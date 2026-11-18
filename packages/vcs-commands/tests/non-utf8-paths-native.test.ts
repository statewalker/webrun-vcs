/**
 * Paths that are no valid UTF-8 against native git: a latin-1 `caf\xe9.txt` (and a
 * directory `d\xff`) made by native git. Git paths are bytes; ours carry the bytes that are
 * no UTF-8 as `decodeGitPath`'s escapes, so reading a tree or the index and writing it back
 * keeps the ids and the bytes, the output quotes them as git does (`"caf\351.txt"`), and
 * the worktree names are the original bytes on Linux. Twins are built by the same steps
 * (never copied).
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileStagingStore } from "@statewalker/vcs-store-files";
import { decodeGitPath, encodeGitPath } from "@statewalker/vcs-utils/encoding";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { formatStatusPorcelain } from "../src/index.js";
import { INTEROP_IDENT, openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root: string;
let counter = 0;

/** Native git's stdout as bytes. */
function gitBytes(cwd: string, ...args: string[]): Buffer {
  return execFileSync("git", args, {
    cwd,
    env: nativeGitEnv(root),
    stdio: ["ignore", "pipe", "pipe"],
  });
}
const gitText = (cwd: string, ...args: string[]) => gitBytes(cwd, ...args).toString("latin1");

/** A path given as latin-1 text (each char one byte), as a Buffer for node:fs. */
const raw = (path: string) => Buffer.from(path, "latin1");
/** The same path as our commands name it. */
const ours = (path: string) => decodeGitPath(raw(path));

function putRaw(dir: string, path: string, content: string) {
  const full = Buffer.concat([raw(`${dir}/`), raw(path)]);
  const parent = full.subarray(0, full.lastIndexOf(0x2f));
  mkdirSync(parent, { recursive: true });
  writeFileSync(full, content);
}

/** A repository with a latin-1 file, a latin-1 directory, a UTF-8 name and an ASCII one. */
function build(): string {
  const dir = join(root, `repo-${counter++}`);
  mkdirSync(dir);
  gitBytes(dir, "init", "-q", "-b", "main");
  putRaw(dir, "caf\xe9.txt", "latin-1\n");
  putRaw(dir, "d\xff/n\xe9", "in a latin-1 directory\n");
  writeFileSync(join(dir, "café.txt"), "utf-8\n");
  writeFileSync(join(dir, "plain.txt"), "plain\n");
  gitBytes(dir, "add", "-A");
  gitBytes(dir, "commit", "-q", "-m", "base");
  return dir;
}

/** Our status, porcelain v1 and v2, as bytes. */
async function ourStatus(dir: string, version: 1 | 2) {
  const git = await openOurs(dir);
  return Buffer.from(encodeGitPath(formatStatusPorcelain(await git.status().call(), version)));
}

describeGit("paths that are no valid UTF-8, against native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "non-utf8-paths-"));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("a tree read and stored again keeps its id", async () => {
    const dir = build();
    const git = await openOurs(dir);
    const history = git.workingCopy.history;
    const head = await history.refs.resolve("HEAD");
    const treeId = (await history.commits.load(head?.objectId ?? ""))?.tree ?? "";
    expect(treeId).toBe(gitText(dir, "rev-parse", "HEAD^{tree}").trim());
    const entries = [];
    for await (const e of (await history.trees.load(treeId)) ?? []) entries.push(e);
    expect(entries.map((e) => e.name)).toEqual([
      // git's byte order: "café" is caf\xc3\xa9, before caf\xe9
      "café.txt",
      ours("caf\xe9.txt"),
      ours("d\xff"),
      "plain.txt",
    ]);
    // stored again in another order: the same tree
    expect(await history.trees.store([...entries].reverse())).toBe(treeId);
    rmSync(dir, { recursive: true, force: true });
  });

  it("the index read and written back keeps its bytes", async () => {
    const dir = build();
    const before = readFileSync(join(dir, ".git/index"));
    const staging = new FileStagingStore(createNodeFilesApi({ rootDir: dir }), ".git/index");
    await staging.read();
    const paths: string[] = [];
    for await (const e of staging.entries()) paths.push(e.path);
    expect(paths).toEqual(["café.txt", ours("caf\xe9.txt"), ours("d\xff/n\xe9"), "plain.txt"]);
    // rewritten as a command would (the cache-tree dropped once an entry is replaced)
    await staging.write();
    expect(Buffer.compare(readFileSync(join(dir, ".git/index")), before)).toBe(0);
    expect(gitText(dir, "ls-files", "-s")).toBe(
      gitText(dir, "ls-tree", "-r", "HEAD").replace(/^(\d+) blob ([0-9a-f]+)\t/gm, "$1 $2 0\t"),
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it("status quotes the names as git does", async () => {
    const dir = build();
    putRaw(dir, "caf\xe9.txt", "changed\n");
    putRaw(dir, "u\xe9", "untracked\n");
    putRaw(dir, "d\xff/new\xe9", "untracked in a latin-1 directory\n");
    for (const version of [1, 2] as const) {
      const expected = gitBytes(dir, "status", `--porcelain=v${version}`, "--untracked-files=all");
      expect(expected.toString("latin1")).toContain('"caf\\351.txt"');
      expect((await ourStatus(dir, version)).toString("latin1")).toBe(expected.toString("latin1"));
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("diff output quotes them: patch, stat, numstat, name-only, name-status", async () => {
    const dir = build();
    putRaw(dir, "caf\xe9.txt", "latin-1\nchanged\n");
    putRaw(dir, "d\xff/n\xe9", "rewritten\n");
    const git = await openOurs(dir);
    for (const format of ["patch", "stat", "numstat", "name-only", "name-status"] as const) {
      const args = format === "patch" ? [] : [`--${format}`];
      const expected = gitBytes(dir, "diff", ...args);
      expect(Buffer.from(await git.diff().callBytes(format)).toString("latin1")).toBe(
        expected.toString("latin1"),
      );
    }
    expect(gitText(dir, "diff", "--name-only")).toBe('"caf\\351.txt"\n"d\\377/n\\351"\n');
    // core.quotePath=false prints the bytes themselves
    gitBytes(dir, "config", "core.quotePath", "false");
    const unquoted = await openOurs(dir);
    for (const format of ["patch", "name-only"] as const) {
      const args = format === "patch" ? [] : [`--${format}`];
      const expected = gitBytes(dir, "diff", ...args);
      expect(Buffer.from(await unquoted.diff().callBytes(format)).toString("latin1")).toBe(
        expected.toString("latin1"),
      );
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("add and commit: the index and the tree as native git makes them", async () => {
    const native = build();
    const twin = build();
    for (const dir of [native, twin]) {
      putRaw(dir, "caf\xe9.txt", "changed\n");
      putRaw(dir, "n\xe9w/f\xfc.txt", "new\n");
    }
    gitBytes(native, "add", "-A");
    const git = await openOurs(twin);
    await git.add().addFilepattern(".").call();
    // entries and their flags (the stat data differs between twins: other inodes, times)
    const listing = (dir: string) =>
      gitText(dir, "ls-files", "-s", "--debug").replace(/^ {2}(ctime|mtime|dev|uid):.*\n/gm, "");
    expect(listing(twin)).toBe(listing(native));
    expect(gitText(twin, "ls-files")).toContain('"n\\351w/f\\374.txt"');
    expect(gitText(twin, "write-tree")).toBe(gitText(native, "write-tree"));
    // native write-tree above rewrote the index: a fresh instance commits it
    const commit = await (await openOurs(twin))
      .commit()
      .setMessage("latin-1 names")
      .setAuthorIdent(INTEROP_IDENT)
      .setCommitterIdent(INTEROP_IDENT)
      .call();
    gitBytes(native, "commit", "-q", "-m", "latin-1 names");
    expect(gitText(twin, "rev-parse", `${commit.id}^{tree}`)).toBe(
      gitText(native, "rev-parse", "HEAD^{tree}"),
    );
    expect(gitText(twin, "fsck", "--strict")).toBe("");
    expect(gitText(twin, "status", "--porcelain")).toBe("");
    for (const dir of [native, twin]) rmSync(dir, { recursive: true, force: true });
  });

  it("checkout writes the names as their bytes", async () => {
    const dir = build();
    gitBytes(dir, "checkout", "-q", "-b", "side");
    putRaw(dir, "s\xe9de", "on side\n");
    rmSync(Buffer.concat([raw(`${dir}/`), raw("caf\xe9.txt")]));
    gitBytes(dir, "add", "-A");
    gitBytes(dir, "commit", "-q", "-m", "side");
    gitBytes(dir, "checkout", "-q", "main");
    const git = await openOurs(dir);
    await git.checkout().setName("side").call();
    const names = readdirSync(Buffer.from(dir), { encoding: "buffer" })
      .map((n) => n.toString("latin1"))
      .filter((n) => n !== ".git")
      .sort();
    expect(names).toEqual(
      [Buffer.from("café.txt").toString("latin1"), "d\xff", "plain.txt", "s\xe9de"].sort(),
    );
    expect(readFileSync(Buffer.concat([raw(`${dir}/`), raw("s\xe9de")]), "utf8")).toBe("on side\n");
    expect(gitText(dir, "status", "--porcelain")).toBe("");
    // and back
    await git.checkout().setName("main").call();
    expect(readFileSync(Buffer.concat([raw(`${dir}/`), raw("caf\xe9.txt")]), "utf8")).toBe(
      "latin-1\n",
    );
    expect(gitText(dir, "status", "--porcelain")).toBe("");
    rmSync(dir, { recursive: true, force: true });
  });
});
