/**
 * The tree attributes are read from (`$GIT_ATTR_SOURCE`, which `git --attr-source` sets, over
 * `attr.tree`), against native git: every attribute consumer reads the in-tree files of that
 * tree instead of the worktree's and the index's (a checkout's smudge, a check-in's clean,
 * diff and merge drivers, `log -- :(attr)`), in a repository with a worktree and in a bare
 * one. A `$GIT_ATTR_SOURCE` that names nothing is fatal; an `attr.tree` that names nothing is
 * ignored; a source that is no tree leaves no in-tree attributes.
 *
 * Every repository is built twice (never copied), with the same author and committer dates.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFileWorktree,
  createGitFilesBackend,
  FileStagingStore,
  GitCheckout,
  type GitCheckoutFilesApi,
  GitWorkingCopyConfig,
  openGitLinkedWorktrees,
} from "@statewalker/vcs-store-files";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { MemoryWorkingCopy } from "@statewalker/vcs-working-tree";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Git, ResetMode } from "../src/index.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root = "";
const env = (extra: Record<string, string> = {}) => ({ ...nativeGitEnv(root), ...extra });
const run = (cwd: string, args: string[], extra: Record<string, string> = {}) =>
  execFileSync("git", args, {
    cwd,
    env: env(extra),
    encoding: "latin1",
    stdio: ["ignore", "pipe", "pipe"],
  });
const put = (dir: string, path: string, content: string) => {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), content);
};
const bytes = (dir: string, path: string) => readFileSync(join(dir, path)).toString("latin1");

/** Our Git on a repository with a worktree, its environment from `extra` as native git's. */
async function open(dir: string, extra: Record<string, string> = {}) {
  const environment = createNodeGitHostEnvironment({ env: env(extra) });
  const files = createNodeFilesApi({ rootDir: dir });
  const { history } = await createGitFilesBackend({ files });
  const io = {
    read: async (path: string) => {
      try {
        return new Uint8Array(readFileSync(join(dir, path)));
      } catch {
        return undefined;
      }
    },
    write: async (path: string, content: Uint8Array) => writeFileSync(join(dir, path), content),
  };
  const config = new GitWorkingCopyConfig(io, ".git/config", {
    gitDirPath: join(dir, ".git"),
    environment,
  });
  await config.load();
  const staging = new FileStagingStore(files, ".git/index");
  await staging.read();
  const checkout = new GitCheckout({
    staging,
    refs: history.refs,
    files: {
      read: io.read,
      write: (p: string, c: Uint8Array) => files.write(p, [c]),
      stats: async () => undefined,
      remove: async () => {},
    } as unknown as GitCheckoutFilesApi,
    gitDir: ".git",
  });
  const worktree = createFileWorktree({
    files,
    rootPath: "",
    gitDir: ".git",
    blobs: history.blobs,
    trees: history.trees,
  });
  return Git.fromWorkingCopy(new MemoryWorkingCopy({ history, checkout, worktree, config }));
}

/**
 * `attrs` (tagged): `*.txt` text with CRLF in the worktree, `*.bin` without diff, `*.m`
 * merged as a union; HEAD then replaces those attributes with `* -text`.
 */
function build(dir: string): void {
  mkdirSync(dir, { recursive: true });
  run(dir, ["init", "-q", "-b", "main"]);
  put(dir, ".gitattributes", "*.txt text eol=crlf\n*.bin -diff\n*.m merge=union\nsub/*.c foo\n");
  put(dir, "sub/.gitattributes", "*.c bar\n");
  put(dir, "a.txt", "one\ntwo\n");
  put(dir, "x.bin", "x\n");
  put(dir, "f.m", "base\n");
  put(dir, "sub/k.c", "k\n");
  run(dir, ["add", "-A"]);
  run(dir, ["commit", "-q", "-m", "attrs"]);
  run(dir, ["tag", "attrs"]);
  put(dir, ".gitattributes", "* -text\n");
  rmSync(join(dir, "sub/.gitattributes"));
  put(dir, "sub/k.c", "k2\n");
  run(dir, ["add", "-A"]);
  run(dir, ["commit", "-q", "-m", "plain"]);
}

/** The same repository twice: `native` and `ours`. */
function twins(name: string): { native: string; ours: string } {
  const native = join(root, `${name}-native`);
  const ours = join(root, `${name}-ours`);
  build(native);
  build(ours);
  return { native, ours };
}

describeGit("attribute source (GIT_ATTR_SOURCE, attr.tree) against native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "attr-source-native-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("a checkout smudges with the source's attributes (attr.tree, then $GIT_ATTR_SOURCE)", async () => {
    const t = twins("checkout");
    for (const dir of [t.native, t.ours]) {
      run(dir, ["config", "attr.tree", "attrs"]);
      unlinkSync(join(dir, "a.txt"));
    }
    run(t.native, ["reset", "-q", "--hard"]);
    await (await open(t.ours)).reset().setMode(ResetMode.HARD).setRef("HEAD").call();
    expect(bytes(t.native, "a.txt")).toBe("one\r\ntwo\r\n");
    expect(bytes(t.ours, "a.txt")).toBe(bytes(t.native, "a.txt"));

    // $GIT_ATTR_SOURCE over attr.tree: HEAD's attributes (`* -text`) write LF again
    const source = { GIT_ATTR_SOURCE: "HEAD" };
    for (const dir of [t.native, t.ours]) unlinkSync(join(dir, "a.txt"));
    run(t.native, ["reset", "-q", "--hard"], source);
    await (await open(t.ours, source)).reset().setMode(ResetMode.HARD).setRef("HEAD").call();
    expect(bytes(t.native, "a.txt")).toBe("one\ntwo\n");
    expect(bytes(t.ours, "a.txt")).toBe(bytes(t.native, "a.txt"));
  });

  it("a check-in cleans with the source's attributes", async () => {
    const t = twins("add");
    const source = { GIT_ATTR_SOURCE: "attrs" };
    for (const dir of [t.native, t.ours]) put(dir, "b.txt", "x\r\ny\r\n");
    run(t.native, ["add", "b.txt"], source);
    await (await open(t.ours, source)).add().addFilepattern("b.txt").call();
    const staged = (dir: string) => run(dir, ["ls-files", "-s", "b.txt"]);
    expect(staged(t.ours)).toBe(staged(t.native));
    // CRLF cleaned to LF, as `text` asks
    expect(run(t.native, ["cat-file", "-p", ":b.txt"])).toBe("x\ny\n");
  });

  it("diff and merge drivers come from the source", async () => {
    const t = twins("drivers");
    const source = { GIT_ATTR_SOURCE: "attrs" };
    for (const dir of [t.native, t.ours]) put(dir, "x.bin", "y\n");
    const theirs = run(t.native, ["diff"], source);
    expect(theirs).toContain("Binary files a/x.bin and b/x.bin differ");
    expect(await (await open(t.ours, source)).diff().callText()).toBe(theirs);
    // without the source, HEAD's attributes: a text diff
    expect(await (await open(t.ours)).diff().callText()).toBe(run(t.native, ["diff"]));

    for (const dir of [t.native, t.ours]) {
      run(dir, ["checkout", "-q", "x.bin"]);
      run(dir, ["checkout", "-q", "-b", "side"]);
      put(dir, "f.m", "base\nside\n");
      run(dir, ["commit", "-q", "-am", "side"]);
      run(dir, ["checkout", "-q", "main"]);
      put(dir, "f.m", "base\nmain\n");
      run(dir, ["commit", "-q", "-am", "main"]);
    }
    run(t.native, ["merge", "-q", "--no-edit", "side"], source);
    await (await open(t.ours, source)).merge().include("side").call();
    expect(bytes(t.native, "f.m")).toBe("base\nmain\nside\n");
    expect(bytes(t.ours, "f.m")).toBe(bytes(t.native, "f.m"));
    expect(run(t.ours, ["rev-parse", "HEAD^{tree}"])).toBe(
      run(t.native, ["rev-parse", "HEAD^{tree}"]),
    );
  });

  /** `log -- <pathspec>` of ours, with `extra` in the environment. */
  async function ourLog(git: Git, paths: string[]): Promise<string[]> {
    let command = git.log();
    for (const p of paths) command = command.addPath(p);
    const out: string[] = [];
    for await (const c of await command.call()) out.push(c.id);
    return out;
  }
  const nativeLog = (dir: string, paths: string[], extra: Record<string, string> = {}) =>
    run(dir, ["log", "--format=%H", "--", ...paths], extra)
      .split("\n")
      .filter(Boolean);
  const specs = [
    [":(attr:merge=union)"],
    [":(attr:foo bar)"],
    [":(attr:!text)"],
    [":(attr:-diff)"],
  ];

  it("log -- :(attr) reads the source's attributes, with a worktree", async () => {
    const t = twins("log");
    const sources: Record<string, string>[] = [
      { GIT_ATTR_SOURCE: "attrs" },
      { GIT_ATTR_SOURCE: "HEAD" },
      {},
    ];
    for (const extra of sources) {
      const git = await open(t.ours, extra);
      for (const paths of specs) {
        expect(await ourLog(git, paths)).toEqual(nativeLog(t.native, paths, extra));
      }
    }
  });

  it("log -- :(attr) reads the source's attributes in a bare repository", async () => {
    const work = join(root, "bare-work");
    build(work);
    const bare = join(root, "bare.git");
    execFileSync("git", ["clone", "-q", "--bare", work, bare], { env: env() });
    run(bare, ["tag", "-f", "attrs", "main~1"]);
    const openBare = async (extra: Record<string, string>) => {
      const files = createNodeFilesApi({ rootDir: bare });
      const environment = createNodeGitHostEnvironment({ env: env(extra) });
      const { history } = await createGitFilesBackend({ files, gitDir: "." });
      const worktrees = await openGitLinkedWorktrees({ files, gitDir: ".", history, environment });
      return Git.fromWorktreeAdmin(await worktrees.openAdmin());
    };
    for (const extra of [{ GIT_ATTR_SOURCE: "attrs" }, { GIT_ATTR_SOURCE: "main" }]) {
      const git = await openBare(extra);
      for (const paths of specs) {
        expect(await ourLog(git, paths)).toEqual(nativeLog(bare, paths, extra));
      }
    }
    run(bare, ["config", "attr.tree", "attrs"]);
    const git = await openBare({});
    for (const paths of specs) expect(await ourLog(git, paths)).toEqual(nativeLog(bare, paths));
  });

  it("a bad $GIT_ATTR_SOURCE is fatal; a bad attr.tree is ignored; a blob gives none", async () => {
    const t = twins("bad");
    for (const dir of [t.native, t.ours]) put(dir, "x.bin", "y\n");
    const bad = { GIT_ATTR_SOURCE: "nope" };
    const r = spawnSync("git", ["diff"], { cwd: t.native, env: env(bad), encoding: "latin1" });
    expect(r.status).toBe(128);
    expect(r.stderr).toContain("fatal: bad --attr-source or GIT_ATTR_SOURCE");
    await expect((await open(t.ours, bad)).diff().callText()).rejects.toThrow(
      "bad --attr-source or GIT_ATTR_SOURCE",
    );
    // over attr.tree too
    for (const dir of [t.native, t.ours]) run(dir, ["config", "attr.tree", "attrs"]);
    await expect((await open(t.ours, bad)).diff().callText()).rejects.toThrow(
      "bad --attr-source or GIT_ATTR_SOURCE",
    );

    // attr.tree naming nothing: the worktree's attributes (HEAD's `* -text`), no error
    for (const dir of [t.native, t.ours]) run(dir, ["config", "attr.tree", "nope"]);
    expect(await (await open(t.ours)).diff().callText()).toBe(run(t.native, ["diff"]));
    for (const paths of specs) {
      expect(await ourLog(await open(t.ours), paths)).toEqual(nativeLog(t.native, paths));
    }

    // a blob (or a missing object by its full id): no in-tree attributes at all
    for (const name of [run(t.native, ["rev-parse", "attrs:a.txt"]).trim(), "1".repeat(40)]) {
      const extra = { GIT_ATTR_SOURCE: name };
      expect(await (await open(t.ours, extra)).diff().callText()).toBe(
        run(t.native, ["diff"], extra),
      );
      for (const paths of specs) {
        expect(await ourLog(await open(t.ours, extra), paths)).toEqual(
          nativeLog(t.native, paths, extra),
        );
      }
    }
  });
});
