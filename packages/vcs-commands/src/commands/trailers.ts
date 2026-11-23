/**
 * git's trailer engine (trailer.c): finding the trailer block of a message, formatting it
 * (`%(trailers)` of a pretty format), adding and editing trailers (`git interpret-trailers`,
 * the `--trailer` of commit, tag, merge, rebase and cherry-pick) with the `trailer.*`
 * configuration, and sequencer.c's sign-off (`append_signoff`).
 *
 * The block is the last paragraph when every line of it is a trailer, or when it has a
 * git-generated one (`Signed-off-by: `, `(cherry picked from commit `) or a configured one
 * and at least a quarter of its lines are trailers, continuation lines folded in.
 *
 * @example
 * ```typescript
 * const message = "Fix\n\nBody.\n\nSigned-off-by: A <a@b>\nAcked-by: C <c@d>\n";
 * formatTrailersOf(message, { onlyTrailers: true, valueOnly: true, separator: ", " });
 * // "A <a@b>, C <c@d>"
 *
 * const { output } = await interpretTrailers("Fix\n", { trailers: ["Reviewed-by: R <r@x>"] });
 * // "Fix\n\nReviewed-by: R <r@x>\n"
 * ```
 *
 * @module
 */

import type { WorkingCopy } from "@statewalker/vcs-working-tree";

import { GitApiError } from "../errors/index.js";
import { RemoteConfigStore } from "../remote-config/index.js";
import { commentPrefixOf } from "./message-cleanup.js";

/** Where a new trailer goes (`--where`, `trailer.where`, `trailer.<key>.where`). */
export type TrailerWhere = "end" | "after" | "before" | "start";
/** What to do when a trailer of the key exists (`--if-exists`, `trailer.ifexists`). */
export type TrailerIfExists =
  | "addIfDifferentNeighbor"
  | "addIfDifferent"
  | "add"
  | "replace"
  | "doNothing";
/** What to do when no trailer of the key exists (`--if-missing`, `trailer.ifmissing`). */
export type TrailerIfMissing = "add" | "doNothing";

/** One `trailer.<name>.*` section (git's `conf_info`). */
export interface TrailerItemConfig {
  /** `<name>`, the key alias (`--trailer <name>=<value>`) */
  name: string;
  /** `trailer.<name>.key`: the key written for the trailer */
  key?: string;
  /**
   * `trailer.<name>.command` (deprecated): a shell command, its first `$ARG` replaced by the
   * value, whose output is the value; also adds the trailer to every message
   */
  command?: string;
  /** `trailer.<name>.cmd`: a shell command given the value as `$1`, whose output is the value */
  cmd?: string;
  /** `trailer.<name>.where` (default `trailer.where`) */
  where?: TrailerWhere;
  /** `trailer.<name>.ifexists` (default `trailer.ifexists`) */
  ifExists?: TrailerIfExists;
  /** `trailer.<name>.ifmissing` (default `trailer.ifmissing`) */
  ifMissing?: TrailerIfMissing;
}

/** The configuration trailers are read and written with (`trailer.*`, `core.commentChar`). */
export interface TrailerConfig {
  /** `trailer.separators`: the characters that end a trailer's key (default `:`) */
  separators?: string;
  /** `core.commentChar` / `core.commentString` (default `#`) */
  commentString?: string;
  /** `trailer.where` (default `end`) */
  where?: TrailerWhere;
  /** `trailer.ifexists` (default `addIfDifferentNeighbor`) */
  ifExists?: TrailerIfExists;
  /** `trailer.ifmissing` (default `add`) */
  ifMissing?: TrailerIfMissing;
  /**
   * The `trailer.<name>.*` sections in the configuration's order (names without case): a
   * trailer whose key starts a name (or its `key`) is recognized, and shown with the `key`
   */
  items?: readonly TrailerItemConfig[];
  /**
   * git's warnings reading the configuration (`warning: unknown value 'x' for key
   * 'trailer.where'`, `warning: more than one trailer.a.key`), each a line
   */
  warnings?: readonly string[];
  /**
   * The git version whose behaviour to follow where versions differ (default `2.56`): git
   * 2.43 takes `https://x` for a trailer (2.45+ refuses a `://` right after the key), its
   * `--trim-empty` also drops the non-trailer lines of a block that are empty, and its
   * `interpret-trailers` reads an input without a final line end as it is (2.44+ completes it)
   */
  compatibility?: "2.43" | "2.56";
}

/** What git's process_trailer_options carries for formatting trailers. */
export interface TrailerFormatOptions {
  /** Only the trailers, not the other lines of the block (`only`) */
  onlyTrailers?: boolean;
  /** Continuation lines joined into one (`unfold`) */
  unfold?: boolean;
  /** Only the keys (`keyonly`) */
  keyOnly?: boolean;
  /** Only the values (`valueonly`) */
  valueOnly?: boolean;
  /** Between trailers, instead of each one's line end (`separator=`) */
  separator?: string;
  /** Between a key and its value, instead of `: ` (`key_value_separator=`) */
  keyValueSeparator?: string;
  /** Only the trailers with one of these keys, matched without case (`key=`) */
  keys?: readonly string[];
}

/** A trailer to add (`--trailer <key>[(=|:)<value>]`) and how, over the configuration. */
export interface NewTrailer {
  /** `<key>`, `<key>:<value>`, `<key>=<value>` (any of `trailer.separators` or `=`) */
  text: string;
  /** `--where` given before it */
  where?: TrailerWhere;
  /** `--if-exists` given before it */
  ifExists?: TrailerIfExists;
  /** `--if-missing` given before it */
  ifMissing?: TrailerIfMissing;
}

/** A shell command of `trailer.<name>.cmd` / `.command` for the host to run. */
export interface TrailerCommand {
  /** The command line (`command` with its `$ARG` replaced, or `cmd`) */
  command: string;
  /** The arguments after it (`cmd`'s value; none for `command`) */
  args: string[];
}

/** What a trailer command did. */
export interface TrailerCommandOutcome {
  exitCode: number;
  stdout: string;
  /** What it wrote on stderr (git's own stderr shows it) */
  stderr?: string;
}

/**
 * Runs trailer commands as git's `apply_command` does: through the shell (`sh -c`), stdin
 * closed, without the variables naming the repository (`local_repo_env`). Undefined when the
 * command could not be started (git reports it as failed).
 */
export type TrailerCommandRunner = (
  command: TrailerCommand,
) => Promise<TrailerCommandOutcome | undefined>;

/** How {@link interpretTrailers} edits a message (`git interpret-trailers` options). */
export interface InterpretTrailersOptions {
  /** The trailers to add (`--trailer`), in order; a string takes the options below */
  trailers?: readonly (string | NewTrailer)[];
  /** `--where` for the trailers given as strings */
  where?: TrailerWhere;
  /** `--if-exists` for the trailers given as strings */
  ifExists?: TrailerIfExists;
  /** `--if-missing` for the trailers given as strings */
  ifMissing?: TrailerIfMissing;
  /** `--trim-empty`: trailers with an empty value are left out */
  trimEmpty?: boolean;
  /** `--only-trailers`: only the trailers are output */
  onlyTrailers?: boolean;
  /** `--only-input`: no `trailer.<name>.command` trailers (and no `trailers` allowed) */
  onlyInput?: boolean;
  /** `--unfold`: continuation lines joined into one */
  unfold?: boolean;
  /** `--parse`: `--only-trailers --only-input --unfold` */
  parse?: boolean;
  /** `--no-divider`: a `---` line does not end the message */
  noDivider?: boolean;
  /**
   * Runs `trailer.<name>.cmd` / `.command` (see {@link TrailerCommandRunner}). Absent, as in a
   * host that runs no commands: commands are not run, a trailer keeps the value given and no
   * `.command` trailer is added on its own.
   */
  runCommand?: TrailerCommandRunner;
}

/** What {@link interpretTrailers} gave. */
export interface InterpretTrailersResult {
  /** The message with its trailers (git's stdout) */
  output: string;
  /** git's stderr: `error:` lines and the commands' stderr, in order */
  errors: string;
}

/** One line of a trailer block as git's trailer iterator gives it. */
export interface TrailerLine {
  /** The line as written, continuation lines included */
  raw: string;
  /** The key (the configured `key` where one matches); the whole line for a non-trailer */
  key: string;
  /** The value, unfolded; empty for a non-trailer */
  value: string;
  /** Whether it is a trailer (`<key><separator><value>`) */
  isTrailer: boolean;
}

/** git's `trailer_set_where`: the placement named (without case); undefined when unknown. */
export function parseTrailerWhere(value: string): TrailerWhere | undefined {
  const lower = lowerAscii(value);
  for (const where of ["after", "before", "end", "start"] as const)
    if (lower === where) return where;
  return undefined;
}

/** git's `trailer_set_if_exists`: the action named (without case); undefined when unknown. */
export function parseTrailerIfExists(value: string): TrailerIfExists | undefined {
  const lower = lowerAscii(value);
  for (const action of [
    "addIfDifferent",
    "addIfDifferentNeighbor",
    "add",
    "replace",
    "doNothing",
  ] as const) {
    if (lower === lowerAscii(action)) return action;
  }
  return undefined;
}

/** git's `trailer_set_if_missing`: the action named (without case); undefined when unknown. */
export function parseTrailerIfMissing(value: string): TrailerIfMissing | undefined {
  const lower = lowerAscii(value);
  if (lower === "donothing") return "doNothing";
  if (lower === "add") return "add";
  return undefined;
}

/** The trailer configuration of a working copy (`trailer.*`, the comment prefix). */
export function trailerConfigOf(workingCopy: WorkingCopy): TrailerConfig {
  const config = RemoteConfigStore.from(workingCopy);
  let entries = config.entriesWithPrefix("trailer.");
  if (!entries) {
    // a config that cannot list its variables in order: section by section
    entries = [];
    for (const variable of ["where", "ifexists", "ifmissing", "separators"]) {
      for (const value of config.values(`trailer.${variable}`)) {
        entries.push({ key: `trailer.${variable}`, value });
      }
    }
    for (const name of config.subsections("trailer")) {
      for (const variable of TRAILER_VARIABLES) {
        for (const value of config.values(`trailer.${name}.${variable}`)) {
          entries.push({ key: `trailer.${name}.${variable}`, value });
        }
      }
    }
  }
  return trailerConfigFromEntries(entries, commentPrefixOf(workingCopy));
}

const TRAILER_VARIABLES = ["key", "command", "cmd", "where", "ifexists", "ifmissing"] as const;

/**
 * The trailer configuration from `trailer.*` variables in the configuration's order (keys
 * canonical: section and variable in lower case), as git's `trailer_config_init` reads them:
 * `trailer.where`/`ifexists`/`ifmissing`/`separators` first, then each `trailer.<name>.*`.
 * A `key`, `command`, `cmd` or `separators` without a value is git's fatal config error.
 */
export function trailerConfigFromEntries(
  entries: readonly { key: string; value: string | undefined }[],
  commentString?: string,
): TrailerConfig {
  const warnings: string[] = [];
  const unknown = (value: string | undefined, key: string) =>
    warnings.push(`warning: unknown value '${value ?? "(null)"}' for key '${key}'`);
  const missing = (key: string): never => {
    throw new GitApiError(
      `error: missing value for '${key}'\nfatal: bad config variable '${key}'`,
      {
        exitCode: 128,
      },
    );
  };
  const out: {
    separators?: string;
    where?: TrailerWhere;
    ifExists?: TrailerIfExists;
    ifMissing?: TrailerIfMissing;
  } = {};
  // git_trailer_default_config
  for (const { key, value } of entries) {
    const rest = key.slice("trailer.".length);
    if (!key.startsWith("trailer.") || rest.includes(".")) continue;
    if (rest === "where") {
      const where = value === undefined ? undefined : parseTrailerWhere(value);
      if (where) out.where = where;
      else if (value !== undefined) unknown(value, key);
    } else if (rest === "ifexists") {
      const action = value === undefined ? undefined : parseTrailerIfExists(value);
      if (action) out.ifExists = action;
      else if (value !== undefined) unknown(value, key);
    } else if (rest === "ifmissing") {
      const action = value === undefined ? undefined : parseTrailerIfMissing(value);
      if (action) out.ifMissing = action;
      else if (value !== undefined) unknown(value, key);
    } else if (rest === "separators") {
      if (value === undefined) missing(key);
      else out.separators = value;
    }
  }
  // git_trailer_config: one item per name (without case), in the order first met
  const items: TrailerItemConfig[] = [];
  for (const { key, value } of entries) {
    if (!key.startsWith("trailer.")) continue;
    const rest = key.slice("trailer.".length);
    const dot = rest.lastIndexOf(".");
    if (dot < 0) continue;
    const variable = rest.slice(dot + 1);
    if (!(TRAILER_VARIABLES as readonly string[]).includes(variable)) continue;
    const name = rest.slice(0, dot);
    let item = items.find((i) => lowerAscii(i.name) === lowerAscii(name));
    if (!item) {
      item = { name };
      items.push(item);
    }
    switch (variable) {
      case "key":
      case "command":
      case "cmd": {
        const field = variable;
        if (item[field] !== undefined) warnings.push(`warning: more than one ${key}`);
        if (value === undefined) missing(key);
        else item[field] = value;
        break;
      }
      case "where": {
        const where = value === undefined ? undefined : parseTrailerWhere(value);
        if (where) item.where = where;
        else unknown(value, key);
        break;
      }
      case "ifexists": {
        const action = value === undefined ? undefined : parseTrailerIfExists(value);
        if (action) item.ifExists = action;
        else unknown(value, key);
        break;
      }
      case "ifmissing": {
        const action = value === undefined ? undefined : parseTrailerIfMissing(value);
        if (action) item.ifMissing = action;
        else unknown(value, key);
        break;
      }
    }
  }
  return {
    ...out,
    ...(commentString !== undefined ? { commentString } : {}),
    items,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

const lowerAscii = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
/** strncasecmp(a, b, n) === 0 */
function sameStart(a: string, b: string, n: number): boolean {
  for (let i = 0; i < n; i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined || y === undefined) return x === y;
    if (x !== y && lowerAscii(x) !== lowerAscii(y)) return false;
  }
  return true;
}
/** git's isspace (sane_ctype): space, tab, LF, CR */
const isSpace = (c: string | undefined) => c === " " || c === "\t" || c === "\n" || c === "\r";
const isAlnum = (c: string | undefined) => c !== undefined && /^[A-Za-z0-9]$/.test(c);
const trim = (s: string) => s.replace(/^[ \t\n\r]+/, "").replace(/[ \t\n\r]+$/, "");

/** git's is_blank_line: only spaces up to the line's end. */
function isBlankLine(buf: string, at: number): boolean {
  let i = at;
  while (i < buf.length && buf[i] !== "\n" && isSpace(buf[i])) i++;
  return i >= buf.length || buf[i] === "\n";
}

/** git's next_line: past the next line end (or at the end). */
function nextLine(buf: string, at: number): number {
  const nl = buf.indexOf("\n", at);
  return nl < 0 ? buf.length : nl + 1;
}

/** git's last_line: where the last line of `buf[0, len)` starts; -1 when empty. */
function lastLine(buf: string, len: number): number {
  if (len === 0) return -1;
  if (len === 1) return 0;
  for (let i = len - 2; i >= 0; i--) if (buf[i] === "\n") return i + 1;
  return 0;
}

/** The configuration with git's defaults. */
interface Resolved {
  separators: string;
  commentString: string;
  where: TrailerWhere;
  ifExists: TrailerIfExists;
  ifMissing: TrailerIfMissing;
  items: readonly TrailerItemConfig[];
  legacy: boolean;
}

function resolve(config: TrailerConfig): Resolved {
  return {
    separators: config.separators || ":",
    commentString: config.commentString || "#",
    where: config.where ?? "end",
    ifExists: config.ifExists ?? "addIfDifferentNeighbor",
    ifMissing: config.ifMissing ?? "add",
    items: config.items ?? [],
    legacy: config.compatibility === "2.43",
  };
}

/**
 * git's find_separator: where the separator of `<token><optional blanks><separator>` is in
 * `line` from `at`, -1 when it is not a trailer line (a `://` right after the token is a URL,
 * git 2.45+). 0 when the line starts with a separator.
 */
function findSeparator(line: string, at: number, separators: string, legacy: boolean): number {
  let whitespace = false;
  for (let c = at; c < line.length; c++) {
    const ch = line[c] as string;
    if (separators.includes(ch)) {
      if (!legacy && !whitespace && line.startsWith("://", c)) return -1;
      return c - at;
    }
    if (!whitespace && (isAlnum(ch) || ch === "-")) continue;
    if (c !== at && (ch === " " || ch === "\t")) {
      whitespace = true;
      continue;
    }
    break;
  }
  return -1;
}

/** git's token_len_without_separator: the token without its final punctuation. */
function tokenLength(token: string): number {
  let len = token.length;
  while (len > 0 && !isAlnum(token[len - 1])) len--;
  return len;
}

/** git's token_matches_item: `tok`'s first `len` characters start the item's name or key. */
function tokenMatches(tok: string, item: TrailerItemConfig, len: number): boolean {
  if (sameStart(tok, item.name, len)) return true;
  return item.key !== undefined && sameStart(tok, item.key, len);
}

const GIT_GENERATED_PREFIXES = ["Signed-off-by: ", "(cherry picked from commit "];
const CUT_LINE = "------------------------ >8 ------------------------";

/** commit.c's ignored_log_message_bytes: the trailing comments, blank lines, scissors. */
function ignoredBytes(buf: string, len: number, comment: string): number {
  // wt_status_locate_end (strstr over the whole input; wt-status.c's cut_line ends with its
  // line end, so a cut line with text after it is no cut line)
  let cutoff = len;
  const pattern = `\n${comment} ${CUT_LINE}\n`;
  if (buf.startsWith(pattern.slice(1))) cutoff = 0;
  else {
    const p = buf.indexOf(pattern);
    if (p >= 0 && p + 1 < len) cutoff = p + 1;
  }
  let boc = 0;
  let bol = 0;
  let inConflicts = false;
  while (bol < cutoff) {
    const nl = buf.indexOf("\n", bol);
    const next = nl < 0 || nl >= len ? len : nl + 1;
    if (buf.slice(bol, cutoff).startsWith(comment) || buf[bol] === "\n") {
      if (!boc) boc = bol;
    } else if (buf.startsWith("Conflicts:\n", bol)) {
      inConflicts = true;
      if (!boc) boc = bol;
    } else if (inConflicts && buf[bol] === "\t") {
      // a path in the conflicts block
    } else if (boc) {
      boc = 0;
      inConflicts = false;
    }
    bol = next;
  }
  return boc ? len - boc : len - cutoff;
}

/**
 * commit.c's ignored_log_message_bytes: how many characters at the end of `message` are not
 * part of the log message (trailing comments and blank lines, an old `Conflicts:` block, the
 * scissors line and what follows it): the `ignoreFooter` of {@link appendSignoff} for a
 * commit message being edited.
 */
export function ignoredLogMessageBytes(message: string, commentString = "#"): number {
  return ignoredBytes(message, message.length, commentString || "#");
}

/** trailer.c's find_end_of_log_message: before a `---` line (unless `noDivider`) and the ignored tail. */
function endOfLogMessage(input: string, noDivider: boolean, comment: string): number {
  let end = input.length;
  if (!noDivider) {
    for (let s = 0; s < input.length; s = nextLine(input, s)) {
      if (input.startsWith("---", s) && isSpace(input[s + 3])) {
        end = s;
        break;
      }
    }
  }
  return end - ignoredBytes(input, end, comment);
}

/** trailer.c's find_trailer_block_start: where the block starts, `len` when there is none. */
function trailerBlockStart(buf: string, len: number, config: Resolved): number {
  const comment = config.commentString;
  let s = 0;
  for (; s < len; s = nextLine(buf, s)) {
    if (buf.slice(s, len).startsWith(comment)) continue;
    if (isBlankLine(buf, s)) break;
  }
  const endOfTitle = s;
  let onlySpaces = true;
  let recognizedPrefix = false;
  let trailerLines = 0;
  let nonTrailerLines = 0;
  let possibleContinuationLines = 0;
  for (let l = lastLine(buf, len); l >= endOfTitle; l = lastLine(buf, l)) {
    if (buf.slice(l, len).startsWith(comment)) {
      nonTrailerLines += possibleContinuationLines;
      possibleContinuationLines = 0;
      continue;
    }
    if (isBlankLine(buf, l)) {
      if (onlySpaces) continue;
      nonTrailerLines += possibleContinuationLines;
      if (recognizedPrefix && trailerLines * 3 >= nonTrailerLines) return nextLine(buf, l);
      if (trailerLines && !nonTrailerLines) return nextLine(buf, l);
      return len;
    }
    onlySpaces = false;
    if (GIT_GENERATED_PREFIXES.some((p) => buf.startsWith(p, l))) {
      trailerLines++;
      possibleContinuationLines = 0;
      recognizedPrefix = true;
      continue;
    }
    const separatorPos = findSeparator(buf, l, config.separators, config.legacy);
    if (separatorPos >= 1 && !isSpace(buf[l])) {
      trailerLines++;
      possibleContinuationLines = 0;
      if (recognizedPrefix) continue;
      const line = buf.slice(l);
      if (config.items.some((item) => tokenMatches(line, item, separatorPos))) {
        recognizedPrefix = true;
      }
    } else if (isSpace(buf[l])) possibleContinuationLines++;
    else {
      nonTrailerLines++;
      nonTrailerLines += possibleContinuationLines;
      possibleContinuationLines = 0;
    }
  }
  return len;
}

/** git's unfold_value: each line end and the blanks after it one space, then trimmed. */
function unfoldValue(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; ) {
    let c = value[i++] as string;
    if (c === "\n") {
      while (i < value.length && isSpace(value[i])) i++;
      c = " ";
    }
    out += c;
  }
  return trim(out);
}

/** A trailer block (trailer.c's `trailer_block`). */
interface Block {
  start: number;
  end: number;
  /** Its lines, a continuation (a line starting with a blank) joined to the trailer before it */
  lines: string[];
  /** A blank line comes right before `start` */
  blankLineBefore: boolean;
}

/** trailer.c's trailer_block_get. */
function trailerBlock(message: string, config: Resolved, noDivider: boolean): Block {
  const end = endOfLogMessage(message, noDivider, config.commentString);
  const start = trailerBlockStart(message, end, config);
  const lines: string[] = [];
  let lastIsTrailer = false;
  for (let i = start; i < end; ) {
    const next = Math.min(nextLine(message, i), end);
    const line = message.slice(i, next);
    i = next;
    if (lastIsTrailer && isSpace(line[0])) {
      lines[lines.length - 1] += line;
      continue;
    }
    lines.push(line);
    lastIsTrailer = findSeparator(line, 0, config.separators, config.legacy) >= 1;
  }
  // ends_with_blank_line(message, start)
  const ll = lastLine(message, start);
  return { start, end, lines, blankLineBefore: ll >= 0 && isBlankLine(message, ll) };
}

/** A line of a block, or a trailer to add (git's `trailer_item`). */
interface Item {
  /** undefined for a line that is not a trailer */
  token?: string;
  value: string;
}

/** The settings a trailer is added with (git's `conf_info`). */
interface Conf {
  command?: string;
  cmd?: string;
  where: TrailerWhere;
  ifExists: TrailerIfExists;
  ifMissing: TrailerIfMissing;
}

/** A trailer to add (git's `arg_item`). */
interface ArgItem {
  token: string;
  value: string;
  conf: Conf;
}

function confOf(item: TrailerItemConfig | undefined, config: Resolved): Conf {
  return {
    ...(item?.command !== undefined ? { command: item.command } : {}),
    ...(item?.cmd !== undefined ? { cmd: item.cmd } : {}),
    where: item?.where ?? config.where,
    ifExists: item?.ifExists ?? config.ifExists,
    ifMissing: item?.ifMissing ?? config.ifMissing,
  };
}

/**
 * git's parse_trailer: the token and value of `trailer` around its separator (the whole
 * text as the token for -1), the token replaced by the `key` of the item it names.
 */
function parseTrailer(
  trailer: string,
  separatorPos: number,
  config: Resolved,
): { token: string; value: string; item?: TrailerItemConfig } {
  let token: string;
  let value = "";
  if (separatorPos !== -1) {
    token = trim(trailer.slice(0, separatorPos));
    value = trim(trailer.slice(separatorPos + 1));
  } else token = trim(trailer);
  const len = tokenLength(token);
  const item = config.items.find((i) => tokenMatches(token, i, len));
  if (item) return { token: item.key ?? token, value, item };
  return { token, value };
}

/** trailer.c's parse_trailers: the block of `message` and its items. */
function parseTrailers(
  message: string,
  options: { unfold?: boolean; onlyTrailers?: boolean; noDivider: boolean },
  config: Resolved,
): { block: Block; items: Item[] } {
  const block = trailerBlock(message, config, options.noDivider);
  const items: Item[] = [];
  for (const trailer of block.lines) {
    if (trailer.startsWith(config.commentString)) continue;
    const separatorPos = findSeparator(trailer, 0, config.separators, config.legacy);
    if (separatorPos >= 1) {
      const parsed = parseTrailer(trailer, separatorPos, config);
      items.push({
        token: parsed.token,
        value: options.unfold ? unfoldValue(parsed.value) : parsed.value,
      });
    } else if (!options.onlyTrailers) {
      items.push({ value: trailer.endsWith("\n") ? trailer.slice(0, -1) : trailer });
    }
  }
  return { block, items };
}

/**
 * The lines of the trailer block of `message` (sequencer.c's trailer_iterator: no `---`
 * divider, values unfolded, non-trailer and comment lines included).
 *
 * @example
 * ```typescript
 * trailerLinesOf("Fix\n\nAcked-by: A\n").map((t) => [t.key, t.value]); // [["Acked-by", "A"]]
 * ```
 */
export function trailerLinesOf(message: string, trailerConfig: TrailerConfig = {}): TrailerLine[] {
  const config = resolve(trailerConfig);
  const { lines } = trailerBlock(message, config, true);
  return lines.map((raw) => {
    const separatorPos = findSeparator(raw, 0, config.separators, config.legacy);
    const parsed = parseTrailer(raw, separatorPos, config);
    return {
      raw,
      key: parsed.token,
      value: unfoldValue(parsed.value),
      isTrailer: separatorPos >= 1,
    };
  });
}

/** git's same_token: the tokens without final punctuation agree over the shorter, without case. */
function sameToken(a: Item, b: ArgItem): boolean {
  if (a.token === undefined) return false;
  const len = Math.min(tokenLength(a.token), tokenLength(b.token));
  return sameStart(a.token, b.token, len);
}

/** git's same_trailer: same token and the same value without case. */
function sameTrailer(a: Item, b: ArgItem): boolean {
  return sameToken(a, b) && lowerAscii(a.value) === lowerAscii(b.value);
}

const afterOrEnd = (where: TrailerWhere) => where === "after" || where === "end";

/** The state of one run of the engine: the commands' runner and git's stderr. */
interface Run {
  config: Resolved;
  runCommand?: TrailerCommandRunner;
  errors: string[];
}

/** git's apply_command: the command's trimmed output, "" (and an error) when it failed. */
async function applyCommand(conf: Conf, arg: string, run: Run): Promise<string> {
  let command: TrailerCommand;
  if (conf.cmd !== undefined) command = { command: conf.cmd, args: [arg] };
  else {
    const text = conf.command ?? "";
    const at = text.indexOf("$ARG");
    command = {
      command: at < 0 ? text : text.slice(0, at) + arg + text.slice(at + "$ARG".length),
      args: [],
    };
  }
  const outcome = await run.runCommand?.(command);
  if (outcome?.stderr) run.errors.push(outcome.stderr);
  if (outcome?.exitCode !== 0) {
    run.errors.push(`error: running trailer command '${command.command}' failed\n`);
    return "";
  }
  return trim(outcome.stdout);
}

/** git's apply_item_command: the value of a trailer with a command, from its output. */
async function applyItemCommand(inTok: Item | undefined, arg: ArgItem, run: Run): Promise<void> {
  if (!run.runCommand) return;
  if (arg.conf.command === undefined && arg.conf.cmd === undefined) return;
  const value = arg.value ? arg.value : (inTok?.value ?? "");
  arg.value = await applyCommand(arg.conf, value, run);
}

/** git's add_arg_to_input_list: after `on` (after, end) or before it. */
function addArg(list: Item[], on: Item, arg: ArgItem): void {
  const at = list.indexOf(on);
  const item: Item = { token: arg.token, value: arg.value };
  list.splice(afterOrEnd(arg.conf.where) ? at + 1 : at, 0, item);
}

/** git's check_if_different: no trailer from `inTok` on (toward the start for after/end) is the same. */
function checkIfDifferent(list: Item[], inTok: Item, arg: ArgItem, checkAll: boolean): boolean {
  const step = afterOrEnd(arg.conf.where) ? -1 : 1;
  let i = list.indexOf(inTok);
  do {
    if (sameTrailer(list[i] as Item, arg)) return false;
    i += step;
    if (i < 0 || i >= list.length) break;
  } while (checkAll);
  return true;
}

/** git's apply_arg_if_exists. */
async function applyIfExists(
  list: Item[],
  inTok: Item,
  arg: ArgItem,
  on: Item,
  run: Run,
): Promise<void> {
  switch (arg.conf.ifExists) {
    case "doNothing":
      return;
    case "replace":
      await applyItemCommand(inTok, arg, run);
      addArg(list, on, arg);
      list.splice(list.indexOf(inTok), 1);
      return;
    case "add":
      await applyItemCommand(inTok, arg, run);
      addArg(list, on, arg);
      return;
    case "addIfDifferent":
      await applyItemCommand(inTok, arg, run);
      if (checkIfDifferent(list, inTok, arg, true)) addArg(list, on, arg);
      return;
    case "addIfDifferentNeighbor":
      await applyItemCommand(inTok, arg, run);
      if (checkIfDifferent(list, on, arg, false)) addArg(list, on, arg);
      return;
  }
}

/** git's process_trailers_lists: each trailer to add applied to the block's items. */
async function processLists(list: Item[], args: ArgItem[], run: Run): Promise<void> {
  for (const arg of args) {
    // find_same_and_apply_arg
    const where = arg.conf.where;
    const middle = where === "after" || where === "before";
    const backwards = afterOrEnd(where);
    let applied = false;
    if (list.length > 0) {
      const start = (backwards ? list[list.length - 1] : list[0]) as Item;
      const order = backwards ? [...list].reverse() : [...list];
      for (const inTok of order) {
        if (!sameToken(inTok, arg)) continue;
        await applyIfExists(list, inTok, arg, middle ? inTok : start, run);
        applied = true;
        break;
      }
    }
    if (applied) continue;
    // apply_arg_if_missing
    if (arg.conf.ifMissing === "doNothing") continue;
    await applyItemCommand(undefined, arg, run);
    const item: Item = { token: arg.token, value: arg.value };
    if (afterOrEnd(where)) list.push(item);
    else list.unshift(item);
  }
}

/** git's parse_trailers_from_config: a trailer for each item with a `command`. */
function argsFromConfig(run: Run): ArgItem[] {
  // a host that runs no commands adds none
  if (!run.runCommand) return [];
  return run.config.items
    .filter((item) => item.command !== undefined)
    .map((item) => ({ token: item.key ?? item.name, value: "", conf: confOf(item, run.config) }));
}

/** git's parse_trailers_from_command_line_args (`=` is a separator there too). */
function argsFromCommandLine(trailers: readonly NewTrailer[], run: Run): ArgItem[] {
  const config = run.config;
  const separators = `=${config.separators}`;
  const args: ArgItem[] = [];
  for (const trailer of trailers) {
    const separatorPos = findSeparator(trailer.text, 0, separators, config.legacy);
    if (separatorPos === 0) {
      run.errors.push(`error: empty trailer token in trailer '${trim(trailer.text)}'\n`);
      continue;
    }
    const parsed = parseTrailer(trailer.text, separatorPos, config);
    const conf = confOf(parsed.item, config);
    if (trailer.where) conf.where = trailer.where;
    if (trailer.ifExists) conf.ifExists = trailer.ifExists;
    if (trailer.ifMissing) conf.ifMissing = trailer.ifMissing;
    args.push({ token: parsed.token, value: parsed.value, conf });
  }
  return args;
}

/** git's last_non_space_char. */
function lastNonSpace(s: string): string {
  for (let i = s.length - 1; i >= 0; i--) if (!isSpace(s[i])) return s[i] as string;
  return "";
}

/** format_trailers for interpret-trailers (2.43: print_all). */
function formatItems(
  items: readonly Item[],
  options: { trimEmpty?: boolean; onlyTrailers?: boolean },
  config: Resolved,
): string {
  let out = "";
  for (const item of items) {
    if (item.token !== undefined) {
      if (options.trimEmpty && item.value === "") continue;
      const c = lastNonSpace(item.token);
      // 2.43's print_tok_val prints nothing for a token of blanks
      if (config.legacy && !c) continue;
      out += item.token;
      if (c && !config.separators.includes(c)) out += `${config.separators[0]} `;
      out += `${item.value}\n`;
    } else if (!options.onlyTrailers) {
      if (config.legacy && options.trimEmpty && item.value === "") continue;
      out += `${item.value}\n`;
    }
  }
  return out;
}

/** The trailers as {@link NewTrailer}s, strings taking the options' placement. */
function newTrailersOf(options: InterpretTrailersOptions): NewTrailer[] {
  return (options.trailers ?? []).map((t) =>
    typeof t === "string"
      ? {
          text: t,
          ...(options.where ? { where: options.where } : {}),
          ...(options.ifExists ? { ifExists: options.ifExists } : {}),
          ...(options.ifMissing ? { ifMissing: options.ifMissing } : {}),
        }
      : t,
  );
}

/**
 * trailer.c's process_trailers: `message` with its trailer block parsed, the configured and
 * given trailers applied, and the block written back (the text around it kept as it is).
 */
export async function processTrailers(
  message: string,
  options: InterpretTrailersOptions = {},
  trailerConfig: TrailerConfig = {},
): Promise<InterpretTrailersResult> {
  const config = resolve(trailerConfig);
  const onlyTrailers = options.onlyTrailers || options.parse;
  const onlyInput = options.onlyInput || options.parse;
  const unfold = options.unfold || options.parse;
  const run: Run = {
    config,
    ...(options.runCommand ? { runCommand: options.runCommand } : {}),
    errors: [],
  };
  const { block, items } = parseTrailers(
    message,
    { unfold: !!unfold, onlyTrailers: !!onlyTrailers, noDivider: !!options.noDivider },
    config,
  );
  let out = "";
  if (!onlyTrailers) out += message.slice(0, block.start);
  if (!onlyTrailers && !block.blankLineBefore) out += "\n";
  if (!onlyInput) {
    const args = [...argsFromConfig(run), ...argsFromCommandLine(newTrailersOf(options), run)];
    await processLists(items, args, run);
  }
  out += formatItems(
    items,
    { trimEmpty: !!options.trimEmpty, onlyTrailers: !!onlyTrailers },
    config,
  );
  if (!onlyTrailers) out += message.slice(block.end);
  return { output: out, errors: run.errors.join("") };
}

/**
 * `git interpret-trailers` on one input: the message completed with a line end (as git 2.44+
 * reads its input), then {@link processTrailers}. `trailers` with `onlyInput`/`parse` is git's usage
 * error.
 *
 * @example
 * ```typescript
 * const config = { items: [{ name: "ack", key: "Acked-by" }] };
 * (await interpretTrailers("Fix\n", { trailers: ["ack: Peff"] }, config)).output;
 * // "Fix\n\nAcked-by: Peff\n"
 * ```
 */
export async function interpretTrailers(
  message: string,
  options: InterpretTrailersOptions = {},
  trailerConfig: TrailerConfig = {},
): Promise<InterpretTrailersResult> {
  if ((options.onlyInput || options.parse) && (options.trailers?.length ?? 0) > 0) {
    throw new GitApiError("error: --trailer with --only-input does not make sense", {
      exitCode: 129,
    });
  }
  // read_input_file's strbuf_complete_line (2.44+; 2.43 reads the input as it is)
  const complete =
    trailerConfig.compatibility !== "2.43" && message.length > 0 && !message.endsWith("\n");
  return processTrailers(complete ? `${message}\n` : message, options, trailerConfig);
}

/**
 * git's validate_trailer_args: the `error:` line refusing the first `--trailer` argument that
 * is empty or starts with a separator; undefined when all are fine.
 */
export function validateTrailerArgs(
  args: readonly string[],
  trailerConfig: TrailerConfig = {},
): string | undefined {
  const config = resolve(trailerConfig);
  const separators = `=${config.separators}`;
  for (const text of args) {
    if (!text) return "error: empty --trailer argument";
    if (findSeparator(text, 0, separators, config.legacy) === 0) {
      return `error: invalid trailer '${text}': missing key before separator`;
    }
  }
  return undefined;
}

/**
 * trailer.c's amend_strbuf_with_trailers, what `commit`, `tag`, `merge`, `rebase` and
 * `cherry-pick` do with their `--trailer` arguments: each added to `message` as
 * `interpret-trailers --no-divider --trailer <arg>` adds it (the configured `where`, `ifexists`,
 * `ifmissing` and commands apply). An empty argument throws git's `empty --trailer argument`.
 *
 * @example
 * ```typescript
 * (await amendWithTrailers("Fix\n", ["Closes: #12"])).output; // "Fix\n\nCloses: #12\n"
 * ```
 */
export async function amendWithTrailers(
  message: string,
  args: readonly string[],
  trailerConfig: TrailerConfig = {},
  runCommand?: TrailerCommandRunner,
): Promise<InterpretTrailersResult> {
  if (args.some((a) => a === "")) {
    throw new GitApiError("error: empty --trailer argument", { exitCode: 128 });
  }
  return processTrailers(
    message,
    { trailers: args, noDivider: true, ...(runCommand ? { runCommand } : {}) },
    trailerConfig,
  );
}

/** git's `Signed-off-by: <name> <email>` line (sign_off_header and fmt_name), with its line end. */
export function signoffLine(ident: { name: string; email: string }): string {
  return `Signed-off-by: ${ident.name} <${ident.email}>\n`;
}

/**
 * sequencer.c's append_signoff: `sob` (`Signed-off-by: <ident>` and a line end, see
 * {@link signoffLine}) added to `message` before its last `ignoreFooter` characters (commit's
 * comments and scissors, `ignored_log_message_bytes`), after a blank line unless the message
 * ends with a trailer block; nothing added when the block's last line is `sob` already
 * (has_conforming_footer), or when the message is `sob` alone. `dedup`
 * (APPEND_SIGNOFF_DEDUP, format-patch) adds nothing when the block has `sob` anywhere.
 *
 * @example
 * ```typescript
 * appendSignoff("Fix\n", "Signed-off-by: A <a@b>\n");
 * // "Fix\n\nSigned-off-by: A <a@b>\n"
 * ```
 */
export function appendSignoff(
  message: string,
  sob: string,
  trailerConfig: TrailerConfig = {},
  dedup = false,
  ignoreFooter = 0,
): string {
  // strbuf_complete_line
  let out =
    ignoreFooter === 0 && message.length > 0 && !message.endsWith("\n") ? `${message}\n` : message;
  const len = out.length - ignoreFooter;
  const body = out.slice(0, len);
  let footer: 0 | 1 | 2 | 3;
  if (body === sob) footer = 3;
  else {
    // has_conforming_footer
    const { lines } = trailerBlock(body, resolve(trailerConfig), true);
    let found = 0;
    lines.forEach((line, k) => {
      if (line.startsWith(sob)) found = k + 1;
    });
    footer = lines.length === 0 ? 0 : found === lines.length ? 3 : found ? 2 : 1;
  }
  const insert = (text: string) => {
    const at = out.length - ignoreFooter;
    out = out.slice(0, at) + text + out.slice(at);
  };
  if (footer === 0) {
    if (len === 0) insert("\n\n");
    else if (len === 1) insert("\n");
    else if (out[len - 2] !== "\n") insert("\n");
  }
  if (footer !== 3 && !(dedup && footer === 2)) insert(sob);
  return out;
}

/**
 * trailer.c's format_trailers_from_commit: the trailer block of `message` (from its
 * subject), whole when no option changes it, else each trailer formatted. `before` is what
 * the output already holds (git trims the blanks it ends with after a non-trailer line when
 * a separator is given); the result is `before` with the trailers after it.
 */
export function appendTrailers(
  before: string,
  message: string,
  options: TrailerFormatOptions = {},
  trailerConfig: TrailerConfig = {},
): string {
  const config = resolve(trailerConfig);
  const { block, items } = parseTrailers(
    message,
    { unfold: !!options.unfold, onlyTrailers: !!options.onlyTrailers, noDivider: true },
    config,
  );
  const filtered = options.keys !== undefined;
  if (
    !options.onlyTrailers &&
    !options.unfold &&
    !filtered &&
    options.separator === undefined &&
    !options.keyOnly &&
    !options.valueOnly &&
    options.keyValueSeparator === undefined
  ) {
    return before + message.slice(block.start, block.end);
  }
  let out = before;
  const origLength = out.length;
  for (const item of items) {
    if (item.token !== undefined) {
      const token = item.token;
      const keep =
        !filtered ||
        (options.keys ?? []).some((key) => {
          // format_trailer_match_cb: the key without a final `:`, the same length
          const len = key.endsWith(":") ? key.length - 1 : key.length;
          return token.length === len && sameStart(key, token, len);
        });
      if (!keep) continue;
      if (options.separator !== undefined && out.length !== origLength) out += options.separator;
      if (!options.valueOnly) out += token;
      if (!options.keyOnly && !options.valueOnly) {
        if (options.keyValueSeparator !== undefined) out += options.keyValueSeparator;
        else {
          const last = lastNonSpace(token);
          if (last && !config.separators.includes(last)) out += `${config.separators[0]} `;
        }
      }
      if (!options.keyOnly) out += item.value;
      if (options.separator === undefined) out += "\n";
    } else if (!options.onlyTrailers) {
      if (options.separator !== undefined && out.length !== origLength) out += options.separator;
      out += item.value;
      if (options.separator !== undefined) out = out.replace(/[ \t\n\r]+$/, "");
      else out += "\n";
    }
  }
  return out;
}

/** {@link appendTrailers} of `message` alone. */
export function formatTrailersOf(
  message: string,
  options: TrailerFormatOptions = {},
  config: TrailerConfig = {},
): string {
  return appendTrailers("", message, options, config);
}
