/**
 * A git server on any byte stream: git-daemon's side of `git://` (the request line, then the
 * service) and the side of an ssh-like session whose service, path and protocol arrive out of
 * band (the command an ssh channel runs, its `GIT_PROTOCOL`).
 *
 * @example git:// over a socket
 * ```ts
 * await serveGitConnection({
 *   duplex: socketDuplex,
 *   enableReceivePack: true,
 *   resolveRepository: async (path) => repos.get(path), // { repository, refStore, config? }
 * });
 * ```
 */

import type { Duplex } from "../api/duplex.js";
import type { ServeResult } from "../api/fetch-result.js";
import type { RepositoryFacade } from "../api/repository-facade.js";
import type { RefStore } from "../context/process-context.js";
import {
  GitDaemonRequestError,
  parseGitProtocolEnv,
  readGitDaemonRequest,
} from "../protocol/git-daemon-request.js";
import { encodePacket } from "../protocol/pkt-line-codec.js";
import { type ServeOverDuplexOptions, serveOverDuplex } from "./serve-over-duplex.js";
import { type ServerConfigReader, serverSettingsFromConfig } from "./server-config.js";

/** The `serveOverDuplex` options a served repository decides (everything but the stream and the protocol). */
export type GitServeSettings = Omit<
  ServeOverDuplexOptions,
  "duplex" | "repository" | "refStore" | "service" | "protocolVersion" | "announceVersion1"
>;

/** A repository {@link ServeGitConnectionOptions.resolveRepository} found for a request. */
export interface ServedRepository {
  repository: RepositoryFacade;
  refStore: RefStore;
  /**
   * Its configuration: git-daemon's per-repository `daemon.uploadpack` / `daemon.receivepack`
   * overrides, and the settings git's upload-pack and receive-pack read
   * (`serverSettingsFromConfig`: `receive.*`, hidden refs)
   */
  config?: ServerConfigReader;
  /** Server settings of this repository, over those its config gives (hooks, current branch, ...) */
  settings?: GitServeSettings;
}

/** What a client asked for. */
export interface GitServiceRequest {
  /** `git-upload-pack`, `git-receive-pack` or `git-upload-archive` (any other is refused before) */
  service: string;
  /** The repository's path, as sent */
  path: string;
  /** git:// only: the virtual host (`host=`), canonicalized as git-daemon does */
  host?: string;
  /** git:// only: the port of `host=` */
  port?: string;
  /** The `GIT_PROTOCOL` parameters (`version=2`), git:// ones after the second NUL */
  gitProtocol?: string;
  /** The protocol `gitProtocol` asks for (git's greatest `version=`) */
  version: 0 | 1 | 2;
}

/** Options of {@link serveGitService} (the stream and request given) and {@link serveGitConnection}. */
export interface GitServeOptions {
  /**
   * The repository a request names, or undefined when there is none to serve (git-daemon's
   * "no such repository" and "repository not exported" alike)
   */
  resolveRepository(
    path: string,
    request: GitServiceRequest,
  ): Promise<ServedRepository | undefined>;
  /** Serve upload-pack (default true; git-daemon's `--disable=upload-pack` is false) */
  enableUploadPack?: boolean;
  /** Serve receive-pack (default false, as git-daemon without `--enable=receive-pack`) */
  enableReceivePack?: boolean;
  /**
   * Let a repository's `daemon.uploadpack` / `daemon.receivepack` turn its service on or off
   * (default true; git-daemon's `--forbid-override` is false)
   */
  allowOverride?: boolean;
  /**
   * Refusals name their reason (git-daemon's `--informative-errors`: "no such repository",
   * "service not enabled"); default: "access denied or repository not exported" for all
   */
  informativeErrors?: boolean;
  /** Settings of every served repository, under each one's own */
  settings?: GitServeSettings;
  /** Close the stream once served (default true: the connection is over, as git-daemon's child exits) */
  closeDuplex?: boolean;
}

/** Options of {@link serveGitConnection}. */
export interface ServeGitConnectionOptions extends GitServeOptions {
  /** The connection; its first pkt-line is git-daemon's request line */
  duplex: Duplex;
}

/** Options of {@link serveGitService}: a session whose request arrived out of band. */
export interface ServeGitServiceOptions extends GitServeOptions {
  duplex: Duplex;
  /** The service (`git-upload-pack`, `git-receive-pack`), e.g. from `parseGitServiceCommand` */
  service: string;
  /** The repository's path */
  path: string;
  /** The session's `GIT_PROTOCOL` (`version=2`) */
  gitProtocol?: string;
  /**
   * How a refusal reaches the client: `"daemon"` (default for {@link serveGitConnection}) as
   * git-daemon's `ERR <reason>: <path>` packet; `"implicit"` (default here) as the `ERR` packet
   * of a server that could not open the repository (`'<path>' does not appear to be a git
   * repository`), for a stream with no stderr
   */
  refusal?: "daemon" | "implicit";
  /** git:// only: the request's virtual host and port */
  host?: string;
  port?: string;
}

/** The outcome of a served connection. */
export interface ServeGitConnectionResult extends ServeResult {
  /** The request, once read */
  request?: GitServiceRequest;
  /** Set when the request was refused: the text sent (or, for an unreadable request, why none was) */
  refused?: string;
}

/** git-daemon's services: the name in the request and its `daemon.<name>` config key. */
const DAEMON_SERVICES: Record<string, string> = {
  "git-upload-archive": "uploadarch",
  "git-upload-pack": "uploadpack",
  "git-receive-pack": "receivepack",
};

/**
 * path.c's `daemon_avoid_alias`: a path git-daemon refuses before looking for it (not absolute
 * nor `~user`, or with `//`, `/./`, `/../`, a trailing `/.` or `/..`).
 */
export function daemonAvoidsAlias(path: string): boolean {
  if (!path.startsWith("/") && !path.startsWith("~")) return true;
  let slash = true;
  let dots = 0;
  for (let i = 1; i <= path.length; i++) {
    const ch = i < path.length ? path[i] : "";
    if (slash) {
      if (ch === ".") dots++;
      else if (ch === "/") {
        if (dots < 3) return true;
        dots = 0;
      } else if (ch === "") return dots > 0 && dots < 3;
      else {
        slash = false;
        dots = 0;
      }
    } else if (ch === "") return false;
    else if (ch === "/") {
      slash = true;
      dots = 0;
    }
  }
  return false;
}

/** git's `git_config_bool` for the last value of `key`, or undefined when unset. */
function configBool(config: ServerConfigReader | undefined, key: string): boolean | undefined {
  const values = config?.getAll(key) ?? [];
  if (values.length === 0) return undefined;
  const value = values[values.length - 1];
  if (value === null || value === true || value === undefined) return true;
  if (value === false) return false;
  const text = String(value).trim().toLowerCase();
  if (["true", "yes", "on"].includes(text)) return true;
  if (["false", "no", "off", ""].includes(text)) return false;
  const n = Number(text);
  return Number.isFinite(n) ? n !== 0 : undefined;
}

async function closeQuietly(duplex: Duplex): Promise<void> {
  try {
    await duplex.close?.();
  } catch {
    // gone already
  }
}

/**
 * Serves one git:// connection as git-daemon does (daemon.c's `execute` and `run_service`):
 * reads the request line (`git-upload-pack /r.git\0host=h\0\0version=2\0`) without losing the
 * bytes after it, then serves the service it names ({@link serveGitService}). A request
 * git-daemon dies on (malformed, an unknown command) gets no answer: the stream is closed.
 *
 * @example
 * ```ts
 * server.on("connection", (socket) =>
 *   void serveGitConnection({ duplex: socketDuplex(socket), resolveRepository, enableReceivePack: true }),
 * );
 * ```
 */
export async function serveGitConnection(
  options: ServeGitConnectionOptions,
): Promise<ServeGitConnectionResult> {
  const { duplex } = options;
  let read: Awaited<ReturnType<typeof readGitDaemonRequest>>;
  try {
    read = await readGitDaemonRequest(duplex);
  } catch (error) {
    if (options.closeDuplex !== false) await closeQuietly(duplex);
    const message = error instanceof Error ? error.message : String(error);
    if (!(error instanceof GitDaemonRequestError)) return { success: false, error: message };
    return { success: false, error: message, refused: message };
  }
  const { request, input } = read;
  if (!(request.command in DAEMON_SERVICES)) {
    if (options.closeDuplex !== false) await closeQuietly(duplex);
    const message = `Protocol error: '${request.command} ${request.path}'`;
    return { success: false, error: message, refused: message };
  }
  const rest: Duplex = {
    [Symbol.asyncIterator]: () => input[Symbol.asyncIterator](),
    write: (data) => duplex.write(data),
    ...(duplex.end ? { end: () => duplex.end?.() ?? Promise.resolve() } : {}),
    ...(duplex.close ? { close: () => duplex.close?.() ?? Promise.resolve() } : {}),
  };
  return serveGitService({
    ...options,
    duplex: rest,
    service: request.command,
    path: request.path,
    refusal: "daemon",
    ...(request.gitProtocol !== undefined ? { gitProtocol: request.gitProtocol } : {}),
    ...(request.host !== undefined ? { host: request.host } : {}),
    ...(request.port !== undefined ? { port: request.port } : {}),
  });
}

/**
 * Serves a session whose service, path and protocol are known already (an ssh channel that
 * runs `git-upload-pack '<path>'` with `GIT_PROTOCOL=version=2`; git:// after its request
 * line): the service checks of git-daemon's `run_service` (enabled, the path, the
 * repository, its `daemon.<service>` override), then `serveOverDuplex` with the repository's
 * settings at the protocol asked for (v2 for upload-pack; `version 1` announced for v1; a push
 * asking for v2 gets v0, as git's receive-pack).
 */
export async function serveGitService(
  options: ServeGitServiceOptions,
): Promise<ServeGitConnectionResult> {
  const { duplex, service, path } = options;
  const { version } = parseGitProtocolEnv(options.gitProtocol);
  const request: GitServiceRequest = {
    service,
    path,
    version,
    ...(options.host !== undefined ? { host: options.host } : {}),
    ...(options.port !== undefined ? { port: options.port } : {}),
    ...(options.gitProtocol !== undefined ? { gitProtocol: options.gitProtocol } : {}),
  };
  const daemon = options.refusal === "daemon";
  const refuse = async (reason: "no such repository" | "service not enabled") => {
    const text = daemon
      ? `ERR ${options.informativeErrors ? reason : "access denied or repository not exported"}: ${path}`
      : reason === "service not enabled"
        ? `ERR service not enabled: ${path}`
        : `ERR '${path}' does not appear to be a git repository`;
    try {
      await duplex.write(encodePacket(text));
    } catch {
      // the client is gone
    }
    if (options.closeDuplex !== false) await closeQuietly(duplex);
    return { success: false, error: text, refused: text, request };
  };

  const configKey = DAEMON_SERVICES[service];
  if (configKey === undefined) return refuse("service not enabled");
  const enabled =
    service === "git-upload-pack"
      ? options.enableUploadPack !== false
      : service === "git-receive-pack"
        ? options.enableReceivePack === true
        : false;
  const overridable = options.allowOverride !== false;
  if (!enabled && !overridable) return refuse("service not enabled");
  if (daemon && daemonAvoidsAlias(path)) return refuse("no such repository");
  let served: ServedRepository | undefined;
  try {
    served = await options.resolveRepository(path, request);
  } catch {
    served = undefined;
  }
  if (!served) return refuse("no such repository");
  const override = overridable ? configBool(served.config, `daemon.${configKey}`) : undefined;
  // upload-archive is not served here: refused as when it is not enabled
  if (!(override ?? enabled) || service === "git-upload-archive") {
    return refuse("service not enabled");
  }

  const fromConfig = served.config ? serverSettingsFromConfig(served.config) : {};
  try {
    const result = await serveOverDuplex({
      ...options.settings,
      ...fromConfig,
      ...served.settings,
      duplex,
      repository: served.repository,
      refStore: served.refStore,
      service: service as "git-upload-pack" | "git-receive-pack",
      ...(service === "git-upload-pack" && version === 2 ? { protocolVersion: "2" as const } : {}),
      ...(version === 1 ? { announceVersion1: true } : {}),
    });
    return { ...result, request };
  } finally {
    if (options.closeDuplex !== false) await closeQuietly(duplex);
  }
}
