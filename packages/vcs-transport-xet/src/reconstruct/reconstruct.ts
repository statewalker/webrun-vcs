/**
 * File reconstruction: a file rebuilt, as a stream, from its CAS reconstruction answer.
 */

import { chunkHash, rangeHash } from "../hashes/index.js";
import { readXorbChunks } from "../xorb/index.js";
import type {
  FetchRange,
  ReconstructionAnswer,
  ReconstructionVerifier,
  VerifiedTerm,
} from "./types.js";
import { XetIntegrityError } from "./types.js";

/**
 * Rebuilds a file from a reconstruction answer: for each term, the fetch entry of its xorb that
 * covers its chunk range is fetched and decoded chunk by chunk, and the term's chunks are yielded;
 * `offset_into_first_range` bytes of the first term are dropped, and `length` (a range request's
 * length) truncates the last. The answer has v1's shape (`fetch_info`, `url_range` inclusive);
 * a v2 answer is turned into it by `v2ToV1`. `verify` checks chunks and
 * terms against a shard's hashes as they stream (`ReconstructionVerifier`).
 */
export async function* reconstruct(
  answer: ReconstructionAnswer,
  fetchRange: FetchRange,
  opts: { length?: number; verify?: ReconstructionVerifier } = {},
): AsyncGenerator<Uint8Array> {
  const verify = opts.verify;
  const fail = (message: string): never => {
    throw verify ? new XetIntegrityError(message) : new Error(message);
  };
  let skip = answer.offset_into_first_range;
  let left = opts.length ?? Number.POSITIVE_INFINITY;
  const seen: VerifiedTerm[] = [];
  type Term = ReconstructionAnswer["terms"][number];
  type Entry = ReconstructionAnswer["fetch_info"][string][number];
  const entryOf = (term: Term): Entry => {
    const entry = (answer.fetch_info[term.hash] ?? []).find(
      (f) => f.range.start <= term.range.start && term.range.end <= f.range.end,
    );
    if (!entry)
      throw new Error(
        `reconstruction: no fetch range for ${term.hash} ${term.range.start}-${term.range.end}`,
      );
    return entry;
  };
  /** a term being decoded: what it produced, its chunk hashes, its expected range hash */
  const open = (term: Term) => {
    const vt: VerifiedTerm = {
      xorb: term.hash.toLowerCase(),
      start: term.range.start,
      end: term.range.end,
    };
    seen.push(vt);
    return { term, vt, expected: verify?.rangeHash?.(vt), hashes: [] as Uint8Array[], produced: 0 };
  };
  /** a term's own checks, once its last chunk is decoded */
  const check = (t: ReturnType<typeof open>) => {
    if (t.produced !== t.term.unpacked_length)
      fail(
        `reconstruction: term ${t.term.hash} gave ${t.produced} bytes, expected ${t.term.unpacked_length}`,
      );
    if (t.expected) {
      const got = rangeHash(t.hashes);
      const want = t.expected;
      if (!got.every((b, k) => b === want[k]))
        fail(
          `reconstruction: term ${t.term.hash} ${t.term.range.start}-${t.term.range.end} does not match its verification hash`,
        );
    }
  };

  const terms = answer.terms;
  const empty = (t: Term) => t.range.end <= t.range.start;
  for (let first = 0; first < terms.length; ) {
    if (empty(terms[first] as Term)) {
      // no chunk to fetch: checked at once (its bytes, and its verification hash over none)
      check(open(terms[first] as Term));
      first++;
      continue;
    }
    // One fetch for the consecutive terms of one fetch entry whose chunk ranges go forward:
    // the entry's bytes are fetched once, not once per term. Forming the group
    // looks up the next terms' fetch entries, so an answer missing one is refused before the
    // group's bytes are yielded.
    const entry = entryOf(terms[first] as Term);
    let last = first;
    while (
      last + 1 < terms.length &&
      !empty(terms[last + 1] as Term) &&
      (terms[last + 1] as Term).hash === (terms[first] as Term).hash &&
      entryOf(terms[last + 1] as Term) === entry &&
      (terms[last + 1] as Term).range.start >= (terms[last] as Term).range.end
    )
      last++;
    let k = first;
    let current = open(terms[k] as Term);
    let index = entry.range.start;
    const bytes = fetchRange(entry.url, entry.url_range.start, entry.url_range.end);
    const upTo = (terms[last] as Term).range.end - entry.range.start;
    for await (const chunk of readXorbChunks(bytes, upTo)) {
      const i = index++;
      const inTerm = i >= current.term.range.start;
      if (verify?.chunk || (current.expected && inTerm)) {
        const h = chunkHash(chunk);
        if (verify?.chunk?.(current.vt.xorb, i, h) === false)
          fail(`reconstruction: chunk ${i} of xorb ${current.term.hash} is damaged`);
        if (inTerm) current.hashes.push(h);
      }
      if (!inTerm) continue; // before the term (its fetch range starts earlier, or a gap)
      current.produced += chunk.length;
      const endsTerm = i === current.term.range.end - 1;
      if (skip >= chunk.length) skip -= chunk.length;
      else {
        const piece = skip ? chunk.subarray(skip) : chunk;
        skip = 0;
        if (piece.length >= left) {
          yield piece.subarray(0, left);
          // ending exactly at the term's end: the term is whole, so it is checked (and, as the
          // reconstruction is whole up to `length`, `done` too)
          if (piece.length === left && endsTerm) {
            check(current);
            if (k === terms.length - 1) {
              const refused = verify?.done?.(seen);
              if (refused) fail(`reconstruction: ${refused}`);
            }
          }
          return;
        }
        left -= piece.length;
        yield piece;
      }
      if (endsTerm) {
        check(current);
        if (k === last) break;
        current = open(terms[++k] as Term);
      }
    }
    if (k !== last || current.produced < current.term.unpacked_length) check(current);
    first = last + 1;
  }
  const refused = verify?.done?.(seen);
  if (refused) fail(`reconstruction: ${refused}`);
}
