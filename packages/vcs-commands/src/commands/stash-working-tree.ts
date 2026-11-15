/**
 * The built-in working-tree side of `git stash push`, for a working copy with an index and
 * a worktree: the stash trees (index, worktree, untracked) as git builds them, and the
 * reset that follows (`git clean -fd` with `-u`, `git reset --hard`, and with
 * `--keep-index` the index tree checked out again).
 */

import { type Blobs, FileMode, type ObjectId } from "@statewalker/vcs-core";
import {
  compareWithWorktree,
  createIndexTree,
  createUntrackedTree,
  createWorktreeTree,
  findUntrackedFiles,
  flattenTree,
  hasTrackedChanges,
  type Staging,
  type StashTreesSource,
  trackedUnder,
  type WorkingCopy,
  type Worktree,
} from "@statewalker/vcs-working-tree";

import type { CommandTrees } from "../git-command.js";
import { coreBool, worktreeModeTrust } from "./core-config.js";
import type { StashResetOptions, StashWorkingTreeProvider } from "./stash-create-command.js";
import { planTreeRestore, writeTreeRestorePlan } from "./tree-restore.js";
import { pruneEmptyParents } from "./worktree-overwrite-checks.js";

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
 * copy has an index and a worktree.
 */
export class WorkingCopyStashProvider implements StashWorkingTreeProvider {
  constructor(private readonly context: WorkingCopyStashContext) {}

  private get source(): StashTreesSource {
    const { trees, blobs, staging, worktree, workingCopy } = this.context;
    return { trees, blobs, staging, worktree, trust: worktreeModeTrust(workingCopy, worktree) };
  }

  getIndexTree(): Promise<ObjectId> {
    return createIndexTree(this.source);
  }

  async getWorkingTree(): Promise<ObjectId> {
    return createWorktreeTree(this.source, await this.context.headTree());
  }

  async getUntrackedTree(options?: { includeIgnored?: boolean }): Promise<ObjectId | undefined> {
    return (await createUntrackedTree(this.source, options))?.treeId;
  }

  async hasLocalChanges(options?: {
    includeUntracked?: boolean;
    includeIgnored?: boolean;
  }): Promise<boolean> {
    if (await hasTrackedChanges(this.source, await this.context.headTree())) return true;
    if (!options?.includeUntracked) return false;
    const tracked = await this.trackedPaths();
    for await (const file of findUntrackedFiles(this.context.worktree, (p) => tracked.has(p), {
      hasTrackedUnder: trackedUnder(tracked),
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
    if (options.includeUntracked) await this.clean(options.includeIgnored === true);
    const headTree = await this.context.headTree();
    await this.resetTo(headTree);
    if (options.keepIndex && options.indexTree) await this.resetTo(options.indexTree);
  }

  private async trackedPaths(): Promise<Set<string>> {
    const tracked = new Set<string>();
    for await (const entry of this.context.staging.entries()) tracked.add(entry.path);
    return tracked;
  }

  /** `git clean -fd` (`-x` with `ignored`): the untracked files, then emptied directories. */
  private async clean(ignored: boolean): Promise<void> {
    const { worktree } = this.context;
    const tracked = await this.trackedPaths();
    const untracked: string[] = [];
    for await (const file of findUntrackedFiles(worktree, (p) => tracked.has(p), {
      hasTrackedUnder: trackedUnder(tracked),
      includeIgnored: ignored,
    })) {
      // a nested repository is left alone (git clean without -f -f)
      if (!file.path.endsWith("/")) untracked.push(file.path);
    }
    for (const path of untracked) {
      await worktree.remove(path);
      await pruneEmptyParents(worktree, path);
    }
  }

  /**
   * The index and the worktree's tracked files made to match `treeId`, as a forced checkout:
   * every path whose index entry or worktree file differs from the tree is written (or
   * removed) and staged with its fresh stat; paths that already match are not touched.
   */
  private async resetTo(treeId: ObjectId | undefined): Promise<void> {
    const { trees, blobs, staging, worktree, workingCopy } = this.context;
    const trust = worktreeModeTrust(workingCopy, worktree);
    const target = await flattenTree(trees, treeId);
    const indexTime = staging.getUpdateTime();
    const stale = new Set<string>();
    const indexed = new Set<string>();
    for await (const entry of staging.entries()) {
      indexed.add(entry.path);
      const t = target.get(entry.path);
      if (entry.stage !== 0 || !t || t.id !== entry.objectId || t.mode !== entry.mode) {
        stale.add(entry.path);
        continue;
      }
      if (entry.mode === FileMode.GITLINK) continue;
      if ((await compareWithWorktree(worktree, entry, { trust, indexTime })).kind) {
        stale.add(entry.path);
      }
    }
    for (const path of target.keys()) if (!indexed.has(path)) stale.add(path);
    if (stale.size === 0) return;

    const plan = treeId
      ? await planTreeRestore(trees, blobs, treeId, STASH, {
          symlinks: true,
          ignoreCase: coreBool(workingCopy, "ignorecase", false),
          windows: worktree.capabilities?.windowsPaths === true,
          reservedNames: worktree.capabilities?.reservedNames,
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
