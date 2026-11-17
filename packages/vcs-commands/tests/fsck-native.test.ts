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
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { FsckCommand } from "../src/index.js";
import { gitOk, openOurs, put } from "./merge-native-helpers.js";
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
});
