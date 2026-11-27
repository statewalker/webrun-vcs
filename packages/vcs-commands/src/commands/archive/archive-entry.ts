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
  /** The content (a symbolic link: its target); empty for directories and streamed blobs */
  content: Uint8Array;
  /**
   * The blob is streamed (git's `size > core.bigFileThreshold` with no export-subst): it is
   * written unconverted, and zip writes it with a data descriptor
   */
  streamed?: boolean;
  /**
   * A streamed blob's bytes as they are read (git's `open_istream`), {@link size} of them in
   * all; without it a streamed entry's bytes are {@link content}
   */
  stream?: AsyncIterable<Uint8Array>;
  /** The size of {@link stream} (the blob's size, as `oid_object_info` gives it) */
  size?: number;
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
  /** Where the bytes go as they are written; without it {@link ArchiveWriter.finish} returns them */
  output?: ArchiveOutput;
}

/**
 * Where a writer sends its bytes as it writes them (git's `write_or_die(1, ...)`): a
 * returned promise holds the writer back until it settles. Each chunk is the writer's no
 * longer (it may be kept).
 */
export type ArchiveOutput = (chunk: Uint8Array) => void | Promise<void>;

/**
 * Writes an archive one entry at a time (`write_archive_entries`' callback). Given an
 * {@link ArchiveOutput} the bytes leave in chunks of about {@link OUTPUT_CHUNK} as they are
 * written, and a streamed entry is never held whole; without one they are kept and
 * {@link finish} returns them.
 */
export interface ArchiveWriter {
  /** Writes an entry; a string is git's `error:` message for an entry it refuses */
  entry(entry: ArchiveEntry): Promise<string | undefined>;
  /** The archive's bytes (the trailer written); empty when they went to an output */
  finish(): Promise<Uint8Array>;
}

/** The size of the chunks a writer sends to its output. */
export const OUTPUT_CHUNK = 64 * 1024;

/**
 * The bytes a writer has written: kept whole, or sent to an {@link ArchiveOutput} in chunks
 * of about {@link OUTPUT_CHUNK}.
 */
export class ArchiveSink {
  readonly buffer: ByteBuffer;
  /** The bytes sent to the output so far */
  private sent = 0;

  constructor(
    private readonly output: ArchiveOutput | undefined,
    capacity = 16384,
  ) {
    this.buffer = new ByteBuffer(output ? OUTPUT_CHUNK * 2 : capacity);
  }

  /** The archive's length so far (sent and held). */
  get position(): number {
    return this.sent + this.buffer.length;
  }

  /** Sends what is held once it reaches a chunk (`force`: whatever is held). */
  async flush(force = false): Promise<void> {
    if (!this.output || this.buffer.length === 0) return;
    if (!force && this.buffer.length < OUTPUT_CHUNK) return;
    const chunk = this.buffer.bytes().slice();
    this.sent += chunk.length;
    this.buffer.clear();
    await this.output(chunk);
  }

  /** Writes a large piece (a streamed blob's chunk), sent as it is when there is an output. */
  async write(bytes: Uint8Array): Promise<void> {
    if (!this.output) {
      this.buffer.push(bytes);
      return;
    }
    if (this.buffer.length + bytes.length < OUTPUT_CHUNK) {
      this.buffer.push(bytes);
      return;
    }
    await this.flush(true);
    this.sent += bytes.length;
    await this.output(bytes.slice());
  }

  /** The bytes held whole (no output), or empty once everything was sent. */
  async finish(): Promise<Uint8Array> {
    if (!this.output) return this.buffer.bytes();
    await this.flush(true);
    return new Uint8Array(0);
  }
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

  /** Forgets the bytes written (the capacity kept). */
  clear(): void {
    this.length = 0;
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
