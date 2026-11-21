/**
 * git's interactive hunk selection (add-patch.c) as a library: the per-file diff is split
 * into git's hunks, a selector callback answers each prompt as a user would answer git on
 * standard input, and the selected hunks are reassembled into a patch and applied. What git
 * prints (the file headers, hunks, prompts, help and errors) is gathered as text, so a
 * terminal host can show it exactly as git does.
 *
 * The diff and the patch are "binary strings" (one byte per character); the texts given to
 * the selector and gathered in the output are decoded as paths are (`decodeGitPath`).
 */

import { compilePosixRegex, PosixRegexError } from "@statewalker/vcs-utils";

import { latin1ToBytes, latin1ToPath, pathToLatin1 } from "../apply/index.js";
import type { PatchApplyArgs, PatchMode, PatchPromptKind } from "./patch-modes.js";
import { promptIndex } from "./patch-modes.js";

/** The git version whose prompts and behaviour are reproduced. */
export type PatchCompatibility = "2.43" | "2.56";

/** One read git makes from standard input (or its editor) while selecting hunks. */
export type PatchRequest =
  | {
      /** The prompt after a hunk: answered with git's commands (`y`, `n`, `s`, `g3`, `/re`...) */
      type: "hunk";
      mode: PatchMode["name"];
      /** The file's path (the diff's `a/` side) */
      path: string;
      kind: PatchPromptKind;
      /** Index of the hunk in the file (0-based) */
      hunkIndex: number;
      hunkCount: number;
      /** The hunk as git shows it (the header hunk of a file without hunks: empty) */
      hunk: string;
      /** The prompt as git prints it, e.g. `(1/2) Stage this hunk [y,n,q,a,d,j,J,g,/,s,e,?]? ` */
      prompt: string;
      /** The commands the prompt offers, in its order (`y`, `n`, `q`, `a`, `d`, ..., `?`) */
      choices: string[];
      /** The earlier decision on this hunk (2.5x shows it as " (was: y)") */
      decision?: "y" | "n";
      /** What git would have printed so far */
      output: string;
    }
  | {
      /** The edit of a hunk (`e`): the buffer git hands its editor; answer the edited buffer */
      type: "edit";
      mode: PatchMode["name"];
      path: string;
      text: string;
    }
  | {
      /** A yes/no question ("Your edited hunk does not apply. Edit again ...", "Apply them to the worktree anyway? ") */
      type: "yesno";
      prompt: string;
    }
  | {
      /** `g` without a number: "go to which hunk? " */
      type: "goto";
      prompt: string;
    }
  | {
      /** `/` without a pattern: "search for regex? " */
      type: "search";
      prompt: string;
    }
  | {
      /**
       * `git add -i`'s menus (add-interactive.c's `list_and_choose`): the main loop's
       * "What now> " (one item), or a selection of files ("Update>> ", "Revert>> ", "Add
       * untracked>> ", "Patch update>> ", "Review diff>> "), answered with numbers, ranges
       * (`1-3`, `3-`), unique prefixes, `*`, `-` to deselect, `?` for help, an empty line to
       * finish
       */
      type: "choose";
      /** The prompt as git prints it (`What now> `, `Update>> `) */
      prompt: string;
      /** One item is chosen (the main menu), not several */
      singleton: boolean;
      /** The items listed, in their order (numbered from 1) */
      items: string[];
      /** What `git add -i` would have printed so far */
      output: string;
    };

/**
 * Answers git's reads: the line typed (without its line end), or undefined for the end of
 * input (EOF; for `edit`: the editor failed). An `edit` request is answered with the whole
 * edited buffer.
 */
export type PatchSelector = (
  request: PatchRequest,
) => string | undefined | Promise<string | undefined>;

/** What a patch selection printed and did. */
export interface PatchResult {
  /** Standard output, as git prints it: headers, hunks, prompts, help and messages */
  output: string;
  /** Standard error: git apply's errors and add-patch's `error:` lines (2.43's messages too) */
  errors: string;
  /** Paths whose selected hunks were applied */
  applied: string[];
  /** Whether the selection ended with `q` (or the end of input) */
  quit: boolean;
}

/** How the engine reaches the repository. */
export interface PatchBackend {
  /** The diff to select from (`diff-files -p`, `diff-index -p ...`), as a binary string */
  diff(): Promise<string>;
  /**
   * Runs `git apply` with the patch (a binary string); true when it applied (or, with
   * `check`, would apply). Its standard error goes to `errors`.
   */
  apply(
    patch: string,
    args: PatchApplyArgs & { check?: boolean },
  ): Promise<{ ok: boolean; errors: string }>;
  /**
   * `repo_refresh_and_write_index` of the index the selection works on: refreshed and
   * written, what it prints on standard output (`<path>: needs merge`) handed back. None for
   * an index whose refresh shows nothing (`stash -p`'s temporary one).
   */
  refresh?(): Promise<string>;
}

/** Options of {@link runAddPatch}. */
export interface AddPatchOptions {
  mode: PatchMode;
  backend: PatchBackend;
  selector: PatchSelector;
  /** Default 2.56 */
  compatibility?: PatchCompatibility;
  /** `--no-auto-advance` (2.5x): stay in a file until `q`, apply after the last file */
  autoAdvance?: boolean;
  /** `core.commentChar` / `core.commentString` (default `#`) */
  commentString?: string;
  /** `add -p` run from a command that disallows `e` (ADD_P_DISALLOW_EDIT) */
  disallowEdit?: boolean;
}

const UNDECIDED = 0;
const SKIP = 1;
const USE = 2;

interface HunkHeader {
  oldOffset: number;
  oldCount: number;
  newOffset: number;
  newCount: number;
  extraStart: number;
  extraEnd: number;
}

interface Hunk {
  start: number;
  end: number;
  splittableInto: number;
  delta: number;
  use: number;
  header: HunkHeader;
}

interface FileDiff {
  head: Hunk;
  hunks: Hunk[];
  deleted: boolean;
  added: boolean;
  modeChange: boolean;
  binary: boolean;
}

const newHunk = (): Hunk => ({
  start: 0,
  end: 0,
  splittableInto: 0,
  delta: 0,
  use: UNDECIDED,
  header: { oldOffset: 0, oldCount: 0, newOffset: 0, newCount: 0, extraStart: 0, extraEnd: 0 },
});

const copyHunk = (h: Hunk): Hunk => ({ ...h, header: { ...h.header } });

class PatchError extends Error {}

const HELP_REMAINDER_256 =
  "j - go to the next undecided hunk, roll over at the bottom\n" +
  "J - go to the next hunk, roll over at the bottom\n" +
  "k - go to the previous undecided hunk, roll over at the top\n" +
  "K - go to the previous hunk, roll over at the top\n" +
  "g - select a hunk to go to\n" +
  "/ - search for a hunk matching the given regex\n" +
  "s - split the current hunk into smaller hunks\n" +
  "e - manually edit the current hunk\n" +
  "p - print the current hunk\n" +
  "P - print the current hunk using the pager\n" +
  "> - go to the next file, roll over at the bottom\n" +
  "< - go to the previous file, roll over at the top\n" +
  "? - print help\n" +
  "HUNKS SUMMARY - Hunks: %d, USE: %d, SKIP: %d\n";

const HELP_REMAINDER_243 =
  "j - leave this hunk undecided, see next undecided hunk\n" +
  "J - leave this hunk undecided, see next hunk\n" +
  "k - leave this hunk undecided, see previous undecided hunk\n" +
  "K - leave this hunk undecided, see previous hunk\n" +
  "g - select a hunk to go to\n" +
  "/ - search for a hunk matching the given regex\n" +
  "s - split the current hunk into smaller hunks\n" +
  "e - manually edit the current hunk\n" +
  "? - print help\n";

/** `normalize_marker`: an empty context line may omit its leading space. */
function markerAt(text: string, at: number): string {
  const c = text[at];
  if (c === "\n" || (c === "\r" && text[at + 1] === "\n")) return " ";
  return c ?? "";
}

function isOctal(text: string): boolean {
  return text.length > 0 && /^[0-7]+$/.test(text);
}

/** strtoul as parse_range uses it: digits, the end offset; undefined when none. */
function parseNumber(text: string, at: number): { value: number; end: number } | undefined {
  let end = at;
  while (end < text.length && text[end] >= "0" && text[end] <= "9") end++;
  if (end === at) return undefined;
  return { value: Number(text.slice(at, end)), end };
}

/** One run of git's add-patch.c over a diff. */
class AddPatchState {
  private plain = "";
  private files: FileDiff[] = [];
  private out = "";
  private errOut = "";
  /** `s->buf`: the scratch buffer (the prompt's choices, the search's rendered hunks) */
  private buf = "";
  private readonly applied: string[] = [];
  private quitAll = false;
  private readonly modern: boolean;
  private readonly comment: string;

  constructor(private readonly options: AddPatchOptions) {
    this.modern = (options.compatibility ?? "2.56") !== "2.43";
    this.comment = options.commentString ?? "#";
  }

  private get mode(): PatchMode {
    return this.options.mode;
  }

  private get autoAdvance(): boolean {
    return !this.modern || this.options.autoAdvance !== false;
  }

  /** add-patch.c's `err()`: 2.5x prints to stdout, 2.43 to stderr */
  private err(message: string): void {
    if (this.modern) this.out += `${message}\n`;
    else this.errOut += `${message}\n`;
  }

  private error(message: string): void {
    this.errOut += `error: ${message}\n`;
  }

  private text(latin1: string): string {
    return latin1ToPath(latin1);
  }

  /** repo_refresh_and_write_index through the backend, its lines printed */
  private async refresh(): Promise<void> {
    const refresh = this.options.backend.refresh;
    if (refresh) this.out += pathToLatin1(await refresh.call(this.options.backend));
  }

  /** The marker of the line at `at`: 2.5x's `normalize_marker`, 2.43's byte as it is */
  private marker(at: number): string {
    return this.modern ? markerAt(this.plain, at) : (this.plain[at] ?? "");
  }

  async run(): Promise<PatchResult> {
    const backend = this.options.backend;
    // run_add_p: every mode but the index-only ones refreshes the index first
    if (!this.mode.indexOnly && backend.refresh) await this.refresh();
    this.plain = await backend.diff();
    if (this.plain.length > 0 && !this.plain.endsWith("\n")) this.plain += "\n";
    this.parseDiff();
    const nr = this.files.length;
    let binaryCount = 0;
    if (this.modern) {
      for (let i = 0; i < nr; ) {
        const file = this.files[i];
        if (file.binary && file.hunks.length === 0) {
          binaryCount++;
          i++;
          continue;
        }
        i = await this.patchUpdateFile(i);
        if (i === nr) break;
      }
      if (!this.autoAdvance) for (const file of this.files) await this.applyPatch(file);
    } else {
      for (let i = 0; i < nr; i++) {
        const file = this.files[i];
        if (file.binary && file.hunks.length === 0) binaryCount++;
        else if ((await this.patchUpdateFile(i)) === nr) break;
      }
    }
    if (nr === 0) this.err("No changes.");
    else if (binaryCount === nr) this.err("Only binary files changed.");
    return {
      output: this.text(this.out),
      errors: this.text(this.errOut),
      applied: this.applied,
      quit: this.quitAll,
    };
  }

  // --- parsing -------------------------------------------------------------------------

  private parseHunkHeader(hunk: Hunk): boolean {
    const plain = this.plain;
    const line = hunk.start;
    let eol = plain.indexOf("\n", line);
    if (eol < 0) eol = plain.length;
    const fail = () => {
      this.error(`could not parse hunk header '${plain.slice(line, eol)}'`);
      return false;
    };
    let p = line;
    if (!plain.startsWith("@@ -", p)) return fail();
    p += 4;
    const range = (): [number, number] | undefined => {
      const offset = parseNumber(plain, p);
      if (!offset) return undefined;
      p = offset.end;
      if (plain[p] !== ",") return [offset.value, 1];
      const count = parseNumber(plain, p + 1);
      if (!count) return undefined;
      p = count.end;
      return [offset.value, count.value];
    };
    const old = range();
    if (!old || !plain.startsWith(" +", p)) return fail();
    p += 2;
    const nu = range();
    if (!nu || !plain.startsWith(" @@", p)) return fail();
    p += 3;
    const header = hunk.header;
    [header.oldOffset, header.oldCount] = old;
    [header.newOffset, header.newCount] = nu;
    hunk.start = eol + (plain[eol] === "\n" ? 1 : 0);
    header.extraStart = p;
    header.extraEnd = hunk.start;
    return true;
  }

  private parseDiff(): void {
    const plain = this.plain;
    const pend = plain.length;
    let p = 0;
    let marker = "";
    let file: FileDiff | undefined;
    let hunk: Hunk | undefined;
    const completeFile = () => {
      if (hunk && (marker === "-" || marker === "+")) hunk.splittableInto++;
    };
    while (p !== pend) {
      let eol = plain.indexOf("\n", p);
      if (eol < 0) eol = pend;
      const ch = this.marker(p);
      let modeChange = false;
      const atHead = file !== undefined && hunk === file.head;
      if (plain.startsWith("diff ", p) || plain.startsWith("* Unmerged path ", p)) {
        completeFile();
        file = {
          head: newHunk(),
          hunks: [],
          deleted: false,
          added: false,
          modeChange: false,
          binary: false,
        };
        this.files.push(file);
        hunk = file.head;
        hunk.start = p;
        marker = "";
      } else if (!file || !hunk) {
        throw new PatchError(`diff starts with unexpected line:\n${plain.slice(p, eol)}\n`);
      } else if (file.deleted) {
        // keep the rest of the file in a single "hunk"
      } else if (plain.startsWith("@@ ", p) || (atHead && plain.startsWith("deleted file", p))) {
        const deleted = !plain.startsWith("@@ ", p);
        if (marker === "-" || marker === "+") hunk.splittableInto++;
        hunk = newHunk();
        file.hunks.push(hunk);
        hunk.start = p;
        if (deleted) file.deleted = true;
        else if (!this.parseHunkHeader(hunk)) throw new PatchError("could not parse diff");
        marker = ch;
      } else if (atHead && plain.startsWith("new file", p)) {
        file.added = true;
      } else if (atHead && plain.startsWith("old mode ", p) && isOctal(plain.slice(p + 9, eol))) {
        modeChange = true;
        file.modeChange = true;
        const pseudo = newHunk();
        pseudo.start = p;
        file.hunks.push(pseudo);
      } else if (atHead && plain.startsWith("new mode ", p) && isOctal(plain.slice(p + 9, eol))) {
        modeChange = true;
      } else if (atHead && plain.startsWith("Binary files ", p)) {
        file.binary = true;
      }
      if ((marker === "-" || marker === "+") && ch === " ") hunk.splittableInto++;
      if (marker && ch !== "\\") marker = ch;
      p = eol === pend ? pend : eol + 1;
      hunk.end = p;
      if (modeChange && file.hunks.length > 0) file.hunks[0].end = hunk.end;
    }
    completeFile();
  }

  // --- rendering -----------------------------------------------------------------------

  private renderHunk(hunk: Hunk, delta: number): string {
    const header = hunk.header;
    let out = "";
    if (header.oldOffset !== 0 || header.newOffset !== 0) {
      let oldOffset = header.oldOffset;
      let newOffset = header.newOffset;
      if (this.mode.isReverse) oldOffset -= delta;
      else newOffset += delta;
      out += `@@ -${oldOffset}`;
      if (header.oldCount !== 1) out += `,${header.oldCount}`;
      out += ` +${newOffset}`;
      if (header.newCount !== 1) out += `,${header.newCount}`;
      out += " @@";
      const extra = this.plain.slice(header.extraStart, header.extraEnd);
      out += extra.length ? extra : "\n";
    }
    return out + this.plain.slice(hunk.start, hunk.end);
  }

  private renderDiffHeader(file: FileDiff): string {
    const head = file.head;
    const first = file.hunks[0];
    const skipModeChange = file.modeChange && first.use !== USE;
    if (!skipModeChange) return this.renderHunk(head, 0);
    return this.plain.slice(head.start, first.start) + this.plain.slice(first.end, head.end);
  }

  private findNextLine(offset: number): number {
    const eol = this.plain.indexOf("\n", offset);
    return eol < 0 ? this.plain.length : eol + 1;
  }

  /**
   * merge_hunks: coalesces hunks that were split again; the merged hunk, or undefined when
   * none merged. On an error (git's `return error(...)`, which its caller takes as merged)
   * the hunk merged so far comes back and `index` stays: the next hunk is rendered on its own.
   */
  private mergeHunks(file: FileDiff, index: { i: number }, useAll: boolean): Hunk | undefined {
    let i = index.i;
    let hunk = file.hunks[i];
    if (!useAll && hunk.use !== USE) return undefined;
    const merged = copyHunk(hunk);
    const header = merged.header;
    for (; i + 1 < file.hunks.length; i++) {
      hunk = file.hunks[i + 1];
      const next = hunk.header;
      if (
        (!useAll && hunk.use !== USE) ||
        header.newOffset >= next.newOffset + merged.delta ||
        header.newOffset + header.newCount < next.newOffset + merged.delta
      ) {
        break;
      }
      let delta: number;
      if (merged.start < hunk.start && merged.end > hunk.start) {
        merged.end = hunk.end;
        delta = 0;
      } else {
        const overlappingLineCount =
          header.newOffset + header.newCount - merged.delta - next.newOffset;
        let overlapEnd = hunk.start;
        let overlapStart = overlapEnd;
        for (let j = 0; j < overlappingLineCount; j++) {
          const overlapNext = this.findNextLine(overlapEnd);
          if (overlapNext > hunk.end) {
            throw new PatchError(`failed to find ${overlappingLineCount} context lines`);
          }
          if (this.marker(overlapEnd) !== " ") {
            this.error(
              `expected context line #${j + 1} in\n${this.plain.slice(hunk.start, hunk.end)}`,
            );
            return merged;
          }
          overlapStart = overlapEnd;
          overlapEnd = overlapNext;
        }
        const len = overlapEnd - overlapStart;
        if (
          len > merged.end - merged.start ||
          this.plain.slice(merged.end - len, merged.end) !==
            this.plain.slice(overlapStart, overlapEnd)
        ) {
          this.error(
            `hunks do not overlap:\n${this.plain.slice(merged.start, merged.end)}\n\tdoes not end with:\n${this.plain.slice(overlapStart, overlapEnd)}`,
          );
          return merged;
        }
        if (merged.end !== this.plain.length) {
          const start = this.plain.length;
          this.plain += this.plain.slice(merged.start, merged.end);
          merged.start = start;
          merged.end = this.plain.length;
        }
        this.plain += this.plain.slice(overlapEnd, hunk.end);
        merged.end = this.plain.length;
        merged.splittableInto += hunk.splittableInto;
        delta = merged.delta;
        merged.delta += hunk.delta;
      }
      header.oldCount = next.oldOffset + next.oldCount - header.oldOffset;
      header.newCount = next.newOffset + delta + next.newCount - header.newOffset;
    }
    if (i === index.i) return undefined;
    index.i = i;
    return merged;
  }

  private reassemblePatch(file: FileDiff, useAll: boolean): string {
    const saveLen = this.plain.length;
    let out = this.renderDiffHeader(file);
    let delta = 0;
    for (let i = file.modeChange ? 1 : 0; i < file.hunks.length; i++) {
      let hunk = file.hunks[i];
      if (!useAll && hunk.use !== USE) {
        delta += hunk.header.oldCount - hunk.header.newCount;
      } else {
        const index = { i };
        const merged = this.mergeHunks(file, index, useAll);
        i = index.i;
        if (merged) hunk = merged;
        out += this.renderHunk(hunk, delta);
        this.plain = this.plain.slice(0, saveLen);
        delta += hunk.delta;
      }
    }
    return out;
  }

  /** split_hunk: false when the hunk cannot be split */
  private splitHunk(file: FileDiff, hunkIndex: number): boolean {
    const original = file.hunks[hunkIndex];
    if (original.splittableInto < 2) return false;
    let splittableInto = original.splittableInto;
    const end = original.end;
    const remaining = { ...original.header };
    const parts: Hunk[] = [original];
    for (let k = 1; k < splittableInto; k++) parts.push(newHunk());
    file.hunks.splice(hunkIndex, 1, ...parts);
    let n = 0;
    let hunk = parts[0];
    hunk.splittableInto = 1;
    // 2.43 kept the decision: the first part keeps it, each later one copies its neighbour's
    if (this.modern) hunk.use = UNDECIDED;
    let header = hunk.header;
    header.oldCount = 0;
    header.newCount = 0;
    let current = hunk.start;
    let marker = "";
    let contextLineCount = 0;
    let first = true;
    while (splittableInto > 1) {
      let ch = this.marker(current);
      if (!ch) throw new PatchError("buffer overrun while splitting hunks");
      if ((marker === "-" || marker === "+") && ch === " ") {
        first = false;
        parts[n + 1].start = current;
        contextLineCount = 0;
      }
      let startNew = !(marker !== " " || (ch !== "-" && ch !== "+"));
      if (startNew && first) {
        header.oldCount = contextLineCount;
        header.newCount = contextLineCount;
        contextLineCount = 0;
        first = false;
        startNew = false;
      }
      if (!startNew) {
        if (ch === "\\") ch = marker ? marker : " ";
        if (ch === " ") contextLineCount++;
        else if (ch === "-") header.oldCount++;
        else if (ch === "+") header.newCount++;
        else throw new PatchError(`unhandled diff marker: '${ch}'`);
        marker = ch;
        current = this.findNextLine(current);
        continue;
      }
      remaining.oldOffset += header.oldCount;
      remaining.oldCount -= header.oldCount;
      remaining.newOffset += header.newCount;
      remaining.newCount -= header.newCount;
      parts[n + 1].header.oldOffset = header.oldOffset + header.oldCount;
      parts[n + 1].header.newOffset = header.newOffset + header.newCount;
      header.oldCount += contextLineCount;
      header.newCount += contextLineCount;
      hunk.end = current;
      n++;
      hunk = parts[n];
      hunk.splittableInto = 1;
      hunk.use = this.modern ? UNDECIDED : parts[n - 1].use;
      header = hunk.header;
      header.oldCount = contextLineCount;
      header.newCount = contextLineCount;
      contextLineCount = 0;
      splittableInto--;
      marker = ch;
    }
    header.oldCount = remaining.oldCount;
    header.newCount = remaining.newCount;
    hunk.end = end;
    return true;
  }

  // --- editing -------------------------------------------------------------------------

  private commented(text: string): string {
    let out = "";
    const lines = text.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    for (const line of lines) {
      out += this.comment;
      if (line.length > 0 && line[0] !== "\t") out += " ";
      out += `${line}\n`;
    }
    return out;
  }

  /** edit_hunk_manually: 1 edited, 0 abandoned, -1 failed */
  private async editHunkManually(file: FileDiff, hunk: Hunk): Promise<number> {
    const comment = this.comment;
    let buffer = this.commented("Manual hunk edit mode -- see bottom for a quick guide.\n");
    buffer += this.renderHunk(hunk, 0);
    buffer += this.commented(
      "---\n" +
        `To remove '${this.mode.isReverse ? "+" : "-"}' lines, make them ' ' lines (context).\n` +
        `To remove '${this.mode.isReverse ? "-" : "+"}' lines, delete them.\n` +
        `Lines starting with ${comment} will be removed.\n`,
    );
    buffer += this.commented(this.mode.editHunkHint);
    buffer += this.commented(
      "If it does not apply cleanly, you will be given an opportunity to\n" +
        "edit again.  If all lines of the hunk are removed, then the edit is\n" +
        "aborted and the hunk is left unchanged.\n",
    );
    const answer = await this.options.selector({
      type: "edit",
      mode: this.mode.name,
      path: this.filePath(file),
      text: this.text(buffer),
    });
    if (answer === undefined) {
      this.error("could not edit 'addp-hunk-edit.diff'"); // an editor failure
      return -1;
    }
    const edited = pathToLatin1(answer);
    hunk.start = this.plain.length;
    let i = 0;
    while (i < edited.length) {
      const eol = edited.indexOf("\n", i);
      const next = eol < 0 ? edited.length : eol + 1;
      if (!edited.startsWith(comment, i)) this.plain += edited.slice(i, next);
      i = next;
    }
    hunk.end = this.plain.length;
    if (hunk.end === hunk.start) return 0;
    if (this.plain[hunk.start] === "@" && !this.parseHunkHeader(hunk)) {
      this.error("could not parse hunk header");
      return -1;
    }
    return 1;
  }

  private recountEditedHunk(hunk: Hunk, origOld: number, origNew: number): number {
    const header = hunk.header;
    if (!this.modern) {
      // 2.43: the counts only (splittable_into kept), a bare line end counting as context
      header.oldCount = 0;
      header.newCount = 0;
      for (let i = hunk.start; i < hunk.end; i = this.findNextLine(i)) {
        const ch = this.plain[i];
        if (ch === "-") header.oldCount++;
        else if (ch === "+") header.newCount++;
        else if (ch === " " || ch === "\r" || ch === "\n") {
          header.oldCount++;
          header.newCount++;
        }
      }
      return origOld - origNew - header.oldCount + header.newCount;
    }
    hunk.splittableInto = 0;
    header.oldCount = 0;
    header.newCount = 0;
    let marker = " ";
    for (let i = hunk.start; i < hunk.end; i = this.findNextLine(i)) {
      const ch = markerAt(this.plain, i);
      if (ch === "-") {
        header.oldCount++;
        if (marker === " ") hunk.splittableInto++;
        marker = ch;
      } else if (ch === "+") {
        header.newCount++;
        if (marker === " ") hunk.splittableInto++;
        marker = ch;
      } else if (ch === " ") {
        header.oldCount++;
        header.newCount++;
        marker = ch;
      }
    }
    return origOld - origNew - header.oldCount + header.newCount;
  }

  private async runApplyCheck(file: FileDiff): Promise<boolean> {
    const patch = this.reassemblePatch(file, true);
    const r = await this.options.backend.apply(patch, {
      ...this.mode.applyCheckArgs,
      check: true,
    });
    this.errOut += r.errors;
    if (!r.ok) {
      this.error("'git apply --cached' failed");
      return false;
    }
    return true;
  }

  /** prompt_yesno: 1 yes, 0 no, -1 end of input */
  private async promptYesNo(prompt: string): Promise<number> {
    for (;;) {
      this.out += prompt;
      const answer = await this.options.selector({ type: "yesno", prompt });
      if (answer === undefined) return -1;
      const c = answer[0]?.toLowerCase();
      if (c === "n") return 0;
      if (c === "y") return 1;
    }
  }

  private async editHunkLoop(file: FileDiff, index: number): Promise<number> {
    const plainLen = this.plain.length;
    const backup = copyHunk(file.hunks[index]);
    for (;;) {
      const hunk = file.hunks[index];
      const res = await this.editHunkManually(file, hunk);
      if (res === 0) {
        file.hunks[index] = backup;
        return -1;
      }
      if (res > 0) {
        hunk.delta += this.recountEditedHunk(hunk, backup.header.oldCount, backup.header.newCount);
        if (await this.runApplyCheck(file)) return 0;
      }
      this.plain = this.plain.slice(0, plainLen);
      file.hunks[index] = copyHunk(backup);
      const yes = await this.promptYesNo(
        'Your edited hunk does not apply. Edit again (saying "no" discards!) [y/n]? ',
      );
      if (yes < 1) return -1;
    }
  }

  // --- applying ------------------------------------------------------------------------

  private async applyForCheckout(patch: string, reverse: boolean): Promise<void> {
    const backend = this.options.backend;
    const index = await backend.apply(patch, { cached: true, reverse, check: true });
    const worktree = await backend.apply(patch, { cached: false, reverse, check: true });
    if (index.ok && worktree.ok) {
      this.errOut += (await backend.apply(patch, { cached: true, reverse })).errors;
      this.errOut += (await backend.apply(patch, { cached: false, reverse })).errors;
      return;
    }
    this.errOut += index.errors + worktree.errors;
    if (!index.ok) {
      this.err("The selected hunks do not apply to the index!");
      if ((await this.promptYesNo("Apply them to the worktree anyway? ")) > 0) {
        this.errOut += (await backend.apply(patch, { cached: false, reverse })).errors;
        return;
      }
      this.err("Nothing was applied.\n");
    } else if (this.modern) {
      // as a last resort, the diff is shown (2.43 wrote it to stderr)
      this.out += patch;
    } else {
      this.errOut += patch;
    }
  }

  private async applyPatch(file: FileDiff): Promise<void> {
    const any = file.hunks.some((h) => h.use === USE);
    if (!any && !(file.hunks.length === 0 && file.head.use === USE)) return;
    const patch = this.reassemblePatch(file, false);
    if (this.mode.applyForCheckout) {
      await this.applyForCheckout(patch, this.mode.isReverse);
    } else {
      const r = await this.options.backend.apply(
        patch,
        this.mode.applyArgs ?? {
          cached: false,
          reverse: false,
        },
      );
      this.errOut += r.errors;
      if (!r.ok) this.error("'git apply' failed");
    }
    // the index read back and refreshed after the apply
    await this.refresh();
    this.applied.push(this.filePath(file));
  }

  private filePath(file: FileDiff): string {
    const line = this.plain.slice(file.head.start, this.plain.indexOf("\n", file.head.start));
    const m = /^diff --git "?[ab]\/(.*?)"? "?[ab]\//.exec(line);
    if (m) return this.text(m[1]);
    const u = /^\* Unmerged path (.*)$/.exec(line);
    return this.text(u ? u[1] : line);
  }

  // --- the prompt loop -----------------------------------------------------------------

  private summarizeHunk(hunk: Hunk): string {
    const h = hunk.header;
    let out = ` -${h.oldOffset},${h.oldCount} +${h.newOffset},${h.newCount} `;
    if (out.length < 20) out += " ".repeat(20 - out.length);
    let i = hunk.start;
    for (; i < hunk.end; i = this.findNextLine(i)) if (this.plain[i] !== " ") break;
    if (i < hunk.end) out += this.plain.slice(i, this.findNextLine(i));
    if (out.length > 80) out = out.slice(0, 80);
    if (!out.endsWith("\n")) out += "\n";
    return out;
  }

  private displayHunks(file: FileDiff, start: number): number {
    const end = Math.min(start + 20, file.hunks.length);
    for (let i = start; i < end; i++) {
      const hunk = file.hunks[i];
      const mark = hunk.use === USE ? "+" : hunk.use === SKIP ? "-" : " ";
      this.out += `${mark}${String(i + 1).padStart(2)}: ${this.summarizeHunk(hunk)}`;
    }
    return end;
  }

  private matches(regex: ReturnType<typeof compilePosixRegex>, text: string): boolean {
    // REG_NEWLINE: each line on its own
    for (const line of text.split("\n")) {
      if (regex.test(latin1ToBytes(line))) return true;
    }
    return false;
  }

  /** patch_update_file: the index of the next file (2.43: `files.length` to quit) */
  private async patchUpdateFile(idx: number): Promise<number> {
    const file = this.files[idx];
    const modern = this.modern;
    const nr = this.files.length;
    let resp = idx;
    if (file.hunks.length === 0 && !file.added) return idx + 1;
    this.out += this.renderDiffHeader(file);
    let hunkIndex = 0;
    let renderedHunkIndex = -1;
    let allDecided = false;
    // 2.43 never cleared its permissions between prompts of one file
    const sticky = new Set<string>();
    for (;;) {
      const count = file.hunks.length;
      if (hunkIndex >= count || hunkIndex < 0) hunkIndex = 0;
      const hunk = count ? file.hunks[hunkIndex] : file.head;
      let undecidedPrevious = -1;
      let undecidedNext = -1;
      if (count) {
        if (modern) {
          for (
            let i = (hunkIndex + count - 1) % count;
            i !== hunkIndex;
            i = (i + count - 1) % count
          )
            if (file.hunks[i].use === UNDECIDED) {
              undecidedPrevious = i;
              break;
            }
          for (let i = (hunkIndex + 1) % count; i !== hunkIndex; i = (i + 1) % count)
            if (file.hunks[i].use === UNDECIDED) {
              undecidedNext = i;
              break;
            }
        } else {
          for (let i = hunkIndex - 1; i >= 0; i--)
            if (file.hunks[i].use === UNDECIDED) {
              undecidedPrevious = i;
              break;
            }
          for (let i = hunkIndex + 1; i < count; i++)
            if (file.hunks[i].use === UNDECIDED) {
              undecidedNext = i;
              break;
            }
        }
      }
      if (undecidedPrevious < 0 && undecidedNext < 0 && hunk.use !== UNDECIDED) {
        if (!this.autoAdvance) allDecided = true;
        else {
          if (modern) resp++;
          break;
        }
      }
      const permitted = modern ? new Set<string>() : sticky;
      let choices = "";
      let rendered = "";
      if (count) {
        if (!modern || renderedHunkIndex !== hunkIndex) {
          rendered = this.renderHunk(hunk, 0);
          this.out += rendered;
          renderedHunkIndex = hunkIndex;
        } else {
          rendered = this.renderHunk(hunk, 0);
        }
        const allow = (key: string, letters: string) => {
          permitted.add(key);
          choices += letters;
        };
        if (undecidedPrevious >= 0) allow("k", ",k");
        if (modern ? count > 1 : hunkIndex > 0) allow("K", ",K");
        if (undecidedNext >= 0) allow("j", ",j");
        if (modern ? count > 1 : hunkIndex + 1 < count) allow("J", ",J");
        if (count > 1) allow("g", ",g,/");
        if (hunk.splittableInto > 1) allow("s", ",s");
        if (
          !this.options.disallowEdit &&
          hunkIndex + 1 > (file.modeChange ? 1 : 0) &&
          !file.deleted
        ) {
          allow("e", ",e");
        }
        if (modern && !this.autoAdvance && nr > 1) {
          allow(">", ",>");
          allow("<", ",<");
        }
        if (modern) choices += ",p,P";
      }
      this.buf = choices;
      const kind: PatchPromptKind = file.deleted
        ? "deletion"
        : file.added
          ? "addition"
          : file.modeChange && hunkIndex === 0
            ? "mode-change"
            : "hunk";
      const decision = hunk.use === USE ? "y" : hunk.use === SKIP ? "n" : undefined;
      let template = this.mode.promptMode[promptIndex(kind)];
      if (modern) {
        template = template.replace("%s", decision ? ` (was: ${decision})` : "");
      } else {
        template = template.replace("%s", "");
      }
      const prompt = `(${hunkIndex + 1}/${count || 1}) ${template.replace("%s", choices)}`;
      this.out += prompt;
      const answer = await this.options.selector({
        type: "hunk",
        mode: this.mode.name,
        path: this.filePath(file),
        kind,
        hunkIndex,
        hunkCount: count || 1,
        hunk: this.text(rendered),
        prompt: this.text(prompt),
        choices: ["y", "n", "q", "a", "d", ...choices.split(",").filter(Boolean), "?"],
        ...(decision ? { decision } : {}),
        output: this.text(this.out),
      });
      if (answer === undefined) {
        if (modern) {
          resp = nr;
          this.quitAll = true;
        }
        break;
      }
      let line = answer.replace(/\r?\n$/, "");
      if (line.length === 0) continue;
      const ch = line[0].toLowerCase();
      const c0 = line[0];
      if (modern && line.length !== 1 && ch !== "g" && ch !== "/") {
        this.err(`Only one letter is expected, got '${line}'`);
        continue;
      }
      const softIncrement = () => {
        hunkIndex = undecidedNext < 0 ? count : undecidedNext;
      };
      const firstUndecided = () => {
        const i = file.hunks.findIndex((h) => h.use === UNDECIDED);
        return modern ? (i < 0 ? 0 : i) : hunkIndex;
      };
      if (ch === "y") {
        hunk.use = USE;
        softIncrement();
      } else if (ch === "n") {
        hunk.use = SKIP;
        softIncrement();
      } else if (ch === "a" || ch === "d") {
        const use = ch === "a" ? USE : SKIP;
        if (count) {
          for (; hunkIndex < count; hunkIndex++) {
            if (file.hunks[hunkIndex].use === UNDECIDED) file.hunks[hunkIndex].use = use;
          }
          hunkIndex = firstUndecided();
        } else if (hunk.use === UNDECIDED) {
          hunk.use = use;
        }
      } else if (ch === "q") {
        resp = nr;
        this.quitAll = true;
        break;
      } else if (modern && !this.autoAdvance && c0 === ">") {
        if (permitted.has(">")) {
          resp = resp === nr - 1 ? 0 : resp + 1;
          break;
        }
        this.err("No next file");
      } else if (modern && !this.autoAdvance && c0 === "<") {
        if (permitted.has("<")) {
          resp = resp === 0 ? nr - 1 : resp - 1;
          break;
        }
        this.err("No previous file");
      } else if (c0 === "K") {
        if (permitted.has("K"))
          hunkIndex = modern ? (hunkIndex + count - 1) % count : hunkIndex - 1;
        else this.err(modern ? "No other hunk" : "No previous hunk");
      } else if (c0 === "J") {
        if (permitted.has("J")) hunkIndex++;
        else this.err(modern ? "No other hunk" : "No next hunk");
      } else if (c0 === "k") {
        if (permitted.has("k")) hunkIndex = undecidedPrevious;
        else this.err(modern ? "No other undecided hunk" : "No previous hunk");
      } else if (c0 === "j") {
        if (permitted.has("j")) hunkIndex = undecidedNext;
        else this.err(modern ? "No other undecided hunk" : "No next hunk");
      } else if (c0 === "g") {
        if (!permitted.has("g")) {
          this.err("No other hunks to goto");
          continue;
        }
        line = line.slice(1).trim();
        let i = hunkIndex - 10;
        const first = file.modeChange ? 1 : 0;
        if (i < first) i = first;
        while (line.length === 0) {
          i = this.displayHunks(file, i);
          const goPrompt =
            i < count ? "go to which hunk (<ret> to see more)? " : "go to which hunk? ";
          this.out += goPrompt;
          const reply = await this.options.selector({ type: "goto", prompt: goPrompt });
          if (reply === undefined) break;
          line = reply.replace(/\r?\n$/, "");
        }
        line = line.trim();
        const m = /^([+-]?)(\d+)$/.exec(line);
        if (!m) this.err(`Invalid number: '${line}'`);
        else {
          const response = m[1] === "-" && Number(m[2]) !== 0 ? -1 : Number(m[2]);
          if (response > 0 && response <= count) hunkIndex = response - 1;
          else this.err(`Sorry, only ${count} hunk${count === 1 ? "" : "s"} available.`);
        }
      } else if (c0 === "/") {
        if (!permitted.has("g")) {
          this.err("No other hunks to search");
          continue;
        }
        line = line.slice(1).replace(/\r?\n$/, "");
        if (line.length === 0) {
          const searchPrompt = "search for regex? ";
          this.out += searchPrompt;
          const reply = await this.options.selector({ type: "search", prompt: searchPrompt });
          if (reply === undefined) break;
          line = reply.replace(/\r?\n$/, "");
          if (line.length === 0) continue;
        }
        let regex: ReturnType<typeof compilePosixRegex>;
        try {
          regex = compilePosixRegex(latin1ToBytes(pathToLatin1(line)), { extended: true });
        } catch (error) {
          if (!(error instanceof PosixRegexError)) throw error;
          this.err(`Malformed search regexp ${line}: ${error.message}`);
          continue;
        }
        let i = hunkIndex;
        for (;;) {
          this.buf += this.renderHunk(file.hunks[i], 0);
          if (this.matches(regex, this.buf)) break;
          i++;
          if (i === count) i = 0;
          if (i !== hunkIndex) continue;
          this.err("No hunk matches the given pattern");
          break;
        }
        hunkIndex = i;
      } else if (c0 === "s") {
        const into = hunk.splittableInto;
        if (!permitted.has("s")) this.err("Sorry, cannot split this hunk");
        else {
          if (into >= 2) this.splitHunk(file, hunkIndex);
          this.out += `Split into ${into} hunks.\n`;
          renderedHunkIndex = -1;
        }
      } else if (c0 === "e") {
        if (!permitted.has("e")) this.err("Sorry, cannot edit this hunk");
        else if ((await this.editHunkLoop(file, hunkIndex)) >= 0) {
          file.hunks[hunkIndex].use = USE;
          softIncrement();
        }
      } else if (modern && ch === "p") {
        renderedHunkIndex = -1;
      } else if (!modern || c0 === "?") {
        this.out += this.mode.helpPatchText;
        const remainder = modern ? HELP_REMAINDER_256 : HELP_REMAINDER_243;
        for (const helpLine of remainder.split("\n")) {
          if (!helpLine) continue;
          if (allDecided && helpLine.startsWith("HUNKS SUMMARY")) {
            const used = file.hunks.filter((h) => h.use === USE).length;
            const skipped = file.hunks.filter((h) => h.use === SKIP).length;
            this.out += `${helpLine
              .replace("%d", String(count))
              .replace("%d", String(used))
              .replace("%d", String(skipped))}\n`;
          }
          if (helpLine[0] !== "?" && !this.buf.includes(helpLine[0])) continue;
          this.out += `${helpLine}\n`;
        }
      } else {
        this.err(`Unknown command '${line}' (use '?' for help)`);
      }
    }
    if (this.autoAdvance) await this.applyPatch(file);
    this.out += "\n";
    return modern ? resp : this.quitAll ? nr : idx + 1;
  }
}

/**
 * Runs git's interactive hunk selection: the backend's diff is split into hunks, each
 * prompt goes to the selector, and the selected hunks are applied through the backend.
 *
 * @example
 * ```typescript
 * const answers = ["y", "n", "s", "y", "q"];
 * const result = await runAddPatch({
 *   mode: PATCH_MODES.stage,
 *   backend,
 *   selector: () => answers.shift(),
 * });
 * process.stdout.write(result.output);
 * ```
 */
export async function runAddPatch(options: AddPatchOptions): Promise<PatchResult> {
  return new AddPatchState(options).run();
}
