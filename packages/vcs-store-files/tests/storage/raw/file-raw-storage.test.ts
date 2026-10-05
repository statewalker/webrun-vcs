import { createInMemoryFilesApi, type FilesApi } from "@statewalker/vcs-core";
import { rawStorageConformanceTests } from "../../../../vcs-core/tests/storage/raw/raw-storage.conformance.test.js";
import { FileRawStorage } from "../../../src/storage/raw/index.js";

let files: FilesApi;

rawStorageConformanceTests(
  "FileRawStorage",
  async () => {
    files = createInMemoryFilesApi();
    return new FileRawStorage(files, "/objects", { compress: false });
  },
  async () => {
    // createInMemoryFilesApi cleanup is automatic (new instance each test)
  },
);
