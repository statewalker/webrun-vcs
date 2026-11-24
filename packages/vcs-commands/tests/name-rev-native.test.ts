/**
 * `git name-rev` (builtin/name-rev.c), native twins: t6120-describe's name-rev tests and the
 * histories of JGit's NameRevCommandTest, each run by native git and by ours on the same
 * repository with git as the oracle (stdout, stderr and exit status compared).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { describeTwin, nameRevTwin, type Outcome, Shell } from "./describe-native-support.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root: string;
let shell: Shell;
let counter = 0;

async function check(dir: string, argv: string[], input?: string): Promise<Outcome> {
  const twin = await nameRevTwin(shell, dir, argv, input);
  expect(twin.ours).toEqual(twin.native);
  return twin.native;
}

/** A new repository (`main` its initial branch). */
function repository(name: string): string {
  const dir = join(root, `${name}-${counter++}`);
  shell.ok(root, "init", "-q", "-b", "main", dir);
  return dir;
}

/** JGit's TestRepository.commit(): an empty-tree commit of the next tick, its parents. */
function commit(dir: string, ...parents: string[]): string {
  shell.tick();
  const tree = shell.ok(dir, "mktree").trim();
  const args = ["commit-tree", tree, "-m", `c${counter++}`];
  for (const p of parents) args.push("-p", p);
  return shell.ok(dir, ...args).trim();
}

const update = (dir: string, ref: string, id: string) =>
  shell.ok(dir, "update-ref", ref.startsWith("refs/") ? ref : `refs/heads/${ref}`, id);

describeGit("git name-rev, native twins", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "name-rev-native-"));
    shell = new Shell(root);
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe("JGit NameRevCommandTest", () => {
    it("NameRevCommandTest.simple", async () => {
      const dir = repository("simple");
      const c = commit(dir);
      update(dir, "master", c);
      await check(dir, [c]);
      await check(dir, ["--name-only", c]);
    });

    it("NameRevCommandTest.prefix", async () => {
      const dir = repository("prefix");
      const c = commit(dir);
      update(dir, "refs/heads/master", c);
      update(dir, "refs/tags/tag", c);
      await check(dir, [c]);
      await check(dir, ["--refs=refs/heads/*", "--refs=refs/tags/*", c]);
      await check(dir, ["--refs=refs/tags/*", "--refs=refs/heads/*", c]);
      await check(dir, ["--refs=refs/tags/*", "--name-only", c]);
      await check(dir, ["--tags", "--name-only", c]);
      await check(dir, ["--tags", c]);
      await check(dir, ["--exclude=refs/heads/*", c]);
      await check(dir, ["--exclude=tag", c]);
    });

    it("NameRevCommandTest.ref", async () => {
      const dir = repository("ref");
      const c = commit(dir);
      update(dir, "refs/heads/master", c);
      update(dir, "refs/tags/tag", c);
      await check(dir, ["--refs=refs/heads/master", c]);
      await check(dir, ["--refs=refs/tags/tag", c]);
      await check(dir, ["--refs=tag", "--name-only", c]);
      await check(dir, ["--refs=master", "--name-only", c]);
    });

    it("NameRevCommandTest.annotatedTags", async () => {
      const dir = repository("annotated");
      const c = commit(dir);
      update(dir, "refs/heads/master", c);
      update(dir, "refs/tags/tag1", c);
      shell.ok(dir, "tag", "-a", "-m", "tag2", "tag2", c);
      await check(dir, ["--tags", c]);
      await check(dir, ["--tags", "--name-only", c]);
      await check(dir, [c]);
      const tag = shell.ok(dir, "rev-parse", "tag2").trim();
      await check(dir, [tag]);
      await check(dir, ["--peel-tag", tag]);
      await check(dir, ["--tags", "--name-only", tag]);
    });

    it("NameRevCommandTest.annotatedTagsNoResult", async () => {
      const dir = repository("no-result");
      const c = commit(dir);
      update(dir, "refs/heads/master", c);
      update(dir, "refs/tags/tag1", c);
      update(dir, "refs/tags/tag2", c);
      await check(dir, ["--tags", c]);
      await check(dir, ["--refs=nothing", c]);
      await check(dir, ["--refs=nothing", "--no-undefined", c]);
      await check(dir, ["--refs=nothing", "--no-undefined", "--always", c]);
      await check(dir, ["--refs=nothing", "--always", c]);
    });

    it("NameRevCommandTest.simpleAncestor", async () => {
      const dir = repository("ancestor");
      const c0 = commit(dir);
      const c1 = commit(dir, c0);
      const c2 = commit(dir, c1);
      update(dir, "master", c2);
      await check(dir, [c0, c1, c2]);
      await check(dir, ["--name-only", c0, c1, c2]);
    });

    it("NameRevCommandTest.multiplePathsNoMerge", async () => {
      const dir = repository("no-merge");
      const c0 = commit(dir);
      const c1 = commit(dir, c0);
      const c2 = commit(dir, c0);
      const c3 = commit(dir, c2);
      update(dir, "master", c1);
      update(dir, "branch", c3);
      await check(dir, [c0, c1, c2, c3]);
    });

    it("NameRevCommandTest.onePathMerge", async () => {
      const dir = repository("merge");
      const c0 = commit(dir);
      const c1 = commit(dir, c0);
      const c2 = commit(dir, c0);
      const c3 = commit(dir, c1, c2);
      update(dir, "master", c3);
      await check(dir, [c0, c1, c2, c3]);
    });

    it("NameRevCommandTest.onePathMergeSecondParent", async () => {
      const dir = repository("second");
      const c0 = commit(dir);
      const c1 = commit(dir, c0);
      const c2 = commit(dir, c0);
      const c3 = commit(dir, c2);
      const c4 = commit(dir, c1, c3);
      update(dir, "master", c4);
      await check(dir, [c0, c1, c2, c3, c4]);
    });

    it("NameRevCommandTest.onePathMergeLongerFirstParentPath", async () => {
      const dir = repository("longer");
      const c0 = commit(dir);
      const c1 = commit(dir, c0);
      const c2 = commit(dir, c1);
      const c3 = commit(dir, c0);
      const c4 = commit(dir, c2, c3);
      update(dir, "master", c4);
      await check(dir, [c0, c1, c2, c3, c4]);
    });

    it("NameRevCommandTest.multiplePathsSecondParent", async () => {
      const dir = repository("cost");
      const c0 = commit(dir);
      const c1 = commit(dir, c0);
      let c = c0;
      for (let i = 0; i < 5; i++) c = commit(dir, c);
      const c2 = commit(dir, c, c1);
      update(dir, "master", c2);
      await check(dir, [c0, c1, c2]);
      await check(dir, ["--name-only", c0]);
    });
  });

  it('t6120-describe.sh: "name-rev a rev shortly after epoch"', async () => {
    const dir = repository("epoch");
    shell.commit(dir, "--no-tag", "first");
    shell.ok(dir, "checkout", "-q", "--orphan", "no-timestamp-underflow");
    shell.git(dir, ["commit", "-q", "-m", "committer date shortly after epoch"], {
      env: { GIT_COMMITTER_DATE: "@1234 +0000" },
    });
    const old = shell.ok(dir, "rev-parse", "HEAD").trim();
    expect((await check(dir, [old])).stdout).toBe(`${old} no-timestamp-underflow\n`);
  });

  it('t6120-describe.sh: "name-rev covers all conditions while looking at parents"', async () => {
    const dir = repository("parents");
    const t = shell;
    t.commit(dir, "--no-tag", "A", "file", "A");
    const a = t.ok(dir, "rev-parse", "HEAD").trim();
    t.ok(dir, "checkout", "-q", "--detach");
    t.commit(dir, "--no-tag", "B", "file", "B");
    const b = t.ok(dir, "rev-parse", "HEAD").trim();
    t.ok(dir, "checkout", "-q", a);
    t.tick();
    t.ok(dir, "merge", "-q", "--no-ff", b);
    t.commit(dir, "--no-tag", "C", "file", "C");
    t.ok(dir, "checkout", "-q", a);
    t.tick();
    t.ok(dir, "merge", "-q", "--no-ff", "HEAD@{1}");
    t.ok(dir, "checkout", "-q", "main");
    t.tick();
    t.ok(dir, "merge", "-q", "--no-ff", "HEAD@{1}");
    expect((await check(dir, [b])).stdout).toBe(`${b} main^2^2~1^2\n`);
    const all = t.ok(dir, "rev-list", "--all").trim().split("\n");
    await check(dir, all);
    await check(dir, ["--annotate-stdin"], all.join("\n"));
  });

  describe("non-monotonic commit dates", () => {
    let dir: string;
    beforeAll(() => {
      // t6120-describe.sh: "non-monotonic commit dates setup"
      dir = repository("non-monotonic");
      shell.commit(dir, "A");
      shell.commit(dir, "--no-tag", "B");
      shell.commit(dir, "--no-tag", "--date", "@0 +0000", "C");
      shell.commit(dir, "D");
      shell.commit(dir, "E");
    });

    it('t6120-describe.sh: "name-rev with commitGraph handles non-monotonic timestamps"', async () => {
      shell.ok(dir, "-c", "core.commitGraph=true", "commit-graph", "write", "--reachable");
      shell.ok(dir, "config", "core.commitGraph", "true");
      expect((await check(dir, ["--tags", "main~3"])).stdout).toBe("main~3 tags/D~2\n");
      for (const rev of ["main", "main~1", "main~2", "main~4"]) await check(dir, ["--tags", rev]);
      // generation numbers of a graph without corrected dates (topological levels)
      rmSync(join(dir, ".git/objects/info/commit-graph"), { force: true });
      shell.ok(
        dir,
        "-c",
        "commitGraph.generationVersion=1",
        "commit-graph",
        "write",
        "--reachable",
      );
      await check(dir, ["--tags", "main~3"]);
      await check(dir, ["main~3", "main~4"]);
    });

    it('t6120-describe.sh: "name-rev --all works with non-monotonic timestamps"', async () => {
      shell.ok(dir, "config", "core.commitGraph", "false");
      rmSync(join(dir, ".git/objects/info/commit-graph"), { force: true });
      const twin = await nameRevTwin(shell, dir, ["--tags", "--all"]);
      const sorted = (s: string) => s.split("\n").sort().join("\n");
      expect(sorted(twin.ours.stdout)).toBe(sorted(twin.native.stdout));
      // without generations the date cutoff stops at C (dated 1970): B stays unnamed
      await check(dir, ["--tags", "main~3"]);
      await check(dir, ["--tags", "main~3", "main~4"]);
    });

    it('t6120-describe.sh: "name-rev --annotate-stdin works with non-monotonic timestamps"', async () => {
      const revs = shell.ok(dir, "log", "--pretty=%H");
      expect((await check(dir, ["--tags", "--annotate-stdin", "--name-only"], revs)).stdout).toBe(
        "E\nD\nD~1\nD~2\nA\n",
      );
    });

    it('t6120-describe.sh: "name-rev --all works with commitGraph"', async () => {
      shell.ok(dir, "config", "core.commitGraph", "true");
      shell.ok(dir, "commit-graph", "write", "--reachable");
      const twin = await nameRevTwin(shell, dir, ["--tags", "--all"]);
      const sorted = (s: string) => s.split("\n").sort().join("\n");
      expect(sorted(twin.ours.stdout)).toBe(sorted(twin.native.stdout));
      // t6120-describe.sh: "name-rev --annotate-stdin works with commitGraph"
      const revs = shell.ok(dir, "log", "--pretty=%H");
      await check(dir, ["--tags", "--annotate-stdin", "--name-only"], revs);
    });
  });

  it("tags of one date: the first by name names, the nearer wins", async () => {
    const dir = repository("same-date");
    // every commit and tag of one second
    const date = "1300000000 +0000";
    const env = { GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date };
    const tree = shell.ok(dir, "write-tree").trim();
    const mk = (msg: string, ...parents: string[]) =>
      shell
        .git(dir, ["commit-tree", tree, "-m", msg, ...parents.flatMap((p) => ["-p", p])], { env })
        .stdout.trim();
    const c0 = mk("c0");
    const c1 = mk("c1", c0);
    const c2 = mk("c2", c1);
    const s1 = mk("s1", c0);
    const m = mk("m", c2, s1);
    for (const [name, id] of [
      ["zeta", c2],
      ["alpha", c1],
      ["mid", s1],
      ["beta", m],
    ] as const) {
      update(dir, `refs/tags/${name}`, id);
    }
    shell.git(dir, ["tag", "-a", "-m", "x", "annotated-b", c2], { env });
    shell.git(dir, ["tag", "-a", "-m", "x", "annotated-a", s1], { env });
    update(dir, "main", m);
    update(dir, "other", c1);
    const all = [c0, c1, c2, s1, m];
    await check(dir, all);
    await check(dir, ["--tags", ...all]);
    await check(dir, ["--tags", "--name-only", ...all]);
    await check(dir, ["--refs=refs/heads/*", ...all]);
    await check(dir, ["--exclude=refs/tags/a*", ...all]);
    await check(dir, ["--refs=a*", "--name-only", ...all]);
    await check(dir, ["--annotate-stdin"], `${all.join(" and ")}\n`);
    await check(dir, ["--annotate-stdin", "--name-only", "--tags"], `${all.join("\n")}\n`);
  });

  it("revisions name-rev cannot read, and lists with --all", async () => {
    const dir = repository("errors");
    shell.commit(dir, "one");
    shell.commit(dir, "--no-tag", "two");
    const tree = shell.ok(dir, "rev-parse", "HEAD^{tree}").trim();
    await check(dir, ["no-such", "HEAD", tree, "one", "0123456789012345678901234567890123456789"]);
    await check(dir, ["--peel-tag", "HEAD", tree, "one"]);
    await check(dir, ["--no-undefined", "HEAD", tree]);
    await check(dir, ["--no-undefined", "--always", "HEAD", tree]);
    const twin = await nameRevTwin(shell, dir, ["--all", "HEAD"]);
    expect(twin.ours.status).toBe(twin.native.status);
    expect(twin.ours.stdout).toBe(twin.native.stdout);
    expect(twin.ours.stderr.split("\n")[0]).toBe(twin.native.stderr.split("\n")[0]);
  });
});

describeGit("git name-rev and describe in a shallow clone, native twins", () => {
  let dir: string;
  let bare: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "name-rev-shallow-"));
    shell = new Shell(root);
    const src = join(root, "src");
    shell.ok(root, "init", "-q", "-b", "main", src);
    shell.commit(src, "--annotate", "base");
    shell.commit(src, "one");
    shell.ok(src, "checkout", "-q", "-b", "side", "base");
    shell.commit(src, "--annotate", "two");
    shell.ok(src, "checkout", "-q", "main");
    shell.tick();
    shell.ok(src, "merge", "-q", "--no-ff", "-m", "merge", "side");
    shell.commit(src, "--no-tag", "top");
    // without the tags, the merge's parents are absent
    bare = join(root, "bare");
    shell.ok(root, "clone", "-q", "--no-local", "--depth=2", src, bare);
    dir = join(root, "s");
    shell.ok(root, "clone", "-q", "--no-local", "--depth=2", src, dir);
    shell.ok(dir, "fetch", "-q", "--tags", "--depth=2");
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("name-rev --all lists no parent the shallow boundary cuts off", async () => {
    const sorted = (s: string) => s.split("\n").sort().join("\n");
    for (const repo of [dir, bare]) {
      for (const argv of [["--all"], ["--tags", "--all"]]) {
        const twin = await nameRevTwin(shell, repo, argv);
        expect(sorted(twin.ours.stdout)).toBe(sorted(twin.native.stdout));
        expect(twin.ours.status).toBe(twin.native.status);
      }
    }
    for (const argv of [["--always"], ["--all"], ["--debug", "--always"]]) {
      const twin = await describeTwin(shell, bare, argv);
      expect(twin.ours).toEqual(twin.native);
    }
  });

  it("name-rev and describe stop at the shallow boundary", async () => {
    const all = shell.ok(dir, "rev-list", "--all").trim().split("\n");
    await check(dir, all);
    await check(dir, ["--tags", ...all]);
    await check(dir, ["--annotate-stdin"], all.join("\n"));
    for (const argv of [
      [],
      ["--tags"],
      ["--all"],
      ["--always"],
      ["--debug", "--tags"],
      ["--contains", "HEAD~1"],
    ]) {
      const twin = await describeTwin(shell, dir, argv);
      expect(twin.ours).toEqual(twin.native);
    }
    for (const rev of all) {
      const twin = await describeTwin(shell, dir, ["--tags", "--always", rev]);
      expect(twin.ours).toEqual(twin.native);
    }
  });
});
