/**
 * What `git fast-export` and `git fast-import` share: the stream is bytes, handled here as
 * binary strings (one character per byte), signature modes, and the marks files' host.
 */

import type { GitObjects, ObjectId } from "@statewalker/vcs-core";
import { type FilesApi, tryReadFile } from "@statewalker/vcs-utils/files";

/**
 * How signed tags and commits are handled (gpg-interface.c's `parse_sign_mode`): `warn` is
 * `warn-verbatim`, `ignore` is `verbatim`.
 */
export type SignMode =
  | "abort"
  | "verbatim"
  | "ignore"
  | "warn-verbatim"
  | "warn"
  | "warn-strip"
  | "strip";

const SIGN_MODES = new Set<string>([
  "abort",
  "verbatim",
  "ignore",
  "warn-verbatim",
  "warn",
  "warn-strip",
  "strip",
]);

/** Whether `mode` names a {@link SignMode}. */
export function isSignMode(mode: string): mode is SignMode {
  return SIGN_MODES.has(mode);
}

/**
 * Where marks files live (`--import-marks`, `--export-marks`, fast-import's `feature
 * import-marks=`): git opens them relative to its current directory, or below
 * `<git dir>/info/fast-import/` under `relative-marks` (`relative` set).
 */
export interface FastMarksFiles {
  /** The file's bytes, or undefined when it does not exist */
  read(path: string, options?: { relative?: boolean }): Promise<Uint8Array | undefined>;
  /** Writes the file (its leading directories created) */
  write(path: string, bytes: Uint8Array, options?: { relative?: boolean }): Promise<void>;
}

/** Bytes as a binary string, one character per byte. */
export function latin1(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[]);
  }
  return out;
}

/** A binary string's bytes (characters above 0xff are not expected). */
export function latin1Bytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/** An object's type and content, undefined when it cannot be read. */
export async function readObjectBytes(
  objects: GitObjects,
  id: ObjectId,
): Promise<{ type: string; bytes: Uint8Array } | undefined> {
  const object = await objects.get(id).catch(() => undefined);
  if (!object) return undefined;
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of object.content) {
    chunks.push(chunk);
    length += chunk.length;
  }
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }
  return { type: object.type, bytes };
}

const SIGNATURE_STARTS: [string, string][] = [
  ["-----BEGIN PGP SIGNATURE-----", "openpgp"],
  ["-----BEGIN PGP MESSAGE-----", "openpgp"],
  ["-----BEGIN SIGNED MESSAGE-----", "x509"],
  ["-----BEGIN SSH SIGNATURE-----", "ssh"],
];

/** gpg-interface.c's get_signature_format: the format a signature's first line names. */
export function signatureFormatOf(signature: string): string {
  for (const [start, format] of SIGNATURE_STARTS) if (signature.startsWith(start)) return format;
  return "unknown";
}

/**
 * Where a tag message's signature starts (its length when it has none): 2.5x's
 * `parse_signed_buffer` (the last line opening any known format), 2.43's search for the
 * first `\n-----BEGIN PGP SIGNATURE-----\n`.
 */
export function signatureStartOf(message: string, compatibility: "2.43" | "2.56"): number {
  if (compatibility === "2.43") {
    const at = message.indexOf("\n-----BEGIN PGP SIGNATURE-----\n");
    return at < 0 ? message.length : at + 1;
  }
  let match = message.length;
  let len = 0;
  while (len < message.length) {
    if (SIGNATURE_STARTS.some(([start]) => message.startsWith(start, len))) match = len;
    const eol = message.indexOf("\n", len);
    len = eol < 0 ? message.length : eol + 1;
  }
  return match;
}

/**
 * Marks files over a FilesApi: paths relative to `cwd` (git's current directory, default the
 * FilesApi's root), `relative-marks` ones below `<gitDir>/info/fast-import/`.
 *
 * @example
 * ```typescript
 * git.fastImport().setMarksFiles(marksFilesOf(files, { gitDir: ".git" })).setExportMarks("marks");
 * ```
 */
export function marksFilesOf(
  files: FilesApi,
  options: { cwd?: string; gitDir?: string } = {},
): FastMarksFiles {
  const join = (dir: string | undefined, path: string) =>
    path.startsWith("/") || !dir ? path : `${dir.replace(/\/+$/, "")}/${path}`;
  const resolve = (path: string, relative?: boolean) =>
    relative ? join(`${options.gitDir ?? ".git"}/info/fast-import`, path) : join(options.cwd, path);
  return {
    read: async (path, opts) => {
      const full = resolve(path, opts?.relative);
      // a missing file must read as absent (an in-memory FilesApi reads it as empty)
      if ((await files.stats(full))?.kind !== "file") return undefined;
      return tryReadFile(files, full);
    },
    write: async (path, bytes, opts) => {
      await files.write(resolve(path, opts?.relative), [bytes]);
    },
  };
}

/** A ByteSink writing into a Web Stream (the writer is released when the run ends). */
export function writableSink(stream: WritableStream<Uint8Array>): {
  sink: (chunk: Uint8Array) => Promise<void>;
  release: () => void;
} {
  const writer = stream.getWriter();
  return {
    sink: async (chunk) => {
      await writer.write(chunk);
    },
    release: () => writer.releaseLock(),
  };
}

/** A Web Stream's bytes, whole. */
export async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    length += value.length;
  }
  const out = new Uint8Array(length);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
