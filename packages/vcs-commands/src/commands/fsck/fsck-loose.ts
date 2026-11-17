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
 * The object is read whole, one at a time (git maps the file and inflates it whole too, except
 * blobs above core.bigFileThreshold).
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
const enc = new TextEncoder();
const dec = new TextDecoder();

/** A loose object as fsck read it. */
export interface LooseRead {
  /** Messages git prints with `error()`, in order (without the `error: ` prefix). */
  errors: string[];
  /** The type and content, when the object could be read and hashes to its name. */
  object?: { type: string; content: Uint8Array };
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

/** Reads the loose object `id` stored at `path`, as `read_loose_object` does. */
export async function readLooseObject(
  files: FilesApi,
  path: string,
  id: string,
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

  // unpack_loose_rest
  let content: Uint8Array;
  try {
    const r = inflateWhole(data, { size: headerLength + size });
    if (r.consumed < data.length) {
      errors.push(`garbage at end of loose object '${id}'`);
      errors.push(`unable to unpack contents of ${path}`);
      return { errors };
    }
    // a stream that ends early leaves the rest of git's buffer zeroed
    content = r.data.subarray(headerLength, headerLength + size);
  } catch (e) {
    const zlib = zlibErrorMessage(e);
    if (zlib) errors.push(zlib);
    errors.push(`corrupt loose object '${id}'`);
    errors.push(`unable to unpack contents of ${path}`);
    return { errors };
  }

  const realId = bytesToHex(
    createSha1()
      .update(enc.encode(`${type} ${size}\0`))
      .update(content)
      .digest(),
  );
  if (realId !== id) return { errors, realId };
  return { errors, object: { type, content } };
}
