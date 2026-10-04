/** Shared helpers for the xet transfer demo: a mem content-store with a shared
 * chunk-identity hasher, a mem LFS resolver, a putChunk spy, and stream utils. */

import { createHash } from "node:crypto";
import type { LfsPointer, LfsResolver } from "@statewalker/vcs-transport-lfs";
import {
  type ByteStream,
  type ChunkId,
  type ContentStore,
  createContentStore,
} from "@statewalker/webrun-content-store";
import { memBlobStore } from "@statewalker/webrun-storage";

/**
 * The content-store's injected identity. Both peers share it so chunk ids line
 * up for dedup negotiation. Prefixed so a content-store id never collides with
 * a bare LFS oid — the resolver genuinely translates between the two id spaces.
 */
export async function csHash(input: ByteStream): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of input) h.update(chunk);
  return `cs-sha256:${h.digest("hex")}`;
}

export function makeStore(): ContentStore {
  return createContentStore({
    chunks: memBlobStore(),
    manifests: memBlobStore(),
    hashContent: csHash,
  });
}

/** A `Map`-backed LFS-oid -> content-store-id resolver (no persistence). */
export function memResolver(): LfsResolver {
  const map = new Map<string, string>();
  return {
    async toObject(oid) {
      return map.get(oid);
    },
    async record(oid, obj) {
      map.set(oid, obj);
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

/** Copy a set of chunks from one store to another (pre-seed the far side). */
export async function seedChunks(
  from: ContentStore,
  to: ContentStore,
  ids: ChunkId[],
): Promise<void> {
  for (const id of ids) await to.putChunk(id, from.getChunk(id));
}

/** Records `putChunk` ids so the demo can count the DEDUP delta (missing-only). */
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

export type { ChunkId, ContentStore, LfsPointer, LfsResolver };
