/**
 * git-daemon's front end, its socket left to the host: the host accepts connections and hands
 * each to {@link GitDaemon.serve} with the client's address, and the daemon applies
 * `--max-connections` (daemon.c's `handle`, `kill_some_child`) before serving it as
 * `serveGitConnection` does (`--init-timeout`, `--timeout`, `--access-hook`,
 * `--informative-errors`; `--interpolated-path` and the path rules are the resolver's,
 * `createBasePathResolver`).
 *
 * @example
 * ```ts
 * const daemon = createGitDaemon({
 *   maxConnections: 32,
 *   resolveRepository: createBasePathResolver({ files, basePath: "/srv/git", openRepository }),
 *   accessHook: daemonAccessHookOf(hookRunner, "/usr/local/bin/git-access"), // vcs-commands
 * });
 * // Node: each accepted socket as a MessagePort (vcs-utils-node's socket adapter)
 * await listenSocketPorts({ host: "0.0.0.0", port: 9418 }, (port, peer) =>
 *   void daemon.serve(port, {
 *     remoteAddress: peer.remoteAddress,
 *     remotePort: String(peer.remotePort),
 *   }),
 * );
 * ```
 *
 * A connection is a `Duplex` or a `MessagePort` whose other end carries the client's bytes
 * (`socketMessagePort`, `serveOverPort`), read through `messagePortDuplex`.
 */

import { DEFAULT_PORT_DRAIN_TIMEOUT, duplexOfStream } from "../adapters/messageport/index.js";
import type { ByteStream, Duplex } from "../api/duplex.js";
import {
  type ServeGitConnectionOptions,
  type ServeGitConnectionResult,
  serveGitConnection,
} from "./serve-git-connection.js";

/** Options of {@link createGitDaemon}: `serveGitConnection`'s, bar the stream. */
export interface GitDaemonOptions
  extends Omit<
    ServeGitConnectionOptions,
    "duplex" | "remoteAddress" | "remotePort" | "signal" | "onServiceStart"
  > {
  /**
   * Most connections served at once (git-daemon's `--max-connections`, default 32; 0: no
   * limit). A connection over it first cuts off the newest connection of an address that has
   * two, unless that one is being served already; if that frees no place within a second,
   * the new connection is closed without an answer ("Too many children, dropping connection")
   */
  maxConnections?: number;
  /**
   * How long a connection over the limit waits for a place, in milliseconds (git-daemon
   * sleeps one second); default 1000
   */
  limitWaitMs?: number;
}

/** Who a connection comes from. */
export interface GitDaemonConnectionInfo {
  /** The client's address (connections of one address are grouped, as git-daemon's `addrcmp`) */
  remoteAddress?: string;
  remotePort?: string;
}

/** A daemon serving the connections a host hands it. */
export interface GitDaemon {
  /**
   * Serves one connection (git-daemon's child), or drops it when over the limit: a `Duplex`,
   * or a `MessagePort` carrying the client's bytes (a socket through `socketMessagePort`)
   */
  serve(stream: ByteStream, info?: GitDaemonConnectionInfo): Promise<ServeGitConnectionResult>;
  /** The connections being served (git-daemon's `live_children`) */
  readonly liveConnections: number;
}

interface Child {
  address: string;
  controller: AbortController;
  started: boolean;
  done: Promise<unknown>;
}

/**
 * A git daemon over host-accepted connections (see the module's example). Each served
 * connection is a child in git-daemon's list: a new one goes before the first of its address
 * (newest first), and over the limit the first child followed by one of its address is cut
 * off, unless it already passed every check (git-daemon's child ignores SIGTERM then).
 */
export function createGitDaemon(options: GitDaemonOptions): GitDaemon {
  const { maxConnections = 32, limitWaitMs = 1000, ...serveOptions } = options;
  const children: Child[] = [];

  /** daemon.c's `kill_some_child`: the newest of the first address with two connections. */
  const killSomeChild = (): Child | undefined => {
    for (let i = 0; i + 1 < children.length; i++) {
      const child = children[i] as Child;
      if (child.address === (children[i + 1] as Child).address) {
        if (child.started) return undefined; // SIGTERM ignored by a served child
        child.controller.abort();
        return child;
      }
    }
    return undefined;
  };

  const cutOff = async (duplex: Duplex) => {
    try {
      if (duplex.close) await duplex.close();
      else await duplex.end?.();
    } catch {
      // gone already
    }
  };

  return {
    get liveConnections() {
      return children.length;
    },
    async serve(stream, info = {}) {
      // a port must not lose the end of the answer when the session closes it
      const duplex = duplexOfStream(stream, { drainTimeout: DEFAULT_PORT_DRAIN_TIMEOUT });
      if (maxConnections > 0 && children.length >= maxConnections) {
        const killed = killSomeChild();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const wait = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, limitWaitMs);
        });
        await (killed ? Promise.race([killed.done, wait]) : wait);
        clearTimeout(timer);
        if (children.length >= maxConnections) {
          await cutOff(duplex);
          const message = "Too many children, dropping connection";
          return { success: false, error: message, refused: message };
        }
      }
      const controller = new AbortController();
      const address = info.remoteAddress ?? "";
      let finish: () => void = () => {};
      const child: Child = {
        address,
        controller,
        started: false,
        done: new Promise<void>((resolve) => {
          finish = resolve;
        }),
      };
      // add_child: before the first child of the same address, else last
      const at = children.findIndex((c) => c.address === address);
      if (at < 0) children.push(child);
      else children.splice(at, 0, child);
      // a cut-off child's connection ends at once, whatever it is waiting for
      const onAbort = () => {
        if (!child.started) void cutOff(duplex);
      };
      controller.signal.addEventListener("abort", onAbort);
      try {
        return await serveGitConnection({
          ...serveOptions,
          duplex,
          signal: controller.signal,
          onServiceStart: () => {
            child.started = true;
          },
          ...(info.remoteAddress !== undefined ? { remoteAddress: info.remoteAddress } : {}),
          ...(info.remotePort !== undefined ? { remotePort: info.remotePort } : {}),
        });
      } finally {
        controller.signal.removeEventListener("abort", onAbort);
        const index = children.indexOf(child);
        if (index >= 0) children.splice(index, 1);
        finish();
      }
    },
  };
}
