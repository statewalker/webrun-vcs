/**
 * Hono-based Git HTTP server using VCS transport API.
 *
 * Implements the Git smart HTTP protocol using the transport package's
 * createFetchHandler, providing a cleaner implementation than the
 * manual protocol handling.
 *
 * Handles:
 * - GET /repo.git/info/refs?service=git-upload-pack (fetch/clone refs)
 * - POST /repo.git/git-upload-pack (send pack data to client)
 * - GET /repo.git/info/refs?service=git-receive-pack (push refs)
 * - POST /repo.git/git-receive-pack (receive pack data from client)
 */

import { type ServerType, serve } from "@hono/node-server";
import { DefaultSerializationApi, type History, isSymbolicRef } from "@statewalker/vcs-core";
import { createFetchHandler, type RefStore as TransportRefStore } from "@statewalker/vcs-transport";
import { createVcsRepositoryFacade } from "@statewalker/vcs-transport-adapters";
import { Hono } from "hono";

import type { FileHistory } from "./file-history.js";

export interface HonoHttpServerOptions {
  /** Port to listen on */
  port: number;
  /** Storage getter - returns the FileHistory for a given repository path */
  getStorage: (repoPath: string) => Promise<FileHistory | null>;
  /** Optional logger */
  logger?: {
    info: (msg: string) => void;
    error: (msg: string, err?: unknown) => void;
  };
}

/**
 * Create a transport RefStore adapter from History refs.
 *
 * Adapts the core History refs interface to the transport RefStore interface.
 */
function createRefStoreAdapter(history: History): TransportRefStore {
  const refs = history.refs;

  return {
    async get(name: string): Promise<string | undefined> {
      const ref = await refs.resolve(name);
      return ref?.objectId;
    },

    async update(name: string, oid: string): Promise<void> {
      const ZERO_OID = "0".repeat(40);
      if (oid === ZERO_OID) {
        await refs.remove(name);
      } else {
        await refs.set(name, oid);
      }
    },

    async listAll(): Promise<Iterable<[string, string]>> {
      const result: Array<[string, string]> = [];
      for await (const ref of refs.list()) {
        if (!isSymbolicRef(ref) && ref.objectId) {
          result.push([ref.name, ref.objectId]);
        }
      }
      return result;
    },

    async getSymrefTarget(name: string): Promise<string | undefined> {
      const ref = await refs.get(name);
      if (ref && isSymbolicRef(ref)) {
        return ref.target;
      }
      return undefined;
    },

    async isRefTip(oid: string): Promise<boolean> {
      for await (const ref of refs.list()) {
        if (!isSymbolicRef(ref) && ref.objectId === oid) {
          return true;
        }
      }
      return false;
    },
  };
}

/**
 * A Git HTTP server using Hono and VCS transport API.
 */
export class HonoHttpServer {
  private server: ServerType | null = null;
  private port: number;
  private getStorage: (repoPath: string) => Promise<FileHistory | null>;
  private logger?: {
    info: (msg: string) => void;
    error: (msg: string, err?: unknown) => void;
  };

  constructor(options: HonoHttpServerOptions) {
    this.port = options.port;
    this.getStorage = options.getStorage;
    this.logger = options.logger;
  }

  /**
   * Start the HTTP server.
   */
  async start(): Promise<void> {
    const app = new Hono();

    // Create the Git handler using transport's createFetchHandler
    const gitHandler = createFetchHandler({
      resolveRepository: async (repoPath: string) => {
        // Remove leading slash and normalize path
        const normalizedPath = repoPath.replace(/^\//, "");

        const history = await this.getStorage(normalizedPath);
        if (!history) {
          this.logger?.info(`Repository not found: ${normalizedPath}`);
          return null;
        }

        // Create serialization API from history
        const serialization = new DefaultSerializationApi({ history });

        // Create repository facade
        const repository = createVcsRepositoryFacade({
          history,
          serialization,
        });

        // Create ref store adapter
        const refStore = createRefStoreAdapter(history);

        this.logger?.info(`Resolved repository: ${normalizedPath}`);
        return { repository, refStore };
      },
      logger: this.logger,
    });

    // Route all git requests
    app.all("/*", async (c) => {
      return gitHandler(c.req.raw);
    });

    return new Promise((resolve) => {
      this.server = serve(
        {
          fetch: app.fetch,
          port: this.port,
        },
        () => {
          resolve();
        },
      );
    });
  }

  /**
   * Stop the HTTP server.
   */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.server = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}

/**
 * Create and start a Hono-based VCS HTTP server.
 */
export async function createHonoHttpServer(
  options: HonoHttpServerOptions,
): Promise<HonoHttpServer> {
  const server = new HonoHttpServer(options);
  await server.start();
  return server;
}

export type { HonoHttpServerOptions as VcsHttpServerOptions };
// Re-export the old interface names for backwards compatibility
export { createHonoHttpServer as createVcsHttpServer, HonoHttpServer as VcsHttpServer };
