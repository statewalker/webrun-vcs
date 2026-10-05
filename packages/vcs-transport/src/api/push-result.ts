/**
 * Common result types for push operations.
 */

/**
 * Result of a push operation.
 */
export interface PushResult {
  /** Whether the push was successful */
  success: boolean;
  /** Error message if push failed */
  error?: string;
  /** Map of ref names to their push status */
  refStatus?: Map<string, RefPushStatus>;
}

/**
 * Status of a single ref push.
 */
export interface RefPushStatus {
  /** Whether this ref was successfully pushed */
  success: boolean;
  /** Error message if this ref failed */
  error?: string;
  /** Old object ID (before push) */
  oldOid?: string;
  /** New object ID (after push) */
  newOid?: string;
}
