/**
 * A peer connection: Fetch exchanges over a webrun `Duplex` (`@statewalker/webrun-http-streams`),
 * with the mesh's two headers handled at the edges. The serving side stamps each request with the
 * peer its transport proved (and drops whatever the caller claimed); the calling side adds its
 * membership token (and never claims an identity itself).
 */

import {
  MESH_TOKEN_HEADER,
  PEER_ID_HEADER,
  registerAnonymous,
  registerPeer,
} from "@statewalker/httpeers-core";
import { fetchOverDuplex, serveFetchOverDuplex } from "@statewalker/webrun-http-streams";
import type { Duplex as WebrunDuplex } from "@statewalker/webrun-streams";
import type { MeshHandler } from "../access/index.js";

export type { WebrunDuplex };

/** A membership token, or where to get a current one (called per request). */
export type MeshToken = string | (() => string | Promise<string>);

/** Options of {@link servePeerConnection}. */
export interface ServePeerConnectionOptions {
  /**
   * The peer at the other end, as the transport proved it (a libp2p handshake, a signed
   * session). `undefined`: an anonymous caller, refused by every handler that needs a token.
   */
  remotePeer: string | undefined;
}

/**
 * The serving end of one peer connection: a webrun `Duplex` running `handler` (a
 * `meshGitHandler`, a `meshLfsHandler`, or both behind a router) for each Fetch exchange. Every
 * request is bound to `remotePeer` before the handler sees it, replacing any peer header the
 * caller sent.
 *
 * @example
 * ```ts
 * const duplex = servePeerConnection(meshGitHandler({ repository, refStore, access }), {
 *   remotePeer: provenPeerId,
 * });
 * await serve(params, duplex); // any webrun-streams adapter
 * ```
 */
export function servePeerConnection(
  handler: MeshHandler,
  options: ServePeerConnectionOptions,
): WebrunDuplex {
  return serveFetchOverDuplex(async (incoming: Request) => {
    const request = new Request(incoming, {
      headers: new Headers(incoming.headers),
      duplex: "half",
    } as RequestInit);
    if (options.remotePeer === undefined) registerAnonymous(request);
    else registerPeer(request, options.remotePeer);
    return handler(request);
  });
}

/**
 * Adds the membership token to every request of `fetchImpl` (and removes any peer header: an
 * identity is proven by the transport, never claimed).
 */
export function withMeshToken(
  fetchImpl: (request: Request) => Promise<Response>,
  token: MeshToken,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const headers = new Headers(request.headers);
    headers.delete(PEER_ID_HEADER);
    headers.set(MESH_TOKEN_HEADER, typeof token === "function" ? await token() : token);
    return fetchImpl(new Request(request, { headers, duplex: "half" } as RequestInit));
  };
}

/**
 * The calling end of one peer connection: a `fetchImpl` for the git and LFS clients that runs
 * each request over `call` (a webrun caller `Duplex`) with the membership token.
 *
 * @example
 * ```ts
 * const fetchImpl = peerFetch(connection.call, token);
 * await fetch({ url: "http://peer/repo.git", fetchImpl, repository, refStore });
 * ```
 */
export function peerFetch(
  call: WebrunDuplex,
  token: MeshToken,
): (request: Request) => Promise<Response> {
  return withMeshToken((request) => fetchOverDuplex(call, request), token);
}
