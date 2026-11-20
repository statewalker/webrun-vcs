/**
 * Test-only: a Fetch API handler (ours, or native `git http-backend` through
 * `nativeGitHttpBackend`) served on a loopback port, so a native git client can reach it
 * over real HTTP. Request and response bodies are streamed; connections are kept alive and
 * ended in `close()` (see CLAUDE.md on `connection: close`).
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";

export interface LoopbackServer {
  /** `http://127.0.0.1:<port>` */
  baseUrl: string;
  /** Method, path and status of every request served, in order */
  requests: Array<{ method: string; url: string; status: number }>;
  close(): Promise<void>;
}

function toRequest(req: IncomingMessage, baseUrl: string): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(key, value);
    else if (Array.isArray(value)) for (const v of value) headers.append(key, v);
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(`${baseUrl}${req.url}`, {
    method: req.method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as ReadableStream<Uint8Array>) : undefined,
    duplex: hasBody ? "half" : undefined,
  } as RequestInit);
}

/** Serves `handler` on an ephemeral loopback port. */
export async function serveOnLoopback(
  handler: (request: Request) => Promise<Response>,
): Promise<LoopbackServer> {
  const requests: LoopbackServer["requests"] = [];
  let baseUrl = "";
  const server: Server = createServer((req, res) => {
    void (async () => {
      const response = await handler(toRequest(req, baseUrl));
      requests.push({ method: req.method ?? "", url: req.url ?? "", status: response.status });
      res.statusCode = response.status;
      response.headers.forEach((value, key) => {
        res.setHeader(key, value);
      });
      if (response.body) {
        const reader = response.body.getReader();
        let closed = false;
        const onClose = () => {
          closed = true;
          reader.cancel(new Error("client disconnected")).catch(() => {});
        };
        res.once("close", onClose);
        try {
          while (!closed) {
            const next = await reader.read();
            if (next.done) break;
            if (!res.write(next.value)) {
              await new Promise<void>((resolve) => {
                const done = () => {
                  res.off("drain", done);
                  res.off("close", done);
                  resolve();
                };
                res.once("drain", done);
                res.once("close", done);
              });
            }
          }
        } finally {
          res.off("close", onClose);
        }
      }
      res.end();
    })().catch((error: unknown) => {
      res.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    baseUrl,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
