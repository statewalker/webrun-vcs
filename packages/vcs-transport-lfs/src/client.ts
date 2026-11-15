import { fetchWithRequestBody, shouldStreamRequestBody } from "@statewalker/vcs-utils/streams";
import type { ByteStream, ContentStore } from "@statewalker/webrun-content-store";
import type { BatchAction, BatchObjectResponse, BatchRequest, BatchResponse } from "./batch.js";
import { BASIC_TRANSFER, LFS_CONTENT_TYPE } from "./batch.js";
import { chunksOf } from "./sha256.js";
import { contentStoreLfsObjects, isContentStore, type LfsObjectStore } from "./store.js";
import type {
  FetchLike,
  LfsPointer,
  LfsResolver,
  LfsTransferOptions,
  TransportEvent,
} from "./types.js";

const defaultFetch: FetchLike = (request) => fetch(request);

/** Thrown inside a download that runs past the pointer's size. */
class SizeExceeded extends Error {}

/** Releases a response whose body is not read, so its connection can be reused. */
async function discard(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => {});
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function base64(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** The client's own headers: `opts.headers`, then `opts.credentials` as Basic auth. */
function clientHeaders(opts: LfsTransferOptions): Headers {
  const headers = new Headers(opts.headers);
  if (opts.credentials) {
    const { username, password } = opts.credentials;
    headers.set("authorization", `Basic ${base64(`${username}:${password}`)}`);
  }
  return headers;
}

function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/**
 * A transfer's headers: the client's own, then the action's. Header names are
 * case-insensitive, so they are merged by name, an action's `Authorization`
 * replacing the client's `authorization` (as object keys both would be sent,
 * joined by a comma).
 *
 * The client's own headers and credentials belong to the LFS endpoint: they go
 * only to an href on the endpoint's origin (git-lfs scopes credentials per URL
 * the same way), and not at all when the server marked the object
 * `authenticated`. An href on another origin (a CDN, a presigned bucket URL)
 * gets what `opts.headersFor(href)` gives, if anything.
 */
function transferHeaders(
  obj: BatchObjectResponse,
  action: BatchAction,
  opts: LfsTransferOptions,
  endpointOrigin: string | undefined,
): Headers {
  let headers = new Headers();
  if (!obj.authenticated) {
    const origin = originOf(action.href);
    if (origin !== undefined && origin === endpointOrigin) headers = clientHeaders(opts);
    else headers = new Headers(opts.headersFor?.(action.href));
  }
  for (const [name, value] of Object.entries(action.header ?? {})) headers.set(name, value);
  return headers;
}

async function postBatch(
  fetchImpl: FetchLike,
  url: string,
  operation: "upload" | "download",
  oids: LfsPointer[],
  opts: LfsTransferOptions,
): Promise<BatchResponse> {
  const body: BatchRequest = {
    operation,
    transfers: [BASIC_TRANSFER],
    objects: oids.map(({ oid, size }) => ({ oid, size })),
    hash_algo: "sha256",
  };
  const headers = clientHeaders(opts);
  headers.set("content-type", LFS_CONTENT_TYPE);
  headers.set("accept", LFS_CONTENT_TYPE);
  const res = await fetchImpl(
    new Request(`${url.replace(/\/+$/, "")}/objects/batch`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let message = text;
    try {
      message = (JSON.parse(text) as { message?: string }).message ?? text;
    } catch {
      // not JSON: the text itself
    }
    throw new Error(`lfs batch ${operation} failed: ${res.status} ${message}`.trim());
  }
  const json = (await res.json()) as BatchResponse;
  if (!json || !Array.isArray(json.objects))
    throw new Error(`lfs batch ${operation}: the response has no objects`);
  if (json.transfer !== undefined && json.transfer !== BASIC_TRANSFER)
    throw new Error(`lfs batch ${operation}: the server chose transfer ${json.transfer}`);
  return json;
}

/**
 * The batch answer checked against what was asked: the answers to transfer,
 * in the server's order, and the error events for what does not match — an
 * object nobody asked for (never transferred), a second answer for one oid,
 * an answer with another size, and every object the server left out.
 */
function matchAnswers(
  requested: Map<string, number>,
  answers: BatchObjectResponse[],
): { matched: BatchObjectResponse[]; errors: TransportEvent[] } {
  const matched: BatchObjectResponse[] = [];
  const errors: TransportEvent[] = [];
  const seen = new Set<string>();
  for (const obj of answers) {
    const oid = obj?.oid;
    if (typeof oid !== "string" || !requested.has(oid) || seen.has(oid)) {
      errors.push({
        type: "error",
        oid: String(oid),
        reason: "unexpected object in batch response",
      });
      continue;
    }
    seen.add(oid);
    if (!obj.error && obj.size !== requested.get(oid)) {
      errors.push({ type: "error", oid, reason: "size mismatch in batch response" });
      continue;
    }
    matched.push(obj);
  }
  for (const oid of requested.keys()) {
    if (!seen.has(oid)) errors.push({ type: "error", oid, reason: "missing from batch response" });
  }
  return { matched, errors };
}

/** One entry per oid (the first one's size). */
function unique(oids: LfsPointer[]): LfsPointer[] {
  const byOid = new Map<string, LfsPointer>();
  for (const p of oids) if (!byOid.has(p.oid)) byOid.set(p.oid, p);
  return [...byOid.values()];
}

type Args = [string, LfsPointer[], FetchLike?, LfsTransferOptions?];

/** The overloads' arguments as one store and the rest. */
function normalize(
  store: ContentStore | LfsObjectStore,
  rest: unknown[],
): {
  objects: LfsObjectStore;
  url: string;
  oids: LfsPointer[];
  fetchImpl: FetchLike;
  opts: LfsTransferOptions;
} {
  let args: Args;
  let objects: LfsObjectStore;
  if (isContentStore(store)) {
    objects = contentStoreLfsObjects(store, rest[0] as LfsResolver);
    args = rest.slice(1) as Args;
  } else {
    objects = store;
    args = rest as Args;
  }
  const [url, oids, fetchImpl, opts] = args;
  return { objects, url, oids, fetchImpl: fetchImpl ?? defaultFetch, opts: opts ?? {} };
}

/**
 * Upload whole objects to a Git LFS endpoint: `POST {url}/objects/batch`
 * (operation `upload`), then for each returned upload action `PUT` the object
 * from the local store, and call its `verify` action when the server offers
 * one. Objects the server answers without actions (it holds them) are not
 * sent. `store` is a content-store with its resolver, or an
 * {@link LfsObjectStore} (`createFilesLfsStore`).
 *
 * The batch answer must name exactly the objects asked for, with their sizes:
 * an object it adds is never sent, and every mismatch is an `error` event. The
 * body streams from the store as the request reads it (`duplex: "half"`), so
 * the object is never held in memory. Its `content-length` is the size of the
 * local object, never a size from the server; when that size disagrees with
 * the requested pointer, the object is reported as a `size mismatch` error and
 * not sent. Every per-object failure, a rejected `fetch` included, becomes
 * that object's `error` event and the remaining objects are still uploaded. A
 * batch the server refuses (any non-2xx status) throws, with its message.
 *
 * `opts.headers` and `opts.credentials` go with the batch, and with the
 * transfers unless the server marked the object `authenticated`; an action's
 * headers replace the client's of the same name, case-insensitively.
 *
 * Browsers collect the body unless `opts.streamRequestBody` is set (Firefox
 * and Safari cannot stream request bodies; Chromium only over HTTP/2). A
 * streamed browser upload also carries no length: `content-length` is a
 * forbidden header there, which the browser drops, so it sends the body
 * chunked, and presigned S3-style URLs may reject it. A collected body has a
 * length the browser sets itself.
 */
export function lfsUpload(
  store: ContentStore,
  resolver: LfsResolver,
  url: string,
  oids: LfsPointer[],
  fetchImpl?: FetchLike,
  opts?: LfsTransferOptions,
): AsyncIterable<TransportEvent>;
export function lfsUpload(
  store: LfsObjectStore,
  url: string,
  oids: LfsPointer[],
  fetchImpl?: FetchLike,
  opts?: LfsTransferOptions,
): AsyncIterable<TransportEvent>;
export async function* lfsUpload(
  store: ContentStore | LfsObjectStore,
  ...rest: unknown[]
): AsyncIterable<TransportEvent> {
  const { objects, url, oids, fetchImpl, opts } = normalize(store, rest);
  const endpointOrigin = originOf(url);
  const wanted = unique(oids);
  const batch = await postBatch(fetchImpl, url, "upload", wanted, opts);
  yield { type: "batch", operation: "upload", count: batch.objects.length };
  const stream = shouldStreamRequestBody(opts.streamRequestBody);
  const requested = new Map(wanted.map((p) => [p.oid, p.size]));
  const { matched, errors } = matchAnswers(requested, batch.objects);
  yield* errors;

  for (const obj of matched) {
    if (obj.error) {
      yield { type: "error", oid: obj.oid, reason: obj.error.message };
      continue;
    }
    const action = obj.actions?.upload;
    if (!action) continue; // the server already has it

    let failure: string | undefined;
    try {
      failure = await uploadOne(obj, action);
    } catch (error) {
      failure = errorMessage(error);
    }
    yield failure === undefined
      ? { type: "object-uploaded", oid: obj.oid }
      : { type: "error", oid: obj.oid, reason: failure };
  }

  /** Sends one object (and verifies it); the reason it failed, or `undefined`. */
  async function uploadOne(
    obj: BatchObjectResponse,
    action: BatchAction,
  ): Promise<string | undefined> {
    const size = await objects.size(obj.oid);
    if (size === undefined) return "no local object for oid";
    if (size !== obj.size || size !== requested.get(obj.oid)) return "size mismatch";
    const headers = transferHeaders(obj, action, opts, endpointOrigin);
    headers.set("content-length", String(size));
    if (!headers.has("content-type")) headers.set("content-type", "application/octet-stream");
    const res = await fetchWithRequestBody(
      () => objects.read(obj.oid),
      async (init) =>
        fetchImpl(new Request(action.href, { method: "PUT", headers, ...init } as RequestInit)),
      stream,
    );
    await discard(res); // only the status matters
    if (!res.ok) return `upload failed: ${res.status}`;

    const verify = obj.actions?.verify;
    if (verify) {
      const verifyHeaders = transferHeaders(obj, verify, opts, endpointOrigin);
      verifyHeaders.set("content-type", LFS_CONTENT_TYPE);
      verifyHeaders.set("accept", LFS_CONTENT_TYPE);
      const checked = await fetchImpl(
        new Request(verify.href, {
          method: "POST",
          headers: verifyHeaders,
          body: JSON.stringify({ oid: obj.oid, size }),
        }),
      );
      await discard(checked);
      if (!checked.ok) return `verify failed: ${checked.status}`;
    }
    return undefined;
  }
}

/** Per store, per oid: the tail of the downloads queued for it (one at a time). */
const downloads = new WeakMap<LfsObjectStore, Map<string, Promise<unknown>>>();

async function exclusive<T>(store: LfsObjectStore, oid: string, fn: () => Promise<T>): Promise<T> {
  let queue = downloads.get(store);
  if (!queue) {
    queue = new Map();
    downloads.set(store, queue);
  }
  const before = queue.get(oid) ?? Promise.resolve();
  const run = before.then(fn, fn);
  const tail = run.catch(() => undefined);
  queue.set(oid, tail);
  try {
    return await run;
  } finally {
    if (queue.get(oid) === tail) queue.delete(oid);
  }
}

/** The chunks of `body`, throwing {@link SizeExceeded} once they run past `limit` bytes. */
async function* capped(body: ReadableStream<Uint8Array> | null, limit: number): ByteStream {
  if (!body) return;
  let size = 0;
  for await (const chunk of chunksOf(body)) {
    size += chunk.length;
    if (size > limit) throw new SizeExceeded();
    yield chunk;
  }
}

/**
 * Download whole objects from a Git LFS endpoint: `POST {url}/objects/batch`
 * (operation `download`), then for each returned download action `GET` the
 * object and store it as it arrives, hashing it on the way. At the end its
 * SHA-256 and size must match the requested pointer; otherwise it never
 * becomes visible and an `error` event reports `sha256 mismatch` or `size
 * mismatch`. A body that runs past the pointer size is cut off (cancelled)
 * early. Objects the store already holds are reported downloaded without a
 * request. The batch answer is checked as `lfsUpload` checks it, and
 * `opts.headers`/`opts.credentials` are sent the same way.
 *
 * A store that keeps partial downloads (`store.partial`, as
 * `createFilesLfsStore` does at `lfs/incomplete/<oid>.part`) resumes: a
 * download that breaks keeps the bytes that arrived, and the next call asks
 * only for the rest with `Range: bytes=N-`. A 200 starts over from zero. A
 * 206 from another offset (or without `Content-Range`), a 416, or held
 * bytes that change while they are copied drop the held bytes and start once
 * more from zero, as git-lfs does. Bytes that do not verify are dropped.
 * Downloads of one oid run one at a time within a process: per store instance,
 * or, for a store with `partial.exclusive` (`createFilesLfsStore`), per
 * FilesApi instance and root.
 *
 * Into a content-store (with its resolver) nothing is kept from a broken
 * download, and a refused object stays in the store, unrecorded, until its
 * `gc` runs with the resolver's values as live roots (see `storeVerified`).
 * A response that is not ok is cancelled unread, and a rejected `fetch`
 * becomes that object's `error` event; the remaining objects are still
 * downloaded.
 */
export function lfsDownload(
  store: ContentStore,
  resolver: LfsResolver,
  url: string,
  oids: LfsPointer[],
  fetchImpl?: FetchLike,
  opts?: LfsTransferOptions,
): AsyncIterable<TransportEvent>;
export function lfsDownload(
  store: LfsObjectStore,
  url: string,
  oids: LfsPointer[],
  fetchImpl?: FetchLike,
  opts?: LfsTransferOptions,
): AsyncIterable<TransportEvent>;
export async function* lfsDownload(
  store: ContentStore | LfsObjectStore,
  ...rest: unknown[]
): AsyncIterable<TransportEvent> {
  const { objects, url, oids, fetchImpl, opts } = normalize(store, rest);
  const endpointOrigin = originOf(url);
  const missing: LfsPointer[] = [];
  for (const p of unique(oids)) {
    if ((await objects.size(p.oid)) === p.size) yield { type: "object-downloaded", oid: p.oid };
    else missing.push(p);
  }
  if (missing.length === 0) return;

  const batch = await postBatch(fetchImpl, url, "download", missing, opts);
  yield { type: "batch", operation: "download", count: batch.objects.length };
  const requested = new Map(missing.map((p) => [p.oid, p.size]));
  const { matched, errors } = matchAnswers(requested, batch.objects);
  yield* errors;

  for (const obj of matched) {
    if (obj.error) {
      yield { type: "error", oid: obj.oid, reason: obj.error.message };
      continue;
    }
    const action = obj.actions?.download;
    if (!action) {
      yield { type: "error", oid: obj.oid, reason: "no download action" };
      continue;
    }
    const pointer = { oid: obj.oid, size: requested.get(obj.oid) ?? obj.size };
    let failure: string | undefined;
    try {
      const partial = objects.partial;
      failure = !partial
        ? await whole(pointer, obj, action)
        : partial.exclusive
          ? await partial.exclusive(obj.oid, () => resumable(pointer, obj, action))
          : await exclusive(objects, obj.oid, () => resumable(pointer, obj, action));
    } catch (error) {
      failure = errorMessage(error);
    }
    yield failure === undefined
      ? { type: "object-downloaded", oid: obj.oid }
      : { type: "error", oid: obj.oid, reason: failure };
  }

  /** The whole object in one GET, verified as it is stored. */
  async function whole(
    pointer: LfsPointer,
    obj: BatchObjectResponse,
    action: BatchAction,
  ): Promise<string | undefined> {
    const res = await fetchImpl(
      new Request(action.href, {
        method: "GET",
        headers: transferHeaders(obj, action, opts, endpointOrigin),
      }),
    );
    if (!res.ok) {
      await discard(res);
      return `download failed: ${res.status}`;
    }
    // Standard LFS requirement: the stored bytes must hash to the oid (and match the size).
    const stored = await objects.put(res.body ?? new Uint8Array(0), pointer);
    return stored.ok ? undefined : stored.reason;
  }

  /** Into the store's partial bytes, resumed from what is held, then verified. */
  async function resumable(
    pointer: LfsPointer,
    obj: BatchObjectResponse,
    action: BatchAction,
  ): Promise<string | undefined> {
    const partial = objects.partial;
    if (!partial) throw new Error("the store keeps no partial downloads");
    // another download of it may have finished while this one waited
    if ((await objects.size(pointer.oid)) === pointer.size) return undefined;
    let held = await partial.size(pointer.oid);
    if (held > pointer.size) {
      await partial.remove(pointer.oid);
      held = 0;
    }
    // As git-lfs's basic download: an answer that cannot continue the held
    // bytes (a 206 from another offset or without Content-Range, a 416, the
    // held bytes changing under us) drops them and starts once more from 0.
    for (let restarted = false; held < pointer.size; restarted = true) {
      const restart = async (): Promise<boolean> => {
        await partial.remove(pointer.oid);
        held = 0;
        return !restarted;
      };
      const headers = transferHeaders(obj, action, opts, endpointOrigin);
      if (held > 0) headers.set("range", `bytes=${held}-`);
      const res = await fetchImpl(new Request(action.href, { method: "GET", headers }));
      if (res.status === 206) {
        const start = /^bytes (\d+)-/.exec(res.headers.get("content-range") ?? "")?.[1];
        if (start === undefined || Number(start) !== held) {
          await discard(res);
          if (await restart()) continue;
          return `the server resumed at ${start ?? "?"}, not ${held}`;
        }
      } else if (res.ok) {
        // the whole object again: what was held goes
        if (held > 0) await partial.remove(pointer.oid);
        held = 0;
      } else {
        await discard(res);
        if (res.status === 416 && held > 0 && (await restart())) continue;
        if (res.status === 416) await partial.remove(pointer.oid);
        return `download failed: ${res.status}`;
      }
      try {
        held = await partial.append(pointer.oid, capped(res.body, pointer.size - held));
      } catch (error) {
        if (error instanceof SizeExceeded) {
          await partial.remove(pointer.oid);
          return "size mismatch";
        }
        if ((error as Error | undefined)?.name === "LfsPartialChangedError") {
          await discard(res);
          if (await restart()) continue;
          return errorMessage(error);
        }
        const kept = await partial.size(pointer.oid);
        return `${errorMessage(error)} (${kept} of ${pointer.size} bytes kept to resume)`;
      }
      if (held < pointer.size)
        return `incomplete: ${held} of ${pointer.size} bytes (kept to resume)`;
    }
    const completed = await partial.complete(pointer);
    return completed.ok ? undefined : completed.reason;
  }
}
