/**
 * Conflict detection and resolution utilities
 *
 * Provides helpers for working with merge conflicts in the staging area:
 * - Conflict detection and analysis
 * - Resolution helpers
 * - Merge conflict marker generation and parsing
 *
 * Based on Git's conflict handling patterns.
 */

import type { ObjectId } from "@statewalker/vcs-core";
import type { Staging } from "./staging.js";
import { ResolveStagingConflict } from "./staging-edits.js";
import type { MergeStageValue, StagingEntry } from "./types.js";
import { MergeStage } from "./types.js";

/**
 * Detailed information about a single conflict.
 */
export interface ConflictInfo {
  /** Path of the conflicted file */
  path: string;
  /** Base (common ancestor) entry, if exists */
  base?: StagingEntry;
  /** Our (current branch) entry, if exists */
  ours?: StagingEntry;
  /** Their (merged branch) entry, if exists */
  theirs?: StagingEntry;
  /** Type of conflict */
  type: ConflictTypeValue;
}

/**
 * Types of merge conflicts.
 */
export const ConflictType = {
  /** Both sides modified the same file differently */
  BOTH_MODIFIED: "both_modified",
  /** We deleted, they modified */
  DELETE_MODIFY: "delete_modify",
  /** We modified, they deleted */
  MODIFY_DELETE: "modify_delete",
  /** Both sides added the same path with different content */
  BOTH_ADDED: "both_added",
  /** File mode conflict (e.g., one side made it executable) */
  MODE_CONFLICT: "mode_conflict",
} as const;

export type ConflictTypeValue = (typeof ConflictType)[keyof typeof ConflictType];

/**
 * Resolution strategy for conflicts.
 */
export const ResolutionStrategy = {
  /** Keep our version */
  OURS: "ours",
  /** Keep their version */
  THEIRS: "theirs",
  /** Keep base version */
  BASE: "base",
  /** Delete the file */
  DELETE: "delete",
} as const;

export type ResolutionStrategyValue = (typeof ResolutionStrategy)[keyof typeof ResolutionStrategy];

/**
 * Options for generating conflict markers.
 */
export interface ConflictMarkerOptions {
  /** Label for our side (default: "HEAD") */
  oursLabel?: string;
  /** Label for their side (default: "merged") */
  theirsLabel?: string;
  /** Include base (ancestor) section with ||||||| marker (default: false) */
  includeBase?: boolean;
  /** Label for base section (default: "base") */
  baseLabel?: string;
}

/**
 * Parsed section from conflict markers.
 */
export interface ConflictSection {
  /** Content lines from ours side */
  ours: string[];
  /** Content lines from theirs side */
  theirs: string[];
  /** Content lines from base side (only if diff3 style) */
  base?: string[];
  /** Start line number in original content */
  startLine: number;
  /** End line number in original content */
  endLine: number;
}

// ============ Conflict Detection ============

/**
 * Get detailed information about a conflict at a specific path.
 *
 * @param store Staging store to query
 * @param path Path to check for conflict
 * @returns Conflict info or undefined if no conflict
 */
export async function getConflictInfo(
  store: Staging,
  path: string,
): Promise<ConflictInfo | undefined> {
  const entries = await store.getEntries(path);

  // No conflict if only stage 0 or no entries
  if (entries.length <= 1) {
    const entry = entries[0];
    if (!entry || entry.stage === MergeStage.MERGED) {
      return undefined;
    }
  }

  // Build conflict info from entries
  let base: StagingEntry | undefined;
  let ours: StagingEntry | undefined;
  let theirs: StagingEntry | undefined;

  for (const entry of entries) {
    switch (entry.stage) {
      case MergeStage.BASE:
        base = entry;
        break;
      case MergeStage.OURS:
        ours = entry;
        break;
      case MergeStage.THEIRS:
        theirs = entry;
        break;
    }
  }

  // Determine conflict type
  const type = classifyConflict(base, ours, theirs);

  return { path, base, ours, theirs, type };
}

/**
 * Get all conflicts in the staging area.
 *
 * @param store Staging store to query
 * @returns Array of conflict info objects
 */
export async function getAllConflicts(store: Staging): Promise<ConflictInfo[]> {
  const conflicts: ConflictInfo[] = [];
  const paths = await store.getConflictedPaths();

  for (const path of paths) {
    const info = await getConflictInfo(store, path);
    if (info) {
      conflicts.push(info);
    }
  }

  return conflicts;
}

/**
 * Count the number of conflicts in the staging area.
 *
 * @param store Staging store to query
 * @returns Number of conflicted paths
 */
export async function countConflicts(store: Staging): Promise<number> {
  const paths = await store.getConflictedPaths();
  return paths.length;
}

/**
 * Classify the type of conflict based on which stages are present.
 */
function classifyConflict(
  base: StagingEntry | undefined,
  ours: StagingEntry | undefined,
  theirs: StagingEntry | undefined,
): ConflictTypeValue {
  const hasBase = base !== undefined;
  const hasOurs = ours !== undefined;
  const hasTheirs = theirs !== undefined;

  if (!hasBase && hasOurs && hasTheirs) {
    // No common ancestor - both added
    return ConflictType.BOTH_ADDED;
  }

  if (hasBase && !hasOurs && hasTheirs) {
    // We deleted, they modified
    return ConflictType.DELETE_MODIFY;
  }

  if (hasBase && hasOurs && !hasTheirs) {
    // We modified, they deleted
    return ConflictType.MODIFY_DELETE;
  }

  // Check for mode-only conflict
  if (hasOurs && hasTheirs && ours.objectId === theirs.objectId && ours.mode !== theirs.mode) {
    return ConflictType.MODE_CONFLICT;
  }

  // Default: both modified
  return ConflictType.BOTH_MODIFIED;
}

// ============ Conflict Resolution ============

/**
 * Resolve a conflict using a predefined strategy.
 *
 * Creates a resolution edit that can be applied to the staging area.
 *
 * @param path Path of the conflict to resolve
 * @param strategy Resolution strategy to use
 * @returns Resolution edit to apply via editor
 */
export function createResolutionEdit(
  path: string,
  strategy: ResolutionStrategyValue,
): ResolveStagingConflict | { path: string; apply: () => undefined } {
  switch (strategy) {
    case ResolutionStrategy.OURS:
      return new ResolveStagingConflict(path, MergeStage.OURS);
    case ResolutionStrategy.THEIRS:
      return new ResolveStagingConflict(path, MergeStage.THEIRS);
    case ResolutionStrategy.BASE:
      return new ResolveStagingConflict(path, MergeStage.BASE);
    case ResolutionStrategy.DELETE:
      // Return a delete edit
      return {
        path,
        apply: () => undefined,
      };
  }
}

/**
 * Get the stage value for a resolution strategy.
 *
 * @param strategy Resolution strategy
 * @returns Corresponding merge stage, or undefined for DELETE
 */
export function strategyToStage(strategy: ResolutionStrategyValue): MergeStageValue | undefined {
  switch (strategy) {
    case ResolutionStrategy.OURS:
      return MergeStage.OURS;
    case ResolutionStrategy.THEIRS:
      return MergeStage.THEIRS;
    case ResolutionStrategy.BASE:
      return MergeStage.BASE;
    case ResolutionStrategy.DELETE:
      return undefined;
  }
}

/**
 * Get the object ID for a specific resolution strategy.
 *
 * @param conflict Conflict info
 * @param strategy Resolution strategy
 * @returns Object ID or undefined if that version doesn't exist
 */
export function getResolutionObjectId(
  conflict: ConflictInfo,
  strategy: ResolutionStrategyValue,
): ObjectId | undefined {
  switch (strategy) {
    case ResolutionStrategy.OURS:
      return conflict.ours?.objectId;
    case ResolutionStrategy.THEIRS:
      return conflict.theirs?.objectId;
    case ResolutionStrategy.BASE:
      return conflict.base?.objectId;
    case ResolutionStrategy.DELETE:
      return undefined;
  }
}

// ============ Merge Conflict Markers ============

/** Standard conflict marker: start of our changes */
const MARKER_OURS = "<<<<<<<";
/** Standard conflict marker: separator between ours and theirs */
const MARKER_SEPARATOR = "=======";
/** Standard conflict marker: end of their changes */
const MARKER_THEIRS = ">>>>>>>";
/** Diff3-style marker: start of base section */
const MARKER_BASE = "|||||||";

/**
 * Generate content with merge conflict markers.
 *
 * Creates Git-style conflict markers for manual resolution.
 *
 * @param oursContent Our version of the content (lines)
 * @param theirsContent Their version of the content (lines)
 * @param baseContent Base version (optional, for diff3 style)
 * @param options Marker options
 * @returns Content with conflict markers
 */
export function generateConflictMarkers(
  oursContent: string[],
  theirsContent: string[],
  baseContent?: string[],
  options: ConflictMarkerOptions = {},
): string {
  const oursLabel = options.oursLabel ?? "HEAD";
  const theirsLabel = options.theirsLabel ?? "merged";
  const baseLabel = options.baseLabel ?? "base";
  const includeBase = options.includeBase ?? false;

  const lines: string[] = [];

  // Start marker with ours label
  lines.push(`${MARKER_OURS} ${oursLabel}`);

  // Our content
  lines.push(...oursContent);

  // Include base section if requested and available
  if (includeBase && baseContent) {
    lines.push(`${MARKER_BASE} ${baseLabel}`);
    lines.push(...baseContent);
  }

  // Separator
  lines.push(MARKER_SEPARATOR);

  // Their content
  lines.push(...theirsContent);

  // End marker with theirs label
  lines.push(`${MARKER_THEIRS} ${theirsLabel}`);

  return lines.join("\n");
}

/**
 * Check if content contains conflict markers.
 *
 * @param content Content to check
 * @returns True if conflict markers are present
 */
export function hasConflictMarkers(content: string): boolean {
  return (
    content.includes(MARKER_OURS) &&
    content.includes(MARKER_SEPARATOR) &&
    content.includes(MARKER_THEIRS)
  );
}

/**
 * Parse conflict markers from content.
 *
 * Extracts conflict sections from Git-style conflict markers.
 *
 * @param content Content with conflict markers
 * @returns Array of parsed conflict sections
 */
export function parseConflictMarkers(content: string): ConflictSection[] {
  const lines = content.split("\n");
  const sections: ConflictSection[] = [];

  let i = 0;
  while (i < lines.length) {
    // Look for start marker
    if (lines[i].startsWith(MARKER_OURS)) {
      const startLine = i;
      i++;

      const oursLines: string[] = [];
      const baseLines: string[] = [];
      const theirsLines: string[] = [];

      let hasBase = false;
      let inBase = false;
      let inTheirs = false;

      // Collect lines until end marker
      while (i < lines.length && !lines[i].startsWith(MARKER_THEIRS)) {
        if (lines[i].startsWith(MARKER_BASE)) {
          hasBase = true;
          inBase = true;
        } else if (lines[i] === MARKER_SEPARATOR || lines[i].startsWith(MARKER_SEPARATOR)) {
          inBase = false;
          inTheirs = true;
        } else if (inTheirs) {
          theirsLines.push(lines[i]);
        } else if (inBase) {
          baseLines.push(lines[i]);
        } else {
          oursLines.push(lines[i]);
        }
        i++;
      }

      const endLine = i;
      i++; // Skip end marker

      sections.push({
        ours: oursLines,
        theirs: theirsLines,
        base: hasBase ? baseLines : undefined,
        startLine,
        endLine,
      });
    } else {
      i++;
    }
  }

  return sections;
}

/**
 * Remove conflict markers by choosing a side.
 *
 * @param content Content with conflict markers
 * @param strategy Which side to keep for all conflicts
 * @returns Content with conflicts resolved
 */
export function resolveMarkersByStrategy(
  content: string,
  strategy: "ours" | "theirs" | "base",
): string {
  const lines = content.split("\n");
  const result: string[] = [];

  let i = 0;
  while (i < lines.length) {
    if (lines[i].startsWith(MARKER_OURS)) {
      // Parse this conflict section
      i++;

      const oursLines: string[] = [];
      const baseLines: string[] = [];
      const theirsLines: string[] = [];

      let inBase = false;
      let inTheirs = false;

      while (i < lines.length && !lines[i].startsWith(MARKER_THEIRS)) {
        if (lines[i].startsWith(MARKER_BASE)) {
          inBase = true;
        } else if (lines[i] === MARKER_SEPARATOR || lines[i].startsWith(MARKER_SEPARATOR)) {
          inBase = false;
          inTheirs = true;
        } else if (inTheirs) {
          theirsLines.push(lines[i]);
        } else if (inBase) {
          baseLines.push(lines[i]);
        } else {
          oursLines.push(lines[i]);
        }
        i++;
      }
      i++; // Skip end marker

      // Choose the appropriate content based on strategy
      switch (strategy) {
        case "ours":
          result.push(...oursLines);
          break;
        case "theirs":
          result.push(...theirsLines);
          break;
        case "base":
          result.push(...baseLines);
          break;
      }
    } else {
      result.push(lines[i]);
      i++;
    }
  }

  return result.join("\n");
}

/**
 * Count the number of conflict sections in content.
 *
 * @param content Content to check
 * @returns Number of conflict sections
 */
export function countConflictMarkers(content: string): number {
  let count = 0;
  const lines = content.split("\n");

  for (const line of lines) {
    if (line.startsWith(MARKER_OURS)) {
      count++;
    }
  }

  return count;
}
