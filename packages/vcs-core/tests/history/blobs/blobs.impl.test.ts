/**
 * Tests for BlobsImpl using MemoryRawStorage
 *
 * Runs conformance tests against the new Blobs implementation.
 */

import { createBlobs } from "../../../src/history/blobs/blobs.impl.js";
import type { Blobs } from "../../../src/history/blobs/blobs.js";
import { createGitObjectStore } from "../../../src/history/objects/index.js";
import { MemoryRawStorage } from "../../../src/storage/raw/memory-raw-storage.js";
import { blobsConformanceTests } from "./blobs.conformance.test.js";

let storage: MemoryRawStorage;

blobsConformanceTests(
  "BlobsImpl",
  async (): Promise<Blobs> => {
    storage = new MemoryRawStorage();
    return createBlobs(createGitObjectStore(storage));
  },
  async (): Promise<void> => {
    storage.clear();
  },
);
