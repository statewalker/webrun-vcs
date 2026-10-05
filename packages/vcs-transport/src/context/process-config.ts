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
   * Progress callback for reporting transfer status.
   * @param message - Progress message to display
   */
  onProgress?: (message: string) => void;

  // Push configuration

  /**
   * Refspecs for push operation.
   * Format: "[+]src:dst" where + means force push
   * @example ["refs/heads/main:refs/heads/main", "+refs/heads/feature:refs/heads/feature"]
   */
  pushRefspecs?: string[];

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
   * Whether to deny updates to the currently checked-out branch.
   * @default true
   */
  denyCurrentBranch?: boolean;

  /**
   * The currently checked-out branch on the server.
   * Used with denyCurrentBranch to prevent updates.
   */
  currentBranch?: string;

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
   * Policy for validating want requests (server-side).
   * - "ADVERTISED": Only allow wants that were advertised in refs
   * - "REACHABLE_COMMIT": Allow any reachable commit
   * - "TIP": Only allow refs/tips
   * - "REACHABLE_COMMIT_TIP": Allow tips and reachable commits
   * - "ANY": Allow any valid object ID
   * @default "ADVERTISED"
   */
  requestPolicy?: "ADVERTISED" | "REACHABLE_COMMIT" | "TIP" | "REACHABLE_COMMIT_TIP" | "ANY";

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
