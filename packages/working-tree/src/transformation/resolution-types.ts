/**
 * Resolution types - Types for conflict tracking and resolution
 *
 * These types define the conflict detection and resolution workflow,
 * including rerere (reuse recorded resolution) functionality.
 */

import type { FileModeValue, ObjectId } from "@statewalker/vcs-core";

// === Conflict Types ===

/**
 * Types of conflicts that can occur during merge operations.
 *
 * Based on Git's conflict detection in merge-recursive and merge-ort.
 */
export type ConflictType =
  | "content" // Both modified same file differently
  | "delete-modify" // We deleted, they modified
  | "modify-delete" // We modified, they deleted
  | "add-add" // Both added with different content
  | "mode" // File mode conflict (e.g., executable bit)
  | "rename-rename" // Both renamed same file differently
  | "rename-delete" // We renamed, they deleted (or vice versa)
  | "directory-file" // One made directory, other made file
  | "submodule"; // Submodule conflict

/**
 * Resolution strategies for conflicts.
 */
export type ResolutionStrategy =
  | "ours" // Take our version
  | "theirs" // Take their version
  | "union" // Combine both (for certain file types)
  | "manual" // Manually edited resolution
  | "delete" // Delete the file
  | "rename"; // Rename to avoid conflict

// === Conflict Info ===

/**
 * Entry for a single stage in a conflict.
 */
export interface ConflictEntry {
  /** Object ID of content */
  readonly objectId: ObjectId;

  /** File mode */
  readonly mode: FileModeValue | number;

  /** File size (if known) */
  readonly size?: number;
}

/**
 * Detailed information about a single conflict.
 */
export interface ConflictInfo {
  /** File path with conflict */
  readonly path: string;

  /** Type of conflict */
  readonly type: ConflictType;

  /** Stage 1 (base) entry - common ancestor */
  readonly base?: ConflictEntry;

  /** Stage 2 (ours) entry - current branch */
  readonly ours?: ConflictEntry;

  /** Stage 3 (theirs) entry - being merged */
  readonly theirs?: ConflictEntry;

  /** Whether conflict has been resolved in working tree */
  readonly resolvedInWorktree: boolean;

  /** Whether resolution has been staged */
  readonly staged: boolean;
}

// === Resolution ===

/**
 * Resolution for a conflict.
 */
export interface Resolution {
  /** Strategy used */
  readonly strategy: ResolutionStrategy;

  /** Resulting object ID (after resolution) */
  readonly objectId?: ObjectId;

  /** Resulting file mode */
  readonly mode?: FileModeValue | number;

  /** Path to rename to (for rename strategy) */
  readonly renameTo?: string;
}

// === Resolution Recording (rerere) ===

/**
 * Recorded resolution for future reuse.
 *
 * Git's "rerere" (reuse recorded resolution) feature stores
 * resolutions indexed by conflict signature, allowing automatic
 * resolution of identical conflicts in future merges.
 *
 * Storage format in .git/rr-cache/<signature>/:
 * - preimage: The conflicted file with markers
 * - postimage: The resolved content
 */
export interface RecordedResolution {
  /** Unique signature of the conflict (hash of conflict content) */
  readonly signature: string;

  /** The resolution that was applied */
  readonly resolution: Resolution;

  /** When resolution was recorded */
  readonly recordedAt: Date;

  /** Original conflict content (for verification) */
  readonly conflictContent?: Uint8Array;

  /** Resolved content */
  readonly resolvedContent?: Uint8Array;
}

// === Resolution Events ===

/**
 * Events emitted during resolution workflow.
 */
export type ResolutionEvent =
  | { type: "conflict-detected"; path: string; conflictType: ConflictType }
  | { type: "conflict-resolved"; path: string; strategy: ResolutionStrategy }
  | { type: "resolution-recorded"; path: string; signature: string }
  | { type: "auto-resolved"; path: string; signature: string };

// === Statistics ===

/**
 * Conflict statistics for current operation.
 */
export interface ConflictStats {
  /** Total number of conflicting files */
  readonly totalConflicts: number;

  /** Conflicts resolved (staged) */
  readonly resolvedCount: number;

  /** Conflicts still pending */
  readonly pendingCount: number;

  /** Breakdown by conflict type */
  readonly byType: Readonly<Record<ConflictType, number>>;
}
