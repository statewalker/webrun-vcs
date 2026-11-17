/**
 * Paths and tree entry names in TEXT columns.
 *
 * A path that is no UTF-8 holds escaped bytes, lone surrogates (`decodeGitPath`: U+DC00 +
 * byte), and SQL drivers turn those into U+FFFD: the name, and the id of a tree rebuilt from
 * it, would be lost. So a lone surrogate is stored as U+0001 and its four hex digits, and a
 * U+0001 of the path as two of them. Every other character stays as it is, so a UTF-8 path
 * is stored unchanged (rows written before read back the same; migration 9 doubles the rare
 * U+0001 they held in `staging_entry` and `tree_entry`; `tree_delta_entry`, made outside
 * the migrations, is not rewritten, so an old delta row holding a U+0001 reads back
 * differently), a prefix of a
 * path is stored as a prefix of the stored path (`LIKE 'dir/%'` still works), and
 * `ORDER BY` keeps git's byte order for every path without either character.
 *
 * @example
 * ```typescript
 * toSqlPath("caf\udce9.txt"); // "caf\u0001dce9.txt"
 * fromSqlPath("caf\u0001dce9.txt"); // "caf\udce9.txt"
 * toSqlPath("café.txt"); // "café.txt"
 * ```
 *
 * @module
 */

import { hasEscapedBytes } from "@statewalker/vcs-utils/encoding";

const MARK = String.fromCharCode(1);

/** `path` as it is stored in a TEXT column. */
export function toSqlPath(path: string): string {
  if (!path.includes(MARK) && !hasEscapedBytes(path)) return path;
  let out = "";
  for (let i = 0; i < path.length; i++) {
    const c = path.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < path.length) {
      const d = path.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        // a surrogate pair: a character beyond U+FFFF, valid text
        out += path[i] + path[i + 1];
        i++;
        continue;
      }
    }
    if (c === 1) out += MARK + MARK;
    else if (c >= 0xd800 && c <= 0xdfff) out += MARK + c.toString(16);
    else out += path[i];
  }
  return out;
}

/** A path read from a TEXT column (written by {@link toSqlPath}). */
export function fromSqlPath(text: string): string {
  if (!text.includes(MARK)) return text;
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c !== MARK) {
      out += c;
      continue;
    }
    if (text[i + 1] === MARK) {
      out += MARK;
      i++;
      continue;
    }
    const hex = text.slice(i + 1, i + 5);
    if (/^d[89a-f][0-9a-f]{2}$/.test(hex)) {
      out += String.fromCharCode(Number.parseInt(hex, 16));
      i += 4;
    } else out += c; // not written by toSqlPath: kept as it is
  }
  return out;
}
