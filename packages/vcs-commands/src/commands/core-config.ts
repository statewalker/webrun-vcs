/**
 * The `core.*` settings that decide how the worktree is read and written.
 *
 * Read from the working copy's own configuration: this repository has no chain of
 * global and system configuration files, so a `core.symlinks` set only in `~/.gitconfig`
 * is not seen (native git would honour it).
 */

import {
  DEFAULT_ABBREV_LENGTH,
  findAbbrevLengths,
  type ObjectId,
  parseCoreAbbrev,
} from "@statewalker/vcs-core";
import { parseGitBool } from "@statewalker/vcs-utils";
import type { WorkingCopy, Worktree, WorktreeModeTrust } from "@statewalker/vcs-working-tree";

import { RemoteConfigStore } from "../remote-config/index.js";

/**
 * A git boolean (`git_config_bool`: a key with no `=` is true, an empty value false), else
 * `fallback`.
 */
export function coreBool(workingCopy: WorkingCopy, name: string, fallback: boolean): boolean {
  return parseGitBool(RemoteConfigStore.from(workingCopy).value(`core.${name}`)) ?? fallback;
}

/**
 * Whether the worktree's executable bits and symbolic links are real: the worktree can
 * represent them and `core.filemode` / `core.symlinks` are not false.
 */
export function worktreeModeTrust(workingCopy: WorkingCopy, worktree: Worktree): WorktreeModeTrust {
  const minimal =
    RemoteConfigStore.from(workingCopy).value("core.checkStat")?.trim().toLowerCase() === "minimal";
  return {
    // inode, owner and group compared unless core.checkStat is minimal
    fullStat: !minimal,
    executable:
      worktree.capabilities?.executable !== false && coreBool(workingCopy, "filemode", true),
    symlinks: worktree.capabilities?.symlinks !== false && coreBool(workingCopy, "symlinks", true),
    // git compares ctime unless core.trustctime is false or core.checkStat is minimal
    ctime:
      coreBool(workingCopy, "trustctime", true) &&
      RemoteConfigStore.from(workingCopy).value("core.checkStat")?.trim().toLowerCase() !==
        "minimal",
  };
}

/**
 * The lengths git abbreviates `ids` to (`repo_find_unique_abbrev` with `DEFAULT_ABBREV`):
 * from `minLength`, else `core.abbrev` (auto: from the approximate object count), lengthened
 * until unique among the stored objects. Without an object store, the start length (7 for
 * auto).
 */
export async function abbrevLengths(
  workingCopy: WorkingCopy,
  ids: Iterable<ObjectId>,
  minLength?: number,
): Promise<Map<ObjectId, number>> {
  const start =
    minLength ?? parseCoreAbbrev(RemoteConfigStore.from(workingCopy).value("core.abbrev")) ?? -1;
  const objects = workingCopy.history?.objects;
  if (objects) return findAbbrevLengths(objects, ids, start);
  const fixed = start < 0 ? DEFAULT_ABBREV_LENGTH : start === 0 ? 40 : Math.min(start, 40);
  return new Map([...ids].map((id) => [id, fixed]));
}
