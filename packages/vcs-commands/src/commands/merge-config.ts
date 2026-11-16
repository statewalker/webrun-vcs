/**
 * The settings `merge`, `cherry-pick`, `revert`, `rebase` and `pull` read from the
 * working copy's configuration, as git reads them.
 */

import type { ConflictStyle } from "@statewalker/vcs-utils";
import type { WorkingCopy } from "@statewalker/vcs-working-tree";

import { RemoteConfigStore } from "../remote-config/index.js";

/** A configuration value (`section.name` or `section.sub.name`), undefined when unset. */
export function configValue(workingCopy: WorkingCopy, key: string): string | undefined {
  return RemoteConfigStore.from(workingCopy).value(key);
}

/** A git boolean setting, `fallback` when unset or not a boolean. */
export function configBool(workingCopy: WorkingCopy, key: string, fallback: boolean): boolean {
  const value = configValue(workingCopy, key)?.trim().toLowerCase();
  if (value === undefined) return fallback;
  if (["false", "no", "off", "0"].includes(value)) return false;
  if (["true", "yes", "on", "1", ""].includes(value)) return true;
  return fallback;
}

/** `merge.conflictStyle`: `merge` (default), `diff3` or `zdiff3`. */
export function conflictStyleOf(workingCopy: WorkingCopy): ConflictStyle {
  const value = configValue(workingCopy, "merge.conflictStyle")?.trim().toLowerCase();
  return value === "diff3" || value === "zdiff3" ? value : "merge";
}
