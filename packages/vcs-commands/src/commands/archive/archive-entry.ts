/**
 * What the archive writers (archive-tar.c, archive-zip.c) are given: one call per entry, in
 * the order `write_archive_entries` makes them, then the end of the archive.
 */

/** An entry of an archive, as archive.c hands it to `write_entry`. */
export interface ArchiveEntry {
  /** The path in the archive as bytes (prefix included; a directory ends in `/`) */
  path: Uint8Array;
  /** git's mode: `0o40000`/`0o40777` (a directory), `0o160000`, `0o120000`, `0o100644`… */
  mode: number;
  /** The object id in hex (an extra file: git's fake id, its number in the first 8 bytes) */
  id: string;
  /** The content (a symbolic link: its target); empty for directories */
  content: Uint8Array;
  /**
   * The blob is streamed (git's `size > core.bigFileThreshold` with no export-subst): it is
   * written unconverted, and zip writes it with a data descriptor
   */
  streamed?: boolean;
  /**
   * zip's `entry_is_binary`: the userdiff driver's `binary` setting for the path (`true`,
   * `false`), undefined to look at the content (a NUL in its first 8000 bytes)
   */
  binary?: boolean;
}

/** What every archive writer is told besides its entries. */
export interface ArchiveSettings {
  /** The entries' modification time in seconds (a commit's committer date, `--mtime`) */
  time: number;
  /** The commit archived (pax `comment`, zip comment), undefined for a tree */
  commitId?: string;
  /** zlib's level (`-0` … `-9`); -1 for zlib's default */
  compressionLevel: number;
}

/** Writes an archive one entry at a time (`write_archive_entries`' callback). */
export interface ArchiveWriter {
  /** Writes an entry; a string is git's `error:` message for an entry it refuses */
  entry(entry: ArchiveEntry): string | undefined;
  /** The archive's bytes (the trailer written) */
  finish(): Uint8Array;
}

/** A growing byte buffer. */
export class ByteBuffer {
  private buf: Uint8Array;
  length = 0;

  constructor(capacity = 16384) {
    this.buf = new Uint8Array(capacity);
  }

  private reserve(n: number): void {
    if (this.length + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.length + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
  }

  push(bytes: Uint8Array): void {
    this.reserve(bytes.length);
    this.buf.set(bytes, this.length);
    this.length += bytes.length;
  }

  zeros(n: number): void {
    this.reserve(n);
    this.buf.fill(0, this.length, this.length + n);
    this.length += n;
  }

  /** The bytes written (a view: copy before writing more). */
  bytes(): Uint8Array {
    return this.buf.subarray(0, this.length);
  }
}

const ascii = new TextEncoder();

/** ASCII text as bytes. */
export function asciiBytes(text: string): Uint8Array {
  return ascii.encode(text);
}

/** git's `S_ISDIR`, `S_ISGITLINK`, `S_ISLNK`, `S_ISREG` on a mode. */
export const isDirMode = (mode: number) => (mode & 0o170000) === 0o040000;
export const isGitlinkMode = (mode: number) => (mode & 0o170000) === 0o160000;
export const isLinkMode = (mode: number) => (mode & 0o170000) === 0o120000;
export const isRegMode = (mode: number) => (mode & 0o170000) === 0o100000;
