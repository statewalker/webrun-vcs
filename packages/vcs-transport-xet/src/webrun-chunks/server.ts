/**
 * A webrun-chunks-capable Git LFS server over a content-store. It (1) answers
 * `POST /objects/batch` advertising `webrun-chunks` when the client offered it (still
 * listing `basic`), (2) exposes a per-oid chunk-negotiation endpoint
 * `POST /webrun-chunks/<oid>` that bridges `content-transfer.serveStore(store)` onto
 * HTTP, and (3) delegates every basic `PUT`/`GET` (the fallback path) to the
 * reused {@link serveLfs} handler. Chunk dedup, resume, and integrity all live
 * in content-transfer; the LFS batch/basic internals all live in vcs-transport-lfs.
 */

import type { BatchRequest, LfsResolver } from "@statewalker/vcs-transport-lfs";
import { serveLfs, storeVerified } from "@statewalker/vcs-transport-lfs";
import type { ContentStore } from "@statewalker/webrun-content-store";
import { serveStore } from "@statewalker/webrun-content-transfer";
import type { FetchHandler } from "@statewalker/webrun-http-streams";
import {
  WEBRUN_CHUNKS_TRANSFER,
  type WebrunChunksBatchObjectResponse,
  type WebrunChunksBatchResponse,
} from "./batch.js";
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
 * reassemble + `put`) hashes the reassembled bytes as they stream into the
 * store and checks them against the LFS oid. On a match the LFS-oid →
 * content-store-id mapping is recorded, so a later webrun-chunks/basic download can
 * resolve this oid; on a mismatch nothing is recorded and the assemble fails,
 * which the client sees as an upload error. The refused object is left for the
 * store's `gc` (live roots: the resolver's values), never removed here.
 */
function recordingStore(store: ContentStore, oid: string, resolver: LfsResolver): ContentStore {
  return {
    ...store,
    async put(content) {
      const stored = await storeVerified(store, resolver, content, { oid });
      if (!stored.ok) throw new Error(`webrun-chunks upload refused: ${stored.reason}`);
      return stored.descriptor;
    },
  };
}

export function serveWebrunChunks(store: ContentStore, resolver: LfsResolver): FetchHandler {
  const basic = serveLfs(store, resolver);

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const base = url.href.slice(0, url.href.length - url.pathname.length);

    // Per-oid chunk-negotiation channel (the content-transfer Duplex over HTTP).
    const chunkMatch = url.pathname.match(/\/webrun-chunks\/([^/]+)$/);
    if (request.method === "POST" && chunkMatch) {
      const oid = chunkMatch[1];
      return serveChunkChannel(serveStore(recordingStore(store, oid, resolver)), request);
    }

    // Batch negotiation: advertise webrun-chunks when offered, else defer to basic LFS.
    if (request.method === "POST" && url.pathname.endsWith("/objects/batch")) {
      const req = (await request.clone().json()) as BatchRequest;
      if (!req.transfers?.includes(WEBRUN_CHUNKS_TRANSFER)) return basic(request);

      const objects: WebrunChunksBatchObjectResponse[] = [];
      for (const { oid, size } of req.objects) {
        const href = `${base}/webrun-chunks/${oid}`;
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
      const body: WebrunChunksBatchResponse = { transfer: WEBRUN_CHUNKS_TRANSFER, objects };
      return json(body);
    }

    // Everything else (basic PUT/GET) is the reused LFS server.
    return basic(request);
  };
}
