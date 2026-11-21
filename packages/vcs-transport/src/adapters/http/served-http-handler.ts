/**
 * The smart-HTTP server over the same repositories `serveGitConnection` serves: a resolver
 * of {@link ServedRepository} (path → repository, config, settings, hooks, `around`), as
 * git's `http-backend` serves a repository on disk. The settings are layered as
 * `serveGitService` layers them (git's defaults, the operator's, the repository's config,
 * the resolver's), so `receive.*`, `uploadpack.hideRefs` and `transfer.hideRefs` come from the
 * repository's own config, its hooks run for a push (pre-receive, update, post-receive,
 * post-update, push-to-checkout, reference-transaction through `around`), and the services
 * are enabled as http-backend enables them (`http.uploadpack`, `http.receivepack`,
 * `http.getanyfile`, the dumb protocol's object files read through `ServedRepository.files`),
 * except that what the operator turns off stays off whatever a repository's config says.
 *
 * @example
 * ```ts
 * const handle = createServedFetchHandler({
 *   resolveRepository: createBasePathResolver({
 *     files,
 *     basePath: "/srv/git",
 *     exportAll: true, // GIT_HTTP_EXPORT_ALL
 *     openRepository: async (gitDir) => {
 *       const opened = await worktree.openRepository?.(gitDir, { configIncludes: "files" });
 *       return opened && servedRepositoryOf(opened, { hooks }); // vcs-commands
 *     },
 *   }),
 *   // http-backend's REMOTE_USER: receive-pack is served to authenticated users only
 *   remoteUser: (request) => userOf(request.headers.authorization),
 * });
 * ```
 */

import type { UploadPackRequestPolicy } from "../../context/process-config.js";
import { defaultUploadPackCapabilities } from "../../fsm/fetch/server-fetch-fsm.js";
import { peelFully } from "../../fsm/fetch/upload-pack-graph.js";
import type { ReceivePackLogger } from "../../fsm/push/receive-pack-types.js";
import {
  type GitServeSettings,
  type GitServiceRequest,
  isUnsafeServicePath,
  layerServeSettings,
  resolveServeSettings,
  type ServedRepository,
  type ServedRequestContext,
} from "../../operations/serve-git-connection.js";
import type { ServedGitFileStats } from "../../operations/served-git-files.js";
import { configBoolOf } from "../../operations/server-config.js";
import { parseGitProtocolEnv } from "../../protocol/git-daemon-request.js";
import { visibleRefs } from "../../protocol/hidden-refs.js";
import {
  fetchRequestToHttpRequest,
  type HttpHandlerContext,
  type HttpRequest,
  type HttpResponse,
  type HttpServerOptions,
  handleInfoRefs,
  handleInfoRefsV2,
  handleReceivePack,
  handleReceivePackInfoRefs,
  handleUploadPack,
  handleUploadPackV2,
  httpResponseToFetchResponse,
  isProtocolV2Request,
  NO_CACHE_HEADERS,
  requestedProtocolVersion,
} from "./http-server.js";

/** What a served smart-HTTP request asks for, as `resolveRepository` is told it. */
export interface HttpServiceRequest extends GitServiceRequest {
  /**
   * `git-upload-pack` or `git-receive-pack` for the smart protocol; `getanyfile` for a dumb
   * request (`HEAD`, `info/refs` without `service`, `objects/...`)
   */
  service: string;
  /** The HTTP request */
  http: HttpRequest;
  /** The authenticated user ({@link ServedHttpHandlerOptions.remoteUser}), if any */
  remoteUser?: string;
  /** The client's address ({@link ServedHttpHandlerOptions.remoteAddr}), if known */
  remoteAddr?: string;
}

/** Options of {@link createServedHttpHandler}. */
export interface ServedHttpHandlerOptions {
  /**
   * The repository a request names, or undefined (answered 404, as http-backend's "Not a git
   * repository" and "Repository not exported"). `path` is the URL path before the service
   * suffix (`/r.git` of `/r.git/info/refs`), each segment percent-decoded (`/my repo.git` of
   * `/my%20repo.git`, as a web server hands http-backend its `PATH_INFO`); a path whose
   * segments encode `/`, `\` or NUL, or do not decode, is answered 404 without asking. It
   * has passed {@link isUnsafeServicePath} once decoded (absolute, no `..`, `//`, `/./`, NUL
   * or backslash). Map it with `createBasePathResolver`, never by joining it to a directory
   * unchecked.
   */
  resolveRepository(
    path: string,
    request: HttpServiceRequest,
  ): Promise<ServedRepository | undefined>;
  /**
   * The authenticated user of a request (http-backend's `REMOTE_USER`, which the web server
   * sets once it has authenticated the client); default: none. Without `enableReceivePack`
   * or `http.receivepack`, receive-pack is served only to a request with a user.
   */
  remoteUser?(request: HttpRequest): string | undefined | Promise<string | undefined>;
  /**
   * The client's address of a request (http-backend's `REMOTE_ADDR`, which the web server
   * sets); default: none. Receive-pack's hooks get it as `REMOTE_ADDR`, and in
   * `GIT_COMMITTER_EMAIL` (`<user>@http.<addr>`) where the host sets no committer.
   */
  remoteAddr?(request: HttpRequest): string | undefined | Promise<string | undefined>;
  /**
   * Serve upload-pack (default true, as http-backend). Unset or true, a repository's
   * `http.uploadpack` decides (unless `allowOverride` is false); false refuses it whatever
   * the repository's config says (http-backend lets the config turn it back on)
   */
  enableUploadPack?: boolean;
  /**
   * Serve receive-pack: true to every client, false to none; default (undefined) as
   * http-backend: to authenticated users only (`remoteUser`). Unset or true, a repository's
   * `http.receivepack` decides (unless `allowOverride` is false); false refuses it whatever
   * the repository's config says, so one tenant cannot open its repository to pushes the
   * operator turned off
   */
  enableReceivePack?: boolean;
  /**
   * Answer the dumb protocol's requests (http-backend's `http.getanyfile`), default true as
   * in http-backend: `HEAD` and `info/refs` without a service from the refs, and the git
   * directory's files a dumb client fetches (`objects/info/packs` generated from the local
   * packs, `objects/info/alternates`, `objects/info/http-alternates`, loose objects, packs and
   * their indexes) from `ServedRepository.files` (404 without it). Served only where
   * upload-pack is served (403 otherwise), and `info/refs` without the refs upload-pack hides
   * (`transfer.hideRefs`, `uploadpack.hideRefs`), where http-backend lists every ref. The
   * object files hold what hidden refs reach, so they fail closed: while any hidden-ref
   * pattern applies (the operator's `settings`, the repository's config or the resolver's
   * settings), `objects/...` is refused (403) unless this is explicitly true, or the
   * repository sets `http.getanyfile=true` while only its own config hides refs (a
   * repository's opt-in never re-opens what the operator's `settings` or the resolver's
   * settings hide); `HEAD` and `info/refs` are still served. Off,
   * every dumb request is refused (403). Unset or true, a repository's `http.getanyfile`
   * decides (unless `allowOverride` is false); false refuses it whatever the repository's
   * config says. A `HEAD` request is answered with the headers only, no file opened
   */
  getAnyFile?: boolean;
  /**
   * Let a repository's config (`http.uploadpack`, `http.receivepack`, `http.getanyfile`)
   * decide what the operator left unset or turned on (default true: http-backend reads them
   * from the repository's config). An operator's false is never overridden.
   */
  allowOverride?: boolean;
  /**
   * Settings of every served repository (the operator's: git's system config), under each
   * repository's config and its resolver's settings (see `GitServeOptions.settings`)
   */
  settings?: GitServeSettings;
  /** Which objects upload-pack serves by id (see `HttpServerOptions.requestPolicy`) */
  requestPolicy?: UploadPackRequestPolicy;
  /** Largest request body accepted (see `HttpServerOptions.maxRequestBodyBytes`) */
  maxRequestBodyBytes?: number;
  /** Serve protocol v2 to `Git-Protocol: version=2` (default true) */
  protocolV2?: boolean;
  /** Capabilities of the v2 advertisement */
  v2Capabilities?: string[];
  /** upload-pack's keep-alive interval (ms; see `HttpServerOptions.keepAliveMs`) */
  keepAliveMs?: number;
  /** Logs refusals (`info`) and failures (`error`) */
  logger?: {
    info: (msg: string) => void;
    error: (msg: string, err?: unknown) => void;
  };
}

/** http-backend's services: the name after `git-` and its `http.<name>` config key. */
const RPC_SERVICES: Record<string, string> = {
  "upload-pack": "uploadpack",
  "receive-pack": "receivepack",
  "upload-archive": "uploadarchive",
};

type Route = "head" | "info-refs" | "text-file" | "info-packs" | "loose" | "pack" | "idx" | "rpc";

/** http-backend's request table (`services[]`): method, path suffix, what it serves. */
const ROUTES: Array<{ method: "GET" | "POST"; pattern: RegExp; route: Route }> = [
  { method: "GET", pattern: /\/HEAD$/, route: "head" },
  { method: "GET", pattern: /\/info\/refs$/, route: "info-refs" },
  {
    method: "GET",
    pattern: /\/objects\/info\/(?:alternates|http-alternates)$/,
    route: "text-file",
  },
  { method: "GET", pattern: /\/objects\/info\/packs$/, route: "info-packs" },
  {
    method: "GET",
    pattern: /\/objects\/[0-9a-f]{2}\/(?:[0-9a-f]{38}|[0-9a-f]{62})$/,
    route: "loose",
  },
  {
    method: "GET",
    pattern: /\/objects\/pack\/pack-(?:[0-9a-f]{40}|[0-9a-f]{64})\.pack$/,
    route: "pack",
  },
  {
    method: "GET",
    pattern: /\/objects\/pack\/pack-(?:[0-9a-f]{40}|[0-9a-f]{64})\.idx$/,
    route: "idx",
  },
  { method: "POST", pattern: /\/git-upload-pack$/, route: "rpc" },
  { method: "POST", pattern: /\/git-upload-archive$/, route: "rpc" },
  { method: "POST", pattern: /\/git-receive-pack$/, route: "rpc" },
];

const textEncoder = new TextEncoder();

/** The body of every 500: what failed goes to the logger, never to the client. */
const INTERNAL_ERROR = "Internal server error";

function internalError(): HttpResponse {
  return {
    status: 500,
    headers: { ...NO_CACHE_HEADERS, "Content-Type": "text/plain" },
    body: textEncoder.encode(INTERNAL_ERROR),
  };
}

/**
 * The repository path of a request path, each segment percent-decoded (as a web server
 * decodes `PATH_INFO` for http-backend); undefined when a segment does not decode or
 * encodes a `/`, `\` or NUL (Apache's `AllowEncodedSlashes Off` answers those 404 too).
 */
function decodeRepoPath(path: string): string | undefined {
  const segments = path.split("/");
  const out: string[] = [];
  for (const segment of segments) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return undefined;
    }
    if (/[/\\\0]/.test(decoded)) return undefined;
    out.push(decoded);
  }
  return out.join("/");
}

/** The content types of http-backend's `send_local_file`, per route. */
const FILE_TYPES: Partial<Record<Route, string>> = {
  "text-file": "text/plain",
  loose: "application/x-git-loose-object",
  pack: "application/x-git-packed-objects",
  idx: "application/x-git-packed-objects-toc",
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** git's `show_date(when, 0, DATE_RFC2822)` (http-backend's `hdr_date`): `Sat, 2 Jan 2027 03:04:05 +0000`. */
function httpBackendDate(ms: number): string {
  const d = new Date(Math.floor(ms / 1000) * 1000);
  const two = (n: number) => String(n).padStart(2, "0");
  return (
    `${WEEKDAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ` +
    `${d.getUTCFullYear()} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:` +
    `${two(d.getUTCSeconds())} +0000`
  );
}

/** http-backend's `hdr_cache_forever`: what never changes (objects, packs) cached for a year. */
function cacheForeverHeaders(now = Date.now()): Record<string, string> {
  return {
    Date: httpBackendDate(now),
    Expires: httpBackendDate(now + 31536000 * 1000),
    "Cache-Control": "public, max-age=31536000",
  };
}

/** An answer with no body, as http-backend's `not_found` / `forbidden` (the reason on its stderr). */
function refusal(status: 403 | 404, headers: Record<string, string> = {}): HttpResponse {
  return { status, headers: { ...NO_CACHE_HEADERS, ...headers }, body: new Uint8Array(0) };
}

function header(request: HttpRequest, name: string): string | undefined {
  for (const [key, value] of Object.entries(request.headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
}

/** The HTTP options of a served repository's layered settings. */
function httpOptionsOf(
  settings: GitServeSettings,
  options: ServedHttpHandlerOptions,
): HttpServerOptions {
  const {
    hooks,
    uploadPackHooks,
    hideRefs,
    uploadPackHideRefs,
    receivePackHideRefs,
    requestPolicy,
    advertiseObjectInfo,
    logger,
    capabilities: _capabilities,
    ...receive
  } = settings;
  const out: HttpServerOptions = {
    receivePack: { ...receive, ...(hooks ? { hooks } : {}) },
    uploadPack: {
      ...(uploadPackHooks ? { hooks: uploadPackHooks } : {}),
      ...(uploadPackHideRefs ? { hideRefs: uploadPackHideRefs } : {}),
    },
  };
  if (receivePackHideRefs && out.receivePack) out.receivePack.hideRefs = receivePackHideRefs;
  if (hideRefs) out.hideRefs = hideRefs;
  const policy = requestPolicy ?? options.requestPolicy;
  if (policy !== undefined) out.requestPolicy = policy;
  if (advertiseObjectInfo !== undefined) out.advertiseObjectInfo = advertiseObjectInfo;
  if (options.maxRequestBodyBytes !== undefined) {
    out.maxRequestBodyBytes = options.maxRequestBodyBytes;
  }
  if (options.protocolV2 !== undefined) out.protocolV2 = options.protocolV2;
  if (options.v2Capabilities !== undefined) out.v2Capabilities = options.v2Capabilities;
  if (options.keepAliveMs !== undefined) out.keepAliveMs = options.keepAliveMs;
  const log: ReceivePackLogger | undefined =
    logger ?? (options.logger ? { error: options.logger.error } : undefined);
  if (log) out.logger = log;
  return out;
}

/**
 * Runs `produce` inside the repository's `around` (as `serveGitService` serves a request),
 * which then lasts until the run behind the streamed response has ended, not only until
 * the response head is out.
 */
function withinAround(
  served: ServedRepository,
  service: "git-upload-pack" | "git-receive-pack",
  produce: (context: Pick<HttpHandlerContext, "done">) => Promise<HttpResponse>,
  logger: ServedHttpHandlerOptions["logger"],
  requestContext: ServedRequestContext,
): Promise<HttpResponse> {
  const around = served.around?.bind(served);
  if (!around) return produce({});
  return new Promise<HttpResponse>((resolve, reject) => {
    let delivered = false;
    around(
      service,
      async () => {
        let finished: Promise<void> = Promise.resolve();
        const response = await produce({
          done: (run) => {
            finished = run;
          },
        });
        delivered = true;
        resolve(response);
        await finished;
      },
      requestContext,
    ).then(
      () => {
        // an `around` that never served the request: answered, not left hanging
        if (!delivered) {
          logger?.error(`${service}: the repository's around ended without serving the request`);
          delivered = true;
          resolve(internalError());
        }
      },
      (error: unknown) => {
        if (!delivered) reject(error);
        else logger?.error(`${service} failed`, error);
      },
    );
  });
}

/**
 * http-backend's `select_service`: whether `name` (`git-receive-pack`) is served for this
 * request, else the 403 and the reason http-backend writes to its stderr.
 */
function selectService(
  name: string,
  served: ServedRepository,
  options: ServedHttpHandlerOptions,
  remoteUser: string | undefined,
): { service: "git-upload-pack" | "git-receive-pack" } | { refused: string } {
  const short = name.startsWith("git-") ? name.slice(4) : undefined;
  const key = short === undefined ? undefined : RPC_SERVICES[short];
  if (short === undefined || key === undefined) {
    return { refused: `Unsupported service: '${name}'` };
  }
  const operator =
    short === "upload-pack"
      ? (options.enableUploadPack ?? true)
      : short === "receive-pack"
        ? options.enableReceivePack
        : undefined;
  // the operator's false is final (a repository's config cannot open what it closed)
  const override =
    options.allowOverride === false || operator === false
      ? undefined
      : configBoolOf(served.config, `http.${key}`);
  const enabled =
    operator !== false && (override ?? operator ?? (remoteUser !== undefined && remoteUser !== ""));
  // upload-archive is not served here: refused as when it is not enabled
  if (!enabled || short === "upload-archive") {
    return { refused: `Service not enabled: '${short}'` };
  }
  return { service: name as "git-upload-pack" | "git-receive-pack" };
}

/**
 * The dumb protocol's `info/refs` (http-backend's `show_text_ref`): `<oid>\t<ref>` per ref
 * under `refs/`, an annotated tag followed by its peeled `^{}` line; unlike http-backend,
 * without the refs upload-pack hides (`hidden`).
 */
async function textRefs(served: ServedRepository, hidden: readonly string[]): Promise<Uint8Array> {
  let text = "";
  for (const [name, oid] of visibleRefs(await served.refStore.listAll(), hidden)) {
    if (!name.startsWith("refs/")) continue;
    text += `${oid}\t${name}\n`;
    const peeled = await peelFully(served.repository, oid);
    if (peeled) text += `${peeled}\t${name}^{}\n`;
  }
  return textEncoder.encode(text);
}

/** The dumb protocol's `HEAD` (http-backend's `get_head`): `ref: <target>` or its id. */
async function textHead(served: ServedRepository): Promise<Uint8Array> {
  const target = await served.refStore.getSymrefTarget?.("HEAD");
  if (target) return textEncoder.encode(`ref: ${target}\n`);
  const oid = await served.refStore.get("HEAD");
  return textEncoder.encode(oid ? `${oid}\n` : "");
}

/**
 * A dumb-protocol file (`path` in the git directory, as http-backend's `cmd_arg`): the
 * generated `objects/info/packs` (`get_info_packs`: `P <pack>` per local pack, then an empty
 * line), else the file as `send_local_file` sends it, with `hdr_nocache` (alternates) or
 * `hdr_cache_forever` (objects, packs, indexes); 404 when missing or when the repository
 * has no files to serve (`ServedRepository.files`).
 */
async function dumbFile(
  served: ServedRepository,
  route: Route,
  path: string,
  logger: ServedHttpHandlerOptions["logger"],
  headOnly = false,
): Promise<HttpResponse> {
  const files = served.files;
  if (!files) {
    logger?.info(`Cannot open '${path}': the repository has no files to serve`);
    return refusal(404);
  }
  if (route === "info-packs") {
    let text = "";
    for (const pack of await files.localPacks()) text += `P ${pack}\n`;
    const body = textEncoder.encode(`${text}\n`);
    return {
      status: 200,
      headers: {
        ...NO_CACHE_HEADERS,
        "Content-Length": String(body.length),
        "Content-Type": "text/plain; charset=utf-8",
      },
      body,
    };
  }
  const type = FILE_TYPES[route];
  if (type === undefined) return refusal(404);
  const cache = route === "text-file" ? NO_CACHE_HEADERS : cacheForeverHeaders();
  const file: (ServedGitFileStats & { content?: ReadableStream<Uint8Array> }) | undefined = headOnly
    ? await files.stat(path)
    : await files.read(path);
  if (!file) {
    logger?.info(`Cannot open '${path}': No such file or directory`);
    return refusal(404);
  }
  return {
    status: 200,
    headers: {
      ...cache,
      "Content-Length": String(file.size),
      "Content-Type": type,
      ...(file.lastModified !== undefined
        ? { "Last-Modified": httpBackendDate(file.lastModified) }
        : {}),
    },
    body: file.content ?? new Uint8Array(0),
  };
}

/**
 * Creates a smart-HTTP handler over served repositories, as git's `http-backend` serves
 * the repositories of a project root (see the module's example).
 *
 * The request is answered in http-backend's order: its path is matched against http-backend's
 * request table (no match: 404; the wrong method: 405 with `Allow`), the repository is looked
 * up (`isUnsafeServicePath`, then `resolveRepository`; none: 404), then the service is
 * selected: an unknown one or one not enabled is a 403 with an empty body, as http-backend
 * answers (`Service not enabled: 'receive-pack'` goes to the logger, as http-backend writes
 * it to its stderr). A served request runs with the repository's layered settings inside its
 * `around` (for receive-pack, until the push's run has ended).
 */
export function createServedHttpHandler(
  options: ServedHttpHandlerOptions,
): (request: HttpRequest) => Promise<HttpResponse> {
  const logger = options.logger;
  return async (request: HttpRequest): Promise<HttpResponse> => {
    const method = request.method === "HEAD" ? "GET" : request.method;
    let match: (typeof ROUTES)[number] | undefined;
    let repoPath = "";
    let fileAt = 0;
    for (const entry of ROUTES) {
      const found = entry.pattern.exec(request.path);
      if (!found) continue;
      if (entry.method !== method) {
        return {
          status: 405,
          headers: { ...NO_CACHE_HEADERS, Allow: entry.method === "GET" ? "GET, HEAD" : "POST" },
          body: new Uint8Array(0),
        };
      }
      match = entry;
      fileAt = found.index;
      const decoded = decodeRepoPath(request.path.slice(0, found.index));
      if (decoded === undefined) {
        logger?.info(`Request not supported: '${request.path}'`);
        return refusal(404);
      }
      repoPath = decoded;
      break;
    }
    if (!match) {
      logger?.info(`Request not supported: '${request.path}'`);
      return refusal(404);
    }

    let remoteUser: string | undefined;
    let remoteAddr: string | undefined;
    try {
      remoteUser = (await options.remoteUser?.(request)) || undefined;
      remoteAddr = (await options.remoteAddr?.(request)) || undefined;
    } catch (error) {
      logger?.error("Error identifying the client", error);
      return internalError();
    }
    const rpcName =
      match.route === "rpc"
        ? request.path.slice(request.path.lastIndexOf("/") + 1)
        : match.route === "info-refs"
          ? request.query.service
          : undefined;
    const gitProtocol = header(request, "git-protocol");
    const serviceRequest: HttpServiceRequest = {
      service: rpcName ?? "getanyfile",
      path: repoPath,
      version: parseGitProtocolEnv(gitProtocol).version,
      ...(gitProtocol !== undefined ? { gitProtocol } : {}),
      http: request,
      ...(remoteUser !== undefined ? { remoteUser } : {}),
      ...(remoteAddr !== undefined ? { remoteAddr } : {}),
    };

    let served: ServedRepository | undefined;
    if (repoPath !== "" && !isUnsafeServicePath(repoPath)) {
      try {
        served = await options.resolveRepository(repoPath, serviceRequest);
      } catch (error) {
        logger?.error(`Error resolving repository ${repoPath}`, error);
        served = undefined;
      }
    }
    if (!served) {
      logger?.info(`Not a git repository: '${repoPath}'`);
      return refusal(404);
    }

    if (rpcName === undefined) {
      // the dumb protocol: on unless turned off (as http-backend), never where upload-pack
      // is not served, and without the refs upload-pack hides
      const explicit =
        options.allowOverride === false || options.getAnyFile === false
          ? undefined
          : configBoolOf(served.config, "http.getanyfile");
      const getAnyFile = options.getAnyFile !== false && (explicit ?? options.getAnyFile ?? true);
      if (!getAnyFile) {
        logger?.info("Unsupported service: getanyfile");
        return refusal(403);
      }
      const uploadPack = selectService("git-upload-pack", served, options, remoteUser);
      if ("refused" in uploadPack) {
        logger?.info(uploadPack.refused);
        return refusal(403);
      }
      // HEAD answers the head of a GET without its body (and never opens a file)
      const headOnly = request.method === "HEAD";
      const answer = (response: HttpResponse): HttpResponse =>
        headOnly && response.body instanceof Uint8Array && response.body.length > 0
          ? { ...response, body: new Uint8Array(0) }
          : response;
      try {
        const settings = resolveServeSettings(options.settings, served);
        const hidden = [...(settings.hideRefs ?? []), ...(settings.uploadPackHideRefs ?? [])];
        if (match.route === "info-refs") {
          const body = await textRefs(served, hidden);
          return answer({
            status: 200,
            headers: {
              ...NO_CACHE_HEADERS,
              "Content-Length": String(body.length),
              "Content-Type": "text/plain",
            },
            body,
          });
        }
        if (match.route === "head") {
          const body = await textHead(served);
          return answer({
            status: 200,
            headers: { "Content-Length": String(body.length), "Content-Type": "text/plain" },
            body,
          });
        }
        // fail closed: the object files hold what hidden refs reach, so with refs hidden they
        // are served only where the operator (getAnyFile: true) asked for them explicitly, or
        // the repository (http.getanyfile=true) while only its own config hides refs: a
        // repository cannot re-open what the operator's patterns (its `settings`, the
        // resolver's) hide
        const operatorHides = layerServeSettings(options.settings, served.settings);
        const operatorHidden =
          (operatorHides.hideRefs?.length ?? 0) + (operatorHides.uploadPackHideRefs?.length ?? 0) >
          0;
        const optedIn = options.getAnyFile === true || (explicit === true && !operatorHidden);
        if (hidden.length > 0 && !optedIn) {
          logger?.info("Unsupported service: getanyfile");
          return refusal(403);
        }
        return answer(
          await dumbFile(served, match.route, request.path.slice(fileAt + 1), logger, headOnly),
        );
      } catch (error) {
        logger?.error(`Error answering ${request.path}`, error);
        return internalError();
      }
    }

    const selected = selectService(rpcName, served, options, remoteUser);
    if ("refused" in selected) {
      logger?.info(selected.refused);
      return refusal(403);
    }
    const { service } = selected;
    if (match.route === "rpc") {
      // check_content_type: the request body's type, exactly
      const accepted = `application/x-git-${service.slice(4)}-request`;
      const actual = header(request, "content-type") ?? "";
      if (actual !== accepted) {
        return {
          status: 415,
          headers: { ...NO_CACHE_HEADERS },
          body: textEncoder.encode(
            `Expected POST with Content-Type '${accepted}', but received '${actual}' instead.\n`,
          ),
        };
      }
    }
    const settings = resolveServeSettings(options.settings, served);
    const serverOptions = httpOptionsOf(settings, options);
    const { repository, refStore } = served;
    // git has no v2 push: receive-pack is v0 whatever the client asks
    const v2 = service === "git-upload-pack" && isProtocolV2Request(request, serverOptions);
    const uploadPackOptions: HttpServerOptions = {
      ...serverOptions,
      capabilities: defaultUploadPackCapabilities(
        serverOptions.requestPolicy ?? "ADVERTISED",
        repository,
      ),
    };

    try {
      return await withinAround(
        served,
        service,
        async (context) => {
          if (match.route === "info-refs") {
            if (v2) return handleInfoRefsV2(serverOptions, repository);
            const version1 = requestedProtocolVersion(gitProtocol) === 1;
            return service === "git-upload-pack"
              ? handleInfoRefs(refStore, uploadPackOptions, repository, version1)
              : handleReceivePackInfoRefs(refStore, serverOptions, version1, repository);
          }
          const runContext: HttpHandlerContext = {
            repoPath,
            ...context,
            ...(remoteUser !== undefined ? { remoteUser } : {}),
            ...(remoteAddr !== undefined ? { remoteAddr } : {}),
          };
          if (v2)
            return handleUploadPackV2(request, repository, refStore, serverOptions, runContext);
          return service === "git-upload-pack"
            ? handleUploadPack(request, repository, refStore, uploadPackOptions, runContext)
            : handleReceivePack(request, repository, refStore, serverOptions, runContext);
        },
        logger,
        {
          http: true,
          ...(remoteUser !== undefined ? { remoteUser } : {}),
          ...(remoteAddr !== undefined ? { remoteAddr } : {}),
        },
      );
    } catch (error) {
      logger?.error(`Error handling ${service} request`, error);
      return internalError();
    }
  };
}

/**
 * {@link createServedHttpHandler} as a Fetch API handler (Workers, Deno, Bun, a Node server
 * through a bridge).
 *
 * @example
 * ```ts
 * Deno.serve(createServedFetchHandler({ resolveRepository, enableReceivePack: true }));
 * ```
 */
export function createServedFetchHandler(
  options: ServedHttpHandlerOptions,
): (request: Request) => Promise<Response> {
  const handler = createServedHttpHandler(options);
  return async (request) =>
    httpResponseToFetchResponse(await handler(fetchRequestToHttpRequest(request)));
}
