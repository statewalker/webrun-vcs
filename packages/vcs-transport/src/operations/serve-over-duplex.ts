/**
 * High-level server operation over any Duplex stream.
 *
 * Serves Git requests (fetch/push) over any bidirectional stream.
 * Detects the service type from the incoming request and runs
 * the appropriate FSM.
 */

import type { Duplex } from "../api/duplex.js";
import type { ServeResult } from "../api/fetch-result.js";
import type { RepositoryFacade } from "../api/repository-facade.js";
import { HandlerOutput } from "../context/handler-output.js";
import type { ProcessConfiguration } from "../context/process-config.js";
import type { ProcessContext, RefStore } from "../context/process-context.js";
import { ProtocolState } from "../context/protocol-state.js";
import { createTransportApi } from "../factories/transport-api-factory.js";
import { serverFetchHandlers, serverFetchTransitions } from "../fsm/fetch/server-fetch-fsm.js";
import { Fsm } from "../fsm/fsm.js";
import { serverV2Handlers, serverV2Transitions } from "../fsm/protocol-v2/server-v2-fsm.js";
import { serverPushHandlers, serverPushTransitions } from "../fsm/push/server-push-fsm.js";
import type { ServiceType } from "../protocol/types.js";

/**
 * Options for serve-over-duplex operation.
 */
export interface ServeOverDuplexOptions {
  /** Bidirectional stream to serve requests on */
  duplex: Duplex;
  /** Repository facade for pack import/export */
  repository: RepositoryFacade;
  /** Ref store for reading/writing refs */
  refStore: RefStore;
  /** Service type to serve (auto-detect if not specified) */
  service?: ServiceType;
  /** Allow ref deletions (receive-pack only) */
  allowDeletes?: boolean;
  /** Allow non-fast-forward updates (receive-pack only) */
  allowNonFastForward?: boolean;
  /** Deny updates to the currently checked-out branch */
  denyCurrentBranch?: boolean;
  /** Currently checked-out branch (for denyCurrentBranch) */
  currentBranch?: string;
  /** Server capabilities to advertise */
  capabilities?: string[];
  /**
   * Git wire protocol version to serve. Version negotiation is out-of-band in
   * git (the `GIT_PROTOCOL` env / `Git-Protocol: version=2` header), never in
   * the pkt-line stream — so the version is handed to the server as an option.
   *
   * `"2"` runs the protocol-v2 server FSM, but ONLY for the fetch service
   * (upload-pack); v2 is fetch-only, so receive-pack/push always stays on v1.
   * Defaults to `"1"`, which keeps the v1 path byte-for-byte unchanged.
   */
  protocolVersion?: "1" | "2";
}

/**
 * Serves Git requests over a Duplex stream.
 *
 * This is the transport-agnostic server operation that works with any
 * bidirectional stream (MessagePort, WebSocket, WebRTC, HTTP, etc.).
 *
 * @param options - Serve options including duplex, repository, and refStore
 * @returns Serve result with success status
 *
 * @example
 * ```ts
 * // Using with MessagePort
 * const channel = new MessageChannel();
 * const duplex = createMessagePortDuplex(channel.port2);
 *
 * const result = await serveOverDuplex({
 *   duplex,
 *   repository: serverRepo,
 *   refStore: serverRefStore,
 *   service: "git-upload-pack",
 * });
 *
 * if (result.success) {
 *   console.log("Served request successfully");
 * }
 * ```
 */
export async function serveOverDuplex(options: ServeOverDuplexOptions): Promise<ServeResult> {
  const { duplex, repository, refStore, service = "git-upload-pack" } = options;

  // v2 is fetch-only: run it only when explicitly requested AND the service is
  // upload-pack. receive-pack/push always falls through to the v1 push FSM.
  const useV2 = options.protocolVersion === "2" && service !== "git-receive-pack";

  const state = new ProtocolState();
  const transport = createTransportApi(duplex, state);

  // Protocol-v2's packfile section is ALWAYS side-band-64k multiplexed
  // (protocol-v2.txt), even though the v2 capability advertisement never lists
  // "side-band-64k". `TransportApi.writePack()` selects its sideband path off
  // this capability, so seed it before the FSM writes the pack — mirroring the
  // v2 client's identical seed in fetch-v2-over-duplex.ts, which is what makes
  // the client's sideband demux (`readPack`) match the server's framing.
  if (useV2) {
    state.capabilities.add("side-band-64k");
  }

  const config: ProcessConfiguration = {
    localHead: options.currentBranch ?? "refs/heads/main",
    maxHaves: 256,
    serverCapabilities: options.capabilities,
    allowDeletes: options.allowDeletes ?? true,
    allowNonFastForward: options.allowNonFastForward ?? false,
    denyCurrentBranch: options.denyCurrentBranch ?? true,
    currentBranch: options.currentBranch,
  };

  const output = new HandlerOutput();

  const ctx: ProcessContext = {
    transport,
    repository,
    refStore,
    state,
    output,
    config,
  };

  // Select FSM: v2 fetch, else v1 push (receive-pack) or v1 fetch (upload-pack).
  const fsm = useV2
    ? new Fsm(serverV2Transitions, serverV2Handlers)
    : service === "git-receive-pack"
      ? new Fsm(serverPushTransitions, serverPushHandlers)
      : new Fsm(serverFetchTransitions, serverFetchHandlers);

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
