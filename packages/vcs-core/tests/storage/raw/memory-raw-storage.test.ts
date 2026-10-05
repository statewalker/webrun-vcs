import { MemoryRawStorage } from "../../../src/storage/raw/index.js";
import { rawStorageConformanceTests } from "./raw-storage.conformance.test.js";

let storage: MemoryRawStorage;

rawStorageConformanceTests(
  "MemoryRawStorage",
  async () => {
    storage = new MemoryRawStorage();
    return storage;
  },
  async () => {
    storage.clear();
  },
);
