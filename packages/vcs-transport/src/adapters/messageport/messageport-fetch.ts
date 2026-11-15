/**
 * MessagePort-based fetch client.
 *
 * Runs a Git fetch operation over a MessagePort channel.
 * Connects to a server running messagePortServe on the other end.
 */

import type { FetchResult } from "../../api/fetch-result.js";
import type { RepositoryFacade } from "../../api/repository-facade.js";
import type { RefStore } from "../../context/process-context.js";
import type { FetchClientOptions } from "../../fetch-client/index.js";
import { fetchOverDuplex } from "../../operations/fetch-over-duplex.js";
import { createMessagePortDuplex } from "./messageport-duplex.js";

/**
 * Options for MessagePort fetch operation: what to fetch (refspecs, depth, tags, …).
 */
export type MessagePortFetchOptions = Omit<FetchClientOptions, "repository" | "refStore">;

/**
 * Performs a Git fetch over a MessagePort (see `fetchOverDuplex`).
 *
 * The MessagePort should be connected to a server running
 * messagePortServe() on the other end.
 *
 * @param port - MessagePort connected to the server
 * @param repository - Repository facade for pack import/export
 * @param refStore - Ref store for reading/writing refs
 * @param options - Fetch options
 * @returns Fetch result
 *
 * @example
 * ```ts
 * const channel = new MessageChannel();
 * messagePortServe(channel.port2, serverRepo, serverRefs);
 * const result = await messagePortFetch(channel.port1, clientRepo, clientRefs, {
 *   refspecs: ["+refs/heads/*:refs/remotes/origin/*"],
 * });
 * if (result.success) console.log("Fetched successfully");
 * ```
 */
export async function messagePortFetch(
  port: MessagePort,
  repository: RepositoryFacade,
  refStore: RefStore,
  options: MessagePortFetchOptions = {},
): Promise<FetchResult> {
  return fetchOverDuplex({
    ...options,
    duplex: createMessagePortDuplex(port),
    repository,
    refStore,
  });
}
