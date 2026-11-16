/**
 * The content filter applied around a worktree's raw reads and writes, shared by the
 * worktree implementations and the commands that store worktree files.
 */
import type { ObjectId } from "@statewalker/vcs-core";
import { createSha1 } from "@statewalker/vcs-utils/hash/hasher";
import { computeObjectIdFromStream } from "@statewalker/vcs-utils/pack";
import {
  type ContentAttributesContext,
  type ContentConversionOptions,
  collectChunks,
  type WorktreeContentFilter,
} from "./content-filter.js";
import type { NewHasher } from "./hash-worktree-file.js";
import type { Worktree } from "./worktree.js";

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

/** Whether a file of `mode` is converted (a regular file; never a link or a directory). */
export function isConvertedMode(mode: number | undefined): boolean {
  return mode === undefined || ((mode & S_IFMT) !== S_IFLNK && (mode & S_IFMT) !== 0o040000);
}

/**
 * The blob id of a regular file's content as `filter` cleans it, or undefined when the
 * filter leaves the path as it is (the caller then hashes the file as it streams).
 */
export async function hashCleanedContent(
  filter: WorktreeContentFilter | undefined,
  path: string,
  read: () => AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  newHasher: NewHasher = createSha1,
): Promise<ObjectId | undefined> {
  if (!filter) return undefined;
  const conversion = await filter.checkin(path);
  if (!conversion) return undefined;
  const cleaned = await conversion.apply(await collectChunks(read()));
  return computeObjectIdFromStream("blob", cleaned.length, [cleaned], newHasher);
}

/**
 * The content to write for `path` once `filter` smudged it (as it was when no conversion
 * applies), its attributes read as `context` says (default: the worktree's, then the
 * index's).
 */
export async function smudgeContent(
  filter: WorktreeContentFilter | undefined,
  path: string,
  content: AsyncIterable<Uint8Array> | Iterable<Uint8Array> | Uint8Array,
  mode: number | undefined,
  context?: ContentAttributesContext,
): Promise<AsyncIterable<Uint8Array> | Iterable<Uint8Array> | Uint8Array> {
  if (!filter || !isConvertedMode(mode)) return content;
  const conversion = await filter.checkout(path, context);
  if (!conversion) return content;
  return conversion.apply(await collectChunks(content));
}

/**
 * The content of the regular file at `path` as `worktree`'s content filter cleans it, or
 * undefined when no conversion applies to it (its content goes in as it is).
 */
export async function readConvertedContent(
  worktree: Worktree,
  path: string,
  options: ContentConversionOptions = {},
): Promise<Uint8Array | undefined> {
  const filter = worktree.contentFilter;
  if (!filter) return undefined;
  const conversion = await filter.checkin(path);
  if (!conversion) return undefined;
  return conversion.apply(await collectChunks(worktree.readContent(path)), options);
}

/**
 * The content of the worktree file at `path` as the repository would store it: cleaned by
 * the worktree's content filter (a symbolic link's target as it is).
 *
 * @example
 * ```typescript
 * const bytes = await readCleanContent(worktree, "a.txt"); // CRLF turned to LF under text=auto
 * ```
 */
export async function readCleanContent(
  worktree: Worktree,
  path: string,
  options: ContentConversionOptions = {},
): Promise<Uint8Array> {
  const raw = await collectChunks(worktree.readContent(path));
  const filter = worktree.contentFilter;
  if (!filter) return raw;
  const entry = await worktree.getEntry(path);
  if (entry && !isConvertedMode(entry.mode)) return raw;
  const conversion = await filter.checkin(path);
  return conversion ? conversion.apply(raw, options) : raw;
}
