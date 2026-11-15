/**
 * git smart HTTP on a mesh peer: the server of `@statewalker/vcs-transport` behind httpeers'
 * access middleware, with per-service and per-ref authorization.
 */

import { isValidRefName } from "@statewalker/vcs-core";
import {
  createFetchHandler,
  type HookResult,
  type HookVerdict,
  type HttpHandlerOptions,
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
   * The ref prefix a `git:write-own` caller may push to (default `refs/peers/<peerId>/`).
   * `undefined` refuses that caller every push.
   */
  ownNamespace?: (peer: string) => string | undefined;
}

/** The default own namespace: `refs/peers/<peerId>/`, when the peer id can be one ref component. */
export function defaultOwnNamespace(peer: string): string | undefined {
  if (peer.includes("/") || !isValidRefName(`refs/peers/${peer}/x`)) return undefined;
  return `refs/peers/${peer}/`;
}

/** Whether a request is for receive-pack (a push, or its ref advertisement). */
export function isReceivePackRequest(request: Request): boolean {
  const url = new URL(request.url);
  return (
    url.pathname.endsWith("/git-receive-pack") ||
    (url.pathname.endsWith("/info/refs") && url.searchParams.get("service") === "git-receive-pack")
  );
}

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
 * hooks, which run after the namespace check).
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
  const { access, ownNamespace = defaultOwnNamespace, repository, refStore, ...rest } = options;
  let resolveRepository = options.resolveRepository;
  if (!resolveRepository) {
    if (!repository || !refStore)
      throw new Error("meshGitHandler: give repository and refStore, or resolveRepository");
    const resolved = { repository, refStore };
    resolveRepository = async () => resolved;
  }
  const base: HttpHandlerOptions = { ...rest, resolveRepository };
  const serve = createFetchHandler(base);

  return withMeshAccess(access, async (request: Request, caller: MeshCaller) => {
    const caps = caller.capabilities;
    if (!isReceivePackRequest(request)) {
      if (!caps.has(GIT_READ)) return refusal(403, `${GIT_READ} required`);
      return serve(request);
    }
    if (caps.has(GIT_WRITE)) return serve(request);
    if (!caps.has(GIT_WRITE_OWN)) return refusal(403, `${GIT_WRITE} required`);
    const prefix = caller.peer === undefined ? undefined : ownNamespace(caller.peer);
    if (!prefix) return refusal(403, "this peer id cannot name a ref namespace");
    return createFetchHandler({
      ...base,
      receivePack: {
        ...base.receivePack,
        hooks: ownNamespaceHooks(prefix, base.receivePack?.hooks),
      },
    })(request);
  });
}
