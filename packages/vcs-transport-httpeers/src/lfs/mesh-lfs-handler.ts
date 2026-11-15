/**
 * Git LFS on a mesh peer: `serveLfs` of `@statewalker/vcs-transport-lfs` behind httpeers' access
 * middleware, with git's capabilities, lock owners named by the proven peer id, and the `ranged`
 * transfer offered to clients that ask for it.
 */

import {
  type LfsAuthorization,
  type LfsLockOperation,
  type LfsLocksOptions,
  type LfsObjectStore,
  type LfsOperation,
  type LfsServerOptions,
  serveLfs,
} from "@statewalker/vcs-transport-lfs";
import {
  GIT_READ,
  GIT_WRITE,
  GIT_WRITE_OWN,
  type MeshAccessOptions,
  type MeshCaller,
  type MeshHandler,
  withMeshAccess,
} from "../access/index.js";

/** The transfer adapter id of ranged downloads. */
export const RANGED_TRANSFER = "ranged";

/** Options of {@link meshLfsHandler}. */
export interface MeshLfsHandlerOptions extends Omit<LfsServerOptions, "authorize" | "locks"> {
  /** The LFS objects served (`createFilesLfsStore(files, ".git")`, a content-store view) */
  objects: LfsObjectStore;
  /** The mesh: issuer, rules, revocation, how the caller's peer is proven */
  access: MeshAccessOptions;
  /**
   * The File Locking API. Lock owners are the callers' proven peer ids, and callers with
   * `git:write` may force-unlock, unless `identify` / `admin` say otherwise.
   */
  locks?: Omit<LfsLocksOptions, "identify"> & Partial<Pick<LfsLocksOptions, "identify">>;
  /**
   * Answer `transfer: "ranged"` to a batch that offers it (`transfers: ["ranged", "basic"]`).
   * `ranged` has the basic transfer's actions, and its downloads are ranged `GET`s
   * (`Range: bytes=a-b`, answered 206), which is what lets a client fetch one object from several
   * peers at once. A client offering only `basic` (native git-lfs) gets `basic`. Default true.
   */
  ranged?: boolean;
  /**
   * The application's own decision, asked once the caller has the capability: `true` allows, a
   * refusal refuses (as `serveLfs`'s `authorize`).
   */
  authorize?: (
    request: Request,
    operation: LfsOperation,
    caller: MeshCaller,
    lock?: LfsLockOperation,
  ) => LfsAuthorization | Promise<LfsAuthorization>;
}

/** Reads at most `max + 1` bytes of a body (more is cancelled): enough for the limit to show. */
async function boundedBytes(
  body: ReadableStream<Uint8Array> | null,
  max: number,
): Promise<Uint8Array> {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      size += value.length;
      if (size > max) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    all.set(part, offset);
    offset += part.length;
  }
  return all;
}

/** Whether a batch request body offers the ranged transfer. */
function offersRanged(body: Uint8Array): boolean {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as { transfers?: unknown };
    return Array.isArray(parsed.transfers) && parsed.transfers.includes(RANGED_TRANSFER);
  } catch {
    return false;
  }
}

/**
 * The LFS handler of a mesh peer (mount it at the repository's `…/info/lfs`). Each request's
 * membership token is verified first (no token 401, expired 401, forged or foreign 403); then
 * downloads (and lock listings) need `git:read`, uploads (and lock changes) need `git:write` or
 * `git:write-own` (objects are content-addressed: a contributor's upload is what its own refs
 * point to), else 403. The rest is `serveLfs`'s.
 *
 * @example
 * ```ts
 * const lfs = meshLfsHandler({
 *   objects: createFilesLfsStore(files, ".git"),
 *   access: { issuer: hubPeerId },
 *   locks: { store: createMemoryLockStore() },
 * });
 * ```
 */
export function meshLfsHandler(options: MeshLfsHandlerOptions): MeshHandler {
  const { objects, access, locks, ranged = true, authorize, ...rest } = options;
  const callers = new WeakMap<Request, MeshCaller>();
  const callerOf = (request: Request): MeshCaller =>
    callers.get(request) ?? { peer: undefined, capabilities: new Set() };

  const serve = serveLfs(objects, {
    ...rest,
    locks: locks && {
      ...locks,
      identify: locks.identify ?? ((request) => callerOf(request).peer),
      admin: locks.admin ?? ((request) => callerOf(request).capabilities.has(GIT_WRITE)),
    },
    authorize: async (request, operation, lock) => {
      const caller = callerOf(request);
      const caps = caller.capabilities;
      if (operation === "download" && !caps.has(GIT_READ))
        return { status: 403, message: `${GIT_READ} required` };
      if (operation === "upload" && !caps.has(GIT_WRITE) && !caps.has(GIT_WRITE_OWN))
        return { status: 403, message: `${GIT_WRITE} required` };
      return authorize ? authorize(request, operation, caller, lock) : true;
    },
  });
  const maxBatchBytes = rest.maxBatchBytes ?? 1 << 20;

  return withMeshAccess(access, async (request, caller) => {
    callers.set(request, caller);
    const isBatch =
      request.method === "POST" && new URL(request.url).pathname.endsWith("/objects/batch");
    if (!ranged || !isBatch) return serve(request);

    // a batch: read it (bounded) to see whether it offers `ranged`, then let serveLfs answer
    const body = await boundedBytes(request.body, maxBatchBytes);
    const forwarded = new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body: body as BodyInit,
      signal: request.signal,
    });
    callers.set(forwarded, caller);
    const response = await serve(forwarded);
    if (response.status !== 200 || !offersRanged(body)) return response;
    const answer = (await response.json()) as { transfer?: string };
    answer.transfer = RANGED_TRANSFER;
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    return new Response(JSON.stringify(answer), { status: 200, headers });
  });
}
