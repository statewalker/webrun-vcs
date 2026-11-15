/**
 * Index refresh: the fresh stat of entries a status or stash proved clean by hashing,
 * stored as git's `refresh_index` stores it, compare-and-set per entry so a change made
 * meanwhile (an add, a flag) is never undone.
 */

import type { ObjectId } from "@statewalker/vcs-core";
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

/**
 * `existing` with the update's stat, or undefined to leave it: only a stage-0 entry that
 * still has the compared id, mode, size and mtime, and no assume-unchanged, skip-worktree
 * or intent-to-add flag; everything else of it is kept. An entry modified at or after `now`
 * (the index's write time) gets size 0, as git smudges racily clean entries.
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
  return {
    ...existing,
    size: ms(update.mtime) >= ms(now) ? 0 : update.size,
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
): Promise<StagingEntry[] | undefined> {
  if (updates.length === 0 || current.currentChecksum === undefined) return undefined;
  try {
    const read = await fresh.read();
    if (!read || fresh.currentChecksum !== current.currentChecksum) return undefined;
    const now = Date.now();
    const entries = applyStatUpdates(read.entries, updates, now);
    if (!entries) return undefined;
    fresh.version = current.version;
    await fresh.write(entries);
    current.adopt(fresh);
    return applyStatUpdates(inMemory, updates, now) ?? [...inMemory];
  } catch {
    // locked, changed meanwhile, or unreadable: git status gives up on its refresh too
    return undefined;
  }
}
