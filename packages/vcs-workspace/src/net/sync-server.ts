/**
 * The repository workspaces sync through, served with the transport's own server: smart HTTP
 * (`createFetchHandler`) and duplex streams (`serveOverDuplex`), upload-pack for fetches and
 * receive-pack for pushes. After a push, receive-pack's post-receive hook — detached, once the
 * report is written — tells subscribers which branches moved, so other workspaces can pull.
 */

import {
  createFetchHandler,
  type Duplex,
  type ReceiveCommand,
  type ReceivePackHooks,
  type ReceivePackLogger,
  type RefStore,
  type RepositoryFacade,
  type ServeResult,
  serveOverDuplex,
  type UploadPackHooks,
  type UploadPackRequestPolicy,
} from "@statewalker/vcs-transport";
import type { GitService } from "./sync-remote.js";

const ZERO_OID = "0".repeat(40);

/** A ref a push moved, as post-receive reports it. */
export interface PushNotification {
  /** The full ref name (`refs/heads/main`) */
  ref: string;
  /** Its value before the push (undefined: created) */
  oldOid?: string;
  /** Its value after the push (undefined: deleted) */
  newOid?: string;
}

/** Called after each push with the refs it moved. */
export type PushListener = (updates: PushNotification[]) => void | Promise<void>;

/** Options of {@link createSyncServer}. */
export interface SyncServerOptions {
  /** The served repository (bare: no folder is checked out on the server) */
  repository: RepositoryFacade;
  refStore: RefStore;
  /**
   * More receive-pack hooks (`authorize`, `preReceive`, `update`); a `postReceive` here runs
   * after the subscribers are told
   */
  hooks?: ReceivePackHooks;
  /** Where failures of hooks and listeners go (default: console.error) */
  logger?: ReceivePackLogger;
  /**
   * Which objects a client may fetch by id (default as git: the advertised refs over protocol
   * v0, any object the repository has over v2); "REACHABLE_COMMIT" refuses objects no branch
   * or tag reaches. See the transport's `UploadPackRequestPolicy`.
   */
  requestPolicy?: UploadPackRequestPolicy;
  /** upload-pack hooks: `authorize` (may refuse a fetch), `postUpload` (after the pack) */
  uploadPackHooks?: UploadPackHooks;
  /**
   * Hidden ref patterns (git's `transfer.hideRefs`): not advertised to fetches or pushes, and
   * a push changing one is refused
   */
  hideRefs?: string[];
}

/** A served repository: the HTTP handler, a duplex server, and push notifications. */
export interface SyncServer {
  /** The smart-HTTP handler (any path: one repository) */
  fetch(request: Request): Promise<Response>;
  /** Serves one duplex connection for `service` */
  serve(duplex: Duplex, service: GitService): Promise<ServeResult>;
  /**
   * The receive-pack hooks it serves with, for another handler of the same repository (an
   * httpeers mesh: `meshGitHandler({ ..., receivePack: { hooks: server.hooks } })`)
   */
  readonly hooks: ReceivePackHooks;
  /** Calls `listener` after every push that moved refs; returns the unsubscribe function */
  subscribe(listener: PushListener): () => void;
}

/**
 * Serves `repository` for workspaces to sync through.
 *
 * @example
 * ```ts
 * const server = createSyncServer({ repository, refStore });
 * Bun.serve({ fetch: server.fetch });
 * server.subscribe((updates) => broadcast(updates)); // tell the other clients to sync
 * ```
 */
export function createSyncServer(options: SyncServerOptions): SyncServer {
  const listeners = new Set<PushListener>();
  const logger: ReceivePackLogger = options.logger ?? {
    error: (message, error) => console.error(message, error),
  };
  const extra = options.hooks ?? {};

  const hooks: ReceivePackHooks = {
    ...extra,
    async postReceive(commands: readonly ReceiveCommand[], ctx) {
      const updates = commands.map((c) => ({
        ref: c.refName,
        ...(c.oldOid === ZERO_OID ? {} : { oldOid: c.oldOid }),
        ...(c.newOid === ZERO_OID ? {} : { newOid: c.newOid }),
      }));
      for (const listener of [...listeners]) {
        try {
          await listener(updates);
        } catch (error) {
          logger.error("sync server: a push listener failed", error);
        }
      }
      await extra.postReceive?.(commands, ctx);
    },
  };

  const handler = createFetchHandler({
    resolveRepository: async () => ({
      repository: options.repository,
      refStore: options.refStore,
    }),
    receivePack: { hooks },
    uploadPack: { hooks: options.uploadPackHooks },
    hideRefs: options.hideRefs,
    requestPolicy: options.requestPolicy,
    logger: { info: () => {}, error: (message, error) => logger.error(message, error) },
  });

  return {
    fetch: handler,
    serve: (duplex, service) =>
      serveOverDuplex({
        duplex,
        repository: options.repository,
        refStore: options.refStore,
        service,
        hooks,
        uploadPackHooks: options.uploadPackHooks,
        hideRefs: options.hideRefs,
        logger,
        requestPolicy: options.requestPolicy,
      }),
    hooks,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
