/**
 * A commit's tree, parents and date as git's `parse_commit_buffer` and `parse_commit_date`
 * read them, without the commit-graph: what the writer stores and `verify` compares against.
 */

import { bytesToHex } from "@statewalker/vcs-utils/hash/utils";

import type { ObjectId } from "../../common/id/index.js";

/** What the commit-graph keeps of a commit. */
export interface GraphCommitData {
  tree: ObjectId;
  parents: ObjectId[];
  /** git's `commit->date` (0 when the committer line does not parse) */
  date: number;
}

/** The commit does not parse as git's parse_commit_buffer requires. */
export class CommitParseError extends Error {
  override name = "CommitParseError";
}

const TREE_ENTRY_LEN = 45; // "tree " + 40 hex
const PARENT_ENTRY_LEN = 47; // "parent " + 40 hex

function hexValue(c: number): number {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 97 && c <= 102) return c - 87;
  if (c >= 65 && c <= 70) return c - 55;
  return -1;
}

/** git's get_oid_hex at `at`: 40 hex digits (either case), lowercase hex id, or undefined. */
function oidAt(data: Uint8Array, at: number): ObjectId | undefined {
  if (at + 40 > data.length) return undefined;
  // the usual case, lowercase digits: the id is those bytes as they are
  let lower = true;
  for (let i = at; i < at + 40; i++) {
    const c = data[i] as number;
    if (!((c >= 48 && c <= 57) || (c >= 97 && c <= 102))) {
      lower = false;
      break;
    }
  }
  if (lower) {
    return String.fromCharCode.apply(
      null,
      data.subarray(at, at + 40) as unknown as number[],
    ) as ObjectId;
  }
  const raw = new Uint8Array(20);
  for (let i = 0; i < 20; i++) {
    const hi = hexValue(data[at + 2 * i] as number);
    const lo = hexValue(data[at + 2 * i + 1] as number);
    if (hi < 0 || lo < 0) return undefined;
    raw[i] = (hi << 4) | lo;
  }
  return bytesToHex(raw);
}

const startsWith = (data: Uint8Array, at: number, text: string) => {
  for (let i = 0; i < text.length; i++) if (data[at + i] !== text.charCodeAt(i)) return false;
  return true;
};

/** git's isspace (sane_ctype GIT_SPACE): space, tab, newline, carriage return. */
const isGitSpace = (c: number) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;

/**
 * git's parse_commit_date: the number after the last `>` of the committer line, which must be
 * the line after an `author` line; 0 when it is not there. A leading `-` wraps around as
 * strtoumax does (the value is then not exact).
 */
export function parseCommitDate(data: Uint8Array, start: number): number {
  const tail = data.length;
  let buf = start;
  if (buf + 6 >= tail) return 0;
  if (!startsWith(data, buf, "author")) return 0;
  while (buf < tail && data[buf++] !== 0x0a) {
    /* to the next line */
  }
  if (buf + 9 >= tail) return 0;
  if (!startsWith(data, buf, "committer")) return 0;
  let eol = data.indexOf(0x0a, buf);
  if (eol < 0) return 0;
  let p = eol;
  while (p > buf && data[p - 1] !== 0x3e) p--;
  if (p === buf) return 0;
  while (p < eol && isGitSpace(data[p] as number)) p++;
  const first = data[p] as number;
  const isDigit = (c: number) => c >= 0x30 && c <= 0x39;
  if (!isDigit(first) && first !== 0x2d) return 0;
  // strtoumax: an optional sign, then digits (the line end stops it at worst)
  let negative = false;
  if (first === 0x2d) {
    negative = true;
    p++;
  }
  eol = tail;
  // up to 15 digits fit a double exactly (every date git writes); longer ones as strtoumax
  let small = 0;
  let n = 0;
  while (p + n < eol && n < 16 && isDigit(data[p + n] as number)) {
    small = small * 10 + ((data[p + n] as number) - 0x30);
    n++;
  }
  if (n === 0) return 0;
  if (n < 16 && !negative) return small;
  let value = 0n;
  while (p < eol && isDigit(data[p] as number)) {
    value = value * 10n + BigInt((data[p] as number) - 0x30);
    p++;
  }
  const max = (1n << 64n) - 1n;
  if (value > max) value = max;
  if (negative && value !== 0n) value = (1n << 64n) - value;
  return Number(value);
}

/**
 * The tree, parents and date of a commit's raw bytes, as git's parse_commit_buffer (without
 * grafts): throws `CommitParseError` with git's message when the header is malformed.
 *
 * @example
 * ```typescript
 * const { tree, parents, date } = parseGraphCommit(bytes, id);
 * ```
 */
export function parseGraphCommit(data: Uint8Array, id = ""): GraphCommitData {
  const tail = data.length;
  let p = 0;
  if (tail <= p + TREE_ENTRY_LEN + 1 || !startsWith(data, p, "tree ")) {
    throw new CommitParseError(`bogus commit object ${id}`);
  }
  if (data[p + TREE_ENTRY_LEN] !== 0x0a) throw new CommitParseError(`bogus commit object ${id}`);
  const tree = oidAt(data, p + 5);
  if (!tree) throw new CommitParseError(`bad tree pointer in commit ${id}`);
  p += TREE_ENTRY_LEN + 1;
  const parents: ObjectId[] = [];
  while (p + PARENT_ENTRY_LEN < tail && startsWith(data, p, "parent ")) {
    const parent = tail <= p + PARENT_ENTRY_LEN + 1 ? undefined : oidAt(data, p + 7);
    if (!parent || data[p + PARENT_ENTRY_LEN] !== 0x0a) {
      throw new CommitParseError(`bad parents in commit ${id}`);
    }
    parents.push(parent);
    p += PARENT_ENTRY_LEN + 1;
  }
  return { tree, parents, date: parseCommitDate(data, p) };
}
