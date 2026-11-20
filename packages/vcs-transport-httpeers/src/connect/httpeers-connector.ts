/**
 * Transport connectors for `httpeers://<peer>/<repo>` URLs: the remote commands of
 * `@statewalker/vcs-commands` (clone, fetch, push, ls-remote, pull) reach a mesh peer's
 * repository through the registry, as any other remote.
 *
 * - `mode: "http"` (default, scheme `httpeers`): smart HTTP over the mesh. Each request is a
 *   Fetch exchange on a webrun caller `Duplex` to the peer (`meshRemoteFetch`), or goes through
 *   a `fetchImpl` that already reaches peers (an httpeers member's `fetch`), with the
 *   membership token. The peer serves it with `meshGitHandler` behind `servePeerConnection`.
 * - `mode: "native"` (scheme `httpeers+git`): git's native protocol on an httpeers duplex
 *   stream (`openDuplex` of `@statewalker/httpeers-libp2p`), the token in the stream's open
 *   frame. The peer serves it with `meshGitDuplexHandler`.
 */

import {
  createDuplexConnector,
  type Duplex,
  type GitConnectRequest,
  type GitTransportConnector,
  TransportError,
  type WebrunDuplex,
  webrunClientDuplex,
} from "@statewalker/vcs-transport";
import { HTTPEERS_GIT_DUPLEX_PATH, meshRemoteFetch } from "../git/index.js";
import type { MeshToken } from "../peer/index.js";

/** The scheme of smart HTTP over the mesh: `httpeers://<peer>/<repo>`. */
export const HTTPEERS_SCHEME = "httpeers";
/** The scheme of git's native protocol over an httpeers stream: `httpeers+git://<peer>/<repo>`. */
export const HTTPEERS_NATIVE_SCHEME = "httpeers+git";

/**
 * The origin of the requests a `call` connector sends over its peer connection, unless
 * `peerUrl` says otherwise: the connection already leads to the peer, so the URL routes
 * nothing (the peer's handler sees the repository's path).
 */
export const HTTPEERS_CALL_ORIGIN = "http://httpeers.mesh";

/** Where a native session's stream goes: what {@link HttpeersConnectorOptions.openStream} is given. */
export interface HttpeersStreamTarget {
  /** The peer the URL names (its authority, case kept) */
  peer: string;
  /** The mount path the peer serves git on ({@link HttpeersConnectorOptions.streamPath}) */
  path: string;
  /** The membership token, for the stream's open frame */
  token?: string;
  /** The connect request (URL, service, protocol version) */
  request: GitConnectRequest;
}

/** A stream to a peer: its webrun caller, and how to release it (httpeers-libp2p's `PeerDuplex`). */
export interface HttpeersPeerStream {
  call: WebrunDuplex;
  close?(): Promise<void>;
}

/** Options of {@link createHttpeersConnector}. */
export interface HttpeersConnectorOptions {
  /** Names the connector (default `httpeers`, or `httpeers-native`) */
  name?: string;
  /** URL schemes it serves (default `["httpeers"]`, or `["httpeers+git"]` in native mode) */
  schemes?: readonly string[];
  /** Smart HTTP over Fetch exchanges (default), or git's native protocol over a stream */
  mode?: "http" | "native";
  /**
   * The membership token the hub minted for this peer, or a function returning a current one.
   * HTTP: sent (header `x-httpeers-token`) only to the peer's origin. Native: put in the
   * stream's open frame. Required with `call`.
   */
  token?: MeshToken;
  /** HTTP: the webrun caller `Duplex` of a connection to `peer` (Fetch exchanges over it) */
  call?(peer: string, request: GitConnectRequest): WebrunDuplex | Promise<WebrunDuplex>;
  /** HTTP: or a fetch that reaches peers by URL (an httpeers member's `fetch`) */
  fetchImpl?: (request: Request) => Promise<Response>;
  /**
   * HTTP: the URL of a peer's root, the repository's path appended. Required with `fetchImpl`
   * (through a member's edge, e.g. `http://local/<key>/<peer>`): a peer id is case-sensitive,
   * so it belongs in the path, never in a URL host (which URL parsing lower-cases). With
   * `call` the connection already leads to the peer, and the default, {@link HTTPEERS_CALL_ORIGIN},
   * only names the requests. The membership token goes only to this URL and below it.
   */
  peerUrl?(peer: string): string;
  /** HTTP: headers added to every request */
  headers?: Record<string, string>;
  /** Native: opens a stream to the peer (e.g. `openDuplex({ node, peerId: peer, path, token })`) */
  openStream?(
    target: HttpeersStreamTarget,
    options: { signal?: AbortSignal },
  ): WebrunDuplex | HttpeersPeerStream | Promise<WebrunDuplex | HttpeersPeerStream>;
  /** Native: the path the peer mounts its git handler on (default {@link HTTPEERS_GIT_DUPLEX_PATH}) */
  streamPath?: string;
  /** Native: most milliseconds `openStream` may take (default: no limit) */
  connectTimeout?: number;
}

/**
 * What a peer may be spelled with: letters and digits (libp2p peer ids are base58btc, or base32
 * / base36 multibase), and `-` / `_` for names a test or a local mesh gives its peers. Nothing
 * that could change a URL's meaning (`@`, `:`, `%`, `/`, `.`).
 */
const PEER_NAME = /^[A-Za-z0-9_-]+$/;

/** The peer and repository path of an httpeers URL, or git's error. */
function targetOf(request: GitConnectRequest): { peer: string; path: string } {
  const { host, path, raw, user, port } = request.url;
  if (!host) throw new TransportError(`fatal: no peer in '${raw}'`);
  // an httpeers URL names a peer, not a host: no `user@`, no `:port`
  if (user !== undefined || port !== undefined)
    throw new TransportError(
      `fatal: '${raw}' names a user or a port; httpeers URLs name a peer only`,
    );
  if (!PEER_NAME.test(host))
    throw new TransportError(`fatal: '${host}' in '${raw}' is not a peer id`);
  if (!path || path === "/") throw new TransportError(`fatal: no path specified in '${raw}'`);
  return { peer: host, path: path.startsWith("/") ? path : `/${path}` };
}

async function resolveToken(token: MeshToken | undefined): Promise<string | undefined> {
  if (token === undefined) return undefined;
  return typeof token === "function" ? await token() : token;
}

/** A transport duplex over `stream` that releases the stream once closed. */
function streamDuplex(stream: HttpeersPeerStream): Duplex {
  const duplex = webrunClientDuplex(stream.call);
  if (!stream.close) return duplex;
  const release = stream.close.bind(stream);
  let released = false;
  return {
    [Symbol.asyncIterator]: () => duplex[Symbol.asyncIterator](),
    write: (data) => duplex.write(data),
    end: () => duplex.end?.() ?? Promise.resolve(),
    close: async () => {
      await duplex.close?.();
      if (released) return;
      released = true;
      await release().catch(() => undefined);
    },
  };
}

/**
 * A connector for repositories of httpeers mesh peers.
 *
 * @example Smart HTTP over a peer connection
 * ```ts
 * const transports = createDefaultTransports();
 * transports.register(createHttpeersConnector({
 *   token: () => member.token(),                // the hub's membership token
 *   call: (peer) => connectionTo(peer).call,    // a webrun-streams caller to the peer
 * }));
 * const git = Git.fromWorkingCopy(workingCopy, { transports });
 * await git.clone().setURI("httpeers://12D3KooW.../notes.git").call();
 * ```
 *
 * @example Native protocol over httpeers-libp2p's duplex streams
 * ```ts
 * transports.register(createHttpeersConnector({
 *   mode: "native",
 *   token,
 *   openStream: ({ peer, path, token }) => openDuplex({ node, peerId: peer, path, token }),
 * }));
 * await git.fetch().setRemote("httpeers+git://12D3KooW.../notes.git").call();
 * ```
 */
export function createHttpeersConnector(options: HttpeersConnectorOptions): GitTransportConnector {
  if (options.mode === "native") return nativeConnector(options);
  const { call, fetchImpl, token, headers } = options;
  if (!call && !fetchImpl)
    throw new Error("createHttpeersConnector: give call or fetchImpl (or mode: native)");
  if (call && token === undefined)
    throw new Error("createHttpeersConnector: a call needs the membership token");
  if (!call && !options.peerUrl)
    throw new Error(
      "createHttpeersConnector: a fetchImpl needs peerUrl (the peer id in the path, e.g. http://local/<key>/<peer>)",
    );
  const peerUrl = options.peerUrl ?? (() => HTTPEERS_CALL_ORIGIN);
  return {
    name: options.name ?? "httpeers",
    schemes: options.schemes ?? [HTTPEERS_SCHEME],
    async connect(request) {
      const { peer, path } = targetOf(request);
      const baseUrl = `${peerUrl(peer).replace(/\/+$/, "")}${path}`;
      try {
        new URL(baseUrl);
      } catch {
        throw new TransportError(`fatal: '${request.url.raw}' names no reachable peer URL`);
      }
      let send: (request: Request) => Promise<Response>;
      if (call) {
        send = meshRemoteFetch({
          call: await call(peer, request),
          token: token as MeshToken,
          origin: baseUrl,
          scope: baseUrl,
        });
      } else if (token !== undefined) {
        // every peer behind one edge shares its origin: the token stays on this peer's path
        send = meshRemoteFetch({ fetchImpl, token, origin: baseUrl, scope: baseUrl });
      } else {
        send = fetchImpl as (request: Request) => Promise<Response>;
      }
      return {
        kind: "http",
        baseUrl,
        fetchImpl: send,
        ...(headers ? { headers: { ...headers } } : {}),
      };
    },
  };
}

function nativeConnector(options: HttpeersConnectorOptions): GitTransportConnector {
  const { openStream, token, connectTimeout } = options;
  if (!openStream) throw new Error("createHttpeersConnector: native mode needs openStream");
  const streamPath = options.streamPath ?? HTTPEERS_GIT_DUPLEX_PATH;
  return createDuplexConnector({
    name: options.name ?? "httpeers-native",
    schemes: options.schemes ?? [HTTPEERS_NATIVE_SCHEME],
    ...(connectTimeout !== undefined ? { connectTimeout } : {}),
    async open(request, { signal }) {
      const { peer } = targetOf(request);
      const resolved = await resolveToken(token);
      const opened = await openStream(
        { peer, path: streamPath, request, ...(resolved !== undefined ? { token: resolved } : {}) },
        signal ? { signal } : {},
      );
      return streamDuplex(typeof opened === "function" ? { call: opened } : opened);
    },
  });
}
