/**
 * A Hub file stored with Xet, streamed: path info, a read token, the reconstruction answer, and
 * the xorb ranges, chained into `reconstruct`.
 */

import { type ChunkRef, chunkHash, fileHash, hashToString } from "../hashes/index.js";
import {
  type ReconstructionVerifier,
  reconstruct,
  XetIntegrityError,
} from "../reconstruct/index.js";
import { httpRanges } from "./http-ranges.js";
import { hubPathInfo } from "./hub.js";
import { fetchReconstruction } from "./reconstruction-api.js";
import { hubReadTokens, type XetTokenSource } from "./token-source.js";
import { type RepoRef, XetHttpError } from "./types.js";

export interface DownloadXetFileOptions {
  /** the bytes `start`…`end` (inclusive) instead of the whole file */
  range?: { start: number; end: number };
  /** the reconstruction API version (default: v2, v1 where v2 is missing) */
  version?: 1 | 2;
  /** checks chunks and terms as they stream (`verifierFromShard`) */
  verify?: ReconstructionVerifier;
  /**
   * For a whole file (no `range`): its Xet file hash, recomputed from the decoded chunks, and its
   * size are checked when the last byte is out (default true; only `false` turns it off).
   */
  verifyFile?: boolean;
  /** the file's Xet hash, when known: `paths-info` is not asked */
  xetHash?: string;
  /** the file's size, when known (from `paths-info` otherwise); checked with `verifyFile` */
  size?: number;
  /** CAS tokens (default `hubReadTokens(repo)`: renewed before expiry and after a 401) */
  tokens?: XetTokenSource;
  retries?: number;
  backoffMs?: number;
  signal?: AbortSignal;
}

/**
 * A file of a Hub repository (stored with Xet) streamed: its path info, a read token, the
 * reconstruction answer (all of it, or `range`), and the xorb ranges fetched with retries and
 * resumed. A xorb URL refused with 401/403 (a signed URL that expired during a long download) is
 * replaced from a new reconstruction answer, asked with a renewed token.
 *
 * A whole file is checked against its Xet hash (the Merkle root of its chunk hashes) and its size
 * by default, with nothing but the hash `paths-info` gave: a mismatch throws `XetIntegrityError`
 * at the end. The output is therefore provisional until the generator completes: write it
 * somewhere temporary and commit it only when the loop ends without an error. `verify` (a shard's
 * hashes) adds checks per chunk, before each is yielded, and per term. A `range` download is
 * checked only by `verify`.
 */
export async function* downloadXetFile(
  r: RepoRef,
  path: string,
  o: DownloadXetFileOptions = {},
): AsyncGenerator<Uint8Array> {
  let xetHash = o.xetHash;
  let size = o.size;
  if (!xetHash) {
    const info = await hubPathInfo(r, path, { signal: o.signal });
    if (!info.xetHash) throw new XetHttpError(`${path}: not stored with Xet`);
    xetHash = info.xetHash;
    size ??= info.size;
  }
  const tokens = o.tokens ?? hubReadTokens(r);
  const ask = () =>
    fetchReconstruction({
      token: tokens,
      fileHash: xetHash as string,
      range: o.range,
      version: o.version,
      fetch: r.fetch,
      signal: o.signal,
    });
  const answer = await ask();
  // which xorb each URL serves, to find its replacement in a newer answer
  const xorbOf = new Map<string, string>();
  for (const [xorb, entries] of Object.entries(answer.fetch_info))
    for (const e of entries) xorbOf.set(e.url, xorb);
  const refreshUrl = async (url: string, start: number, end: number) => {
    const xorb = xorbOf.get(url);
    if (!xorb) return undefined;
    const fresh = await ask();
    const e = (fresh.fetch_info[xorb] ?? []).find(
      (x) => x.url_range.start === start && x.url_range.end === end,
    );
    if (e) xorbOf.set(e.url, xorb);
    return e?.url;
  };
  const checkFile = !o.range && o.verifyFile !== false;
  const chunks: ChunkRef[] = [];
  let total = 0;
  const length = o.range ? o.range.end - o.range.start + 1 : undefined;
  for await (const piece of reconstruct(
    answer,
    httpRanges({
      fetch: r.fetch,
      retries: o.retries,
      backoffMs: o.backoffMs,
      signal: o.signal,
      refreshUrl,
    }),
    {
      length,
      verify: o.verify,
      onChunk: checkFile
        ? (c) => {
            chunks.push({ hash: chunkHash(c), length: c.length });
          }
        : undefined,
    },
  )) {
    total += piece.length;
    yield piece;
  }
  if (!checkFile) return;
  if (size !== undefined && total !== size)
    throw new XetIntegrityError(`${path}: ${total} bytes, the file's size is ${size}`);
  const got = hashToString(fileHash(chunks));
  if (got !== xetHash.toLowerCase())
    throw new XetIntegrityError(`${path}: the bytes hash to ${got}, not the file's ${xetHash}`);
}
