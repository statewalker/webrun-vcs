/**
 * Xet's aggregated hashes (xet-core `merklehash::aggregated_hashes`): the xorb hash and the file
 * hash are roots of a Merkle tree over chunk hashes with a content-defined branching (mean 4); a
 * verification range hash (`mdb_shard` term verification) is the chunk hashes concatenated,
 * keyed with VERIFICATION_KEY.
 */

import { hashToString, INTERNAL_NODE_KEY, keyedBlake3, VERIFICATION_KEY } from "./xet-hash.js";

/** a chunk (or a subtree) as the tree sees it: its hash and its uncompressed length */
export interface ChunkRef {
  hash: Uint8Array;
  length: number;
}

const ZERO_KEY = new Uint8Array(32);
const enc = new TextEncoder();

/** an internal node: `{hash} : {size}\n` per child, keyed with INTERNAL_NODE_KEY */
function mergedHash(children: ChunkRef[]): ChunkRef {
  let text = "";
  let length = 0;
  for (const c of children) {
    text += `${hashToString(c.hash)} : ${c.length}\n`;
    length += c.length;
  }
  return { hash: keyedBlake3(INTERNAL_NODE_KEY, enc.encode(text)), length };
}

/**
 * How many of `nodes` the next group takes (xet-core's `next_merge_cut`): at least 2, at most 9;
 * a node whose hash is 0 mod 4 (its last word, little-endian) ends a group from the third on.
 */
function nextCut(nodes: ChunkRef[], from: number): number {
  const left = nodes.length - from;
  if (left <= 2) return left;
  const end = Math.min(9, left);
  for (let i = 2; i < end; i++) if (((nodes[from + i]?.hash[24] as number) & 3) === 0) return i + 1;
  return end;
}

/** the root of xet-core's aggregated Merkle tree */
function aggregated(chunks: ChunkRef[]): Uint8Array {
  if (!chunks.length) return new Uint8Array(32);
  let level = chunks;
  while (level.length > 1) {
    const next: ChunkRef[] = [];
    for (let at = 0; at < level.length; ) {
      const n = nextCut(level, at);
      next.push(mergedHash(level.slice(at, at + n)));
      at += n;
    }
    level = next;
  }
  return (level[0] as ChunkRef).hash;
}

/** a xorb's hash: the Merkle root over its chunks */
export const xorbHash = (chunks: ChunkRef[]): Uint8Array => aggregated(chunks);

/** a file's hash: the Merkle root over its chunks, keyed once more with a zero key */
export const fileHash = (chunks: ChunkRef[]): Uint8Array =>
  chunks.length ? keyedBlake3(ZERO_KEY, aggregated(chunks)) : new Uint8Array(32);

/** a verification range hash: the chunk hashes concatenated, keyed with VERIFICATION_KEY */
export function rangeHash(hashes: Uint8Array[]): Uint8Array {
  const all = new Uint8Array(hashes.length * 32);
  hashes.forEach((h, i) => {
    all.set(h, i * 32);
  });
  return keyedBlake3(VERIFICATION_KEY, all);
}
