/**
 * The shapes of a CAS reconstruction answer (https://huggingface.co/docs/xet/api) and what a
 * reconstruction checks as it streams.
 */

export interface ReconstructionAnswer {
  /** bytes to drop from the first term's output (a range request) */
  offset_into_first_range: number;
  terms: { hash: string; unpacked_length: number; range: { start: number; end: number } }[];
  fetch_info: Record<
    string,
    {
      range: { start: number; end: number };
      url: string;
      /** inclusive byte range of the xorb holding chunks `range` */
      url_range: { start: number; end: number };
    }[]
  >;
}
/** fetches bytes `start`…`end` (inclusive) of `url`, as they arrive */
export type FetchRange = (url: string, start: number, end: number) => AsyncIterable<Uint8Array>;

/** a chunk or a term whose bytes are not those its hash names */
export class XetIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XetIntegrityError";
  }
}

/** a term of the answer as the verifier sees it */
export interface VerifiedTerm {
  /** the xorb hash, lower case */
  xorb: string;
  start: number;
  end: number;
}

/**
 * What a reconstruction checks as it goes. The answer carries no hashes;
 * they come from a shard (`verifierFromShard`): the xorbs' chunk hashes (CAS section) and the
 * file's term verification hashes (File Info section).
 */
export interface ReconstructionVerifier {
  /**
   * Is `hash` (the decoded chunk's) the expected one for chunk `index` of `xorb` (lower case)?
   * `false` stops the reconstruction; `undefined`: not known, unchecked. Asked before the chunk
   * is yielded, so a damaged chunk stops the stream there, chunks before the term's first too.
   */
  chunk?: (xorb: string, index: number, hash: Uint8Array) => boolean | undefined;
  /**
   * The expected verification hash of a term (the plain hashes of its chunks, concatenated and
   * keyed with the verification key), or `undefined` (unchecked). Matched by the term's xorb and
   * chunk range, not by its position: a range request starts mid-file, and the server may split
   * a file's terms otherwise. Checked when the term's last chunk is decoded.
   */
  rangeHash?: (term: VerifiedTerm) => Uint8Array | undefined;
  /**
   * After the last term of a reconstruction that ran to the end (not cut short by `length`
   * inside a term): the terms it had. Throw (or return a message) to refuse it: a verifier that
   * knows the whole file can require all of it.
   */
  done?: (terms: VerifiedTerm[]) => string | undefined;
}
