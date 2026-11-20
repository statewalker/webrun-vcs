/**
 * git's post-index-change hook (read-cache.c `do_write_locked_index`): run after each write
 * of the index with two flags, `1` when the write follows an unpack-trees run that updated
 * the worktree (`updated_workdir`: a branch switch, `reset --hard`, a merge's checkout) and
 * `1` when the command may have changed skip-worktree bits (`updated_skipworktree`: a mixed
 * reset, `update-index`). The flags belong to the index written and are cleared by the run.
 */
import type { Staging } from "@statewalker/vcs-working-tree";

import type { HookSession } from "./git-hooks.js";

interface IndexUpdateFlags {
  workdir: boolean;
  skipWorktree: boolean;
}

const pending = new WeakMap<object, IndexUpdateFlags>();

/**
 * Marks what the next write of `staging` follows: an update of the worktree from the index
 * (unpack-trees with a destination index) or a change of skip-worktree bits.
 *
 * @example
 * ```typescript
 * markIndexUpdate(staging, { workdir: true }); // before a branch switch writes the index
 * ```
 */
export function markIndexUpdate(
  staging: object,
  what: { workdir?: boolean; skipWorktree?: boolean },
): void {
  const flags = pending.get(staging) ?? { workdir: false, skipWorktree: false };
  if (what.workdir) flags.workdir = true;
  if (what.skipWorktree) flags.skipWorktree = true;
  pending.set(staging, flags);
}

/** The flags of `staging`'s next write, cleared (git resets them after the hook). */
function takeIndexUpdate(staging: object): IndexUpdateFlags {
  const flags = pending.get(staging) ?? { workdir: false, skipWorktree: false };
  pending.delete(staging);
  return flags;
}

/**
 * The write hook (`Staging.setWriteHook`) that runs post-index-change through `hooks` with
 * the flags marked for `staging`; its exit code is ignored, as git ignores it.
 */
export function postIndexChangeHookOf(hooks: HookSession, staging: Staging): () => Promise<void> {
  return async () => {
    const flags = takeIndexUpdate(staging);
    await hooks.run("post-index-change", {
      args: [flags.workdir ? "1" : "0", flags.skipWorktree ? "1" : "0"],
    });
  };
}
