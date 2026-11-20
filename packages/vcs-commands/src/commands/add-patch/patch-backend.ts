/**
 * The repository side of a patch selection: the diff add-patch.c asks git for (`diff-files
 * -p`, `diff-index -p [--cached] [-R] <rev>`, with its options) and the `git apply` runs
 * that apply the selected hunks, both in-process through `DiffCommand` and `ApplyCommand`.
 */

import { EMPTY_TREE_ID } from "@statewalker/vcs-core";
import type { XdiffAlgorithm } from "@statewalker/vcs-utils";

import type { WorkingCopy } from "../../types.js";
import { ApplyCommand } from "../apply/index.js";
import { bytesToLatin1, latin1ToBytes } from "../apply/latin1.js";
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
    const diff = new DiffCommand(workingCopy)
      .setRenames(false)
      .setIgnoreSubmodules("dirty")
      .setCombineMerges(false);
    if (mode.diff !== "files") {
      diff.setOldTree(options.revision ?? EMPTY_TREE_ID);
      if (mode.diff === "index-cached") diff.setCached(true);
    }
    if (pathspec.length > 0) diff.setPathspec(pathspec);
    return diff;
  };
  return {
    async diff() {
      let pathspec = paths;
      if (options.temporaryIndex) {
        // diff-index against a temporary index of the revision's tree: paths the revision
        // lacks are not in it, so not in the diff
        const entries = await diffCommand(paths).call();
        const kept = entries
          .filter((e) => e.oldPath !== undefined && !e.unmerged)
          .map((e) => `:(literal)${e.oldPath}`);
        if (kept.length === 0) return "";
        if (kept.length !== entries.length) pathspec = kept;
      }
      const bytes = await diffCommand(pathspec)
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
  };
}
