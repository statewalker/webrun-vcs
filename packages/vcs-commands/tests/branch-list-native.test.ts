/**
 * `git.branchList().callText()` against native `git branch` (list mode), byte for byte:
 * the listings of t3203-branch-output.sh (local, `-r`, `-a`, patterns, `-v`/`-vv`, detached
 * HEAD descriptions, worktrees' `+`, symrefs, `--sort`, `--points-at`, `--format`,
 * `--omit-empty`, `--color`, `-i`) and the reachability filters of t3201-branch-contains.sh
 * (`--contains`, `--no-contains`, `--merged`, `--no-merged`, with `-v` tracking), and the
 * rebasing/bisecting HEAD descriptions t3200-branch.sh and t6030-bisect-porcelain.sh grep
 * for. Each case runs the same arguments through native git and through ours and compares
 * stdout (or the exit status and stderr of a refusal).
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createGitFilesBackend, openGitLinkedWorktrees } from "@statewalker/vcs-store-files";
import { encodeGitPath } from "@statewalker/vcs-utils/encoding";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Git, GitApiError, type ListBranchCommand, ListBranchMode } from "../src/index.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";
import { gitAtLeast } from "./native-git-working-copy.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root: string;
let version = "";

const env = (): Record<string, string> => ({ ...nativeGitEnv(root), TZ: "UTC" });

function run(cwd: string, args: string[]) {
  const r = spawnSync("git", args, { cwd, env: env() });
  return {
    status: r.status ?? 1,
    stdout: r.stdout as Buffer,
    stderr: (r.stderr as Buffer).toString("utf8"),
  };
}

/** Runs a setup script (bash, t/test-lib.sh's helpers defined) in `dir`. */
function sh(dir: string, script: string): void {
  const prelude = `
set -e
export GIT_AUTHOR_NAME="A U Thor" GIT_AUTHOR_EMAIL=author@example.com
export GIT_COMMITTER_NAME="C O Mitter" GIT_COMMITTER_EMAIL=committer@example.com
test_tick () {
  if test -z "\${test_tick+set}"; then test_tick=1112911993; else test_tick=$((test_tick + 60)); fi
  export GIT_COMMITTER_DATE="$test_tick -0700" GIT_AUTHOR_DATE="$test_tick -0700"
}
test_commit () {
  echo "$1" >"$1.t" && git add "$1.t" && test_tick && git commit -q -m "$1" && git tag "$1"
}
`;
  const r = spawnSync("bash", ["-c", prelude + script], { cwd: dir, env: env() });
  if (r.status !== 0) throw new Error(`setup failed: ${r.stderr.toString()}`);
}

async function openOurs(dir: string): Promise<Git> {
  const files = createNodeFilesApi({ rootDir: dir });
  const environment = createNodeGitHostEnvironment({ env: env() });
  const { history } = await createGitFilesBackend({ files, gitDir: ".git", environment });
  const worktrees = await openGitLinkedWorktrees({ files, gitDir: ".git", history, environment });
  return Git.fromWorkingCopy(await worktrees.openCurrent());
}

/** The command for `branch <args>` (list mode). */
function configure(command: ListBranchCommand, args: string[]): void {
  const patterns: string[] = [];
  const sort: string[] = [];
  const lists: Record<string, string[]> = {};
  let verbose = 0;
  for (const arg of args) {
    const eq = arg.indexOf("=");
    const [name, value] =
      arg.startsWith("--") && eq > 0 ? [arg.slice(0, eq), arg.slice(eq + 1)] : [arg, undefined];
    switch (name) {
      case "--list":
      case "-l":
      case "--no-column":
        break;
      case "-r":
      case "--remotes":
        command.setListMode(ListBranchMode.REMOTE);
        break;
      case "-a":
      case "--all":
        command.setListMode(ListBranchMode.ALL);
        break;
      case "-v":
      case "--verbose":
        verbose++;
        break;
      case "-vv":
        verbose += 2;
        break;
      case "--format":
        command.setFormat(value as string);
        break;
      case "--sort":
        sort.push(value as string);
        command.setSort(...sort);
        break;
      case "--abbrev":
        command.setAbbrev(Number(value));
        break;
      case "--no-abbrev":
        command.setAbbrev(0);
        break;
      case "--omit-empty":
        command.setOmitEmpty(true);
        break;
      case "--color":
        command.setColor(true);
        break;
      case "--no-color":
        command.setColor(false);
        break;
      case "-i":
      case "--ignore-case":
        command.setIgnoreCase(true);
        break;
      case "--points-at":
      case "--contains":
      case "--no-contains":
      case "--merged":
      case "--no-merged":
        if (!lists[name]) lists[name] = [];
        (lists[name] as string[]).push(value ?? "HEAD");
        break;
      default:
        if (arg.startsWith("-")) throw new Error(`unknown option ${arg}`);
        patterns.push(arg);
    }
  }
  if (verbose) command.setVerbose(verbose);
  if (patterns.length) command.setPatterns(...patterns);
  if (lists["--points-at"]) command.setPointsAt(...lists["--points-at"]);
  if (lists["--contains"]) command.setContains(...lists["--contains"]);
  if (lists["--no-contains"]) command.setNoContains(...lists["--no-contains"]);
  if (lists["--merged"]) command.setMerged(...lists["--merged"]);
  if (lists["--no-merged"]) command.setNoMerged(...lists["--no-merged"]);
}

/** A case: arguments, the git version it needs, a script run before it (and one after). */
interface Case {
  args: string[];
  /** [major, minor] native git must be at least */
  since?: [number, number];
  before?: string;
  after?: string;
}

/** Runs `c` through native git and ours in `dir` and compares the results. */
async function twin(dir: string, c: Case): Promise<void> {
  if (c.since && !gitAtLeast(version, c.since[0], c.since[1])) return;
  if (c.before) sh(dir, c.before);
  try {
    const native = run(dir, ["branch", ...c.args]);
    const label = `branch ${c.args.join(" ")}`;
    const git = await openOurs(dir);
    const command = git.branchList();
    try {
      configure(command, c.args);
      command.setCompatibility(gitAtLeast(version, 2, 45) ? "2.56" : "2.43");
      const result = await command.callText();
      expect({ label, status: 0, stderr: "" }).toEqual({
        label,
        status: native.status,
        stderr: native.stderr,
      });
      expect(Buffer.from(encodeGitPath(result.output)).toString("latin1"), label).toBe(
        native.stdout.toString("latin1"),
      );
      const warnings = result.warnings.map((w) => `${w}\n`).join("");
      expect(warnings, `${label} (stderr)`).toBe(native.stderr);
    } catch (e) {
      if (!(e instanceof GitApiError)) throw e;
      expect({ label, status: e.exitCode, message: e.message }).toEqual({
        label,
        status: native.status,
        message: e.exitCode === 129 ? e.message : native.stderr.replace(/\n$/, ""),
      });
      if (e.exitCode === 129) expect(native.stderr.startsWith(`${e.message}\n`), label).toBe(true);
    }
  } finally {
    if (c.after) sh(dir, c.after);
  }
}

/** t3203's setup: two commits, two branches, remote-tracking branches and origin/HEAD. */
const T3203_SETUP = `
git init -q -b main .
>file
git add file
test_tick
git commit -q -m one
echo >>file
test_tick
git commit -q -a -m two
git branch branch-one
git branch branch-two HEAD^
git update-ref refs/remotes/origin/branch-one branch-one
git update-ref refs/remotes/origin/branch-two branch-two
git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/branch-one
`;

/** t3203's listings on main. */
const T3203_LISTINGS: Case[] = [
  { args: [] },
  { args: ["--list"] },
  { args: ["--no-column"] },
  { args: ["--list", "branch*"] },
  { args: ["-r"] },
  { args: ["--remotes"] },
  { args: ["-a"] },
  { args: ["-a", "--no-column"] },
  { args: ["-v"] },
  { args: ["-vv"] },
  { args: ["-a", "-v"] },
  { args: ["-r", "-v"] },
  { args: ["-a", "-vv"] },
  { args: ["--list", "-v", "branch*"] },
  { args: ["--list", "--ignore-case", "-v", "BRANCH*"] },
  { args: ["--list", "-v", "--abbrev=10"] },
  { args: ["--list", "-v", "--abbrev=2"] },
  { args: ["--list", "-v", "--no-abbrev"] },
  { args: ["-a", "--list", "*one", "origin/HEAD"] },
  { args: ["--list", "nothing*"] },
  { args: ["--sort=objectsize"] },
  { args: ["--sort=-objectsize"] },
  { args: ["--sort=type"] },
  { args: ["--sort=-type"] },
  { args: ["--sort=-refname"] },
  { args: ["-a", "--sort=-refname"] },
  { args: ["--sort=committerdate", "--sort=-refname"] },
  { args: ["--points-at=branch-one"] },
  { args: ["-a", "--points-at=branch-two"] },
  { args: ["--format=Refname is %(refname)"] },
  { args: ["-a", "--format=%(refname:short) %(HEAD) %(objectname:short)"] },
  { args: ["--format=%(refname) %(ahead-behind:HEAD)"], since: [2, 41] },
  {
    args: ["--format=%(refname) %(ahead-behind:HEAD)", "--sort=ahead-behind:HEAD"],
    since: [2, 41],
  },
  { args: ["--format=%(rest)"] },
  { args: ["--format=%(refname"] },
  { args: ["--sort=bogus"] },
  {
    args: ["--format=%(if:notequals=refs/heads/main)%(refname)%(then)Refname is %(refname)%(end)"],
  },
  {
    args: [
      "--omit-empty",
      "--format=%(if:notequals=refs/heads/main)%(refname)%(then)Refname is %(refname)%(end)",
    ],
  },
  { args: ["--format=%(color:red)%(refname:short)", "--list", "main"] },
  { args: ["--color", "--format=%(color:red)%(refname:short)", "--list", "main"] },
  { args: ["--color"] },
  { args: ["--color", "-a", "-vv"] },
  {
    args: [],
    before: "git config branch.sort -refname",
    after: "git config --unset branch.sort",
  },
  {
    args: ["--sort=objectsize"],
    before: "git config branch.sort -refname",
    after: "git config --unset branch.sort",
  },
  {
    args: ["--color"],
    before: "git config color.branch.local yellow && git config color.branch.current 'bold blue'",
    after: "git config --unset color.branch.local && git config --unset color.branch.current",
  },
  {
    args: [],
    before: "git config color.branch always",
    after: "git config --unset color.branch",
  },
  { args: ["--points-at=nonexistent"] },
  { args: ["--contains=nonexistent"] },
];

describeGit("branch listing against native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "branch-list-native-"));
    version = run(root, ["--version"]).stdout.toString();
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const repo = (name: string, setup: string): string => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    sh(dir, setup);
    return dir;
  };

  it("t3203: listings, patterns, -r/-a, -v/-vv, --sort, --format, colors", {
    timeout: 300_000,
  }, async () => {
    const dir = repo("t3203", T3203_SETUP);
    for (const c of T3203_LISTINGS) await twin(dir, c);
  });

  it("t3203: detached HEAD descriptions, worktrees, symrefs", { timeout: 300_000 }, async () => {
    const dir = repo("t3203-detached", T3203_SETUP);
    const cases: Case[] = [
      // 'git branch shows detached HEAD properly'
      { before: "git checkout -q HEAD^0", args: [] },
      { args: ["-v"] },
      { args: ["-vv"] },
      { args: ["-a", "-v"] },
      { args: ["--sort=-refname"] },
      { args: ["--format=%(refname) %(HEAD)"] },
      { args: ["--list", "H*"] },
      { args: ["--list", "main"] },
      { args: ["-r"] },
      // after checkout --detach
      { before: "git checkout -q main && git checkout -q --detach", args: [] },
      // after moving
      { before: "git checkout -q HEAD^0 && git reset -q --hard HEAD^", args: ["-v"] },
      // from a tag
      {
        before: "git checkout -q main && git tag fromtag main && git checkout -q fromtag",
        args: [],
      },
      // after moving from a tag
      { before: "git reset -q --hard HEAD^", args: ["-v"] },
      // ambiguous branch/tag not marked
      { before: "git tag ambiguous && git branch ambiguous", args: ["--list", "ambiguous"] },
      // local-branch symrefs shortened properly
      {
        before:
          "git symbolic-ref refs/heads/ref-to-branch refs/heads/branch-one && git symbolic-ref refs/heads/ref-to-remote refs/remotes/origin/branch-one",
        args: [],
      },
      { args: ["-v"] },
      { args: ["-a"] },
      // worktree colors correct / verbose output lists worktree path
      { before: "git worktree add -q worktree_dir branch-two", args: [] },
      { args: ["--color"] },
      { args: ["-vv"] },
      { args: ["-v"] },
      { args: ["--format=%(refname:short) %(worktreepath)"] },
      {
        args: ["--color", "-vv"],
        after: "rm -r worktree_dir && git worktree prune",
      },
    ];
    for (const c of cases) await twin(dir, c);
  });

  it("t3203: sort branches, ignore case", { timeout: 120_000 }, async () => {
    const dir = repo(
      "t3203-icase",
      `git init -q -b main .
test_commit initial
git branch branch-one
git branch BRANCH-two`,
    );
    for (const c of [
      { args: [] },
      { args: ["-i"] },
      { args: ["-i", "-v"] },
      { args: ["-i", "--sort=-refname"] },
      { args: ["--list", "-i", "b*"] },
    ])
      await twin(dir, c);
  });

  it("t3203: version sort", { timeout: 120_000 }, async () => {
    const dir = repo(
      "t3203-version",
      `git init -q -b main .
test_commit initial
git branch b-1.10
git branch b-1.2
git branch b-1.9`,
    );
    for (const c of [
      { args: ["--sort=version:refname"] },
      { args: ["--sort=-version:refname"] },
      { args: ["--sort=v:refname", "-v"] },
    ])
      await twin(dir, c);
  });

  it("t3200 and t6030: rebasing and bisecting descriptions (get_head_description)", {
    timeout: 120_000,
  }, async () => {
    const dir = repo(
      "rebase",
      `git init -q -b main .
test_commit one
git checkout -q -b topic
echo topic >one.t && git commit -q -a -m topic
git checkout -q main
echo main >one.t && git commit -q -a -m main`,
    );
    const cases: Case[] = [
      {
        before: "git checkout -q topic && ! git rebase -q main >/dev/null 2>&1",
        args: [],
      },
      { args: ["-v"], after: "git rebase --abort" },
      {
        before: "git checkout -q --detach topic && ! git rebase -q main >/dev/null 2>&1",
        args: [],
        after: "git rebase --abort",
      },
      {
        before:
          "git checkout -q main && git bisect start -q 2>/dev/null || git bisect start >/dev/null; git checkout -q --detach HEAD^",
        args: [],
        after: "git bisect reset -q 2>/dev/null || git bisect reset >/dev/null",
      },
    ];
    for (const c of cases) await twin(dir, c);
  });

  it("t3201: --contains, --no-contains, --merged, --no-merged", {
    timeout: 300_000,
  }, async () => {
    const dir = repo(
      "t3201",
      `git init -q -b main .
>file
git add file
test_tick
git commit -q -m initial
git branch side
echo 1 >file
test_tick
git commit -q -a -m "second on main"
git checkout -q side
echo 1 >file
test_tick
git commit -q -a -m "second on side"
git merge -q main`,
    );
    const cases: Case[] = [
      { args: ["--contains=main"] },
      { args: ["--no-contains=main"] },
      { args: ["--contains=side"] },
      { args: ["--no-contains=side"] },
      { args: ["--contains=main", "main"] },
      { args: ["--no-contains=main", "main"] },
      { args: ["--merged"] },
      { args: ["--merged=side", "main"] },
      { args: ["--no-merged"] },
      { before: "git checkout -q main", args: ["--merged"] },
      { args: ["--no-merged"] },
      { args: ["--no-merged=main", "main"] },
      { args: ["--contains"] },
      // Assert that --contains only works on commits, not trees & blobs
      { args: ["--contains=main^{tree}"] },
      { args: ["--merged=main^{tree}"] },
      { args: ["--no-merged=main^{tree}"] },
      {
        before:
          "git checkout -q -b side2 main && >feature && git add feature && test_tick && git commit -q -m 'add feature' && git checkout -q -b next main && git merge -q side",
        args: ["--contains=side", "--contains=side2"],
      },
      { args: ["--merged=next", "--merged=main"] },
      { args: ["--no-contains=side", "--no-contains=side2"] },
      { args: ["--no-merged=next", "--no-merged=main"] },
      {
        before: "git checkout -q -b seen main && git merge -q side && git merge -q side2",
        args: ["--contains=side", "--no-contains=side2"],
      },
      { args: ["--merged=seen", "--no-merged=next"] },
      // branch --merged with --verbose
      {
        before:
          "git branch --track topic main >/dev/null && git branch zzz topic && git checkout -q topic && test_commit foo",
        args: ["--merged=topic"],
      },
      { args: ["--verbose", "--merged=topic"] },
      { args: ["-vv", "--merged=topic"] },
      { args: ["-vv"] },
      { args: ["-a", "-vv", "--contains=main"] },
      { args: ["--points-at=main"] },
      { args: ["--points-at=foo"] },
      // an upstream behind and ahead, and one gone
      {
        before:
          "git checkout -q main && git branch --track behind topic >/dev/null && git reset -q --hard HEAD^ && git checkout -q -b gone main && git branch -q --track tmp main && git config branch.gone.merge refs/heads/nowhere && git config branch.gone.remote . && git checkout -q main && git branch -D tmp >/dev/null",
        args: ["-v"],
      },
      { args: ["-vv"] },
      { args: ["--format=%(refname:short) %(upstream:short) %(upstream:track)"] },
    ];
    for (const c of cases) await twin(dir, c);
  });
});
