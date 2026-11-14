/**
 * unpack-objects over the object kernel, after git's builtin/unpack-objects.c:
 *
 *   - one sequential pass over the incoming stream, never stored and never buffered whole: each
 *     entry is inflated as it arrives (stopping past its declared size) and every byte feeds the
 *     pack's SHA-1, checked against the trailer at the end;
 *   - whole objects are written as loose objects (`putRaw`, byte for byte as git frames them);
 *     those over `bigObjectThreshold` stream straight into the store (`put`, git's stream_blob),
 *     hashed on the way, and the id `put` returns must be that hash (`ObjectIdMismatchError`);
 *   - deltas are resolved as they arrive: an OFS_DELTA base is always earlier in the pack, so it
 *     is already written; a REF_DELTA base is an earlier entry, an object the store has (a thin
 *     pack) or a later entry, in which case the delta waits for it (git's delta_list);
 *   - bases come from a byte-bounded LRU of recent objects, or are read back from the store;
 *   - an object the store already has is compared byte for byte with the incoming one (git's
 *     check_collision), and a mismatch is refused with `ObjectCollisionError`.
 *
 * Objects are written before the trailer is read, as git does: each is named by the hash of its
 * own bytes, so a pack refused at its end leaves only sound objects behind.
 */
import { CompressionError, createInflaterPool } from "@statewalker/vcs-utils/compression";
import { applyGitDelta, DeltaError } from "@statewalker/vcs-utils/diff";
import { createSha1, type Hasher } from "@statewalker/vcs-utils/hash/hasher";
import { bytesToHex, hexToBytes } from "@statewalker/vcs-utils/hash/utils";
import type { ObjectId } from "../common/id/index.js";
import { type GitObjects, ObjectIdMismatchError } from "../history/objects/git-objects.js";
import type { ObjectTypeString } from "../history/objects/object-types.js";
import { PackError } from "./index-pack.js";
import { DeltaBaseCache, type ResolvedObject } from "./pack-file.js";

/** An incoming object whose id the store already holds with other bytes (a SHA-1 collision). */
export class ObjectCollisionError extends PackError {
  override name = "ObjectCollisionError";
}

/** The parts of the object kernel `unpackObjects` writes and reads through. */
export type UnpackTarget = Pick<GitObjects, "put" | "putRaw" | "get" | "getRaw" | "has">;

export interface UnpackObjectsOptions {
  /** Largest object (or delta) accepted, by its header and by delta results. Default 1 GiB. */
  maxObjectSize?: number;
  /** Bytes of recent objects kept as delta bases; others are read back from the store. Default 16 MiB. */
  baseCacheBytes?: number;
  /**
   * Whole objects larger than this stream straight into the store instead of being held while
   * they are hashed (git's `core.bigFileThreshold`). They skip the collision check, as in git;
   * the store keeps an existing object, so one can never be replaced. Default 16 MiB.
   */
  bigObjectThreshold?: number;
  /** Called for every object of the pack once it is stored (or found already stored). */
  onObject?: (id: ObjectId, type: ObjectTypeString) => void;
}

export interface UnpackResult {
  /** objects in the pack */
  count: number;
  /**
   * objects handed to the store by this call. Objects over `bigObjectThreshold` always count
   * here: they are streamed to `put` before their id is known, so whether the store already had
   * them is not checked (the store keeps an existing object).
   */
  written: number;
  /** objects the store already had, compared byte for byte (objects up to `bigObjectThreshold`) */
  existing: number;
  /** entries stored in the pack as deltas */
  deltas: number;
  /** objects per type */
  types: Record<ObjectTypeString, number>;
}

const TYPE_NAMES: (ObjectTypeString | undefined)[] = [undefined, "commit", "tree", "blob", "tag"];
const TYPE_CODE: Record<ObjectTypeString, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const OFS_DELTA = 6;
const REF_DELTA = 7;
const SLICE = 1024; // inflater input per push: one push yields at most ~1 MiB
const enc = new TextEncoder();
const hex = bytesToHex;

const header = (type: ObjectTypeString, size: number) => enc.encode(`${type} ${size}\0`);

/** Sequential reader over the incoming stream; hashes every byte until `digest()`. */
class StreamReader {
  pos = 0;
  private chunk: Uint8Array = new Uint8Array(0);
  private at = 0;
  private readonly it: AsyncIterator<Uint8Array>;
  private hasher: Hasher | undefined = createSha1();
  constructor(source: AsyncIterable<Uint8Array>) {
    this.it = source[Symbol.asyncIterator]();
  }
  private consumed(bytes: Uint8Array) {
    this.hasher?.update(bytes);
    this.pos += bytes.length;
  }
  private async fill(): Promise<boolean> {
    while (this.at >= this.chunk.length) {
      const r = await this.it.next();
      if (r.done) return false;
      this.chunk = r.value;
      this.at = 0;
    }
    return true;
  }
  async byte(): Promise<number> {
    if (!(await this.fill())) throw new PackError(`pack truncated at ${this.pos}`);
    const b = this.chunk[this.at] as number;
    this.consumed(this.chunk.subarray(this.at, this.at + 1));
    this.at++;
    return b;
  }
  async bytes(n: number): Promise<Uint8Array> {
    const out = new Uint8Array(n);
    let o = 0;
    while (o < n) {
      if (!(await this.fill())) throw new PackError(`pack truncated at ${this.pos}`);
      const k = Math.min(n - o, this.chunk.length - this.at);
      const part = this.chunk.subarray(this.at, this.at + k);
      out.set(part, o);
      this.consumed(part);
      this.at += k;
      o += k;
    }
    return out;
  }
  /**
   * The inflated data of the entry at `offset`, exactly `size` bytes, as it arrives. Fails with
   * `PackError` on corrupt zlib, truncation, or a size other than declared (stopping at the first
   * byte past it). Stopping early releases the inflater.
   */
  async *inflate(size: number, offset: number): AsyncGenerator<Uint8Array> {
    const inflater = pool.acquire();
    let got = 0;
    let done = false;
    try {
      while (!done) {
        if (!(await this.fill()))
          throw new PackError(`pack truncated inside the entry at ${offset}`);
        const slice = this.chunk.subarray(this.at, Math.min(this.chunk.length, this.at + SLICE));
        let r: ReturnType<typeof inflater.push>;
        try {
          r = inflater.push(slice);
        } catch (err) {
          if (err instanceof CompressionError)
            throw new PackError(`entry at ${offset}: ${err.message}`);
          throw err;
        }
        done = r.done;
        const used = r.done ? r.consumed : slice.length;
        this.consumed(slice.subarray(0, used));
        this.at += used;
        for (const out of r.out) {
          got += out.length;
          if (got > size)
            throw new PackError(`entry at ${offset} inflates past its declared ${size} bytes`);
          yield out;
        }
      }
    } finally {
      if (!done) inflater.abort();
    }
    if (got !== size)
      throw new PackError(`entry at ${offset} inflates to ${got} bytes, header says ${size}`);
  }
  async inflateAll(size: number, offset: number): Promise<Uint8Array> {
    const out = new Uint8Array(size);
    let o = 0;
    for await (const c of this.inflate(size, offset)) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }
  /** The SHA-1 of everything read so far; later bytes (the trailer) are not hashed. */
  digest(): Uint8Array {
    const h = this.hasher as Hasher;
    this.hasher = undefined;
    return h.digest();
  }
  async atEnd(): Promise<boolean> {
    return !(await this.fill());
  }
  async close(): Promise<void> {
    await this.it.return?.();
  }
}

const pool = createInflaterPool();

/**
 * Per-entry state in typed arrays, 29 bytes an entry, grown by doubling as entries are parsed (so
 * up to about 58 bytes an entry are allocated just after a doubling).
 */
class Entries {
  n = 0;
  offset = new Float64Array(256);
  type = new Uint8Array(256); // resolved type 1-4, 0 while a delta waits for its base
  oid = new Uint8Array(256 * 20);
  push(offset: number): number {
    if (this.n === this.offset.length) {
      const cap = this.n * 2;
      const o = new Float64Array(cap);
      o.set(this.offset);
      this.offset = o;
      const t = new Uint8Array(cap);
      t.set(this.type);
      this.type = t;
      const d = new Uint8Array(cap * 20);
      d.set(this.oid);
      this.oid = d;
    }
    this.offset[this.n] = offset;
    return this.n++;
  }
  /** index of the entry at `offset`, or -1 */
  at(offset: number): number {
    let lo = 0;
    let hi = this.n - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const o = this.offset[mid] as number;
      if (o === offset) return mid;
      if (o < offset) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }
  id(i: number): ObjectId {
    return hex(this.oid.subarray(i * 20, i * 20 + 20));
  }
}

/** A delta waiting for its base: a later REF_DELTA base, or an OFS base that itself waits. */
interface Waiting {
  index: number;
  delta: Uint8Array;
}

/**
 * Stores every object of a pack stream as a loose object through `objects`, as `git
 * unpack-objects` does. Deltas are resolved against the pack's own objects and, for thin packs,
 * against objects the store already has. A corrupt pack (bad header, zlib, sizes, deltas or
 * trailer) is refused with `PackError`; an object whose id the store holds with other bytes with
 * `ObjectCollisionError`.
 *
 * Memory: the per-entry table (29 bytes an entry, up to about 58 allocated, as the arrays grow by
 * doubling), the base cache (`baseCacheBytes`), the entry being resolved (a whole object up to
 * `bigObjectThreshold`, or a delta with its base and result) and deltas waiting for their base:
 * REF_DELTAs whose base comes later in the pack (which git's pack-objects never writes) and the
 * deltas built on them. When a base arrives, every delta waiting on it is resolved from it while
 * it is held, so sibling deltas on one base are all held together with it (as in git). A base
 * over `bigObjectThreshold` is streamed to the store, not kept: every OFS or waiting delta
 * against it reads it back from the store (unless it fits the base cache).
 *
 * @example
 * ```typescript
 * const objects = createGitObjects(rawStorageStaging(new MemoryRawStorage()));
 * const { count, written } = await unpackObjects(objects, response.body);
 * ```
 */
export async function unpackObjects(
  objects: UnpackTarget,
  pack: AsyncIterable<Uint8Array>,
  options: UnpackObjectsOptions = {},
): Promise<UnpackResult> {
  const maxObjectSize = options.maxObjectSize ?? 2 ** 30;
  const bigObjectThreshold = Math.min(options.bigObjectThreshold ?? 16 * 2 ** 20, maxObjectSize);
  const cache = new DeltaBaseCache(options.baseCacheBytes ?? 16 * 2 ** 20);
  const result: UnpackResult = {
    count: 0,
    written: 0,
    existing: 0,
    deltas: 0,
    types: { commit: 0, tree: 0, blob: 0, tag: 0 },
  };
  const t = new Entries();
  /** waiting deltas, keyed by base id or by "#<index>" of a base entry that itself waits */
  const waiting = new Map<string, Waiting[]>();
  let waitingCount = 0;

  const patch = (base: Uint8Array, delta: Uint8Array, i: number) => {
    try {
      return applyGitDelta(base, delta, maxObjectSize);
    } catch (err) {
      if (err instanceof DeltaError) throw new PackError(`delta at ${t.offset[i]}: ${err.message}`);
      throw err;
    }
  };

  /** A base by id: the cache, then the store. */
  const loadBase = async (id: ObjectId): Promise<ResolvedObject | undefined> => {
    const hit = cache.get(id);
    if (hit) return hit;
    const obj = await objects.get(id);
    if (!obj) return undefined;
    if (obj.size > maxObjectSize) {
      await obj.content[Symbol.asyncIterator]().return?.();
      throw new PackError(`base ${id} is larger than the limit of ${maxObjectSize}`);
    }
    const data = new Uint8Array(obj.size);
    let o = 0;
    for await (const c of obj.content) {
      data.set(c, o);
      o += c.length;
    }
    const base = { type: obj.type, data };
    cache.put(id, base);
    return base;
  };

  /** Compares the stored object `id` with `raw` (header and content), byte for byte. */
  const sameAsStored = async (id: ObjectId, head: Uint8Array, data: Uint8Array) => {
    let o = 0;
    const total = head.length + data.length;
    const it = objects.getRaw(id)[Symbol.asyncIterator]();
    try {
      for (let r = await it.next(); !r.done; r = await it.next()) {
        for (const b of r.value) {
          if (o >= total) return false;
          const want = o < head.length ? head[o] : data[o - head.length];
          if (b !== want) return false;
          o++;
        }
      }
    } finally {
      await it.return?.();
    }
    return o === total;
  };

  /** Stores a materialised object (or checks the stored copy) and records entry i. */
  const store = async (i: number, type: ObjectTypeString, data: Uint8Array) => {
    const head = header(type, data.length);
    const id = hex(createSha1().update(head).update(data).digest());
    if (await objects.has(id)) {
      if (!(await sameAsStored(id, head, data)))
        throw new ObjectCollisionError(`SHA-1 collision found with ${id}: the bytes differ`);
      result.existing++;
    } else {
      await objects.putRaw(id, [head, data]);
      result.written++;
    }
    record(i, id, type);
    cache.put(id, { type, data });
    return id;
  };

  const record = (i: number, id: ObjectId, type: ObjectTypeString) => {
    t.type[i] = TYPE_CODE[type];
    t.oid.set(hexToBytes(id), i * 20);
    result.types[type]++;
    options.onObject?.(id, type);
  };

  const wait = (key: string, w: Waiting) => {
    const list = waiting.get(key);
    if (list) list.push(w);
    else waiting.set(key, [w]);
    waitingCount++;
  };

  /** Resolves the deltas waiting on entry i (and on what they resolve to), depth first. */
  const release = async (i: number, data: Uint8Array | undefined) => {
    if (!waitingCount) return;
    const stack: { i: number; data: Uint8Array | undefined }[] = [{ i, data }];
    while (stack.length) {
      const top = stack.pop() as { i: number; data: Uint8Array | undefined };
      const id = t.id(top.i);
      const children = [...(waiting.get(id) ?? []), ...(waiting.get(`#${top.i}`) ?? [])];
      if (!children.length) continue;
      waiting.delete(id);
      waiting.delete(`#${top.i}`);
      waitingCount -= children.length;
      const type = TYPE_NAMES[t.type[top.i] as number] as ObjectTypeString;
      let base = top.data;
      if (!base) {
        const loaded = await loadBase(id);
        if (!loaded) throw new PackError(`base ${id} vanished from the store`);
        base = loaded.data;
      }
      for (const c of children) {
        const data = patch(base, c.delta, c.index);
        await store(c.index, type, data);
        stack.push({ i: c.index, data });
      }
    }
  };

  const r = new StreamReader(pack);
  try {
    const head = await r.bytes(12);
    if (String.fromCharCode(...head.subarray(0, 4)) !== "PACK")
      throw new PackError("not a pack (bad signature)");
    const view = new DataView(head.buffer, head.byteOffset, 12);
    const version = view.getUint32(4);
    const count = view.getUint32(8);
    if (version !== 2 && version !== 3) throw new PackError(`unsupported pack version ${version}`);
    result.count = count;

    for (let n = 0; n < count; n++) {
      const offset = r.pos;
      let b = await r.byte();
      const kind = (b >> 4) & 7;
      if (!TYPE_NAMES[kind] && kind !== OFS_DELTA && kind !== REF_DELTA)
        throw new PackError(`bad object type ${kind} at ${offset}`);
      let size = b & 0x0f;
      let mul = 16;
      while (b & 0x80) {
        b = await r.byte();
        size += (b & 0x7f) * mul;
        mul *= 128;
        if (mul > 2 ** 53) throw new PackError(`object size overflow at ${offset}`);
      }
      if (size > maxObjectSize)
        throw new PackError(
          `entry at ${offset} declares ${size} bytes, over the limit of ${maxObjectSize}`,
        );
      let baseIndex = -1;
      let baseId: ObjectId | undefined;
      if (kind === OFS_DELTA) {
        b = await r.byte();
        let back = b & 0x7f;
        while (b & 0x80) {
          b = await r.byte();
          back = (back + 1) * 128 + (b & 0x7f);
          if (back > offset) break; // before the pack start: refused below
        }
        const baseOffset = offset - back;
        baseIndex = back === 0 || baseOffset < 12 ? -1 : t.at(baseOffset);
        if (baseIndex < 0)
          throw new PackError(
            `OFS_DELTA at ${offset} points to ${baseOffset}, not an earlier entry`,
          );
      } else if (kind === REF_DELTA) {
        baseId = hex(await r.bytes(20));
      }
      const i = t.push(offset);
      const typeName = TYPE_NAMES[kind];
      if (typeName) {
        if (size > bigObjectThreshold) {
          // streamed into the store, hashed on the way: the store's id must be the pack's
          const hasher = createSha1().update(header(typeName, size));
          const body = (async function* () {
            for await (const c of r.inflate(size, offset)) {
              hasher.update(c);
              yield c;
            }
          })();
          const stored = await objects.put(typeName, size, body);
          const id = hex(hasher.digest());
          if (stored !== id)
            throw new ObjectIdMismatchError(
              `entry at ${offset} is object ${id}, but the store returned ${stored}`,
            );
          result.written++;
          record(i, id, typeName);
          await release(i, undefined);
        } else {
          const data = await r.inflateAll(size, offset);
          await store(i, typeName, data);
          await release(i, data);
        }
        continue;
      }
      result.deltas++;
      const delta = await r.inflateAll(size, offset);
      if (baseIndex >= 0 && !t.type[baseIndex]) {
        wait(`#${baseIndex}`, { index: i, delta }); // its base is a delta still waiting
        continue;
      }
      const id = baseIndex >= 0 ? t.id(baseIndex) : (baseId as ObjectId);
      const base = await loadBase(id);
      if (!base) {
        if (baseIndex >= 0) throw new PackError(`base ${id} vanished from the store`);
        wait(id, { index: i, delta }); // a later entry, or missing: checked at the end
        continue;
      }
      const data = patch(base.data, delta, i);
      await store(i, base.type, data);
      await release(i, data);
    }

    const expected = hex(r.digest());
    const trailer = hex(await r.bytes(20));
    if (trailer !== expected)
      throw new PackError(`pack checksum mismatch: trailer ${trailer}, content ${expected}`);
    if (!(await r.atEnd())) throw new PackError("bytes after the pack trailer");
    if (waitingCount) {
      const first = [...waiting.keys()].find((k) => !k.startsWith("#"));
      throw new PackError(
        `${waitingCount} unresolved deltas${first ? ` (thin pack? first missing base ${first})` : ""}`,
      );
    }
    return result;
  } finally {
    await r.close();
  }
}
