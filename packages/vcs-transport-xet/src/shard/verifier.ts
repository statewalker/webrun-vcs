/**
 * A reconstruction verifier from a shard's hashes.
 */

import { hashToString } from "../hashes/index.js";
import type { ReconstructionVerifier } from "../reconstruct/index.js";
import { isZeroHash as isZero, keyedChunkHash, type Shard } from "./shard-format.js";

/**
 * What a reconstruction checks, from a shard: the chunk hashes its CAS section lists (keyed ones
 * compared keyed), and the verification hashes of the file `fileHash`'s terms (File Info section),
 * a term of the answer matched to the file's term with the same xorb and chunk range, in order.
 *
 * - `wholeFile`: the answer must be the file itself: exactly its terms, each checked, none
 *   missing or extra (not for range requests, whose terms may start mid-file or be narrowed).
 * - `strict`: a chunk of a xorb the shard does not list fails instead of passing unchecked.
 *
 * A chunk past the end of a xorb the shard lists fails either way: the shard says it has no such
 * chunk. One verifier per reconstruction: it walks the file's terms in order.
 */
export function verifierFromShard(
  shard: Shard,
  fileHash?: Uint8Array,
  o: { wholeFile?: boolean; strict?: boolean } = {},
): ReconstructionVerifier {
  if (shard.chunkHashesKeyed && (!shard.footer?.chunkHashKey || isZero(shard.footer.chunkHashKey)))
    throw new Error("shard: keyed chunk hashes without the footer key");
  const key = shard.chunkHashesKeyed ? shard.footer?.chunkHashKey : undefined;
  const xorbs = new Map(shard.xorbs.map((x) => [hashToString(x.xorbHash), x]));
  const file = fileHash
    ? shard.files.find((f) => f.fileHash.every((b, i) => b === fileHash[i]))
    : undefined;
  if (fileHash && !file) throw new Error("shard: the file is not in this shard");
  if (o.wholeFile && !file) throw new Error("shard: wholeFile needs the file's hash");
  const terms = (file?.terms ?? []).map((t) => ({ ...t, xorb: hashToString(t.xorbHash) }));
  let cursor = 0; // file terms already matched: an answer lists them in file order
  return {
    chunk: (xorb, index, hash) => {
      const x = xorbs.get(xorb.toLowerCase());
      if (!x) return o.strict ? false : undefined;
      const want = x.chunks[index]?.hash;
      if (!want) return false;
      const got = key ? keyedChunkHash(hash, key) : hash;
      return got.every((b, i) => b === want[i]);
    },
    rangeHash: (term) => {
      for (let k = cursor; k < terms.length; k++) {
        const t = terms[k] as (typeof terms)[number];
        if (t.xorb === term.xorb && t.start === term.start && t.end === term.end) {
          cursor = k + 1;
          return t.rangeHash;
        }
      }
      return undefined;
    },
    done: o.wholeFile
      ? (seen) => {
          const same =
            seen.length === terms.length &&
            seen.every((s, k) => {
              const t = terms[k] as (typeof terms)[number];
              return s.xorb === t.xorb && s.start === t.start && s.end === t.end && t.rangeHash;
            });
          return same
            ? undefined
            : `the answer's ${seen.length} terms are not the file's ${terms.length} (each with its verification hash)`;
        }
      : undefined,
  };
}
