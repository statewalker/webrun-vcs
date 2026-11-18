/**
 * git's checks of arguments that may be revisions or paths (`setup.c`): `check_filename`,
 * `verify_filename` (with `maybe_die_on_misspelt_object_name`) and `verify_non_filename`,
 * as `git rev-parse <args>` and `git log <args>` run them when no `--` separates the two.
 *
 * @example
 * ```typescript
 * const files = { prefix: "", exists: (p) => lstatExists(lookup, p), inWorktree: true };
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
  /**
   * Whether git's `lstat` of `path`, read from the top as written (`..`, `.`, a trailing
   * slash and all), finds something: see {@link lstatExists}
   */
  exists(path: string): Promise<boolean>;
}

/** The entries of a worktree as {@link lstatExists} reads them, links not followed. */
export interface WorktreeLookup {
  /** What is at `path` (from the top, no `.` or `..`, no link among its parents), or undefined */
  kind(path: string): Promise<"file" | "directory" | "symlink" | undefined>;
  /** The target of the link at `path` */
  readlink(path: string): Promise<string | undefined>;
  /** The top of the worktree as the host names it (`/home/u/repo`), when there is one */
  readonly hostPath?: string;
}

/** The kernel's limit on links followed in one lookup (`ELOOP`). */
const MAX_LINKS = 40;

/**
 * Whether `lstat(path)` succeeds with the current directory at the top of the worktree, as
 * the kernel resolves the path: each component but the last must be a directory (a link is
 * followed to its target, relative to the directory holding it), `..` steps up from where
 * the components led (out of a linked directory, out of the worktree and back in through
 * its own name), a trailing slash asks for a directory (following a last link); the last
 * component is not followed. Outside the worktree only the directories above it are known;
 * any other path there reads as absent (git would look on disk).
 *
 * @example
 * ```typescript
 * await lstatExists(lookup, "a.txt/"); // false: a file is no directory
 * await lstatExists(lookup, "lnk/c.txt"); // true when lnk links to a directory holding c.txt
 * ```
 */
export async function lstatExists(lookup: WorktreeLookup, path: string): Promise<boolean> {
  // the worktree's top as host path components; without one a name no path can spell
  const top = lookup.hostPath?.split("/").filter((p) => p !== "") ?? ["\0worktree"];
  const queue = path.split("/").filter((p) => p !== "");
  if (queue.length === 0 && !path.startsWith("/")) return false;
  // a trailing slash: the path must name a directory, through a last link too
  if (path.endsWith("/")) queue.push(".");
  let at = path.startsWith("/") ? [] : [...top];
  let links = 0;
  const inside = (abs: string[]) =>
    abs.length >= top.length && top.every((part, i) => abs[i] === part);
  const above = (abs: string[]) =>
    abs.length < top.length && abs.every((part, i) => top[i] === part);
  while (queue.length > 0) {
    const part = queue.shift() as string;
    if (part === ".") continue;
    if (part === "..") {
      at.pop();
      continue;
    }
    const next = [...at, part];
    let kind: "file" | "directory" | "symlink" | undefined;
    if (inside(next)) kind = await lookup.kind(next.slice(top.length).join("/"));
    else if (above(next)) kind = "directory";
    else return false;
    if (kind === undefined) return false;
    if (queue.length === 0) return true;
    if (kind === "file") return false;
    if (kind === "symlink") {
      if (++links > MAX_LINKS) return false;
      const target = await lookup.readlink(next.slice(top.length).join("/"));
      if (!target) return false;
      queue.unshift(...target.split("/").filter((p) => p !== ""));
      if (target.startsWith("/")) at = [];
      continue;
    }
    at = next;
  }
  return true;
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
 * prefix (`:/x` from the top, `:/` the top itself; `:!x` and `:^x` as `x`), looked up as
 * git's `lstat` looks it up (see {@link lstatExists}).
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
  return files.exists(path.startsWith("/") ? path : `${prefix}${path}`);
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
