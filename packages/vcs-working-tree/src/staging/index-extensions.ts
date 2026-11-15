/**
 * Which index extensions survive a rewrite of the index.
 *
 * Git stores optional data after the index entries, each piece behind a
 * four-character signature. A signature that starts with an uppercase letter is
 * optional: a reader that does not understand it may ignore it. One that starts
 * with a lowercase letter is required: a reader that does not understand it must
 * not use the index (`link`, the split index; `sdir`, the sparse index).
 *
 * When we rewrite an index git wrote, we keep only the extensions we know, as
 * git drops the optional extensions it does not know when it rewrites:
 *
 * | Extension | Kept when |
 * |-----------|-----------|
 * | `TREE` (cache-tree), `UNTR` (untracked cache), `FSMN` (fsmonitor) | the entries did not change; dropped otherwise, git rebuilds them |
 * | `REUC` (resolve-undo) | always, every record (dropped only when it cannot be parsed) |
 * | `EOIE`, `IEOT` (offsets into the file) | never; git writes them again when configured to |
 * | any other uppercase signature | never: an optional extension we do not know is dropped |
 * | any lowercase signature | never: the rewrite is refused (`UnsupportedIndexExtensionError`) |
 *
 * "The entries did not change" means the same (path, stage, mode, object id,
 * intent-to-add) list; stat data may differ.
 *
 * Resolve-undo records stay even for a path that is no longer in the index (a
 * conflict resolved with `git rm`), as git keeps them. Git clears them on
 * `read-tree`, `reset` and `commit`; here a full `Staging.readTree` (without
 * `keepExisting`) clears them, which covers our reset. Our commit does not
 * rewrite the index, so it leaves them until the next read-tree or reset.
 */
import { objectIdToBytes } from "@statewalker/vcs-core";
import { bytesToHex, createSha1 } from "@statewalker/vcs-utils";
import type { IndexExtension } from "./index-format.js";
import type { StagingEntry } from "./types.js";

/** An index holds a required extension we cannot write back (`link`, `sdir`, ...). */
export class UnsupportedIndexExtensionError extends Error {
  override name = "UnsupportedIndexExtensionError";
  constructor(readonly signature: string) {
    super(
      `index has the required extension '${signature}', which this implementation does not ` +
        `support; refusing to rewrite it (for a split index run 'git update-index --no-split-index')`,
    );
  }
}

/** Extensions derived from the entries, valid only while the entries stay the same. */
const ENTRY_DERIVED = new Set(["TREE", "UNTR", "FSMN"]);

/** Whether a signature names a required extension (first character not uppercase A-Z). */
export function isRequiredIndexExtension(signature: string): boolean {
  const c = signature.charCodeAt(0);
  return !(c >= 65 && c <= 90);
}

/**
 * Throw `UnsupportedIndexExtensionError` for the first required extension, if any.
 */
export function assertWritableIndexExtensions(extensions: readonly IndexExtension[]): void {
  for (const ext of extensions) {
    if (isRequiredIndexExtension(ext.signature)) {
      throw new UnsupportedIndexExtensionError(ext.signature);
    }
  }
}

/**
 * A digest of what the entry-derived extensions depend on: each entry's path,
 * stage, mode, object id and intent-to-add flag, in order.
 */
export function indexEntriesDigest(entries: readonly StagingEntry[]): string {
  const hasher = createSha1();
  const enc = new TextEncoder();
  for (const e of entries) {
    hasher.update(
      enc.encode(`${e.path}\0${e.stage} ${e.mode} ${e.objectId} ${e.intentToAdd ? 1 : 0}\n`),
    );
  }
  return bytesToHex(hasher.digest());
}

/**
 * The extensions to write with `entries`, from those read with the index.
 *
 * @param extensions The extensions as read (`ParsedIndex.extensionData`)
 * @param _entries The entries about to be written (unused; kept for the signature)
 * @param entriesChanged Whether `entries` differ from the entries read (see `indexEntriesDigest`)
 * @throws UnsupportedIndexExtensionError when a required extension was read
 */
export function carryIndexExtensions(
  extensions: readonly IndexExtension[],
  _entries: readonly StagingEntry[],
  entriesChanged: boolean,
): IndexExtension[] {
  assertWritableIndexExtensions(extensions);
  const out: IndexExtension[] = [];
  for (const ext of extensions) {
    if (ENTRY_DERIVED.has(ext.signature)) {
      if (!entriesChanged) out.push(ext);
    } else if (ext.signature === "REUC") {
      if (isValidResolveUndo(ext.data)) out.push(ext);
    }
    // EOIE, IEOT and unknown optional extensions are dropped
  }
  return out;
}

/** Whether a `REUC` payload parses; a corrupt one is dropped rather than failing the write. */
function isValidResolveUndo(data: Uint8Array): boolean {
  try {
    parseResolveUndo(data);
    return true;
  } catch {
    return false;
  }
}

/** One resolve-undo record: a path and its stage 1-3 modes and ids before resolution (0 / undefined: absent). */
export interface ResolveUndoRecord {
  path: string;
  modes: [number, number, number];
  objectIds: [string | undefined, string | undefined, string | undefined];
}

/**
 * Parse the payload of a `REUC` extension: per path, the path and three octal
 * modes as NUL-terminated ASCII, then a 20-byte id for each nonzero mode.
 */
export function parseResolveUndo(data: Uint8Array): ResolveUndoRecord[] {
  const dec = new TextDecoder();
  const records: ResolveUndoRecord[] = [];
  let at = 0;
  const field = (): string => {
    const nul = data.indexOf(0, at);
    if (nul < 0) throw new Error("REUC extension: truncated record");
    const s = dec.decode(data.subarray(at, nul));
    at = nul + 1;
    return s;
  };
  while (at < data.length) {
    const path = field();
    const modes = [0, 0, 0].map(() => {
      const m = field();
      if (!/^[0-7]+$/.test(m)) throw new Error(`REUC extension: bad mode ${JSON.stringify(m)}`);
      return Number.parseInt(m, 8);
    }) as [number, number, number];
    const objectIds = modes.map((m) => {
      if (m === 0) return undefined;
      if (at + 20 > data.length) throw new Error("REUC extension: truncated object id");
      const id = bytesToHex(data.subarray(at, at + 20));
      at += 20;
      return id;
    }) as ResolveUndoRecord["objectIds"];
    records.push({ path, modes, objectIds });
  }
  return records;
}

/** Encode resolve-undo records as a `REUC` payload. */
export function encodeResolveUndo(records: readonly ResolveUndoRecord[]): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  for (const r of records) {
    parts.push(enc.encode(`${r.path}\0${r.modes.map((m) => m.toString(8)).join("\0")}\0`));
    r.modes.forEach((m, i) => {
      const id = r.objectIds[i];
      if (m === 0) return;
      if (!id) throw new Error(`REUC record for ${r.path}: missing object id for stage ${i + 1}`);
      parts.push(objectIdToBytes(id));
    });
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
