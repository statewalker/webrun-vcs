/**
 * Opens the repository git's setup arrives at, at the paths the environment's repository
 * variables give: `$GIT_DIR`, `$GIT_WORK_TREE`, `$GIT_COMMON_DIR`, `$GIT_INDEX_FILE` and
 * `$GIT_OBJECT_DIRECTORY`, as a git command run in the same place would use them.
 */

import type { FilesApi } from "@statewalker/vcs-core";
import type { WorktreeAdmin } from "@statewalker/vcs-working-tree";

import { createGitFilesBackend, type GitFilesBackendResult } from "./create-git-files-backend.js";
import {
  commonDirWithoutEnvironment,
  type DiscoverRepositoryOptions,
  type GitDirectorySetup,
  setupGitDirectory,
} from "./safety/index.js";
import {
  type GitLinkedWorktrees,
  openGitLinkedWorktrees,
} from "./workspace/linked-worktrees/index.js";

/** Options of {@link openRepositoryFromEnvironment}. */
export interface OpenRepositoryFromEnvironmentOptions extends DiscoverRepositoryOptions {
  /** The storage the repository is in (its root is usually the host's `/`) */
  files: FilesApi;
  /** Which include directives of the repository's config are followed (default git's) */
  configIncludes?: boolean | "files";
}

/** The repository {@link openRepositoryFromEnvironment} opened. */
export interface RepositoryFromEnvironment {
  /** git's setup: git directory, common directory, worktree, prefix, index and objects */
  setup: GitDirectorySetup;
  /**
   * The stores: the refs of the `commondir` file's common directory (git's files ref store
   * ignores `$GIT_COMMON_DIR`), the objects of `setup.objectDirectory` (which follows it)
   */
  backend: GitFilesBackendResult;
  /** The repository's worktrees, seen from `setup.gitDir` */
  worktrees: GitLinkedWorktrees;
  /**
   * The current working copy (index `setup.indexFile`, worktree `setup.workTree`), or, for
   * a repository without a worktree, its history and configuration alone
   */
  admin: WorktreeAdmin;
}

/**
 * Finds the repository as git's `setup_git_directory_gently` does ({@link setupGitDirectory}:
 * discovery with its ownership, `safe.bareRepository`, ceiling and file-system checks, or
 * `$GIT_DIR` as given) and opens it where the variables put its parts: the objects at
 * `$GIT_OBJECT_DIRECTORY` (a pre-receive hook's quarantine; the alternates and
 * `$GIT_ALTERNATE_OBJECT_DIRECTORIES` read from there), else `<$GIT_COMMON_DIR>/objects`;
 * the refs, as git's files ref store reads them, in the `commondir` file's common directory
 * whatever `$GIT_COMMON_DIR` says (its config too: a divergence where the two differ); the index at `$GIT_INDEX_FILE` (`index.lock` in a `commit -a`
 * pre-commit hook, `next-index-*.lock` under `commit --only`) and the worktree at
 * `$GIT_WORK_TREE`. This is the opener for a tool that runs where git does (a hook, a git
 * alias, a program started with git's variables); a server opening other people's
 * repositories uses `Worktree.openRepository`, which never reads these variables.
 *
 * @example
 * ```typescript
 * const environment = createNodeGitHostEnvironment(); // inside a pre-commit hook
 * const files = createNodeFilesApi({ rootDir: "/" });
 * const { admin } = await openRepositoryFromEnvironment({ files, cwd: process.cwd(), environment });
 * const git = Git.fromWorkingCopy(admin as WorkingCopy); // its index is GIT_INDEX_FILE
 * ```
 */
export async function openRepositoryFromEnvironment(
  options: OpenRepositoryFromEnvironmentOptions,
): Promise<RepositoryFromEnvironment> {
  const { files, environment } = options;
  const setup = await setupGitDirectory(options);
  const includes =
    options.configIncludes === undefined ? {} : { configIncludes: options.configIncludes };
  const backend = await createGitFilesBackend({
    files,
    gitDir: await commonDirWithoutEnvironment(files, setup.gitDir),
    objectsDir: setup.objectDirectory,
    // relative $GIT_ALTERNATE_OBJECT_DIRECTORIES entries: from where git's setup went
    workTree: setup.cwd,
    ...(environment ? { environment } : {}),
    ...includes,
  });
  const worktrees = await openGitLinkedWorktrees({
    files,
    gitDir: setup.gitDir,
    indexFile: setup.indexFile,
    history: backend.history,
    ...(setup.workTree !== undefined
      ? { workTree: setup.workTree, currentWorkTree: setup.workTree }
      : {}),
    ...(environment ? { environment } : {}),
    ...(options.configIncludes === undefined ? {} : { includes: options.configIncludes }),
  });
  const admin = await worktrees.openAdmin();
  return { setup, backend, worktrees, admin };
}
