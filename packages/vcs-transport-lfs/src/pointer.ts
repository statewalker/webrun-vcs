import type { ByteSource } from "./sha256.js";
import type { LfsPointer, LfsPointerExtension } from "./types.js";
import { hashing } from "./verify.js";

/** The first line of every Git LFS pointer file. */
export const LFS_POINTER_VERSION = "version https://git-lfs.github.com/spec/v1";

/**
 * git-lfs's `blobSizeCutoff`: a pointer is read from at most this many bytes,
 * whatever follows them.
 */
export const LFS_POINTER_MAX_SIZE = 1024;

/** The spec v1 version URL and the old aliases git-lfs still reads. */
const VERSIONS = new Set([
  "https://git-lfs.github.com/spec/v1",
  "https://hawser.github.com/spec/v1",
  "http://git-media.io/v/2",
]);
/** The keys a pointer must carry, in this order. */
const KEYS = ["version", "oid", "size"] as const;
const OID = /^[0-9a-f]{64}$/;
/** git-lfs's extRE, anchored only at the start: the name is the rest of the key. */
const EXT = /^ext-(\d)-\w+/;
/** Go's `unicode.IsSpace`: what `strings.TrimSpace` trims. */
const GO_SPACE = new Set("\t\n\v\f\r \u0085                 　");

const encoder = new TextEncoder();
// the BOM is kept: git-lfs reads it as part of the first key, so it is no pointer
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

function goTrimSpace(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && GO_SPACE.has(s[a] as string)) a++;
  while (b > a && GO_SPACE.has(s[b - 1] as string)) b--;
  return s.slice(a, b);
}

/**
 * The pointer of `content` (its SHA-256 oid and byte size), computed in one
 * streaming pass: what a clean filter needs to replace a large file with its
 * pointer, without holding the file in memory.
 *
 * @example
 * ```typescript
 * const pointer = await createLfsPointer(files.read(["model.bin"]));
 * const text = formatLfsPointer(pointer); // what git stores instead of the file
 * ```
 */
export async function createLfsPointer(content: ByteSource): Promise<LfsPointer> {
  const h = hashing(content);
  for await (const _chunk of h.stream) {
    // hashed and counted on the way through
  }
  return h.pointer();
}

/**
 * The text of the pointer file for `pointer`, as git-lfs encodes it: the
 * version, the extension lines by priority, `oid sha256:<hex>`, `size`, each
 * line ending in a newline. An empty object is its own pointer: the empty
 * string (git-lfs's clean leaves an empty file empty).
 *
 * @example
 * ```typescript
 * formatLfsPointer({ oid, size: 12 }); // "version https://git-lfs.github.com/spec/v1\noid sha256:…\nsize 12\n"
 * formatLfsPointer({ oid: EMPTY_OID, size: 0 }); // ""
 * ```
 */
export function formatLfsPointer(pointer: LfsPointer): string {
  if (pointer.size === 0) return "";
  const extensions = [...(pointer.extensions ?? [])]
    .sort((a, b) => a.priority - b.priority)
    .map((e) => `ext-${e.priority}-${e.name} sha256:${e.oid}\n`)
    .join("");
  return `${LFS_POINTER_VERSION}\n${extensions}oid sha256:${pointer.oid}\nsize ${pointer.size}\n`;
}

/**
 * Reads a pointer file as git-lfs's `DecodeFrom` does; `undefined` when the
 * content is not a pointer (what `git lfs smudge` passes through unchanged).
 *
 * Only the first {@link LFS_POINTER_MAX_SIZE} bytes count. They are trimmed as
 * Go's `TrimSpace` trims (Unicode spaces included; a BOM is not a space), then
 * read line by line, CRLF tolerated and blank lines skipped. Each line is
 * `key value`: `version` (spec v1, or the legacy hawser and git-media URLs),
 * then `oid sha256:<64 lowercase hex>`, then `size <decimal>`, in that order,
 * and nothing after `size`. Extension lines `ext-<digit>-<name> sha256:<hex>`
 * may stand anywhere before `size`; one per priority (a repeated key keeps its
 * last value), returned sorted by priority. The size is read as Go's
 * `ParseInt` reads it (a sign and leading zeros allowed) and must be ≥ 0;
 * sizes above 2^53 are refused here, where git-lfs takes up to 2^63.
 *
 * @example
 * ```typescript
 * parseLfsPointer(`${LFS_POINTER_VERSION}\noid sha256:${oid}\nsize 12\n`); // { oid, size: 12 }
 * parseLfsPointer(`${LFS_POINTER_VERSION}\nsize 12\noid sha256:${oid}\n`); // undefined: out of order
 * ```
 */
export function parseLfsPointer(content: string | Uint8Array): LfsPointer | undefined {
  // the first 1024 BYTES: a string is cut to 1024 characters (at least 1024 bytes) first
  const bytes =
    typeof content === "string" ? encoder.encode(content.slice(0, LFS_POINTER_MAX_SIZE)) : content;
  const text = goTrimSpace(decoder.decode(bytes.subarray(0, LFS_POINTER_MAX_SIZE)));
  if (!text) return undefined;

  const values = new Map<string, string>();
  const extensionKeys = new Map<string, string>(); // key → oid; a repeated key keeps the last
  let next = 0;
  for (let line of text.split("\n")) {
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (!line) continue;
    const space = line.indexOf(" ");
    if (space < 0) return undefined;
    if (next >= KEYS.length) return undefined; // a line after size
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    if (EXT.test(key)) {
      if (!value.startsWith("sha256:") || !OID.test(value.slice(7))) return undefined;
      extensionKeys.set(key, value.slice(7));
      continue;
    }
    if (key !== KEYS[next]) return undefined;
    values.set(key, value);
    next++;
  }

  const version = values.get("version");
  const oid = values.get("oid");
  const sizeText = values.get("size");
  if (version === undefined || !VERSIONS.has(version)) return undefined;
  if (oid === undefined || !oid.startsWith("sha256:") || !OID.test(oid.slice(7))) return undefined;
  if (sizeText === undefined || !/^[+-]?\d+$/.test(sizeText)) return undefined;
  const size = Number(sizeText);
  if (!Number.isSafeInteger(size) || size < 0) return undefined;

  const extensions: LfsPointerExtension[] = [];
  const priorities = new Set<number>();
  for (const [key, extOid] of extensionKeys) {
    const priority = Number(key[4]);
    if (priorities.has(priority)) return undefined; // two extensions with one priority
    priorities.add(priority);
    extensions.push({ priority, name: key.slice(6), oid: extOid });
  }
  extensions.sort((a, b) => a.priority - b.priority);
  // `+0`/`-0` read as 0, as ParseInt reads them
  const pointer: LfsPointer = { oid: oid.slice(7), size: size === 0 ? 0 : size };
  if (extensions.length > 0) pointer.extensions = extensions;
  return pointer;
}
