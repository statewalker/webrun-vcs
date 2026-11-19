/**
 * Index refresh: the fresh stat of entries a status or stash proved clean by hashing,
 * stored as git's `refresh_index` stores it, compare-and-set per entry so a change made
 * meanwhile (an add, a flag) is never undone.
 */

import type { ObjectId } from "@statewalker/vcs-core";
import type { UntrackedCache } from "../status/untracked-cache.js";
import { wholeSeconds } from "../status/worktree-status.js";
import type { IndexFile } from "./index-file.js";
import type { StagingEntry } from "./types.js";

/** Fresh stat for one index entry, and the entry it was computed for. */
export interface IndexStatUpdate {
  path: string;
  /** The entry as compared: refreshed only while the index still holds exactly this */
  objectId: ObjectId;
  mode: number;
  expectedSize: number;
  expectedMtime: number;
  /** The stat to record */
  size: number;
  mtime: number;
  ctime?: number;
  mtimeNs?: number;
  ctimeNs?: number;
  dev?: number;
  ino?: number;
  uid?: number;
  gid?: number;
  /** A racily clean entry that changed: keep its stat, record size 0 (git's smudging) */
  smudge?: boolean;
}

const ms = (t: number | undefined) => Math.floor(t ?? 0);

/** Whole seconds, as status compares them (the exact nanoseconds deciding where known). */
const seconds = (t: number | undefined, ns?: number) => wholeSeconds(t, ns);

/**
 * Checks whether an index entry is racily clean and changed: its stat still matches the
 * file (whole seconds) while its content does not. Supplied by whoever can read the
 * worktree; used on every index write.
 */
export type RacyCheck = (entry: StagingEntry, indexTime: number) => Promise<boolean>;

/**
 * git's `ce_smudge_racily_clean_entry`, applied when an index is written: every stage-0
 * entry (not a submodule) whose mtime second is not older than the index file's (`indexTime`,
 * as read) and that `check` finds changed behind a matching stat gets size 0, so a later
 * read re-hashes it whatever its stat says. Only entries `asRead` accepts (unchanged since
 * the index was read or written) are checked. Returns the entries (the same array when none).
 */
export async function smudgeRacilyClean(
  entries: StagingEntry[],
  indexTime: number,
  check: RacyCheck | undefined,
  asRead?: (entry: StagingEntry) => boolean,
): Promise<StagingEntry[]> {
  if (!check || !indexTime) return entries;
  let out: StagingEntry[] | undefined;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.stage !== 0 || e.mode === 0o160000 || e.size === 0) continue;
    // an entry set in this session (from the worktree, or a refresh) is up to date, as
    // git's CE_UPTODATE: only entries as they were read are checked
    if (asRead && !asRead(e)) continue;
    if (seconds(e.mtime, e.mtimeNs) < seconds(indexTime)) continue;
    if (!(await check(e, indexTime))) continue;
    out ??= [...entries];
    out[i] = { ...e, size: 0 };
  }
  return out ?? entries;
}

/**
 * `existing` with the update's stat, or undefined to leave it: only a stage-0 entry that
 * still has the compared id, mode, size and mtime, and no assume-unchanged, skip-worktree
 * or intent-to-add flag; everything else of it is kept.
 */
export function applyStatUpdate(
  existing: StagingEntry | undefined,
  update: IndexStatUpdate,
  now: number,
): StagingEntry | undefined {
  if (!existing || existing.stage !== 0) return undefined;
  if (existing.assumeValid || existing.skipWorktree || existing.intentToAdd) return undefined;
  if (existing.objectId !== update.objectId || existing.mode !== update.mode) return undefined;
  if (existing.size !== update.expectedSize || ms(existing.mtime) !== ms(update.expectedMtime)) {
    return undefined;
  }
  if (update.smudge) return existing.size === 0 ? undefined : { ...existing, size: 0 };
  const defined = <T>(value: T | undefined, fallback: T | undefined) => value ?? fallback;
  // proved clean: recorded as it is, not smudged (git smudges only an entry whose content
  // changed); one in the second the index is written stays racy and is re-read next time
  void now;
  return {
    ...existing,
    size: update.size,
    mtime: update.mtime,
    ctime: defined(update.ctime, existing.ctime),
    mtimeNs: update.mtimeNs,
    ctimeNs: update.ctime !== undefined ? update.ctimeNs : existing.ctimeNs,
    dev: defined(update.dev, existing.dev),
    ino: defined(update.ino, existing.ino),
    uid: defined(update.uid, existing.uid),
    gid: defined(update.gid, existing.gid),
  };
}

/** `entries` with the updates applied (compare-and-set); undefined when none applied. */
export function applyStatUpdates(
  entries: readonly StagingEntry[],
  updates: readonly IndexStatUpdate[],
  now: number,
): StagingEntry[] | undefined {
  const byPath = new Map(updates.map((u) => [u.path, u]));
  let changed = false;
  const out = entries.map((entry) => {
    const update = byPath.get(entry.path);
    const next = update ? applyStatUpdate(entry, update, now) : undefined;
    if (!next) return entry;
    changed = true;
    return next;
  });
  return changed ? out : undefined;
}

/**
 * Refreshes the index file at `indexPath` with `updates`, as git status does: the index is
 * read afresh and must still be the one `current` read or wrote (same checksum); only stat
 * fields of matching entries change, so in-memory edits not yet written are not written by
 * this; the write takes `index.lock`. Returns the new in-memory entries (the same updates
 * applied to `inMemory`), or undefined when nothing was written.
 */
export async function refreshIndexFile(
  current: IndexFile,
  fresh: IndexFile,
  inMemory: readonly StagingEntry[],
  updates: readonly IndexStatUpdate[],
  skipWorktreeCleared?: ReadonlySet<string>,
  untrackedCache?: UntrackedCache | null,
): Promise<StagingEntry[] | undefined> {
  const untrackedChanged = untrackedCache !== undefined;
  if ((updates.length === 0 && !untrackedChanged) || current.currentChecksum === undefined) {
    return undefined;
  }
  try {
    const read = await fresh.read();
    if (!read || fresh.currentChecksum !== current.currentChecksum) return undefined;
    const now = Date.now();
    // the flags cleared when the index was read go with the write (as git writes its index)
    const base =
      (skipWorktreeCleared && clearSkipWorktreeFlags(read.entries, skipWorktreeCleared)) ||
      read.entries;
    // a changed untracked cache is written even with no stat to store (UNTRACKED_CHANGED)
    const entries = applyStatUpdates(base, updates, now) ?? (untrackedChanged ? base : undefined);
    if (!entries) return undefined;
    if (untrackedChanged) fresh.setUntrackedCache(untrackedCache, entries);
    fresh.version = current.version;
    await fresh.write(entries);
    current.adopt(fresh);
    return applyStatUpdates(inMemory, updates, now) ?? [...inMemory];
  } catch {
    // locked, changed meanwhile, or unreadable: git status gives up on its refresh too
    return undefined;
  }
}

/**
 * `entries` with the skip-worktree flag of the entries at `paths` cleared, any stage (git's
 * `clear_skip_worktree_from_present_files`); undefined when none had it. `onCleared`
 * receives each entry replaced and its replacement.
 */
export function clearSkipWorktreeFlags(
  entries: readonly StagingEntry[],
  paths: ReadonlySet<string>,
  onCleared?: (before: StagingEntry, after: StagingEntry) => void,
): StagingEntry[] | undefined {
  if (paths.size === 0) return undefined;
  let out: StagingEntry[] | undefined;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i] as StagingEntry;
    if (!e.skipWorktree || !paths.has(e.path)) continue;
    out ??= [...entries];
    const next = { ...e, skipWorktree: false };
    out[i] = next;
    onCleared?.(e, next);
  }
  return out;
}

/**
 * The entries of a staging store as it was last read or written (git: the entries not
 * `CE_UPTODATE`), by path, stage, object, mode, size and mtime: only these are checked when
 * the store is written again, so an entry set in this session is never smudged.
 *
 * @example
 * ```typescript
 * const asRead = new EntriesAsRead();
 * asRead.remember(entries); // after a read or a write
 * await smudgeRacilyClean(next, indexTime, check, (e) => asRead.has(e));
 * ```
 */
export class EntriesAsRead {
  private readonly known = new Map<string, string>();

  /** Replaces what is remembered with `entries`. */
  remember(entries: Iterable<StagingEntry>): void {
    this.known.clear();
    for (const e of entries) this.known.set(`${e.path}\0${e.stage}`, signature(e));
  }

  /** Whether `entry` is as it was last read or written. */
  has(entry: StagingEntry): boolean {
    return this.known.get(`${entry.path}\0${entry.stage}`) === signature(entry);
  }
}

const signature = (e: StagingEntry) => `${e.objectId}:${e.mode}:${e.size}:${ms(e.mtime)}`;
