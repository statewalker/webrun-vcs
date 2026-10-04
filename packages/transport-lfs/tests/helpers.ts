import type { ByteStream, ContentStore, ObjectId } from "@statewalker/webrun-content-store";
import { createContentStore } from "@statewalker/webrun-content-store";
import { memBlobStore } from "@statewalker/webrun-storage";
import type { LfsPointer, LfsResolver, TransportEvent } from "../src/index.js";
import { sha256Hex } from "../src/index.js";

/**
 * The content-store's injected `hashContent`. Deliberately PREFIXED so a
 * content-store ObjectId (`cs-sha256:<hex>`) is never equal to a bare LFS oid
 * (`<hex>`) — the resolver genuinely translates between the two id spaces.
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

/** Put whole bytes into a content-store and record the LFS-oid mapping. */
export async function seedObject(
  store: ContentStore,
  resolver: LfsResolver,
  bytes: Uint8Array,
): Promise<LfsPointer> {
  const d = await store.put(streamOf(bytes));
  const oid = await sha256Hex(bytes);
  await resolver.record(oid, d.id);
  return { oid, size: bytes.length };
}

export async function drain(events: AsyncIterable<TransportEvent>): Promise<TransportEvent[]> {
  const out: TransportEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

/** Deterministic pseudo-random bytes (xorshift32). */
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
