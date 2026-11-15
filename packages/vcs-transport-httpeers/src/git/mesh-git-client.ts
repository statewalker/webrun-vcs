/**
 * The git clients of `@statewalker/vcs-transport` (the fetch client, and push) through a peer
 * connection, with the membership token on every request.
 */

import {
  type FetchClientResult,
  type FetchOptions,
  fetch as gitFetch,
  push as gitPush,
  type HttpPushResult,
  type PushOptions,
} from "@statewalker/vcs-transport";
import { type MeshToken, peerFetch, type WebrunDuplex, withMeshToken } from "../peer/index.js";

/** How to reach a peer: a webrun caller `Duplex`, or a `fetchImpl` that already reaches it. */
export interface MeshRemote {
  /** A webrun caller `Duplex` to the peer (one Fetch exchange per call) */
  call?: WebrunDuplex;
  /** Or: a fetch that reaches the peer (an httpeers remote, a local edge) */
  fetchImpl?: (request: Request) => Promise<Response>;
  /** The membership token the hub minted for this peer */
  token: MeshToken;
  /**
   * The peer's origin: the only one the token goes to (default: the first request's). The git
   * helpers set it from their `url`.
   */
  origin?: string;
}

/** The `fetchImpl` for a {@link MeshRemote}. */
export function meshRemoteFetch(remote: MeshRemote): (request: Request) => Promise<Response> {
  const options = { origin: remote.origin };
  if (remote.call) return peerFetch(remote.call, remote.token, options);
  if (remote.fetchImpl) return withMeshToken(remote.fetchImpl, remote.token, options);
  throw new Error("a mesh remote needs a call (Duplex) or a fetchImpl");
}

/** Options of {@link meshGitFetch}: the fetch client's, and the peer. */
export type MeshGitFetchOptions = Omit<FetchOptions, "fetchImpl"> & MeshRemote;

/**
 * Fetches from a peer's repository (`git fetch` over smart HTTP through the peer connection):
 * protocol v2 negotiation, refspecs, shallow and tags as the fetch client does them. A refused
 * token throws (`Failed to get refs: 401` / `403`).
 *
 * @example
 * ```ts
 * await meshGitFetch({
 *   url: "http://peer-b/repo.git",
 *   call: connection.call,
 *   token,
 *   repository,
 *   refStore,
 *   refspecs: ["+refs/heads/*:refs/remotes/b/*"],
 * });
 * ```
 */
export function meshGitFetch(options: MeshGitFetchOptions): Promise<FetchClientResult> {
  const { call, fetchImpl, token, origin = options.url, ...rest } = options;
  return gitFetch({ ...rest, fetchImpl: meshRemoteFetch({ call, fetchImpl, token, origin }) });
}

/** Options of {@link meshGitPush}: push's, and the peer. */
export type MeshGitPushOptions = Omit<PushOptions, "fetchImpl"> & MeshRemote;

/**
 * Pushes to a peer's repository through the peer connection. Refs the peer refuses come back as
 * `ok: false` with git's reason (`not allowed: this peer writes refs/peers/<id>/* only`); a
 * caller without any write capability is refused with 403 (thrown).
 *
 * @example
 * ```ts
 * const result = await meshGitPush({
 *   url: "http://peer-b/repo.git",
 *   call: connection.call,
 *   token,
 *   refspecs: [`refs/heads/main:refs/peers/${myPeerId}/main`],
 *   getLocalRef: (ref) => refStore.get(ref),
 *   exportPack: (wants, exclude) => repository.exportPack(wants, exclude),
 * });
 * ```
 */
export function meshGitPush(options: MeshGitPushOptions): Promise<HttpPushResult> {
  const { call, fetchImpl, token, origin = options.url, ...rest } = options;
  return gitPush({ ...rest, fetchImpl: meshRemoteFetch({ call, fetchImpl, token, origin }) });
}
