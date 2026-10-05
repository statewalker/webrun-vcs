/**
 * webrun-http-streams transport adapter.
 *
 * Runs the git smart-HTTP protocol over a `@statewalker/webrun-streams`
 * functional `Duplex` instead of a network `fetch`. It composes two existing
 * pieces unchanged:
 *  - the server's Fetch-API handler (`createFetchHandler`), wrapped as a webrun
 *    `Duplex` by `serveFetchOverDuplex`, and
 *  - `fetchOverDuplex`, which runs a Fetch `Request` over a webrun `Duplex`,
 *    exposed as a `fetchImpl` the client HTTP operations accept.
 *
 * Smart-HTTP is stateless request/response (GET /info/refs, then
 * POST /git-upload-pack | /git-receive-pack), so each client request is one
 * independent webrun `Duplex` exchange; the server `Duplex` is reusable across
 * them — no network port.
 */

import { fetchOverDuplex, serveFetchOverDuplex } from "@statewalker/webrun-http-streams";
import type { Duplex as WebrunDuplex } from "@statewalker/webrun-streams";
import { createFetchHandler, type HttpHandlerOptions } from "../http/http-server.js";

export type { WebrunDuplex };

/**
 * Builds a webrun `Duplex` that serves the git smart-HTTP endpoints for the
 * given repository resolver. Register it with any `webrun-streams-*` adapter's
 * `serve`, or — for an in-process loopback — pass it straight to
 * {@link webrunHttpFetch}.
 *
 * @param options - The same `HttpHandlerOptions` `createFetchHandler` takes.
 * @returns A webrun `Duplex` serving `/info/refs` + `/git-upload-pack` +
 *   `/git-receive-pack`.
 */
export function serveGitOverWebrunHttp(options: HttpHandlerOptions): WebrunDuplex {
  return serveFetchOverDuplex(createFetchHandler(options));
}

/**
 * Adapts a webrun `Duplex` into a `fetchImpl` for the client HTTP operations
 * (`fetch`, `lsRemote`, `push`, `clone`). Each returned `(request) => Response`
 * call runs one Fetch exchange over the `Duplex`.
 *
 * @param call - A webrun caller `Duplex` (e.g. `connect(...).call`, or — for an
 *   in-process loopback — the server `Duplex` from {@link serveGitOverWebrunHttp}).
 * @returns A `(Request) => Promise<Response>` to pass as `fetchImpl`.
 */
export function webrunHttpFetch(call: WebrunDuplex): (request: Request) => Promise<Response> {
  return (request) => fetchOverDuplex(call, request);
}
