/**
 * git's `add_to_index` and `remove_file_from_index` over one index editor: what `git add`
 * and a partial commit's `add_remove_files` do to each path, applied together at `finish`.
 */
import { type Blobs, EMPTY_BLOB_ID, FileMode } from "@statewalker/vcs-core";
import { compareGitPaths } from "@statewalker/vcs-utils/encoding";
import {
  basicStatMatches,
  DeleteStagingEntry,
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

  private constructor(
    private readonly staging: Staging,
    private readonly blobs: Blobs,
    private readonly trust: WorktreeModeTrust,
  ) {
    this.editor = staging.createEditor();
    this.indexTime = staging.getUpdateTime();
  }

  /** An adder over the index as `staging` holds it now. */
  static async open(staging: Staging, blobs: Blobs, trust: WorktreeModeTrust): Promise<IndexAdder> {
    const adder = new IndexAdder(staging, blobs, trust);
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
    for (let i = 1; i < adder.basePaths.length; i++) {
      if (compareGitPaths(adder.basePaths[i - 1] as string, adder.basePaths[i] as string) > 0) {
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
   * tracked entry that is not racily clean; with `intentToAdd`, an intent-to-add entry where
   * the path has no stage-0 entry (`ADD_CACHE_NEW_ONLY`).
   *
   * @returns whether the path was staged (or found up to date)
   */
  async add(
    worktree: Worktree,
    path: string,
    entry: WorktreeEntry,
    options: { intentToAdd?: boolean; onWarning?: (message: string) => void } = {},
  ): Promise<boolean> {
    if (options.intentToAdd) {
      // ADD_CACHE_NEW_ONLY: a path with a stage-0 entry (tracked, or already intent-to-add)
      // is left as it is; a conflicted one (no stage 0) has its stages replaced
      if (this.hasStage0(path)) return false;
      this.resolve(path);
      this.clearConflicts(path);
      // the empty blob's id, flagged intent-to-add, as git records it (never an empty or
      // all-zero id, which a worktree hash could be compared against)
      this.editor.add(
        new UpdateStagingEntry(
          path,
          EMPTY_BLOB_ID,
          entry.mode ?? FileMode.REGULAR_FILE,
          { size: 0, mtime: Date.now() },
          { intentToAdd: true },
        ),
      );
      this.markAdded(path);
      return true;
    }

    // a tracked file whose stat still matches its entry (and is not racily clean) is not
    // read again (nor its line endings checked)
    const indexed = await this.staging.getEntry(path);
    if (
      indexed &&
      !indexed.intentToAdd &&
      this.hasStage0(path) &&
      this.indexTime > 0 &&
      wholeSeconds(indexed.mtime, indexed.mtimeNs) < wholeSeconds(this.indexTime) &&
      modeFromWorktree(entry.mode, indexed.mode, this.trust) === indexed.mode &&
      basicStatMatches(indexed, entry, this.trust)
    ) {
      return true;
    }

    // the stat that matched the stored content (a fresh one after a retry)
    const stored = await storeWorktreeFile(this.blobs, worktree, path, entry, {
      onWarning: options.onWarning,
    });
    this.resolve(path);
    this.clearConflicts(path);
    // the mode git's ce_mode_from_stat would record
    const mode = modeFromWorktree(stored.entry.mode, indexed?.mode, this.trust);
    this.editor.add(new UpdateStagingEntry(path, stored.id, mode, entryStatOf(stored.entry)));
    this.markAdded(path);
    return true;
  }

  /** git's `remove_file_from_index`: every stage of `path` removed (conflicts as resolve-undo). */
  remove(path: string): void {
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
