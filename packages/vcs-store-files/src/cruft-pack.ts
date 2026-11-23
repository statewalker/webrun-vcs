/**
 * Cruft packs, as `git repack --cruft` writes them through `git pack-objects --cruft`: the
 * unreachable objects of the packs a repack replaces and the unreachable loose objects go
 * into a pack of their own with a `.mtimes` file, instead of being written loose
 * (`repack -A`). Each object keeps the newest time of its copies (a loose file's mtime, a
 * pack's mtime, or the time an older cruft pack's `.mtimes` gives it).
 *
 * With an expiration (`--cruft-expiration`, gc's `gc.pruneExpire`), only the objects newer
 * than it are kept, with what they reach that no kept pack holds (git's
 * `enumerate_and_traverse_cruft_objects`): an older object one of them reaches is kept with
 * the expiration as its time. The rest go with their packs (loose copies are then pruned by
 * gc). `--max-cruft-size` splits the cruft objects into packs of at most that size.
 */

import type {
  FilesApi,
  GitObjects,
  ListedObject,
  ObjectId,
  ObjectTypeString,
  Pack,
  PackSet,
  WritePackOptions,
} from "@statewalker/vcs-core";
import { decodeTreeBytes, joinPath, parsePackMtimes, writePack } from "@statewalker/vcs-core";
import type { FileRawStorage } from "./storage/raw/file-raw-storage.js";

/** A loose object file name. */
const OBJECT_ID = /^[0-9a-f]{40}$/;
/** git's smallest `--max-pack-size` (pack-objects: "minimum pack size limit is 1 MiB"). */
export const MIN_PACK_SIZE_LIMIT = 1024 * 1024;

/** What `writeCruftPacks` needs. @internal */
export interface CruftPackInput {
  files: FilesApi;
  gitDir: string;
  objects: GitObjects;
  packs: PackSet;
  looseStorage: FileRawStorage;
  /** The packs the repack removes, with their `.pack` mtimes (ms; unknown: treated as now) */
  discard: readonly { pack: Pack; modified?: number }[];
  /** Objects never written to the cruft pack (alternates' under `-l`, promisor objects) */
  skip?: (id: ObjectId) => Promise<boolean>;
  /** Objects older than this (seconds since the epoch) expire; undefined: none does */
  expiration?: number;
  /** Largest cruft pack (bytes); undefined: one pack */
  maxSize?: number;
  /** "now" in seconds, for a time the FilesApi does not give */
  now: number;
  /** How the packs are written (deltas, compression) */
  packOptions: WritePackOptions;
  /** `.rev` beside each cruft pack */
  writeReverseIndex: boolean;
}

/** What was written. */
export interface CruftPackResult {
  /** The cruft packs written (`pack-<id>`), in the order written */
  packNames: string[];
  /** Objects in them */
  objectCount: number;
}

/**
 * Writes the cruft pack(s) of a repack once its new packs are installed, before the
 * replaced packs are removed. Returns undefined when there is nothing to write (git's
 * `--non-empty`).
 * @internal
 */
export async function writeCruftPacks(o: CruftPackInput): Promise<CruftPackResult | undefined> {
  const { files, objects, packs } = o;
  const discardIds = new Set(o.discard.map((d) => d.pack.packId));
  // every pack that stays (the new ones, .keep packs, packs installed meanwhile): what they
  // hold is not cruft (git's fresh packs, and the unknown ones it keeps in core)
  const staying = (await packs.packs()).filter((p) => !discardIds.has(p.packId));
  const inStaying = (id: ObjectId) => staying.some((p) => p.has(id));

  /** candidate cruft objects and the newest time of their copies (seconds) */
  const times = new Map<ObjectId, number>();
  const note = (id: ObjectId, t: number) => {
    const prev = times.get(id);
    if (prev === undefined || t > prev) times.set(id, t);
  };
  /** each candidate's size as stored, for `maxSize` */
  const stored = new Map<ObjectId, number>();
  const skipped = new Map<ObjectId, boolean>();
  const excluded = async (id: ObjectId) => {
    let s = skipped.get(id);
    if (s === undefined) {
      s = inStaying(id) || (o.skip ? await o.skip(id) : false);
      skipped.set(id, s);
    }
    return s;
  };
  for (const { pack, modified } of o.discard) {
    const base = joinPath(o.gitDir, "objects", "pack", `pack-${pack.packId}`);
    let perObject: Uint32Array | undefined;
    if ((await files.stats(`${base}.mtimes`))?.kind === "file") {
      try {
        perObject = parsePackMtimes(
          await readBytes(files, `${base}.mtimes`),
          pack.count,
          `${base}.mtimes`,
        );
      } catch {
        // git falls back to the pack's own mtime when the .mtimes cannot be loaded
        perObject = undefined;
      }
    }
    const packTime = modified === undefined ? o.now : Math.floor(modified / 1000);
    const extents = o.maxSize !== undefined ? await entryExtents(o, pack) : undefined;
    let at = 0;
    // `ids()` lists the idx in order: a cruft pack's times are by idx position
    for (const id of pack.ids()) {
      const pos = at++;
      if (await excluded(id)) continue;
      note(id, perObject ? (perObject[pos] as number) : packTime);
      const size = extents?.[pos];
      if (size !== undefined && !stored.has(id)) stored.set(id, size);
    }
  }
  for await (const id of o.looseStorage.keys()) {
    if (!OBJECT_ID.test(id) || (await excluded(id))) continue;
    const path = joinPath(o.gitDir, "objects", id.slice(0, 2), id.slice(2));
    const st = await files.stats(path);
    note(id, st?.lastModified === undefined ? o.now : Math.floor(st.lastModified / 1000));
    if (!stored.has(id) && st?.size !== undefined) stored.set(id, st.size);
  }

  let chosen: Map<ObjectId, number>;
  if (o.expiration === undefined) chosen = times;
  else {
    const expiration = o.expiration;
    chosen = new Map();
    const pending: ObjectId[] = [];
    // add_unseen_recent_objects_to_traversal: newer than the expiration (strictly)
    for (const [id, t] of times) {
      if (t > expiration) {
        chosen.set(id, t);
        pending.push(id);
      }
    }
    // traverse_commit_list from them, stopping at what a staying pack holds; what is reached
    // and not chosen yet is kept with the expiration as its time (show_cruft_object)
    const walked = new Set<ObjectId>();
    while (pending.length > 0) {
      const id = pending.pop() as ObjectId;
      if (walked.has(id)) continue;
      walked.add(id);
      for (const link of await objectLinks(objects, id)) {
        if (walked.has(link) || (await excluded(link))) continue;
        if (!chosen.has(link)) {
          // only an object this repository has (ignore_missing_links)
          if (!times.has(link) && !(await objects.has(link).catch(() => false))) continue;
          chosen.set(link, Math.max(expiration, 0));
        }
        pending.push(link);
      }
    }
  }
  if (chosen.size === 0) return undefined;

  // the listing: types from the headers (never a whole read in a loop)
  const listed: ListedObject[] = [];
  for (const id of [...chosen.keys()].sort()) {
    const type = await typeOf(objects, id);
    if (!type) continue;
    listed.push({ id, type });
  }
  if (listed.length === 0) return undefined;
  const maxSize =
    o.maxSize === undefined || o.maxSize <= 0
      ? undefined
      : Math.max(o.maxSize, MIN_PACK_SIZE_LIMIT);

  const mtimes = (id: ObjectId) => chosen.get(id) ?? 0;
  const names: string[] = [];
  const write = async (group: ListedObject[]): Promise<void> => {
    const installed = await packs.install(writePack(objects, group, o.packOptions), {
      writeReverseIndex: o.writeReverseIndex,
      mtimes,
    });
    if (maxSize !== undefined && group.length > 1) {
      const size = (
        await files.stats(joinPath(o.gitDir, "objects", "pack", `pack-${installed.packId}.pack`))
      )?.size;
      if (size !== undefined && size > maxSize) {
        // the estimate was short (deltas written whole): split it further
        await packs.remove([installed.packId]);
        const half = Math.ceil(group.length / 2);
        await write(group.slice(0, half));
        await write(group.slice(half));
        return;
      }
    }
    names.push(`pack-${installed.packId}`);
  };
  if (maxSize === undefined) await write(listed);
  else {
    // pack-objects --max-pack-size: a new pack whenever the next object would overflow it
    let group: ListedObject[] = [];
    let used = 32; // header and trailer
    for (const l of listed) {
      const size = stored.get(l.id) ?? 0;
      if (group.length > 0 && used + size > maxSize) {
        await write(group);
        group = [];
        used = 32;
      }
      group.push(l);
      used += size;
    }
    if (group.length > 0) await write(group);
  }
  await packs.refresh();
  return { packNames: names, objectCount: listed.length };
}

/** An object's type from its header, else a read. */
async function typeOf(objects: GitObjects, id: ObjectId): Promise<ObjectTypeString | undefined> {
  const t = await objects.objectType?.(id).catch(() => undefined);
  if (t) return t;
  const o = await objects.get(id).catch(() => undefined);
  if (!o) return undefined;
  if (!o.bytes) await o.content[Symbol.asyncIterator]().return?.();
  return o.type;
}

/** Each entry's size in the pack, by idx position (up to the next entry, or the trailer). */
async function entryExtents(o: CruftPackInput, pack: Pack): Promise<number[] | undefined> {
  const p = pack as Pack & { offsetAt?(i: number): number; packOrder?(): Uint32Array };
  if (!p.offsetAt || !p.packOrder) return undefined;
  const size = (
    await o.files.stats(joinPath(o.gitDir, "objects", "pack", `pack-${pack.packId}.pack`))
  )?.size;
  if (size === undefined) return undefined;
  const order = p.packOrder();
  const out: number[] = new Array(pack.count);
  for (let k = 0; k < order.length; k++) {
    const i = order[k] as number;
    const end = k + 1 < order.length ? p.offsetAt(order[k + 1] as number) : size - 20;
    out[i] = end - p.offsetAt(i);
  }
  return out;
}

/**
 * What an object links to: a commit's tree and parents, a tag's object, a tree's entries
 * (gitlinks left out). None for a blob or an object that cannot be read.
 * @internal
 */
export async function objectLinks(objects: GitObjects, id: ObjectId): Promise<ObjectId[]> {
  const type = await typeOf(objects, id);
  if (type !== "commit" && type !== "tag" && type !== "tree") return [];
  const o = await objects.get(id).catch(() => undefined);
  if (!o) return [];
  const bytes = o.bytes ?? (await collect(o.content));
  if (type === "tree") {
    // gitlinks name commits of other repositories: not walked (as git's traversal)
    return decodeTreeBytes(bytes)
      .filter((e) => e.mode !== 0o160000)
      .map((e) => e.id);
  }
  const text = new TextDecoder().decode(bytes.subarray(0, headerEnd(bytes)));
  const links: ObjectId[] = [];
  for (const line of text.split("\n")) {
    const m = /^(tree|parent|object) ([0-9a-f]{40})$/.exec(line);
    if (m) links.push(m[2] as string);
  }
  return links;
}

function headerEnd(bytes: Uint8Array): number {
  for (let i = 0; i + 1 < bytes.length; i++)
    if (bytes[i] === 0x0a && bytes[i + 1] === 0x0a) return i;
  return bytes.length;
}

async function collect(content: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let n = 0;
  for await (const c of content) {
    parts.push(c);
    n += c.length;
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

async function readBytes(files: FilesApi, path: string): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const c of files.read(path)) parts.push(c);
  return collect(
    (async function* () {
      yield* parts;
    })(),
  );
}
