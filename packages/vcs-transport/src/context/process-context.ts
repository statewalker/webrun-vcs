import type { RepositoryFacade } from "../api/repository-facade.js";
import type { TransportApi } from "../api/transport-api.js";
import type { HandlerOutput } from "./handler-output.js";
import type { ProcessConfiguration } from "./process-config.js";
import type { ProtocolState } from "./protocol-state.js";

/**
 * Ref store interface for reading and updating refs.
 *
 * Minimal interface required by the transport layer.
 * Should be implemented by the core RefStore.
 */
export interface RefStore {
  /**
   * Gets the object ID for a ref.
   * @param name - Ref name (e.g., "refs/heads/main")
   * @returns Object ID or undefined if ref doesn't exist
   */
  get(name: string): Promise<string | undefined>;

  /**
   * Updates a ref to point to a new object.
   * @param name - Ref name
   * @param oid - Object ID to set
   */
  update(name: string, oid: string): Promise<void>;

  /**
   * Lists all refs in the repository.
   * @returns Iterable of [name, oid] pairs
   */
  listAll(): Promise<Iterable<[string, string]>>;

  /**
   * Gets the target of a symbolic ref.
   * Optional method for Protocol V2 ls-refs.
   *
   * @param name - Symbolic ref name (e.g., "HEAD")
   * @returns Target ref name or undefined if not a symref
   */
  getSymrefTarget?(name: string): Promise<string | undefined>;

  /**
   * Checks if an object ID is currently a ref tip.
   * Optional method for TIP policy validation.
   *
   * @param oid - Object ID to check
   * @returns true if oid is a current ref tip
   */
  isRefTip?(oid: string): Promise<boolean>;
}

/**
 * Complete context passed to all FSM state handlers.
 *
 * Composes all APIs, state, and configuration needed
 * for Git protocol operations.
 *
 * @example Creating a context
 * ```ts
 * const state = new ProtocolState();
 * const context: ProcessContext = {
 *   transport: createTransportApi(socket, state),
 *   repository: createRepositoryFacade(historyStore),
 *   refStore: historyStore.refStore,
 *   state,
 *   output: new HandlerOutput(),
 *   config: {
 *     maxHaves: 256,
 *     localHead: "refs/heads/main",
 *   },
 * };
 * ```
 */
export type ProcessContext = {
  // ─────────────────────────────────────────────────────────────
  // APIs (stateless interfaces)
  // ─────────────────────────────────────────────────────────────

  /**
   * Transport I/O for Git wire protocol.
   * Handles pkt-line framing, sideband, pack streaming.
   */
  transport: TransportApi;

  /**
   * Repository operations facade.
   * Pack import/export, object existence checks, ancestry walks.
   */
  repository: RepositoryFacade;

  /**
   * Ref management.
   * Read/write refs after successful fetch/push.
   */
  refStore: RefStore;

  // ─────────────────────────────────────────────────────────────
  // State (mutable during execution)
  // ─────────────────────────────────────────────────────────────

  /**
   * Accumulated protocol state.
   * Refs, wants, haves, common base, capabilities.
   */
  state: ProtocolState;

  /**
   * Handler output values.
   * Errors, progress, results.
   */
  output: HandlerOutput;

  // ─────────────────────────────────────────────────────────────
  // Configuration (read-only)
  // ─────────────────────────────────────────────────────────────

  /**
   * FSM execution configuration.
   * Max haves, local head, wanted refs, etc.
   */
  config: ProcessConfiguration;
};
