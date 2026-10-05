/**
 * File-based StashStore implementation using Git's refs/stash.
 *
 * Design:
 * - Interface accessed via WorkingCopy.stash
 * - Storage: Central .git/refs/stash for Git compatibility
 * - Uses reflog for stash history (.git/logs/refs/stash)
 *
 * Stash commit structure:
 * - Tree: working tree state (all tracked files)
 * - Parent 1: HEAD at time of stash
 * - Parent 2: commit of current index state
 */

import type { History, ObjectId, PersonIdent, TreeEntry } from "@statewalker/vcs-core";
import type {
  Staging,
  StashEntry,
  StashPushOptions,
  StashStore,
  Worktree,
} from "@statewalker/vcs-working-tree";

/**
 * Files API subset needed for stash operations
 */
export interface StashFilesApi {
  read(path: string): Promise<Uint8Array | undefined>;
  write(path: string, content: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

/**
 * Extended options for creating GitStashStore with full push/apply support.
 */
export interface GitStashStoreOptions {
  /** History interface for object storage */
  history: History;
  /** Staging area for index state */
  staging: Staging;
  /** Working tree iterator for reading files */
  worktree: Worktree;
  /** Files API for stash metadata */
  files: StashFilesApi;
  /** Path to .git directory */
  gitDir: string;
  /** Function to get current HEAD commit ID */
  getHead: () => Promise<ObjectId | undefined>;
  /** Function to get current branch name */
  getBranch: () => Promise<string | undefined>;
  /** Default author for stash commits */
  author?: PersonIdent;
}

/**
 * Git-compatible stash store implementation.
 *
 * A stash commit has 2-3 parents:
 * - Parent 1: HEAD at time of stash
 * - Parent 2: Index state commit
 * - Parent 3 (optional): Untracked files commit
 *
 * Tree contains working tree state.
 */
export class GitStashStore implements StashStore {
  private readonly history: History;
  private readonly staging: Staging;
  private readonly worktree: Worktree;
  private readonly files: StashFilesApi;
  private readonly gitDir: string;
  private readonly getHead: () => Promise<ObjectId | undefined>;
  private readonly getBranch: () => Promise<string | undefined>;
  private readonly defaultAuthor: PersonIdent;

  constructor(options: GitStashStoreOptions) {
    this.history = options.history;
    this.staging = options.staging;
    this.worktree = options.worktree;
    this.files = options.files;
    this.gitDir = options.gitDir;
    this.getHead = options.getHead;
    this.getBranch = options.getBranch;
    this.defaultAuthor = options.author ?? {
      name: "Git Stash",
      email: "stash@localhost",
      timestamp: Date.now(),
      tzOffset: "+0000",
    };
  }

  /**
   * List all stash entries from reflog.
   * Entries are yielded in order (stash@{0} first).
   */
  async *list(): AsyncIterable<StashEntry> {
    const reflogPath = `${this.gitDir}/logs/refs/stash`;
    const content = await this.files.read(reflogPath);
    if (!content) return;

    const lines = new TextDecoder().decode(content).trim().split("\n");

    // Reflog entries are newest-last, so reverse for stash order
    for (let i = lines.length - 1; i >= 0; i--) {
      const entry = parseReflogEntry(lines[i], lines.length - 1 - i);
      if (entry) yield entry;
    }
  }

  /**
   * Push current changes to stash.
   *
   * Creates a special stash commit with:
   * - Tree: current working tree state
   * - Parent 1: current HEAD
   * - Parent 2: commit of current index state
   * - Parent 3 (optional): untracked files commit
   */
  async push(messageOrOptions?: string | StashPushOptions): Promise<ObjectId> {
    // Parse options
    const options: StashPushOptions =
      typeof messageOrOptions === "string"
        ? { message: messageOrOptions }
        : (messageOrOptions ?? {});

    const head = await this.getHead();
    if (!head) {
      throw new Error("Cannot stash: no commits in repository");
    }

    const branch = (await this.getBranch()) ?? "HEAD";
    const now = Date.now();
    const author: PersonIdent = {
      ...this.defaultAuthor,
      timestamp: now,
    };

    // 1. Create tree from index (this is what stash stores)
    const indexTree = await this.staging.writeTree(this.history.trees);

    // 2. Create index state commit (parent = HEAD)
    const indexCommitId = await this.history.commits.store({
      tree: indexTree,
      parents: [head],
      author,
      committer: author,
      message: `index on ${branch}: WIP`,
    });

    // 3. Create worktree tree by merging index with worktree changes
    const worktreeTree = await this.createWorktreeTree(indexTree);

    // 4. Build parents array
    const parents: ObjectId[] = [head, indexCommitId];

    // 5. If includeUntracked, create untracked files commit (3rd parent)
    if (options.includeUntracked) {
      const untrackedCommitId = await this.createUntrackedFilesCommit(author, branch);
      if (untrackedCommitId) {
        parents.push(untrackedCommitId);
      }
    }

    // 6. Create stash commit
    const stashMessage = options.message ?? `WIP on ${branch}`;
    const stashCommitId = await this.history.commits.store({
      tree: worktreeTree,
      parents,
      author,
      committer: author,
      message: stashMessage,
    });

    // 7. Get old stash ref for reflog
    const oldStash = await this.getStashRef();

    // 8. Update refs/stash
    await this.ensureDir(`${this.gitDir}/refs`);
    await this.files.write(
      `${this.gitDir}/refs/stash`,
      new TextEncoder().encode(`${stashCommitId}\n`),
    );

    // 9. Add reflog entry
    await this.addReflogEntry(
      oldStash ?? "0000000000000000000000000000000000000000",
      stashCommitId,
      author,
      `stash: ${stashMessage}`,
    );

    return stashCommitId;
  }

  /**
   * Create a commit containing only untracked files.
   *
   * This is the 3rd parent of a stash when --include-untracked is used.
   * The commit has no parents (orphan commit).
   *
   * @returns Commit ID, or undefined if no untracked files
   */
  private async createUntrackedFilesCommit(
    author: PersonIdent,
    branch: string,
  ): Promise<ObjectId | undefined> {
    // Collect set of tracked paths from index
    const trackedPaths = new Set<string>();
    for await (const entry of this.staging.entries()) {
      trackedPaths.add(entry.path);
    }

    // Walk working tree to find untracked files
    const untrackedEntries: TreeEntry[] = [];
    for await (const wtEntry of this.worktree.walk()) {
      if (wtEntry.isDirectory || wtEntry.isIgnored) {
        continue;
      }

      // Check if file is tracked
      if (!trackedPaths.has(wtEntry.path)) {
        // Store blob content
        const blobId = await this.history.blobs.store(this.worktree.readContent(wtEntry.path));
        untrackedEntries.push({
          name: wtEntry.path,
          mode: wtEntry.mode,
          id: blobId,
        });
      }
    }

    if (untrackedEntries.length === 0) {
      return undefined;
    }

    // Create tree with untracked files
    const untrackedTree = await this.history.trees.store(untrackedEntries);

    // Create orphan commit (no parents)
    return this.history.commits.store({
      tree: untrackedTree,
      parents: [],
      author,
      committer: author,
      message: `untracked files on ${branch}`,
    });
  }

  /**
   * Create worktree tree by checking for modifications.
   * For now, uses the index tree. Full implementation would
   * scan worktree for modifications and create blobs.
   */
  private async createWorktreeTree(indexTree: ObjectId): Promise<ObjectId> {
    // Collect all entries, checking for worktree modifications
    const entries: TreeEntry[] = [];

    const indexTreeEntries = await this.history.trees.load(indexTree);
    if (!indexTreeEntries) {
      return this.history.trees.store([]);
    }

    for await (const entry of indexTreeEntries) {
      // Get worktree file content if it exists
      const wtEntry = await this.worktree.getEntry(entry.name);
      if (wtEntry && !wtEntry.isDirectory) {
        // Check if modified by computing hash
        const wtHash = await this.worktree.computeHash(entry.name);
        if (wtHash !== entry.id) {
          // File is modified, store new content
          const blobId = await this.history.blobs.store(this.worktree.readContent(entry.name));
          entries.push({ ...entry, id: blobId });
        } else {
          entries.push(entry);
        }
      } else {
        entries.push(entry);
      }
    }

    // Create new tree if any modifications, otherwise return original
    if (entries.length > 0) {
      return this.history.trees.store(entries);
    }
    return indexTree;
  }

  /**
   * Pop most recent stash entry.
   * Applies stash@{0} and removes it.
   */
  async pop(): Promise<void> {
    await this.apply(0);
    await this.drop(0);
  }

  /**
   * Apply stash entry without removing it.
   */
  async apply(index = 0): Promise<void> {
    const stashCommit = await this.getStashCommit(index);
    if (!stashCommit) {
      throw new Error(`stash@{${index}} does not exist`);
    }

    // Get stash tree
    const stashTree = await this.history.commits.getTree(stashCommit);
    if (!stashTree) {
      throw new Error(`Stash tree not found for commit ${stashCommit}`);
    }

    // Restore index from stash tree
    await this.staging.readTree(this.history.trees, stashTree);
  }

  /**
   * Get stash commit at given index.
   */
  private async getStashCommit(index: number): Promise<ObjectId | undefined> {
    let current = 0;
    for await (const entry of this.list()) {
      if (current === index) {
        return entry.commitId;
      }
      current++;
    }
    return undefined;
  }

  /**
   * Drop a stash entry.
   */
  async drop(index = 0): Promise<void> {
    const reflogPath = `${this.gitDir}/logs/refs/stash`;
    const content = await this.files.read(reflogPath);
    if (!content) return;

    const lines = new TextDecoder().decode(content).trim().split("\n");
    const targetLine = lines.length - 1 - index;

    if (targetLine < 0 || targetLine >= lines.length) {
      throw new Error(`stash@{${index}} does not exist`);
    }

    // Remove the line
    lines.splice(targetLine, 1);

    if (lines.length === 0) {
      // No more stash entries, clean up
      await this.clear();
    } else {
      // Update reflog
      await this.files.write(reflogPath, new TextEncoder().encode(`${lines.join("\n")}\n`));

      // Update refs/stash to point to new top
      const topEntry = parseReflogEntry(lines[lines.length - 1], 0);
      if (topEntry) {
        await this.files.write(
          `${this.gitDir}/refs/stash`,
          new TextEncoder().encode(`${topEntry.commitId}\n`),
        );
      }
    }
  }

  /**
   * Clear all stash entries.
   */
  async clear(): Promise<void> {
    await this.files.remove(`${this.gitDir}/refs/stash`);
    await this.files.remove(`${this.gitDir}/logs/refs/stash`);
  }

  /**
   * Get current stash ref.
   */
  private async getStashRef(): Promise<ObjectId | undefined> {
    const content = await this.files.read(`${this.gitDir}/refs/stash`);
    if (!content) return undefined;
    return new TextDecoder().decode(content).trim();
  }

  /**
   * Add a reflog entry.
   */
  private async addReflogEntry(
    oldSha: ObjectId,
    newSha: ObjectId,
    author: PersonIdent,
    message: string,
  ): Promise<void> {
    const reflogPath = `${this.gitDir}/logs/refs/stash`;

    // Ensure logs/refs directory exists
    await this.ensureDir(`${this.gitDir}/logs`);
    await this.ensureDir(`${this.gitDir}/logs/refs`);

    // Format: <old-sha> <new-sha> <author> <timestamp> <timezone>\t<message>
    const timestamp = Math.floor(author.timestamp / 1000);
    const line = `${oldSha} ${newSha} ${author.name} <${author.email}> ${timestamp} ${author.tzOffset}\t${message}\n`;

    // Append to existing reflog
    const existing = await this.files.read(reflogPath);
    const content = existing
      ? new TextEncoder().encode(new TextDecoder().decode(existing) + line)
      : new TextEncoder().encode(line);

    await this.files.write(reflogPath, content);
  }

  /**
   * Ensure directory exists.
   */
  private async ensureDir(path: string): Promise<void> {
    const exists = await this.files.exists(path);
    if (!exists) {
      await this.files.mkdir(path);
    }
  }
}

/**
 * Parse a reflog entry line.
 *
 * Format: <old-sha> <new-sha> <author> <timestamp> <timezone>\t<message>
 */
function parseReflogEntry(line: string, index: number): StashEntry | undefined {
  if (!line.trim()) return undefined;

  const tabIndex = line.indexOf("\t");
  if (tabIndex === -1) return undefined;

  const header = line.substring(0, tabIndex);
  const message = line.substring(tabIndex + 1);

  const parts = header.split(" ");
  if (parts.length < 5) return undefined;

  const newSha = parts[1];
  const timestamp = parseInt(parts[parts.length - 2], 10);

  return {
    index,
    commitId: newSha,
    message: message.replace(/^stash:\s*/, ""),
    timestamp: timestamp * 1000, // Convert to milliseconds
  };
}

/**
 * Create a GitStashStore instance with full push/apply support.
 */
export function createGitStashStore(options: GitStashStoreOptions): StashStore {
  return new GitStashStore(options);
}
