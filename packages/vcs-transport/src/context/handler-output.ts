import type { PackImportResult } from "../api/repository-facade.js";

/**
 * Output values produced by FSM handlers.
 *
 * Handlers write results here during execution.
 * Used for:
 * - Error reporting
 * - Progress tracking
 * - Final results
 */
export class HandlerOutput {
  /**
   * Error message if an operation failed.
   * When set, FSM typically transitions to error state.
   */
  error?: string;

  /**
   * Last acknowledged object ID from server.
   * Updated during ACK/NAK negotiation.
   */
  lastAckOid?: string;

  /**
   * Result from pack import operation.
   * Set after successfully receiving and importing a pack.
   */
  packResult?: PackImportResult;

  /**
   * Whether server sent "ACK ... ready".
   * Indicates pack is ready without waiting for "done".
   * Used with no-done capability.
   */
  receivedReady?: boolean;

  /**
   * Number of "have" commands sent during negotiation.
   * Used to enforce maxHaves limit.
   */
  havesSent?: number;

  /**
   * Number of haves sent since last "continue" ACK.
   * Used for early termination optimization.
   */
  havesSinceLastContinue?: number;

  /**
   * Whether a "continue" ACK was received.
   * Indicates server found some common objects.
   */
  receivedContinue?: boolean;

  // Protocol V2 specific outputs

  /**
   * Number of packfile URIs fetched from CDN.
   * Used with packfile-uris capability.
   */
  packfileUrisFetched?: number;

  /**
   * The invalid want that caused validation failure.
   * Could be a ref name or object ID.
   */
  invalidWant?: string;

  // Fetch FSM specific outputs

  /**
   * Number of objects received/sent.
   */
  objectCount?: number;

  /**
   * Progress message for UI.
   */
  progress?: string;

  /**
   * Additional tags sent with include-tag capability.
   * Maps tag ref name to object ID.
   */
  additionalTags?: Map<string, string>;

  /**
   * Number of bytes sent (server) or received (client).
   */
  sentBytes?: number;

  // Error recovery

  /**
   * Detailed error information for error recovery FSM.
   */
  errorInfo?: ErrorInfo;

  /**
   * Number of retry attempts made.
   */
  retryCount?: number;

  /**
   * Rollback function to undo partial changes.
   */
  rollback?: () => Promise<void>;

  /**
   * Resets all output values.
   */
  reset(): void {
    this.error = undefined;
    this.lastAckOid = undefined;
    this.packResult = undefined;
    this.receivedReady = undefined;
    this.havesSent = undefined;
    this.havesSinceLastContinue = undefined;
    this.receivedContinue = undefined;
    this.packfileUrisFetched = undefined;
    this.invalidWant = undefined;
    this.objectCount = undefined;
    this.progress = undefined;
    this.additionalTags = undefined;
    this.sentBytes = undefined;
    this.errorInfo = undefined;
    this.retryCount = undefined;
    this.rollback = undefined;
  }
}

/**
 * Error categories for error recovery FSM.
 */
export type ErrorCategory =
  | "PROTOCOL_ERROR"
  | "TRANSPORT_ERROR"
  | "TIMEOUT"
  | "PACK_ERROR"
  | "VALIDATION_ERROR";

/**
 * Detailed error information for recovery decisions.
 */
export interface ErrorInfo {
  /** Error category for routing */
  category: ErrorCategory;
  /** Human-readable error message */
  message: string;
  /** Whether the operation can be recovered */
  recoverable: boolean;
  /** Whether the operation can be retried */
  retryable: boolean;
  /** Additional context for error handling */
  context?: Record<string, unknown>;
}
