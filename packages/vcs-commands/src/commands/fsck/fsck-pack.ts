/**
 * Checking one installed pack as git's `verify_pack` (pack-check.c) does for fsck and
 * verify-pack, with git's messages:
 *
 *  - the idx's own SHA-1 (`Packfile index for <pack> hash mismatch`);
 *  - the pack's SHA-1 over everything before its trailer (`<pack> pack checksum mismatch`) and
 *    the trailer against the checksum the idx records (`... pack checksum does not match its
 *    index`), in one streaming pass that also computes each entry's CRC-32;
 *  - then entry by entry in pack order: the CRC-32 the idx records (`index CRC mismatch for
 *    object <id> from <pack> at offset <n>`), the entry unpacked (`cannot unpack <id> from
 *    <pack> at offset <n>`) and re-hashed (`packed <id> from <pack> is corrupt`).
 *
 * Only the idx (git maps it too) and one object at a time are held; delta bases go through the
 * pack's bounded base cache.
 */

import {
  type FilesApi,
  type GitObject,
  ObjectIdMismatchError,
  openPack,
  type PackFile,
  type PackIndex,
  readPackIndex,
} from "@statewalker/vcs-core";
import { CRC32 } from "@statewalker/vcs-utils/hash/crc32";
import { createSha1 } from "@statewalker/vcs-utils/hash/hasher";
import { bytesToHex } from "@statewalker/vcs-utils/hash/utils";

/** One entry of a pack, in pack order. */
export interface PackScanEntry {
  id: string;
  offset: number;
  /** Bytes the entry takes in the pack (to the next entry, or to the trailer). */
  sizeInPack: number;
  /** False when its CRC-32 is not the one the idx records (v2 idx only). */
  crcOk: boolean;
}

/** A pack opened for checking. */
export interface PackScan {
  /** The entries in pack order. */
  entries: PackScanEntry[];
  /** The pack, to read objects and entries from; undefined when it could not be opened. */
  pack?: PackFile;
  /** Whether a check failed (idx or pack checksum). */
  failed: boolean;
}

async function readAll(files: FilesApi, path: string): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let n = 0;
  for await (const c of files.read(path)) {
    parts.push(c);
    n += c.length;
  }
  if (parts.length === 1) return parts[0] as Uint8Array;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * Checks the idx and pack checksums and the entries' CRC-32s, reporting failures through
 * `error` (git's `error()` texts). `externalBase` resolves delta bases outside the pack; `read`
 * is the idx when the caller has read it already.
 */
export async function scanPack(
  files: FilesApi,
  packPath: string,
  idxPath: string,
  error: (message: string) => void,
  externalBase?: (id: string) => Promise<GitObject | undefined>,
  read?: { bytes: Uint8Array; idx: PackIndex },
): Promise<PackScan> {
  let failed = false;
  let idxBytes: Uint8Array;
  let idx: PackIndex;
  try {
    // the idx as the caller read it, or read here: once either way
    idxBytes = read?.bytes ?? (await readAll(files, idxPath));
    idx = read?.idx ?? readPackIndex(idxBytes);
  } catch {
    error(`packfile ${packPath} index not opened`);
    return { entries: [], failed: true };
  }
  // verify_pack_index
  const idxSum = bytesToHex(
    createSha1()
      .update(idxBytes.subarray(0, idxBytes.length - 20))
      .digest(),
  );
  if (idxSum !== bytesToHex(idxBytes.subarray(idxBytes.length - 20))) {
    error(`Packfile index for ${packPath} hash mismatch`);
    failed = true;
  }

  let pack: PackFile | undefined;
  try {
    pack = await openPack(files, packPath, idxPath, {
      idxBytes,
      externalBase: externalBase
        ? async (id) => {
            const obj = await externalBase(id);
            if (!obj) return undefined;
            return { type: obj.type, data: await collect(obj) };
          }
        : undefined,
    });
  } catch {
    error(`packfile ${packPath} cannot be accessed`);
    return { entries: [], failed: true };
  }

  const stats = await files.stats(packPath);
  const packLength = stats?.size ?? 0;
  const trailerAt = packLength - 20;
  const raw: { id: string; offset: number; crc?: number }[] = [];
  for (const e of idx.entries()) raw.push({ id: e.id, offset: e.offset, crc: e.crc32 });
  raw.sort((a, b) => a.offset - b.offset);
  const n = raw.length;
  const crcOk = new Uint8Array(n).fill(1);

  // One pass: the pack's SHA-1 and each entry's CRC-32
  const sha = createSha1();
  const trailer = new Uint8Array(20);
  let pos = 0;
  let k = 0;
  let crc = new CRC32();
  const entryEnd = (i: number) => (i + 1 < n ? (raw[i + 1]?.offset as number) : trailerAt);
  while (k < n && entryEnd(k) <= (raw[k]?.offset as number)) k++;
  for await (const chunk of files.read(packPath)) {
    let at = 0;
    while (at < chunk.length) {
      if (pos >= trailerAt) {
        const take = Math.min(chunk.length - at, packLength - pos);
        trailer.set(chunk.subarray(at, at + take), pos - trailerAt);
        pos += take;
        at += take;
        continue;
      }
      const limit = Math.min(chunk.length - at, trailerAt - pos);
      let take = limit;
      if (k < n) {
        const start = raw[k]?.offset as number;
        if (pos < start) take = Math.min(take, start - pos);
        else take = Math.min(take, entryEnd(k) - pos);
      }
      const part = chunk.subarray(at, at + take);
      sha.update(part);
      if (k < n && pos >= (raw[k]?.offset as number)) {
        crc.update(part);
        if (pos + take === entryEnd(k)) {
          const want = raw[k]?.crc;
          if (want !== undefined && crc.getValue() !== want) crcOk[k] = 0;
          crc = new CRC32();
          k++;
        }
      }
      pos += take;
      at += take;
    }
  }
  if (bytesToHex(sha.digest()) !== bytesToHex(trailer)) {
    error(`${packPath} pack checksum mismatch`);
    failed = true;
  }
  if (bytesToHex(idx.packChecksum) !== bytesToHex(trailer)) {
    error(`${packPath} pack checksum does not match its index`);
    failed = true;
  }

  const entries: PackScanEntry[] = raw.map((e, i) => ({
    id: e.id,
    offset: e.offset,
    sizeInPack: entryEnd(i) - e.offset,
    crcOk: crcOk[i] === 1,
  }));
  return { entries, pack, failed };
}

/** The whole content of an object read from a store. */
export async function collect(obj: GitObject): Promise<Uint8Array> {
  if (obj.bytes) {
    // `content` is single-use: release it unread
    await obj.content[Symbol.asyncIterator]().return?.();
    return obj.bytes;
  }
  const parts: Uint8Array[] = [];
  let n = 0;
  for await (const c of obj.content) {
    parts.push(c);
    n += c.length;
  }
  if (parts.length === 1) return parts[0] as Uint8Array;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** An object unpacked from a pack: its type and content, or what went wrong (git's texts). */
export type UnpackedEntry =
  | { type: string; content: Uint8Array }
  | {
      error: string;
      corrupt: boolean;
      /** The zlib error git prints first (`inflate: data stream error (...)`), if any. */
      zlib?: string;
    };

/**
 * Unpacks and re-hashes one entry. `keep` says whether the content is wanted (trees, commits
 * and tags always are; a blob only when asked, otherwise it is streamed through the hash).
 */
export async function unpackEntry(
  pack: PackFile,
  packPath: string,
  entry: PackScanEntry,
  keepBlob: (id: string) => boolean,
): Promise<UnpackedEntry> {
  try {
    const obj = await pack.get(entry.id, { verify: true });
    if (!obj) return { error: cannotUnpack(entry, packPath), corrupt: false };
    if (obj.type === "blob" && !keepBlob(entry.id)) {
      for await (const _ of obj.content) {
        // hashed as it streams
      }
      return { type: obj.type, content: new Uint8Array(0) };
    }
    const parts: Uint8Array[] = [];
    let n = 0;
    for await (const c of obj.content) {
      parts.push(c);
      n += c.length;
    }
    const content = new Uint8Array(n);
    let o = 0;
    for (const p of parts) {
      content.set(p, o);
      o += p.length;
    }
    return { type: obj.type, content };
  } catch (e) {
    if (e instanceof ObjectIdMismatchError) {
      return { error: `packed ${entry.id} from ${packPath} is corrupt`, corrupt: true };
    }
    const inflate = /: inflate failed: (.*)$/.exec(e instanceof Error ? e.message : "")?.[1];
    return {
      error: cannotUnpack(entry, packPath),
      corrupt: false,
      zlib: inflate ? `inflate: data stream error (${inflate})` : undefined,
    };
  }
}

function cannotUnpack(entry: PackScanEntry, packPath: string): string {
  return `cannot unpack ${entry.id} from ${packPath} at offset ${entry.offset}`;
}
