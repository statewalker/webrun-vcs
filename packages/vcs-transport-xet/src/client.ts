/**
 * The xet client. Each direction negotiates once over the standard LFS batch
 * API advertising `["xet","basic"]`. If the server agreed to `xet`, bytes move
 * through `content-transfer` (chunk dedup, resumable) over a per-oid chunk
 * channel; otherwise the whole transfer defers to the reused
 * `@statewalker/vcs-transport-lfs` basic path. The whole-file SHA-256 (the LFS
 * oid) is verified on a completed xet download — the interop guarantee.
 */

import type { BatchRequest, LfsPointer, LfsResolver } from "@statewalker/vcs-transport-lfs";
import { lfsDownload, lfsUpload, sha256Hex } from "@statewalker/vcs-transport-lfs";
import type { ByteStream, ContentStore } from "@statewalker/webrun-content-store";
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

async function collect(stream: ByteStream): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const chunk of stream) parts.push(chunk);
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

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
    yield* lfsUpload(store, resolver, url, oids, fetchImpl);
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
 * content-transfer, then its whole-file SHA-256 is verified against the oid
 * before the mapping is recorded; on a `basic` response the whole download
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

    // Interop guarantee: the reassembled whole object must hash to the LFS oid.
    const bytes = await collect(store.read(remoteId));
    if ((await sha256Hex(bytes)) !== obj.oid) {
      await store.remove(remoteId);
      yield { type: "error", oid: obj.oid, reason: "sha256 mismatch" };
      continue;
    }
    await resolver.record(obj.oid, remoteId);
    yield { type: "object-downloaded", oid: obj.oid };
  }
}
