/**
 * A peer connection: Fetch exchanges over a webrun `Duplex` (`@statewalker/webrun-http-streams`),
 * with the mesh's two headers handled at the edges. The serving side binds each request to the
 * peer its transport proved (and drops whatever the caller claimed); the calling side adds its
 * membership token, only for the remote's own origin, and never claims an identity itself.
 */

import { MESH_TOKEN_HEADER, PEER_ID_HEADER } from "@statewalker/httpeers-core";
import { fetchOverDuplex, serveFetchOverDuplex } from "@statewalker/webrun-http-streams";
import type { Duplex as WebrunDuplex } from "@statewalker/webrun-streams";
import { bindProvenPeer, type MeshHandler } from "../access/index.js";

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
 * request is bound to `remotePeer` (`bindProvenPeer`) before the handler sees it, replacing any
 * peer header the caller sent.
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
    bindProvenPeer(request, options.remotePeer);
    return handler(request);
  });
}

/** Options of {@link withMeshToken}. */
export interface MeshTokenOptions {
  /**
   * The remote's origin (`http://peer-b`, or any URL on it): the only origin the token goes to.
   * Default: the origin of the first request.
   */
  origin?: string;
  /**
   * Narrows where the token goes to one base URL on that origin (a repository's
   * `http://local/<key>/<peer>/repo.git`, which shares its origin with every other peer behind
   * the same edge): only requests to that path or below it carry the token, and a redirect
   * leaving it throws {@link MeshRedirectError}. Its origin is the pinned one when `origin` is
   * not given. Default: the whole origin.
   */
  scope?: string;
  /** Same-origin redirects followed at most (default 5); a redirect to another origin throws */
  maxRedirects?: number;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** Thrown for a redirect the mesh client does not follow (another origin, or too many). */
export class MeshRedirectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MeshRedirectError";
  }
}

/**
 * Adds the membership token to the requests of `fetchImpl` that go to the remote's origin
 * (`options.origin`, default the first request's), and removes any peer header from all of them:
 * an identity is proven by the transport, never claimed. Redirects are not left to `fetchImpl`
 * (`redirect: "manual"`): a same-origin redirect of a request without a body is followed, with
 * the token; a redirect to another origin (or out of `scope`) throws {@link MeshRedirectError},
 * so the token never follows one.
 */
export function withMeshToken(
  fetchImpl: (request: Request) => Promise<Response>,
  token: MeshToken,
  options: MeshTokenOptions = {},
): (request: Request) => Promise<Response> {
  const scope = options.scope === undefined ? undefined : new URL(options.scope);
  let pinned = options.origin !== undefined ? new URL(options.origin).origin : scope?.origin;
  // the scope's path without a trailing slash: the path itself, or anything below it
  const scopePath = scope?.pathname.replace(/\/+$/, "");
  const inScope = (url: URL) =>
    url.origin === pinned &&
    (scope === undefined ||
      (url.origin === scope.origin &&
        (url.pathname === scopePath || url.pathname.startsWith(`${scopePath}/`))));
  const maxRedirects = options.maxRedirects ?? 5;
  return async (request) => {
    pinned ??= new URL(request.url).origin;
    let current = request;
    for (let hops = 0; ; hops++) {
      const headers = new Headers(current.headers);
      headers.delete(PEER_ID_HEADER);
      headers.delete(MESH_TOKEN_HEADER);
      if (inScope(new URL(current.url)))
        headers.set(MESH_TOKEN_HEADER, typeof token === "function" ? await token() : token);
      const res = await fetchImpl(
        new Request(current, { headers, redirect: "manual", duplex: "half" } as RequestInit),
      );
      if (!REDIRECTS.has(res.status)) return res;
      const location = res.headers.get("location");
      if (location === null) return res;
      void res.body?.cancel().catch(() => {});
      const target = new URL(location, current.url);
      const from = new URL(current.url).origin;
      if (target.origin !== from)
        throw new MeshRedirectError(
          `refused a redirect from ${from} to another origin (${target.origin})`,
        );
      if (scope !== undefined && inScope(new URL(current.url)) && !inScope(target))
        throw new MeshRedirectError(
          `refused a redirect from ${current.url} out of ${scope.href} (${target.href})`,
        );
      if (hops >= maxRedirects) throw new MeshRedirectError(`more than ${maxRedirects} redirects`);
      const bodiless = current.method === "GET" || current.method === "HEAD";
      if (!bodiless && res.status !== 303)
        throw new MeshRedirectError(
          `cannot follow a ${res.status} redirect of a ${current.method}`,
        );
      current = new Request(target, {
        method: bodiless ? current.method : "GET",
        headers: current.headers,
        signal: current.signal,
      });
    }
  };
}

/**
 * The calling end of one peer connection: a `fetchImpl` for the git and LFS clients that runs
 * each request over `call` (a webrun caller `Duplex`) with the membership token.
 *
 * @example
 * ```ts
 * const fetchImpl = peerFetch(connection.call, token, { origin: "http://peer-b" });
 * await fetch({ url: "http://peer-b/repo.git", fetchImpl, repository, refStore });
 * ```
 */
export function peerFetch(
  call: WebrunDuplex,
  token: MeshToken,
  options: MeshTokenOptions = {},
): (request: Request) => Promise<Response> {
  return withMeshToken((request) => fetchOverDuplex(call, request), token, options);
}
