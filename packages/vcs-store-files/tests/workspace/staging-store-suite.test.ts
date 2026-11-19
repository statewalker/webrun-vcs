/**
 * The Staging contract suite (vcs-testing's `createStagingStoreTests`) for the two
 * index-file backed stagings: `FileStagingStore` and vcs-working-tree's `GitStaging` (run
 * here, as vcs-working-tree cannot depend on vcs-testing).
 */
import { createInMemoryFilesApi } from "@statewalker/vcs-core";
import { createGitFilesBackend, FileStagingStore } from "@statewalker/vcs-store-files";
import { createStagingStoreTests } from "@statewalker/vcs-testing";
import { createGitStaging } from "@statewalker/vcs-working-tree";

createStagingStoreTests("FileStagingStore", async () => {
  const files = createInMemoryFilesApi();
  const { history } = await createGitFilesBackend({ files });
  return { stagingStore: new FileStagingStore(files, ".git/index"), trees: history.trees };
});

createStagingStoreTests("GitStaging", async () => {
  const files = createInMemoryFilesApi();
  const { history } = await createGitFilesBackend({ files });
  return { stagingStore: createGitStaging(files, ".git/index"), trees: history.trees };
});
