/**
 * The `ident` attribute as git's `convert.c` does it: `$Id$` is expanded on checkout to
 * `$Id: <blob id> $` and collapsed back on check-in.
 */

const DOLLAR = 0x24;
const LF = 0x0a;
const SPACE = 0x20;
const I = 0x49;
const D = 0x64;
const COLON = 0x3a;

const isId = (b: Uint8Array, at: number) => b[at] === I && b[at + 1] === D;

function indexOfByte(b: Uint8Array, byte: number, from: number, to: number): number {
  for (let i = from; i < to; i++) if (b[i] === byte) return i;
  return -1;
}

/** git's `count_ident`: how many `$Id$` / `$Id: ... $` keywords the content holds. */
export function countIdent(src: Uint8Array): number {
  let cnt = 0;
  let i = 0;
  let size = src.length;
  while (size) {
    const ch = src[i++];
    size--;
    if (ch !== DOLLAR) continue;
    if (size < 3) break;
    if (!isId(src, i)) continue;
    const next = src[i + 2];
    i += 3;
    size -= 3;
    if (next === DOLLAR) cnt++;
    if (next !== COLON) continue;
    while (size) {
      const c = src[i++];
      size--;
      if (c === DOLLAR) {
        cnt++;
        break;
      }
      if (c === LF) break;
    }
  }
  return cnt;
}

/** git's `ident_to_git`: every `$Id: ... $` collapsed to `$Id$` (the same array when none). */
export function identToGit(src: Uint8Array): Uint8Array {
  if (!countIdent(src)) return src;
  const out: number[] = [];
  let pos = 0;
  const len = src.length;
  for (;;) {
    const dollar = indexOfByte(src, DOLLAR, pos, len);
    if (dollar < 0) break;
    for (let k = pos; k <= dollar; k++) out.push(src[k]);
    pos = dollar + 1;
    const rest = len - pos;
    if (rest > 3 && src[pos] === I && src[pos + 1] === D && src[pos + 2] === COLON) {
      const end = indexOfByte(src, DOLLAR, pos + 3, len);
      if (end < 0) break;
      if (indexOfByte(src, LF, pos + 3, end) >= 0) continue; // a line break before the next $
      out.push(I, D, DOLLAR);
      pos = end + 1;
    }
  }
  for (let k = pos; k < len; k++) out.push(src[k]);
  return Uint8Array.from(out);
}

/**
 * git's `ident_to_worktree`: every `$Id$` (and git-style `$Id: ... $`) replaced by
 * `$Id: <blobId> $`, `blobId` being the id of `src` as a blob (the same array when none).
 */
export function identToWorktree(src: Uint8Array, blobId: string): Uint8Array {
  if (!countIdent(src)) return src;
  const out: number[] = [];
  const insert = new TextEncoder().encode(`Id: ${blobId} $`);
  let pos = 0;
  const len = src.length;
  for (;;) {
    const dollar = indexOfByte(src, DOLLAR, pos, len);
    if (dollar < 0) break;
    for (let k = pos; k <= dollar; k++) out.push(src[k]);
    pos = dollar + 1;
    const rest = len - pos;
    if (rest < 3 || !isId(src, pos)) continue;
    if (src[pos + 2] === DOLLAR) {
      pos += 3;
    } else if (src[pos + 2] === COLON) {
      const end = indexOfByte(src, DOLLAR, pos + 3, len);
      if (end < 0) break; // an incomplete keyword, no more $
      if (indexOfByte(src, LF, pos + 3, end) >= 0) continue;
      const spc = indexOfByte(src, SPACE, pos + 4, end);
      // spaces in unexpected places: another system's id, kept
      if (spc >= 0 && spc < end - 1) continue;
      pos = end + 1;
    } else continue;
    for (const b of insert) out.push(b);
  }
  for (let k = pos; k < len; k++) out.push(src[k]);
  return Uint8Array.from(out);
}
