import { toReadableStream } from "@statewalker/vcs-utils/streams";
import type { ContentStore } from "@statewalker/webrun-content-store";
import type { HttpHandler } from "@statewalker/webrun-http-streams";
import type { BatchObjectResponse, BatchRequest, BatchResponse } from "./batch.js";
import { BASIC_TRANSFER, LFS_CONTENT_TYPE } from "./batch.js";
import type { LfsResolver } from "./types.js";
import { storeVerified } from "./verify.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": LFS_CONTENT_TYPE },
  });
}

/**
 * A Git LFS server over a content-store: the batch API + basic whole-object
 * transfer. Routes `POST {base}/objects/batch`, and `PUT`/`GET
 * {base}/objects/<oid>` for the basic transfer.
 *
 * On upload (`PUT`) the request body is stored via `store.put` as it arrives,
 * hashed on the way; its SHA-256 must equal the path oid, else the object is
 * removed again and the upload rejected (422). On success the LFS-oid →
 * content-store-id mapping is recorded. On download (`GET`) the mapping is
 * resolved and the object streamed back from the store with its
 * `content-length`; an unknown oid is 404. A batch `download` for an unknown oid is reported as an `error`
 * object, never a crash.
 */
export function serveLfs(store: ContentStore, resolver: LfsResolver): HttpHandler {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const base = url.href.slice(0, url.href.length - url.pathname.length);

    // POST /objects/batch
    if (request.method === "POST" && url.pathname.endsWith("/objects/batch")) {
      const req = (await request.json()) as BatchRequest;
      const href = (oid: string) => `${base}/objects/${oid}`;
      const objects: BatchObjectResponse[] = [];
      for (const { oid, size } of req.objects) {
        if (req.operation === "upload") {
          objects.push({ oid, size, actions: { upload: { href: href(oid) } } });
        } else {
          const mapped = await resolver.toObject(oid);
          if (mapped === undefined) {
            objects.push({ oid, size, error: { code: 404, message: "Object does not exist" } });
          } else {
            objects.push({ oid, size, actions: { download: { href: href(oid) } } });
          }
        }
      }
      const body: BatchResponse = { transfer: BASIC_TRANSFER, objects };
      return json(body);
    }

    // basic transfer: /objects/<oid>
    const m = url.pathname.match(/\/objects\/([^/]+)$/);
    if (m && m[1] !== "batch") {
      const oid = m[1];

      if (request.method === "PUT") {
        // Standard LFS requirement: the whole object must hash to the oid.
        const stored = await storeVerified(store, resolver, request.body ?? new Uint8Array(0), {
          oid,
        });
        if (!stored.ok) return json({ message: "oid does not match content" }, 422);
        return new Response(null, { status: 200 });
      }

      if (request.method === "GET") {
        const mapped = await resolver.toObject(oid);
        const manifest = mapped === undefined ? undefined : await store.getManifest(mapped);
        if (mapped === undefined || !manifest) {
          return json({ message: "Object does not exist" }, 404);
        }
        return new Response(toReadableStream(store.read(mapped)), {
          status: 200,
          headers: { "content-length": String(manifest.size) },
        });
      }
    }

    return json({ message: "Not found" }, 404);
  };
}
