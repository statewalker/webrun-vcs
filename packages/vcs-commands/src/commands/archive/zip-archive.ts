/**
 * git's zip writer (archive-zip.c): a local header with the extended-timestamp extra field
 * per entry, the content deflated (raw deflate) unless storing it is smaller, streamed blobs
 * with a data descriptor, zip64 records past the 32-bit limits, the central directory, and
 * the commit id as the archive's comment.
 */

import { deflateSync } from "@statewalker/vcs-utils/compression";
import { crc32 } from "@statewalker/vcs-utils/hash/crc32";
import { bufferIsBinary } from "../grep/index.js";
import {
  type ArchiveEntry,
  type ArchiveSettings,
  type ArchiveWriter,
  asciiBytes,
  ByteBuffer,
  isDirMode,
  isGitlinkMode,
  isLinkMode,
  isRegMode,
} from "./archive-entry.js";

const ZIP_STREAM = 1 << 3;
const ZIP_UTF8 = 1 << 11;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const _LOCAL_HEADER_SIZE = 30;
const EXTRA_MTIME_SIZE = 9;
const ZIP64_EXTRA_SIZE = 20;
const MAX32 = 0xffffffff;

/** Options of {@link ZipArchiveWriter}. */
export interface ZipArchiveOptions extends ArchiveSettings {
  /**
   * The local time zone's offset east of UTC in minutes at a time in seconds (git's
   * `localtime_r` for the DOS date and time); default the host's
   */
  localTzOffset?: (time: number) => number;
  /** The hex length of object ids (the comment's length), default 40 */
  hexLength?: number;
  /** Receives git's warnings (`path is not valid UTF-8`) */
  onWarning?: (message: string) => void;
}

/** Little-endian fields appended to a buffer. */
class LeWriter {
  constructor(readonly out: ByteBuffer) {}
  private readonly scratch = new DataView(new ArrayBuffer(8));
  u16(n: number): void {
    this.scratch.setUint16(0, n & 0xffff, true);
    this.out.push(new Uint8Array(this.scratch.buffer, 0, 2));
  }
  u32(n: number): void {
    this.scratch.setUint32(0, n >>> 0, true);
    this.out.push(new Uint8Array(this.scratch.buffer, 0, 4));
  }
  u64(n: number): void {
    this.scratch.setBigUint64(0, BigInt(n), true);
    this.out.push(new Uint8Array(this.scratch.buffer, 0, 8));
  }
}

const clamp32 = (n: number) => (n < MAX32 ? n : MAX32);

/** git's `has_only_ascii`. */
function onlyAscii(path: Uint8Array): boolean {
  for (const b of path) if (b >= 0x80) return false;
  return true;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** git's `is_utf8`. */
function isUtf8(path: Uint8Array): boolean {
  try {
    utf8.decode(path);
    return true;
  } catch {
    return false;
  }
}

/** git's `dos_time`: the DOS date and time of `time` in local time. */
export function dosTime(
  time: number,
  localTzOffset: (time: number) => number = (t) => -new Date(t * 1000).getTimezoneOffset(),
): { date: number; time: number } {
  const local = new Date((time + localTzOffset(time) * 60) * 1000);
  const date =
    local.getUTCDate() + (local.getUTCMonth() + 1) * 32 + (local.getUTCFullYear() - 1980) * 512;
  const dos =
    Math.floor(local.getUTCSeconds() / 2) + local.getUTCMinutes() * 32 + local.getUTCHours() * 2048;
  return { date: date & 0xffff, time: dos & 0xffff };
}

/** Writes git's zip archive (`git archive --format=zip`). */
export class ZipArchiveWriter implements ArchiveWriter {
  private readonly out = new ByteBuffer(65536);
  private readonly dir = new ByteBuffer(4096);
  private readonly le = new LeWriter(this.out);
  private readonly dirLe = new LeWriter(this.dir);
  private entries = 0;
  private maxCreatorVersion = 0;
  private readonly dosDate: number;
  private readonly dosTimeOfDay: number;

  constructor(private readonly settings: ZipArchiveOptions) {
    const dos = dosTime(settings.time, settings.localTzOffset);
    this.dosDate = dos.date;
    this.dosTimeOfDay = dos.time;
  }

  /** `write_zip_entry`. */
  entry(entry: ArchiveEntry): string | undefined {
    const { path, mode, id } = entry;
    const offset = this.out.length;
    let flags = 0;
    let crc = 0;
    let isBinary: boolean | undefined;
    let creatorVersion = 0;
    let versionNeeded = 10;
    let method: number;
    let attr2: number;
    let out: Uint8Array | undefined;
    let compressedSize: number;
    const size = entry.content.length;
    const streamed = entry.streamed === true && isRegMode(mode);

    if (!onlyAscii(path)) {
      if (isUtf8(path)) flags |= ZIP_UTF8;
      else this.settings.onWarning?.(`warning: path is not valid UTF-8: ${latin1(path)}`);
    }
    if (path.length > 0xffff) {
      return `path too long (${path.length} chars, SHA1: ${id}): ${latin1(path)}`;
    }
    if (isDirMode(mode) || isGitlinkMode(mode)) {
      method = METHOD_STORE;
      attr2 = 16;
      compressedSize = 0;
    } else if (isRegMode(mode) || isLinkMode(mode)) {
      method = METHOD_STORE;
      attr2 = isLinkMode(mode) ? (mode | 0o777) * 0x10000 : mode & 0o111 ? mode * 0x10000 : 0;
      if (isLinkMode(mode) || mode & 0o111) creatorVersion = 0x0317;
      if (isRegMode(mode) && this.settings.compressionLevel !== 0 && size > 0) {
        method = METHOD_DEFLATE;
      }
      if (streamed) flags |= ZIP_STREAM;
      else {
        crc = crc32(entry.content);
        isBinary = entry.binary ?? bufferIsBinary(entry.content);
        out = entry.content;
      }
      compressedSize = method === METHOD_STORE ? size : 0;
    } else {
      return `unsupported file mode: 0${mode.toString(8)} (SHA1: ${id})`;
    }
    if (creatorVersion > this.maxCreatorVersion) this.maxCreatorVersion = creatorVersion;

    const level = this.settings.compressionLevel;
    if (!streamed && method === METHOD_DEFLATE) {
      const deflated = deflateSync([entry.content], { format: "raw", level });
      if (deflated.length >= size) {
        method = METHOD_STORE;
        compressedSize = size;
      } else {
        out = deflated;
        compressedSize = deflated.length;
      }
    }

    let needZip64 = size > MAX32 || compressedSize > MAX32;
    if (streamed && size > 0x7fffffff) needZip64 = true;
    if (needZip64) versionNeeded = 45;

    // the local header
    const le = this.le;
    le.u32(0x04034b50);
    le.u16(versionNeeded);
    le.u16(flags);
    le.u16(method);
    le.u16(this.dosTimeOfDay);
    le.u16(this.dosDate);
    le.u32(crc);
    if (needZip64) {
      le.u32(MAX32);
      le.u32(MAX32);
    } else {
      le.u32(compressedSize);
      le.u32(size);
    }
    le.u16(path.length);
    le.u16(EXTRA_MTIME_SIZE + (needZip64 ? ZIP64_EXTRA_SIZE : 0));
    this.out.push(path);
    const extra = new ByteBuffer(EXTRA_MTIME_SIZE);
    const extraLe = new LeWriter(extra);
    extraLe.u16(0x5455);
    extraLe.u16(5);
    extra.push(new Uint8Array([1]));
    extraLe.u32(this.settings.time);
    const extraBytes = extra.bytes().slice();
    this.out.push(extraBytes);
    if (needZip64) {
      le.u16(0x0001);
      le.u16(16);
      le.u64(size);
      le.u64(compressedSize);
    }

    if (streamed) {
      crc = crc32(entry.content);
      isBinary = entry.binary ?? bufferIsBinary(entry.content.subarray(0, 16384));
      if (method === METHOD_STORE) {
        this.out.push(entry.content);
        compressedSize = size;
      } else {
        const deflated = deflateSync([entry.content], { format: "raw", level });
        this.out.push(deflated);
        compressedSize = deflated.length;
      }
      // write_zip_data_desc
      le.u32(0x08074b50);
      le.u32(crc);
      if (size >= MAX32 || compressedSize >= MAX32) {
        le.u64(compressedSize);
        le.u64(size);
      } else {
        le.u32(compressedSize);
        le.u32(size);
      }
    } else if (compressedSize > 0 && out) {
      this.out.push(out);
    }

    let zip64DirPayload = 0;
    let dirExtraSize = EXTRA_MTIME_SIZE;
    if (compressedSize > MAX32 || size > MAX32 || offset > MAX32) {
      if (compressedSize >= MAX32) zip64DirPayload += 8;
      if (size >= MAX32) zip64DirPayload += 8;
      if (offset >= MAX32) zip64DirPayload += 8;
      dirExtraSize += 4 + zip64DirPayload;
    }
    const d = this.dirLe;
    d.u32(0x02014b50);
    d.u16(creatorVersion);
    d.u16(versionNeeded);
    d.u16(flags);
    d.u16(method);
    d.u16(this.dosTimeOfDay);
    d.u16(this.dosDate);
    d.u32(crc);
    d.u32(clamp32(compressedSize));
    d.u32(clamp32(size));
    d.u16(path.length);
    d.u16(dirExtraSize);
    d.u16(0); // comment length
    d.u16(0); // disk
    // `!is_binary` (directories: is_binary -1, so 0)
    d.u16(isBinary === undefined ? 0 : isBinary ? 0 : 1);
    d.u32(attr2);
    d.u32(clamp32(offset));
    this.dir.push(path);
    this.dir.push(extraBytes);
    if (zip64DirPayload) {
      d.u16(0x0001);
      d.u16(zip64DirPayload);
      if (size >= MAX32) d.u64(size);
      if (compressedSize >= MAX32) d.u64(compressedSize);
      if (offset >= MAX32) d.u64(offset);
    }
    this.entries++;
    return undefined;
  }

  /** `write_zip_trailer`. */
  finish(): Uint8Array {
    const zipOffset = this.out.length;
    const dirBytes = this.dir.bytes();
    const clamped = this.entries > 0xffff || zipOffset > MAX32;
    this.out.push(dirBytes);
    const le = this.le;
    if (clamped) {
      // write_zip64_trailer
      le.u32(0x06064b50);
      le.u64(44);
      le.u16(this.maxCreatorVersion);
      le.u16(45);
      le.u32(0);
      le.u32(0);
      le.u64(this.entries);
      le.u64(this.entries);
      le.u64(dirBytes.length);
      le.u64(zipOffset);
      le.u32(0x07064b50);
      le.u32(0);
      le.u64(zipOffset + dirBytes.length);
      le.u32(1);
    }
    const commitId = this.settings.commitId;
    le.u32(0x06054b50);
    le.u16(0);
    le.u16(0);
    le.u16(Math.min(this.entries, 0xffff));
    le.u16(Math.min(this.entries, 0xffff));
    le.u32(dirBytes.length);
    le.u32(clamp32(zipOffset));
    le.u16(commitId ? (this.settings.hexLength ?? commitId.length) : 0);
    if (commitId) this.out.push(asciiBytes(commitId));
    return this.out.bytes();
  }
}

/** Bytes as one character each (git prints paths as their bytes). */
function latin1(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}
