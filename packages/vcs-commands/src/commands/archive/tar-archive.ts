/**
 * git's tar writer (archive-tar.c): ustar headers with a pax global header carrying the
 * commit id (`comment`), pax extended headers for paths and link targets that do not fit,
 * records of 512 bytes written in blocks of 20 records, and the trailer that ends the
 * archive with at least two zero records and fills its last block.
 */
import {
  type ArchiveEntry,
  type ArchiveSettings,
  ArchiveSink,
  type ArchiveWriter,
  asciiBytes,
  ByteBuffer,
  isDirMode,
  isGitlinkMode,
  isLinkMode,
  isRegMode,
} from "./archive-entry.js";

const RECORDSIZE = 512;
const BLOCKSIZE = RECORDSIZE * 20;
/** The largest size and mtime a ustar header holds (11 octal digits). */
const USTAR_MAX = 0o77777777777;

const TYPEFLAG_REG = 0x30; // '0'
const TYPEFLAG_LNK = 0x32; // '2'
const TYPEFLAG_DIR = 0x35; // '5'
const TYPEFLAG_GLOBAL_HEADER = 0x67; // 'g'
const TYPEFLAG_EXT_HEADER = 0x78; // 'x'

/** Field offsets and sizes of `struct ustar_header`. */
const NAME = 0;
const NAME_SIZE = 100;
const MODE = 100;
const UID = 108;
const GID = 116;
const SIZE = 124;
const MTIME = 136;
const CHKSUM = 148;
const TYPEFLAG = 156;
const LINKNAME = 157;
const LINKNAME_SIZE = 100;
const MAGIC = 257;
const VERSION = 263;
const UNAME = 265;
const GNAME = 297;
const DEVMAJOR = 329;
const DEVMINOR = 337;
const PREFIX = 345;
const PREFIX_SIZE = 155;

/** Options of {@link TarArchiveWriter}. */
export interface TarArchiveOptions extends ArchiveSettings {
  /** `tar.umask` (default 002) */
  umask?: number;
}

/** `xsnprintf(field, size, "%0<size-1>o", value)`: octal digits and a NUL. */
function octal(header: Uint8Array, at: number, size: number, value: number): void {
  const digits = value.toString(8).padStart(size - 1, "0");
  // xsnprintf would BUG on overflow; the callers keep the values in range
  header.set(asciiBytes(digits.slice(-(size - 1))), at);
  header[at + size - 1] = 0;
}

/** `strbuf_append_ext_header`: one pax record, `"%u %s=%s\n"`. */
function extRecord(out: ByteBuffer, keyword: string, value: Uint8Array): void {
  let len = 1 + 1 + keyword.length + 1 + value.length + 1;
  for (let tmp = 1; Math.floor(len / 10) >= tmp; tmp *= 10) len++;
  out.push(asciiBytes(`${len} ${keyword}=`));
  out.push(value);
  out.push(asciiBytes("\n"));
}

/** `get_path_prefix`: where a long path is split between the prefix and name fields. */
function pathPrefix(path: Uint8Array, maxlen: number): number {
  let i = path.length;
  if (i > 1 && path[i - 1] === 0x2f) i--;
  if (i > maxlen) i = maxlen;
  do {
    i--;
  } while (i > 0 && path[i] !== 0x2f);
  return i;
}

/** Writes git's tar archive (`git archive --format=tar`). */
export class TarArchiveWriter implements ArchiveWriter {
  private readonly sink: ArchiveSink;
  private readonly out: ByteBuffer;
  private readonly umask: number;
  private time: number;

  constructor(private readonly settings: TarArchiveOptions) {
    this.sink = new ArchiveSink(settings.output, BLOCKSIZE);
    this.out = this.sink.buffer;
    this.umask = settings.umask ?? 0o002;
    this.time = settings.time;
    this.writeGlobalExtendedHeader();
  }

  /** `write_blocked`: data padded to a whole record. */
  private writeBlocked(data: Uint8Array): void {
    this.out.push(data);
    const tail = data.length % RECORDSIZE;
    if (tail) this.out.zeros(RECORDSIZE - tail);
  }

  /** `stream_blocked`: a streamed blob's bytes, padded to a whole record; false when short. */
  private async streamBlocked(stream: AsyncIterable<Uint8Array>, size: number): Promise<boolean> {
    let total = 0;
    try {
      for await (const chunk of stream) {
        if (total + chunk.length > size) return false;
        total += chunk.length;
        await this.sink.write(chunk);
      }
    } catch {
      return false;
    }
    if (total !== size) return false;
    const tail = size % RECORDSIZE;
    if (tail) this.out.zeros(RECORDSIZE - tail);
    return true;
  }

  /** `prepare_header`: the numeric fields, owner, magic and checksum. */
  private prepareHeader(header: Uint8Array, mode: number, size: number): void {
    octal(header, MODE, 8, mode & 0o7777);
    octal(header, SIZE, 12, isRegMode(mode) ? size : 0);
    octal(header, MTIME, 12, this.time);
    octal(header, UID, 8, 0);
    octal(header, GID, 8, 0);
    header.set(asciiBytes("root"), UNAME);
    header.set(asciiBytes("root"), GNAME);
    octal(header, DEVMAJOR, 8, 0);
    octal(header, DEVMINOR, 8, 0);
    header.set(asciiBytes("ustar\0"), MAGIC);
    header.set(asciiBytes("00"), VERSION);
    // ustar_header_chksum: the checksum field counts as spaces
    let sum = 8 * 0x20;
    for (let i = 0; i < RECORDSIZE; i++) {
      if (i < CHKSUM || i >= CHKSUM + 8) sum += header[i] as number;
    }
    octal(header, CHKSUM, 8, sum);
  }

  private writeGlobalExtendedHeader(): void {
    const ext = new ByteBuffer(256);
    if (this.settings.commitId) extRecord(ext, "comment", asciiBytes(this.settings.commitId));
    if (this.time > USTAR_MAX) {
      extRecord(ext, "mtime", asciiBytes(String(this.time)));
      this.time = USTAR_MAX;
    }
    if (!ext.length) return;
    const header = new Uint8Array(RECORDSIZE);
    header[TYPEFLAG] = TYPEFLAG_GLOBAL_HEADER;
    header.set(asciiBytes("pax_global_header"), NAME);
    this.prepareHeader(header, 0o100666, ext.length);
    this.writeBlocked(header);
    this.writeBlocked(ext.bytes());
  }

  private writeExtendedHeader(id: string, ext: Uint8Array): void {
    const header = new Uint8Array(RECORDSIZE);
    header[TYPEFLAG] = TYPEFLAG_EXT_HEADER;
    header.set(asciiBytes(`${id}.paxheader`.slice(0, NAME_SIZE - 1)), NAME);
    this.prepareHeader(header, 0o100666, ext.length);
    this.writeBlocked(header);
    this.writeBlocked(ext);
  }

  /** `write_tar_entry`. */
  async entry(entry: ArchiveEntry): Promise<string | undefined> {
    const { path, id, content } = entry;
    const stream = isRegMode(entry.mode) ? entry.stream : undefined;
    const size = stream ? (entry.size ?? 0) : content.length;
    let mode = entry.mode;
    const header = new Uint8Array(RECORDSIZE);
    const ext = new ByteBuffer(256);
    if (isDirMode(mode) || isGitlinkMode(mode)) {
      header[TYPEFLAG] = TYPEFLAG_DIR;
      mode = (mode | 0o777) & ~this.umask;
    } else if (isLinkMode(mode)) {
      header[TYPEFLAG] = TYPEFLAG_LNK;
      mode |= 0o777;
    } else if (isRegMode(mode)) {
      header[TYPEFLAG] = TYPEFLAG_REG;
      mode = (mode | (mode & 0o100 ? 0o777 : 0o666)) & ~this.umask;
    } else {
      return `unsupported file mode: 0${mode.toString(8)} (SHA1: ${id})`;
    }
    if (path.length > NAME_SIZE) {
      const plen = pathPrefix(path, PREFIX_SIZE);
      const rest = path.length - plen - 1;
      if (plen > 0 && rest <= NAME_SIZE) {
        header.set(path.subarray(0, plen), PREFIX);
        header.set(path.subarray(plen + 1), NAME);
      } else {
        header.set(asciiBytes(`${id}.data`.slice(0, NAME_SIZE - 1)), NAME);
        extRecord(ext, "path", path);
      }
    } else header.set(path, NAME);

    if (isLinkMode(mode)) {
      if (content.length > LINKNAME_SIZE) {
        header.set(asciiBytes(`see ${id}.paxheader`.slice(0, LINKNAME_SIZE - 1)), LINKNAME);
        extRecord(ext, "linkpath", content);
      } else header.set(content, LINKNAME);
    }

    let sizeInHeader = size;
    if (isRegMode(mode) && size > USTAR_MAX) {
      sizeInHeader = 0;
      extRecord(ext, "size", asciiBytes(String(size)));
    }
    this.prepareHeader(header, mode, sizeInHeader);
    if (ext.length > 0) this.writeExtendedHeader(id, ext.bytes());
    this.writeBlocked(header);
    if (stream) {
      if (!(await this.streamBlocked(stream, size))) return `cannot stream blob ${id}`;
    } else if (isRegMode(mode) && content.length > 0) {
      await this.sink.write(content);
      const tail = content.length % RECORDSIZE;
      if (tail) this.out.zeros(RECORDSIZE - tail);
    }
    await this.sink.flush();
    return undefined;
  }

  /** `write_trailer`: the last block filled, another one when fewer than two records remain. */
  async finish(): Promise<Uint8Array> {
    const offset = this.sink.position % BLOCKSIZE;
    const tail = BLOCKSIZE - offset;
    this.out.zeros(tail);
    if (tail < 2 * RECORDSIZE) this.out.zeros(BLOCKSIZE);
    return this.sink.finish();
  }
}
