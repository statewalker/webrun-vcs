/**
 * Test-only bridge from a `node:http` server on a loopback port to a Fetch API handler
 * (`createFetchHandler`): the request body and the response body are both streamed.
 *
 * Every request is logged with its method, path, `Git-Protocol` and `Content-Encoding`
 * headers, so tests can tell which protocol a real git client spoke.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";

export interface LoggedRequest {
  method: string;
  /** Path and query */
  url: string;
  gitProtocol: string | undefined;
  contentEncoding: string | undefined;
  status: number;
}

export interface LoopbackHttpServer {
  /** `http://127.0.0.1:<port>` */
  baseUrl: string;
  /** Requests served so far, in order */
  requests: LoggedRequest[];
  close(): Promise<void>;
}

/** Serve `handler` on an ephemeral loopback port. */
export async function serveFetchHandler(
  handler: (request: Request) => Promise<Response>,
): Promise<LoopbackHttpServer> {
  const requests: LoggedRequest[] = [];
  let baseUrl = "";
  const server: Server = createServer((req, res) => {
    void (async () => {
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === "string") headers.set(key, value);
        else if (Array.isArray(value)) for (const v of value) headers.append(key, v);
      }
      const hasBody = req.method !== "GET" && req.method !== "HEAD";
      const request = new Request(`${baseUrl}${req.url}`, {
        method: req.method,
        headers,
        body: hasBody ? (Readable.toWeb(req) as ReadableStream<Uint8Array>) : undefined,
        duplex: hasBody ? "half" : undefined,
      } as RequestInit);
      const response = await handler(request);
      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        gitProtocol: req.headers["git-protocol"] as string | undefined,
        contentEncoding: req.headers["content-encoding"] as string | undefined,
        status: response.status,
      });
      res.statusCode = response.status;
      response.headers.forEach((value, key) => {
        res.setHeader(key, value);
      });
      if (response.body) {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          // wait for the socket to take each chunk: the pack is pulled, not buffered
          if (!res.write(chunk)) await new Promise((resolve) => res.once("drain", resolve));
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
