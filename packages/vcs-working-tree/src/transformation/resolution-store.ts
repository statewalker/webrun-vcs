/**
 * ResolutionStore - Conflict tracking and resolution management
 *
 * Provides a unified interface for:
 * 1. Conflict registry - query all current conflicts from staging area
 * 2. Resolution workflow - mark files as resolved with specific strategies
 * 3. Resolution recording - rerere functionality for automatic resolution
 */

import type {
  ConflictInfo,
  ConflictStats,
  ConflictType,
  RecordedResolution,
  Resolution,
} from "./resolution-types.js";

/**
 * Store for conflict tracking and resolution.
 *
 * ResolutionStore provides comprehensive conflict management by:
 * - Detecting conflicts from staging area entries (stages 1-3)
 * - Tracking conflict types and status
 * - Managing resolution workflow
 * - Recording resolutions for future reuse (rerere)
 *
 * Usage pattern:
 * ```typescript
 * // Check for conflicts
 * if (await resolutionStore.hasConflicts()) {
 *   const conflicts = await resolutionStore.getConflicts();
 *
 *   // Try auto-resolving with recorded resolutions
 *   const autoResolved = await resolutionStore.autoResolve();
 *
 *   // Handle remaining conflicts
 *   for (const conflict of conflicts) {
 *     if (!autoResolved.includes(conflict.path)) {
 *       // Manual resolution needed
 *       await resolutionStore.acceptOurs(conflict.path);
 *       // or: await resolutionStore.acceptTheirs(conflict.path);
 *       // or: manual edit then markResolved
 *     }
 *   }
 *
 *   // Record resolutions for future use
 *   for (const conflict of conflicts) {
 *     await resolutionStore.recordResolution(conflict.path);
 *   }
 * }
 * ```
 */
export interface ResolutionStore {
  // ========== Conflict Registry ==========

  /**
   * Get all current conflicts.
   *
   * Scans staging area for entries with stage > 0 and builds
   * ConflictInfo objects with type detection.
   */
  getConflicts(): Promise<ConflictInfo[]>;

  /**
   * Get conflict info for a specific path.
   *
   * @param path File path to check
   * @returns ConflictInfo if path has a conflict, undefined otherwise
   */
  getConflict(path: string): Promise<ConflictInfo | undefined>;

  /**
   * Check if there are any unresolved conflicts.
   *
   * Faster than getConflicts() when only checking presence.
   */
  hasConflicts(): Promise<boolean>;

  /**
   * Get conflict statistics.
   *
   * Provides summary counts by type and resolution status.
   */
  getStats(): Promise<ConflictStats>;

  /**
   * Get paths with conflicts.
   *
   * @returns Array of paths with unresolved conflicts
   */
  getConflictPaths(): Promise<string[]>;

  // ========== Resolution Workflow ==========

  /**
   * Mark a conflict as resolved.
   *
   * This updates the staging area by:
   * 1. Removing conflict stage entries (1, 2, 3)
   * 2. Adding a stage 0 entry with the resolved content
   *
   * The resolved content should already be in the working tree
   * (for 'manual' strategy) or is taken from the appropriate stage.
   *
   * @param path File path to mark resolved
   * @param resolution Resolution details (strategy and resulting content)
   */
  markResolved(path: string, resolution: Resolution): Promise<void>;

  /**
   * Mark all conflicts as resolved using working tree content.
   *
   * For each conflict:
   * 1. Reads current content from working tree
   * 2. Verifies no conflict markers remain
   * 3. Stores content as blob and stages at stage 0
   */
  markAllResolved(): Promise<void>;

  /**
   * Unmark a resolution (put back into conflict state).
   *
   * Note: This requires the original conflict entries to have been
   * preserved somewhere, which may not always be possible.
   *
   * @param path File path to unresolve
   * @throws Error if original conflict entries cannot be restored
   */
  unmarkResolved(path: string): Promise<void>;

  /**
   * Accept "ours" version for a conflict.
   *
   * Takes the stage 2 (ours) entry and:
   * 1. Clears all conflict stage entries
   * 2. Creates stage 0 entry with ours content
   * 3. Updates working tree to match
   *
   * @param path File path with conflict
   * @throws Error if no 'ours' version exists
   */
  acceptOurs(path: string): Promise<void>;

  /**
   * Accept "theirs" version for a conflict.
   *
   * Takes the stage 3 (theirs) entry and:
   * 1. Clears all conflict stage entries
   * 2. Creates stage 0 entry with theirs content
   * 3. Updates working tree to match
   *
   * @param path File path with conflict
   * @throws Error if no 'theirs' version exists
   */
  acceptTheirs(path: string): Promise<void>;

  // ========== Resolution Recording (rerere) ==========

  /**
   * Record a resolution for future reuse.
   *
   * Stores the current resolution in .git/rr-cache/ indexed by
   * a signature computed from the conflict (base/ours/theirs).
   *
   * This enables automatic resolution of identical conflicts
   * in future merge operations.
   *
   * @param path Path of resolved file
   * @returns Signature of recorded resolution, or undefined if not recorded
   */
  recordResolution(path: string): Promise<string | undefined>;

  /**
   * Get suggested resolution based on recorded resolutions.
   *
   * Computes the conflict signature and looks up in rr-cache.
   *
   * @param path Path with conflict
   * @returns Recorded resolution if signature matches, undefined otherwise
   */
  getSuggestedResolution(path: string): Promise<RecordedResolution | undefined>;

  /**
   * Apply a recorded resolution to a conflict.
   *
   * If a matching recorded resolution exists, writes the resolved
   * content to the working tree.
   *
   * @param path Path with conflict
   * @returns True if resolution was applied
   */
  applyRecordedResolution(path: string): Promise<boolean>;

  /**
   * Try to auto-resolve all conflicts using recorded resolutions.
   *
   * For each conflict, attempts to find and apply a recorded resolution.
   *
   * @returns Paths that were auto-resolved
   */
  autoResolve(): Promise<string[]>;

  /**
   * Clear all recorded resolutions.
   *
   * Removes the entire .git/rr-cache/ directory.
   */
  clearRecordedResolutions(): Promise<void>;

  // ========== Rerere Database ==========

  /**
   * List all recorded resolution signatures.
   *
   * @returns Array of signature strings
   */
  listRecordedResolutions(): Promise<string[]>;

  /**
   * Get a recorded resolution by signature.
   *
   * @param signature Resolution signature
   * @returns RecordedResolution if found
   */
  getRecordedResolution(signature: string): Promise<RecordedResolution | undefined>;

  /**
   * Delete a recorded resolution.
   *
   * @param signature Resolution signature to delete
   * @returns True if deleted, false if not found
   */
  deleteRecordedResolution(signature: string): Promise<boolean>;
}

/**
 * Type for conflict detection function.
 *
 * Used by implementations to determine conflict type from staging entries.
 */
export type ConflictDetector = (path: string) => Promise<ConflictType>;
