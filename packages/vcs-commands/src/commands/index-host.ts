/**
 * What an index write reads from the repository (`IndexHost`), as git reads it when it
 * writes the index: `core.splitIndex` and `splitIndex.*` (read-cache.c `write_locked_index`),
 * `core.sharedRepository` for a new shared index, and whether a sparse index is allowed
 * (sparse-index.c `is_sparse_index_allowed`: `index.sparse`, `core.sparseCheckout`,
 * `core.sparseCheckoutCone` and patterns of the cone's shape), with the trees a sparse index
 * expands from and collapses into.
 *
 * ```typescript
 * staging.setIndexHost?.(indexHostOf(workingCopy, staging, history.trees));
 * ```
 */
import type { Trees } from "@statewalker/vcs-core";
import { parseGitBool } from "@statewalker/vcs-utils";
import {
  type IndexHost,
  type IndexSettings,
  parseSharedRepository,
  type Staging,
  type WorkingCopy,
} from "@statewalker/vcs-working-tree";

import { RemoteConfigStore } from "../remote-config/index.js";
import { approxidateCareful } from "./git-date.js";
import { peekIndexUpdate } from "./post-index-change.js";
import { readSparseCheckoutPatterns, sparseCheckoutConfig } from "./sparse-checkout-support.js";

/** The configuration value of `key`, undefined when unset or unreadable. */
function configValueOf(config: RemoteConfigStore, key: string): string | undefined {
  try {
    return config.value(key);
  } catch {
    return undefined;
  }
}

/**
 * git's `get_shared_index_expire_date`: `splitIndex.sharedIndexExpire` (default
 * `2.weeks.ago`) as a time in seconds; `never` (and any value approxidate reads as 0) is 0.
 */
export function sharedIndexExpireDate(value: string | undefined, now: number): number {
  const text = value ?? "2.weeks.ago";
  if (text === "now") return now;
  if (text === "never") return 0;
  return approxidateCareful(text, now).timestamp;
}

/** The paths the next write of a staging removes and adds again (see `markReaddedEntries`). */
const readdedPaths = new WeakMap<object, Set<string>>();

/**
 * Marks paths whose entries the next write of `staging` removes and adds again, as git's
 * apply edits the index (`remove_file_from_index`, then `add_index_entry`): a split index
 * writes them whole instead of as replacements. Cleared once that write is done (the host's
 * `written`), never by asking the settings.
 */
export function markReaddedEntries(staging: object, paths: Iterable<string>): void {
  const set = readdedPaths.get(staging) ?? new Set<string>();
  for (const p of paths) set.add(p);
  readdedPaths.set(staging, set);
}

/** The settings of the next write of `staging`, from the working copy's configuration. */
export async function indexSettingsOf(
  workingCopy: WorkingCopy,
  staging: Staging,
): Promise<IndexSettings> {
  const settings: IndexSettings = { unpackTrees: peekIndexUpdate(staging).workdir };
  const readded = readdedPaths.get(staging);
  if (readded) settings.readded = new Set(readded);
  if (!workingCopy.config) return settings;
  const config = RemoteConfigStore.from(workingCopy);
  const split = configValueOf(config, "core.splitIndex");
  if (split !== undefined) {
    const v = parseGitBool(split);
    if (v !== undefined) settings.splitIndex = v;
  }
  const max = configValueOf(config, "splitIndex.maxPercentChange");
  if (max !== undefined && /^\s*-?\d+\s*$/.test(max)) {
    const n = Number.parseInt(max, 10);
    if (n >= 0 && n <= 100) settings.maxPercentChange = n;
  }
  settings.sharedIndexExpireBefore = sharedIndexExpireDate(
    configValueOf(config, "splitIndex.sharedIndexExpire"),
    Math.floor(Date.now() / 1000),
  );
  try {
    settings.sharedRepository = parseSharedRepository(
      configValueOf(config, "core.sharedRepository"),
    );
  } catch {
    settings.sharedRepository = 0;
  }
  const sparse = sparseCheckoutConfig(workingCopy);
  const indexSparse = configValueOf(config, "index.sparse");
  if (sparse.enabled && sparse.cone && indexSparse !== undefined && parseGitBool(indexSparse)) {
    const patterns = await readSparseCheckoutPatterns(workingCopy).catch(() => undefined);
    // no sparse-checkout file, or patterns not of the cone's shape: no sparse index
    if (patterns?.cone && patterns.coneSets) settings.sparse = patterns;
  }
  return settings;
}

/** The host a command gives its staging (see `Staging.setIndexHost`). */
export function indexHostOf(
  workingCopy: WorkingCopy,
  staging: Staging,
  trees: () => Pick<Trees, "load" | "store">,
): IndexHost {
  return {
    settings: () => indexSettingsOf(workingCopy, staging),
    written: () => {
      readdedPaths.delete(staging);
    },
    get trees() {
      return trees();
    },
  };
}
