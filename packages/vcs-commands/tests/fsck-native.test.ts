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
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
});
