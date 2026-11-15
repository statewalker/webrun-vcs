import { FileMode, type ObjectId } from "@statewalker/vcs-core";
import { mergeLines } from "@statewalker/vcs-utils";
import type { Worktree } from "@statewalker/vcs-working-tree";
import {
  InvalidArgumentError,
  NoHeadError,
  RefNotFoundError,
  StashApplyFailedError,
  StoreNotAvailableError,
} from "../errors/index.js";
import { GitCommand } from "../git-command.js";
import { DEFAULT_RENAME_SCORE, SimilarityIndex } from "../rename/index.js";
import { type ContentMergeStrategy, MergeStrategy } from "../results/merge-result.js";
import type { StashApplyResult } from "../results/stash-result.js";
import { StashApplyStatus } from "../results/stash-result.js";
import { coreBool, worktreeModeTrust } from "./core-config.js";
import { STASH_REF } from "./stash-list-command.js";
import { planTreeRestore, type TreeRestorePlan, writeTreeRestorePlan } from "./tree-restore.js";
import {
  type CheckedEntry,
  findInTheWay,
  overwriteMessage,
  pruneEmptyParents,
  removeDirectoryIfEmpty,
  worktreeDiffers,
} from "./worktree-overwrite-checks.js";

/** A path the index and the stash changed beyond a clean merge, as git leaves it. */
interface MergeConflict {
  base?: CheckedEntry;
  ours?: CheckedEntry;
  theirs?: CheckedEntry;
  /** Where the stages (and the worktree file) go: the path, or `<path>~<side>` */
  stagePath: string;
  /** The file with conflict markers, for a text conflict */
  content?: Uint8Array;
  /** The blob the worktree gets at `stagePath` (a modify/delete's surviving stash side) */
  write?: CheckedEntry;
  /** The path a file/directory conflict moves ours away from */
  moveFrom?: string;
  mode: number;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

const sameEntry = (a: CheckedEntry | undefined, b: CheckedEntry | undefined) =>
  a === undefined || b === undefined ? a === b : a.objectId === b.objectId && a.mode === b.mode;

/** Names this operation in restore failure messages. */
const STASH_APPLY = "stash apply";

/** Removes the directory at `path` if nothing is in it (git's `rmdir` of a submodule). */
async function removeIfEmptyDirectory(worktree: Worktree, path: string): Promise<void> {
  const entry = await worktree.getEntry(path);
  if (!entry?.isDirectory) {
    if (entry) await worktree.remove(path);
    return;
  }
  await removeDirectoryIfEmpty(worktree, path);
}

/**
 * Command to apply a stashed commit.
 *
 * Equivalent to `git stash apply`.
 *
 * Based on JGit's StashApplyCommand.
 *
 * As git's `stash apply`: the stash's change is merged into the current index (staged
 * content and newly staged files take part), line by line where both sides changed a
 * file; the result goes to the worktree, refused up front where it would overwrite local
 * changes or untracked files. A content conflict is written with conflict markers and
 * staged at stages 1-3 (status CONFLICTS). Without `setRestoreIndex(true)` (`--index`)
 * the index keeps its entries plus the files the stash adds; the stashed untracked files
 * are restored first, refused (nothing written) where a file stands in their way.
 *
 * Known limits: a gitlink's contents are not restored, as in git; the restore is not
 * atomic across the working tree and the index.
 *
 * @example
 * ```typescript
 * // Apply most recent stash
 * const result = await git.stashApply().call();
 *
 * // Apply specific stash
 * const result = await git.stashApply()
 *   .setStashRef("stash@{2}")
 *   .call();
 *
 * // Apply without restoring index
 * const result = await git.stashApply()
 *   .setRestoreIndex(false)
 *   .call();
 * ```
 */
export class StashApplyCommand extends GitCommand<StashApplyResult> {
  private stashRef?: string;
  private restoreIndex = false;
  private restoreUntracked = true;
  private strategy = MergeStrategy.RECURSIVE;
  private contentStrategy?: ContentMergeStrategy;

  /**
   * Set the stash reference to apply.
   *
   * Defaults to stash@{0} (most recent) if not specified.
   *
   * @param stashRef Name of the stash ref to apply
   */
  setStashRef(stashRef: string): this {
    this.checkCallable();
    this.stashRef = stashRef;
    return this;
  }

  /**
   * Get the stash reference.
   */
  getStashRef(): string | undefined {
    return this.stashRef;
  }

  /**
   * Set whether to restore the index state (`git stash apply --index`): the stash's index
   * change is merged into the current index, and a conflict there refuses the apply
   * ("conflicts in index. Try without --index."). Off by default, as in git: the index then
   * keeps its entries, plus the files the stash adds.
   *
   * @param restoreIndex true to restore the index (default false)
   */
  setRestoreIndex(restoreIndex: boolean): this {
    this.checkCallable();
    this.restoreIndex = restoreIndex;
    return this;
  }

  /**
   * Get whether index will be restored.
   */
  getRestoreIndex(): boolean {
    return this.restoreIndex;
  }

  /**
   * Set whether to restore untracked files.
   *
   * @param restoreUntracked true to restore untracked files (default)
   */
  setRestoreUntracked(restoreUntracked: boolean): this {
    this.checkCallable();
    this.restoreUntracked = restoreUntracked;
    return this;
  }

  /**
   * Get whether untracked files will be restored.
   */
  getRestoreUntracked(): boolean {
    return this.restoreUntracked;
  }

  /**
   * Set whether to ignore repository state when applying.
   *
   * Note: Currently not implemented - stash apply always ignores repo state.
   *
   * @param _ignore true to ignore state
   */
  setIgnoreRepositoryState(_ignore: boolean): this {
    this.checkCallable();
    // Not currently implemented - reserved for future use
    return this;
  }

  /**
   * Set the merge strategy to use.
   *
   * @param strategy The merge strategy
   */
  setStrategy(strategy: MergeStrategy): this {
    this.checkCallable();
    this.strategy = strategy;
    return this;
  }

  /**
   * Get the merge strategy.
   */
  getStrategy(): MergeStrategy {
    return this.strategy;
  }

  /**
   * Set the content merge strategy for file-level conflicts.
   *
   * @param strategy The content merge strategy
   */
  setContentMergeStrategy(strategy: ContentMergeStrategy): this {
    this.checkCallable();
    this.contentStrategy = strategy;
    return this;
  }

  /**
   * Get the content merge strategy.
   */
  getContentMergeStrategy(): ContentMergeStrategy | undefined {
    return this.contentStrategy;
  }

  /**
   * Execute the stash apply command.
   *
   * @returns Result of the apply operation
   */
  async call(): Promise<StashApplyResult> {
    this.checkCallable();
    this.setCallable(false);

    // Applying a stash means putting files back. A repository with no working
    // tree has nowhere to put them, and reporting OK there would be the same
    // silent no-op this command used to be.
    const worktree = this.worktreeAccess;
    if (!worktree) {
      throw new StoreNotAvailableError("worktree", "stash apply requires a working tree");
    }
    // one batch: the checks and the writes share one reading of the ignore rules
    return worktree.batch ? worktree.batch(() => this.apply(worktree)) : this.apply(worktree);
  }

  private async apply(worktree: Worktree): Promise<StashApplyResult> {
    // Get HEAD commit
    const headRef = await this.refsStore.resolve("HEAD");
    if (!headRef?.objectId) {
      throw new NoHeadError("HEAD is required to apply stash");
    }

    // Get stash commit
    const stashId = await this.resolveStashRef();
    const stashCommit = await this.commits.load(stashId);
    if (!stashCommit) {
      throw new RefNotFoundError(stashId, "Stash commit not found");
    }

    // Validate stash commit structure
    if (stashCommit.parents.length < 2 || stashCommit.parents.length > 3) {
      throw new InvalidArgumentError(
        "stashRef",
        stashId,
        `Stash commit ${stashId} has invalid number of parents: ${stashCommit.parents.length}`,
      );
    }

    const stashHeadCommit = stashCommit.parents[0];
    const stashIndexCommit = stashCommit.parents[1];
    const stashUntrackedCommit = stashCommit.parents[2]; // Optional

    // git's do_apply_stash: the stash's change (its base -> its worktree tree) merged into
    // the current index ("ours" is the tree written from the index, so staged content and
    // newly staged files take part), the result written to the worktree; with --index the
    // stash's index change is merged into the index too, else the index keeps its entries
    // plus the files the stash adds.
    const headCommit = await this.commits.load(headRef.objectId);
    const stashHeadCommitObj = await this.commits.load(stashHeadCommit);
    if (!headCommit || !stashHeadCommitObj) {
      throw new RefNotFoundError(headRef.objectId, "Head or stash commit not found");
    }
    const unmerged: string[] = [];
    const index = new Map<string, CheckedEntry>();
    for await (const entry of this.staging.entries()) {
      if (entry.stage === 0) index.set(entry.path, entry);
      else unmerged.push(entry.path);
    }
    if (unmerged.length > 0) {
      throw new StashApplyFailedError(
        stashId,
        [...new Set(unmerged)],
        "error: you need to resolve your current index first",
      );
    }
    const ignoreCase = coreBool(this.workingCopy, "ignorecase", false);
    const base = await this.flatTree(stashHeadCommitObj.tree);
    const stashWorking = await this.flatTree(stashCommit.tree);
    const ours = new Map(index);

    // --index: the stash's index change onto the current index, refused on a conflict
    let restoredIndex: Map<string, CheckedEntry> | undefined;
    if (this.restoreIndex) {
      const stashIndexCommitObj = await this.commits.load(stashIndexCommit);
      const stashIndex = stashIndexCommitObj ? await this.flatTree(stashIndexCommitObj.tree) : base;
      const indexMerge = await this.mergeFlat(base, ours, stashIndex, ignoreCase);
      if (indexMerge.conflicts.size > 0) {
        throw new StashApplyFailedError(
          stashId,
          [...indexMerge.conflicts.keys()],
          "error: conflicts in index. Try without --index.",
        );
      }
      restoredIndex = indexMerge.result;
    }

    const merge = await this.mergeFlat(base, ours, stashWorking, ignoreCase);

    // symlinks are restored as links, or as files holding the target where the worktree
    // or core.symlinks cannot have links (as clone writes them)
    const trust = worktreeModeTrust(this.workingCopy, worktree);
    // every path of the result verified (verify_path, collisions) before anything is written
    const resultTree = await this.storeFlat(merge.result);
    const worktreePlan = await planTreeRestore(this.trees, this.blobs, resultTree, STASH_APPLY, {
      symlinks: true,
      ignoreCase,
      windows: worktree.capabilities?.windowsPaths === true,
      reservedNames: worktree.capabilities?.reservedNames,
    });

    // Only what the merge changes is touched: the paths where its result differs from the
    // index, and its conflicts, are written, removed or staged; an unrelated unstaged edit is
    // left alone
    const conflicts = merge.conflicts;
    const changed = [...new Set([...ours.keys(), ...merge.result.keys(), ...conflicts.keys()])]
      .filter((p) => conflicts.has(p) || !sameEntry(ours.get(p), merge.result.get(p)))
      .sort();
    const movedFrom = new Set(
      [...conflicts.values()].flatMap((c) => (c.moveFrom ? [c.moveFrom] : [])),
    );
    const removes = changed.filter((p) => !merge.result.has(p) && ours.has(p) && !conflicts.has(p));
    const conflictWrites = [...conflicts.values()].filter((c) => c.content || c.write);
    const writes = [
      ...changed.filter((p) => merge.result.has(p) && !conflicts.has(p)),
      ...conflictWrites.map((c) => c.stagePath),
    ];

    // git's merge refuses before writing anything (protecting untracked files): local
    // changes on a path the merge changes, untracked files where it writes, untracked files
    // in a directory a file of the stash replaces (ignored files are expendable)
    const local: string[] = [];
    for (const path of changed) {
      // a conflict that leaves the worktree file as it is (rename/rename, rename/delete on
      // our side, a binary conflict) only stages: git keeps an unstaged edit there
      const conflict = conflicts.get(path);
      if (conflict && !conflict.content && !conflict.write && !conflict.moveFrom) continue;
      const i = index.get(path);
      if (i && (await worktreeDiffers(worktree, path, i, trust))) local.push(path);
    }
    const found = await findInTheWay(worktree, {
      writes,
      removes: new Set([...removes, ...movedFrom]),
      index,
      ignoreCase,
    });
    const refused = overwriteMessage("merge", { local, ...found });
    if (refused) {
      throw new StashApplyFailedError(
        stashId,
        [...local, ...found.lostDirs, ...found.untracked],
        refused,
      );
    }
    // the stashed untracked files, checked (leading components too) before any write
    const untrackedPlan = await this.planUntrackedRestore(
      stashUntrackedCommit,
      worktreePlan,
      worktree,
    );

    // Everything below this line writes.
    if (untrackedPlan) {
      // git restores the untracked files first; they stay untracked
      await writeTreeRestorePlan(worktree, this.blobs, untrackedPlan, STASH_APPLY, {
        symlinks: trust.symlinks,
      });
    }
    // a file a file/directory conflict moves aside goes to `<path>~<side>` first
    for (const conflict of conflicts.values()) {
      if (!conflict.moveFrom) continue;
      if (conflict.write?.mode === FileMode.GITLINK) {
        // a submodule moved aside: staged at stage 2, its new path an empty directory (as
        // git checks out an unpopulated submodule); the old directory goes only if empty
        if (!(await worktree.getEntry(conflict.stagePath))) {
          await worktree.mkdir(conflict.stagePath);
        }
        await removeIfEmptyDirectory(worktree, conflict.moveFrom);
        continue;
      }
      if (conflict.content) {
        await worktree.writeContent(conflict.stagePath, conflict.content, {
          mode: conflict.mode,
          createParents: true,
          replaceInTheWay: true,
        });
      } else if (conflict.write) {
        await this.writeBlob(worktree, conflict.stagePath, conflict.write, trust.symlinks);
      }
      await worktree.remove(conflict.moveFrom);
    }
    // deletions next, as git's unpack-trees: a deleted file or link `d` makes way for `d/x`
    for (const path of removes) {
      await worktree.remove(path);
      await pruneEmptyParents(worktree, path);
    }
    const writing = new Set(writes.filter((p) => merge.result.has(p)));
    await writeTreeRestorePlan(
      worktree,
      this.blobs,
      {
        ...worktreePlan,
        entries: worktreePlan.entries.filter((e) => writing.has(e.path)),
        gitlinks: [],
      },
      STASH_APPLY,
      { symlinks: trust.symlinks, replaceInTheWay: true },
    );
    // conflicted files: the text with git's markers, or the surviving side of a
    // modify/delete; a binary conflict keeps ours as it is
    for (const conflict of conflicts.values()) {
      if (conflict.moveFrom) continue;
      if (conflict.content) {
        await worktree.writeContent(conflict.stagePath, conflict.content, {
          mode: conflict.mode,
          createParents: true,
          replaceInTheWay: true,
        });
      } else if (conflict.write) {
        await this.writeBlob(worktree, conflict.stagePath, conflict.write, trust.symlinks);
      }
    }

    // the index
    const editor = this.staging.createEditor();
    const stage = async (path: string, entry: CheckedEntry, stageNumber: 0 | 1 | 2 | 3) => {
      // the worktree's stat only for a file that holds the staged blob (else it is rehashed)
      let stats: { size: number; mtime: number; ctime?: number } | undefined;
      if (stageNumber === 0) {
        const current = await worktree.getEntry(path);
        if (
          current &&
          !current.isDirectory &&
          (await worktree.computeHash(path)) === entry.objectId
        ) {
          stats = current;
        }
      }
      editor.upsert({
        path,
        objectId: entry.objectId,
        mode: entry.mode,
        stage: stageNumber,
        size: stats?.size ?? 0,
        mtime: stats?.mtime ?? 0,
        ...(stats?.ctime !== undefined ? { ctime: stats.ctime } : {}),
      });
    };
    if (conflicts.size > 0) {
      // a conflicted merge leaves its result staged and the conflicts at stages 1-3
      for (const path of changed) {
        const result = merge.result.get(path);
        const conflict = conflicts.get(path);
        if (conflict) {
          editor.remove(path);
          if (conflict.base) await stage(conflict.stagePath, conflict.base, 1);
          if (conflict.ours) await stage(conflict.stagePath, conflict.ours, 2);
          if (conflict.theirs) await stage(conflict.stagePath, conflict.theirs, 3);
        } else if (result) await stage(path, result, 0);
        else editor.remove(path);
      }
      await editor.finish();
      await this.staging.write();
      return {
        status: StashApplyStatus.CONFLICTS,
        stashCommit: stashId,
        conflicts: [...conflicts.keys()].sort(),
      };
    }
    if (restoredIndex) {
      // --index: the index is the stash's index change merged into it
      for (const path of new Set([...index.keys(), ...restoredIndex.keys()])) {
        const entry = restoredIndex.get(path);
        if (sameEntry(index.get(path), entry)) continue;
        if (entry) await stage(path, entry, 0);
        else editor.remove(path);
      }
    } else {
      // the index keeps its entries, plus the files the stash adds (git stages them)
      for (const path of changed) {
        const result = merge.result.get(path);
        if (result && !ours.has(path)) await stage(path, result, 0);
      }
    }
    await editor.finish();
    await this.staging.write();

    return {
      status: StashApplyStatus.OK,
      stashCommit: stashId,
    };
  }

  /** Writes a blob to the worktree (a link as a link where the worktree has them). */
  private async writeBlob(
    worktree: Worktree,
    path: string,
    entry: CheckedEntry,
    symlinks: boolean,
  ): Promise<void> {
    const content = await this.blobs.load(entry.objectId);
    if (!content) throw new Error(`${STASH_APPLY} cannot restore ${path}: blob missing`);
    const mode = entry.mode === FileMode.SYMLINK && !symlinks ? FileMode.REGULAR_FILE : entry.mode;
    await worktree.writeContent(path, content, {
      mode,
      createParents: true,
      replaceInTheWay: true,
    });
  }

  /**
   * git's ort merge of a stash: `base` (the stash's parent) to `ours` (the current index)
   * and to `theirs` (the stash). Renames on one side (exact, then by similarity of at least
   * {@link DEFAULT_RENAME_SCORE}%) carry the other side's change to the new path; files both
   * sides changed are merged line by line (`Updated upstream` / `Stashed changes` markers);
   * binary files, modify/delete and file/directory collisions are conflicts as in git.
   */
  private async mergeFlat(
    baseIn: Map<string, CheckedEntry>,
    oursIn: Map<string, CheckedEntry>,
    theirsIn: Map<string, CheckedEntry>,
    ignoreCase = false,
  ): Promise<{
    result: Map<string, CheckedEntry>;
    conflicts: Map<string, MergeConflict>;
  }> {
    const base = new Map(baseIn);
    const ours = new Map(oursIn);
    const theirs = new Map(theirsIn);
    const conflicts = new Map<string, MergeConflict>();
    const oursRenames = await this.detectRenames(baseIn, oursIn);
    const theirsRenames = await this.detectRenames(baseIn, theirsIn);
    // both sides renamed the same path: to one path, it merges there; to two, git's
    // CONFLICT (rename/rename): the original at stage 1 (DD), each side's at its path (AU/UA)
    for (const [from, oursTo] of [...oursRenames]) {
      const theirsTo = theirsRenames.get(from);
      const original = base.get(from);
      if (theirsTo === undefined || !original) continue;
      oursRenames.delete(from);
      theirsRenames.delete(from);
      if (theirsTo === oursTo) {
        base.delete(from);
        base.set(oursTo, original);
        continue;
      }
      const o = ours.get(oursTo);
      const t = theirs.get(theirsTo);
      if (!o || !t || theirs.has(oursTo) || ours.has(theirsTo)) continue;
      base.delete(from);
      ours.delete(oursTo);
      theirs.delete(theirsTo);
      conflicts.set(from, { base: original, stagePath: from, mode: original.mode });
      conflicts.set(oursTo, { ours: o, stagePath: oursTo, mode: o.mode });
      conflicts.set(theirsTo, { theirs: t, stagePath: theirsTo, mode: t.mode, write: t });
    }
    // a path one side renamed: the other side's change merges at the new path; deleted on
    // the other side, git's CONFLICT (rename/delete): stage 1 and the renaming side's
    for (const [renames, side, other, sideIsOurs] of [
      [oursRenames, ours, theirs, true],
      [theirsRenames, theirs, ours, false],
    ] as const) {
      for (const [from, to] of renames) {
        const original = base.get(from);
        if (!original || other.has(to)) continue;
        const moved = other.get(from);
        base.delete(from);
        if (moved) {
          other.delete(from);
          other.set(to, moved);
          base.set(to, original);
          continue;
        }
        const kept = side.get(to);
        if (!kept) continue;
        side.delete(to);
        conflicts.set(to, {
          base: original,
          ...(sideIsOurs ? { ours: kept } : { theirs: kept, write: kept }),
          stagePath: to,
          mode: kept.mode,
        });
      }
    }

    const result = new Map<string, CheckedEntry>();
    const read = async (e?: CheckedEntry) => {
      if (!e) return new Uint8Array(0);
      const chunks: Uint8Array[] = [];
      for await (const chunk of (await this.blobs.load(e.objectId)) ?? []) chunks.push(chunk);
      return concatBytes(chunks);
    };
    for (const path of new Set([...base.keys(), ...ours.keys(), ...theirs.keys()])) {
      const b = base.get(path);
      const o = ours.get(path);
      const t = theirs.get(path);
      if (sameEntry(o, t) || sameEntry(b, t)) {
        if (o) result.set(path, o);
        continue;
      }
      if (sameEntry(b, o)) {
        if (t) result.set(path, t);
        continue;
      }
      if (!o || !t) {
        // modify/delete: the surviving side stays in the worktree, staged 1 and 2 or 3
        conflicts.set(path, {
          base: b,
          ours: o,
          theirs: t,
          stagePath: path,
          mode: (o ?? t)?.mode ?? 0,
          ...(t ? { write: t } : {}),
        });
        continue;
      }
      const textual = (e?: CheckedEntry) =>
        e === undefined || e.mode === FileMode.REGULAR_FILE || e.mode === FileMode.EXECUTABLE_FILE;
      const mode = o.mode === t.mode ? o.mode : b && o.mode === b.mode ? t.mode : o.mode;
      if (textual(o) && textual(t) && textual(b)) {
        const [bb, ob, tb] = [await read(b), await read(o), await read(t)];
        if (![bb, ob, tb].some((bytes) => SimilarityIndex.isBinary(bytes))) {
          const lines = mergeLines(bb, ob, tb, {
            oursLabel: "Updated upstream",
            theirsLabel: "Stashed changes",
          });
          if (lines.conflicts === 0) {
            result.set(path, { objectId: await this.blobs.store([lines.content]), mode });
          } else {
            conflicts.set(path, {
              base: b,
              ours: o,
              theirs: t,
              stagePath: path,
              content: lines.content,
              mode,
            });
          }
          continue;
        }
      }
      // binary files (git: "Cannot merge binary files"), or a link or submodule changed on
      // both sides: ours stays in the worktree, all three staged
      conflicts.set(path, { base: b, ours: o, theirs: t, stagePath: path, mode });
    }
    // a path cannot be a file and a directory at once (CONFLICT (file/directory)): the
    // directory keeps the name, the file (a merged one, or the side a conflict keeps) moves
    // aside to `<path>~<side>`, made unique as git's unique_path: `_0`, `_1`, ... appended
    // while the name is a path (or a directory) of any of the three trees, or already taken
    const dirsOf = (paths: Iterable<string>) => {
      const dirs = new Set<string>();
      for (const path of paths) {
        for (let k = path.indexOf("/"); k > 0; k = path.indexOf("/", k + 1)) {
          dirs.add(path.slice(0, k));
        }
      }
      return dirs;
    };
    // on a case-folding worktree (core.ignorecase) a name taken in another case is taken:
    // the moved file would land on that path
    const fold = (name: string) => (ignoreCase ? name.toLowerCase() : name);
    const taken = new Set<string>();
    for (const map of [baseIn, oursIn, theirsIn, base, ours, theirs]) {
      for (const path of map.keys()) taken.add(fold(path));
      for (const dir of dirsOf(map.keys())) taken.add(fold(dir));
    }
    const uniquePath = (path: string, label: string) => {
      let name = `${path}~${label}`;
      for (let n = 0; taken.has(fold(name)); n++) name = `${path}~${label}_${n}`;
      taken.add(fold(name));
      return name;
    };
    const outcomeDirs = dirsOf([
      ...result.keys(),
      ...[...conflicts.values()].map((c) => c.stagePath),
    ]);
    const theirsDirs = dirsOf(theirs.keys());
    const files = [
      ...result.keys(),
      ...[...conflicts.entries()].filter(([, c]) => c.ours || c.theirs).map(([p]) => p),
    ].sort();
    for (const path of files) {
      if (!outcomeDirs.has(path)) continue;
      // the side whose tree has the directory keeps it; the file is the other side's
      const oursFile = theirsDirs.has(path);
      const label = oursFile ? "Updated upstream" : "Stashed changes";
      const moveFrom = oursFile && ours.has(path) ? { moveFrom: path } : {};
      const merged = result.get(path);
      if (merged) {
        result.delete(path);
        conflicts.set(path, {
          ...(oursFile ? { ours: merged } : { theirs: merged }),
          stagePath: uniquePath(path, label),
          mode: merged.mode,
          write: merged,
          ...moveFrom,
        });
        continue;
      }
      const conflict = conflicts.get(path) as MergeConflict;
      const kept = oursFile ? conflict.ours : conflict.theirs;
      conflicts.set(path, {
        ...conflict,
        stagePath: uniquePath(path, label),
        ...(kept && !conflict.content ? { write: kept } : {}),
        ...moveFrom,
      });
    }
    return { result, conflicts };
  }

  /**
   * The paths `side` renamed from `base`: a deleted path paired with an added one holding
   * the same blob, else (text files) the most similar added one scoring at least
   * {@link DEFAULT_RENAME_SCORE}, as git's rename detection.
   */
  private async detectRenames(
    base: Map<string, CheckedEntry>,
    side: Map<string, CheckedEntry>,
  ): Promise<Map<string, string>> {
    const deleted = [...base.keys()].filter((p) => !side.has(p));
    const added = new Set([...side.keys()].filter((p) => !base.has(p)));
    const renames = new Map<string, string>();
    if (deleted.length === 0 || added.size === 0) return renames;
    for (const from of deleted) {
      const blob = base.get(from)?.objectId;
      const to = [...added].find((p) => side.get(p)?.objectId === blob);
      if (to) {
        renames.set(from, to);
        added.delete(to);
      }
    }
    // inexact renames, bounded as git's rename limit bounds them
    const left = deleted.filter((p) => !renames.has(p));
    if (left.length === 0 || added.size === 0 || left.length * added.size > 1000) return renames;
    const read = async (e?: CheckedEntry) => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of (await this.blobs.load(e?.objectId ?? "")) ?? [])
        chunks.push(chunk);
      return concatBytes(chunks);
    };
    const candidates = new Map<string, SimilarityIndex>();
    for (const p of added) {
      const bytes = await read(side.get(p));
      if (!SimilarityIndex.isBinary(bytes)) candidates.set(p, SimilarityIndex.create(bytes));
    }
    for (const from of left) {
      const bytes = await read(base.get(from));
      if (SimilarityIndex.isBinary(bytes)) continue;
      const index = SimilarityIndex.create(bytes);
      let best: string | undefined;
      let bestScore = DEFAULT_RENAME_SCORE - 1;
      for (const [to, other] of candidates) {
        const score = index.score(other);
        if (score > bestScore) {
          best = to;
          bestScore = score;
        }
      }
      if (best) {
        renames.set(from, best);
        candidates.delete(best);
      }
    }
    return renames;
  }

  /** Stores a flat path map as a tree. */
  private async storeFlat(entries: Map<string, CheckedEntry>): Promise<ObjectId> {
    type Node = Map<string, Node | CheckedEntry>;
    const root: Node = new Map();
    for (const [path, entry] of entries) {
      const parts = path.split("/");
      let node = root;
      for (const part of parts.slice(0, -1)) {
        let next = node.get(part);
        if (!(next instanceof Map)) {
          next = new Map();
          node.set(part, next);
        }
        node = next;
      }
      node.set(parts[parts.length - 1], entry);
    }
    const store = async (node: Node): Promise<ObjectId> => {
      const list: { name: string; mode: number; id: ObjectId }[] = [];
      for (const [name, value] of node) {
        if (value instanceof Map) list.push({ name, mode: FileMode.TREE, id: await store(value) });
        else list.push({ name, mode: value.mode, id: value.objectId });
      }
      return this.trees.storeTree(list);
    };
    return store(root);
  }

  /** The blobs, links and gitlinks of a tree, by path. */
  private async flatTree(treeId: ObjectId): Promise<Map<string, CheckedEntry>> {
    const out = new Map<string, CheckedEntry>();
    const walk = async (id: ObjectId, prefix: string): Promise<void> => {
      for await (const entry of this.trees.loadTree(id)) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.mode === FileMode.TREE) await walk(entry.id, path);
        else out.set(path, { objectId: entry.id, mode: entry.mode });
      }
    };
    await walk(treeId, "");
    return out;
  }

  /**
   * Plan the restore of the stash's untracked files, if there are any to restore.
   *
   * Untracked files are stashed in their own parentless commit and are not
   * merged with anything: they are simply written back. A stashed untracked
   * file whose path is already taken - by a file on disk, or by one the merged
   * tree is about to write - is refused rather than overwritten, since nothing
   * in the stash records what the displaced content was.
   *
   * @param untrackedCommitId The stash's third parent, if it has one
   * @param worktreePlan The already-planned restore of the merged working tree
   * @param worktree The working tree, checked for existing files
   * @returns The plan, or undefined if there is nothing to restore
   */
  private async planUntrackedRestore(
    untrackedCommitId: ObjectId | undefined,
    worktreePlan: TreeRestorePlan,
    worktree: Worktree,
  ): Promise<TreeRestorePlan | undefined> {
    if (!this.restoreUntracked || !untrackedCommitId) {
      return undefined;
    }

    const untrackedCommit = await this.commits.load(untrackedCommitId);
    if (!untrackedCommit) {
      throw new RefNotFoundError(untrackedCommitId, "Stash untracked commit not found");
    }

    const plan = await planTreeRestore(this.trees, this.blobs, untrackedCommit.tree, STASH_APPLY, {
      symlinks: true,
      ignoreCase: coreBool(this.workingCopy, "ignorecase", false),
      windows: worktree.capabilities?.windowsPaths === true,
      reservedNames: worktree.capabilities?.reservedNames,
    });

    const taken: string[] = [];
    for (const { path } of plan.entries) {
      // a file on a leading component: git cannot create the directory, and restores
      // nothing ("cannot create directory at 'd': File exists")
      const parts = path.split("/");
      for (let k = 1; k < parts.length; k++) {
        const prefix = parts.slice(0, k).join("/");
        const entry = await worktree.getEntry(prefix);
        if (entry && !entry.isDirectory) {
          throw new StashApplyFailedError(
            untrackedCommitId,
            [prefix],
            `fatal: cannot create directory at '${prefix}': File exists\nerror: could not restore untracked files from stash`,
          );
        }
      }
      // taken by a file on disk (untracked or tracked), or one the merge writes: git's
      // `checkout-index --all` refuses each such path
      if (worktreePlan.paths.has(path) || (await worktree.exists(path))) taken.push(path);
    }
    if (taken.length > 0) {
      throw new StashApplyFailedError(
        untrackedCommitId,
        taken,
        [
          ...taken.map((p) => `${p} already exists, no checkout`),
          "error: could not restore untracked files from stash",
        ].join("\n"),
      );
    }

    return plan;
  }

  /**
   * Resolve the stash reference to a commit ID.
   */
  private async resolveStashRef(): Promise<ObjectId> {
    const refName = this.stashRef ?? `${STASH_REF}@{0}`;

    // Handle stash@{N} syntax
    const match = refName.match(/^(.+)@\{(\d+)\}$/);
    if (match) {
      let baseRef = match[1];
      const index = parseInt(match[2], 10);

      // Normalize stash to refs/stash
      if (baseRef === "stash") {
        baseRef = STASH_REF;
      }

      // For index 0, just resolve the ref
      if (index === 0) {
        const ref = await this.refsStore.resolve(baseRef);
        if (!ref?.objectId) {
          throw new RefNotFoundError(refName);
        }
        return ref.objectId;
      }

      // Older entries are in the ref's reflog (stash@{n}), as git reads them
      const reflog = await this.refsStore.getReflog?.(baseRef);
      if (!reflog) {
        throw new RefNotFoundError(refName, `Stash entry ${index} not found (no reflog)`);
      }
      const entry = await reflog.getReverseEntry(index);
      if (!entry) throw new RefNotFoundError(refName, `Stash entry ${index} not found`);
      return entry.newId;
    }

    // Try as direct ref
    const ref = await this.refsStore.resolve(refName);
    if (ref?.objectId) {
      return ref.objectId;
    }

    // Try as commit ID
    if (await this.commits.has(refName)) {
      return refName;
    }

    throw new RefNotFoundError(refName);
  }
}
