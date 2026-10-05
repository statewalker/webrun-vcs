import type { ContentStore } from "@statewalker/webrun-content-store";
import type { HttpHandler } from "@statewalker/webrun-http-streams";
import type { BatchObjectResponse, BatchRequest, BatchResponse } from "./batch.js";
import { BASIC_TRANSFER, LFS_CONTENT_TYPE } from "./batch.js";
import { collect, streamOf } from "./bytes.js";
import { sha256Hex } from "./sha256.js";
import type { LfsResolver } from "./types.js";

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
 * On upload (`PUT`) the whole bytes are read, their SHA-256 verified against the
 * path oid (rejected 422 on mismatch, never stored), stored via `store.put`,
 * and the LFS-oid → content-store-id mapping recorded. On download (`GET`) the
 * mapping is resolved and the whole assembled object streamed back; an unknown
 * oid is 404. A batch `download` for an unknown oid is reported as an `error`
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
        const bytes = new Uint8Array(await request.arrayBuffer());
        // Standard LFS requirement: verify the whole-object SHA-256.
        if ((await sha256Hex(bytes)) !== oid) {
          return json({ message: "oid does not match content" }, 422);
        }
        const d = await store.put(streamOf(bytes));
        await resolver.record(oid, d.id);
        return new Response(null, { status: 200 });
      }

      if (request.method === "GET") {
        const mapped = await resolver.toObject(oid);
        if (mapped === undefined || !(await store.has(mapped))) {
          return json({ message: "Object does not exist" }, 404);
        }
        const bytes = await collect(store.read(mapped));
        return new Response(bytes, { status: 200 });
      }
    }

    return json({ message: "Not found" }, 404);
  };
}
