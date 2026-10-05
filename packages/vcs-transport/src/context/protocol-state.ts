/**
 * Accumulated state during protocol negotiation.
 *
 * This class holds the mutable state that builds up during
 * the Git protocol exchange. Both client and server FSMs
 * read from and write to this state.
 */
export class ProtocolState {
  /**
   * Remote refs advertised by the server.
   * Maps ref name (e.g., "refs/heads/main") to object ID.
   */
  refs = new Map<string, string>();

  /**
   * Object IDs that the client wants from the server.
   * Populated during the "want" phase.
   */
  wants = new Set<string>();

  /**
   * Object IDs that the client has locally.
   * Sent to server during negotiation.
   */
  haves = new Set<string>();

  /**
   * Common ancestors found during negotiation.
   * Objects both client and server have.
   * Server uses this to minimize pack size.
   */
  commonBase = new Set<string>();

  /**
   * Negotiated protocol capabilities.
   * e.g., "multi_ack_detailed", "side-band-64k", "thin-pack", "no-done"
   */
  capabilities = new Set<string>();

  // Protocol V2 specific state

  /**
   * Protocol version negotiated with the server.
   * 1 for V1, 2 for V2.
   */
  protocolVersion?: number;

  /**
   * Capability values for capabilities with parameters.
   * e.g., "fetch=shallow filter" would store "shallow filter" under "fetch".
   */
  capabilityValues?: Map<string, string>;

  /**
   * Symbolic ref targets.
   * Maps ref name to its target ref name.
   * e.g., "HEAD" -> "refs/heads/main"
   */
  symrefs?: Map<string, string>;

  /**
   * Peeled tag targets.
   * Maps tag ref to the OID of the dereferenced object.
   */
  peeled?: Map<string, string>;

  /**
   * Refs the client wants to fetch, mapped to their OIDs.
   * Used with want-ref protocol V2 extension.
   */
  wantedRefs?: Map<string, string>;

  /**
   * Whether client has sent "done" command.
   * In V2, client sends "done" to signal end of negotiation.
   */
  sentDone?: boolean;

  /**
   * Current section being processed in fetch response.
   * One of: "acknowledgments", "shallow-info", "wanted-refs", "packfile-uris"
   */
  currentSection?: string;

  /**
   * Whether server signaled "ready" to send packfile.
   */
  serverReady?: boolean;

  /**
   * Client's shallow boundaries.
   * Commits that the client has shallowly.
   */
  clientShallow?: Set<string>;

  /**
   * Commits that the server wants to unshallow.
   * Sent in shallow-info section.
   */
  serverUnshallow?: Set<string>;

  /**
   * Server's shallow boundaries (for server FSM).
   */
  serverShallow?: Set<string>;

  /**
   * Resolved wanted-refs from the server response.
   * Maps ref name to resolved OID.
   */
  resolvedWantedRefs?: Map<string, string>;

  /**
   * Packfile URIs for CDN-based pack fetching.
   */
  packfileUris?: string[];

  /**
   * Current command being processed (server-side).
   * One of: "ls-refs", "fetch", "object-info"
   */
  currentCommand?: string;

  /**
   * ACKed object IDs during negotiation.
   */
  acks?: string[];

  // V1 Fetch FSM specific state

  /**
   * Deepen request from client (V1 fetch).
   * One of: "deepen N", "deepen-since TIMESTAMP", "deepen-not REF"
   */
  deepenRequest?: string;

  /**
   * Filter specification for partial clone.
   * e.g., "blob:none", "tree:0", "blob:limit=1m"
   */
  filterSpec?: string;

  /**
   * Count of empty negotiation rounds.
   * Used to detect and prevent infinite cycles.
   */
  emptyBatchCount?: number;

  /**
   * Objects already ACKed in multi_ack_detailed mode.
   * Prevents sending duplicate ACKs.
   */
  ackedCommon?: Set<string>;

  // Error recovery

  /**
   * Checkpoint for error recovery.
   * Stores a snapshot of state at a stable point.
   */
  checkpoint?: Partial<ProtocolState>;

  /**
   * Checks if a specific capability is enabled.
   * @param cap - Capability name to check
   */
  hasCapability(cap: string): boolean {
    return this.capabilities.has(cap);
  }

  /**
   * Creates a checkpoint of the current state.
   * Can be restored after a recoverable error.
   */
  createCheckpoint(): void {
    this.checkpoint = {
      refs: new Map(this.refs),
      wants: new Set(this.wants),
      haves: new Set(this.haves),
      commonBase: new Set(this.commonBase),
      capabilities: new Set(this.capabilities),
      protocolVersion: this.protocolVersion,
      capabilityValues: this.capabilityValues ? new Map(this.capabilityValues) : undefined,
      symrefs: this.symrefs ? new Map(this.symrefs) : undefined,
      peeled: this.peeled ? new Map(this.peeled) : undefined,
      wantedRefs: this.wantedRefs ? new Map(this.wantedRefs) : undefined,
      sentDone: this.sentDone,
      currentSection: this.currentSection,
      serverReady: this.serverReady,
      clientShallow: this.clientShallow ? new Set(this.clientShallow) : undefined,
      serverUnshallow: this.serverUnshallow ? new Set(this.serverUnshallow) : undefined,
      serverShallow: this.serverShallow ? new Set(this.serverShallow) : undefined,
      resolvedWantedRefs: this.resolvedWantedRefs ? new Map(this.resolvedWantedRefs) : undefined,
      packfileUris: this.packfileUris ? [...this.packfileUris] : undefined,
      currentCommand: this.currentCommand,
      acks: this.acks ? [...this.acks] : undefined,
      deepenRequest: this.deepenRequest,
      filterSpec: this.filterSpec,
      emptyBatchCount: this.emptyBatchCount,
      ackedCommon: this.ackedCommon ? new Set(this.ackedCommon) : undefined,
    };
  }

  /**
   * Restores state from checkpoint.
   * @returns true if checkpoint was restored, false if no checkpoint exists
   */
  restoreCheckpoint(): boolean {
    if (!this.checkpoint) return false;

    const cp = this.checkpoint;
    this.refs = cp.refs ? new Map(cp.refs) : new Map();
    this.wants = cp.wants ? new Set(cp.wants) : new Set();
    this.haves = cp.haves ? new Set(cp.haves) : new Set();
    this.commonBase = cp.commonBase ? new Set(cp.commonBase) : new Set();
    this.capabilities = cp.capabilities ? new Set(cp.capabilities) : new Set();
    this.protocolVersion = cp.protocolVersion;
    this.capabilityValues = cp.capabilityValues ? new Map(cp.capabilityValues) : undefined;
    this.symrefs = cp.symrefs ? new Map(cp.symrefs) : undefined;
    this.peeled = cp.peeled ? new Map(cp.peeled) : undefined;
    this.wantedRefs = cp.wantedRefs ? new Map(cp.wantedRefs) : undefined;
    this.sentDone = cp.sentDone;
    this.currentSection = cp.currentSection;
    this.serverReady = cp.serverReady;
    this.clientShallow = cp.clientShallow ? new Set(cp.clientShallow) : undefined;
    this.serverUnshallow = cp.serverUnshallow ? new Set(cp.serverUnshallow) : undefined;
    this.serverShallow = cp.serverShallow ? new Set(cp.serverShallow) : undefined;
    this.resolvedWantedRefs = cp.resolvedWantedRefs ? new Map(cp.resolvedWantedRefs) : undefined;
    this.packfileUris = cp.packfileUris ? [...cp.packfileUris] : undefined;
    this.currentCommand = cp.currentCommand;
    this.acks = cp.acks ? [...cp.acks] : undefined;
    this.deepenRequest = cp.deepenRequest;
    this.filterSpec = cp.filterSpec;
    this.emptyBatchCount = cp.emptyBatchCount;
    this.ackedCommon = cp.ackedCommon ? new Set(cp.ackedCommon) : undefined;

    return true;
  }

  /**
   * Resets all accumulated state.
   * Useful for reusing the state object.
   */
  reset(): void {
    this.refs.clear();
    this.wants.clear();
    this.haves.clear();
    this.commonBase.clear();
    this.capabilities.clear();
    this.protocolVersion = undefined;
    this.capabilityValues = undefined;
    this.symrefs = undefined;
    this.peeled = undefined;
    this.wantedRefs = undefined;
    this.sentDone = undefined;
    this.currentSection = undefined;
    this.serverReady = undefined;
    this.clientShallow = undefined;
    this.serverUnshallow = undefined;
    this.serverShallow = undefined;
    this.resolvedWantedRefs = undefined;
    this.packfileUris = undefined;
    this.currentCommand = undefined;
    this.acks = undefined;
    this.deepenRequest = undefined;
    this.filterSpec = undefined;
    this.emptyBatchCount = undefined;
    this.ackedCommon = undefined;
    this.checkpoint = undefined;
  }
}
