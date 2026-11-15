/**
 * The built-in working-tree side of `git stash push`, for a working copy with an index and
 * a worktree: the stash trees (index, worktree, untracked) as git builds them, and the
 * reset that follows (`git clean -fd` with `-u`, `git reset --hard`, and with
 * `--keep-index` the index tree checked out again).
 *
 * The index is compared with the worktree once per stash ({@link scanIndex}); the check for
 * changes, the worktree tree and the reset all use that one comparison, and the entries it
 * could only prove clean by hashing get their fresh stat in the index the reset writes.
 */

import { type Blobs, FileMode, type ObjectId } from "@statewalker/vcs-core";
import {
  createIndexTree,
  createUntrackedTree,
  createWorktreeTree,
  directoriesOf,
  findUntrackedFiles,
  flattenTree,
  hasTrackedChanges,
  type IndexScan,
  refreshableEntries,
  refreshIndexStats,
  type Staging,
  type StashTreesSource,
  scanIndex,
  trackedUnder,
  type WorkingCopy,
  type Worktree,
} from "@statewalker/vcs-working-tree";

import type { CommandTrees } from "../git-command.js";
import { coreBool, worktreeModeTrust } from "./core-config.js";
import type { StashResetOptions, StashWorkingTreeProvider } from "./stash-create-command.js";
import { planTreeRestore, writeTreeRestorePlan } from "./tree-restore.js";
import { pruneEmptyParents, removeDirectoryIfEmpty } from "./worktree-overwrite-checks.js";

/** Names this operation in restore failure messages. */
const STASH = "stash";

/** What {@link WorkingCopyStashProvider} works on. */
export interface WorkingCopyStashContext {
  workingCopy: WorkingCopy;
  trees: CommandTrees;
  blobs: Blobs;
  staging: Staging;
  worktree: Worktree;
  /** HEAD's tree (undefined before the first commit) */
  headTree: () => Promise<ObjectId | undefined>;
}

/**
 * The stash working-tree provider `git.stashCreate()` uses when none is set and the working
 * copy has an index and a worktree. One instance serves one stash: it compares the index
 * with the worktree once and reuses that comparison.
 */
export class WorkingCopyStashProvider implements StashWorkingTreeProvider {
  private scanned?: Promise<IndexScan>;

  constructor(private readonly context: WorkingCopyStashContext) {}

  private get source(): StashTreesSource {
    const { trees, blobs, staging, worktree, workingCopy } = this.context;
    return { trees, blobs, staging, worktree, trust: worktreeModeTrust(workingCopy, worktree) };
  }

  /** The index compared with the worktree, once. */
  private scan(): Promise<IndexScan> {
    this.scanned ??= scanIndex(this.source);
    return this.scanned;
  }

  getIndexTree(): Promise<ObjectId> {
    return createIndexTree(this.source);
  }

  async getWorkingTree(): Promise<ObjectId> {
    return createWorktreeTree(this.source, await this.context.headTree(), await this.scan());
  }

  async getUntrackedTree(options?: { includeIgnored?: boolean }): Promise<ObjectId | undefined> {
    return (await createUntrackedTree(this.source, options)).treeId;
  }

  async hasLocalChanges(options?: {
    includeUntracked?: boolean;
    includeIgnored?: boolean;
  }): Promise<boolean> {
    const scan = await this.scan();
    if (await hasTrackedChanges(this.source, await this.context.headTree(), scan)) return true;
    if (!options?.includeUntracked) return false;
    for await (const file of findUntrackedFiles(this.context.worktree, (p) => scan.paths.has(p), {
      hasTrackedUnder: trackedUnder(scan.paths),
      includeIgnored: options.includeIgnored,
    })) {
      if (!file.path.endsWith("/")) return true;
    }
    return false;
  }

  /**
   * As `git stash push` after saving: with `includeUntracked` the untracked files go
   * (`git clean -fd`, `-x` too with `includeIgnored`), then the index and the worktree's
   * tracked files are reset to HEAD (`git reset --hard`); with `keepIndex` the index tree is
   * then checked out again (`git checkout --no-overlay <index tree> -- :/`). Only paths
   * that differ are written; untracked files are kept unless removed by the clean.
   */
  async resetHard(options: StashResetOptions = {}): Promise<void> {
    const scan = await this.scan();
    if (options.includeUntracked) await this.clean(scan, options.includeIgnored === true);
    const headTree = await this.context.headTree();
    await this.resetToHead(scan, headTree);
    if (options.keepIndex && options.indexTree) {
      await this.checkoutTree(headTree, options.indexTree);
    }
  }

  /**
   * `git clean -fd` (`-x` with `ignored`): the untracked files, then the untracked
   * directories left empty, deepest first. A directory is removed only when nothing at all
   * is in it, so a nested repository (and, without `-x`, an ignored file) keeps its own.
   */
  private async clean(scan: IndexScan, ignored: boolean): Promise<void> {
    const { worktree } = this.context;
    const tracked = scan.paths;
    const trackedDirs = directoriesOf(tracked);
    const untracked: string[] = [];
    const dirs: string[] = [];
    for await (const entry of worktree.walk({
      includeIgnored: ignored,
      includeDirectories: true,
    })) {
      if (entry.isDirectory) {
        if (entry.mode !== FileMode.GITLINK && !trackedDirs.has(entry.path)) dirs.push(entry.path);
        continue;
      }
      if (!tracked.has(entry.path) && (ignored || !entry.isIgnored)) untracked.push(entry.path);
    }
    for (const path of untracked) await worktree.remove(path);
    dirs.sort((a, b) => b.split("/").length - a.split("/").length || (a < b ? 1 : -1));
    for (const dir of dirs) await removeDirectoryIfEmpty(worktree, dir);
    for (const path of untracked) await pruneEmptyParents(worktree, path);
  }

  /**
   * The index and the worktree's tracked files made to match HEAD, as `git reset --hard`:
   * every path whose index entry or worktree file differs is written (or removed) and staged
   * with its fresh stat; paths that already match are not touched, and those the scan only
   * proved clean by hashing get their fresh stat.
   */
  private async resetToHead(scan: IndexScan, headTree: ObjectId | undefined): Promise<void> {
    const target = await flattenTree(this.context.trees, headTree);
    const stale = new Set<string>(scan.unmerged);
    for (const { entry, compared } of scan.entries) {
      const t = target.get(entry.path);
      if (!t || t.id !== entry.objectId || t.mode !== entry.mode) stale.add(entry.path);
      else if (entry.mode !== FileMode.GITLINK && compared?.kind) stale.add(entry.path);
    }
    for (const path of target.keys()) if (!scan.paths.has(path)) stale.add(path);
    const refresh = refreshableEntries(scan).filter((u) => !stale.has(u.path));
    await this.write(headTree, target, stale);
    await refreshIndexStats(this.context.staging, refresh);
  }

  /** `git checkout --no-overlay <tree> -- :/` after the reset: index and worktree at `to`. */
  private async checkoutTree(from: ObjectId | undefined, to: ObjectId): Promise<void> {
    const { trees } = this.context;
    const before = await flattenTree(trees, from);
    const target = await flattenTree(trees, to);
    const stale = new Set<string>();
    for (const [path, t] of target) {
      const b = before.get(path);
      if (!b || b.id !== t.id || b.mode !== t.mode) stale.add(path);
    }
    for (const path of before.keys()) if (!target.has(path)) stale.add(path);
    await this.write(to, target, stale);
  }

  /** Writes (or removes) the `stale` paths of the worktree and the index to `treeId`. */
  private async write(
    treeId: ObjectId | undefined,
    target: Map<string, { id: ObjectId; mode: number }>,
    stale: Set<string>,
  ): Promise<void> {
    if (stale.size === 0) return;
    const { trees, blobs, staging, worktree, workingCopy } = this.context;
    const trust = worktreeModeTrust(workingCopy, worktree);
    const plan = treeId
      ? await planTreeRestore(trees, blobs, treeId, STASH, {
          symlinks: true,
          ignoreCase: coreBool(workingCopy, "ignorecase", false),
          windows: worktree.capabilities?.windowsPaths === true,
          reservedNames: worktree.capabilities?.reservedNames,
          writing: stale,
        })
      : undefined;
    // deletions first, as git's unpack-trees: a removed file `d` makes way for `d/x`
    const editor = staging.createEditor();
    for (const path of [...stale].sort()) {
      if (target.has(path)) continue;
      editor.remove(path);
      const current = await worktree.getEntry(path);
      if (current && !current.isDirectory) {
        await worktree.remove(path);
        await pruneEmptyParents(worktree, path);
      }
    }
    if (plan) {
      const writing = plan.entries.filter((e) => stale.has(e.path));
      await writeTreeRestorePlan(
        worktree,
        blobs,
        { ...plan, entries: writing, gitlinks: [] },
        STASH,
        { symlinks: trust.symlinks, replaceInTheWay: true },
      );
      for (const path of stale) {
        const t = target.get(path);
        if (!t) continue;
        editor.remove(path);
        const current = t.mode === FileMode.GITLINK ? undefined : await worktree.getEntry(path);
        editor.upsert({
          path,
          objectId: t.id,
          mode: t.mode,
          stage: 0,
          size: current?.size ?? 0,
          mtime: current?.mtime ?? 0,
          ...(current?.ctime !== undefined ? { ctime: current.ctime } : {}),
        });
      }
    }
    await editor.finish();
    await staging.write();
  }
}
