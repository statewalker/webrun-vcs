/**
 * StashStore over git's `refs/stash` and its reflog, as `git stash` keeps them.
 *
 * - `refs/stash` points at the newest stash commit; the reflog of `refs/stash`
 *   (`logs/refs/stash` on git files) holds every stash, `stash@{0}` newest.
 * - Every write goes through the repository's ref store (`history.refs`), so on git
 *   files it takes git's locks: push is a one-ref batch under `refs/stash.lock` that
 *   creates the reflog (git's REF_FORCE_CREATE_REFLOG) and appends its line under the
 *   lock; drop is `git reflog delete --rewrite --updateref refs/stash@{n}` under
 *   `refs/stash.lock` and `logs/refs/stash.lock`; clearing deletes the ref and its log.
 *   Native git sees our stashes (`git stash list`, `git stash show`) and we see its own.
 *
 * Stash commit structure (as git's):
 * - Tree: working tree state (tracked files)
 * - Parent 1: HEAD at the time of the stash
 * - Parent 2: commit of the index state ("index on <branch>: …")
 * - Parent 3 (optional): commit of the untracked files
 */

import {
  formatPersonIdent,
  type History,
  isSymbolicRef,
  type ObjectId,
  type PersonIdent,
  type Refs,
  type TreeEntry,
} from "@statewalker/vcs-core";
import type {
  Staging,
  StashEntry,
  StashPushOptions,
  StashStore,
  Worktree,
} from "@statewalker/vcs-working-tree";
import { storeWorktreeFile } from "@statewalker/vcs-working-tree";
import { RefUpdateRejectedError } from "../../refs/index.js";

/** git's stash ref. */
export const STASH_REF = "refs/stash";

/**
 * Options for creating GitStashStore with full push/apply support.
 */
export interface GitStashStoreOptions {
  /** History: objects, and the ref store that holds `refs/stash` and its reflog */
  history: History;
  /** Staging area for index state */
  staging: Staging;
  /** Working tree iterator for reading files */
  worktree: Worktree;
  /** Function to get current HEAD commit ID */
  getHead: () => Promise<ObjectId | undefined>;
  /** Function to get current branch name */
  getBranch: () => Promise<string | undefined>;
  /** Identity of stash commits and reflog lines (the time is taken at each push) */
  author?: Omit<PersonIdent, "timestamp">;
}

/**
 * Git-compatible stash store: `refs/stash` and its reflog in the history's ref store.
 */
export class GitStashStore implements StashStore {
  private readonly history: History;
  private readonly staging: Staging;
  private readonly worktree: Worktree;
  private readonly getHead: () => Promise<ObjectId | undefined>;
  private readonly getBranch: () => Promise<string | undefined>;
  private readonly defaultAuthor: Omit<PersonIdent, "timestamp">;

  constructor(options: GitStashStoreOptions) {
    this.history = options.history;
    this.staging = options.staging;
    this.worktree = options.worktree;
    this.getHead = options.getHead;
    this.getBranch = options.getBranch;
    this.defaultAuthor = options.author ?? {
      name: "Git Stash",
      email: "stash@localhost",
      tzOffset: "+0000",
    };
  }

  private get refs(): Refs {
    return this.history.refs;
  }

  /**
   * List the stash entries from the reflog of `refs/stash`, `stash@{0}` first. The
   * message is the reflog message, as `git stash list` shows it.
   */
  async *list(): AsyncIterable<StashEntry> {
    const reflog = await this.refs.getReflog?.(STASH_REF);
    if (!reflog) return;
    const entries = await reflog.getReverseEntries();
    for (const [index, entry] of entries.entries()) {
      yield {
        index,
        commitId: entry.newId,
        message: entry.comment,
        timestamp: entry.who.timestamp * 1000, // milliseconds
      };
    }
  }

  /**
   * Push current changes to stash, as `git stash push`: the stash commits, then
   * `refs/stash` updated with a reflog line whose message is the stash commit's
   * ("WIP on <branch>: <abbrev> <subject>", or "On <branch>: <message>").
   */
  async push(messageOrOptions?: string | StashPushOptions): Promise<ObjectId> {
    const options: StashPushOptions =
      typeof messageOrOptions === "string"
        ? { message: messageOrOptions }
        : (messageOrOptions ?? {});

    const head = await this.getHead();
    if (!head) {
      throw new Error("Cannot stash: no commits in repository");
    }

    const branch = (await this.getBranch()) ?? "(no branch)";
    const author: PersonIdent = {
      ...this.defaultAuthor,
      timestamp: Math.floor(Date.now() / 1000),
    };
    const headCommit = await this.history.commits.load(head).catch(() => undefined);
    const subject = headCommit?.message.split("\n")[0] ?? "";
    const onHead = `${branch}: ${head.slice(0, 7)} ${subject}`;

    // 1. The index tree, and its commit (parent: HEAD)
    const indexTree = await this.staging.writeTree(this.history.trees);
    const indexCommitId = await this.history.commits.store({
      tree: indexTree,
      parents: [head],
      author,
      committer: author,
      message: `index on ${onHead}\n`,
    });

    // 2. The working tree: the index with the worktree's changes
    const worktreeTree = await this.createWorktreeTree(indexTree);
    const parents: ObjectId[] = [head, indexCommitId];

    // 3. With includeUntracked, the untracked files commit (3rd parent)
    if (options.includeUntracked) {
      const untrackedCommitId = await this.createUntrackedFilesCommit(author, onHead);
      if (untrackedCommitId) {
        parents.push(untrackedCommitId);
      }
    }

    // 4. The stash commit
    const stashMessage =
      options.message !== undefined ? `On ${branch}: ${options.message}` : `WIP on ${onHead}`;
    const stashCommitId = await this.history.commits.store({
      tree: worktreeTree,
      parents,
      author,
      committer: author,
      message: `${stashMessage}\n`,
    });

    // 5. refs/stash and its reflog line, under refs/stash.lock (git's update_ref with
    //    REF_FORCE_CREATE_REFLOG and no old-value check)
    const result = await this.refs.batch([{ name: STASH_REF, new: stashCommitId }], {
      ident: formatPersonIdent(author),
      message: stashMessage,
      createReflog: true,
    });
    // refused (another writer holds refs/stash.lock: code "ELOCKED"); nothing changed
    if (!result.ok) throw new RefUpdateRejectedError(result.rejected);

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
    onHead: string,
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
        const { id: blobId } = await storeWorktreeFile(
          this.history.blobs,
          this.worktree,
          wtEntry.path,
          wtEntry,
        );
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
      message: `untracked files on ${onHead}\n`,
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
          const { id: blobId } = await storeWorktreeFile(
            this.history.blobs,
            this.worktree,
            entry.name,
            wtEntry,
          );
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
    const reflog = await this.refs.getReflog?.(STASH_REF);
    return (await reflog?.getReverseEntry(index))?.newId;
  }

  /**
   * Drop a stash entry, as `git stash drop stash@{n}`: `git reflog delete --rewrite
   * --updateref refs/stash@{n}`, and once no entry is left, `refs/stash` is deleted.
   */
  async drop(index = 0): Promise<void> {
    const refs = this.refs;
    if (!refs.deleteReflogEntry) {
      throw new Error("Cannot drop a stash entry: this ref store keeps no reflog");
    }
    if (!(await this.getStashCommit(index))) {
      throw new Error(`stash@{${index}} does not exist`);
    }
    const left = await refs.deleteReflogEntry(STASH_REF, index, {
      rewrite: true,
      updateRef: true,
    });
    // as git: refs/stash goes once refs/stash@{0} no longer exists (re-checked, so a
    // stash pushed meanwhile is kept)
    if (left === 0 && !(await this.getStashCommit(0))) await this.clear();
  }

  /**
   * Clear all stash entries: `refs/stash` and its reflog deleted, under the ref's lock.
   */
  async clear(): Promise<void> {
    const current = await this.refs.get(STASH_REF);
    if (!current) return;
    const old = isSymbolicRef(current) ? undefined : current.objectId;
    const result = await this.refs.batch([{ name: STASH_REF, old, new: null, noDeref: true }]);
    if (!result.ok) throw new RefUpdateRejectedError(result.rejected);
  }
}

/**
 * Create a GitStashStore instance with full push/apply support.
 */
export function createGitStashStore(options: GitStashStoreOptions): StashStore {
  return new GitStashStore(options);
}
