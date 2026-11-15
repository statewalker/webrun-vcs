/**
 * Where a workspace syncs to: a repository reached over smart HTTP (a server, or a peer through
 * an httpeers mesh, whose connection is just another `fetchImpl`) or over a duplex stream.
 * Both run the transport's own clients: the fetch client (git's fetch-pack) and the push client
 * (git's send-pack).
 */

import {
  type Credentials,
  type Duplex,
  type FetchClientResult,
  fetchOverDuplex,
  fetch as fetchOverHttp,
  type PushClientResult,
  pushOverDuplex,
  push as pushOverHttp,
  type RefStore,
  type RepositoryFacade,
} from "@statewalker/vcs-transport";

/** What a remote's fetch and push are given. */
export interface SyncTransferOptions {
  repository: RepositoryFacade;
  refStore: RefStore;
  refspecs: string[];
  signal?: AbortSignal;
}

/** A repository a workspace syncs with. */
export interface SyncRemote {
  /** Names the remote-tracking ref (`refs/remotes/<name>/<branch>`) */
  readonly name: string;
  /** Fetches with git's fetch-pack; throws on transport and protocol errors */
  fetch(options: SyncTransferOptions): Promise<FetchClientResult>;
  /** Pushes with git's send-pack, never forced; refused refs are in the result, not thrown */
  push(options: SyncTransferOptions): Promise<PushClientResult>;
}

/** Options of {@link httpRemote}. */
export interface HttpRemoteOptions {
  /** The repository URL (`https://host/repo.git`) */
  url: string;
  /** Names the remote-tracking ref (default `origin`) */
  name?: string;
  /** Credentials for the server */
  auth?: Credentials;
  /** Extra request headers */
  headers?: Record<string, string>;
  /**
   * How requests reach the server (default: the global `fetch`). An httpeers peer connection
   * plugs in here: `meshRemoteFetch({ call, token })` of `@statewalker/vcs-transport-httpeers`.
   */
  fetchImpl?: (request: Request) => Promise<Response>;
  /** Bounds each wait for the server (ms) */
  timeout?: number;
}

/**
 * A repository over smart HTTP.
 *
 * @example
 * ```ts
 * const origin = httpRemote({ url: "https://example.com/notes.git", auth: { token } });
 * // through an httpeers mesh
 * const peer = httpRemote({ url: "http://hub.mesh/notes.git", fetchImpl: meshRemoteFetch({ call, token }) });
 * ```
 */
export function httpRemote(options: HttpRemoteOptions): SyncRemote {
  const { name = "origin", ...http } = options;
  return {
    name,
    fetch: (o) => fetchOverHttp({ ...http, ...o, tags: "none", missingRefsOk: true }),
    push: (o) => pushOverHttp({ ...http, ...o }),
  };
}

/** The git service a duplex connection is opened for. */
export type GitService = "git-upload-pack" | "git-receive-pack";

/** Options of {@link duplexRemote}. */
export interface DuplexRemoteOptions {
  /**
   * Opens a fresh connection to the remote, whose other end serves `service` (for example
   * `createSyncServer(...).serve(duplex, service)`); it is closed when the fetch or push ends.
   */
  connect(service: GitService): Duplex | Promise<Duplex>;
  /** Names the remote-tracking ref (default `origin`) */
  name?: string;
  /** Bounds each wait for the server during a push (ms) */
  timeout?: number;
}

/**
 * A repository over duplex streams (a MessagePort, a WebSocket, a WebRTC channel): one
 * connection per fetch and per push.
 *
 * @example
 * ```ts
 * const remote = duplexRemote({
 *   connect: (service) => {
 *     const channel = new MessageChannel();
 *     void server.serve(createMessagePortDuplex(channel.port2), service);
 *     return createMessagePortDuplex(channel.port1);
 *   },
 * });
 * ```
 */
export function duplexRemote(options: DuplexRemoteOptions): SyncRemote {
  const { name = "origin" } = options;
  return {
    name,
    async fetch(o) {
      const duplex = await options.connect("git-upload-pack");
      const result = await fetchOverDuplex({
        ...o,
        duplex,
        closeDuplex: true,
        tags: "none",
        missingRefsOk: true,
      });
      if (!result.success || !result.report) {
        throw new Error(`fetch from ${name} failed: ${result.error ?? "no report"}`);
      }
      return result.report;
    },
    async push(o) {
      const duplex = await options.connect("git-receive-pack");
      const result = await pushOverDuplex({
        ...o,
        duplex,
        closeDuplex: true,
        timeout: options.timeout,
      });
      if (!result.report) {
        throw new Error(`push to ${name} failed: ${result.error ?? "no report"}`);
      }
      return result.report;
    },
  };
}
