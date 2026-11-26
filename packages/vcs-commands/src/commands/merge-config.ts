/**
 * The settings `merge`, `cherry-pick`, `revert`, `rebase` and `pull` read from the
 * working copy's configuration, as git reads them.
 */

import { type ConflictStyle, parseGitBool } from "@statewalker/vcs-utils";
import type { GitHostEnvironment, WorkingCopy } from "@statewalker/vcs-working-tree";

import { RemoteConfigStore } from "../remote-config/index.js";

/** A configuration value (`section.name` or `section.sub.name`), undefined when unset. */
export function configValue(workingCopy: WorkingCopy, key: string): string | undefined {
  return RemoteConfigStore.from(workingCopy).value(key);
}

/** A git boolean setting, `fallback` when unset or not a boolean. */
export function configBool(workingCopy: WorkingCopy, key: string, fallback: boolean): boolean {
  return parseGitBool(configValue(workingCopy, key)) ?? fallback;
}

/** `merge.conflictStyle`: `merge` (default), `diff3` or `zdiff3`. */
export function conflictStyleOf(workingCopy: WorkingCopy): ConflictStyle {
  const value = configValue(workingCopy, "merge.conflictStyle")?.trim().toLowerCase();
  return value === "diff3" || value === "zdiff3" ? value : "merge";
}

/**
 * merge-ort's `verbosity` (init_merge_options): `$GIT_MERGE_VERBOSITY` read as `strtol`,
 * else `merge.verbosity`, else 2. At 0 `git merge` prints none of merge-ort's messages
 * (`Auto-merging`, `CONFLICT`) from git 2.50 on (merge_ort_recursive's `show_msgs`; 2.43
 * prints them whatever the level); the other levels change nothing git prints.
 */
export function mergeVerbosityOf(workingCopy: WorkingCopy): number {
  const environment = (workingCopy.config as { environment?: GitHostEnvironment } | undefined)
    ?.environment;
  const fromEnv = environment?.diffVariables?.GIT_MERGE_VERBOSITY;
  const parse = (value: string) => {
    const m = /^\s*([+-]?)(\d*)/.exec(value);
    const n = m?.[2] ? Number.parseInt(m[2], 10) : 0;
    return m?.[1] === "-" ? -n : n;
  };
  if (fromEnv !== undefined) return parse(fromEnv);
  const configured = workingCopy.config
    ? RemoteConfigStore.from(workingCopy).value("merge.verbosity")
    : undefined;
  return configured !== undefined ? parse(configured) : 2;
}
