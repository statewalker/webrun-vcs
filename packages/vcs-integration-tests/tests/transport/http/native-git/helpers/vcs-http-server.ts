/**
 * Node.js HTTP server wrapping our createHttpHandler.
 *
 * Allows native git commands to talk to our VCS transport server
 * over real HTTP connections.
 */

import http from "node:http";
import type { RefStore, RepositoryFacade } from "@statewalker/vcs-transport";
import { createHttpHandler } from "@statewalker/vcs-transport";

export interface VcsHttpServer {
  /** Base URL including port */
  url: string;
  /** Port the server is listening on */
  port: number;
  /** Shut down the server */
  close(): Promise<void>;
}

/**
 * Start a Node.js HTTP server that wraps our createHttpHandler.
 *
 * Native git clients can clone/push/fetch against this server.
 */
export async function startVcsHttpServer(options: {
  resolveRepository: (
    repoPath: string,
  ) => Promise<{ repository: RepositoryFacade; refStore: RefStore } | null>;
}): Promise<VcsHttpServer> {
  const handler = createHttpHandler({
    resolveRepository: options.resolveRepository,
  });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      const query: Record<string, string> = {};
      url.searchParams.forEach((v, k) => {
        query[k] = v;
      });

      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") headers[k] = v;
      }

      // Convert Node readable stream to ReadableStream<Uint8Array>
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          req.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
          req.on("end", () => controller.close());
          req.on("error", (err) => controller.error(err));
        },
      });

      const httpRequest = {
        method: req.method ?? "GET",
        path: url.pathname,
        query,
        headers,
        body,
      };

      const response = await handler(httpRequest);

      res.writeHead(response.status, response.headers);
      res.end(Buffer.from(response.body));
    } catch (err) {
      res.writeHead(500);
      res.end(String(err));
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address() as { port: number };

  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    async close(): Promise<void> {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
