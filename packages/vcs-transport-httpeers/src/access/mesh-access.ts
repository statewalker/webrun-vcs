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
import {
  ANONYMOUS,
  lookupPeer,
  type ProvenPeer,
  registerAnonymous,
  registerPeer,
} from "@statewalker/httpeers-core";

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
   * What the transport proved about the caller. Default: the peer an edge bound to this very
   * request with {@link bindProvenPeer} (`servePeerConnection` does); without one the caller is
   * anonymous, whatever peer header it sent. Mounted straight on HTTP without an edge, give
   * this (say, from a verified client certificate) or every token is refused (401).
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
  const guarded = withAccess({
    issuer: options.issuer,
    rules: options.rules ?? gitRules(),
    keys: options.keys,
    revocation: options.revocation,
    selfPeer: options.selfPeer,
    now: options.now,
    // the binding made below, on the request httpeers-access is given
    provenPeer: (request) => lookupPeer(request) ?? ANONYMOUS,
  })(async (request) => {
    const ctx = access(request);
    const peer = ctx?.peer;
    return next(request, {
      peer: typeof peer === "string" && peer !== "" ? peer : undefined,
      capabilities: ctx?.capabilities() ?? new Set<string>(),
    });
  });
  return async (request) => {
    const peer: ProvenPeer = options.provenPeer
      ? await options.provenPeer(request)
      : BOUND.has(request)
        ? (lookupPeer(request) ?? ANONYMOUS)
        : ANONYMOUS;
    return guarded(withPeer(request, peer));
  };
}

/** Requests an edge bound to the peer its transport proved. */
const BOUND = new WeakSet<Request>();

/** `request` carrying `peer` as its only peer binding (the same request when its headers can change). */
function withPeer(request: Request, peer: ProvenPeer): Request {
  const bind = (target: Request) => {
    if (peer === ANONYMOUS) registerAnonymous(target);
    else registerPeer(target, peer);
    return target;
  };
  try {
    return bind(request);
  } catch {
    // immutable headers: a copy carries the binding
    return bind(
      new Request(request, {
        headers: new Headers(request.headers),
        duplex: "half",
      } as RequestInit),
    );
  }
}

/**
 * Binds `request` to the peer its transport proved (`undefined`: anonymous), replacing any peer
 * header the caller sent. This is the edge's job: whatever puts requests from the network in
 * front of `meshGitHandler` / `meshLfsHandler` calls it (or passes `access.provenPeer`).
 * `servePeerConnection` does it for webrun duplexes. A peer header on a request no edge bound is
 * ignored: the caller is anonymous.
 */
export function bindProvenPeer(request: Request, peer: string | undefined): void {
  if (peer === undefined) registerAnonymous(request);
  else registerPeer(request, peer);
  BOUND.add(request);
}

/** A JSON error response. */
export function refusal(status: 401 | 403, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
