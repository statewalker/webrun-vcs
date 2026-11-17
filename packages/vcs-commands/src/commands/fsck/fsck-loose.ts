/**
 * Reading one loose object as git's `read_loose_object` does for fsck, with git's messages:
 *
 *  - the header is inflated into a 32-byte buffer first (`unpack_loose_header`): a zlib error
 *    there, or no NUL in those bytes, is `unable to unpack header of <path>`;
 *  - `unable to parse header of <path>` for a header that is not `<type> <size>`;
 *  - then the rest (`unpack_loose_rest`): a zlib error or a stream that does not end exactly at
 *    the declared size is `corrupt loose object '<id>'`, bytes after the stream are
 *    `garbage at end of loose object '<id>'`, both followed by `unable to unpack contents of
 *    <path>`;
 *  - zlib errors themselves are printed first, as git's `git_inflate` prints them
 *    (`inflate: data stream error (incorrect data check)`); a stream cut short is not (zlib's
 *    Z_BUF_ERROR);
 *  - content that hashes to another id than the file's name is `hash-path mismatch`.
 *
 * Blobs above `core.bigFileThreshold` are streamed as git's `check_stream_oid` streams them:
 * hashed as they inflate, never held whole. git does not compare the length read with the
 * declared size there, so a stream that ends early is fine when it hashes to the file's name;
 * otherwise it is `hash mismatch for <path> (expected <id>)`. A zlib error, a cut stream or bytes
 * after it are reported without `unable to unpack contents`. (A stream longer than declared
 * makes git 2.43 and 2.56 loop forever there; it is `corrupt loose object` here.)
 *
 * Other objects are inflated whole, one at a time (git maps the file and inflates it whole
 * too), into one buffer of the declared size, or of what zlib can produce from the file (1032
 * bytes per input byte) when that is less: a hostile header cannot allocate more. git inflates into a buffer of the declared size and hashes all
 * of it, so a stream that ends early hashes as its bytes followed by what the buffer held:
 * zeros for a buffer malloc maps fresh (above glibc's mmap threshold, at most 32 MiB),
 * whatever was reused below. Zeros are hashed here (`hash-path mismatch`), without being
 * allocated, for declared sizes up to 1 GiB (above that git takes as long or dies out of
 * memory; it is `corrupt loose object` here).
 */

import type { FilesApi } from "@statewalker/vcs-core";
import {
  createInflater,
  InflateError,
  InflateOverflowError,
  inflateWhole,
  TruncatedStreamError,
} from "@statewalker/vcs-utils/compression";
import { createSha1 } from "@statewalker/vcs-utils/hash/hasher";
import { bytesToHex } from "@statewalker/vcs-utils/hash/utils";

/** git's MAX_HEADER_LEN */
const MAX_HEADER_LEN = 32;
/** git's default `core.bigFileThreshold` (512 MiB). */
export const DEFAULT_BIG_FILE_THRESHOLD = 512 * 1024 * 1024;
/** The most bytes a deflate stream yields per input byte. */
const MAX_DEFLATE_RATIO = 1032;
/** The largest declared size whose missing tail is hashed as git's zeroed buffer. */
const MAX_ZERO_PADDING = 2 ** 30;
/** Input slice per push when streaming: at most ~1 MiB of output each. */
const STREAM_SLICE = 1024;
const ZEROS = new Uint8Array(64 * 1024);
const enc = new TextEncoder();
const dec = new TextDecoder();

/** A loose object as fsck read it. */
export interface LooseRead {
  /** Messages git prints with `error()`, in order (without the `error: ` prefix). */
  errors: string[];
  /**
   * The type, size and content, when the object could be read and hashes to its name. A blob
   * above `core.bigFileThreshold` is streamed: no content (as git's NULL buffer).
   */
  object?: { type: string; size: number; content?: Uint8Array };
  /** The id the content hashes to, when it was read whole but hashes to another id. */
  realId?: string;
}

/** The message git's `git_inflate` prints for a zlib error, or undefined for a short stream. */
export function zlibErrorMessage(e: unknown): string | undefined {
  if (e instanceof TruncatedStreamError || e instanceof InflateOverflowError) return undefined;
  if (e instanceof InflateError) {
    const message = e.message.replace(/^inflate failed: /, "");
    if (message.includes("preset dictionary")) return "inflate: needs dictionary (no message)";
    return `inflate: data stream error (${message})`;
  }
  return undefined;
}

/** The first MAX_HEADER_LEN bytes a truncated stream inflates to, if they hold the header. */
function inflatedStart(data: Uint8Array): Uint8Array | undefined {
  const inflater = createInflater();
  try {
    const { out } = inflater.push(data);
    const all = new Uint8Array(out.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of out) {
      all.set(c, at);
      at += c.length;
    }
    const start = all.subarray(0, MAX_HEADER_LEN);
    return start.includes(0) ? start : undefined;
  } catch {
    return undefined;
  } finally {
    inflater.abort();
  }
}

async function readFile(files: FilesApi, path: string): Promise<Uint8Array | undefined> {
  const parts: Uint8Array[] = [];
  let n = 0;
  try {
    for await (const c of files.read(path)) {
      parts.push(c);
      n += c.length;
    }
  } catch {
    return undefined;
  }
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Options of `readLooseObject`. */
export interface LooseReadOptions {
  /** `core.bigFileThreshold`: larger blobs are streamed (default 512 MiB). */
  bigFileThreshold?: number;
}

/** Reads the loose object `id` stored at `path`, as `read_loose_object` does. */
export async function readLooseObject(
  files: FilesApi,
  path: string,
  id: string,
  options: LooseReadOptions = {},
): Promise<LooseRead> {
  const errors: string[] = [];
  const data = await readFile(files, path);
  if (!data) {
    errors.push(`unable to mmap ${path}: No such file or directory`);
    return { errors };
  }

  // unpack_loose_header: inflate into MAX_HEADER_LEN bytes
  let head: Uint8Array;
  try {
    const r = inflateWhole(data, { into: new Uint8Array(MAX_HEADER_LEN), partial: true });
    head = r.data.subarray(0, r.length);
  } catch (e) {
    // zlib stops once the 32 bytes are out, even if the stream is cut short after them
    const start = e instanceof TruncatedStreamError ? inflatedStart(data) : undefined;
    if (!start) {
      const zlib = zlibErrorMessage(e);
      if (zlib) errors.push(zlib);
      errors.push(`unable to unpack header of ${path}`);
      return { errors };
    }
    head = start;
  }
  const nul = head.indexOf(0);
  if (nul < 0) {
    errors.push(`unable to unpack header of ${path}`);
    return { errors };
  }

  // parse_loose_header
  const header = dec.decode(head.subarray(0, nul));
  const match = /^(commit|tree|blob|tag) (0|[1-9][0-9]*)$/.exec(header);
  if (!match) {
    errors.push(`unable to parse header of ${path}`);
    return { errors };
  }
  const type = match[1] as string;
  const size = Number(match[2]);
  const headerLength = nul + 1;

  if (type === "blob" && size > (options.bigFileThreshold ?? DEFAULT_BIG_FILE_THRESHOLD)) {
    const streamed = checkStreamOid(data, headerLength, size, path, id);
    if (streamed.length > 0) return { errors: streamed };
    return { errors, object: { type, size } };
  }

  // unpack_loose_rest: into one buffer of the declared size, or of what zlib can produce from
  // the file if that is less (its pages are mapped as the output reaches them, as git's)
  const total = headerLength + size;
  let content: Uint8Array;
  try {
    const r = inflateWhole(data, {
      size: Math.min(total, data.length * MAX_DEFLATE_RATIO + MAX_HEADER_LEN),
    });
    if (r.consumed < data.length) {
      errors.push(`garbage at end of loose object '${id}'`);
      errors.push(`unable to unpack contents of ${path}`);
      return { errors };
    }
    content = r.data.subarray(headerLength, Math.max(headerLength, r.length));
  } catch (e) {
    const zlib = zlibErrorMessage(e);
    if (zlib) errors.push(zlib);
    errors.push(`corrupt loose object '${id}'`);
    errors.push(`unable to unpack contents of ${path}`);
    return { errors };
  }

  // a stream that ends early leaves the rest of git's buffer as malloc gave it: zeros here
  const missing = size - content.length;
  if (missing > 0 && size > MAX_ZERO_PADDING) {
    errors.push(`corrupt loose object '${id}'`);
    errors.push(`unable to unpack contents of ${path}`);
    return { errors };
  }
  const hasher = createSha1()
    .update(enc.encode(`${type} ${size}\0`))
    .update(content);
  for (let left = missing; left > 0; left -= ZEROS.length) {
    hasher.update(left >= ZEROS.length ? ZEROS : ZEROS.subarray(0, left));
  }
  const realId = bytesToHex(hasher.digest());
  if (realId !== id) return { errors, realId };
  if (missing > 0) {
    const padded = new Uint8Array(size);
    padded.set(content);
    content = padded;
  }
  return { errors, object: { type, size, content } };
}

/**
 * git's `check_stream_oid` for a blob above `core.bigFileThreshold`: the errors it prints, none
 * when the stream hashes to `id`. Output is hashed as it inflates, in bounded pieces.
 */
function checkStreamOid(
  data: Uint8Array,
  headerLength: number,
  size: number,
  path: string,
  id: string,
): string[] {
  const hasher = createSha1();
  const inflater = createInflater();
  let produced = 0;
  const limit = headerLength + size;
  let end = -1;
  try {
    for (let at = 0; at < data.length && end < 0; at += STREAM_SLICE) {
      const slice = data.subarray(at, Math.min(data.length, at + STREAM_SLICE));
      const { out, done, consumed } = inflater.push(slice);
      for (const chunk of out) {
        produced += chunk.length;
        // git reads at most the declared size; past it, it loops (corrupt here)
        if (produced > limit) throw new InflateOverflowError();
        hasher.update(chunk);
      }
      if (done) end = at + consumed;
    }
    if (end < 0) throw new TruncatedStreamError();
  } catch (e) {
    inflater.abort();
    const zlib = zlibErrorMessage(e);
    return [...(zlib ? [zlib] : []), `corrupt loose object '${id}'`];
  }
  if (end < data.length) return [`garbage at end of loose object '${id}'`];
  if (bytesToHex(hasher.digest()) !== id) return [`hash mismatch for ${path} (expected ${id})`];
  return [];
}
