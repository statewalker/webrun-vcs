/**
 * The split index (`core.splitIndex`, `link`) against native git: status, add, rm, commit,
 * reset and checkout on a split index write the index and shared index git writes for them;
 * a new shared index at `splitIndex.maxPercentChange`, old ones removed per
 * `splitIndex.sharedIndexExpire`, and `core.splitIndex=false` writing the index whole again.
 *
 * Twins run in one directory: the repository's state is saved, native git runs, its result
 * is kept, the state is put back and ours runs. The worktree and its stat data stay the same,
 * so the two indexes (and the shared indexes they name) are compared byte for byte.
 */
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeGitHostEnvironment } from "@statewalker/vcs-utils-node/files";
import { parseIndexFile, parseLinkExtension } from "@statewalker/vcs-working-tree";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type Git, ResetMode } from "../src/index.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root: string;
const env = () => nativeGitEnv(root);
const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, {
    cwd,
    env: env(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "split-index-native-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Seconds far in the past, a fresh one each time: no entry is ever racily clean. */
let clock = 1_500_000_000;
const second = () => {
  clock += 10;
  return clock;
};

function put(dir: string, path: string, content: string): void {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), content);
  const s = second();
  utimesSync(join(dir, path), s, s);
}

/** A committed repository of `count` files, `core.trustctime` off (ctime cannot be dated). */
function repo(count = 10): string {
  const dir = mkdtempSync(join(root, "repo-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "core.trustctime", "false"]);
  for (let i = 1; i <= count; i++) put(dir, `f${i}.txt`, `${i}\n`);
  put(dir, "d/a.txt", "a\n");
  put(dir, "d/b.txt", "b\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

/** What a twin run may change in `.git`: the index, shared indexes, HEAD's branch, logs. */
type State = Map<string, Buffer>;

const STATE_PATHS = [
  "index",
  "refs/heads/main",
  "logs/HEAD",
  "logs/refs/heads/main",
  "ORIG_HEAD",
  "HEAD",
];

function saveState(dir: string): State {
  const state: State = new Map();
  const gitDir = join(dir, ".git");
  for (const name of readdirSync(gitDir)) {
    if (name.startsWith("sharedindex.")) state.set(name, readFileSync(join(gitDir, name)));
  }
  for (const p of STATE_PATHS) {
    try {
      state.set(p, readFileSync(join(gitDir, p)));
    } catch {
      // absent
    }
  }
  return state;
}

function restoreState(dir: string, state: State, mtimes?: Map<string, number>): void {
  const gitDir = join(dir, ".git");
  for (const name of readdirSync(gitDir)) {
    if (name.startsWith("sharedindex.")) unlinkSync(join(gitDir, name));
  }
  for (const p of STATE_PATHS) rmSync(join(gitDir, p), { force: true });
  for (const [p, bytes] of state) {
    writeFileSync(join(gitDir, p), bytes);
    const m = mtimes?.get(p);
    if (m !== undefined) utimesSync(join(gitDir, p), m, m);
  }
}

/** The index and the shared indexes, as bytes by name. */
function indexFiles(dir: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const gitDir = join(dir, ".git");
  for (const name of readdirSync(gitDir).sort()) {
    if (name === "index" || name.startsWith("sharedindex."))
      out.set(name, readFileSync(join(gitDir, name)));
  }
  return out;
}

async function ours(dir: string): Promise<Git> {
  return openOurs(dir, createNodeGitHostEnvironment({ env: env() }));
}

/** Runs native git's `native` and our `run` on the same state; returns both results' index files. */
async function twins(
  dir: string,
  native: () => void,
  run: (git: Git) => Promise<unknown>,
): Promise<{ theirs: Map<string, Buffer>; ours: Map<string, Buffer> }> {
  const before = saveState(dir);
  native();
  const theirs = indexFiles(dir);
  restoreState(dir, before);
  await run(await ours(dir));
  return { theirs, ours: indexFiles(dir) };
}

function expectSame(result: { theirs: Map<string, Buffer>; ours: Map<string, Buffer> }): void {
  expect([...result.ours.keys()]).toEqual([...result.theirs.keys()]);
  for (const [name, bytes] of result.theirs) {
    expect(result.ours.get(name)?.equals(bytes), name).toBe(true);
  }
}

async function link(dir: string) {
  const parsed = await parseIndexFile(new Uint8Array(readFileSync(join(dir, ".git/index"))));
  const ext = parsed.extensionData.find((e) => e.signature === "link");
  return ext ? { ...parseLinkExtension(ext.data), entries: parsed.entries.length } : undefined;
}

describeGit("split index against native git", () => {
  it("status splits the index under core.splitIndex=true, as git", async () => {
    const dir = repo();
    git(dir, ["config", "core.splitIndex", "true"]);
    const result = await twins(
      dir,
      () => git(dir, ["status", "--porcelain"]),
      (g) => g.status().call(),
    );
    expectSame(result);
    expect([...result.ours.keys()].filter((n) => n.startsWith("sharedindex."))).toHaveLength(1);
    expect(git(dir, ["status", "--porcelain"])).toBe("");
  });

  it("add, rm and commit cycles write the split index git writes", async () => {
    const dir = repo();
    git(dir, ["config", "core.splitIndex", "true"]);
    git(dir, ["status", "--porcelain"]);
    put(dir, "f3.txt", "three\n");
    expectSame(
      await twins(
        dir,
        () => git(dir, ["add", "f3.txt"]),
        (g) => g.add().addFilepattern("f3.txt").call(),
      ),
    );
    const afterAdd = await link(dir);
    // d/a.txt d/b.txt f1.txt f10.txt f2.txt f3.txt: the sixth shared entry replaced
    expect(afterAdd?.replaced).toEqual([5]);
    expectSame(
      await twins(
        dir,
        () => git(dir, ["rm", "-q", "--cached", "f5.txt"]),
        (g) => g.rm().addFilepattern("f5.txt").setCached(true).call(),
      ),
    );
    expect((await link(dir))?.deleted?.length).toBe(1);
    put(dir, "new.txt", "new\n");
    expectSame(
      await twins(
        dir,
        () => git(dir, ["add", "new.txt"]),
        (g) => g.add().addFilepattern("new.txt").call(),
      ),
    );
    expectSame(
      await twins(
        dir,
        () => git(dir, ["commit", "-q", "-m", "second"]),
        (g) => g.commit().setMessage("second\n").call(),
      ),
    );
    expect(git(dir, ["status", "--porcelain"])).toBe("?? f5.txt");
  });

  it("writes a new shared index past splitIndex.maxPercentChange", async () => {
    const dir = repo();
    git(dir, ["config", "core.splitIndex", "true"]);
    git(dir, ["status", "--porcelain"]);
    const first = (await link(dir))?.baseId;
    // 2 new entries of 14: 14% is not over 20%
    put(dir, "n1.txt", "1\n");
    put(dir, "n2.txt", "2\n");
    expectSame(
      await twins(
        dir,
        () => git(dir, ["add", "n1.txt", "n2.txt"]),
        (g) => g.add().addFilepattern("n1.txt").addFilepattern("n2.txt").call(),
      ),
    );
    expect((await link(dir))?.baseId).toBe(first);
    // 2 more: 4 of 16 is 25%
    put(dir, "n3.txt", "3\n");
    put(dir, "n4.txt", "4\n");
    expectSame(
      await twins(
        dir,
        () => git(dir, ["add", "n3.txt", "n4.txt"]),
        (g) => g.add().addFilepattern("n3.txt").addFilepattern("n4.txt").call(),
      ),
    );
    const second = await link(dir);
    expect(second?.baseId).not.toBe(first);
    expect(second?.entries).toBe(0);
    // the old shared index is younger than two weeks: kept
    expect(readdirSync(join(dir, ".git")).filter((n) => n.startsWith("sharedindex."))).toHaveLength(
      2,
    );
  });

  it("splitIndex.maxPercentChange 0 writes a shared index every time, 100 never", async () => {
    const dir = repo();
    git(dir, ["config", "core.splitIndex", "true"]);
    git(dir, ["config", "splitIndex.maxPercentChange", "0"]);
    git(dir, ["status", "--porcelain"]);
    put(dir, "f1.txt", "one\n");
    expectSame(
      await twins(
        dir,
        () => git(dir, ["add", "f1.txt"]),
        (g) => g.add().addFilepattern("f1.txt").call(),
      ),
    );
    expect((await link(dir))?.entries).toBe(0);
    git(dir, ["config", "splitIndex.maxPercentChange", "100"]);
    for (let i = 0; i < 5; i++) put(dir, `m${i}.txt`, `${i}\n`);
    expectSame(
      await twins(
        dir,
        () => git(dir, ["add", "."]),
        (g) => g.add().addFilepattern(".").call(),
      ),
    );
    expect((await link(dir))?.entries).toBe(5);
  });

  it("removes shared indexes unused since splitIndex.sharedIndexExpire", async () => {
    const dir = repo();
    git(dir, ["config", "core.splitIndex", "true"]);
    git(dir, ["config", "splitIndex.maxPercentChange", "0"]);
    git(dir, ["status", "--porcelain"]);
    const shared = () => readdirSync(join(dir, ".git")).filter((n) => n.startsWith("sharedindex."));
    const [first] = shared() as [string];
    put(dir, "f1.txt", "one\n");
    git(dir, ["add", "f1.txt"]);
    expect(shared()).toHaveLength(2);
    // the first one, no longer used, three weeks old: past the default two weeks
    const weeks3 = Math.floor(Date.now() / 1000) - 21 * 24 * 3600;
    const age = (name: string) => utimesSync(join(dir, ".git", name), weeks3, weeks3);
    age(first);
    put(dir, "f2.txt", "two\n");
    const before = saveState(dir);
    git(dir, ["add", "f2.txt"]);
    const theirs = indexFiles(dir);
    restoreState(dir, before, new Map([[first, weeks3]]));
    await (await ours(dir)).add().addFilepattern("f2.txt").call();
    expectSame({ theirs, ours: indexFiles(dir) });
    expect(shared()).not.toContain(first);
    expect(shared()).toHaveLength(2);

    // never: nothing is removed
    git(dir, ["config", "splitIndex.sharedIndexExpire", "never"]);
    for (const name of shared()) age(name);
    const kept = shared();
    put(dir, "f3.txt", "three\n");
    await (await ours(dir)).add().addFilepattern("f3.txt").call();
    expect(shared()).toEqual(expect.arrayContaining(kept));
    expect(shared()).toHaveLength(3);

    // now: every one but the new one goes
    git(dir, ["config", "splitIndex.sharedIndexExpire", "now"]);
    put(dir, "f4.txt", "four\n");
    expectSame(
      await twins(
        dir,
        () => git(dir, ["add", "f4.txt"]),
        (g) => g.add().addFilepattern("f4.txt").call(),
      ),
    );
    expect(shared()).toHaveLength(1);
  });

  it("core.sharedRepository sets the new shared index's mode, as git", async () => {
    const modes: Record<string, string> = {};
    for (const value of ["group", "0640"]) {
      const dir = repo();
      git(dir, ["config", "core.splitIndex", "true"]);
      git(dir, ["config", "core.sharedRepository", value]);
      const copy = `${dir}-native`;
      execFileSync("cp", ["-a", dir, copy]);
      const result = await twins(
        dir,
        () => git(dir, ["status", "--porcelain"]),
        (g) => g.status().call(),
      );
      expectSame(result);
      const shared = readdirSync(join(dir, ".git")).find((n) => n.startsWith("sharedindex."));
      const ourMode = (statSync(join(dir, ".git", shared as string)).mode & 0o777).toString(8);
      // native git's, from its own run in a copy made before ours ran
      git(copy, ["status", "--porcelain"]);
      const theirs = readdirSync(join(copy, ".git")).find((n) => n.startsWith("sharedindex."));
      modes[value] = ourMode;
      expect(ourMode).toBe(
        (statSync(join(copy, ".git", theirs as string)).mode & 0o777).toString(8),
      );
    }
    expect(modes).toEqual({ group: "664", "0640": "640" });
  });

  it("core.splitIndex=false writes the index whole again", async () => {
    const dir = repo();
    git(dir, ["update-index", "--split-index"]);
    put(dir, "f6.txt", "six\n");
    git(dir, ["config", "core.splitIndex", "false"]);
    const result = await twins(
      dir,
      () => git(dir, ["add", "f6.txt"]),
      (g) => g.add().addFilepattern("f6.txt").call(),
    );
    expectSame(result);
    expect(await link(dir)).toBeUndefined();
    expect(git(dir, ["status", "--porcelain"])).toBe("M  f6.txt");
  });

  it("an index split by git, written by ours without configuration, stays split", async () => {
    const dir = repo();
    git(dir, ["update-index", "--split-index"]);
    put(dir, "f7.txt", "seven\n");
    put(dir, "d/c.txt", "c\n");
    expectSame(
      await twins(
        dir,
        () => git(dir, ["add", "f7.txt", "d/c.txt"]),
        (g) => g.add().addFilepattern("f7.txt").addFilepattern("d/c.txt").call(),
      ),
    );
    expect(git(dir, ["ls-files", "-s", "--debug"]).split("\n").length).toBeGreaterThan(13);
    expect(git(dir, ["status", "--porcelain"])).toBe("A  d/c.txt\nM  f7.txt");
  });

  it("reset and checkout on a split index: git reads what ours writes", async () => {
    const dir = repo();
    git(dir, ["config", "core.splitIndex", "true"]);
    git(dir, ["status", "--porcelain"]);
    put(dir, "f8.txt", "eight\n");
    git(dir, ["add", "f8.txt"]);
    git(dir, ["commit", "-q", "-m", "eight"]);
    git(dir, ["branch", "eight"]);
    git(dir, ["status", "--porcelain"]);
    const g = await ours(dir);
    await g.reset().setRef("HEAD~1").call();
    expect(git(dir, ["status", "--porcelain"])).toBe(" M f8.txt");
    expect(await link(dir)).toBeDefined();
    put(dir, "f8.txt", "8\n");
    git(dir, ["update-index", "--refresh"]);
    const g2 = await ours(dir);
    await g2.checkout().setName("eight").call();
    expect(git(dir, ["status", "--porcelain"])).toBe("");
    expect(git(dir, ["rev-parse", "HEAD"])).toBe(git(dir, ["rev-parse", "eight"]));
    expect(readFileSync(join(dir, "f8.txt"), "utf8")).toBe("eight\n");
    expect(statSync(join(dir, ".git/index")).size).toBeGreaterThan(0);
  });
});

/**
 * What an index holds once stat data is set aside: the index file's entries in file order
 * (replacements with stripped names included), its extensions, the link's bitmaps and the
 * shared index's entries. Twins on two copies of a repository differ only in stat data.
 */
async function structure(dir: string) {
  const gitDir = join(dir, ".git");
  const describe = (e: {
    path: string;
    objectId: string;
    mode: number;
    stage: number;
    skipWorktree?: boolean;
    intentToAdd?: boolean;
    assumeValid?: boolean;
  }) =>
    `${e.mode.toString(8)} ${e.objectId} ${e.stage}${e.skipWorktree ? "S" : ""}${e.intentToAdd ? "I" : ""}${e.assumeValid ? "V" : ""}\t${e.path}`;
  const main = await parseIndexFile(new Uint8Array(readFileSync(join(gitDir, "index"))));
  const linkExt = main.extensionData.find((e) => e.signature === "link");
  const link = linkExt ? parseLinkExtension(linkExt.data) : undefined;
  let shared: string[] = [];
  if (link) {
    const sharedIndex = await parseIndexFile(
      new Uint8Array(readFileSync(join(gitDir, `sharedindex.${link.baseId}`))),
    );
    shared = sharedIndex.entries.map(describe);
  }
  return {
    version: main.version,
    entries: main.entries.map(describe),
    extensions: main.extensions,
    tree: main.extensionData.find((e) => e.signature === "TREE")?.data.toString(),
    deleted: link?.deleted,
    replaced: link?.replaced,
    shared,
  };
}

/**
 * {@link structure} without the cache-tree: where ours computes another `TREE` than git
 * after a branch switch or a stash, whether the index is split or not (a known difference of
 * those commands, not of the split index)
 */
async function entriesStructure(dir: string) {
  const { tree: _tree, ...rest } = await structure(dir);
  return rest;
}

/** Two copies of `dir` (native, ours), each index refreshed against its own copy's stat data. */
function copies(dir: string): { native: string; ours: string } {
  const native = `${dir}-native`;
  const mine = `${dir}-ours`;
  for (const d of [native, mine]) {
    execFileSync("cp", ["-a", dir, d]);
    git(d, ["update-index", "-q", "--refresh"]);
  }
  return { native, ours: mine };
}

describeGit("split index through unpack-trees commands, against native git", () => {
  /** A split repository with a second branch, a staged and an unstaged change. */
  function branched(): string {
    const dir = repo();
    git(dir, ["config", "core.splitIndex", "true"]);
    git(dir, ["status", "--porcelain"]);
    git(dir, ["checkout", "-q", "-b", "side"]);
    put(dir, "f2.txt", "side\n");
    put(dir, "s.txt", "s\n");
    git(dir, ["rm", "-q", "f9.txt"]);
    git(dir, ["add", "."]);
    git(dir, ["commit", "-q", "-m", "side"]);
    git(dir, ["checkout", "-q", "main"]);
    put(dir, "f1.txt", "main\n");
    git(dir, ["commit", "-q", "-a", "-m", "main"]);
    put(dir, "f3.txt", "staged\n");
    git(dir, ["add", "f3.txt"]);
    put(dir, "f4.txt", "unstaged\n");
    // the files the checkouts wrote, dated back: none is racily clean
    const s = second();
    for (const name of readdirSync(dir, { recursive: true }) as string[]) {
      if (name !== ".git" && !name.startsWith(".git/")) utimesSync(join(dir, name), s, s);
    }
    git(dir, ["update-index", "-q", "--refresh"]);
    return dir;
  }

  it("switch writes the split index git writes", async () => {
    const { native, ours: mine } = copies(branched());
    git(native, ["switch", "-q", "side"]);
    await (await ours(mine)).switch().setName("side").call();
    expect(await entriesStructure(mine)).toEqual(await entriesStructure(native));
    expect(git(mine, ["status", "--porcelain"])).toBe(git(native, ["status", "--porcelain"]));
  });

  it("reset --hard and --mixed write the split index git writes", async () => {
    for (const mode of ["hard", "mixed"] as const) {
      const { native, ours: mine } = copies(branched());
      git(native, ["reset", "-q", `--${mode}`, "side"]);
      await (await ours(mine))
        .reset()
        .setRef("side")
        .setMode(mode === "hard" ? ResetMode.HARD : ResetMode.MIXED)
        .call();
      expect(await structure(mine)).toEqual(await structure(native));
      expect(git(mine, ["status", "--porcelain"])).toBe(git(native, ["status", "--porcelain"]));
      rmSync(native, { recursive: true, force: true });
      rmSync(mine, { recursive: true, force: true });
    }
  });

  it("merge writes the split index git writes", async () => {
    const dir = branched();
    git(dir, ["reset", "-q", "--hard"]);
    const { native, ours: mine } = copies(dir);
    git(native, ["merge", "-q", "--no-edit", "side"]);
    await (await ours(mine)).merge().include("side").call();
    expect(await structure(mine)).toEqual(await structure(native));
    expect(git(mine, ["rev-parse", "HEAD^{tree}"])).toBe(git(native, ["rev-parse", "HEAD^{tree}"]));
  });

  it("stash and stash apply leave a split index git reads", async () => {
    const { native, ours: mine } = copies(branched());
    git(native, ["stash", "push", "-q"]);
    const g = await ours(mine);
    await g.stashCreate().call();
    expect(await entriesStructure(mine)).toEqual(await entriesStructure(native));
    git(native, ["stash", "apply", "-q", "--index"]);
    await (await ours(mine)).stashApply().setRestoreIndex(true).call();
    expect(git(mine, ["status", "--porcelain"])).toBe(git(native, ["status", "--porcelain"]));
    expect(git(mine, ["ls-files", "-s"])).toBe(git(native, ["ls-files", "-s"]));
    expect(await link(mine)).toBeDefined();
  });

  it("add -i patches into a split index as git", async () => {
    const { native, ours: mine } = copies(branched());
    const answers = ["p", "f4.txt", "", "y", "q"];
    execFileSync(
      "git",
      ["-c", "color.ui=false", "-c", "interactive.singleKey=false", "add", "-i"],
      {
        cwd: native,
        env: { ...env(), GIT_PAGER: "cat" },
        input: answers.map((a) => `${a}\n`).join(""),
      },
    );
    const queue = [...answers];
    await (await ours(mine))
      .add()
      .setInteractive(true)
      .setPatchSelector(() => queue.shift())
      .call();
    expect(await structure(mine)).toEqual(await structure(native));
    expect(git(mine, ["status", "--porcelain"])).toBe(git(native, ["status", "--porcelain"]));
  });
});

describeGit("split index and sparse index together, against native git", () => {
  const sparseRepo = () => {
    const dir = repo(3);
    git(dir, ["sparse-checkout", "set", "--sparse-index"]);
    expect(git(dir, ["ls-files", "--sparse"])).toBe("d/\nf1.txt\nf2.txt\nf3.txt");
    return dir;
  };

  it("core.splitIndex=true on a sparse index dies on read, as git (both versions)", async () => {
    const dir = sparseRepo();
    git(dir, ["config", "core.splitIndex", "true"]);
    const before = readFileSync(join(dir, ".git/index"));
    let theirs = "";
    try {
      git(dir, ["status", "--porcelain"]);
    } catch (error) {
      theirs = String((error as { stderr?: string }).stderr);
    }
    expect(theirs).toBe("fatal: cannot use split index with a sparse index\n");
    await expect((await ours(dir)).status().call()).rejects.toThrow(
      "cannot use split index with a sparse index",
    );
    put(dir, "f1.txt", "changed\n");
    await expect((await ours(dir)).add().addFilepattern("f1.txt").call()).rejects.toThrow(
      "cannot use split index with a sparse index",
    );
    expect(readFileSync(join(dir, ".git/index")).equals(before)).toBe(true);
    expect(readdirSync(join(dir, ".git")).some((n) => n.startsWith("sharedindex."))).toBe(false);
  });

  it("a split index under index.sparse stays split and whole (convert_to_sparse returns early)", async () => {
    const dir = repo(3);
    git(dir, ["config", "core.splitIndex", "true"]);
    git(dir, ["status", "--porcelain"]);
    git(dir, ["config", "--unset", "core.splitIndex"]);
    git(dir, ["sparse-checkout", "set", "--sparse-index"]);
    expect(git(dir, ["ls-files", "--sparse"])).toBe("d/a.txt\nd/b.txt\nf1.txt\nf2.txt\nf3.txt");
    put(dir, "f1.txt", "changed\n");
    git(dir, ["update-index", "-q", "--refresh"]);
    const result = await twins(
      dir,
      () => git(dir, ["add", "f1.txt"]),
      (g) => g.add().addFilepattern("f1.txt").call(),
    );
    expectSame(result);
    const parsed = await parseIndexFile(new Uint8Array(readFileSync(join(dir, ".git/index"))));
    expect(parsed.extensions).toContain("link");
    expect(parsed.extensions).not.toContain("sdir");
    expect(git(dir, ["status", "--porcelain"])).toBe("M  f1.txt");
  });
});
