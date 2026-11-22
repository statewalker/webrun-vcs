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
import type { ProcessConfiguration, UploadPackRequestPolicy } from "../context/process-config.js";
import type { ProcessContext, RefStore } from "../context/process-context.js";
import { ProtocolState } from "../context/protocol-state.js";
import { createTransportApi } from "../factories/transport-api-factory.js";
import { serverFetchHandlers, serverFetchTransitions } from "../fsm/fetch/server-fetch-fsm.js";
import type { UploadPackFilterPolicy } from "../fsm/fetch/upload-pack-filter.js";
import type { UploadPackHooks } from "../fsm/fetch/upload-pack-hooks.js";
import { Fsm } from "../fsm/fsm.js";
import { serverV2Handlers, serverV2Transitions } from "../fsm/protocol-v2/server-v2-fsm.js";
import {
  DEFAULT_RECEIVE_PACK_WRITE_TIMEOUT_MS,
  type ReceiveDenyAction,
  type ReceivePackConfig,
  type ReceivePackHooks,
  type ReceivePackLogger,
} from "../fsm/push/receive-pack-types.js";
import {
  releaseReceivePack,
  serverPushHandlers,
  serverPushTransitions,
} from "../fsm/push/server-push-fsm.js";
import { encodePacketLine } from "../protocol/pkt-line-codec.js";
import type { ServiceType } from "../protocol/types.js";
import { withIdleTimeout, withWriteTimeout } from "../utils/idle-timeout.js";

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
  /**
   * Refuse updating the checked-out branch of a non-bare repository ("branch is currently
   * checked out", git's `receive.denyCurrentBranch`; default true)
   */
  denyCurrentBranch?: boolean | ReceiveDenyAction;
  /** The branch HEAD names (default: `refStore.getSymrefTarget("HEAD")`) */
  currentBranch?: string;
  /**
   * The branches the HEAD of each non-bare worktree uses (git's `find_shared_symref`; see
   * `ReceivePackConfig.checkedOutBranches`). Default: `currentBranch` unless bare.
   */
  checkedOutBranches?: readonly string[];
  /** `denyCurrentBranch: "updateInstead"`: see `ReceivePackConfig.updateWorktree` */
  updateWorktree?: ReceivePackConfig["updateWorktree"];
  /** Whether the repository has no working tree (default: `repository.isBare()`, else true) */
  bare?: boolean;
  /** Refuse deleting the current branch (git's `receive.denyDeleteCurrent`; default true) */
  denyDeleteCurrent?: boolean | ReceiveDenyAction;
  /** Accept shallow pushes (git's `receive.shallowUpdate`; default false) */
  shallowUpdate?: boolean;
  /**
   * receive-pack: an atomic push fails as a whole when any command is refused (default false:
   * as git, a command refused before the ref transaction — missing objects, shallow,
   * `authorize`, `preReceive` — keeps its error and the others still land together)
   */
  strictAtomic?: boolean;
  /** receive-pack hooks: authorize, preReceive, update, postReceive */
  hooks?: ReceivePackHooks;
  /**
   * Run post-receive before the side-band closes, awaited, its messages relayed to the client
   * (git's receive-pack); default: detached once the report is out
   */
  relayPostReceive?: boolean;
  /** receive-pack: a push that is not atomic updates refs in two batches (see `ReceivePackOptions`) */
  batchNonAtomic?: boolean;
  /** receive-pack: each ref of a push that is not atomic updated after its update hook */
  interleaveUpdateHook?: boolean;
  /** receive-pack: objects published before the commands are checked (see `ReceivePackOptions`) */
  publishBeforeUpdate?: boolean;
  /** receive-pack: pre-receive sees the commands refused before it too (see `ReceivePackConfig`) */
  preReceiveSeesRefused?: boolean;
  /** receive-pack: git's `receive.procReceiveRefs` (see `ReceivePackConfig.procReceiveRefs`) */
  procReceiveRefs?: readonly string[];
  /** receive-pack: a setting git cannot read (see `ReceivePackConfig.configError`) */
  receivePackConfigError?: string;
  /** upload-pack hooks: authorize (before the negotiation), postUpload (after the pack) */
  uploadPackHooks?: UploadPackHooks;
  /**
   * Hidden ref patterns of both services (git's `transfer.hideRefs`; see `isRefHidden`):
   * not advertised (nor listed by v2 `ls-refs`), a v2 `want-ref` of one is an unknown ref,
   * and receive-pack refuses changing one ("deny updating a hidden ref"). Not access control,
   * as in git: hidden history stays fetchable by id under the "ANY" (v2's default), "TIP" and
   * reachable request policies, and HEAD naming a hidden branch is still advertised.
   */
  hideRefs?: string[];
  /** Hidden ref patterns of upload-pack, after `hideRefs` (git's `uploadpack.hideRefs`) */
  uploadPackHideRefs?: string[];
  /** Hidden ref patterns of receive-pack, after `hideRefs` (git's `receive.hideRefs`) */
  receivePackHideRefs?: string[];
  /** Most commands in one push (receive-pack; default 65536) */
  maxCommands?: number;
  /** Side-band keep-alive interval while a push is checked (ms; default 5000; 0: none) */
  keepAliveMs?: number;
  /**
   * Fail a read from the client that brings nothing for this long (ms): a stalled push is
   * answered "unpack request idle for … ms". Default: none.
   */
  idleTimeoutMs?: number;
  /**
   * receive-pack: fail a write the client does not take within this long (ms), ending the run: a client that
   * stopped reading cannot hold it (and a push's quarantine) forever. Default
   * {@link DEFAULT_RECEIVE_PACK_WRITE_TIMEOUT_MS}; 0: none.
   */
  writeTimeoutMs?: number;
  /** A receive-pack hook still running after this long (ms) refuses its commands (default: none) */
  hookTimeoutMs?: number;
  /** Logs hook failures that cannot reach the client (default: console.error) */
  logger?: ReceivePackLogger;
  /** Server capabilities to advertise */
  capabilities?: string[];
  /**
   * Which objects upload-pack serves by id (see {@link UploadPackRequestPolicy}); anything else
   * is answered `ERR upload-pack: not our ref <oid>`. Default as git: "ADVERTISED" over
   * protocol v0/v1, "ANY" over v2 (git's v2 serves any object it has). "REACHABLE_COMMIT"
   * refuses, over both versions, objects no branch or tag reaches (git has no such v2
   * setting).
   */
  requestPolicy?: UploadPackRequestPolicy;
  /**
   * Protocol v2: advertise and serve `object-info` (`object-info=size type`, as git with
   * `transfer.advertiseObjectInfo`). Default false, as git: not advertised, and refused.
   */
  advertiseObjectInfo?: boolean;
  /**
   * upload-pack's partial clone filters (git's `uploadpack.allowFilter` and
   * `uploadpackfilter.*`; see `UploadPackFilterPolicy`): with `allowFilter` the default
   * capabilities offer `filter` (v0) and `fetch=... filter` (v2), and each request is checked
   * against the allow-list. Default: none advertised, as git.
   */
  uploadPackFilter?: UploadPackFilterPolicy;
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
  /**
   * Answer a client that asked for protocol v1 (`GIT_PROTOCOL=version=1`): the `version 1`
   * line before the v0 advertisement, as git's upload-pack and receive-pack write it. Ignored
   * when v2 is served.
   */
  announceVersion1?: boolean;
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
  const input = withIdleTimeout(duplex, options.idleTimeoutMs);
  // receive-pack: a client that stops reading the answer must not hold the run (and its
  // quarantine) forever
  const write =
    service === "git-receive-pack"
      ? withWriteTimeout(
          (data) => duplex.write(data),
          options.writeTimeoutMs ?? DEFAULT_RECEIVE_PACK_WRITE_TIMEOUT_MS,
        )
      : undefined;
  const transport = createTransportApi(
    input === duplex && !write
      ? duplex
      : {
          [Symbol.asyncIterator]: () => input[Symbol.asyncIterator](),
          write: write ?? ((data) => duplex.write(data)),
          ...(duplex.close ? { close: () => duplex.close?.() ?? Promise.resolve() } : {}),
        },
    state,
  );

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
    requestPolicy: options.requestPolicy,
    advertiseObjectInfo: options.advertiseObjectInfo,
    ...(options.uploadPackFilter ? { uploadPackFilter: options.uploadPackFilter } : {}),
    hiddenRefs: [
      ...(options.hideRefs ?? []),
      ...((service === "git-receive-pack"
        ? options.receivePackHideRefs
        : options.uploadPackHideRefs) ?? []),
    ],
    uploadPack: { hooks: options.uploadPackHooks, logger: options.logger },
    allowDeletes: options.allowDeletes ?? true,
    allowNonFastForward: options.allowNonFastForward ?? false,
    denyCurrentBranch: options.denyCurrentBranch ?? true,
    currentBranch: options.currentBranch,
    receivePack: {
      hooks: options.hooks,
      maxCommands: options.maxCommands,
      keepAliveMs: options.keepAliveMs,
      hookTimeoutMs: options.hookTimeoutMs,
      bare: options.bare,
      denyDeleteCurrent: options.denyDeleteCurrent,
      checkedOutBranches: options.checkedOutBranches,
      updateWorktree: options.updateWorktree,
      shallowUpdate: options.shallowUpdate,
      strictAtomic: options.strictAtomic,
      logger: options.logger,
      // a pipe's writer blocks until its pack is taken: read a refused pack, store nothing
      drainRefusedPack: true,
      afterReport: (task) => afterReport.push(task),
      ...(options.relayPostReceive ? { relayPostReceive: true } : {}),
      ...(options.batchNonAtomic ? { batchNonAtomic: true } : {}),
      ...(options.interleaveUpdateHook ? { interleaveUpdateHook: true } : {}),
      ...(options.publishBeforeUpdate ? { publishBeforeUpdate: true } : {}),
      ...(options.preReceiveSeesRefused ? { preReceiveSeesRefused: true } : {}),
      ...(options.procReceiveRefs?.length ? { procReceiveRefs: options.procReceiveRefs } : {}),
      ...(options.receivePackConfigError !== undefined
        ? { configError: options.receivePackConfigError }
        : {}),
    },
  };
  // post-receive tasks: started once the report is written (detached from this call)
  const afterReport: Array<() => Promise<void>> = [];

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
    if (options.announceVersion1 && !useV2) {
      await (write ?? ((data: Uint8Array) => duplex.write(data)))(encodePacketLine("version 1\n"));
    }
    const success = await fsm.run(ctx);
    for (const task of afterReport) setTimeout(() => void task(), 0);

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
  } finally {
    // objects of a push that stopped before applying its refs are not left behind
    if (service === "git-receive-pack" && !useV2) await releaseReceivePack(ctx);
  }
}
