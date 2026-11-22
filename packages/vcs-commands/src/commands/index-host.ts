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
import { parseGitBool, parseGitInt } from "@statewalker/vcs-utils";
import {
  type GitHostEnvironment,
  type IndexHost,
  type IndexSettings,
  type IndexVersion,
  parseSharedRepository,
  type Staging,
  untrackedCacheIdent,
  type WorkingCopy,
} from "@statewalker/vcs-working-tree";

import { InvalidConfigError } from "../errors/index.js";
import { RemoteConfigStore } from "../remote-config/index.js";
import { approxidateCareful } from "./git-date.js";
import { hostEnvironmentOf } from "./git-ident.js";
import { peekIndexUpdate } from "./post-index-change.js";
import { readSparseCheckoutPatterns, sparseCheckoutConfig } from "./sparse-checkout-support.js";
import { newUntrackedCacheFlags, untrackedCacheSetting } from "./untracked-cache-support.js";

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

/** read-cache.c's `INDEX_FORMAT_DEFAULT`, `INDEX_FORMAT_LB` and `INDEX_FORMAT_UB`. */
const INDEX_FORMAT_DEFAULT = 3;
const INDEX_FORMAT_LB = 2;
const INDEX_FORMAT_UB = 4;

/**
 * `index.version` is not an integer: git dies when it reads its repository settings
 * (`prepare_repo_settings`), which every command but `git config` does before it reads or
 * writes anything.
 */
export class IndexVersionConfigError extends InvalidConfigError {
  /** git's stderr */
  readonly lines: string[];
  /** @param file the configuration file it was read from (none: the command line) */
  constructor(
    readonly value: string,
    file?: string,
  ) {
    const where = file ? ` in file ${file}` : "";
    const line = `fatal: bad numeric config value '${value}' for 'index.version'${where}: invalid unit`;
    super("index.version", line);
    this.name = "IndexVersionConfigError";
    this.lines = [line];
  }
}

/**
 * The death git's `prepare_repo_settings` gives a non-integer `index.version`, or undefined.
 * Commands check it as they start (`GitCommand.checkConfigOnLoad`), so a command git refuses
 * to run changes nothing: checkout would otherwise update the worktree and only then fail
 * to write the index.
 *
 * ```typescript
 * // .git/config: [index] version = four
 * indexVersionConfigError(workingCopy)?.lines;
 * // ["fatal: bad numeric config value 'four' for 'index.version' in file .git/config: invalid unit"]
 * ```
 */
export function indexVersionConfigError(
  workingCopy: WorkingCopy,
): IndexVersionConfigError | undefined {
  if (!workingCopy.config) return undefined;
  const config = RemoteConfigStore.from(workingCopy);
  const configured = configValueOf(config, "index.version");
  if (configured === undefined || parseGitInt(configured) !== undefined) return undefined;
  return new IndexVersionConfigError(configured, versionOrigin(config));
}

/**
 * The version a new index is written in, as read-cache.c's `get_index_format_default`
 * works it out: `$GIT_INDEX_VERSION` (read as `strtoul`), else `index.version`, else 4 under
 * `feature.manyFiles` (repo-settings.c), else 3; a value outside 2..4 gives 3 and git's
 * warning.
 *
 * ```typescript
 * indexFormatDefault({ indexVersion: "4" }, undefined, false); // { version: 4 }
 * indexFormatDefault(undefined, "9", false).warning; // "warning: index.version set, ..."
 * ```
 *
 * @throws IndexVersionConfigError when `index.version` is not an integer (git dies)
 */
export function indexFormatDefault(
  environment: Pick<GitHostEnvironment, "indexVersion"> | undefined,
  configured: string | undefined,
  manyFiles: boolean,
  /** The file `configured` was read from, for the death's line (none: the command line) */
  configuredFile?: string,
): { version: IndexVersion; warning?: string } {
  const env = environment?.indexVersion;
  if (env === undefined) {
    let version = manyFiles ? 4 : INDEX_FORMAT_DEFAULT;
    if (configured !== undefined) {
      const n = parseGitInt(configured);
      if (n === undefined) throw new IndexVersionConfigError(configured, configuredFile);
      // r->settings.index_version >= 0 overrides; a negative value keeps the default
      if (n >= 0) version = n;
    }
    if (version < INDEX_FORMAT_LB || version > INDEX_FORMAT_UB) {
      return {
        version: INDEX_FORMAT_DEFAULT,
        warning: `warning: index.version set, but the value is invalid.\nUsing version ${INDEX_FORMAT_DEFAULT}`,
      };
    }
    return { version: version as IndexVersion };
  }
  // strtoul(envversion, &endp, 10) with nothing after the digits
  const m = /^[ \t\n\v\f\r]*([+-]?)(\d*)$/.exec(env);
  const n = m ? Number.parseInt(m[2] || "0", 10) : Number.NaN;
  const value = m && m[1] === "-" && n !== 0 ? Number.NaN : n;
  if (!(value >= INDEX_FORMAT_LB && value <= INDEX_FORMAT_UB)) {
    return {
      version: INDEX_FORMAT_DEFAULT,
      warning: `warning: GIT_INDEX_VERSION set, but the value is invalid.\nUsing version ${INDEX_FORMAT_DEFAULT}`,
    };
  }
  return { version: value as IndexVersion };
}

/** The warnings index writes of a staging printed (see `takeIndexWarnings`). */
const indexWarnings = new WeakMap<object, string[]>();

/**
 * The warnings the index writes of `staging` printed since the last call (git's stderr:
 * `index.version set, but the value is invalid.`), cleared by the call.
 *
 * ```typescript
 * await git.add().addFilepattern("a").call();
 * takeIndexWarnings(staging); // ["warning: index.version set, but ..."]
 * ```
 */
export function takeIndexWarnings(staging: object): string[] {
  const lines = indexWarnings.get(staging) ?? [];
  indexWarnings.delete(staging);
  return lines;
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

/** The file the last `index.version` was read from (undefined: the command line, or unknown). */
function versionOrigin(config: RemoteConfigStore): string | undefined {
  try {
    const last = config.valuesWithOrigin("index.version").at(-1);
    return last?.scope === "command" ? undefined : last?.file;
  } catch {
    return undefined;
  }
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
  // repo-settings.c: feature.manyFiles implies index.skipHash, which overrides it
  const manyFiles = configValueOf(config, "feature.manyFiles");
  const manyFilesOn = manyFiles === undefined ? false : (parseGitBool(manyFiles) ?? false);
  const skipHash = configValueOf(config, "index.skipHash");
  if (skipHash === undefined ? manyFilesOn : (parseGitBool(skipHash) ?? manyFilesOn)) {
    settings.skipHash = true;
  }
  const environment = hostEnvironmentOf(workingCopy);
  const configured = configValueOf(config, "index.version");
  const origin = configured === undefined ? undefined : versionOrigin(config);
  const format = indexFormatDefault(environment, configured, manyFilesOn, origin);
  settings.version = format.version;
  if (format.warning) settings.versionWarning = format.warning;
  // tweak_untracked_cache (core.untrackedCache, default write under feature.manyFiles): an
  // added cache names the worktree and the system (set_untracked_ident)
  const untracked = untrackedCacheSetting({ value: (key) => configValueOf(config, key) });
  if (untracked !== "keep") {
    settings.untrackedCache = untracked;
    const location = workingCopy.worktree?.hostPath;
    if (untracked === "write" && location && environment?.systemName) {
      settings.untrackedIdent = untrackedCacheIdent(location, environment.systemName);
      settings.untrackedFlags = newUntrackedCacheFlags({
        value: (key) => configValueOf(config, key),
      });
    }
  }
  const max = configValueOf(config, "splitIndex.maxPercentChange");
  if (max !== undefined && /^\s*-?\d+\s*$/.test(max)) {
    const n = Number.parseInt(max, 10);
    if (n >= 0 && n <= 100) settings.maxPercentChange = n;
  }
  // worked out when a write expires shared indexes (a split index only): approxidate's first
  // run costs a command's start milliseconds; the time is the settings' own
  const now = Math.floor(Date.now() / 1000);
  const expireValue = configValueOf(config, "splitIndex.sharedIndexExpire");
  let expireBefore: number | undefined;
  Object.defineProperty(settings, "sharedIndexExpireBefore", {
    get: () => {
      expireBefore ??= sharedIndexExpireDate(expireValue, now);
      return expireBefore;
    },
    enumerable: true,
    configurable: true,
  });
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
    warn: (line) => {
      const lines = indexWarnings.get(staging) ?? [];
      lines.push(line);
      indexWarnings.set(staging, lines);
    },
    get trees() {
      return trees();
    },
  };
}
