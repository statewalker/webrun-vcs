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
import { namespacedRefStore } from "../context/namespaced-ref-store.js";
import type { ProcessConfiguration, UploadPackRequestPolicy } from "../context/process-config.js";
import type { ProcessContext, RefStore } from "../context/process-context.js";
import { ProtocolState } from "../context/protocol-state.js";
import { createTransportApi } from "../factories/transport-api-factory.js";
import type { PackObjectsHook } from "../fsm/fetch/pack-objects-hook.js";
import { serverFetchHandlers, serverFetchTransitions } from "../fsm/fetch/server-fetch-fsm.js";
import type { UploadPackFilterPolicy } from "../fsm/fetch/upload-pack-filter.js";
import type { UploadPackHooks } from "../fsm/fetch/upload-pack-hooks.js";
import { Fsm } from "../fsm/fsm.js";
import { serverV2Handlers, serverV2Transitions } from "../fsm/protocol-v2/server-v2-fsm.js";
import {
  DEFAULT_RECEIVE_PACK_WRITE_TIMEOUT_MS,
  type PushCertSettings,
  pushCertificatesOf,
  type ReceiveDenyAction,
  type ReceivePackConfig,
  type ReceivePackHooks,
  type ReceivePackLogger,
} from "../fsm/push/receive-pack-types.js";
import {
  receivePackCapabilitiesOf,
  releaseReceivePack,
  serverPushHandlers,
  serverPushTransitions,
} from "../fsm/push/server-push-fsm.js";
import { encodePacketLine } from "../protocol/pkt-line-codec.js";
import { gitNamespacePrefix } from "../protocol/ref-namespace.js";
import { processSessionId, validSessionId } from "../protocol/session-id.js";
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
  /**
   * receive-pack: git's `receive.advertisePushOptions`; false leaves `push-options` out of
   * the advertised capabilities (a client sending options anyway has them ignored). Default:
   * advertised (git's default is false: a served repository's config gives it, see
   * `GIT_SERVER_SETTINGS_DEFAULTS`)
   */
  advertisePushOptions?: boolean;
  /**
   * receive-pack: git's `receive.advertiseAtomic` (default true); false leaves `atomic` out of
   * the advertised capabilities, and a client asking for it anyway pushes without it
   */
  advertiseAtomic?: boolean;
  /** receive-pack: git's `receive.maxInputSize` (see `ReceivePackConfig.maxInputSize`) */
  maxInputSize?: number;
  /**
   * receive-pack: git's `receive.certNonceSeed` (advertise `push-cert=<nonce>`; see
   * `PushCertSettings.nonceSeed`)
   */
  certNonceSeed?: string;
  /** receive-pack: git's `receive.certNonceSlop` in seconds */
  certNonceSlop?: number;
  /**
   * receive-pack: the rest of the push certificate settings (the signature check, the nonce's
   * directory and clock); `certNonceSeed`/`certNonceSlop` win over theirs
   */
  pushCertificates?: PushCertSettings;
  /**
   * receive-pack: git's `receive.keepAlive` in ms (0: none), over {@link keepAliveMs} for a push
   */
  receiveKeepAliveMs?: number;
  /** receive-pack: `receive.unpackLimit` (see `ReceivePackConfig.unpackLimit`) */
  unpackLimit?: number;
  /** receive-pack: what runs once a push is done (see `ReceivePackConfig.afterPush`) */
  afterPush?: ReceivePackConfig["afterPush"];
  /** receive-pack: `receive.fsckObjects` (see `ReceivePackConfig.fsckObjects`) */
  fsckObjects?: ReceivePackConfig["fsckObjects"];
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
  /**
   * The ref namespace to serve (git's `GIT_NAMESPACE` / `git --namespace`, gitnamespaces(7)):
   * the client sees and writes only `refs/namespaces/<ns>/...` (nested for `a/b`), named
   * without that prefix, and `HEAD` is `refs/namespaces/<ns>/HEAD` (`namespacedRefStore`).
   * Non-`^` hidden ref patterns match the stripped names, `^` ones the full names. A value
   * git refuses (`bad git namespace path`) fails the request before anything is written.
   */
  namespace?: string;
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
   * upload-pack over protocol v0/v1: which objects a client may want by id, as git's
   * `uploadpack.allowTipSHA1InWant` / `allowReachableSHA1InWant` / `allowAnySHA1InWant` set it
   * (`uploadPackRequestPolicyOf`; advertised as `allow-tip-sha1-in-want` and
   * `allow-reachable-sha1-in-want`). Ignored over v2, which serves any object as git does, and
   * when `requestPolicy` is given. Default "ADVERTISED"
   */
  uploadPackRequestPolicy?: UploadPackRequestPolicy;
  /**
   * Protocol v2: advertise `fetch=... ref-in-want` and take `want-ref` lines (git's
   * `uploadpack.allowRefInWant`). Default false, as git: a `want-ref` line ends the
   * connection as an unexpected line
   */
  allowRefInWant?: boolean;
  /**
   * Protocol v2: advertise `fetch=... sideband-all` and take a `sideband-all` argument (git's
   * `uploadpack.allowSidebandAll`). Default false, as git: the argument ends the connection as
   * an unexpected line
   */
  allowSidebandAll?: boolean;
  /**
   * Protocol v2 upload-pack acknowledges every have it holds, repeats and parents of an
   * earlier have included, as git before 2.45 (`process_haves`' `common`). Default false:
   * git 2.45+ acknowledges a have only when no child of it (and no copy) came first in the
   * request (`do_got_oid`'s `THEY_HAVE`, `send_acks` over `have_obj`)
   */
  acknowledgeEveryHave?: boolean;
  /** Protocol v2 `packfile-uris` (git's `uploadpack.blobPackfileUri` values) */
  blobPackfileUris?: readonly string[];
  /**
   * Protocol v2: git's `uploadpack.advertiseBundleURIs`: `bundle-uri` advertised and answered
   * with these lines, the served repository's `bundle.*` settings as `<key>=<value>` in config
   * order (`bundle_uri_command`). Undefined: not advertised, and the command refused
   */
  bundleUris?: readonly string[];
  /**
   * git's `transfer.advertiseSID`: upload-pack and receive-pack advertise `session-id=<id>`
   * (v0 capability, v2 capability line), the id {@link sessionId} names; the client's own
   * session id comes back as `ServeResult.clientSessionId`. Default false
   */
  advertiseSID?: boolean;
  /** The session id {@link advertiseSID} advertises (default: one per process, `processSessionId()`) */
  sessionId?: string;
  /**
   * Protocol v2: the `promisor-remote` capability's value (git's `promisor.advertise`,
   * `promisorRemoteAdvertisement`); the remotes the client accepts come back in
   * `ServeResult.acceptedPromisorRemotes`
   */
  promisorRemoteInfo?: string;
  /**
   * upload-pack: git's `uploadpack.packObjectsHook`, run by the host (see `PackObjectsHook`):
   * the pack comes from its stdout. git reads the setting only from protected configuration,
   * so a served repository's config never sets it (`serverSettingsFromConfig` does not read it)
   */
  packObjectsHook?: PackObjectsHook;
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
  const { duplex, repository, service = "git-upload-pack" } = options;
  // GIT_NAMESPACE: the namespace's view of the refs (git dies on a bad value, at once)
  let namespace: string;
  try {
    namespace = gitNamespacePrefix(options.namespace);
  } catch (error) {
    return { success: false, error: `fatal: ${(error as Error).message}` };
  }
  const refStore = namespace ? namespacedRefStore(options.refStore, namespace) : options.refStore;
  // receive-pack's head_name is the repository's own HEAD, whatever the namespace
  const namespaceHead =
    namespace && options.currentBranch === undefined
      ? await options.refStore.getSymrefTarget?.("HEAD")
      : undefined;

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
    serverCapabilities:
      service === "git-receive-pack"
        ? receivePackCapabilitiesOf(options.capabilities, options)
        : options.capabilities,
    requestPolicy:
      options.requestPolicy ??
      (useV2 || service === "git-receive-pack" ? undefined : options.uploadPackRequestPolicy),
    ...(options.allowRefInWant ? { allowRefInWant: true } : {}),
    ...(options.allowSidebandAll ? { allowSidebandAll: true } : {}),
    ...(options.acknowledgeEveryHave ? { acknowledgeEveryHave: true } : {}),
    ...(options.blobPackfileUris?.length ? { blobPackfileUris: options.blobPackfileUris } : {}),
    ...(options.bundleUris !== undefined && service !== "git-receive-pack"
      ? { bundleUris: options.bundleUris }
      : {}),
    ...(options.advertiseSID
      ? { sessionId: validSessionId(options.sessionId) ?? processSessionId() }
      : {}),
    ...(options.promisorRemoteInfo !== undefined && useV2 && service === "git-upload-pack"
      ? { promisorRemote: options.promisorRemoteInfo }
      : {}),
    advertiseObjectInfo: options.advertiseObjectInfo,
    ...(options.uploadPackFilter ? { uploadPackFilter: options.uploadPackFilter } : {}),
    ...(namespace ? { namespace } : {}),
    ...(namespaceHead !== undefined ? { namespaceHead } : {}),
    hiddenRefs: [
      ...(options.hideRefs ?? []),
      ...((service === "git-receive-pack"
        ? options.receivePackHideRefs
        : options.uploadPackHideRefs) ?? []),
    ],
    uploadPack: {
      hooks: options.uploadPackHooks,
      logger: options.logger,
      ...(options.packObjectsHook ? { packObjectsHook: options.packObjectsHook } : {}),
    },
    allowDeletes: options.allowDeletes ?? true,
    allowNonFastForward: options.allowNonFastForward ?? false,
    denyCurrentBranch: options.denyCurrentBranch ?? true,
    currentBranch: options.currentBranch,
    receivePack: {
      hooks: options.hooks,
      maxCommands: options.maxCommands,
      keepAliveMs: options.receiveKeepAliveMs ?? options.keepAliveMs,
      ...(options.maxInputSize ? { maxInputSize: options.maxInputSize } : {}),
      ...pushCertificatesOf(options),
      ...(options.unpackLimit !== undefined ? { unpackLimit: options.unpackLimit } : {}),
      ...(options.afterPush ? { afterPush: options.afterPush } : {}),
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
      ...(options.fsckObjects ? { fsckObjects: options.fsckObjects } : {}),
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
    const clientSid = {
      ...(ctx.output.clientSessionId !== undefined
        ? { clientSessionId: ctx.output.clientSessionId }
        : {}),
      ...(ctx.output.acceptedPromisorRemotes !== undefined
        ? { acceptedPromisorRemotes: ctx.output.acceptedPromisorRemotes }
        : {}),
    };
    for (const task of afterReport) setTimeout(() => void task(), 0);

    if (!success || ctx.output.error) {
      return {
        success: false,
        error: ctx.output.error ?? "FSM did not complete successfully",
        ...clientSid,
      };
    }

    return {
      success: true,
      objectsSent: ctx.output.objectCount,
      ...clientSid,
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
