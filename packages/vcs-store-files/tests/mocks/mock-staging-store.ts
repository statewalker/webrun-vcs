/**
 * Mock Staging for testing
 */

import type {
  ConflictResolution,
  EntryIteratorOptions,
  IndexBuilder,
  IndexEditor,
  MergeStageValue,
  Staging,
  StagingEntry,
} from "@statewalker/vcs-working-tree";
import { MergeStage } from "@statewalker/vcs-working-tree";
import { vi } from "vitest";

/**
 * Create a staging entry for tests.
 */
export function createStagingEntry(
  path: string,
  objectId: string,
  stage: MergeStageValue = MergeStage.MERGED,
  options: Partial<StagingEntry> = {},
): StagingEntry {
  return {
    path,
    objectId,
    mode: options.mode ?? 0o100644,
    stage,
    size: options.size ?? 100,
    mtime: options.mtime ?? Date.now(),
    ctime: options.ctime ?? Date.now(),
    dev: options.dev ?? 0,
    ino: options.ino ?? 0,
    uid: options.uid ?? 0,
    gid: options.gid ?? 0,
    flags: options.flags ?? 0,
    assumeValid: options.assumeValid ?? false,
    ...options,
  };
}

/**
 * Create a mock Staging for testing.
 *
 * @param entries Stage 0 entries to include
 * @param conflictPaths Paths that have conflicts
 */
export function createMockStaging(
  entries: StagingEntry[] = [],
  conflictPaths: string[] = [],
): Staging {
  return {
    // ========== Entry Operations (Staging interface) ==========
    getEntryCount: vi.fn().mockResolvedValue(entries.length),
    hasEntry: vi.fn().mockImplementation(async (path: string) => {
      return entries.some((e) => e.path === path);
    }),
    getEntry: vi.fn().mockImplementation(async (path: string, stage?: MergeStageValue) => {
      const targetStage = stage ?? 0;
      return entries.find((e) => e.path === path && e.stage === targetStage);
    }),
    getEntries: vi.fn().mockImplementation(async (path: string) => {
      return entries.filter((e) => e.path === path);
    }),
    setEntry: vi.fn().mockResolvedValue(undefined),
    removeEntry: vi.fn().mockResolvedValue(true),
    entries: vi.fn().mockImplementation(async function* (_options?: EntryIteratorOptions) {
      for (const entry of entries) {
        yield entry;
      }
    }),

    // ========== Conflict Handling (Staging interface) ==========
    hasConflicts: vi.fn().mockResolvedValue(conflictPaths.length > 0),
    getConflictedPaths: vi.fn().mockResolvedValue(conflictPaths),
    resolveConflict: vi
      .fn()
      .mockImplementation(async (_path: string, _resolution: ConflictResolution) => {
        // No-op in mock
      }),

    // ========== Tree Operations (Staging interface) ==========
    writeTree: vi.fn().mockResolvedValue("4b825dc642cb6eb9a060e54bf8d69288fbee4904"),
    readTree: vi.fn().mockResolvedValue(undefined),

    // ========== Bulk Operations (Staging interface) ==========
    createBuilder: vi.fn().mockReturnValue({
      add: vi.fn(),
      keep: vi.fn(),
      addTree: vi.fn().mockResolvedValue(undefined),
      finish: vi.fn().mockResolvedValue(undefined),
    } as IndexBuilder),
    createEditor: vi.fn().mockReturnValue({
      add: vi.fn(),
      remove: vi.fn(),
      upsert: vi.fn(),
      finish: vi.fn().mockResolvedValue(undefined),
    } as IndexEditor),

    // ========== Persistence (Staging interface) ==========
    read: vi.fn().mockResolvedValue(undefined),
    write: vi.fn().mockResolvedValue(undefined),
    isOutdated: vi.fn().mockResolvedValue(false),
    getUpdateTime: vi.fn().mockReturnValue(Date.now()),
    clear: vi.fn().mockResolvedValue(undefined),
  } as unknown as Staging;
}
