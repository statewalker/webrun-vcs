/**
 * `git pull --recurse-submodules` / `submodule.recurse` against native git (builtin/pull.c:
 * the fetch recursing into submodules, then `git submodule update --recursive --checkout`
 * after a merge or `--rebase` after a rebase; a rebasing pull refusing local commits that
 * record submodule changes): the upstream (`parent`, `child`) is built once and shared, the
 * superproject clone is copied into twins, and each pull runs natively in one and ours in the
 * other. The exit status, the submodule lines (the fetch's `Fetching submodule` part of
 * stderr, the update's stdout and stderr) and every repository's HEAD, refs, FETCH_HEAD,
 * index and files are compared.
 *
 * Inputs come from git's t5572-pull-submodule.sh (each test names its title there) and
 * JGit's FetchAndPullCommandsRecurseSubmodulesTest (its pull cases).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createNodeGitHostEnvironment,
  createNodeHookRunner,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Git, PullCommand } from "../src/index.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { gitAtLeast } from "./native-git-working-copy.js";
import { testEnv } from "./status-native-support.js";
import { CLEANUP_TIMEOUT, removeTempDir } from "./temp-dir-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;
const versionLine = nativeGitAvailable() ? execFileSync("git", ["--version"]).toString() : "";
const compatibility = gitAtLeast(versionLine, 2, 50) ? "2.56" : "2.43";

const ALLOW_FILE = "'protocol.file.allow'='always'";

let root: string;
let caseNo = 0;

interface Twins {
  base: string;
  build: string;
  native: string;
  ours: string;
}

function sh(cwd: string, script: string): string {
  return execFileSync("bash", ["-euc", script], {
    cwd,
    env: { ...testEnv(root), GIT_CONFIG_PARAMETERS: ALLOW_FILE },
    stdio: ["ignore", "pipe", "pipe"],
  }).toString("latin1");
}

const HELPERS = `
pwd=$(pwd)
test_commit () { if [ "$1" = -C ]; then (cd "$2"; shift 2; test_commit "$@"); return; fi
  echo "$1" > "$1.t"; git add "$1.t"; git commit -qm "$1"; git tag "$1"; }
update_parent () { git -C parent submodule -q update --remote; git -C parent add sub; git -C parent commit -qm "update submodule"; }
`;

/** t5572-pull-submodule.sh: "pull --recurse-submodule setup". */
const T5572_SETUP = `
git init -q -b main child; test_commit -C child bar
git init -q -b main parent; test_commit -C child foo
git -C parent submodule add -q ../child sub; git -C parent commit -qm "add submodule"
git clone -q --recurse-submodules parent super
`;

function twins(script: string, dir = "super"): Twins {
  const base = join(root, `case${++caseNo}`);
  const build = join(base, "build");
  execFileSync("mkdir", ["-p", build]);
  sh(build, `${HELPERS}${script}`);
  const native = join(base, "native");
  const ours = join(base, "ours");
  execFileSync("mkdir", ["-p", native, ours]);
  execFileSync("cp", ["-a", join(build, dir), join(native, dir)]);
  execFileSync("cp", ["-a", join(build, dir), join(ours, dir)]);
  return { base, build, native, ours };
}

/** Every repository below `dir` (the submodules too): HEAD, refs, FETCH_HEAD, index, files. */
function snapshot(dir: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync("git", args, { cwd, env: testEnv(root) });
    return `${r.stdout.toString("latin1")}${r.status ? `[exit ${r.status}]` : ""}`;
  };
  const files = (repo: string, rel: string, into: Record<string, string>) => {
    for (const name of readdirSync(join(repo, rel)).sort()) {
      if (name === ".git") continue;
      const r = rel ? `${rel}/${name}` : name;
      const p = join(repo, r);
      if (statSync(p).isDirectory()) {
        if (existsSync(join(p, ".git"))) into[r] = "(repository)";
        else files(repo, r, into);
      } else into[r] = readFileSync(p, "latin1");
    }
  };
  const visit = (repo: string, rel: string) => {
    if (!existsSync(join(repo, ".git"))) {
      out[rel] = "not populated";
      return;
    }
    const gitDir = git(repo, "rev-parse", "--absolute-git-dir").trim();
    const worktree: Record<string, string> = {};
    files(repo, "", worktree);
    out[rel] = {
      head: git(repo, "rev-parse", "HEAD", "--symbolic-full-name", "HEAD"),
      refs: git(repo, "for-each-ref", "--format=%(refname) %(objectname)"),
      fetchHead: existsSync(join(gitDir, "FETCH_HEAD"))
        ? readFileSync(join(gitDir, "FETCH_HEAD"), "latin1")
        : "-",
      index: git(repo, "ls-files", "-s"),
      worktree,
    };
    for (const line of git(repo, "ls-files", "-s").split("\n")) {
      const m = /^160000 [0-9a-f]+ \d\t(.*)$/.exec(line);
      if (m) visit(join(repo, m[1] as string), `${rel}/${m[1]}`);
    }
  };
  visit(dir, ".");
  return out;
}

type Step =
  | { up: string }
  | { both: string }
  | { pull: string[]; ours: (c: PullCommand) => PullCommand; config?: string };

const up = (script: string): Step => ({ up: script });
const both = (script: string): Step => ({ both: script });
/** `git [-c <config>] pull <args>` and ours. */
const pull = (args: string[], ours: (c: PullCommand) => PullCommand, config?: string): Step => ({
  pull: args,
  ours,
  ...(config !== undefined ? { config } : {}),
});

async function expectTwins(t: Twins, steps: Step[], dir = "super"): Promise<void> {
  for (const step of steps) {
    if ("up" in step) {
      sh(t.build, `${HELPERS}${step.up}`);
      continue;
    }
    if ("both" in step) {
      sh(join(t.native, dir), `${HELPERS}${step.both}`);
      sh(join(t.ours, dir), `${HELPERS}${step.both}`);
      continue;
    }
    const env = {
      ...testEnv(root),
      GIT_CONFIG_PARAMETERS: [ALLOW_FILE, step.config ?? ""].join(" ").trim(),
    };
    const label = `git pull ${step.pull.join(" ")}${step.config ? ` (${step.config})` : ""}`;
    const r = spawnSync("git", ["pull", ...step.pull], { cwd: join(t.native, dir), env });
    const native = {
      stdout: r.stdout.toString("utf8"),
      stderr: r.stderr.toString("utf8"),
      exitCode: r.status ?? -1,
    };
    const environment = createNodeGitHostEnvironment({
      env,
      hookRunner: createNodeHookRunner({ env, compatibility }),
    });
    const git: Git = await openOurs(t.base, environment, undefined, `ours/${dir}`, true);
    let exitCode: number;
    let tail = "";
    let stdoutTail = "";
    let died = false;
    try {
      const result = await step.ours(git.pull().setCompatibility(compatibility)).call();
      exitCode = result.submodules?.exitCode ?? (result.successful ? 0 : 1);
      tail = `${result.fetchResult?.submoduleOutput ?? ""}${result.submodules?.stderr ?? ""}`;
      stdoutTail = result.submodules?.stdout ?? "";
    } catch (error) {
      const e = error as Error & { exitCode?: number };
      exitCode = e.exitCode ?? 128;
      tail = `${e.message}\n`;
      // a pull that dies after its fetch throws: the fetch's lines are not returned
      died = true;
    }
    expect({ exitCode, tail: native.stderr.endsWith(tail) ? tail : native.stderr }, label).toEqual({
      exitCode: native.exitCode,
      tail,
    });
    expect(native.stdout.endsWith(stdoutTail), `${label}: stdout ${native.stdout}`).toBe(true);
    // the submodule lines are all there (`Fetching submodule`, `Submodule path`)
    for (const line of native.stderr
      .split("\n")
      .filter((l) => !died && l.startsWith("Fetching submodule"))) {
      expect(tail.includes(line), `${label}\n${native.stderr}\n--- ours\n${tail}`).toBe(true);
    }
    for (const line of native.stdout.split("\n").filter((l) => l.startsWith("Submodule path"))) {
      expect(stdoutTail.includes(line), label).toBe(true);
    }
    expect(snapshot(join(t.ours, dir)), label).toEqual(snapshot(join(t.native, dir)));
  }
}

describeGit("git pull --recurse-submodules (native twins)", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "pull-recurse-"));
  });
  afterAll(async () => {
    if (!process.env.KEEP_TWINS) await removeTempDir(root);
  }, CLEANUP_TIMEOUT);

  it('t5572-pull-submodule.sh: "recursive pull updates working tree"', async () => {
    const t = twins(T5572_SETUP);
    await expectTwins(t, [
      up("test_commit -C child merge_strategy; update_parent"),
      pull(["--no-rebase", "--recurse-submodules"], (c) =>
        c.setRebase(false).setRecurseSubmodules(true),
      ),
    ]);
  });

  it('t5572-pull-submodule.sh: "submodule.recurse option triggers recursive pull"', async () => {
    const t = twins(T5572_SETUP);
    await expectTwins(t, [
      up("test_commit -C child merge_strategy_2; update_parent"),
      pull(["--no-rebase"], (c) => c.setRebase(false), "'submodule.recurse'"),
    ]);
  });

  it('t5572-pull-submodule.sh: " --[no-]recurse-submodule and submodule.recurse"', async () => {
    const t = twins(T5572_SETUP);
    await expectTwins(t, [
      up("test_commit -C child merge_strategy_3; update_parent"),
      pull(
        ["--no-recurse-submodules", "--no-rebase"],
        (c) => c.setRecurseSubmodules(false).setRebase(false),
        "'submodule.recurse'",
      ),
      pull(
        ["--recurse-submodules", "--no-rebase"],
        (c) => c.setRecurseSubmodules(true).setRebase(false),
        "'submodule.recurse'='false'",
      ),
      up("test_commit -C child merge_strategy_4; update_parent"),
      pull(
        ["--no-recurse-submodules", "--no-rebase"],
        (c) => c.setRecurseSubmodules(false).setRebase(false),
        "'submodule.recurse'='false'",
      ),
      pull(
        ["--recurse-submodules", "--no-rebase"],
        (c) => c.setRecurseSubmodules(true).setRebase(false),
        "'submodule.recurse'='true'",
      ),
    ]);
  });

  it('t5572-pull-submodule.sh: "fetch.recurseSubmodules option triggers recursive fetch (but not recursive update)", "fetch.recurseSubmodules takes precedence over submodule.recurse"', async () => {
    const t = twins(T5572_SETUP);
    await expectTwins(t, [
      up("test_commit -C child merge_strategy_5"),
      pull(["--no-rebase"], (c) => c.setRebase(false), "'fetch.recursesubmodules'='true'"),
      up("test_commit -C child merge_strategy_6"),
      pull(
        ["--no-rebase"],
        (c) => c.setRebase(false),
        "'submodule.recurse'='false' 'fetch.recursesubmodules'='true'",
      ),
    ]);
  });

  it('t5572-pull-submodule.sh: "pull --rebase --recurse-submodules (remote superproject submodule changes, local submodule changes)", "pull --rebase --recurse-submodules fails if both sides record submodule changes"', async () => {
    const t = twins(T5572_SETUP);
    await expectTwins(t, [
      up("test_commit -C child rebase_strategy; update_parent"),
      both("(cd sub; git checkout -q -B main; test_commit local_stuff)"),
      pull(["--rebase", "--recurse-submodules"], (c) =>
        c.setRebase(true).setRecurseSubmodules(true),
      ),
      both(
        'test_commit -C sub local_stuff_2; git add sub; git commit -qm "local update submodule"',
      ),
      up("test_commit -C child important_upstream_work; update_parent"),
      pull(["--rebase", "--recurse-submodules"], (c) =>
        c.setRebase(true).setRecurseSubmodules(true),
      ),
    ]);
  });

  describe("JGit FetchAndPullCommandsRecurseSubmodulesTest (pull)", () => {
    const JGIT_SETUP = `
git init -q -b master sub1; (cd sub1; echo content > file.txt; git add file.txt; git commit -qm "create file")
git init -q -b master sub2; (cd sub2; echo content > file.txt; git add file.txt; git commit -qm "create file")
(cd sub1; git submodule add -q "$pwd/sub2" sub; git commit -qam "Adding submodule")
git init -q -b master super; (cd super; git submodule add -q "$pwd/sub1" sub; git commit -qam "Adding submodule")
git clone -q --recurse-submodules super clone
(cd sub1/sub; echo test > f2.txt; git add f2.txt; git commit -qm "new commit")
(cd sub1; echo test > f1.txt; git add f1.txt; git commit -qm "new commit")
(cd sub2; echo test > f2.txt; git add f2.txt; git commit -qm "new commit")
`;
    const UPDATE = `(cd super/sub; git fetch -q origin refs/heads/master; git reset -q --hard FETCH_HEAD)
(cd super; git add sub; git commit -qm "update sub")`;
    const cases: [string, string[], (c: PullCommand) => PullCommand, string, string?][] = [
      [
        "shouldNotFetchSubmodulesWhenNo",
        ["--recurse-submodules=no"],
        (c) => c.setRecurseSubmodules("no"),
        "",
      ],
      [
        "shouldFetchSubmodulesWhenYes",
        ["--recurse-submodules=yes"],
        (c) => c.setRecurseSubmodules("yes"),
        "",
      ],
      [
        "shouldFetchSubmodulesWhenOnDemandAndRevisionChanged",
        ["--recurse-submodules=on-demand"],
        (c) => c.setRecurseSubmodules("on-demand"),
        UPDATE,
      ],
      [
        "shouldNotFetchSubmodulesWhenOnDemandAndRevisionNotChanged",
        ["--recurse-submodules=on-demand"],
        (c) => c.setRecurseSubmodules("on-demand"),
        "",
      ],
      [
        "shouldNotFetchSubmodulesWhenSubmoduleConfigurationSetToNo",
        [],
        (c) => c,
        UPDATE,
        "git config submodule.sub.fetchRecurseSubmodules false",
      ],
      [
        "shouldFetchSubmodulesWhenSubmoduleConfigurationSetToYes",
        [],
        (c) => c,
        "",
        "git config submodule.sub.fetchRecurseSubmodules true",
      ],
      [
        "shouldNotFetchSubmodulesWhenFetchConfigurationSetToNo",
        [],
        (c) => c,
        UPDATE,
        "git config fetch.recurseSubmodules false",
      ],
      [
        "shouldFetchSubmodulesWhenFetchConfigurationSetToYes",
        [],
        (c) => c,
        "",
        "git config fetch.recurseSubmodules true",
      ],
    ];
    for (const [name, args, build, upstream, local] of cases) {
      it(name, async () => {
        const t = twins(JGIT_SETUP, "clone");
        await expectTwins(
          t,
          [
            ...(local ? [both(local)] : []),
            ...(upstream ? [up(upstream)] : []),
            pull(["--rebase", "origin", ...args], (c) =>
              build(c.setRebase(true).setRemote("origin")),
            ),
          ],
          "clone",
        );
      });
    }
  });
});
