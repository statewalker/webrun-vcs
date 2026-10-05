import type { TreeEntry } from "../../../history/trees/tree-entry.js";
import { BLOB_FIXTURES } from "./blobs.js";

/**
 * Simple tree entry for fixtures (uses id instead of hash).
 */
type TreeEntryFixture = {
  mode: string;
  name: string;
  id: string;
};

/**
 * Test tree fixtures with known structures.
 */
export const TREE_FIXTURES = {
  /**
   * Empty tree (special hash)
   */
  empty: {
    entries: [] as TreeEntryFixture[],
    hash: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
  },

  /**
   * Simple tree with one file
   */
  singleFile: {
    entries: [
      { mode: "100644", name: "file.txt", id: BLOB_FIXTURES.hello.hash },
    ] as TreeEntryFixture[],
    hash: "computed",
  },

  /**
   * Tree with multiple files
   */
  multipleFiles: {
    entries: [
      { mode: "100644", name: "README.md", id: BLOB_FIXTURES.helloWorld.hash },
      { mode: "100755", name: "script.sh", id: BLOB_FIXTURES.hello.hash },
      { mode: "100644", name: "data.txt", id: BLOB_FIXTURES.hello.hash },
    ] as TreeEntryFixture[],
    hash: "computed",
  },

  /**
   * Nested tree structure
   */
  nested: {
    structure: {
      "README.md": BLOB_FIXTURES.helloWorld.hash,
      "src/": {
        "index.js": BLOB_FIXTURES.hello.hash,
        "utils/": {
          "helper.js": BLOB_FIXTURES.hello.hash,
        },
      },
    },
    rootHash: "computed",
  },
} as const;

/**
 * Build tree entries from a nested structure.
 */
export async function buildTreeStructure(
  structure: Record<string, string | Record<string, unknown>>,
  storeTree: (entries: TreeEntry[]) => Promise<string>,
): Promise<string> {
  // Recursively build tree from structure
  const entries: TreeEntry[] = [];

  for (const [name, value] of Object.entries(structure)) {
    if (typeof value === "string") {
      // It's a blob hash
      entries.push({
        mode: name.endsWith(".sh") ? 0o100755 : 0o100644,
        name,
        id: value,
      });
    } else {
      // It's a subtree
      const subtreeHash = await buildTreeStructure(
        value as Record<string, string | Record<string, unknown>>,
        storeTree,
      );
      entries.push({
        mode: 0o040000,
        name: name.replace(/\/$/, ""), // Remove trailing slash
        id: subtreeHash,
      });
    }
  }

  return await storeTree(entries);
}
