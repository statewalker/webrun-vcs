/**
 * Repository controller - manages Git repository operations.
 *
 * Handles:
 * - Initializing a new repository
 * - Adding files
 * - Creating commits
 * - Staging operations
 * - Refreshing repository state
 *
 * Uses the porcelain Git API from @statewalker/vcs-commands.
 */

import type { Git } from "@statewalker/vcs-commands";
import {
  listenAddFileAction,
  listenCheckoutAction,
  listenCreateCommitAction,
  listenInitRepoAction,
  listenOpenRepoAction,
  listenRefreshRepoAction,
  listenStageAllAction,
  listenStageFileAction,
  listenUnstageFileAction,
} from "../actions/index.js";
import { getIntents, runOpenRepositoryIntent } from "../intents/index.js";
import {
  type CommitEntry,
  type FileEntry,
  getActivityLogModel,
  getRepositoryModel,
  getUserActionsModel,
} from "../models/index.js";
import { newRegistry } from "../utils/index.js";
import type { AppContext } from "./index.js";
import {
  getGit,
  getHistory,
  getWorktree,
  initializeGitFromFiles,
  setStorageLabel,
} from "./index.js";

/**
 * Create the repository controller.
 *
 * @param ctx The application context
 * @returns Cleanup function
 */
export function createRepositoryController(ctx: AppContext): () => void {
  const [register, cleanup] = newRegistry();

  // Get models
  const repoModel = getRepositoryModel(ctx);
  const logModel = getActivityLogModel(ctx);
  const actionsModel = getUserActionsModel(ctx);

  // Repository operations run one at a time, in the order they were asked for: a
  // checkout after a received push must have written the index before a following
  // refresh or add reads it (otherwise a commit made right after can drop pushed files).
  let queue: Promise<void> = Promise.resolve();
  function serialized(operation: () => Promise<void>): void {
    queue = queue.then(operation, operation);
  }

  // Listen to user actions via typed action adapters
  register(
    listenInitRepoAction(actionsModel, () => {
      serialized(() => handleInit());
    }),
  );

  register(
    listenRefreshRepoAction(actionsModel, () => {
      serialized(() => handleRefresh());
    }),
  );

  register(
    listenCheckoutAction(actionsModel, () => {
      serialized(() => handleCheckoutHead());
    }),
  );

  register(
    listenAddFileAction(actionsModel, (actions) => {
      for (const { name, content } of actions) {
        serialized(() => handleAddFile(name, content));
      }
    }),
  );

  register(
    listenCreateCommitAction(actionsModel, (actions) => {
      for (const { message } of actions) {
        serialized(() => handleCommit(message));
      }
    }),
  );

  register(
    listenStageFileAction(actionsModel, (actions) => {
      for (const { path } of actions) {
        serialized(() => handleStageFile(path));
      }
    }),
  );

  register(
    listenUnstageFileAction(actionsModel, (actions) => {
      for (const { path } of actions) {
        serialized(() => handleUnstageFile(path));
      }
    }),
  );

  register(
    listenStageAllAction(actionsModel, () => {
      serialized(() => handleStageAll());
    }),
  );

  register(
    listenOpenRepoAction(actionsModel, () => {
      serialized(() => handleOpenRepository());
    }),
  );

  // ============ File Helper Methods ============

  /**
   * Write a file to the working directory (in-memory worktree).
   */
  async function writeFile(path: string, content: string): Promise<void> {
    const worktree = getWorktree(ctx);
    if (!worktree) throw new Error("Worktree not initialized");
    const encoder = new TextEncoder();
    await worktree.writeContent(path, encoder.encode(content));
  }

  // ============ Action Handlers ============

  /**
   * Open a repository from persistent storage via the intent system.
   */
  async function handleOpenRepository(): Promise<void> {
    try {
      const intents = getIntents(ctx);
      const intent = runOpenRepositoryIntent(intents, { title: "Select project folder" });

      if (!intent.resolved) {
        logModel.error("No handler resolved the open-repository intent");
        return;
      }

      const { files, label } = await intent.promise;

      // Re-initialize git infrastructure from the selected folder
      await initializeGitFromFiles(ctx, files);
      setStorageLabel(ctx, label);

      logModel.info(`Opened repository: ${label}`);

      // Refresh repository state
      const git = getGit(ctx);
      if (git) {
        await refreshRepositoryState(git);
      }
    } catch (error) {
      logModel.error(`Failed to open repository: ${(error as Error).message}`);
    }
  }

  /**
   * Initialize the repository with an initial commit.
   */
  async function handleInit(): Promise<void> {
    const git = getGit(ctx);
    if (!git) {
      logModel.error("Git not initialized");
      return;
    }

    try {
      logModel.info("Initializing repository...");

      // Write initial README to working directory
      await writeFile("README.md", "# My Repository\n\nInitialized via WebRTC P2P sync demo.\n");

      // Stage the file
      await git.add().addFilepattern("README.md").call();

      // Create initial commit
      const result = await git
        .commit()
        .setMessage("Initial commit")
        .setAuthor("Demo User", "demo@example.com")
        .call();

      logModel.info(`Repository initialized with commit ${result.id.slice(0, 8)}`);

      // Refresh state
      await refreshRepositoryState(git);
    } catch (error) {
      logModel.error(`Failed to initialize repository: ${(error as Error).message}`);
    }
  }

  /**
   * Refresh repository state from storage.
   */
  async function handleRefresh(): Promise<void> {
    const git = getGit(ctx);
    if (!git) {
      logModel.warn("No repository to refresh");
      return;
    }

    await refreshRepositoryState(git);
  }

  /**
   * Checkout main branch - update working directory from current main branch.
   * Uses the porcelain checkout API to write files to the working directory.
   *
   * Note: We checkout "main" instead of "HEAD" because checkout("HEAD") would
   * detach HEAD, breaking subsequent syncs. The sync controller updates
   * refs/heads/main, so we need to checkout that branch directly.
   */
  async function handleCheckoutHead(): Promise<void> {
    const git = getGit(ctx);
    if (!git) {
      logModel.warn("Repository not initialized for checkout");
      return;
    }
    try {
      // The sync moved refs/heads/main under HEAD: a plain checkout of the branch HEAD
      // already names changes nothing (git's two-way merge); `checkout -f` writes its tree.
      await git.checkout().setName("main").setForced(true).call();
      logModel.info("Checked out main branch to working directory");
      await refreshRepositoryState(git);
    } catch (error) {
      logModel.error(`Failed to checkout main: ${(error as Error).message}`);
    }
  }

  /**
   * Add a file to the repository (write, stage, and commit).
   */
  async function handleAddFile(name: string, content: string): Promise<void> {
    const git = getGit(ctx);
    if (!git) {
      logModel.error("No repository initialized");
      return;
    }

    try {
      // Write file to working directory
      await writeFile(name, content);

      // Stage the file
      await git.add().addFilepattern(name).call();

      // Commit
      const result = await git
        .commit()
        .setMessage(`Add ${name}`)
        .setAuthor("Demo User", "demo@example.com")
        .call();

      logModel.info(`Added ${name} in commit ${result.id.slice(0, 8)}`);

      // Refresh state
      await refreshRepositoryState(git);
    } catch (error) {
      logModel.error(`Failed to add file: ${(error as Error).message}`);
    }
  }

  /**
   * Create a commit with staged changes.
   */
  async function handleCommit(message: string): Promise<void> {
    const git = getGit(ctx);
    if (!git) {
      logModel.error("No repository initialized");
      return;
    }

    try {
      // Check if there are staged changes (unstaged and untracked files are not committed)
      const status = await git.status().call();
      if (status.added.size + status.changed.size + status.removed.size === 0) {
        logModel.warn("Nothing staged to commit");
        return;
      }

      // Create commit
      const result = await git
        .commit()
        .setMessage(message)
        .setAuthor("Demo User", "demo@example.com")
        .call();

      logModel.info(`Created commit ${result.id.slice(0, 8)}: ${message}`);

      // Refresh state
      await refreshRepositoryState(git);
    } catch (error) {
      logModel.error(`Failed to commit: ${(error as Error).message}`);
    }
  }

  // ============ Staging Operations ============

  /**
   * Stage a file.
   */
  async function handleStageFile(path: string): Promise<void> {
    const git = getGit(ctx);
    if (!git) return;

    try {
      await git.add().addFilepattern(path).call();
      logModel.info(`Staged ${path}`);
      await refreshRepositoryState(git);
    } catch (error) {
      logModel.error(`Failed to stage ${path}: ${(error as Error).message}`);
    }
  }

  /**
   * Unstage a file.
   */
  async function handleUnstageFile(path: string): Promise<void> {
    const git = getGit(ctx);
    if (!git) return;

    try {
      await git.reset().addPath(path).call();
      logModel.info(`Unstaged ${path}`);
      await refreshRepositoryState(git);
    } catch (error) {
      logModel.error(`Failed to unstage ${path}: ${(error as Error).message}`);
    }
  }

  /**
   * Stage all files.
   */
  async function handleStageAll(): Promise<void> {
    const git = getGit(ctx);
    if (!git) return;

    try {
      await git.add().addFilepattern(".").call();
      logModel.info("Staged all changes");
      await refreshRepositoryState(git);
    } catch (error) {
      logModel.error(`Failed to stage all: ${(error as Error).message}`);
    }
  }

  // ============ State Refresh ============

  /**
   * Update repository model from current state.
   */
  async function refreshRepositoryState(git: Git): Promise<void> {
    const history = getHistory(ctx);

    if (!history) {
      logModel.error("Repository infrastructure not initialized");
      return;
    }

    try {
      // Get commit log
      const commits: CommitEntry[] = [];
      try {
        for await (const commit of await git.log().call()) {
          commits.push({
            id: commit.id,
            message: commit.message,
            author: commit.author.name,
            timestamp: new Date(commit.author.timestamp * 1000),
          });
        }
      } catch {
        // No commits yet - that's okay
      }

      // Get current branch from HEAD
      let currentBranch = "main";
      try {
        const headRef = await history.refs.get("HEAD");
        if (headRef && "target" in headRef && headRef.target) {
          // HEAD is symbolic ref pointing to a branch
          const branchName = headRef.target.replace("refs/heads/", "");
          currentBranch = branchName;
        }
      } catch {
        // No branches yet
      }

      // Get files from HEAD tree (recursive)
      const fileList: FileEntry[] = [];
      if (commits.length > 0) {
        const headCommit = await history.commits.load(commits[0].id);
        if (headCommit?.tree) {
          await collectFilesFromTree(history, headCommit.tree, "", fileList);
        }
      }
      // Sort files: directories first, then alphabetically by path
      fileList.sort((a, b) => {
        if (a.type === "directory" && b.type !== "directory") return -1;
        if (a.type !== "directory" && b.type === "directory") return 1;
        return a.path.localeCompare(b.path);
      });

      // Get staging status
      // Note: Status shows staged changes vs HEAD (added, changed, removed)
      // We don't have working tree tracking in this demo, so unstaged/untracked are empty
      let staged: string[] = [];
      const unstaged: string[] = [];
      const untracked: string[] = [];
      try {
        const status = await git.status().call();
        // Combine added and changed as "staged"
        staged = [...Array.from(status.added), ...Array.from(status.changed)];
      } catch {
        // Status might fail if no commits
      }

      // Update model
      repoModel.update({
        initialized: commits.length > 0,
        branch: currentBranch,
        commitCount: commits.length,
        files: fileList,
        headCommitId: commits[0]?.id ?? null,
        commits,
        staged,
        unstaged,
        untracked,
      });
    } catch (error) {
      logModel.error(`Failed to refresh repository: ${(error as Error).message}`);
    }
  }

  return cleanup;
}

/**
 * Recursively collect files from a tree.
 *
 * @param history The history store to read trees from
 * @param treeId The tree ID to read
 * @param basePath The base path for entries in this tree
 * @param fileList The array to append entries to
 */
async function collectFilesFromTree(
  history: {
    trees: {
      load(
        id: string,
      ): Promise<AsyncIterable<{ name: string; mode: number; id: string }> | undefined>;
    };
  },
  treeId: string,
  basePath: string,
  fileList: FileEntry[],
): Promise<void> {
  const entries = await history.trees.load(treeId);
  if (!entries) return;
  for await (const entry of entries) {
    const fullPath = basePath ? `${basePath}/${entry.name}` : entry.name;
    const isDirectory = entry.mode === 0o040000;

    fileList.push({
      name: entry.name,
      path: fullPath,
      type: isDirectory ? "directory" : "file",
      mode: entry.mode,
      id: entry.id,
    });

    // Recursively process subdirectories
    if (isDirectory) {
      await collectFilesFromTree(history, entry.id, fullPath, fileList);
    }
  }
}
