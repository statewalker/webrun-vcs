import type { LfsLockPage, LfsLockQuery, LfsStoredLock } from "./types.js";

/**
 * A lock path as the server keys it: relative to the repository root, `/`
 * between segments, no empty or `.` segments (`./a//b/` is `a/b`). `undefined`
 * for a path that is empty, has a `..` segment, or a NUL or other control
 * character: no file in a repository has such a path. Backslashes are kept
 * as they are (a valid file name character on POSIX); git-lfs sends `/`.
 *
 * @example
 * ```typescript
 * normalizeLockPath("./assets//logo.psd"); // "assets/logo.psd"
 * normalizeLockPath("../etc/passwd"); // undefined
 * ```
 */
export function normalizeLockPath(path: unknown): string | undefined {
  if (typeof path !== "string") return undefined;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
  if (/[\u0000-\u001f\u007f]/.test(path)) return undefined;
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") return undefined;
    parts.push(part);
  }
  return parts.length > 0 ? parts.join("/") : undefined;
}

const encoder = new TextEncoder();

function hex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/**
 * A lock's sort key as a cursor: the UTF-8 bytes of `path\0ref\0id` in hex,
 * so comparing cursors as strings compares the keys bytewise (paths sort as
 * git sorts them). Opaque to clients.
 */
export function lockCursor(lock: LfsStoredLock): string {
  return hex(encoder.encode(`${lock.path}\0${lock.ref ?? ""}\0${lock.id}`));
}

/**
 * One page of `all` as `query` selects it, in cursor order: what
 * `createMemoryLockStore` and `createFilesLockStore` answer `list` with.
 */
export function pageLocks(all: Iterable<LfsStoredLock>, query: LfsLockQuery): LfsLockPage {
  const selected: { cursor: string; lock: LfsStoredLock }[] = [];
  for (const lock of all) {
    if (query.path !== undefined && lock.path !== query.path) continue;
    if (query.id !== undefined && lock.id !== query.id) continue;
    if (query.ref !== undefined && lock.ref !== query.ref) continue;
    const cursor = lockCursor(lock);
    if (query.cursor !== undefined && cursor <= query.cursor) continue;
    selected.push({ cursor, lock });
  }
  selected.sort((a, b) => (a.cursor < b.cursor ? -1 : a.cursor > b.cursor ? 1 : 0));
  const limit = Math.max(1, Math.floor(query.limit));
  const page = selected.slice(0, limit);
  const last = page[page.length - 1];
  return {
    locks: page.map((s) => s.lock),
    ...(selected.length > limit && last ? { nextCursor: last.cursor } : {}),
  };
}

/** A fresh random lock id (hex). */
export function randomLockId(bytes = 16): string {
  return hex(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** SHA-256 (hex) of a lock's identity, `ref\0path`: the files store's file name. */
export async function lockKeyHash(path: string, ref: string | undefined): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`${ref ?? ""}\0${path}`));
  return hex(new Uint8Array(digest));
}
