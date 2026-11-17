import type {
  Blobs,
  Commit,
  Commits,
  ObjectId,
  PersonIdent,
  Ref,
  RefLogOptions,
  Refs,
  SymbolicRef,
  Tag,
  Tags,
  Tree,
  TreeEntry,
  Trees,
} from "@statewalker/vcs-core";
import { isSymbolicRef } from "@statewalker/vcs-core";
import {
  basicStatMatches,
  compareWithWorktree,
  type Staging,
  type WorkingCopy,
  type Worktree,
} from "@statewalker/vcs-working-tree";
import { worktreeModeTrust } from "./commands/core-config.js";
import {
  authorIdentOf,
  committerIdentOf,
  hostEnvironmentOf,
  type IdentRole,
  resolveIdentDate,
  withoutCrud,
} from "./commands/git-ident.js";
import { reflogLine } from "./commands/reflog-messages.js";

import { NoHeadError, RefNotFoundError } from "./errors/index.js";

/**
 * Extended Trees interface with legacy method names for command compatibility.
 */
export interface CommandTrees extends Trees {
  /** Load tree entries - alias for load() */
  loadTree(id: ObjectId): AsyncIterable<TreeEntry>;
  /** Store tree - alias for store() */
  storeTree(entries: Tree): Promise<ObjectId>;
}

/**
 * Extended Refs interface with legacy method names for command compatibility.
 */
export interface CommandRefs extends Refs {
  /** Delete a reference - alias for remove() */
  delete(name: string): Promise<boolean>;
}

/**
 * Extended Tags interface with legacy method names for command compatibility.
 */
export interface CommandTags extends Tags {
  /** Store tag - alias for store() */
  storeTag(tag: Tag): Promise<ObjectId>;
  /** Load tag - alias for load() */
  loadTag(id: ObjectId): Promise<Tag | undefined>;
}

/**
 * Extended Commits interface with legacy method names for command compatibility.
 */
export interface CommandCommits extends Commits {
  /** Load commit - alias for legacy loadCommit() */
  load(id: ObjectId): Promise<Commit | undefined>;
  /** Store commit - alias for legacy storeCommit() */
  store(commit: Commit): Promise<ObjectId>;
}

/**
 * Create a CommandTrees adapter wrapping a Trees instance.
 */
function wrapTrees(trees: Trees): CommandTrees {
  const wrapper = trees as CommandTrees;
  if (!wrapper.loadTree) {
    wrapper.loadTree = async function* (id: ObjectId): AsyncIterable<TreeEntry> {
      const result = await trees.load(id);
      if (result) {
        yield* result;
      }
    };
  }
  if (!wrapper.storeTree) {
    wrapper.storeTree = (entries: Tree) => trees.store(entries);
  }
  return wrapper;
}

/**
 * Create a CommandRefs adapter wrapping a Refs instance.
 */
function wrapRefs(refs: Refs): CommandRefs {
  const wrapper = refs as CommandRefs;
  if (!wrapper.delete) {
    wrapper.delete = (name: string) => refs.remove(name);
  }
  return wrapper;
}

/**
 * Create a CommandTags adapter wrapping a Tags instance.
 * Handles both new Tags interface (load/store) and legacy TagStore (loadTag/storeTag).
 */
function wrapTags(tags: Tags): CommandTags {
  const wrapper = tags as CommandTags & {
    loadTag?: (id: ObjectId) => Promise<Tag | undefined>;
    storeTag?: (tag: Tag) => Promise<ObjectId>;
  };
  // Add load/store if missing (old TagStore uses loadTag/storeTag)
  if (!wrapper.load && wrapper.loadTag) {
    wrapper.load = wrapper.loadTag;
  }
  if (!wrapper.store && wrapper.storeTag) {
    wrapper.store = wrapper.storeTag;
  }
  // Add loadTag/storeTag as aliases for new interface
  // Bind methods to preserve 'this' context
  if (!wrapper.loadTag) {
    const loadFn = wrapper.load;
    if (loadFn) {
      wrapper.loadTag = (id: ObjectId) => loadFn.call(wrapper, id);
    }
  }
  if (!wrapper.storeTag) {
    const storeFn = wrapper.store;
    if (storeFn) {
      wrapper.storeTag = (tag: Tag) => storeFn.call(wrapper, tag);
    }
  }
  return wrapper as CommandTags;
}

/**
 * Create a CommandCommits adapter wrapping a Commits instance.
 * Handles legacy CommitStore interface that uses loadCommit/storeCommit.
 */
function wrapCommits(commits: Commits): CommandCommits {
  const wrapper = commits as CommandCommits & {
    loadCommit?: (id: ObjectId) => Promise<Commit | undefined>;
    storeCommit?: (commit: Commit) => Promise<ObjectId>;
  };
  // Add load/store if missing (old CommitStore uses loadCommit/storeCommit)
  if (!wrapper.load && wrapper.loadCommit) {
    wrapper.load = wrapper.loadCommit;
  }
  if (!wrapper.store && wrapper.storeCommit) {
    wrapper.store = wrapper.storeCommit;
  }
  return wrapper as CommandCommits;
}

/**
 * Abstract base class for all Git commands.
 *
 * Implements the Command pattern with single-use semantics.
 * Each command instance can only be called once.
 *
 * Commands are constructed with a WorkingCopy that provides access to all repository components.
 *
 * Based on JGit's GitCommand<T> class.
 *
 * @typeParam T - The return type of the command's call() method
 */
export abstract class GitCommand<T> {
  protected readonly _workingCopy: WorkingCopy;
  private callable = true;
  private racyCheckInstalled = false;
  private reflogActionOverride?: string;
  /** The time of this command's reflog lines, read once (git's ident_default_date). */
  private reflogClock?: number;

  constructor(workingCopy: WorkingCopy) {
    this._workingCopy = workingCopy;
  }

  /**
   * The action named in the reflog lines this command writes, in place of its own (git's
   * `GIT_REFLOG_ACTION`): `git pull` runs its merge as `pull`, so the line reads
   * `pull: Fast-forward`. Each command uses it where git does: as the whole message of
   * `checkout`, as the prefix of `commit`, `merge`, `fetch`, `rebase`, `cherry-pick`.
   */
  setReflogAction(action: string): this {
    this.checkCallable();
    this.reflogActionOverride = action;
    return this;
  }

  /** The reflog action set with {@link setReflogAction}, else `fallback`. */
  protected reflogAction(fallback: string): string {
    return this.reflogActionOverride ?? fallback;
  }

  /** Whether {@link setReflogAction} named an action. */
  protected hasReflogAction(): boolean {
    return this.reflogActionOverride !== undefined;
  }

  /**
   * A reflog line's options: `message` with `who` (a commit's committer) as its identity,
   * else git's committer ident from the environment and configuration, at the time this
   * command first asked for a line.
   */
  protected reflogLine(message: string, who?: PersonIdent): RefLogOptions {
    return reflogLine(this._workingCopy, message, who, this.clock());
  }

  /**
   * The clock of this command's identities and reflog lines, in seconds: read once per
   * command (a rebase's finish logs the branch and HEAD at one time, as git's process reads
   * its default date once), and again where git resets it ({@link resetClock}).
   */
  protected clock(): number {
    this.reflogClock ??= Math.floor(Date.now() / 1000);
    return this.reflogClock;
  }

  /**
   * git's `reset_ident_date()`: the clock read again, for the commit about to be made and
   * the lines after it (the sequencer does this before each pick).
   */
  protected resetClock(): number {
    this.reflogClock = Math.floor(Date.now() / 1000);
    return this.reflogClock;
  }

  /**
   * The committer of a commit (or tagger of a tag) this command makes, as git resolves it
   * (`resolveCommitterIdent`): `GIT_COMMITTER_*`, `committer.*`, `user.*`, the clock;
   * `fallback`'s name and email (an identity given explicitly) where git would guess them;
   * never `fallback`'s date.
   */
  protected resolveCommitter(fallback?: Pick<PersonIdent, "name" | "email">): PersonIdent {
    return committerIdentOf(this._workingCopy, { now: this.clock(), fallback });
  }

  /**
   * The author of a commit this command makes, as git resolves it (`resolveAuthorIdent`):
   * `GIT_AUTHOR_*`, `author.*`, `user.*`, the clock; `fallback`'s name and email where git
   * would guess them.
   */
  protected resolveAuthor(fallback?: Pick<PersonIdent, "name" | "email">): PersonIdent {
    return authorIdentOf(this._workingCopy, { now: this.clock(), fallback });
  }

  /**
   * An identity named explicitly (`--author=<who>`), dated as git dates `role` now; its
   * name and email without crud, as git writes them.
   */
  protected datedIdent(role: IdentRole, who: { name: string; email: string }): PersonIdent {
    const date = resolveIdentDate(role, hostEnvironmentOf(this._workingCopy), this.clock());
    return { name: withoutCrud(who.name), email: withoutCrud(who.email), ...date };
  }

  // ============ Store Accessors ============

  /**
   * Access blob storage.
   */
  protected get blobs(): Blobs {
    if (!this._workingCopy.history) {
      throw new Error("WorkingCopy.history is required for commands");
    }
    return this._workingCopy.history.blobs as unknown as Blobs;
  }

  /**
   * Access tree storage.
   */
  protected get trees(): CommandTrees {
    if (!this._workingCopy.history) {
      throw new Error("WorkingCopy.history is required for commands");
    }
    return wrapTrees(this._workingCopy.history.trees as unknown as Trees);
  }

  /**
   * Access commit storage.
   */
  protected get commits(): CommandCommits {
    if (!this._workingCopy.history) {
      throw new Error("WorkingCopy.history is required for commands");
    }
    return wrapCommits(this._workingCopy.history.commits as unknown as Commits);
  }

  /**
   * Access tag storage.
   * Named tagsStore to avoid conflict with command properties.
   */
  protected get tagsStore(): CommandTags | undefined {
    if (!this._workingCopy.history) {
      throw new Error("WorkingCopy.history is required for commands");
    }
    const tags = this._workingCopy.history.tags as unknown as Tags | undefined;
    return tags ? wrapTags(tags) : undefined;
  }

  /**
   * Access refs storage.
   * Named refsStore to avoid conflict with command properties.
   */
  protected get refsStore(): CommandRefs {
    if (!this._workingCopy.history) {
      throw new Error("WorkingCopy.history is required for commands");
    }
    return wrapRefs(this._workingCopy.history.refs as unknown as Refs);
  }

  /**
   * Access staging area.
   * Supports both new architecture (checkout.staging) and legacy/init (staging directly).
   */
  protected get staging(): Staging {
    const staging = this.resolveStaging();
    if (!this.racyCheckInstalled) {
      this.racyCheckInstalled = true;
      this.installRacyCheck(staging);
    }
    return staging;
  }

  /**
   * Gives the staging git's racy-git smudging for its writes: an entry whose mtime second is
   * not older than the index file and whose content changed behind a matching stat is
   * written with size 0 (`ce_smudge_racily_clean_entry`), so a later same-size edit in that
   * second is never taken as clean.
   */
  private installRacyCheck(staging: Staging): void {
    const worktree = this._workingCopy.worktree;
    if (!worktree || typeof staging.setRacyCheck !== "function") return;
    const trust = worktreeModeTrust(this._workingCopy, worktree);
    staging.setRacyCheck(async (entry, indexTime) => {
      try {
        // git returns early when the basic stat already differs: changed, nothing to smudge
        const current = await worktree.getEntry(entry.path);
        if (!current || current.isDirectory || !basicStatMatches(entry, current, trust)) {
          return false;
        }
        return (await compareWithWorktree(worktree, entry, { trust, indexTime })).smudge === true;
      } catch {
        return false;
      }
    });
  }

  private resolveStaging(): Staging {
    // Try new architecture first (checkout.staging)
    if (this._workingCopy.checkout?.staging) {
      return this._workingCopy.checkout.staging as unknown as Staging;
    }
    // Fall back to legacy pattern (staging directly on workingCopy)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wcAny = this._workingCopy as any;
    if (wcAny.staging) {
      return wcAny.staging as unknown as Staging;
    }
    throw new Error("WorkingCopy.checkout.staging is required for commands");
  }

  /**
   * Access worktree interface.
   */
  protected get worktreeAccess(): Worktree | undefined {
    return this._workingCopy.worktree;
  }

  /**
   * Get the WorkingCopy.
   */
  protected get workingCopy(): WorkingCopy {
    return this._workingCopy;
  }

  /**
   * Execute the command.
   * Can only be called once per instance.
   */
  abstract call(): Promise<T>;

  /**
   * Verify the command hasn't been called yet.
   * @throws Error if command was already executed
   */
  protected checkCallable(): void {
    if (!this.callable) {
      throw new Error(`Command ${this.constructor.name} has already been called`);
    }
  }

  /**
   * Mark command as no longer callable.
   */
  protected setCallable(value: boolean): void {
    this.callable = value;
  }

  /**
   * Resolve HEAD to its target commit.
   *
   * @returns ObjectId of the commit HEAD points to
   * @throws NoHeadError if HEAD doesn't exist or cannot be resolved
   */
  protected async resolveHead(): Promise<ObjectId> {
    const ref = await this.refsStore.resolve("HEAD");
    if (!ref?.objectId) {
      throw new NoHeadError("HEAD cannot be resolved");
    }
    return ref.objectId;
  }

  /**
   * Get the current branch name (if HEAD is not detached).
   *
   * @returns Branch name (e.g., "refs/heads/main") or undefined if detached
   */
  protected async getCurrentBranch(): Promise<string | undefined> {
    const head = await this.refsStore.get("HEAD");
    if (head && isSymbolicRef(head)) {
      return head.target;
    }
    return undefined;
  }

  /**
   * Resolve a ref name to its ObjectId.
   *
   * @param refName Ref name, commit ID, or commit-ish
   * @returns ObjectId of the resolved ref
   * @throws RefNotFoundError if ref cannot be resolved
   */
  protected async resolveRef(name: string): Promise<ObjectId> {
    // git's interpret_nth_prior_checkout: `@{-N}` is the branch (or commit) left N
    // checkouts ago
    const refName = await this.expandPriorCheckout(name);
    if (refName.startsWith("@{-")) throw new RefNotFoundError(name);

    // Handle relative refs like HEAD~1, HEAD^
    if (refName.includes("~") || refName.includes("^")) {
      return this.resolveRelativeRef(refName);
    }

    // Try as direct ref first
    const ref = await this.refsStore.resolve(refName);
    if (ref?.objectId) {
      // Peel tag objects to commits
      return this.peelToCommit(ref.objectId);
    }

    // Try as branch name
    const branchRef = await this.refsStore.resolve(`refs/heads/${refName}`);
    if (branchRef?.objectId) {
      return branchRef.objectId;
    }

    // Try as tag name
    const tagRef = await this.refsStore.resolve(`refs/tags/${refName}`);
    if (tagRef?.objectId) {
      // Peel tag objects to commits
      return this.peelToCommit(tagRef.objectId);
    }

    // Try as remote-tracking branch (git's dwim rules: refs/remotes/<name>, then its HEAD)
    for (const candidate of [`refs/remotes/${refName}`, `refs/remotes/${refName}/HEAD`]) {
      const remoteRef = await this.refsStore.resolve(candidate);
      if (remoteRef?.objectId) return this.peelToCommit(remoteRef.objectId);
    }

    // Try as direct commit ID
    if (await this.commits.has(refName)) {
      return refName;
    }

    throw new RefNotFoundError(name);
  }

  /**
   * git's `interpret_nth_prior_checkout`: the name a leading `@{-N}` stands for, the
   * branch (or detached commit) the Nth most recent `checkout: moving from <x> to <y>`
   * line of HEAD's reflog left, followed by the rest of `name` (`@{-1}~2` is `main~2`).
   * A name without it, or an `@{-N}` the reflog cannot answer, is returned as given.
   *
   * @example
   * ```typescript
   * await this.expandPriorCheckout("@{-1}"); // "feat" after `checkout feat` + `checkout main`
   * ```
   */
  protected async expandPriorCheckout(name: string): Promise<string> {
    const match = /^@\{-(\d+)\}/.exec(name);
    if (!match) return name;
    const nth = Number.parseInt(match[1] ?? "0", 10);
    if (!(nth > 0)) return name;
    const log = await this.refsStore.getReflog?.("HEAD");
    if (!log) return name;
    let remaining = nth;
    for (const entry of await log.getReverseEntries()) {
      const prefix = "checkout: moving from ";
      if (!entry.comment.startsWith(prefix)) continue;
      const rest = entry.comment.slice(prefix.length);
      const to = rest.indexOf(" to ");
      if (to < 0) continue;
      if (--remaining === 0) return rest.slice(0, to) + name.slice(match[0].length);
    }
    return name;
  }

  /**
   * Resolve a relative ref like HEAD~1 or HEAD^2.
   */
  private async resolveRelativeRef(ref: string): Promise<ObjectId> {
    // Parse the ref
    const match = ref.match(/^([^~^]+)((?:[~^]\d*)+)$/);
    if (!match) {
      throw new RefNotFoundError(ref);
    }

    const baseRef = match[1];
    const modifiers = match[2];

    let commitId = await this.resolveRef(baseRef);

    // Process each modifier
    const modifierMatch = modifiers.matchAll(/([~^])(\d*)/g);
    for (const m of modifierMatch) {
      const type = m[1];
      const count = m[2] ? parseInt(m[2], 10) : 1;

      if (type === "~") {
        // ~N means follow first parent N times
        for (let i = 0; i < count; i++) {
          const commit = await this.commits.load(commitId);
          if (!commit || commit.parents.length === 0) {
            throw new RefNotFoundError(ref, `Cannot resolve ${ref}: no parent`);
          }
          commitId = commit.parents[0];
        }
      } else if (type === "^") {
        // ^N means follow Nth parent
        const commit = await this.commits.load(commitId);
        if (!commit) {
          throw new RefNotFoundError(ref, `Cannot resolve ${ref}: commit not found`);
        }
        const parentIndex = count > 0 ? count - 1 : 0;
        if (commit.parents.length <= parentIndex) {
          throw new RefNotFoundError(ref, `Cannot resolve ${ref}: no parent ${count}`);
        }
        commitId = commit.parents[parentIndex];
      }
    }

    return commitId;
  }

  /**
   * Peel an object ID to a commit (follows tag objects).
   */
  private async peelToCommit(objectId: ObjectId): Promise<ObjectId> {
    // If it's already a commit, return it
    if (await this.commits.has(objectId)) {
      return objectId;
    }

    // Try to load as tag and get target
    const tags = this.tagsStore;
    if (tags) {
      try {
        const tag = await tags.load(objectId);
        if (tag) {
          // Recursively peel
          return this.peelToCommit(tag.object);
        }
      } catch {
        // Not a tag
      }
    }

    // Return as-is (might be a tree or blob in some contexts)
    return objectId;
  }

  /**
   * Get a ref by name.
   *
   * @param refName Full ref name
   * @returns Ref object or undefined
   */
  protected async getRef(refName: string): Promise<Ref | SymbolicRef | undefined> {
    return this.refsStore.get(refName);
  }
}
