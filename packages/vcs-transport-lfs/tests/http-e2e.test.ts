import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lfsDownload, lfsUpload, serveLfs } from "../src/index.js";
import { collect, drain, makeStore, memResolver, prng, seedObject } from "./helpers.js";

/**
 * End to end over real HTTP: `serveLfs` behind a Node `http` server, the client
 * on the runtime's own `fetch` (undici). Checks that a streamed upload body with
 * its `content-length` and a streamed download both survive a real socket.
 */
describe("lfs over a real HTTP server", () => {
  const serverStore = makeStore();
  const serverResolver = memResolver();
  const handler = serveLfs(serverStore, serverResolver);
  const seen: { method: string; contentLength?: string; chunked: boolean }[] = [];
  let server: Server;
  let url = "";

  async function bridge(req: IncomingMessage, res: ServerResponse) {
    seen.push({
      method: req.method ?? "",
      contentLength: req.headers["content-length"],
      chunked: req.headers["transfer-encoding"] === "chunked",
    });
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const request = new Request(`${url}${req.url}`, {
      method: req.method,
      headers: req.headers as Record<string, string>,
      body: hasBody ? (Readable.toWeb(req) as ReadableStream<Uint8Array>) : undefined,
      duplex: "half",
    } as RequestInit);
    const response = await handler(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        res.write(chunk);
      }
    }
    res.end();
  }

  beforeAll(async () => {
    server = createServer((req, res) => {
      bridge(req, res).catch((error) => {
        res.statusCode = 500;
        res.end(String(error));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("uploads with a streamed body and content-length, then downloads and verifies", async () => {
    const bytes = prng(3 * 1024 * 1024 + 5, 31);
    const clientStore = makeStore();
    const clientResolver = memResolver();
    const ptr = await seedObject(clientStore, clientResolver, bytes);

    const up = await drain(
      lfsUpload(clientStore, clientResolver, url, [ptr], undefined, {
        streamRequestBody: true,
      }),
    );
    expect(up).toContainEqual({ type: "object-uploaded", oid: ptr.oid });
    const put = seen.find((s) => s.method === "PUT");
    expect(put?.contentLength).toBe(String(bytes.length));
    expect(put?.chunked).toBe(false);

    const fresh = makeStore();
    const freshResolver = memResolver();
    const down = await drain(lfsDownload(fresh, freshResolver, url, [ptr]));
    expect(down).toContainEqual({ type: "object-downloaded", oid: ptr.oid });
    const id = (await freshResolver.toObject(ptr.oid)) as string;
    const got = await collect(fresh.read(id));
    expect(got.length).toBe(bytes.length);
    expect(Buffer.compare(got, bytes)).toBe(0);
  });

  it("a wrong size in the batch response errors that object only; the others upload", async () => {
    const clientStore = makeStore();
    const clientResolver = memResolver();
    const a = await seedObject(clientStore, clientResolver, prng(70_000, 32));
    const b = await seedObject(clientStore, clientResolver, prng(80_000, 33));
    // A host whose batch response misreports the first object's size.
    const lying = async (request: Request): Promise<Response> => {
      const res = await fetch(request);
      if (!request.url.endsWith("/objects/batch")) return res;
      const body = (await res.json()) as { objects: { oid: string; size: number }[] };
      for (const o of body.objects) if (o.oid === a.oid) o.size += 1000;
      return Response.json(body);
    };
    const up = await drain(
      lfsUpload(clientStore, clientResolver, url, [a, b], lying, { streamRequestBody: true }),
    );
    expect(up.find((e) => e.type === "error")).toMatchObject({ oid: a.oid });
    expect(up).toContainEqual({ type: "object-uploaded", oid: b.oid });
    expect(await serverResolver.toObject(b.oid)).toBeDefined();
    expect(await serverResolver.toObject(a.oid)).toBeUndefined();
  });
});
