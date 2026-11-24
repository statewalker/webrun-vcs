/**
 * The write side of `git config` on one file, as config.c writes it:
 * `repo_config_set_multivar_in_file_gently` (set, `--add`, `--replace-all`, unset,
 * `--unset-all`, value patterns) and `repo_config_copy_or_rename_section_in_file`
 * (`--rename-section`, `--remove-section`).
 *
 * Both work on the file's text the way git works on its bytes: the parser's events and their
 * offsets (`store_aux_event`) say which spans are copied, replaced or cut
 * (`maybe_remove_section`), so every byte git keeps (comments, blank lines, includes, other
 * sections, a variable on a header line) is kept as it was. The file is edited under
 * `<file>.lock`, created exclusively before the file is read and renamed over it once the new
 * text is written, as git's lock file; a refusal removes the lock and leaves the file alone.
 *
 * {@link GitWorkingCopyConfig.save} is the writer of the configuration a working copy holds in
 * memory; these functions are `git config`'s own edits of a file, sharing its parser
 * (`config-scanner.ts`).
 *
 * @example
 * ```typescript
 * const target = { files, path: ".git/config", name: ".git/config" };
 * const { status, stderr } = await setConfigMultivarInFile(target, "remote.origin.fetch",
 *   "+refs/heads/*:refs/remotes/origin/*", { valuePattern: "^\\+refs/heads/main:" });
 * ```
 */

import { compilePosixRegex, PosixRegexError } from "@statewalker/vcs-utils";
import { decodeGitPath, encodeGitPath } from "@statewalker/vcs-utils/encoding";
import {
  atomicFilesOver,
  type FilesApi,
  type PosixFilesApi,
  readFile,
} from "@statewalker/vcs-utils/files";
import {
  ConfigCursor,
  headerNames,
  isAlpha,
  isAsciiKeyChar,
  isConfigSpace,
  isKeyChar,
  readConfigValue,
  readSectionHeader,
  type SectionHeaderState,
} from "./config-scanner.js";

/** git's `CONFIG_REGEX_NONE`: a value pattern that matches no value (`--add`, `--append`) */
export const CONFIG_REGEX_NONE: unique symbol = Symbol("CONFIG_REGEX_NONE");

/** git's exit statuses of config writes (config.h) */
export const ConfigWriteStatus = {
  OK: 0,
  /** `CONFIG_INVALID_KEY` */
  INVALID_KEY: 1,
  /** `CONFIG_NO_SECTION_OR_NAME` */
  NO_SECTION_OR_NAME: 2,
  /** `CONFIG_INVALID_FILE` */
  INVALID_FILE: 3,
  /** `CONFIG_NO_WRITE` */
  NO_WRITE: 4,
  /** `CONFIG_NOTHING_SET` */
  NOTHING_SET: 5,
  /** `CONFIG_INVALID_PATTERN` */
  INVALID_PATTERN: 6,
  /** `CONFIG_NO_LOCK` (-1, exit status 255) */
  NO_LOCK: 255,
  /** git died (`bad config line <n> in file <file>`) */
  DIED: 128,
} as const;

/** The file a `git config` write edits. */
export interface ConfigFileLocation {
  /** The storage holding it (the repository's, or the host's for `--global` / `--system`) */
  files: FilesApi;
  /** Its path in {@link files} */
  path: string;
  /** The file as git names it in its messages (`.git/config`, the `--file` argument) */
  name: string;
}

/** Options of {@link setConfigMultivarInFile}, as `git config` passes them. */
export interface ConfigMultivarOptions {
  /**
   * Which values of the key are replaced or removed: a POSIX extended regex (`!` first
   * inverts it), the string itself with {@link fixedValue}, {@link CONFIG_REGEX_NONE} for
   * none (`--add`); absent: every value
   */
  valuePattern?: string | typeof CONFIG_REGEX_NONE;
  /** `--fixed-value`: {@link valuePattern} is compared as a string (`CONFIG_FLAGS_FIXED_VALUE`) */
  fixedValue?: boolean;
  /** `--replace-all` / `--unset-all` / `--all` (`CONFIG_FLAGS_MULTI_REPLACE`) */
  multiReplace?: boolean;
  /** `--comment`, prepared by {@link prepareConfigComment} (written after the value) */
  comment?: string;
}

/** What a config write did: git's exit status and what it wrote on stderr. */
export interface ConfigWriteOutcome {
  /** git's exit status ({@link ConfigWriteStatus}) */
  status: number;
  /** git's `warning:` / `error:` / `fatal:` lines, in order */
  stderr: string[];
}

/** What {@link setConfigMultivarText} computed. */
export interface ConfigMultivarTextResult {
  status: number;
  stderr: string[];
  /** The new text, when the file is to be written (status 0) */
  text?: string;
}

/** What {@link renameConfigSectionText} computed. */
export interface ConfigRenameTextResult {
  /** The headers that named the section (git's `ret`), or -1 when git refuses */
  count: number;
  stderr: string[];
  /** The new text (also when no header matched: git rewrites the file all the same) */
  text?: string;
}

/**
 * git's `git_config_prepare_comment_string` for `--comment`: kept as is when it starts with
 * blanks and `#`, a space put before a leading `#`, else ` # ` before it.
 *
 * @throws Error `no multi-line comment allowed: '<comment>'` (git dies)
 */
export function prepareConfigComment(comment: string): string {
  if (comment.includes("\n")) throw new Error(`no multi-line comment allowed: '${comment}'`);
  let blanks = 0;
  while (comment[blanks] === " " || comment[blanks] === "\t") blanks++;
  if (blanks > 0 && comment[blanks] === "#") return comment;
  if (comment[0] === "#") return ` ${comment}`;
  return ` # ${comment}`;
}

/** git's `do_parse_config_key`: the canonical key and its section's length, or git's refusal. */
export function parseConfigKey(
  key: string,
): { key: string; baselen: number } | { status: number; error: string } {
  const last = key.lastIndexOf(".");
  if (last <= 0) {
    return { status: 2, error: `key does not contain a section: ${key}` };
  }
  if (last === key.length - 1) {
    return { status: 2, error: `key does not contain variable name: ${key}` };
  }
  let out = "";
  let dot = false;
  for (let i = 0; i < key.length; i++) {
    let c = key[i];
    if (c === ".") dot = true;
    if (!dot || i > last) {
      if (!isAsciiKeyChar(c) || (i === last + 1 && !isAlpha(c))) {
        return { status: 1, error: `invalid key: ${key}` };
      }
      c = c.toLowerCase();
    } else if (c === "\n") {
      return { status: 1, error: `invalid key (newline): ${key}` };
    }
    out += c;
  }
  return { key: out, baselen: last };
}

/* ------------------------------------------------------------- parsing */

type EventType = "section" | "entry" | "whitespace" | "comment" | "eof" | "error";

interface ParsedEvent {
  begin: number;
  end: number;
  type: EventType;
  isKeysSection: boolean;
}

/** How {@link parseEvents} ended: read whole, refused by the event callback, or a bad line. */
type ParseEnd = { kind: "ok" } | { kind: "aborted" } | { kind: "bad-line"; line: number };

/**
 * git's `git_parse_source` with an event callback (`do_event`): each header, variable, run of
 * whitespace and comment with the offsets it spans (from its first character to the first
 * of the next event), handed on once the next one starts, and each variable's key and value
 * (`fn`) while its event is still pending.
 */
function parseEvents(
  text: string,
  onEvent: (type: EventType, begin: number, end: number, header: SectionHeaderState) => boolean,
  onEntry: (key: string, value: string | undefined) => void,
): ParseEnd {
  const cs = new ConfigCursor(text);
  let previous: EventType = "eof";
  let previousOffset = 0;
  const header: SectionHeaderState = { name: "", extended: false };
  let baselen = 0;
  let comment = false;
  let first = true;

  const doEvent = (type: EventType): boolean => {
    if (type === "whitespace" && previous === type) return true;
    let offset = cs.offset;
    if (type !== "eof") offset--;
    if (previous !== "eof" && !onEvent(previous, previousOffset, offset, header)) return false;
    previous = type;
    previousOffset = offset;
    return true;
  };

  for (;;) {
    const c = cs.next();
    if (first) {
      first = false;
      // the UTF-8 byte order mark (one character here) is skipped, as git skips its bytes
      if (c === "﻿" && !cs.eof) continue;
    }
    if (c === "\n") {
      if (cs.eof) return doEvent("eof") ? { kind: "ok" } : { kind: "aborted" };
      if (!doEvent("whitespace")) return { kind: "aborted" };
      comment = false;
      continue;
    }
    if (comment) continue;
    if (isConfigSpace(c)) {
      if (!doEvent("whitespace")) return { kind: "aborted" };
      continue;
    }
    if (c === "#" || c === ";") {
      if (!doEvent("comment")) return { kind: "aborted" };
      comment = true;
      continue;
    }
    if (c === "[") {
      if (!doEvent("section")) return { kind: "aborted" };
      const name = readSectionHeader(cs, header);
      if (name === undefined || name.length < 1) break;
      header.name = `${name}.`;
      baselen = header.name.length;
      continue;
    }
    if (!isAlpha(c)) break;
    if (!doEvent("entry")) return { kind: "aborted" };
    // get_value: the name after the section's stem, blanks, then `=` and the value
    let name = header.name.slice(0, baselen) + c.toLowerCase();
    let d = cs.next();
    while (!cs.eof && isKeyChar(d)) {
      name += d.toLowerCase();
      d = cs.next();
    }
    while (d === " " || d === "\t") d = cs.next();
    let value: string | undefined;
    if (d !== "\n") {
      if (d !== "=") break;
      value = readConfigValue(cs);
      if (value === undefined) break;
      const nul = value.indexOf("\0");
      if (nul >= 0) value = value.slice(0, nul);
    }
    // cs->var holds the variable's name now (what a following header event does not see)
    header.name = name;
    onEntry(name, value);
  }
  if (!doEvent("error")) return { kind: "aborted" };
  return { kind: "bad-line", line: cs.linenr };
}

/** ASCII case folding (C's `strncasecmp` in the C locale). */
const asciiLower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/* ------------------------------------------------------------- writing */

/** git's `store_create_section`: the header of `key`'s section as `key` spells it. */
function storeCreateSection(key: string, baselen: number): string {
  const head = key.slice(0, baselen);
  const dot = head.indexOf(".");
  if (dot >= 0) {
    let out = `[${head.slice(0, dot)} "`;
    for (const c of head.slice(dot + 1)) out += c === '"' || c === "\\" ? `\\${c}` : c;
    return `${out}"]\n`;
  }
  return `[${head}]\n`;
}

/** git's `write_pair`: `\t<name> = <value>` quoted and escaped as git writes it. */
function writePair(key: string, baselen: number, value: string, comment?: string): string {
  let quote = "";
  if (value[0] === " ") quote = '"';
  if (/[;#\r]/.test(value)) quote = '"';
  if (value.length > 0 && value[value.length - 1] === " ") quote = '"';
  let out = `\t${key.slice(baselen + 1)} = ${quote}`;
  for (const c of value) {
    if (c === "\n") out += "\\n";
    else if (c === "\t") out += "\\t";
    else if (c === '"' || c === "\\") out += `\\${c}`;
    else out += c;
  }
  return comment !== undefined ? `${out}${quote}${comment}\n` : `${out}${quote}\n`;
}

/** C's `isspace` without the newline: what git swallows before a variable it replaces. */
const isBlank = (c: string | undefined) => c === " " || c === "\t" || c === "\r";

interface Store {
  key: string;
  baselen: number;
  doNotMatch: boolean;
  fixedValue?: string;
  pattern?: ReturnType<typeof compilePosixRegex> | typeof CONFIG_REGEX_NONE;
  multiReplace: boolean;
  parsed: ParsedEvent[];
  seen: number[];
  seenNr: number;
  keySeen: boolean;
  sectionSeen: boolean;
  isKeysSection: boolean;
  warnings: string[];
}

/** git's `matches`. */
function matches(key: string, value: string | undefined, store: Store): boolean {
  if (key !== store.key) return false;
  if (store.fixedValue !== undefined && value !== undefined) return store.fixedValue === value;
  if (store.pattern === undefined) return true;
  if (store.pattern === CONFIG_REGEX_NONE) return false;
  return store.doNotMatch !== (value !== undefined && store.pattern.test(encodeGitPath(value)));
}

/**
 * git's `maybe_remove_section`: when the variables being unset are the last of their section
 * and no comment stands in it, before it or before its header, the whole section goes.
 */
function maybeRemoveSection(
  store: Store,
  span: { begin: number; end: number },
  seenAt: number,
): number {
  const { parsed } = store;
  let sectionSeen = false;
  let seen = seenAt;
  let i: number;
  for (i = store.seen[seen]; i > 0; i--) {
    const e = parsed[i - 1];
    if (e.type === "comment") return seenAt;
    if (e.type === "entry") {
      if (!sectionSeen) return seenAt;
      break;
    }
    if (e.type === "section") {
      if (!e.isKeysSection) break;
      sectionSeen = true;
    }
  }
  const begin = parsed[i].begin;
  for (i = store.seen[seen] + 1; i < parsed.length; i++) {
    const e = parsed[i];
    if (e.type === "comment") return seenAt;
    if (e.type === "section") {
      if (e.isKeysSection) continue;
      break;
    }
    if (e.type === "entry") {
      if (++seen < store.seenNr && i === store.seen[seen]) continue;
      return seenAt;
    }
  }
  span.begin = begin;
  span.end = i < parsed.length ? parsed[i].begin : parsed[parsed.length - 1].end;
  return seen;
}

/**
 * `repo_config_set_multivar_in_file_gently` on a file's text (`undefined`: no file): sets
 * `key` to `value`, or unsets it (`value` undefined), where {@link ConfigMultivarOptions}
 * say. The key must have passed {@link parseConfigKey}; `key` is as given (a new header and
 * variable name are written as spelled).
 */
export function setConfigMultivarText(
  contents: string | undefined,
  fileName: string,
  key: string,
  value: string | undefined,
  options: ConfigMultivarOptions = {},
): ConfigMultivarTextResult {
  const parsedKey = parseConfigKey(key);
  if ("status" in parsedKey) {
    return { status: parsedKey.status, stderr: [`error: ${parsedKey.error}`] };
  }
  if (contents === undefined) {
    // if .git/config does not exist yet, write a minimal version
    if (value === undefined) return { status: 5, stderr: [] };
    return {
      status: 0,
      stderr: [],
      text:
        storeCreateSection(key, parsedKey.baselen) +
        writePair(key, parsedKey.baselen, value, options.comment),
    };
  }

  const store: Store = {
    key: parsedKey.key,
    baselen: parsedKey.baselen,
    doNotMatch: false,
    multiReplace: options.multiReplace === true,
    parsed: [],
    seen: [],
    seenNr: 0,
    keySeen: false,
    sectionSeen: false,
    isKeysSection: false,
    warnings: [],
  };
  const pattern = options.valuePattern;
  if (pattern === CONFIG_REGEX_NONE) store.pattern = CONFIG_REGEX_NONE;
  else if (pattern !== undefined && options.fixedValue) store.fixedValue = pattern;
  else if (pattern !== undefined) {
    let source = pattern;
    if (source[0] === "!") {
      store.doNotMatch = true;
      source = source.slice(1);
    }
    try {
      store.pattern = compilePosixRegex(encodeGitPath(source), { extended: true });
    } catch (error) {
      if (!(error instanceof PosixRegexError)) throw error;
      return { status: 6, stderr: [`error: invalid pattern: ${source}`] };
    }
  }

  const errors: string[] = [];
  const end = parseEvents(
    contents,
    (type, begin, endOffset, header) => {
      const event: ParsedEvent = { begin, end: endOffset, type, isKeysSection: false };
      if (type === "section") {
        const name = header.name;
        if (name.length < 2 || name[name.length - 1] !== ".") {
          errors.push(`error: invalid section name '${name}'`);
          return false;
        }
        // git's store_aux_event: an old-style header compares without case (the swap of
        // strncasecmp and strncmp is git's own)
        const head = name.slice(0, store.baselen);
        const want = store.key.slice(0, store.baselen);
        event.isKeysSection =
          name.length - 1 === store.baselen &&
          (header.extended ? head === want : asciiLower(head) === asciiLower(want));
        store.isKeysSection = event.isKeysSection;
        if (store.isKeysSection) {
          store.sectionSeen = true;
          store.seen[store.seenNr] = store.parsed.length;
        }
      }
      store.parsed.push(event);
      return true;
    },
    (entryKey, entryValue) => {
      if (store.keySeen) {
        if (matches(entryKey, entryValue, store)) {
          if (store.seenNr === 1 && !store.multiReplace) {
            store.warnings.push(`warning: ${entryKey} has multiple values`);
          }
          store.seen[store.seenNr] = store.parsed.length;
          store.seenNr++;
        }
      } else if (store.isKeysSection) {
        store.seen[store.seenNr] = store.parsed.length;
        store.sectionSeen = true;
        if (matches(entryKey, entryValue, store)) {
          store.seenNr++;
          store.keySeen = true;
        }
      }
    },
  );
  if (end.kind === "aborted") {
    return {
      status: 3,
      stderr: [...store.warnings, ...errors, `error: invalid config file ${fileName}`],
    };
  }
  if (end.kind === "bad-line") {
    return {
      status: 128,
      stderr: [...store.warnings, `fatal: bad config line ${end.line} in file ${fileName}`],
    };
  }

  // if nothing to unset, or too many matches, error out
  if ((store.seenNr === 0 && value === undefined) || (store.seenNr > 1 && !store.multiReplace)) {
    return { status: 5, stderr: store.warnings };
  }

  const parsed = store.parsed;
  const eventAt = (j: number) => parsed[j] ?? { begin: 0, end: 0 };
  if (store.seenNr === 0) {
    // did not see key nor section: after the last event
    if (store.seen.length === 0) store.seen[0] = parsed.length - (parsed.length > 0 ? 1 : 0);
    store.seenNr = 1;
  }

  let out = "";
  let copyBegin = 0;
  for (let i = 0; i < store.seenNr; i++) {
    let replaceEnd: number;
    let copyEnd: number;
    const j = store.seen[i];
    if (!store.keySeen) {
      copyEnd = eventAt(j).end;
      // include '\n' when copying section header
      if (
        copyEnd > 0 &&
        copyEnd < contents.length &&
        contents[copyEnd - 1] !== "\n" &&
        contents[copyEnd] === "\n"
      ) {
        copyEnd++;
      }
      replaceEnd = copyEnd;
    } else {
      const span = { begin: eventAt(j).begin, end: eventAt(j).end };
      if (value === undefined) i = maybeRemoveSection(store, span, i);
      replaceEnd = span.end;
      copyEnd = span.begin;
      // swallow preceding white-space on the same line
      while (copyEnd > 0 && isBlank(contents[copyEnd - 1])) copyEnd--;
    }
    const newLine = copyEnd > 0 && contents[copyEnd - 1] !== "\n";
    if (copyEnd > copyBegin) {
      out += contents.slice(copyBegin, copyEnd);
      if (newLine) out += "\n";
    }
    copyBegin = replaceEnd;
  }
  if (value !== undefined) {
    if (!store.sectionSeen) out += storeCreateSection(key, store.baselen);
    out += writePair(key, store.baselen, value, options.comment);
  }
  if (copyBegin < contents.length) out += contents.slice(copyBegin);
  return { status: 0, stderr: store.warnings, text: out };
}

/** git's `section_name_is_ok`: not empty, letters, digits and `-` before the first dot. */
function sectionNameIsOk(name: string): boolean {
  if (name === "") return false;
  for (const c of name) {
    if (c === ".") break;
    if (!isAsciiKeyChar(c)) return false;
  }
  return true;
}

/** git's `GIT_CONFIG_MAX_LINE_LEN` */
const MAX_LINE_LEN = 512 * 1024;

/**
 * `repo_config_copy_or_rename_section_in_file` (rename or, `newName` undefined, remove) on a
 * file's text, line by line as git reads it: each header naming `oldName` as written (case
 * and all) is replaced by `newName`'s header as spelled (what followed the old header on its
 * line moved after a tab), or, removing, dropped with every line up to the next header.
 */
export function renameConfigSectionText(
  contents: string | undefined,
  fileName: string,
  oldName: string,
  newName: string | undefined,
): ConfigRenameTextResult {
  if (newName !== undefined && !sectionNameIsOk(newName)) {
    return { count: -1, stderr: [`error: invalid section name: ${newName}`] };
  }
  if (contents === undefined) return { count: 0, stderr: [], text: "" };
  let out = "";
  let count = 0;
  let remove = false;
  let lineNr = 0;
  for (let at = 0; at < contents.length; ) {
    const nl = contents.indexOf("\n", at);
    const next = nl < 0 ? contents.length : nl + 1;
    const line = contents.slice(at, next);
    at = next;
    lineNr++;
    if (line.length * 3 >= MAX_LINE_LEN && encodeGitPath(line).length >= MAX_LINE_LEN) {
      return {
        count: -1,
        stderr: [
          `error: refusing to work with overly long line in '${fileName}' on line ${lineNr}`,
        ],
      };
    }
    let output = line;
    let i = 0;
    while (isConfigSpace(line[i])) i++;
    if (line[i] === "[") {
      const offset = headerNames(line, oldName);
      if (offset > 0) {
        count++;
        if (newName === undefined) {
          remove = true;
          continue;
        }
        out += storeCreateSection(newName, newName.length);
        output = line.slice(offset);
        // more content means there's a declaration to put on the next line
        if (output.length > 0) output = `\t${output}`;
      }
      remove = false;
    }
    if (remove) continue;
    out += output;
  }
  return { count, stderr: [], text: out };
}

/* ---------------------------------------------------------------- files */

/** At most this many links are followed to the file a lock is taken for (git's `resolve_symlink`) */
const MAXDEPTH = 5;
/** At most this many links are followed when the file is opened (Linux's `MAXSYMLINKS`) */
const MAXSYMLINKS = 40;

/** C's `strerror` text of the errno codes a config file's open or lock meets */
const STRERROR: Record<string, string> = {
  EACCES: "Permission denied",
  EPERM: "Operation not permitted",
  EEXIST: "File exists",
  ENOENT: "No such file or directory",
  ENOTDIR: "Not a directory",
  EISDIR: "Is a directory",
  ELOOP: "Too many levels of symbolic links",
  EROFS: "Read-only file system",
  ENOSPC: "No space left on device",
  ENAMETOOLONG: "File name too long",
};

/** The `strerror` text of an error (its `code`), else its message. */
function reasonOf(error: unknown): string {
  const code = (error as { code?: string } | undefined)?.code;
  if (code && STRERROR[code]) return STRERROR[code];
  return error instanceof Error ? error.message : String(error);
}

/**
 * `path` with `.` and `..` resolved and empty components dropped (a leading `/` kept);
 * undefined when `..` would climb above its start (the storage's root).
 */
function normalizeLinkPath(path: string): string | undefined {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return undefined;
      out.pop();
    } else out.push(part);
  }
  return (path.startsWith("/") ? "/" : "") + out.join("/");
}

/**
 * `path` with at most `depth` symbolic links followed; `"loop"` when it is still a link
 * after `depth` of them and `strict` (the open's ELOOP), `"outside"` when a link leads where
 * this storage cannot follow (an absolute target outside its root).
 */
async function followLinks(
  files: FilesApi,
  path: string,
  depth: number,
  strict: boolean,
): Promise<string | "loop" | "outside"> {
  const posix = files as PosixFilesApi;
  if (!posix.lstat || !posix.readlink) return path;
  let current = path;
  for (let hop = 0; ; hop++) {
    const stats = await posix.lstat(current).catch(() => undefined);
    if (stats?.kind !== "symlink") return current;
    if (hop >= depth) return strict ? "loop" : current;
    const bytes = await posix.readlink(current);
    if (!bytes) return current;
    let target = decodeGitPath(bytes);
    if (target.startsWith("/")) {
      const root = posix.rootDirectory?.replace(/\/+$/, "");
      if (root === undefined) return "outside";
      const normal = normalizeLinkPath(target);
      if (normal === undefined) return "outside";
      target = normal;
      if (root === "") current = target;
      else if (target === root || target.startsWith(`${root}/`)) {
        current = target.slice(root.length) || "/";
      } else return "outside";
    } else {
      const slash = current.lastIndexOf("/");
      const joined = slash < 0 ? target : `${current.slice(0, slash + 1)}${target}`;
      // `..` climbs lexically, never above this storage's root
      const normal = normalizeLinkPath(joined);
      if (normal === undefined) return "outside";
      current = normal;
    }
  }
}

/**
 * The file `path` names, its symbolic links followed (at most five, as git's
 * `resolve_symlink`): what git's lock is taken for, so a linked `~/.gitconfig` stays a link
 * (the lock is renamed over the last link followed). Undefined when a link leads where this
 * storage cannot follow (an absolute target outside its root).
 */
export async function resolveConfigFileLink(
  files: FilesApi,
  path: string,
): Promise<string | undefined> {
  const resolved = await followLinks(files, path, MAXDEPTH, false);
  return resolved === "outside" || resolved === "loop" ? undefined : resolved;
}

/** What {@link readConfigFileThroughLinks} found. */
export type ConfigFileRead =
  | { kind: "file"; bytes: Uint8Array; path: string; mode?: number }
  | { kind: "absent" }
  | { kind: "directory" }
  | { kind: "error"; reason: string };

/**
 * A config file as git's `open` reads it: every symbolic link followed (a link to a link
 * whose end is missing is absent; more than {@link MAXSYMLINKS} links, a link to itself, is
 * `Too many levels of symbolic links`), with the permission bits of the file read, where the
 * storage keeps them. A link this storage cannot follow is an error, never absent.
 */
export async function readConfigFileThroughLinks(
  files: FilesApi,
  path: string,
): Promise<ConfigFileRead> {
  const real = await followLinks(files, path, MAXSYMLINKS, true);
  if (real === "loop") return { kind: "error", reason: STRERROR.ELOOP };
  if (real === "outside") {
    return { kind: "error", reason: "symbolic link leads outside the storage" };
  }
  try {
    const posix = files as PosixFilesApi;
    const entry = posix.lstat ? await posix.lstat(real) : undefined;
    const kind = posix.lstat ? entry?.kind : (await files.stats(real))?.kind;
    if (kind === undefined) return { kind: "absent" };
    if (kind === "directory") return { kind: "directory" };
    if (kind !== "file") return { kind: "error", reason: "not a regular file" };
    const bytes = await readFile(files, real);
    return {
      kind: "file",
      bytes,
      path: real,
      ...(entry?.mode !== undefined ? { mode: entry.mode } : {}),
    };
  } catch (error) {
    return { kind: "error", reason: reasonOf(error) };
  }
}

/** A lock taken on a config file: its text, and how to commit or drop it. */
interface ConfigLock {
  contents: string | undefined;
  commit(text: string): Promise<string | undefined>;
  rollback(): Promise<void>;
}

type LockRefusal = { error: string; status: number };

/**
 * Takes `<file>.lock` (git's `hold_lock_file_for_update`), reads the file through its links
 * and gives the lock the file's permission bits (git's `chmod` of the lock to `st_mode &
 * 07777`), so the rename never widens them. A refusal is git's message and status; the lock
 * is removed on every refusal after it was made.
 */
async function lockConfigFile(
  location: ConfigFileLocation,
  kind: "set" | "rename",
): Promise<ConfigLock | LockRefusal> {
  const { files, name } = location;
  const failure = (reason: string) => ({
    error:
      kind === "set"
        ? `error: could not lock config file ${name}: ${reason}`
        : `error: could not lock config file ${name}`,
    status: 255,
  });
  const path = await resolveConfigFileLink(files, location.path);
  if (path === undefined) return failure("symbolic link leads outside the storage");
  // git's lock is an open(O_CREAT | O_EXCL) in the file's directory: it creates no directory
  const slash = path.lastIndexOf("/");
  if (slash > 0) {
    const dirKind = (await files.stats(path.slice(0, slash)).catch(() => undefined))?.kind;
    if (dirKind === undefined) return failure(STRERROR.ENOENT);
    if (dirKind !== "directory") return failure(STRERROR.ENOTDIR);
  }
  const atomic = atomicFilesOver(files, "");
  const lockPath = `${path}.lock`;
  let created: boolean;
  try {
    created = await atomic.createExclusive(lockPath, new Uint8Array(0));
  } catch (error) {
    return failure(reasonOf(error));
  }
  if (!created) return failure(STRERROR.EEXIST);
  const rollback = async () => {
    await files.remove(lockPath).catch(() => false);
  };
  try {
    const read = await readConfigFileThroughLinks(files, location.path);
    if (read.kind === "error" || read.kind === "directory") {
      await rollback();
      const reason = read.kind === "error" ? read.reason : STRERROR.EISDIR;
      if (kind === "rename") {
        // warn_on_fopen_errors
        return { error: `warning: unable to access '${name}': ${reason}`, status: 255 };
      }
      return read.kind === "directory"
        ? { error: `error: unable to mmap '${name}': ${reason}`, status: 3 }
        : { error: `error: opening ${name}: ${reason}`, status: 3 };
    }
    if (read.kind === "file" && read.mode !== undefined) {
      // the lock gets the file's bits before the rename; a storage that keeps bits but
      // cannot set them refuses rather than widen them
      const chmod = (files as PosixFilesApi).chmod;
      try {
        if (!chmod) throw new Error("the storage cannot set file modes");
        await chmod.call(files, lockPath, read.mode & 0o7777);
      } catch (error) {
        await rollback();
        return {
          error: `error: chmod on ${name}.lock failed: ${reasonOf(error)}`,
          status: kind === "set" ? 4 : 255,
        };
      }
    }
    const contents = read.kind === "file" ? decodeGitPath(read.bytes) : undefined;
    return {
      contents,
      rollback,
      commit: async (text: string) => {
        try {
          await files.write(lockPath, [encodeGitPath(text)]);
          await atomic.replace(lockPath, path);
          return undefined;
        } catch (error) {
          await rollback();
          return `error: could not write config file ${name}: ${reasonOf(error)}`;
        }
      },
    };
  } catch (error) {
    await rollback();
    throw error;
  }
}

/** Runs `body` on a taken lock, which is removed if `body` throws (git's atexit rollback). */
async function withLock<T>(lock: ConfigLock, body: () => Promise<T>): Promise<T> {
  try {
    return await body();
  } catch (error) {
    await lock.rollback();
    throw error;
  }
}

/**
 * `repo_config_set_multivar_in_file_gently`: sets, adds, replaces or unsets values of `key`
 * in the file at `location`, under its lock (see {@link setConfigMultivarText}). The key is
 * checked before the lock is taken, the value pattern once the file is read, as git does.
 *
 * @example
 * ```typescript
 * // git config --unset-all remote.origin.fetch '^\+refs/tags/'
 * await setConfigMultivarInFile(target, "remote.origin.fetch", undefined, {
 *   valuePattern: "^\\+refs/tags/", multiReplace: true });
 * ```
 */
export async function setConfigMultivarInFile(
  location: ConfigFileLocation,
  key: string,
  value: string | undefined,
  options: ConfigMultivarOptions = {},
): Promise<ConfigWriteOutcome> {
  const parsedKey = parseConfigKey(key);
  if ("status" in parsedKey) {
    return { status: parsedKey.status, stderr: [`error: ${parsedKey.error}`] };
  }
  const lock = await lockConfigFile(location, "set");
  if ("error" in lock) return { status: lock.status, stderr: [lock.error] };
  return withLock(lock, async () => {
    const result = setConfigMultivarText(lock.contents, location.name, key, value, options);
    if (result.status !== 0 || result.text === undefined) {
      await lock.rollback();
      return { status: result.status, stderr: result.stderr };
    }
    const failed = await lock.commit(result.text);
    if (failed) return { status: 4, stderr: [...result.stderr, failed] };
    return { status: 0, stderr: result.stderr };
  });
}

/**
 * `repo_config_rename_section_in_file` (`newName` undefined: remove the section) under the
 * file's lock (see {@link renameConfigSectionText}). `count` is git's return: the headers
 * that named the section (0: git's `no such section`), -1 where git refuses.
 *
 * @example
 * ```typescript
 * const { count } = await renameConfigSectionInFile(target, "remote.origin", "remote.up");
 * ```
 */
export async function renameConfigSectionInFile(
  location: ConfigFileLocation,
  oldName: string,
  newName: string | undefined,
): Promise<{ count: number; stderr: string[] }> {
  if (newName !== undefined && !sectionNameIsOk(newName)) {
    return { count: -1, stderr: [`error: invalid section name: ${newName}`] };
  }
  const lock = await lockConfigFile(location, "rename");
  if ("error" in lock) return { count: -1, stderr: [lock.error] };
  return withLock(lock, async () => {
    const result = renameConfigSectionText(lock.contents, location.name, oldName, newName);
    if (result.count < 0 || result.text === undefined) {
      await lock.rollback();
      return { count: -1, stderr: result.stderr };
    }
    const failed = await lock.commit(result.text);
    if (failed) return { count: -1, stderr: [...result.stderr, failed] };
    return { count: result.count, stderr: result.stderr };
  });
}
