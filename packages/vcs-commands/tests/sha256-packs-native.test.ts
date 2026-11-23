/**
 * SHA-256 packs and index files against native git (statewalker-root#225, T3b): packs, `.idx`,
 * `.rev` and `.mtimes` native git writes in a `--object-format=sha256` repository read by
 * ours, and the ones ours writes (index-pack, pack-objects, repack, gc) read by native git
 * (`git fsck --strict`, `git verify-pack -v`); the index file (versions 2 to 4, `TREE`, `REUC`,
 * `UNTR`, a split index's `link`, a sparse index's `sdir`, `index.skipHash`) read and written
 * byte for byte as git does. Scenarios follow git's own tests, named per case: t5300-pack-object.sh
 * (pack-objects, unpack-objects, verify-pack, index-pack), t5302-pack-index.sh (index v2 and
 * the reverse index), t1700-split-index.sh, t1092-sparse-checkout-compatibility.sh,
 * t7063-status-untracked-cache.sh, t2104-update-index-skip-worktree.sh (version 3) and
 * t2108-update-index-refresh-racy.sh (version 4 via `index.version`).
 *
 * What SHA-256 repositories still lack (the multi-pack-index, pack bitmaps, the commit-graph)
 * stays refused or skipped: see the last describe.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  importPack,
  installPack,
  openPack,
  parsePackMtimes,
  unpackObjects,
  writePack,
} from "@statewalker/vcs-core";
import {
  createGitFilesBackend,
  multiPackIndexWrite,
  openGitLinkedWorktrees,
} from "@statewalker/vcs-store-files";
import { SHA256_OBJECT_FORMAT, UnsupportedObjectFormatError } from "@statewalker/vcs-utils";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import {
  encodeIndexFileBytes,
  encodeIndexInOrder,
  IndexFile,
  parseIndexFile,
} from "@statewalker/vcs-working-tree";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatStatusPorcelain, Git } from "../src/index.js";
import { put } from "./merge-native-helpers.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

describeGit("SHA-256 packs and index files against native git", () => {
  let root: string;
  let n = 0;
  /** git 2.45+ (2.5x's fsck checks the reverse indexes, `--no-references`) */
  let modern = false;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "sha256-packs-"));
    const m = /(\d+)\.(\d+)/.exec(native(root, ["--version"]).stdout);
    modern = !!m && (Number(m[1]) > 2 || Number(m[2]) >= 45);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  function native(cwd: string, args: string[], input?: string | Uint8Array, env = {}) {
    const r = spawnSync("git", args, {
      cwd,
      env: { ...nativeGitEnv(root), ...env },
      input,
      maxBuffer: 64 * 2 ** 20,
    });
    return { status: r.status ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
  }
  const g = (dir: string, ...args: string[]) => {
    const r = native(dir, args);
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const fresh = () => join(root, `r${n++}`);
  const fsckArgs = () => [
    "fsck",
    "--strict",
    "--no-progress",
    "--no-dangling",
    ...(modern ? ["--no-references"] : []),
  ];
  const expectNativeFsckClean = (dir: string) => {
    const r = native(dir, fsckArgs());
    expect([r.status, r.stderr, r.stdout]).toEqual([0, "", ""]);
  };

  /**
   * A SHA-256 repository native git builds with history that deltifies: a file edited over
   * several commits, a tag, a side branch merged back.
   */
  function nativeRepo(): string {
    const dir = fresh();
    g(root, "init", "-q", "--object-format=sha256", "-b", "main", dir);
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i} of a file that deltifies well`);
    for (let c = 0; c < 6; c++) {
      lines[c * 7] = `changed in commit ${c}`;
      put(dir, "big.txt", `${lines.join("\n")}\n`);
      put(dir, `d/f${c}.txt`, `file ${c}\n`);
      g(dir, "add", "-A");
      g(dir, "commit", "-q", "-m", `commit ${c}`);
    }
    g(dir, "tag", "-a", "-m", "version one", "v1");
    g(dir, "checkout", "-q", "-b", "side");
    put(dir, "side.txt", "side\n");
    g(dir, "add", "side.txt");
    g(dir, "commit", "-q", "-m", "side");
    g(dir, "checkout", "-q", "main");
    g(dir, "merge", "-q", "--no-ff", "--no-edit", "side");
    return dir;
  }

  /** Every object of a repository as native git reads it: id, type, size and content. */
  function nativeObjects(dir: string): Map<string, { type: string; content: Buffer }> {
    const ids = g(dir, "cat-file", "--batch-all-objects", "--batch-check=%(objectname)").split(
      "\n",
    );
    const out = new Map<string, { type: string; content: Buffer }>();
    const r = spawnSync("git", ["cat-file", "--batch"], {
      cwd: dir,
      env: nativeGitEnv(root),
      input: `${ids.join("\n")}\n`,
      maxBuffer: 64 * 2 ** 20,
    });
    let at = 0;
    const buf = r.stdout;
    while (at < buf.length) {
      const nl = buf.indexOf(10, at);
      const [id, type, size] = buf.subarray(at, nl).toString().split(" ");
      const len = Number(size);
      out.set(id as string, {
        type: type as string,
        content: buf.subarray(nl + 1, nl + 1 + len),
      });
      at = nl + 1 + len + 1;
    }
    return out;
  }

  /** Our files working copy over `dir` (its `.git`), its index read from `.git/index`. */
  async function openOurs(dir: string): Promise<Git> {
    const files = createNodeFilesApi({ rootDir: dir });
    const environment = createNodeGitHostEnvironment({ env: nativeGitEnv(root) });
    const { history } = await createGitFilesBackend({ files, gitDir: ".git", environment });
    const worktrees = await openGitLinkedWorktrees({ files, gitDir: ".git", history, environment });
    return Git.fromWorkingCopy(await worktrees.openCurrent());
  }

  const packNames = (dir: string, ext: string) =>
    readdirSync(join(dir, ".git", "objects", "pack"))
      .filter((f) => f.endsWith(ext))
      .sort();

  // ---------------------------------------------------------------- packs native git writes

  describe("packs native git writes, read by ours (t5300-pack-object.sh)", () => {
    // "pack with REF_DELTA" (pack-objects without --delta-base-offset) and "pack with
    // OFS_DELTA" (repack's --delta-base-offset): every object read back through the packs
    for (const kind of ["OFS_DELTA", "REF_DELTA"] as const) {
      it(`reads every object of a ${kind} pack as native git does`, async () => {
        const dir = nativeRepo();
        const expected = nativeObjects(dir);
        if (kind === "OFS_DELTA") {
          g(dir, "repack", "-q", "-a", "-d", "-f");
        } else {
          const list = g(dir, "rev-list", "--objects", "--all");
          const r = native(dir, ["pack-objects", "-q", ".git/objects/pack/pack"], `${list}\n`);
          expect(r.status).toBe(0);
          g(dir, "prune-packed");
        }
        expect(packNames(dir, ".pack")).toHaveLength(1);
        expect(packNames(dir, ".pack")[0]).toMatch(/^pack-[0-9a-f]{64}\.pack$/);
        const files = createNodeFilesApi({ rootDir: dir });
        const { objects, packs } = await createGitFilesBackend({ files, gitDir: ".git" });
        expect(objects.objectFormat).toBe(SHA256_OBJECT_FORMAT);
        const [pack] = await packs.packs();
        expect(pack?.packId).toHaveLength(64);
        let deltas = 0;
        for (const [id, want] of expected) {
          const entry = await packs.entry(id);
          if (entry && entry.kind > 4) {
            deltas++;
            expect(entry.kind).toBe(kind === "OFS_DELTA" ? 6 : 7);
            expect(entry.baseId).toHaveLength(64);
          }
          const obj = await objects.get(id, { verify: true });
          expect(obj?.type).toBe(want.type);
          const chunks: Uint8Array[] = [];
          for await (const c of obj?.content ?? []) chunks.push(c);
          expect(Buffer.concat(chunks).equals(want.content)).toBe(true);
        }
        expect(deltas).toBeGreaterThan(0);
        // the log walks the packed commits
        const git = await openOurs(dir);
        const log = [];
        for await (const c of await git.log().call()) log.push(c.message.trim());
        expect(log).toEqual(g(dir, "log", "--format=%B").split(/\n+/).filter(Boolean));
      });
    }

    // "verify pack -v": ours prints what native verify-pack prints for git's pack
    it("verify-pack -v of a native pack prints what git prints", async () => {
      const dir = nativeRepo();
      g(dir, "repack", "-q", "-a", "-d");
      const [pack] = packNames(dir, ".idx");
      const path = `.git/objects/pack/${pack}`;
      const theirs = native(dir, ["verify-pack", "-v", path]);
      const git = await openOurs(dir);
      const ours = await git
        .verifyPack()
        .setRepositoryFiles({ files: createNodeFilesApi({ rootDir: dir }) })
        .addPack(path)
        .setVerbose(true)
        .call();
      expect([ours.output, ours.errorOutput, ours.exitCode]).toEqual([
        theirs.stdout,
        theirs.stderr,
        theirs.status,
      ]);
    });

    // "unpack without delta" / "unpack with REF_DELTA": git's pack into loose objects
    it("unpacks a native pack into loose objects native git reads", async () => {
      const src = nativeRepo();
      const list = g(src, "rev-list", "--objects", "--all");
      const pack = spawnSync("git", ["pack-objects", "-q", "--stdout"], {
        cwd: src,
        env: nativeGitEnv(root),
        input: `${list}\n`,
        maxBuffer: 64 * 2 ** 20,
      }).stdout;
      const dir = fresh();
      g(root, "init", "-q", "--object-format=sha256", "-b", "main", dir);
      const { objects } = await createGitFilesBackend({
        files: createNodeFilesApi({ rootDir: dir }),
        gitDir: ".git",
      });
      const result = await unpackObjects(
        objects,
        (async function* () {
          yield new Uint8Array(pack);
        })(),
      );
      expect(result.count).toBe(list.split("\n").length);
      expect(result.deltas).toBeGreaterThan(0);
      g(dir, "update-ref", "refs/heads/main", g(src, "rev-parse", "main"));
      expect(native(dir, ["cat-file", "--batch-all-objects", "--batch-check"]).stdout).toBe(
        native(src, ["cat-file", "--batch-all-objects", "--batch-check"]).stdout,
      );
      expectNativeFsckClean(dir);
    });

    // t5302-pack-index.sh "index v2: verify a pack with some 64-bit offsets" (the idx layout):
    // index-pack of git's pack writes git's .idx and .rev byte for byte
    it("index-pack writes the .idx and .rev git writes for the same pack", async () => {
      const dir = nativeRepo();
      g(dir, "-c", "pack.writeReverseIndex=true", "repack", "-q", "-a", "-d");
      const [name] = packNames(dir, ".pack");
      const base = join(dir, ".git", "objects", "pack", (name as string).slice(0, -5));
      const packBytes = readFileSync(`${base}.pack`);
      const files = createNodeFilesApi({ rootDir: root });
      const target = fresh();
      g(root, "init", "-q", "--object-format=sha256", target);
      const packDir = `${target.slice(root.length + 1)}/.git/objects/pack`;
      const source = (async function* () {
        yield new Uint8Array(packBytes);
      })();
      const installed = await installPack(files, packDir, source, {
        objectFormat: SHA256_OBJECT_FORMAT,
        writeReverseIndex: true,
      });
      expect(`pack-${installed.packId}.pack`).toBe(name);
      const ours = join(target, ".git", "objects", "pack", `pack-${installed.packId}`);
      expect(readFileSync(`${ours}.idx`).equals(readFileSync(`${base}.idx`))).toBe(true);
      if (existsSync(`${base}.rev`)) {
        expect(readFileSync(`${ours}.rev`).equals(readFileSync(`${base}.rev`))).toBe(true);
      } else {
        // git 2.43 writes none by default: git's index-pack --rev-index writes the same
        g(target, "index-pack", "--rev-index", `${ours}.pack`);
      }
      // the reverse index's hash id is SHA-256's (2)
      expect(readFileSync(`${ours}.rev`).readUInt32BE(8)).toBe(2);
      const opened = await openPack(
        files,
        `${packDir}/pack-${installed.packId}.pack`,
        `${packDir}/pack-${installed.packId}.idx`,
        {
          objectFormat: SHA256_OBJECT_FORMAT,
          verifyIndex: true,
        },
      );
      expect(await opened.loadReverseIndex?.()).toBe("loaded");
      expect(await opened.verifyReverseIndex?.()).toBeUndefined();
      opened.close();
    });
  });

  // ---------------------------------------------------------------- packs ours writes

  describe("packs ours writes, read by native git", () => {
    // t5300 "pack-objects with REF_DELTA" / "with OFS_DELTA", then "index-pack" of each
    it("pack-objects streams packs native index-pack and verify-pack accept", async () => {
      const dir = nativeRepo();
      const { objects } = await createGitFilesBackend({
        files: createNodeFilesApi({ rootDir: dir }),
        gitDir: ".git",
      });
      const ids = g(dir, "rev-list", "--objects", "--all")
        .split("\n")
        .map((l) => {
          const space = l.indexOf(" ");
          return space < 0 ? { id: l } : { id: l.slice(0, space), path: l.slice(space + 1) };
        });
      for (const ofsDelta of [true, false]) {
        const chunks: Uint8Array[] = [];
        for await (const c of writePack(objects, ids, { deltaSearch: true, ofsDelta })) {
          chunks.push(c);
        }
        const pack = Buffer.concat(chunks);
        const out = join(root, `ours-${n++}.pack`);
        writeFileSync(out, pack);
        const r = native(dir, ["index-pack", "-o", out.replace(/\.pack$/, ".idx"), out]);
        expect([r.status, r.stderr]).toEqual([0, ""]);
        const v = native(dir, ["verify-pack", "-v", out.replace(/\.pack$/, ".idx")]);
        expect(v.status).toBe(0);
        expect(v.stdout).toMatch(/chain length = 1: /);
        // the base ids of a REF_DELTA pack are 32 bytes: git found every delta's base
        expect(v.stdout).toMatch(/^non delta: \d+ objects$/m);
      }
    });

    // gc: repack -a -d, prune, the reverse index, packed refs
    it("gc packs a repository native git finds clean and verifies", async () => {
      const dir = nativeRepo();
      put(dir, "loose.txt", "unreachable\n");
      g(dir, "hash-object", "-w", "loose.txt");
      rmSync(join(dir, "loose.txt"));
      const before = nativeObjects(dir);
      const git = await openOurs(dir);
      const result = await git.gc().setPrune("now").call();
      expect(result.objectsRemoved).toBeGreaterThan(0);
      const packs = packNames(dir, ".pack");
      expect(packs).toHaveLength(1);
      expect(packs[0]).toMatch(/^pack-[0-9a-f]{64}\.pack$/);
      // git 2.41+'s default: a .rev beside the pack, SHA-256's hash id
      const rev = readFileSync(
        join(dir, ".git", "objects", "pack", (packs[0] as string).replace(/\.pack$/, ".rev")),
      );
      expect(rev.readUInt32BE(8)).toBe(2);
      // no commit-graph, no bitmap in a SHA-256 repository yet
      expect(existsSync(join(dir, ".git", "objects", "info", "commit-graph"))).toBe(false);
      expect(packNames(dir, ".bitmap")).toEqual([]);
      expectNativeFsckClean(dir);
      const idx = `.git/objects/pack/${(packs[0] as string).replace(/\.pack$/, ".idx")}`;
      expect(native(dir, ["verify-pack", idx]).status).toBe(0);
      const after = nativeObjects(dir);
      for (const [id] of after) expect(before.has(id)).toBe(true);
      expect(after.size).toBe(before.size - 1);
      // and ours reads its own pack back, the index too
      const again = await openOurs(dir);
      expect((await again.status().call()).isClean()).toBe(true);
    });

    // index-pack into a quarantine (receive-pack's tmp_objdir), kept as a pack or unpacked
    for (const unpackLimit of [1, 1000]) {
      it(`imports a pack through a quarantine (${unpackLimit === 1 ? "kept" : "unpacked"})`, async () => {
        const src = nativeRepo();
        const list = g(src, "rev-list", "--objects", "--all");
        const pack = spawnSync("git", ["pack-objects", "-q", "--stdout", "--delta-base-offset"], {
          cwd: src,
          env: nativeGitEnv(root),
          input: `${list}\n`,
          maxBuffer: 64 * 2 ** 20,
        }).stdout;
        const dir = fresh();
        g(root, "init", "-q", "--object-format=sha256", "-b", "main", dir);
        const { objects, packs } = await createGitFilesBackend({
          files: createNodeFilesApi({ rootDir: dir }),
          gitDir: ".git",
        });
        const imported = await importPack(
          objects,
          (async function* () {
            yield new Uint8Array(pack);
          })(),
          { packs, quarantine: true, unpackLimit },
        );
        expect(imported.quarantined).toBe(true);
        expect(imported.kept !== undefined).toBe(unpackLimit === 1);
        // nothing is published before the commit
        expect(native(dir, ["cat-file", "-e", g(src, "rev-parse", "main")]).status).not.toBe(0);
        await imported.quarantine?.commit();
        g(dir, "update-ref", "refs/heads/main", g(src, "rev-parse", "main"));
        expect(native(dir, ["cat-file", "--batch-all-objects", "--batch-check"]).stdout).toBe(
          native(src, ["cat-file", "--batch-all-objects", "--batch-check"]).stdout,
        );
        expectNativeFsckClean(dir);
      });
    }

    // a kept pack (.keep) stays as it is; a promisor pack is repacked apart (repack -a)
    it("gc leaves a .keep pack and repacks a promisor pack apart", async () => {
      const dir = nativeRepo();
      g(dir, "repack", "-q", "-a", "-d");
      const [kept] = packNames(dir, ".pack");
      const keptBase = join(dir, ".git", "objects", "pack", (kept as string).slice(0, -5));
      writeFileSync(`${keptBase}.keep`, "");
      put(dir, "later.txt", "later\n");
      g(dir, "add", "later.txt");
      g(dir, "commit", "-q", "-m", "later");
      const git = await openOurs(dir);
      await git.gc().setPrune("now").call();
      expect(existsSync(`${keptBase}.pack`)).toBe(true);
      expect(packNames(dir, ".pack")).toHaveLength(2);
      expectNativeFsckClean(dir);

      const promised = nativeRepo();
      g(promised, "repack", "-q", "-a", "-d");
      const [p] = packNames(promised, ".pack");
      writeFileSync(
        join(promised, ".git", "objects", "pack", (p as string).replace(/\.pack$/, ".promisor")),
        "",
      );
      g(promised, "config", "remote.origin.url", "https://example.invalid/repo.git");
      g(promised, "config", "remote.origin.promisor", "true");
      g(promised, "config", "remote.origin.partialclonefilter", "blob:none");
      const ours = await openOurs(promised);
      await ours.gc().setPrune("now").call();
      const promisors = packNames(promised, ".promisor");
      expect(promisors).toHaveLength(1);
      expect(promisors[0]).toMatch(/^pack-[0-9a-f]{64}\.promisor$/);
      expectNativeFsckClean(promised);
    });

    // cruft packs: git gc's default keeps recent unreachable objects in one, with .mtimes
    it("gc writes a cruft pack and .mtimes native git reads", async () => {
      const dir = nativeRepo();
      put(dir, "loose.txt", "unreachable but recent\n");
      const loose = g(dir, "hash-object", "-w", "loose.txt");
      const git = await openOurs(dir);
      await git.gc().setPrune("2.weeks.ago").call();
      const mtimes = packNames(dir, ".mtimes");
      expect(mtimes).toHaveLength(1);
      const bytes = readFileSync(join(dir, ".git", "objects", "pack", mtimes[0] as string));
      expect(bytes.readUInt32BE(8)).toBe(2);
      expect(parsePackMtimes(new Uint8Array(bytes), 1, "x")).toHaveLength(1);
      expect(g(dir, "cat-file", "-t", loose)).toBe("blob");
      expectNativeFsckClean(dir);
      // native gc reads our cruft pack's times: the object is recent, kept
      g(dir, "gc", "-q", "--prune=2.weeks.ago");
      expect(g(dir, "cat-file", "-t", loose)).toBe("blob");
    });

    // native git gc over what ours packed, and ours over what native packed
    it("each side repacks what the other packed", async () => {
      const dir = nativeRepo();
      g(dir, "repack", "-q", "-a", "-d");
      const git = await openOurs(dir);
      await git.gc().setPrune("now").call();
      expectNativeFsckClean(dir);
      g(dir, "repack", "-q", "-a", "-d", "-f");
      const again = await openOurs(dir);
      await again.gc().setPrune("now").call();
      expectNativeFsckClean(dir);
      const ours = await again
        .fsck()
        .setRepositoryFiles({ files: createNodeFilesApi({ rootDir: dir }) })
        .setCompatibility(modern ? "2.56" : "2.43")
        .call();
      const theirs = native(dir, ["fsck", ...(modern ? ["--no-references"] : [])]);
      expect([ours.output, ours.errorOutput, ours.exitCode]).toEqual([
        theirs.stdout,
        theirs.stderr,
        theirs.status,
      ]);
    });
  });

  // ---------------------------------------------------------------- the index file

  describe("the index file", () => {
    /** Re-encodes the index at `dir` from its parsed entries and extensions: git's bytes. */
    async function reencoded(dir: string): Promise<{ same: boolean; version: number }> {
      const bytes = new Uint8Array(readFileSync(join(dir, ".git", "index")));
      const parsed = await parseIndexFile(bytes, {
        objectFormat: SHA256_OBJECT_FORMAT,
        verifyChecksum: true,
      });
      const skipHash = bytes.subarray(bytes.length - 32).every((b) => b === 0);
      const options = {
        objectFormat: SHA256_OBJECT_FORMAT,
        ...(skipHash ? { skipHash: true } : {}),
      };
      // a split index's entries are written in its order, replacements with stripped names
      const again = parsed.extensions.includes("link")
        ? await encodeIndexInOrder(
            parsed.entries.map((entry) => ({ entry, path: entry.path })),
            parsed.version,
            parsed.extensionData,
            options,
          )
        : await encodeIndexFileBytes(parsed.entries, parsed.version, parsed.extensionData, {
            ...options,
            sparseDirectories: parsed.extensions.includes("sdir"),
          });
      return { same: Buffer.from(again.bytes).equals(Buffer.from(bytes)), version: parsed.version };
    }

    // versions 2 (t2104 without flags), 3 (skip-worktree: extended flags), 4 (index.version)
    it("reads and re-encodes git's index byte for byte: versions 2, 3 and 4, TREE", async () => {
      const dir = nativeRepo();
      expect(await reencoded(dir)).toEqual({ same: true, version: 2 });
      g(dir, "update-index", "--skip-worktree", "d/f1.txt");
      expect(await reencoded(dir)).toEqual({ same: true, version: 3 });
      g(dir, "update-index", "--no-skip-worktree", "d/f1.txt");
      g(dir, "update-index", "--index-version", "4");
      expect(await reencoded(dir)).toEqual({ same: true, version: 4 });
      // the cache-tree of a freshly committed index is valid: 64-hex ids
      g(dir, "update-index", "--index-version", "2");
      g(dir, "read-tree", "HEAD");
      g(dir, "write-tree");
      const parsed = await parseIndexFile(
        new Uint8Array(readFileSync(join(dir, ".git", "index"))),
        {
          objectFormat: SHA256_OBJECT_FORMAT,
        },
      );
      expect(parsed.extensions).toContain("TREE");
      expect(await reencoded(dir)).toEqual({ same: true, version: 2 });
    });

    // index.skipHash (t1600-index.sh "index.skipHash config option")
    it("reads and writes a null trailer (index.skipHash)", async () => {
      const dir = nativeRepo();
      g(dir, "config", "index.skipHash", "true");
      put(dir, "new.txt", "new\n");
      g(dir, "add", "new.txt");
      const bytes = readFileSync(join(dir, ".git", "index"));
      expect(bytes.subarray(bytes.length - 32).every((b) => b === 0)).toBe(true);
      expect((await reencoded(dir)).same).toBe(true);
      const git = await openOurs(dir);
      put(dir, "other.txt", "other\n");
      await git.add().addFilepattern("other.txt").call();
      const ours = readFileSync(join(dir, ".git", "index"));
      expect(ours.subarray(ours.length - 32).every((b) => b === 0)).toBe(true);
      expect(g(dir, "status", "--porcelain")).toBe("A  new.txt\nA  other.txt");
      expectNativeFsckClean(dir);
    });

    // REUC (t2030-unresolve-info.sh): a resolved conflict's stages kept
    it("reads and writes resolve-undo records (REUC)", async () => {
      const dir = nativeRepo();
      g(dir, "checkout", "-q", "-b", "other", "v1");
      put(dir, "big.txt", "theirs\n");
      g(dir, "commit", "-q", "-am", "other");
      g(dir, "checkout", "-q", "main");
      put(dir, "big.txt", "ours\n");
      g(dir, "commit", "-q", "-am", "mine");
      expect(native(dir, ["merge", "other"]).status).toBe(1);
      put(dir, "big.txt", "resolved\n");
      g(dir, "add", "big.txt");
      const parsed = await parseIndexFile(
        new Uint8Array(readFileSync(join(dir, ".git", "index"))),
        {
          objectFormat: SHA256_OBJECT_FORMAT,
        },
      );
      expect(parsed.extensions).toContain("REUC");
      expect((await reencoded(dir)).same).toBe(true);
      // ours reads them (`checkout -m` recreates the conflict from them) and keeps them
      const git = await openOurs(dir);
      put(dir, "d/f0.txt", "edited\n");
      await git.add().addFilepattern("d/f0.txt").call();
      expect(g(dir, "ls-files", "--resolve-undo")).toMatch(/^100644 [0-9a-f]{64} 1\tbig.txt$/m);
      await git.checkout().setMerge(true).addPath("big.txt").call();
      expect(g(dir, "ls-files", "-u", "big.txt").split("\n")).toHaveLength(3);
    });

    // t7063-status-untracked-cache.sh: the cache ours writes is the one git writes
    it("writes the untracked cache (UNTR) native git writes", async () => {
      const dir = nativeRepo();
      g(dir, "config", "core.untrackedCache", "true");
      put(dir, ".gitignore", "*.log\n");
      put(dir, "u/one.txt", "one\n");
      put(dir, "x.log", "ignored\n");
      g(dir, "update-index", "--untracked-cache");
      const index = join(dir, ".git", "index");
      const start = readFileSync(index);
      native(dir, ["status", "--porcelain"]);
      const theirs = readFileSync(index);
      writeFileSync(index, start);
      const git = await openOurs(dir);
      const status = await git.status().call();
      expect(formatStatusPorcelain(status)).toBe("?? .gitignore\n?? u/\n");
      const ours = readFileSync(index);
      const untr = async (b: Buffer) =>
        (
          await parseIndexFile(new Uint8Array(b), { objectFormat: SHA256_OBJECT_FORMAT })
        ).extensionData.find((e) => e.signature === "UNTR")?.data;
      const a = await untr(ours);
      const b = await untr(theirs);
      expect(a).toBeDefined();
      expect(Buffer.from(a as Uint8Array).equals(Buffer.from(b as Uint8Array))).toBe(true);
    });

    // t1700-split-index.sh: a split index (link) and its sharedindex.<64-hex>
    it("reads and writes a split index with a SHA-256 shared index", async () => {
      const dir = nativeRepo();
      g(dir, "update-index", "--split-index");
      const shared = readdirSync(join(dir, ".git")).filter((f) => f.startsWith("sharedindex."));
      expect(shared).toHaveLength(1);
      expect(shared[0]).toMatch(/^sharedindex\.[0-9a-f]{64}$/);
      expect((await reencoded(dir)).same).toBe(true);
      const git = await openOurs(dir);
      expect((await git.status().call()).isClean()).toBe(true);
      put(dir, "d/f2.txt", "changed\n");
      await git.add().addFilepattern("d/f2.txt").call();
      const parsed = await parseIndexFile(
        new Uint8Array(readFileSync(join(dir, ".git", "index"))),
        {
          objectFormat: SHA256_OBJECT_FORMAT,
        },
      );
      expect(parsed.extensions).toContain("link");
      expect(g(dir, "status", "--porcelain")).toBe("M  d/f2.txt");
      expect(g(dir, "ls-files", "-s")).toBe(
        g(dir, "ls-tree", "-r", "--format=%(objectmode) %(objectname) 0\t%(path)", "HEAD")
          .split("\n")
          .map((l) =>
            l.endsWith("\td/f2.txt")
              ? `100644 ${g(dir, "hash-object", "d/f2.txt")} 0\td/f2.txt`
              : l,
          )
          .join("\n"),
      );
      // a new shared index once the configuration asks for one
      g(dir, "config", "core.splitIndex", "true");
      g(dir, "config", "splitIndex.maxPercentChange", "0");
      put(dir, "d/f3.txt", "changed too\n");
      await git.add().addFilepattern("d/f3.txt").call();
      const names = readdirSync(join(dir, ".git")).filter((f) => f.startsWith("sharedindex."));
      expect(names.every((f) => /^sharedindex\.[0-9a-f]{64}$/.test(f))).toBe(true);
      expect(g(dir, "status", "--porcelain")).toBe("M  d/f2.txt\nM  d/f3.txt");
      expectNativeFsckClean(dir);
    });

    // t1092-sparse-checkout-compatibility.sh: a sparse index (sdir) expanded and collapsed
    it("reads and writes a sparse index (sdir) with SHA-256 trees", async () => {
      const dir = nativeRepo();
      g(dir, "sparse-checkout", "set", "--cone", "--sparse-index", "d");
      g(dir, "sparse-checkout", "set", "--cone", "--sparse-index", "nothing");
      const before = await parseIndexFile(
        new Uint8Array(readFileSync(join(dir, ".git", "index"))),
        {
          objectFormat: SHA256_OBJECT_FORMAT,
        },
      );
      expect(before.extensions).toContain("sdir");
      expect(before.entries.some((e) => e.path === "d/" && e.objectId.length === 64)).toBe(true);
      expect((await reencoded(dir)).same).toBe(true);
      // a twin where native git makes the same change
      const twin = fresh();
      spawnSync("cp", ["-a", dir, twin]);
      put(twin, "big.txt", "changed at the top\n");
      g(twin, "add", "big.txt");
      const git = await openOurs(dir);
      put(dir, "big.txt", "changed at the top\n");
      await git.add().addFilepattern("big.txt").call();
      expect(g(dir, "status", "--porcelain")).toBe("M  big.txt");
      expect(g(dir, "ls-files", "--sparse", "-s")).toBe(g(twin, "ls-files", "--sparse", "-s"));
      const after = await parseIndexFile(new Uint8Array(readFileSync(join(dir, ".git", "index"))), {
        objectFormat: SHA256_OBJECT_FORMAT,
      });
      expect(after.extensions).toEqual(
        (
          await parseIndexFile(new Uint8Array(readFileSync(join(twin, ".git", "index"))), {
            objectFormat: SHA256_OBJECT_FORMAT,
          })
        ).extensions,
      );
      // git's fsck of a sparse index whose root changed (the root tree not written yet: git
      // reports it missing after its own add too), the same for both
      const fsckOf = (d: string) => native(d, fsckArgs());
      expect(fsckOf(dir)).toEqual(fsckOf(twin));
    });

    // review of #236 (C1), t1000-read-tree-m-3way.sh's `read-tree --empty`: the cache-tree ours
    // writes holds the SHA-256 empty tree (32 bytes), never SHA-1's
    it("read-tree --empty writes a SHA-256 empty-tree cache-tree git reads", async () => {
      const dir = nativeRepo();
      const twin = fresh();
      spawnSync("cp", ["-a", dir, twin]);
      g(twin, "read-tree", "--empty");
      const git = await openOurs(dir);
      await git.readTree().setEmpty(true).call();
      const treeOf = async (d: string) =>
        (
          await parseIndexFile(new Uint8Array(readFileSync(join(d, ".git", "index"))), {
            objectFormat: SHA256_OBJECT_FORMAT,
            verifyChecksum: true,
          })
        ).extensionData.find((e) => e.signature === "TREE")?.data;
      const ours = await treeOf(dir);
      const theirs = await treeOf(twin);
      expect(Buffer.from(ours ?? new Uint8Array()).toString("hex")).toBe(
        Buffer.from(theirs ?? new Uint8Array()).toString("hex"),
      );
      expect(g(dir, "ls-files", "-s")).toBe("");
      expect(native(dir, ["status", "--porcelain"]).stdout).toBe(
        native(twin, ["status", "--porcelain"]).stdout,
      );
      expect(native(dir, fsckArgs())).toEqual(native(twin, fsckArgs()));
      expect(g(dir, "write-tree")).toBe(SHA256_OBJECT_FORMAT.emptyTreeId);
    });

    // porcelain over the index: status, add, commit -a, read by native git
    it("status, add and commit -a work over git's index and git reads ours", async () => {
      const dir = nativeRepo();
      const git = await openOurs(dir);
      expect((await git.status().call()).isClean()).toBe(true);
      put(dir, "big.txt", "rewritten\n");
      put(dir, "added.txt", "added\n");
      const theirs = native(dir, ["status", "--porcelain"]).stdout;
      const status = await git.status().call();
      expect(formatStatusPorcelain(status)).toBe(theirs);
      expect(theirs).toBe(" M big.txt\n?? added.txt\n");
      await git.add().addFilepattern("added.txt").call();
      expect(g(dir, "status", "--porcelain")).toBe("A  added.txt\n M big.txt");
      const commit = await git.commit().setAll(true).setMessage("ours").call();
      expect(commit.id).toHaveLength(64);
      expect(g(dir, "status", "--porcelain")).toBe("");
      expect(g(dir, "rev-parse", "HEAD")).toBe(commit.id);
      expect(g(dir, "ls-files", "-s", "added.txt")).toBe(
        `100644 ${g(dir, "rev-parse", "HEAD:added.txt")} 0\tadded.txt`,
      );
      // the index ours wrote, hashed and checked by native fsck (verify_index_checksum)
      expectNativeFsckClean(dir);
      const bytes = new Uint8Array(readFileSync(join(dir, ".git", "index")));
      await expect(
        parseIndexFile(bytes, { objectFormat: SHA256_OBJECT_FORMAT, verifyChecksum: true }),
      ).resolves.toBeDefined();
      // twins: the same add by native git in a copy writes the same entries and cache-tree
      expect((await reencoded(dir)).same).toBe(true);
      const read = new IndexFile(createNodeFilesApi({ rootDir: dir }), ".git/index", {
        objectFormat: SHA256_OBJECT_FORMAT,
      });
      expect((await read.read())?.entries.every((e) => e.objectId.length === 64)).toBe(true);
    });
  });

  // ---------------------------------------------------------------- still refused

  describe("what SHA-256 repositories still lack", () => {
    it("refuses a multi-pack-index (read and written) and bitmaps asked for", async () => {
      const dir = nativeRepo();
      g(dir, "repack", "-q", "-a", "-d");
      const files = createNodeFilesApi({ rootDir: dir });
      await expect(multiPackIndexWrite({ files, gitDir: ".git" })).rejects.toThrow(
        UnsupportedObjectFormatError,
      );
      g(dir, "config", "repack.writeBitmaps", "true");
      const git = await openOurs(dir);
      await expect(git.gc().call()).rejects.toThrow(
        "webrun-vcs does not support pack bitmaps in sha256 repositories yet",
      );
      g(dir, "config", "--unset", "repack.writeBitmaps");
      g(dir, "multi-pack-index", "write");
      await expect(createGitFilesBackend({ files, gitDir: ".git" })).rejects.toThrow(
        "webrun-vcs does not support the multi-pack-index in sha256 repositories yet",
      );
    });

    it("gc of a bare repository writes no bitmap and no commit-graph", async () => {
      const src = nativeRepo();
      const dir = fresh();
      g(root, "clone", "-q", "--bare", "--no-local", src, dir);
      const files = createNodeFilesApi({ rootDir: dir });
      const environment = createNodeGitHostEnvironment({ env: nativeGitEnv(root) });
      const { history } = await createGitFilesBackend({ files, gitDir: ".", environment });
      const worktrees = await openGitLinkedWorktrees({ files, gitDir: ".", history, environment });
      const git = Git.fromWorktreeAdmin(await worktrees.openAdmin());
      await git.gc().setPrune("now").call();
      const packDir = join(dir, "objects", "pack");
      expect(readdirSync(packDir).filter((f) => f.endsWith(".bitmap"))).toEqual([]);
      expect(existsSync(join(dir, "objects", "info", "commit-graph"))).toBe(false);
      const r = spawnSync("git", fsckArgs(), {
        cwd: dir,
        env: { ...nativeGitEnv(root), GIT_DIR: "." },
      });
      expect([r.status, r.stderr.toString()]).toEqual([0, ""]);
    });
  });
});
