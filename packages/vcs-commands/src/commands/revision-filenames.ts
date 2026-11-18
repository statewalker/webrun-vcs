/**
 * git's checks of arguments that may be revisions or paths (`setup.c`): `check_filename`,
 * `verify_filename` (with `maybe_die_on_misspelt_object_name`) and `verify_non_filename`,
 * as `git rev-parse <args>` and `git log <args>` run them when no `--` separates the two.
 *
 * @example
 * ```typescript
 * const files = { prefix: "", exists: (p) => worktree.exists(p), inWorktree: true };
 * // a revision that is also a file: git's "both revision and filename"
 * const message = await verifyNonFilename(files, "a.txt");
 * if (message) throw new RevisionError("a.txt", message);
 * ```
 */

import { RevisionError } from "../errors/index.js";
import {
  handleRevisionArg,
  type ParsedRevisionArgs,
  type RevisionArgEntry,
  type RevisionArgOptions,
  unknownRevisionMessage,
} from "./revision-range.js";
import type { RevisionResolver } from "./revision-resolver.js";

/** What the checks see of the worktree. */
export interface ArgumentFiles {
  /** Whether there is a worktree (git's `is_inside_work_tree`); without one nothing is checked */
  readonly inWorktree: boolean;
  /** The current directory below the top (`sub/` or ""), git's `prefix` */
  readonly prefix: string;
  /** Whether something is at `path` (from the top), as git's `lstat` finds it */
  exists(path: string): Promise<boolean>;
}

const isGlobSpecial = (c: string) => c === "*" || c === "?" || c === "[" || c === "\\";
const isAlnum = (c: string | undefined) => c !== undefined && /^[A-Za-z0-9]$/.test(c);

/**
 * git's `looks_like_pathspec`: a wildcard (not escaped with a backslash), or long-form
 * pathspec magic (`:(...)`).
 */
export function looksLikePathspec(arg: string): boolean {
  let escaped = false;
  for (const c of arg) {
    if (escaped) escaped = false;
    else if (isGlobSpecial(c)) {
      if (c === "\\") escaped = true;
      else return true;
    }
  }
  return arg.startsWith(":(");
}

/**
 * git's `check_filename`: whether `arg` names something in the worktree, read against the
 * prefix (`:/x` from the top, `:/` the top itself; `:!x` and `:^x` as `x`). A path that
 * climbs out of the worktree exists only as the worktree's parents themselves (`..`).
 */
export async function checkFilename(files: ArgumentFiles, arg: string): Promise<boolean> {
  let path = arg;
  let prefix = files.prefix;
  if (path.startsWith(":/")) {
    path = path.slice(2);
    if (path === "") return true;
    prefix = "";
  } else if (path.startsWith(":!") || path.startsWith(":^")) {
    path = path.slice(2);
    if (path === "") return true;
  }
  const parts: string[] = [];
  let above = 0;
  for (const part of `${prefix}${path}`.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0) parts.pop();
      else above++;
      continue;
    }
    if (above > 0) return false;
    parts.push(part);
  }
  if (above > 0) return true;
  return files.exists(parts.join("/"));
}

/**
 * git's `verify_non_filename`: a revision read without `--` that also names a file is
 * ambiguous. The message git dies with, else undefined.
 */
export async function verifyNonFilename(
  files: ArgumentFiles,
  arg: string,
): Promise<string | undefined> {
  if (!files.inWorktree || arg.startsWith("-")) return undefined;
  if (!(await checkFilename(files, arg))) return undefined;
  return [
    `fatal: ambiguous argument '${arg}': both revision and filename`,
    "Use '--' to separate paths from revisions, like this:",
    "'git <command> [<revision>...] -- [<file>...]'",
  ].join("\n");
}

/**
 * git's `verify_filename`: an argument taken for a path must name one (or look like a
 * pathspec). The first such argument (`diagnose`) may have been meant as a revision: git
 * reads it again for a better message (`maybe_die_on_misspelt_object_name`: `path 'x' does
 * not exist in 'HEAD'`, `'x' is outside repository at '<dir>'`, ...), else says it is
 * neither; a later one is just no such path.
 *
 * @throws RevisionError with git's message where git dies, `output` what it printed
 */
export async function verifyFilename(
  files: ArgumentFiles,
  resolver: RevisionResolver,
  arg: string,
  diagnose: boolean,
  output: string[] = [],
): Promise<void> {
  const fail = (message: string): never => {
    throw new RevisionError(arg, [...resolver.warnings, message].join("\n"), output);
  };
  if (arg.startsWith("-")) fail(`fatal: option '${arg}' must come before non-option arguments`);
  if (looksLikePathspec(arg) || (await checkFilename(files, arg))) return;
  if (!diagnose) {
    fail(
      `fatal: ${arg}: no such path in the working tree.\n` +
        "Use 'git <command> -- <path>...' to specify paths that do not exist locally.",
    );
  }
  // ":(icase)foo" is magic, not a misspelt object name
  if (!(arg.startsWith(":") && !isAlnum(arg[1]))) {
    try {
      await resolver.dieOnMisspeltObjectName(arg);
    } catch (error) {
      if (error instanceof RevisionError) {
        throw new RevisionError(arg, error.message, output);
      }
      throw error;
    }
  }
  fail(unknownRevisionMessage(arg));
}

/** What {@link parseRevisionAndPathArgs} read. */
export interface RevisionAndPathArgs extends ParsedRevisionArgs {
  /** The arguments taken for paths (after `--`, or from the first that is no revision on) */
  readonly paths: string[];
}

/**
 * Reads arguments as `git log <args>` does (`setup_revisions`), revisions and paths mixed:
 * with a `--` the arguments before it are revisions (one that names nothing is git's `bad
 * revision`) and those after it paths, unchecked; without one, each revision must not also
 * name a file (`verify_non_filename`), and from the first argument that is no revision on
 * every argument is a path that must exist (`verify_filename`, the first diagnosed as a
 * misspelt revision). `--not` flips the sense of the revisions after it.
 *
 * @throws RevisionError with git's lines where git dies
 */
export async function parseRevisionAndPathArgs(
  resolver: RevisionResolver,
  args: readonly string[],
  files: ArgumentFiles,
  options: RevisionArgOptions,
): Promise<RevisionAndPathArgs> {
  const entries: RevisionArgEntry[] = [];
  const dashdash = args.indexOf("--");
  const revisions = dashdash < 0 ? args : args.slice(0, dashdash);
  const paths = dashdash < 0 ? [] : args.slice(dashdash + 1);
  let not = false;
  for (const [i, arg] of revisions.entries()) {
    if (arg === "--not") {
      not = !not;
      continue;
    }
    const handled = await handleRevisionArg(resolver, arg, not, options, entries, dashdash >= 0);
    if (handled === false) {
      if (dashdash >= 0 || arg.startsWith("^")) {
        throw new RevisionError(
          arg,
          [...resolver.warnings, `fatal: bad revision '${arg}'`].join("\n"),
        );
      }
      for (let j = i; j < revisions.length; j++) {
        await verifyFilename(files, resolver, revisions[j], j === i);
      }
      return { entries, warnings: resolver.warnings, paths: [...revisions.slice(i), ...paths] };
    }
    if (dashdash < 0 && handled.verifyName !== undefined) {
      const message = await verifyNonFilename(files, handled.verifyName);
      if (message) throw new RevisionError(arg, [...resolver.warnings, message].join("\n"));
    }
  }
  return { entries, warnings: resolver.warnings, paths };
}
