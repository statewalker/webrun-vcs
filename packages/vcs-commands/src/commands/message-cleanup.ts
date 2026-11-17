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
 * and `scissors` are `whitespace` for a commit or a merge; a tag's default is `strip`.
 */
export enum CleanupMode {
  /** git's default: `whitespace` for a commit or merge message given, `strip` for a tag. */
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

/** The comment prefix git strips (`core.commentString`, `core.commentChar`; `#`, also for `auto`). */
export function commentPrefixOf(workingCopy: WorkingCopy): string {
  const config = RemoteConfigStore.from(workingCopy);
  const value = config.value("core.commentString") ?? config.value("core.commentChar");
  if (!value || value.toLowerCase() === "auto" || value.includes("\n")) return "#";
  return value;
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

/** git's `cleanup_message`: a message cleaned up as `mode` says (none for `verbatim`). */
export function cleanupWith(
  workingCopy: WorkingCopy,
  message: string,
  mode: CleanupMode.STRIP | CleanupMode.WHITESPACE | CleanupMode.VERBATIM,
): string {
  if (mode === CleanupMode.VERBATIM) return message;
  return stripspace(message, mode === CleanupMode.STRIP ? commentPrefixOf(workingCopy) : undefined);
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
): string {
  return cleanupWith(workingCopy, completeLine(message), commitCleanupMode(workingCopy, mode));
}

/**
 * A tag message given as git's `tag -m` gives it: `strip` by default (comment lines go,
 * even without an editor), `whitespace`, or `verbatim` (no newline added); `tag.c` knows no
 * other mode (`scissors` is refused, as git's `Invalid cleanup mode`) and reads no
 * configuration for it.
 */
export function tagMessageFromOption(
  message: string,
  mode: CleanupMode | undefined,
  workingCopy: WorkingCopy,
): string {
  switch (mode ?? CleanupMode.DEFAULT) {
    case CleanupMode.DEFAULT:
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
