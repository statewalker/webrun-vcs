/**
 * git's `add_to_index` and `remove_file_from_index` over one index editor: what `git add`
 * and a partial commit's `add_remove_files` do to each path, applied together at `finish`.
 */
import { type Blobs, EMPTY_BLOB_ID, FileMode, type ObjectId } from "@statewalker/vcs-core";
import { compareGitPaths } from "@statewalker/vcs-utils/encoding";
import {
  basicStatMatches,
  DeleteStagingEntry,
  type EntryStat,
  entryStatOf,
  type IndexEditor,
  invalidateCacheTreePath,
  MergeStage,
  modeFromWorktree,
  type ResolveUndoRecord,
  type Staging,
  type StagingEntry,
  UpdateStagingEntry,
  type Worktree,
  type WorktreeEntry,
  type WorktreeModeTrust,
  wholeSeconds,
} from "@statewalker/vcs-working-tree";
import { storeWorktreeFile } from "../core-commands/index.js";

const SURROGATE = /[\ud800-\udfff]/;

/** What {@link IndexAdder.add} did with a path. */
export type AddOutcome = "unchanged" | "same" | "added";

/** Options of {@link IndexAdder.add}. */
export interface AddToIndexOptions {
  /** `add -N`: an intent-to-add entry where the path has none */
  intentToAdd?: boolean;
  /** `add --renormalize`: read and clean again whatever the stat says */
  renormalize?: boolean;
  /** The path as git names it in its messages (`sub/` for a directory found untracked) */
  displayPath?: string;
  onWarning?: (message: string) => void;
}

/** A path `add_to_index` cannot add: git's error lines (`fatal: adding files failed` follows). */
export class AddToIndexError extends Error {
  constructor(
    readonly path: string,
    readonly lines: string[],
  ) {
    super(lines.join("\n"));
    this.name = "AddToIndexError";
  }
}

/**
 * The commit checked out in the repository at `path` (git's `resolve_gitlink_ref` of its
 * HEAD), read through the worktree; undefined when there is none or it cannot be read.
 */
export async function readGitlinkHead(
  worktree: Worktree,
  path: string,
): Promise<ObjectId | undefined> {
  try {
    return await worktree.readGitlinkHead?.(path);
  } catch {
    return undefined;
  }
}

/**
 * Index edits made as git's `add_index_entry_with_check` makes them, with
 * `ADD_CACHE_OK_TO_ADD | ADD_CACHE_OK_TO_REPLACE`:
 *
 * - a stage-0 entry replaces the path's conflict stages, kept as resolve-undo;
 * - it replaces the stage-0 entries it clashes with (`check_file_directory_conflict`):
 *   adding `a/b` removes the file `a`, adding `a` removes every `a/...` entry;
 * - a removal takes every stage of the path.
 *
 * @example
 * ```typescript
 * const adder = await IndexAdder.open(staging, blobs, trust);
 * await adder.add(worktree, "a/inner", await worktree.getEntry("a/inner")); // `a` goes
 * adder.remove("gone");
 * await adder.finish();
 * ```
 */
export class IndexAdder {
  private readonly editor: IndexEditor;
  private readonly resolveUndo: ResolveUndoRecord[] = [];
  /** The paths' conflict stages, until a stage-0 entry or a removal resolves them */
  private readonly unmerged = new Map<string, StagingEntry[]>();
  /** The index's stage-0 paths before the edits, sorted (git's order) */
  private readonly basePaths: string[] = [];
  private readonly baseSet = new Set<string>();
  /** Stage-0 paths of the index removed by the edits */
  private readonly removed = new Set<string>();
  /** Stage-0 paths the edits add (in no particular order) */
  private readonly added = new Set<string>();
  /** The leading directories of the added paths */
  private readonly addedDirs = new Set<string>();
  private readonly indexTime: number;
  /** The paths given a new entry or removed: git invalidates their cache-tree paths */
  private readonly touched = new Set<string>();
  private emptyBlobStored = false;

  private constructor(
    private readonly staging: Staging,
    private readonly blobs: Blobs,
    private readonly trust: WorktreeModeTrust,
    /** git's `ADD_CACHE_PRETEND` (`add --dry-run`): nothing is written or edited */
    private readonly pretend: boolean,
  ) {
    this.editor = staging.createEditor();
    this.indexTime = staging.getUpdateTime();
  }

  /**
   * An adder over the index as `staging` holds it now; with `pretend` (`add --dry-run`),
   * one that only tells what it would do.
   */
  static async open(
    staging: Staging,
    blobs: Blobs,
    trust: WorktreeModeTrust,
    options: { pretend?: boolean } = {},
  ): Promise<IndexAdder> {
    const adder = new IndexAdder(staging, blobs, trust, options.pretend === true);
    const list = staging.entryList?.();
    const entries: Iterable<StagingEntry> | AsyncIterable<StagingEntry> = list ?? staging.entries();
    for await (const entry of entries) {
      if (entry.stage === 0) {
        adder.basePaths.push(entry.path);
        adder.baseSet.add(entry.path);
      } else {
        adder.unmerged.set(entry.path, [...(adder.unmerged.get(entry.path) ?? []), entry]);
      }
    }
    // sorted already in the index's order; sorted again only if a staging gave another
    // (the engine's string order is the bytes' order without surrogates: checked first)
    for (let i = 1; i < adder.basePaths.length; i++) {
      const a = adder.basePaths[i - 1] as string;
      const b = adder.basePaths[i] as string;
      if (a < b && !SURROGATE.test(a) && !SURROGATE.test(b)) continue;
      if (compareGitPaths(a, b) > 0) {
        adder.basePaths.sort(compareGitPaths);
        break;
      }
    }
    return adder;
  }

  /** Whether the index (as edited so far) has a stage-0 entry at `path`. */
  hasStage0(path: string): boolean {
    return this.added.has(path) || (this.baseSet.has(path) && !this.removed.has(path));
  }

  /** Whether `path` has conflict stages (as edited so far). */
  isUnmerged(path: string): boolean {
    return this.unmerged.has(path);
  }

  /**
   * git's `add_to_index` of the file at `path` (`entry` its lstat): hashed through the
   * content filters and staged with the mode git records, unless its stat still matches a
   * tracked entry that is not racily clean; a directory (a repository) as a gitlink to the
   * commit checked out there; with `intentToAdd`, an intent-to-add entry where the path has
   * no stage-0 entry (`ADD_CACHE_NEW_ONLY`).
   *
   * @returns `"unchanged"` when the entry was found up to date (nothing done), `"same"` when
   * it was hashed again to what the index has (git's `was_same`: `add -v` prints nothing),
   * `"added"` otherwise
   * @throws AddToIndexError when the path cannot be added (a repository without a commit)
   */
  async add(
    worktree: Worktree,
    path: string,
    entry: WorktreeEntry,
    options: AddToIndexOptions = {},
  ): Promise<AddOutcome> {
    const indexed = this.hasStage0(path) ? await this.staging.getEntry(path) : undefined;
    if (entry.isDirectory) return this.addGitlink(worktree, path, entry, indexed, options);
    if (options.intentToAdd) {
      // ADD_CACHE_NEW_ONLY: a path with a stage-0 entry (tracked, or already intent-to-add)
      // keeps its entry; unless its stat matches, git invalidates its cache-tree path all the
      // same (add_index_entry_with_check), after writing the empty blob
      if (indexed && this.statUnchanged(indexed, entry)) return "unchanged";
      await this.storeEmptyBlob();
      if (indexed) {
        if (!this.pretend) this.touched.add(path);
        return indexed.objectId === EMPTY_BLOB_ID ? "same" : "added";
      }
      if (this.pretend) return "added";
      this.resolve(path);
      this.clearConflicts(path);
      // the empty blob's id, flagged intent-to-add, without stat data, as git records it
      // (never an empty or all-zero id, which a worktree hash could be compared against)
      const mode = modeFromWorktree(entry.mode, undefined, this.trust);
      this.editor.add(
        new UpdateStagingEntry(
          path,
          EMPTY_BLOB_ID,
          mode,
          { size: 0, mtime: 0 },
          { intentToAdd: true },
        ),
      );
      this.markAdded(path);
      return "added";
    }

    // a tracked file whose stat still matches its entry (and is not racily clean) is not
    // read again (nor its line endings checked); a renormalisation always reads it
    if (indexed && !options.renormalize && this.statUnchanged(indexed, entry)) return "unchanged";

    // the mode git's ce_mode_from_stat would record
    const known = indexed ?? this.unmerged.get(path)?.[0];
    if (this.pretend) {
      // git's ADD_CACHE_PRETEND: hashed, never written
      const id = await worktree.computeHash(path);
      const mode = modeFromWorktree(entry.mode, known?.mode, this.trust);
      return indexed && indexed.objectId === id && indexed.mode === mode ? "same" : "added";
    }
    // the stat that matched the stored content (a fresh one after a retry)
    const stored = await storeWorktreeFile(this.blobs, worktree, path, entry, {
      onWarning: options.onWarning,
      ...(options.renormalize ? { renormalize: true } : {}),
    });
    const mode = modeFromWorktree(stored.entry.mode, known?.mode, this.trust);
    this.stage(path, stored.id, mode, entryStatOf(stored.entry));
    return indexed && indexed.objectId === stored.id && indexed.mode === mode ? "same" : "added";
  }

  /**
   * `add_to_index` of a directory: a gitlink to the commit checked out in the repository
   * there (`index_path`'s `resolve_gitlink_ref`), git's error when there is none.
   */
  private async addGitlink(
    worktree: Worktree,
    path: string,
    entry: WorktreeEntry,
    indexed: StagingEntry | undefined,
    options: AddToIndexOptions,
  ): Promise<AddOutcome> {
    const head = await readGitlinkHead(worktree, path);
    const name = options.displayPath ?? path;
    if (!head) {
      // git 2.5x adds the "unable to index file" line
      throw new AddToIndexError(path, [
        `error: '${name}' does not have a commit checked out`,
        `error: unable to index file '${name}'`,
      ]);
    }
    // ie_match_stat of a gitlink compares the commit checked out (ce_compare_gitlink)
    if (
      indexed &&
      indexed.mode === FileMode.GITLINK &&
      !indexed.intentToAdd &&
      indexed.objectId === head
    ) {
      return "unchanged";
    }
    if (options.intentToAdd) {
      if (indexed) {
        await this.storeEmptyBlob();
        if (!this.pretend) this.touched.add(path);
        return "added";
      }
      await this.storeEmptyBlob();
      if (this.pretend) return "added";
      this.resolve(path);
      this.clearConflicts(path);
      this.editor.add(
        new UpdateStagingEntry(
          path,
          EMPTY_BLOB_ID,
          FileMode.GITLINK,
          { size: 0, mtime: 0 },
          { intentToAdd: true },
        ),
      );
      this.markAdded(path);
      return "added";
    }
    if (this.pretend) return "added";
    this.stage(path, head, FileMode.GITLINK, entryStatOf(entry));
    return "added";
  }

  /** A stage-0 entry for `path`, replacing its conflict stages and the entries it clashes with. */
  private stage(path: string, id: ObjectId, mode: number, stat: EntryStat): void {
    this.resolve(path);
    this.clearConflicts(path);
    this.editor.add(new UpdateStagingEntry(path, id, mode, stat));
    this.markAdded(path);
  }

  /**
   * git's `ie_match_stat` with `CE_MATCH_RACY_IS_DIRTY` for `add_to_index`'s alias: the
   * entry's stat matches the file's and it is not racily clean (an intent-to-add entry never
   * matches).
   */
  private statUnchanged(indexed: StagingEntry, entry: WorktreeEntry): boolean {
    return (
      !indexed.intentToAdd &&
      this.indexTime > 0 &&
      wholeSeconds(indexed.mtime, indexed.mtimeNs) < wholeSeconds(this.indexTime) &&
      modeFromWorktree(entry.mode, indexed.mode, this.trust) === indexed.mode &&
      basicStatMatches(indexed, entry, this.trust)
    );
  }

  /** git's `set_object_name_for_intent_to_add_entry`: the empty blob written (once). */
  private async storeEmptyBlob(): Promise<void> {
    if (this.emptyBlobStored) return;
    this.emptyBlobStored = true;
    await this.blobs.store([new Uint8Array(0)], 0);
  }

  /** git's `remove_file_from_index`: every stage of `path` removed (conflicts as resolve-undo). */
  remove(path: string): void {
    if (this.pretend) return;
    this.touched.add(path);
    this.resolve(path);
    this.editor.add(new DeleteStagingEntry(path));
    this.markRemoved(path);
  }

  /**
   * The edits applied, and the resolve-undo records kept. Each path given an entry (even
   * one with the same content: a racily clean file read again) or removed has its
   * cache-tree path invalidated, as git's `add_index_entry` and `remove_file_from_index`
   * invalidate it (`cache_tree_invalidate_path`).
   */
  async finish(): Promise<void> {
    if (this.pretend) return;
    await this.editor.finish();
    if (this.resolveUndo.length > 0) this.staging.recordResolveUndo?.(this.resolveUndo);
    if (this.touched.size === 0 || !this.staging.setCacheTree) return;
    const tree = this.staging.getCacheTree?.();
    if (!tree) return;
    for (const path of this.touched) invalidateCacheTreePath(tree, path);
    this.staging.setCacheTree(tree);
  }

  /** A stage-0 entry or a removal resolves a conflict: its stages kept as resolve-undo. */
  private resolve(path: string): void {
    const stages = this.unmerged.get(path);
    if (!stages) return;
    this.unmerged.delete(path);
    this.editor.remove(path);
    const record: ResolveUndoRecord = {
      path,
      modes: [0, 0, 0],
      objectIds: [undefined, undefined, undefined],
    };
    for (const entry of stages) {
      const k = entry.stage - 1;
      if (k < 0 || k > 2) continue;
      record.modes[k] = entry.mode;
      record.objectIds[k] = entry.objectId;
    }
    this.resolveUndo.push(record);
  }

  /**
   * git's `check_file_directory_conflict` with `ok_to_replace` for a stage-0 entry at
   * `path`: the stage-0 entries under `path/` (`has_file_name`) and at each of its leading
   * directories (`has_dir_name`) are removed. Other stages are left (git compares stages).
   */
  private clearConflicts(path: string): void {
    for (const under of this.stage0Under(path)) {
      this.editor.remove(under, MergeStage.MERGED);
      this.markRemoved(under);
    }
    for (let at = path.indexOf("/"); at >= 0; at = path.indexOf("/", at + 1)) {
      const dir = path.slice(0, at);
      if (!this.hasStage0(dir)) continue;
      this.editor.remove(dir, MergeStage.MERGED);
      this.markRemoved(dir);
    }
  }

  /** The stage-0 paths under `dir/`, as edited so far. */
  private stage0Under(dir: string): string[] {
    const prefix = `${dir}/`;
    const out: string[] = [];
    // the base entries under the prefix are next to each other in git's order
    const paths = this.basePaths;
    let lo = 0;
    let hi = paths.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (compareGitPaths(paths[mid] as string, prefix) < 0) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < paths.length && (paths[i] as string).startsWith(prefix); i++) {
      const p = paths[i] as string;
      if (!this.removed.has(p)) out.push(p);
    }
    if (this.addedDirs.has(dir)) {
      for (const p of this.added) {
        if (p.startsWith(prefix) && !this.baseSet.has(p)) out.push(p);
      }
    }
    return out;
  }

  private markAdded(path: string): void {
    this.touched.add(path);
    this.added.add(path);
    this.removed.delete(path);
    for (let at = path.indexOf("/"); at >= 0; at = path.indexOf("/", at + 1)) {
      this.addedDirs.add(path.slice(0, at));
    }
  }

  private markRemoved(path: string): void {
    this.added.delete(path);
    if (this.baseSet.has(path)) this.removed.add(path);
  }
}
