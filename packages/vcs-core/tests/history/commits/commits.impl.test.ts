/**
 * Tests for CommitsImpl using GitObjectStore with MemoryRawStorage
 *
 * Runs conformance tests against the new Commits implementation.
 */

import { createCommits } from "../../../src/history/commits/commits.impl.js";
import type { Commits } from "../../../src/history/commits/commits.js";
import { createGitObjects } from "../../../src/history/objects/index.js";
import { rawStorageStaging } from "../../../src/storage/adapters/staging-blob-store.js";
import { MemoryRawStorage } from "../../../src/storage/raw/memory-raw-storage.js";
import { commitsConformanceTests } from "./commits.conformance.test.js";

let storage: MemoryRawStorage;

commitsConformanceTests(
  "CommitsImpl",
  async (): Promise<Commits> => {
    storage = new MemoryRawStorage();
    const objects = createGitObjects(rawStorageStaging(storage));
    return createCommits(objects);
  },
  async (): Promise<void> => {
    storage.clear();
  },
);
