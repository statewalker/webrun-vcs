import { toReadableStream } from "@statewalker/vcs-utils/streams";
import type { ContentStore } from "@statewalker/webrun-content-store";
import type { FetchHandler } from "@statewalker/webrun-http-streams";
import type { BatchAction, BatchObjectResponse, BatchResponse } from "./batch.js";
import { BASIC_TRANSFER, LFS_CONTENT_TYPE } from "./batch.js";
import { type LfsLockOperation, type LfsLocksOptions, lockRoutes } from "./locks/index.js";
import { chunksOf } from "./sha256.js";
import { contentStoreLfsObjects, isContentStore, type LfsObjectStore } from "./store.js";
import type { LfsResolver } from "./types.js";

/** The two operations of the batch API. */
export type LfsOperation = "upload" | "download";

/**
 * What `authorize` decides: `true` allows; `false` refuses, as 401 with
 * `LFS-Authenticate` when the request carries no `Authorization` (git-lfs
 * then asks for credentials) and as 403 when it does; an object picks the
 * status and message itself.
 */
export type LfsAuthorization = boolean | { status: 401 | 403; message?: string };

/** Options of {@link serveLfs}. Every limit and hook is optional. */
export interface LfsServerOptions {
  /**
   * Decides each batch (before anything in it is answered) and, without
   * `transferAuth`, each transfer (`GET`/`PUT`/verify) as well. With
   * `locks`, it decides each lock call first too: a listing as `download`,
   * create, verify and unlock as `upload`, with the lock call as `lock`.
   */
  authorize?: (
    request: Request,
    operation: LfsOperation,
    lock?: LfsLockOperation,
  ) => LfsAuthorization | Promise<LfsAuthorization>;
  /**
   * The File Locking API (docs/api/locking.md) under `…/locks`, kept in
   * `locks.store`. Without it every lock route answers 404, which git-lfs
   * takes as "this server does not support locking".
   */
  locks?: LfsLocksOptions;
  /**
   * Per-action authorization (docs/api/authentication.md): `header` gives the
   * headers an action carries for one object and operation, `check` checks
   * them on the transfer request. Objects are then marked `authenticated` and
   * actions carry `expires_in` (`expiresIn` seconds, default 3600).
   */
  transferAuth?: {
    header(
      operation: LfsOperation,
      oid: string,
    ): Record<string, string> | Promise<Record<string, string>>;
    check(request: Request, operation: LfsOperation, oid: string): boolean | Promise<boolean>;
    expiresIn?: number;
  };
  /** Objects per batch (default 1000); more is 413. */
  maxBatchObjects?: number;
  /** Bytes of a batch request body (default 1 MiB); more is 413. */
  maxBatchBytes?: number;
  /** Bytes per object: a larger object is a per-object 422 in a batch and 413 on `PUT`. */
  maxObjectSize?: number;
  /** The LFS endpoint as clients reach it (behind a proxy); default: the request's own. */
  publicUrl?: string;
  /** The realm of the `LFS-Authenticate: Basic realm="…"` challenge (default "Git LFS"). */
  realm?: string;
  /** Added to every error object as `documentation_url`. */
  documentationUrl?: string;
  /**
   * Called with an unexpected error before the handler answers 500. The
   * response carries only a generic message and `request_id` (the request's
   * `X-Request-Id`, or a fresh UUID), which is passed here to correlate.
   */
  onError?: (error: unknown, request: Request, requestId: string) => void | Promise<void>;
}

const OID = /^[0-9a-f]{64}$/;
const VERIFY_MAX_BYTES = 4096;
/** A lock verify body at most (as every lock route reads). */
const LOCK_VERIFY_MAX_BYTES = 16 * 1024;

/** Whether a body is a JSON object with an `oid`: an object verify, not a lock verify. */
function namesOid(text: string | undefined): boolean {
  if (text === undefined) return false;
  try {
    const v = JSON.parse(text) as unknown;
    return !!v && typeof v === "object" && !Array.isArray(v) && "oid" in v;
  } catch {
    return false;
  }
}

const isSize = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** Whether an `Accept` header admits the LFS media type (absent, wildcards and JSON do). */
function acceptsLfsJson(accept: string | null): boolean {
  if (accept === null || accept.trim() === "") return true;
  return accept.split(",").some((part) => {
    const type = part.split(";")[0]?.trim().toLowerCase() ?? "";
    return (
      type === "*/*" ||
      type === "application/*" ||
      type === LFS_CONTENT_TYPE ||
      type === "application/json"
    );
  });
}

/**
 * The request body as text, or `undefined` once it runs past `max` bytes (the
 * rest of the body is then cancelled, unread).
 */
async function boundedText(request: Request, max: number): Promise<string | undefined> {
  const declared = request.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > max) {
    await request.body?.cancel().catch(() => {});
    return undefined;
  }
  if (!request.body) return "";
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of chunksOf(request.body)) {
    size += chunk.length;
    if (size > max) return undefined; // leaving the loop cancels the body
    parts.push(chunk);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    all.set(part, offset);
    offset += part.length;
  }
  return new TextDecoder().decode(all);
}

/**
 * RFC 9110 for a single range: `bytes=a-b`, `bytes=a-`, `bytes=-n` (the last n
 * bytes). Past the end is "unsatisfiable"; anything else (other units, several
 * ranges, a malformed or reversed range) is ignored: the whole object is sent.
 */
function byteRange(
  header: string | null,
  size: number,
): { start: number; end: number } | "unsatisfiable" | undefined {
  if (!header) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (!m[1] && !m[2])) return undefined;
  if (!m[1]) {
    const n = Number(m[2]);
    if (n === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  if (m[2] && Number(m[2]) < start) return undefined;
  if (start >= size) return "unsatisfiable";
  return { start, end: m[2] ? Math.min(Number(m[2]), size - 1) : size - 1 };
}

/**
 * A Git LFS server: the batch API and the basic transfer as a fetch handler,
 * over a content-store and its resolver, or over any {@link LfsObjectStore}
 * (such as `createFilesLfsStore`, git-lfs's own layout). Routes, by path
 * suffix under the LFS endpoint (`…/info/lfs` for git-lfs's default):
 *
 * - `POST …/objects/batch` (docs/api/batch.md): per object, a `download`
 *   action, or for `upload` an `upload` and a `verify` action — none at all
 *   for an object the server already holds — or an error object (404 missing
 *   on download, 422 invalid oid or size, or over `maxObjectSize`). A
 *   `hash_algo` other than `sha256` is 409, too many objects or bytes 413, a
 *   malformed request 422, an `Accept` without the LFS media type 406.
 * - `GET`/`HEAD …/objects/<oid>`: the object, with `Accept-Ranges` and the oid
 *   as a strong `ETag`; `Range: bytes=N-` (and RFC 9110's other single
 *   ranges) answered 206 with `Content-Range`, past the end 416.
 * - `PUT …/objects/<oid>`: stored as it arrives and verified (SHA-256, and
 *   the declared `Content-Length`) before it becomes visible: 422 on a
 *   mismatch, 413 over `maxObjectSize`, 400 for an invalid length.
 * - `POST …/verify`: 200 when the object is held with that size, 404 if not.
 *
 * Errors are `application/vnd.git-lfs+json` objects `{ message, request_id?,
 * documentation_url? }` (`request_id` echoes an `X-Request-Id`). See
 * {@link LfsServerOptions} for `authorize`, `transferAuth` and the limits.
 *
 * @example
 * ```typescript
 * const handler = serveLfs(createFilesLfsStore(files, ".git"), {
 *   authorize: (req, op) => op === "download" || isWriter(req.headers.get("authorization")),
 * });
 * ```
 */
export function serveLfs(
  store: ContentStore,
  resolver: LfsResolver,
  options?: LfsServerOptions,
): FetchHandler;
export function serveLfs(store: LfsObjectStore, options?: LfsServerOptions): FetchHandler;
export function serveLfs(
  store: ContentStore | LfsObjectStore,
  resolverOrOptions?: LfsResolver | LfsServerOptions,
  maybeOptions?: LfsServerOptions,
): FetchHandler {
  let objects: LfsObjectStore;
  let opts: LfsServerOptions;
  if (isContentStore(store)) {
    objects = contentStoreLfsObjects(store, resolverOrOptions as LfsResolver);
    opts = maybeOptions ?? {};
  } else {
    objects = store;
    opts = (resolverOrOptions as LfsServerOptions | undefined) ?? {};
  }
  return lfsHandler(objects, opts);
}

function lfsHandler(store: LfsObjectStore, opts: LfsServerOptions): FetchHandler {
  const maxBatchObjects = opts.maxBatchObjects ?? 1000;
  const maxBatchBytes = opts.maxBatchBytes ?? 1 << 20;
  const realm = opts.realm ?? "Git LFS";
  const tooLarge = (size: number) => opts.maxObjectSize !== undefined && size > opts.maxObjectSize;

  function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": LFS_CONTENT_TYPE, ...headers },
    });
  }

  function error(
    request: Request,
    status: number,
    message: string,
    headers: Record<string, string> = {},
    extra: Record<string, unknown> = {},
  ): Response {
    const body: Record<string, unknown> = { ...extra, message };
    const requestId = request.headers.get("x-request-id");
    if (requestId) body.request_id = requestId;
    if (opts.documentationUrl) body.documentation_url = opts.documentationUrl;
    return json(status, body, headers);
  }

  /** `undefined` when allowed, otherwise the refusal to send. */
  async function refusal(
    request: Request,
    decision: LfsAuthorization,
  ): Promise<Response | undefined> {
    if (decision === true) return undefined;
    const status =
      decision === false ? (request.headers.has("authorization") ? 403 : 401) : decision.status;
    const message =
      (decision !== false && decision.message) ||
      (status === 401 ? "Credentials needed" : "Forbidden");
    await request.body?.cancel().catch(() => {});
    return error(
      request,
      status,
      message,
      status === 401 ? { "lfs-authenticate": `Basic realm="${realm}"` } : {},
    );
  }

  const locks = opts.locks
    ? lockRoutes({
        options: opts.locks,
        authorize: async (request, lock) =>
          refusal(
            request,
            opts.authorize
              ? await opts.authorize(request, lock === "list" ? "download" : "upload", lock)
              : true,
          ),
        needCredentials: (request) =>
          error(request, 401, "Credentials needed", {
            "lfs-authenticate": `Basic realm="${realm}"`,
          }),
        error: (request, status, message, extra) => error(request, status, message, {}, extra),
        json,
        acceptsLfsJson: (request) => acceptsLfsJson(request.headers.get("accept")),
        readBody: boundedText,
      })
    : undefined;

  const authorizeBatch = async (request: Request, operation: LfsOperation) =>
    refusal(request, opts.authorize ? await opts.authorize(request, operation) : true);

  /** A transfer: the action's own headers with `transferAuth`, else the batch's `authorize`. */
  async function authorizeTransfer(request: Request, operation: LfsOperation, oid: string) {
    if (opts.transferAuth) {
      const ok = OID.test(oid) && (await opts.transferAuth.check(request, operation, oid));
      return refusal(request, ok ? true : { status: 401, message: "Transfer not authorized" });
    }
    return authorizeBatch(request, operation);
  }

  async function action(href: string, operation: LfsOperation, oid: string): Promise<BatchAction> {
    if (!opts.transferAuth) return { href };
    return {
      href,
      header: await opts.transferAuth.header(operation, oid),
      expires_in: opts.transferAuth.expiresIn ?? 3600,
    };
  }

  async function batch(request: Request, base: string): Promise<Response> {
    const text = await boundedText(request, maxBatchBytes);
    if (text === undefined)
      return error(request, 413, `A batch request is limited to ${maxBatchBytes} bytes`);
    let input:
      | { operation?: unknown; objects?: unknown; hash_algo?: unknown; transfers?: unknown }
      | undefined;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        input = parsed as typeof input;
    } catch {
      // answered below, once the request is authorized
    }
    const operation = input?.operation;
    // authorized before anything about the request is answered (an unknown
    // operation is asked about as the lesser one)
    const denied = await authorizeBatch(request, operation === "upload" ? "upload" : "download");
    if (denied) return denied;
    if (!acceptsLfsJson(request.headers.get("accept")))
      return error(request, 406, `Accept must allow ${LFS_CONTENT_TYPE}`);
    if (
      !input ||
      (operation !== "download" && operation !== "upload") ||
      !Array.isArray(input.objects)
    )
      return error(request, 422, "A batch needs an operation (upload or download) and objects");
    if (input.hash_algo !== undefined && input.hash_algo !== "sha256")
      return error(request, 409, `Hash algorithm ${String(input.hash_algo)} is not supported`);
    if (input.objects.length > maxBatchObjects)
      return error(request, 413, `A batch is limited to ${maxBatchObjects} objects`);

    const authenticated = opts.transferAuth ? { authenticated: true } : {};
    const answers: BatchObjectResponse[] = [];
    for (const raw of input.objects as unknown[]) {
      const { oid, size } = (raw && typeof raw === "object" ? raw : {}) as {
        oid?: unknown;
        size?: unknown;
      };
      if (typeof oid !== "string" || !OID.test(oid) || !isSize(size)) {
        answers.push({
          oid: oid as string,
          size: size as number,
          error: { code: 422, message: "Invalid object id or size" },
        });
        continue;
      }
      if (tooLarge(size)) {
        answers.push({
          oid,
          size,
          error: { code: 422, message: `Object is larger than ${opts.maxObjectSize} bytes` },
        });
        continue;
      }
      const held = await store.size(oid);
      const href = `${base}/objects/${oid}`;
      if (operation === "download") {
        if (held === undefined) {
          answers.push({ oid, size, error: { code: 404, message: "Object does not exist" } });
        } else if (held !== size) {
          answers.push({
            oid,
            size,
            error: { code: 422, message: `Object has ${held} bytes, not ${size}` },
          });
        } else {
          answers.push({
            oid,
            size,
            ...authenticated,
            actions: { download: await action(href, "download", oid) },
          });
        }
      } else if (held === size) {
        answers.push({ oid, size }); // held already: nothing to upload
      } else {
        answers.push({
          oid,
          size,
          ...authenticated,
          actions: {
            upload: await action(href, "upload", oid),
            verify: await action(`${base}/verify`, "upload", oid),
          },
        });
      }
    }
    const body: BatchResponse = { transfer: BASIC_TRANSFER, objects: answers, hash_algo: "sha256" };
    return json(200, body);
  }

  async function download(request: Request, oid: string): Promise<Response> {
    const denied = await authorizeTransfer(request, "download", oid);
    if (denied) return denied;
    const size = OID.test(oid) ? await store.size(oid) : undefined;
    if (size === undefined) return error(request, 404, "Object does not exist");
    const etag = `"${oid}"`;
    const ifRange = request.headers.get("if-range");
    const range =
      ifRange === null || ifRange === etag
        ? byteRange(request.headers.get("range"), size)
        : undefined;
    if (range === "unsatisfiable")
      return error(request, 416, "Range not satisfiable", { "content-range": `bytes */${size}` });
    const start = range?.start ?? 0;
    const length = range ? range.end - range.start + 1 : size;
    const headers: Record<string, string> = {
      "content-type": "application/octet-stream",
      "content-length": String(length),
      "accept-ranges": "bytes",
      etag,
    };
    if (range) headers["content-range"] = `bytes ${range.start}-${range.end}/${size}`;
    const status = range ? 206 : 200;
    if (request.method === "HEAD" || length === 0) return new Response(null, { status, headers });
    const body = range ? store.read(oid, { offset: start, length }) : store.read(oid);
    return new Response(toReadableStream(body), { status, headers });
  }

  async function upload(request: Request, oid: string): Promise<Response> {
    // authorized before anything about the request is answered
    const denied = await authorizeTransfer(request, "upload", oid);
    if (denied) return denied;
    if (!OID.test(oid)) {
      await request.body?.cancel().catch(() => {});
      return error(request, 422, "Invalid object id");
    }
    const length = request.headers.get("content-length");
    const refuse = async (status: number, message: string) => {
      await request.body?.cancel().catch(() => {});
      return error(request, status, message);
    };
    if (length !== null && !/^\d+$/.test(length))
      return refuse(400, `Invalid Content-Length ${JSON.stringify(length)}`);
    const size = length === null ? undefined : Number(length);
    if (size !== undefined && !Number.isSafeInteger(size))
      return refuse(400, `Invalid Content-Length ${JSON.stringify(length)}`);
    if (size !== undefined && tooLarge(size))
      return refuse(413, `Object is larger than ${opts.maxObjectSize} bytes`);
    // a declared content-length caps the body: a PUT cannot write past what it announced
    const stored = await store.put(
      request.body ?? new Uint8Array(0),
      { oid, size },
      { maxSize: opts.maxObjectSize },
    );
    if (stored.ok) return new Response(null, { status: 200 });
    if (stored.reason === "too large")
      return error(request, 413, `Object is larger than ${opts.maxObjectSize} bytes`);
    return error(
      request,
      422,
      stored.reason === "size mismatch"
        ? "size does not match content-length"
        : "oid does not match content",
    );
  }

  async function verify(
    request: Request,
    preread?: { text: string | undefined },
  ): Promise<Response> {
    // authorized before the body is looked at; with transferAuth the oid is
    // needed to check, so a body without a valid one is refused as unauthorized
    if (!opts.transferAuth) {
      const denied = await authorizeBatch(request, "upload");
      if (denied) return denied;
    }
    const text = preread
      ? preread.text !== undefined &&
        new TextEncoder().encode(preread.text).length <= VERIFY_MAX_BYTES
        ? preread.text
        : undefined
      : await boundedText(request, VERIFY_MAX_BYTES);
    let input: { oid?: unknown; size?: unknown } | undefined;
    try {
      input = text === undefined ? undefined : (JSON.parse(text) as typeof input);
    } catch {
      input = undefined;
    }
    const oid = input?.oid;
    const size = input?.size;
    const valid = typeof oid === "string" && OID.test(oid) && isSize(size);
    if (opts.transferAuth) {
      const denied = await authorizeTransfer(request, "upload", valid ? oid : "");
      if (denied) return denied;
    }
    if (!valid) return error(request, 422, "Invalid object id or size");
    return (await store.size(oid)) === size
      ? json(200, {})
      : error(request, 404, "Object does not exist");
  }

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const path = url.pathname;
    const endpoint = (suffixLength: number) =>
      opts.publicUrl
        ? opts.publicUrl.replace(/\/+$/, "")
        : `${url.origin}${path.slice(0, path.length - suffixLength)}`;
    try {
      // `…/locks/verify` is a lock verify under the endpoint, or the object
      // verify of an endpoint that itself ends in `/locks`: the body tells
      // (an object verify always names an `oid`; a lock verify never does)
      if (path.endsWith("/locks/verify") && request.method === "POST") {
        const preread = { text: await boundedText(request, LOCK_VERIFY_MAX_BYTES) };
        if (namesOid(preread.text)) return await verify(request, preread);
        if (!locks) return error(request, 404, "File locking is not supported");
        return await (locks(request, path, preread) as Promise<Response>);
      }
      if (locks) {
        const answered = locks(request, path);
        if (answered) return await answered;
      } else if (/\/locks(\/verify|\/[^/]+\/unlock)?$/.test(path)) {
        await request.body?.cancel().catch(() => {});
        return error(request, 404, "File locking is not supported");
      }
      if (path.endsWith("/objects/batch")) {
        if (request.method !== "POST") return error(request, 405, "Use POST for a batch");
        return await batch(request, endpoint("/objects/batch".length));
      }
      if (path.endsWith("/verify") && request.method === "POST") return await verify(request);
      const m = path.match(/\/objects\/([^/]+)$/);
      if (m) {
        const oid = m[1] as string;
        if (request.method === "GET" || request.method === "HEAD")
          return await download(request, oid);
        if (request.method === "PUT") return await upload(request, oid);
      }
      return error(request, 404, "Not found");
    } catch (e) {
      // nothing internal goes out: a generic message and an id to find it by
      const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
      try {
        await opts.onError?.(e, request, requestId);
      } catch {
        // a failing hook does not change the answer
      }
      const body: { message: string; request_id: string; documentation_url?: string } = {
        message: "Internal server error",
        request_id: requestId,
      };
      if (opts.documentationUrl) body.documentation_url = opts.documentationUrl;
      return json(500, body);
    }
  };
}
