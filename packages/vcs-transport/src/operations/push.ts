/**
 * Push over smart HTTP.
 */

import type { BaseHttpOptions } from "../api/options.js";
import {
  openHttpReceivePackConnection,
  type PushClientOptions,
  type PushClientResult,
  pushToConnection,
} from "../push-client/index.js";

/** Options of {@link push}: the remote (URL, credentials) and what to push. */
export interface PushOptions extends BaseHttpOptions, PushClientOptions {
  /**
   * Stream the request body (default: outside browsers, where supported); `false` sends it
   * collected, with a `Content-Length`, for servers and proxies that refuse chunked requests
   * (see `HttpReceivePackOptions.streamRequestBody`)
   */
  streamRequestBody?: boolean;
  /** Aborts the push */
  signal?: AbortSignal;
}

/**
 * Pushes to a smart-HTTP remote, as `git push` over remote-curl: `GET
 * info/refs?service=git-receive-pack`, then one `POST git-receive-pack` with the commands and
 * a thin pack streamed as it is written, and the report read as it arrives (side-band
 * keep-alives included). Each ref is checked first as git does (see {@link pushToConnection}):
 * refused refs are in the result, never sent.
 *
 * Throws on refspec errors, transport errors (401/403 are an `AuthenticationError`) and
 * protocol errors. `options.timeout` bounds each wait for the server, not the whole push.
 *
 * @example
 * ```ts
 * const result = await push({
 *   url: "https://example.com/repo.git",
 *   auth: { token },
 *   repository,
 *   refStore,
 *   refspecs: ["main", "+refs/heads/topic:refs/heads/topic", ":refs/heads/old"],
 * });
 * for (const u of result.updates) console.log(u.summary, u.remoteRef);
 * ```
 */
export async function push(options: PushOptions): Promise<PushClientResult> {
  const connection = await openHttpReceivePackConnection(options);
  try {
    return await pushToConnection(connection, options);
  } finally {
    await connection.close();
  }
}
