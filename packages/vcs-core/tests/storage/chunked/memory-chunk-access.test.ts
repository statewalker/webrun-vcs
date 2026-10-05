import { MemoryChunkAccess } from "../../../src/storage/chunked/index.js";
import { chunkAccessConformanceTests } from "./chunk-access.conformance.test.js";

let access: MemoryChunkAccess;

chunkAccessConformanceTests(
  "MemoryChunkAccess",
  async () => {
    access = new MemoryChunkAccess();
    return access;
  },
  async () => {
    access.clear();
  },
);
