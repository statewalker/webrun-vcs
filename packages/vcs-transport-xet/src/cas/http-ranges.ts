/**
 * Xorb byte ranges over HTTP, retried and resumed.
 */

import type { FetchRange } from "../reconstruct/index.js";
import { discard } from "./hub.js";
import { type XetFetch, XetHttpError } from "./types.js";

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason);
    };
    // the listener goes with the pause: a long-lived signal does not collect one per retry
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/**
 * A `Retry-After` header's pause in milliseconds, up to a minute: delay-seconds or an HTTP date;
 * `undefined` when absent or unreadable.
 */
export function retryAfterMs(value?: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (/^\d+$/.test(v)) {
    const s = Number(v);
    return s > 0 ? Math.min(s, 60) * 1000 : undefined;
  }
  const date = Date.parse(v);
  if (Number.isNaN(date)) return undefined;
  return Math.min(Math.max(date - now, 0), 60_000);
}

export interface HttpRangesOptions {
  fetch?: XetFetch;
  /** failures in a row tried again (default 4); `minProgress` bytes between two resets it */
  retries?: number;
  /** failures tried again over one range, whatever the progress (default 64) */
  maxFailures?: number;
  /** the bytes between two failures that count as progress (default 64 KiB) */
  minProgress?: number;
  /** the first pause, doubled on each failure in a row (default 250 ms) */
  backoffMs?: number;
  signal?: AbortSignal;
  /**
   * A new URL for the range `start`…`end` of `url` once `url` is refused with 401 or 403 (a
   * signed URL that expired); `undefined` keeps the refusal. Asked again only after progress.
   */
  refreshUrl?: (url: string, start: number, end: number) => Promise<string | undefined>;
}

/**
 * Xorb byte ranges over HTTP (signed URLs need no token): `Range: bytes=start-end`, the body
 * streamed as it arrives. A failed request (network error, 429, 5xx), or a body that errors or
 * ends early, is tried again from the next byte not yet yielded, after a growing pause (or the
 * answer's `Retry-After`, seconds or an HTTP date, up to a minute), up to `retries` times without
 * `minProgress` bytes in between and `maxFailures` times in all. A server that ignores
 * `Range` (200) is read from the start, skipping what was yielded; a `Content-Range` that starts
 * elsewhere is refused.
 */
export function httpRanges(o: HttpRangesOptions = {}): FetchRange {
  const f = o.fetch ?? fetch;
  const retries = o.retries ?? 4;
  const backoff = o.backoffMs ?? 250;
  const maxFailures = o.maxFailures ?? 64;
  const minProgress = o.minProgress ?? 64 * 1024;
  return async function* (firstUrl, start, end) {
    let url = firstUrl;
    let at = start;
    let failures = 0; // in a row: since the last meaningful progress
    let total = 0; // over the whole range
    let mark = start; // where the last failure happened
    let refreshed = false;
    const again = async (why: unknown, retryAfter?: string | null) => {
      // a few bytes between failures is no progress: a peer cutting every few bytes must not
      // keep the count at zero forever
      if (at - mark >= minProgress) failures = 0;
      mark = at;
      if (++failures > retries || ++total > maxFailures)
        throw why instanceof Error ? why : new XetHttpError(`${url}: ${String(why)}`);
      await sleep(retryAfterMs(retryAfter) ?? backoff * 2 ** (failures - 1), o.signal);
    };
    while (at <= end) {
      let res: Response;
      try {
        res = await f(url, { headers: { range: `bytes=${at}-${end}` }, signal: o.signal });
      } catch (e) {
        if (o.signal?.aborted) throw e;
        await again(e);
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        await discard(res);
        await again(
          new XetHttpError(`${url}: HTTP ${res.status}`, res.status),
          res.headers.get("retry-after"),
        );
        continue;
      }
      if ((res.status === 401 || res.status === 403) && o.refreshUrl && !refreshed) {
        await discard(res);
        refreshed = true;
        const next = await o.refreshUrl(url, start, end);
        if (!next) throw new XetHttpError(`${url}: HTTP ${res.status}`, res.status);
        url = next;
        continue;
      }
      let skip = 0;
      if (res.status === 200)
        skip = at; // Range ignored: the whole object
      else if (res.status === 206) {
        const m = /^bytes (\d+)-/.exec(res.headers.get("content-range") ?? "");
        if (!m || Number(m[1]) !== at) {
          await discard(res);
          throw new XetHttpError(
            `${url}: answered another range (${res.headers.get("content-range")})`,
          );
        }
      } else {
        await discard(res);
        throw new XetHttpError(`${url}: HTTP ${res.status}`, res.status);
      }
      if (!res.body) {
        await again(new XetHttpError(`${url}: no body`));
        continue;
      }
      const reader = res.body.getReader();
      try {
        for (;;) {
          const r = await reader.read();
          if (r.done) break;
          let piece = r.value;
          if (skip) {
            const s = Math.min(skip, piece.length);
            piece = piece.subarray(s);
            skip -= s;
          }
          if (at + piece.length > end + 1) piece = piece.subarray(0, end + 1 - at);
          if (!piece.length) {
            if (at > end) break;
            continue;
          }
          at += piece.length;
          refreshed = false;
          yield piece;
          if (at > end) break;
        }
      } catch (e) {
        if (o.signal?.aborted) throw e;
        await again(e);
        continue;
      } finally {
        await reader.cancel().catch(() => {});
      }
      if (at <= end) await again(new XetHttpError(`${url}: body ended at byte ${at}`));
    }
  };
}
