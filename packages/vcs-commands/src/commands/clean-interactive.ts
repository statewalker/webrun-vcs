/**
 * `git clean -i` (builtin/clean.c's `interactive_main_loop`): the items to delete listed in
 * columns, the "*** Commands ***" menu (clean, filter by pattern, select by numbers, ask
 * each, quit, help) and its actions, each read of standard input answered by a
 * `PatchSelector` (the menus as `choose` requests, the patterns as a `line`, each "Remove
 * ...?" as a `yesno`), and what git prints gathered as its standard output.
 */

import { wildmatch } from "@statewalker/vcs-working-tree";

import { quotePath } from "../results/quote-path.js";
import type { PatchRequest, PatchSelector } from "./add-patch/index.js";

/** What `git clean -i` printed. */
export interface CleanInteractiveResult {
  /** Standard output, as git prints it: listings, menus, prompts, help */
  output: string;
}

/** column.c's layouts (`column.ui`, `column.clean`). */
export interface ColumnLayout {
  layout: "column" | "row" | "plain";
  dense: boolean;
}

/** Options of {@link runCleanInteractive}. */
export interface CleanInteractiveOptions {
  selector: PatchSelector;
  /** The items to delete, as git lists them (directories with their `/`), in order */
  items: string[];
  /** Whether an item is a directory (`lstat`'s answer for the pattern filter) */
  isDirectory: (item: string) => boolean;
  /** `term_columns()` (default 80: `$COLUMNS`, else the terminal's width) */
  columns?: number;
  /** The layout of the item listing (default `column`, not dense) */
  layout?: ColumnLayout;
  /** `core.quotePath` (default true) */
  quotePath?: boolean;
  /** `core.ignoreCase`: patterns match ignoring case */
  ignoreCase?: boolean;
  /** git 2.43 prints the whole input of a pattern filter that matched nothing */
  compatibility?: "2.43" | "2.56";
}

/** Reads `column.ui` / `column.clean` values (the later one wins for each part). */
export function parseColumnLayout(values: readonly string[]): ColumnLayout {
  const out: ColumnLayout = { layout: "column", dense: false };
  for (const value of values) {
    for (const word of value.split(/[ ,]+/)) {
      const w = word.toLowerCase();
      if (w === "column" || w === "row" || w === "plain") out.layout = w;
      else if (w === "dense") out.dense = true;
      else if (w === "nodense") out.dense = false;
    }
  }
  return out;
}

/** utf8_strnwidth: the display width (one column per character here). */
const itemLength = (s: string) => [...s].length;

/**
 * column.c's `print_columns` with the layout always enabled: `indent` before each line,
 * `padding` spaces between cells, `width` the terminal's columns less one.
 */
export function printColumns(
  list: readonly string[],
  layout: ColumnLayout,
  options: { indent: string; padding: number; width: number },
): string {
  if (list.length === 0) return "";
  const { indent, padding } = options;
  if (layout.layout === "plain") return list.map((s) => `${indent}${s}\n`).join("");
  const n = list.length;
  const len = list.map(itemLength);
  const column = layout.layout === "column";
  let initialWidth = Math.max(...len) + padding;
  let cols = Math.floor((options.width - indent.length) / initialWidth);
  if (cols === 0) cols = 1;
  let rows = Math.ceil(n / cols);
  const linear = (x: number, y: number) => (column ? x * rows + y : y * cols + x);
  let width: number[] | undefined;
  const computeWidths = () => {
    const w: number[] = [];
    for (let x = 0; x < cols; x++) {
      w[x] = linear(x, 0);
      for (let y = 0; y < rows; y++) {
        const i = linear(x, y);
        if (i < n && len[w[x] as number] < len[i]) w[x] = i;
      }
    }
    return w;
  };
  if (layout.dense) {
    while (rows > 1) {
      const oldRows = rows;
      const oldCols = cols;
      rows--;
      cols = Math.ceil(n / rows);
      const w = computeWidths();
      let total = indent.length;
      for (let x = 0; x < cols; x++) total += len[w[x] as number] + padding;
      if (total > options.width) {
        rows = oldRows;
        cols = oldCols;
        break;
      }
    }
    width = computeWidths();
  }
  initialWidth = Math.max(...len) + padding;
  let out = "";
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = linear(x, y);
      if (i >= n) break;
      let l = len[i] as number;
      if (width && len[width[x] as number] < initialWidth) {
        l += initialWidth - len[width[x] as number];
        l -= padding;
      }
      const newline = column ? i + rows >= n : x === cols - 1 || i === n - 1;
      out += `${x === 0 ? indent : ""}${list[i]}${newline ? "\n" : " ".repeat(Math.max(0, initialWidth - l))}`;
    }
  }
  return out;
}

interface MenuItem {
  hotkey: string;
  title: string;
}

const MENU: readonly MenuItem[] = [
  { hotkey: "c", title: "clean" },
  { hotkey: "f", title: "filter by pattern" },
  { hotkey: "s", title: "select by numbers" },
  { hotkey: "a", title: "ask each" },
  { hotkey: "q", title: "quit" },
  { hotkey: "h", title: "help" },
];

const isDigit = (c: string) => c >= "0" && c <= "9";

/** atoi: the leading digits' value (0 for none). */
const atoi = (s: string) => {
  const m = /^\d+/.exec(s);
  return m ? Number(m[0]) : 0;
};

const lower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** A pattern of `add_pattern` (parse_path_pattern's flags). */
interface Pattern {
  pattern: string;
  negative: boolean;
  mustBeDir: boolean;
  noDir: boolean;
}

function parsePattern(text: string): Pattern {
  let p = text;
  let negative = false;
  if (p.startsWith("!")) {
    negative = true;
    p = p.slice(1);
  }
  let mustBeDir = false;
  if (p.length > 0 && p.endsWith("/")) {
    mustBeDir = true;
    p = p.slice(0, -1);
  }
  return { pattern: p, negative, mustBeDir, noDir: !p.includes("/") };
}

/** The input up to the end of its first space-separated piece, its trailing blanks cut. */
function firstPieceOf(input: string): string {
  let p = 0;
  while (p < input.length && /\s/.test(input[p] as string)) p++;
  let end = input.indexOf(" ", p);
  if (end < 0) end = input.length;
  while (end > p && /\s/.test(input[end - 1] as string)) end--;
  return input.slice(0, end);
}

/** A `git clean -i` session. */
class CleanInteractiveSession {
  private out = "";
  private del: string[];
  private readonly width: number;

  constructor(private readonly options: CleanInteractiveOptions) {
    this.del = [...options.items];
    this.width = (options.columns ?? 80) - 1;
  }

  private quote(item: string): string {
    return quotePath(item, this.options.quotePath ?? true);
  }

  private prettyPrintDels(): void {
    this.out += printColumns(
      this.del.map((item) => this.quote(item)),
      this.options.layout ?? { layout: "column", dense: false },
      { indent: "  ", padding: 2, width: this.width },
    );
  }

  private async read(request: PatchRequest): Promise<string | undefined> {
    const reply = await this.options.selector(request);
    // git_read_line_interactively: the line without its line end
    return reply?.replace(/\r?\n$/, "");
  }

  async run(): Promise<{ items: string[]; output: string }> {
    while (this.del.length > 0) {
      this.out += `Would remove the following item${this.del.length === 1 ? "" : "s"}:\n`;
      this.prettyPrintDels();
      const chosen = await this.listAndChoose(
        MENU.map((m) => m.title),
        {
          header: "*** Commands ***",
          prompt: "What now",
          singleton: true,
        },
        (i, selected) => {
          const m = MENU[i] as MenuItem;
          return `${selected ? "*" : " "}${String(i + 1).padStart(2)}: ${m.title}`;
        },
      );
      if (chosen === undefined) {
        this.quit();
        break;
      }
      const title = MENU[chosen[0] as number]?.title;
      let loop = true;
      if (title === "clean") loop = false;
      else if (title === "filter by pattern") await this.filterByPatterns();
      else if (title === "select by numbers") await this.selectByNumbers();
      else if (title === "ask each") {
        await this.askEach();
        loop = false;
      } else if (title === "quit") {
        this.quit();
        loop = false;
      } else if (title === "help") this.help();
      if (!loop) break;
      if (this.del.length === 0) {
        this.out += "No more files to clean, exiting.\n";
        break;
      }
    }
    return { items: this.del, output: this.out };
  }

  private quit(): void {
    this.del = [];
    this.out += "Bye.\n";
  }

  private help(): void {
    this.out +=
      "clean               - start cleaning\n" +
      "filter by pattern   - exclude items from deletion\n" +
      "select by numbers   - select items to be deleted by numbers\n" +
      'ask each            - confirm each deletion (like "rm -i")\n' +
      "quit                - stop cleaning\n" +
      "help                - this screen\n" +
      "?                   - help for prompt selection\n";
  }

  /** `find_unique`: the 1-based item `choice` names, 0 for none or several. */
  private findUnique(choice: string, titles: readonly string[], menu: boolean): number {
    const len = choice.length;
    let found = 0;
    const c = lower(choice);
    for (let i = 0; i < titles.length; i++) {
      const title = titles[i] as string;
      if (menu && len === 1 && choice === MENU[i]?.hotkey) return i + 1;
      if (lower(title.slice(0, len)) === c && title.length >= len) {
        if (found) {
          if (menu && len === 1) {
            // continue for hotkey matching
            found = -1;
          } else return 0;
        } else found = i + 1;
      }
    }
    return found;
  }

  /** `parse_choice`: marks `chosen`; the number of items chosen. */
  private parseChoice(
    titles: readonly string[],
    singleton: boolean,
    input: string,
    chosen: number[],
    menu: boolean,
  ): number {
    const tokens = (singleton ? [input] : input.split(/[, ]/)).map((t) => t.trim());
    const nr = titles.length;
    for (const token of tokens) {
      let string = token;
      if (!string) continue;
      let choose = 1;
      if (string.startsWith("-")) {
        choose = 0;
        string = string.slice(1);
      }
      let isRange = false;
      let isNumber = true;
      for (const ch of string) {
        if (ch === "-") {
          if (!isRange) {
            isRange = true;
            isNumber = false;
          } else {
            isNumber = false;
            isRange = false;
            break;
          }
        } else if (!isDigit(ch)) {
          isNumber = false;
          isRange = false;
          break;
        }
      }
      let bottom: number;
      let top: number;
      if (isNumber) {
        bottom = atoi(string);
        top = bottom;
      } else if (isRange) {
        bottom = atoi(string);
        const rest = string.slice(string.indexOf("-") + 1);
        top = rest ? atoi(rest) : nr;
      } else if (string === "*") {
        bottom = 1;
        top = nr;
      } else {
        bottom = this.findUnique(string, titles, menu);
        top = bottom;
      }
      if (top <= 0 || bottom <= 0 || top > nr || bottom > top || (singleton && bottom !== top)) {
        this.out += `Huh (${string})?\n`;
        continue;
      }
      for (let i = bottom; i <= top; i++) chosen[i - 1] = choose;
    }
    return chosen.reduce((a, b) => a + Math.max(0, b), 0);
  }

  /**
   * `list_and_choose`: the indexes chosen, or undefined at the end of input.
   */
  private async listAndChoose(
    titles: readonly string[],
    opts: { header?: string; prompt: string; singleton: boolean },
    label: (i: number, selected: boolean) => string,
  ): Promise<number[] | undefined> {
    const menu = opts.singleton;
    const chosen = titles.map(() => 0);
    let nr = 0;
    for (;;) {
      if (opts.header !== undefined) this.out += `${opts.header}\n`;
      this.out += printColumns(
        titles.map((_, i) => label(i, chosen[i] === 1)),
        // pretty_print_menus: always in rows
        { layout: "row", dense: false },
        { indent: "  ", padding: 2, width: this.width },
      );
      const prompt = `${opts.prompt}${opts.singleton ? "> " : ">> "}`;
      this.out += prompt;
      const input = await this.read({
        type: "choose",
        prompt,
        singleton: opts.singleton,
        items: [...titles],
        output: this.out,
      });
      if (input === undefined) return undefined;
      if (input === "?") {
        this.promptHelp(opts.singleton);
        continue;
      }
      if (!opts.singleton && !input.length) break;
      nr = this.parseChoice(titles, opts.singleton, input, chosen, menu);
      if (opts.singleton && nr) break;
    }
    const result: number[] = [];
    for (let i = 0; i < chosen.length; i++) if (chosen[i]) result.push(i);
    return result;
  }

  private promptHelp(singleton: boolean): void {
    this.out += singleton
      ? "Prompt help:\n" +
        "1          - select a numbered item\n" +
        "foo        - select item based on unique prefix\n" +
        "           - (empty) select nothing\n"
      : "Prompt help:\n" +
        "1          - select a single item\n" +
        "3-5        - select a range of items\n" +
        "2-3,6-9    - select multiple ranges\n" +
        "foo        - select item based on unique prefix\n" +
        "-...       - unselect specified items\n" +
        "*          - choose all items\n" +
        "           - (empty) finish selecting\n";
  }

  /** `filter_by_patterns_cmd`. */
  private async filterByPatterns(): Promise<void> {
    let changed = -1;
    for (;;) {
      if (this.del.length === 0) break;
      if (changed) this.prettyPrintDels();
      const prompt = "Input ignore patterns>> ";
      this.out += prompt;
      let confirm = await this.read({ type: "line", prompt, output: this.out });
      if (confirm === undefined) {
        this.out += "\n";
        confirm = "";
      }
      if (!confirm.length) break;
      const pieces = confirm.split(" ").map((p) => p.trim());
      const patterns = pieces.filter((p) => p.length > 0).map(parsePattern);
      changed = 0;
      const kept: string[] = [];
      for (const item of this.del) {
        if (this.excluded(item, patterns)) changed++;
        else kept.push(item);
      }
      if (changed) this.del = kept;
      else {
        // 2.5x splits the input in place (string_list_split_in_place_f, trimming): what is
        // left of it ends where its first piece, right-trimmed, ends
        const shown = this.options.compatibility === "2.43" ? confirm : firstPieceOf(confirm);
        this.out += `WARNING: Cannot find items matched by: ${shown}\n`;
      }
    }
  }

  /**
   * `is_excluded` with the patterns alone: `prep_exclude` first asks each leading
   * directory (an excluded one excludes everything below it), then the item itself
   * (`last_matching_pattern_from_list`, its basename what follows its last `/`).
   */
  private excluded(item: string, patterns: Pattern[]): boolean {
    const slash = item.lastIndexOf("/");
    for (let at = item.indexOf("/"); at >= 0 && at <= slash; at = item.indexOf("/", at + 1)) {
      if (at === 0) continue;
      const dir = item.slice(0, at);
      const match = this.lastMatching(dir, true, patterns);
      if (match && !match.negative) return true;
    }
    const match = this.lastMatching(item, this.options.isDirectory(item), patterns);
    return match !== undefined && !match.negative;
  }

  /** `last_matching_pattern_from_list`: the last pattern matching `path`. */
  private lastMatching(path: string, directory: boolean, patterns: Pattern[]): Pattern | undefined {
    const slash = path.lastIndexOf("/");
    const basename = slash < 0 ? path : path.slice(slash + 1);
    const casefold = this.options.ignoreCase === true;
    for (let i = patterns.length - 1; i >= 0; i--) {
      const p = patterns[i] as Pattern;
      if (p.mustBeDir && !directory) continue;
      const matched = p.noDir
        ? wildmatch(p.pattern, basename, { casefold })
        : wildmatch(p.pattern.startsWith("/") ? p.pattern.slice(1) : p.pattern, path, {
            pathname: true,
            casefold,
          });
      if (matched) return p;
    }
    return undefined;
  }

  /** `select_by_numbers_cmd`. */
  private async selectByNumbers(): Promise<void> {
    const chosen = await this.listAndChoose(
      this.del,
      { prompt: "Select items to delete", singleton: false },
      (i, selected) => `${selected ? "*" : " "}${String(i + 1).padStart(2)}: ${this.del[i]}`,
    );
    const keep = new Set(chosen ?? []);
    this.del = this.del.filter((_, i) => keep.has(i));
  }

  /** `ask_each_cmd`. */
  private async askEach(): Promise<void> {
    let eof = false;
    let confirm = "";
    const kept: string[] = [];
    for (const item of this.del) {
      if (!eof) {
        const prompt = `Remove ${this.quote(item)} [y/N]? `;
        this.out += prompt;
        const reply = await this.read({ type: "yesno", prompt });
        if (reply === undefined) {
          this.out += "\n";
          eof = true;
          confirm = "";
        } else confirm = reply;
      }
      if (confirm.length && lower("yes".slice(0, confirm.length)) === lower(confirm)) {
        kept.push(item);
      }
    }
    this.del = kept;
  }
}

/**
 * Runs `git clean -i` over the items to delete: the ones left to delete come back with
 * the transcript.
 */
export async function runCleanInteractive(
  options: CleanInteractiveOptions,
): Promise<{ items: string[]; output: string }> {
  return new CleanInteractiveSession(options).run();
}
