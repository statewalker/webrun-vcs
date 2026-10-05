/**
 * A xet-capable Git LFS server over a content-store. It (1) answers
 * `POST /objects/batch` advertising `xet` when the client offered it (still
 * listing `basic`), (2) exposes a per-oid chunk-negotiation endpoint
 * `POST /xet-chunks/<oid>` that bridges `content-transfer.serveStore(store)` onto
 * HTTP, and (3) delegates every basic `PUT`/`GET` (the fallback path) to the
 * reused {@link serveLfs} handler. Chunk dedup, resume, and integrity all live
 * in content-transfer; the LFS batch/basic internals all live in vcs-transport-lfs.
 */

import type { BatchRequest, LfsResolver } from "@statewalker/vcs-transport-lfs";
import { serveLfs } from "@statewalker/vcs-transport-lfs";
import type { ContentStore, ObjectDescriptor } from "@statewalker/webrun-content-store";
import { serveStore } from "@statewalker/webrun-content-transfer";
import type { HttpHandler } from "@statewalker/webrun-http-streams";
import { XET_TRANSFER, type XetBatchObjectResponse, type XetBatchResponse } from "./batch.js";
import { serveChunkChannel } from "./chunk-channel.js";

const LFS_CONTENT_TYPE = "application/vnd.git-lfs+json";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": LFS_CONTENT_TYPE },
  });
}

/**
 * Wrap a store so that assembling an object (content-transfer's `putManifest` →
 * reassemble + `put`) also records the LFS-oid → content-store-id mapping, so a
 * later xet/basic download can resolve this oid.
 */
function recordingStore(store: ContentStore, oid: string, resolver: LfsResolver): ContentStore {
  return {
    ...store,
    async put(content) {
      const descriptor: ObjectDescriptor = await store.put(content);
      await resolver.record(oid, descriptor.id);
      return descriptor;
    },
  };
}

export function serveXet(store: ContentStore, resolver: LfsResolver): HttpHandler {
  const basic = serveLfs(store, resolver);

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const base = url.href.slice(0, url.href.length - url.pathname.length);

    // Per-oid chunk-negotiation channel (the content-transfer Duplex over HTTP).
    const chunkMatch = url.pathname.match(/\/xet-chunks\/([^/]+)$/);
    if (request.method === "POST" && chunkMatch) {
      const oid = chunkMatch[1];
      return serveChunkChannel(serveStore(recordingStore(store, oid, resolver)), request);
    }

    // Batch negotiation: advertise xet when offered, else defer to basic LFS.
    if (request.method === "POST" && url.pathname.endsWith("/objects/batch")) {
      const req = (await request.clone().json()) as BatchRequest;
      if (!req.transfers?.includes(XET_TRANSFER)) return basic(request);

      const objects: XetBatchObjectResponse[] = [];
      for (const { oid, size } of req.objects) {
        const href = `${base}/xet-chunks/${oid}`;
        if (req.operation === "upload") {
          objects.push({ oid, size, actions: { upload: { href } } });
        } else {
          const mapped = await resolver.toObject(oid);
          if (mapped === undefined) {
            objects.push({ oid, size, error: { code: 404, message: "Object does not exist" } });
          } else {
            objects.push({ oid, size, actions: { download: { href, objectId: mapped } } });
          }
        }
      }
      const body: XetBatchResponse = { transfer: XET_TRANSFER, objects };
      return json(body);
    }

    // Everything else (basic PUT/GET) is the reused LFS server.
    return basic(request);
  };
}
