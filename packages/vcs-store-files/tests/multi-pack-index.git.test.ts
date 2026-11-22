/**
 * Multi-pack-indexes against native git (whichever version is on PATH: 2.43 and 2.5x write
 * different chunks, 2.5x has incremental chains).
 *
 * Safety first: native git reads a midx-covered pack only through the midx, so a repack or gc of
 * ours that deletes packs a midx names must clear it as git's repack does
 * (`repack_remove_redundant_pack` → `clear_midx_file`, `clear_incremental_midx_files`), or
 * native fsck and `multi-pack-index verify` fail with "failed to load pack in position N".
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultSerializationApi, encodeMultiPackIndex, openPack } from "@statewalker/vcs-core";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { afterAll, describe, expect, it } from "vitest";
import {
  createGitFilesBackend,
  gc,
  multiPackIndexExpire,
  multiPackIndexRepack,
  multiPackIndexVerify,
  multiPackIndexWrite,
  repack,
} from "../src/index.js";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "A U Thor",
  GIT_AUTHOR_EMAIL: "author@example.com",
  GIT_COMMITTER_NAME: "C O Mitter",
  GIT_COMMITTER_EMAIL: "committer@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "maintenance.auto",
  GIT_CONFIG_VALUE_0: "false",
  GIT_CONFIG_KEY_1: "gc.auto",
  GIT_CONFIG_VALUE_1: "0",
};
const version = execFileSync("git", ["--version"], { encoding: "utf8" });
const [major = 0, minor = 0] = (/(\d+)\.(\d+)/.exec(version) ?? []).slice(1).map(Number);
const is25x = major > 2 || (major === 2 && minor >= 50);

const git = (cwd: string, args: string[], env: Record<string, string> = {}) =>
  execFileSync("git", args, {
    cwd,
    env: { ...GIT_ENV, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  }).toString();
/** exit status, stdout and stderr of a git call that may fail */
function gitRun(cwd: string, args: string[], input?: string) {
  const r = spawnSync("git", args, { cwd, env: GIT_ENV, input, encoding: "utf8" });
  return { status: r.status ?? -1, out: r.stdout, err: r.stderr };
}

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** `n` commits, each packed into a pack of its own (`repack -d`), dated one second apart. */
function packedRepo(n: number, start = 0): string {
  const dir = mkdtempSync(join(tmpdir(), "midx-"));
  dirs.push(dir);
  git(dir, ["init", "-q", "--initial-branch=main", "."]);
  for (let c = start; c < start + n; c++) addCommit(dir, c);
  return dir;
}

function addCommit(dir: string, c: number, repackIt = true) {
  const date = `${1700000000 + c} +0000`;
  writeFileSync(join(dir, `f${c % 3}.txt`), `content ${c}\n${"x".repeat(c * 7)}\n`);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", `c${c}`], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  if (repackIt) git(dir, ["repack", "-dq"]);
}

const packDir = (dir: string) => join(dir, ".git/objects/pack");
const listPack = (dir: string) => readdirSync(packDir(dir)).sort();
const midxFiles = (dir: string) => listPack(dir).filter((f) => f.startsWith("multi-pack-index"));

const allObjects = (dir: string) =>
  git(dir, ["rev-list", "--objects", "--all"])
    .split("\n")
    .filter(Boolean)
    .map((l) => l.slice(0, 40))
    .sort();

/** native git reads everything and fsck (which runs `multi-pack-index verify`) passes */
function expectNativeReadsAll(dir: string, objects: string[]) {
  const fsck = gitRun(dir, ["fsck", "--no-progress"]);
  expect(fsck.err).toBe("");
  expect(fsck.status).toBe(0);
  expect(gitRun(dir, ["multi-pack-index", "verify"]).status).toBe(0);
  expect(allObjects(dir)).toEqual(objects);
  const batch = execFileSync("git", ["cat-file", "--batch-check"], {
    cwd: dir,
    env: GIT_ENV,
    input: `${objects.join("\n")}\n`,
  }).toString();
  expect(batch).not.toMatch(/missing/);
  git(dir, ["log", "--oneline", "-p"]);
}

async function backend(dir: string) {
  return createGitFilesBackend({ files: createNodeFilesApi({ rootDir: dir }) });
}

describe("midx safety: our repack and gc keep native git's midx consistent", () => {
  it("repack -a -d clears a midx (and its bitmap) naming the packs it deletes", async () => {
    const dir = packedRepo(3);
    git(dir, ["multi-pack-index", "write", "--bitmap"]);
    expect(midxFiles(dir).some((f) => f.endsWith(".bitmap"))).toBe(true);
    const objects = allObjects(dir);

    const r = await repack(await backend(dir));

    expect(r?.packsRemoved.length).toBe(3);
    expect(midxFiles(dir)).toEqual([]);
    expectNativeReadsAll(dir, objects);
  });

  it("gc clears the midx, and native git writes a new one afterwards", async () => {
    const dir = packedRepo(3);
    git(dir, ["multi-pack-index", "write"]);
    addCommit(dir, 3, false); // loose objects for prune-packed
    const objects = allObjects(dir);
    const b = await backend(dir);

    await gc({ history: b.history, files: b.files, pruneExpireMs: 0 });

    expect(midxFiles(dir)).toEqual([]);
    expectNativeReadsAll(dir, objects);
    git(dir, ["multi-pack-index", "write"]);
    expectNativeReadsAll(dir, objects);
  });

  it("repack -d (loose objects only) keeps a midx whose packs all stay", async () => {
    const dir = packedRepo(2);
    git(dir, ["multi-pack-index", "write"]);
    addCommit(dir, 2, false);
    const before = midxFiles(dir);
    const objects = allObjects(dir);

    const r = await repack({ ...(await backend(dir)), all: false });

    expect(r?.packsRemoved).toEqual([]);
    expect(midxFiles(dir)).toEqual(before);
    expectNativeReadsAll(dir, objects);
  });

  it("a .keep pack in the midx: the midx still goes when another pack it names is deleted", async () => {
    const dir = packedRepo(3);
    const first = listPack(dir).find((f) => f.endsWith(".pack")) as string;
    writeFileSync(join(packDir(dir), first.replace(/\.pack$/, ".keep")), "");
    git(dir, ["multi-pack-index", "write"]);
    const objects = allObjects(dir);

    const r = await repack(await backend(dir));

    expect(r?.keptPacks.length).toBe(1);
    expect(midxFiles(dir)).toEqual([]);
    expectNativeReadsAll(dir, objects);
  });

  it.runIf(is25x)(
    "clears an incremental chain (multi-pack-index.d) naming deleted packs",
    async () => {
      const dir = packedRepo(2);
      git(dir, ["multi-pack-index", "write", "--incremental"]);
      addCommit(dir, 2);
      git(dir, ["multi-pack-index", "write", "--incremental"]);
      const chainDir = join(packDir(dir), "multi-pack-index.d");
      expect(readdirSync(chainDir).filter((f) => f.endsWith(".midx")).length).toBe(2);
      const objects = allObjects(dir);

      await repack(await backend(dir));

      expect(readdirSync(chainDir)).toEqual([]);
      expect(midxFiles(dir)).toEqual(["multi-pack-index.d"]);
      expectNativeReadsAll(dir, objects);
    },
  );
});

const files = (dir: string) => createNodeFilesApi({ rootDir: dir });
const compatibility = is25x ? ("2.56" as const) : ("2.43" as const);
const midxPath = (dir: string) => join(packDir(dir), "multi-pack-index");

/** native's midx bytes for `args`, then the midx files removed again */
function nativeMidx(dir: string, args: string[] = [], input?: string): Buffer {
  execFileSync("git", ["multi-pack-index", "write", ...args], {
    cwd: dir,
    env: GIT_ENV,
    stdio: ["pipe", "pipe", "pipe"],
    ...(input !== undefined ? { input } : {}),
  });
  const bytes = readFileSync(midxPath(dir));
  for (const f of midxFiles(dir)) rmSync(join(packDir(dir), f), { recursive: true, force: true });
  return bytes;
}

const packNames = (dir: string, ext: string) => listPack(dir).filter((f) => f.endsWith(ext));

describe("midx write: byte-identical to native for the same packs", () => {
  it("several packs, with and without --bitmap (RIDX, and BTMP in 2.5x)", async () => {
    const dir = packedRepo(4);
    for (const args of [[], ["--bitmap"]]) {
      const native = nativeMidx(dir, args);
      const r = await multiPackIndexWrite({
        files: files(dir),
        compatibility,
        bitmap: args.length > 0,
      });
      expect(r.stderr).toEqual([]);
      expect(r.exitCode).toBe(0);
      expect(Buffer.from(readFileSync(midxPath(dir))).equals(native)).toBe(true);
      expect(gitRun(dir, ["multi-pack-index", "verify"]).status).toBe(0);
      for (const f of midxFiles(dir)) rmSync(join(packDir(dir), f), { force: true });
    }
  });

  it("an explicit preferred pack, duplicates across packs and equal mtimes", async () => {
    const dir = packedRepo(3);
    git(dir, ["repack", "-aq"]); // one more pack holding every object again (newer)
    const packs = packNames(dir, ".pack");
    for (const preferred of [packs[0] as string, packs[2] as string]) {
      for (const args of [
        [`--preferred-pack=${preferred}`],
        [`--preferred-pack=${preferred}`, "--bitmap"],
      ]) {
        const native = nativeMidx(dir, args);
        const r = await multiPackIndexWrite({
          files: files(dir),
          compatibility,
          preferredPack: preferred,
          bitmap: args.length > 1,
        });
        expect(r.exitCode).toBe(0);
        expect(Buffer.from(readFileSync(midxPath(dir))).equals(native)).toBe(true);
        for (const f of midxFiles(dir)) rmSync(join(packDir(dir), f), { force: true });
      }
    }
    // equal mtimes: the copy chosen is the first pack in readdir order
    const when = new Date(1700000000 * 1000);
    for (const p of packs) utimesSync(join(packDir(dir), p), when, when);
    for (const args of [[], ["--bitmap"]]) {
      const native = nativeMidx(dir, args);
      await multiPackIndexWrite({ files: files(dir), compatibility, bitmap: args.length > 0 });
      expect(Buffer.from(readFileSync(midxPath(dir))).equals(native)).toBe(true);
      for (const f of midxFiles(dir)) rmSync(join(packDir(dir), f), { force: true });
    }
  });

  it("reuses an existing midx as git does, and --stdin-packs indexes only the packs given", async () => {
    const dir = packedRepo(3);
    git(dir, ["multi-pack-index", "write"]);
    const old = readFileSync(midxPath(dir));
    git(dir, ["repack", "-aq"]); // a new pack duplicating every object
    git(dir, ["multi-pack-index", "write"]);
    const native = readFileSync(midxPath(dir));
    writeFileSync(midxPath(dir), old);
    const r = await multiPackIndexWrite({ files: files(dir), compatibility });
    expect(r.exitCode).toBe(0);
    expect(Buffer.from(readFileSync(midxPath(dir))).equals(native)).toBe(true);

    const some = packNames(dir, ".idx").slice(1, 3);
    const nativeSome = nativeMidx(dir, ["--stdin-packs"], `${some.join("\n")}\n`);
    await multiPackIndexWrite({ files: files(dir), compatibility, stdinPacks: some });
    expect(Buffer.from(readFileSync(midxPath(dir))).equals(nativeSome)).toBe(true);
  });

  it("git's messages and exit codes: no packs, an unknown preferred pack", async () => {
    const empty = mkdtempSync(join(tmpdir(), "midx-empty-"));
    dirs.push(empty);
    git(empty, ["init", "-q", "."]);
    const native = gitRun(empty, ["multi-pack-index", "write"]);
    const ours = await multiPackIndexWrite({ files: files(empty), compatibility });
    expect(ours.stderr.join("\n")).toBe(native.err.trimEnd());
    expect(ours.exitCode).toBe(native.status);

    const dir = packedRepo(2);
    const n = gitRun(dir, ["multi-pack-index", "write", "--preferred-pack=nope"]);
    const bytes = readFileSync(midxPath(dir));
    rmSync(midxPath(dir));
    const o = await multiPackIndexWrite({
      files: files(dir),
      compatibility,
      preferredPack: "nope",
    });
    expect(o.stderr.join("\n")).toBe(n.err.trimEnd());
    expect(o.exitCode).toBe(n.status);
    expect(Buffer.from(readFileSync(midxPath(dir))).equals(bytes)).toBe(true);
  });

  it.runIf(is25x)("--incremental layers and chain byte-identical to native's", async () => {
    const dir = packedRepo(2);
    const chainDir = join(packDir(dir), "multi-pack-index.d");
    const snapshot = () =>
      new Map(readdirSync(chainDir).map((f) => [f, readFileSync(join(chainDir, f))] as const));
    const restore = (snap: Map<string, Buffer>) => {
      rmSync(chainDir, { recursive: true, force: true });
      mkdirSync(chainDir);
      for (const [f, b] of snap) writeFileSync(join(chainDir, f), b);
    };
    const expectSame = (snap: Map<string, Buffer>) => {
      const now = snapshot();
      expect([...now.keys()].sort()).toEqual([...snap.keys()].sort());
      for (const [f, b] of snap) expect(Buffer.from(now.get(f) as Buffer).equals(b)).toBe(true);
    };
    git(dir, ["multi-pack-index", "write", "--incremental"]);
    const step1 = snapshot();
    const before = new Set(packNames(dir, ".idx"));
    addCommit(dir, 2);
    git(dir, ["multi-pack-index", "write", "--incremental"]);
    const step2 = snapshot();
    expect([...step2.keys()].filter((f) => f.endsWith(".midx")).length).toBe(2);

    // step 2 over native's first layer
    restore(step1);
    expect(
      (await multiPackIndexWrite({ files: files(dir), compatibility, incremental: true })).exitCode,
    ).toBe(0);
    expectSame(step2);
    expect(gitRun(dir, ["multi-pack-index", "verify"]).status).toBe(0);
    expectNativeReadsAll(dir, allObjects(dir));

    // step 1 itself, the third pack out of the way
    rmSync(chainDir, { recursive: true, force: true });
    const third = packNames(dir, ".idx").find((f) => !before.has(f)) as string;
    const aside = mkdtempSync(join(tmpdir(), "midx-aside-"));
    dirs.push(aside);
    const base = third.slice(0, -4);
    const moved = listPack(dir).filter((f) => f.startsWith(`${base}.`));
    for (const f of moved) renameSync(join(packDir(dir), f), join(aside, f));
    expect(
      (await multiPackIndexWrite({ files: files(dir), compatibility, incremental: true })).exitCode,
    ).toBe(0);
    expectSame(step1);
    for (const f of moved) renameSync(join(aside, f), join(packDir(dir), f));
  });
});

/** every object's type and bytes as `git cat-file` gives them */
function nativeContents(dir: string): Map<string, { type: string; bytes: Buffer }> {
  const out = new Map<string, { type: string; bytes: Buffer }>();
  for (const id of allObjects(dir)) {
    const type = git(dir, ["cat-file", "-t", id]).trim();
    out.set(id, {
      type,
      bytes: execFileSync("git", ["cat-file", type, id], { cwd: dir, env: GIT_ENV }),
    });
  }
  return out;
}

/** every object through our backend, its type and bytes as native gave them */
async function expectOursReadsAll(dir: string, reference = nativeContents(dir)) {
  const b = await backend(dir);
  for (const [id, native] of reference) {
    const o = await b.objects.get(id);
    expect(o, id).toBeDefined();
    expect(o?.type).toBe(native.type);
    const chunks: Uint8Array[] = [];
    if (o?.bytes) chunks.push(o.bytes);
    else if (o) for await (const c of o.content) chunks.push(c);
    expect(Buffer.concat(chunks).equals(native.bytes), id).toBe(true);
  }
  return b;
}

describe("midx read: our pack set looks objects up through native's midx", () => {
  it("uses a valid midx (duplicates, preferred pack) and reads every object as native", async () => {
    const dir = packedRepo(4);
    git(dir, ["repack", "-aq"]);
    const preferred = packNames(dir, ".pack")[1] as string;
    git(dir, ["multi-pack-index", "write", "--bitmap", `--preferred-pack=${preferred}`]);
    const b = await expectOursReadsAll(dir);
    const midx = await b.packs.multiPackIndex?.();
    expect(midx?.numPacks).toBe(5);
    expect(b.packs.midxErrors).toEqual([]);
    for (const id of allObjects(dir)) expect(await b.packs.has(id)).toBe(true);
  });

  it("falls back to the packs' own idx for a corrupt, refused or stale midx", async () => {
    const dir = packedRepo(3);
    git(dir, ["multi-pack-index", "write"]);
    const good = readFileSync(midxPath(dir));
    const reference = nativeContents(dir);

    // a flipped id byte: the checksum no longer matches
    const flipped = Buffer.from(good);
    flipped[flipped.length - 100] ^= 0xff;
    writeFileSync(midxPath(dir), flipped);
    let b = await expectOursReadsAll(dir, reference);
    expect(await b.packs.multiPackIndex?.()).toBeUndefined();
    expect(b.packs.midxErrors).toEqual([
      "warning: ignoring existing multi-pack-index; checksum mismatch",
    ]);

    // a wrong signature: native dies, ours records git's line and reads the packs
    const badSig = Buffer.from(good);
    badSig[0] = 0x4e;
    writeFileSync(midxPath(dir), badSig);
    b = await expectOursReadsAll(dir, reference);
    expect(b.packs.midxErrors).toEqual([
      "fatal: multi-pack-index signature 0x4e494458 does not match signature 0x4d494458",
    ]);
    expect(gitRun(dir, ["cat-file", "-t", "HEAD"]).err.trimEnd()).toBe(
      "fatal: multi-pack-index signature 0x4e494458 does not match signature 0x4d494458",
    );

    // too small: an error, the midx ignored (native too)
    writeFileSync(midxPath(dir), good.subarray(0, 20));
    b = await expectOursReadsAll(dir, reference);
    // the path as the FilesApi names it (rooted at the repository), git's relative to its cwd
    expect(b.packs.midxErrors).toEqual([
      "error: multi-pack-index file /.git/objects/pack/multi-pack-index is too small",
    ]);
    expect(gitRun(dir, ["cat-file", "-t", "HEAD"]).err).toContain(
      "error: multi-pack-index file .git/objects/pack/multi-pack-index is too small",
    );

    // stale: a pack it names is gone (its objects are in a pack outside the midx)
    writeFileSync(midxPath(dir), good);
    git(dir, ["repack", "-aq"]);
    const gone = packNames(dir, ".pack")[0] as string;
    for (const ext of [".pack", ".idx", ".rev"])
      rmSync(join(packDir(dir), gone.replace(/\.pack$/, ext)), { force: true });
    b = await expectOursReadsAll(dir, reference);
    expect(await b.packs.multiPackIndex?.()).toBeUndefined();
  });

  it("core.multiPackIndex=false leaves the midx unused", async () => {
    const dir = packedRepo(2);
    git(dir, ["multi-pack-index", "write"]);
    git(dir, ["config", "core.multiPackIndex", "false"]);
    const b = await expectOursReadsAll(dir);
    expect(await b.packs.multiPackIndex?.()).toBeUndefined();
  });

  it.runIf(is25x)("reads through an incremental chain", async () => {
    const dir = packedRepo(2);
    git(dir, ["multi-pack-index", "write", "--incremental"]);
    addCommit(dir, 2);
    git(dir, ["multi-pack-index", "write", "--incremental"]);
    const b = await expectOursReadsAll(dir);
    const midx = await b.packs.multiPackIndex?.();
    expect(midx?.base).toBeDefined();
    expect((midx?.numPacks ?? 0) + (midx?.numPacksInBase ?? 0)).toBe(3);
  });
});

describe("midx verify, expire and repack as native's", () => {
  it("verify: messages and exit codes of a sound, damaged and stale midx", async () => {
    const dir = packedRepo(3);
    git(dir, ["multi-pack-index", "write"]);
    const same = async () => {
      const n = gitRun(dir, ["multi-pack-index", "verify"]);
      const o = await multiPackIndexVerify({ files: files(dir), compatibility });
      expect(o.stderr.join("\n")).toBe(n.err.trimEnd());
      expect(o.exitCode).toBe(n.status);
    };
    await same();
    const good = readFileSync(midxPath(dir));
    const bad = Buffer.from(good);
    bad[bad.length - 1] ^= 1;
    writeFileSync(midxPath(dir), bad);
    await same();
    writeFileSync(midxPath(dir), good);
    const gone = packNames(dir, ".idx")[1] as string;
    const aside = mkdtempSync(join(tmpdir(), "midx-aside-"));
    dirs.push(aside);
    renameSync(join(packDir(dir), gone), join(aside, gone));
    await same();
    renameSync(join(aside, gone), join(packDir(dir), gone));
    rmSync(midxPath(dir));
    await same(); // none: nothing to say
    writeFileSync(midxPath(dir), good.subarray(0, 10));
    await same(); // too small: exists, but failed to parse
  });

  it("expire drops the packs the midx selects nothing from, as native", async () => {
    const dir = packedRepo(3);
    git(dir, ["repack", "-aq"]); // the newest pack wins every object
    git(dir, ["multi-pack-index", "write"]);
    const twin = `${dir}-twin`;
    dirs.push(twin);
    execFileSync("cp", ["-a", dir, twin]);
    const n = gitRun(twin, ["multi-pack-index", "expire"]);
    const o = await multiPackIndexExpire({ files: files(dir), compatibility });
    expect(o.stderr.join("\n")).toBe(n.err.trimEnd());
    expect(o.exitCode).toBe(n.status);
    expect(listPack(dir)).toEqual(listPack(twin));
    expect(Buffer.from(readFileSync(midxPath(dir))).equals(readFileSync(midxPath(twin)))).toBe(
      true,
    );
    expect(gitRun(dir, ["multi-pack-index", "verify"]).status).toBe(0);
  });

  it("repack --batch-size packs the same packs as native, then expire leaves one", async () => {
    const dir = packedRepo(4);
    git(dir, ["multi-pack-index", "write"]);
    const objects = allObjects(dir);
    const twin = `${dir}-twin`;
    dirs.push(twin);
    execFileSync("cp", ["-a", dir, twin]);
    for (const batch of ["1", "0"]) {
      const before = packNames(twin, ".pack");
      const n = gitRun(twin, ["multi-pack-index", "repack", `--batch-size=${batch}`]);
      const o = await multiPackIndexRepack({
        files: files(dir),
        compatibility,
        batchSize: Number(batch),
      });
      expect(o.stderr.join("\n")).toBe(n.err.trimEnd());
      expect(o.exitCode).toBe(n.status);
      // the same number of packs (the new pack's bytes are pack-objects', not compared)
      expect(packNames(dir, ".pack").length).toBe(packNames(twin, ".pack").length);
      expect(packNames(twin, ".pack").length).toBe(before.length + (batch === "1" ? 0 : 1));
    }
    expectNativeReadsAll(dir, objects);
    await multiPackIndexExpire({ files: files(dir), compatibility });
    git(twin, ["multi-pack-index", "expire"]);
    expect(packNames(dir, ".pack").length).toBe(packNames(twin, ".pack").length);
    expect(packNames(dir, ".pack").length).toBe(1);
    expectNativeReadsAll(dir, objects);
  });

  it("an up-to-date midx is left alone; without --bitmap its bitmap goes", async () => {
    const dir = packedRepo(2);
    git(dir, ["multi-pack-index", "write", "--bitmap"]);
    const bytes = readFileSync(midxPath(dir));
    const r = await multiPackIndexWrite({ files: files(dir), compatibility });
    expect(r.written).toBeUndefined();
    expect(Buffer.from(readFileSync(midxPath(dir))).equals(bytes)).toBe(true);
    expect(midxFiles(dir)).toEqual(["multi-pack-index"]);
  });
});

describe("repack --write-midx", () => {
  it("-a -d -m: a midx over the new pack, as native writes it for those packs", async () => {
    const dir = packedRepo(3);
    git(dir, ["multi-pack-index", "write"]); // replaced: the old midx names packs that go
    const objects = allObjects(dir);
    const r = await repack({ ...(await backend(dir)), writeMidx: true, compatibility });
    expect(r?.midx).toBeDefined();
    expect(packNames(dir, ".pack")).toEqual([`${r?.packName}.pack`]);
    expectNativeReadsAll(dir, objects);
    const ours = readFileSync(midxPath(dir));
    const native = nativeMidx(
      dir,
      ["--stdin-packs", `--preferred-pack=${r?.packName}.pack`],
      `${r?.packName}.idx\n`,
    );
    expect(Buffer.from(ours).equals(native)).toBe(true);
  });

  it("-d -m (loose objects only): the existing packs stay in the midx with the new one", async () => {
    const dir = packedRepo(2);
    addCommit(dir, 2, false);
    const objects = allObjects(dir);
    const r = await repack({ ...(await backend(dir)), all: false, writeMidx: true, compatibility });
    const idx = packNames(dir, ".idx");
    expect(idx.length).toBe(3);
    expectNativeReadsAll(dir, objects);
    const ours = readFileSync(midxPath(dir));
    const native = nativeMidx(
      dir,
      ["--stdin-packs", `--preferred-pack=${r?.packName}.pack`],
      `${idx.join("\n")}\n`,
    );
    expect(Buffer.from(ours).equals(native)).toBe(true);
  });
});

describe("midx bitmaps", () => {
  /** distinct dates, a merge, a tag and a branch: commits git selects for bitmaps */
  function historyRepo(): string {
    const dir = packedRepo(4);
    git(dir, ["checkout", "-q", "-b", "side", "HEAD~2"]);
    addCommit(dir, 10);
    git(dir, ["checkout", "-q", "main"]);
    git(dir, ["merge", "-q", "--no-edit", "side"], {
      GIT_AUTHOR_DATE: "1700000100 +0000",
      GIT_COMMITTER_DATE: "1700000100 +0000",
    });
    git(dir, ["repack", "-dq"]);
    git(dir, ["tag", "-a", "-m", "release", "v1", "HEAD~1"], {
      GIT_COMMITTER_DATE: "1700000200 +0000",
    });
    git(dir, ["repack", "-dq"]);
    git(dir, ["repack", "-aq"]); // duplicates in a newer pack
    return dir;
  }

  const bitmapOf = (dir: string) => midxFiles(dir).find((f) => f.endsWith(".bitmap"));

  it("--bitmap writes native's midx bitmap bytes, and native's --test-bitmap accepts ours", async () => {
    const dir = historyRepo();
    for (const extra of [[], [`--preferred-pack=${packNames(dir, ".pack")[0]}`]]) {
      git(dir, ["multi-pack-index", "write", "--bitmap", ...extra]);
      const name = bitmapOf(dir) as string;
      const native = readFileSync(join(packDir(dir), name));
      const nativeMidxBytes = readFileSync(midxPath(dir));
      for (const f of midxFiles(dir)) rmSync(join(packDir(dir), f), { force: true });
      const preferredPack = extra[0]?.slice("--preferred-pack=".length);
      const r = await multiPackIndexWrite({
        files: files(dir),
        compatibility,
        bitmap: true,
        ...(preferredPack ? { preferredPack } : {}),
      });
      expect(r.stderr).toEqual([]);
      expect(Buffer.from(readFileSync(midxPath(dir))).equals(nativeMidxBytes)).toBe(true);
      expect(bitmapOf(dir)).toBe(name);
      expect(Buffer.from(readFileSync(join(packDir(dir), name))).equals(native)).toBe(true);
      const test = gitRun(dir, ["rev-list", "--test-bitmap", "HEAD"]);
      expect(test.status).toBe(0);
      expect(test.err).toMatch(/OK!/);
      for (const f of midxFiles(dir)) rmSync(join(packDir(dir), f), { force: true });
    }
  });

  it("repack -b -m writes a midx bitmap (no pack bitmap) native accepts", async () => {
    const dir = historyRepo();
    const objects = allObjects(dir);
    const r = await repack({
      ...(await backend(dir)),
      writeMidx: true,
      writeBitmaps: true,
      compatibility,
    });
    expect(r?.midx).toBeDefined();
    expect(packNames(dir, ".bitmap").filter((f) => f.startsWith("pack-"))).toEqual([]);
    expect(bitmapOf(dir)).toBe(`multi-pack-index-${r?.midx}.bitmap`);
    expectNativeReadsAll(dir, objects);
    const test = gitRun(dir, ["rev-list", "--test-bitmap", "HEAD"]);
    expect(test.status).toBe(0);
    expect(
      gitRun(dir, ["rev-list", "--count", "--objects", "--all", "--use-bitmap-index"]).out.trim(),
    ).toBe(String(objects.length));
  });
});

describe("midx bitmaps read and served", () => {
  it("our pack set prefers native's midx bitmap and serves the packs native lists", async () => {
    const dir = packedRepo(4);
    git(dir, ["tag", "-a", "-m", "t", "v1", "HEAD~2"], { GIT_COMMITTER_DATE: "1700000300 +0000" });
    git(dir, ["repack", "-adbq"]); // a pack bitmap, which the midx bitmap must win over
    addCommit(dir, 5);
    git(dir, ["multi-pack-index", "write", "--bitmap"]);
    const b = await backend(dir);
    const midx = await b.packs.multiPackIndex?.();
    const index = await b.packs.bitmap?.();
    expect(index?.pack.packId).toBe(midx?.checksum);
    expect(b.packs.bitmapErrors).toEqual([]);
    const serialization = new DefaultSerializationApi({ history: b.history, packs: b.packs });
    const head = git(dir, ["rev-parse", "HEAD"]).trim();
    const old = git(dir, ["rev-parse", "HEAD~3"]).trim();
    const served = async (useBitmaps: boolean, haves: string[]) => {
      const chunks: Uint8Array[] = [];
      for await (const c of serialization.exportPack([head], haves, { useBitmaps })) chunks.push(c);
      const out = mkdtempSync(join(tmpdir(), "midx-served-"));
      dirs.push(out);
      writeFileSync(join(out, "p.pack"), Buffer.concat(chunks));
      git(out, ["init", "-q", "--bare", "repo"]);
      git(join(out, "repo"), ["index-pack", "-o", join(out, "p.idx"), join(out, "p.pack")]);
      return execFileSync("git", ["show-index"], { input: readFileSync(join(out, "p.idx")) })
        .toString()
        .split("\n")
        .filter(Boolean)
        .map((l) => l.split(" ")[1] as string)
        .sort();
    };
    const native = (args: string[]) =>
      git(dir, ["rev-list", "--objects", ...args])
        .split("\n")
        .filter(Boolean)
        .map((l) => l.slice(0, 40))
        .sort();
    expect(await served(true, [])).toEqual(native([head]));
    expect(await served(true, [old])).toEqual(native([head, `^${old}`, "--use-bitmap-index"]));
  });

  it("a midx bitmap of another midx is refused (stale), with git's message", async () => {
    const dir = packedRepo(3);
    git(dir, ["multi-pack-index", "write", "--bitmap"]);
    const stale = midxFiles(dir).find((f) => f.endsWith(".bitmap")) as string;
    const staleBytes = readFileSync(join(packDir(dir), stale));
    addCommit(dir, 3);
    git(dir, ["multi-pack-index", "write", "--bitmap"]); // a new midx, its bitmap replaced
    const b0 = await backend(dir);
    const midx = await b0.packs.multiPackIndex?.();
    const name = `multi-pack-index-${midx?.checksum}.bitmap`;
    chmodSync(join(packDir(dir), name), 0o644);
    writeFileSync(join(packDir(dir), name), staleBytes);
    const b = await backend(dir);
    expect(await b.packs.bitmap?.()).toBeUndefined();
    expect(b.packs.bitmapErrors).toEqual(["error: checksum doesn't match in pack and bitmap"]);
  });
});

/** rewrites a midx's trailing checksum after a test changed its bytes */
function resumMidx(bytes: Buffer): Buffer {
  const out = Buffer.from(bytes);
  createHash("sha1")
    .update(out.subarray(0, out.length - 20))
    .digest()
    .copy(out, out.length - 20);
  return out;
}

/** the start of chunk `name` in a midx */
function midxChunk(bytes: Buffer, name: string): number {
  for (let k = 0; k < (bytes[6] as number); k++)
    if (bytes.toString("latin1", 12 + 12 * k, 16 + 12 * k) === name)
      return bytes.readUInt32BE(12 + 12 * k + 8);
  throw new Error(`no ${name} chunk`);
}

describe("midx hardening (review of P4.74)", () => {
  it("expire deletes nothing while a pack the midx selects objects from is gone (native would)", async () => {
    const dir = packedRepo(3);
    git(dir, ["repack", "-aq"]); // a 4th pack holding every object: the midx selects it
    git(dir, ["multi-pack-index", "write"]);
    const objects = allObjects(dir);
    const midx = (await (await backend(dir)).packs.multiPackIndex?.()) as {
      packNames: readonly string[];
      numObjects: number;
      packIntIdAt(pos: number): number;
    };
    const selected = midx.packIntIdAt(0);
    const winner = midx.packNames[selected] as string;
    const aside = mkdtempSync(join(tmpdir(), "midx-aside-"));
    dirs.push(aside);
    for (const ext of [".pack", ".idx", ".rev"]) {
      const name = winner.replace(/\.idx$/, ext);
      if (listPack(dir).includes(name)) renameSync(join(packDir(dir), name), join(aside, name));
    }
    const before = listPack(dir);

    const r = await multiPackIndexExpire({ files: files(dir), compatibility });

    expect(r.stderr).toEqual([`error: could not load pack ${selected}`]);
    expect(r.exitCode).toBe(compatibility === "2.43" ? 1 : 255);
    expect(listPack(dir)).toEqual(before); // the three old packs (the only copies) stay
    rmSync(midxPath(dir));
    expect(allObjects(dir)).toEqual(objects);
  });

  it("expire touches nothing outside the pack directory for a midx naming ../ paths", async () => {
    const dir = packedRepo(3);
    const victim = join(dir, "victim");
    mkdirSync(victim);
    writeFileSync(join(victim, "pack-v.pack"), "keep me");
    writeFileSync(join(victim, "pack-v.idx"), "keep me");
    // a midx of four packs, the last (selecting nothing) named ../../../victim/pack-v.idx
    const real = packNames(dir, ".idx");
    const sources = await Promise.all(
      real.map(async (name) => {
        const p = await openPack(
          files(dir),
          `.git/objects/pack/${name.replace(/\.idx$/, ".pack")}`,
          `.git/objects/pack/${name}`,
        );
        return { name, mtime: 1, count: p.count, idAt: p.idAt, offsetAt: p.offsetAt };
      }),
    );
    const evil = {
      name: "../../../victim/pack-v.idx",
      mtime: 0,
      count: 0,
      idAt: () => "",
      offsetAt: () => 0,
    };
    writeFileSync(midxPath(dir), encodeMultiPackIndex({ packs: [evil, ...sources] }).bytes);
    const r = await multiPackIndexExpire({ files: files(dir), compatibility });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toEqual([
      "error: multi-pack-index pack name '../../../victim/pack-v.idx' is not a pack index name; ignoring .git/objects/pack/multi-pack-index",
    ]);
    expect(readdirSync(victim).sort()).toEqual(["pack-v.idx", "pack-v.pack"]);
    expect(packNames(dir, ".pack").length).toBe(3);
  });

  it("a pack-int-id out of range: verify dies as native, fsck's exit code, the pack set ignores the midx", async () => {
    const dir = packedRepo(3);
    git(dir, ["multi-pack-index", "write"]);
    const reference = nativeContents(dir);
    const bytes = readFileSync(midxPath(dir));
    bytes.writeUInt32BE(7, midxChunk(bytes, "OOFF") + 8 * 2);
    chmodSync(midxPath(dir), 0o644);
    writeFileSync(midxPath(dir), resumMidx(bytes));

    const n = gitRun(dir, ["multi-pack-index", "verify"]);
    const o = await multiPackIndexVerify({ files: files(dir), compatibility });
    expect(n.err.trimEnd()).toBe("fatal: bad pack-int-id: 7 (3 total packs)");
    expect(o.stderr.join("\n")).toBe(n.err.trimEnd());
    expect(o.exitCode).toBe(128);
    expect(n.status).toBe(128);
    expect(gitRun(dir, ["fsck", "--no-progress"]).status).toBe(compatibility === "2.43" ? 32 : 1);

    const b = await expectOursReadsAll(dir, reference);
    expect(await b.packs.multiPackIndex?.()).toBeUndefined();
    expect(b.packs.midxErrors).toEqual(["fatal: bad pack-int-id: 7 (3 total packs)"]);
  });

  it("a crafted RIDX: the midx bitmap is refused and the walk answers", async () => {
    const dir = packedRepo(3);
    git(dir, ["multi-pack-index", "write", "--bitmap"]);
    const bytes = readFileSync(midxPath(dir));
    const ridx = midxChunk(bytes, "RIDX");
    bytes.writeUInt32BE(bytes.readUInt32BE(ridx), ridx + 4); // a duplicate position
    const crafted = resumMidx(bytes);
    // the bitmap is named after the midx checksum: keep it findable under the new one
    const oldBitmap = midxFiles(dir).find((f) => f.endsWith(".bitmap")) as string;
    const newSum = crafted.subarray(crafted.length - 20).toString("hex");
    chmodSync(midxPath(dir), 0o644);
    writeFileSync(midxPath(dir), crafted);
    renameSync(
      join(packDir(dir), oldBitmap),
      join(packDir(dir), `multi-pack-index-${newSum}.bitmap`),
    );
    const b = await backend(dir);
    expect(await b.packs.multiPackIndex?.()).toBeDefined();
    expect(await b.packs.bitmap?.()).toBeUndefined();
    expect(b.packs.bitmapErrors).toEqual([
      "error: multi-pack-index reverse index (RIDX) is corrupt; ignoring its bitmap",
    ]);
    for (const id of allObjects(dir)) expect(await b.packs.has(id)).toBe(true);
  });

  it.runIf(is25x)(
    "midx.version=2: native's bytes; 1 rewrites it; others are git's errors",
    async () => {
      const dir = packedRepo(3);
      for (const args of [[], ["--bitmap"]]) {
        git(dir, ["config", "midx.version", "2"]);
        const native = nativeMidx(dir, args);
        expect(native[4]).toBe(2);
        const r = await multiPackIndexWrite({
          files: files(dir),
          compatibility,
          bitmap: args.length > 0,
        });
        expect(r.stderr).toEqual([]);
        expect(Buffer.from(readFileSync(midxPath(dir))).equals(native)).toBe(true);
        // the same version: up to date; version 1 asked: rewritten
        expect(
          (await multiPackIndexWrite({ files: files(dir), compatibility, bitmap: args.length > 0 }))
            .written,
        ).toBeUndefined();
        git(dir, ["config", "midx.version", "1"]);
        const again = await multiPackIndexWrite({
          files: files(dir),
          compatibility,
          bitmap: args.length > 0,
        });
        expect(again.written).toBeDefined();
        expect(readFileSync(midxPath(dir))[4]).toBe(1);
        for (const f of midxFiles(dir)) rmSync(join(packDir(dir), f), { force: true });
      }
      for (const value of ["3", "abc"]) {
        git(dir, ["config", "midx.version", value]);
        const n = gitRun(dir, ["multi-pack-index", "write"]);
        const o = await multiPackIndexWrite({ files: files(dir), compatibility });
        expect(o.stderr.join("\n")).toBe(n.err.trimEnd());
        expect(o.exitCode).toBe(n.status);
      }
    },
  );

  it.runIf(!is25x)(
    "2.43 ignores midx.version (version 1) and dies on a version 2 file",
    async () => {
      const dir = packedRepo(3);
      git(dir, ["config", "midx.version", "2"]);
      const native = nativeMidx(dir);
      expect(native[4]).toBe(1);
      const r = await multiPackIndexWrite({ files: files(dir), compatibility });
      expect(r.stderr).toEqual([]);
      expect(Buffer.from(readFileSync(midxPath(dir))).equals(native)).toBe(true);
      const v2 = Buffer.from(native);
      v2[4] = 2;
      chmodSync(midxPath(dir), 0o644);
      writeFileSync(midxPath(dir), resumMidx(v2));
      const n = gitRun(dir, ["multi-pack-index", "verify"]);
      const o = await multiPackIndexVerify({ files: files(dir), compatibility });
      expect(o.stderr.join("\n")).toBe(n.err.trimEnd());
      expect(o.exitCode).toBe(n.status);
    },
  );
});
