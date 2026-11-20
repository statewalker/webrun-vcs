/**
 * Pluggable transports: how a remote URL becomes a session with upload-pack or receive-pack.
 *
 * A connector turns a {@link GitConnectRequest} into a {@link GitSession}: either a byte
 * stream to a peer that speaks git's native protocol (a socket, a MessagePort, a WebSocket,
 * a libp2p stream), or a smart-HTTP endpoint reached through a `fetch` function. The registry
 * picks the connector for a URL; `openUploadPack` / `openReceivePack` open the protocol over
 * the session.
 */

import type { Credentials } from "../api/credentials.js";
import type { Duplex } from "../api/duplex.js";
import type { GitUrl } from "./git-url.js";

/** The service a session talks to. */
export type GitService = "git-upload-pack" | "git-receive-pack";

/** What a connector is asked to connect to. */
export interface GitConnectRequest {
  /** The remote URL, parsed */
  url: GitUrl;
  /** The service wanted */
  service: GitService;
  /**
   * The protocol asked for (git's `protocol.version`, default 2). receive-pack has no v2: a
   * push asks for v0 instead, as git does.
   */
  protocolVersion: 0 | 1 | 2;
  /**
   * The program the remote runs for the service (git's `--upload-pack` / `--receive-pack`,
   * `remote.<name>.uploadpack` / `receivepack`): what an ssh connector runs and git:// names
   * in its request line. Default: the service's name.
   */
  program?: string;
  /** Extra parameters for the server (git-daemon's `key=value` after the host) */
  extraParams?: Readonly<Record<string, string>>;
  /** Credentials, for transports that use them */
  credentials?: Credentials;
  /** Additional HTTP headers, for HTTP transports */
  headers?: Readonly<Record<string, string>>;
  /** Bounds each wait for the server, in milliseconds */
  timeout?: number;
  /** Aborts the connection */
  signal?: AbortSignal;
}

/**
 * A native session: a byte stream to a peer speaking git's pack protocol.
 *
 * - `"implicit"`: the peer already knows the service and repository (a stream opened for
 *   it, as an ssh channel running `git-upload-pack '<path>'`): it speaks first
 * - `"git-daemon"`: the peer expects git://'s request line first
 *   (`git-upload-pack <path>\0host=<host>\0`), as git-daemon does
 */
export interface GitNativeSession {
  kind: "native";
  duplex: Duplex;
  handshake: "git-daemon" | "implicit";
}

/** A smart-HTTP session: requests to `<baseUrl>/info/refs` and `<baseUrl>/git-*-pack`. */
export interface GitHttpSession {
  kind: "http";
  /** The repository's URL (`…/repo.git`) */
  baseUrl: string;
  /** How requests are sent */
  fetchImpl: (request: Request) => Promise<Response>;
  /** Headers added to every request */
  headers?: Record<string, string>;
}

/** What a connector returns: a native stream or a smart-HTTP endpoint. */
export type GitSession = GitNativeSession | GitHttpSession;

/**
 * A transport: the URLs it serves (by scheme, or by a predicate) and how it connects.
 *
 * @example
 * ```ts
 * const connector: GitTransportConnector = {
 *   name: "worker",
 *   schemes: ["worker"],
 *   async connect(req) {
 *     return { kind: "native", duplex: openPortTo(req.url.path, req.service), handshake: "implicit" };
 *   },
 * };
 * ```
 */
export interface GitTransportConnector {
  /** Names the connector (unregistering by name) */
  readonly name: string;
  /** URL schemes it serves (`GitUrl.scheme`, compared without case) */
  readonly schemes?: readonly string[];
  /** Whether it serves a URL its schemes do not name */
  matches?(url: GitUrl): boolean;
  /** Opens a session for the request */
  connect(request: GitConnectRequest): Promise<GitSession>;
}
