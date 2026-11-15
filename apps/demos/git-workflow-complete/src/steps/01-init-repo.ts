/**
 * Step 01: Initialize Repository with Git.init()
 *
 * Creates a new Git repository using the porcelain Git.init() command
 * with FilesApi for filesystem operations.
 */

import { Git } from "@statewalker/vcs-commands";
import { FileStagingStore } from "@statewalker/vcs-store-files";
import {
  cleanupRepo,
  createFilesApi,
  createRepoDir,
  GIT_DIR,
  log,
  logInfo,
  logSection,
  REPO_DIR,
  state,
} from "../shared/index.js";

export async function run(): Promise<void> {
  logSection("Step 01: Initialize Repository with Git.init()");

  log("Cleaning up any existing repository...");
  await cleanupRepo();

  log("Creating repository directory...");
  await createRepoDir();

  log("Initializing Git repository with Git.init()...");
  const files = createFilesApi();

  // Use FileStagingStore for native git compatibility
  const staging = new FileStagingStore(files, `${GIT_DIR}/index`);

  // Initialize repository using porcelain Git.init()
  const result = await Git.init()
    .setFilesApi(files)
    .setDirectory("")
    .setGitDir(GIT_DIR)
    .setInitialBranch("main")
    .setStagingStore(staging)
    .setWorktree(true)
    .call();

  // Store in shared state
  state.repository = result.repository;
  state.git = result.git;
  state.files = files;

  logInfo("Repository created at", REPO_DIR);
  logInfo("Git directory", `${REPO_DIR}/${GIT_DIR}`);
  logInfo("Default branch", result.initialBranch);

  log("Repository initialization complete!");
}
