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
  let pending: Promise<XetToken> | undefined;
  const fresh = (t: XetToken) => !(t.exp > 0) || t.exp * 1000 - ahead > now();
  const renew = (signal?: AbortSignal) => {
    pending ??= fetchToken(signal).then(
      (t) => {
        current = t;
        pending = undefined;
        return t;
      },
      (e) => {
        pending = undefined;
        throw e;
      },
    );
    return pending;
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
