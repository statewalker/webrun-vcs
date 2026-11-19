/**
 * The sparse checkout's half of unpack-trees, shared by every command that writes the index
 * and the worktree together (`checkout`, `switch`, `reset --hard/--merge/--keep`, the merge
 * family through `switchTrees`) and by `git sparse-checkout` itself.
 *
 * git marks the entries outside the sparse-checkout patterns skip-worktree
 * (`mark_new_skip_worktree`) and then, per entry, removes the files that go out of the
 * checkout and writes those that come back (`apply_sparse_checkout`, `check_updates`). Here
 * the commands write their result first; {@link applySparseCheckout} then runs git's loop
 * over the index they leave, comparing it with the index they started from, so a command
 * needs nothing of its own beyond a snapshot of the index taken before it changes anything.
 */

import type { Blobs } from "@statewalker/vcs-core";
import { FileMode, type ObjectId } from "@statewalker/vcs-core";
import { parseGitBool } from "@statewalker/vcs-utils";
import {
  attributesIndexOf,
  entryStatOf,
  parseSparseCheckoutPatterns,
  type SparseCheckoutPatterns,
  type Staging,
  type StagingEntry,
  type WorkingCopy,
  type Worktree,
} from "@statewalker/vcs-working-tree";

import { RemoteConfigStore } from "../remote-config/index.js";
import { worktreeModeTrust } from "./core-config.js";
import { planFlatRestore, writeTreeRestorePlan } from "./tree-restore.js";
import {
  entryNotUptodate,
  flaggedEntryDiffers,
  pruneEmptyParents,
  removeDirectoryIfEmpty,
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

/** A stage-0 entry as the snapshot keeps it. */
interface SnapshotEntry {
  objectId: ObjectId;
  mode: number;
  skipWorktree: boolean;
}

/** The index before an unpack: its stage-0 entries and the paths that were unmerged. */
export interface SparseIndexSnapshot {
  entries: Map<string, SnapshotEntry>;
  unmerged: Set<string>;
}

/** The index as it is now, for {@link applySparseCheckout} once a command has written its result. */
export async function snapshotSparseIndex(staging: Staging): Promise<SparseIndexSnapshot> {
  const entries = new Map<string, SnapshotEntry>();
  const unmerged = new Set<string>();
  for (const entry of await entryList(staging)) {
    if (entry.stage === 0) {
      entries.set(entry.path, {
        objectId: entry.objectId,
        mode: entry.mode,
        skipWorktree: entry.skipWorktree === true,
      });
    } else unmerged.add(entry.path);
  }
  return { entries, unmerged };
}

/** The entry as one without flags: its file compared by content, as `ie_match_stat` does. */
const unflagged = (entry: StagingEntry): StagingEntry => ({
  ...entry,
  skipWorktree: false,
  assumeValid: false,
});

async function entryList(staging: Staging): Promise<readonly StagingEntry[]> {
  const list = staging.entryList?.();
  if (list) return list;
  const out: StagingEntry[] = [];
  for await (const entry of staging.entries()) out.push(entry);
  return out;
}

/** What {@link applySparseCheckout} needs of a command. */
export interface SparseApplyContext {
  workingCopy: WorkingCopy;
  worktree?: Worktree;
  staging: Staging;
  blobs: Blobs;
}

/** Options of {@link applySparseCheckout}. */
export interface SparseApplyOptions {
  /**
   * The index before the command changed it ({@link snapshotSparseIndex}): the entries it
   * added, changed or kept are told apart by it, and their files are the ones the command
   * wrote. Absent: git's `update_sparsity` on the index as it is (nothing was written).
   */
  before?: SparseIndexSnapshot;
  /**
   * The unpack resets (`o->reset`: `reset --hard`, `checkout -f`): a changed file going out
   * of the checkout is removed all the same, never reported as not up to date.
   */
  reset?: boolean;
}

/** The paths unpack-trees reports while it applies the patterns (its sparse warnings). */
export interface SparseApplyOutcome {
  /** Files out of the patterns kept for their changes (WARNING_SPARSE_NOT_UPTODATE_FILE) */
  notUptodate: string[];
  /** Unmerged paths left in the worktree (WARNING_SPARSE_UNMERGED_FILE) */
  unmerged: string[];
  /** Files back in the patterns not written over what stands there (WARNING_SPARSE_ORPHANED_NOT_OVERWRITTEN) */
  orphaned: string[];
  /** The files removed from the worktree, now skip-worktree */
  removed: string[];
  /** The files written into the worktree, no longer skip-worktree */
  written: string[];
  /** Whether the index was changed (and written) */
  changed: boolean;
}

/**
 * git's sparse-checkout loop of unpack-trees (`mark_new_skip_worktree` and
 * `apply_sparse_checkout` over the result, then `check_updates`) on the index and worktree a
 * command left, or, without `before`, git's `update_sparsity` (`git sparse-checkout`): every
 * stage-0 entry outside `patterns` (and not unmerged before) becomes skip-worktree and its
 * file is removed (directories left empty go too, as `unlink_entry`), unless it has changes
 * (kept, flag cleared, reported); every skip-worktree entry back inside the patterns is
 * written and loses the flag, unless something stands at its path (reported). The index is
 * written when a flag changed.
 */
export async function applySparseCheckout(
  ctx: SparseApplyContext,
  patterns: SparseCheckoutPatterns,
  options: SparseApplyOptions = {},
): Promise<SparseApplyOutcome> {
  const outcome: SparseApplyOutcome = {
    notUptodate: [],
    unmerged: [],
    orphaned: [],
    removed: [],
    written: [],
    changed: false,
  };
  const { staging, worktree } = ctx;
  const before = options.before;
  const trust = worktree ? worktreeModeTrust(ctx.workingCopy, worktree) : undefined;
  const indexTime = staging.getUpdateTime();
  const entries = await entryList(staging);
  /** path -> the flag it ends with */
  const flags = new Map<string, boolean>();
  const removing: StagingEntry[] = [];
  const writing: StagingEntry[] = [];
  let lastUnmerged: string | undefined;
  const exists = async (path: string) => {
    if (!worktree) return false;
    try {
      return (await worktree.getEntry(path)) !== undefined;
    } catch {
      return false;
    }
  };
  for (const entry of entries) {
    const path = entry.path;
    if (entry.stage !== 0) {
      // update_sparsity: warn_conflicted_path, once per path
      if (!before && lastUnmerged !== path) outcome.unmerged.push(path);
      lastUnmerged = path;
      continue;
    }
    const conflictedBefore = before?.unmerged.has(path) === true;
    // mark_new_skip_worktree: only unmerged entries are in, then the patterns widen it
    const now = !conflictedBefore && !patterns.includes(path);
    const old = before?.entries.get(path);
    // an entry the unpack added starts as skip-worktree when it goes out (loop #2); a kept or
    // changed one carries the old entry's bit (merged_entry migrates it)
    const was = before
      ? old
        ? old.skipWorktree && !conflictedBefore
        : conflictedBefore
          ? false
          : now
      : entry.skipWorktree === true;
    const changed = before
      ? !old || old.objectId !== entry.objectId || old.mode !== entry.mode || conflictedBefore
      : false;
    let flag = now;
    if (was && now) {
      // a file the command wrote nonetheless is taken out again (never written by git)
      if (before && worktree && (await exists(path))) removing.push(entry);
    } else if (!was && now) {
      if (worktree && !changed && !options.reset && (await exists(path))) {
        // verify_uptodate_sparse: a changed file stays, without the flag
        if (
          entry.mode !== FileMode.GITLINK &&
          (before
            ? await entryNotUptodate(worktree, path, unflagged(entry), trust, indexTime)
            : // the index as read, never refreshed: its stat decides (ie_match_stat)
              await flaggedEntryDiffers(worktree, path, unflagged(entry), trust, indexTime))
        ) {
          outcome.notUptodate.push(path);
          flag = false;
        } else removing.push(entry);
      } else if (worktree && (await exists(path))) removing.push(entry);
    } else if (was && !now) {
      // verify_absent_sparse: a file standing there (not one the command wrote) is kept
      if (worktree) {
        const present = await exists(path);
        if (present && !before) outcome.orphaned.push(path);
        else if (!present) writing.push(entry);
      }
    }
    if (flag !== (entry.skipWorktree === true)) flags.set(path, flag);
  }

  if (worktree) {
    // check_updates: the removals first (unlink_entry, the emptied directories after them)
    for (const entry of removing) {
      if (entry.mode === FileMode.GITLINK) {
        await removeDirectoryIfEmpty(worktree, entry.path);
      } else {
        await worktree.remove(entry.path);
      }
      await pruneEmptyParents(worktree, entry.path);
      outcome.removed.push(entry.path);
    }
    if (writing.length > 0) {
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
      await writeTreeRestorePlan(worktree, ctx.blobs, plan, "sparse-checkout", {
        symlinks: trust?.symlinks ?? true,
        gitlinks: true,
        attributes: { direction: "checkout", index: attributesIndexOf(index) },
      });
      outcome.written.push(...writing.map((e) => e.path));
    }
  }

  if (flags.size === 0 && outcome.written.length === 0) return outcome;
  const written = new Set(outcome.written);
  const editor = staging.createEditor();
  for (const path of new Set([...flags.keys(), ...written])) {
    const flag = flags.get(path);
    const stats = written.has(path) && worktree ? await worktree.getEntry(path) : undefined;
    editor.add({
      path,
      apply: (existing) => {
        if (!existing) return existing;
        // the stat of the file written (check_updates refreshes the entry)
        return {
          ...existing,
          ...(flag !== undefined ? { skipWorktree: flag } : {}),
          ...(stats && !stats.isDirectory ? entryStatOf(stats) : {}),
        };
      },
    });
  }
  await editor.finish();
  await staging.write();
  outcome.changed = true;
  return outcome;
}

/**
 * The lines git prints for the paths {@link applySparseCheckout} reports, on stderr. With
 * `porcelain` (`setup_unpack_trees_porcelain`: `checkout`, `switch`, the merge family,
 * `sparse-checkout`) one `warning:` block per kind and git's reminder to reapply; without
 * (`reset --merge`, `reset --keep`) one `error:` line per path, as `add_rejected_path` prints
 * them when it does not collect them.
 */
export function sparseWarningText(outcome: SparseApplyOutcome, porcelain: boolean): string {
  if (!porcelain) {
    return [
      ...outcome.notUptodate.map(
        (p) => `error: Path '${p}' not uptodate; will not remove from working tree.\n`,
      ),
      ...outcome.unmerged.map(
        (p) => `error: Path '${p}' unmerged; will not remove from working tree.\n`,
      ),
      ...outcome.orphaned.map(
        (p) => `error: Path '${p}' already present; will not overwrite with sparse update.\n`,
      ),
    ].join("");
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

/** git's `warning: ` lines for the patterns' own warnings (`add_pattern_to_hashsets`). */
export function patternWarningText(patterns: SparseCheckoutPatterns | undefined): string {
  return (patterns?.warnings ?? []).map((w) => `warning: ${w}\n`).join("");
}

/**
 * The sparse checkout's patterns and a snapshot of the index, taken by an index-writing
 * command before it changes anything; undefined outside a sparse checkout (or without a
 * worktree: unpack-trees then has no update to make).
 */
export interface SparseCheckoutRun {
  patterns: SparseCheckoutPatterns;
  before: SparseIndexSnapshot;
}

/** Starts a {@link SparseCheckoutRun} when `core.sparseCheckout` is on. */
export async function startSparseCheckoutRun(ctx: {
  workingCopy: WorkingCopy;
  worktree?: Worktree;
  staging: Staging;
}): Promise<SparseCheckoutRun | undefined> {
  if (!ctx.worktree) return undefined;
  const patterns = await readSparseCheckoutPatterns(ctx.workingCopy);
  if (!patterns) return undefined;
  return { patterns, before: await snapshotSparseIndex(ctx.staging) };
}

/**
 * Finishes a {@link SparseCheckoutRun} once the command wrote its result: git's
 * `apply_sparse_checkout` loop. Returns what git prints on stderr for it (the patterns'
 * warnings, then the sparse warnings), empty when nothing is to be said.
 */
export async function finishSparseCheckoutRun(
  ctx: SparseApplyContext,
  run: SparseCheckoutRun | undefined,
  options: { reset?: boolean; porcelain: boolean },
): Promise<string> {
  if (!run) return "";
  const outcome = await applySparseCheckout(ctx, run.patterns, {
    before: run.before,
    ...(options.reset ? { reset: true } : {}),
  });
  return patternWarningText(run.patterns) + sparseWarningText(outcome, options.porcelain);
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
