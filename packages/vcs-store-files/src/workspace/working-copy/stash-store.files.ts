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
} from "@statewalker/vcs-core";
import type {
  Staging,
  StashEntry,
  StashPushOptions,
  StashStore,
  StashTreesSource,
  Worktree,
  WorktreeModeTrust,
} from "@statewalker/vcs-working-tree";
import {
  createIndexTree,
  createUntrackedTree,
  createWorktreeTree,
} from "@statewalker/vcs-working-tree";
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
  /**
   * The author and committer of each push's commits, asked at each push; the committer is
   * also the identity of its reflog line. vcs-commands' `stashCreate()` resolves them as
   * git does (`GIT_*`, `author.*` / `committer.*`, `user.*`); this store cannot, so a caller
   * that wants git's identities passes them here. Default: {@link author}, else
   * {@link DEFAULT_STASH_IDENT}, dated now in the local offset.
   */
  identity?: (role: "author" | "committer") => PersonIdent;
  /** One identity of stash commits and reflog lines (the time is taken at each push) */
  author?: Omit<PersonIdent, "timestamp">;
  /** `core.filemode` / `core.symlinks`; defaults to what the worktree can represent */
  trust?: WorktreeModeTrust;
}

/**
 * The identity of the stashes nobody gave an identity for: the one vcs-commands and the ref
 * stores use when nobody is configured.
 */
export const DEFAULT_STASH_IDENT = { name: "webrun-vcs", email: "vcs@localhost" } as const;

/** The local timezone offset at `seconds` as git writes it (`+HHMM`). */
function localOffset(seconds: number): string {
  const minutes = -new Date(seconds * 1000).getTimezoneOffset();
  const abs = Math.abs(minutes);
  const hhmm = `${String(Math.floor(abs / 60)).padStart(2, "0")}${String(abs % 60).padStart(2, "0")}`;
  return `${minutes < 0 ? "-" : "+"}${hhmm}`;
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
  private readonly defaultAuthor?: Omit<PersonIdent, "timestamp">;
  private readonly identity?: (role: "author" | "committer") => PersonIdent;
  private readonly trust?: WorktreeModeTrust;

  constructor(options: GitStashStoreOptions) {
    this.history = options.history;
    this.staging = options.staging;
    this.worktree = options.worktree;
    this.getHead = options.getHead;
    this.getBranch = options.getBranch;
    this.trust = options.trust;
    this.defaultAuthor = options.author;
    this.identity = options.identity;
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
    const { author, committer } = this.identities();
    const headCommit = await this.history.commits.load(head).catch(() => undefined);
    const subject = headCommit?.message.split("\n")[0] ?? "";
    const onHead = `${branch}: ${head.slice(0, 7)} ${subject}`;

    // 1. The index tree, and its commit (parent: HEAD)
    const source = this.treesSource;
    const indexTree = await createIndexTree(source);
    const indexCommitId = await this.history.commits.store({
      tree: indexTree,
      parents: [head],
      author,
      committer,
      message: `index on ${onHead}\n`,
    });

    // 2. The working tree: the index with the worktree's changes to tracked files
    const worktreeTree = await createWorktreeTree(source, headCommit?.tree);
    const parents: ObjectId[] = [head, indexCommitId];

    // 3. With includeUntracked, the untracked files commit (3rd parent, no parents itself;
    //    as git, written even when there are none: the empty tree)
    if (options.includeUntracked) {
      const untracked = await createUntrackedTree(source);
      parents.push(
        await this.history.commits.store({
          tree: untracked.treeId,
          parents: [],
          author,
          committer,
          message: `untracked files on ${onHead}\n`,
        }),
      );
    }

    // 4. The stash commit
    const stashMessage =
      options.message !== undefined ? `On ${branch}: ${options.message}` : `WIP on ${onHead}`;
    const stashCommitId = await this.history.commits.store({
      tree: worktreeTree,
      parents,
      author,
      committer,
      message: `${stashMessage}\n`,
    });

    // 5. refs/stash and its reflog line, under refs/stash.lock (git's update_ref with
    //    REF_FORCE_CREATE_REFLOG and no old-value check)
    const result = await this.refs.batch([{ name: STASH_REF, new: stashCommitId }], {
      ident: formatPersonIdent(committer),
      message: stashMessage,
      createReflog: true,
    });
    // refused (another writer holds refs/stash.lock: code "ELOCKED"); nothing changed
    if (!result.ok) throw new RefUpdateRejectedError(result.rejected);

    return stashCommitId;
  }

  /** The author and committer of a push now (see {@link GitStashStoreOptions.identity}). */
  private identities(): { author: PersonIdent; committer: PersonIdent } {
    if (this.identity) {
      return { author: this.identity("author"), committer: this.identity("committer") };
    }
    const timestamp = Math.floor(Date.now() / 1000);
    const who: PersonIdent = this.defaultAuthor
      ? { ...this.defaultAuthor, timestamp }
      : { ...DEFAULT_STASH_IDENT, timestamp, tzOffset: localOffset(timestamp) };
    return { author: who, committer: who };
  }

  /** The source the stash trees are built from (shared with `git.stashCreate()`). */
  private get treesSource(): StashTreesSource {
    return {
      blobs: this.history.blobs,
      trees: this.history.trees,
      staging: this.staging,
      worktree: this.worktree,
      trust: this.trust,
    };
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
