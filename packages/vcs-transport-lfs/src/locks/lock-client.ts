import { LFS_CONTENT_TYPE } from "../batch.js";
import type { FetchLike, LfsTransferOptions } from "../types.js";
import type { LfsListLocksResponse, LfsLock, LfsVerifyLocksResponse } from "./types.js";

/** Options of {@link lfsLocks}: the credentials of the LFS endpoint, as for transfers. */
export type LfsLockClientOptions = Pick<
  LfsTransferOptions,
  "headers" | "credentials" | "headersFor"
> & {
  /** Redirects followed, at most (default 5). */
  maxRedirects?: number;
};

/** What `listLocks` selects (all optional): the query string of `GET /locks`. */
export interface LfsListLocksQuery {
  path?: string;
  id?: string;
  cursor?: string;
  limit?: number;
  /** The server ref (`refs/heads/main`) to list the locks of */
  refspec?: string;
}

/** One page of a verify: the caller's locks (`ours`) and everyone else's (`theirs`). */
export interface LfsVerifyLocksPage {
  ours: LfsLock[];
  theirs: LfsLock[];
  nextCursor?: string;
}

/**
 * A lock API call the server refused: `status` is its HTTP status. On a 409
 * from `createLock`, `lock` is the lock that already holds the path. On a 401,
 * `authenticate` is the server's `LFS-Authenticate` (or `WWW-Authenticate`)
 * challenge. A 404 from `verifyLocks` or `listLocks` means the server has no
 * locking API (git-lfs then stops asking); from `unlock`, that the lock does
 * not exist.
 */
export class LfsLockError extends Error {
  readonly status: number;
  readonly lock?: LfsLock;
  readonly requestId?: string;
  readonly documentationUrl?: string;
  readonly authenticate?: string;
  constructor(
    message: string,
    init: {
      status: number;
      lock?: LfsLock;
      requestId?: string;
      documentationUrl?: string;
      authenticate?: string;
    },
  ) {
    super(message);
    this.name = "LfsLockError";
    this.status = init.status;
    if (init.lock) this.lock = init.lock;
    if (init.requestId) this.requestId = init.requestId;
    if (init.documentationUrl) this.documentationUrl = init.documentationUrl;
    if (init.authenticate) this.authenticate = init.authenticate;
  }
}

/** The lock API of one LFS endpoint (see {@link lfsLocks}). */
export interface LfsLocksClient {
  /** `POST /locks`: locks `path` (for `ref`). A 409 throws {@link LfsLockError} with the existing `lock`. */
  createLock(path: string, ref?: string): Promise<LfsLock>;
  /** `GET /locks`: one page of locks; pass `nextCursor` back as `cursor` for the next. */
  listLocks(query?: LfsListLocksQuery): Promise<{ locks: LfsLock[]; nextCursor?: string }>;
  /** Every lock `query` selects, page after page. */
  allLocks(query?: Omit<LfsListLocksQuery, "cursor">): AsyncIterable<LfsLock>;
  /** `POST /locks/verify`: one page of the caller's locks and everyone else's. */
  verifyLocks(query?: {
    ref?: string;
    cursor?: string;
    limit?: number;
  }): Promise<LfsVerifyLocksPage>;
  /** `POST /locks/<id>/unlock`: the lock removed. Someone else's lock needs `force` (and the server's permission). */
  unlock(id: string, opts?: { force?: boolean; ref?: string }): Promise<LfsLock>;
}

function base64(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

const isLock = (v: unknown): v is LfsLock =>
  !!v &&
  typeof v === "object" &&
  typeof (v as LfsLock).id === "string" &&
  typeof (v as LfsLock).path === "string";

function locksOf(v: unknown, what: string): LfsLock[] {
  if (!Array.isArray(v) || !v.every(isLock)) throw new Error(`lfs ${what}: malformed locks`);
  return v;
}

/**
 * A client of the Git LFS File Locking API (git-lfs `docs/api/locking.md`)
 * at the LFS endpoint `url` (`<remote>/info/lfs` for git-lfs's default). Every
 * request sends and accepts `application/vnd.git-lfs+json`.
 *
 * `opts.headers` and `opts.credentials` (Basic) go with every request to the
 * endpoint's origin, as for `lfsUpload`/`lfsDownload`. Redirects are followed
 * here (at most `maxRedirects`), so credentials never follow one to another
 * origin: there a request gets only `opts.headersFor(href)`, if anything. A
 * `307`/`308` repeats the request; `301`/`302`/`303` turn it into a `GET`, as
 * `fetch` does.
 *
 * Every refusal throws {@link LfsLockError} with the server's status and
 * message: 401 (with the `authenticate` challenge), 403, 404, 409 (with the
 * existing `lock`), 422, 500.
 *
 * @example
 * ```typescript
 * const locks = lfsLocks("https://host/org/repo.git/info/lfs", fetch, {
 *   credentials: { username: "ada", password: token },
 * });
 * const lock = await locks.createLock("assets/logo.psd", "refs/heads/main");
 * const { ours, theirs } = await locks.verifyLocks({ ref: "refs/heads/main" });
 * await locks.unlock(lock.id);
 * ```
 */
export function lfsLocks(
  url: string,
  fetchImpl?: FetchLike,
  opts: LfsLockClientOptions = {},
): LfsLocksClient {
  const endpoint = url.replace(/\/+$/, "");
  const endpointOrigin = originOf(endpoint);
  const doFetch: FetchLike = fetchImpl ?? ((request) => fetch(request));
  const maxRedirects = opts.maxRedirects ?? 5;

  function headersFor(href: string): Headers {
    if (originOf(href) === endpointOrigin) {
      const headers = new Headers(opts.headers);
      if (opts.credentials) {
        const { username, password } = opts.credentials;
        headers.set("authorization", `Basic ${base64(`${username}:${password}`)}`);
      }
      return headers;
    }
    return new Headers(opts.headersFor?.(href));
  }

  async function call(method: "GET" | "POST", href: string, body?: unknown): Promise<Response> {
    let target = href;
    let m: string = method;
    let payload = body === undefined ? undefined : JSON.stringify(body);
    for (let redirects = 0; ; redirects++) {
      const headers = headersFor(target);
      headers.set("accept", LFS_CONTENT_TYPE);
      if (payload !== undefined) headers.set("content-type", LFS_CONTENT_TYPE);
      const res = await doFetch(
        new Request(target, { method: m, headers, body: payload, redirect: "manual" }),
      );
      // a browser hides manual redirects: let it follow them itself (it drops
      // Authorization on a cross-origin redirect)
      if (res.type === "opaqueredirect") {
        return doFetch(new Request(target, { method: m, headers, body: payload }));
      }
      const location = res.headers.get("location");
      if (![301, 302, 303, 307, 308].includes(res.status) || !location) return res;
      await res.body?.cancel().catch(() => {});
      if (redirects >= maxRedirects) throw new Error(`lfs locks: too many redirects from ${href}`);
      target = new URL(location, target).href;
      if (res.status !== 307 && res.status !== 308) {
        m = "GET";
        payload = undefined;
      }
    }
  }

  async function answer(res: Response, what: string): Promise<Record<string, unknown>> {
    const text = await res.text().catch(() => "");
    let parsed: Record<string, unknown> | undefined;
    try {
      const v = JSON.parse(text) as unknown;
      if (v && typeof v === "object" && !Array.isArray(v)) parsed = v as Record<string, unknown>;
    } catch {
      // not JSON
    }
    if (res.ok) {
      if (!parsed) throw new Error(`lfs ${what}: the response is not a JSON object`);
      return parsed;
    }
    const message = typeof parsed?.message === "string" ? parsed.message : text;
    throw new LfsLockError(`lfs ${what} failed: ${res.status} ${message}`.trim(), {
      status: res.status,
      lock: isLock(parsed?.lock) ? parsed.lock : undefined,
      requestId: typeof parsed?.request_id === "string" ? parsed.request_id : undefined,
      documentationUrl:
        typeof parsed?.documentation_url === "string" ? parsed.documentation_url : undefined,
      authenticate:
        res.headers.get("lfs-authenticate") ?? res.headers.get("www-authenticate") ?? undefined,
    });
  }

  const ref = (name: string | undefined) => (name === undefined ? {} : { ref: { name } });

  const client: LfsLocksClient = {
    async createLock(path, refName) {
      const res = await call("POST", `${endpoint}/locks`, { path, ...ref(refName) });
      const body = await answer(res, "create lock");
      if (!isLock(body.lock)) throw new Error("lfs create lock: the response has no lock");
      return body.lock;
    },
    async listLocks(query = {}) {
      const params = new URLSearchParams();
      if (query.path !== undefined) params.set("path", query.path);
      if (query.id !== undefined) params.set("id", query.id);
      if (query.cursor !== undefined) params.set("cursor", query.cursor);
      if (query.limit !== undefined) params.set("limit", String(query.limit));
      if (query.refspec !== undefined) params.set("refspec", query.refspec);
      const qs = params.toString();
      const res = await call("GET", `${endpoint}/locks${qs ? `?${qs}` : ""}`);
      const body = (await answer(res, "list locks")) as Partial<LfsListLocksResponse>;
      const locks = locksOf(body.locks ?? [], "list locks");
      return body.next_cursor ? { locks, nextCursor: String(body.next_cursor) } : { locks };
    },
    async *allLocks(query = {}) {
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        const page = await client.listLocks({ ...query, cursor });
        yield* page.locks;
        cursor = page.nextCursor;
        if (cursor !== undefined) {
          if (seen.has(cursor)) throw new Error("lfs list locks: the server repeats a cursor");
          seen.add(cursor);
        }
      } while (cursor !== undefined);
    },
    async verifyLocks(query = {}) {
      const res = await call("POST", `${endpoint}/locks/verify`, {
        ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
        ...(query.limit !== undefined ? { limit: query.limit } : {}),
        ...ref(query.ref),
      });
      const body = (await answer(res, "verify locks")) as Partial<LfsVerifyLocksResponse>;
      const page: LfsVerifyLocksPage = {
        ours: locksOf(body.ours ?? [], "verify locks"),
        theirs: locksOf(body.theirs ?? [], "verify locks"),
      };
      if (body.next_cursor) page.nextCursor = String(body.next_cursor);
      return page;
    },
    async unlock(id, o = {}) {
      const res = await call("POST", `${endpoint}/locks/${encodeURIComponent(id)}/unlock`, {
        force: o.force === true,
        ...ref(o.ref),
      });
      const body = await answer(res, "unlock");
      if (!isLock(body.lock)) throw new Error("lfs unlock: the response has no lock");
      return body.lock;
    },
  };
  return client;
}
