import type { ContentStore } from "@statewalker/webrun-content-store";
import type { BatchRequest, BatchResponse } from "./batch.js";
import { BASIC_TRANSFER, LFS_CONTENT_TYPE } from "./batch.js";
import { collect, streamOf } from "./bytes.js";
import { sha256Hex } from "./sha256.js";
import type { FetchLike, LfsPointer, LfsResolver, TransportEvent } from "./types.js";

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
 * (operation `upload`), then for each returned upload action `PUT` the whole
 * object bytes read from the local content-store via the resolver mapping.
 */
export async function* lfsUpload(
  store: ContentStore,
  resolver: LfsResolver,
  url: string,
  oids: LfsPointer[],
  fetchImpl: FetchLike = defaultFetch,
): AsyncIterable<TransportEvent> {
  const batch = await postBatch(fetchImpl, url, "upload", oids);
  yield { type: "batch", operation: "upload", count: batch.objects.length };

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
    const bytes = await collect(store.read(localId));
    const res = await fetchImpl(
      new Request(action.href, { method: "PUT", headers: action.header, body: bytes }),
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
 * (operation `download`), then for each returned download action `GET` the whole
 * object bytes, verify their SHA-256 against the oid (rejected, never stored, on
 * mismatch), assemble into the local content-store and record the mapping.
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
    const bytes = new Uint8Array(await res.arrayBuffer());
    // Standard LFS requirement: verify the whole-object SHA-256 before storing.
    if ((await sha256Hex(bytes)) !== obj.oid) {
      yield { type: "error", oid: obj.oid, reason: "sha256 mismatch" };
      continue;
    }
    const d = await store.put(streamOf(bytes));
    await resolver.record(obj.oid, d.id);
    yield { type: "object-downloaded", oid: obj.oid };
  }
}
