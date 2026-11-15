/**
 * Deduplication lookups over shards: where a chunk is (a xorb and an index), and a file's terms
 * from its chunks' locations.
 */

import { type ChunkRef, rangeHash } from "../hashes/index.js";
import { type FileTerm, isZeroHash as isZero, keyedChunkHash, type Shard } from "./shard-format.js";

/** where a chunk is: the xorb and the chunk's index in it */
export interface ChunkLocation {
  xorbHash: Uint8Array;
  index: number;
}

/**
 * The deduplication index of shards (an upload's own, or global-dedupe answers): a chunk hash to
 * the xorb and index holding it. A shard whose footer has a key stores keyed chunk hashes; the
 * lookup keys the asked hash with it.
 */
export function dedupeIndex(shards: Shard[]): (hash: Uint8Array) => ChunkLocation | undefined {
  const plain = new Map<string, ChunkLocation>();
  const byKey: { key: Uint8Array; map: Map<string, ChunkLocation> }[] = [];
  const hex = (h: Uint8Array) => Array.from(h, (b) => b.toString(16).padStart(2, "0")).join("");
  for (const s of shards) {
    const key = s.footer?.chunkHashKey;
    let map = plain;
    // keyed as stored (read from a keyed shard); an in-memory shard to be written holds plain ones
    if (key && !isZero(key) && s.chunkHashesKeyed) {
      map = new Map();
      byKey.push({ key, map });
    }
    for (const x of s.xorbs)
      x.chunks.forEach((c, index) => {
        const k = hex(c.hash);
        if (!map.has(k)) map.set(k, { xorbHash: x.xorbHash, index });
      });
  }
  return (hash) =>
    plain.get(hex(hash)) ??
    byKey.map(({ key, map }) => map.get(hex(keyedChunkHash(hash, key)))).find(Boolean);
}

/**
 * A file's terms from its chunks and where each is: consecutive chunks at consecutive indexes of
 * one xorb make one term, with its verification hash over that xorb's chunk hashes (which are the
 * file's own chunk hashes, in order).
 */
export function termsFor(
  chunks: ChunkRef[],
  locate: (hash: Uint8Array, i: number) => ChunkLocation,
): FileTerm[] {
  const terms: FileTerm[] = [];
  let open: { term: FileTerm; hashes: Uint8Array[] } | undefined;
  const close = () => {
    if (open) {
      open.term.rangeHash = rangeHash(open.hashes);
      terms.push(open.term);
    }
    open = undefined;
  };
  chunks.forEach((c, i) => {
    const at = locate(c.hash, i);
    const same =
      open &&
      open.term.end === at.index &&
      open.term.xorbHash.every((b, k) => b === at.xorbHash[k]);
    if (!same) {
      close();
      open = {
        term: { xorbHash: at.xorbHash, bytes: 0, start: at.index, end: at.index },
        hashes: [],
      };
    }
    const o = open as { term: FileTerm; hashes: Uint8Array[] };
    o.term.end++;
    o.term.bytes += c.length;
    o.hashes.push(c.hash);
  });
  close();
  return terms;
}
