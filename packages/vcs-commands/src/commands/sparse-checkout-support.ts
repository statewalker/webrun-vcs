/**
 * The sparse checkout's half of unpack-trees, shared by every command that writes the index
 * and the worktree together (`checkout`, `switch`, `reset --hard/--merge/--keep`, the merge
 * family through `switchTrees`, `clone --sparse`) and by `git sparse-checkout` itself.
 *
 * git marks the entries outside the sparse-checkout patterns before it merges
 * (`mark_new_skip_worktree`, loop #1), so the merge functions neither check nor touch the
 * files of entries that stay outside (`verify_uptodate` and `verify_absent` skip
 * `CE_NEW_SKIP_WORKTREE`); new entries are marked once the merge is done (loop #2), then
 * `apply_sparse_checkout` decides, entry by entry and before anything is written, which files
 * leave the checkout (`verify_uptodate_sparse`) and which come back (`verify_absent_sparse`),
 * and `check_updates` removes and writes. A command takes a {@link SparseUnpack} before it
 * changes anything, asks it which paths it may check, write and remove
 * ({@link SparseUnpack.leavesAlone}, {@link SparseUnpack.writes}), unlinks the files
 * {@link SparseUnpack.leaving} returns with its own removals, and once its result is
 * written lets {@link SparseUnpack.finish} set the flags and write the entries that came
 * back. Nothing is written first and taken out again.
 */

import type { Blobs } from "@statewalker/vcs-core";
import { FileMode, type ObjectId } from "@statewalker/vcs-core";
import { parseGitBool } from "@statewalker/vcs-utils";
import {
  attributesIndexOf,
  basicStatMatches,
  entryStatOf,
  getWorktreeEntries,
  parseSparseCheckoutPatterns,
  type SparseCheckoutPatterns,
  type Staging,
  type StagingEntry,
  type WorkingCopy,
  type Worktree,
  type WorktreeEntry,
  type WorktreeModeTrust,
} from "@statewalker/vcs-working-tree";

import { RemoteConfigStore } from "../remote-config/index.js";
import { worktreeModeTrust } from "./core-config.js";
import { planFlatRestore, writeTreeRestorePlan } from "./tree-restore.js";
import {
  flaggedEntryDiffers,
  pruneEmptyParents,
  removeDirectoryIfEmpty,
  untrackedUnder,
} from "./worktree-overwrite-checks.js";

/** The sparse checkout's settings, as git reads them into its globals. */
export interface SparseCheckoutConfig {
  /** `core.sparseCheckout` (git's `core_apply_sparse_checkout`) */
  enabled: boolean;
  /** `core.sparseCheckoutCone` */
  cone: boolean;
  /** `core.ignoreCase` */
  ignoreCase: boolean;
  /** `sparse.expectFilesOutsideOfPatterns` */
  expectFilesOutside: boolean;
}

/** The sparse checkout's configuration of a working copy. */
export function sparseCheckoutConfig(workingCopy: WorkingCopy): SparseCheckoutConfig {
  if (!workingCopy.config) {
    return { enabled: false, cone: false, ignoreCase: false, expectFilesOutside: false };
  }
  const config = RemoteConfigStore.from(workingCopy);
  const bool = (key: string) => {
    try {
      return parseGitBool(config.value(key)) === true;
    } catch {
      return false;
    }
  };
  return {
    enabled: bool("core.sparseCheckout"),
    cone: bool("core.sparseCheckoutCone"),
    ignoreCase: bool("core.ignoreCase"),
    expectFilesOutside: bool("sparse.expectFilesOutsideOfPatterns"),
  };
}

/** The sparse-checkout file's text (`$GIT_DIR/info/sparse-checkout`), undefined when there is none. */
export async function readSparseCheckoutFile(
  workingCopy: WorkingCopy,
): Promise<string | undefined> {
  const bytes = await workingCopy.checkout
    ?.readStateFile?.("info/sparse-checkout")
    .catch(() => undefined);
  return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
}

/**
 * The sparse checkout's patterns (`$GIT_DIR/info/sparse-checkout`, cone matching with
 * `core.sparseCheckoutCone`, case folded with `core.ignoreCase`) for git's
 * `path_in_sparse_checkout`, or undefined when `core.sparseCheckout` is off (every path
 * is in the checkout).
 */
export async function readSparseCheckoutPatterns(
  workingCopy: WorkingCopy,
): Promise<SparseCheckoutPatterns | undefined> {
  const config = sparseCheckoutConfig(workingCopy);
  if (!config.enabled) return undefined;
  const content = await readSparseCheckoutFile(workingCopy);
  return parseSparseCheckoutPatterns(content, config.cone, config.ignoreCase);
}

/** What unpack-trees reports while it applies the patterns (its sparse warnings). */
type SparseReportKind = "notUptodate" | "unmerged" | "orphaned";

/** The paths unpack-trees reports while it applies the patterns, and what it changed. */
export interface SparseApplyOutcome {
  /** Files out of the patterns kept for their changes (WARNING_SPARSE_NOT_UPTODATE_FILE) */
  notUptodate: string[];
  /** Unmerged paths left in the worktree (WARNING_SPARSE_UNMERGED_FILE) */
  unmerged: string[];
  /** Files back in the patterns not written over what stands there (WARNING_SPARSE_ORPHANED_NOT_OVERWRITTEN) */
  orphaned: string[];
  /** Every report in index order, as git prints them one by one without porcelain messages */
  reports: { kind: SparseReportKind; path: string }[];
  /** The files removed from the worktree, now skip-worktree */
  removed: string[];
  /** The files written into the worktree, no longer skip-worktree */
  written: string[];
  /** Whether the index was changed (and written) */
  changed: boolean;
  /**
   * check_updates' `unlink_or_warn` lines for files leaving the checkout that could not be
   * removed ("warning: unable to unlink 'p': Is a directory"), printed after the sparse
   * warnings by unpack-trees, before them by `update_sparsity`
   */
  unlinkWarnings: string[];
}

async function entryList(staging: Staging): Promise<readonly StagingEntry[]> {
  const list = staging.entryList?.();
  if (list) return list;
  const out: StagingEntry[] = [];
  for await (const entry of staging.entries()) out.push(entry);
  return out;
}

/** What {@link SparseUnpack.finish} needs of a command. */
export interface SparseApplyContext {
  workingCopy: WorkingCopy;
  worktree?: Worktree;
  staging: Staging;
  blobs: Blobs;
}

/** The stage-0 entry a command's result holds at a path, undefined when it removes the path. */
export type SparseResultLookup = (path: string) => { objectId: ObjectId; mode: number } | undefined;

/** Byte order of paths, as the index sorts them (UTF-16 order below the surrogates). */
const pathOrder = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Whether a leading directory of `path` is a symbolic link: git's `lstat` follows it to
 * whatever it points to, which this worktree never looks into. `seen` caches the answer of
 * each directory.
 */
async function beneathLink(
  worktree: Worktree,
  path: string,
  seen: Map<string, "dir" | "link" | "none">,
): Promise<boolean> {
  for (let k = path.indexOf("/"); k > 0; k = path.indexOf("/", k + 1)) {
    const dir = path.slice(0, k);
    let kind = seen.get(dir);
    if (kind === undefined) {
      const entry = await worktree.getEntry(dir).catch(() => undefined);
      kind = !entry
        ? "none"
        : entry.mode === FileMode.SYMLINK
          ? "link"
          : entry.isDirectory
            ? "dir"
            : "none";
      seen.set(dir, kind);
    }
    if (kind === "link") return true;
    if (kind === "none") return false;
  }
  return false;
}

/**
 * Whether a leading component of `path` is a file or link that `verify_absent_1` would
 * refuse to replace (`check_leading_path`, then `check_ok_to_remove`: an ignored one is
 * expendable).
 */
async function blockedLeadingPath(
  worktree: Worktree,
  path: string,
  preserveIgnored = false,
): Promise<boolean> {
  for (let k = path.indexOf("/"); k > 0; k = path.indexOf("/", k + 1)) {
    const prefix = path.slice(0, k);
    const entry = await worktree.getEntry(prefix).catch(() => undefined);
    if (!entry) return false;
    if (entry.isDirectory && entry.mode !== FileMode.SYMLINK) continue;
    return preserveIgnored || !(await worktree.isIgnored(prefix));
  }
  return false;
}

/**
 * git's sparse checkout over one unpack-trees run (`unpack_trees` with `update`, or
 * `update_sparsity`), taken by a command before it changes anything: the patterns, and the
 * index as the command found it (git's `o->src_index`, with its time for the racy check).
 *
 * @example
 * ```typescript
 * const sparse = await SparseUnpack.start(ctx);
 * // the merge's checks and writes skip what stays outside the checkout
 * if (!sparse?.leavesAlone(path)) verifyUptodate(path);
 * // before writing: the files that leave the checkout (verify_uptodate_sparse)
 * const unlink = await sparse.leaving(worktree, (p) => result.get(p));
 * await sparse.unlink(worktree, unlink);
 * // ...the command's own removals and writes, only of paths sparse.writes() accepts...
 * const outcome = await sparse.finish(ctx, { written });
 * ```
 */
export class SparseUnpack {
  /** The source index's stage-0 entries */
  private readonly src = new Map<string, StagingEntry>();
  /** Paths unmerged in the source index (mark_new_skip_worktree: never skip-worktree) */
  private readonly unmergedSrc = new Set<string>();
  /** The source entries in the checkout that its patterns put outside (copied, in index order) */
  private readonly candidates: StagingEntry[] = [];
  /** Paths whose conflicts the command records */
  private readonly conflicts = new Set<string>();
  private readonly inPatterns = new Map<string, boolean>();
  /** Files going out that were kept for their changes: they lose no flag */
  private readonly kept = new Set<string>();
  /** Kept files changed behind a matching stat (racy): their entries are smudged */
  private readonly smudge = new Set<string>();
  private readonly reports: { kind: SparseReportKind; path: string }[] = [];
  private readonly removed: string[] = [];
  private readonly unlinkWarnings: string[] = [];

  private constructor(
    readonly patterns: SparseCheckoutPatterns,
    entries: readonly StagingEntry[],
    /** The source index's time (`o->src_index->timestamp`), for `ie_match_stat`'s racy check */
    readonly srcTime: number,
  ) {
    for (const entry of entries) {
      if (entry.stage !== 0) {
        this.unmergedSrc.add(entry.path);
        continue;
      }
      this.src.set(entry.path, entry);
    }
    for (const entry of this.src.values()) {
      if (!entry.skipWorktree && this.outside(entry.path)) this.candidates.push({ ...entry });
    }
  }

  /**
   * The run of an index-writing command in a sparse checkout (`core.sparseCheckout` on, a
   * worktree to update), undefined otherwise: unpack-trees then has nothing to apply.
   */
  static async start(ctx: {
    workingCopy: WorkingCopy;
    worktree?: Worktree;
    staging: Staging;
  }): Promise<SparseUnpack | undefined> {
    if (!ctx.worktree) return undefined;
    const patterns = await readSparseCheckoutPatterns(ctx.workingCopy);
    if (!patterns) return undefined;
    return SparseUnpack.of(patterns, ctx.staging);
  }

  /** A run over the index as it is now, with `patterns`. */
  static async of(patterns: SparseCheckoutPatterns, staging: Staging): Promise<SparseUnpack> {
    return new SparseUnpack(patterns, await entryList(staging), staging.getUpdateTime());
  }

  /**
   * Paths whose conflicts the command records (merge-ort's `record_conflicted_index_entries`,
   * whose stage entries are never skip-worktree). One whose source entry was skip-worktree,
   * or that had none, has its file written whatever the patterns say (the stage-0 entry
   * unpack-trees left skip-worktree is checked out). One whose source entry was in the
   * checkout but is outside the patterns now leaves it as any other entry does:
   * `apply_sparse_checkout` set `CE_WT_REMOVE`, which `checkout_entry` honours by unlinking,
   * so its content is only in the index stages (a changed file is kept, as ever).
   */
  conflict(paths: Iterable<string>): void {
    for (const path of paths) this.conflicts.add(path);
  }

  /**
   * `CE_NEW_SKIP_WORKTREE` of a stage-0 entry the result holds at `path`: outside the
   * patterns, and neither unmerged in the source index (loop #1 of
   * `mark_new_skip_worktree`) nor conflicted by the command where its file is written
   * (see {@link conflict}).
   */
  outside(path: string): boolean {
    if (this.unmergedSrc.has(path)) return false;
    if (this.conflicts.has(path)) {
      const old = this.src.get(path);
      if (!old || old.skipWorktree) return false;
    }
    let included = this.inPatterns.get(path);
    if (included === undefined) {
      included = this.patterns.includes(path);
      this.inPatterns.set(path, included);
    }
    return !included;
  }

  /**
   * Whether the command leaves the worktree at `path` alone, its checks included: the path
   * stays outside the patterns and its source entry is skip-worktree, or it has none (a new
   * entry, which loop #2 marks skip-worktree). git's `verify_uptodate` and `verify_absent`
   * skip such an entry, and `apply_sparse_checkout` drops its update and its removal
   * (`was_skip_worktree && ce_skip_worktree`). Its index entry is changed all the same. Ask
   * only for a path the command's source index or target holds.
   */
  leavesAlone(path: string): boolean {
    if (!this.outside(path)) return false;
    const old = this.src.get(path);
    return old ? old.skipWorktree === true : true;
  }

  /** Whether the command writes the file of the entry its result holds at `path`. */
  writes(path: string): boolean {
    return !this.outside(path);
  }

  /**
   * `apply_sparse_checkout` for the source entries the patterns take out of the checkout
   * (`!was_skip_worktree && ce_skip_worktree`), decided before anything is written: an
   * entry the result removes is the command's own removal; one it changes, or any with
   * `reset` (`o->reset`: the one-way merge flagged its changed file `CE_UPDATE`), is
   * unlinked (the command checked it as git's merge functions do); an unchanged one is
   * unlinked unless `verify_uptodate_sparse` finds its file changed (by its stat against
   * the source index, racy entries read), in which case it stays, keeps no flag, and is
   * reported. A file reached through a symlinked leading directory is reported, never
   * unlinked: git's `lstat` finds what the link points to. Returns the files to unlink, for
   * {@link unlink} with the command's own removals.
   */
  async leaving(
    worktree: Worktree | undefined,
    result: SparseResultLookup,
    options: { reset?: boolean; trust?: WorktreeModeTrust } = {},
  ): Promise<string[]> {
    if (!worktree) return [];
    const unlink: string[] = [];
    const checking: StagingEntry[] = [];
    for (const old of this.candidates) {
      if (!this.outside(old.path)) continue;
      const now = result(old.path);
      if (!now) continue;
      if (options.reset || now.objectId !== old.objectId || now.mode !== old.mode) {
        unlink.push(old.path);
      } else checking.push(old);
    }
    if (checking.length === 0) return unlink;
    const found = await getWorktreeEntries(
      worktree,
      checking.map((e) => e.path),
    );
    const links = new Map<string, "dir" | "link" | "none">();
    for (let i = 0; i < checking.length; i++) {
      const old = checking[i] as StagingEntry;
      const current: WorktreeEntry | null = found[i] ?? null;
      const changed =
        current === null
          ? await beneathLink(worktree, old.path, links)
          : // verify_uptodate_1 of an entry already skip-worktree: ie_match_stat, no refresh
            await flaggedEntryDiffers(
              worktree,
              old.path,
              { ...old, skipWorktree: true },
              options.trust,
              this.srcTime,
              current,
            );
      if (changed) {
        this.kept.add(old.path);
        this.reports.push({ kind: "notUptodate", path: old.path });
        // a change only the content showed: the index written records size 0, as git's
        // ce_smudge_racily_clean_entry does for an entry racy against the source index
        if (current && basicStatMatches(old, current, options.trust)) this.smudge.add(old.path);
      } else unlink.push(old.path);
    }
    return unlink;
  }

  /**
   * `check_updates`' `unlink_entry` of the files {@link leaving} gave: a submodule's
   * directory only when empty, the directories left empty after (`schedule_dir_for_removal`).
   * Nothing beneath a symbolic link is touched.
   */
  async unlink(worktree: Worktree, paths: readonly string[]): Promise<void> {
    for (const path of paths) {
      if (this.src.get(path)?.mode === FileMode.GITLINK) {
        await removeDirectoryIfEmpty(worktree, path);
      } else {
        const current = await worktree.getEntry(path).catch(() => undefined);
        if (current?.isDirectory && current.mode !== FileMode.SYMLINK) {
          // unlink_or_warn on a directory: EISDIR, the directory and the flag kept as they are
          this.unlinkWarnings.push(`warning: unable to unlink '${path}': Is a directory\n`);
          continue;
        }
        if (current) await worktree.remove(path);
      }
      await pruneEmptyParents(worktree, path);
      this.removed.push(path);
    }
  }

  /**
   * The rest of `apply_sparse_checkout` once the command wrote its result: every stage-0
   * entry outside the patterns becomes skip-worktree (but those {@link leaving} kept), every
   * other loses the flag; a skip-worktree entry back in the patterns that the command did
   * not write (`written`) is written unless something stands at its path
   * (`verify_absent_sparse`: an untracked file, or a directory holding one, is kept and
   * reported; an ignored one is replaced; with `overwrite`, `UNPACK_RESET_OVERWRITE_UNTRACKED`,
   * anything is). A directory holding such a file keeps the entry unwritten without a report
   * (verify_clean_subdirectory's ERROR_NOT_UPTODATE_DIR, which unpack-trees never prints with
   * the sparse warnings). With `warnUnmerged` (`update_sparsity`) unmerged paths are reported.
   * With `preserveIgnored` (`update_sparsity`, which runs without `o->internal.dir`) ignored
   * files are no more expendable than untracked ones. The index is written when an entry
   * changed.
   */
  async finish(
    ctx: SparseApplyContext,
    options: {
      written?: ReadonlySet<string>;
      overwrite?: boolean;
      warnUnmerged?: boolean;
      preserveIgnored?: boolean;
    } = {},
  ): Promise<SparseApplyOutcome> {
    const { staging, worktree } = ctx;
    const entries = await entryList(staging);
    const flags = new Map<string, boolean>();
    const back: StagingEntry[] = [];
    let lastUnmerged: string | undefined;
    for (const entry of entries) {
      const path = entry.path;
      if (entry.stage !== 0) {
        // update_sparsity: warn_conflicted_path, once per path
        if (options.warnUnmerged && lastUnmerged !== path) {
          this.reports.push({ kind: "unmerged", path });
        }
        lastUnmerged = path;
        continue;
      }
      const outside = this.outside(path);
      if (!outside && entry.skipWorktree && worktree && !options.written?.has(path)) {
        back.push(entry);
      }
      const flag = outside && !this.kept.has(path);
      if (flag !== (entry.skipWorktree === true)) flags.set(path, flag);
    }

    const writing: StagingEntry[] = [];
    if (worktree && back.length > 0) {
      const found = options.overwrite
        ? []
        : await getWorktreeEntries(
            worktree,
            back.map((e) => e.path),
          );
      let tracked: Set<string> | undefined;
      for (let i = 0; i < back.length; i++) {
        const entry = back[i] as StagingEntry;
        const current = found[i];
        let present: boolean;
        if (options.overwrite) present = false;
        else if (!current) {
          present = await blockedLeadingPath(worktree, entry.path, options.preserveIgnored);
        } else if (current.isDirectory && current.mode !== FileMode.SYMLINK) {
          // verify_clean_subdirectory: what is untracked there would be lost
          tracked ??= new Set(entries.map((e) => e.path));
          const known = tracked;
          // ERROR_NOT_UPTODATE_DIR: the entry stays unwritten, and nothing is printed
          if (
            entry.mode !== FileMode.GITLINK &&
            (await untrackedUnder(
              worktree,
              entry.path,
              (p) => known.has(p),
              options.preserveIgnored === true,
            ))
          ) {
            continue;
          }
          present = false;
        } else {
          // the rules read now (never the entry's lazy `isIgnored`, which answers before the
          // ignore files are read)
          present = options.preserveIgnored === true || !(await worktree.isIgnored(entry.path));
        }
        if (present) this.reports.push({ kind: "orphaned", path: entry.path });
        else writing.push(entry);
      }
    }
    const written: string[] = [];
    if (worktree && writing.length > 0) {
      const target = new Map<string, { objectId: ObjectId; mode: number }>();
      for (const entry of writing) target.set(entry.path, entry);
      const plan = await planFlatRestore(
        ctx.blobs,
        target,
        new Set(target.keys()),
        "sparse-checkout",
        {
          symlinks: true,
          windows: worktree.capabilities?.windowsPaths === true,
          reservedNames: worktree.capabilities?.reservedNames,
        },
      );
      // the files smudged with the attributes of the index they are written from
      const index = new Map<string, ObjectId>();
      for (const entry of entries) {
        if (entry.stage === 0 && entry.path.endsWith(".gitattributes")) {
          index.set(entry.path, entry.objectId);
        }
      }
      const trust = worktreeModeTrust(ctx.workingCopy, worktree);
      await writeTreeRestorePlan(worktree, ctx.blobs, plan, "sparse-checkout", {
        symlinks: trust.symlinks,
        gitlinks: true,
        replaceInTheWay: true,
        ...(options.overwrite ? { discardUntracked: true } : {}),
        attributes: { direction: "checkout", index: attributesIndexOf(index) },
      });
      written.push(...writing.map((e) => e.path));
    }

    const outcome = this.outcome(written, false);
    if (flags.size === 0 && written.length === 0 && this.smudge.size === 0) return outcome;
    const writtenSet = new Set(written);
    const stats = worktree && written.length > 0 ? await getWorktreeEntries(worktree, written) : [];
    const statOf = new Map<string, WorktreeEntry | undefined>();
    for (let i = 0; i < written.length; i++) statOf.set(written[i] as string, stats[i]);
    const editor = staging.createEditor();
    for (const path of new Set([...flags.keys(), ...writtenSet, ...this.smudge])) {
      const flag = flags.get(path);
      const stat = statOf.get(path);
      const smudge = this.smudge.has(path);
      editor.add({
        path,
        apply: (existing) => {
          if (!existing) return existing;
          // the stat of the file written (check_updates refreshes the entry)
          return {
            ...existing,
            ...(flag !== undefined ? { skipWorktree: flag } : {}),
            ...(stat && !stat.isDirectory ? entryStatOf(stat) : {}),
            ...(smudge ? { size: 0 } : {}),
          };
        },
      });
    }
    await editor.finish();
    await staging.write();
    outcome.changed = true;
    return outcome;
  }

  private outcome(written: string[], changed: boolean): SparseApplyOutcome {
    const of = (kind: SparseReportKind) =>
      this.reports.filter((r) => r.kind === kind).map((r) => r.path);
    return {
      notUptodate: of("notUptodate"),
      unmerged: of("unmerged"),
      orphaned: of("orphaned"),
      reports: [...this.reports].sort((a, b) => pathOrder(a.path, b.path)),
      removed: [...this.removed],
      written,
      changed,
      unlinkWarnings: [...this.unlinkWarnings],
    };
  }
}

/**
 * git's `update_sparsity` (`git sparse-checkout set/add/reapply/init/disable`): the index as
 * it is, every stage-0 entry outside `patterns` made skip-worktree and its file removed
 * unless changed (kept, reported), every skip-worktree entry back inside written unless
 * something stands there (reported), unmerged paths reported. The index is written when a
 * flag changed.
 */
export async function updateSparsity(
  ctx: SparseApplyContext,
  patterns: SparseCheckoutPatterns,
): Promise<SparseApplyOutcome> {
  const unpack = await SparseUnpack.of(patterns, ctx.staging);
  const worktree = ctx.worktree;
  if (worktree) {
    const source = new Map<string, StagingEntry>();
    for (const entry of await entryList(ctx.staging)) {
      if (entry.stage === 0) source.set(entry.path, entry);
    }
    const unlink = await unpack.leaving(worktree, (path) => source.get(path), {
      trust: worktreeModeTrust(ctx.workingCopy, worktree),
    });
    await unpack.unlink(worktree, unlink);
  }
  return unpack.finish(ctx, { warnUnmerged: true, preserveIgnored: true });
}

/**
 * git's `clean_tracked_sparse_directories` after `update_sparsity` (cone mode only, an index
 * without unmerged entries): each top-most directory outside the cone whose entries are all
 * skip-worktree and none a submodule (what `convert_to_sparse` collapses) is removed with
 * what is left in it when that is only ignored files, else warned about. A directory reached
 * through a symbolic link is never entered. Returns git's warning lines.
 */
export async function cleanTrackedSparseDirectories(
  ctx: { worktree?: Worktree; staging: Staging },
  patterns: SparseCheckoutPatterns,
): Promise<string> {
  const worktree = ctx.worktree;
  if (!worktree || !patterns.cone) return "";
  const entries = await entryList(ctx.staging);
  if (entries.length === 0 || entries.some((e) => e.stage !== 0)) return "";
  // the directories holding an entry that keeps them from being collapsed
  const blocked = new Set<string>();
  const dirs: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const stays = !entry.skipWorktree || entry.mode === FileMode.GITLINK;
    for (let k = entry.path.indexOf("/"); k > 0; k = entry.path.indexOf("/", k + 1)) {
      const dir = entry.path.slice(0, k + 1);
      if (!seen.has(dir)) {
        seen.add(dir);
        dirs.push(dir);
      }
      if (stays) blocked.add(dir);
    }
  }
  // convert_to_sparse_rec: top-down, the first directory outside the cone that can be
  // collapsed stands for everything beneath it
  const sparseDirs: string[] = [];
  for (const dir of dirs) {
    if (sparseDirs.some((d) => dir.startsWith(d))) continue;
    if (blocked.has(dir) || patterns.includes(dir)) continue;
    sparseDirs.push(dir);
  }
  let text = "";
  for (const dir of sparseDirs) {
    const path = dir.slice(0, -1);
    const current = await worktree.getEntry(path).catch(() => undefined);
    if (!current?.isDirectory || current.mode === FileMode.SYMLINK) continue;
    const tracked = new Set(entries.map((e) => e.path));
    if (await untrackedUnder(worktree, path, (p) => tracked.has(p))) {
      text += `warning: directory '${dir}' contains untracked files, but is not in the sparse-checkout cone\n`;
      continue;
    }
    const removed = await worktree.remove(path, { recursive: true }).catch(() => false);
    if (!removed) text += `warning: failed to remove directory '${dir}'\n`;
  }
  return text;
}

/**
 * The lines git prints for the paths a sparse run reports, on stderr. With `porcelain`
 * (`setup_unpack_trees_porcelain`: `checkout`, `switch`, the merge family,
 * `sparse-checkout`) one `warning:` block per kind and git's reminder to reapply; without
 * (`reset --merge`, `reset --keep`) one `error:` line per path in index order, as
 * `add_rejected_path` prints them when it does not collect them.
 */
export function sparseWarningText(outcome: SparseApplyOutcome, porcelain: boolean): string {
  if (!porcelain) {
    const line = {
      notUptodate: (p: string) =>
        `error: Path '${p}' not uptodate; will not remove from working tree.\n`,
      unmerged: (p: string) => `error: Path '${p}' unmerged; will not remove from working tree.\n`,
      orphaned: (p: string) =>
        `error: Path '${p}' already present; will not overwrite with sparse update.\n`,
    };
    return outcome.reports.map((r) => line[r.kind](r.path)).join("");
  }
  const blocks: [string[], string][] = [
    [
      outcome.notUptodate,
      "The following paths are not up to date and were left despite sparse patterns:",
    ],
    [outcome.unmerged, "The following paths are unmerged and were left despite sparse patterns:"],
    [
      outcome.orphaned,
      "The following paths were already present and thus not updated despite sparse patterns:",
    ],
  ];
  let text = "";
  for (const [paths, header] of blocks) {
    if (paths.length === 0) continue;
    text += `warning: ${header}\n${paths.map((p) => `\t${p}\n`).join("")}\n`;
  }
  if (text) {
    text += "After fixing the above paths, you may want to run `git sparse-checkout reapply`.\n";
  }
  return text;
}

/**
 * What a command's sparse run printed (the patterns' warnings, then the sparse warnings),
 * appended to `lines` one entry per line.
 */
export function pushSparseWarnings(
  lines: string[] | undefined,
  sparse: SparseUnpack | undefined,
  outcome: SparseApplyOutcome | undefined,
  porcelain: boolean,
): string {
  if (!sparse || !outcome) return "";
  const text =
    patternWarningText(sparse.patterns) +
    sparseWarningText(outcome, porcelain) +
    outcome.unlinkWarnings.join("");
  if (text) lines?.push(...text.replace(/\n$/, "").split("\n"));
  return text;
}

/** git's `warning: ` lines for the patterns' own warnings (`add_pattern_to_hashsets`). */
export function patternWarningText(patterns: SparseCheckoutPatterns | undefined): string {
  return (patterns?.warnings ?? []).map((w) => `warning: ${w}\n`).join("");
}

/**
 * git's `advise_on_updating_sparse_paths` (`add`, `rm`): the elements that matched only
 * entries outside the sparse checkout and, unless `advice.updateSparsePath` is off, the
 * hint, its last line as the version words it (2.43: "git config advice...", 2.5x: "git
 * config set advice...").
 */
export function sparsePathAdvice(
  elements: readonly string[],
  advice: boolean,
  compatibility: "2.43" | "2.56" = "2.56",
): string[] {
  const lines = [
    "The following paths and/or pathspecs matched paths that exist",
    "outside of your sparse-checkout definition, so will not be",
    "updated in the index:",
    ...elements,
  ];
  if (advice) {
    const command = compatibility === "2.43" ? "git config" : "git config set";
    lines.push(
      "hint: If you intend to update such entries, try one of the following:",
      "hint: * Use the --sparse option.",
      "hint: * Disable or modify the sparsity rules.",
      `hint: Disable this message with "${command} advice.updateSparsePath false"`,
    );
  }
  return lines;
}
