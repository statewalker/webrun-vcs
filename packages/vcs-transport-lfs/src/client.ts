import { fetchWithRequestBody, shouldStreamRequestBody } from "@statewalker/vcs-utils/streams";
import type { ContentStore } from "@statewalker/webrun-content-store";
import type { BatchAction, BatchRequest, BatchResponse } from "./batch.js";
import { BASIC_TRANSFER, LFS_CONTENT_TYPE } from "./batch.js";
import type {
  FetchLike,
  LfsPointer,
  LfsResolver,
  LfsTransferOptions,
  TransportEvent,
} from "./types.js";
import { storeVerified } from "./verify.js";

const defaultFetch: FetchLike = (request) => fetch(request);

async function postBatch(
  fetchImpl: FetchLike,
  url: string,
  operation: "upload" | "download",
  oids: LfsPointer[],
): Promise<BatchResponse> {
  const body: BatchRequest = {
    operation,
    transfers: [BASIC_TRANSFER],
    objects: oids.map(({ oid, size }) => ({ oid, size })),
  };
  const res = await fetchImpl(
    new Request(`${url}/objects/batch`, {
      method: "POST",
      headers: { "content-type": LFS_CONTENT_TYPE, accept: LFS_CONTENT_TYPE },
      body: JSON.stringify(body),
    }),
  );
  return (await res.json()) as BatchResponse;
}

/** Releases a response whose body is not read, so its connection can be reused. */
async function discard(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => {});
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Upload whole objects to a Git LFS endpoint: `POST {url}/objects/batch`
 * (operation `upload`), then for each returned upload action `PUT` the object
 * read from the local content-store via the resolver mapping.
 *
 * The body streams from the store as the request reads it (`duplex: "half"`),
 * so the object is never held in memory. Its `content-length` is the size of
 * the local object (its manifest), never a size from the server; when that
 * size disagrees with the requested pointer or the batch response, the object
 * is reported as a `size mismatch` error and not sent. Every per-object
 * failure, a rejected `fetch` included, becomes that object's `error` event and
 * the remaining objects are still uploaded.
 *
 * Browsers collect the body unless `opts.streamRequestBody` is set (Firefox
 * and Safari cannot stream request bodies; Chromium only over HTTP/2). A
 * streamed browser upload also carries no length: `content-length` is a
 * forbidden header there, which the browser drops, so it sends the body
 * chunked, and presigned S3-style URLs may reject it. A collected body has a
 * length the browser sets itself.
 */
export async function* lfsUpload(
  store: ContentStore,
  resolver: LfsResolver,
  url: string,
  oids: LfsPointer[],
  fetchImpl: FetchLike = defaultFetch,
  opts: LfsTransferOptions = {},
): AsyncIterable<TransportEvent> {
  const batch = await postBatch(fetchImpl, url, "upload", oids);
  yield { type: "batch", operation: "upload", count: batch.objects.length };
  const stream = shouldStreamRequestBody(opts.streamRequestBody);
  const requested = new Map(oids.map((p) => [p.oid, p.size]));

  for (const obj of batch.objects) {
    if (obj.error) {
      yield { type: "error", oid: obj.oid, reason: obj.error.message };
      continue;
    }
    const action = obj.actions?.upload;
    if (!action) continue; // server already has it — nothing to do

    let failure: string | undefined;
    try {
      failure = await uploadOne(obj.oid, obj.size, requested.get(obj.oid), action);
    } catch (error) {
      failure = errorMessage(error);
    }
    yield failure === undefined
      ? { type: "object-uploaded", oid: obj.oid }
      : { type: "error", oid: obj.oid, reason: failure };
  }

  /** Sends one object; returns the reason it failed, or `undefined` once uploaded. */
  async function uploadOne(
    oid: string,
    batchSize: number,
    pointerSize: number | undefined,
    action: BatchAction,
  ): Promise<string | undefined> {
    const localId = await resolver.toObject(oid);
    const manifest = localId === undefined ? undefined : await store.getManifest(localId);
    if (localId === undefined || !manifest) return "no local object for oid";
    const size = manifest.size;
    if (size !== batchSize || (pointerSize !== undefined && size !== pointerSize)) {
      return "size mismatch";
    }
    const headers = new Headers(action.header);
    headers.set("content-length", String(size));
    const res = await fetchWithRequestBody(
      () => store.read(localId),
      async (init) =>
        fetchImpl(new Request(action.href, { method: "PUT", headers, ...init } as RequestInit)),
      stream,
    );
    await discard(res); // only the status matters
    return res.ok ? undefined : `upload failed: ${res.status}`;
  }
}

/**
 * Download whole objects from a Git LFS endpoint: `POST {url}/objects/batch`
 * (operation `download`), then for each returned download action `GET` the
 * object and store the response body as it arrives, hashing it on the way. At
 * the end its SHA-256 and size must match the requested pointer; otherwise
 * nothing is recorded and an `error` event reports `sha256 mismatch` or `size
 * mismatch`. The refused object is not removed: it stays in the store until its
 * `gc` runs with the resolver's values as live roots (see `storeVerified`). A
 * body that runs past the pointer size is cut off (cancelled) early. A
 * response that is not ok is cancelled unread, and a rejected `fetch` becomes
 * that object's `error` event; the remaining objects are still downloaded.
 */
export async function* lfsDownload(
  store: ContentStore,
  resolver: LfsResolver,
  url: string,
  oids: LfsPointer[],
  fetchImpl: FetchLike = defaultFetch,
): AsyncIterable<TransportEvent> {
  const batch = await postBatch(fetchImpl, url, "download", oids);
  yield { type: "batch", operation: "download", count: batch.objects.length };
  const requested = new Map(oids.map((p) => [p.oid, p.size]));

  for (const obj of batch.objects) {
    if (obj.error) {
      yield { type: "error", oid: obj.oid, reason: obj.error.message };
      continue;
    }
    const action = obj.actions?.download;
    if (!action) {
      yield { type: "error", oid: obj.oid, reason: "no download action" };
      continue;
    }
    let failure: string | undefined;
    try {
      const res = await fetchImpl(
        new Request(action.href, { method: "GET", headers: action.header }),
      );
      if (!res.ok) {
        await discard(res);
        failure = `download failed: ${res.status}`;
      } else {
        // Standard LFS requirement: the stored bytes must hash to the oid (and match the size).
        const size = requested.get(obj.oid) ?? obj.size;
        const stored = await storeVerified(store, resolver, res.body ?? new Uint8Array(0), {
          oid: obj.oid,
          size,
        });
        if (!stored.ok) failure = stored.reason;
      }
    } catch (error) {
      failure = errorMessage(error);
    }
    yield failure === undefined
      ? { type: "object-downloaded", oid: obj.oid }
      : { type: "error", oid: obj.oid, reason: failure };
  }
}
