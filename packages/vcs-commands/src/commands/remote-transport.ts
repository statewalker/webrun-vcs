/**
 * How a remote command reaches a remote, as git's `transport_get` and `git_connect` decide:
 * the URL (already rewritten by `url.<base>.insteadOf`, see `RemoteConfigStore`) is checked
 * against `protocol.allow`; a path or `file://` URL is git's local transport (served in
 * process, see `local-transport.ts`); anything else goes to the connector the transport
 * registry names for it (smart HTTP by default).
 */

import {
  type Credentials,
  type Duplex,
  type GitConnectRequest,
  type GitService,
  type GitSession,
  type GitTransportConnector,
  type GitTransportRegistry,
  type GitUrl,
  isGitUrl,
  openReceivePack,
  openUploadPack,
  parseGitUrl,
  protocolVersionFor,
  type ReceivePackConnection,
  type UploadPackConnection,
} from "@statewalker/vcs-transport";
import type {
  GitHostEnvironment,
  OpenedRepository,
  WorkingCopy,
} from "@statewalker/vcs-working-tree";
import { InvalidConfigError, TransportError } from "../errors/index.js";
import { RemoteConfigStore } from "../remote-config/index.js";
import type { HookSession } from "./git-hooks.js";
import { hostEnvironmentOf } from "./git-ident.js";
import {
  openLocalRemote,
  type ReceivePackHost,
  withLocalReceivePack,
  withLocalUploadPack,
} from "./local-transport.js";

/** A remote URL resolved to the transport that reaches it. */
export type ResolvedRemote =
  | {
      kind: "local";
      /** The URL as given (rewritten) */
      url: string;
      /** The repository's path, as git reports it (`file://` stripped and decoded) */
      path: string;
    }
  | {
      kind: "connector";
      url: string;
      parsed: GitUrl;
      connector: GitTransportConnector;
    };

/** A resolved remote, its local repository opened. */
export type PreparedRemote =
  | (Extract<ResolvedRemote, { kind: "local" }> & { repository: OpenedRepository })
  | Extract<ResolvedRemote, { kind: "connector" }>;

/** What {@link resolveRemote} reads: the configuration, the environment and the registry. */
export interface RemoteResolutionContext {
  /** `protocol.*` settings */
  config: RemoteConfigStore;
  /** `GIT_PROTOCOL_FROM_USER`, `GIT_ALLOW_PROTOCOL` */
  environment?: GitHostEnvironment;
  transports: GitTransportRegistry;
}

const NO_PATH = "fatal: no path specified; see 'git help pull' for valid url syntax";

type AllowPolicy = "always" | "never" | "user";

/** transport.c's `parse_protocol_config`. */
function parsePolicy(key: string, value: string): AllowPolicy {
  const lower = value.toLowerCase();
  if (lower === "always" || lower === "never" || lower === "user") return lower;
  throw new InvalidConfigError(key, `fatal: unknown value for config '${key}': ${value}`);
}

/**
 * transport.c's `is_transport_allowed`: `GIT_ALLOW_PROTOCOL` when set (the only transports
 * allowed); else `protocol.<type>.allow`, then `protocol.allow`, then git's defaults (http,
 * https, git and ssh always; ext never; any other, `file` included, only when
 * `GIT_PROTOCOL_FROM_USER` is not false).
 *
 * @example
 * ```ts
 * isTransportAllowed("ext", store);                          // false
 * isTransportAllowed("file", store, { protocolFromUser: false } as GitHostEnvironment); // false
 * ```
 */
export function isTransportAllowed(
  type: string,
  config: RemoteConfigStore,
  environment?: GitHostEnvironment,
): boolean {
  if (environment?.allowProtocol !== undefined) {
    return environment.allowProtocol.split(":").includes(type);
  }
  const key = `protocol.${type}.allow`;
  const own = config.value(key);
  const fallback = config.value("protocol.allow");
  let policy: AllowPolicy;
  if (own !== undefined) policy = parsePolicy(key, own);
  else if (fallback !== undefined) policy = parsePolicy("protocol.allow", fallback);
  else if (["http", "https", "git", "ssh"].includes(type)) policy = "always";
  else if (type === "ext") policy = "never";
  else policy = "user";
  if (policy === "user") return environment?.protocolFromUser ?? true;
  return policy === "always";
}

/** transport.c's `transport_check_allowed`: git's "transport '<type>' not allowed". */
export function checkTransportAllowed(
  type: string,
  config: RemoteConfigStore,
  environment?: GitHostEnvironment,
): void {
  if (!isTransportAllowed(type, config, environment)) {
    throw new TransportError(`fatal: transport '${type}' not allowed`);
  }
}

/**
 * `protocol.version` (git's `get_protocol_version_config`): 0, 1 or 2, default 2; any other
 * value is git's "unknown value for config 'protocol.version'".
 */
export function protocolVersionOf(config: RemoteConfigStore): 0 | 1 | 2 {
  const value = config.value("protocol.version");
  if (value === undefined) return 2;
  if (value === "0" || value === "1" || value === "2") return Number(value) as 0 | 1 | 2;
  throw new InvalidConfigError(
    "protocol.version",
    `fatal: unknown value for config 'protocol.version': ${value}`,
  );
}

/**
 * Resolves a remote URL (already rewritten by `insteadOf`) to its transport, in git's order
 * (transport_get, then git_connect): a `<helper>::<address>` URL goes to the connector for
 * the helper; `rsync:` is refused; a path or `file://` URL is the local transport (its path
 * checked first, then `protocol.file.allow`); `ssh`/`git` URLs (path, then
 * `protocol.<scheme>.allow`) and any other `<scheme>://` (`protocol.<scheme>.allow`) go to
 * the registry's connector. Without one, git's words: "unable to find remote helper" where
 * git would run a remote helper, ours for ssh and git:// (git would connect directly).
 *
 * @throws TransportError git's lines (exit 128)
 */
export function resolveRemote(url: string, context: RemoteResolutionContext): ResolvedRemote {
  const { config, environment, transports } = context;
  const parsed = parseGitUrl(url);
  const viaConnector = (type: string): ResolvedRemote | undefined => {
    checkTransportAllowed(type, config, environment);
    const connector = transports.resolve(parsed);
    return connector ? { kind: "connector", url, parsed, connector } : undefined;
  };
  const helperMissing = (helper: string) =>
    new TransportError(`fatal: unable to find remote helper for '${helper}'`);

  if (parsed.address !== undefined) {
    return viaConnector(parsed.scheme) ?? throwError(helperMissing(parsed.scheme));
  }
  if (url.startsWith("rsync:")) {
    throw new TransportError("fatal: git-over-rsync is no longer supported");
  }
  const builtin =
    !isGitUrl(url) || /^(?:file|git|ssh|git\+ssh|ssh\+git):\/\//.test(url) || url === "";
  if (!builtin) {
    // an external handler: the scheme as written
    const scheme = url.slice(0, url.indexOf(":"));
    return viaConnector(scheme) ?? throwError(helperMissing(scheme));
  }
  // parse_connect_url: `host:` names the empty path, a URL without one names none
  if (!parsed.path && !parsed.scpLike) throw new TransportError(NO_PATH);
  // git_connect runs a command for ssh and file (not for git://): an option-looking path, then
  // (after protocol.ssh.allow) host, never reaches it
  if (parsed.scheme === "ssh" || parsed.local) checkNotAnOption("pathname", parsed.path);
  if (parsed.scheme === "file") {
    checkTransportAllowed("file", config, environment);
    return { kind: "local", url, path: parsed.path };
  }
  if (parsed.scheme === "ssh") {
    checkTransportAllowed("ssh", config, environment);
    checkNotAnOption(
      "hostname",
      `${parsed.user !== undefined ? `${parsed.user}@` : ""}${parsed.host ?? ""}`,
    );
  }
  return (
    viaConnector(parsed.scheme) ??
    throwError(
      new TransportError(
        `fatal: cannot connect to '${url}': only http(s) and local repositories are reachable here`,
      ),
    )
  );
}

/**
 * connect.c's `looks_like_command_line_option` checks: git's "strange hostname '<host>'
 * blocked" (and pathname), so a remote URL cannot smuggle an option into the command git
 * runs (`ssh -oProxyCommand=...`).
 *
 * @throws TransportError git's line (exit 128)
 */
function checkNotAnOption(what: "hostname" | "pathname", value: string): void {
  if (value.startsWith("-")) throw new TransportError(`fatal: strange ${what} '${value}' blocked`);
}

function throwError(error: Error): never {
  throw error;
}

/**
 * {@link resolveRemote}, then a local remote's repository opened (git's "does not appear to
 * be a git repository" when it cannot be).
 */
export async function prepareRemote(
  workingCopy: WorkingCopy,
  url: string,
  transports: GitTransportRegistry,
): Promise<PreparedRemote> {
  return openResolvedRemote(
    workingCopy,
    resolveRemote(url, remoteContextOf(workingCopy, transports)),
  );
}

/** A resolved remote with its local repository opened ({@link prepareRemote}'s second half). */
export async function openResolvedRemote(
  workingCopy: WorkingCopy,
  resolved: ResolvedRemote,
): Promise<PreparedRemote> {
  if (resolved.kind !== "local") return resolved;
  return { ...resolved, repository: await openLocalRemote(workingCopy, resolved.path) };
}

/** The resolution context of a working copy: its configuration and host environment. */
export function remoteContextOf(
  workingCopy: WorkingCopy,
  transports: GitTransportRegistry,
): RemoteResolutionContext {
  const environment = hostEnvironmentOf(workingCopy);
  return {
    config: RemoteConfigStore.from(workingCopy),
    ...(environment ? { environment } : {}),
    transports,
  };
}

/** How a remote command talks to a remote reached through a connector. */
export interface RemoteSessionOptions {
  credentials?: Credentials;
  headers?: Record<string, string>;
  timeout?: number;
  /** Smart HTTP: gzip large fetch request bodies */
  gzipRequests?: boolean;
  /** Smart HTTP: stream the push request body */
  streamRequestBody?: boolean;
  /** `protocol.version` ({@link protocolVersionOf}) */
  protocolVersion: 0 | 1 | 2;
  /**
   * The program the remote runs for the service (git's `--upload-pack` / `--receive-pack`,
   * `remote.<name>.uploadpack` / `receivepack`); connectors that run one (ssh, git://) use it
   */
  program?: string;
  signal?: AbortSignal;
}

function connectRequest(
  remote: Extract<ResolvedRemote, { kind: "connector" }>,
  service: GitService,
  options: RemoteSessionOptions,
): GitConnectRequest {
  return {
    url: remote.parsed,
    service,
    // git_connect: receive-pack has no v2, so a push asks for v0; connectors never see 2
    protocolVersion: protocolVersionFor(service, options.protocolVersion),
    ...(options.program !== undefined ? { program: options.program } : {}),
    ...(options.credentials ? { credentials: options.credentials } : {}),
    ...(options.headers ? { headers: options.headers } : {}),
    ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  };
}

/**
 * A native session whose stream closes once: the connection opened over it closes the stream
 * (`closeDuplex`), and {@link withRemoteSession} closes it again for a `run` that opened none
 * or failed before; the second close does nothing.
 */
function closingOnce(session: GitSession): GitSession {
  if (session.kind !== "native") return session;
  const inner = session.duplex;
  let closing: Promise<void> | undefined;
  const duplex: Duplex = {
    [Symbol.asyncIterator]: () => inner[Symbol.asyncIterator](),
    write: (data) => inner.write(data),
    ...(inner.end ? { end: () => inner.end?.() ?? Promise.resolve() } : {}),
    close: () => {
      closing ??= inner.close?.() ?? Promise.resolve();
      return closing;
    },
  };
  return { ...session, duplex };
}

/**
 * Runs `run` over a session the remote's connector opens for `service` (the request's
 * protocol version as git_connect asks for it: v0 for receive-pack when v2 is configured); a
 * native session's stream is closed afterwards, once, whether or not `run` closed it.
 */
export async function withRemoteSession<T>(
  remote: Extract<ResolvedRemote, { kind: "connector" }>,
  service: GitService,
  options: RemoteSessionOptions,
  run: (session: GitSession, request: GitConnectRequest) => Promise<T>,
): Promise<T> {
  const request = connectRequest(remote, service, options);
  const session = closingOnce(await remote.connector.connect(request));
  try {
    return await run(session, request);
  } finally {
    if (session.kind === "native") await session.duplex.close?.().catch(() => undefined);
  }
}

/**
 * Runs `run` over a connection to upload-pack of a remote: in process for a local one
 * (`withLocalUploadPack`, protocol v2 unless `protocol.version` says otherwise), else over
 * the session its connector opens (`openUploadPack`).
 */
export async function withRemoteUploadPack<T>(
  remote: PreparedRemote,
  options: RemoteSessionOptions,
  run: (connection: UploadPackConnection) => Promise<T>,
): Promise<T> {
  if (remote.kind === "local") {
    return withLocalUploadPack(remote.repository, run, {
      protocolVersion: options.protocolVersion,
    });
  }
  return withRemoteSession(remote, "git-upload-pack", options, async (session, request) => {
    const connection = await openUploadPack(session, request, {
      ...(options.gzipRequests !== undefined ? { gzipRequests: options.gzipRequests } : {}),
    });
    try {
      return await run(connection);
    } finally {
      await connection.close();
    }
  });
}

/**
 * Runs `run` over a connection to receive-pack of a remote: in process for a local one
 * (`withLocalReceivePack`, with the remote repository's hooks), else over the session its
 * connector opens (`openReceivePack`).
 */
export async function withRemoteReceivePack<T>(
  remote: PreparedRemote,
  options: RemoteSessionOptions,
  run: (connection: ReceivePackConnection) => Promise<T>,
  hooks?: HookSession,
  transactionHooks?: HookSession,
  /** A local receive-pack's host and its config warnings (see `withLocalReceivePack`) */
  local: { host?: ReceivePackHost; onWarning?: (line: string) => void } = {},
): Promise<T> {
  if (remote.kind === "local") {
    return withLocalReceivePack(remote.repository, run, hooks, transactionHooks, {
      protocolVersion: options.protocolVersion,
      ...local,
    });
  }
  return withRemoteSession(remote, "git-receive-pack", options, async (session, request) => {
    const connection = await openReceivePack(session, request, {
      ...(options.streamRequestBody !== undefined
        ? { streamRequestBody: options.streamRequestBody }
        : {}),
    });
    try {
      return await run(connection);
    } finally {
      await connection.close();
    }
  });
}
