/**
 * `git fsck` and `git verify-pack` against native git: repositories native git builds (clean
 * ones, with dangling and unreachable objects, missing and corrupt objects, malformed trees,
 * commits and tags crafted with `hash-object --literally`, corrupted packs), checked by both,
 * and the output compared.
 *
 * stdout (`missing`, `dangling`, `unreachable`, `broken link`, `root`, `tagged`) is compared
 * line for line: git prints those objects in the order of its object hash table, which the
 * command lays out the same way (except for objects of one fan-out directory that collide in
 * that table: see `normalizeOrder`). stderr is compared as a sorted list of lines: git reads loose
 * objects in directory order and, before 2.45, reflogs in directory order, so the order of
 * those messages depends on the filesystem.
 *
 * What differs between git versions is normalised (see `normalize`):
 *  - 2.45+ no longer prints `notice: HEAD points to an unborn branch (<branch>)`;
 *  - an object that cannot be parsed is `<id>: object could not be parsed: <path>` (2.43) or
 *    `<id>: object corrupt or missing` (2.5x);
 *  - a bad pack sets exit bit 4 (2.43) or bit 1 (2.5x);
 *  - 2.47+ runs `git refs verify` first: native git runs with `--no-references` there.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import type { GitObjects } from "@statewalker/vcs-core";
import { createGitFilesBackend } from "@statewalker/vcs-store-files";
import { MemoryStagingStore } from "@statewalker/vcs-store-mem";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { MemoryCheckout, MemoryWorkingCopy } from "@statewalker/vcs-working-tree";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type FsckCommand, Git } from "../src/index.js";
import { gitOk, openOurs, put } from "./merge-native-helpers.js";
import { createMockWorktree } from "./mock-worktree-store.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

describeGit("fsck against native git", () => {
  let root: string;
  let n = 0;
  let noReferences: string[] = [];
  let compatibility: "2.43" | "2.56" = "2.43";
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "fsck-native-"));
    const probe = join(root, "probe");
    gitOk(root, root, "init", "-q", probe);
    const r = native(probe, ["fsck", "--no-references"]);
    noReferences = r.status === 129 ? [] : ["--no-references"];
    const version = /(\d+)\.(\d+)/.exec(native(probe, ["--version"]).stdout);
    if (version && (Number(version[1]) > 2 || Number(version[2]) >= 45)) compatibility = "2.56";
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  function native(cwd: string, args: string[], input?: Uint8Array) {
    const r = spawnSync("git", args, { cwd, env: nativeGitEnv(root), input });
    return { status: r.status ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
  }
  const g = (dir: string, ...args: string[]) => gitOk(root, dir, ...args).trim();

  function newRepo(): string {
    const dir = join(root, `r${n++}`);
    g(root, "init", "-q", "-b", "main", dir);
    return dir;
  }

  function commitFiles(dir: string, files: Record<string, string>, message: string): string {
    for (const [path, content] of Object.entries(files)) put(dir, path, content);
    g(dir, "add", "-A");
    g(dir, "commit", "-q", "-m", message);
    return g(dir, "rev-parse", "HEAD");
  }

  /** Writes an object with `hash-object --literally`. */
  function literal(dir: string, type: string, content: Uint8Array | string): string {
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    const r = native(dir, ["hash-object", "-t", type, "--literally", "-w", "--stdin"], bytes);
    expect(r.status).toBe(0);
    return r.stdout.trim();
  }

  /** Raw tree bytes from `[mode, name, id]` entries, as written (no sorting, no checks). */
  function treeBytes(entries: [string, string, string][]): Uint8Array {
    const parts: number[] = [];
    for (const [mode, name, id] of entries) {
      parts.push(...new TextEncoder().encode(`${mode} ${name}\0`));
      for (let i = 0; i < 40; i += 2) parts.push(parseInt(id.slice(i, i + 2), 16));
    }
    return new Uint8Array(parts);
  }

  const looseFile = (dir: string, id: string) =>
    join(dir, ".git", "objects", id.slice(0, 2), id.slice(2));

  function flipByte(path: string, at: number, mask = 0x55): void {
    chmodSync(path, 0o644);
    const data = readFileSync(path);
    const i = at < 0 ? data.length + at : at;
    data[i] = (data[i] as number) ^ mask;
    writeFileSync(path, data);
  }

  function normalize(text: string): string[] {
    return text
      .split("\n")
      .filter((l) => l !== "" && !/^notice: .* points to an unborn branch/.test(l))
      .map((l) =>
        l.replace(
          /^error: ([0-9a-f]{40}): object (?:could not be parsed: \S+|corrupt or missing)$/,
          "error: $1: object could not be parsed",
        ),
      );
  }
  /**
   * Lines of objects in the same fan-out directory that come out next to each other are
   * sorted: they collided in git's object hash, and which came first depends on the order
   * git's readdir loop met them in, the filesystem's order (Node lists directories sorted).
   */
  function normalizeOrder(lines: string[]): string[] {
    const out: string[] = [];
    let run: string[] = [];
    let key: string | undefined;
    const flush = () => {
      out.push(...run.sort());
      run = [];
    };
    for (const line of lines) {
      const k = /[0-9a-f]{40}/.exec(line)?.[0].slice(0, 2);
      if (k === undefined || k !== key) flush();
      key = k;
      run.push(line);
    }
    flush();
    return out;
  }
  const normalizeExit = (code: number) => (code & 4 ? (code & ~4) | 1 : code);

  /** Runs native `git fsck <args>` and ours with the same options; expects the same output. */
  async function compare(
    dir: string,
    args: string[],
    configure: (c: FsckCommand) => FsckCommand = (c) => c,
  ): Promise<{ stdout: string; stderr: string; exit: number }> {
    const theirs = native(dir, ["fsck", ...noReferences, ...args]);
    const git = await openOurs(dir);
    const files = createNodeFilesApi({ rootDir: dir });
    const ours = await configure(
      git.fsck().setRepositoryFiles({ files }).setCompatibility(compatibility),
    ).call();
    if (theirs.status === 128) {
      // git 2.45+ dies on a corrupt packed object in --connectivity-only runs (2.43 reports
      // `Could not read <id>` and goes on, as this command does)
      expect(theirs.stderr).toContain("fatal: packed object");
      return { stdout: ours.output, stderr: ours.errorOutput, exit: ours.exitCode };
    }
    expect(normalizeOrder(normalize(ours.output))).toEqual(
      normalizeOrder(normalize(theirs.stdout)),
    );
    expect(normalize(ours.errorOutput).sort()).toEqual(normalize(theirs.stderr).sort());
    expect(normalizeExit(ours.exitCode)).toBe(normalizeExit(theirs.status));
    return { stdout: ours.output, stderr: ours.errorOutput, exit: ours.exitCode };
  }

  it("a clean repository: loose and packed objects, tags, a deleted branch kept by reflogs", async () => {
    const dir = newRepo();
    commitFiles(dir, { a: "a\n", "d/b": "b\n" }, "one");
    commitFiles(dir, { a: "a2\n", "d/c": "c\n" }, "two");
    g(dir, "tag", "-a", "v1", "-m", "tag one");
    g(dir, "repack", "-adq");
    g(dir, "checkout", "-q", "-b", "side", "HEAD~1");
    commitFiles(dir, { s: "s\n" }, "side");
    g(dir, "checkout", "-q", "main");
    g(dir, "branch", "-q", "-D", "side");
    commitFiles(dir, { e: "e\n" }, "three");
    g(dir, "tag", "light");
    const r = await compare(dir, []);
    expect(r).toEqual({ stdout: "", stderr: "", exit: 0 });
    await compare(dir, ["--unreachable"], (c) => c.setUnreachable(true));
    await compare(dir, ["--root", "--tags"], (c) => c.setRoot(true).setTags(true));
    await compare(dir, ["--connectivity-only"], (c) => c.setConnectivityOnly(true));
    await compare(dir, ["--strict"], (c) => c.setStrict(true));
  });

  it("an empty repository: no default references", async () => {
    const dir = newRepo();
    const r = await compare(dir, []);
    expect(r.stderr).toContain("notice: No default references");
  });

  it("dangling and unreachable objects", async () => {
    const dir = newRepo();
    for (let i = 1; i <= 4; i++) commitFiles(dir, { [`f${i}`]: `${i}\n` }, `c${i}`);
    g(dir, "checkout", "-q", "-b", "side", "HEAD~2");
    commitFiles(dir, { s: "s\n", "x/y": "y\n" }, "side");
    commitFiles(dir, { s: "s2\n" }, "side 2");
    g(dir, "checkout", "-q", "main");
    g(dir, "branch", "-q", "-D", "side");
    for (const c of "abcdefgh") literal(dir, "blob", `${c}\n`);
    g(dir, "write-tree");
    const tree = literal(dir, "tree", treeBytes([["100644", "z", literal(dir, "blob", "z\n")]]));
    literal(
      dir,
      "commit",
      `tree ${tree}\nauthor A <a@x> 1 +0000\ncommitter C <c@x> 1 +0000\n\nm\n`,
    );

    // the side commits are reachable from the reflogs
    await compare(dir, []);
    await compare(dir, ["--name-objects"], (c) => c.setNameObjects(true));
    await compare(dir, ["--no-reflogs"], (c) => c.setReflogs(false));
    await compare(dir, ["--no-reflogs", "--unreachable"], (c) =>
      c.setReflogs(false).setUnreachable(true),
    );
    await compare(dir, ["--no-reflogs", "--no-dangling"], (c) =>
      c.setReflogs(false).setDangling(false),
    );
    await compare(dir, ["--connectivity-only", "--no-reflogs"], (c) =>
      c.setConnectivityOnly(true).setReflogs(false),
    );
    g(dir, "reflog", "expire", "--expire=now", "--all");
    const r = await compare(dir, []);
    expect(r.stdout).toMatch(/^dangling commit /m);
    await compare(dir, ["--unreachable"], (c) => c.setUnreachable(true));

    // --lost-found: both write the same files
    const twin = `${dir}-twin`;
    cpSync(dir, twin, { recursive: true });
    native(dir, ["fsck", ...noReferences, "--lost-found"]);
    const git = await openOurs(twin);
    await git
      .fsck()
      .setRepositoryFiles({ files: createNodeFilesApi({ rootDir: twin }) })
      .setLostFound(true)
      .call();
    for (const kind of ["commit", "other"]) {
      const theirs = join(dir, ".git", "lost-found", kind);
      const ours = join(twin, ".git", "lost-found", kind);
      const list = (d: string) => (existsSync(d) ? readdirSync(d).sort() : []);
      expect(list(ours)).toEqual(list(theirs));
      for (const f of list(theirs)) {
        expect(readFileSync(join(ours, f)).equals(readFileSync(join(theirs, f)))).toBe(true);
      }
    }
    rmSync(join(dir, ".git", "lost-found"), { recursive: true, force: true });

    g(dir, "repack", "-adq");
    await compare(dir, ["--unreachable"], (c) => c.setUnreachable(true));
  });

  it("missing blobs and trees", async () => {
    const dir = newRepo();
    commitFiles(dir, { a: "a\n", "d/b": "b\n", "d/e/f": "f\n" }, "one");
    commitFiles(dir, { a: "a2\n" }, "two");
    const blob = g(dir, "rev-parse", "HEAD:d/b");
    rmSync(looseFile(dir, blob));
    let r = await compare(dir, []);
    expect(r.stdout).toContain(`missing blob ${blob}`);
    // without reflogs: git before 2.45 reads them in directory order, which decides the names
    await compare(dir, ["--name-objects", "--no-reflogs"], (c) =>
      c.setNameObjects(true).setReflogs(false),
    );
    await compare(dir, ["--connectivity-only"], (c) => c.setConnectivityOnly(true));
    const tree = g(dir, "rev-parse", "HEAD:d/e");
    rmSync(looseFile(dir, tree));
    r = await compare(dir, []);
    expect(r.stdout).toContain("broken link from");
    await compare(dir, ["--name-objects", "--no-reflogs"], (c) =>
      c.setNameObjects(true).setReflogs(false),
    );
    // gone from the index too: only the tree walk reaches it
    g(dir, "rm", "-q", "--cached", "d/b");
    await compare(dir, ["--name-objects", "--no-reflogs"], (c) =>
      c.setNameObjects(true).setReflogs(false),
    );
  });

  it("corrupt loose objects: bad zlib, wrong hash, truncated, stray files", async () => {
    const dir = newRepo();
    commitFiles(
      dir,
      { a: "a\n", b: "b\n", c: "some longer content for a blob\n".repeat(20) },
      "one",
    );
    const a = g(dir, "rev-parse", "HEAD:a");
    flipByte(looseFile(dir, a), 5, 0xff);
    let r = await compare(dir, []);
    expect(r.stderr).toContain("inflate: data stream error");
    const c = g(dir, "rev-parse", "HEAD:c");
    const cFile = looseFile(dir, c);
    chmodSync(cFile, 0o644);
    writeFileSync(cFile, readFileSync(cFile).subarray(0, 30));
    await compare(dir, []);
    const z = literal(dir, "blob", "zzz\n");
    const b = g(dir, "rev-parse", "HEAD:b");
    chmodSync(looseFile(dir, z), 0o644);
    writeFileSync(looseFile(dir, z), readFileSync(looseFile(dir, b)));
    r = await compare(dir, []);
    expect(r.stderr).toContain("hash-path mismatch");
    writeFileSync(join(dir, ".git", "objects", a.slice(0, 2), "junk"), "x");
    writeFileSync(join(dir, ".git", "objects", a.slice(0, 2), "tmp_obj_123"), "x");
    r = await compare(dir, []);
    expect(r.stderr).toContain("bad sha1 file:");
    writeFileSync(looseFile(dir, z), "garbage");
    await compare(dir, []);
  });

  it("malformed trees: duplicates, modes, order, .git and '..', null ids", async () => {
    const dir = newRepo();
    commitFiles(dir, { a: "a\n" }, "one");
    const A = g(dir, "rev-parse", "HEAD:a");
    const T = g(dir, "rev-parse", "HEAD^{tree}");
    const trees: [string, string, string][][] = [
      [
        ["100644", "a", A],
        ["100644", "a", A],
      ],
      [
        ["100644", "b", A],
        ["100644", "a", A],
      ],
      [["100644", ".git", A]],
      [["100644", ".GIT", A]],
      [
        ["100664", "a", A],
        ["100755", "b", A],
      ],
      [["0100644", "a", A]],
      [["100600", "a", A]],
      [["100644", "a", "0".repeat(40)]],
      [["100644", "..", A]],
      [["100644", ".", A]],
      [
        ["100644", "a", A],
        ["40000", "a", T],
      ],
      [
        ["100644", "foo", A],
        ["100644", "foo.bar", A],
        ["40000", "foo", T],
      ],
      [["120000", ".gitmodules", A]],
      [["120000", ".gitignore", A]],
    ];
    for (const entries of trees) {
      const tree = literal(dir, "tree", treeBytes(entries));
      literal(
        dir,
        "commit",
        `tree ${tree}\nauthor A <a@x> 1 +0000\ncommitter C <c@x> 1 +0000\n\nx\n`,
      );
    }
    // a tree that cannot be parsed
    literal(dir, "tree", new TextEncoder().encode("100644 a\0short"));
    // .gitmodules and .gitattributes blobs git refuses
    const modules = literal(
      dir,
      "blob",
      '[submodule "../evil"]\n\tpath = -x\n\turl = --upload-pack=touch\n\tupdate = !rm\n',
    );
    const attributes = literal(dir, "blob", `${"x".repeat(3000)} text\n`);
    const withModules = literal(
      dir,
      "tree",
      treeBytes([
        ["100644", ".gitattributes", attributes],
        ["100644", ".gitmodules", modules],
      ]),
    );
    literal(
      dir,
      "commit",
      `tree ${withModules}\nauthor A <a@x> 1 +0000\ncommitter C <c@x> 1 +0000\n\nx\n`,
    );
    await compare(dir, []);
    await compare(dir, ["--strict"], (c) => c.setStrict(true));
    g(dir, "config", "fsck.duplicateEntries", "ignore");
    g(dir, "config", "fsck.zeroPaddedFilemode", "error");
    g(dir, "config", "fsck.badFilemode", "ignore");
    await compare(dir, []);
    // a bad tree reachable from a branch
    const bad = literal(dir, "tree", treeBytes(trees[1] as [string, string, string][]));
    const commit = literal(
      dir,
      "commit",
      `tree ${bad}\nparent ${g(dir, "rev-parse", "HEAD")}\nauthor A <a@x> 1 +0000\ncommitter C <c@x> 1 +0000\n\nx\n`,
    );
    g(dir, "update-ref", "refs/heads/bad", commit);
    await compare(dir, ["--name-objects"], (c) => c.setNameObjects(true));
  });

  it("malformed commits and tags", async () => {
    const dir = newRepo();
    const C = commitFiles(dir, { a: "a\n" }, "one");
    const T = g(dir, "rev-parse", "HEAD^{tree}");
    const ok = "author A <a@x> 1700000000 +0000\ncommitter C <c@x> 1700000000 +0000\n\nmsg\n";
    const commits = [
      `tree ${T}\ncommitter C <c@x> 1700000000 +0000\n\nmsg\n`,
      `tree ${T}\nauthor A <a@x> 1700000000 +00000\ncommitter C <c@x> 1700000000 +0000\n\nmsg\n`,
      `tree ${T}\nauthor A <a@x 1700000000 +0000\ncommitter C <c@x> 1700000000 +0000\n\nmsg\n`,
      `tree ${T}\nauthor A <a@x> 0170 +0000\ncommitter C <c@x> 1700000000 +0000\n\nmsg\n`,
      `tree ${T}\nauthor A <a@x> 99999999999999999999 +0000\ncommitter C <c@x> 1 +0000\n\nm\n`,
      `tree ${T}\nauthor <a@x> 1 +0000\ncommitter C <c@x> 1 +0000\n\nm\n`,
      `tree ${T}\nauthor A a@x> 1 +0000\ncommitter C <c@x> 1 +0000\n\nm\n`,
      `tree ${T}\nauthor A<a@x> 1 +0000\ncommitter C <c@x> 1 +0000\n\nm\n`,
      `tree ${T}\nauthor A <a@x>1 +0000\ncommitter C <c@x> 1 +0000\n\nm\n`,
      `tree ${T}\nauthor A <a@x> 1 +0000\n\nm\n`,
      `author A <a@x> 1700000000 +0000\ncommitter C <c@x> 1700000000 +0000\n\nmsg\n`,
      `tree 1234\n${ok}`,
      `tree ${T}\nparent zz\n${ok}`,
      `tree ${T}\nauthor A <a@x> 1700000000 +0000\n${ok}`,
      `tree ${T}\n${ok.replace("\n\nmsg", "\n\nm\0sg")}`,
      `tree ${T}\nauthor A <a@x> 1700000000 +0000\ncommitter C <c@x> 1700000000 +0000`,
      `tree ${T}\nauthor A <a\0@x> 1 +0000\ncommitter C <c@x> 1 +0000\n\nm\n`,
    ];
    for (const text of commits) literal(dir, "commit", text);
    const tagger = "tagger T <t@x> 1700000000 +0000\n";
    const tags = [
      `object ${C}\ntype commit\ntag v1\n\nmsg\n`,
      `object ${C}\ntype bogus\ntag v1\n${tagger}\nmsg\n`,
      `object ${C}\ntag v1\n${tagger}\nmsg\n`,
      `object ${C}\ntype commit\ntag v..1\n${tagger}\nmsg\n`,
      `object ${T}\ntype commit\ntag v2\n${tagger}\nmsg\n`,
      `object ${C}\ntype commit\ntag v1\n${tagger}extra x\n\nmsg\n`,
      `object ${C}\ntype commit\ntag v3\ntagger T <t@x> 1700000000 +0000 x\n\nmsg\n`,
      `object zz\ntype commit\ntag v4\n${tagger}\nmsg\n`,
    ];
    for (const text of tags) literal(dir, "tag", text);
    await compare(dir, []);
    await compare(dir, ["--strict"], (c) => c.setStrict(true));
    g(dir, "config", "fsck.missingTaggerEntry", "error");
    g(dir, "config", "fsck.extraHeaderEntry", "warn");
    g(dir, "config", "fsck.badTimezone", "warn");
    await compare(dir, []);
    // reachable through refs: the bad tag from a tag ref, a branch to a blob
    const tag = literal(dir, "tag", `object ${C}\ntype commit\ntag v5\n\nmsg\n`);
    g(dir, "update-ref", "refs/tags/v5", tag);
    writeFileSync(join(dir, ".git", "refs", "heads", "blob"), `${g(dir, "rev-parse", "HEAD:a")}\n`);
    writeFileSync(join(dir, ".git", "refs", "heads", "nothing"), `${"1".repeat(40)}\n`);
    await compare(dir, ["--tags", "--name-objects"], (c) => c.setTags(true).setNameObjects(true));
  });

  it("corrupted packs: a flipped byte in the data, a bad idx checksum", async () => {
    const dir = newRepo();
    for (let i = 1; i <= 3; i++) {
      put(dir, "f", `${Array.from({ length: i * 300 }, (_, k) => k).join("\n")}\n`);
      g(dir, "add", "f");
      g(dir, "commit", "-q", "-m", `c${i}`);
    }
    g(dir, "repack", "-adq");
    const packDir = join(dir, ".git", "objects", "pack");
    const pack = join(packDir, readdirSync(packDir).find((f) => f.endsWith(".pack")) as string);
    const idx = `${pack.slice(0, -5)}.idx`;
    const packBytes = readFileSync(pack);
    const idxBytes = readFileSync(idx);
    await compare(dir, []);

    flipByte(pack, 200);
    const r = await compare(dir, []);
    expect(r.stderr).toContain("pack checksum mismatch");
    await compare(dir, ["--connectivity-only"], (c) => c.setConnectivityOnly(true));

    writeFileSync(pack, packBytes);
    flipByte(idx, -1);
    await compare(dir, []);
    writeFileSync(idx, idxBytes);

    // a pack holding a bad commit: the object error marks the pack bad too (git 2.43)
    const T = g(dir, "rev-parse", "HEAD^{tree}");
    const bad = literal(
      dir,
      "commit",
      `tree ${T}\nauthor A <a@x> 1 +00000\ncommitter C <c@x> 1 +0000\n\nm\n`,
    );
    expect(
      native(
        dir,
        ["pack-objects", "-q", ".git/objects/pack/pack"],
        new TextEncoder().encode(`${bad}\n`),
      ).status,
    ).toBe(0);
    g(dir, "prune-packed");
    await compare(dir, []);
  });

  it("linked worktrees, stashes and the index as roots", async () => {
    const dir = newRepo();
    commitFiles(dir, { a: "a\n" }, "one");
    commitFiles(dir, { a: "a2\n" }, "two");
    const wt = join(root, `wt${n++}`);
    g(dir, "worktree", "add", "-q", "-b", "wtb", wt);
    commitFiles(wt, { w: "w\n" }, "in worktree");
    put(dir, "a", "dirty\n");
    g(dir, "stash", "-q");
    put(wt, "staged", "staged only\n");
    g(wt, "add", "staged");
    put(dir, "new", "new\n");
    g(dir, "add", "new");
    await compare(dir, []);
    await compare(dir, ["--name-objects"], (c) => c.setNameObjects(true));
    // the worktree's commit is reachable only from its HEAD once its branch is gone
    g(wt, "checkout", "-q", "--detach");
    g(dir, "branch", "-q", "-D", "wtb");
    await compare(dir, ["--no-reflogs"], (c) => c.setReflogs(false));
    await compare(dir, ["--no-reflogs", "--name-objects"], (c) =>
      c.setReflogs(false).setNameObjects(true),
    );
  });

  it("verify-pack -v and -s list a pack as git does", async () => {
    const dir = newRepo();
    for (let i = 1; i <= 5; i++) {
      put(dir, "f", `${Array.from({ length: 200 + i * 10 }, (_, k) => `line ${k}`).join("\n")}\n`);
      put(dir, `g${i}`, `${i}\n`);
      g(dir, "add", "-A");
      g(dir, "commit", "-q", "-m", `c${i}`);
    }
    g(dir, "repack", "-adq", "--depth=3", "--window=10");
    const packDir = join(dir, ".git", "objects", "pack");
    const idxName = readdirSync(packDir).find((f) => f.endsWith(".idx")) as string;
    const rel = `.git/objects/pack/${idxName}`;
    const git = await openOurs(dir);
    const files = createNodeFilesApi({ rootDir: dir });
    for (const flags of [["-v"], ["-s"], []] as string[][]) {
      const theirs = native(dir, ["verify-pack", ...flags, rel]);
      const ours = await git
        .verifyPack()
        .setRepositoryFiles({ files })
        .addPack(rel)
        .setVerbose(flags.includes("-v"))
        .setStatOnly(flags.includes("-s"))
        .call();
      expect(ours.output).toBe(theirs.stdout);
      expect(ours.exitCode).toBe(theirs.status);
    }
    const ours = await git
      .verifyPack()
      .setRepositoryFiles({ files })
      .addPack(rel)
      .setVerbose(true)
      .call();
    expect(ours.output).toMatch(/^chain length = 1: \d+ objects?$/m);

    const pack = join(packDir, `${idxName.slice(0, -4)}.pack`);
    flipByte(pack, 300);
    const theirs = native(dir, ["verify-pack", "-v", rel]);
    const bad = await git
      .verifyPack()
      .setRepositoryFiles({ files })
      .addPack(rel)
      .setVerbose(true)
      .call();
    expect(bad.exitCode).toBe(1);
    expect(theirs.status).not.toBe(0);
    expect(bad.output.split("\n").at(-2)).toBe(theirs.stdout.split("\n").at(-2));
  });

  /** Writes a loose object file as given: `raw` deflated (or `stored` as is), named `id`. */
  function writeLoose(dir: string, raw: Uint8Array, id?: string, stored?: Uint8Array): string {
    const name = id ?? createHash("sha1").update(raw).digest("hex");
    mkdirSync(join(dir, ".git", "objects", name.slice(0, 2)), { recursive: true });
    writeFileSync(looseFile(dir, name), stored ?? deflateSync(raw));
    return name;
  }
  const bytesOf = (...parts: (string | Uint8Array)[]) =>
    Buffer.concat(parts.map((p) => (typeof p === "string" ? Buffer.from(p) : p)));

  /** Deterministic bytes zlib cannot compress: stored blocks. */
  function noise(n: number, seed: number): Uint8Array {
    const out = new Uint8Array(n);
    let x = seed >>> 0 || 1;
    for (let i = 0; i < n; i++) {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      out[i] = x & 255;
    }
    return out;
  }

  it("loose binary blobs (stored zlib blocks) of many sizes in a clean repository", async () => {
    const dir = newRepo();
    const sizes = [1, 20, 31, 32, 33, 100, 4096, 65535, 65536, 70000, 300000];
    for (const [i, size] of sizes.entries()) {
      writeFileSync(join(dir, `bin${i}.dat`), noise(size, i + 1));
    }
    g(dir, "add", "-A");
    g(dir, "commit", "-q", "-m", "binaries");
    // and one not reachable, written by git as well
    const loose = literal(dir, "blob", noise(80000, 99));
    const r = await compare(dir, []);
    expect(r).toEqual({ stdout: `dangling blob ${loose}\n`, stderr: "", exit: 0 });
    // zlib stores them: the start of each file is a stored block longer than the header
    for (let i = 0; i < sizes.length; i++) {
      const id = g(dir, "rev-parse", `HEAD:bin${i}.dat`);
      const data = inflateSync(readFileSync(looseFile(dir, id)));
      expect(data.length).toBeGreaterThan(sizes[i] as number);
    }
  });

  it("blobs above core.bigFileThreshold are streamed: verdicts and messages as git's check_stream_oid", async () => {
    const dir = newRepo();
    commitFiles(dir, { a: "a\n" }, "one");
    g(dir, "config", "core.bigFileThreshold", "1k");
    const body = noise(2000, 5);
    const z = (raw: Uint8Array) => new Uint8Array(deflateSync(raw));
    const good = bytesOf("blob 2000\0", body);
    writeLoose(dir, good);
    // a stream shorter than declared: git does not compare the length when streaming. (The
    // sizes are above glibc's largest mmap threshold, 32 MiB: inflated whole, git's buffer is
    // then fresh zeroed pages; a smaller one holds whatever malloc reused.)
    writeLoose(dir, bytesOf("blob 40000000\0", body));
    // ... and does when it is named after the declared size
    const shortRaw = bytesOf("blob 40000001\0", body);
    writeLoose(
      dir,
      shortRaw,
      createHash("sha1")
        .update(bytesOf(shortRaw, new Uint8Array(40000001 - body.length)))
        .digest("hex"),
    );
    // bytes after the stream, a cut stream, a corrupt checksum, content hashing elsewhere
    const g2 = bytesOf("blob 2001\0", body, "x");
    writeLoose(dir, g2, undefined, bytesOf(z(g2), "xyz"));
    const t2 = bytesOf("blob 2002\0", body, "xy");
    writeLoose(dir, t2, undefined, z(t2).subarray(0, -30));
    const c2 = bytesOf("blob 2003\0", body, "xyz");
    const corrupt = z(c2);
    corrupt[corrupt.length - 2] = (corrupt[corrupt.length - 2] as number) ^ 1;
    writeLoose(dir, c2, undefined, corrupt);
    writeLoose(dir, good, "1".repeat(40));
    // a 23-byte file declaring 8 GB: streamed, it hashes to its name
    writeLoose(dir, bytesOf("blob 8000000000\0"));
    const r = await compare(dir, []);
    expect(r.stderr).toContain("(expected 1111111111111111111111111111111111111111)");
    expect(r.stderr).toContain("garbage at end of loose object");
    expect(r.stderr).not.toContain("unable to unpack contents");
    expect(r.exit).toBe(1);
    // the same objects whole (default threshold): git's zeroed buffer for the short ones
    g(dir, "config", "--unset", "core.bigFileThreshold");
    const whole = await compare(dir, []);
    expect(whole.stderr).toContain("hash-path mismatch");
    expect(whole.stderr).toContain("unable to unpack contents");
  });

  it("a declared size larger than the stream: git's verdict without allocating it", async () => {
    const dir = newRepo();
    commitFiles(dir, { a: "a\n" }, "one");
    // a blob below the threshold and a commit: inflated whole into git's zeroed buffer
    writeLoose(dir, bytesOf("blob 40000000\0hello"));
    writeLoose(dir, bytesOf("commit 50000000\0tree 1234\n"));
    // a truncated zip bomb: 16 MiB of zeros, half the stream, declaring 400 MB
    const bomb = deflateSync(new Uint8Array(16 << 20), { level: 9 });
    writeLoose(
      dir,
      bytesOf("blob 400000000\0"),
      "2".repeat(40),
      bytesOf(
        deflateSync(bytesOf("blob 400000000\0")).subarray(0, 2),
        bomb.subarray(2, bomb.length >> 1),
      ),
    );
    const start = performance.now();
    const r = await compare(dir, []);
    expect(performance.now() - start).toBeLessThan(20000);
    expect(r.stderr).toContain("hash-path mismatch");
    expect(r.exit).toBe(1);
  });

  it("a symbolic ref that resolves to nothing is an invalid sha1 pointer", async () => {
    const dir = newRepo();
    commitFiles(dir, { a: "a\n" }, "one");
    g(dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    g(dir, "symbolic-ref", "refs/heads/alias", "refs/heads/nothere");
    g(dir, "symbolic-ref", "refs/heads/chain", "refs/heads/alias");
    const r = await compare(dir, []);
    expect(r.stderr).toContain(
      "error: refs/remotes/origin/HEAD: invalid sha1 pointer 0000000000000000000000000000000000000000",
    );
    expect(r.exit).toBe(2);
    g(dir, "pack-refs", "--all");
    await compare(dir, []);
    // the 2.45+ snapshot and the 2.43 walk both report them
    const files = createNodeFilesApi({ rootDir: dir });
    for (const version of ["2.43", "2.56"] as const) {
      const ours = await (await openOurs(dir))
        .fsck()
        .setRepositoryFiles({ files })
        .setCompatibility(version)
        .call();
      expect(ours.errorOutput).toContain("error: refs/heads/chain: invalid sha1 pointer");
      expect(ours.exitCode & 2).toBe(2);
    }
  });

  it("tree modes are read in 16 bits, as git's unsigned short", async () => {
    const dir = newRepo();
    commitFiles(dir, { a: "a\n" }, "one");
    const blob = g(dir, "rev-parse", "HEAD:a");
    // 1100644 is 100644, 1040000 is 40000 (a tree), 3100755 is 100755
    const sub = g(dir, "rev-parse", "HEAD^{tree}");
    const tree = literal(
      dir,
      "tree",
      treeBytes([
        ["1100644", "a", blob],
        ["1040000", "d", sub],
        ["3100755", "x", blob],
      ]),
    );
    const c = literal(
      dir,
      "commit",
      `tree ${tree}\nauthor A <a@x> 1 +0000\ncommitter A <a@x> 1 +0000\n\nm\n`,
    );
    g(dir, "update-ref", "refs/heads/odd", c);
    const r = await compare(dir, []);
    expect(r.stderr).not.toContain("badFilemode");
    // ordering sees the truncated mode: "d" as a directory sorts after "d.txt"
    const unsorted = literal(
      dir,
      "tree",
      treeBytes([
        ["1040000", "d", sub],
        ["100644", "d.txt", blob],
      ]),
    );
    const c2 = literal(
      dir,
      "commit",
      `tree ${unsorted}\nauthor A <a@x> 1 +0000\ncommitter A <a@x> 1 +0000\n\nm\n`,
    );
    g(dir, "update-ref", "refs/heads/odd2", c2);
    const r2 = await compare(dir, []);
    expect(r2.stderr).toContain("treeNotSorted");
  });

  it("a .gitmodules blob starting with a UTF-8 BOM is not parsed (gitmodulesParse)", async () => {
    const dir = newRepo();
    const text = '[submodule "s"]\n\tpath = s\n\turl = https://example.com/s\n';
    const bom = literal(dir, "blob", bytesOf(Buffer.from([0xef, 0xbb, 0xbf]), text));
    const plain = literal(dir, "blob", text);
    const tree = literal(dir, "tree", treeBytes([["100644", ".gitmodules", bom]]));
    const tree2 = literal(dir, "tree", treeBytes([["100644", ".gitmodules", plain]]));
    const c = literal(
      dir,
      "commit",
      `tree ${tree}\nauthor A <a@x> 1 +0000\ncommitter A <a@x> 1 +0000\n\nm\n`,
    );
    const c2 = literal(
      dir,
      "commit",
      `tree ${tree2}\nparent ${c}\nauthor A <a@x> 1 +0000\ncommitter A <a@x> 1 +0000\n\nm\n`,
    );
    g(dir, "update-ref", "refs/heads/main", c2);
    const r = await compare(dir, []);
    expect(r.stderr).toContain(
      `warning in blob ${bom}: gitmodulesParse: could not parse gitmodules blob`,
    );
    expect(r.stderr).not.toContain(plain);
    expect(r.exit).toBe(0);
  });

  it("after a backslash only NTFS spellings of .gitmodules count, not HFS+ ones", async () => {
    const dir = newRepo();
    const bad = literal(dir, "blob", "[not a config\n");
    const bad2 = literal(dir, "blob", "[not a config either\n");
    // U+200C is ignorable to HFS+ only; GITMOD~1 is the NTFS short name
    const tree = literal(
      dir,
      "tree",
      treeBytes([
        ["100644", "a\\.git\u200cmodules", bad],
        ["100644", "b\\GITMOD~1", bad2],
      ]),
    );
    const c = literal(
      dir,
      "commit",
      `tree ${tree}\nauthor A <a@x> 1 +0000\ncommitter A <a@x> 1 +0000\n\nm\n`,
    );
    g(dir, "update-ref", "refs/heads/main", c);
    const r = await compare(dir, []);
    // only the blob under the NTFS name is parsed
    expect(r.stderr).toContain(`warning in blob ${bad2}: gitmodulesParse`);
    expect(r.stderr).not.toContain(bad);
  });

  it("HEAD is followed to the end of its symbolic ref chain (2.43)", async () => {
    const dir = newRepo();
    const C = commitFiles(dir, { a: "a\n" }, "one");
    g(dir, "update-ref", "refs/remotes/origin/x", C);
    g(dir, "symbolic-ref", "refs/heads/alias", "refs/remotes/origin/x");
    g(dir, "symbolic-ref", "HEAD", "refs/heads/alias");
    // HEAD's commit is reachable only through HEAD once main is gone
    g(dir, "update-ref", "-d", "refs/heads/main");
    const files = createNodeFilesApi({ rootDir: dir });
    const ours = async () =>
      (await openOurs(dir))
        .fsck()
        .setRepositoryFiles({ files })
        .setCompatibility("2.43")
        .setReflogs(false)
        .call();
    // the chain ends in a remote ref: strange
    await compare(dir, ["--no-reflogs"], (c) => c.setReflogs(false));
    let r = await ours();
    expect(r.errorOutput).toBe("error: HEAD points to something strange (refs/remotes/origin/x)\n");
    expect(r.exitCode).toBe(8);
    expect(r.output).toBe("");
    // ... and git still takes what HEAD resolves to as a root: a commit only a pseudo ref names
    const D = commitFiles(dir, { b: "b\n" }, "two");
    g(dir, "update-ref", "refs/remotes/origin/x", C);
    writeFileSync(join(dir, ".git", "OTHER_HEAD"), `${D}\n`);
    writeFileSync(join(dir, ".git", "refs", "heads", "alias"), "ref: OTHER_HEAD\n");
    await compare(dir, ["--no-reflogs"], (c) => c.setReflogs(false));
    r = await ours();
    expect(r.errorOutput).toBe("error: HEAD points to something strange (OTHER_HEAD)\n");
    expect(r.output).toBe("");
    // a chain ending in a branch is fine
    g(dir, "symbolic-ref", "refs/heads/alias", "refs/heads/main2");
    g(dir, "update-ref", "refs/heads/main2", C);
    r = await ours();
    expect(r.errorOutput).toBe("");
    expect(r.exitCode).toBe(0);
    await compare(dir, ["--no-reflogs"], (c) => c.setReflogs(false));
  });

  it("a tag's gpgsig header is an extra header in 2.43 only", async () => {
    const dir = newRepo();
    const C = commitFiles(dir, { a: "a\n" }, "one");
    const tag = literal(
      dir,
      "tag",
      `object ${C}\ntype commit\ntag v1\ntagger A <a@x> 1 +0000\ngpgsig -----BEGIN-----\n x\n -----END-----\n\nmsg\n`,
    );
    g(dir, "update-ref", "refs/tags/v1", tag);
    g(dir, "config", "fsck.extraHeaderEntry", "error");
    const r = await compare(dir, []);
    expect(r.exit).toBe(compatibility === "2.43" ? 1 : 0);
    const files = createNodeFilesApi({ rootDir: dir });
    for (const version of ["2.43", "2.56"] as const) {
      const ours = await (await openOurs(dir))
        .fsck()
        .setRepositoryFiles({ files })
        .setCompatibility(version)
        .call();
      expect(ours.errorOutput.includes("extraHeaderEntry")).toBe(version === "2.43");
    }
  });

  /** Our fsck in one compatibility mode, on the repository's files. */
  async function oursIn(
    dir: string,
    version: "2.43" | "2.56",
    configure: (c: FsckCommand) => FsckCommand = (c) => c,
  ) {
    const files = createNodeFilesApi({ rootDir: dir });
    return configure(
      (await openOurs(dir)).fsck().setRepositoryFiles({ files }).setCompatibility(version),
    ).call();
  }

  const sha1Hex = (text: string) => createHash("sha1").update(text).digest("hex");

  /** `refs/heads/<from>` -> ... -> `refs/heads/<to>` as symbolic ref files, `<to>` at `id`. */
  function refChain(dir: string, prefix: string, length: number, id: string): void {
    const heads = join(dir, ".git", "refs", "heads");
    writeFileSync(join(heads, `${prefix}${length}`), `${id}\n`);
    for (let i = length - 1; i >= 1; i--) {
      writeFileSync(join(heads, `${prefix}${i}`), `ref: refs/heads/${prefix}${i + 1}\n`);
    }
  }

  it("HEAD resolves in at most 5 reads, HEAD's own included (2.43: invalid HEAD past them)", async () => {
    const dir = newRepo();
    const C = commitFiles(dir, { a: "a\n" }, "one");
    // r1 -> r2 -> r3 -> r4 -> r5 (direct): each listed ref resolves in 5 reads or fewer
    refChain(dir, "r", 5, C);
    g(dir, "update-ref", "-d", "refs/heads/main");
    // HEAD -> r2 -> ... -> r5: 5 reads, fine
    writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/r2\n");
    expect(await compare(dir, [])).toEqual({ stdout: "", stderr: "", exit: 0 });
    for (const version of ["2.43", "2.56"] as const) {
      const r = await oursIn(dir, version);
      expect([r.errorOutput, r.exitCode]).toEqual(["", 0]);
    }
    // HEAD -> r1 -> ... -> r5: 6 reads, one too many
    writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/r1\n");
    await compare(dir, []);
    await compare(dir, ["--no-reflogs"], (c) => c.setReflogs(false));
    let r = await oursIn(dir, "2.43");
    // git 2.43's reflog iterator does not resolve HEAD either: its reflog is skipped
    expect(r.errorOutput).toBe("error: invalid HEAD\nerror: bad ref for .git/logs/HEAD\n");
    expect(r.exitCode).toBe(8);
    r = await oursIn(dir, "2.43", (c) => c.setReflogs(false));
    expect([r.errorOutput, r.exitCode]).toEqual(["error: invalid HEAD\n", 8]);
    // 2.45+ checks HEAD's link no more (git refs verify does): an unresolved HEAD is no root
    r = await oursIn(dir, "2.56");
    expect([r.errorOutput, r.exitCode]).toEqual(["", 0]);
  });

  it("a listed symbolic ref deeper than 5 reads is an invalid sha1 pointer, its reflog a bad ref (2.43)", async () => {
    const dir = newRepo();
    const C = commitFiles(dir, { a: "a\n" }, "one");
    // r1 -> ... -> r6 (direct): r1 takes 6 reads, r2 takes 5
    refChain(dir, "r", 6, C);
    mkdirSync(join(dir, ".git", "logs", "refs", "heads"), { recursive: true });
    for (const name of ["r1", "r2"]) {
      writeFileSync(
        join(dir, ".git", "logs", "refs", "heads", name),
        `${"0".repeat(40)} ${C} A <a@x> 1700000000 +0000\tx\n`,
      );
    }
    const pointer =
      "error: refs/heads/r1: invalid sha1 pointer 0000000000000000000000000000000000000000\n";
    const r = await compare(dir, []);
    expect(r.exit).toBe(2);
    await compare(dir, ["--no-reflogs"], (c) => c.setReflogs(false));
    let ours = await oursIn(dir, "2.43");
    expect(ours.errorOutput).toBe(`${pointer}error: bad ref for .git/logs/refs/heads/r1\n`);
    expect(ours.exitCode).toBe(2);
    ours = await oursIn(dir, "2.56");
    expect([ours.errorOutput, ours.exitCode]).toEqual([pointer, 2]);
    for (const version of ["2.43", "2.56"] as const) {
      ours = await oursIn(dir, version, (c) => c.setReflogs(false));
      expect([ours.errorOutput, ours.exitCode]).toEqual([pointer, 2]);
    }
    // HEAD -> r2 -> ... -> r6: 6 reads, no root in the 2.45+ snapshot and nothing printed
    writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/r2\n");
    ours = await oursIn(dir, "2.56");
    expect([ours.errorOutput, ours.exitCode]).toEqual([pointer, 2]);
  });

  it("a stream longer than its declared size: kept to the size when it all fit in the 32-byte header read", async () => {
    const dir = newRepo();
    commitFiles(dir, { a: "a\n" }, "one");
    // git's unpack_loose_rest copies at most the declared size from the header buffer, and
    // zlib, at the end of the stream already, says Z_STREAM_END: a fine (dangling) blob
    const fine = writeLoose(dir, bytesOf("blob 2\0abcdefgh"), sha1Hex("blob 2\0ab"));
    // 32 bytes inflated in all: still in the header buffer
    const edge = writeLoose(dir, bytesOf(`blob 3\0${"x".repeat(25)}`), sha1Hex("blob 3\0xxx"));
    // 33 and more: the rest of the stream does not fit the declared size, corrupt
    const over = writeLoose(dir, bytesOf(`blob 3\0${"y".repeat(26)}`), sha1Hex("blob 3\0yyy"));
    const far = writeLoose(dir, bytesOf(`blob 3\0${"q".repeat(40)}`), sha1Hex("blob 3\0qqq"));
    // a commit cut to its size is parsed as such
    const cut = writeLoose(dir, bytesOf("commit 5\0tree x\nmore"), sha1Hex("commit 5\0tree "));
    const r = await compare(dir, []);
    expect(r.stdout).toContain(`dangling blob ${fine}`);
    expect(r.stdout).toContain(`dangling blob ${edge}`);
    expect(r.stderr).toContain(`error: corrupt loose object '${over}'`);
    expect(r.stderr).toContain(`error: corrupt loose object '${far}'`);
    expect(r.stderr).toContain(`error: bogus commit object ${cut}`);
    expect(r.exit).toBe(1);
  });

  it("an invalid core.bigFileThreshold is fatal, with git's message", async () => {
    const dir = newRepo();
    commitFiles(dir, { a: "a\n" }, "one");
    for (const [value, why] of [
      ["abc", "invalid unit"],
      ["5k ", "invalid unit"],
      ["-1", "invalid unit"],
      ["0x", "invalid unit"],
      ["99999999999999999999", "out of range"],
    ] as const) {
      g(dir, "config", "core.bigFileThreshold", value);
      const theirs = native(dir, ["fsck", ...noReferences]);
      expect(theirs.status).toBe(128);
      const message = `bad numeric config value '${value}' for 'core.bigfilethreshold'`;
      expect(theirs.stderr).toContain(`fatal: ${message}`);
      for (const version of ["2.43", "2.56"] as const) {
        await expect(oursIn(dir, version)).rejects.toThrow(`${message}: ${why}`);
      }
    }
    // what git takes: blanks before, any case of the unit, hex and octal
    for (const value of [" 5k", "1K", "0x10m", "010", "+3g"]) {
      g(dir, "config", "core.bigFileThreshold", value);
      expect(await compare(dir, [])).toEqual({ stdout: "", stderr: "", exit: 0 });
    }
  });

  it("packs read in one pass: OFS and REF deltas, a blob over 1 MiB, corrupt bases, a tree bad in its pack", async () => {
    const dir = newRepo();
    for (let i = 1; i <= 8; i++) {
      // small changes: long delta chains
      const lines = Array.from({ length: 300 + i }, (_, k) =>
        k % 37 === i ? `changed ${i}` : `line ${k}`,
      );
      put(dir, "f", `${lines.join("\n")}\n`);
      put(dir, `d${i % 3}/g`, `${Array.from({ length: 50 + i }, (_, k) => `g ${k}`).join("\n")}\n`);
      if (i === 4) writeFileSync(join(dir, "big"), noise(1536 * 1024, 7));
      g(dir, "add", "-A");
      g(dir, "commit", "-q", "-m", `c${i}`);
    }
    const packDir = join(dir, ".git", "objects", "pack");
    const packFile = () => readdirSync(packDir).find((f) => f.endsWith(".pack")) as string;
    const git = await openOurs(dir);
    const files = createNodeFilesApi({ rootDir: dir });
    /** `verify-pack -v`: the same listing and status as git's. */
    const verifyPack = async (expectOutput: boolean) => {
      const rel = `.git/objects/pack/${packFile().slice(0, -5)}.idx`;
      const theirs = native(dir, ["verify-pack", "-v", rel]);
      const ours = await git
        .verifyPack()
        .setRepositoryFiles({ files })
        .addPack(rel)
        .setVerbose(true)
        .call();
      expect(ours.exitCode === 0).toBe(theirs.status === 0);
      if (expectOutput) expect(ours.output).toBe(theirs.stdout);
      else expect(ours.output.split("\n").at(-2)).toBe(theirs.stdout.split("\n").at(-2));
      return theirs.stdout;
    };
    const both = async () => {
      await compare(dir, []);
      await compare(dir, ["--connectivity-only"], (c) => c.setConnectivityOnly(true));
    };

    for (const offsets of ["true", "false"]) {
      g(dir, "-c", `repack.useDeltaBaseOffset=${offsets}`, "repack", "-adfq", "--depth=4");
      await both();
      const listing = await verifyPack(true);
      // whole objects that are a delta's base, and deltas based on deltas
      const rows = listing
        .split("\n")
        .map((l) => l.split(/ +/))
        .filter((r) => /^[0-9a-f]{40}$/.test(r[0] as string));
      const bases = new Set(rows.filter((r) => r.length === 7).map((r) => r[6] as string));
      const base = rows.find((r) => r.length === 5 && bases.has(r[0] as string)) as string[];
      const deep = rows.find((r) => r.length === 7 && Number(r[5]) >= 2) as string[];
      expect(base && deep).toBeTruthy();
      const pack = join(packDir, packFile());
      const original = readFileSync(pack);
      for (const row of [base, deep]) {
        // a byte in the middle of the entry's compressed data: the same entries fail as in
        // git (git also reports the failed delta bases on the way, which this does not)
        flipByte(pack, Number(row[4]) + Math.floor(Number(row[3]) / 2));
        expect(await unpackErrors(dir)).toEqual(unpackErrors(dir, true));
        await verifyPack(false);
        writeFileSync(pack, original);
      }
    }

    // a tree whose packed copy is corrupt, with a sound loose copy
    const tree = g(dir, "rev-parse", "HEAD~2^{tree}");
    const content = spawnSync("git", ["cat-file", "tree", tree], { cwd: dir }).stdout;
    writeLoose(dir, bytesOf(`tree ${content.length}\0`, content), tree);
    const row = (await verifyPack(true)).split("\n").find((l) => l.startsWith(tree)) as string;
    const [, , , size, at] = row.split(/ +/);
    flipByte(join(packDir, packFile()), Number(at) + Math.floor(Number(size) / 2));
    expect(await unpackErrors(dir)).toEqual(unpackErrors(dir, true));
  });

  /** The pack errors of a full fsck (checksums, CRCs, entries that cannot be unpacked). */
  function unpackErrors(dir: string, native: true): string[];
  function unpackErrors(dir: string): Promise<string[]>;
  function unpackErrors(dir: string, nativeGit?: true): string[] | Promise<string[]> {
    const pick = (text: string) =>
      text
        .split("\n")
        .filter((l) => /^error: (cannot unpack|packed |index CRC|\S+ pack checksum)/.test(l))
        .sort();
    if (nativeGit) return pick(native(dir, ["fsck", ...noReferences]).stderr);
    return openOurs(dir).then(async (git) => {
      const files = createNodeFilesApi({ rootDir: dir });
      const r = await git
        .fsck()
        .setRepositoryFiles({ files })
        .setCompatibility(compatibility)
        .call();
      return pick(r.errorOutput);
    });
  }

  it("--connectivity-only reads no blob, not even to name a dangling one's type", async () => {
    const dir = newRepo();
    for (let i = 1; i <= 4; i++) {
      const lines = Array.from({ length: 200 }, (_, k) => (k === i ? `blob ${i}` : `line ${k}`));
      commitFiles(dir, { f: `${lines.join("\n")}\n`, [`d/${i}`]: `${i}\n` }, `c${i}`);
    }
    // dangling blobs, one a delta of a reachable one, packed with the rest
    const lines = Array.from({ length: 200 }, (_, k) => (k === 7 ? "dangling" : `line ${k}`));
    literal(dir, "blob", `${lines.join("\n")}\n`);
    literal(dir, "blob", "dangling on its own\n");
    const all = g(dir, "cat-file", "--batch-all-objects", "--batch-check=%(objectname)");
    const packed = native(
      dir,
      ["pack-objects", "-q", ".git/objects/pack/pack"],
      new TextEncoder().encode(`${all}\n`),
    );
    expect(packed.status).toBe(0);
    g(dir, "prune-packed");
    expect(readdirSync(join(dir, ".git", "objects")).filter((d) => d.length === 2)).toEqual([]);
    const theirs = await compare(dir, ["--connectivity-only"], (c) => c.setConnectivityOnly(true));
    expect(theirs.stdout).toMatch(/^dangling blob /m);

    // the same run over a store that records what it reads
    const files = createNodeFilesApi({ rootDir: dir });
    const { history } = await createGitFilesBackend({ files });
    const store = history.objects as GitObjects;
    const types: string[] = [];
    const note = <T extends { type: string } | undefined>(o: T): T => {
      if (o) types.push(o.type);
      return o;
    };
    const spy = new Proxy(store, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop === "get") {
          return (id: string, o?: { verify?: boolean }) => target.get(id, o).then(note);
        }
        if (prop === "getNow" && typeof value === "function") {
          return (id: string, o?: { verify?: boolean }) => {
            const r = value.call(target, id, o);
            return r instanceof Promise ? r.then(note) : note(r);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    Object.defineProperty(history, "objects", { value: spy });
    const git = Git.fromWorkingCopy(
      new MemoryWorkingCopy({
        history,
        checkout: new MemoryCheckout({ staging: new MemoryStagingStore() }),
        worktree: createMockWorktree(),
      }),
    );
    const ours = await git
      .fsck()
      .setRepositoryFiles({ files })
      .setCompatibility(compatibility)
      .setConnectivityOnly(true)
      .call();
    expect(ours.output).toBe(theirs.stdout);
    expect(types.length).toBeGreaterThan(0);
    expect(types.filter((t) => t === "blob")).toEqual([]);
  });

  /** The offset of a chunk of a commit-graph file (its table of contents). */
  function chunkOffset(bytes: Uint8Array, id: string): number {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < (bytes[6] as number); i++) {
      const at = 8 + 12 * i;
      if (new TextDecoder().decode(bytes.subarray(at, at + 4)) === id) {
        return Number(view.getBigUint64(at + 4));
      }
    }
    throw new Error(`no ${id} chunk`);
  }

  it("the commit-graph is verified as `git commit-graph verify` (exit bit 16)", async () => {
    const dir = newRepo();
    for (let i = 0; i < 4; i++) commitFiles(dir, { [`f${i}`]: `${i}\n` }, `c${i}`);
    g(dir, "checkout", "-q", "-b", "side", "HEAD~2");
    commitFiles(dir, { s: "s\n" }, "side");
    g(dir, "checkout", "-q", "main");
    g(dir, "merge", "-q", "--no-edit", "side");
    g(dir, "commit-graph", "write", "--reachable");
    expect(await compare(dir, [])).toEqual({ stdout: "", stderr: "", exit: 0 });
    const file = join(dir, ".git", "objects", "info", "commit-graph");
    const sound = readFileSync(file);
    // a date in the commit data: the checksum and the date are reported
    flipByte(file, chunkOffset(sound, "CDAT") + 20 + 15, 0x01);
    let r = await compare(dir, []);
    expect(r.exit).toBe(16);
    expect(r.stderr).toContain(
      "the commit-graph file has incorrect checksum and is likely corrupt",
    );
    expect(r.stderr).toMatch(/commit date for commit [0-9a-f]{40} in commit-graph is \d+ != \d+/);
    // a parent position: the parent is reported
    writeFileSync(file, sound);
    flipByte(file, chunkOffset(sound, "CDAT") + 20 + 3, 0x01);
    r = await compare(dir, []);
    expect(r.stderr).toMatch(
      /commit-graph parent for [0-9a-f]{40} is [0-9a-f]{40} != [0-9a-f]{40}/,
    );
    // a bad signature: the graph does not load
    writeFileSync(file, sound);
    flipByte(file, 0, 0x01);
    r = await compare(dir, []);
    expect(r.stderr).toContain("error: commit-graph signature");
    expect(r.exit).toBe(16);
    // core.commitGraph=false: not verified
    g(dir, "config", "core.commitGraph", "false");
    expect(await compare(dir, [])).toEqual({ stdout: "", stderr: "", exit: 0 });
    g(dir, "config", "core.commitGraph", "true");
    // a split chain with a missing layer
    writeFileSync(file, sound);
    rmSync(file);
    g(dir, "commit-graph", "write", "--reachable", "--split");
    commitFiles(dir, { t: "t\n" }, "top");
    g(dir, "commit-graph", "write", "--reachable", "--split=no-merge");
    const chain = readFileSync(
      join(dir, ".git/objects/info/commit-graphs/commit-graph-chain"),
      "utf8",
    );
    expect(await compare(dir, [])).toEqual({ stdout: "", stderr: "", exit: 0 });
    const top = chain.trim().split("\n")[1] as string;
    rmSync(join(dir, `.git/objects/info/commit-graphs/graph-${top}.graph`));
    r = await compare(dir, []);
    expect(r.stderr).toContain("error: one or more commit-graph chain files could not be loaded");
    expect(r.exit).toBe(16);
  });
});
