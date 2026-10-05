/**
 * MessagePort-based fetch server.
 *
 * Serves Git fetch requests over a MessagePort channel.
 * Handles client requests from messagePortFetch on the other end.
 */

import type { ServeResult } from "../../api/fetch-result.js";
import type { RepositoryFacade } from "../../api/repository-facade.js";
import { HandlerOutput } from "../../context/handler-output.js";
import type { ProcessConfiguration } from "../../context/process-config.js";
import type { ProcessContext, RefStore } from "../../context/process-context.js";
import { ProtocolState } from "../../context/protocol-state.js";
import { createTransportApi } from "../../factories/transport-api-factory.js";
import { serverFetchHandlers, serverFetchTransitions } from "../../fsm/fetch/server-fetch-fsm.js";
import { Fsm } from "../../fsm/fsm.js";
import { createMessagePortDuplex } from "./messageport-duplex.js";

/**
 * Options for MessagePort serve operation.
 */
export interface MessagePortServeOptions {
  /** Request policy for validating client wants */
  requestPolicy?: "ADVERTISED" | "REACHABLE_COMMIT" | "TIP" | "REACHABLE_COMMIT_TIP" | "ANY";
  /** Maximum empty negotiation batches before error */
  maxEmptyBatches?: number;
}

/**
 * Serves a Git fetch request over a MessagePort.
 *
 * Waits for a client connection and processes the fetch request.
 * Typically run in a Web Worker or on one side of a MessageChannel.
 *
 * @param port - MessagePort to listen on
 * @param repository - Repository facade for pack import/export
 * @param refStore - Ref store for reading refs
 * @param options - Server options
 * @returns Serve result
 *
 * @example
 * ```ts
 * // In a Web Worker
 * self.onmessage = async (event) => {
 *   if (event.data.type === "init") {
 *     const port = event.data.port;
 *     const result = await messagePortServe(
 *       port,
 *       repository,
 *       refStore,
 *       { requestPolicy: "ADVERTISED" }
 *     );
 *     self.postMessage({ type: "done", result });
 *   }
 * };
 * ```
 */
export async function messagePortServe(
  port: MessagePort,
  repository: RepositoryFacade,
  refStore: RefStore,
  options: MessagePortServeOptions = {},
): Promise<ServeResult> {
  const state = new ProtocolState();
  const duplex = createMessagePortDuplex(port);
  const transport = createTransportApi(duplex, state);

  // Populate refs from refStore for advertisement
  const allRefs = await refStore.listAll();
  for (const [refName, oid] of allRefs) {
    state.refs.set(refName, oid);
  }

  const config: ProcessConfiguration = {
    requestPolicy: options.requestPolicy ?? "ADVERTISED",
    maxEmptyBatches: options.maxEmptyBatches ?? 10,
  };

  const ctx: ProcessContext = {
    transport,
    repository,
    refStore,
    state,
    output: new HandlerOutput(),
    config,
  };

  const fsm = new Fsm(serverFetchTransitions, serverFetchHandlers);

  try {
    const success = await fsm.run(ctx);

    if (!success || ctx.output.error) {
      return {
        success: false,
        error: ctx.output.error ?? "FSM did not complete successfully",
      };
    }

    return {
      success: true,
      objectsSent: ctx.output.objectCount,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
