import { fetchWithRequestBody, shouldStreamRequestBody } from "@statewalker/vcs-utils/streams";
import type { ContentStore } from "@statewalker/webrun-content-store";
import type { BatchRequest, BatchResponse } from "./batch.js";
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

/**
 * Upload whole objects to a Git LFS endpoint: `POST {url}/objects/batch`
 * (operation `upload`), then for each returned upload action `PUT` the object
 * read from the local content-store via the resolver mapping. The body streams
 * from the store as the request reads it (`duplex: "half"`, with a
 * `content-length` from the pointer), so the object is never held in memory;
 * in browsers it is collected unless `opts.streamRequestBody` is set.
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

  for (const obj of batch.objects) {
    if (obj.error) {
      yield { type: "error", oid: obj.oid, reason: obj.error.message };
      continue;
    }
    const action = obj.actions?.upload;
    if (!action) continue; // server already has it — nothing to do

    const localId = await resolver.toObject(obj.oid);
    if (localId === undefined) {
      yield { type: "error", oid: obj.oid, reason: "no local object for oid" };
      continue;
    }
    const headers = new Headers(action.header);
    if (!headers.has("content-length")) headers.set("content-length", String(obj.size));
    const res = await fetchWithRequestBody(
      () => store.read(localId),
      async (init) =>
        fetchImpl(new Request(action.href, { method: "PUT", headers, ...init } as RequestInit)),
      stream,
    );
    if (!res.ok) {
      yield { type: "error", oid: obj.oid, reason: `upload failed: ${res.status}` };
      continue;
    }
    yield { type: "object-uploaded", oid: obj.oid };
  }
}

/**
 * Download whole objects from a Git LFS endpoint: `POST {url}/objects/batch`
 * (operation `download`), then for each returned download action `GET` the
 * object and store the response body as it arrives, hashing it on the way. At
 * the end its SHA-256 and size must match the requested pointer; otherwise the
 * stored object is removed again and an `error` event reports `sha256 mismatch`
 * or `size mismatch`. A body that runs past the pointer size is cut off early.
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
    const res = await fetchImpl(
      new Request(action.href, { method: "GET", headers: action.header }),
    );
    if (!res.ok) {
      yield { type: "error", oid: obj.oid, reason: `download failed: ${res.status}` };
      continue;
    }
    // Standard LFS requirement: the stored bytes must hash to the oid (and match the size).
    const size = requested.get(obj.oid) ?? obj.size;
    const stored = await storeVerified(store, resolver, res.body ?? new Uint8Array(0), {
      oid: obj.oid,
      size,
    });
    if (!stored.ok) {
      yield { type: "error", oid: obj.oid, reason: stored.reason };
      continue;
    }
    yield { type: "object-downloaded", oid: obj.oid };
  }
}
