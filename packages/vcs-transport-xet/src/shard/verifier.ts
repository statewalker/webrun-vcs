/**
 * A reconstruction verifier from a shard's hashes.
 */

import { hashToString } from "../hashes/index.js";
import type { ReconstructionVerifier, VerifiedTerm } from "../reconstruct/index.js";
import { isZeroHash as isZero, keyedChunkHash, type Shard } from "./shard-format.js";

export interface ShardVerifierOptions {
  /**
   * The answer must be the file itself: exactly its terms, in order, none missing or extra,
   * compared before any byte is fetched. Default: on when a file hash is given. Pass `false` for
   * range requests, whose terms may start mid-file or be narrowed.
   */
  wholeFile?: boolean;
  /**
   * A chunk of a xorb the shard does not list fails (before it is yielded) instead of passing
   * unchecked. Default: on when a file hash is given and the shard lists every xorb of that
   * file's terms.
   */
  strict?: boolean;
}

/**
 * What a reconstruction checks, from a shard: the chunk hashes its CAS section lists (keyed ones
 * compared keyed), and the verification hashes of the file `fileHash`'s terms (File Info section),
 * a term of the answer matched to the file's term with the same xorb and chunk range, in order.
 *
 * Given a file hash, it is safe by default: the answer's term list must be the file's
 * (`wholeFile`), checked before anything is fetched, and chunks of xorbs the shard does not list
 * are refused (`strict`, when the shard lists the file's xorbs). A chunk past the end of a xorb
 * the shard lists fails either way. One verifier per reconstruction: it walks the file's terms
 * in order.
 */
export function verifierFromShard(
  shard: Shard,
  fileHash?: Uint8Array,
  o: ShardVerifierOptions = {},
): ReconstructionVerifier {
  if (shard.chunkHashesKeyed && (!shard.footer?.chunkHashKey || isZero(shard.footer.chunkHashKey)))
    throw new Error("shard: keyed chunk hashes without the footer key");
  const key = shard.chunkHashesKeyed ? shard.footer?.chunkHashKey : undefined;
  const xorbs = new Map(shard.xorbs.map((x) => [hashToString(x.xorbHash), x]));
  const file = fileHash
    ? shard.files.find((f) => f.fileHash.every((b, i) => b === fileHash[i]))
    : undefined;
  if (fileHash && !file) throw new Error("shard: the file is not in this shard");
  const wholeFile = o.wholeFile ?? file !== undefined;
  if (wholeFile && !file) throw new Error("shard: wholeFile needs the file's hash");
  const terms = (file?.terms ?? []).map((t) => ({ ...t, xorb: hashToString(t.xorbHash) }));
  const strict =
    o.strict ?? (file !== undefined && terms.length > 0 && terms.every((t) => xorbs.has(t.xorb)));
  const describe = (t: VerifiedTerm) => `xorb ${t.xorb} chunks ${t.start}-${t.end}`;
  /** how the answer's terms differ from the file's, or undefined when they are the same */
  const difference = (seen: VerifiedTerm[]): string | undefined => {
    if (seen.length !== terms.length)
      return `the answer has ${seen.length} terms, not the file's ${terms.length}`;
    for (let k = 0; k < seen.length; k++) {
      const s = seen[k] as VerifiedTerm;
      const t = terms[k] as (typeof terms)[number];
      if (s.xorb !== t.xorb || s.start !== t.start || s.end !== t.end)
        return `term ${k} of the answer (${describe(s)}) is not the file's (${describe(t)})`;
      if (!t.rangeHash && !xorbs.has(t.xorb))
        return `term ${k} of the file (${describe(t)}) has neither a verification hash nor its xorb's chunk hashes in the shard`;
    }
    return undefined;
  };
  let cursor = 0; // file terms already matched: an answer lists them in file order
  return {
    start: (seen) => {
      if (wholeFile) {
        const diff = difference(seen);
        if (diff) return diff;
      }
      if (strict) {
        const unknown = seen.find((t) => t.end > t.start && !xorbs.has(t.xorb));
        if (unknown) return `xorb ${unknown.xorb} is not in the shard`;
      }
      return undefined;
    },
    chunk: (xorb, index, hash) => {
      const x = xorbs.get(xorb.toLowerCase());
      if (!x) return strict ? false : undefined;
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
    done: wholeFile ? difference : undefined,
  };
}
