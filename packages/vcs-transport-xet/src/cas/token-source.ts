/**
 * CAS tokens that renew themselves: a token is fetched when first needed, fetched again shortly
 * before it expires, and on demand after the CAS refuses it (401).
 */

import { xetReadToken } from "./hub.js";
import type { RepoRef, XetToken } from "./types.js";

export interface XetTokenSource {
  /** a token valid for at least the refresh margin (the cached one, or a new one) */
  token(signal?: AbortSignal): Promise<XetToken>;
  /**
   * A new token, after `stale` was refused. When another caller has already replaced `stale`,
   * its replacement is returned; concurrent callers share one request.
   */
  refresh(stale?: XetToken, signal?: AbortSignal): Promise<XetToken>;
}

export interface XetTokenSourceOptions {
  /** renew this many seconds before `exp` (default 60) */
  refreshAheadSec?: number;
  /** the clock, in milliseconds (default `Date.now`) */
  now?: () => number;
}

/**
 * A token source over `fetchToken`. A token whose `exp` is 0 or missing is kept until refused.
 */
export function xetTokenSource(
  fetchToken: (signal?: AbortSignal) => Promise<XetToken>,
  o: XetTokenSourceOptions = {},
): XetTokenSource {
  const ahead = (o.refreshAheadSec ?? 60) * 1000;
  const now = o.now ?? Date.now;
  let current: XetToken | undefined;
  /**
   * The shared request: its own controller, not any caller's signal (one caller giving up must not
   * fail the others); aborted only when every caller waiting for it has given up.
   */
  type Pending = { promise: Promise<XetToken>; controller: AbortController; waiters: number };
  let pending = undefined as Pending | undefined;
  const fresh = (t: XetToken) => !(t.exp > 0) || t.exp * 1000 - ahead > now();
  const renew = (signal?: AbortSignal): Promise<XetToken> => {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (!pending) {
      const controller = new AbortController();
      const p: Pending = {
        controller,
        waiters: 0,
        promise: fetchToken(controller.signal).then(
          (t) => {
            if (pending === p) {
              current = t;
              pending = undefined;
            }
            return t;
          },
          (e) => {
            if (pending === p) pending = undefined;
            throw e;
          },
        ),
      };
      p.promise.catch(() => {}); // a request every caller left is not an unhandled rejection
      pending = p;
    }
    const p = pending;
    p.waiters++;
    if (!signal)
      return p.promise.finally(() => {
        p.waiters--;
      });
    return new Promise<XetToken>((resolve, reject) => {
      let done = false;
      const leave = () => {
        if (done) return false;
        done = true;
        p.waiters--;
        signal.removeEventListener("abort", onAbort);
        return true;
      };
      const onAbort = () => {
        if (!leave()) return;
        if (p.waiters === 0) {
          p.controller.abort(signal.reason);
          if (pending === p) pending = undefined;
        }
        reject(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      p.promise.then(
        (t) => {
          if (leave()) resolve(t);
        },
        (e) => {
          if (leave()) reject(e);
        },
      );
    });
  };
  return {
    token: (signal) => (current && fresh(current) ? Promise.resolve(current) : renew(signal)),
    refresh: (stale, signal) =>
      current && stale && current !== stale && fresh(current)
        ? Promise.resolve(current)
        : renew(signal),
  };
}

/** read tokens of a Hub repository (`xetReadToken`), renewed as `xetTokenSource` does */
export const hubReadTokens = (r: RepoRef, o: XetTokenSourceOptions = {}): XetTokenSource =>
  xetTokenSource((signal) => xetReadToken(r, { signal }), o);

/** whether `t` is a token source rather than a fixed token */
export const isTokenSource = (t: XetToken | XetTokenSource): t is XetTokenSource =>
  typeof (t as XetTokenSource).token === "function";
