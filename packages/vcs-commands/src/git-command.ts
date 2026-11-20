import type {
  BlobRead,
  Blobs,
  Commit,
  Commits,
  ObjectId,
  PersonIdent,
  Ref,
  RefLogOptions,
  RefRemoveOptions,
  Refs,
  RefTransactionHook,
  SymbolicRef,
  Tag,
  Tags,
  Tree,
  TreeEntry,
  Trees,
} from "@statewalker/vcs-core";
import {
  createReplacedBlobs,
  createReplacedCommits,
  createReplacedTags,
  createReplacedTrees,
  type GraftFileBase,
  graftFileBaseDir,
  graftFileReader,
  hasReplacements,
  isSymbolicRef,
  type LoadedObjectReplacements,
  loadObjectReplacements,
  overlayMethods,
} from "@statewalker/vcs-core";
import { OrderedMap, parseGitBool } from "@statewalker/vcs-utils";
import {
  type AttributesSourceResolver,
  basicStatMatches,
  clearSkipWorktreeFromPresentFiles,
  compareWithWorktree,
  IndexChangedError,
  type SparseCheckoutPatterns,
  type Staging,
  type WorkingCopy,
  type Worktree,
} from "@statewalker/vcs-working-tree";
import { attributesSourceResolver } from "./commands/attributes-source.js";
import {
  configLoadError,
  createIdAbbreviator,
  type IdAbbreviator,
  worktreeModeTrust,
} from "./commands/core-config.js";
import { HookSession, refTransactionHookOf } from "./commands/git-hooks.js";
import {
  authorIdentOf,
  committerIdentOf,
  hostEnvironmentOf,
  type IdentRole,
  resolveIdentDate,
  withoutCrud,
} from "./commands/git-ident.js";
import type { NotesContext } from "./commands/notes-support.js";
import { reflogLine } from "./commands/reflog-messages.js";
import {
  type ArgumentFiles,
  lstatExists,
  type WorktreeLookup,
} from "./commands/revision-filenames.js";
import { type ResolveOptions, RevisionResolver } from "./commands/revision-resolver.js";
import { readSparseCheckoutPatterns } from "./commands/sparse-checkout-support.js";
import {
  InvalidConfigError,
  NoHeadError,
  NotACommitError,
  RefNotFoundError,
} from "./errors/index.js";
import { RemoteConfigStore } from "./remote-config/index.js";

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
/** A ref store that runs the reference-transaction hook (the files store). */
interface TransactionHookStore {
  setTransactionHook?(hook: RefTransactionHook | undefined): void;
  getTransactionHook?(): RefTransactionHook | undefined;
}

/**
 * The reference-transaction hooks commands installed: a command without hooks removes one
 * of these left on its store (a command that wrote refs outside its `call`), never a hook
 * someone else set (the receive side of a local push, a library user).
 */
const commandTransactionHooks = new WeakSet<RefTransactionHook>();

export interface CommandRefs extends Refs {
  /** Delete a reference - alias for remove() */
  delete(name: string, options?: RefRemoveOptions): Promise<boolean>;
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
    wrapper.delete = (name: string, options?: RefRemoveOptions) => refs.remove(name, options);
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

/** git's advice when it reads a grafts file (2.5x wording). */
const GRAFT_FILE_ADVICE = [
  "hint: Support for <GIT_DIR>/info/grafts is deprecated",
  "hint: and will be removed in a future Git version.",
  "hint:",
  'hint: Please use "git replace --convert-graft-file"',
  "hint: to convert the grafts into replace refs.",
  "hint:",
  "hint: Turn this message off by running",
  'hint: "git config set advice.graftFileDeprecated false"',
];

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
/** Trees the commands sharing reads keep (see `GitCommand.shareReadsOf`). */
const SHARED_TREES = 1024;
/** Bytes of blob content the commands sharing reads keep, and the largest blob kept */
export const SHARED_BLOB_BYTES = 64 * 2 ** 20;
export const SHARED_BLOB_MAX = 2 ** 20;

/** Blob contents kept for the commands sharing reads, most recently used last */
export interface SharedBlobs {
  recent: OrderedMap<ObjectId, Uint8Array>;
  bytes: number;
}

/**
 * `blobs` keeping the small blobs it reads in `shared` until they are read again: `git log -p`
 * reads a file's version as the old side of one commit's diff and again as the new side of
 * the next one down, then no more. The bytes handed out are shared between the readers,
 * never to be changed.
 */
export function sharingBlobs(blobs: Blobs, shared: SharedBlobs): Blobs {
  const open = async (id: ObjectId): Promise<BlobRead | undefined> => {
    const known = shared.recent.get(id);
    if (known) {
      // the second read is mostly the last (newest first, a version is read as the old side
      // of the change after it, then as the new side of its own): it leaves the cache, which
      // so holds the versions still to come instead of the ones done with
      shared.recent.delete(id);
      shared.bytes -= known.length;
      return { size: known.length, bytes: known, content: single(known) };
    }
    const blob = await blobs.open?.(id);
    if (blob?.bytes && blob.size <= SHARED_BLOB_MAX) {
      // another open of the same id may have kept it while this one read: hand out that copy
      const kept = shared.recent.get(id);
      if (kept) return { size: kept.length, bytes: kept, content: single(kept) };
      shared.recent.set(id, blob.bytes);
      shared.bytes += blob.bytes.length;
      while (shared.bytes > SHARED_BLOB_BYTES && shared.recent.size > 0) {
        const oldest = shared.recent.oldestKey() as ObjectId;
        shared.bytes -= shared.recent.get(oldest)?.length ?? 0;
        shared.recent.delete(oldest);
      }
      if (shared.recent.size === 0) shared.bytes = 0;
    }
    return blob;
  };
  return overlayMethods(blobs, {
    open,
    load: async (id: ObjectId) => {
      const blob = await open(id);
      if (!blob) return undefined;
      return blob.bytes ? single(blob.bytes) : blob.content;
    },
    size: async (id: ObjectId) => {
      const blob = await open(id);
      if (!blob) return -1;
      if (!blob.bytes) await blob.content[Symbol.asyncIterator]().return?.();
      return blob.size;
    },
  });
}

/** One chunk as a stream */
async function* single(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
}

export abstract class GitCommand<T> {
  protected readonly _workingCopy: WorkingCopy;
  private callable = true;
  private racyCheckInstalled = false;
  /** `--no-replace-objects` (false) or not given (undefined: config and environment decide) */
  protected useReplaceRefsOverride?: boolean;
  private replacementsLoad?: Promise<LoadedObjectReplacements | undefined>;
  private reflogActionOverride?: string;
  /** The time of this command's reflog lines, read once (git's ident_default_date). */
  private reflogClock?: number;
  /** The hooks this command runs (made when first asked for) */
  private hookSession?: HookSession;

  constructor(workingCopy: WorkingCopy) {
    this._workingCopy = workingCopy;
    this.installAttributesSource();
    this.releaseHooksAfterCalls();
  }

  /**
   * Each entry point of the command (`call`, `callText`, ...) puts back the ref store's
   * reference-transaction hook when it ends, whatever the outcome.
   */
  private releaseHooksAfterCalls(): void {
    const self = this as unknown as Record<string, unknown>;
    const names = new Set<string>();
    for (
      let proto = Object.getPrototypeOf(this);
      proto && proto !== Object.prototype;
      proto = Object.getPrototypeOf(proto)
    ) {
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (!/^call(?:[A-Z]\w*)?$/.test(name)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(proto, name);
        if (typeof descriptor?.value === "function") names.add(name);
      }
    }
    for (const name of names) {
      const method = self[name];
      if (typeof method !== "function") continue;
      self[name] = (...args: unknown[]) => {
        let result: unknown;
        try {
          result = (method as (...a: unknown[]) => unknown).apply(this, args);
        } catch (error) {
          this.releaseRefTransactionHook();
          throw error;
        }
        if (result && typeof (result as Promise<unknown>).finally === "function") {
          return (result as Promise<unknown>).finally(() => this.releaseRefTransactionHook());
        }
        this.releaseRefTransactionHook();
        return result;
      };
    }
  }

  /**
   * Lets git's content filter resolve an attribute source (`$GIT_ATTR_SOURCE`, `attr.tree`)
   * with git's revision syntax over this repository.
   */
  private installAttributesSource(): void {
    let worktree: Worktree | undefined;
    try {
      worktree = this._workingCopy.worktree;
    } catch {
      // a bare repository's working copy refuses its worktree
      return;
    }
    const filter = worktree?.contentFilter as
      | { setAttributesSourceResolver?: (resolve: AttributesSourceResolver) => void }
      | undefined;
    if (!filter?.setAttributesSourceResolver || !this._workingCopy.history) return;
    filter.setAttributesSourceResolver(attributesSourceResolver(() => this.revisionResolver()));
  }

  /**
   * The hooks this command runs (git's `run_hooks_opt`), through the host environment's
   * `hookRunner`; with none, no hook runs.
   */
  protected get hooks(): HookSession {
    if (!this.hookSession) this.hookSession = new HookSession(this._workingCopy);
    return this.hookSession;
  }

  /**
   * Runs this command's hooks in another command's session: a command that runs another
   * (merge committing, rebase picking) gathers the output of both in one place.
   */
  shareHooksOf(source: GitCommand<unknown>): this {
    this.hookSession = source.hooks;
    return this;
  }

  /**
   * What the hooks this command ran wrote, in order, with git's hints about hooks it ignored
   * (`advice.ignoredHook`): git relays all of it on its stderr (a hook's stdout included,
   * except for the hooks whose stdout git keeps apart). Empty when no hook ran.
   */
  getHookOutput(): string {
    return this.hookSession?.output ?? "";
  }

  /** What the hooks whose stdout git keeps on its own stdout (pre-push) wrote there. */
  getHookStdout(): string {
    return this.hookSession?.stdout ?? "";
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

  /** What git's notes code reads and writes through this command (`notes-support.ts`). */
  protected notesContext(): NotesContext {
    const tags = this.tagsStore;
    return {
      workingCopy: this._workingCopy,
      blobs: this.blobs,
      trees: this.trees,
      commits: this.commits,
      refs: this.refsStore,
      ...(tags ? { tags } : {}),
      author: () => this.resolveAuthor(),
      committer: () => this.resolveCommitter(),
      reflogLine: (message) => this.reflogLine(message),
      // a full object id is itself (get_oid_basic); the resolver would also look for refs
      // spelled as it, for an ambiguity warning the notes commands do not print — a ref
      // lookup per line of `git notes copy --stdin` that costs most of its time
      resolve: (name) =>
        /^[0-9a-fA-F]{40}$/.test(name)
          ? Promise.resolve(name.toLowerCase())
          : this.revisionResolver()
              .resolve(name)
              .catch(() => undefined),
    };
  }

  // ============ Store Accessors ============

  /**
   * Whether this command reads objects through replace refs and grafts (see {@link commits}).
   * git applies them to every object read but those of gc, prune, pack-objects, upload-pack,
   * index-pack, fsck and commit-graph; the commands doing those override this to read the
   * objects as stored.
   */
  protected readsReplacedObjects(): boolean {
    return true;
  }

  /** The stored objects, as {@link storedCommits} reads commits. */
  private historyOf(): NonNullable<WorkingCopy["history"]> {
    if (!this._workingCopy.history) {
      throw new Error("WorkingCopy.history is required for commands");
    }
    return this._workingCopy.history;
  }

  /** Whether an object was read through the replacements (git then read them, and printed) */
  private replacementsRead = false;

  /** The views of the stored objects through the replacements, made once per command */
  private replacedViews?: {
    blobs: Blobs;
    trees: CommandTrees;
    commits: CommandCommits;
    tags?: CommandTags;
  };

  private views() {
    if (!this.replacedViews) {
      const history = this.historyOf();
      const load = () => {
        this.replacementsRead = true;
        return this.objectReplacements();
      };
      const storedTrees = wrapTrees(history.trees as unknown as Trees);
      const trees = createReplacedTrees(storedTrees, load);
      const rawTags = history.tags ? wrapTags(history.tags as unknown as Tags) : undefined;
      const tags = rawTags ? createReplacedTags(rawTags, load) : undefined;
      this.replacedViews = {
        blobs: createReplacedBlobs(history.blobs as unknown as Blobs, load),
        // the legacy names read through the view too
        trees: overlayMethods(trees, {
          loadTree: async function* (id: ObjectId): AsyncIterable<TreeEntry> {
            const entries = await trees.load(id);
            if (entries) yield* entries;
          },
        }),
        commits: createReplacedCommits(
          wrapCommits(history.commits as unknown as Commits),
          load,
        ) as CommandCommits,
        ...(tags
          ? { tags: overlayMethods(tags, { loadTag: (id: ObjectId) => tags.load(id) }) }
          : {}),
      };
    }
    return this.replacedViews;
  }

  /**
   * Access blob storage: a blob replaced by `refs/replace/<id>` reads as its replacement,
   * unless this command reads the objects as stored ({@link readsReplacedObjects}).
   */
  protected get blobs(): Blobs {
    const blobs = this.readsReplacedObjects() ? this.views().blobs : this.storedBlobs;
    const shared = this.sharedBlobs;
    if (!shared || !blobs.open) return blobs;
    if (this.sharedBlobsView?.of !== blobs) {
      this.sharedBlobsView = { of: blobs, view: sharingBlobs(blobs, shared) };
    }
    return this.sharedBlobsView.view;
  }

  /** Blob contents read lately by the commands sharing reads ({@link shareReadsOf}) */
  private sharedBlobs?: SharedBlobs;
  private sharedBlobsView?: { of: Blobs; view: Blobs };

  /**
   * Access tree storage: a tree replaced by `refs/replace/<id>` reads as its replacement,
   * unless this command reads the objects as stored ({@link readsReplacedObjects}).
   */
  protected get trees(): CommandTrees {
    return this.readsReplacedObjects() ? this.views().trees : this.storedTrees;
  }

  /**
   * Access commit storage, as git reads commits: a commit replaced by `refs/replace/<id>`
   * reads as its replacement (keeping its id), a commit in `info/grafts` with its grafted
   * parents, a shallow commit with none; merge bases, ancestry and walks follow them (see
   * `createReplacedCommits`). Without replace refs or grafts, or in a command that reads the
   * objects as stored ({@link readsReplacedObjects}), it is the store itself.
   */
  protected get commits(): CommandCommits {
    return this.readsReplacedObjects() ? this.views().commits : this.storedCommits;
  }

  /** The blobs as stored, without replace refs. */
  protected get storedBlobs(): Blobs {
    return this.historyOf().blobs as unknown as Blobs;
  }

  /** The trees as stored, without replace refs. */
  protected get storedTrees(): CommandTrees {
    return wrapTrees(this.historyOf().trees as unknown as Trees);
  }

  /** The commits as stored, without replace refs or grafts. */
  protected get storedCommits(): CommandCommits {
    return wrapCommits(this.historyOf().commits as unknown as Commits);
  }

  /**
   * Whether replace refs apply to this command's history walks: `false` is git's
   * `--no-replace-objects`. Unset, `core.useReplaceRefs` (default true) decides, and
   * `GIT_NO_REPLACE_OBJECTS` in the host environment turns them off.
   */
  setUseReplaceRefs(use: boolean): this {
    this.checkCallable();
    this.useReplaceRefsOverride = use;
    return this;
  }

  /** Whether replace refs apply (see {@link setUseReplaceRefs}). */
  protected useReplaceRefs(): boolean {
    if (this.useReplaceRefsOverride !== undefined) return this.useReplaceRefsOverride;
    if (hostEnvironmentOf(this._workingCopy)?.noReplaceObjects) return false;
    const value = this._workingCopy.config
      ? RemoteConfigStore.from(this._workingCopy).value("core.useReplaceRefs")
      : undefined;
    return parseGitBool(value) ?? true;
  }

  /**
   * Where a relative `GIT_GRAFT_FILE` is read from: the worktree top (the git directory when
   * `core.bare`), as the host names it (the working copy's `hostGitDir`), where git's setup
   * has changed to before opening the file; undefined when the host path is unknown.
   */
  protected graftFileBase(): GraftFileBase | undefined {
    const gitDir = (this._workingCopy.config as { hostGitDir?: string } | undefined)?.hostGitDir;
    if (gitDir === undefined) return undefined;
    const bare = this._workingCopy.config
      ? parseGitBool(RemoteConfigStore.from(this._workingCopy).value("core.bare"))
      : undefined;
    return { dir: graftFileBaseDir(gitDir, bare) };
  }

  /** The commits as git's history walks read them: {@link commits}. */
  protected get walkCommits(): CommandCommits {
    return this.commits;
  }

  /**
   * The replace refs and grafts this command's reads apply, read once; undefined when there
   * are none (or they cannot be read).
   */
  protected objectReplacements(): Promise<LoadedObjectReplacements | undefined> {
    return this.loadedReplacements().then((r) => (hasReplacements(r) ? r : undefined));
  }

  /**
   * The replace refs and grafts as read, with the messages git prints while reading them
   * (`bad graft data`, `bad replace ref name`), read once.
   */
  protected loadedReplacements(): Promise<LoadedObjectReplacements | undefined> {
    if (!this.replacementsLoad) {
      const environment = hostEnvironmentOf(this._workingCopy);
      const replaceRefBase = environment?.replaceRefBase;
      // GIT_GRAFT_FILE: that file is read in place of info/grafts (an empty one is a grafts
      // file all the same: git gives its deprecation advice)
      const readGraftFile = graftFileReader(environment, this.graftFileBase());
      this.replacementsLoad = loadObjectReplacements({
        refs: this.refsStore,
        useReplaceRefs: this.useReplaceRefs(),
        ...(replaceRefBase !== undefined ? { replaceRefBase } : {}),
        ...(readGraftFile ? { readGraftFile } : {}),
      }).catch(() => undefined);
    }
    return this.replacementsLoad;
  }

  /**
   * What git prints on stderr while it reads the replace refs and grafts, once this command
   * has read an object through them (`git log`, `git rev-parse HEAD~1`; not `git rev-parse
   * HEAD`, which reads no object): `warning: bad replace ref name: <name>`, the advice that
   * `info/grafts` is deprecated (unless `advice.graftFileDeprecated` is false), `error: bad
   * graft data: <line>`. The advice is worded as git 2.5x words it.
   */
  async replacementMessages(): Promise<string[]> {
    if (!this.replacementsRead) return [];
    const loaded = await this.loadedReplacements();
    if (!loaded) return [];
    const advice =
      loaded.graftFile &&
      parseGitBool(
        this._workingCopy.config
          ? RemoteConfigStore.from(this._workingCopy).value("advice.graftFileDeprecated")
          : undefined,
      ) !== false
        ? GRAFT_FILE_ADVICE
        : [];
    return [...loaded.replaceMessages, ...advice, ...loaded.graftMessages];
  }

  /** Marks that this command read objects through the replacements (see replacementMessages). */
  protected markReplacementsRead(): void {
    this.replacementsRead = true;
  }

  /**
   * Access tag storage: an annotated tag replaced by `refs/replace/<id>` reads as its
   * replacement, unless this command reads the objects as stored.
   * Named tagsStore to avoid conflict with command properties.
   */
  protected get tagsStore(): CommandTags | undefined {
    if (this.readsReplacedObjects()) return this.views().tags;
    const tags = this.historyOf().tags as unknown as Tags | undefined;
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
    const refs = wrapRefs(this._workingCopy.history.refs as unknown as Refs);
    this.installRefTransactionHook(refs);
    return refs;
  }

  /** The reference-transaction hook this command installs on its ref store (made once). */
  private refTransactionHook?: RefTransactionHook;
  /** The store it is installed on, and the hook that was there before (put back at the end) */
  private refTransactionInstalled?: {
    store: TransactionHookStore;
    previous: RefTransactionHook | undefined;
  };

  /**
   * git's reference-transaction hook (see {@link refTransactionHookOf}) on a ref store that
   * supports it (the files store), while this command runs: the hook that was there before
   * is put back when the command's `call` ends ({@link releaseRefTransactionHook}), so a
   * later write never routes its output to this command. A command without hooks (no
   * runner) removes a command's hook left there, and leaves any other hook in place.
   */
  private installRefTransactionHook(refs: Refs): void {
    const store = refs as TransactionHookStore;
    if (!store.setTransactionHook) return;
    if (!this.hooks.enabled) {
      const current = store.getTransactionHook?.();
      if (current && commandTransactionHooks.has(current)) store.setTransactionHook(undefined);
      return;
    }
    if (!this.refTransactionHook) {
      this.refTransactionHook = refTransactionHookOf(this.hooks);
      commandTransactionHooks.add(this.refTransactionHook);
    }
    if (!this.refTransactionInstalled) {
      this.refTransactionInstalled = { store, previous: store.getTransactionHook?.() };
    }
    store.setTransactionHook(this.refTransactionHook);
  }

  /**
   * Puts back the reference-transaction hook the store had before this command installed
   * its own (when its own is still the one installed).
   */
  protected releaseRefTransactionHook(): void {
    const installed = this.refTransactionInstalled;
    if (!installed) return;
    this.refTransactionInstalled = undefined;
    const current = installed.store.getTransactionHook?.();
    if (current === undefined || current === this.refTransactionHook) {
      installed.store.setTransactionHook?.(installed.previous);
    }
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
   * The index as it is on disk at the start of an index-writing command, as git reads the
   * index at the start of every command (`repo_read_index`): when another writer replaced
   * the index since this instance read or wrote it, the index is read again, unless this
   * instance holds edits it has not written (they would be lost), which refuses the
   * command with `IndexChangedError` before it touches the worktree, the index or a ref.
   * A staging area that cannot be outdated (no index file) is left as it is.
   *
   * @param refuseUnwritten false for a command that writes no index (`clean`): unwritten
   *   edits are then kept and used instead of refusing
   */
  protected async readCurrentIndex(refuseUnwritten = true): Promise<void> {
    const staging = this.staging;
    if (await staging.isOutdated()) {
      if (staging.hasUnwrittenChanges?.() !== false) {
        if (!refuseUnwritten) return;
        throw new IndexChangedError("index");
      }
      await staging.read();
    }
    await this.clearPresentSkipWorktree();
  }

  /**
   * git's `clear_skip_worktree_from_present_files`, which `repo_read_index` runs on every
   * index read: with `core.sparseCheckout` on (and `sparse.expectFilesOutsideOfPatterns`
   * off), a skip-worktree entry whose path exists in the worktree loses the flag, written
   * with the index when the command writes it. Nothing is stat'ed outside a sparse checkout.
   */
  protected async clearPresentSkipWorktree(): Promise<void> {
    // a bare repository's working copy refuses its worktree: asked without touching it
    if (!("worktree" in this._workingCopy)) return;
    const worktree = this._workingCopy.worktree;
    if (!worktree || !this._workingCopy.config) return;
    const config = RemoteConfigStore.from(this._workingCopy);
    if (parseGitBool(config.value("core.sparseCheckout")) !== true) return;
    if (parseGitBool(config.value("sparse.expectFilesOutsideOfPatterns")) === true) return;
    await clearSkipWorktreeFromPresentFiles(this.staging, worktree);
  }

  /**
   * The sparse checkout's patterns (`$GIT_DIR/info/sparse-checkout`, cone matching with
   * `core.sparseCheckoutCone`, case folded with `core.ignoreCase`) for git's
   * `path_in_sparse_checkout`, or undefined when `core.sparseCheckout` is off (every path
   * is in the checkout).
   */
  protected async sparseCheckoutPatterns(): Promise<SparseCheckoutPatterns | undefined> {
    return readSparseCheckoutPatterns(this._workingCopy);
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
   * Verify the command hasn't been called yet, and that the configuration loads as git
   * loads it (see {@link checkConfigOnLoad}). Every `call()` starts here, before it reads or
   * writes anything, so a command git would refuse to start changes nothing.
   * @throws Error if command was already executed
   * @throws InvalidConfigError if git would die loading the configuration
   */
  protected checkCallable(): void {
    if (!this.callable) {
      throw new Error(`Command ${this.constructor.name} has already been called`);
    }
    this.checkConfigOnLoad();
  }

  /** Mark command as no longer callable (or callable again). */
  protected setCallable(value: boolean): void {
    this.callable = value;
  }

  /**
   * What every git command dies on before it runs, `status` included: configuration git's
   * `git_default_config` refuses (an unknown `core.disambiguate`, see {@link configLoadError}).
   * Checked each time, so a setter run before the configuration changed does not excuse
   * the `call()` after it.
   *
   * @throws InvalidConfigError with git's `error:` and `fatal:` lines
   */
  protected checkConfigOnLoad(): void {
    const failure = configLoadError(this._workingCopy);
    if (failure) throw new InvalidConfigError(failure.key, failure.message);
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
   * A resolver for git's revision syntax over this command's stores (see
   * {@link RevisionResolver}); its `warnings` hold what git would print.
   */
  protected revisionResolver(): RevisionResolver {
    return new RevisionResolver({
      refs: this.refsStore,
      commits: this.walkCommits,
      trees: this.trees,
      blobs: this.blobs,
      tags: this.tagsStore,
      staging: () => this.staging,
      workingCopy: this._workingCopy,
      objects: this._workingCopy.history?.objects,
      abbreviate: (ids) => this.idAbbreviator().lengths(ids),
      ...this.worktreeSources(),
    });
  }

  /**
   * The worktree as git's checks of revision-or-path arguments see it (`check_filename`),
   * from the current directory `prefix` below the top.
   */
  protected argumentFiles(prefix = ""): ArgumentFiles {
    const exists = this.worktreeSources().fileExists;
    return {
      inWorktree: exists !== undefined,
      prefix,
      exists: exists ?? (async () => false),
    };
  }

  /** What a resolver checks in the worktree (git's `lstat` of an argument). */
  protected worktreeSources(): {
    fileExists?: (path: string) => Promise<boolean>;
    worktreeHostPath?: string;
  } {
    let worktree: Worktree | undefined;
    try {
      worktree = this._workingCopy.worktree;
    } catch {
      // a bare repository's admin copy refuses its worktree (no work tree)
      return {};
    }
    if (!worktree) return {};
    const host = (worktree as { hostPath?: string }).hostPath;
    const wt = worktree;
    const lookup: WorktreeLookup = {
      kind: async (path) => {
        const entry = await wt.getEntry(path).catch(() => undefined);
        if (!entry) return undefined;
        if ((entry.mode & 0o170000) === 0o120000) return "symlink";
        return entry.isDirectory ? "directory" : "file";
      },
      readlink: async (path) => {
        try {
          const chunks: Uint8Array[] = [];
          for await (const chunk of wt.readContent(path)) chunks.push(chunk);
          return new TextDecoder().decode(concatBytes(chunks));
        } catch {
          return undefined;
        }
      },
      ...(host !== undefined ? { hostPath: host } : {}),
    };
    return {
      // git's lstat of the path as written, from the top (links among its parents followed)
      fileExists: async (path) => {
        try {
          return await lstatExists(lookup, path);
        } catch {
          return false;
        }
      },
      ...(host !== undefined ? { worktreeHostPath: host } : {}),
    };
  }

  private abbreviator?: IdAbbreviator;

  /**
   * This command's id abbreviator: the objects are counted once for git's automatic length,
   * however many ids the command prints (see {@link createIdAbbreviator}).
   */
  protected idAbbreviator(): IdAbbreviator {
    this.abbreviator ??= createIdAbbreviator(this._workingCopy, {
      cacheListings: this.writesNoObjects(),
    });
    return this.abbreviator;
  }

  /**
   * Whether this command stores no objects while it abbreviates ids: its abbreviator then
   * lists each loose fan-out directory once (see `IdAbbreviatorOptions.cacheListings`).
   */
  protected writesNoObjects(): boolean {
    return false;
  }

  /**
   * Read objects through the replace refs and grafts `source` reads, and abbreviate ids with
   * its object count: git reads both once per process, so a command run for each commit of
   * another (`git log -p` runs a diff per commit) reads them once.
   */
  shareReadsOf(source: GitCommand<unknown>): this {
    this.replacementsLoad = source.loadedReplacements();
    this.abbreviator = source.idAbbreviator();
    source.sharedTrees ??= new OrderedMap();
    this.sharedTrees = source.sharedTrees;
    source.sharedBlobs ??= { recent: new OrderedMap(), bytes: 0 };
    this.sharedBlobs = source.sharedBlobs;
    return this;
  }

  /** Trees read lately by the commands sharing reads ({@link shareReadsOf}), newest last */
  private sharedTrees?: OrderedMap<ObjectId, TreeEntry[]>;

  /**
   * A tree's entries through the replacements (`trees.loadTree`), kept a while for the
   * commands that share reads: one commit's tree is the next one's parent tree.
   */
  protected async treeEntries(id: ObjectId): Promise<readonly TreeEntry[]> {
    const trees = this.trees;
    // a store that caches decoded trees hands them out as they are (no copy per read)
    if (trees.entries) {
      // a missing tree reads as empty, as `loadTree` yields nothing for it
      return (await trees.entries(id)) ?? [];
    }
    const cache = this.sharedTrees;
    const known = cache?.get(id);
    if (known) {
      cache?.delete(id);
      cache?.set(id, known);
      return known;
    }
    const entries: TreeEntry[] = [];
    for await (const e of this.trees.loadTree(id)) entries.push(e);
    if (cache) {
      cache.set(id, entries);
      while (cache.size > SHARED_TREES) cache.delete(cache.oldestKey() as ObjectId);
    }
    return entries;
  }

  /** `id` abbreviated as git prints it, through {@link idAbbreviator}. */
  protected abbreviateObjectId(id: ObjectId): Promise<string> {
    return this.idAbbreviator().abbreviate(id);
  }

  /**
   * The object a revision names, as git's `get_oid` finds it: refs by git's rules, object
   * ids, `@`, `@{-N}`, `@{u}`, `@{push}`, `<ref>@{<n>}`, `<ref>@{<date>}`, `~`, `^`,
   * `^{<type>}`, `^{/<regex>}`, `:/<regex>`, `<rev>:<path>`, `:<n>:<path>`. An annotated
   * tag is returned as the tag object.
   *
   * @throws RefNotFoundError if it names nothing
   * @throws RevisionError where git dies (no upstream, reflog too short)
   */
  protected async resolveRevision(name: string, options?: ResolveOptions): Promise<ObjectId> {
    const id = await this.revisionResolver().resolve(name, options);
    if (id === undefined) throw new RefNotFoundError(name);
    return id;
  }

  /**
   * Resolve a revision (see {@link resolveRevision}) to a commit, as git's
   * `lookup_commit_reference` does: tags are peeled, and a revision that ends at a tree, a
   * blob or a missing object is refused with git's lines, `error: object <id> is a tree,
   * not a commit` (not for a missing object) and `fatal` (by default reset's `fatal: Could
   * not parse object '<name>'.`).
   *
   * @param name Ref name, commit ID, or any revision expression
   * @param fatal The command's last line for a revision that names no commit
   * @returns ObjectId of the resolved commit
   * @throws RefNotFoundError if it cannot be resolved
   * @throws NotACommitError if it names something else
   * @throws RevisionError where git dies (no upstream, reflog too short)
   */
  protected async resolveRef(
    name: string,
    fatal: (name: string) => string = (n) => `fatal: Could not parse object '${n}'.`,
  ): Promise<ObjectId> {
    // a commit is wanted: an abbreviation is read as a committish (repo_get_oid_committish)
    const id = await this.resolveRevision(name, { hint: "committish" });
    const peeled = await this.revisionResolver().peelTags(id);
    if (peeled.type === "commit") return peeled.id;
    const lines = peeled.type
      ? [`error: object ${peeled.id} is a ${peeled.type}, not a commit`, fatal(name)]
      : [fatal(name)];
    throw new NotACommitError(name, peeled.id, peeled.type, lines.join("\n"));
  }

  /**
   * git's `setup_branch_path` (`INTERPRET_BRANCH_LOCAL`): the local branch a name's branch
   * syntax stands for (`loc@{u}` is `main` when loc tracks main with `remote = .`), else
   * the name as given.
   *
   * @throws RevisionError where git dies reading it (`@{u}` without an upstream)
   */
  protected async interpretLocalBranch(name: string): Promise<string> {
    if (!name.includes("@")) return name;
    const value = await this.revisionResolver().interpretBranchName(name);
    return value?.startsWith("refs/heads/") ? value.slice("refs/heads/".length) : name;
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
   * Get a ref by name.
   *
   * @param refName Full ref name
   * @returns Ref object or undefined
   */
  protected async getRef(refName: string): Promise<Ref | SymbolicRef | undefined> {
    return this.refsStore.get(refName);
  }
}

/** `chunks` as one array. */
function concatBytes(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
