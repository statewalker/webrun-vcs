/**
 * `git multi-pack-index` over a files repository: `write` (with `--preferred-pack`,
 * `--stdin-packs`, `--bitmap` and 2.5x's `--incremental`), `verify`, `expire` and `repack
 * --batch-size`, as builtin/multi-pack-index.c and midx-write.c run them, with git's messages
 * and exit codes (2.43 exits 1 where 2.5x returns -1, exit 255).
 *
 * ```typescript
 * const result = await multiPackIndexWrite({ files, preferredPack: "pack-1234.pack" });
 * process.stderr.write(result.stderr.map((l) => `${l}\n`).join(""));
 * process.exitCode = result.exitCode;
 * ```
 *
 * The bytes are git's (`encodeMultiPackIndex`): the packs are discovered in the directory's
 * readdir order (`listKinds(..., { readdirOrder: true })` where the FilesApi has it), a valid
 * existing midx is reused as git reuses it (its packs first, its entries as packs of mtime 0),
 * and files go through `multi-pack-index.lock`, renamed over the target, then git's
 * `clear_midx_files` removes what the new midx no longer uses. `midx.version` (2.5x) picks the
 * version byte as `write_midx_internal` reads it; 2.43 ignores the key and writes version 1.
 *
 * A SHA-256 repository's midx (hash version 2, 32-byte ids and trailer) is read and written in
 * its format (`readRepositoryFormat` of `gitDir`), its chain lines 64 hex digits long.
 *
 * Where we are deliberately safer than git:
 * - `expire` checks, before its first unlink, that the midx's checksum holds and that every pack
 *   the midx selects objects from opens. git unlinks the packs selecting nothing first and only
 *   then finds (in its rewrite) that a pack holding their objects is gone, so a midx left naming a
 *   deleted pack made it delete the only remaining copies. We refuse instead (`error: could not
 *   load pack N`, nothing deleted), also under 2.43 compatibility, where git says nothing.
 * - a write reusing a midx whose pack is gone fails with 2.5x's `error: could not load pack N` under
 *   2.43 compatibility too: 2.43 exits 0 and leaves the midx naming the missing pack.
 */
import {
  BitmapClosureError,
  badPackIntId,
  clearIncrementalMultiPackIndex,
  encodeMultiPackIndex,
  type FilesApi,
  joinPath,
  type ListedObject,
  listObjects,
  loadMultiPackIndex,
  MIDX_CHAIN_DIR,
  MIDX_CHAIN_FILE,
  MIDX_FILE,
  type MidxPackSource,
  type MultiPackIndex,
  MultiPackIndexError,
  multiPackIndexBitmapPack,
  type ObjectId,
  objectsWithoutLazyFetch,
  openPack,
  type PackFile,
  parseMultiPackIndex,
  writePack,
  writePackBitmap,
} from "@statewalker/vcs-core";
import { atomicFilesOver } from "@statewalker/vcs-utils/files";
import { type ObjectFormat, SHA1_OBJECT_FORMAT } from "@statewalker/vcs-utils/hash";
import type { GitHostEnvironment } from "@statewalker/vcs-working-tree";
import { createGitFilesBackend } from "./create-git-files-backend.js";
import { type BitmapSettings, isPreferredBitmapTip, readBitmapSettings } from "./repack.js";
import { readRepositoryFormat } from "./repository-format.js";
import {
  configFilesApiOf,
  createWorkingCopyConfig,
} from "./workspace/working-copy/working-copy-config.files.js";

/** What a `git multi-pack-index` subcommand printed and its exit status. */
export interface MultiPackIndexCommandResult {
  exitCode: number;
  stdout: string;
  /** git's stderr lines (`error:`, `warning:`, `fatal:` prefixed, or verify's bare lines) */
  stderr: string[];
  /** the checksum of the midx written (none when nothing was written) */
  written?: string;
}

export interface MultiPackIndexOptions {
  files: FilesApi;
  /** the git directory (default `.git`); the midx lives in `<gitDir>/objects/pack` */
  gitDir?: string;
  /** `--object-dir`: another objects directory (an alternate's), instead of the git dir's */
  objectsDir?: string;
  /** whose behaviour to follow where versions differ (default 2.56) */
  compatibility?: "2.43" | "2.56";
  /**
   * The user's environment: `midx.version` and the bitmap settings come from git's whole
   * sequence (system, global, the repository's, `config.worktree`, the command line, so
   * `git -c midx.version=2 multi-pack-index write`); absent, the repository's file alone
   */
  environment?: GitHostEnvironment;
}

export interface MultiPackIndexWriteOptions extends MultiPackIndexOptions {
  /** `--preferred-pack=<pack>` (`pack-x.pack` or `pack-x.idx`) */
  preferredPack?: string;
  /** `--bitmap`: the midx gets `RIDX` (and `BTMP` in 2.44+); see `writeBitmap` */
  bitmap?: boolean;
  /** `--stdin-packs`: only these `.idx` names */
  stdinPacks?: readonly string[];
  /** `--incremental` (2.5x): a new layer of the chain in `multi-pack-index.d/` */
  incremental?: boolean;
  /**
   * Writes the midx bitmap of the new midx (before the midx itself is put in place); default
   * `multi-pack-index-<checksum>.bitmap` as git's write_midx_bitmap writes it.
   */
  writeBitmap?: (midx: MultiPackIndex) => Promise<void>;
  /** @internal `pack.preferBitmapTips` and the bitmap settings, read from the config otherwise */
  bitmapSettings?: Partial<BitmapSettings>;
  /** @internal packs to drop (`expire`), `.idx` names */
  packsToDrop?: readonly string[];
}

interface Ctx {
  files: FilesApi;
  gitDir: string;
  packDir: string;
  compatibility: "2.43" | "2.56";
  stderr: string[];
  environment?: GitHostEnvironment;
  /** the repository's object format (`extensions.objectFormat`) */
  objectFormat: ObjectFormat;
}

const failure = (c: Ctx) => (c.compatibility === "2.43" ? 1 : 255);

/**
 * The command's context: the pack directory and the repository's object format (the midx's
 * hash version and id width, as git's `the_hash_algo`; SHA-1 when the format cannot be read).
 */
async function ctxOf(options: MultiPackIndexOptions): Promise<Ctx> {
  const gitDir = options.gitDir ?? ".git";
  const format = await readRepositoryFormat(options.files, gitDir).catch(() => undefined);
  return {
    objectFormat: format?.objectFormat ?? SHA1_OBJECT_FORMAT,
    files: options.files,
    gitDir,
    // as git names it in messages (`.git/objects/pack`), not normalized
    packDir: `${(options.objectsDir ?? `${gitDir}/objects`).replace(/\/+$/, "")}/pack`,
    compatibility: options.compatibility ?? "2.56",
    stderr: [],
    ...(options.environment ? { environment: options.environment } : {}),
  };
}

/** The pack directory's file names in readdir order (sorted where the FilesApi cannot tell). */
async function listPackDir(files: FilesApi, dir: string): Promise<string[]> {
  const posix = files as FilesApi & {
    listKinds?(path: string, o?: { readdirOrder?: boolean }): Promise<{ name: string }[]>;
  };
  if (posix.listKinds) {
    try {
      return (await posix.listKinds(dir, { readdirOrder: true })).map((e) => e.name);
    } catch {
      return [];
    }
  }
  const names: string[] = [];
  try {
    for await (const e of files.list(dir)) names.push(e.name);
  } catch {
    return [];
  }
  return names;
}

interface PackInfo {
  name: string;
  pack: PackFile;
  mtime: number;
  size: number;
  keep: boolean;
  cruft: boolean;
}

async function openPackInfo(c: Ctx, idxName: string): Promise<PackInfo | string> {
  const base = idxName.slice(0, -4);
  const packPath = `${c.packDir}/${`${base}.pack`}`;
  const idxPath = `${c.packDir}/${idxName}`;
  // a name the FilesApi refuses (outside its root, say) reads as a pack that is not there
  const st = await c.files.stats(packPath).catch(() => undefined);
  if (st?.kind !== "file") return `warning: failed to add packfile '${idxPath}'`;
  let pack: PackFile;
  try {
    pack = await openPack(c.files, packPath, idxPath, { objectFormat: c.objectFormat });
  } catch {
    return `warning: failed to open pack-index '${idxPath}'`;
  }
  const isFile = async (path: string) =>
    (await c.files.stats(path).catch(() => undefined))?.kind === "file";
  return {
    name: idxName,
    pack,
    mtime: Math.floor((st.lastModified ?? 0) / 1000),
    size: st.size ?? 0,
    keep: await isFile(`${c.packDir}/${`${base}.keep`}`),
    cruft: await isFile(`${c.packDir}/${`${base}.mtimes`}`),
  };
}

/** A pack `expire` deleted, kept in the list by name only (it selects no object). */
const droppedPack = (name: string): PackInfo => ({
  name,
  pack: { count: 0 } as PackFile,
  mtime: 0,
  size: 0,
  keep: false,
  cruft: false,
});

const sourceOf = (p: PackInfo): MidxPackSource => ({
  name: p.name,
  mtime: p.mtime,
  count: p.pack.count,
  idAt: (i) => p.pack.idAt(i),
  offsetAt: (i) => p.pack.offsetAt(i),
});

const stripExt = (name: string, ext: string) =>
  name.endsWith(ext) ? name.slice(0, -ext.length) : name;

/** git's midx_needs_update (2.5x): the midx's packs are exactly `packs`, checksum valid. */
function midxNeedsUpdate(
  midx: MultiPackIndex,
  packs: readonly PackInfo[],
  version: number,
): boolean {
  if (!midx.checksumValid()) return true;
  if (midx.version !== version) return true;
  if (packs.length !== midx.numPacks + midx.numPacksInBase) return true;
  const names = new Set(packs.map((p) => stripExt(p.name, ".idx")));
  for (let m: MultiPackIndex | undefined = midx; m; m = m.base) {
    for (const n of m.packNames) {
      const key = stripExt(n, ".idx");
      if (!names.has(key)) return true;
      names.delete(key);
    }
  }
  return false;
}

async function writeLocked(c: Ctx, target: string, bytes: Uint8Array): Promise<void> {
  const atomic = atomicFilesOver(c.files, c.packDir);
  const lock = `${target}.lock`;
  if (!(await atomic.createExclusive(lock, new Uint8Array(0))))
    throw new MultiPackIndexError(
      `Unable to create '${`${c.packDir}/${lock}`}': File exists.\n\nAnother git process seems to be running in this repository, e.g.\nan editor opened by 'git commit'. Please make sure all processes\nare terminated then try again. If it still fails, a git process\nmay have crashed in this repository earlier:\nremove the file manually to continue.`,
      true,
    );
  try {
    await atomic.write(lock, bytes);
    await atomic.replace(lock, target);
  } catch (e) {
    await atomic.remove(lock);
    throw e;
  }
}

/** git's clear_midx_files after a write: keep only `hashes` (and the incremental mode's file). */
async function clearMidxFilesAfterWrite(
  c: Ctx,
  hashes: readonly string[],
  incremental: boolean,
): Promise<void> {
  await clearIncrementalMultiPackIndex(c.files, c.packDir, hashes);
  const keep = new Set<string>();
  for (const ext of ["bitmap", "rev", "midx"])
    for (const h of hashes) keep.add(`multi-pack-index-${h}.${ext}`);
  for (const name of await listPackDir(c.files, c.packDir)) {
    if (!name.startsWith("multi-pack-index-")) continue;
    if (!/\.(bitmap|rev|midx)$/.test(name) || keep.has(name)) continue;
    await c.files.remove(`${c.packDir}/${name}`);
  }
  const other = incremental
    ? `${c.packDir}/${MIDX_FILE}`
    : `${c.packDir}/${MIDX_CHAIN_DIR}/${MIDX_CHAIN_FILE}`;
  if (await c.files.stats(other)) await c.files.remove(other);
}

async function readAll(files: FilesApi, path: string): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let n = 0;
  for await (const chunk of files.read(path)) {
    parts.push(chunk);
    n += chunk.length;
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** `git multi-pack-index write`: midx-write.c's write_midx_internal. */
export async function multiPackIndexWrite(
  options: MultiPackIndexWriteOptions,
): Promise<MultiPackIndexCommandResult> {
  const c = await ctxOf(options);
  try {
    return await writeInternal(c, options);
  } catch (e) {
    if (e instanceof MultiPackIndexError && e.fatal) {
      c.stderr.push(...e.lines);
      return { exitCode: 128, stdout: "", stderr: c.stderr };
    }
    throw e;
  }
}

async function writeInternal(
  c: Ctx,
  options: MultiPackIndexWriteOptions,
): Promise<MultiPackIndexCommandResult> {
  const incremental = options.incremental ?? false;
  if (incremental && c.compatibility === "2.43")
    throw new Error("multi-pack-index write --incremental needs git 2.47 or later");
  const toInclude = options.stdinPacks ? new Set(options.stdinPacks) : undefined;
  const drop = options.packsToDrop;
  const wantRev = options.bitmap ?? false;
  const done = (exitCode: number, written?: string): MultiPackIndexCommandResult => ({
    exitCode,
    stdout: "",
    stderr: c.stderr,
    ...(written ? { written } : {}),
  });

  // midx.version (2.5x's write_midx_internal: repo_config_get_int, then 1 or 2 only)
  const version = c.compatibility === "2.43" ? 1 : await readMidxVersion(c);
  if (typeof version === "string") {
    c.stderr.push(version);
    return done(128);
  }
  const loaded = await loadMultiPackIndex(c.files, c.packDir, c);
  c.stderr.push(...loaded.errors);
  if (loaded.fatal) return done(128);
  let reuse: MultiPackIndex | undefined;
  let base: MultiPackIndex | undefined;
  if (!toInclude || incremental) {
    let m = loaded.midx;
    if (m && !m.checksumValid()) {
      c.stderr.push("warning: ignoring existing multi-pack-index; checksum mismatch");
      m = undefined;
    }
    if (m) {
      if (incremental) base = m;
      if (!toInclude) reuse = m;
    }
  }
  if (incremental) reuse = undefined;

  const packs: PackInfo[] = [];
  if (reuse) {
    // fill_packs_from_midx: tip layer first
    for (let m: MultiPackIndex | undefined = reuse; m; m = m.base) {
      for (let i = 0; i < m.numPacks; i++) {
        const id = m.numPacksInBase + i;
        const name = m.packNames[i] as string;
        // a pack `expire` just deleted: git still holds it open; none of its objects is used
        if (drop?.includes(name)) {
          packs.push(droppedPack(name));
          continue;
        }
        const info = await openPackInfo(c, name);
        if (typeof info === "string") {
          c.stderr.push(`error: could not load pack ${id}`);
          return done(failure(c));
        }
        packs.push(info);
      }
    }
  }
  for (const name of await listPackDir(c.files, c.packDir)) {
    if (!name.endsWith(".idx")) continue;
    if (reuse?.containsPack(name) || base?.containsPack(name)) continue;
    if (toInclude && !toInclude.has(name)) continue;
    const info = await openPackInfo(c, name);
    if (typeof info === "string") {
      c.stderr.push(info);
      continue;
    }
    packs.push(info);
  }

  if (!drop) {
    const midx = reuse ?? loaded.midx;
    // both versions leave an up-to-date midx alone (2.43 and 2.5x alike)
    const upToDate = midx && !incremental && !midxNeedsUpdate(midx, packs, version);
    if (midx && upToDate) {
      const bitmapPath = `${c.packDir}/${`multi-pack-index-${midx.checksum}.bitmap`}`;
      const bitmapExists = (await c.files.stats(bitmapPath))?.kind === "file";
      if (bitmapExists || !wantRev) {
        if (!wantRev) {
          for (const name of await listPackDir(c.files, c.packDir))
            if (name.startsWith("multi-pack-index-") && name.endsWith(".bitmap"))
              await c.files.remove(`${c.packDir}/${name}`);
        }
        return done(0);
      }
    }
  }
  if (incremental && packs.length === 0) return done(0);

  let preferred: number | undefined;
  if (options.preferredPack !== undefined) {
    const want = options.preferredPack;
    const k = packs.findIndex((p) => cmpName(want, p.name) === 0);
    if (k < 0) c.stderr.push(`warning: unknown preferred pack: '${want}'`);
    else preferred = k;
  } else if (packs.length > 0 && wantRev) {
    let oldest = 0;
    for (let i = 1; i < packs.length; i++) {
      const o = packs[oldest] as PackInfo;
      if (!o.pack.count || (packs[i] as PackInfo).mtime < o.mtime) oldest = i;
    }
    preferred = (packs[oldest] as PackInfo).pack.count ? oldest : undefined;
  }
  if (preferred !== undefined && !(packs[preferred] as PackInfo).pack.count) {
    c.stderr.push(
      `error: cannot select preferred pack ${c.packDir}/${stripExt((packs[preferred] as PackInfo).name, ".idx")}.pack with no objects`,
    );
    return done(failure(c));
  }

  let dropped: Set<number> | undefined;
  if (drop && drop.length > 0) {
    dropped = new Set();
    const sortedPacks = packs
      .map((p, k) => ({ name: p.name, k }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const want = [...drop].sort();
    let di = 0;
    let missing = 0;
    for (let i = 0; i < sortedPacks.length && di < want.length; i++) {
      const s = sortedPacks[i] as { name: string; k: number };
      const w = want[di] as string;
      if (s.name === w) {
        dropped.add(s.k);
        di++;
      } else if (s.name > w) {
        c.stderr.push(`error: did not see pack-file ${w} to drop`);
        di++;
        missing++;
        i--;
      }
    }
    if (missing) return done(failure(c));
  }

  // incremental: objects already in the base layers are left out
  let sources = packs.map(sourceOf);
  if (incremental && base) {
    const b = base;
    sources = sources.map((s) => {
      const keep: number[] = [];
      for (let i = 0; i < s.count; i++) if (b.find(s.idAt(i)) < 0) keep.push(i);
      return {
        ...s,
        count: keep.length,
        idAt: (i) => s.idAt(keep[i] as number),
        offsetAt: (i) => s.offsetAt(keep[i] as number),
      };
    });
  }
  let encoded: ReturnType<typeof encodeMultiPackIndex>;
  const totalObjects = sources.reduce((s, p) => s + p.count, 0);
  let wantRevIndex = wantRev;
  if (wantRev && totalObjects === 0 && !reuse) {
    c.stderr.push("warning: refusing to write multi-pack .bitmap without any objects");
    wantRevIndex = false;
  }
  try {
    encoded = encodeMultiPackIndex({
      packs: sources,
      ...(reuse ? { existing: reuse } : {}),
      ...(preferred !== undefined ? { preferred } : {}),
      revIndex: wantRevIndex,
      bitmappedPacks: c.compatibility === "2.56",
      version,
      ...(dropped ? { dropped } : {}),
      ...(incremental && base ? { baseObjects: base.numObjects + base.numObjectsInBase } : {}),
      objectFormat: c.objectFormat,
    });
  } catch (e) {
    if (e instanceof MultiPackIndexError) {
      c.stderr.push(...e.lines);
      return done(failure(c));
    }
    throw e;
  }

  // the bitmap first (git commits the midx's lock only once its bitmap is written)
  if (wantRevIndex && !incremental) {
    const midx = parseMultiPackIndex(encoded.bytes, `${c.packDir}/${MIDX_FILE}`, undefined, {
      objectFormat: c.objectFormat,
    });
    try {
      const write = options.writeBitmap ?? ((m) => writeMidxBitmap(c, m, options.bitmapSettings));
      await write(midx);
    } catch (e) {
      if (!(e instanceof BitmapClosureError)) throw e;
      c.stderr.push(`warning: ${e.message}`, "error: could not write multi-pack bitmap");
      return done(failure(c));
    }
  }
  let hashes: string[];
  if (incremental) {
    const dir = `${c.packDir}/${MIDX_CHAIN_DIR}`;
    const layers: MultiPackIndex[] = [];
    for (let m = base; m; m = m.base) layers.unshift(m);
    // link_midx_to_chain: a plain midx becomes the chain's first layer
    if (base && layers.length === 1 && (await c.files.stats(`${c.packDir}/${MIDX_FILE}`))) {
      for (const [from, to] of [
        [MIDX_FILE, `multi-pack-index-${base.checksum}.midx`],
        [`multi-pack-index-${base.checksum}.bitmap`, `multi-pack-index-${base.checksum}.bitmap`],
        [`multi-pack-index-${base.checksum}.rev`, `multi-pack-index-${base.checksum}.rev`],
      ] as const) {
        const src = `${c.packDir}/${from}`;
        if ((await c.files.stats(src))?.kind === "file")
          await c.files.write(joinPath(dir, to), [await readAll(c.files, src)]);
      }
    }
    // git's mks_tempfile in the chain directory, renamed to the layer's name
    const tmp = joinPath(dir, `tmp_midx_${Math.random().toString(36).slice(2, 8)}`);
    await c.files.write(tmp, [encoded.bytes]);
    if (!(await c.files.move(tmp, joinPath(dir, `multi-pack-index-${encoded.checksum}.midx`)))) {
      await c.files.remove(tmp).catch(() => false);
      c.stderr.push("error: unable to rename new multi-pack-index layer");
      return done(failure(c));
    }
    hashes = [...layers.map((m) => m.checksum), encoded.checksum];
    await writeLocked(
      c,
      joinPath(MIDX_CHAIN_DIR, MIDX_CHAIN_FILE),
      new TextEncoder().encode(hashes.map((h) => `${h}\n`).join("")),
    );
  } else {
    await writeLocked(c, MIDX_FILE, encoded.bytes);
    hashes = [encoded.checksum];
  }
  await clearMidxFilesAfterWrite(c, hashes, incremental);
  return done(0, encoded.checksum);
}

/**
 * `midx.version` as git reads it (`repo_config_get_int`: the last value, with k/m/g units): 1 or
 * 2, else git's fatal line.
 */
async function readMidxVersion(c: Ctx): Promise<number | string> {
  const config = await createWorkingCopyConfig(configFilesApiOf(c.files), c.gitDir, undefined, {
    ...(c.environment ? { environment: c.environment } : {}),
  });
  const last = config.getAllWithOrigin("midx.version").at(-1);
  if (!last) return 1;
  const value = last.text ?? String(last.value);
  const m = /^\s*([-+]?\d+)([kmg]?)\s*$/i.exec(value);
  // git names the file of a value read from one (die_bad_number)
  const where = last.file ? ` in file ${last.file}` : "";
  if (!m)
    return `fatal: bad numeric config value '${value}' for 'midx.version'${where}: invalid unit`;
  const unit = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[
    (m[2] as string).toLowerCase() as "" | "k" | "m" | "g"
  ];
  const n = Number(m[1]) * unit;
  if (n !== 1 && n !== 2) return `fatal: unknown MIDX version: ${n}`;
  return n;
}

/**
 * git's write_midx_bitmap: the commits a revision walk from every ref (peeled, commits only,
 * `pack.preferBitmapTips` marking the preferred ones) lists, in walk order, those the midx
 * holds; bits in the midx's pseudo-pack order (`RIDX`); every name hash 0.
 */
async function writeMidxBitmap(
  c: Ctx,
  midx: MultiPackIndex,
  given?: Partial<BitmapSettings>,
): Promise<void> {
  const backend = await createGitFilesBackend({
    files: c.files,
    gitDir: c.gitDir,
    ...(c.environment ? { environment: c.environment } : {}),
  });
  const objects = objectsWithoutLazyFetch(backend.objects);
  const refs = backend.history.refs;
  const settings = {
    ...(await readBitmapSettings(c.files, c.gitDir, {
      ...(c.environment ? { environment: c.environment } : {}),
    })),
    ...given,
  };
  const wants: ObjectId[] = [];
  const preferred: ObjectId[] = [];
  for await (const ref of refs.list()) {
    if (!ref.name.startsWith("refs/")) continue;
    const resolved = await refs.resolve(ref.name).catch(() => undefined);
    const id = resolved?.peeledObjectId ?? resolved?.objectId;
    if (!id) continue;
    const o = await objects.get(id);
    if (!o) continue;
    if (!o.bytes) await o.content[Symbol.asyncIterator]().return?.();
    if (o.type !== "commit") continue;
    wants.push(id);
    if (isPreferredBitmapTip(ref.name, settings.preferredTips, c.compatibility)) preferred.push(id);
  }
  const listed: ListedObject[] = [];
  for await (const o of listObjects(objects, { wants })) {
    if (o.type !== "commit") break; // commits come first
    if (midx.find(o.id) >= 0) listed.push({ id: o.id, type: "commit", nameHash: 0 });
  }
  const bytes = await writePackBitmap({
    pack: multiPackIndexBitmapPack(midx),
    objects,
    listed,
    hashCache: settings.hashCache,
    lookupTable: settings.lookupTable,
    preferredTips: preferred,
    compatibility: c.compatibility,
    nameTags: false,
  });
  const target = `${c.packDir}/multi-pack-index-${midx.checksum}.bitmap`;
  const tmp = `${c.packDir}/tmp_bitmap_${Math.random().toString(36).slice(2, 8)}`;
  await c.files.write(tmp, [bytes]);
  if (!(await c.files.move(tmp, target))) {
    await c.files.remove(tmp).catch(() => false);
    throw new Error(`unable to rename temporary bitmap file to '${target}'`);
  }
}

function cmpName(idxOrPackName: string, idxName: string): number {
  const a = stripExt(stripExt(idxOrPackName, ".idx"), ".pack");
  const b = stripExt(idxName, ".idx");
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `git multi-pack-index verify`: midx.c's verify_midx_file (exit 1 on any report). */
export async function multiPackIndexVerify(
  options: MultiPackIndexOptions,
): Promise<MultiPackIndexCommandResult> {
  const c = await ctxOf(options);
  const loaded = await loadMultiPackIndex(c.files, c.packDir, c);
  c.stderr.push(...loaded.errors);
  if (loaded.fatal) return { exitCode: 128, stdout: "", stderr: c.stderr };
  const m = loaded.midx;
  if (!m) {
    if (loaded.fileExists) {
      c.stderr.push("error: multi-pack-index file exists, but failed to parse");
      return { exitCode: 1, stdout: "", stderr: c.stderr };
    }
    return { exitCode: 0, stdout: "", stderr: c.stderr };
  }
  const lines = verifyMidxLines(m, await openMidxPacks(c, m), c.compatibility);
  c.stderr.push(...lines);
  // a pack-int-id out of range: git dies there (`fatal: bad pack-int-id`)
  const died = lines.at(-1)?.startsWith("fatal: ") ?? false;
  return { exitCode: died ? 128 : lines.length ? 1 : 0, stdout: "", stderr: c.stderr };
}

/**
 * The packs of a midx by pack-int-id: undefined where the `.pack` is missing (git's
 * prepare_midx_pack fails), `indexUnavailable` where the pack is there but its idx cannot be
 * opened (git loads the pack, then fails each lookup in it).
 */
async function openMidxPacks(
  c: Ctx,
  m: MultiPackIndex,
): Promise<(PackInfo | { indexUnavailable: string } | undefined)[]> {
  const out: (PackInfo | { indexUnavailable: string } | undefined)[] = [];
  for (let id = 0; id < m.numPacks + m.numPacksInBase; id++) {
    const name = m.packNameAt(id);
    const info = await openPackInfo(c, name);
    if (typeof info !== "string") out.push(info);
    else if (info.startsWith("warning: failed to open pack-index"))
      out.push({ indexUnavailable: `${c.packDir}/${stripExt(name, ".idx")}.pack` });
    else out.push(undefined);
  }
  return out;
}

/**
 * verify_midx_file's reports, in its order. A pack-int-id out of range ends the list with git's
 * `fatal: bad pack-int-id: N (M total packs)`, where git dies (`midx_for_pack`).
 */
export function verifyMidxLines(
  m: MultiPackIndex,
  packs: readonly ({ pack: PackFile } | { indexUnavailable: string } | undefined)[],
  compatibility: "2.43" | "2.56" = "2.56",
): string[] {
  const out: string[] = [];
  if (!m.checksumValid()) out.push("incorrect checksum");
  const total = m.numPacks + m.numPacksInBase;
  for (let i = 0; i < total; i++) if (!packs[i]) out.push(`failed to load pack in position ${i}`);
  // 2.43 checks the fan-out here (2.5x refuses such a file on load)
  if (compatibility === "2.43") {
    for (let i = 0; i < 255; i++) {
      const a = m.fanout(i);
      const b = m.fanout(i + 1);
      if (a > b)
        out.push(
          `oid fanout out of order: fanout[${i}] = ${a.toString(16)} > ${b.toString(16)} = fanout[${i + 1}]`,
        );
    }
  }
  if (m.numObjects === 0) {
    out.push("the midx contains no oid");
    return out;
  }
  for (let layer: MultiPackIndex | undefined = m; layer; layer = layer.base) {
    for (let i = 0; i < m.numObjects - 1; i++) {
      const a = m.idAt(m.numObjectsInBase + i);
      const b = m.idAt(m.numObjectsInBase + i + 1);
      if (a >= b) out.push(`oid lookup out of order: oid[${i}] = ${a} >= ${b} = oid[${i + 1}]`);
    }
  }
  const all = m.numObjects + m.numObjectsInBase;
  const totalPacks = (pos: number) => {
    let l: MultiPackIndex = m;
    while (l.base && pos < l.numObjectsInBase) l = l.base;
    return l.numPacks + l.numPacksInBase;
  };
  const pairs: { pos: number; pack: number }[] = [];
  for (let i = 0; i < all; i++) pairs.push({ pos: i, pack: m.packIntIdAt(i) });
  // glibc's qsort is a stable merge sort here: positions stay in order within a pack
  const head = pairs.slice(0, m.numObjects).sort((a, b) => a.pack - b.pack);
  const sorted = head.concat(pairs.slice(m.numObjects));
  for (const { pos, pack } of sorted) {
    const id = m.idAt(pos);
    if (pack >= totalPacks(pos)) {
      out.push(`fatal: bad pack-int-id: ${pack} (${totalPacks(pos)} total packs)`);
      return out;
    }
    const info = packs[pack];
    if (!info || "indexUnavailable" in info) {
      if (info) out.push(`error: packfile ${info.indexUnavailable} index unavailable`);
      out.push(`failed to load pack entry for oid[${pos}] = ${id}`);
      continue;
    }
    const mOffset = m.offsetAt(pos);
    const at = info.pack.indexOf(id);
    const pOffset = at < 0 ? 0 : info.pack.offsetAt(at);
    if (mOffset !== pOffset)
      out.push(
        `incorrect object offset for oid[${pos}] = ${id}: ${mOffset.toString(16)} != ${pOffset.toString(16)}`,
      );
  }
  return out;
}

/** `git multi-pack-index expire`: deletes the midx's packs it selects no object from. */
export async function multiPackIndexExpire(
  options: MultiPackIndexOptions,
): Promise<MultiPackIndexCommandResult> {
  const c = await ctxOf(options);
  const loaded = await loadMultiPackIndex(c.files, c.packDir, c);
  c.stderr.push(...loaded.errors);
  if (loaded.fatal) return { exitCode: 128, stdout: "", stderr: c.stderr };
  const m = loaded.midx;
  if (!m) return { exitCode: 0, stdout: "", stderr: c.stderr };
  if (m.base) {
    c.stderr.push("fatal: cannot expire packs from an incremental multi-pack-index");
    return { exitCode: 128, stdout: "", stderr: c.stderr };
  }
  const bad = badPackIntId(m);
  if (bad) {
    c.stderr.push(`fatal: ${bad}`);
    return { exitCode: 128, stdout: "", stderr: c.stderr };
  }
  const count = new Uint32Array(m.numPacks);
  for (let i = 0; i < m.numObjects; i++) count[m.packIntIdAt(i)]++;
  // Everything is checked before the first unlink (git checks nothing here): the checksum, and
  // that every pack the midx still selects objects from opens. Otherwise the packs selecting
  // nothing may hold the only copies left (a midx naming a deleted pack), and git's later
  // rewrite fails only after it has unlinked them. The PNAM names were checked on load.
  if (!m.checksumValid()) {
    c.stderr.push("error: multi-pack-index checksum mismatch; not expiring any pack");
    return { exitCode: failure(c), stdout: "", stderr: c.stderr };
  }
  const toDrop: string[] = [];
  for (let i = 0; i < m.numPacks; i++) {
    const info = await openPackInfo(c, m.packNames[i] as string);
    if (typeof info !== "string") info.pack.close();
    if (count[i]) {
      if (typeof info === "string") {
        c.stderr.push(`error: could not load pack ${i}`);
        return { exitCode: failure(c), stdout: "", stderr: c.stderr };
      }
      continue;
    }
    if (typeof info === "string" || info.keep || info.cruft) continue;
    toDrop.push(m.packNames[i] as string);
  }
  for (const name of toDrop) await unlinkPack(c, stripExt(name, ".idx"));
  if (toDrop.length === 0) return { exitCode: 0, stdout: "", stderr: c.stderr };
  const result = await writeInternal(c, { ...options, packsToDrop: toDrop });
  return result;
}

/** git's unlink_pack_path(force_delete = 0): every file of the pack but a `.keep`. */
async function unlinkPack(c: Ctx, base: string): Promise<void> {
  for (const ext of [".pack", ".rev", ".mtimes", ".bitmap", ".promisor", ".idx"]) {
    const path = `${c.packDir}/${`${base}${ext}`}`;
    if (await c.files.stats(path)) await c.files.remove(path);
  }
}

export interface MultiPackIndexRepackOptions extends MultiPackIndexOptions {
  /** `--batch-size` in bytes (0: every pack) */
  batchSize?: number;
  /** `repack.packKeptObjects` */
  packKeptObjects?: boolean;
}

/**
 * `git multi-pack-index repack`: the objects the midx selects from the chosen packs go into
 * one new pack (pack-objects reading their ids in midx order), then the midx is rewritten.
 */
export async function multiPackIndexRepack(
  options: MultiPackIndexRepackOptions,
): Promise<MultiPackIndexCommandResult> {
  const c = await ctxOf(options);
  const loaded = await loadMultiPackIndex(c.files, c.packDir, c);
  c.stderr.push(...loaded.errors);
  if (loaded.fatal) return { exitCode: 128, stdout: "", stderr: c.stderr };
  const m = loaded.midx;
  if (!m) return { exitCode: 0, stdout: "", stderr: c.stderr };
  if (m.base) {
    c.stderr.push("fatal: cannot repack an incremental multi-pack-index");
    return { exitCode: 128, stdout: "", stderr: c.stderr };
  }
  const bad = badPackIntId(m);
  if (bad) {
    c.stderr.push(`fatal: ${bad}`);
    return { exitCode: 128, stdout: "", stderr: c.stderr };
  }
  const infos = await openMidxPacks(c, m);
  const kept = options.packKeptObjects ?? false;
  const want = (i: number) => {
    const p = infos[i];
    if (!p || "indexUnavailable" in p) return false;
    if (!kept && p.keep) return false;
    if (p.cruft) return false;
    return p.pack.count > 0;
  };
  const mtimeOf = (p: PackInfo | { indexUnavailable: string } | undefined) =>
    p && "mtime" in p ? p.mtime : 0;
  const include = new Uint8Array(m.numPacks);
  const batch = options.batchSize ?? 0;
  if (batch) {
    const referenced = new Uint32Array(m.numPacks);
    for (let i = 0; i < m.numObjects; i++) referenced[m.packIntIdAt(i)]++;
    // QSORT by mtime: glibc's merge sort keeps equal mtimes in pack-int-id order
    const order = Array.from({ length: m.numPacks }, (_, i) => i).sort(
      (a, b) => mtimeOf(infos[a]) - mtimeOf(infos[b]),
    );
    let total = 0;
    for (let k = 0; total < batch && k < order.length; k++) {
      const id = order[k] as number;
      if (!want(id)) continue;
      const p = infos[id] as PackInfo;
      // shifted integer arithmetic as git's, to ~4 significant digits
      let expected = (BigInt(referenced[id] as number) << 14n) / BigInt(p.pack.count);
      expected *= BigInt(p.size);
      expected = (expected + (1n << 13n)) >> 14n;
      if (expected >= BigInt(batch)) continue;
      total += Number(expected);
      include[id] = 1;
    }
  } else {
    for (let i = 0; i < m.numPacks; i++) if (want(i)) include[i] = 1;
  }
  if (include.reduce((s, v) => s + v, 0) <= 1) return { exitCode: 0, stdout: "", stderr: c.stderr };

  const backend = await createGitFilesBackend({
    files: c.files,
    gitDir: c.gitDir,
    ...(c.environment ? { environment: c.environment } : {}),
  });
  const objects = objectsWithoutLazyFetch(backend.objects);
  const ids: ListedObject[] = [];
  for (let i = 0; i < m.numObjects; i++) {
    if (!include[m.packIntIdAt(i)]) continue;
    const id = m.idAt(i);
    const o = await objects.get(id);
    if (!o) continue;
    if (!o.bytes) await o.content[Symbol.asyncIterator]().return?.();
    ids.push({ id, type: o.type });
  }
  await backend.packs.install(writePack(objects, ids, { packs: backend.packs }));
  return writeInternal(c, options);
}
