/**
 * The applier of `git apply` (apply.c): finds where each hunk applies (offsets, context
 * reduction, whitespace fuzz), applies binary patches, checks the preimage against the
 * worktree and the index, falls back to a three-way merge, and writes the results, the
 * rejects and the index. The storage it works on is behind {@link ApplyIO}.
 */

import { decodeGitBinaryDelta } from "@statewalker/vcs-utils";
import { statSummary } from "../../results/diff-output.js";
import { ApplyParser, linelen } from "./apply-parse.js";
import {
  BINARY_DELTA,
  BINARY_LITERAL,
  type FilePatch,
  isGitlink,
  isLink,
  isRegular,
  newFilePatch,
  S_IFMT,
  S_IFREG,
} from "./apply-types.js";
import { bytesToLatin1, cQuote, latin1ToBytes } from "./latin1.js";
import { isGitSpace, WS_BLANK_AT_EOF, wsBlankLine, wsFixCopy } from "./whitespace.js";

const LINE_COMMON = 1;
const LINE_PATCHED = 2;

interface Line {
  len: number;
  hash: number;
  flag: number;
  /** The line itself (lines of a {@link Target} only) */
  text?: string;
}

interface Image {
  buf: string;
  lines: Line[];
}

function hashLine(s: string, start: number, len: number): number {
  let h = 0;
  for (let i = 0; i < len; i++) {
    const c = s.charCodeAt(start + i);
    if (!isGitSpace(c)) h = (Math.imul(h, 3) + (c & 0xff)) >>> 0;
  }
  return h & 0xffffff;
}

function addLine(img: Image, s: string, start: number, len: number, flag: number): void {
  img.lines.push({ len, hash: hashLine(s, start, len), flag });
}

function prepareImage(buf: string, lineTable: boolean): Image {
  const img: Image = { buf, lines: [] };
  if (!lineTable) return img;
  let cp = 0;
  while (cp < buf.length) {
    const nl = buf.indexOf("\n", cp);
    const next = nl < 0 ? buf.length : nl + 1;
    addLine(img, buf, cp, next - cp, 0);
    cp = next;
  }
  return img;
}

function removeFirstLine(img: Image): void {
  const first = img.lines.shift() as Line;
  img.buf = img.buf.slice(first.len);
}

function removeLastLine(img: Image): void {
  const last = img.lines.pop() as Line;
  img.buf = img.buf.slice(0, img.buf.length - last.len);
}

const isSpaceAt = (s: string, i: number) => isGitSpace(s.charCodeAt(i));

/**
 * The lines of a target image in a gap buffer: replacing lines costs the distance from
 * the previous replacement, not the size of the image, so hunks applied in order make
 * the whole patch linear (git's `update_image` moves the rest of the image each time).
 */
class LineTable {
  private items: (Line | undefined)[];
  private gapStart: number;
  private gapEnd: number;

  constructor(lines: Line[]) {
    this.items = lines;
    this.gapStart = lines.length;
    this.gapEnd = lines.length;
  }

  get length(): number {
    return this.items.length - (this.gapEnd - this.gapStart);
  }

  at(i: number): Line {
    return (
      i < this.gapStart ? this.items[i] : this.items[i + this.gapEnd - this.gapStart]
    ) as Line;
  }

  /** Replaces `remove` lines at `at` with `insert`. */
  splice(at: number, remove: number, insert: Line[]): void {
    const items = this.items;
    if (at < this.gapStart) {
      while (this.gapStart > at) items[--this.gapEnd] = items[--this.gapStart];
    } else {
      while (this.gapStart < at) items[this.gapStart++] = items[this.gapEnd++];
    }
    for (let i = 0; i < remove; i++) items[this.gapEnd + i] = undefined;
    this.gapEnd += remove;
    if (this.gapEnd - this.gapStart < insert.length) {
      const gap = insert.length + (this.length >> 1) + 16;
      const grown: (Line | undefined)[] = new Array(this.length + gap);
      for (let i = 0; i < this.gapStart; i++) grown[i] = items[i];
      const tail = items.length - this.gapEnd;
      for (let i = 0; i < tail; i++) grown[grown.length - tail + i] = items[this.gapEnd + i];
      this.gapEnd = grown.length - tail;
      this.items = grown;
    }
    for (const line of insert) this.items[this.gapStart++] = line;
  }
}

/** The image a patch is applied to (`struct image` of the preimage file). */
class Target {
  lines: LineTable;
  private text: string | undefined;

  constructor(buf: string, lineTable: boolean) {
    const lines: Line[] = [];
    if (lineTable) {
      let cp = 0;
      while (cp < buf.length) {
        const nl = buf.indexOf("\n", cp);
        const next = nl < 0 ? buf.length : nl + 1;
        lines.push({
          len: next - cp,
          hash: hashLine(buf, cp, next - cp),
          flag: 0,
          text: buf.slice(cp, next),
        });
        cp = next;
      }
    }
    this.lines = new LineTable(lines);
    this.text = buf;
  }

  /** The whole content. */
  get buf(): string {
    if (this.text === undefined) {
      const parts: string[] = [];
      for (let i = 0; i < this.lines.length; i++) parts.push(this.lines.at(i).text as string);
      this.text = parts.join("");
    }
    return this.text;
  }

  /** Replaces the content, without a line table (a binary or merged result). */
  set buf(content: string) {
    this.text = content;
    this.lines = new LineTable([]);
  }

  lineText(i: number): string {
    return this.lines.at(i).text as string;
  }

  /**
   * Whether the content from line `lno` on starts with `s` (`exact`: is `s`), git's
   * `memcmp` of the preimage at the line's offset.
   */
  textStartsWith(lno: number, s: string, exact: boolean): boolean {
    let pos = 0;
    const n = this.lines.length;
    for (let i = lno; i < n; i++) {
      if (pos >= s.length) return !exact;
      const t = this.lineText(i);
      const rest = s.length - pos;
      if (t.length > rest) return !exact && t.slice(0, rest) === s.slice(pos);
      if (!s.startsWith(t, pos)) return false;
      pos += t.length;
    }
    return pos === s.length;
  }

  replaceLines(at: number, remove: number, insert: Line[]): void {
    this.lines.splice(at, remove, insert);
    this.text = undefined;
  }
}

/** An index entry as the applier sees it (stage 0 unless said otherwise). */
export interface ApplyIndexEntry {
  mode: number;
  oid: string;
  intentToAdd?: boolean;
  stage?: number;
}

/** The storage `git apply` reads and writes; names are binary strings. */
export interface ApplyIO {
  /** lstat of a worktree path: its mode (S_IFREG|perm, S_IFLNK, S_IFDIR), none when absent */
  lstat(name: string): Promise<{ mode: number } | undefined>;
  /**
   * The worktree file's content as git would stage it (a link: its target); `keepCrlf`
   * skips the line-ending conversion (`CONV_EOL_KEEP_CRLF`), otherwise CRLF in the index
   * does not hold it back (`CONV_EOL_RENORMALIZE`)
   */
  readWorktree(name: string, mode: number, keepCrlf: boolean): Promise<string | undefined>;
  /** Whether a leading directory of the path is a symlink in the worktree */
  hasSymlinkLeadingPath(name: string): Promise<boolean>;
  /** The mode git would stage for the worktree file (`ce_mode_from_stat`) */
  modeFromStat(name: string, entry: ApplyIndexEntry | undefined, stMode: number): number;
  /** Whether the worktree file still matches the index entry (`ie_match_stat`) */
  matchesIndex(name: string, entry: ApplyIndexEntry): Promise<boolean>;
  /** Checks the entry out to the worktree (`checkout_target`); false on failure */
  checkout(name: string, entry: ApplyIndexEntry): Promise<boolean>;
  readBlob(oid: string): Promise<string | undefined>;
  hasObject(oid: string): Promise<boolean>;
  writeBlob(content: string): Promise<string>;
  hashBlob(content: string): Promise<string>;
  /** The blob a (possibly abbreviated) id names */
  resolveBlob(prefix: string): Promise<string | undefined>;
  /** `ll_merge` of three blobs; conflicts > 0 for a conflicted result, undefined on failure */
  merge(
    name: string,
    base: string,
    ours: string,
    theirs: string,
    variant: "ours" | "theirs" | "union" | undefined,
  ): Promise<{ content: string; conflicts: number; binary?: boolean } | undefined>;
  /**
   * Removes a worktree file (a gitlink: its directory when empty) and, with `rmdirEmpty`,
   * the directories it leaves empty (`remove_or_warn`, `remove_path`); a warning on failure
   */
  removeWorktree(name: string, mode: number, rmdirEmpty: boolean): Promise<string | undefined>;
  /** Writes a worktree file (smudged), creating directories; an error message on failure */
  createWorktree(name: string, mode: number, content: string): Promise<string | undefined>;
  writeReject(name: string, content: string): Promise<void>;
  /** Stat data of a written file for its index entry */
  statOf(name: string): Promise<Record<string, number> | undefined>;
  /** Whether symlinks can be created (`core.symlinks`) */
  hasSymlinks: boolean;
  trustExecutableBit: boolean;
  /** Whether the path is safe to have in the index (`verify_path`) */
  verifyPath(name: string, mode: number): boolean;
}

type FnState = FilePatch | "deleted" | "to-be-deleted";

/** Options of {@link ApplyEngine.applyAll}. */
export interface ApplyInput {
  /** The patch bytes as a binary string */
  text: string;
  /** Its name in messages: the file name, `<stdin>` by default */
  name: string;
  /** Whether it was named on the command line (whitespace default mode per file) */
  fromFile: boolean;
}

/** One applier run (apply.c's `apply_state` plus the patch list). */
export class ApplyEngine extends ApplyParser {
  threeway = false;
  cached = false;
  checkIndex = false;
  updateIndex = false;
  itaOnly = false;
  unsafePaths = false;
  applyWithReject = false;
  allowOverlap = false;
  noAdd = false;
  unidiffZero = false;
  inaccurateEof = false;
  recount = false;
  allowEmpty = false;
  diffstat = false;
  numstat = false;
  summary = false;
  lineTermination = "\n";
  pContext = Number.MAX_SAFE_INTEGER;
  wsIgnoreChange = false;
  whitespaceOptionGiven = false;
  configWhitespace?: string;
  mergeVariant?: "ours" | "theirs" | "union";
  appliedAfterFixingWs = 0;
  maxChange = 0;
  maxLen = 0;
  /** Paths of the patch list written with conflicts, for the caller (am) */
  conflictedPaths: string[] = [];

  private fnTable = new Map<string, FnState>();
  private removedSymlinks = new Set<string>();
  private keptSymlinks = new Set<string>();
  /** Index changes: a name's entries (all stages) replaced, or removed (empty list) */
  readonly indexChanges = new Map<
    string,
    (ApplyIndexEntry & { stat?: Record<string, number> })[]
  >();

  constructor(
    private readonly io: ApplyIO,
    private readonly indexOf: (name: string) => ApplyIndexEntry | undefined,
    private readonly wsRuleOfName: (name: string) => Promise<number>,
    private readonly wildmatch: (pattern: string, text: string) => boolean,
    /** The names of the stage-0 index entries (for the file/directory checks) */
    private readonly indexNames: () => Iterable<string> = () => [],
  ) {
    super();
  }

  private sortedIndexNames?: string[];

  /** Whether the name is an entry of the index as changed so far (at the stage). */
  private hasIndexName(name: string, stage: number): boolean {
    const changed = this.indexChanges.get(name);
    if (changed) return changed.some((e) => (e.stage ?? 0) === stage);
    return stage === 0 && this.indexOf(name) !== undefined;
  }

  /**
   * `check_file_directory_conflict` of `add_index_entry` without `ADD_CACHE_OK_TO_REPLACE`:
   * whether an entry (at the stage) of the index as changed so far is below the name
   * (`has_file_name`) or one of its leading directories (`has_dir_name`).
   */
  private fileDirectoryConflict(name: string, stage: number): boolean {
    for (let at = name.lastIndexOf("/"); at > 0; at = name.lastIndexOf("/", at - 1)) {
      if (this.hasIndexName(name.slice(0, at), stage)) return true;
    }
    const prefix = `${name}/`;
    for (const [n, entries] of this.indexChanges) {
      if (n.startsWith(prefix) && entries.some((e) => (e.stage ?? 0) === stage)) return true;
    }
    if (stage !== 0) return false;
    if (!this.sortedIndexNames) {
      this.sortedIndexNames = [...this.indexNames()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    }
    const names = this.sortedIndexNames;
    let lo = 0;
    let hi = names.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((names[mid] as string) < prefix) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < names.length && (names[i] as string).startsWith(prefix); i++) {
      if (!this.indexChanges.has(names[i] as string)) return true;
    }
    return false;
  }

  /** `add_index_entry(..., ADD_CACHE_OK_TO_ADD)` of entries at one name; 0 or -1. */
  private addIndexEntries(
    name: string,
    entries: (ApplyIndexEntry & { stat?: Record<string, number> })[],
  ): number {
    for (const e of entries) {
      if (this.fileDirectoryConflict(name, e.stage ?? 0)) {
        this.error(`'${name}' appears as both a file and as a directory`);
        return this.error(`unable to add cache entry for ${name}`);
      }
    }
    this.setIndex(name, entries);
    return 0;
  }

  private indexEntry(name: string): ApplyIndexEntry | undefined {
    const changed = this.indexChanges.get(name);
    if (changed) return changed.find((e) => !e.stage);
    return this.indexOf(name);
  }

  // ---------------------------------------------------------------- matching

  private updatePrePostImages(preimage: Image, postimage: Image, buf: string): void {
    const fixed = prepareImage(buf, true);
    for (let i = 0; i < fixed.lines.length; i++)
      (fixed.lines[i] as Line).flag = preimage.lines[i]?.flag ?? 0;
    preimage.buf = fixed.buf;
    preimage.lines = fixed.lines;
    let fixedAt = 0;
    let insertPos = 0;
    let reduced = 0;
    let ctx = 0;
    let post = postimage.buf;
    for (let i = 0; i < postimage.lines.length; i++) {
      const line = postimage.lines[i] as Line;
      if (!(line.flag & LINE_COMMON)) {
        insertPos += line.len;
        continue;
      }
      while (ctx < preimage.lines.length && !((preimage.lines[ctx] as Line).flag & LINE_COMMON)) {
        fixedAt += (preimage.lines[ctx] as Line).len;
        ctx++;
      }
      if (preimage.lines.length <= ctx) {
        // dropped from the buffer (git copies nothing for it)
        post = post.slice(0, insertPos) + post.slice(insertPos + line.len);
        reduced++;
        continue;
      }
      const lLen = (preimage.lines[ctx] as Line).len;
      post =
        post.slice(0, insertPos) +
        preimage.buf.slice(fixedAt, fixedAt + lLen) +
        post.slice(insertPos + line.len);
      insertPos += lLen;
      fixedAt += lLen;
      line.len = lLen;
      ctx++;
    }
    postimage.buf = post;
    postimage.lines.length -= reduced;
  }

  private lineByLineFuzzyMatch(
    img: Target,
    preimage: Image,
    postimage: Image,
    currentLno: number,
    preimageLimit: number,
  ): boolean {
    let preoff = 0;
    let i = 0;
    const matched: string[] = [];
    for (; i < preimageLimit; i++) {
      const prelen = (preimage.lines[i] as Line).len;
      const t = img.lineText(currentLno + i);
      if (!fuzzyMatchLines(t, 0, t.length, preimage.buf, preoff, prelen)) return false;
      matched.push(t);
      preoff += prelen;
    }
    const preimageEof = preoff;
    for (; i < preimage.lines.length; i++) preoff += (preimage.lines[i] as Line).len;
    for (let b = preimageEof; b < preoff; b++) if (!isSpaceAt(preimage.buf, b)) return false;
    const fixed = matched.join("") + preimage.buf.slice(preimageEof, preoff);
    this.updatePrePostImages(preimage, postimage, fixed);
    return true;
  }

  private matchFragment(
    img: Target,
    preimage: Image,
    postimage: Image,
    currentLno: number,
    wsRule: number,
    matchBeginning: boolean,
    matchEnd: boolean,
  ): boolean {
    let preimageLimit: number;
    if (preimage.lines.length + currentLno <= img.lines.length) {
      preimageLimit = preimage.lines.length;
      if (matchEnd && preimage.lines.length + currentLno !== img.lines.length) return false;
    } else if (this.wsErrorAction === "fix" && wsRule & WS_BLANK_AT_EOF) {
      preimageLimit = img.lines.length - currentLno;
    } else return false;
    if (matchBeginning && currentLno) return false;
    for (let i = 0; i < preimageLimit; i++) {
      const il = img.lines.at(currentLno + i);
      if (il.flag & LINE_PATCHED || (preimage.lines[i] as Line).hash !== il.hash) return false;
    }
    if (preimageLimit === preimage.lines.length) {
      if (img.textStartsWith(currentLno, preimage.buf, matchEnd)) return true;
    } else {
      let end = 0;
      for (let i = 0; i < preimageLimit; i++) end += (preimage.lines[i] as Line).len;
      let b = 0;
      for (; b < end; b++) if (!isSpaceAt(preimage.buf, b)) break;
      if (b === end) return false;
    }
    if (this.wsIgnoreChange) {
      return this.lineByLineFuzzyMatch(img, preimage, postimage, currentLno, preimageLimit);
    }
    if (this.wsErrorAction !== "fix") return false;
    let fixed = "";
    let orig = 0;
    let i = 0;
    for (; i < preimageLimit; i++) {
      const oldlen = (preimage.lines[i] as Line).len;
      const a = wsFixCopy(preimage.buf.slice(orig, orig + oldlen), wsRule).text;
      const b = wsFixCopy(img.lineText(currentLno + i), wsRule).text;
      fixed += a;
      if (a !== b) return false;
      orig += oldlen;
    }
    for (; i < preimage.lines.length; i++) {
      const oldlen = (preimage.lines[i] as Line).len;
      const a = wsFixCopy(preimage.buf.slice(orig, orig + oldlen), wsRule).text;
      for (let j = 0; j < a.length; j++) if (!isSpaceAt(a, j)) return false;
      fixed += a;
      orig += oldlen;
    }
    this.updatePrePostImages(preimage, postimage, fixed);
    return true;
  }

  private findPos(
    img: Target,
    preimage: Image,
    postimage: Image,
    line: number,
    wsRule: number,
    matchBeginning: boolean,
    matchEnd: boolean,
  ): number {
    const nr = img.lines.length;
    if (this.allowOverlap && matchBeginning && matchEnd && nr - preimage.lines.length !== 0)
      matchBeginning = false;
    if (matchBeginning) line = 0;
    else if (matchEnd) line = nr - preimage.lines.length;
    if (line < 0 || line > nr) line = nr;
    let backwardsLno = line;
    let forwardsLno = line;
    let currentLno = line;
    for (let i = 0; ; i++) {
      if (
        this.matchFragment(img, preimage, postimage, currentLno, wsRule, matchBeginning, matchEnd)
      )
        return currentLno;
      for (;;) {
        if (backwardsLno === 0 && forwardsLno === nr) return -1;
        if (i & 1) {
          if (backwardsLno === 0) {
            i++;
            continue;
          }
          backwardsLno--;
          currentLno = backwardsLno;
        } else {
          if (forwardsLno === nr) {
            i++;
            continue;
          }
          forwardsLno++;
          currentLno = forwardsLno;
        }
        break;
      }
    }
  }

  private updateImage(img: Target, appliedPos: number, preimage: Image, postimage: Image): void {
    let preimageLimit = preimage.lines.length;
    if (preimageLimit > img.lines.length - appliedPos)
      preimageLimit = img.lines.length - appliedPos;
    const inserted: Line[] = [];
    let off = 0;
    for (const l of postimage.lines) {
      inserted.push({
        len: l.len,
        hash: l.hash,
        flag: this.allowOverlap ? l.flag : l.flag | LINE_PATCHED,
        text: postimage.buf.slice(off, off + l.len),
      });
      off += l.len;
    }
    // the postimage's bytes past its lines (none unless its lines were cut) stay with it
    if (off < postimage.buf.length) {
      const last = inserted[inserted.length - 1];
      if (last) last.text += postimage.buf.slice(off);
      else inserted.push({ len: 0, hash: 0, flag: LINE_PATCHED, text: postimage.buf.slice(off) });
    }
    img.replaceLines(appliedPos, preimageLimit, inserted);
  }

  private applyOneFragment(
    img: Target,
    frag: FilePatch["fragments"][number],
    inaccurateEof: boolean,
    wsRule: number,
    nth: number,
  ): boolean {
    const patch = frag.patch;
    let size = frag.size;
    let old = "";
    let newlines = "";
    let newBlankLinesAtEnd = 0;
    let foundNewBlankLinesAtEnd = 0;
    let hunkLinenr = frag.linenr;
    const preimage: Image = { buf: "", lines: [] };
    const postimage: Image = { buf: "", lines: [] };
    let at = 0;
    while (size > 0) {
      const len = linelen(patch, at, size);
      if (!len) break;
      let plen = len - 1;
      if (len < size && patch[at + len] === "\\") plen--;
      let first = patch[at] as string;
      if (this.applyInReverse) {
        if (first === "-") first = "+";
        else if (first === "+") first = "-";
      }
      let addedBlankLine = false;
      let isBlankContext = false;
      const body = patch.slice(at + 1, at + 1 + Math.max(plen, 0));
      switch (first) {
        case "\n":
          if (plen < 0) break;
          old += "\n";
          newlines += "\n";
          addLine(preimage, "\n", 0, 1, LINE_COMMON);
          addLine(postimage, "\n", 0, 1, LINE_COMMON);
          isBlankContext = true;
          break;
        case " ":
        case "-":
        case "+": {
          if (first === " " && plen && wsRule & WS_BLANK_AT_EOF && wsBlankLine(body))
            isBlankContext = true;
          if (first !== "+") {
            addLine(preimage, body, 0, plen, first === " " ? LINE_COMMON : 0);
            old += body;
            if (first === "-") break;
          }
          if (first === "+" && this.noAdd) break;
          let added: string;
          if (first !== "+" || !this.whitespaceError || this.wsErrorAction !== "fix") {
            added = body;
          } else {
            const f = wsFixCopy(body, wsRule);
            added = f.text;
            if (f.fixed) this.appliedAfterFixingWs++;
          }
          newlines += added;
          addLine(postimage, added, 0, added.length, first === "+" ? 0 : LINE_COMMON);
          if (first === "+" && wsRule & WS_BLANK_AT_EOF && wsBlankLine(body)) addedBlankLine = true;
          break;
        }
        case "@":
        case "\\":
          break;
        default:
          if (this.verbosity > 0) this.error(`invalid start of line: '${first}'`);
          return true;
      }
      if (addedBlankLine) {
        if (!newBlankLinesAtEnd) foundNewBlankLinesAtEnd = hunkLinenr;
        newBlankLinesAtEnd++;
      } else if (!isBlankContext) newBlankLinesAtEnd = 0;
      at += len;
      size -= len;
      hunkLinenr++;
    }
    if (inaccurateEof && old.endsWith("\n") && newlines.endsWith("\n")) {
      old = old.slice(0, -1);
      newlines = newlines.slice(0, -1);
      (preimage.lines[preimage.lines.length - 1] as Line).len--;
      (postimage.lines[postimage.lines.length - 1] as Line).len--;
    }
    let leading = frag.leading;
    let trailing = frag.trailing;
    let matchBeginning = !frag.oldpos || (frag.oldpos === 1 && !this.unidiffZero);
    let matchEnd = !this.unidiffZero && !trailing;
    let pos = frag.newpos ? frag.newpos - 1 : 0;
    preimage.buf = old;
    postimage.buf = newlines;
    let appliedPos: number;
    for (;;) {
      appliedPos = this.findPos(img, preimage, postimage, pos, wsRule, matchBeginning, matchEnd);
      if (appliedPos >= 0) break;
      if (leading <= this.pContext && trailing <= this.pContext) break;
      if (matchBeginning || matchEnd) {
        matchBeginning = matchEnd = false;
        continue;
      }
      if (leading >= trailing) {
        removeFirstLine(preimage);
        removeFirstLine(postimage);
        pos--;
        leading--;
      }
      if (trailing > leading) {
        removeLastLine(preimage);
        removeLastLine(postimage);
        trailing--;
      }
    }
    if (appliedPos >= 0) {
      if (
        newBlankLinesAtEnd &&
        preimage.lines.length + appliedPos >= img.lines.length &&
        wsRule & WS_BLANK_AT_EOF &&
        this.wsErrorAction !== "nowarn"
      ) {
        this.recordWsError(WS_BLANK_AT_EOF, "+", foundNewBlankLinesAtEnd);
        if (this.wsErrorAction === "fix") {
          while (newBlankLinesAtEnd--) removeLastLine(postimage);
        }
        if (this.wsErrorAction === "error") this.apply = false;
      }
      if (this.verbosity > 0 && appliedPos !== pos) {
        let offset = appliedPos - pos;
        if (this.applyInReverse) offset = -offset;
        const lines = offset === 1 ? "line" : "lines";
        this.stderr += `Hunk #${nth} succeeded at ${appliedPos + 1} (offset ${offset} ${lines}).\n`;
      }
      if ((leading !== frag.leading || trailing !== frag.trailing) && this.verbosity > -1)
        this.stderr += `Context reduced to (${leading}/${trailing}) to apply fragment at ${appliedPos + 1}\n`;
      this.updateImage(img, appliedPos, preimage, postimage);
    } else if (this.verbosity > 0) {
      this.error(`while searching for:\n${old}`);
    }
    return appliedPos < 0;
  }

  private applyBinaryFragment(img: Target, patch: FilePatch): number {
    let fragment = patch.fragments[0];
    const name = patch.newName ?? patch.oldName;
    if (!fragment) return this.error(`missing binary patch data for '${name}'`);
    if (this.applyInReverse) {
      if (!patch.fragments[1])
        return this.error(
          `cannot reverse-apply a binary patch without the reverse hunk to '${name}'`,
        );
      fragment = patch.fragments[1];
    }
    if (fragment.binaryMethod === BINARY_DELTA) {
      try {
        const out = decodeGitBinaryDelta(latin1ToBytes(img.buf), latin1ToBytes(fragment.patch));
        img.buf = bytesToLatin1(out);
        return 0;
      } catch {
        return -1;
      }
    }
    if (fragment.binaryMethod === BINARY_LITERAL) {
      img.buf = fragment.patch;
      return 0;
    }
    return -1;
  }

  private async applyBinary(img: Target, patch: FilePatch): Promise<number> {
    const name = patch.oldName ?? patch.newName;
    const hex = /^[0-9a-f]{40}$/;
    if (!hex.test(patch.oldOidPrefix) || !hex.test(patch.newOidPrefix))
      return this.error(`cannot apply binary patch to '${name}' without full index line`);
    if (patch.oldName !== null) {
      const oid = await this.io.hashBlob(img.buf);
      if (oid !== patch.oldOidPrefix)
        return this.error(
          `the patch applies to '${name}' (${oid}), which does not match the current contents.`,
        );
    } else if (img.buf.length) {
      return this.error(`the patch applies to an empty '${name}' but it is not empty`);
    }
    if (/^0+$/.test(patch.newOidPrefix)) {
      img.buf = "";
      return 0;
    }
    if (await this.io.hasObject(patch.newOidPrefix)) {
      const result = await this.io.readBlob(patch.newOidPrefix);
      if (result === undefined)
        return this.error(
          `the necessary postimage ${patch.newOidPrefix} for '${name}' cannot be read`,
        );
      img.buf = result;
    } else {
      if (this.applyBinaryFragment(img, patch))
        return this.error(`binary patch does not apply to '${name}'`);
      const oid = await this.io.hashBlob(img.buf);
      if (oid !== patch.newOidPrefix)
        return this.error(
          `binary patch to '${name}' creates incorrect result (expecting ${patch.newOidPrefix}, got ${oid})`,
        );
    }
    return 0;
  }

  private async applyFragments(img: Target, patch: FilePatch): Promise<number> {
    const name = patch.oldName ?? patch.newName;
    if (patch.isBinary) return this.applyBinary(img, patch);
    let nth = 0;
    for (const frag of patch.fragments) {
      nth++;
      if (this.applyOneFragment(img, frag, patch.inaccurateEof, patch.wsRule, nth)) {
        this.error(`patch failed: ${name}:${frag.oldpos}`);
        if (!this.applyWithReject) return -1;
        frag.rejected = true;
      }
    }
    return 0;
  }

  // ---------------------------------------------------------------- the tree

  private async readBlobObject(oid: string, mode: number): Promise<string | undefined> {
    if (isGitlink(mode)) return `Subproject commit ${oid}\n`;
    return this.io.readBlob(oid);
  }

  private addToFnTable(patch: FilePatch): void {
    if (patch.newName !== null) this.fnTable.set(patch.newName, patch);
    if (patch.newName === null || patch.isRename)
      this.fnTable.set(patch.oldName as string, "deleted");
  }

  private prepareFnTable(list: FilePatch[]): void {
    for (const patch of list) {
      if (patch.newName === null || patch.isRename)
        this.fnTable.set(patch.oldName as string, "to-be-deleted");
    }
  }

  private previousPatch(patch: FilePatch): { previous?: FilePatch; gone: boolean } {
    if (patch.isCopy || patch.isRename) return { gone: false };
    const previous = patch.oldName === null ? undefined : this.fnTable.get(patch.oldName);
    if (!previous || previous === "to-be-deleted") return { gone: false };
    if (previous === "deleted") return { gone: true };
    return { previous, gone: false };
  }

  /** `load_patch_target`: 0, 1 for a submodule patch without the index, -1 on error. */
  private async loadPatchTarget(
    out: { buf: string },
    entry: ApplyIndexEntry | undefined,
    stMode: number,
    patch: FilePatch,
    name: string | null,
    expectedMode: number,
  ): Promise<number> {
    if (this.cached || this.checkIndex) {
      if (entry) {
        const data = await this.readBlobObject(entry.oid, entry.mode);
        if (data === undefined) return this.error(`failed to read ${name}`);
        out.buf = data;
      }
    } else if (name !== null) {
      if (isGitlink(expectedMode)) {
        if (entry) {
          out.buf = (await this.readBlobObject(entry.oid, entry.mode)) ?? "";
          return 0;
        }
        return 1;
      }
      if (await this.io.hasSymlinkLeadingPath(name))
        return this.error(`reading from '${name}' beyond a symbolic link`);
      const data = await this.io.readWorktree(name, stMode, patch.crlfInOld);
      if (data === undefined) return this.error(`failed to read ${name}`);
      out.buf = data;
    }
    return 0;
  }

  private async loadPreimage(
    patch: FilePatch,
    stMode: number,
    entry: ApplyIndexEntry | undefined,
  ): Promise<Target | undefined> {
    const { previous, gone } = this.previousPatch(patch);
    if (gone) {
      this.error(`path ${patch.oldName} has been renamed/deleted`);
      return undefined;
    }
    const out = { buf: "" };
    if (previous) out.buf = previous.result ?? "";
    else {
      const status = await this.loadPatchTarget(
        out,
        entry,
        stMode,
        patch,
        patch.oldName,
        patch.oldMode,
      );
      if (status < 0) return undefined;
      if (status === 1) patch.fragments = [];
    }
    return new Target(out.buf, !patch.isBinary);
  }

  private async loadCurrent(patch: FilePatch): Promise<Target | undefined> {
    const name = patch.newName as string;
    const entry = this.indexEntry(name);
    if (!entry) {
      this.error(`${name}: does not exist in index`);
      return undefined;
    }
    let st = await this.io.lstat(name);
    if (!st) {
      if (!(await this.io.checkout(name, entry))) {
        this.error(`cannot checkout ${name}`);
        return undefined;
      }
      st = await this.io.lstat(name);
    }
    if (!(await this.io.matchesIndex(name, entry))) {
      this.error(`${name}: does not match index`);
      return undefined;
    }
    const out = { buf: "" };
    const status = await this.loadPatchTarget(
      out,
      entry,
      st?.mode ?? 0,
      patch,
      name,
      patch.newMode,
    );
    if (status) return undefined;
    return new Target(out.buf, !patch.isBinary);
  }

  private async tryThreeway(
    image: Target,
    patch: FilePatch,
    stMode: number,
    entry: ApplyIndexEntry | undefined,
  ): Promise<number> {
    if (
      patch.isDelete ||
      isGitlink(patch.oldMode) ||
      isGitlink(patch.newMode) ||
      (patch.isNew && !patch.directToThreeway) ||
      (patch.isRename && !patch.linesAdded && !patch.linesDeleted)
    )
      return -1;
    let preOid: string;
    let pre = "";
    if (patch.isNew) preOid = await this.io.writeBlob("");
    else {
      const resolved = await this.io.resolveBlob(patch.oldOidPrefix);
      const data = resolved ? await this.readBlobObject(resolved, patch.oldMode) : undefined;
      if (!resolved || data === undefined)
        return this.error("repository lacks the necessary blob to perform 3-way merge.");
      preOid = resolved;
      pre = data;
    }
    if (this.verbosity > -1 && patch.directToThreeway)
      this.stderr += "Performing three-way merge...\n";
    const tmp = new Target(pre, true);
    if ((await this.applyFragments(tmp, patch)) < 0) return -1;
    const postOid = await this.io.writeBlob(tmp.buf);
    let ours: Target | undefined;
    if (patch.isNew) {
      ours = await this.loadCurrent(patch);
      if (!ours) return this.error(`cannot read the current contents of '${patch.newName}'`);
    } else {
      ours = await this.loadPreimage(patch, stMode, entry);
      if (!ours) return this.error(`cannot read the current contents of '${patch.oldName}'`);
    }
    const ourOid = await this.io.writeBlob(ours.buf);
    let status: number;
    if (preOid === ourOid) {
      image.buf = (await this.io.readBlob(postOid)) ?? "";
      status = 0;
    } else if (preOid === postOid || ourOid === postOid) {
      image.buf = (await this.io.readBlob(ourOid)) ?? "";
      status = 0;
    } else {
      const merged = await this.io.merge(
        patch.newName as string,
        preOid,
        ourOid,
        postOid,
        this.mergeVariant,
      );
      if (merged?.binary)
        this.warning(`Cannot merge binary files: ${patch.newName} (ours vs. theirs)`);
      if (!merged || merged.binary) {
        if (this.verbosity > -1) this.stderr += "Failed to perform three-way merge...\n";
        return -1;
      }
      image.buf = merged.content;
      status = merged.conflicts > 0 ? 1 : 0;
    }
    if (status) {
      patch.conflictedThreeway = true;
      patch.threewayStage = [patch.isNew ? null : preOid, ourOid, postOid];
      if (this.verbosity > -1)
        this.stderr += `Applied patch to '${patch.newName}' with conflicts.\n`;
    } else if (this.verbosity > -1) {
      this.stderr += `Applied patch to '${patch.newName}' cleanly.\n`;
    }
    return 0;
  }

  private async applyData(
    patch: FilePatch,
    stMode: number,
    entry: ApplyIndexEntry | undefined,
  ): Promise<number> {
    const image = await this.loadPreimage(patch, stMode, entry);
    if (!image) return -1;
    if (!this.threeway || (await this.tryThreeway(image, patch, stMode, entry)) < 0) {
      if (this.verbosity > -1 && this.threeway && !patch.directToThreeway)
        this.stderr += "Falling back to direct application...\n";
      if (patch.directToThreeway || (await this.applyFragments(image, patch)) < 0) return -1;
    }
    patch.result = image.buf;
    this.addToFnTable(patch);
    if (0 < patch.isDelete && patch.result.length)
      return this.error("removal patch leaves file contents");
    return 0;
  }

  private async checkPreimage(
    patch: FilePatch,
  ): Promise<{ status: number; entry?: ApplyIndexEntry; stMode: number }> {
    const oldName = patch.oldName;
    let stMode = 0;
    let fileMode = 0;
    let missing = false;
    if (oldName === null) return { status: 0, stMode: 0 };
    const { previous, gone } = this.previousPatch(patch);
    if (gone) return { status: this.error(`path ${oldName} has been renamed/deleted`), stMode: 0 };
    if (previous) stMode = previous.newMode;
    else if (!this.cached) {
      const st = await this.io.lstat(oldName);
      if (st) fileMode = st.mode;
      else missing = true;
    }
    let entry: ApplyIndexEntry | undefined;
    const isNew = (): { status: number; stMode: number } => {
      patch.isNew = 1;
      patch.isDelete = 0;
      patch.oldName = null;
      return { status: 0, stMode: 0 };
    };
    if (this.checkIndex && !previous) {
      entry = this.indexEntry(oldName);
      if (!entry) {
        if (patch.isNew < 0) return isNew();
        return { status: this.error(`${oldName}: does not exist in index`), stMode: 0 };
      }
      if (missing && !this.cached) {
        if (!(await this.io.checkout(oldName, entry)))
          return { status: this.error(`cannot checkout ${oldName}`), stMode: 0 };
        fileMode = (await this.io.lstat(oldName))?.mode ?? 0;
        missing = false;
      }
      if (!this.cached && !(await this.io.matchesIndex(oldName, entry)))
        return { status: this.error(`${oldName}: does not match index`), stMode: 0 };
      if (this.cached) stMode = entry.mode;
    } else if (missing) {
      if (patch.isNew < 0) return isNew();
      return { status: this.error(`${oldName}: No such file or directory`), stMode: 0 };
    }
    if (!this.cached && !previous) {
      if (this.io.trustExecutableBit || !isRegular(fileMode))
        stMode = this.io.modeFromStat(oldName, entry, fileMode);
      else if (entry) stMode = entry.mode;
      else stMode = patch.oldMode;
    }
    if (patch.isNew < 0) patch.isNew = 0;
    if (!patch.oldMode) patch.oldMode = stMode;
    if ((stMode ^ patch.oldMode) & S_IFMT)
      return { status: this.error(`${oldName}: wrong type`), stMode: 0 };
    if (stMode !== patch.oldMode)
      this.warning(
        `${oldName} has type ${stMode.toString(8)}, expected ${patch.oldMode.toString(8)}`,
      );
    if (!patch.newMode && !patch.isDelete) patch.newMode = stMode;
    return { status: 0, entry, stMode: fileMode || stMode };
  }

  /** `check_to_create`: 0, 1 in index, 2 in worktree, 3 in index as ITA. */
  private async checkToCreate(name: string, okIfExists: boolean): Promise<number> {
    if (this.checkIndex && (!okIfExists || !this.cached)) {
      const entry = this.indexEntry(name);
      if (entry) {
        if (!okIfExists && !entry.intentToAdd) return 1;
        if (!this.cached && entry.intentToAdd) return 3;
      }
    }
    if (this.cached) return 0;
    const st = await this.io.lstat(name);
    if (st) {
      if ((st.mode & S_IFMT) === 0o040000 || okIfExists) return 0;
      if (await this.io.hasSymlinkLeadingPath(name)) return 0;
      return 2;
    }
    return 0;
  }

  private prepareSymlinkChanges(list: FilePatch[]): void {
    for (const patch of list) {
      if (patch.oldName !== null && isLink(patch.oldMode) && (patch.isRename || patch.isDelete))
        this.removedSymlinks.add(patch.oldName);
      if (patch.newName !== null && isLink(patch.newMode)) this.keptSymlinks.add(patch.newName);
    }
  }

  private async pathIsBeyondSymlink(name: string): Promise<boolean> {
    let len = name.length;
    for (;;) {
      while (--len > 0 && name[len] !== "/");
      if (len <= 0) break;
      const dir = name.slice(0, len);
      if (this.keptSymlinks.has(dir)) return true;
      if (this.removedSymlinks.has(dir)) continue;
      if (this.checkIndex) {
        const entry = this.indexEntry(dir);
        if (entry && isLink(entry.mode)) return true;
      } else {
        const st = await this.io.lstat(dir);
        if (st && isLink(st.mode)) return true;
      }
    }
    return false;
  }

  private checkUnsafePath(patch: FilePatch): number {
    let oldName: string | null = null;
    let newName: string | null = null;
    if (patch.isDelete) oldName = patch.oldName;
    else if (!patch.isNew && !patch.isCopy) oldName = patch.oldName;
    if (!patch.isDelete) newName = patch.newName;
    if (oldName !== null && !this.io.verifyPath(oldName, patch.oldMode))
      return this.error(`invalid path '${oldName}'`);
    if (newName !== null && !this.io.verifyPath(newName, patch.newMode))
      return this.error(`invalid path '${newName}'`);
    return 0;
  }

  private async checkPatch(patch: FilePatch): Promise<number> {
    patch.rejected = true;
    const pre = await this.checkPreimage(patch);
    if (pre.status) return pre.status;
    const oldName = patch.oldName;
    const newName = patch.newName;
    const name = oldName ?? newName;
    const t = newName === null ? undefined : this.fnTable.get(newName);
    const okIfExists = t === "deleted" || t === "to-be-deleted";
    if (newName !== null && (0 < patch.isNew || patch.isRename || patch.isCopy)) {
      const err = await this.checkToCreate(newName, okIfExists);
      if (err && this.threeway) patch.directToThreeway = true;
      else if (err === 1) return this.error(`${newName}: already exists in index`);
      else if (err === 3) return this.error(`${newName}: does not match index`);
      else if (err === 2) return this.error(`${newName}: already exists in working directory`);
      if (!patch.newMode) patch.newMode = 0 < patch.isNew ? S_IFREG | 0o644 : patch.oldMode;
    }
    if (newName !== null && oldName !== null) {
      if (!patch.newMode) patch.newMode = patch.oldMode;
      if ((patch.oldMode ^ patch.newMode) & S_IFMT) {
        const nm = patch.newMode.toString(8);
        const om = patch.oldMode.toString(8);
        if (oldName === newName)
          return this.error(`new mode (${nm}) of ${newName} does not match old mode (${om})`);
        return this.error(
          `new mode (${nm}) of ${newName} does not match old mode (${om}) of ${oldName}`,
        );
      }
    }
    if (!this.unsafePaths && this.checkUnsafePath(patch)) return -128;
    if (!patch.isDelete && newName !== null && (await this.pathIsBeyondSymlink(newName)))
      return this.error(`affected file '${newName}' is beyond a symbolic link`);
    if ((await this.applyData(patch, pre.stMode, pre.entry)) < 0)
      return this.error(`${name}: patch does not apply`);
    patch.rejected = false;
    return 0;
  }

  private sayPatchName(format: (name: string) => string, patch: FilePatch): void {
    let shown: string;
    if (patch.oldName !== null && patch.newName !== null && patch.oldName !== patch.newName)
      shown = `${this.quote(patch.oldName)} => ${this.quote(patch.newName)}`;
    else shown = this.quote((patch.newName ?? patch.oldName) as string);
    this.stderr += `${format(shown)}\n`;
  }

  private async checkPatchList(list: FilePatch[]): Promise<number> {
    let err = 0;
    this.prepareSymlinkChanges(list);
    this.prepareFnTable(list);
    for (const patch of list) {
      if (this.verbosity > 0) this.sayPatchName((n) => `Checking patch ${n}...`, patch);
      const res = await this.checkPatch(patch);
      if (res === -128) return -128;
      err |= res;
    }
    return err;
  }

  // ---------------------------------------------------------------- output

  private showStats(patch: FilePatch): void {
    let qname = this.quote((patch.newName ?? patch.oldName) as string);
    let max = this.maxLen;
    if (max > 50) max = 50;
    if (qname.length > max) {
      const from = qname.length + 3 - max;
      let cp = qname.indexOf("/", from);
      if (cp < 0) cp = from;
      qname = `...${qname.slice(cp)}`;
    }
    if (patch.isBinary) {
      this.stdout += ` ${qname.padEnd(max)} |  Bin\n`;
      return;
    }
    this.stdout += ` ${qname.padEnd(max)} |`;
    max = max + this.maxChange > 70 ? 70 - max : this.maxChange;
    let add = patch.linesAdded;
    let del = patch.linesDeleted;
    if (this.maxChange > 0) {
      const total = Math.trunc(
        ((add + del) * max + Math.trunc(this.maxChange / 2)) / this.maxChange,
      );
      add = Math.trunc((add * max + Math.trunc(this.maxChange / 2)) / this.maxChange);
      del = total - add;
    }
    const n = String(patch.linesAdded + patch.linesDeleted).padStart(5);
    this.stdout += `${n} ${"+".repeat(Math.max(0, Math.min(add, 70)))}${"-".repeat(Math.max(0, Math.min(del, 70)))}\n`;
  }

  private statPatchList(list: FilePatch[]): void {
    let adds = 0;
    let dels = 0;
    for (const patch of list) {
      adds += patch.linesAdded;
      dels += patch.linesDeleted;
      this.showStats(patch);
    }
    this.stdout += statSummary(list.length, adds, dels);
  }

  private numstatPatchList(list: FilePatch[]): void {
    for (const patch of list) {
      const name = (patch.newName ?? patch.oldName) as string;
      this.stdout += patch.isBinary ? "-\t-\t" : `${patch.linesAdded}\t${patch.linesDeleted}\t`;
      this.stdout += this.lineTermination === "\n" ? this.quote(name) : name;
      this.stdout += this.lineTermination;
    }
  }

  private summaryPatchList(list: FilePatch[]): void {
    const o6 = (m: number) => m.toString(8).padStart(6, "0");
    const fileModeName = (what: string, mode: number, name: string) => {
      this.stdout += mode ? ` ${what} mode ${o6(mode)} ${name}\n` : ` ${what} ${name}\n`;
    };
    const modeChange = (p: FilePatch, showName: boolean) => {
      if (p.oldMode && p.newMode && p.oldMode !== p.newMode) {
        this.stdout += showName
          ? ` mode change ${o6(p.oldMode)} => ${o6(p.newMode)} ${p.newName}\n`
          : ` mode change ${o6(p.oldMode)} => ${o6(p.newMode)}\n`;
      }
    };
    for (const p of list) {
      if (p.isNew) fileModeName("create", p.newMode, p.newName as string);
      else if (p.isDelete) fileModeName("delete", p.oldMode, p.oldName as string);
      else if (p.isRename || p.isCopy) {
        const what = p.isRename ? "rename" : "copy";
        const oldFull = p.oldName as string;
        const newFull = p.newName as string;
        let o = 0;
        let n = 0;
        for (;;) {
          const so = oldFull.indexOf("/", o);
          const sn = newFull.indexOf("/", n);
          if (
            so < 0 ||
            sn < 0 ||
            so - o !== sn - n ||
            oldFull.slice(o, so) !== newFull.slice(n, sn)
          )
            break;
          o = so + 1;
          n = sn + 1;
        }
        if (o) {
          this.stdout += ` ${what} ${oldFull.slice(0, o)}{${oldFull.slice(o)} => ${newFull.slice(n)}} (${p.score}%)\n`;
        } else this.stdout += ` ${what} ${oldFull} => ${newFull} (${p.score}%)\n`;
        modeChange(p, false);
      } else if (p.score) {
        this.stdout += ` rewrite ${p.newName} (${p.score}%)\n`;
        modeChange(p, false);
      } else modeChange(p, true);
    }
  }

  private patchStats(patch: FilePatch): void {
    const lines = patch.linesAdded + patch.linesDeleted;
    if (lines > this.maxChange) this.maxChange = lines;
    for (const name of [patch.oldName, patch.newName]) {
      if (name === null) continue;
      const len = this.quote(name).length;
      if (len > this.maxLen) this.maxLen = len;
    }
  }

  // ---------------------------------------------------------------- writing

  private setIndex(
    name: string,
    entries: (ApplyIndexEntry & { stat?: Record<string, number> })[],
  ): void {
    this.indexChanges.set(name, entries);
  }

  private async removeFile(patch: FilePatch, rmdirEmpty: boolean): Promise<number> {
    const name = patch.oldName as string;
    if (this.updateIndex && !this.itaOnly) this.setIndex(name, []);
    if (!this.cached) {
      const warning = await this.io.removeWorktree(name, patch.oldMode, rmdirEmpty);
      if (warning) this.warning(warning);
    }
    return 0;
  }

  private async addIndexFile(name: string, mode: number, buf: string): Promise<number> {
    if (this.itaOnly) {
      return this.addIndexEntries(name, [
        { mode, oid: "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391", intentToAdd: true },
      ]);
    }
    if (isGitlink(mode)) {
      const m = /^Subproject commit ([0-9a-f]{40})/.exec(buf);
      if (!m) return this.error(`corrupt patch for submodule ${name}`);
      return this.addIndexEntries(name, [{ mode, oid: m[1] as string }]);
    }
    let stat: Record<string, number> | undefined;
    if (!this.cached) {
      stat = await this.io.statOf(name);
      if (!stat)
        return this.error(`unable to stat newly created file '${name}': No such file or directory`);
    }
    const oid = await this.io.writeBlob(buf);
    return this.addIndexEntries(name, [{ mode, oid, ...(stat ? { stat } : {}) }]);
  }

  private async createFile(patch: FilePatch): Promise<number> {
    const name = patch.newName as string;
    let mode = patch.newMode;
    const buf = patch.result ?? "";
    if (!mode) mode = S_IFREG | 0o644;
    if (!this.cached) {
      if (await this.pathIsBeyondSymlink(name))
        return this.error(`affected file '${name}' is beyond a symbolic link`);
      const failure = await this.io.createWorktree(name, mode, buf);
      if (failure) return this.error(failure);
    }
    if (patch.conflictedThreeway) {
      if (!this.updateIndex) return 0;
      const m = patch.newMode ? patch.newMode : S_IFREG | 0o644;
      const entries: ApplyIndexEntry[] = [];
      patch.threewayStage.forEach((oid, i) => {
        if (oid) entries.push({ mode: m, oid, stage: i + 1 });
      });
      // remove_file_from_index, then each stage added
      this.setIndex(name, []);
      return this.addIndexEntries(name, entries);
    }
    if (this.checkIndex || (this.itaOnly && patch.isNew > 0))
      return this.addIndexFile(name, mode, buf);
    return 0;
  }

  private async writeOutOneResult(patch: FilePatch, phase: number): Promise<number> {
    if (patch.isDelete > 0) return phase === 0 ? this.removeFile(patch, true) : 0;
    if (patch.isNew > 0 || patch.isCopy) return phase === 1 ? this.createFile(patch) : 0;
    if (phase === 0) return this.removeFile(patch, patch.isRename);
    return this.createFile(patch);
  }

  private async writeOutOneReject(patch: FilePatch): Promise<number> {
    const cnt = patch.fragments.filter((f) => f.rejected).length;
    if (!cnt) {
      if (this.verbosity > 0) this.sayPatchName((n) => `Applied patch ${n} cleanly.`, patch);
      return 0;
    }
    const rejects = cnt === 1 ? "reject" : "rejects";
    if (this.verbosity > -1)
      this.sayPatchName((n) => `Applying patch ${n} with ${cnt} ${rejects}...`, patch);
    const name = patch.newName as string;
    let rej = `diff a/${name} b/${name}\t(rejected hunks)\n`;
    patch.fragments.forEach((frag, i) => {
      if (!frag.rejected) {
        if (this.verbosity > -1) this.stderr += `Hunk #${i + 1} applied cleanly.\n`;
        return;
      }
      if (this.verbosity > -1) this.stderr += `Rejected hunk #${i + 1}.\n`;
      rej += frag.patch.slice(0, frag.size);
      if (!frag.patch.slice(0, frag.size).endsWith("\n")) rej += "\n";
    });
    await this.io.writeReject(`${name}.rej`, rej);
    return -1;
  }

  private async writeOutResults(list: FilePatch[]): Promise<number> {
    let errs = 0;
    const cpath: string[] = [];
    for (let phase = 0; phase < 2; phase++) {
      for (const l of list) {
        if (l.rejected) errs = 1;
        else {
          if (await this.writeOutOneResult(l, phase)) return -1;
          if (phase === 1) {
            if (await this.writeOutOneReject(l)) errs = 1;
            if (l.conflictedThreeway) {
              cpath.push(l.newName as string);
              errs = 1;
            }
          }
        }
      }
    }
    if (cpath.length) {
      cpath.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      if (this.verbosity > -1) for (const p of cpath) this.stderr += `U ${p}\n`;
      this.conflictedPaths.push(...cpath);
    }
    return errs;
  }

  /** `apply_patch` of one input: -128 fatal, -1 not applied, 0 applied, 1 applied partly. */
  async applyPatch(input: ApplyInput): Promise<number> {
    this.patchInputFile = input.name;
    this.linenr = 1;
    const buf = input.text;
    const list: FilePatch[] = [];
    let skipped = 0;
    let offset = 0;
    try {
      while (offset < buf.length) {
        const patch = newFilePatch();
        patch.inaccurateEof = this.inaccurateEof;
        patch.recount = this.recount;
        const nr = await this.parseChunk(buf, offset, buf.length - offset, patch, async (p) => {
          if (!this.usePatch(p, this.wildmatch)) return 0;
          return this.wsRuleOfName((p.newName ?? p.oldName) as string);
        });
        if (nr < 0) {
          if (nr === -128) return -128;
          break;
        }
        if (this.applyInReverse) reversePatch(patch);
        if (this.usePatch(patch, this.wildmatch)) {
          this.patchStats(patch);
          if (!list.length || !this.applyInReverse) list.push(patch);
          else list.unshift(patch);
        } else {
          if (this.verbosity > 0) this.sayPatchName((n) => `Skipped patch '${n}'.`, patch);
          skipped++;
        }
        offset += nr;
      }
      if (!list.length && !skipped) {
        if (!this.allowEmpty) {
          this.error('No valid patches in input (allow with "--allow-empty")');
          return -128;
        }
        return 0;
      }
      if (this.whitespaceError && this.wsErrorAction === "error") this.apply = false;
      this.updateIndex = (this.checkIndex || this.itaOnly) && this.apply;
      if (this.check || this.apply) {
        const r = await this.checkPatchList(list);
        if (r === -128) return -128;
        if (r < 0 && !this.applyWithReject) return -1;
      }
      if (this.apply) {
        const w = await this.writeOutResults(list);
        if (w < 0) return -128;
        if (w > 0) return this.applyWithReject ? -1 : 1;
      }
      if (this.diffstat && this.verbosity > -1) this.statPatchList(list);
      if (this.numstat && this.verbosity > -1) this.numstatPatchList(list);
      if (this.summary && this.verbosity > -1) this.summaryPatchList(list);
      return 0;
    } finally {
      this.fnTable.clear();
    }
  }

  /**
   * The file patches of an input, parsed only (what `--build-fake-ancestor` reads); a
   * negative status when the input does not parse.
   */
  async parsePatches(input: ApplyInput): Promise<FilePatch[] | number> {
    this.patchInputFile = input.name;
    this.linenr = 1;
    const buf = input.text;
    const list: FilePatch[] = [];
    let offset = 0;
    while (offset < buf.length) {
      const patch = newFilePatch();
      const nr = await this.parseChunk(buf, offset, buf.length - offset, patch, async () => 0);
      if (nr < 0) {
        if (nr === -128) return -128;
        break;
      }
      if (this.applyInReverse) reversePatch(patch);
      if (this.usePatch(patch, this.wildmatch)) list.push(patch);
      offset += nr;
    }
    return list;
  }

  /** The whitespace action when none was asked for (`set_default_whitespace_mode`). */
  setDefaultWhitespaceMode(): void {
    if (!this.whitespaceOptionGiven && this.configWhitespace === undefined)
      this.wsErrorAction = this.apply ? "warn" : "nowarn";
  }

  /**
   * `apply_all_patches`: applies each input; the exit status (0, 1, 128). `wroteIndex` says
   * whether the caller must write the index changes.
   */
  async applyAll(inputs: ApplyInput[]): Promise<{ status: number; writeIndex: boolean }> {
    let errs = 0;
    const end = (res: number) => ({
      status: res > -1 ? res : res === -1 ? 1 : 128,
      writeIndex: false,
    });
    for (const input of inputs) {
      this.setDefaultWhitespaceMode();
      const res = await this.applyPatch(input);
      if (res < 0) return end(res);
      errs |= res;
    }
    if (this.whitespaceError) {
      if (this.squelchWhitespaceErrors && this.squelchWhitespaceErrors < this.whitespaceError) {
        const squelched = this.whitespaceError - this.squelchWhitespaceErrors;
        this.warning(`squelched ${squelched} whitespace error${squelched === 1 ? "" : "s"}`);
      }
      const n = this.whitespaceError;
      if (this.wsErrorAction === "error") {
        this.error(
          n === 1 ? "1 line adds whitespace errors." : `${n} lines add whitespace errors.`,
        );
        return end(-128);
      }
      const fixed = this.appliedAfterFixingWs;
      if (fixed && this.apply)
        this.warning(
          fixed === 1
            ? "1 line applied after fixing whitespace errors."
            : `${fixed} lines applied after fixing whitespace errors.`,
        );
      else
        this.warning(
          n === 1 ? "1 line adds whitespace errors." : `${n} lines add whitespace errors.`,
        );
    }
    return { status: errs ? 1 : 0, writeIndex: this.updateIndex };
  }
}

function reversePatch(p: FilePatch): void {
  [p.newName, p.oldName] = [p.oldName, p.newName];
  if (p.newMode || p.isDelete) [p.newMode, p.oldMode] = [p.oldMode, p.newMode];
  [p.isNew, p.isDelete] = [p.isDelete, p.isNew];
  [p.linesAdded, p.linesDeleted] = [p.linesDeleted, p.linesAdded];
  [p.oldOidPrefix, p.newOidPrefix] = [p.newOidPrefix, p.oldOidPrefix];
  for (const f of p.fragments) {
    [f.newpos, f.oldpos] = [f.oldpos, f.newpos];
    [f.newlines, f.oldlines] = [f.oldlines, f.newlines];
  }
}

function fuzzyMatchLines(
  s1: string,
  a1: number,
  n1: number,
  s2: string,
  a2: number,
  n2: number,
): boolean {
  let end1 = a1 + n1;
  let end2 = a2 + n2;
  while (a1 < end1 && (s1[end1 - 1] === "\r" || s1[end1 - 1] === "\n")) end1--;
  while (a2 < end2 && (s2[end2 - 1] === "\r" || s2[end2 - 1] === "\n")) end2--;
  while (a1 < end1 && a2 < end2) {
    if (isSpaceAt(s1, a1)) {
      if (!isSpaceAt(s2, a2)) return false;
      while (a1 < end1 && isSpaceAt(s1, a1)) a1++;
      while (a2 < end2 && isSpaceAt(s2, a2)) a2++;
    } else if (s1[a1++] !== s2[a2++]) return false;
  }
  return a1 === end1 && a2 === end2;
}

export { cQuote };
