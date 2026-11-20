import type { UploadPackConfig } from "../fsm/fetch/upload-pack-hooks.js";
import type { ReceiveDenyAction, ReceivePackConfig } from "../fsm/push/receive-pack-types.js";

/**
 * Which objects upload-pack serves when a client asks for them by id (`want <oid>`); anything
 * else is answered `ERR upload-pack: not our ref <oid>`. The names follow git's
 * `uploadpack.*` settings:
 *
 * - "ADVERTISED": only the ids of the refs (git's default over protocol v0/v1)
 * - "TIP": the ids of the refs, hidden ones too (`uploadpack.allowTipSHA1InWant`)
 * - "REACHABLE_COMMIT": the refs and the commits reachable from them
 *   (`uploadpack.allowReachableSHA1InWant`)
 * - "REACHABLE_COMMIT_TIP": both of the above
 * - "ANY": any object the repository has (`uploadpack.allowAnySHA1InWant`, and what git's
 *   protocol v2 always does)
 *
 * The servers default to git's behaviour: "ADVERTISED" over v0/v1, "ANY" over v2. Git's v2
 * ignores the `uploadpack.allow*` settings; a stricter v2 policy (such as "REACHABLE_COMMIT",
 * to refuse objects no branch or tag reaches) is an extension of ours.
 */
export type UploadPackRequestPolicy =
  | "ADVERTISED"
  | "REACHABLE_COMMIT"
  | "TIP"
  | "REACHABLE_COMMIT_TIP"
  | "ANY";

/**
 * Configuration options for FSM execution.
 *
 * Read-only settings that control FSM behavior.
 * Set before starting the FSM run.
 */
export class ProcessConfiguration {
  /**
   * Maximum number of "have" commands to send during negotiation.
   * Prevents excessive negotiation on large repositories.
   * @default 256
   */
  maxHaves?: number;

  /**
   * Local HEAD ref to start ancestry walk from.
   * Client uses this to find local commits to send as "have".
   * @example "refs/heads/main"
   */
  localHead?: string;

  /**
   * Refs that should be fetched/updated.
   * Maps remote ref name to object ID.
   * After successful fetch, these refs are updated locally.
   */
  wantedRefs?: Map<string, string>;

  /**
   * Server capabilities to advertise.
   * Only used by server-side FSM.
   */
  serverCapabilities?: string[];

  /**
   * Whether to use thin packs.
   * Thin packs can reference objects the receiver has
   * but aren't in the pack itself.
   * @default true
   */
  thinPack?: boolean;

  /**
   * Whether to enable sideband multiplexing.
   * Allows progress messages alongside pack data.
   * @default true
   */
  sideBand?: boolean;

  /**
   * Server side: the side-band keep-alive interval in milliseconds while a pack is prepared,
   * until its first byte (an empty band-1 packet, as git's `uploadpack.keepAlive`); 0 turns
   * keep-alives off.
   * @default 5000
   */
  keepAliveMs?: number;

  /**
   * Progress callback for reporting transfer status.
   * @param message - Progress message to display
   */
  onProgress?: (message: string) => void;

  // Push configuration

  /**
   * Whether to use atomic push mode.
   * All refs are updated together or none are updated.
   * @default false
   */
  atomic?: boolean;

  /**
   * Push options to send to the server.
   * Requires server support for "push-options" capability.
   */
  pushOptions?: string[];

  /**
   * Suppress output/progress messages.
   * @default false
   */
  quiet?: boolean;

  // Server-side push configuration

  /**
   * Whether to allow ref deletions on the server.
   * @default true
   */
  allowDeletes?: boolean;

  /**
   * Whether to allow non-fast-forward updates on the server.
   * @default false
   */
  allowNonFastForward?: boolean;

  /**
   * Whether to deny updates to the currently checked-out branch of a non-bare repository
   * ("branch is currently checked out", git's `receive.denyCurrentBranch`).
   * @default true
   */
  denyCurrentBranch?: boolean | ReceiveDenyAction;

  /**
   * The currently checked-out branch on the server.
   * Used with denyCurrentBranch to prevent updates.
   */
  currentBranch?: string;

  /** receive-pack hooks, limits and driver integration */
  receivePack?: ReceivePackConfig;

  /** upload-pack hooks and driver integration */
  uploadPack?: UploadPackConfig;

  /**
   * Server side: the hidden ref patterns of the served service (git's `transfer.hideRefs`
   * followed by `uploadpack.hideRefs` or `receive.hideRefs`; see `isRefHidden`). Hidden refs
   * are not advertised, nor listed by `ls-refs`; a `want-ref` of one is an unknown ref, and
   * receive-pack refuses to change one.
   */
  hiddenRefs?: string[];

  // Protocol V2 configuration

  /**
   * Whether to force ref fetch even if refs are already known.
   * @default false
   */
  forceRefFetch?: boolean;

  /**
   * Whether to request symref information in ls-refs.
   * @default false
   */
  lsRefsSymrefs?: boolean;

  /**
   * Whether to request peeled tag info in ls-refs.
   * @default false
   */
  lsRefsPeel?: boolean;

  /**
   * Whether to request unborn HEAD info in ls-refs.
   * @default false
   */
  lsRefsUnborn?: boolean;

  /**
   * Ref prefixes to filter ls-refs response.
   * @default ["refs/heads/", "refs/tags/"]
   */
  refPrefixes?: string[];

  /**
   * Whether to suppress progress messages.
   * @default false
   */
  noProgress?: boolean;

  /**
   * Shallow clone depth (number of commits).
   * 0 means full clone.
   * @default 0
   */
  depth?: number;

  /**
   * Whether to deepen relative to current shallow boundary.
   * @default false
   */
  deepenRelative?: boolean;

  /**
   * Timestamp to deepen to (shallow since).
   */
  shallowSince?: number;

  /**
   * Refs to exclude from shallow clone.
   */
  shallowExclude?: string[];

  /**
   * Partial clone filter specification.
   * @example "blob:none" - filter out all blobs
   * @example "blob:limit=1m" - filter blobs larger than 1MB
   */
  filter?: string;

  /**
   * Whether this is a stateless RPC connection.
   * In stateless mode, client always sends "done" immediately.
   * @default false
   */
  statelessRpc?: boolean;

  // Fetch negotiation configuration

  /**
   * Maximum number of empty negotiation batches before giving up.
   * Used with multi_ack_detailed to detect when server won't find common base.
   * @default 10
   */
  maxEmptyBatches?: number;

  /**
   * Policy for validating want requests (server-side), see {@link UploadPackRequestPolicy}.
   * Default: "ADVERTISED" over protocol v0/v1, "ANY" over v2 (git's).
   */
  requestPolicy?: UploadPackRequestPolicy;

  /**
   * Protocol v2: advertise and serve `object-info` (git's `transfer.advertiseObjectInfo`,
   * default false: not advertised, and the command is refused as "invalid command"). Added
   * to `serverCapabilities` as `object-info=size type` unless they name it already.
   */
  advertiseObjectInfo?: boolean;

  /**
   * Whether to include automatically annotated tags pointing to fetched objects.
   * @default true
   */
  includeTag?: boolean;

  /**
   * Multi-ack mode for negotiation.
   * - undefined: Single ACK at end
   * - "continue": ACK each common object
   * - "detailed": ACK with status (common, ready)
   * @default undefined
   */
  multiAck?: "continue" | "detailed";

  /**
   * Whether server supports no-done optimization.
   * Server can send pack immediately when it has enough info.
   * @default false
   */
  noDone?: boolean;

  // Error recovery configuration

  /**
   * Maximum number of retry attempts for recoverable errors.
   * @default 3
   */
  maxRetries?: number;

  /**
   * Whether to allow reconnection on transport errors.
   * @default false
   */
  allowReconnect?: boolean;

  /**
   * Function to create a new connection for reconnection.
   * Must return a new duplex stream or null if reconnection fails.
   */
  reconnect?: () => Promise<ReconnectDuplex | null>;
}

/**
 * Duplex stream interface for reconnection.
 * Named to avoid conflict with api/duplex.ts Duplex type.
 */
export interface ReconnectDuplex {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
}
