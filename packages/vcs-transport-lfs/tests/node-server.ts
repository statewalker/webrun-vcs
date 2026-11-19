/**
 * Test helper: serves a fetch handler on a loopback `node:http` server, with
 * request and response bodies streamed both ways (no keep-alive, so closing is
 * prompt).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** node:http's request body as a web stream that tolerates an early cancel. */
function requestBody(req: IncomingMessage): ReadableStream<Uint8Array> {
  let done = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      req.on("data", (chunk: Buffer) => {
        if (done) return;
        controller.enqueue(new Uint8Array(chunk));
        if ((controller.desiredSize ?? 1) <= 0) req.pause();
      });
      req.on("end", () => {
        if (!done) {
          done = true;
          controller.close();
        }
      });
      req.on("error", (error) => {
        if (!done) {
          done = true;
          controller.error(error);
        }
      });
    },
    pull() {
      req.resume();
    },
    cancel() {
      done = true;
      req.resume();
    },
  });
}

/** Starts `handler` on 127.0.0.1; returns its origin and a `close`. */
export async function serveOnLoopback(
  handler: (request: Request) => Response | Promise<Response>,
): Promise<{ origin: string; close(): Promise<void> }> {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const hasBody = req.method !== "GET" && req.method !== "HEAD";
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") headers.set(k, v);
        else if (Array.isArray(v)) for (const item of v) headers.append(k, item);
      }
      const port = (server.address() as AddressInfo).port;
      const response = await handler(
        new Request(`http://127.0.0.1:${port}${req.url}`, {
          method: req.method,
          headers,
          body: hasBody ? requestBody(req) : undefined,
          duplex: "half",
        } as RequestInit),
      );
      // no `connection: close`: undici 6 (Node 22) asserts in Parser.finish when the socket
      // ends while the body consumer has paused it on the final chunk; `close` below ends
      // every connection instead
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) {
        const reader = response.body.getReader();
        res.on("close", () => void reader.cancel().catch(() => {}));
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!res.write(value)) await new Promise((r) => res.once("drain", r));
        }
      }
      res.end();
    } catch (error) {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(error));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
