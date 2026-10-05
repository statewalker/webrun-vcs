/**
 * Mock Worktree for testing
 */

import type { Worktree, WorktreeEntry } from "@statewalker/vcs-working-tree";
import { vi } from "vitest";

/**
 * Create a working tree entry for tests.
 */
export function createWorktreeEntry(
  path: string,
  options: Partial<WorktreeEntry> = {},
): WorktreeEntry {
  return {
    path,
    name: path.split("/").pop() ?? path,
    isDirectory: options.isDirectory ?? false,
    isSymbolicLink: options.isSymbolicLink ?? false,
    isIgnored: options.isIgnored ?? false,
    size: options.size ?? 100,
    mtime: options.mtime ?? Date.now(),
    mode: options.mode ?? 0o100644,
    ...options,
  };
}

/**
 * Create a mock Worktree for testing.
 *
 * @param entries Working tree entries
 * @param hashes Map of path -> object hash
 */
export function createMockWorktree(
  entries: WorktreeEntry[] = [],
  hashes: Map<string, string> = new Map(),
): Worktree {
  return {
    // ========== Reading ==========
    walk: vi.fn().mockImplementation(async function* () {
      for (const entry of entries) {
        yield entry;
      }
    }),
    getEntry: vi.fn().mockImplementation(async (path: string) => {
      return entries.find((e) => e.path === path);
    }),
    computeHash: vi.fn().mockImplementation(async (path: string) => {
      return hashes.get(path) ?? "unknown-hash";
    }),
    readContent: vi.fn().mockImplementation(function* () {
      yield new Uint8Array([]);
    }),
    exists: vi.fn().mockImplementation(async (path: string) => {
      return entries.some((e) => e.path === path);
    }),
    isIgnored: vi.fn().mockImplementation(async (path: string) => {
      const entry = entries.find((e) => e.path === path);
      return entry?.isIgnored ?? false;
    }),

    // ========== Writing ==========
    writeContent: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(true),
    mkdir: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),

    // ========== Checkout Operations ==========
    checkoutTree: vi.fn().mockResolvedValue({
      updated: [],
      removed: [],
      conflicts: [],
      failed: [],
    }),
    checkoutPaths: vi.fn().mockResolvedValue({
      updated: [],
      removed: [],
      conflicts: [],
      failed: [],
    }),

    // ========== Metadata ==========
    getRoot: vi.fn().mockReturnValue("/mock/worktree"),
    refreshIgnore: vi.fn().mockResolvedValue(undefined),
  } as unknown as Worktree;
}
