import type { LfsPointer, LfsResolver } from "@statewalker/vcs-transport-lfs";
import { sha256Hex } from "@statewalker/vcs-transport-lfs";
import type {
  ByteStream,
  ChunkId,
  ContentStore,
  ObjectId,
} from "@statewalker/webrun-content-store";
import { createContentStore } from "@statewalker/webrun-content-store";
import { memBlobStore } from "@statewalker/webrun-storage";
import type { XetTransportEvent } from "../src/index.js";

/**
 * The content-store's injected `hashContent`. PREFIXED so a content-store
 * ObjectId (`cs-sha256:<hex>`) is never equal to a bare LFS oid (`<hex>`) — the
 * resolver genuinely translates between the two id spaces. Both peers share it
 * so chunk ids line up for dedup negotiation.
 */
export async function csHash(input: ByteStream): Promise<string> {
  return `cs-sha256:${await sha256Hex(await collect(input))}`;
}

export function makeStore(): ContentStore {
  return createContentStore({
    chunks: memBlobStore(),
    manifests: memBlobStore(),
    hashContent: csHash,
  });
}

/** A `Map`-backed LFS-oid → content-store-id resolver (no persistence). */
export function memResolver(): LfsResolver {
  const map = new Map<string, ObjectId>();
  return {
    async toObject(lfsOid) {
      return map.get(lfsOid);
    },
    async record(lfsOid, obj) {
      map.set(lfsOid, obj);
    },
  };
}

export async function* streamOf(bytes: Uint8Array): ByteStream {
  yield bytes;
}

export async function collect(stream: ByteStream): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const chunk of stream) parts.push(chunk);
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/**
 * Put whole bytes into a content-store, record the LFS-oid → content-store-id
 * mapping, and return both the LFS pointer and the content-store object id.
 */
export async function seedObject(
  store: ContentStore,
  resolver: LfsResolver,
  bytes: Uint8Array,
): Promise<{ ptr: LfsPointer; id: ObjectId }> {
  const { id } = await store.put(streamOf(bytes));
  const oid = await sha256Hex(bytes);
  await resolver.record(oid, id);
  return { ptr: { oid, size: bytes.length }, id };
}

export async function drain(
  events: AsyncIterable<XetTransportEvent>,
): Promise<XetTransportEvent[]> {
  const out: XetTransportEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

/** Deterministic pseudo-random bytes (xorshift32) — varied enough for CDC boundaries. */
export function prng(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}

/** Records `putChunk` ids so a test can assert the DEDUP delta (missing-only). */
export interface StoreSpy {
  putChunkIds: ChunkId[];
}

export function spyStore(inner: ContentStore): { store: ContentStore; spy: StoreSpy } {
  const spy: StoreSpy = { putChunkIds: [] };
  const store: ContentStore = {
    ...inner,
    async putChunk(id, bytes) {
      spy.putChunkIds.push(id);
      await inner.putChunk(id, bytes);
    },
  };
  return { store, spy };
}

export type { ChunkId, ContentStore, LfsPointer, LfsResolver, ObjectId };
