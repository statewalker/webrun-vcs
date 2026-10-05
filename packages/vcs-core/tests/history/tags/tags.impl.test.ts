/**
 * Tests for TagsImpl using GitObjectStore with MemoryRawStorage
 *
 * Runs conformance tests against the new Tags implementation.
 */

import { createGitObjectStore } from "../../../src/history/objects/index.js";
import { createTags } from "../../../src/history/tags/tags.impl.js";
import type { Tags } from "../../../src/history/tags/tags.js";
import { MemoryRawStorage } from "../../../src/storage/raw/memory-raw-storage.js";
import { tagsConformanceTests } from "./tags.conformance.test.js";

let storage: MemoryRawStorage;

tagsConformanceTests(
  "TagsImpl",
  async (): Promise<Tags> => {
    storage = new MemoryRawStorage();
    const objects = createGitObjectStore(storage);
    return createTags(objects);
  },
  async (): Promise<void> => {
    storage.clear();
  },
);
