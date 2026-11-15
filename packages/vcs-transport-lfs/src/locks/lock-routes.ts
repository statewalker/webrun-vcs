import { normalizeLockPath } from "./lock-paths.js";
import type { LfsLock, LfsLockStore, LfsStoredLock } from "./types.js";

/** The lock API calls, as `authorize` is told about them. */
export type LfsLockOperation = "create" | "list" | "verify" | "unlock";

/** The `locks` option of `serveLfs`: the File Locking API. */
export interface LfsLocksOptions {
  /** Where locks are kept: `createMemoryLockStore()`, `createFilesLockStore(files)`, or your own. */
  store: LfsLockStore;
  /**
   * The caller's VERIFIED name, which owns the locks it creates, decides who
   * may unlock them without `force`, and splits a verify into `ours` and
   * `theirs`. `undefined` is 401 with `LFS-Authenticate` (git-lfs then asks
   * its credential helper). Called after `authorize`. Required: whoever
   * `identify` names can unlock that user's locks, so it must only name a
   * user whose credentials were checked, by `identify` itself or by an
   * `authorize` that checks the very credentials `identify` reads.
   * `basicUserIdentity` reads the Basic user name WITHOUT checking the
   * password: use it only behind such an `authorize`.
   */
  identify: (request: Request) => string | undefined | Promise<string | undefined>;
  /**
   * Whether the caller may force-unlock a lock someone else owns (`force:
   * true`). Default: nobody may; owners unlock their own locks without
   * `force`.
   */
  admin?: (request: Request, lock: LfsLock) => boolean | Promise<boolean>;
  /**
   * Keep locks per ref, as the spec allows: a lock belongs to the `ref.name`
   * it was created with, listing with `refspec` and verifying with `ref`
   * select that ref's locks, and one path can be locked once per ref.
   * Default `false`: refs are ignored and a path has one lock in the
   * repository, as GitHub and Gitea do.
   */
  perRef?: boolean;
  /** Locks per page: the default and the largest `limit` (default 100). */
  pageSize?: number;
}

/** What the server gives the lock routes. */
export interface LockRouteContext {
  options: LfsLocksOptions;
  /** `undefined` when allowed, else the 401/403 to send (after `authorize`). */
  authorize(request: Request, lock: LfsLockOperation): Promise<Response | undefined>;
  /** A 401 asking for credentials (with `LFS-Authenticate`). */
  needCredentials(request: Request): Response;
  error(
    request: Request,
    status: number,
    message: string,
    extra?: Record<string, unknown>,
  ): Response;
  json(status: number, body: unknown): Response;
  acceptsLfsJson(request: Request): boolean;
  readBody(request: Request, max: number): Promise<string | undefined>;
}

const MAX_BODY = 16 * 1024;

/** The wire lock: `ref` is the store's business, not the client's. */
function wire(lock: LfsStoredLock): LfsLock {
  return { id: lock.id, path: lock.path, locked_at: lock.locked_at, owner: lock.owner };
}

/**
 * The user name of a Basic `Authorization`, if any, for `locks.identify`. It
 * does NOT check the password: it is only safe when `authorize` refuses every
 * request whose Basic credentials it has not verified (otherwise anyone can
 * send `Authorization: Basic <victim>:x`, take the victim's name and unlock
 * the victim's locks).
 *
 * @example
 * ```typescript
 * serveLfs(objects, {
 *   authorize: (request) => checkBasicPassword(request.headers.get("authorization")),
 *   locks: { store, identify: basicUserIdentity },
 * });
 * ```
 */
export function basicUserIdentity(request: Request): string | undefined {
  const m = /^basic\s+(\S+)\s*$/i.exec(request.headers.get("authorization") ?? "");
  if (!m) return undefined;
  try {
    const bytes = Uint8Array.from(atob(m[1] as string), (c) => c.charCodeAt(0));
    const text = new TextDecoder().decode(bytes);
    const colon = text.indexOf(":");
    const user = colon < 0 ? text : text.slice(0, colon);
    return user || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The File Locking API routes (docs/api/locking.md) under the LFS endpoint:
 * `POST …/locks`, `GET …/locks`, `POST …/locks/verify` and `POST
 * …/locks/<id>/unlock`. Returns `undefined` for any other path. `preread`
 * is the body when the server already read it (to tell a lock verify from an
 * object verify, see `serveLfs`).
 */
export function lockRoutes(
  ctx: LockRouteContext,
): (
  request: Request,
  path: string,
  preread?: { text: string | undefined },
) => Promise<Response> | undefined {
  const { options: o } = ctx;
  const pageSize = Math.max(1, Math.floor(o.pageSize ?? 100));
  if (typeof o.identify !== "function")
    throw new TypeError(
      "serveLfs: locks.identify is required (a function naming the verified caller)",
    );
  const identify = o.identify;
  const refOf = (name: unknown) =>
    o.perRef && typeof name === "string" && name !== "" ? name : undefined;
  const limitOf = (raw: unknown): number | undefined => {
    if (raw === undefined || raw === null || raw === "" || raw === 0) return pageSize;
    const n = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : raw;
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) return undefined;
    return n === 0 ? pageSize : Math.min(n, pageSize);
  };

  /** Authorized, accepting the media type, and (when `needsOwner`) identified. */
  async function admit(
    request: Request,
    op: LfsLockOperation,
    needsOwner: boolean,
  ): Promise<Response | { owner: string | undefined }> {
    const denied = await ctx.authorize(request, op);
    if (denied) return denied;
    if (!ctx.acceptsLfsJson(request)) {
      await request.body?.cancel().catch(() => {});
      return ctx.error(request, 406, "Accept must allow application/vnd.git-lfs+json");
    }
    if (!needsOwner) return { owner: undefined };
    const owner = await identify(request);
    if (owner === undefined || owner === "") {
      await request.body?.cancel().catch(() => {});
      return ctx.needCredentials(request);
    }
    return { owner };
  }

  async function body(
    request: Request,
    preread?: { text: string | undefined },
  ): Promise<Record<string, unknown> | undefined> {
    const text = preread ? preread.text : await ctx.readBody(request, MAX_BODY);
    if (text === undefined) return undefined;
    try {
      const v = JSON.parse(text || "{}") as unknown;
      return v && typeof v === "object" && !Array.isArray(v)
        ? (v as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  }

  const refName = (input: Record<string, unknown>): unknown =>
    (input.ref as { name?: unknown } | undefined)?.name;

  async function create(request: Request): Promise<Response> {
    const admitted = await admit(request, "create", true);
    if (admitted instanceof Response) return admitted;
    const input = await body(request);
    if (!input) return ctx.error(request, 422, "A lock request needs a JSON body");
    const path = normalizeLockPath(input.path);
    if (path === undefined) return ctx.error(request, 422, "A lock needs a valid path");
    const { created, lock } = await o.store.create({
      path,
      owner: { name: admitted.owner as string },
      ref: refOf(refName(input)),
    });
    if (!created) return ctx.error(request, 409, "already created lock", { lock: wire(lock) });
    return ctx.json(201, { lock: wire(lock) });
  }

  async function list(request: Request): Promise<Response> {
    const admitted = await admit(request, "list", false);
    if (admitted instanceof Response) return admitted;
    const q = new URL(request.url).searchParams;
    const limit = limitOf(q.get("limit") ?? undefined);
    if (limit === undefined) return ctx.error(request, 400, "Invalid limit");
    const rawPath = q.get("path");
    const path = rawPath === null || rawPath === "" ? undefined : normalizeLockPath(rawPath);
    if (rawPath && path === undefined) return ctx.json(200, { locks: [] });
    const page = await o.store.list({
      path,
      id: q.get("id") || undefined,
      ref: refOf(q.get("refspec") || undefined),
      cursor: q.get("cursor") || undefined,
      limit,
    });
    return ctx.json(200, {
      locks: page.locks.map(wire),
      ...(page.nextCursor ? { next_cursor: page.nextCursor } : {}),
    });
  }

  async function verify(
    request: Request,
    preread?: { text: string | undefined },
  ): Promise<Response> {
    const admitted = await admit(request, "verify", true);
    if (admitted instanceof Response) return admitted;
    const input = await body(request, preread);
    if (!input) return ctx.error(request, 422, "A verify request needs a JSON body");
    const limit = limitOf(input.limit);
    if (limit === undefined) return ctx.error(request, 422, "Invalid limit");
    const cursor = typeof input.cursor === "string" && input.cursor ? input.cursor : undefined;
    const page = await o.store.list({ ref: refOf(refName(input)), cursor, limit });
    const ours: LfsLock[] = [];
    const theirs: LfsLock[] = [];
    for (const lock of page.locks)
      (lock.owner.name === admitted.owner ? ours : theirs).push(wire(lock));
    return ctx.json(200, {
      ours,
      theirs,
      ...(page.nextCursor ? { next_cursor: page.nextCursor } : {}),
    });
  }

  async function unlock(request: Request, id: string): Promise<Response> {
    const admitted = await admit(request, "unlock", true);
    if (admitted instanceof Response) return admitted;
    const input = await body(request);
    if (!input) return ctx.error(request, 422, "An unlock request needs a JSON body");
    const lock = await o.store.get(id);
    if (!lock) return ctx.error(request, 404, "Lock does not exist");
    if (lock.owner.name !== admitted.owner) {
      if (input.force !== true)
        return ctx.error(
          request,
          403,
          `The lock is owned by ${lock.owner.name}; unlocking it needs force`,
        );
      if (!(o.admin && (await o.admin(request, wire(lock)))))
        return ctx.error(request, 403, "You may not force-unlock a lock you do not own");
    }
    const removed = await o.store.remove(id);
    if (!removed) return ctx.error(request, 404, "Lock does not exist");
    return ctx.json(200, { lock: wire(removed) });
  }

  return (request, path, preread) => {
    if (path.endsWith("/locks")) {
      if (request.method === "POST") return create(request);
      if (request.method === "GET") return list(request);
      return Promise.resolve(ctx.error(request, 405, "Use GET or POST for locks"));
    }
    if (path.endsWith("/locks/verify")) {
      if (request.method === "POST") return verify(request, preread);
      return Promise.resolve(ctx.error(request, 405, "Use POST to verify locks"));
    }
    const m = /\/locks\/([^/]+)\/unlock$/.exec(path);
    if (m) {
      if (request.method !== "POST")
        return Promise.resolve(ctx.error(request, 405, "Use POST to unlock"));
      let id: string;
      try {
        id = decodeURIComponent(m[1] as string);
      } catch {
        return Promise.resolve(ctx.error(request, 404, "Lock does not exist"));
      }
      return unlock(request, id);
    }
    return undefined;
  };
}
