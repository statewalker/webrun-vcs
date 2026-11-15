/**
 * The mesh's side of a repository: who is calling (a Biscuit membership token bound to the peer
 * the transport proved) and what they may do with git (capabilities derived from mesh roles).
 */

import {
  access,
  type IssuerKeys,
  type RevocationChecker,
  type RuleSet,
  ruleSet,
  withAccess,
} from "@statewalker/httpeers-access";
import { ANONYMOUS, lookupPeer, type ProvenPeer } from "@statewalker/httpeers-core";

/** Fetch (clone, ls-remote) and LFS downloads. */
export const GIT_READ = "git:read";
/** Push to any ref, and LFS uploads. */
export const GIT_WRITE = "git:write";
/** Push only into the caller's own namespace (`refs/peers/<peerId>/*`), and LFS uploads. */
export const GIT_WRITE_OWN = "git:write-own";

/** A request handler in the Fetch API's shape. */
export type MeshHandler = (request: Request) => Promise<Response>;

/**
 * git's capabilities from httpeers' mesh roles, as a hub issues them (`member` from its join flow,
 * `admin` and `hidden` otherwise): every role reads, `admin` writes anywhere. With
 * `contributors`, members may also push into their own namespace (`refs/peers/<peerId>/*`); it is
 * opt-in, since every peer that joined the mesh is a member.
 *
 * @example
 * ```ts
 * const rules = gitRules({ contributors: true });
 * deriveCapabilities(rules, ["member"]); // Set { "git:read", "git:write-own" }
 * ```
 */
export function gitRules(options: { contributors?: boolean } = {}): RuleSet {
  return ruleSet({
    version: 1,
    rules: [
      `capability("${GIT_READ}") <- role("member");`,
      `capability("${GIT_READ}") <- role("hidden");`,
      `capability("${GIT_READ}") <- role("admin");`,
      `capability("${GIT_WRITE}") <- role("admin");`,
      ...(options.contributors ? [`capability("${GIT_WRITE_OWN}") <- role("member");`] : []),
    ],
    policies: [
      `allow if capability("${GIT_READ}");`,
      `allow if capability("${GIT_WRITE}");`,
      ...(options.contributors ? [`allow if capability("${GIT_WRITE_OWN}");`] : []),
    ],
  });
}

/** How a serving peer checks its callers. */
export interface MeshAccessOptions {
  /** The mesh whose tokens are accepted: the hub's peerId (also its verifying key by default) */
  issuer: string;
  /** Roles to capabilities and the policy (default {@link gitRules}`()`: reads for all, writes for admins) */
  rules?: RuleSet;
  /** Where the issuer's verifying keys come from (default: the peerId itself) */
  keys?: IssuerKeys;
  /** A live deny list (`RevocationCache`, or the hub's `RevocationRegistry`) */
  revocation?: RevocationChecker;
  /** This peer's own id, asserted to the policy as `self_peer` */
  selfPeer?: string;
  /**
   * What the transport proved about the caller (default: the binding the peer connection put
   * on the request, see `servePeerConnection`; anonymous without one)
   */
  provenPeer?: (request: Request) => ProvenPeer | Promise<ProvenPeer>;
  /** Clock for token expiry (default `Date.now`) */
  now?: () => number;
}

/** What a request under {@link withMeshAccess} may do. */
export interface MeshCaller {
  /** The peer the transport proved; `undefined` when anonymous */
  peer: string | undefined;
  /** The capabilities its token's roles derive */
  capabilities: ReadonlySet<string>;
}

/**
 * Puts httpeers' access middleware in front of `next`: a request without a token is 401, an
 * expired one or one bound to another peer is 401, a forged or foreign one is 403, a token whose
 * roles the policy does not allow at all is 403. `next` receives the request and its caller.
 */
export function withMeshAccess(
  options: MeshAccessOptions,
  next: (request: Request, caller: MeshCaller) => Promise<Response>,
): MeshHandler {
  return withAccess({
    issuer: options.issuer,
    rules: options.rules ?? gitRules(),
    keys: options.keys,
    revocation: options.revocation,
    selfPeer: options.selfPeer,
    now: options.now,
    provenPeer: options.provenPeer ?? ((request) => lookupPeer(request) ?? ANONYMOUS),
  })(async (request) => {
    const ctx = access(request);
    const peer = ctx?.peer;
    return next(request, {
      peer: typeof peer === "string" && peer !== "" ? peer : undefined,
      capabilities: ctx?.capabilities() ?? new Set<string>(),
    });
  });
}

/** A JSON error response. */
export function refusal(status: 401 | 403, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
