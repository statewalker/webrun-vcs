/**
 * Socket-based Git protocol handler.
 *
 * Handles git-upload-pack and git-receive-pack over socket connections
 * like WebSocket or WebRTC data channels.
 */

import type { Duplex } from "../../api/duplex.js";
import type { RepositoryFacade } from "../../api/repository-facade.js";
import type { RefStore } from "../../context/process-context.js";
import { serveOverDuplex } from "../../operations/serve-over-duplex.js";
import type { ServiceType } from "../../protocol/types.js";

/**
 * External IO handles for socket communication.
 */
export interface ExternalIOHandles {
  /** Read data from the socket */
  read: () => AsyncIterable<Uint8Array>;
  /** Write data to the socket */
  write: (data: Uint8Array) => Promise<void>;
  /** Close the socket */
  close: () => Promise<void>;
}

/**
 * Options for creating a Git socket client.
 */
export interface GitSocketClientOptions {
  /** The IO handles for communication */
  io: ExternalIOHandles;
  /** Optional progress callback */
  onProgress?: (message: string) => void;
}

/**
 * Create a MessagePort reader function.
 *
 * Returns a factory that produces an async iterable reading from the port.
 * Incoming messages are queued and yielded. Handles close signals and
 * ArrayBuffer-to-Uint8Array conversion.
 *
 * @param port - The MessagePort to read from
 * @returns A function that returns an async iterable of Uint8Array chunks
 */
export function createMessagePortReader(port: MessagePort): () => AsyncIterable<Uint8Array> {
  const queue: Uint8Array[] = [];
  let resolveNext: ((chunk: Uint8Array | null) => void) | null = null;
  let closed = false;

  port.addEventListener("message", (event: MessageEvent) => {
    const data = event.data;

    if (data === null || data === "__close__") {
      closed = true;
      if (resolveNext) {
        resolveNext(null);
        resolveNext = null;
      }
      return;
    }

    const chunk =
      data instanceof Uint8Array
        ? data
        : data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(0);

    if (chunk.length === 0) return;

    if (resolveNext) {
      resolveNext(chunk);
      resolveNext = null;
    } else {
      queue.push(chunk);
    }
  });

  port.start();

  return function read(): AsyncIterable<Uint8Array> {
    return {
      [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
        return {
          async next(): Promise<IteratorResult<Uint8Array>> {
            if (queue.length > 0) {
              const item = queue.shift();
              if (item) return { done: false, value: item };
            }
            if (closed) {
              return { done: true, value: undefined };
            }
            const chunk = await new Promise<Uint8Array | null>((resolve) => {
              resolveNext = resolve;
            });
            if (chunk === null || closed) {
              return { done: true, value: undefined };
            }
            return { done: false, value: chunk };
          },
        };
      },
    };
  };
}

/**
 * Create a MessagePort writer function.
 *
 * @param port - The MessagePort to write to
 * @returns A function that writes Uint8Array data to the port
 */
export function createMessagePortWriter(port: MessagePort): (data: Uint8Array) => Promise<void> {
  return async (data: Uint8Array): Promise<void> => {
    port.postMessage(data);
  };
}

/**
 * Create a MessagePort closer function.
 *
 * Sends a close signal to the remote end and closes the port.
 *
 * @param port - The MessagePort to close
 * @returns A function that closes the port
 */
export function createMessagePortCloser(port: MessagePort): () => Promise<void> {
  let closed = false;
  return async (): Promise<void> => {
    if (!closed) {
      closed = true;
      port.postMessage("__close__");
      port.close();
    }
  };
}

/**
 * Create a Git socket client for performing fetch/push operations.
 *
 * Wraps ExternalIOHandles into a Duplex interface suitable for use
 * with fetchOverDuplex or pushOverDuplex.
 *
 * @param options - Client options including IO handles
 * @returns A Duplex interface for Git operations
 *
 * @example
 * ```ts
 * const reader = createMessagePortReader(port);
 * const writer = createMessagePortWriter(port);
 * const closer = createMessagePortCloser(port);
 *
 * const duplex = createGitSocketClient({
 *   io: { read: reader, write: writer, close: closer },
 * });
 *
 * const result = await fetchOverDuplex({ duplex, repository, refStore });
 * ```
 */
export function createGitSocketClient(options: GitSocketClientOptions): Duplex {
  const { io } = options;
  let closed = false;

  return {
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      return io.read()[Symbol.asyncIterator]();
    },

    write(data: Uint8Array): void {
      if (!closed) {
        io.write(data);
      }
    },

    async close(): Promise<void> {
      if (!closed) {
        closed = true;
        await io.close();
      }
    },
  };
}

/**
 * Options for handling a git socket connection.
 */
export interface HandleGitSocketOptions {
  /** Repository facade for pack import/export */
  repository: RepositoryFacade;
  /** Ref store for reading/writing refs */
  refStore: RefStore;
  /** Service type (auto-detect from stream if not specified) */
  service?: ServiceType;
  /** Allow ref deletions (receive-pack only) */
  allowDeletes?: boolean;
  /** Allow non-fast-forward updates (receive-pack only) */
  allowNonFastForward?: boolean;
  /** Optional progress callback */
  onProgress?: (message: string) => void;
}

/**
 * Handle a git protocol connection over a socket.
 *
 * Serves Git requests (fetch/push) over a bidirectional stream.
 * Delegates to serveOverDuplex with the appropriate service type.
 *
 * @param duplex - The bidirectional stream for communication
 * @param options - Handler options including repository and refStore
 *
 * @example
 * ```ts
 * const duplex = createMessagePortDuplex(port);
 * await handleGitSocketConnection(duplex, {
 *   repository: myRepo,
 *   refStore: myRefStore,
 *   service: "git-upload-pack",
 * });
 * ```
 */
export async function handleGitSocketConnection(
  duplex: Duplex,
  options: HandleGitSocketOptions,
): Promise<void> {
  const result = await serveOverDuplex({
    duplex,
    repository: options.repository,
    refStore: options.refStore,
    service: options.service,
    allowDeletes: options.allowDeletes,
    allowNonFastForward: options.allowNonFastForward,
  });

  if (!result.success) {
    throw new Error(result.error ?? "Socket connection handler failed");
  }
}
