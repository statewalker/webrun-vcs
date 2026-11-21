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
  attributesIndexOf,
  createIndexTree,
  createUntrackedTree,
  createWorktreeTree,
  directoriesOf,
  type EntryStat,
  entryStatOf,
  findUntrackedFiles,
  flattenTree,
  hasTrackedChanges,
  type IndexScan,
  modeFromWorktree,
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
import { markIndexUpdate } from "./post-index-change.js";
import type { StashResetOptions, StashWorkingTreeProvider } from "./stash-create-command.js";
import { planTreeRestore, restoreCaseOptions, writeTreeRestorePlan } from "./tree-restore.js";
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
  /**
   * `git stash push -- <pathspec>`: the paths stashed and reset (the index tree is the whole
   * index all the same); absent: every path
   */
  pathFilter?: (path: string) => boolean;
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
    const { trees, blobs, staging, worktree, workingCopy, pathFilter } = this.context;
    return {
      trees,
      blobs,
      staging,
      worktree,
      trust: worktreeModeTrust(workingCopy, worktree),
      ...(pathFilter ? { pathFilter } : {}),
    };
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
      ...(this.context.pathFilter ? { filter: this.context.pathFilter } : {}),
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
    const filter = this.context.pathFilter;
    if (options.includeUntracked) {
      if (filter) await this.removeUntracked(scan, options.includeIgnored === true, filter);
      else await this.clean(scan, options.includeIgnored === true);
    }
    const headTree = await this.context.headTree();
    await this.resetToHead(scan, headTree, filter);
    if (options.keepIndex && options.indexTree) {
      await this.checkoutTree(headTree, options.indexTree, filter);
    }
  }

  /**
   * `git stash push --staged` after the staged changes left the worktree: the index made to
   * match HEAD (`git reset -q --refresh -- <pathspec>`, every path without one), each entry
   * taken from HEAD given its file's stat where the file holds HEAD's content (the refresh).
   */
  async resetIndexToHead(): Promise<void> {
    const { trees, staging, worktree, workingCopy } = this.context;
    const filter = this.context.pathFilter;
    const trust = worktreeModeTrust(workingCopy, worktree);
    const target = await flattenTree(trees, await this.context.headTree());
    const editor = staging.createEditor();
    const seen = new Set<string>();
    const fromHead = async (path: string, t: { id: ObjectId; mode: number }) => {
      let stat: EntryStat = { size: 0, mtime: 0 };
      if (t.mode !== FileMode.GITLINK) {
        const current = await worktree.getEntry(path);
        if (current && !current.isDirectory) {
          const mode = modeFromWorktree(current.mode, t.mode, trust);
          const id = mode === t.mode ? await worktree.computeHash(path).catch(() => "") : "";
          if (id === t.id) stat = entryStatOf(current);
        }
      }
      editor.upsert({ path, objectId: t.id, mode: t.mode, stage: 0, ...stat });
    };
    for await (const entry of staging.entries()) {
      const path = entry.path;
      if (seen.has(path) || (filter && !filter(path))) continue;
      seen.add(path);
      const t = target.get(path);
      const same =
        t &&
        entry.stage === 0 &&
        !entry.intentToAdd &&
        t.id === entry.objectId &&
        t.mode === entry.mode;
      if (same) continue;
      editor.remove(path);
      if (t) await fromHead(path, t);
    }
    for (const [path, t] of target) {
      if (seen.has(path) || (filter && !filter(path))) continue;
      await fromHead(path, t);
    }
    await editor.finish();
    await staging.write();
  }

  /**
   * The untracked files of a pathspec stash removed (git adds them and applies the stash's
   * diff in reverse, `git apply --index -R`): each file, then the directories it leaves empty.
   */
  private async removeUntracked(
    scan: IndexScan,
    ignored: boolean,
    filter: (path: string) => boolean,
  ): Promise<void> {
    const { worktree } = this.context;
    const untracked: string[] = [];
    for await (const file of findUntrackedFiles(worktree, (p) => scan.paths.has(p), {
      hasTrackedUnder: trackedUnder(scan.paths),
      includeIgnored: ignored,
      filter,
    })) {
      if (!file.path.endsWith("/")) untracked.push(file.path);
    }
    for (const path of untracked) {
      await worktree.remove(path);
      await pruneEmptyParents(worktree, path);
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
    // a `.git` naming no repository (an empty directory, a gitfile of garbage) is listed
    // and goes with its directory, as git clean's remove_dirs takes it
    for await (const entry of worktree.walk({
      includeIgnored: ignored,
      includeDirectories: true,
      enterNonRepositoryGitDirs: true,
    })) {
      if (entry.isDirectory) {
        if (entry.mode !== FileMode.GITLINK && !trackedDirs.has(entry.path)) dirs.push(entry.path);
        continue;
      }
      if (!tracked.has(entry.path) && (ignored || !entry.isIgnored)) untracked.push(entry.path);
    }
    const fake = { nonRepositoryGitDirs: true };
    for (const path of untracked) await worktree.remove(path, fake);
    dirs.sort((a, b) => b.split("/").length - a.split("/").length || (a < b ? 1 : -1));
    for (const dir of dirs) await removeDirectoryIfEmpty(worktree, dir, fake);
    for (const path of untracked) await pruneEmptyParents(worktree, path);
  }

  /**
   * The index and the worktree's tracked files made to match HEAD, as `git reset --hard`:
   * every path whose index entry or worktree file differs is written (or removed) and staged
   * with its fresh stat; paths that already match are not touched, and those the scan only
   * proved clean by hashing get their fresh stat.
   */
  private async resetToHead(
    scan: IndexScan,
    headTree: ObjectId | undefined,
    filter?: (path: string) => boolean,
  ): Promise<void> {
    const target = await flattenTree(this.context.trees, headTree);
    const inScope = (path: string) => !filter || filter(path);
    const stale = new Set<string>(scan.unmerged.filter(inScope));
    for (const { entry, compared } of scan.entries) {
      if (!inScope(entry.path)) continue;
      const t = target.get(entry.path);
      if (!t || t.id !== entry.objectId || t.mode !== entry.mode) stale.add(entry.path);
      else if (entry.mode !== FileMode.GITLINK && compared?.kind) stale.add(entry.path);
    }
    for (const path of target.keys()) {
      if (!scan.paths.has(path) && inScope(path)) stale.add(path);
    }
    const refresh = refreshableEntries(scan).filter((u) => !stale.has(u.path));
    // a reset --hard writes a new index (unpack-trees): the resolve-undo records go
    this.context.staging.clearResolveUndo?.();
    // git's `reset --hard` child: an unpack-trees write that updates the worktree
    if (!filter) markIndexUpdate(this.context.staging, { workdir: true });
    await this.write(headTree, target, stale);
    await refreshIndexStats(this.context.staging, refresh);
  }

  /** `git checkout --no-overlay <tree> -- :/` after the reset: index and worktree at `to`. */
  private async checkoutTree(
    from: ObjectId | undefined,
    to: ObjectId,
    filter?: (path: string) => boolean,
  ): Promise<void> {
    const { trees } = this.context;
    const before = await flattenTree(trees, from);
    const target = await flattenTree(trees, to);
    const stale = new Set<string>();
    for (const [path, t] of target) {
      if (filter && !filter(path)) continue;
      const b = before.get(path);
      if (!b || b.id !== t.id || b.mode !== t.mode) stale.add(path);
    }
    for (const path of before.keys()) {
      if (!target.has(path) && (!filter || filter(path))) stale.add(path);
    }
    // a path checkout (`checkout --no-overlay <tree> -- :/`): the worktree's attributes first
    await this.write(to, target, stale, "checkin");
  }

  /** Writes (or removes) the `stale` paths of the worktree and the index to `treeId`. */
  private async write(
    treeId: ObjectId | undefined,
    target: Map<string, { id: ObjectId; mode: number }>,
    stale: Set<string>,
    direction: "checkin" | "checkout" = "checkout",
  ): Promise<void> {
    if (stale.size === 0) return;
    const { trees, blobs, staging, worktree, workingCopy } = this.context;
    const trust = worktreeModeTrust(workingCopy, worktree);
    const plan = treeId
      ? await planTreeRestore(trees, blobs, treeId, STASH, {
          symlinks: true,
          ...(await restoreCaseOptions(worktree, coreBool(workingCopy, "ignorecase", false))),
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
        {
          symlinks: trust.symlinks,
          replaceInTheWay: true,
          // reset --hard and checkout -- :/ overwrite untracked files, as in git
          discardUntracked: true,
          // the attributes of the index left behind: the whole target tree
          attributes: {
            direction,
            index: attributesIndexOf([...target].map(([p, t]) => [p, t.id] as const)),
          },
        },
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
          // the exact stat where the worktree reports it (git's stat data)
          ...(current?.ctime !== undefined ? { ctime: current.ctime } : {}),
          ...(current?.mtimeNs !== undefined ? { mtimeNs: current.mtimeNs } : {}),
          ...(current?.ctimeNs !== undefined ? { ctimeNs: current.ctimeNs } : {}),
          ...(current?.dev !== undefined ? { dev: current.dev } : {}),
          ...(current?.ino !== undefined ? { ino: current.ino } : {}),
          ...(current?.uid !== undefined ? { uid: current.uid } : {}),
          ...(current?.gid !== undefined ? { gid: current.gid } : {}),
        });
      }
    }
    await editor.finish();
    await staging.write();
  }
}
