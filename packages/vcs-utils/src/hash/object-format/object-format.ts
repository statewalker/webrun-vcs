/**
 * Git's object formats (hash.h `struct git_hash_algo`): the hash a repository names its
 * objects with, chosen when it is created (`git init --object-format`) and recorded in its
 * config (`extensions.objectFormat`, with `core.repositoryformatversion = 1`). Everything that
 * computes, parses, prints or sizes an object id asks the repository's format: the raw and
 * hex lengths, the null id, the empty tree and blob, the hasher.
 */
import { createSha1, createSha256, type Hasher } from "../hasher/index.js";
import { sha1 } from "../sha1/index.js";
import { sha256 } from "../sha256/index.js";

/** The names git knows (`hash_algos[].name`). */
export type ObjectFormatName = "sha1" | "sha256";

/** One object format: git's `struct git_hash_algo`. */
export interface ObjectFormat {
  /** `sha1` or `sha256`, as `extensions.objectFormat` and `--object-format` spell it */
  readonly name: ObjectFormatName;
  /** git's `format_id` as reftables and the v2 index/pack formats store it (`sha1`, `s256`) */
  readonly formatId: number;
  /** git's `hash_algo_by_ptr`: 1 for SHA-1, 2 for SHA-256 (commit-graph and midx headers) */
  readonly version: 1 | 2;
  /** Bytes of a raw id (git's `rawsz`) */
  readonly rawLength: 20 | 32;
  /** Characters of a hex id (git's `hexsz`) */
  readonly hexLength: 40 | 64;
  /** The id of no object: all zeros (`null_oid`) */
  readonly nullId: string;
  /** The empty tree's id (`empty_tree`) */
  readonly emptyTreeId: string;
  /** The empty blob's id (`empty_blob`) */
  readonly emptyBlobId: string;
  /** The commit header carrying this format's signature (`gpg_sig_headers`) */
  readonly signatureHeader: "gpgsig" | "gpgsig-sha256";
  /** A fresh incremental hasher (streams: hashed chunk by chunk) */
  createHasher(): Hasher;
  /** One-shot digest of a buffer: Web Crypto where the runtime has it */
  digest(data: Uint8Array): Promise<Uint8Array>;
}

/** SHA-1, git's default object format (before git 3.0). */
export const SHA1_OBJECT_FORMAT: ObjectFormat = Object.freeze({
  name: "sha1",
  formatId: 0x73686131,
  version: 1,
  rawLength: 20,
  hexLength: 40,
  nullId: "0".repeat(40),
  emptyTreeId: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
  emptyBlobId: "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391",
  signatureHeader: "gpgsig",
  createHasher: createSha1,
  digest: sha1,
});

/** SHA-256 (`git init --object-format=sha256`, git 3.0's default). */
export const SHA256_OBJECT_FORMAT: ObjectFormat = Object.freeze({
  name: "sha256",
  formatId: 0x73323536,
  version: 2,
  rawLength: 32,
  hexLength: 64,
  nullId: "0".repeat(64),
  emptyTreeId: "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321",
  emptyBlobId: "473a0f4c3be8a93681a267e3b1e9a7dcda1185436fe141f7749120a303721813",
  signatureHeader: "gpgsig-sha256",
  createHasher: createSha256,
  digest: sha256,
});

/** The formats by name, as `hash_algo_by_name` finds them. */
export const OBJECT_FORMATS: readonly ObjectFormat[] = [SHA1_OBJECT_FORMAT, SHA256_OBJECT_FORMAT];

/**
 * The format named exactly `name` (git's `hash_algo_by_name`: `sha1`, `sha256`), or
 * undefined for a name git does not know.
 *
 * @example
 * ```typescript
 * objectFormatByName("sha256")?.hexLength; // 64
 * ```
 */
export function objectFormatByName(name: string | undefined): ObjectFormat | undefined {
  if (name === undefined) return undefined;
  return OBJECT_FORMATS.find((f) => f.name === name);
}

/** The format whose hex ids are `hexLength` characters long (40 or 64), else undefined. */
export function objectFormatByHexLength(hexLength: number): ObjectFormat | undefined {
  return hexLength === 40
    ? SHA1_OBJECT_FORMAT
    : hexLength === 64
      ? SHA256_OBJECT_FORMAT
      : undefined;
}

/** The format whose raw ids are `rawLength` bytes long (20 or 32), else undefined. */
export function objectFormatByRawLength(rawLength: number): ObjectFormat | undefined {
  return rawLength === 20
    ? SHA1_OBJECT_FORMAT
    : rawLength === 32
      ? SHA256_OBJECT_FORMAT
      : undefined;
}

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Whether `id` is a full lowercase hex object id: of `format` when given, else of either
 * format (40 or 64 hex digits).
 *
 * @example
 * ```typescript
 * isHexObjectId("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"); // true
 * isHexObjectId("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391", SHA256_OBJECT_FORMAT); // false
 * ```
 */
export function isHexObjectId(id: unknown, format?: ObjectFormat): id is string {
  if (typeof id !== "string") return false;
  if (format) return format.hexLength === 40 ? HEX40.test(id) : HEX64.test(id);
  return id.length === 40 ? HEX40.test(id) : id.length === 64 && HEX64.test(id);
}

/** Whether `id` is a null id (all zeros) of either format. */
export function isNullObjectId(id: string | undefined): boolean {
  return id !== undefined && (id.length === 40 || id.length === 64) && /^0+$/.test(id);
}

/**
 * The null id of the format `like` is an id of (40 or 64 zeros), SHA-1's when `like` is
 * undefined or neither length.
 */
export function nullObjectIdLike(like?: string): string {
  return like?.length === 64 ? SHA256_OBJECT_FORMAT.nullId : SHA1_OBJECT_FORMAT.nullId;
}

/**
 * A repository format git knows but webrun-vcs does not implement yet for this object format
 * (a SHA-256 repository's pack files, index, commit-graph, transport): refused with a clear
 * message instead of reading 32-byte ids as 20-byte ones.
 */
export class UnsupportedObjectFormatError extends Error {
  constructor(
    /** What cannot be read or written (`"pack files"`, `"the index file"`) */
    readonly feature: string,
    /** The repository's format */
    readonly format: ObjectFormatName,
  ) {
    super(`webrun-vcs does not support ${feature} in ${format} repositories yet`);
    this.name = "UnsupportedObjectFormatError";
  }
}

/**
 * Throws `UnsupportedObjectFormatError` unless `format` is SHA-1 (or undefined): for code that
 * reads or writes 20-byte ids (packs, idx, index file, commit-graph) and has no SHA-256 path yet.
 */
export function assertSha1ObjectFormat(format: ObjectFormat | undefined, feature: string): void {
  if (format && format.name !== "sha1")
    throw new UnsupportedObjectFormatError(feature, format.name);
}
