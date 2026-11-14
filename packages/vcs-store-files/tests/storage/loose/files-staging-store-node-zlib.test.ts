/**
 * The object kernel contract under the `node:zlib` compression set, which test
 * setups and Node apps register process-wide (vitest isolates each file).
 */
import { createGitObjects } from "@statewalker/vcs-core";
import { createGitObjectsTests } from "@statewalker/vcs-testing";
import { setCompressionUtils } from "@statewalker/vcs-utils/compression";
import { createInMemoryFilesApi } from "@statewalker/vcs-utils/files";
import { createNodeCompression } from "@statewalker/vcs-utils-node/compression";
import { filesStagingStore } from "../../../src/storage/loose/index.js";

setCompressionUtils(createNodeCompression());

createGitObjectsTests("Files (in memory, node:zlib)", async () => {
  const store = filesStagingStore(createInMemoryFilesApi(), "/repo/.git/objects");
  return { objects: createGitObjects(store), store };
});
