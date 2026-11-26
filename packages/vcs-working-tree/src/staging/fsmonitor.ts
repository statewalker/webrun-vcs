/**
 * The fsmonitor state of an index (git's `fsmonitor_last_update` and the entries'
 * `CE_FSMONITOR_VALID` bits) and its `FSMN` extension.
 *
 * ```typescript
 * const state = staging.getFsmonitor?.();
 * if (state?.isValid(entry)) {
 *   // the monitor saw no change since the token: git takes the entry as up to date
 * }
 * ```
 *
 * A valid bit claims "the file has not changed since the token". A wrong claim makes git
 * miss a change, so a bit is held for the entry exactly as it was when it was marked (path,
 * stage, mode, id, flags and stat): an entry changed or replaced in any way since is dirty
 * again, as git's `replace_index_entry` clears the bit. Only code that saw the file up to
 * date marks it valid (status's refresh, a new entry `git add` hashed).
 */

import { EwahBitmap } from "@statewalker/vcs-utils";
import type { StagingEntry } from "./types.js";

/** The fsmonitor extension's signature. */
export const FSMONITOR_EXTENSION = "FSMN";

const GITLINK = 0o160000;

const keyOf = (entry: StagingEntry) => `${entry.path}\0${entry.stage}`;

/** Every field of an entry a valid bit is held for. */
function fingerprintOf(e: StagingEntry): string {
  return [
    e.mode,
    e.objectId,
    e.size,
    e.mtime,
    e.mtimeNs ?? 0,
    e.ctime ?? 0,
    e.ctimeNs ?? 0,
    e.dev ?? 0,
    e.ino ?? 0,
    e.uid ?? 0,
    e.gid ?? 0,
    e.assumeValid ? 1 : 0,
    e.intentToAdd ? 1 : 0,
    e.skipWorktree ? 1 : 0,
  ].join(" ");
}

/** What an `FSMN` extension holds: the token and the positions of the dirty entries. */
export interface FsmonitorExtension {
  token: string;
  /** Positions (in index order) of the entries not known valid */
  dirty: number[];
  /** The bitmap's bit size */
  bitSize: number;
}

/**
 * The in-memory fsmonitor state of an index: its last update token and which entries are
 * valid (git's `CE_FSMONITOR_VALID`), plus what git keeps per index read (whether the
 * monitor was asked, whether the untracked cache may trust it).
 */
export class FsmonitorState {
  private readonly valid = new Map<string, string>();
  /** git's `FSMONITOR_CHANGED`: the index should be written although no entry changed */
  changed = false;
  /** git's `fsmonitor_has_run_once`: the monitor was asked for this index */
  hasRun = false;
  /** git's `untracked->use_fsmonitor`: the untracked cache's valid directories are trusted */
  useForUntracked = false;
  /**
   * Added by `update-index --fsmonitor` with `core.fsmonitor` off: written all the same (git
   * writes any `fsmonitor_last_update`), removed by the next read with the monitor off
   */
  writtenWhileDisabled = false;

  constructor(
    /** git's `fsmonitor_last_update` */
    public token: string,
  ) {}

  /** Whether `entry`, exactly as it is, is fsmonitor-valid. */
  isValid(entry: StagingEntry): boolean {
    const held = this.valid.get(keyOf(entry));
    return held !== undefined && held === fingerprintOf(entry);
  }

  /**
   * git's `mark_fsmonitor_valid`: `entry` (as it is) is up to date; a gitlink never is,
   * unless `gitlinks` (update-index's `mark_ce_flags`).
   * Marks the index changed when the bit was not set.
   */
  markValid(entry: StagingEntry, options: { gitlinks?: boolean } = {}): void {
    // update-index --fsmonitor-valid sets the flag on any entry (mark_ce_flags): a gitlink's
    // bit is then written as not dirty, and cleared again when the index is read
    if (entry.mode === GITLINK && !options.gitlinks) return;
    if (this.isValid(entry)) return;
    this.valid.set(keyOf(entry), fingerprintOf(entry));
    this.changed = true;
  }

  /** Clears `entry`'s bit (any entry at its path and stage); true when it was set. */
  markInvalid(entry: StagingEntry): boolean {
    return this.valid.delete(keyOf(entry));
  }

  /** Clears every bit; true when one was set. */
  invalidateAll(): boolean {
    const had = this.valid.size > 0;
    this.valid.clear();
    return had;
  }

  /**
   * git's `tweak_fsmonitor` on an index read with an `FSMN` extension: every entry valid
   * (gitlinks aside) but those the bitmap names dirty.
   */
  static fromExtension(ext: FsmonitorExtension, entries: readonly StagingEntry[]): FsmonitorState {
    const state = new FsmonitorState(ext.token);
    const dirty = new Set(ext.dirty);
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i] as StagingEntry;
      if (e.mode === GITLINK || dirty.has(i)) continue;
      state.valid.set(keyOf(e), fingerprintOf(e));
    }
    return state;
  }

  /** A copy (the bits, token and flags). */
  copy(): FsmonitorState {
    const state = new FsmonitorState(this.token);
    for (const [k, v] of this.valid) state.valid.set(k, v);
    state.changed = this.changed;
    state.hasRun = this.hasRun;
    state.useForUntracked = this.useForUntracked;
    state.writtenWhileDisabled = this.writtenWhileDisabled;
    return state;
  }
}

/**
 * git's `read_fsmonitor_extension`: version 1 (a 64-bit nanosecond time, given as its
 * decimal string) or 2 (a NUL-terminated token), then the EWAH bitmap of dirty entries.
 * Undefined for an extension git refuses (`corrupt fsmonitor extension`, a bad version, a
 * bitmap that does not parse) or one naming more entries than `entryCount`.
 */
export function parseFsmonitorExtension(
  data: Uint8Array,
  entryCount: number,
): FsmonitorExtension | undefined {
  if (data.length < 9) return undefined;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const version = view.getUint32(0);
  let at = 4;
  let token: string;
  if (version === 1) {
    if (data.length < at + 8 + 4) return undefined;
    token = view.getBigUint64(at).toString();
    at += 8;
  } else if (version === 2) {
    let end = at;
    while (end < data.length && data[end] !== 0) end++;
    if (end >= data.length) return undefined;
    token = "";
    for (let i = at; i < end; i++) token += String.fromCharCode(data[i] as number);
    at = end + 1;
  } else {
    return undefined;
  }
  if (at + 4 > data.length) return undefined;
  const size = view.getUint32(at);
  at += 4;
  if (at + size > data.length) return undefined;
  let bitmap: EwahBitmap;
  try {
    const read = EwahBitmap.read(data, at, at + size);
    if (!read || read.next !== at + size) return undefined;
    bitmap = read.bitmap;
  } catch {
    return undefined;
  }
  if (bitmap.bitSize > entryCount) return undefined;
  const dirty: number[] = [];
  for (const pos of bitmap.bits()) {
    if (pos >= entryCount) return undefined;
    dirty.push(pos);
  }
  return { token, dirty, bitSize: bitmap.bitSize };
}

/**
 * git's `fill_fsmonitor_bitmap` and `write_fsmonitor_extension`: version 2, the token, its
 * NUL, the bitmap's size and the EWAH bitmap of the entries `state` does not hold valid.
 */
export function encodeFsmonitorExtension(
  state: FsmonitorState,
  entries: readonly StagingEntry[],
): Uint8Array {
  const bitmap = new EwahBitmap();
  for (let i = 0; i < entries.length; i++) {
    if (!state.isValid(entries[i] as StagingEntry)) bitmap.set(i);
  }
  const ewah: number[] = [];
  bitmap.serialize(ewah);
  const token = latin1Bytes(state.token);
  const out = new Uint8Array(4 + token.length + 1 + 4 + ewah.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, 2);
  out.set(token, 4);
  out[4 + token.length] = 0;
  view.setUint32(5 + token.length, ewah.length);
  out.set(ewah, 9 + token.length);
  return out;
}

function latin1Bytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}
