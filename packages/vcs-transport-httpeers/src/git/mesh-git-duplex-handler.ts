/**
 * git's native protocol on a mesh peer: a stream handler for httpeers' duplex streams
 * (`@statewalker/httpeers-libp2p`'s `createDuplexMounts` / `serveDuplex`), with the same
 * authorization as the smart-HTTP handler.
 */

import { MESH_TOKEN_HEADER } from "@statewalker/httpeers-core";
import {
  encodePacket,
  type GitServeOptions,
  type ServeGitConnectionResult,
  type ServeOverDuplexOptions,
  serveGitOverWebrun,
} from "@statewalker/vcs-transport";
import {
  bindProvenPeer,
  GIT_READ,
  GIT_WRITE,
  GIT_WRITE_OWN,
  type MeshAccessOptions,
  type MeshCaller,
  withMeshAccess,
} from "../access/index.js";
import { defaultOwnNamespace } from "./mesh-git-handler.js";
import { ownNamespaceHooks } from "./own-namespace.js";

/** Where a peer mounts its native git handler, and where the connectors open streams by default. */
export const HTTPEERS_GIT_DUPLEX_PATH = "/git";

/**
 * What a duplex stream handler is told about the stream: httpeers-libp2p's `DuplexContext`.
 * `peerId` is the peer the transport proved; `token` is what the caller put in the open frame.
 */
export interface MeshDuplexContext {
  /** The calling peer, proven by the transport's handshake (never read from the payload) */
  readonly peerId: string;
  /** The mount path the stream was opened at */
  readonly path?: string;
  /** The caller's membership token, from the open frame: a claim, verified here */
  readonly token?: string;
}

/** A stream handler in httpeers-libp2p's `DuplexHandler` shape. */
export type MeshDuplexHandler = (
  input: AsyncIterable<Uint8Array>,
  context: MeshDuplexContext,
) => AsyncIterable<Uint8Array>;

/** Options of {@link meshGitDuplexHandler}. */
export interface MeshGitDuplexHandlerOptions
  extends Omit<GitServeOptions, "enableUploadPack" | "allowOverride" | "closeDuplex"> {
  /** The mesh: issuer, rules, revocation (`provenPeer` is not used: the stream's peer is) */
  access: Omit<MeshAccessOptions, "provenPeer">;
  /**
   * Serve receive-pack to callers whose token allows a push (default false, as every native
   * server here: a peer that accepts pushes says so). Without it every push is refused.
   */
  enableReceivePack?: boolean;
  /** The ref prefix a `git:write-own` caller may push to (default `refs/peers/<peerId>/`) */
  ownNamespace?: (peer: string) => string | undefined;
  /** Which objects a reader may fetch by id (default "REACHABLE_COMMIT", as `meshGitHandler`) */
  requestPolicy?: ServeOverDuplexOptions["requestPolicy"];
  /** Most milliseconds to wait for the request line (default: no limit) */
  initTimeout?: number;
  /** Most milliseconds the service waits for the client (default: no limit) */
  timeout?: number;
  /** Hears each served stream's outcome, with the caller it was served to */
  onSettled?(
    result: ServeGitConnectionResult | undefined,
    error: unknown,
    caller: MeshCaller,
  ): void;
}

/** The caller a stream's token proves, or the JSON error message of the refusal. */
async function authorize(
  access: Omit<MeshAccessOptions, "provenPeer">,
  context: MeshDuplexContext,
): Promise<MeshCaller | string> {
  let caller: MeshCaller | undefined;
  const check = withMeshAccess(access, async (_request, found) => {
    caller = found;
    return new Response(null, { status: 204 });
  });
  let url: URL;
  try {
    url = new URL(context.path ?? HTTPEERS_GIT_DUPLEX_PATH, "http://httpeers.mesh/");
  } catch {
    url = new URL(HTTPEERS_GIT_DUPLEX_PATH, "http://httpeers.mesh/");
  }
  const headers = new Headers();
  if (context.token !== undefined) headers.set(MESH_TOKEN_HEADER, context.token);
  const request = new Request(url, { headers });
  bindProvenPeer(request, context.peerId === "" ? undefined : context.peerId);
  const response = await check(request);
  if (caller && response.ok) return caller;
  const text = await response.text().catch(() => "");
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed.error === "string") return parsed.error;
  } catch {}
  return text || `refused (${response.status})`;
}

/**
 * A stream handler serving git's native protocol to the peers of a mesh: the caller's
 * membership token (the open frame's `token`) is verified against the stream's proven peer,
 * exactly as `meshGitHandler` verifies a request's; a refused token is answered with git's
 * `ERR access denied: <reason>` packet. Then git-daemon's request line names the repository
 * (`resolveRepository`, e.g. `createBasePathResolver`) and the service:
 *
 * - upload-pack needs `git:read`;
 * - receive-pack needs `enableReceivePack` and `git:write`, or `git:write-own`, whose commands
 *   outside the caller's own namespace are refused (`ng <ref> not allowed: …`);
 * - a repository's `daemon.*` config never turns a service on (`allowOverride: false`).
 *
 * A stream is authorized once, when it opens; wrap the handler with httpeers-access's
 * `guardStream` to cut a revoked member's stream short.
 *
 * @example
 * ```ts
 * import { createDuplexMounts, serveDuplex } from "@statewalker/httpeers-libp2p";
 *
 * const mounts = createDuplexMounts();
 * mounts.provide(HTTPEERS_GIT_DUPLEX_PATH, meshGitDuplexHandler({
 *   access: { issuer: hubPeerId, rules: gitRules({ contributors: true }) },
 *   resolveRepository: createBasePathResolver({ files, basePath: "/repos", exportAll: true, openRepository }),
 *   enableReceivePack: true,
 *   initTimeout: 10_000,
 *   timeout: 60_000,
 * }));
 * await serveDuplex({ node, mounts });
 * ```
 */
export function meshGitDuplexHandler(options: MeshGitDuplexHandlerOptions): MeshDuplexHandler {
  const {
    access,
    ownNamespace = defaultOwnNamespace,
    requestPolicy = "REACHABLE_COMMIT",
    enableReceivePack = false,
    resolveRepository,
    settings,
    onSettled,
    ...serve
  } = options;
  return async function* gitOverMesh(input, context) {
    const caller = await authorize(access, context);
    if (typeof caller === "string") {
      yield encodePacket(`ERR access denied: ${caller}\n`);
      return;
    }
    const caps = caller.capabilities;
    let prefix: string | undefined;
    if (!caps.has(GIT_WRITE) && caps.has(GIT_WRITE_OWN) && caller.peer !== undefined) {
      prefix = ownNamespace(caller.peer);
      if (!prefix?.startsWith("refs/")) prefix = undefined;
      else if (!prefix.endsWith("/")) prefix = `${prefix}/`;
    }
    const canWrite = enableReceivePack && (caps.has(GIT_WRITE) || prefix !== undefined);
    const handler = serveGitOverWebrun({
      ...serve,
      enableUploadPack: caps.has(GIT_READ),
      enableReceivePack: canWrite,
      allowOverride: false,
      settings: { requestPolicy, ...settings },
      async resolveRepository(path, request) {
        const served = await resolveRepository(path, request);
        if (!served || prefix === undefined) return served;
        // the resolver's settings are the last layer: the namespace rule goes there
        const hooks = ownNamespaceHooks(prefix, served.settings?.hooks ?? settings?.hooks);
        return { ...served, settings: { ...served.settings, hooks } };
      },
      ...(onSettled ? { onSettled: (result, error) => onSettled(result, error, caller) } : {}),
    });
    yield* handler(input);
  };
}
