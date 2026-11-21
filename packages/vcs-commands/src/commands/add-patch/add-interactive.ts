/**
 * `git add -i` (add-interactive.c's `run_add_i`) as a library: the status listing, the
 * "*** Commands ***" menu and its actions (status, update, revert, add untracked, patch,
 * diff, quit, help), each read git makes from standard input answered by the selector (a
 * `choose` request for the menus, the hunk prompts of patch mode as `add -p` asks them), and
 * what git prints gathered as its standard output and standard error.
 */

import { EMPTY_TREE_ID, type ObjectId } from "@statewalker/vcs-core";
import type { ResolveUndoRecord, StagingEntry } from "@statewalker/vcs-working-tree";

import { GitCommand } from "../../git-command.js";
import type { WorkingCopy } from "../../types.js";
import { DiffCommand } from "../diff-command.js";
import { addLeadingDirs, stageZeroClashes } from "../index-adder.js";
import { flatTree, rewriteIndex } from "../merge-support.js";
import { StatusCommand } from "../status-command.js";
import type { PatchCompatibility, PatchRequest, PatchSelector } from "./add-patch.js";
import { IndexRefresh } from "./patch-backend.js";
import { patchModeFor } from "./patch-modes.js";
import { type PatchOptions, runPatchSelection } from "./patch-session.js";

/** What `git add -i` printed and staged. */
export interface AddInteractiveResult {
  /** Standard output, as git prints it: listings, menus, prompts, help, patch mode's transcript */
  output: string;
  /** Standard error: `Huh (...)?`, `ignoring unmerged: ...`, patch mode's errors */
  errors: string;
  /** Paths staged by update, add untracked and patch, in order */
  added: string[];
  /** Paths reverted to HEAD */
  reverted: string[];
}

/** The `git add` a session runs for update and add untracked (`add_file_to_index`). */
export type InteractiveAdder = (options: { paths: string[]; update: boolean }) => Promise<void>;

/** Options of {@link runAddInteractive}. */
export interface AddInteractiveOptions extends PatchOptions {
  selector: PatchSelector;
  /** The pathspec `git add -i <pathspec>` was given */
  paths?: string[];
  /** Default 2.56 */
  compatibility?: PatchCompatibility;
  /** Stages paths as `add_file_to_index` does (an `AddCommand`) */
  add: InteractiveAdder;
  /** The command running the session: hooks of the index writes run in its session */
  hookSource?: GitCommand<unknown>;
}

interface AddDel {
  add: number;
  del: number;
  seen: boolean;
  unmerged: boolean;
  binary: boolean;
}

interface Item {
  name: string;
  prefixLength: number;
  index: AddDel;
  worktree: AddDel;
}

const newAddDel = (): AddDel => ({ add: 0, del: 0, seen: false, unmerged: false, binary: false });
const newItem = (name: string): Item => ({
  name,
  prefixLength: 0,
  index: newAddDel(),
  worktree: newAddDel(),
});

/** strcmp's order (the paths' code points, as their UTF-8 bytes sort) */
const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const isAscii = (c: string | undefined) => c !== undefined && c.charCodeAt(0) < 0x80;
const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";
const SEPARATORS = " \t\r\n,";

/** strcspn(s, " \t\r\n,") from `at` */
function separatorSpan(s: string, at: number): number {
  let n = 0;
  while (at + n < s.length && !SEPARATORS.includes(s[at + n])) n++;
  return n;
}

/** `find_unique_prefixes`: each item's shortest unique prefix (1 to 4 ASCII characters). */
function findUniquePrefixes(items: Item[]): Item[] {
  const sorted = [...items].sort((a, b) => byName(a.name, b.name));
  const extend = (item: Item, other: string) => {
    let len = item.prefixLength;
    if (!len || item.name.slice(0, len) !== other.slice(0, len)) return;
    for (;;) {
      const c = item.name[len];
      if (c === undefined || ++len > 4 || !isAscii(c)) {
        len = 0;
        break;
      }
      if (c !== other[len - 1]) break;
    }
    item.prefixLength = len;
  };
  for (let i = 0; i < sorted.length; i++) {
    const item = sorted[i];
    item.prefixLength = 0;
    const c = item.name[0];
    item.prefixLength = c === undefined || !isAscii(c) ? 0 : 1;
    if (i > 0) extend(item, sorted[i - 1].name);
    if (i + 1 < sorted.length) extend(item, sorted[i + 1].name);
  }
  return sorted;
}

/** `find_unique`: the index of the item `s` names (exactly or by a unique prefix), or -1. */
function findUnique(s: string, items: Item[], sorted: Item[]): number {
  // string_list_find_insert_index
  let lo = 0;
  let hi = sorted.length;
  let exact = false;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const cmp = byName(sorted[mid].name, s);
    if (cmp === 0) {
      lo = mid;
      exact = true;
      break;
    }
    if (cmp < 0) lo = mid + 1;
    else hi = mid;
  }
  const index = lo;
  let item: Item;
  if (exact) item = sorted[index];
  else if (index > 0 && sorted[index - 1].name.startsWith(s)) return -1;
  else if (index + 1 < sorted.length && sorted[index + 1].name.startsWith(s)) return -1;
  else if (index < sorted.length && sorted[index].name.startsWith(s)) item = sorted[index];
  else return -1;
  return items.indexOf(item);
}

/** `is_valid_prefix`: a prefix that means nothing else to list_and_choose. */
function isValidPrefix(name: string, length: number): boolean {
  return (
    length > 0 &&
    separatorSpan(name, 0) >= length &&
    name[0] !== "-" &&
    !isDigit(name[0]) &&
    (length !== 1 || (name[0] !== "*" && name[0] !== "?"))
  );
}

/** `%12s` */
const pad12 = (s: string) => s.padStart(12);

function renderAddDel(ad: AddDel, noChanges: string): string {
  if (ad.binary) return "binary";
  if (ad.seen) return `+${ad.add}/-${ad.del}`;
  return noChanges;
}

/** strtoul from `at` (digits only: the caller checked the first is one) */
function parseNumber(s: string, at: number): { value: number; end: number } {
  let end = at;
  while (isDigit(s[end])) end++;
  return { value: Number(s.slice(at, end)), end };
}

const LIST_AND_CHOOSE_ERROR = -1;
const LIST_AND_CHOOSE_QUIT = -2;

interface ListOptions {
  columns: number;
  header?: string;
  print: (i: number, selected: boolean, item: Item) => string;
}

interface ChooseOptions {
  list: ListOptions;
  prompt: string;
  singleton: boolean;
  immediate: boolean;
  help: () => void;
}

type Filter = "none" | "worktree-only" | "index-only";

/** A `git add -i` session (run_add_i). */
class AddInteractiveSession extends GitCommand<AddInteractiveResult> {
  private out = "";
  private err = "";
  private readonly added: string[] = [];
  private readonly reverted: string[] = [];
  private files: Item[] = [];
  /** `files.selected` of the last multi-selection */
  private selected: boolean[] = [];
  /** Whether the files' prefixes are computed (`sorted.nr == items.nr`) */
  private filesSorted?: Item[];
  private onlyNames = false;
  private header = "";

  constructor(
    workingCopy: WorkingCopy,
    private readonly options: AddInteractiveOptions,
  ) {
    super(workingCopy);
  }

  private get modern(): boolean {
    return (this.options.compatibility ?? "2.56") !== "2.43";
  }

  private sharing<T extends GitCommand<unknown>>(command: T): T {
    const source = this.options.hookSource;
    return source ? command.shareHooksOf(source) : command;
  }

  async call(): Promise<AddInteractiveResult> {
    this.checkCallable();
    this.setCallable(false);
    const commands: Item[] = [
      "status",
      "update",
      "revert",
      "add untracked",
      "patch",
      "diff",
      "quit",
      "help",
    ].map(newItem);
    const commandsSorted = findUniquePrefixes(commands);
    this.header = `     ${pad12("staged")} ${pad12("unstaged")} path`;
    const mainLoop: ChooseOptions = {
      list: {
        columns: 4,
        header: "*** Commands ***",
        print: (i, _selected, item) => {
          const n = String(i + 1).padStart(2);
          if (!item.prefixLength || !isValidPrefix(item.name, item.prefixLength)) {
            return ` ${n}: ${item.name}`;
          }
          return ` ${n}: [${item.name.slice(0, item.prefixLength)}]${item.name.slice(item.prefixLength)}`;
        },
      },
      prompt: "What now",
      singleton: true,
      immediate: true,
      help: () => {
        this.out +=
          "Prompt help:\n" +
          "1          - select a numbered item\n" +
          "foo        - select item based on unique prefix\n" +
          "           - (empty) select nothing\n";
      },
    };
    // repo_refresh_and_write_index (REFRESH_QUIET): its `needs merge` lines go to stdout
    try {
      this.out += await this.sharing(new IndexRefresh(this.workingCopy)).call();
    } catch {
      this.err += "warning: could not refresh index\n";
    }
    await this.runStatus();
    for (;;) {
      const i = await this.listAndChoose(commands, commandsSorted, mainLoop);
      const name = i >= 0 && i < commands.length ? commands[i].name : undefined;
      if (i === LIST_AND_CHOOSE_QUIT || name === "quit") {
        this.out += "Bye.\n";
        break;
      }
      switch (name) {
        case "status":
          await this.runStatus();
          break;
        case "update":
          await this.runUpdate();
          break;
        case "revert":
          await this.runRevert();
          break;
        case "add untracked":
          await this.runAddUntracked();
          break;
        case "patch":
          await this.runPatch();
          break;
        case "diff":
          await this.runDiff();
          break;
        case "help":
          this.runHelp();
          break;
      }
    }
    return { output: this.out, errors: this.err, added: this.added, reverted: this.reverted };
  }

  /** The options of the file selections (`opts` of run_add_i) */
  private fileChooser(prompt: string, immediate = false): ChooseOptions {
    return {
      list: {
        columns: 0,
        header: this.header,
        print: (i, selected, item) => {
          let name = item.name;
          if (item.prefixLength > 0 && isValidPrefix(item.name, item.prefixLength)) {
            name = `[${item.name.slice(0, item.prefixLength)}]${item.name.slice(item.prefixLength)}`;
          }
          const lead = `${selected ? "*" : " "}${String(i + 1).padStart(2)}: `;
          if (this.onlyNames) return `${lead}${name}`;
          const worktree = renderAddDel(item.worktree, "nothing");
          const index = renderAddDel(item.index, "unchanged");
          return `${lead}${pad12(index)} ${pad12(worktree)} ${name}`;
        },
      },
      prompt,
      singleton: false,
      immediate,
      help: () => {
        this.out +=
          "Prompt help:\n" +
          "1          - select a single item\n" +
          "3-5        - select a range of items\n" +
          "2-3,6-9    - select multiple ranges\n" +
          "foo        - select item based on unique prefix\n" +
          "-...       - unselect specified items\n" +
          "*          - choose all items\n" +
          "           - (empty) finish selecting\n";
      },
    };
  }

  /** `list()` */
  private list(items: Item[], selected: boolean[] | undefined, options: ListOptions): void {
    if (items.length === 0) return;
    if (options.header !== undefined) this.out += `${options.header}\n`;
    let lastLf = false;
    for (let i = 0; i < items.length; i++) {
      this.out += options.print(i, selected?.[i] ?? false, items[i]);
      if (options.columns && (i + 1) % options.columns) {
        this.out += "\t";
        lastLf = false;
      } else {
        this.out += "\n";
        lastLf = true;
      }
    }
    if (!lastLf) this.out += "\n";
  }

  /**
   * `list_and_choose`: the selected index for a singleton, else the number of items
   * selected; LIST_AND_CHOOSE_ERROR, or LIST_AND_CHOOSE_QUIT at the end of input (immediate).
   */
  private async listAndChoose(
    items: Item[],
    sorted: Item[],
    options: ChooseOptions,
  ): Promise<number> {
    const { singleton, immediate } = options;
    let res = singleton ? LIST_AND_CHOOSE_ERROR : 0;
    const selected = singleton ? undefined : items.map(() => false);
    if (selected) this.selected = selected;
    for (;;) {
      this.list(items, selected, options.list);
      const prompt = `${options.prompt}${singleton ? "> " : ">> "}`;
      this.out += prompt;
      const request: PatchRequest = {
        type: "choose",
        prompt,
        singleton,
        items: items.map((item) => item.name),
        output: this.out,
      };
      const reply = await this.options.selector(request);
      if (reply === undefined) {
        this.out += "\n";
        if (immediate) res = LIST_AND_CHOOSE_QUIT;
        break;
      }
      // git_read_line_interactively: the line without its line end
      const input = reply.replace(/\r?\n$/, "");
      if (input.length === 0) break;
      if (input === "?") {
        options.help();
        continue;
      }
      // the C string the input is once its tokens are cut (each token's end gets a NUL)
      let firstNul = -1;
      let p = 0;
      for (;;) {
        let sep = separatorSpan(input, p);
        let choose = true;
        let from = -1;
        let to = -1;
        if (!sep) {
          if (p >= input.length) break;
          p++;
          continue;
        }
        if (input[p] === "-") {
          choose = false;
          p++;
          sep--;
        }
        if (sep === 1 && input[p] === "*") {
          from = 0;
          to = items.length;
        } else if (isDigit(input[p])) {
          const first = parseNumber(input, p);
          from = first.value - 1;
          let endp = first.end;
          if (endp === p + sep) to = from + 1;
          else if (input[endp] === "-") {
            endp++;
            if (isDigit(input[endp])) {
              const second = parseNumber(input, endp);
              to = second.value;
              endp = second.end;
            } else to = items.length;
            if (endp !== p + sep) from = -1;
          }
        }
        const token = input.slice(p, p + sep);
        if (p + sep < input.length) {
          if (firstNul < 0) firstNul = p + sep;
          sep++;
        }
        if (from < 0) {
          from = findUnique(token, items, sorted);
          if (from >= 0) to = from + 1;
        }
        if (from < 0 || from >= items.length || (singleton && from + 1 !== to)) {
          this.err += `Huh (${token})?\n`;
          break;
        } else if (singleton) {
          res = from;
          break;
        }
        // `to` (signed) against the item count (unsigned): -1 (`5x`) runs to the end
        if (to < 0 || to > items.length) to = items.length;
        for (; from < to; from++) {
          if ((selected as boolean[])[from] !== choose) {
            (selected as boolean[])[from] = choose;
            res += choose ? 1 : -1;
          }
        }
        p += sep;
      }
      const cString = firstNul < 0 ? input : input.slice(0, firstNul);
      if ((immediate && res !== LIST_AND_CHOOSE_ERROR) || cString === "*") break;
    }
    return res;
  }

  /** The files a multi-selection chose */
  private chosen(): string[] {
    return this.files.filter((_, i) => this.selected[i]).map((item) => item.name);
  }

  /** The files list's sorted view, computed once per list (find_unique_prefixes) */
  private sortedFiles(): Item[] {
    if (!this.filesSorted) this.filesSorted = findUniquePrefixes(this.files);
    return this.filesSorted;
  }

  private setFiles(files: Item[]): void {
    this.files = files;
    this.filesSorted = undefined;
  }

  /** HEAD's commit, undefined on an unborn branch */
  private async headId(): Promise<ObjectId | undefined> {
    try {
      return await this.resolveRevision("HEAD");
    } catch {
      return undefined;
    }
  }

  /** `get_modified_files` */
  private async getModifiedFiles(
    filter: Filter,
  ): Promise<{ unmergedCount: number; binaryCount: number }> {
    const head = await this.headId();
    const files: Item[] = [];
    const byPath = new Map<string, Item>();
    let unmergedCount = 0;
    let binaryCount = 0;
    const paths = this.options.paths ?? [];
    for (let i = 0; i < 2; i++) {
      const fromIndex = filter === "index-only" ? i === 0 : i === 1;
      const skipUnseen = filter !== "none" && i === 1;
      const diff = new DiffCommand(this.workingCopy).setRenames(false).setCombineMerges(false);
      if (fromIndex) {
        diff
          .setOldTree(head ?? EMPTY_TREE_ID)
          .setCached(true)
          .setIntentToAddVisible(true);
      } else diff.setIgnoreSubmodules("dirty");
      if (paths.length > 0) diff.setPathspec(paths);
      for (const stat of await diff.callDiffstat()) {
        let item = byPath.get(stat.name);
        if (!item) {
          if (skipUnseen) continue;
          item = newItem(stat.name);
          files.push(item);
          byPath.set(stat.name, item);
        }
        const ad = fromIndex ? item.index : item.worktree;
        const other = fromIndex ? item.worktree : item.index;
        ad.seen = true;
        ad.add = stat.added;
        ad.del = stat.deleted;
        if (stat.isBinary) {
          if (!other.binary) binaryCount++;
          ad.binary = true;
        }
        if (stat.isUnmerged) {
          if (!other.unmerged) unmergedCount++;
          ad.unmerged = true;
        }
      }
    }
    files.sort((a, b) => byName(a.name, b.name));
    this.setFiles(files);
    return { unmergedCount, binaryCount };
  }

  private async runStatus(): Promise<void> {
    await this.getModifiedFiles("none");
    this.list(this.files, undefined, this.fileChooser("").list);
    this.out += "\n";
  }

  private async runUpdate(): Promise<void> {
    await this.getModifiedFiles("worktree-only");
    if (this.files.length === 0) {
      this.out += "\n";
      return;
    }
    const count = await this.listAndChoose(
      this.files,
      this.sortedFiles(),
      this.fileChooser("Update"),
    );
    if (count <= 0) {
      this.out += "\n";
      return;
    }
    const paths = this.chosen();
    if (await this.stage(paths, true)) {
      this.out += `updated ${count} path${count === 1 ? "" : "s"}\n`;
    }
    this.out += "\n";
  }

  /** add_file_to_index (or remove_file_from_index) of each path; false on a failure */
  private async stage(paths: string[], update: boolean): Promise<boolean> {
    try {
      await this.options.add({ paths, update });
      this.added.push(...paths);
      return true;
    } catch (error) {
      const message = (error as Error).message ?? String(error);
      this.err += `${message.startsWith("error:") || message.startsWith("fatal:") ? message : `error: could not stage '${paths[0]}'`}\n`;
      return false;
    }
  }

  private async runRevert(): Promise<void> {
    await this.getModifiedFiles("index-only");
    if (this.files.length === 0) {
      this.out += "\n";
      return;
    }
    const count = await this.listAndChoose(
      this.files,
      this.sortedFiles(),
      this.fileChooser("Revert"),
    );
    if (count > 0) {
      const paths = this.chosen();
      await this.revertPaths(paths);
      // repo_refresh_and_write_index after the write
      this.out += await this.sharing(new IndexRefresh(this.workingCopy)).call();
      this.reverted.push(...paths);
      this.out += `reverted ${count} path${count === 1 ? "" : "s"}\n`;
    }
    this.out += "\n";
  }

  /**
   * `revert_from_diff` over `do_diff_cache` of HEAD's tree (the empty tree when unborn) and
   * the index, limited to the literal paths: a path the tree has takes its entry (stage 0,
   * no stat data, conflict stages replaced), one it lacks leaves the index ("note: <path> is
   * untracked now.").
   */
  private async revertPaths(paths: string[]): Promise<void> {
    await this.readCurrentIndex(false);
    const head = await this.headId();
    const treeId = head ? await this.revisionResolver().peelToType(head, "tree") : undefined;
    const tree = await flatTree(this.trees, treeId);
    const index = new Map<string, StagingEntry[]>();
    for await (const entry of this.staging.entries()) {
      const list = index.get(entry.path);
      if (list) list.push(entry);
      else index.set(entry.path, [entry]);
    }
    const literal = new Set(paths);
    const named = (path: string) => {
      if (literal.has(path)) return true;
      for (let at = path.indexOf("/"); at > 0; at = path.indexOf("/", at + 1)) {
        if (literal.has(path.slice(0, at))) return true;
      }
      return false;
    };
    const all = [...new Set([...index.keys(), ...tree.keys()])].sort(byName).filter(named);
    const changes = new Map<string, StagingEntry[]>();
    const undo: ResolveUndoRecord[] = [];
    const current = (path: string): readonly { stage?: number }[] =>
      changes.get(path) ?? index.get(path) ?? [];
    const hasStageZero = (path: string) => current(path).some((e) => (e.stage ?? 0) === 0);
    const dirs = new Set<string>();
    for (const path of index.keys()) addLeadingDirs(dirs, path);
    const allPaths = [...new Set([...index.keys(), ...tree.keys()])];
    for (const path of all) {
      const entries = index.get(path) ?? [];
      const t = tree.get(path);
      const unmerged = entries.some((e) => e.stage > 0);
      const staged = entries.find((e) => e.stage === 0);
      if (!unmerged) {
        if (staged && t && staged.mode === t.mode && staged.objectId === t.objectId) continue;
        if (!staged && !t) continue;
      } else {
        const record: ResolveUndoRecord = {
          path,
          modes: [0, 0, 0],
          objectIds: [undefined, undefined, undefined],
        };
        for (const e of entries) {
          if (e.stage < 1 || e.stage > 3) continue;
          record.modes[e.stage - 1] = e.mode;
          record.objectIds[e.stage - 1] = e.objectId;
        }
        undo.push(record);
      }
      if (!t) {
        changes.set(path, []);
        this.out += `note: ${path} is untracked now.\n`;
        continue;
      }
      for (const other of stageZeroClashes(path, hasStageZero, allPaths, dirs)) {
        changes.set(
          other,
          (current(other) as StagingEntry[]).filter((e) => (e.stage ?? 0) > 0),
        );
      }
      addLeadingDirs(dirs, path);
      changes.set(path, [
        {
          path,
          mode: t.mode,
          objectId: t.objectId,
          stage: 0,
          size: 0,
          mtime: 0,
        } as StagingEntry,
      ]);
    }
    if (undo.length > 0) this.staging.recordResolveUndo?.(undo);
    if (changes.size > 0) await rewriteIndex(this.staging, changes, { upToDate: false });
    else await this.staging.write();
  }

  private async runAddUntracked(): Promise<void> {
    const status = await this.sharing(new StatusCommand(this.workingCopy))
      .setUntrackedFiles("all")
      .setWriteIndex(false);
    for (const path of this.options.paths ?? []) status.addPath(path);
    const untracked = [...(await status.call()).untracked].sort(byName);
    this.setFiles(untracked.map(newItem));
    if (this.files.length > 0) {
      this.onlyNames = true;
      let count: number;
      try {
        count = await this.listAndChoose(
          this.files,
          this.sortedFiles(),
          this.fileChooser("Add untracked"),
        );
      } finally {
        this.onlyNames = false;
      }
      if (count > 0 && (await this.stage(this.chosen(), false))) {
        this.out += `added ${count} path${count === 1 ? "" : "s"}\n`;
      }
    } else {
      this.out += "No untracked files.\n";
    }
    this.out += "\n";
  }

  private async runPatch(): Promise<void> {
    const { unmergedCount, binaryCount } = await this.getModifiedFiles("worktree-only");
    if (unmergedCount || binaryCount) {
      const kept: Item[] = [];
      for (const item of this.files) {
        if (item.index.binary || item.worktree.binary) continue;
        if (item.index.unmerged || item.worktree.unmerged) {
          this.err += `ignoring unmerged: ${item.name}\n`;
          continue;
        }
        kept.push(item);
      }
      this.setFiles(kept);
    }
    if (this.files.length === 0) {
      this.err += binaryCount ? "Only binary files changed.\n" : "No changes.\n";
      return;
    }
    const count = await this.listAndChoose(
      this.files,
      this.sortedFiles(),
      this.fileChooser("Patch update"),
    );
    if (count <= 0) return;
    const { selector, compatibility, context, interHunkContext, autoAdvance } = this.options;
    const patch = await runPatchSelection(this.workingCopy, {
      mode: patchModeFor("add"),
      selector,
      paths: this.chosen().map((path) => `:(literal)${path}`),
      ...(compatibility ? { compatibility } : {}),
      ...(this.modern && context !== undefined ? { context } : {}),
      ...(this.modern && interHunkContext !== undefined ? { interHunkContext } : {}),
      ...(this.modern && autoAdvance !== undefined ? { autoAdvance } : {}),
      ...(this.options.hookSource ? { hookSource: this.options.hookSource } : {}),
    });
    this.out += patch.output;
    this.err += patch.errors;
    this.added.push(...patch.applied);
  }

  private async runDiff(): Promise<void> {
    const head = await this.headId();
    await this.getModifiedFiles("index-only");
    if (this.files.length === 0) {
      this.out += "\n";
      return;
    }
    const count = await this.listAndChoose(
      this.files,
      this.sortedFiles(),
      this.fileChooser("Review diff", true),
    );
    if (count > 0) {
      // `git diff -p --cached [--unified=<n>] [--inter-hunk-context=<n>] <HEAD> -- <paths>`
      const { context, interHunkContext } = this.options;
      const diff = new DiffCommand(this.workingCopy)
        .setCached(true)
        .setOldTree(head ?? EMPTY_TREE_ID)
        .setPathspec(this.chosen());
      if (this.modern) {
        diff.setOptions({
          ...(context !== undefined ? { context } : {}),
          ...(interHunkContext !== undefined ? { interHunkContext } : {}),
        });
      }
      try {
        this.out += await diff.callText("patch");
        for (const warning of diff.warnings) this.err += `${warning}\n`;
      } catch (error) {
        this.err += `${(error as Error).message}\n`;
      }
    }
    this.out += "\n";
  }

  private runHelp(): void {
    this.out +=
      "status        - show paths with changes\n" +
      "update        - add working tree state to the staged set of changes\n" +
      "revert        - revert staged set of changes back to the HEAD version\n" +
      "patch         - pick hunks and update selectively\n" +
      "diff          - view diff between HEAD and index\n" +
      "add untracked - add contents of untracked files to the staged set of changes\n";
  }
}

/**
 * Runs `git add -i`: the session's menus and file selections go to the selector as `choose`
 * requests (patch mode's prompts as `add -p` asks them), the transcript comes back.
 *
 * @example
 * ```typescript
 * const answers = ["2", "1-2", "", "q"];
 * const { interactive } = await git.add().setInteractive(true)
 *   .setPatchSelector(() => answers.shift()).call();
 * process.stdout.write(interactive?.output ?? "");
 * ```
 */
export async function runAddInteractive(
  workingCopy: WorkingCopy,
  options: AddInteractiveOptions,
): Promise<AddInteractiveResult> {
  return new AddInteractiveSession(workingCopy, options).call();
}
