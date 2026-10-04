/**
 * Mock Trees for testing
 *
 * Implements both old TreeStore and new Trees interfaces for backward compatibility.
 */

import type { TreeEntry, Trees } from "@statewalker/vcs-core";
import { vi } from "vitest";

/**
 * Create a mock Trees for testing.
 *
 * Accepts either:
 * - A Map<string, TreeEntry[]> mapping tree IDs to their entries
 * - A Record<string, TreeEntry[]> object for convenience
 *
 * Implements both old TreeStore and new Trees interfaces.
 */
export function createMockTreeStore(
  entries: Map<string, TreeEntry[]> | Record<string, TreeEntry[]> = {},
): Trees {
  const entriesMap = entries instanceof Map ? entries : new Map(Object.entries(entries));

  const loadTreeImpl = async function* (treeId: string) {
    const treeEntries = entriesMap.get(treeId) ?? [];
    for (const entry of treeEntries) {
      yield entry;
    }
  };

  const storeTreeImpl = async (
    entries: TreeEntry[] | AsyncIterable<TreeEntry> | Iterable<TreeEntry>,
  ) => {
    // Convert to array if needed
    const entriesArray: TreeEntry[] = [];
    if (Symbol.asyncIterator in entries) {
      for await (const entry of entries as AsyncIterable<TreeEntry>) {
        entriesArray.push(entry);
      }
    } else if (Symbol.iterator in entries && !Array.isArray(entries)) {
      for (const entry of entries as Iterable<TreeEntry>) {
        entriesArray.push(entry);
      }
    } else {
      entriesArray.push(...(entries as TreeEntry[]));
    }

    // Generate a simple hash based on entries
    const content = entriesArray.map((e) => `${e.mode}:${e.name}:${e.id}`).join(";");
    const treeId = `tree-${content.length}`;

    // Store for later retrieval
    entriesMap.set(treeId, entriesArray);

    return treeId;
  };

  return {
    // Old interface
    loadTree: vi.fn().mockImplementation(loadTreeImpl),
    storeTree: vi.fn().mockImplementation(storeTreeImpl),

    // New interface (Trees)
    load: vi.fn().mockImplementation(async (treeId: string) => {
      const treeEntries = entriesMap.get(treeId);
      if (!treeEntries) return undefined;
      return (async function* () {
        for (const entry of treeEntries) {
          yield entry;
        }
      })();
    }),
    store: vi.fn().mockImplementation(storeTreeImpl),

    getEntry: vi.fn().mockImplementation(async (treeId: string, name: string) => {
      const treeEntries = entriesMap.get(treeId) ?? [];
      return treeEntries.find((e) => e.name === name);
    }),

    getEmptyTreeId: vi.fn().mockReturnValue("4b825dc642cb6eb9a060e54bf8d69288fbee4904"),

    has: vi.fn().mockImplementation(async (treeId: string) => {
      return entriesMap.has(treeId);
    }),

    keys: vi.fn().mockImplementation(async function* () {
      for (const key of entriesMap.keys()) {
        yield key;
      }
    }),

    remove: vi.fn().mockImplementation(async (treeId: string) => {
      return entriesMap.delete(treeId);
    }),
  } as unknown as Trees;
}
