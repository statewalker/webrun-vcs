/**
 * git's `checkout_paths` (builtin/checkout.c), shared by `git checkout [<tree-ish>] --
 * <pathspec>` and `git restore`: the index entries a pathspec names are checked out to the
 * worktree, from the index or from a tree (`read_tree_some` puts the tree's entries into the
 * index first), in overlay mode or not, with `--ours`/`--theirs`/`--merge` for unmerged
 * paths and skip-worktree entries passed over unless `--ignore-skip-worktree-bits`.
 */

import { type Blobs, FileMode, type ObjectId, PromisorFetchError } from "@statewalker/vcs-core";
import { type ConflictStyle, compareGitPaths } from "@statewalker/vcs-utils";
import { collect } from "@statewalker/vcs-utils/streams";
import {
  entryStatOf,
  type IndexEntryOptions,
  type ResolveUndoRecord,
  type Staging,
  type StagingEntry,
  type WorkingCopy,
  type Worktree,
} from "@statewalker/vcs-working-tree";

import {
  IncompatibleOptionsError,
  InvalidArgumentError,
  RefNotFoundError,
} from "../errors/index.js";
import type { CommandTrees } from "../git-command.js";
import { worktreeModeTrust } from "./core-config.js";
import { addLeadingDirs, stageZeroClashes } from "./index-adder.js";
import { conflictStyleOf } from "./merge-config.js";
import { lowLevelMerge, ortConfigOptions } from "./merge-drivers.js";
import { flatTree, rewriteIndex } from "./merge-support.js";
import {
  DO_MATCH_DIRECTORY,
  type GlobalPathspecMagic,
  matchPathspec,
  matchPathspecSeen,
  type PathspecItem,
  parsePathspec,
  pathspecErrors,
} from "./pathspec.js";
import { PathspecAttributes } from "./pathspec-attributes.js";
import {
  pruneEmptyParents,
  removeDirectoryIfEmpty,
  worktreeDiffers,
} from "./worktree-overwrite-checks.js";

/** What {@link checkoutPaths} reads and writes. */
export interface CheckoutPathsContext {
  workingCopy: WorkingCopy;
  staging: Staging;
  trees: CommandTrees;
  blobs: Blobs;
  worktree: Worktree | undefined;
  /** An object id abbreviated as git prints it (`repo_find_unique_abbrev`) */
  abbreviate(id: ObjectId): Promise<string>;
}

/** The `checkout_opts` that `checkout_paths` reads. */
export interface CheckoutPathsOptions {
  /** The parsed pathspec */
  items: PathspecItem[];
  /** The elements as given, for `report_path_error` */
  originals: readonly string[];
  /** Report elements that matched nothing (off for a whole-index checkout) */
  reportUnmatched?: boolean;
  /** The tree checked out of (`opts->source_tree`); none: the index */
  sourceTree?: ObjectId;
  /** Update the index (`checkout_index`) */
  checkoutIndex: boolean;
  /** Update the worktree (`checkout_worktree`) */
  checkoutWorktree: boolean;
  /** Overlay mode: entries the tree lacks are kept (checkout's default) */
  overlay: boolean;
  /** `--ignore-skip-worktree-bits` */
  ignoreSkipWorktree?: boolean;
  /** `--ours` (2) / `--theirs` (3) */
  writeoutStage?: number;
  /** `-m` / `--merge` / `--conflict`: unmerged paths re-created */
  merge?: boolean;
  /** `--conflict=<style>`; default `merge.conflictStyle` */
  conflictStyle?: ConflictStyle;
  /** `--ignore-unmerged` (`restore`), or `checkout -f` */
  ignoreUnmerged?: boolean;
  /** `-q`: no "path is unmerged" warning, no counts */
  quiet?: boolean;
  /** `count_checkout_paths`: "Updated N paths from ..." (checkout without `--`) */
  countCheckoutPaths?: boolean;
}

/** What {@link checkoutPaths} did. */
export interface CheckoutPathsOutcome {
  /** false where git returns 1 (an error was reported) */
  ok: boolean;
  /**
   * git's exit status where it is neither 0 nor 1: 255 once `checkout_worktree` reported an
   * error (an entry it could not write: its `error()` returns -1)
   */
  exitCode?: number;
  /** git's `error: ...` lines */
  errors: string[];
  /** The other stderr lines: warnings and the counts */
  warnings: string[];
  /** The paths written to the worktree */
  updated: string[];
  /** The paths unlinked from the worktree */
  removed: string[];
  /** The elements that matched nothing, or the paths an error named */
  conflicts: string[];
}

/** A path checkout as `checkout` or `restore` was asked for it (`checkout_opts`). */
export interface PathCheckoutRequest {
  /** Which command: its option checks and messages differ */
  command: "checkout" | "restore";
  /** The pathspec elements as given */
  paths: readonly string[];
  /** The whole index (or tree), whatever the paths: nothing is reported unmatched */
  allPaths?: boolean;
  /** The tree-ish checked out of (`checkout <tree-ish> --`, `restore --source`) */
  source?: string;
  /** `restore --staged` (checkout: always) */
  staged?: boolean;
  /** `restore --worktree` (checkout: always; restore's default without `--staged`) */
  worktree?: boolean;
  /** `--overlay` / `--no-overlay`; default: on for checkout, off for restore */
  overlay?: boolean;
  ignoreSkipWorktree?: boolean;
  /** `--ours` (2) / `--theirs` (3) */
  stage?: number;
  merge?: boolean;
  conflictStyle?: ConflictStyle;
  /** `checkout -f`: unmerged entries are passed over with a warning */
  force?: boolean;
  /** `restore --ignore-unmerged` */
  ignoreUnmerged?: boolean;
  quiet?: boolean;
  countCheckoutPaths?: boolean;
  /** The global pathspec magic (`GIT_LITERAL_PATHSPECS`, ...) */
  globalMagic?: GlobalPathspecMagic;
}

/**
 * `checkout_main`'s and `checkout_paths`' option checks (git's `die()`s, thrown), the
 * pathspec parsed, the source resolved, then {@link checkoutPaths}.
 *
 * @param resolveTree The object a revision names and its tree (`parse_tree_indirect`), the
 *   tree undefined when the object is no tree-ish; throws {@link RefNotFoundError} when it
 *   names nothing
 */
export async function runPathCheckout(
  ctx: CheckoutPathsContext & {
    resolveTree(rev: string): Promise<{ id: ObjectId; tree: ObjectId | undefined }>;
  },
  req: PathCheckoutRequest,
): Promise<CheckoutPathsOutcome> {
  const isRestore = req.command === "restore";
  // checkout writes both; restore the worktree unless only --staged is given
  let checkoutIndex: boolean;
  let checkoutWorktree: boolean;
  if (!isRestore) {
    checkoutIndex = true;
    checkoutWorktree = true;
  } else if (req.staged !== undefined || req.worktree !== undefined) {
    checkoutIndex = req.staged === true;
    checkoutWorktree = req.worktree === true;
  } else {
    checkoutIndex = false;
    checkoutWorktree = true;
  }
  let from = req.source;
  if (isRestore && from === undefined && checkoutIndex) from = "HEAD";
  const ignoreUnmerged = isRestore ? req.ignoreUnmerged === true : req.force === true;
  const fail = (options: string[], message: string) =>
    new IncompatibleOptionsError(options, message);

  // the pathspec (`parse_pathspec(&opts->pathspec, 0, 0, prefix, argv)`): attr allowed
  let items: PathspecItem[] = [];
  const originals = req.allPaths && req.paths.length === 0 ? ["."] : [...req.paths];
  try {
    items = parsePathspec(originals, { attr: true, global: req.globalMagic });
  } catch (error) {
    throw new InvalidArgumentError("path", req.paths, `fatal: ${(error as Error).message}`);
  }
  if (items.length === 0 && !req.allPaths) {
    throw new InvalidArgumentError("path", req.paths, "fatal: you must specify path(s) to restore");
  }
  if (1 < Number(!!req.stage) + Number(!isRestore && !!req.force) + Number(!!req.merge)) {
    throw fail(
      ["--ours/--theirs", "--force", "--merge"],
      "fatal: git checkout: --ours/--theirs, --force and --merge are incompatible when\nchecking out of the index.",
    );
  }
  // the source tree, resolved before checkout_paths runs
  let sourceTree: ObjectId | undefined;
  if (from !== undefined) {
    let resolved: { id: ObjectId; tree: ObjectId | undefined };
    try {
      resolved = await ctx.resolveTree(from);
    } catch (error) {
      if (error instanceof RefNotFoundError) {
        throw new RefNotFoundError(
          from,
          isRestore ? `fatal: could not resolve '${from}'` : `fatal: invalid reference: ${from}`,
        );
      }
      throw error;
    }
    // git 2.5x's parse_tree_indirect dies on an object that is no tree-ish (2.43 went on
    // to "fatal: reference is not a tree: <rev>")
    if (!resolved.tree) {
      throw new RefNotFoundError(from, `fatal: unable to read tree (${resolved.id})`);
    }
    sourceTree = resolved.tree;
  }
  if (ignoreUnmerged && req.merge) {
    throw fail(
      [isRestore ? "--ignore-unmerged" : "--force", "-m"],
      `fatal: options '${isRestore ? "--ignore-unmerged" : "--force"}' and '-m' cannot be used together`,
    );
  }
  if (!checkoutWorktree && !checkoutIndex) {
    throw fail(
      ["--staged", "--worktree"],
      "fatal: neither '--staged' or '--worktree' is specified",
    );
  }
  if (!checkoutWorktree && from === undefined) {
    throw fail(
      ["--worktree", "--source"],
      "fatal: '--worktree' must be used when '--source' is not specified",
    );
  }
  if (isRestore && checkoutIndex) {
    if (req.stage) {
      throw fail(
        ["--ours", "--theirs", "--staged"],
        "fatal: '--ours' or '--theirs' cannot be used with --staged",
      );
    }
    if (req.merge) {
      throw fail(
        ["--merge", "--conflict", "--staged"],
        "fatal: '--merge' or '--conflict' cannot be used with --staged",
      );
    }
  }
  if ((req.merge || req.stage) && sourceTree) {
    throw fail(
      ["--merge", "--ours", "--theirs"],
      "fatal: '--merge', '--ours', or '--theirs' cannot be used when checking out of a tree",
    );
  }
  return checkoutPaths(ctx, {
    items,
    originals,
    reportUnmatched: !req.allPaths,
    ...(sourceTree ? { sourceTree } : {}),
    checkoutIndex,
    checkoutWorktree,
    overlay: req.overlay ?? !isRestore,
    ignoreSkipWorktree: req.ignoreSkipWorktree === true,
    ...(req.stage ? { writeoutStage: req.stage } : {}),
    merge: req.merge === true || req.conflictStyle !== undefined,
    ...(req.conflictStyle ? { conflictStyle: req.conflictStyle } : {}),
    ignoreUnmerged,
    quiet: req.quiet === true,
    countCheckoutPaths: req.countCheckoutPaths === true,
  });
}

/** An index entry while `checkout_paths` works on it, with its `ce_flags`. */
interface Rec {
  entry: IndexEntryOptions;
  /** CE_UPDATE: from the tree (or the same as it) */
  update: boolean;
  /** Fresh from the tree: no stat recorded yet */
  fresh: boolean;
  matched: boolean;
  remove: boolean;
  wtRemove: boolean;
}

const stageOf = (e: IndexEntryOptions) => e.stage ?? 0;
const isGitlink = (mode: number) => mode === FileMode.GITLINK;

/**
 * Runs git's `checkout_paths` past its option checks: `read_tree_some`, `unmerge_index`,
 * the marking (`mark_ce_for_checkout_overlay` / `_no_overlay`), `report_path_error`, the
 * unmerged-path checks, `checkout_worktree` and the index write.
 */
export async function checkoutPaths(
  ctx: CheckoutPathsContext,
  o: CheckoutPathsOptions,
): Promise<CheckoutPathsOutcome> {
  const { staging, worktree } = ctx;
  const errors: string[] = [];
  const warnings: string[] = [];
  const out: CheckoutPathsOutcome = {
    ok: true,
    errors,
    warnings,
    updated: [],
    removed: [],
    conflicts: [],
  };

  // the index, by path (stages in order); paths whose entries change
  const byPath = new Map<string, Rec[]>();
  for await (const entry of staging.entries()) {
    const rec: Rec = {
      entry: { ...entry },
      update: false,
      fresh: false,
      matched: false,
      remove: false,
      wtRemove: false,
    };
    const list = byPath.get(entry.path);
    if (list) list.push(rec);
    else byPath.set(entry.path, [rec]);
  }
  const changed = new Set<string>();
  const resolveUndo: ResolveUndoRecord[] = [];
  // the resolve-undo records unmerge_index used up (dropped with the index write)
  const undone = new Set<string>();
  const recordUndo = (path: string, recs: Rec[]) => {
    const record: ResolveUndoRecord = {
      path,
      modes: [0, 0, 0],
      objectIds: [undefined, undefined, undefined],
    };
    let any = false;
    for (const r of recs) {
      const stage = stageOf(r.entry);
      if (stage < 1 || stage > 3) continue;
      record.modes[stage - 1] = r.entry.mode;
      record.objectIds[stage - 1] = r.entry.objectId;
      any = true;
    }
    if (any) resolveUndo.push(record);
  };

  // `:(attr:...)`: the attributes of the index's and the tree's paths
  const tree = o.sourceTree ? await flatTree(ctx.trees, o.sourceTree) : undefined;
  const attributes = PathspecAttributes.forWorktree(o.items, worktree);
  if (attributes) await attributes.load([...byPath.keys(), ...(tree?.keys() ?? [])]);
  const flagsOf = (mode: number) => (isGitlink(mode) ? DO_MATCH_DIRECTORY : 0);

  // read_tree_some: each tree entry the pathspec names goes into the index (update_some)
  if (tree) {
    const hasStageZero = (path: string) =>
      byPath.get(path)?.some((r) => stageOf(r.entry) === 0) === true;
    const dirs = new Set<string>();
    for (const path of byPath.keys()) addLeadingDirs(dirs, path);
    for (const [path, t] of tree) {
      if (matchPathspec(o.items, path, flagsOf(t.mode)) <= 0) continue;
      const list = byPath.get(path);
      const old = list?.find((r) => stageOf(r.entry) === 0);
      if (
        old &&
        old.entry.mode === t.mode &&
        !old.entry.intentToAdd &&
        old.entry.objectId === t.objectId
      ) {
        old.update = true;
        continue;
      }
      // add_index_entry(ADD_CACHE_OK_TO_REPLACE): a stage-0 entry replaces every stage of
      // its path (recorded for resolve-undo) and the stage-0 entries it clashes with as a
      // file or a directory (their conflict stages stay)
      if (list) recordUndo(path, list);
      for (const other of stageZeroClashes(path, hasStageZero, byPath.keys(), dirs)) {
        const kept = (byPath.get(other) ?? []).filter((r) => stageOf(r.entry) > 0);
        if (kept.length > 0) byPath.set(other, kept);
        else byPath.delete(other);
        changed.add(other);
      }
      addLeadingDirs(dirs, path);
      byPath.set(path, [
        {
          entry: { path, mode: t.mode, objectId: t.objectId, stage: 0, size: 0, mtime: 0 },
          update: true,
          fresh: true,
          matched: false,
          remove: false,
          wtRemove: false,
        },
      ]);
      changed.add(path);
    }
  }

  // unmerge_index: the conflicts the resolve-undo records keep come back
  if (o.merge) {
    for (const record of staging.getResolveUndo?.() ?? []) {
      if (matchPathspec(o.items, record.path, 0) <= 0) continue;
      undone.add(record.path);
      const list = byPath.get(record.path);
      // already unmerged: left as it is
      if (list?.some((r) => stageOf(r.entry) > 0)) continue;
      const recs: Rec[] = [];
      for (let k = 0; k < 3; k++) {
        const mode = record.modes[k];
        const objectId = record.objectIds[k];
        if (!mode || !objectId) continue;
        recs.push({
          entry: {
            path: record.path,
            mode,
            objectId,
            stage: (k + 1) as 1 | 2 | 3,
            size: 0,
            mtime: 0,
          },
          update: false,
          fresh: true,
          matched: false,
          remove: false,
          wtRemove: false,
        });
      }
      if (recs.length > 0) byPath.set(record.path, recs);
      else byPath.delete(record.path);
      changed.add(record.path);
    }
  }

  // the index in its order (by path bytes, then stage)
  const paths = [...byPath.keys()].sort(compareGitPaths);
  const ordered: Rec[] = [];
  for (const path of paths) {
    const list = (byPath.get(path) ?? []).sort((a, b) => stageOf(a.entry) - stageOf(b.entry));
    ordered.push(...list);
  }

  // mark_ce_for_checkout_*: which entries are checked out, which the pathspec matched
  const seen = o.items.map(() => 0);
  for (const rec of ordered) {
    rec.matched = false;
    const e = rec.entry;
    if (!o.ignoreSkipWorktree && e.skipWorktree) continue;
    if (o.overlay) {
      if (o.sourceTree && !rec.update) continue;
      if (matchPathspecSeen(o.items, e.path, flagsOf(e.mode), seen)) rec.matched = true;
    } else if (matchPathspecSeen(o.items, e.path, flagsOf(e.mode), seen)) {
      rec.matched = true;
      // not in the tree-ish: removed from the index and the worktree
      if (o.sourceTree && !rec.update) {
        rec.remove = true;
        rec.wtRemove = true;
      }
    }
  }

  if (o.reportUnmatched !== false) {
    const unmatched = pathspecErrors(o.originals, seen);
    if (unmatched.length > 0) {
      errors.push(...unmatched);
      out.ok = false;
      out.conflicts = o.originals.filter((_, i) => !seen[i]);
      return out;
    }
  }

  // any unmerged paths?
  let errs = false;
  forEachMatchedPath(ordered, (rec, stages) => {
    if (stageOf(rec.entry) === 0) return;
    const path = rec.entry.path;
    if (o.ignoreUnmerged) {
      if (!o.quiet) warnings.push(`warning: path '${path}' is unmerged`);
    } else if (o.writeoutStage) {
      if (!stages.some((r) => stageOf(r.entry) === o.writeoutStage) && o.overlay) {
        errors.push(stageMissing(path, o.writeoutStage));
        out.conflicts.push(path);
        errs = true;
      }
    } else if (o.merge) {
      const have = new Set(stages.map((r) => stageOf(r.entry)));
      if (!have.has(2) || !have.has(3)) {
        errors.push(`error: path '${path}' does not have all necessary versions`);
        out.conflicts.push(path);
        errs = true;
      }
    } else {
      errors.push(`error: path '${path}' is unmerged`);
      out.conflicts.push(path);
      errs = true;
    }
  });
  if (errs) {
    out.ok = false;
    return out;
  }

  // now committed to check them out
  if (o.checkoutWorktree) {
    const ok = await checkoutWorktree(ctx, o, ordered, out, changed);
    if (!ok) {
      out.ok = false;
      out.exitCode = 255;
    }
  }
  // remove_marked_cache_entries
  for (const rec of ordered) {
    if (rec.remove) {
      const list = byPath.get(rec.entry.path);
      if (list) {
        const kept = list.filter((r) => r !== rec);
        if (kept.length > 0) byPath.set(rec.entry.path, kept);
        else byPath.delete(rec.entry.path);
      }
      changed.add(rec.entry.path);
    }
  }

  // the index is written when it is checked out to, or to save the stat of files checked
  // out of it
  const checkoutIndex =
    o.checkoutWorktree && !o.checkoutIndex && !o.sourceTree ? true : o.checkoutIndex;
  if (checkoutIndex) {
    if (undone.size > 0) staging.dropResolveUndo?.(undone);
    if (resolveUndo.length > 0) staging.recordResolveUndo?.(resolveUndo);
    const changes = new Map<string, IndexEntryOptions[]>();
    for (const path of changed) {
      changes.set(
        path,
        (byPath.get(path) ?? []).map((r) => r.entry),
      );
    }
    await rewriteIndex(staging, changes);
  }
  return out;
}

/** Calls `fn` once per matched path (its first matched entry, all its entries). */
function forEachMatchedPath(ordered: Rec[], fn: (rec: Rec, stages: Rec[]) => void): void {
  for (let i = 0; i < ordered.length; i++) {
    const rec = ordered[i];
    if (!rec.matched) continue;
    let j = i + 1;
    while (j < ordered.length && ordered[j].entry.path === rec.entry.path) j++;
    const stages = ordered.slice(i, j);
    if (stageOf(rec.entry) === 0) {
      fn(rec, stages);
      continue;
    }
    fn(rec, stages);
    i = j - 1;
  }
}

/** What `checkout_entry` did with an entry. */
type CheckedOut = "written" | "unchanged" | "failed";

/**
 * git's `check_leading_path` returning -1: every leading component of `path` is there as a
 * directory (none missing, none a symbolic link or a file).
 */
async function leadingDirectoriesExist(worktree: Worktree, path: string): Promise<boolean> {
  for (let k = path.indexOf("/"); k > 0; k = path.indexOf("/", k + 1)) {
    const entry = await worktree.getEntry(path.slice(0, k)).catch(() => undefined);
    if (!entry?.isDirectory || entry.mode === FileMode.SYMLINK) return false;
  }
  return true;
}

const stageMissing = (path: string, stage: number) =>
  stage === 2
    ? `error: path '${path}' does not have our version`
    : `error: path '${path}' does not have their version`;

/** git's `checkout_worktree`: false when an error was reported. */
async function checkoutWorktree(
  ctx: CheckoutPathsContext,
  o: CheckoutPathsOptions,
  ordered: Rec[],
  out: CheckoutPathsOutcome,
  changed: Set<string>,
): Promise<boolean> {
  const worktree = ctx.worktree;
  let nrCheckouts = 0;
  let nrUnmerged = 0;
  let ok = true;
  if (worktree) {
    const trust = worktreeModeTrust(ctx.workingCopy, worktree);
    const indexTime = ctx.staging.getUpdateTime();
    const symlinks = trust.symlinks;
    // git's unlink_entry: nothing beneath a missing leading directory or a symbolic link
    // (check_leading_path); a file already gone counts as removed (unlink_or_warn takes
    // ENOENT as success), so its emptied directories are pruned all the same
    // (schedule_dir_for_removal); a removal that fails is a warning
    const unlink = async (rec: Rec) => {
      const path = rec.entry.path;
      if (!(await leadingDirectoriesExist(worktree, path))) return;
      const current = await worktree.getEntry(path).catch(() => undefined);
      if (isGitlink(rec.entry.mode)) {
        // rmdir_or_warn
        if (current) {
          if (!current.isDirectory) {
            out.warnings.push(`warning: unable to rmdir '${path}': Not a directory`);
            return;
          }
          if (!(await removeDirectoryIfEmpty(worktree, path))) {
            out.warnings.push(`warning: unable to rmdir '${path}': Directory not empty`);
            return;
          }
          out.removed.push(path);
        }
      } else if (current) {
        // unlink_or_warn
        if (current.isDirectory) {
          out.warnings.push(`warning: unable to unlink '${path}': Is a directory`);
          return;
        }
        await worktree.remove(path);
        out.removed.push(path);
      }
      await pruneEmptyParents(worktree, path);
    };
    // write_entry; false where the blob cannot be read ("unable to read sha1 file of"), after
    // checkout_entry has unlinked what stood there and made the leading directories
    const write = async (path: string, objectId: ObjectId, mode: number): Promise<boolean> => {
      if (isGitlink(mode)) {
        await worktree.mkdir(path, { recursive: true });
        return true;
      }
      // a partial clone's absent blob is fetched by the read (git's lazy fetch)
      const content = await ctx.blobs.load(objectId).catch((error: unknown) => {
        if (error instanceof PromisorFetchError) throw error;
        return undefined;
      });
      if (!content) {
        const current = await worktree.getEntry(path).catch(() => undefined);
        if (current) await worktree.remove(path, { recursive: current.isDirectory });
        const at = path.lastIndexOf("/");
        if (at > 0) await worktree.mkdir(path.slice(0, at), { recursive: true }).catch(() => {});
        out.errors.push(`error: unable to read sha1 file of ${path} (${objectId})`);
        return false;
      }
      const written = mode === FileMode.SYMLINK && !symlinks ? FileMode.REGULAR_FILE : mode;
      await worktree.writeContent(path, content, {
        mode: written,
        ...(written !== mode ? { raw: true } : {}),
        createParents: true,
        replaceInTheWay: true,
        discardUntracked: true,
      });
      return true;
    };
    // checkout_entry with state.force: an up-to-date file is left alone (not counted), a
    // gitlink whose directory is there too; "written" counts, "failed" is an error
    const checkoutEntry = async (rec: Rec, stat: boolean): Promise<CheckedOut> => {
      const e = rec.entry;
      if (rec.wtRemove) {
        await unlink(rec);
        return "unchanged";
      }
      const current = await worktree.getEntry(e.path).catch(() => undefined);
      if (current) {
        if (isGitlink(e.mode)) return "unchanged";
        const differs =
          rec.fresh ||
          (await worktreeDiffers(worktree, e.path, e as StagingEntry, trust, indexTime));
        if (!differs) return "unchanged";
      }
      if (!(await write(e.path, e.objectId, e.mode))) {
        out.conflicts.push(e.path);
        return "failed";
      }
      out.updated.push(e.path);
      if (stat && !isGitlink(e.mode)) {
        const stats = await worktree.getEntry(e.path);
        if (stats) {
          rec.entry = { ...e, ...entryStatOf(stats) };
          changed.add(e.path);
        }
      }
      return "written";
    };
    // checkout_worktree goes on past an entry it cannot write (errs |= ...)
    const count = (outcome: CheckedOut) => {
      if (outcome === "written") nrCheckouts++;
      else if (outcome === "failed") ok = false;
    };
    for (let i = 0; i < ordered.length; i++) {
      const rec = ordered[i];
      if (!rec.matched) continue;
      if (stageOf(rec.entry) === 0) {
        count(await checkoutEntry(rec, true));
        continue;
      }
      let j = i + 1;
      while (j < ordered.length && ordered[j].entry.path === rec.entry.path) j++;
      const stages = ordered.slice(i, j);
      i = j - 1;
      if (o.writeoutStage) {
        const chosen = stages.find((r) => stageOf(r.entry) === o.writeoutStage);
        if (chosen) {
          count(await checkoutEntry({ ...chosen, fresh: true }, false));
        } else if (!o.overlay) {
          await unlink(rec);
        } else {
          out.errors.push(stageMissing(rec.entry.path, o.writeoutStage));
          ok = false;
        }
      } else if (o.merge) {
        const merged = await checkoutMerged(ctx, o, stages, out);
        if (merged === undefined) ok = false;
        else if (await write(rec.entry.path, merged.objectId, merged.mode)) {
          out.updated.push(rec.entry.path);
          nrUnmerged++;
        } else ok = false;
      }
    }
  }
  if (o.countCheckoutPaths && !o.quiet) {
    if (nrUnmerged) {
      out.warnings.push(`Recreated ${nrUnmerged} merge conflict${nrUnmerged === 1 ? "" : "s"}`);
    }
    const paths = `${nrCheckouts} path${nrCheckouts === 1 ? "" : "s"}`;
    if (o.sourceTree) {
      out.warnings.push(`Updated ${paths} from ${await ctx.abbreviate(o.sourceTree)}`);
    } else if (!nrUnmerged || nrCheckouts) {
      out.warnings.push(`Updated ${paths} from the index`);
    }
  }
  return ok;
}

/**
 * git's `checkout_merged`: the path's stages merged again (`ll_merge`, labels `ours`,
 * `theirs`, `base`), the result stored as a blob and checked out with stage #2's mode.
 */
async function checkoutMerged(
  ctx: CheckoutPathsContext,
  o: CheckoutPathsOptions,
  stages: Rec[],
  out: CheckoutPathsOutcome,
): Promise<{ objectId: ObjectId; mode: number } | undefined> {
  const path = stages[0].entry.path;
  const ids: (ObjectId | undefined)[] = [undefined, undefined, undefined];
  let mode = 0;
  for (const r of stages) {
    const stage = stageOf(r.entry);
    if (stage < 1 || stage > 3) continue;
    ids[stage - 1] = r.entry.objectId;
    if (stage === 2) mode = r.entry.mode;
  }
  if (!ids[1] || !ids[2]) {
    out.errors.push(`error: path '${path}' does not have necessary versions`);
    return undefined;
  }
  const load = async (id: ObjectId | undefined) => {
    if (!id) return new Uint8Array(0);
    const content = await ctx.blobs.load(id);
    return content ? collect(content) : new Uint8Array(0);
  };
  const [base, ours, theirs] = await Promise.all(ids.map(load));
  // ll_merge with the path's `merge` and `conflict-marker-size` attributes and the merge
  // drivers, as the merges read them (myers: checkout_merged's ll_merge_options)
  const config = ortConfigOptions(ctx.workingCopy, ctx.worktree, { indexAttributes: true });
  const merged = await lowLevelMerge(
    { path, base, ours, theirs, baseLabel: "base", oursLabel: "ours", theirsLabel: "theirs" },
    {
      attributes: (await config.attributes?.(path)) ?? {},
      ...(config.drivers ? { drivers: config.drivers } : {}),
      ...(config.defaultDriver ? { defaultDriver: config.defaultDriver } : {}),
      style: o.conflictStyle ?? conflictStyleOf(ctx.workingCopy),
      ...(config.bigFileThreshold !== undefined
        ? { bigFileThreshold: config.bigFileThreshold }
        : {}),
      algorithm: "myers",
    },
  );
  if (merged.status === "binary") {
    out.warnings.push(`warning: Cannot merge binary files: ${path} (ours vs. theirs)`);
  }
  const content = merged.content;
  const objectId = await ctx.blobs.store([content]);
  return { objectId, mode };
}
