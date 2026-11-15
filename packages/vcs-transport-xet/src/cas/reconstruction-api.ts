/**
 * The CAS reconstruction endpoint: `GET {casUrl}/v2/reconstructions/{file_hash}` (or the
 * deprecated v1), optionally with an HTTP `Range` for part of the file.
 */

import type { ReconstructionAnswer } from "../reconstruct/index.js";
import { discard, readJson } from "./hub.js";
import { isTokenSource, type XetTokenSource } from "./token-source.js";
import { type XetFetch, XetHttpError, type XetToken } from "./types.js";

/** the v2 answer: per xorb, a URL and its ranges (chunks, inclusive bytes) */
export interface ReconstructionAnswerV2 {
  offset_into_first_range: number;
  terms: ReconstructionAnswer["terms"];
  xorbs: Record<
    string,
    {
      url: string;
      ranges: { chunks: { start: number; end: number }; bytes: { start: number; end: number } }[];
    }[]
  >;
}

/** v2's `xorbs[].ranges[]` as v1's fetch entries (one per range, the same URL) */
export function v2ToV1(a: ReconstructionAnswerV2): ReconstructionAnswer {
  const fetch_info: ReconstructionAnswer["fetch_info"] = {};
  for (const [hash, entries] of Object.entries(a.xorbs))
    fetch_info[hash] = entries.flatMap((e) =>
      e.ranges.map((r) => ({ range: r.chunks, url: e.url, url_range: r.bytes })),
    );
  return { offset_into_first_range: a.offset_into_first_range, terms: a.terms, fetch_info };
}

/**
 * The reconstruction answer for a file hash, all of it or the bytes `range` (inclusive, as an
 * HTTP `Range`: the answer's terms then cover it, `offset_into_first_range` into the first).
 * v2 by default, as the specification asks, falling back to the deprecated v1 where v2 answers
 * 404 or 501; `version` forces one. With a token source, a token about to expire is renewed
 * first, and a 401 renews it and asks again, once.
 */
export async function fetchReconstruction(o: {
  token: XetToken | XetTokenSource;
  fileHash: string;
  range?: { start: number; end: number };
  version?: 1 | 2;
  fetch?: XetFetch;
  signal?: AbortSignal;
}): Promise<ReconstructionAnswer> {
  const f = o.fetch ?? fetch;
  const tokens = isTokenSource(o.token) ? o.token : undefined;
  let token = tokens ? await tokens.token(o.signal) : (o.token as XetToken);
  const once = (v: 1 | 2) => {
    const headers: Record<string, string> = { authorization: `Bearer ${token.accessToken}` };
    if (o.range) headers.range = `bytes=${o.range.start}-${o.range.end}`;
    return f(`${token.casUrl}/v${v}/reconstructions/${o.fileHash}`, { headers, signal: o.signal });
  };
  const ask = async (v: 1 | 2) => {
    let res = await once(v);
    if (res.status === 401 && tokens) {
      await discard(res);
      token = await tokens.refresh(token, o.signal);
      res = await once(v);
    }
    return res;
  };
  let v: 1 | 2 = o.version ?? 2;
  let res = await ask(v);
  if (o.version === undefined && (res.status === 404 || res.status === 501)) {
    await discard(res);
    v = 1;
    res = await ask(v);
  }
  if (res.status === 416) {
    await discard(res);
    throw new XetHttpError("reconstruction: range not satisfiable", 416);
  }
  const body = await readJson<ReconstructionAnswer | ReconstructionAnswerV2>(res, "reconstruction");
  return v === 2 ? v2ToV1(body as ReconstructionAnswerV2) : (body as ReconstructionAnswer);
}
