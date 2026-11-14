import { createAtomicFilesTests } from "@statewalker/vcs-testing";
import { atomicFilesOver, createInMemoryFilesApi } from "@statewalker/vcs-utils/files";

createAtomicFilesTests("FilesApi fallback (in memory)", async () => ({
  files: atomicFilesOver(createInMemoryFilesApi(), "/repo/.git"),
}));
