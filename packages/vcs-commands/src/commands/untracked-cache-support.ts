/**
 * How `git status` keeps the index's untracked cache (`UNTR`): `core.untrackedCache`
 * (git's `tweak_untracked_cache` when it reads the index), the checks of
 * `validate_untracked_cache` before a scan may use it, and whether the scan changed it so
 * that the index is written (`read_directory`'s `UNTRACKED_CHANGED`).
 *
 * ```typescript
 * const state = openUntrackedCache(staging, config, environment, host);
 * const cache = await state.forScan(flags); // undefined: scan without it
 * // ... scanUntracked(host, { cache, ... })
 * if (state.changed()) await refreshIndexStats(staging, refresh, { untrackedCache: state.cache ?? null });
 * ```
 */

import { parseGitBool } from "@statewalker/vcs-utils";
import {
  DIR_HIDE_EMPTY_DIRECTORIES,
  DIR_SHOW_OTHER_DIRECTORIES,
  excludeFileOid,
  expandUserPath,
  type GitHostEnvironment,
  invalidateGitignore,
  NULL_OID,
  newUntrackedCache,
  newUntrackedCacheDir,
  type OidStat,
  type Staging,
  statDataOf,
  type UntrackedCache,
  type UntrackedScanHost,
  untrackedCacheIdent,
  untrackedCacheIdentIs,
  xdgConfigPath,
  zeroStatData,
} from "@statewalker/vcs-working-tree";

/** `core.untrackedCache` as git's repo settings read it. */
export type UntrackedCacheSetting = "keep" | "write" | "remove";

/** What configuration the untracked cache reads. */
export interface UntrackedCacheConfig {
  value(key: string): string | undefined;
}

/**
 * `core.untrackedCache`: true writes the cache, false removes it, anything else (`keep`,
 * unset) keeps whatever the index has; `feature.manyFiles` makes true the default.
 */
export function untrackedCacheSetting(config: UntrackedCacheConfig): UntrackedCacheSetting {
  let setting: UntrackedCacheSetting =
    parseGitBool(config.value("feature.manyFiles") ?? "false") === true ? "write" : "keep";
  const value = config.value("core.untrackedCache");
  if (value !== undefined) {
    const v = parseGitBool(value);
    if (v !== undefined) setting = v ? "write" : "remove";
  }
  return setting;
}

/**
 * The flags a new cache is made for (git's `new_untracked_cache_flags`): 0 when
 * `status.showUntrackedFiles` is `all`, else those of the default `normal` mode.
 */
export function newUntrackedCacheFlags(config: UntrackedCacheConfig): number {
  if (config.value("status.showUntrackedFiles") === "all") return 0;
  return DIR_SHOW_OTHER_DIRECTORIES | DIR_HIDE_EMPTY_DIRECTORIES;
}

/** The untracked cache of one status run. */
export interface UntrackedCacheState {
  /** The cache the index will hold (undefined: none) */
  readonly cache: UntrackedCache | undefined;
  /**
   * The cache a whole-tree scan without ignored files and pathspec, made with the
   * `dir_struct` `flags` (0 for `-uall`, `DIR_SHOW_OTHER_DIRECTORIES |
   * DIR_HIDE_EMPTY_DIRECTORIES` for `-unormal`), may use and update
   * (`validate_untracked_cache`): its exclude files checked, a root made; undefined when
   * the scan must go without it. A cache of other flags is replaced, unless it is the one
   * `status.showUntrackedFiles` makes (it is then kept for the scans of that mode).
   */
  forScan(flags: number): Promise<UntrackedCache | undefined>;
  /** Whether the index must be written for the cache (`UNTRACKED_CHANGED`) */
  changed(): boolean;
}

/**
 * The index's untracked cache as `git status` takes it: removed or added per
 * `core.untrackedCache` (an add needs the worktree's location and the system's name, git's
 * ident), then offered to the scan.
 */
export function openUntrackedCache(
  staging: Staging,
  config: UntrackedCacheConfig,
  environment: GitHostEnvironment | undefined,
  host: UntrackedScanHost | undefined,
): UntrackedCacheState {
  const supported = typeof staging.getUntrackedCache === "function";
  let cache = supported ? staging.getUntrackedCache?.() : undefined;
  let changed = false;
  const setting = untrackedCacheSetting(config);
  const ident =
    host?.worktreePath && environment?.systemName
      ? untrackedCacheIdent(host.worktreePath, environment.systemName)
      : undefined;
  // tweak_untracked_cache
  if (supported && setting === "remove" && cache) {
    cache = undefined;
    changed = true;
  } else if (supported && setting === "write" && ident) {
    if (!cache || !untrackedCacheIdentIs(cache, ident)) {
      cache = newUntrackedCache(ident, newUntrackedCacheFlags(config));
      changed = true;
    }
  }
  let scanned: UntrackedCache | undefined;
  const force = environment?.forceUntrackedCache;
  return {
    get cache() {
      return cache;
    },
    async forScan(flags: number) {
      if (!cache || !ident || !host || environment?.disableUntrackedCache) return undefined;
      if (cache.excludePerDir !== ".gitignore") return undefined;
      // a cache made elsewhere: git warns that it is disabled here and goes without it
      if (!untrackedCacheIdentIs(cache, ident)) return undefined;
      // a cache made for other flags: replaced by one for these when it is not the
      // configured mode's, else kept for the scans of that mode and not used here
      if (cache.dirFlags !== flags) {
        if (cache.dirFlags === newUntrackedCacheFlags(config)) return undefined;
        cache = newUntrackedCache(ident, flags);
        changed = true;
      }
      if (!cache.root) {
        // a cache not yet initialized gets its root
        cache.root = newUntrackedCacheDir("");
        changed = true;
      }
      // $GIT_DIR/info/exclude and core.excludesFile: another id invalidates everything
      const info = await readExcludeFile(await host.readInfoExclude?.());
      const excludes = await readExcludesFile(config, environment);
      if (info.oid !== cache.infoExclude.oid) {
        invalidateGitignore(cache, cache.root);
        cache.infoExclude = info;
      }
      if (excludes.oid !== cache.excludesFile.oid) {
        invalidateGitignore(cache, cache.root);
        cache.excludesFile = excludes;
      }
      scanned = cache;
      return cache;
    },
    changed() {
      if (changed) return true;
      if (!scanned) return false;
      const writes = force ?? setting === "write";
      return (
        writes &&
        (scanned.dirOpened > 0 || scanned.gitignoreInvalidated > 0 || scanned.dirInvalidated > 0)
      );
    },
  };
}

/** An exclude file's id and stat as git's `add_patterns` records them (no istate). */
async function readExcludeFile(
  read: { bytes: Uint8Array; stat: import("@statewalker/vcs-utils/files").LinkStats } | undefined,
): Promise<OidStat> {
  if (!read) return { stat: zeroStatData(), oid: NULL_OID };
  return { stat: statDataOf(read.stat), oid: await excludeFileOid(read.bytes) };
}

/**
 * `core.excludesFile` (`~/` expanded), else `$XDG_CONFIG_HOME/git/ignore`, read through the
 * host (git's `setup_standard_excludes`): the null id when it is not there.
 */
async function readExcludesFile(
  config: UntrackedCacheConfig,
  environment: GitHostEnvironment | undefined,
): Promise<OidStat> {
  if (!environment) return { stat: zeroStatData(), oid: NULL_OID };
  const configured = config.value("core.excludesFile");
  const path =
    configured !== undefined && configured !== ""
      ? expandUserPath(configured, environment)
      : xdgConfigPath(environment, "ignore");
  if (!path) return { stat: zeroStatData(), oid: NULL_OID };
  const bytes = await environment.readFile(path).catch(() => undefined);
  if (!bytes) return { stat: zeroStatData(), oid: NULL_OID };
  const stat = await environment.statFile?.(path).catch(() => undefined);
  return {
    stat: stat ? statDataOf(stat) : zeroStatData(),
    oid: await excludeFileOid(bytes),
  };
}
