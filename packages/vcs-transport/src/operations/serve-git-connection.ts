/**
 * A git server on any byte stream: git-daemon's side of `git://` (the request line, then the
 * service) and the side of an ssh-like session whose service, path and protocol arrive out of
 * band (the command an ssh channel runs, its `GIT_PROTOCOL`).
 *
 * The path a request names is client input: it is checked as git-daemon checks it
 * (`daemon_avoid_alias`, plus no NUL or backslash) before `resolveRepository` sees it, and
 * {@link createBasePathResolver} maps it onto a directory as git-daemon does (base path,
 * `~user`, `.git` suffixes, `git-daemon-export-ok`, staying inside the base).
 *
 * Neither function bounds how long a client may take: give {@link serveGitConnection} an
 * `initTimeout` and `timeout` (git-daemon's `--init-timeout` / `--timeout`), or close the
 * stream from outside, where clients are not trusted.
 *
 * @example git:// over a socket
 * ```ts
 * await serveGitConnection({
 *   duplex: socketDuplex,
 *   enableReceivePack: true,
 *   initTimeout: 10_000,
 *   timeout: 60_000,
 *   resolveRepository: createBasePathResolver({
 *     files,                 // where the repositories are
 *     basePath: "/srv/git",  // git-daemon's --base-path
 *     openRepository: async (gitDir) => repos.open(gitDir), // { repository, refStore, config? }
 *   }),
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
import {
  configBoolOf,
  explicitServerSettingsFromConfig,
  GIT_SERVER_SETTINGS_DEFAULTS,
  type ServerConfigReader,
} from "./server-config.js";

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
   * (`explicitServerSettingsFromConfig`: `receive.*`, hidden refs). Only what it sets
   * explicitly overrides {@link GitServeOptions.settings}; see there for the order.
   */
  config?: ServerConfigReader;
  /**
   * Server settings of this repository (hooks, current branch, ...), over the operator's and
   * those its config sets: the last word, so a resolver that must enforce a policy whatever a
   * repository's config says sets it here
   */
  settings?: GitServeSettings;
  /**
   * Runs around the serving of one request (`serve`), for what the repository's owner
   * installs for its duration: the repository's reference-transaction hook while
   * receive-pack updates its refs (`servedRepositoryOf`)
   */
  around?<T>(service: "git-upload-pack" | "git-receive-pack", serve: () => Promise<T>): Promise<T>;
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
   * "no such repository" and "repository not exported" alike).
   *
   * `path` is client input, as sent: it has passed {@link isUnsafeServicePath} (no `..`,
   * `//`, `/./`, NUL or backslash; git-daemon's `daemon_avoid_alias`), but it is not mapped
   * anywhere yet, may start with `~`, and in an implicit session may be relative. Map it
   * with {@link createBasePathResolver}, or check it as strictly yourself, never by joining
   * it to a directory unchecked.
   */
  resolveRepository(
    path: string,
    request: GitServiceRequest,
  ): Promise<ServedRepository | undefined>;
  /** Serve upload-pack (default true; git-daemon's `--disable=upload-pack` is false) */
  enableUploadPack?: boolean;
  /**
   * Serve receive-pack (default false, as git-daemon without `--enable=receive-pack`; an
   * implicit session too: an ssh server that accepts pushes says so)
   */
  enableReceivePack?: boolean;
  /**
   * Let a repository's `daemon.uploadpack` / `daemon.receivepack` turn its service on or off
   * (git-daemon's `--forbid-override` is false). Default: true for git:// (`refusal:
   * "daemon"`, as git-daemon), false for an implicit session (an ssh channel runs the service
   * the operator allows: git's upload-pack and receive-pack never read `daemon.*`)
   */
  allowOverride?: boolean;
  /**
   * Refusals name their reason (git-daemon's `--informative-errors`: "no such repository",
   * "service not enabled"); default: one text for every refusal ("access denied or
   * repository not exported" for git://, `'<path>' does not appear to be a git repository`
   * for an implicit session), so a client cannot tell a missing repository from a refused one
   */
  informativeErrors?: boolean;
  /**
   * Settings of every served repository (the operator's: git's system config), under each
   * repository's. The layers, lowest first: git's defaults (`GIT_SERVER_SETTINGS_DEFAULTS`,
   * for a repository served with a `config`; `serveOverDuplex`'s defaults otherwise), these, what the repository's `config` sets explicitly (as git's repository config over
   * its system config: a repository setting `receive.denyDeletes=false` does allow deletes
   * here), then the resolver's `ServedRepository.settings`. A key the repository's config
   * leaves unset keeps the operator's value; hidden ref lists (`hideRefs`,
   * `uploadPackHideRefs`, `receivePackHideRefs`) are not replaced but concatenated, every
   * layer's patterns in that order across all three lists, as git reads multi-valued
   * `*.hideRefs` from each config file (a later `!pattern` can still unhide an earlier one, as
   * in git; an earlier one never unhides a later layer's, so the resolver's stay hidden).
   */
  settings?: GitServeSettings;
  /** Close the stream once served (default true: the connection is over, as git-daemon's child exits) */
  closeDuplex?: boolean;
}

/** Options of {@link serveGitConnection}. */
export interface ServeGitConnectionOptions extends GitServeOptions {
  /** The connection; its first pkt-line is git-daemon's request line */
  duplex: Duplex;
  /**
   * Most milliseconds to wait for the request line (git-daemon's `--init-timeout`); the
   * stream is closed without an answer when it does not arrive in time. Default: no limit
   */
  initTimeout?: number;
  /**
   * Most milliseconds the service waits for the client's next bytes, or for the client to
   * take a write (git-daemon's `--timeout`, which it hands to upload-pack); the stream is
   * closed (ended, without `close`) when it is exceeded. Time the server spends working is
   * not counted. Default: no limit
   */
  timeout?: number;
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
 * Whether a served path is refused before any lookup: an empty path, a NUL or a backslash anywhere (not
 * git's: a path reaching another API than POSIX's could take either for a separator or an
 * end), or git-daemon's aliases ({@link daemonAvoidsAlias}). git:// (`implicit` false) asks
 * for an absolute or `~user` path as git-daemon does; an implicit session (ssh) also sends
 * relative paths (`host:r.git`) and `~/r.git`, checked as if below a `/`.
 *
 * @example
 * ```ts
 * isUnsafeServicePath("/a/../b");                     // true
 * isUnsafeServicePath("", { implicit: true });       // true
 * isUnsafeServicePath("r.git", { implicit: true });   // false
 * isUnsafeServicePath("../r.git", { implicit: true }); // true
 * ```
 */
export function isUnsafeServicePath(path: string, options: { implicit?: boolean } = {}): boolean {
  // an empty path (ssh's `git-upload-pack ''`) names no repository: setup.c's enter_repo
  // stats "" (which fails) and otherwise only looks at `/.git` or the working directory
  if (path === "") return true;
  if (path.includes("\0") || path.includes("\\")) return true;
  if (!options.implicit) return daemonAvoidsAlias(path);
  if (path.startsWith("~/")) return daemonAvoidsAlias(path.slice(1));
  if (path.startsWith("/") || path.startsWith("~")) return daemonAvoidsAlias(path);
  return daemonAvoidsAlias(`/${path}`);
}

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

/**
 * Layers server settings, the later over the earlier: a key a layer leaves undefined keeps
 * the value below; the hidden ref lists concatenate (see {@link GitServeOptions.settings}).
 * Each service's effective list (`hideRefs`, then the service's own, as `serveOverDuplex`
 * reads them) keeps the layers' order: a layer's `hideRefs` come after every pattern of the
 * layers below, the services' own lists included, so a later layer's `hideRefs` cannot be
 * unhidden by an earlier layer's `!pattern` in `uploadPackHideRefs` or `receivePackHideRefs`
 * (once a lower layer has set a service's own list, a later `hideRefs` is appended to both
 * service lists instead).
 */
export function layerServeSettings(
  ...layers: Array<Partial<GitServeSettings> | undefined>
): GitServeSettings {
  const out: Record<string, unknown> = {};
  const transfer: string[] = [];
  const upload: string[] = [];
  const receive: string[] = [];
  for (const layer of layers) {
    if (!layer) continue;
    const { hideRefs, uploadPackHideRefs, receivePackHideRefs, ...rest } = layer;
    for (const [key, value] of Object.entries(rest)) {
      if (value !== undefined) out[key] = value;
    }
    if (hideRefs) {
      if (upload.length === 0 && receive.length === 0) transfer.push(...hideRefs);
      else {
        upload.push(...hideRefs);
        receive.push(...hideRefs);
      }
    }
    if (uploadPackHideRefs) upload.push(...uploadPackHideRefs);
    if (receivePackHideRefs) receive.push(...receivePackHideRefs);
  }
  if (transfer.length > 0) out.hideRefs = transfer;
  if (upload.length > 0) out.uploadPackHideRefs = upload;
  if (receive.length > 0) out.receivePackHideRefs = receive;
  return out as GitServeSettings;
}

/**
 * The settings a served repository is served with (see {@link GitServeOptions.settings}):
 * git's defaults (for a repository with a config, which git always reads; without one, the
 * server's own defaults), the operator's `settings`, what the repository's config sets
 * explicitly, then the resolver's {@link ServedRepository.settings}. `serveGitService` and
 * the served smart-HTTP handler (`createServedHttpHandler`) layer them alike.
 *
 * @example
 * ```ts
 * const settings = resolveServeSettings({ allowDeletes: false }, served);
 * ```
 */
export function resolveServeSettings(
  operator: GitServeSettings | undefined,
  served: Pick<ServedRepository, "config" | "settings">,
): GitServeSettings {
  return layerServeSettings(
    served.config ? GIT_SERVER_SETTINGS_DEFAULTS : undefined,
    operator,
    served.config ? explicitServerSettingsFromConfig(served.config) : undefined,
    served.settings,
  );
}

/**
 * The stream with an inactivity limit: a read the client does not answer within `ms` ends
 * the input (as a hang-up), and a write the client does not take within `ms` (it stopped
 * reading: the stream's backpressure never lets go) fails, as git's upload-pack resets its
 * alarm around every write of `create_pack_file`; either closes the stream (ends it, for a
 * stream without `close`). `expired()` tells whether it happened.
 */
function withTimeout(duplex: Duplex, ms: number): Duplex & { expired(): boolean } {
  let expired = false;
  const expire = () => {
    expired = true;
    void cutOff(duplex);
  };
  const write = async (data: Uint8Array): Promise<void> => {
    if (expired) throw new Error("timed out waiting for the client");
    const pending = duplex.write(data);
    if (!pending) return;
    pending.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            expire();
            reject(new Error("timed out waiting for the client"));
          }, ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    [Symbol.asyncIterator]: () => {
      const inner = duplex[Symbol.asyncIterator]();
      return {
        async next(): Promise<IteratorResult<Uint8Array>> {
          if (expired) return { value: undefined, done: true };
          let timer: ReturnType<typeof setTimeout> | undefined;
          const timedOut = new Promise<IteratorResult<Uint8Array>>((resolve) => {
            timer = setTimeout(() => {
              expire();
              resolve({ value: undefined, done: true });
            }, ms);
          });
          try {
            return await Promise.race([inner.next(), timedOut]);
          } finally {
            clearTimeout(timer);
          }
        },
        async return(): Promise<IteratorResult<Uint8Array>> {
          await inner.return?.();
          return { value: undefined, done: true };
        },
      };
    },
    write,
    ...(duplex.end ? { end: () => duplex.end?.() ?? Promise.resolve() } : {}),
    ...(duplex.close ? { close: () => duplex.close?.() ?? Promise.resolve() } : {}),
    expired: () => expired,
  };
}

/** `promise`, or undefined once `ms` (when given) pass first. */
async function within<T>(promise: Promise<T>, ms: number | undefined): Promise<T | undefined> {
  if (ms === undefined) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Closes the stream, or ends it when it has no `close`; errors of a gone stream ignored. */
async function cutOff(duplex: Duplex): Promise<void> {
  try {
    if (duplex.close) await duplex.close();
    else await duplex.end?.();
  } catch {
    // gone already
  }
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
 * git-daemon dies on (malformed, an unknown command, none within `initTimeout`) gets no
 * answer: the stream is closed.
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
  const timed =
    options.timeout !== undefined ? withTimeout(options.duplex, options.timeout) : undefined;
  const duplex: Duplex = timed ?? options.duplex;
  let read: Awaited<ReturnType<typeof readGitDaemonRequest>> | undefined;
  try {
    const reading = readGitDaemonRequest(duplex);
    read = await within(reading, options.initTimeout);
    if (read === undefined) {
      reading.catch(() => undefined);
      await closeQuietly(duplex);
      const message = "timed out waiting for the request line";
      return { success: false, error: message, refused: message };
    }
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
  const result = await serveGitService({
    ...options,
    duplex: rest,
    service: request.command,
    path: request.path,
    refusal: "daemon",
    ...(request.gitProtocol !== undefined ? { gitProtocol: request.gitProtocol } : {}),
    ...(request.host !== undefined ? { host: request.host } : {}),
    ...(request.port !== undefined ? { port: request.port } : {}),
  });
  if (timed?.expired()) {
    const message = "timed out waiting for the client";
    return { ...result, success: false, error: message };
  }
  return result;
}

/**
 * Serves a session whose service, path and protocol are known already (an ssh channel that
 * runs `git-upload-pack '<path>'` with `GIT_PROTOCOL=version=2`; git:// after its request
 * line): the service checks of git-daemon's `run_service` (enabled, the path, the
 * repository, its `daemon.<service>` override), then `serveOverDuplex` with the settings
 * layered as {@link GitServeOptions.settings} tells, at the protocol asked for (v2 for upload-pack; `version 1` announced for v1; a push
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
      : reason === "service not enabled" && options.informativeErrors
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
  const overridable = options.allowOverride ?? daemon;
  if (!enabled && !overridable) return refuse("service not enabled");
  if (isUnsafeServicePath(path, { implicit: !daemon })) return refuse("no such repository");
  let served: ServedRepository | undefined;
  try {
    served = await options.resolveRepository(path, request);
  } catch {
    served = undefined;
  }
  if (!served) return refuse("no such repository");
  const override = overridable ? configBoolOf(served.config, `daemon.${configKey}`) : undefined;
  // upload-archive is not served here: refused as when it is not enabled
  if (!(override ?? enabled) || service === "git-upload-archive") {
    return refuse("service not enabled");
  }

  const settings = resolveServeSettings(options.settings, served);
  try {
    const servedService = service as "git-upload-pack" | "git-receive-pack";
    const serve = () =>
      serveOverDuplex({
        ...settings,
        duplex,
        repository: served.repository,
        refStore: served.refStore,
        service: servedService,
        ...(service === "git-upload-pack" && version === 2
          ? { protocolVersion: "2" as const }
          : {}),
        ...(version === 1 ? { announceVersion1: true } : {}),
      });
    const result = served.around ? await served.around(servedService, serve) : await serve();
    return { ...result, request };
  } finally {
    if (options.closeDuplex !== false) await closeQuietly(duplex);
  }
}
