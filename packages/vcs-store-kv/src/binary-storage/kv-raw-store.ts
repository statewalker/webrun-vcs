/**
 * Key-Value based RawStorage implementation
 *
 * Stores binary content in a key-value store, cutting large values into
 * fixed-size chunks so that neither a write nor a read holds a whole value.
 */

import { fixedSizeChunks, type RawStorage, type SweepStaleOptions } from "@statewalker/vcs-core";
import { timestampedId, timestampOfId } from "@statewalker/vcs-utils";
import type { KVStore } from "../kv-store.js";

/** Default chunk size: 256 KiB. */
export const KV_RAW_CHUNK_SIZE = 256 * 1024;

export interface KvRawStoreOptions {
  /** Values longer than this are cut into chunks of this many bytes. Default 256 KiB. */
  chunkSize?: number;
}

/** Where the chunks of a large value live, stored as JSON under `manifest:{key}`. */
interface Manifest {
  size: number;
  chunkSize: number;
  count: number;
  /** Chunks are `chunk:{token}:{seq}`; a fresh token per write makes `move` a rename of the manifest. */
  token: string;
}

/**
 * Chunk tokens of writes and moves running in this process (tokens are unique
 * across stores), and how many such operations run: `sweepStale` never removes
 * their chunks.
 */
const inFlight = new Set<string>();
let activeWrites = 0;

const enc = new TextEncoder();
const dec = new TextDecoder();

function encodeSize(size: number): Uint8Array {
  const buffer = new ArrayBuffer(4);
  new DataView(buffer).setUint32(0, size, true);
  return new Uint8Array(buffer);
}

function decodeSize(data: Uint8Array): number {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0, true);
}

/**
 * KV-based storage
 *
 * A value up to one chunk is kept as before, as one entry:
 * - `{prefix}:raw:{key}` -> the bytes
 * - `{prefix}:size:{key}` -> size as a 4-byte integer
 *
 * A longer value is written chunk by chunk as it streams in, then published
 * by its manifest:
 * - `{prefix}:chunk:{token}:{seq}` -> chunk `seq` (each `chunkSize` bytes, the last shorter)
 * - `{prefix}:manifest:{key}` -> `{ size, chunkSize, count, token }` as JSON
 *
 * Reads stream one chunk at a time. Values written by older versions (always
 * one entry) read unchanged.
 *
 * A token is a `timestampedId`, so it records when its write started. A write
 * that fails cleans up its chunks, but a process that dies mid-write, or two
 * concurrent stores of the same key (both publish; the first manifest is
 * overwritten and its chunks are never dropped), leave chunks that no manifest
 * references. `sweepStale` removes those; gc calls it.
 *
 * Overwrites are last writer wins. A reader that loaded the old manifest of a
 * key being overwritten or removed may fail with `Missing chunk`. Git objects
 * never hit this: `rawStorageStaging` keeps an id that is already stored
 * instead of writing it again.
 *
 * @example
 * ```typescript
 * const raw = new KvRawStore(new MemoryKVAdapter(), "objects", { chunkSize: 256 * 1024 });
 * const objects = createGitObjects(rawStorageStaging(raw)); // streams through raw.move
 * ```
 */
export class KvRawStore implements RawStorage {
  private readonly chunkSize: number;

  /**
   * @param kv Key-value store
   * @param prefix Key prefix (default: "raw")
   * @param options Chunking options
   */
  constructor(
    private readonly kv: KVStore,
    private readonly prefix: string = "raw",
    options: KvRawStoreOptions = {},
  ) {
    this.chunkSize = options.chunkSize ?? KV_RAW_CHUNK_SIZE;
    if (!Number.isSafeInteger(this.chunkSize) || this.chunkSize <= 0) {
      throw new RangeError(`bad chunk size ${this.chunkSize}`);
    }
  }

  private dataKey(key: string): string {
    return `${this.prefix}:raw:${key}`;
  }

  private sizeKey(key: string): string {
    return `${this.prefix}:size:${key}`;
  }

  private manifestKey(key: string): string {
    return `${this.prefix}:manifest:${key}`;
  }

  private chunkKey(token: string, seq: number): string {
    return `${this.prefix}:chunk:${token}:${seq}`;
  }

  private async manifest(key: string): Promise<Manifest | undefined> {
    const bytes = await this.kv.get(this.manifestKey(key));
    return bytes ? (JSON.parse(dec.decode(bytes)) as Manifest) : undefined;
  }

  private async removeChunks(token: string, count: number): Promise<void> {
    for (let seq = 0; seq < count; seq++) await this.kv.delete(this.chunkKey(token, seq));
  }

  /** Drop the chunks of a replaced or removed manifest. */
  private async dropManifest(m: Manifest | undefined): Promise<void> {
    if (m) await this.removeChunks(m.token, m.count);
  }

  /**
   * Store byte stream under key, writing each chunk as soon as it is full.
   */
  async store(key: string, content: AsyncIterable<Uint8Array>): Promise<void> {
    const chunks = fixedSizeChunks(content, this.chunkSize)[Symbol.asyncIterator]();
    const first = await chunks.next();
    const second = first.done ? first : await chunks.next();
    if (second.done) {
      // One chunk at most: one entry, as older versions wrote every value.
      const bytes = first.done ? new Uint8Array(0) : first.value;
      const previous = await this.manifest(key);
      const entries = new Map<string, Uint8Array>();
      entries.set(this.dataKey(key), bytes);
      entries.set(this.sizeKey(key), encodeSize(bytes.length));
      await this.kv.setMany(entries);
      if (previous) {
        await this.kv.delete(this.manifestKey(key));
        await this.dropManifest(previous);
      }
      return;
    }

    const token = timestampedId();
    let count = 0;
    let size = 0;
    let published = false;
    inFlight.add(token);
    activeWrites++;
    try {
      const put = async (chunk: Uint8Array) => {
        await this.kv.set(this.chunkKey(token, count++), chunk);
        size += chunk.length;
      };
      await put(first.value as Uint8Array);
      await put(second.value);
      for (let r = await chunks.next(); !r.done; r = await chunks.next()) await put(r.value);

      const previous = await this.manifest(key);
      const manifest: Manifest = { size, chunkSize: this.chunkSize, count, token };
      await this.kv.set(this.manifestKey(key), enc.encode(JSON.stringify(manifest)));
      published = true;
      await this.kv.delete(this.dataKey(key));
      await this.kv.delete(this.sizeKey(key));
      await this.dropManifest(previous);
    } finally {
      try {
        if (!published) await this.removeChunks(token, count);
      } finally {
        inFlight.delete(token);
        activeWrites--;
      }
    }
  }

  /**
   * Load byte stream by key, one chunk at a time.
   */
  async *load(key: string, options?: { start?: number; end?: number }): AsyncIterable<Uint8Array> {
    const m = await this.manifest(key);
    if (!m) {
      const bytes = await this.kv.get(this.dataKey(key));
      if (!bytes) throw new Error(`Key not found: ${key}`);
      const start = options?.start ?? 0;
      const end = options?.end ?? bytes.length;
      yield start > 0 || end < bytes.length ? bytes.slice(start, end) : bytes;
      return;
    }
    const start = Math.max(0, options?.start ?? 0);
    const end = Math.min(m.size, options?.end ?? m.size);
    if (start >= end) return;
    for (let seq = Math.floor(start / m.chunkSize); seq * m.chunkSize < end; seq++) {
      const chunk = await this.kv.get(this.chunkKey(m.token, seq));
      if (!chunk) throw new Error(`Missing chunk ${seq} of ${key}`);
      const base = seq * m.chunkSize;
      const from = Math.max(0, start - base);
      const to = Math.min(chunk.length, end - base);
      yield from === 0 && to === chunk.length ? chunk : chunk.subarray(from, to);
    }
  }

  async has(key: string): Promise<boolean> {
    return (await this.kv.has(this.manifestKey(key))) || (await this.kv.has(this.dataKey(key)));
  }

  async remove(key: string): Promise<boolean> {
    const m = await this.manifest(key);
    const inline = await this.kv.has(this.dataKey(key));
    if (inline) {
      await this.kv.delete(this.dataKey(key));
      await this.kv.delete(this.sizeKey(key));
    }
    if (m) {
      await this.kv.delete(this.manifestKey(key));
      await this.dropManifest(m);
    }
    return inline || m !== undefined;
  }

  /**
   * Rename a value: a large one by moving its manifest (its chunks stay where
   * they are), a small one by copying its single entry.
   */
  async move(from: string, to: string): Promise<boolean> {
    if (from === to) return this.has(from);
    activeWrites++;
    let token: string | undefined;
    try {
      const m = await this.manifest(from);
      token = m?.token;
      if (token) inFlight.add(token);
      return await this.moveValue(from, to, m);
    } finally {
      if (token) inFlight.delete(token);
      activeWrites--;
    }
  }

  private async moveValue(from: string, to: string, m: Manifest | undefined): Promise<boolean> {
    const inline = m ? undefined : await this.kv.get(this.dataKey(from));
    if (!m && !inline) return false;
    const replaced = await this.manifest(to);
    if (m) {
      await this.kv.set(this.manifestKey(to), enc.encode(JSON.stringify(m)));
      await this.kv.delete(this.dataKey(to));
      await this.kv.delete(this.sizeKey(to));
      await this.kv.delete(this.manifestKey(from));
    } else if (inline) {
      const entries = new Map<string, Uint8Array>();
      entries.set(this.dataKey(to), inline);
      entries.set(this.sizeKey(to), encodeSize(inline.length));
      await this.kv.setMany(entries);
      if (replaced) await this.kv.delete(this.manifestKey(to));
      await this.kv.delete(this.dataKey(from));
      await this.kv.delete(this.sizeKey(from));
    }
    if (replaced && replaced.token !== m?.token) await this.dropManifest(replaced);
    return true;
  }

  async *keys(): AsyncIterable<string> {
    const dataPrefix = this.dataKey("");
    for await (const fullKey of this.kv.list(dataPrefix)) {
      yield fullKey.substring(dataPrefix.length);
    }
    const manifestPrefix = this.manifestKey("");
    for await (const fullKey of this.kv.list(manifestPrefix)) {
      const key = fullKey.substring(manifestPrefix.length);
      // a write interrupted between its two forms: list the key once
      if (!(await this.kv.has(this.dataKey(key)))) yield key;
    }
  }

  async size(key: string): Promise<number> {
    const m = await this.manifest(key);
    if (m) return m.size;
    const sizeData = await this.kv.get(this.sizeKey(key));
    return sizeData ? decodeSize(sizeData) : -1;
  }

  /**
   * Remove chunks that no manifest references and whose token is older than
   * `olderThanMs` (a token records when its write started). A token without a
   * time (written before tokens carried one) is removed only when
   * `olderThanMs <= 0`. Chunks of writes and moves running in this process are
   * kept, and with `olderThanMs <= 0` nothing is removed while one runs. A
   * write in another process sharing the KV store is safe only through its
   * age: pick an expiry longer than any write.
   *
   * @returns The number of orphaned tokens removed
   */
  async sweepStale({ olderThanMs }: SweepStaleOptions): Promise<number> {
    if (olderThanMs <= 0 && activeWrites > 0) return 0;
    const cutoff = Date.now() - olderThanMs;
    // Chunks first, manifests second: a write published in between is then seen.
    const chunkPrefix = `${this.prefix}:chunk:`;
    const candidates = new Map<string, string[]>();
    for await (const fullKey of this.kv.list(chunkPrefix)) {
      const rest = fullKey.substring(chunkPrefix.length);
      const colon = rest.lastIndexOf(":");
      if (colon <= 0) continue;
      const token = rest.slice(0, colon);
      if (inFlight.has(token)) continue;
      const made = timestampOfId(token);
      if (!(olderThanMs <= 0 || (made !== undefined && made < cutoff))) continue;
      const keys = candidates.get(token) ?? [];
      keys.push(fullKey);
      candidates.set(token, keys);
    }
    if (candidates.size === 0) return 0;
    const manifestPrefix = this.manifestKey("");
    for await (const fullKey of this.kv.list(manifestPrefix)) {
      const bytes = await this.kv.get(fullKey);
      if (!bytes) continue;
      try {
        candidates.delete((JSON.parse(dec.decode(bytes)) as Manifest).token);
      } catch {
        // not a manifest we can read: leave chunks alone rather than guess
        return 0;
      }
    }
    let removed = 0;
    for (const [token, keys] of candidates) {
      if (inFlight.has(token)) continue;
      for (const key of keys) await this.kv.delete(key);
      removed++;
    }
    return removed;
  }
}

/**
 * Create a new KV-based raw store
 */
export function createKvRawStore(
  kv: KVStore,
  prefix?: string,
  options?: KvRawStoreOptions,
): KvRawStore {
  return new KvRawStore(kv, prefix, options);
}
