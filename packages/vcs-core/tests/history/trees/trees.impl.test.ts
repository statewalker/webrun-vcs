/**
 * Tests for TreesImpl using GitObjectStore with MemoryRawStorage
 *
 * Runs conformance tests against the new Trees implementation.
 */

import { createGitObjectStore } from "../../../src/history/objects/index.js";
import { createTrees } from "../../../src/history/trees/trees.impl.js";
import type { Trees } from "../../../src/history/trees/trees.js";
import { MemoryRawStorage } from "../../../src/storage/raw/memory-raw-storage.js";
import { treesConformanceTests } from "./trees.conformance.test.js";

let storage: MemoryRawStorage;

treesConformanceTests(
  "TreesImpl",
  async (): Promise<Trees> => {
    storage = new MemoryRawStorage();
    const objects = createGitObjectStore(storage);
    return createTrees(objects);
  },
  async (): Promise<void> => {
    storage.clear();
  },
);
