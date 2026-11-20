/**
 * The repository side of a patch selection: the diff add-patch.c asks git for (`diff-files
 * -p`, `diff-index -p [--cached] [-R] <rev>`, with its options) and the `git apply` runs
 * that apply the selected hunks, both in-process through `DiffCommand` and `ApplyCommand`.
 */

import { EMPTY_TREE_ID, FileMode } from "@statewalker/vcs-core";
import { MemoryStagingStore } from "@statewalker/vcs-store-mem";
import type { XdiffAlgorithm } from "@statewalker/vcs-utils";
import { compareGitPaths } from "@statewalker/vcs-utils/encoding";
import {
  applyStatUpdate,
  compareWithWorktree,
  type IndexStatUpdate,
  type StagingEntry,
  statUpdateOf,
  withWorktreeEntries,
} from "@statewalker/vcs-working-tree";

import { GitCommand } from "../../git-command.js";
import type { WorkingCopy } from "../../types.js";
import { ApplyCommand, bytesToLatin1, latin1ToBytes } from "../apply/index.js";
import { worktreeModeTrust } from "../core-config.js";
import { DiffCommand } from "../diff-command.js";
import type { PatchBackend } from "./add-patch.js";
import type { PatchMode } from "./patch-modes.js";

/** An index held in memory (`GIT_INDEX_FILE` pointing at a temporary index). */
export type TemporaryIndex = Map<string, { mode: number; objectId: string }>;

/** Options of {@link createPatchBackend}. */
export interface PatchBackendOptions {
  workingCopy: WorkingCopy;
  mode: PatchMode;
  /** The revision the diff compares with (`diff-index <rev>`); the empty tree for none */
  revision?: string;
  /** The pathspec elements */
  paths?: string[];
  /** `-U<n>` / `diff.context` (add-patch passes it on) */
  context?: number;
  /** `--inter-hunk-context` / `diff.interHunkContext` */
  interHunkContext?: number;
  /** `diff.algorithm` (add-patch passes it on as `--diff-algorithm`) */
  algorithm?: XdiffAlgorithm;
  /**
   * `stash -p`'s temporary index (HEAD's tree): the diff shows only its paths, and the
   * selected hunks are applied to it (`apply --cached` with `GIT_INDEX_FILE`)
   */
  temporaryIndex?: TemporaryIndex;
}

/**
 * The backend add-patch.c's child processes are: the diff as git prints it for patch mode
 * (`--no-color --ignore-submodules=dirty -p`, no renames, plumbing's prefixes and no
 * textconv), and `git apply` with the mode's arguments.
 */
export function createPatchBackend(options: PatchBackendOptions): PatchBackend {
  const { workingCopy, mode } = options;
  const paths = options.paths ?? [];
  const diffCommand = (pathspec: string[]) => {
    // diff-files shows a conflicted path as its combined diff (`diff --cc`, no hunk
    // add-patch.c parses: the path is passed over); diff-index as the worktree's file
    const diff = new DiffCommand(workingCopy)
      .setRenames(false)
      .setIgnoreSubmodules("dirty")
      .setCombineMerges(mode.diff === "files");
    if (mode.diff !== "files") {
      diff.setOldTree(options.revision ?? EMPTY_TREE_ID);
      if (mode.diff === "index-cached") diff.setCached(true);
    }
    if (pathspec.length > 0) diff.setPathspec(pathspec);
    return diff;
  };
  const temporary = options.temporaryIndex;
  return {
    async diff() {
      const diff = diffCommand(paths);
      if (temporary) {
        // `GIT_INDEX_FILE` at the temporary index (create_index_from_tree: entries without
        // stat data, so each file is compared by content): only its paths are in the diff
        const index = new MemoryStagingStore();
        const builder = index.createBuilder();
        for (const [path, entry] of [...temporary].sort((a, b) => compareGitPaths(a[0], b[0])))
          builder.add({ path, mode: entry.mode, objectId: entry.objectId, size: 0, mtime: 0 });
        await builder.finish();
        diff.setTemporaryIndex(index);
      }
      const bytes = await diff
        .setOptions({
          defaultPrefix: true,
          ignoreConfigNoPrefix: true,
          textconv: false,
          uiConfig: false,
          submoduleFormat: "short",
          orderFile: "",
          ...(mode.diffReverse ? { reverse: true } : {}),
          ...(options.context !== undefined ? { context: options.context } : {}),
          ...(options.interHunkContext !== undefined
            ? { interHunkContext: options.interHunkContext }
            : {}),
          ...(options.algorithm ? { algorithm: options.algorithm } : {}),
        })
        .callBytes("patch");
      return bytesToLatin1(bytes);
    },
    async apply(patch, args) {
      const apply = new ApplyCommand(workingCopy).addPatch(latin1ToBytes(patch));
      if (args.cached) apply.setCached(true);
      if (args.reverse) apply.setReverse(true);
      if (args.check) apply.setCheck(true);
      const temporary = options.temporaryIndex;
      if (temporary && args.cached) apply.setTemporaryIndex(new Map(temporary));
      const result = await apply.call();
      if (temporary && args.cached && !args.check && result.exitCode === 0 && result.index) {
        temporary.clear();
        for (const [path, entry] of result.index) temporary.set(path, entry);
      }
      return { ok: result.exitCode === 0, errors: result.errors };
    },
    // the temporary index's refresh changes nothing the selection shows
    ...(temporary ? {} : { refresh: () => new IndexRefresh(workingCopy).call() }),
  };
}

/**
 * `repo_refresh_and_write_index(r, REFRESH_QUIET, ...)` as add-patch.c runs it: the stage-0
 * entries whose files still hold their content take the files' stat, the index is written
 * (racily clean entries smudged), and each unmerged path is reported as `<path>: needs
 * merge` on standard output, which is what the call returns.
 */
class IndexRefresh extends GitCommand<string> {
  async call(): Promise<string> {
    await this.readCurrentIndex(false);
    const staging = this.staging;
    const worktree = this.workingCopy.worktree;
    const entries: StagingEntry[] = [];
    for await (const entry of staging.entryList?.() ?? staging.entries()) entries.push(entry);
    let out = "";
    const updates: IndexStatUpdate[] = [];
    if (worktree) {
      const trust = worktreeModeTrust(this.workingCopy, worktree);
      const indexTime = staging.getUpdateTime();
      // refresh_cache_ent passes over what it cannot or need not stat
      const stated = (entry: StagingEntry) =>
        entry.stage === 0 &&
        !entry.skipWorktree &&
        !entry.assumeValid &&
        !entry.intentToAdd &&
        entry.mode !== FileMode.GITLINK;
      let lastUnmerged: string | undefined;
      for await (const { item: entry, current } of withWorktreeEntries(worktree, entries, stated)) {
        if (entry.stage !== 0) {
          if (entry.path !== lastUnmerged) out += `${entry.path}: needs merge\n`;
          lastUnmerged = entry.path;
          continue;
        }
        if (!stated(entry)) continue;
        const compared = await compareWithWorktree(worktree, entry, { trust, indexTime }, current);
        if (compared.kind) continue;
        const update = statUpdateOf(entry, compared);
        if (update && !update.smudge) updates.push(update);
      }
    }
    if (updates.length > 0) {
      const now = Date.now();
      const editor = staging.createEditor();
      for (const update of updates) {
        editor.add({
          path: update.path,
          apply: (existing) => applyStatUpdate(existing, update, now) ?? existing,
        });
      }
      await editor.finish();
    }
    // written whether or not an entry changed (write_locked_index)
    await staging.write();
    return out;
  }
}
