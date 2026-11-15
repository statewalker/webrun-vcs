/**
 * Fetch over smart HTTP.
 */

import type { BaseHttpOptions } from "../api/options.js";
import {
  type FetchClientOptions,
  type FetchClientResult,
  fetchFromConnection,
  openHttpConnection,
} from "../fetch-client/index.js";

/** Options of {@link fetch}: the remote (URL, credentials) and what to fetch. */
export interface FetchOptions extends BaseHttpOptions, FetchClientOptions {
  /** 2 (default): protocol v2, falling back to v0 when the server does not speak it. 0: v0. */
  protocolVersion?: 0 | 2;
  /** Aborts the fetch */
  signal?: AbortSignal;
  /**
   * Send upload-pack request bodies over 1024 bytes (large have-batches) gzipped, with
   * `Content-Encoding: gzip`, as git's remote-curl does (default true). Set false where that
   * header cannot go: `Content-Encoding` is not a CORS-safelisted request header, so a browser
   * behind a CORS proxy that does not allow it fails the preflight.
   */
  gzipRequests?: boolean;
}

/**
 * Fetches from a smart-HTTP remote into `repository`/`refStore`, as `git fetch` over
 * remote-curl: protocol v2 (`Git-Protocol: version=2`, `ls-refs`, stateless `fetch`
 * rounds) when the server answers it, v0 otherwise; git's negotiation, so an incremental
 * fetch sends only what the remote lacks; shallow and deepen options; tag auto-follow; and
 * per-ref fast-forward checks (see {@link fetchFromConnection}).
 *
 * The pack goes into `repository.importPack` as it arrives. Throws on transport and protocol
 * errors (an HTTP failure, `ERR`, a missing pack); `options.timeout` bounds each wait for
 * the server, not the whole fetch.
 *
 * @example
 * ```ts
 * const result = await fetch({
 *   url: "https://example.com/repo.git",
 *   repository,
 *   refStore,
 *   refspecs: ["+refs/heads/*:refs/remotes/origin/*"],
 * });
 * for (const u of result.refUpdates) console.log(u.summary, u.localRef);
 * ```
 */
export async function fetch(options: FetchOptions): Promise<FetchClientResult> {
  const connection = await openHttpConnection(options);
  try {
    return await fetchFromConnection(connection, options);
  } finally {
    await connection.close();
  }
}
