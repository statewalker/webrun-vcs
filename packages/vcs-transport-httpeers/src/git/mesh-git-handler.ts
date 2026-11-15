/**
 * git smart HTTP on a mesh peer: the server of `@statewalker/vcs-transport` behind httpeers'
 * access middleware, with per-service and per-ref authorization.
 */

import { isValidRefName } from "@statewalker/vcs-core";
import {
  createFetchHandler,
  fetchRequestToHttpRequest,
  type HookResult,
  type HookVerdict,
  type HttpHandlerOptions,
  parseGitRequest,
  type ReceiveCommand,
  type ReceivePackHookContext,
  type ReceivePackHooks,
  type RefStore,
  type RepositoryFacade,
} from "@statewalker/vcs-transport";
import {
  GIT_READ,
  GIT_WRITE,
  GIT_WRITE_OWN,
  type MeshAccessOptions,
  type MeshCaller,
  type MeshHandler,
  refusal,
  withMeshAccess,
} from "../access/index.js";

/** Options of {@link meshGitHandler}. */
export interface MeshGitHandlerOptions extends Omit<HttpHandlerOptions, "resolveRepository"> {
  /** The repository served at any path (with `refStore`), unless `resolveRepository` is given */
  repository?: RepositoryFacade;
  /** The refs of `repository` */
  refStore?: RefStore;
  /** Resolves the repository of a request path (as `createFetchHandler`'s) */
  resolveRepository?: HttpHandlerOptions["resolveRepository"];
  /** The mesh: issuer, rules, revocation, how the caller's peer is proven */
  access: MeshAccessOptions;
  /**
   * The ref prefix a `git:write-own` caller may push to (default `refs/peers/<peerId>/`). It
   * must start with `refs/`; a missing trailing `/` is added. `undefined` refuses that caller
   * every push.
   */
  ownNamespace?: (peer: string) => string | undefined;
  /**
   * Which objects a `git:read` caller may fetch by id. Default "REACHABLE_COMMIT": the refs and
   * the commits they reach, over protocol v0 and v2 alike, so objects no branch or tag reaches
   * (a refused push's leftovers, history a ref was rewound past, another peer's dropped work)
   * stay private: `ERR upload-pack: not our ref <oid>`. Plain git's v2 serves any object it
   * has ("ANY"); pass that to serve the mesh as git does.
   */
  requestPolicy?: HttpHandlerOptions["requestPolicy"];
}

/** The default own namespace: `refs/peers/<peerId>/`, when the peer id can be one ref component. */
export function defaultOwnNamespace(peer: string): string | undefined {
  if (peer.includes("/") || !isValidRefName(`refs/peers/${peer}/x`)) return undefined;
  return `refs/peers/${peer}/`;
}

/**
 * Which service a request is for, read exactly as the transport's server reads it
 * (`parseGitRequest`), or `undefined` when it is no git request (the server answers 400).
 */
export function gitServiceOf(request: Request): "git-upload-pack" | "git-receive-pack" | undefined {
  const { path, query } = fetchRequestToHttpRequest(request);
  return parseGitRequest(path, query)?.service;
}

/** Whether a request is for receive-pack (a push, or its ref advertisement). */
export function isReceivePackRequest(request: Request): boolean {
  return gitServiceOf(request) === "git-receive-pack";
}

const badRequest = (message: string) =>
  new Response(message, { status: 400, headers: { "content-type": "text/plain" } });

/** A hook verdict as the refs it refuses (`"all"`: the whole push) and why. */
function refusedBy(
  verdict: HookVerdict,
): { refs: Set<string> | "all"; message?: string } | undefined {
  if (verdict === undefined || verdict === true) return undefined;
  if (verdict === false) return { refs: "all" };
  if (typeof verdict === "string") return { refs: "all", message: verdict };
  const result = verdict as HookResult;
  if (result.ok) return undefined;
  return {
    refs: result.rejectedRefs ? new Set(result.rejectedRefs) : "all",
    message: result.message,
  };
}

/**
 * Hooks that keep a `git:write-own` caller inside `prefix`, checked before the pack is read
 * (`ng <ref> not allowed …`; a push refused for every ref stores nothing) and again per ref,
 * then the application's own `hooks`.
 */
function ownNamespaceHooks(prefix: string, hooks: ReceivePackHooks | undefined): ReceivePackHooks {
  const message = `not allowed: this peer writes ${prefix}* only`;
  const outside = (ref: string) => !ref.startsWith(prefix);
  return {
    ...hooks,
    async authorize(commands: readonly ReceiveCommand[], ctx: ReceivePackHookContext) {
      const refused = commands.filter((c) => outside(c.refName)).map((c) => c.refName);
      const theirs = hooks?.authorize ? refusedBy(await hooks.authorize(commands, ctx)) : undefined;
      // the application refused the whole push: its answer (a 403 over smart HTTP)
      if (theirs?.refs === "all") return { ok: false, message: theirs.message };
      const all = new Set([...refused, ...(theirs?.refs ?? [])]);
      if (all.size === 0) return true;
      return {
        ok: false,
        rejectedRefs: [...all],
        message: refused.length > 0 ? message : theirs?.message,
      };
    },
    async update(refName, oldOid, newOid, ctx) {
      if (outside(refName)) return message;
      return hooks?.update?.(refName, oldOid, newOid, ctx);
    },
  };
}

/**
 * The git smart-HTTP handler of a mesh peer. Each request's membership token is verified first
 * (no token 401, expired 401, forged or foreign 403); then
 *
 * - upload-pack (fetch, clone, ls-remote) needs `git:read`, else 403;
 * - receive-pack needs `git:write` (any ref) or `git:write-own`, else 403. A `git:write-own`
 *   caller pushes only into its own namespace (`refs/peers/<peerId>/*` by default): a command
 *   outside it is refused before the pack is read, as `ng <ref> not allowed: …`, and a push
 *   refused for every ref stores nothing.
 *
 * The rest is `createFetchHandler`'s, with these options (protocol v2, limits, the receive-pack
 * hooks, which run after the namespace check). One default differs from git's: `requestPolicy`
 * is "REACHABLE_COMMIT" (git's v2 serves any object it has), since a peer's read access is
 * meant to cover what its refs publish, not every object the repository holds.
 *
 * @example
 * ```ts
 * const handler = meshGitHandler({
 *   repository,
 *   refStore,
 *   access: { issuer: hubPeerId, rules: gitRules({ contributors: true }) },
 * });
 * ```
 */
export function meshGitHandler(options: MeshGitHandlerOptions): MeshHandler {
  const {
    access,
    ownNamespace = defaultOwnNamespace,
    repository,
    refStore,
    requestPolicy = "REACHABLE_COMMIT",
    ...rest
  } = options;
  let resolveRepository = options.resolveRepository;
  if (!resolveRepository) {
    if (!repository || !refStore)
      throw new Error("meshGitHandler: give repository and refStore, or resolveRepository");
    const resolved = { repository, refStore };
    resolveRepository = async () => resolved;
  }
  const base: HttpHandlerOptions = { ...rest, requestPolicy, resolveRepository };
  const serve = createFetchHandler(base);
  /** One handler per own namespace (their hooks differ by prefix) */
  const byPrefix = new Map<string, ReturnType<typeof createFetchHandler>>();
  const servePrefix = (prefix: string) => {
    let handler = byPrefix.get(prefix);
    if (!handler) {
      if (byPrefix.size >= 1024) byPrefix.clear();
      handler = createFetchHandler({
        ...base,
        receivePack: {
          ...base.receivePack,
          hooks: ownNamespaceHooks(prefix, base.receivePack?.hooks),
        },
      });
      byPrefix.set(prefix, handler);
    }
    return handler;
  };

  return withMeshAccess(access, async (request: Request, caller: MeshCaller) => {
    const caps = caller.capabilities;
    // one reading of the request for the decision and the server: a repeated `service` is refused
    if (new URL(request.url).searchParams.getAll("service").length > 1) {
      await request.body?.cancel().catch(() => {});
      return badRequest("Repeated service parameter");
    }
    if (!isReceivePackRequest(request)) {
      if (!caps.has(GIT_READ)) return refusal(403, `${GIT_READ} required`);
      return serve(request);
    }
    if (caps.has(GIT_WRITE)) return serve(request);
    if (!caps.has(GIT_WRITE_OWN)) return refusal(403, `${GIT_WRITE} required`);
    let prefix = caller.peer === undefined ? undefined : ownNamespace(caller.peer);
    if (!prefix?.startsWith("refs/"))
      return refusal(403, "this peer id cannot name a ref namespace");
    // a prefix is a directory: `refs/peers/a` must not also admit `refs/peers/ab`
    if (!prefix.endsWith("/")) prefix = `${prefix}/`;
    return servePrefix(prefix)(request);
  });
}
