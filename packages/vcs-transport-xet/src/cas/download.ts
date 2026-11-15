/**
 * A Hub file stored with Xet, streamed: path info, a read token, the reconstruction answer, and
 * the xorb ranges, chained into `reconstruct`.
 */

import { type ReconstructionVerifier, reconstruct } from "../reconstruct/index.js";
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
  /** the file's Xet hash, when known: `paths-info` is not asked */
  xetHash?: string;
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
 */
export async function* downloadXetFile(
  r: RepoRef,
  path: string,
  o: DownloadXetFileOptions = {},
): AsyncGenerator<Uint8Array> {
  let fileHash = o.xetHash;
  if (!fileHash) {
    const info = await hubPathInfo(r, path, { signal: o.signal });
    if (!info.xetHash) throw new XetHttpError(`${path}: not stored with Xet`);
    fileHash = info.xetHash;
  }
  const tokens = o.tokens ?? hubReadTokens(r);
  const ask = () =>
    fetchReconstruction({
      token: tokens,
      fileHash: fileHash as string,
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
  const length = o.range ? o.range.end - o.range.start + 1 : undefined;
  yield* reconstruct(
    answer,
    httpRanges({
      fetch: r.fetch,
      retries: o.retries,
      backoffMs: o.backoffMs,
      signal: o.signal,
      refreshUrl,
    }),
    { length, verify: o.verify },
  );
}
