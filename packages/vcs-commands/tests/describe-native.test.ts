/**
 * `git describe` (builtin/describe.c), native twins of t6120-describe: the history t6120
 * builds, each `check_describe` and test run by native git and by ours on the same
 * repository, stdout, stderr and the exit status compared (ids left as they are: both see
 * the same objects).
 */

import { mkdtempSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { describeTwin, nameRevTwin, type Outcome, Shell } from "./describe-native-support.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { CLEANUP_TIMEOUT, removeTempDir } from "./temp-dir-support.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root: string;
let shell: Shell;
let repo: string;

function same(twin: { native: Outcome; ours: Outcome }): Outcome {
  expect(twin.ours).toEqual(twin.native);
  return twin.native;
}

async function check(argv: string[], dir = repo): Promise<Outcome> {
  return same(await describeTwin(shell, dir, argv));
}

describeGit("git describe, native twins (t6120-describe)", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "describe-native-"));
    shell = new Shell(root);
    repo = join(root, "repo");
    shell.ok(root, "init", "-q", "-b", "main", repo);
    const t = shell;
    // t6120-describe.sh: "setup"
    t.commit(repo, "initial", "file", "one");
    t.commit(repo, "second", "file", "two");
    t.commit(repo, "third", "file", "three");
    t.commit(repo, "--annotate", "A", "file", "A");
    t.commit(repo, "c", "file", "c");
    t.ok(repo, "reset", "-q", "--hard", "second");
    t.commit(repo, "--annotate", "B", "side", "B");
    t.tick();
    t.ok(repo, "merge", "-q", "-m", "Merged", "c");
    const merged = t.ok(repo, "rev-parse", "HEAD").trim();
    t.ok(repo, "reset", "-q", "--hard", "second");
    t.commit(repo, "--no-tag", "D", "another", "D");
    t.tick();
    t.ok(repo, "tag", "-a", "-m", "R", "R");
    t.commit(repo, "e", "another", "DD");
    t.commit(repo, "--no-tag", "yet another", "another", "DDD");
    t.tick();
    t.ok(repo, "merge", "-q", "-m", "Merged", merged);
    t.commit(repo, "--no-tag", "x", "file");
  });
  afterAll(async () => {
    await removeTempDir(root);
  }, CLEANUP_TIMEOUT);

  const checks: string[][] = [
    ["HEAD"],
    ["HEAD^"],
    ["HEAD^^"],
    ["HEAD^^2"],
    ["HEAD^^2^"],
    ["HEAD^^^"],
    ["--tags", "HEAD"],
    ["--tags", "HEAD^"],
    ["--tags", "HEAD^^"],
    ["--tags", "HEAD^^2"],
    ["--tags", "HEAD^^2^"],
    ["--tags", "HEAD^^^"],
    ["--tags", "--exact-match", "HEAD^^^"],
    ["--all", "HEAD"],
    ["--all", "HEAD^"],
    ["--all", "HEAD^^^"],
    ["--long", "HEAD^^2^"],
    ["--long", "HEAD^^2"],
    ["--tags"],
    ["--first-parent", "--tags"],
    ["--tags", "--no-exact-match", "HEAD"],
    ["--first-parent", "--tags", "--no-exact-match", "HEAD"],
    ["--all", "A^0"],
    ["--debug", "HEAD"],
    ["--debug", "--tags", "HEAD^"],
    ["--candidates=1", "--debug", "HEAD"],
    ["--abbrev=12", "HEAD"],
    ["--abbrev=0", "HEAD^^"],
    ["--tags", "HEAD", "HEAD^^2", "HEAD^^^"],
  ];
  for (const argv of checks) {
    it(`t6120-describe.sh: "describe ${argv.join(" ")}"`, async () => {
      await check(argv);
    });
  }

  it('t6120-describe.sh: "describe R-1-gHASH R-1-g$(git rev-parse --short HEAD^^)~1"', async () => {
    const short = shell.ok(repo, "rev-parse", "--short", "HEAD^^").trim();
    await check([`R-1-g${short}~1`]);
  });

  it('t6120-describe.sh: "describe c-2-gHASH --tags c-2-g$(git rev-parse --short HEAD^^2)^0"', async () => {
    const short = shell.ok(repo, "rev-parse", "--short", "HEAD^^2").trim();
    await check(["--tags", `c-2-g${short}^0`]);
  });

  it('t6120-describe.sh: "--exact-match failure"', async () => {
    expect((await check(["--exact-match", "HEAD"])).status).toBe(128);
  });

  it("describe dies where nothing describes a commit or the options clash", async () => {
    await check(["--long", "--abbrev=0", "HEAD"]);
    await check(["--match=nothing*", "HEAD"]);
    await check(["--match=nothing*", "--always", "HEAD"]);
    await check(["no-such-revision"]);
    await check(["HEAD^{tree}"]);
    await check(["--exclude=*", "--tags", "--always", "HEAD^"]);
  });

  it('t6120-describe.sh: "describe --contains defaults to HEAD without commit-ish"', async () => {
    shell.ok(repo, "checkout", "-q", "A");
    try {
      expect((await check(["--contains"])).stdout).toBe("A^0\n");
    } finally {
      shell.ok(repo, "checkout", "-q", "-");
    }
  });

  it('t6120-describe.sh: "renaming tag A to Q locally produces a warning"', async () => {
    const a = shell.ok(repo, "rev-parse", "refs/tags/A").trim();
    shell.ok(repo, "update-ref", "refs/tags/Q", a);
    shell.ok(repo, "update-ref", "-d", "refs/tags/A");
    const out = await check(["HEAD"]);
    expect(out.stderr).toBe("warning: tag 'Q' is externally known as 'A'\n");
  });

  it('t6120-describe.sh: "misnamed annotated tag forces long output"', async () => {
    await check(["--no-long", "Q^0"]);
  });

  it('t6120-describe.sh: "abbrev=0 will not break misplaced tag (1)"', async () => {
    await check(["--abbrev=0", "Q^0"]);
  });

  it('t6120-describe.sh: "abbrev=0 will not break misplaced tag (2)"', async () => {
    await check(["--abbrev=0", "c^0"]);
    await check(["--all", "--abbrev=0", "c^0"]);
    await check(["Q"]);
  });

  it('t6120-describe.sh: "rename tag Q back to A"', async () => {
    const q = shell.ok(repo, "rev-parse", "refs/tags/Q").trim();
    shell.ok(repo, "update-ref", "refs/tags/A", q);
    shell.ok(repo, "update-ref", "-d", "refs/tags/Q");
    // an annotated tag given by name (2.43 describes the tag object itself)
    await check(["A"]);
    await check(["--all", "A"]);
    await check(["--long", "A"]);
  });

  it('t6120-describe.sh: "pack tag refs"', async () => {
    shell.ok(repo, "pack-refs");
    await check(["HEAD"]);
  });

  it('t6120-describe.sh: "describe --dirty with --work-tree"', async () => {
    await check(["--dirty"]);
    await check(["--broken"]);
  });

  it('t6120-describe.sh: "describe --dirty with --work-tree (dirty)"', async () => {
    writeFileSync(join(repo, "file"), "x\n\n");
    await check(["--dirty"]);
    await check(["--broken"]);
    await check(["--dirty=.mod"]);
    await check(["--dirty=.mod", "--broken=.broke"]);
  });

  it('t6120-describe.sh: "describe --dirty HEAD"', async () => {
    expect((await check(["--dirty", "HEAD"])).status).toBe(128);
    expect((await check(["--broken", "HEAD"])).status).toBe(128);
  });

  it('t6120-describe.sh: "set-up matching pattern tests"', async () => {
    const t = shell;
    t.ok(repo, "tag", "-a", "-m", "test-annotated", "test-annotated");
    writeFileSync(join(repo, "file"), "x\n\n\n");
    t.tick();
    t.ok(repo, "commit", "-q", "-a", "-m", "one more");
    t.ok(repo, "tag", "test1-lightweight");
    writeFileSync(join(repo, "file"), "x\n\n\n\n");
    t.tick();
    t.ok(repo, "commit", "-q", "-a", "-m", "yet another");
    t.ok(repo, "tag", "test2-lightweight");
    writeFileSync(join(repo, "file"), "x\n\n\n\n\n");
    t.tick();
    t.ok(repo, "commit", "-q", "-a", "-m", "even more");
    for (const argv of [
      ["--match=test-*"],
      ["--tags", "--match=test1-*"],
      ["--tags", "--match=test2-*"],
      ["--long", "--tags", "--match=test2-*", "HEAD^"],
      ["--long", "--tags", "--match=test1-*", "--match=test2-*", "HEAD^"],
      ["--long", "--tags", "--match=test1-*", "--no-match", "--match=test2-*", "HEAD^"],
      ["--long", "--tags", "--match=test1-*", "--match=test3-*", "HEAD"],
      ["--long", "--tags", "--match=test3-*", "--match=test1-*", "HEAD"],
    ]) {
      await check(argv);
    }
  });

  it('t6120-describe.sh: "set-up branches"', async () => {
    const t = shell;
    t.ok(repo, "branch", "branch_A", "A");
    t.ok(repo, "branch", "branch_C", "c");
    t.ok(repo, "update-ref", "refs/remotes/origin/remote_branch_A", "A^{commit}");
    t.ok(repo, "update-ref", "refs/remotes/origin/remote_branch_C", "c^{commit}");
    t.ok(repo, "update-ref", "refs/original/original_branch_A", "test-annotated~2");
    for (const argv of [
      ["--all", "--match=branch_*", "--exclude=branch_C", "HEAD"],
      ["--all", "--match=origin/remote_branch_*", "--exclude=origin/remote_branch_C", "HEAD"],
      ["--all", "test-annotated~1"],
      ["--all", "A"],
      ["--all", "c"],
      ["--all", "--match=branch_*", "branch_A"],
    ]) {
      await check(argv);
    }
  });

  it('t6120-describe.sh: "--match does not work for other types"', async () => {
    expect((await check(["--all", "--match=*original_branch_*", "test-annotated~1"])).status).toBe(
      128,
    );
  });

  it('t6120-describe.sh: "--exclude does not work for other types"', async () => {
    await check(["--all", "--exclude=any_pattern_even_not_matching", "test-annotated~1"]);
  });

  it('t6120-describe.sh: "describe --contains with the exact tags"', async () => {
    const tag = shell.ok(repo, "rev-parse", "refs/tags/A").trim();
    const commit = shell.ok(repo, "rev-parse", "refs/tags/A^0").trim();
    expect((await check(["--contains", tag])).stdout).toBe("A^0\n");
    expect((await check(["--contains", commit])).stdout).toBe("A^0\n");
  });

  it('t6120-describe.sh: "describe --contains and --match"', async () => {
    const commit = shell.ok(repo, "rev-parse", "refs/tags/A^0").trim();
    expect((await check(["--contains", "--match=B", commit])).status).toBe(128);
    await check(["--contains", "--match=B", "--match=A", commit]);
  });

  it('t6120-describe.sh: "describe --exclude"', async () => {
    const commit = shell.ok(repo, "rev-parse", "refs/tags/A^0").trim();
    await check(["--contains", "--match=?", "--exclude=A", commit]);
  });

  it('t6120-describe.sh: "describe --contains and --no-match"', async () => {
    const commit = shell.ok(repo, "rev-parse", "refs/tags/A^0").trim();
    await check(["--contains", "--match=B", "--no-match", commit]);
  });

  it('t6120-describe.sh: "describe --contains --all --match no matching commit"', async () => {
    const commit = shell.ok(repo, "rev-parse", "refs/tags/A^0").trim();
    await check(["--contains", "--all", "--match=B", commit]);
    await check(["--contains", "--always", "--match=B", commit]);
  });

  it("t6120-describe.sh: check_describe --contains --all (tags/A^0, branch_A, branch_C~1, remotes)", async () => {
    const commit = shell.ok(repo, "rev-parse", "refs/tags/A^0").trim();
    for (const argv of [
      ["--contains", "--all", "--match=A", commit],
      ["--contains", "--all", "--match=branch*", commit],
      ["--contains", "--all", "--match=branch*", "--exclude=branch_A", commit],
      [
        "--contains",
        "--all",
        "--exclude=A",
        "--exclude=c",
        "--exclude=test*",
        "--exclude=origin/remote_branch_A",
        commit,
      ],
      ["--contains", "--all", "--match=origin/remote*", commit],
      ["--contains", "--all", "--match=origin/remote*", "--exclude=origin/remote_branch_A", commit],
      ["--contains", "HEAD~3", "B", "HEAD^{tree}", "no-such"],
    ]) {
      await check(argv);
    }
  });

  it('t6120-describe.sh: "name-rev with exact tags"', async () => {
    const tag = shell.ok(repo, "rev-parse", "refs/tags/A").trim();
    const commit = shell.ok(repo, "rev-parse", "refs/tags/A^0").trim();
    same(await nameRevTwin(shell, repo, ["--tags", "--name-only", tag]));
    same(await nameRevTwin(shell, repo, ["--tags", "--name-only", commit]));
  });

  it('t6120-describe.sh: "name-rev --all"', async () => {
    const twin = await nameRevTwin(shell, repo, ["--all"]);
    const sorted = (s: string) => s.split("\n").sort().join("\n");
    expect(sorted(twin.ours.stdout)).toBe(sorted(twin.native.stdout));
    expect(twin.ours.status).toBe(twin.native.status);
  });

  it('t6120-describe.sh: "name-rev --annotate-stdin"', async () => {
    const list = shell.ok(repo, "rev-list", "--all");
    same(await nameRevTwin(shell, repo, ["--annotate-stdin"], list));
    same(
      await nameRevTwin(
        shell,
        repo,
        ["--annotate-stdin"],
        `see ${list.slice(0, 40)}, ${list.slice(0, 41)}x and ${list.slice(0, 39)}\r\nlast line`,
      ),
    );
  });

  it('t6120-describe.sh: "name-rev --annotate-stdin --name-only"', async () => {
    const list = shell.ok(repo, "rev-list", "--all");
    same(await nameRevTwin(shell, repo, ["--annotate-stdin", "--name-only"], list));
  });

  it('t6120-describe.sh: "setup and absorb a submodule"', async () => {
    const t = shell;
    const sub = join(repo, "sub1");
    t.ok(repo, "init", "-q", "-b", "main", "sub1");
    t.commit(sub, "initial");
    t.ok(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", "./sub1");
    t.ok(repo, "submodule", "absorbgitdirs");
    t.tick();
    t.ok(repo, "commit", "-q", "-a", "-m", "add submodule");
    await check(["--dirty"]);
    await check(["--broken"]);
  });

  it('t6120-describe.sh: "describe chokes on severely broken submodules"', async () => {
    renameSync(join(repo, ".git/modules/sub1"), join(repo, ".git/modules/sub_moved"));
    try {
      const native = shell.git(repo, ["describe", "--dirty"]);
      const twin = await describeTwin(shell, repo, ["--dirty"]);
      expect(native.status).toBe(128);
      expect(twin.ours.status).toBe(128);
      // t6120-describe.sh: "describe ignoring a broken submodule" (diff-index's fatal line
      // on stderr words the broken gitfile in its own way)
      const broken = await describeTwin(shell, repo, ["--broken"]);
      expect(broken.ours.stdout).toBe(broken.native.stdout);
      expect(broken.ours.status).toBe(broken.native.status);
      expect(broken.ours.stderr).toMatch(/^fatal: /);
    } finally {
      renameSync(join(repo, ".git/modules/sub_moved"), join(repo, ".git/modules/sub1"));
    }
  });

  it("describe --dirty reads submodules as diff-index does: no diff.ignoreSubmodules", async () => {
    const sub = join(repo, "sub1");
    const head = shell.ok(sub, "rev-parse", "HEAD").trim();
    try {
      // an untracked file in the submodule
      writeFileSync(join(sub, "untracked"), "u\n");
      await check(["--dirty", "--tags"]);
      shell.ok(repo, "config", "diff.ignoreSubmodules", "none");
      await check(["--dirty", "--tags"]);
      shell.ok(repo, "config", "--unset", "diff.ignoreSubmodules");
      for (const value of ["none", "untracked"]) {
        shell.ok(repo, "config", "submodule.sub1.ignore", value);
        await check(["--dirty", "--tags"]);
      }
      shell.ok(repo, "config", "--unset", "submodule.sub1.ignore");
      rmSync(join(sub, "untracked"));
      // a change inside the submodule
      writeFileSync(join(sub, "initial.t"), "changed\n");
      shell.ok(repo, "config", "diff.ignoreSubmodules", "all");
      await check(["--dirty", "--tags"]);
      shell.ok(repo, "config", "--unset", "diff.ignoreSubmodules");
      await check(["--dirty", "--tags"]);
      shell.ok(sub, "checkout", "-q", "--", "initial.t");
      // a new commit in the submodule
      shell.commit(sub, "--no-tag", "moved");
      for (const value of ["all", "dirty", "untracked", "none"]) {
        shell.ok(repo, "config", "diff.ignoreSubmodules", value);
        await check(["--dirty", "--tags"]);
        await check(["--broken", "--tags"]);
      }
      shell.ok(repo, "config", "--unset", "diff.ignoreSubmodules");
      // submodule.<name>.ignore still applies
      for (const value of ["all", "dirty", "none"]) {
        shell.ok(repo, "config", "submodule.sub1.ignore", value);
        await check(["--dirty", "--tags"]);
      }
    } finally {
      shell.git(repo, ["config", "--unset", "diff.ignoreSubmodules"]);
      shell.git(repo, ["config", "--unset", "submodule.sub1.ignore"]);
      shell.ok(sub, "reset", "-q", "--hard", head);
    }
    await check(["--dirty"]);
  });

  it('t6120-describe.sh: "describe a blob at a directly tagged commit"', async () => {
    writeFileSync(join(repo, "file"), "make it a unique blob\n");
    shell.ok(repo, "add", "file");
    shell.tick();
    shell.ok(repo, "commit", "-q", "-m", "content in file");
    shell.ok(repo, "tag", "-a", "-m", "latest annotated tag", "unique-file");
    expect((await check(["HEAD:file"])).stdout).toBe("unique-file:file\n");
  });

  it('t6120-describe.sh: "describe a blob with its first introduction"', async () => {
    const t = shell;
    t.tick();
    t.ok(repo, "commit", "-q", "--allow-empty", "-m", "empty commit");
    t.ok(repo, "rm", "-q", "file");
    t.tick();
    t.ok(repo, "commit", "-q", "-m", "delete blob");
    t.tick();
    t.ok(repo, "revert", "HEAD");
    t.tick();
    t.ok(repo, "commit", "-q", "--allow-empty", "-m", "empty commit");
    expect((await check(["HEAD:file"])).stdout).toBe("unique-file:file\n");
    await check(["HEAD:side"]);
  });

  it('t6120-describe.sh: "describe directly tagged blob"', async () => {
    shell.ok(repo, "tag", "test-blob", "unique-file:file");
    await check(["test-blob"]);
  });

  it('t6120-describe.sh: "describe tag object"', async () => {
    shell.ok(repo, "tag", "test-blob-1", "-a", "-m", "msg", "unique-file:file");
    expect((await check(["test-blob-1"])).status).toBe(128);
  });

  it('t6120-describe.sh: "describe an unreachable blob"', async () => {
    const blob = shell
      .git(repo, ["hash-object", "-w", "--stdin"], { input: "not-found-anywhere\n" })
      .stdout.trim();
    await check([blob]);
  });

  it('t6120-describe.sh: "describe complains about tree object"', async () => {
    expect((await check(["HEAD^{tree}"])).status).toBe(128);
  });

  it('t6120-describe.sh: "describe complains about missing object"', async () => {
    expect((await check(["0000000000000000000000000000000000000000"])).status).toBe(128);
  });

  it('t6120-describe.sh: "setup misleading taggerdates"', async () => {
    shell.git(repo, ["tag", "-a", "-m", "another tag", "newer-tag-older-commit", "unique-file~1"], {
      env: { GIT_COMMITTER_DATE: "2006-12-12 12:31" },
    });
    await check(["--contains", "unique-file~2"]);
  });

  it('t6120-describe.sh: "--always with no refs falls back to commit hash"', async () => {
    await check(["--no-abbrev", "--always", "--match=no-such-tag"]);
  });

  it('t6120-describe.sh: "--exact-match does not show --always fallback"', async () => {
    expect((await check(["--exact-match", "--always"])).status).toBe(128);
  });

  it('t6120-describe.sh: "describe works in a deep repo"', async () => {
    const deep = join(root, "deep");
    shell.ok(root, "init", "-q", "-b", "main", deep);
    let stream = "";
    for (let i = 1; i < 3000; i++) {
      stream += `commit refs/heads/main\ncommitter A U Thor <author@example.com> ${1000000000 + i * 100} +0200\ndata <<EOF\ncommit #${i}\nEOF\n`;
    }
    shell.git(deep, ["fast-import", "--quiet"], { input: stream });
    shell.ok(deep, "checkout", "-q", "main");
    shell.ok(deep, "tag", "far-far-away", "HEAD^");
    same(await nameRevTwin(shell, deep, ["HEAD~1500"]));
    shell.ok(deep, "tag", "-f", "far-far-away", "HEAD~2998");
    await check(["--tags", "--abbrev=0", "HEAD~1500"], deep);
  });

  it('t6120-describe.sh: "describe --dirty with a file with changed stat"', async () => {
    const dir = join(root, "stat-dirty");
    shell.ok(root, "init", "-q", dir);
    writeFileSync(join(dir, "file"), "A\n");
    shell.ok(dir, "add", "file");
    shell.ok(dir, "commit", "-q", "-m", "A");
    shell.ok(dir, "tag", "A", "-a", "-m", "A");
    const old = new Date(Date.now() - 10_000);
    utimesSync(join(dir, "file"), old, old);
    await check(["--dirty"], dir);
    // t6120-describe.sh: "describe --broken --dirty with a file with changed stat"
    utimesSync(join(dir, "file"), new Date(Date.now() - 20_000), new Date(Date.now() - 20_000));
    await check(["--dirty", "--broken"], dir);
  });

  it("describe with no names: --always, and dies without", async () => {
    const dir = join(root, "no-tags");
    shell.ok(root, "init", "-q", dir);
    shell.commit(dir, "--no-tag", "one");
    await check([], dir);
    await check(["--always"], dir);
    await check(["--contains"], dir);
    await check(["--contains", "--always"], dir);
  });

  it('t6120-describe.sh: "setup: describe commits with disjoint bases"', async () => {
    const dir = join(root, "disjoint1");
    const t = shell;
    t.ok(root, "init", "-q", "-b", "main", dir);
    const append = (line: string, file = "file") =>
      writeFileSync(join(dir, file), line, { flag: "a" });
    append("o\n");
    t.ok(dir, "add", "file");
    t.tick();
    t.ok(dir, "commit", "-q", "-m", "o");
    t.ok(dir, "tag", "H", "-a", "-m", "H");
    append("A\n");
    t.ok(dir, "add", "file");
    t.tick();
    t.ok(dir, "commit", "-q", "-m", "A");
    t.ok(dir, "tag", "A", "-a", "-m", "A");
    append("o\n");
    t.ok(dir, "add", "file");
    t.tick();
    t.ok(dir, "commit", "-q", "-m", "o");
    t.ok(dir, "checkout", "-q", "--orphan", "branch");
    rmSync(join(dir, "file"));
    append("B\n", "file2");
    t.ok(dir, "add", "-A");
    t.tick();
    t.ok(dir, "commit", "-q", "-m", "B");
    t.ok(dir, "tag", "B", "-a", "-m", "B");
    t.tick();
    t.ok(dir, "merge", "-q", "--no-ff", "--allow-unrelated-histories", "main", "-m", "x");
    await check(["HEAD"], dir);
    await check(["--candidates=2", "HEAD"], dir);
    await check(["--candidates=2", "--debug", "HEAD"], dir);
  });

  it('t6120-describe.sh: "setup: describe commits with disjoint bases 2"', async () => {
    const dir = join(root, "disjoint2");
    const t = shell;
    t.ok(root, "init", "-q", "-b", "main", dir);
    const step = (file: string, message: string, date: string) => {
      writeFileSync(join(dir, file), "o\n", { flag: "a" });
      t.ok(dir, "add", file);
      t.git(dir, ["commit", "-q", "-m", message], { env: { GIT_COMMITTER_DATE: date } });
    };
    step("file", "A", "2020-01-01 18:00");
    t.ok(dir, "tag", "A", "-a", "-m", "A");
    step("file", "o", "2020-01-01 18:01");
    t.ok(dir, "checkout", "-q", "--orphan", "branch");
    step("file2", "o", "2020-01-01 15:00");
    step("file2", "o", "2020-01-01 15:01");
    t.ok(dir, "tag", "H", "-a", "-m", "H");
    step("file2", "B", "2020-01-01 15:02");
    t.ok(dir, "tag", "B", "-a", "-m", "B");
    t.ok(dir, "merge", "-q", "--no-ff", "--allow-unrelated-histories", "main", "-m", "x");
    await check(["HEAD"], dir);
    await check(["--candidates=2", "HEAD"], dir);
    await check(["--candidates=2", "--debug", "HEAD"], dir);
  });
});
