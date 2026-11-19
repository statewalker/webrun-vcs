/**
 * git's message cleanup: `strbuf_stripspace` and the `--cleanup` modes of `git commit`,
 * `git merge` and `git tag` (checked against git 2.43 and 2.56: `strbuf.c`, `sequencer.c`
 * `get_cleanup_mode`, `builtin/tag.c`).
 *
 * @example
 * ```typescript
 * stripspace("  \n\nsubject  \n# note\n\n\nbody\n\n");        // "subject\n# note\n\nbody\n"
 * stripspace("subject\n# note\n", "#");                        // "subject\n"
 * commitMessageFromOption("subject", CleanupMode.DEFAULT, wc); // "subject\n" (`commit -m`)
 * ```
 */

import type { WorkingCopy } from "@statewalker/vcs-working-tree";

import { InvalidArgumentError } from "../errors/index.js";
import { RemoteConfigStore } from "../remote-config/index.js";

/**
 * How a message is cleaned up before it is stored (git's `--cleanup=<mode>`).
 *
 * Without an editor (a message given with `-m`, which is what `setMessage` is), `default`
 * and `scissors` are `whitespace` for a commit or a merge; a tag's default (no mode) is
 * `strip`.
 */
export enum CleanupMode {
  /** git's default: `whitespace` for a commit or merge message given (a tag refuses it by name). */
  DEFAULT = "default",
  /** Comment lines dropped, then as `whitespace`. */
  STRIP = "strip",
  /** Trailing whitespace dropped, runs of blank lines collapsed, leading and trailing ones dropped. */
  WHITESPACE = "whitespace",
  /** The message as it is (a commit `-m` still ends its last line). */
  VERBATIM = "verbatim",
  /** `whitespace` without an editor (the scissors line only matters in an editor). */
  SCISSORS = "scissors",
}

/** git's `isspace` (`sane_ctype`): space, tab, line feed, carriage return. */
const isGitSpace = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r";

/**
 * git's `strbuf_stripspace`: every line loses its trailing whitespace; lines starting with
 * `commentPrefix` (when given) are dropped; blank lines at the start and the end are
 * dropped and runs of them inside collapse to one; every line ends with a newline.
 */
export function stripspace(text: string, commentPrefix?: string): string {
  let out = "";
  let empties = 0;
  let i = 0;
  while (i < text.length) {
    const eol = text.indexOf("\n", i);
    const end = eol < 0 ? text.length : eol + 1;
    const line = text.slice(i, end);
    i = end;
    if (commentPrefix && line.length > 0 && line.startsWith(commentPrefix)) continue;
    let len = line.length;
    while (len > 0 && isGitSpace(line[len - 1] ?? "")) len--;
    if (len === 0) {
      empties++;
      continue;
    }
    if (empties > 0 && out.length > 0) out += "\n";
    empties = 0;
    out += `${line.slice(0, len)}\n`;
  }
  return out;
}

/** git's `strbuf_complete_line`: a newline added to text that does not end with one. */
export function completeLine(text: string): string {
  return text.length === 0 || text.endsWith("\n") ? text : `${text}\n`;
}

/**
 * The comment prefix git strips: `core.commentChar` / `core.commentString`, whichever is
 * set last (git reads them as one variable), `#` when neither is. `auto` is `#`, except for
 * a commit message, which passes `message`: then it is git's `adjust_comment_line_char`
 * (`builtin/commit.c`), the first of `#;@!$%^&|:` that starts no line of it.
 */
export function commentPrefixOf(workingCopy: WorkingCopy, message?: string): string {
  const config = RemoteConfigStore.from(workingCopy);
  const value = config.lastValueOf(["core.commentChar", "core.commentString"]);
  if (value !== undefined && value.toLowerCase() === "auto") {
    return message === undefined ? "#" : autoCommentChar(message);
  }
  if (!value || value.includes("\n")) return "#";
  return value;
}

/**
 * git's `ignored_log_message_bytes` with `#` as the comment prefix: the length of the
 * trailing comments (and an old `Conflicts:` block) of a message, which
 * `adjust_comment_line_char` does not look at.
 */
function ignoredTrailingBytes(text: string): number {
  const cut = "\n# ------------------------ >8 ------------------------\n";
  let cutoff = text.length;
  if (text.startsWith(cut.slice(1))) cutoff = 0;
  else {
    const at = text.indexOf(cut);
    if (at >= 0 && at + 1 < cutoff) cutoff = at + 1;
  }
  let boc = 0;
  let bol = 0;
  let inConflicts = false;
  while (bol < cutoff) {
    const nl = text.indexOf("\n", bol);
    const next = nl < 0 ? text.length : nl + 1;
    if (text.slice(bol, cutoff).startsWith("#") || text[bol] === "\n") {
      if (!boc) boc = bol;
    } else if (text.startsWith("Conflicts:\n", bol)) {
      inConflicts = true;
      if (!boc) boc = bol;
    } else if (inConflicts && text[bol] === "\t") {
      // a path of the conflicts block
    } else if (boc) {
      boc = 0;
      inConflicts = false;
    }
    bol = next;
  }
  return boc ? text.length - boc : text.length - cutoff;
}

/** git's `adjust_comment_line_char`: a comment character no line of `text` starts with. */
function autoCommentChar(text: string): string {
  const candidates = [..."#;@!$%^&|:"];
  if (!text.includes("#")) return "#";
  const used = new Set<string>();
  if (text.length > 0) used.add(text[0] ?? "");
  const cutoff = text.length - ignoredTrailingBytes(text);
  for (let p = 0; p + 1 < cutoff; p++) {
    if ((text[p] === "\n" || text[p] === "\r") && text[p + 1] !== "\0") used.add(text[p + 1] ?? "");
  }
  const free = candidates.find((c) => !used.has(c));
  if (free === undefined) {
    throw new InvalidArgumentError(
      "core.commentChar",
      "auto",
      "fatal: unable to select a comment character that is not used\nin the current commit message",
    );
  }
  return free;
}

/** A cleanup mode given by name (`--cleanup=<name>`, `commit.cleanup`), as git parses it. */
function parseCleanupMode(name: string): CleanupMode {
  const mode = Object.values(CleanupMode).find((m) => m === name);
  if (!mode) {
    throw new InvalidArgumentError("cleanup", name, `fatal: Invalid cleanup mode ${name}`);
  }
  return mode;
}

/**
 * The cleanup of a message edited in an editor (git's `get_cleanup_mode` with `use_editor`):
 * the mode given, else `commit.cleanup`, else `default`, which is `strip` (comments
 * dropped); `scissors` stays (the message cut at the scissors line, comments kept).
 */
export function editorCleanupMode(
  workingCopy: WorkingCopy,
  mode: CleanupMode | undefined,
): CleanupMode.STRIP | CleanupMode.WHITESPACE | CleanupMode.VERBATIM | CleanupMode.SCISSORS {
  const configured = RemoteConfigStore.from(workingCopy).value("commit.cleanup");
  const chosen = mode ?? (configured !== undefined ? parseCleanupMode(configured) : undefined);
  if (chosen === CleanupMode.WHITESPACE) return CleanupMode.WHITESPACE;
  if (chosen === CleanupMode.VERBATIM) return CleanupMode.VERBATIM;
  if (chosen === CleanupMode.SCISSORS) return CleanupMode.SCISSORS;
  return CleanupMode.STRIP;
}

/**
 * The cleanup a commit or merge message gets (git's `get_cleanup_mode` without an editor):
 * the mode given, else `commit.cleanup`, else `default`; `default` and `scissors` are
 * `whitespace`.
 */
export function commitCleanupMode(
  workingCopy: WorkingCopy,
  mode: CleanupMode | undefined,
): CleanupMode.STRIP | CleanupMode.WHITESPACE | CleanupMode.VERBATIM {
  const configured = RemoteConfigStore.from(workingCopy).value("commit.cleanup");
  const chosen = mode ?? (configured !== undefined ? parseCleanupMode(configured) : undefined);
  if (chosen === CleanupMode.STRIP) return CleanupMode.STRIP;
  if (chosen === CleanupMode.VERBATIM) return CleanupMode.VERBATIM;
  return CleanupMode.WHITESPACE;
}

/**
 * git's `cleanup_message`: a message cleaned up as `mode` says (none for `verbatim`).
 * `forCommit`: git's commit, which turns `core.commentChar=auto` into a character the
 * message does not use (merge and tag strip `#` then).
 */
export function cleanupWith(
  workingCopy: WorkingCopy,
  message: string,
  mode: CleanupMode.STRIP | CleanupMode.WHITESPACE | CleanupMode.VERBATIM,
  forCommit = false,
): string {
  if (mode === CleanupMode.VERBATIM) return message;
  if (mode !== CleanupMode.STRIP) return stripspace(message);
  // core.commentChar=auto picks its character from the message as git's prepare_to_commit
  // has it then (whitespace already cleaned up)
  const prefix = commentPrefixOf(workingCopy, forCommit ? stripspace(message) : undefined);
  return stripspace(message, prefix);
}

/**
 * A message a merge, cherry-pick or revert prepared (`MERGE_MSG`, `SQUASH_MSG`), cleaned up
 * as git's commit cleans it once the editor accepts it (`get_cleanup_mode` with an editor):
 * the mode given, else `commit.cleanup`; `default` strips comments, `scissors` drops the
 * scissors line and everything below it, then cleans up whitespace.
 */
export function preparedMessageCleanup(
  workingCopy: WorkingCopy,
  message: string,
  mode: CleanupMode | undefined,
): string {
  const configured = RemoteConfigStore.from(workingCopy).value("commit.cleanup");
  const chosen =
    mode ?? (configured !== undefined ? parseCleanupMode(configured) : CleanupMode.DEFAULT);
  switch (chosen) {
    case CleanupMode.VERBATIM:
      return message;
    case CleanupMode.WHITESPACE:
      return stripspace(message);
    case CleanupMode.SCISSORS: {
      const prefix = commentPrefixOf(workingCopy, stripspace(message));
      const cut = `${prefix} ------------------------ >8 ------------------------\n`;
      const at = message.startsWith(cut) ? 0 : message.indexOf(`\n${cut}`);
      return stripspace(at < 0 ? message : message.slice(0, at === 0 ? 0 : at + 1));
    }
    default:
      return stripspace(message, commentPrefixOf(workingCopy, stripspace(message)));
  }
}

/**
 * A commit or merge message given as git's `-m` gives it: its last line ended
 * (`strbuf_complete_line`), then cleaned up (`whitespace` unless `mode` or
 * `commit.cleanup` says otherwise).
 */
export function commitMessageFromOption(
  message: string,
  mode: CleanupMode | undefined,
  workingCopy: WorkingCopy,
  forCommit = false,
): string {
  const cleanup = commitCleanupMode(workingCopy, mode);
  return cleanupWith(workingCopy, completeLine(message), cleanup, forCommit);
}

/**
 * A tag message given as git's `tag -m` gives it: `strip` by default (comment lines go,
 * even without an editor), `whitespace`, or `verbatim` (no newline added); `tag.c` knows no
 * other mode (`default` and `scissors` are refused, as git's `Invalid cleanup mode`) and
 * reads no configuration for it.
 */
export function tagMessageFromOption(
  message: string,
  mode: CleanupMode | undefined,
  workingCopy: WorkingCopy,
): string {
  // tag.c: no --cleanup is strip; only strip, verbatim and whitespace are known by name
  switch (mode ?? CleanupMode.STRIP) {
    case CleanupMode.STRIP:
      return stripspace(message, commentPrefixOf(workingCopy));
    case CleanupMode.WHITESPACE:
      return stripspace(message);
    case CleanupMode.VERBATIM:
      return message;
    default:
      throw new InvalidArgumentError("cleanup", mode, `fatal: Invalid cleanup mode ${mode}`);
  }
}
