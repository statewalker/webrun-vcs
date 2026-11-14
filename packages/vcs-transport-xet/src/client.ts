/**
 * The xet client. Each direction negotiates once over the standard LFS batch
 * API advertising `["xet","basic"]`. If the server agreed to `xet`, bytes move
 * through `content-transfer` (chunk dedup, resumable) over a per-oid chunk
 * channel; otherwise the whole transfer defers to the reused
 * `@statewalker/vcs-transport-lfs` basic path. The whole-file SHA-256 (the LFS
 * oid) and size are verified on a completed xet download — the interop
 * guarantee — by streaming the stored object through an incremental SHA-256,
 * so memory stays bounded by one chunk.
 */

import type { BatchRequest, LfsPointer, LfsResolver } from "@statewalker/vcs-transport-lfs";
import { createLfsPointer, lfsDownload, lfsUpload } from "@statewalker/vcs-transport-lfs";
import type { ContentStore } from "@statewalker/webrun-content-store";
import { remoteStore, transfer } from "@statewalker/webrun-content-transfer";
import {
  XET_TRANSFER,
  XET_TRANSFERS,
  type XetBatchObjectResponse,
  type XetBatchResponse,
} from "./batch.js";
import { httpChunkChannel } from "./chunk-channel.js";
import type { XetOptions, XetTransportEvent } from "./types.js";

const LFS_CONTENT_TYPE = "application/vnd.git-lfs+json";
const defaultFetch = (request: Request) => fetch(request);

async function postXetBatch(
  fetchImpl: XetOptions["fetchImpl"] & {},
  url: string,
  operation: "upload" | "download",
  oids: LfsPointer[],
): Promise<XetBatchResponse> {
  const body: BatchRequest = {
    operation,
    transfers: XET_TRANSFERS,
    objects: oids.map(({ oid, size }) => ({ oid, size })),
  };
  const res = await fetchImpl(
    new Request(`${url}/objects/batch`, {
      method: "POST",
      headers: { "content-type": LFS_CONTENT_TYPE, accept: LFS_CONTENT_TYPE },
      body: JSON.stringify(body),
    }),
  );
  return (await res.json()) as XetBatchResponse;
}

/**
 * Upload objects to a xet-or-basic LFS endpoint. On a `xet` agreement each
 * object's already-local bytes are pushed chunk-by-chunk (only the chunks the
 * server is missing) through content-transfer; on a `basic` response the whole
 * upload defers to `vcs-transport-lfs`.
 */
export async function* xetUpload(
  store: ContentStore,
  resolver: LfsResolver,
  url: string,
  oids: LfsPointer[],
  opts: XetOptions = {},
): AsyncIterable<XetTransportEvent> {
  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  const batch = await postXetBatch(fetchImpl, url, "upload", oids);

  if (batch.transfer !== XET_TRANSFER) {
    yield* lfsUpload(store, resolver, url, oids, fetchImpl, {
      streamRequestBody: opts.streamRequestBody,
    });
    return;
  }

  yield { type: "batch", operation: "upload", count: batch.objects.length };
  for (const obj of batch.objects) {
    if (obj.error) {
      yield { type: "error", oid: obj.oid, reason: obj.error.message };
      continue;
    }
    const action = obj.actions?.upload;
    if (!action) continue; // server already has it

    const localId = await resolver.toObject(obj.oid);
    if (localId === undefined) {
      yield { type: "error", oid: obj.oid, reason: "no local object for oid" };
      continue;
    }
    const remote = remoteStore(httpChunkChannel(fetchImpl, action.href));
    try {
      for await (const ev of transfer([localId], store, remote, {
        checkpoint: opts.checkpoint,
        limits: opts.limits,
        hashContent: opts.hashContent,
      })) {
        if (ev.type === "chunk-sent") {
          yield { type: "chunk-sent", oid: obj.oid, chunkId: ev.chunkId, size: ev.size };
        }
      }
    } catch (err) {
      yield { type: "error", oid: obj.oid, reason: (err as Error).message };
      continue;
    }
    yield { type: "object-uploaded", oid: obj.oid };
  }
}

/**
 * Download objects from a xet-or-basic LFS endpoint. On a `xet` agreement each
 * object is pulled chunk-by-chunk (only the chunks missing locally) through
 * content-transfer, then its whole-file SHA-256 and size are verified against
 * the pointer (streamed from the store, never collected) before the mapping is
 * recorded; a mismatch removes the object again; on a `basic` response the whole download
 * defers to `vcs-transport-lfs`.
 */
export async function* xetDownload(
  store: ContentStore,
  resolver: LfsResolver,
  url: string,
  oids: LfsPointer[],
  opts: XetOptions = {},
): AsyncIterable<XetTransportEvent> {
  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  const batch = await postXetBatch(fetchImpl, url, "download", oids);

  if (batch.transfer !== XET_TRANSFER) {
    yield* lfsDownload(store, resolver, url, oids, fetchImpl);
    return;
  }

  yield { type: "batch", operation: "download", count: batch.objects.length };
  const requested = new Map(oids.map((p) => [p.oid, p.size]));
  for (const obj of batch.objects as XetBatchObjectResponse[]) {
    if (obj.error) {
      yield { type: "error", oid: obj.oid, reason: obj.error.message };
      continue;
    }
    const action = obj.actions?.download;
    if (!action || action.objectId === undefined) {
      yield { type: "error", oid: obj.oid, reason: "no download action" };
      continue;
    }
    const remoteId = action.objectId;
    const remote = remoteStore(httpChunkChannel(fetchImpl, action.href));
    try {
      for await (const ev of transfer([remoteId], remote, store, {
        checkpoint: opts.checkpoint,
        limits: opts.limits,
        hashContent: opts.hashContent,
      })) {
        if (ev.type === "chunk-sent") {
          yield { type: "chunk-sent", oid: obj.oid, chunkId: ev.chunkId, size: ev.size };
        }
      }
    } catch (err) {
      yield { type: "error", oid: obj.oid, reason: (err as Error).message };
      continue;
    }

    // Interop guarantee: the reassembled whole object must hash to the LFS oid
    // and have the pointer's size. Hashed as it streams from the store.
    const actual = await createLfsPointer(store.read(remoteId));
    const size = requested.get(obj.oid) ?? obj.size;
    const reason =
      actual.size !== size
        ? "size mismatch"
        : actual.oid !== obj.oid
          ? "sha256 mismatch"
          : undefined;
    if (reason) {
      // Keep an object that was already stored here for its real oid.
      if ((await resolver.toObject(actual.oid)) !== remoteId) await store.remove(remoteId);
      yield { type: "error", oid: obj.oid, reason };
      continue;
    }
    await resolver.record(obj.oid, remoteId);
    yield { type: "object-downloaded", oid: obj.oid };
  }
}
