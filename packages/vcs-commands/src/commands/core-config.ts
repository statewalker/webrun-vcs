/**
 * The `core.*` settings that decide how the worktree is read and written.
 *
 * Read from the working copy's own configuration: this repository has no chain of
 * global and system configuration files, so a `core.symlinks` set only in `~/.gitconfig`
 * is not seen (native git would honour it).
 */

import type { WorkingCopy, Worktree, WorktreeModeTrust } from "@statewalker/vcs-working-tree";

import { RemoteConfigStore } from "../remote-config/index.js";

/** A git boolean (`true`/`yes`/`on`/`1`, `false`/`no`/`off`/`0`), else `fallback`. */
export function coreBool(workingCopy: WorkingCopy, name: string, fallback: boolean): boolean {
  const value = RemoteConfigStore.from(workingCopy).value(`core.${name}`)?.trim().toLowerCase();
  if (value === undefined) return fallback;
  if (["false", "no", "off", "0"].includes(value)) return false;
  if (["true", "yes", "on", "1", ""].includes(value)) return true;
  return fallback;
}

/**
 * Whether the worktree's executable bits and symbolic links are real: the worktree can
 * represent them and `core.filemode` / `core.symlinks` are not false.
 */
export function worktreeModeTrust(workingCopy: WorkingCopy, worktree: Worktree): WorktreeModeTrust {
  return {
    executable:
      worktree.capabilities?.executable !== false && coreBool(workingCopy, "filemode", true),
    symlinks: worktree.capabilities?.symlinks !== false && coreBool(workingCopy, "symlinks", true),
  };
}
