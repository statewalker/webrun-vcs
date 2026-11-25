import type { WorkingCopy } from "@statewalker/vcs-working-tree";
import type { HookSession } from "../git-hooks.js";

/** Whether the working copy is a linked worktree (its git directory `<common>/worktrees/<id>`). */
export async function inLinkedWorktree(workingCopy: WorkingCopy): Promise<boolean> {
  const list = await workingCopy.worktrees?.list().catch(() => undefined);
  return list?.find((w) => w.current)?.id !== undefined;
}

/**
 * The object directory as git names it in messages (`repo_get_object_directory`): git runs
 * from the worktree's top, so `.git/objects`; a bare repository found in the current
 * directory is `.`, so `./objects`; a linked worktree reads the common directory through
 * `commondir`, an absolute path.
 */
export async function objectsDirectoryDisplay(
  hooks: HookSession,
  workingCopy: WorkingCopy,
): Promise<string> {
  const common = await hooks.commonGitFile("objects");
  if (common && (await inLinkedWorktree(workingCopy))) return hooks.hookPathOf(common.path);
  const path = await hooks.gitPath("objects");
  return path === "objects" ? "./objects" : path;
}
