/**
 * History simplification against native git: `--full-history`, `--simplify-merges`,
 * `--simplify-by-decoration`, `--ancestry-path[=<commit>]`, `--sparse`/`--dense`,
 * `--show-pulls` and `--parents` of `git log` and `git rev-list`, their commit lists and their
 * `--graph` output. Each case runs the same command line through native git and through ours
 * and compares stdout and the exit status.
 *
 * Inputs come from git's t6012-rev-list-simplify (whose name-rev post-processing is left out:
 * the ids are compared; its `--exclude-first-parent-only` cases are not ported),
 * t6019-rev-list-ancestry-path (compared in git's order, not sorted) and
 * t6016-rev-list-graph-simplify-history (its `--graph --boundary` case is not ported: the
 * graph's boundary columns are not drawn).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitFilesBackend, openGitLinkedWorktrees } from "@statewalker/vcs-store-files";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Git, type LogOutputOptions } from "../src/index.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root = "";
let home = "";
/** The native git's version: 2.43 has no visual-root indentation in graphs */
let version243 = false;

type Outcome = { status: number; out: string };

/** git's test_tick: 60 seconds after the last one, zone -0700. */
let tick = 1112911993;
function tickEnv(extra: Record<string, string> = {}): Record<string, string> {
  tick += 60;
  return { GIT_COMMITTER_DATE: `${tick} -0700`, GIT_AUTHOR_DATE: `${tick} -0700`, ...extra };
}

function env(extra: Record<string, string> = {}): Record<string, string> {
  return { ...nativeGitEnv(home), ...extra };
}

function git(cwd: string, args: string[], extra: Record<string, string> = {}): string {
  return execFileSync("git", args, { cwd, env: env(extra), encoding: "latin1" }).trim();
}

/** git's failing commands of a setup (a merge that conflicts) */
function gitMayFail(cwd: string, args: string[], extra: Record<string, string> = {}): void {
  spawnSync("git", args, { cwd, env: env(extra), encoding: "latin1" });
}

/** git's test_commit: `<file>` (default `<message>.t`) holding `<content>`, committed, tagged */
function testCommit(repo: string, message: string, file = `${message}.t`, content = message) {
  writeFileSync(join(repo, file), `${content}\n`);
  git(repo, ["add", file]);
  git(repo, ["commit", "-qm", message], tickEnv());
  git(repo, ["tag", message]);
}

function init(name: string): string {
  const repo = join(root, name);
  git(root, ["init", "-q", "-b", "main", repo]);
  return repo;
}

async function open(repo: string): Promise<Git> {
  const files = createNodeFilesApi({ rootDir: repo });
  const environment = createNodeGitHostEnvironment({ env: env() });
  const { history } = await createGitFilesBackend({ files, gitDir: ".git", environment });
  const worktrees = await openGitLinkedWorktrees({ files, gitDir: ".git", history, environment });
  return Git.fromWorkingCopy(await worktrees.openCurrent());
}

function native(repo: string, args: string[]): Outcome {
  const r = spawnSync("git", args, { cwd: repo, env: env(), encoding: "latin1" });
  return { status: r.status ?? -1, out: r.stdout };
}

/** `git rev-list|log <args>` through ours. */
async function ours(repo: string, args: string[]): Promise<Outcome> {
  const [cmd, ...rest] = args;
  const command = (await open(repo)).revList();
  if (cmd === "rev-list") command.setCommittish(false);
  if (version243) command.setCompatibility("2.43");
  const log: LogOutputOptions = {};
  let paths = false;
  const flags: Record<string, () => void> = {
    "--full-history": () => command.setFullHistory(true),
    "--simplify-merges": () => command.setSimplifyMerges(true),
    "--simplify-by-decoration": () => command.setSimplifyByDecoration(true),
    "--ancestry-path": () => command.setAncestryPath(true),
    "--sparse": () => command.setDense(false),
    "--dense": () => command.setDense(true),
    "--show-pulls": () => command.setShowPulls(true),
    "--parents": () => {
      if (cmd === "rev-list") command.setParents(true);
      else log.parents = true;
    },
    "--first-parent": () => command.setFirstParent(true),
    "--topo-order": () => command.setOrder("topo"),
    "--date-order": () => command.setOrder("date"),
    "--author-date-order": () => command.setOrder("author-date"),
    "--oneline": () => (log.oneline = true),
    "-p": () => (log.patch = true),
    "--full-diff": () => (log.fullDiff = true),
    "--graph": () => {
      log.graph = true;
      if (version243) log.graphIndent = false;
    },
  };
  for (const a of rest) {
    if (paths) command.addPath(a);
    else if (a === "--") paths = true;
    else if (flags[a]) flags[a]();
    else if (a.startsWith("--ancestry-path=")) command.addAncestryPath(a.slice(16));
    else if (a.startsWith("--format=")) log.pretty = `tformat:${a.slice(9)}`;
    else if (a.startsWith("--pretty=")) log.pretty = a.slice(9);
    else command.addRevision(a);
  }
  try {
    const out = cmd === "rev-list" ? await command.callText() : await command.callLogText(log);
    return { status: 0, out };
  } catch {
    return { status: 128, out: "" };
  }
}

async function expectSame(repo: string, cases: string[][]): Promise<void> {
  for (const args of cases) {
    const n = native(repo, args);
    const o = await ours(repo, args);
    expect([args, o]).toEqual([args, n]);
  }
}

/** t6012's check_result: `git log --pretty="tformat:%P \t%H | %s" --parents <params>` */
function checkResult(params: string[]): string[] {
  return ["log", "--pretty=tformat:%P \t%H | %s", "--parents", ...params];
}

describeGit("history simplification against native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "history-simplification-native-"));
    home = join(root, "home");
    mkdirSync(home);
    version243 = /git version 2\.43\./.test(
      execFileSync("git", ["--version"], { encoding: "utf8" }),
    );
  });
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  describe("t6012-rev-list-simplify", () => {
    let repo = "";
    let pulls = "";
    beforeAll(() => {
      // A-----B-----G--H--I--K--L
      //  \     \      /     /
      //   \     \    /     /
      //    C--D--E--F     J
      repo = init("t6012");
      const write = (name: string, text: string) => writeFileSync(join(repo, name), text);
      write("file", "Hi there\n");
      write("lost", "initial\n");
      git(repo, ["add", "file", "lost"]);
      git(repo, ["commit", "-qm", "Initial file and lost"], tickEnv());
      git(repo, ["tag", "A"]);
      git(repo, ["branch", "other-branch"]);
      git(repo, ["symbolic-ref", "HEAD", "refs/heads/unrelated"]);
      git(repo, ["rm", "-qf", "*"]);
      write("side", "Unrelated branch\n");
      git(repo, ["add", "side"]);
      git(repo, ["commit", "-qm", "Side root"], tickEnv());
      git(repo, ["tag", "J"]);
      git(repo, ["checkout", "-q", "main"]);
      write("file", "Hello\n");
      write("lost", "second\n");
      git(repo, ["add", "file", "lost"]);
      const b = tickEnv();
      git(repo, ["commit", "-qm", "Modified file and lost"], {
        ...b,
        GIT_AUTHOR_DATE: `${tick + 120} -0700`,
      });
      git(repo, ["tag", "B"]);
      git(repo, ["checkout", "-q", "other-branch"]);
      write("file", "Hello\n");
      write("lost", "");
      git(repo, ["add", "file", "lost"]);
      git(repo, ["commit", "-qm", "Modified the file identically"], tickEnv());
      git(repo, ["tag", "C"]);
      write("another-file", "This is a stupid example\n");
      git(repo, ["add", "another-file"]);
      git(repo, ["commit", "-qm", "Add another file"], tickEnv());
      git(repo, ["tag", "D"]);
      const e = tickEnv();
      gitMayFail(repo, ["merge", "-q", "-m", "merge", "main"], e);
      write("lost", "");
      git(repo, ["commit", "-qam", "merge"], e);
      git(repo, ["tag", "E"]);
      write("elif", "Yet another\n");
      git(repo, ["add", "elif"]);
      git(repo, ["commit", "-qm", "Irrelevant change"], tickEnv());
      git(repo, ["tag", "F"]);
      git(repo, ["checkout", "-q", "main"]);
      write("elif", "Yet another\n");
      git(repo, ["add", "elif"]);
      git(repo, ["commit", "-qm", "Another irrelevant change"], tickEnv());
      git(repo, ["tag", "G"]);
      git(repo, ["merge", "-q", "-m", "merge", "other-branch"], tickEnv());
      git(repo, ["tag", "H"]);
      write("file", "Final change\n");
      git(repo, ["commit", "-qam", "Final change"], tickEnv());
      git(repo, ["tag", "I"]);
      git(repo, ["checkout", "-q", "main"]);
      git(
        repo,
        ["merge", "-q", "--allow-unrelated-histories", "-m", "Coolest", "unrelated"],
        tickEnv(),
      );
      git(repo, ["tag", "K"]);
      write("elif", "Immaterial\n");
      git(repo, ["add", "elif"]);
      git(repo, ["commit", "-qm", "Last"], tickEnv());
      git(repo, ["tag", "L"]);

      //   .-A---M-----C--N---O---P
      //  /     / \  \  \/   /   /
      // I     B   \  R-'`-Z'   /
      //  \   /     \/         /
      //   \ /      /\        /
      //    `---X--'  `---Y--'
      pulls = init("t6012-pulls");
      const put = (name: string, text: string) => writeFileSync(join(pulls, name), text);
      git(pulls, ["switch", "-qc", "topic"]);
      put("file", "base\n");
      git(pulls, ["add", "file"]);
      testCommit(pulls, "I");
      put("file", "A\n");
      git(pulls, ["add", "file"]);
      testCommit(pulls, "A");
      git(pulls, ["switch", "-qc", "branchB", "I"]);
      put("file", "B\n");
      git(pulls, ["add", "file"]);
      testCommit(pulls, "B");
      git(pulls, ["switch", "-q", "topic"]);
      const m = tickEnv();
      gitMayFail(pulls, ["merge", "-q", "-m", "M", "B"], m);
      put("file", "A\nB\n");
      git(pulls, ["add", "file"]);
      git(pulls, ["-c", "core.editor=true", "merge", "--continue"], m);
      git(pulls, ["tag", "M"]);
      put("other", "C\n");
      git(pulls, ["add", "other"]);
      testCommit(pulls, "C");
      git(pulls, ["switch", "-qc", "branchX", "I"]);
      put("file", "X\n");
      git(pulls, ["add", "file"]);
      testCommit(pulls, "X");
      git(pulls, ["switch", "-qc", "branchR", "M"]);
      git(pulls, ["merge", "-q", "-m", "R", "-Xtheirs", "X"], tickEnv());
      git(pulls, ["tag", "R"]);
      git(pulls, ["switch", "-q", "topic"]);
      git(pulls, ["merge", "-q", "-m", "N", "R"], tickEnv());
      git(pulls, ["tag", "N"]);
      git(pulls, ["switch", "-qc", "branchY", "M"]);
      put("y", "Y\n");
      git(pulls, ["add", "y"]);
      testCommit(pulls, "Y");
      git(pulls, ["switch", "-qc", "branchZ", "C"]);
      put("z", "Z\n");
      git(pulls, ["add", "z"]);
      testCommit(pulls, "Z");
      git(pulls, ["switch", "-q", "topic"]);
      git(pulls, ["merge", "-q", "-m", "O", "Z"], tickEnv());
      git(pulls, ["tag", "O"]);
      git(pulls, ["merge", "-q", "-m", "P", "Y"], tickEnv());
      git(pulls, ["tag", "P"]);
    });

    // t6012-rev-list-simplify.sh: "log $param" (check_result's cases, each titled `log <params>`)
    for (const params of [
      ["--full-history", "--topo-order"],
      ["--full-history"],
      ["--full-history", "--date-order"],
      ["--full-history", "--author-date-order"],
      ["--full-history", "--", "file"],
      ["--full-history", "--topo-order", "--", "file"],
      ["--full-history", "--date-order", "--", "file"],
      ["--full-history", "--author-date-order", "--", "file"],
      ["--simplify-merges", "--", "file"],
      ["--simplify-merges", "--topo-order", "--", "file"],
      ["--simplify-merges", "--date-order", "--", "file"],
      ["--simplify-merges", "--author-date-order", "--", "file"],
      ["--", "file"],
      ["--topo-order", "--", "file"],
      ["--date-order", "--", "file"],
      ["--author-date-order", "--", "file"],
      ["--first-parent", "--", "another-file"],
      ["--first-parent", "--topo-order", "--", "another-file"],
      ["--first-parent", "L"],
      ["F", "^L"],
      ["L", "^F"],
      ["--full-history", "E", "--", "lost"],
    ]) {
      it(`check_result ${params.join(" ")}`, async () => {
        await expectSame(repo, [checkResult(params)]);
      });
    }

    it('t6012-rev-list-simplify.sh: "full history simplification without parent"', async () => {
      await expectSame(repo, [
        ["log", "--pretty=tformat:%P \t%H | %s", "--full-history", "E", "--", "lost"],
      ]);
    });

    // t6012-rev-list-simplify.sh: "log $param" (the --show-pulls history's check_result cases)
    for (const params of [
      ["--", "file"],
      ["--show-pulls", "--", "file"],
      ["--full-history", "--topo-order", "--", "file"],
      ["--simplify-merges", "--topo-order", "--show-pulls", "--", "file"],
      ["--simplify-merges", "--topo-order", "--", "file"],
      ["--first-parent", "--", "file"],
      ["--first-parent", "--show-pulls", "--", "file"],
      ["--topo-order", "--ancestry-path", "A..HEAD", "--", "file"],
      ["--topo-order", "--show-pulls", "--ancestry-path", "A..HEAD", "--", "file"],
      ["--topo-order", "--full-history", "--ancestry-path", "A..HEAD", "--", "file"],
      ["--topo-order", "--simplify-merges", "--ancestry-path", "A..HEAD", "--", "file"],
      [
        "--topo-order",
        "--simplify-merges",
        "--show-pulls",
        "--ancestry-path",
        "A..HEAD",
        "--",
        "file",
      ],
    ]) {
      it(`check_result ${params.join(" ")} (the --show-pulls history)`, async () => {
        await expectSame(pulls, [checkResult(params)]);
      });
    }

    it('t6012-rev-list-simplify.sh: "--full-diff is not affected by --parents"', async () => {
      await expectSame(repo, [
        ["log", "-p", "--pretty=%H", "--full-diff", "--", "file"],
        ["log", "-p", "--pretty=%H", "--full-diff", "--parents", "--", "file"],
        ["log", "-p", "--pretty=%H", "--parents", "--simplify-merges", "--", "file"],
      ]);
    });

    it('t6012-rev-list-simplify.sh: "log --graph --simplify-merges --show-pulls"', async () => {
      await expectSame(pulls, [
        ["log", "--graph", "--pretty=%s", "--simplify-merges", "--show-pulls", "--", "file"],
      ]);
    });

    it('t6012-rev-list-simplify.sh: "log $param" through rev-list --parents', async () => {
      await expectSame(repo, [
        ["rev-list", "--parents", "--full-history", "HEAD", "--", "file"],
        ["rev-list", "--parents", "--simplify-merges", "HEAD", "--", "file"],
        ["rev-list", "--parents", "HEAD", "--", "file"],
        ["rev-list", "--full-history", "HEAD", "--", "file"],
        ["rev-list", "--sparse", "HEAD", "--", "file"],
        ["rev-list", "--sparse", "--full-history", "HEAD", "--", "file"],
        ["rev-list", "--dense", "--parents", "HEAD", "--", "lost"],
        ["rev-list", "--simplify-by-decoration", "HEAD"],
        ["rev-list", "--parents", "--simplify-by-decoration", "HEAD", "--", "lost"],
      ]);
      await expectSame(pulls, [
        ["rev-list", "--parents", "--simplify-merges", "--show-pulls", "HEAD", "--", "file"],
        ["rev-list", "--parents", "--ancestry-path", "A..HEAD", "--", "file"],
        ["rev-list", "--ancestry-path", "A..HEAD"],
      ]);
    });
  });

  describe("t6019-rev-list-ancestry-path", () => {
    let repo = "";
    let criss = "";
    beforeAll(() => {
      //          D---E-------F
      //         /     \       \
      //    B---C---G---H---I---J
      //   /                     \
      //  A-------K---------------L--M
      repo = init("t6019");
      const merge = (branch: string, name: string) => {
        git(repo, ["merge", "-q", "-s", "ours", "-m", name, branch], tickEnv());
        git(repo, ["tag", name]);
      };
      for (const c of ["A", "B", "C", "D", "E", "F"]) testCommit(repo, c);
      git(repo, ["reset", "-q", "--hard", "C"]);
      testCommit(repo, "G");
      merge("E", "H");
      testCommit(repo, "I");
      merge("F", "J");
      git(repo, ["reset", "-q", "--hard", "A"]);
      testCommit(repo, "K");
      merge("J", "L");
      testCommit(repo, "M");

      //   b---bc
      //  / \ /
      // a   X
      //  \ / \
      //   c---cb
      criss = init("t6019-criss-cross");
      testCommit(criss, "A");
      git(criss, ["checkout", "-qb", "xb", "main"]);
      testCommit(criss, "B");
      git(criss, ["checkout", "-qb", "xc", "main"]);
      testCommit(criss, "C");
      git(criss, ["checkout", "-qb", "xbc", "xb", "--"]);
      git(criss, ["merge", "-q", "--no-edit", "xc"], tickEnv());
      git(criss, ["checkout", "-qb", "xcb", "xc", "--"]);
      git(criss, ["merge", "-q", "--no-edit", "xb"], tickEnv());
      git(criss, ["checkout", "-q", "main"]);
    });

    const cases = [
      ["D..M"],
      ["--ancestry-path", "D..M"],
      ["--ancestry-path=F", "D..M"],
      ["--ancestry-path=G", "D..M"],
      ["--ancestry-path=H", "D..M"],
      ["--ancestry-path=K", "D..M"],
      ["--ancestry-path=F", "--ancestry-path=K", "D..M"],
      ["D..M", "--", "M.t"],
      ["--ancestry-path", "D..M", "--", "M.t"],
      ["F...I"],
      ["--ancestry-path", "F...I"],
      ["G..M", "--", "G.t"],
      ["--ancestry-path", "G..M", "--", "G.t"],
      ["--ancestry-path", "--simplify-merges", "G^..M", "--", "G.t"],
    ];
    // t6019-rev-list-ancestry-path.sh: "log $args" (test_ancestry's cases)
    for (const args of cases) {
      it(`test_ancestry ${args.join(" ")}`, async () => {
        await expectSame(repo, [
          ["log", "--format=%s", ...args],
          ["rev-list", "--parents", ...args],
          ["log", "--graph", "--format=%s", ...args],
        ]);
      });
    }

    it('t6019-rev-list-ancestry-path.sh: "log $args" without bottom commits or with a bad commit', async () => {
      await expectSame(repo, [
        ["rev-list", "--ancestry-path", "M"],
        ["rev-list", "--ancestry-path=nothing", "D..M"],
      ]);
    });

    it('t6019-rev-list-ancestry-path.sh: "criss-cross: rev-list --ancestry-path cb..bc", "criss-cross: rev-list --ancestry-path --all ^cb"', async () => {
      await expectSame(criss, [
        ["rev-list", "--ancestry-path", "xcb..xbc"],
        ["rev-list", "--ancestry-path", "--all", "^xcb"],
      ]);
    });
  });

  describe("t6016-rev-list-graph-simplify-history", () => {
    let repo = "";
    beforeAll(() => {
      repo = init("t6016");
      testCommit(repo, "A1", "foo.txt");
      testCommit(repo, "A2", "bar.txt");
      testCommit(repo, "A3", "bar.txt");
      git(repo, ["branch", "-m", "main", "A"]);
      git(repo, ["checkout", "-qb", "B", "A1"]);
      testCommit(repo, "B1", "foo.txt");
      testCommit(repo, "B2", "abc.txt");
      git(repo, ["checkout", "-qb", "C", "A2"]);
      testCommit(repo, "C1", "xyz.txt");
      testCommit(repo, "C2", "xyz.txt");
      git(repo, ["checkout", "-q", "A"]);
      git(repo, ["merge", "-q", "B", "C", "-m", "A4"], tickEnv());
      git(repo, ["tag", "A4"]);
      testCommit(repo, "A5", "bar.txt");
      git(repo, ["checkout", "-q", "C"]);
      testCommit(repo, "C3", "foo.txt");
      testCommit(repo, "C4", "bar.txt");
      git(repo, ["checkout", "-q", "A"]);
      git(repo, ["merge", "-q", "-s", "ours", "C", "-m", "A6"], tickEnv());
      git(repo, ["tag", "A6"]);
      testCommit(repo, "A7", "bar.txt");
    });

    const graph = (...args: string[]) => ["log", "--graph", "--format=%s", ...args];

    it('t6016-rev-list-graph-simplify-history.sh: "--graph --all"', async () => {
      await expectSame(repo, [graph("--all")]);
    });

    it('t6016-rev-list-graph-simplify-history.sh: "--graph --simplify-by-decoration"', async () => {
      git(repo, ["tag", "-d", "A4"]);
      await expectSame(repo, [
        graph("--all", "--simplify-by-decoration"),
        ["rev-list", "--parents", "--all", "--simplify-by-decoration"],
      ]);
    });

    it('t6016-rev-list-graph-simplify-history.sh: "--graph --simplify-by-decoration prune branch B"', async () => {
      git(repo, ["tag", "-d", "B2"]);
      git(repo, ["tag", "-d", "B1"]);
      git(repo, ["branch", "-qD", "B"]);
      await expectSame(repo, [
        graph("--simplify-by-decoration", "--all"),
        graph("--simplify-by-decoration", "--all", "--", "foo.txt"),
        ["rev-list", "--parents", "--simplify-by-decoration", "--all"],
      ]);
    });

    it('t6016-rev-list-graph-simplify-history.sh: "--graph --full-history -- bar.txt"', async () => {
      await expectSame(repo, [graph("--full-history", "--all", "--", "bar.txt")]);
    });

    it('t6016-rev-list-graph-simplify-history.sh: "--graph --full-history --simplify-merges -- bar.txt"', async () => {
      await expectSame(repo, [
        graph("--full-history", "--simplify-merges", "--all", "--", "bar.txt"),
        ["log", "--parents", "--oneline", "--simplify-merges", "--all", "--", "bar.txt"],
      ]);
    });

    it('t6016-rev-list-graph-simplify-history.sh: "--graph -- bar.txt"', async () => {
      await expectSame(repo, [graph("--all", "--", "bar.txt")]);
    });

    it('t6016-rev-list-graph-simplify-history.sh: "--graph --sparse -- bar.txt"', async () => {
      await expectSame(repo, [
        graph("--sparse", "--all", "--", "bar.txt"),
        graph("--sparse", "--full-history", "--all", "--", "bar.txt"),
        ["rev-list", "--parents", "--sparse", "--all", "--", "bar.txt"],
      ]);
    });

    it('t6016-rev-list-graph-simplify-history.sh: "--graph ^C4"', async () => {
      await expectSame(repo, [graph("--all", "^C4")]);
    });

    it('t6016-rev-list-graph-simplify-history.sh: "--graph ^C3"', async () => {
      await expectSame(repo, [graph("--all", "^C3")]);
    });
  });
});
