/**
 * `--recurse-submodules` (and `submodule.recurse`) for checkout, switch, reset and restore
 * against native git (unpack-trees.c `check_submodule_move_head`, `verify_clean_submodule`,
 * entry.c's `checkout_entry`/`unlink_entry`, submodule.c `submodule_move_head`): each
 * scenario prepares two copies of one superproject state, runs native git in one and our
 * command in the other, and compares whether it succeeded, its error lines where it refused,
 * the worktrees (submodules' files and gitfiles included), each submodule's index and HEAD,
 * and each `.git/modules/<name>`'s config, HEAD and index.
 *
 * The scenarios come from git's t/lib-submodule-update.sh, which t2013-checkout-submodule.sh
 * (`checkout`, `checkout -f`) and t7112-reset-submodule.sh (`reset --keep`, `reset --hard`)
 * source: `test_submodule_switch_recursing_with_args`,
 * `test_submodule_forced_switch_recursing_with_args` and their common part (each test's name
 * is its title there, its command the t-script's), run for `switch` and `switch -f` too; the
 * restore ones from t7423-submodule-symlinks.sh and t2013's path checkouts. The fixture is
 * lib-submodule-update.sh's `create_lib_submodule_repo`, each state its
 * `reset_work_tree_to_interested`. Local URLs need `protocol.file.allow=always`, as the
 * t-scripts set it.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeGitHostEnvironment } from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CheckoutStatus, type Git, GitApiError } from "../src/index.js";
import { ResetMode } from "../src/types.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { gitAtLeast } from "./native-git-working-copy.js";
import { testEnv } from "./status-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

/** `-c protocol.file.allow=always`, as the t-scripts' `test_config_global`. */
const ALLOW_FILE = { GIT_CONFIG_PARAMETERS: "'protocol.file.allow'='always'" };

let root: string;
let caseNo = 0;

/** Runs a bash script with native git's test environment. */
function sh(cwd: string, script: string, extra: Record<string, string> = {}): string {
  return execFileSync("bash", ["-euc", script], {
    cwd,
    env: { ...testEnv(root), ...ALLOW_FILE, ...extra },
    stdio: ["ignore", "pipe", "pipe"],
  }).toString("latin1");
}

/** lib-submodule-update.sh's `create_lib_submodule_repo` (its `test_oid numeric` spelled out). */
const CREATE_LIB_SUBMODULE_REPO = `
git init -q submodule_update_sub1
( cd submodule_update_sub1 && echo expect >>.gitignore && echo actual >>.gitignore &&
  echo x >file1 && echo y >file2 && git add .gitignore file1 file2 &&
  git commit -qm "Base inside first submodule" && git branch no_submodule )
git init -q submodule_update_sub2
( cd submodule_update_sub2 && echo expect >>.gitignore && echo actual >>.gitignore &&
  echo x >file1 && echo y >file2 && git add .gitignore file1 file2 &&
  git commit -qm "nested submodule base" && git branch no_submodule )
git init -q submodule_update_repo
(
cd submodule_update_repo
branch=$(git symbolic-ref --short HEAD)
echo expect >>.gitignore && echo actual >>.gitignore && echo x >file1 && echo y >file2
git add .gitignore file1 file2 && git commit -qm Base && git branch no_submodule
git checkout -q -b add_sub1
git submodule -q add ../submodule_update_sub1 sub1
git submodule -q add ../submodule_update_sub1 uninitialized_sub
git config -f .gitmodules submodule.sub1.ignore all
git config submodule.sub1.ignore all
git add .gitmodules && git commit -qm "Add sub1"
git checkout -q -b remove_sub1 add_sub1 && git revert --no-edit HEAD >/dev/null
git checkout -q -b modify_sub1 add_sub1 && git submodule -q update
( cd sub1 && git fetch -q && git checkout -q -b modifications && echo z >file2 &&
  echo x >file3 && git add file2 file3 && git commit -qm "modified file2 and added file3" &&
  git push -q origin modifications )
git add --force sub1 && git commit -qm "Modify sub1"
git checkout -q -b add_nested_sub modify_sub1
git -C sub1 checkout -q -b add_nested_sub
git -C sub1 submodule -q add --branch no_submodule ../submodule_update_sub2 sub2
git -C sub1 commit -qam "add a nested submodule"
git add --force sub1 && git commit -qam "update submodule, that updates a nested submodule"
git checkout -q -b modify_sub1_recursively
git -C sub1 checkout -q -b modify_sub1_recursively
git -C sub1/sub2 checkout -q -b modify_sub1_recursively
echo change >sub1/sub2/file3
git -C sub1/sub2 add file3 && git -C sub1/sub2 commit -qm "make a change in nested sub"
git -C sub1 add sub2 && git -C sub1 commit -qm "update nested sub"
git add --force sub1 && git commit -qm "update sub1, that updates nested sub"
git -C sub1 push -q origin modify_sub1_recursively
git -C sub1/sub2 push -q origin modify_sub1_recursively
git -C sub1 submodule -q deinit -f --all 2>/dev/null
git checkout -q -b replace_sub1_with_directory add_sub1 2>/dev/null
git submodule -q update
git -C sub1 checkout -q modifications
git rm -q --cached sub1
rm sub1/.git*
git config -f .gitmodules --remove-section submodule.sub1
git add .gitmodules sub1/* && git commit -qm "Replace sub1 with directory"
git checkout -q -b replace_directory_with_sub1 && git revert --no-edit HEAD >/dev/null
git checkout -q -b replace_sub1_with_file add_sub1 2>/dev/null
git rm -q sub1 && echo content >sub1 && git add sub1 && git commit -qm "Replace sub1 with file"
git checkout -q -b replace_file_with_sub1 && git revert --no-edit HEAD >/dev/null
git checkout -q -b invalid_sub1 add_sub1 2>/dev/null
git update-index --cacheinfo 160000 0123456789012345678901234567890123456789 sub1
git commit -qm "Invalid sub1 commit"
git checkout -q -b valid_sub1 && git revert --no-edit HEAD >/dev/null
git checkout -q "$branch" 2>/dev/null
)
`;

/**
 * lib-submodule-update.sh's `reset_work_tree_to_interested <commit>` in `submodule_update`
 * (with the `prolog`'s `diff.ignoreSubmodules all`), then the branch the scenario switches to
 * (`git branch -t <target> origin/<target>`).
 */
function resetWorkTreeToInterested(from: string, target: string | undefined): string {
  return `
rm -rf submodule_update
git clone -q --template= submodule_update_repo submodule_update
(
  cd submodule_update && rm -rf sub1 && git checkout -q -f ${from} &&
  hash=$(git rev-parse --revs-only HEAD:sub1) &&
  if test -n "$hash" && test $(cd ../submodule_update_sub1 && git rev-parse -q --verify "$hash^{commit}")
  then git submodule -q update --init --recursive sub1 2>/dev/null
  fi
)
if ! test -d submodule_update/.git/modules/sub1
then
  mkdir -p submodule_update/.git/modules &&
  cp -r submodule_update_repo/.git/modules/sub1 submodule_update/.git/modules/sub1
  GIT_WORK_TREE=. git -C submodule_update/.git/modules/sub1 config --unset core.worktree
fi
if ! test -d submodule_update/.git/modules/sub1/modules/sub2
then
  mkdir -p submodule_update/.git/modules/sub1/modules &&
  cp -r submodule_update_repo/.git/modules/sub1/modules/sub2 submodule_update/.git/modules/sub1/modules/sub2
fi
git -C submodule_update config submodule.sub1.url bogus
git -C submodule_update/.git/modules/sub1 config submodule.sub2.url bogus
git -C submodule_update config diff.ignoreSubmodules all
${target && target !== "HEAD" ? `git -C submodule_update branch -q -t ${target} origin/${target}` : ""}
`;
}

/** lib-submodule-update.sh's `replace_gitfile_with_git_dir sub1`. */
const REPLACE_GITFILE_WITH_GIT_DIR = `(cd sub1 && git_dir="$(git rev-parse --git-dir)" &&
  rm -f .git && cp -R "$git_dir" .git && GIT_WORK_TREE=. git config --unset core.worktree)`;

interface Twins {
  base: string;
  native: string;
  ours: string;
}

/** The fixture with `submodule_update` at commit `from`, set up by `setup`, twice. */
function twins(from: string, target: string | undefined, setup: string): Twins {
  const base = join(root, `case${++caseNo}`);
  const make = (name: string) => {
    const dir = join(base, name);
    execFileSync("mkdir", ["-p", dir]);
    for (const repo of [
      "submodule_update_sub1",
      "submodule_update_sub2",
      "submodule_update_repo",
    ]) {
      execFileSync("ln", ["-s", join(root, "fixture", repo), join(dir, repo)]);
    }
    sh(dir, resetWorkTreeToInterested(from, target));
    if (setup) sh(join(dir, "submodule_update"), setup);
    return join(dir, "submodule_update");
  };
  return { base, native: make("native"), ours: make("ours") };
}

/** Native git's stdout in `cwd` (read-only questions about a twin), or its failure. */
function ask(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, env: testEnv(root) });
  return `${r.stdout.toString("latin1")}${r.status ? `[exit ${r.status}]` : ""}`;
}

/**
 * The state compared: worktree files and directories, gitfiles, each repository's index
 * (`ls-files -s`) and HEAD, and every `.git/modules/<name>`'s config, HEAD and index.
 */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const norm = (s: string) => s.split(dir).join("<T>");
  const walkModules = (abs: string, rel: string) => {
    for (const name of readdirSync(abs).sort()) {
      const p = join(abs, name);
      if (!lstatSync(p).isDirectory()) continue;
      if (existsSync(join(p, "HEAD"))) {
        out[`${rel}/${name}/HEAD`] = readFileSync(join(p, "HEAD"), "latin1");
        out[`${rel}/${name}/config`] = norm(readFileSync(join(p, "config"), "latin1"));
        out[`${rel}/${name} (ls-files)`] = ask(p, [`--git-dir=${p}`, "ls-files", "-s"]);
        if (existsSync(join(p, "modules"))) walkModules(join(p, "modules"), `${rel}/${name}`);
      } else walkModules(p, `${rel}/${name}`);
    }
  };
  const walk = (abs: string, rel: string) => {
    for (const name of readdirSync(abs).sort()) {
      const p = join(abs, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = lstatSync(p);
      if (name === ".git") {
        if (st.isDirectory()) {
          out[`${r}/`] = "gitdir";
          const modules = join(p, "modules");
          if (existsSync(modules)) walkModules(modules, `${r}/modules`);
        } else out[r] = norm(readFileSync(p, "latin1"));
        out[`${r} (ls-files)`] = ask(abs, ["ls-files", "-s"]);
        out[`${r} (HEAD)`] = ask(abs, ["rev-parse", "HEAD"]);
        out[`${r} (branch)`] = ask(abs, ["symbolic-ref", "-q", "HEAD"]);
      } else if (st.isSymbolicLink()) out[r] = `link -> ${readlinkSync(p)}`;
      else if (st.isDirectory()) {
        out[`${r}/`] = "dir";
        walk(p, r);
      } else out[r] = norm(readFileSync(p, "latin1"));
    }
  };
  walk(dir, "");
  return out;
}

/** The `error:`/`fatal:` lines of an output, the twin's path left out. */
function errorLines(text: string, dir: string): string[] {
  return text
    .split(dir)
    .join("<T>")
    .split("\n")
    .filter((l) => /^(error|fatal): /.test(l));
}

/** A command under test: its native arguments (before the target) and our call. */
interface Command {
  /** The git t/ script running lib-submodule-update.sh's tests with it (none for switch) */
  script?: string;
  args: string[];
  /** Ours, with `--recurse-submodules` when `recurse` (else through `submodule.recurse`) */
  ours: (git: Git, target: string, recurse: boolean) => Promise<{ ok: boolean; stderr: string }>;
}

/** Our checkout or switch result as success and the lines it printed. */
async function ran(run: () => Promise<{ status: CheckoutStatus; message?: string }>) {
  try {
    const result = await run();
    return { ok: result.status === CheckoutStatus.OK, stderr: result.message ?? "" };
  } catch (error) {
    if (error instanceof GitApiError) return { ok: false, stderr: error.message };
    throw error;
  }
}

/** Our reset as success and the lines it printed. */
async function ranReset(run: () => Promise<unknown>) {
  try {
    await run();
    return { ok: true, stderr: "" };
  } catch (error) {
    if (error instanceof GitApiError) return { ok: false, stderr: error.message };
    throw error;
  }
}

/** Sets `--recurse-submodules` unless the scenario relies on `submodule.recurse`. */
const recursing = <T extends { setRecurseSubmodules(r: boolean): T }>(c: T, given: boolean) =>
  given ? c.setRecurseSubmodules(true) : c;

const COMMANDS: Record<string, Command> = {
  checkout: {
    script: "t2013-checkout-submodule.sh",
    args: ["checkout"],
    ours: (g, t, r) => ran(() => recursing(g.checkout().setName(t), r).call()),
  },
  "checkout -f": {
    script: "t2013-checkout-submodule.sh",
    args: ["checkout", "-f"],
    ours: (g, t, r) => ran(() => recursing(g.checkout().setName(t).setForced(true), r).call()),
  },
  switch: {
    args: ["switch"],
    ours: (g, t, r) => ran(() => recursing(g.switch().setName(t), r).call()),
  },
  "switch -f": {
    args: ["switch", "-f"],
    ours: (g, t, r) => ran(() => recursing(g.switch().setName(t).setForced(true), r).call()),
  },
  "reset --keep": {
    script: "t7112-reset-submodule.sh",
    args: ["reset", "--keep"],
    ours: (g, t, r) =>
      ranReset(() => recursing(g.reset().setMode(ResetMode.KEEP).setRef(t), r).call()),
  },
  "reset --merge": {
    args: ["reset", "--merge"],
    ours: (g, t, r) =>
      ranReset(() => recursing(g.reset().setMode(ResetMode.MERGE).setRef(t), r).call()),
  },
  "reset --hard": {
    script: "t7112-reset-submodule.sh",
    args: ["reset", "--hard"],
    ours: (g, t, r) =>
      ranReset(() => recursing(g.reset().setMode(ResetMode.HARD).setRef(t), r).call()),
  },
  "read-tree -u -m": {
    script: "t1013-read-tree-submodule.sh",
    args: ["read-tree", "-u", "-m"],
    ours: (g, t, r) =>
      ranReset(() => recursing(g.readTree().setMerge(true).setUpdate(true).addTree(t), r).call()),
  },
  "read-tree -u --reset": {
    script: "t1013-read-tree-submodule.sh",
    args: ["read-tree", "-u", "--reset"],
    ours: (g, t, r) =>
      ranReset(() => recursing(g.readTree().setReset(true).setUpdate(true).addTree(t), r).call()),
  },
};

/** One scenario of lib-submodule-update.sh. */
interface Scenario {
  title: string;
  from: string;
  target: string;
  setup?: string;
  /** The error lines are compared too (a refusal whose messages ours prints as git's) */
  errors?: boolean;
}

/** `test_submodule_recursing_with_args_common`. */
const COMMON: Scenario[] = [
  { title: "added submodule is checked out", from: "no_submodule", target: "add_sub1" },
  {
    title: "added submodule is checked out in empty dir",
    from: "no_submodule",
    target: "add_sub1",
    setup: "mkdir sub1",
  },
  {
    title: "replace tracked file with submodule checks out submodule",
    from: "replace_sub1_with_file",
    target: "replace_file_with_sub1",
  },
  {
    title: "replace directory with submodule",
    from: "replace_sub1_with_directory",
    target: "replace_directory_with_sub1",
  },
  {
    title: "nested submodules are checked out",
    from: "no_submodule",
    target: "modify_sub1_recursively",
  },
  {
    title: "removed submodule removes submodules working tree",
    from: "add_sub1",
    target: "remove_sub1",
  },
  {
    title: "removed submodule absorbs submodules .git directory",
    from: "add_sub1",
    target: "remove_sub1",
    setup: `${REPLACE_GITFILE_WITH_GIT_DIR} && rm -rf .git/modules`,
  },
  { title: "replace submodule with a file", from: "add_sub1", target: "replace_sub1_with_file" },
  {
    title: "replace submodule with a file must fail with untracked files",
    from: "add_sub1",
    target: "replace_sub1_with_file",
    setup: ": >sub1/untrackedfile",
  },
  {
    title: "worktrees of nested submodules are removed",
    from: "add_nested_sub",
    target: "no_submodule",
  },
  {
    title: "modified submodule updates submodule work tree",
    from: "add_sub1",
    target: "modify_sub1",
  },
  {
    title: "updating to a missing submodule commit fails",
    from: "add_sub1",
    target: "invalid_sub1",
    errors: true,
  },
  {
    title: "submodule branch is not changed, detach HEAD instead",
    from: "add_sub1",
    target: "modify_sub1",
    setup: "git -C sub1 checkout -q -b keep_branch",
  },
];

/** `test_submodule_switch_recursing_with_args`'s own scenarios, and refusals of local changes. */
const SWITCH: Scenario[] = [
  {
    title: "added submodule doesn't remove untracked file with same name",
    from: "no_submodule",
    target: "add_sub1",
    setup: ": >sub1",
    errors: true,
  },
  {
    title: "added submodule removes an untracked ignored file",
    from: "no_submodule",
    target: "add_sub1",
    setup: ": >sub1 && mkdir .git/info && echo sub1 >.git/info/exclude",
  },
  {
    title: "replace submodule with a directory",
    from: "add_sub1",
    target: "replace_sub1_with_directory",
  },
  {
    title: "replace submodule containing a .git directory with a directory must absorb the git dir",
    from: "add_sub1",
    target: "replace_sub1_with_directory",
    setup: `${REPLACE_GITFILE_WITH_GIT_DIR} && rm -rf .git/modules`,
  },
  {
    title: "replace submodule with a file works ignores ignored files in submodule",
    from: "add_sub1",
    target: "replace_sub1_with_file",
    setup:
      "rm -rf .git/modules/sub1/info && mkdir .git/modules/sub1/info && echo ignored >.git/modules/sub1/info/exclude && : >sub1/ignored",
  },
  {
    title: "modified submodule updates submodule recursively",
    from: "add_nested_sub",
    target: "modify_sub1_recursively",
  },
  // the refusals of local changes in a submodule (unpack-trees' verify_uptodate and
  // check_submodule_move_head: the submodule's own read-tree -n -m, its dirty index)
  {
    title: "(refusal) a modified file the submodule's switch changes",
    from: "add_sub1",
    target: "modify_sub1",
    setup: "echo dirty >sub1/file2",
    errors: true,
  },
  {
    title: "(refusal) a staged change in the submodule",
    from: "add_sub1",
    target: "modify_sub1",
    setup: "echo staged >sub1/file1 && git -C sub1 add file1",
    errors: true,
  },
  {
    title: "(refusal) a modified file in a removed submodule",
    from: "add_sub1",
    target: "remove_sub1",
    setup: "echo dirty >sub1/file1",
    errors: true,
  },
  {
    title: "(refusal) a modified file in a nested submodule",
    from: "add_nested_sub",
    target: "modify_sub1_recursively",
    setup: "echo dirty >sub1/sub2/file3 2>/dev/null; echo dirty >sub1/sub2/file1",
    errors: true,
  },
  {
    title: "(kept) an untracked file the submodule's switch writes",
    from: "add_sub1",
    target: "modify_sub1",
    setup: "echo untracked >sub1/file3",
  },
  {
    title: "(kept) a modified file the submodule's switch leaves alone",
    from: "add_sub1",
    target: "modify_sub1",
    setup: "echo dirty >sub1/file1",
  },
];

/** `test_submodule_forced_switch_recursing_with_args`'s own scenarios. */
const FORCED: Scenario[] = [
  {
    title: "added submodule does remove untracked unignored file with same name when forced",
    from: "no_submodule",
    target: "add_sub1",
    setup: ": >sub1",
  },
  {
    title: "replace submodule with a directory",
    from: "add_sub1",
    target: "replace_sub1_with_directory",
  },
  {
    title: "replace submodule containing a .git directory with a directory must fail",
    from: "add_sub1",
    target: "replace_sub1_with_directory",
    setup: `${REPLACE_GITFILE_WITH_GIT_DIR} && rm -rf .git/modules/sub1`,
  },
  {
    title: "replace submodule with a file ignoring ignored files",
    from: "add_sub1",
    target: "replace_sub1_with_file",
    setup: ": >sub1/expect",
  },
  {
    title: "modified submodule does update submodule work tree from invalid commit",
    from: "invalid_sub1",
    target: "valid_sub1",
  },
  {
    title: "updating submodules fixes .git links",
    from: "add_sub1",
    target: "modify_sub1",
    setup: 'echo "gitdir: bogus/path" >sub1/.git',
  },
  {
    title: "changed submodule worktree is reset",
    from: "add_sub1",
    target: "HEAD",
    setup: "rm sub1/file1 && : >sub1/new_file && git -C sub1 add new_file",
  },
  {
    title: "(forced) a modified file the submodule's switch changes",
    from: "add_sub1",
    target: "modify_sub1",
    setup: "echo dirty >sub1/file2 && echo staged >sub1/file1 && git -C sub1 add file1",
  },
];

/**
 * Runs `scenario` with native `git <command> --recurse-submodules <target>` (with
 * `submodule.recurse`: `git -c submodule.recurse=true <command> <target>`) and ours, comparing
 * the results.
 */
async function compare(name: string, scenario: Scenario, viaConfig = false): Promise<void> {
  const command = COMMANDS[name] as Command;
  const t = twins(scenario.from, scenario.target, scenario.setup ?? "");
  const env: Record<string, string> = viaConfig
    ? { GIT_CONFIG_PARAMETERS: "'protocol.file.allow'='always' 'submodule.recurse'='true'" }
    : {};
  const args = viaConfig
    ? [...command.args, scenario.target]
    : [...command.args, "--recurse-submodules", scenario.target];
  const r = spawnSync("git", args, {
    cwd: t.native,
    env: { ...testEnv(root), ...ALLOW_FILE, ...env },
  });
  const native = { ok: r.status === 0, stderr: r.stderr.toString("latin1") };
  const hostEnv = { ...testEnv(root), ...ALLOW_FILE, ...env };
  const environment = createNodeGitHostEnvironment({ env: hostEnv });
  const git = await openOurs(t.base, environment, undefined, "ours/submodule_update", true);
  const ours = await command.ours(git, scenario.target, !viaConfig);
  expect(ours.ok, `ours: ${ours.stderr}\nnative: ${native.stderr}`).toBe(native.ok);
  // a refusal's lines are compared too
  if (scenario.errors || !native.ok) {
    expect(errorLines(ours.stderr, t.ours)).toEqual(errorLines(native.stderr, t.native));
  }
  expect(snapshot(t.ours)).toEqual(snapshot(t.native));
}

/** Runs native `git <args>` and `ours` in twins of `from` set up by `setup`, comparing them. */
async function compareRun(
  from: string,
  setup: string,
  args: string[],
  ours: (git: Git) => Promise<{ ok: boolean; stderr: string }>,
  errors = false,
): Promise<void> {
  const t = twins(from, undefined, setup);
  const r = spawnSync("git", args, { cwd: t.native, env: { ...testEnv(root), ...ALLOW_FILE } });
  const native = { ok: r.status === 0, stderr: r.stderr.toString("latin1") };
  const environment = createNodeGitHostEnvironment({ env: { ...testEnv(root), ...ALLOW_FILE } });
  const git = await openOurs(t.base, environment, undefined, "ours/submodule_update", true);
  const result = await ours(git);
  expect(result.ok, `ours: ${result.stderr}\nnative: ${native.stderr}`).toBe(native.ok);
  if (errors || !native.ok) {
    expect(errorLines(result.stderr, t.ours)).toEqual(errorLines(native.stderr, t.native));
  }
  expect(snapshot(t.ours)).toEqual(snapshot(t.native));
}

/**
 * The test's name: the t/ script and lib-submodule-update.sh's title as that script runs it
 * (`<command>: <title>`), or ours for scenarios git's suite lacks.
 */
function testName(name: string, scenario: Scenario): string {
  const command = COMMANDS[name] as Command;
  const title = `git ${name} --recurse-submodules: ${scenario.title}`;
  if (scenario.title.startsWith("(") || !command.script) return title;
  return `${command.script}: "${title}"`;
}

describeGit("--recurse-submodules on checkout, switch and reset (native twins)", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "recurse-worktree-"));
    const fixture = join(root, "fixture");
    execFileSync("mkdir", ["-p", fixture]);
    sh(fixture, CREATE_LIB_SUBMODULE_REPO);
  }, 120_000);
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  }, 120_000);

  // t2013 `test_submodule_switch_recursing_with_args "checkout"`, t7112 `... "reset --keep"`,
  // t1013 `... "read-tree -u -m"`; switch runs the same scenarios
  for (const name of ["checkout", "switch", "reset --keep", "reset --merge", "read-tree -u -m"]) {
    describe(`lib-submodule-update.sh: git ${name} --recurse-submodules`, () => {
      for (const scenario of [...COMMON, ...SWITCH]) {
        it(testName(name, scenario), () => compare(name, scenario), 60_000);
      }
      const title = `git -c submodule.recurse=true ${name}: modified submodule updates submodule work tree`;
      const script = (COMMANDS[name] as Command).script;
      it(
        script ? `${script}: "${title}"` : title,
        () => compare(name, { title, from: "add_sub1", target: "modify_sub1" }, true),
        60_000,
      );
    });
  }

  // t2013 `test_submodule_forced_switch_recursing_with_args "checkout -f"`, t7112 `... "reset
  // --hard"`, t1013 `... "read-tree -u --reset"`; `switch -f` runs the same scenarios
  for (const name of ["checkout -f", "switch -f", "reset --hard", "read-tree -u --reset"]) {
    describe(`lib-submodule-update.sh: git ${name} --recurse-submodules`, () => {
      for (const scenario of [...COMMON, ...FORCED]) {
        it(testName(name, scenario), () => compare(name, scenario), 60_000);
      }
    });
  }

  // path checkouts (builtin/checkout.c `checkout_worktree`: entry.c's checkout_entry and
  // unlink_entry with state.force), on lib-submodule-update.sh's fixture
  describe("git restore / checkout -- <paths> --recurse-submodules", () => {
    const MOVED = "git -C sub1 checkout -q origin/modifications";
    const DIRTY = "echo dirty >sub1/file2 && : >sub1/untracked && git -C sub1 rm -q --cached file1";
    const restore =
      (build: (c: ReturnType<Git["restore"]>) => ReturnType<Git["restore"]>) => (g: Git) =>
        ran(() => build(g.restore().setRecurseSubmodules(true)).call());
    it(
      "restore of a submodule whose HEAD moved",
      () =>
        compareRun(
          "add_sub1",
          MOVED,
          ["restore", "--recurse-submodules", "sub1"],
          restore((c) => c.addPath("sub1")),
        ),
      60_000,
    );
    it(
      "restore of a submodule with local changes and a dirty index",
      () =>
        compareRun(
          "add_sub1",
          DIRTY,
          ["restore", "--recurse-submodules", "sub1"],
          restore((c) => c.addPath("sub1")),
        ),
      60_000,
    );
    it(
      "restore --source --staged --worktree of a modified submodule",
      () =>
        compareRun(
          "add_sub1",
          "",
          [
            "restore",
            "--recurse-submodules",
            "--source=origin/modify_sub1",
            "--staged",
            "--worktree",
            "sub1",
          ],
          restore((c) =>
            c.setSource("origin/modify_sub1").setStaged(true).setWorktree(true).addPath("sub1"),
          ),
        ),
      60_000,
    );
    it(
      "restore --source of a tree without the submodule (no overlay)",
      () =>
        compareRun(
          "add_sub1",
          "",
          [
            "restore",
            "--recurse-submodules",
            "--source=origin/remove_sub1",
            "--staged",
            "--worktree",
            "sub1",
          ],
          restore((c) =>
            c.setSource("origin/remove_sub1").setStaged(true).setWorktree(true).addPath("sub1"),
          ),
        ),
      60_000,
    );
    it(
      "restore of a nested submodule tree",
      () =>
        compareRun(
          "add_nested_sub",
          "git -C sub1/sub2 checkout -q HEAD~0 && echo dirty >sub1/sub2/file1",
          [
            "restore",
            "--recurse-submodules",
            "--source=origin/modify_sub1_recursively",
            "--staged",
            "--worktree",
            "sub1",
          ],
          restore((c) =>
            c
              .setSource("origin/modify_sub1_recursively")
              .setStaged(true)
              .setWorktree(true)
              .addPath("sub1"),
          ),
        ),
      60_000,
    );
    it(
      "checkout <tree-ish> -- <submodule>",
      () =>
        compareRun(
          "add_sub1",
          DIRTY,
          ["checkout", "--recurse-submodules", "origin/modify_sub1", "--", "sub1"],
          (g) =>
            ran(() =>
              g
                .checkout()
                .setRecurseSubmodules(true)
                .setStartPoint("origin/modify_sub1")
                .addPath("sub1")
                .call(),
            ),
        ),
      60_000,
    );
    it(
      "restore without --recurse-submodules leaves the submodule alone",
      () =>
        compareRun("add_sub1", MOVED, ["restore", "sub1"], (g) =>
          ran(() => g.restore().addPath("sub1").call()),
        ),
      60_000,
    );
  });

  // t7423-submodule-symlinks.sh: its own fixture (a submodule at a/sm, a/sm then a link to
  // another repository)
  // 2.5x only: git 2.43.0 has no validate_submodule_path and moves the linked repository into
  // .git/modules (ours refuses it under every version)
  const describe7423 =
    nativeGitAvailable() && gitAtLeast(execFileSync("git", ["--version"]).toString(), 2, 44)
      ? describe
      : describe.skip;
  describe7423("t7423-submodule-symlinks.sh", () => {
    const PREPARE = `
git init -q sup && cd sup
git commit -q --allow-empty -m initial && git tag initial
git init -q upstream && echo submodule_file >upstream/submodule_file &&
git -C upstream add submodule_file && git -C upstream commit -qm upstream
git submodule -q add ./upstream a/sm 2>/dev/null && git commit -qm submodule
rm -rf a && mkdir a && git init -q a/target && git -C a/target fetch -q ../../upstream && ln -s target a/sm
`;
    /** The fixture twice (`prepare` plus the test's own steps), ours rooted at the case. */
    const symlinkTwins = async (
      extra: string,
      args: string[],
      ours: (g: Git) => Promise<{ ok: boolean; stderr: string }>,
    ) => {
      const base = join(root, `case${++caseNo}`);
      for (const name of ["native", "ours"]) {
        execFileSync("mkdir", ["-p", join(base, name)]);
        sh(join(base, name), `${PREPARE}${extra}`);
      }
      const r = spawnSync("git", args, { cwd: join(base, "native", "sup"), env: testEnv(root) });
      const environment = createNodeGitHostEnvironment({
        env: { ...testEnv(root), ...ALLOW_FILE },
      });
      const git = await openOurs(base, environment, undefined, "ours/sup", true);
      const result = await ours(git);
      expect(result.ok, `ours: ${result.stderr}\nnative: ${r.stderr.toString()}`).toBe(
        r.status === 0,
      );
      expect(snapshot(join(base, "ours", "sup"))).toEqual(snapshot(join(base, "native", "sup")));
    };
    it(
      't7423-submodule-symlinks.sh: "git restore --recurse-submodules must not be confused by a symlink"',
      () =>
        symlinkTwins("", ["restore", "--recurse-submodules", "a/sm"], (g) =>
          ran(() => g.restore().setRecurseSubmodules(true).addPath("a/sm").call()),
        ),
      60_000,
    );
    it(
      't7423-submodule-symlinks.sh: "git restore --recurse-submodules must not migrate git dir of symlinked repo"',
      () =>
        symlinkTwins("rm -rf .git/modules", ["restore", "--recurse-submodules", "a/sm"], (g) =>
          ran(() => g.restore().setRecurseSubmodules(true).addPath("a/sm").call()),
        ),
      60_000,
    );
    it(
      't7423-submodule-symlinks.sh: "git checkout -f --recurse-submodules must not migrate git dir of symlinked repo when removing submodule"',
      () =>
        symlinkTwins(
          "rm -rf .git/modules",
          ["checkout", "-f", "--recurse-submodules", "initial"],
          (g) =>
            ran(() =>
              g.checkout().setName("initial").setForced(true).setRecurseSubmodules(true).call(),
            ),
        ),
      60_000,
    );
  });
});
