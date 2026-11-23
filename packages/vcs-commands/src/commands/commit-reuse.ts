/**
 * The message helpers of `git commit -C/-c` and `--fixup/--squash` (builtin/commit.c's
 * parse_and_validate_options and prepare_to_commit, pretty.c's `%s`/`%b`/`%B`).
 */
import { IncompatibleOptionsError } from "../errors/index.js";
import { subjectOf } from "./merge-support.js";

/** The forms of `--fixup`: `fixup! ` commits, or `amend! ` ones (`amend:` and `reword:`). */
export type FixupKind = "fixup" | "amend" | "reword";

/**
 * `--fixup=<spec>` as parse_and_validate_options reads it: a run of ASCII letters followed by
 * a colon is a suboption (`amend:`/`reword:`; any other name is git's `unknown option`),
 * otherwise the whole spec names the commit.
 */
export function parseFixupSpec(
  spec: string,
): { kind: FixupKind; target: string } | { unknown: string; target: string } {
  const m = /^([A-Za-z]+):/.exec(spec);
  if (!m) return { kind: "fixup", target: spec };
  const name = m[1] as string;
  const target = spec.slice(name.length + 1);
  if (name === "amend" || name === "reword") return { kind: name, target };
  return { unknown: name, target };
}

/**
 * git's die_for_incompatible_opt4: the options given (`[name, given]`, in git's order),
 * refused when more than one is.
 */
export function refuseIncompatible(options: Array<[string, boolean]>): void {
  const given = options.filter(([, on]) => on).map(([name]) => name);
  if (given.length < 2) return;
  const quoted = given.map((n) => `'${n}'`);
  const list =
    quoted.length === 2
      ? `${quoted[0]} and ${quoted[1]}`
      : `${quoted.slice(0, -1).join(", ")}, and ${quoted[quoted.length - 1]}`;
  throw new IncompatibleOptionsError(given, `fatal: options ${list} cannot be used together`);
}

/** git's is_blank_line: nothing but isspace bytes. */
function isBlankLine(line: string): boolean {
  return /^[ \t\n\v\f\r]*$/.test(line);
}

/** git's skip_blank_lines: the text after its leading blank lines. */
export function skipBlankLines(text: string): string {
  let at = 0;
  while (at < text.length) {
    const nl = text.indexOf("\n", at);
    const end = nl < 0 ? text.length : nl + 1;
    if (!isBlankLine(text.slice(at, end))) break;
    at = end;
  }
  return text.slice(at);
}

/** git's commit_subject_length: the length of the first paragraph's lines (with their newlines). */
export function commitSubjectLength(text: string): number {
  let at = 0;
  while (at < text.length) {
    if (skipBlankLines(text.slice(at)).length !== text.length - at) break;
    const nl = text.indexOf("\n", at);
    at = nl < 0 ? text.length : nl + 1;
  }
  return at;
}

/** pretty.c's `%b`: the message after its subject paragraph and the blank lines around it. */
export function bodyOf(message: string): string {
  let rest = skipBlankLines(message);
  // format_subject's walk: the lines up to the first blank one
  while (rest.length > 0) {
    const nl = rest.indexOf("\n");
    const line = nl < 0 ? rest : rest.slice(0, nl + 1);
    if (isBlankLine(line)) break;
    rest = rest.slice(line.length);
  }
  return skipBlankLines(rest);
}

/**
 * prepare_amend_commit: the amended commit's whole message (`%B`), or only its body (`%b`)
 * when its subject already starts with `amend!` (an `amend!` commit amended again).
 */
export function amendCommitText(message: string): string {
  return skipBlankLines(message).startsWith("amend!") ? bodyOf(message) : message;
}

/** The first line of an autosquash commit (`fixup! %s`, `amend! %s`, `squash! %s`) and a blank line. */
export function autosquashSubject(prefix: "fixup" | "amend" | "squash", message: string): string {
  return `${prefix}! ${subjectOf(message)}\n\n`;
}
