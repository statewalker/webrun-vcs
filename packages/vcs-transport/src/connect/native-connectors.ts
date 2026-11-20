/**
 * Connectors for git's own native transports, built on hooks the host supplies: `git://`
 * over a socket the host opens (`openSocket`), and ssh over a command channel the host runs
 * (`exec`: an ssh client, a WebSocket to a shell service, a local process in tests). The
 * protocol itself (the request line, the pack exchange) is ours; only the byte stream is the
 * host's.
 *
 * @example
 * ```ts
 * const transports = createDefaultTransports({
 *   openSocket: (host, port) => openTcp(host, port),          // git://
 *   exec: (target, command, env) => sshExec(target, command, env), // ssh://, host:path
 * });
 * ```
 */

import type { Duplex } from "../api/duplex.js";
import { GIT_PROTOCOL_DEFAULT_PORT, sqQuote, TransportError } from "../protocol/index.js";
import type { GitConnectRequest, GitTransportConnector } from "./connector.js";
import { protocolVersionFor } from "./open-session.js";

/** Options of {@link createGitDaemonConnector}. */
export interface GitDaemonConnectorOptions {
  /** Opens a byte stream to `host:port` (a TCP socket where the host has one) */
  openSocket(host: string, port: number): Promise<Duplex>;
}

/**
 * `git://` (git-daemon): a stream from `openSocket(host, port)` (port 9418 unless the URL names
 * one), git-daemon's request line written first (`openUploadPack` writes it: handshake
 * `"git-daemon"`).
 */
export function createGitDaemonConnector(
  options: GitDaemonConnectorOptions,
): GitTransportConnector {
  return {
    name: "git",
    schemes: ["git"],
    async connect(request) {
      const host = request.url.host;
      if (!host)
        throw new TransportError(`fatal: unable to connect to ${request.url.raw}: no host`);
      const duplex = await options.openSocket(host, request.url.port ?? GIT_PROTOCOL_DEFAULT_PORT);
      return { kind: "native", duplex, handshake: "git-daemon" };
    },
  };
}

/** Where an ssh command runs. */
export interface SshTarget {
  /** The host, without user or brackets */
  host: string;
  /** The port, when the URL names one */
  port?: number;
  /** The user, when the URL names one (`user@host`) */
  user?: string;
}

/** Options of {@link createSshConnector}. */
export interface SshConnectorOptions {
  /**
   * Runs `command` on `target` and returns its stdin/stdout as a stream (ssh's channel).
   * `env` is what git asks ssh to send (`SendEnv=GIT_PROTOCOL`): `GIT_PROTOCOL=version=<n>`
   * for protocol v1 and v2, nothing for v0.
   */
  exec(target: SshTarget, command: string, env: Record<string, string>): Promise<Duplex>;
}

/**
 * The command git's ssh transport runs on the remote (connect.c's `git_connect`): the program
 * (`git-upload-pack`, or `--upload-pack` / `remote.<name>.uploadpack`) and the repository's path
 * shell-quoted as git's `sq_quote_buf` writes it. The path is the URL's as `parseGitUrl` reads
 * it: `~user/x` for `ssh://h/~user/x`, `~/x` for `h:~/x` (upload-pack expands `~` itself).
 *
 * @example
 * ```ts
 * gitSshCommand({ url: parseGitUrl("h:it's.git"), service: "git-upload-pack", protocolVersion: 2 });
 * // "git-upload-pack 'it'\\''s.git'"
 * ```
 */
export function gitSshCommand(request: GitConnectRequest): string {
  const path = request.url.path;
  if (path.startsWith("-")) throw new TransportError(`fatal: strange pathname '${path}' blocked`);
  return `${request.program ?? request.service} ${sqQuote(path)}`;
}

/**
 * The environment git asks ssh to send (`push_ssh_options`): `GIT_PROTOCOL=version=<n>` for
 * protocol v1 and v2 (a push configured for v2 asks for v0, so sends nothing).
 */
export function gitSshEnv(request: GitConnectRequest): Record<string, string> {
  const version = protocolVersionFor(request.service, request.protocolVersion);
  return version > 0 ? { GIT_PROTOCOL: `version=${version}` } : {};
}

/**
 * ssh (`ssh://`, `git+ssh://`, `ssh+git://` and the scp-like `[user@]host:path`): the
 * session is `exec(target, "git-upload-pack '<path>'", { GIT_PROTOCOL })`; the remote program
 * speaks first (handshake `"implicit"`). An option-looking host or path is refused, as git
 * refuses to hand one to ssh.
 */
export function createSshConnector(options: SshConnectorOptions): GitTransportConnector {
  return {
    name: "ssh",
    schemes: ["ssh"],
    async connect(request) {
      const { host, port, user } = request.url;
      if (!host) throw new TransportError(`fatal: no host in '${request.url.raw}'`);
      const userAndHost = `${user !== undefined ? `${user}@` : ""}${host}`;
      if (userAndHost.startsWith("-")) {
        throw new TransportError(`fatal: strange hostname '${userAndHost}' blocked`);
      }
      const command = gitSshCommand(request);
      const target: SshTarget = {
        host,
        ...(port !== undefined ? { port } : {}),
        ...(user !== undefined ? { user } : {}),
      };
      const duplex = await options.exec(target, command, gitSshEnv(request));
      return { kind: "native", duplex, handshake: "implicit" };
    },
  };
}
