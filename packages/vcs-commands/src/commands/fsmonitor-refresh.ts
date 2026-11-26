/**
 * Asking the file system monitor (`core.fsmonitor`) what changed, as git does on every index
 * it reads (fsmonitor.c's `tweak_fsmonitor`, `add_fsmonitor`, `refresh_fsmonitor`).
 *
 * ```typescript
 * const run = await refreshFsmonitor({ staging, config, query, ignoreCase });
 * if (run?.state.isValid(entry)) {
 *   // the monitor reported nothing for it since the token: up to date without an lstat
 * }
 * ```
 *
 * The monitor is a host callback (`GitHostEnvironment.fsmonitor`) or, without one, the
 * hook program `core.fsmonitor` names, run through the host's hook runner; this code never
 * watches files or starts a process itself. A failed, empty or trivial (`/`) answer leaves
 * every entry to be checked, as git: the monitor can make a command skip work, never miss a
 * change it reported.
 */

import { isValidWorktreePath } from "@statewalker/vcs-core";
import { compareGitPaths, decodeGitPath, parseGitBool } from "@statewalker/vcs-utils/encoding";
import {
  type FsmonitorAnswer,
  type FsmonitorQuery,
  FsmonitorState,
  invalidateUntrackedPath,
  type Staging,
  type StagingEntry,
} from "@statewalker/vcs-working-tree";

/** git's `fsmonitor_force_update_threshold`: more reported paths than this write the index. */
const FORCE_UPDATE_THRESHOLD = 100;

/** How `core.fsmonitor` turns the monitor on (fsm-settings.c `lookup_fsmonitor_settings`). */
export type FsmonitorMode =
  | { kind: "disabled" }
  | { kind: "hook"; command: string }
  | { kind: "ipc" };

/**
 * `core.fsmonitor` as git reads it: a boolean (`true`: the builtin daemon, `false` or empty:
 * off), else the hook program's path.
 */
export function fsmonitorModeOf(value: string | undefined): FsmonitorMode {
  if (value === undefined) return { kind: "disabled" };
  const bool = parseGitBool(value);
  if (bool === true) return { kind: "ipc" };
  if (bool === false || value === "") return { kind: "disabled" };
  return { kind: "hook", command: value };
}

/** What a run of the monitor left: the state and what else git did with the answer. */
export interface FsmonitorRun {
  /** The index's fsmonitor state, its bits as the answer left them */
  state: FsmonitorState;
  /**
   * The paths whose untracked-cache directories the answer invalidated
   * (`untracked_cache_invalidate_trimmed_path`), in order
   */
  untrackedPaths: string[];
  /** git's warnings (stderr lines without `warning: `) */
  warnings: string[];
}

export interface RefreshFsmonitorOptions {
  staging: Staging;
  /** A configuration value (`core.fsmonitor`, `core.fsmonitorHookVersion`) */
  config(key: string): string | undefined;
  /** Asks the monitor (the host's callback or the hook); undefined or a throw is a failure */
  query(query: FsmonitorQuery): Promise<FsmonitorAnswer | undefined>;
  /** `core.ignorecase`: a reported path matching no entry is matched again, case folded */
  ignoreCase?: boolean;
  /** The current time in nanoseconds since the epoch (git's `getnanotime`), for tests */
  nanotime?: () => bigint;
  /**
   * The command run asking (git: the process that read the index): the monitor is asked
   * once per owner, again for the next one, even over the same index in memory
   */
  owner?: object;
}

const runs = new WeakMap<FsmonitorState, { owner: object | undefined; run: FsmonitorRun }>();

/**
 * git's `tweak_fsmonitor` for the index `staging` holds: with the monitor off, its `FSMN`
 * state is removed (the index then wants a rewrite); with it on, a state is added when there
 * is none (`add_fsmonitor`: a nanosecond token, every entry dirty) and the monitor is asked
 * once per index read (`refresh_fsmonitor`). Undefined while the monitor is off, or for a
 * staging without an index file.
 */
export async function refreshFsmonitor(
  options: RefreshFsmonitorOptions,
): Promise<FsmonitorRun | undefined> {
  const { staging } = options;
  if (typeof staging.getFsmonitor !== "function" || !staging.setFsmonitor) return undefined;
  const mode = fsmonitorModeOf(options.config("core.fsmonitor"));
  let state = staging.getFsmonitor();
  if (mode.kind === "disabled") {
    if (state) staging.setFsmonitor(undefined);
    return undefined;
  }
  if (state) {
    const done = runs.get(state);
    if (done && done.owner === options.owner) return done.run;
  }
  const nanotime = options.nanotime ?? (() => BigInt(Date.now()) * 1_000_000n);
  const added = !state;
  if (!state) {
    // add_fsmonitor: a V1-like token for now, every entry dirty, the index changed
    state = new FsmonitorState(String(nanotime()));
    state.useForUntracked = true;
    staging.setFsmonitor(state);
  }
  const run: FsmonitorRun = { state, untrackedPaths: [], warnings: [] };
  runs.set(state, { owner: options.owner, run });
  state.hasRun = true;
  await refresh(run, mode, options, nanotime, added);
  // the untracked cache in memory loses the reported directories (refresh_fsmonitor's
  // untracked_cache_invalidate_trimmed_path), carried by whatever writes the index next:
  // the new token must never be written beside directories the monitor reported
  if (run.untrackedPaths.length > 0 && staging.carryUntrackedCache) {
    const cache = staging.getUntrackedCache?.();
    if (cache) {
      for (const path of run.untrackedPaths) invalidateUntrackedPath(cache, path);
      staging.carryUntrackedCache(cache);
    }
  }
  return run;
}

/** `query_fsmonitor_hook` / `fsmonitor_ipc__send_query`: the answer, or undefined on failure. */
async function ask(
  options: RefreshFsmonitorOptions,
  query: FsmonitorQuery,
): Promise<Uint8Array | undefined> {
  try {
    const answer = await options.query(query);
    return answer && answer.exitCode === 0 ? answer.stdout : undefined;
  } catch {
    return undefined;
  }
}

/** The NUL-terminated string at `at` (the whole rest without a NUL), as latin-1 text. */
function cString(bytes: Uint8Array, at: number): string {
  let end = at;
  while (end < bytes.length && bytes[end] !== 0) end++;
  let out = "";
  for (let i = at; i < end; i++) out += String.fromCharCode(bytes[i] as number);
  return out;
}

/** `refresh_fsmonitor`. */
async function refresh(
  run: FsmonitorRun,
  mode: Exclude<FsmonitorMode, { kind: "disabled" }>,
  options: RefreshFsmonitorOptions,
  nanotime: () => bigint,
  added: boolean,
): Promise<void> {
  const { state } = run;
  let result: Uint8Array | undefined;
  let token = "";
  let bol = 0;
  let trivial = false;
  if (mode.kind === "ipc") {
    // add_fsmonitor leaves no token: the daemon is asked since "builtin:fake"
    result = await ask(options, { mode: "ipc", token: added ? "builtin:fake" : state.token });
    if (result) {
      token = cString(result, 0);
      bol = token.length + 1;
      trivial = result[bol] === 0x2f;
    } else {
      token = "builtin:fake";
    }
  } else {
    let version = hookVersion(options, run.warnings);
    const lastUpdate = nanotime();
    if (version === 1) token = String(lastUpdate);
    if (version === -1 || version === 2) {
      result = await ask(options, {
        mode: "hook",
        command: mode.command,
        version: 2,
        token: state.token,
      });
      if (result) {
        if (version < 0) version = 2;
        token = cString(result, 0);
        if (token.length === 0) {
          run.warnings.push("Empty last update token.");
          result = undefined;
        } else {
          bol = token.length + 1;
          trivial = result[bol] === 0x2f;
        }
      } else if (version < 0) {
        version = 1;
        if (token.length === 0) token = String(lastUpdate);
      }
    }
    if (version === 1) {
      result = await ask(options, {
        mode: "hook",
        command: mode.command,
        version: 1,
        token: state.token,
      });
      if (result) trivial = result[0] === 0x2f;
    }
  }
  if (result && !trivial) {
    // every path the monitor names is dirty, in the index and in the untracked cache
    const entries = await entriesOf(options.staging);
    let count = 0;
    let start = bol;
    for (let i = bol; i < result.length; i++) {
      if (result[i] !== 0) continue;
      onPath(run, entries, decodeGitPath(result.subarray(start, i)), options.ignoreCase);
      start = i + 1;
      count++;
    }
    if (start < result.length) {
      onPath(run, entries, decodeGitPath(result.subarray(start)), options.ignoreCase);
      count++;
    }
    state.useForUntracked = true;
    if (count > FORCE_UPDATE_THRESHOLD) state.changed = true;
  } else {
    // no answer, or "everything may have changed": every entry is checked
    if (state.invalidateAll()) state.changed = true;
    state.useForUntracked = false;
  }
  state.token = token;
}

/** `fsmonitor_hook_version`: `core.fsmonitorHookVersion` 1 or 2, else -1 (both tried). */
function hookVersion(options: RefreshFsmonitorOptions, warnings: string[]): number {
  const value = options.config("core.fsmonitorHookVersion");
  if (value === undefined) return -1;
  const n = Number.parseInt(value.trim(), 10);
  if (n === 1 || n === 2) return n;
  warnings.push(
    `Invalid hook version '${Number.isNaN(n) ? 0 : n}' in core.fsmonitorhookversion. Must be 1 or 2.`,
  );
  return -1;
}

async function entriesOf(staging: Staging): Promise<readonly StagingEntry[]> {
  const list = staging.entryList?.();
  if (list) return list;
  const out: StagingEntry[] = [];
  for await (const e of staging.entries()) out.push(e);
  return out;
}

/** git's `untracked_cache_invalidate_trimmed_path` (paths `verify_path` refuses are skipped). */
function invalidateUntracked(run: FsmonitorRun, name: string): void {
  const trimmed = name.endsWith("/") ? name.slice(0, -1) : name;
  if (trimmed === "" || !isValidWorktreePath(trimmed, undefined, { protectHFS: false })) return;
  run.untrackedPaths.push(trimmed);
}

/** Index of the first entry whose path is not before `path` (the entries are sorted). */
function lowerBound(entries: readonly StagingEntry[], path: string): number {
  let lo = 0;
  let hi = entries.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (compareGitPaths((entries[mid] as StagingEntry).path, path) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** `fsmonitor_refresh_callback`: the entries at or below a reported path dirty. */
function onPath(
  run: FsmonitorRun,
  entries: readonly StagingEntry[],
  name: string,
  ignoreCase: boolean | undefined,
): void {
  if (name === "") return;
  let count = 0;
  const cone = (prefix: string) => {
    invalidateUntracked(run, prefix);
    // entries are in byte order of their paths; compare as such for the cone scan
    for (let i = lowerBound(entries, prefix); i < entries.length; i++) {
      const e = entries[i] as StagingEntry;
      if (!e.path.startsWith(prefix)) break;
      run.state.markInvalid(e);
      count++;
    }
    // a sparse index's directory entry in the cone (held apart from the expanded entries)
    if (run.state.markSparseDirectoriesInvalid(prefix)) count++;
  };
  if (name.endsWith("/")) {
    cone(name);
  } else {
    invalidateUntracked(run, name);
    let exact = false;
    for (let i = lowerBound(entries, name); i < entries.length; i++) {
      const e = entries[i] as StagingEntry;
      if (e.path !== name) break;
      run.state.markInvalid(e);
      exact = true;
    }
    if (exact) count++;
    else cone(`${name}/`);
  }
  if (count > 0 || !ignoreCase) return;
  // case-insensitive file systems: the observed spelling may differ from the index's
  const folded = (name.endsWith("/") ? name.slice(0, -1) : name).toLowerCase();
  for (const e of entries) {
    const path = e.path.toLowerCase();
    if (path === folded || path.startsWith(`${folded}/`)) {
      run.state.markInvalid(e);
      invalidateUntracked(run, path === folded ? e.path : e.path.slice(0, folded.length));
    }
  }
}
