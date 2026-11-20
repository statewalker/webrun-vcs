/**
 * The smart-HTTP server over the same repositories `serveGitConnection` serves: a resolver
 * of {@link ServedRepository} (path → repository, config, settings, hooks, `around`), as
 * git's `http-backend` serves a repository on disk. The settings are layered as
 * `serveGitService` layers them (git's defaults, the operator's, the repository's config,
 * the resolver's), so `receive.*`, `uploadpack.hideRefs` and `transfer.hideRefs` come from the
 * repository's own config, its hooks run for a push (pre-receive, update, post-receive,
 * post-update, push-to-checkout, reference-transaction through `around`), and the services
 * are enabled as http-backend enables them (`http.uploadpack`, `http.receivepack`,
 * `http.getanyfile`).
 *
 * @example
 * ```ts
 * const handle = createServedFetchHandler({
 *   resolveRepository: createBasePathResolver({
 *     files,
 *     basePath: "/srv/git",
 *     exportAll: true, // GIT_HTTP_EXPORT_ALL
 *     openRepository: async (gitDir) => {
 *       const opened = await worktree.openRepository?.(gitDir);
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
  resolveServeSettings,
  type ServedRepository,
} from "../../operations/serve-git-connection.js";
import { configBoolOf } from "../../operations/server-config.js";
import { parseGitProtocolEnv } from "../../protocol/git-daemon-request.js";
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
}

/** Options of {@link createServedHttpHandler}. */
export interface ServedHttpHandlerOptions {
  /**
   * The repository a request names, or undefined (answered 404, as http-backend's "Not a git
   * repository" and "Repository not exported"). `path` is the URL path before the service
   * suffix (`/r.git` of `/r.git/info/refs`), percent-decoded as the URL parser leaves it; it
   * has passed {@link isUnsafeServicePath} (absolute, no `..`, `//`, `/./`, NUL or
   * backslash). Map it with `createBasePathResolver`, never by joining it to a directory
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
   * Serve upload-pack (default true, as http-backend); a repository's `http.uploadpack`
   * overrides it (unless `allowOverride` is false)
   */
  enableUploadPack?: boolean;
  /**
   * Serve receive-pack: true to every client, false to none; default (undefined) as
   * http-backend: to authenticated users only (`remoteUser`). A repository's
   * `http.receivepack` overrides it (unless `allowOverride` is false)
   */
  enableReceivePack?: boolean;
  /**
   * Answer the dumb protocol's requests (http-backend's `http.getanyfile`, default true):
   * `HEAD` and `info/refs` without a service are served from the refs; `objects/...` files
   * are not served here (404) whatever this says. False refuses them all (403). A
   * repository's `http.getanyfile` overrides it (unless `allowOverride` is false)
   */
  getAnyFile?: boolean;
  /**
   * Let a repository's config (`http.uploadpack`, `http.receivepack`, `http.getanyfile`)
   * decide (default true: http-backend reads them from the repository's config)
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

type Route = "head" | "info-refs" | "file" | "rpc";

/** http-backend's request table (`services[]`): method, path suffix, what it serves. */
const ROUTES: Array<{ method: "GET" | "POST"; pattern: RegExp; route: Route }> = [
  { method: "GET", pattern: /\/HEAD$/, route: "head" },
  { method: "GET", pattern: /\/info\/refs$/, route: "info-refs" },
  {
    method: "GET",
    pattern: /\/objects\/info\/(?:alternates|http-alternates|packs)$/,
    route: "file",
  },
  {
    method: "GET",
    pattern: /\/objects\/[0-9a-f]{2}\/(?:[0-9a-f]{38}|[0-9a-f]{62})$/,
    route: "file",
  },
  {
    method: "GET",
    pattern: /\/objects\/pack\/pack-(?:[0-9a-f]{40}|[0-9a-f]{64})\.(?:pack|idx)$/,
    route: "file",
  },
  { method: "POST", pattern: /\/git-upload-pack$/, route: "rpc" },
  { method: "POST", pattern: /\/git-upload-archive$/, route: "rpc" },
  { method: "POST", pattern: /\/git-receive-pack$/, route: "rpc" },
];

const textEncoder = new TextEncoder();

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
): Promise<HttpResponse> {
  const around = served.around?.bind(served);
  if (!around) return produce({});
  return new Promise<HttpResponse>((resolve, reject) => {
    let delivered = false;
    around(service, async () => {
      let finished: Promise<void> = Promise.resolve();
      const response = await produce({
        done: (run) => {
          finished = run;
        },
      });
      delivered = true;
      resolve(response);
      await finished;
    }).catch((error: unknown) => {
      if (!delivered) reject(error);
      else logger?.error(`${service} failed`, error);
    });
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
  const override =
    options.allowOverride === false ? undefined : configBoolOf(served.config, `http.${key}`);
  const operator =
    short === "upload-pack"
      ? (options.enableUploadPack ?? true)
      : short === "receive-pack"
        ? options.enableReceivePack
        : undefined;
  const enabled = override ?? operator ?? (remoteUser !== undefined && remoteUser !== "");
  // upload-archive is not served here: refused as when it is not enabled
  if (!enabled || short === "upload-archive") {
    return { refused: `Service not enabled: '${short}'` };
  }
  return { service: name as "git-upload-pack" | "git-receive-pack" };
}

/**
 * The dumb protocol's `info/refs` (http-backend's `show_text_ref`): `<oid>\t<ref>` per ref
 * under `refs/`, an annotated tag followed by its peeled `^{}` line.
 */
async function textRefs(served: ServedRepository): Promise<Uint8Array> {
  let text = "";
  for (const [name, oid] of await served.refStore.listAll()) {
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
      repoPath = request.path.slice(0, found.index);
      break;
    }
    if (!match) {
      logger?.info(`Request not supported: '${request.path}'`);
      return refusal(404);
    }

    const remoteUser = (await options.remoteUser?.(request)) || undefined;
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
      // the dumb protocol
      const getAnyFile =
        (options.allowOverride === false
          ? undefined
          : configBoolOf(served.config, "http.getanyfile")) ??
        options.getAnyFile ??
        true;
      if (!getAnyFile) {
        logger?.info("Unsupported service: getanyfile");
        return refusal(403);
      }
      if (match.route === "info-refs") {
        return {
          status: 200,
          headers: { ...NO_CACHE_HEADERS, "Content-Type": "text/plain" },
          body: await textRefs(served),
        };
      }
      if (match.route === "head") {
        return {
          status: 200,
          headers: { "Content-Type": "text/plain" },
          body: await textHead(served),
        };
      }
      logger?.info(`Cannot open '${request.path}': files are not served`);
      return refusal(404);
    }

    const selected = selectService(rpcName, served, options, remoteUser);
    if ("refused" in selected) {
      logger?.info(selected.refused);
      return refusal(403);
    }
    const { service } = selected;
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
              : handleReceivePackInfoRefs(refStore, serverOptions, version1);
          }
          const runContext: HttpHandlerContext = { repoPath, ...context };
          if (v2)
            return handleUploadPackV2(request, repository, refStore, serverOptions, runContext);
          return service === "git-upload-pack"
            ? handleUploadPack(request, repository, refStore, uploadPackOptions, runContext)
            : handleReceivePack(request, repository, refStore, serverOptions, runContext);
        },
        logger,
      );
    } catch (error) {
      logger?.error(`Error handling ${service} request`, error);
      return {
        status: 500,
        headers: { ...NO_CACHE_HEADERS, "Content-Type": "text/plain" },
        body: textEncoder.encode(error instanceof Error ? error.message : "Internal server error"),
      };
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
