/**
 * git's revision arguments (`revision.c` `handle_revision_arg`, `handle_dotdot`,
 * `add_parents_only`): what `git log` and `git rev-list` make of `a..b`, `a...b`, `^a`,
 * `a^@`, `a^!`, `a^-<n>` and `--not`, as commits included and excluded (git's pending list:
 * included ones are walked, the excluded ones and their ancestors left out).
 *
 * @example
 * ```typescript
 * const resolver = new RevisionResolver(sources);
 * const { entries } = await parseRevisionArgs(resolver, ["main..feat", "^v1"], { mergeBases });
 * // [{ id: <main>, exclude: true, ... }, { id: <feat>, exclude: false, ... }, { id: <v1>, exclude: true, ... }]
 * ```
 *
 * `a..b` is `^a b` (either side defaults to HEAD); `a...b` is `a b` and `^` every merge base
 * of the two; `x^@` is the parents of x; `x^!` is x without its parents; `x^-<n>` (`x^-` for
 * n = 1) is x without its nth parent; `--not` flips the sense of the arguments after it.
 * Revisions in a range are read as committishes, as are the others where the command asks
 * (`committish`, as `git log` does). The arguments are revisions only, as before git's `--`:
 * one that names nothing fails with git's `fatal: bad revision '<arg>'`, and a lone `..` is
 * `HEAD..HEAD` (without `--` git would take it for the parent directory).
 */

import type { ObjectId } from "@statewalker/vcs-core";
import { wildmatch } from "@statewalker/vcs-working-tree";

import { RevisionError } from "../errors/index.js";
import type { DisambiguateHint, RevisionResolver } from "./revision-resolver.js";

/** One commit (or object) an argument named, and whether it is excluded (`^`). */
export interface RevisionArgEntry {
  readonly id: ObjectId;
  /** Excluded: it and its ancestors are left out (git's `UNINTERESTING`) */
  readonly exclude: boolean;
  /** The name it was given by (`a` of `a..b`; undefined for a merge base of `a...b`) */
  readonly name?: string;
  /** The left side of a symmetric difference (`a` of `a...b`, git's SYMMETRIC_LEFT) */
  readonly left?: boolean;
}

/** A ref and the object it names (a symbolic ref resolved). */
export interface RefTip {
  readonly name: string;
  readonly id: ObjectId;
}

/** What {@link parseRevisionArgs} needs besides the resolver. */
export interface RevisionArgOptions {
  /** The merge bases of two commits in git's order (`repo_get_merge_bases`), for `a...b` */
  mergeBases(a: ObjectId, b: ObjectId): Promise<ObjectId[]>;
  /** Read plain revisions as committishes (git's `REVARG_COMMITTISH`, as `git log` does) */
  committish?: boolean;
  /**
   * Every ref under `refs/` in name order (byte order), symbolic ones resolved and broken
   * ones left out, for `--all`, `--branches`, `--tags`, `--remotes` and `--glob`; without,
   * those options name nothing
   */
  refs?(): Promise<RefTip[]>;
  /** What HEAD names (`--all` adds it after the refs); undefined when it names nothing */
  head?(): Promise<ObjectId | undefined>;
  /**
   * `--ignore-missing`: a revision that names nothing is skipped instead of dying
   * (handle_revision_arg's `revs->ignore_missing`), on the command line and in `--stdin`
   */
  ignoreMissing?: boolean;
}

/**
 * The revisions `--stdin` reads (revision.c's read_revisions_from_stdin): one per line, up
 * to an empty line; `--not`, `--all`, `--branches[=]`, `--tags[=]`, `--remotes[=]`,
 * `--glob=`, `--exclude=` among them (`--not` there flips only the lines after it), `--`
 * then paths, `--end-of-options` makes every later line a revision.
 */
export interface StdinRevisions {
  readonly stdin: string;
}

/** An argument {@link parseRevisionArgs} reads: a command-line argument, or `--stdin`'s text. */
export type RevisionArg = string | StdinRevisions;

/** The arguments read. */
export interface ParsedRevisionArgs {
  /** In git's pending order */
  readonly entries: RevisionArgEntry[];
  /** What git printed while reading them (`warning:`, `error:`, `hint:` lines) */
  readonly warnings: string[];
  /**
   * git's `rev_input_given`: a revision or a ref option was read, so git does not fall back
   * to HEAD even when they named nothing (`--glob=nothing`)
   */
  readonly inputGiven?: boolean;
  /** The paths `--stdin` read after its `--` line */
  readonly stdinPaths?: string[];
}

/** The state of a revision parse that options share (git's `rev_info`). */
interface RevisionArgState {
  /** `--exclude=` patterns, for the next ref option */
  excludes: string[];
  inputGiven: boolean;
  stdinPaths: string[];
}

/** dir.c's has_glob_specials */
const hasGlobSpecials = (text: string) => /[*?[\\]/.test(text);

/**
 * The ref options of `git log`/`git rev-list` (revision.c's handle_revision_pseudo_opt):
 * the number of arguments `args[at]` takes (1, or 2 for a detached `--glob <pattern>` /
 * `--exclude <pattern>`), 0 when it is none. Each ref option adds its refs (as
 * `refs_for_each_ref` lists them, in name order) that no `--exclude=` pattern given since
 * the last ref option names (wildmatch without `WM_PATHNAME`, on the name the option gives:
 * `main` for `--branches`, `refs/heads/main` for `--all` and `--glob`), and clears the
 * patterns.
 */
async function handleRefOption(
  args: readonly string[],
  at: number,
  exclude: boolean,
  options: RevisionArgOptions,
  state: RevisionArgState,
  out: RevisionArgEntry[],
): Promise<number> {
  const arg = args[at] as string;
  /** parse_long_opt: `--<name>=<value>` or `--<name> <value>` */
  const longOpt = (name: string): { value: string; count: number } | undefined => {
    if (arg.startsWith(`--${name}=`)) return { value: arg.slice(name.length + 3), count: 1 };
    if (arg !== `--${name}`) return undefined;
    const value = args[at + 1];
    if (value === undefined) {
      throw new RevisionError(arg, `fatal: Option '--${name}' requires a value`);
    }
    return { value, count: 2 };
  };
  const refs = async () => (options.refs ? options.refs() : []);
  const add = (name: string, id: ObjectId) => {
    if (state.excludes.some((pattern) => wildmatch(pattern, name))) return;
    out.push({ id, exclude, name });
  };
  /** refs_for_each_ref_ext with a pattern: refs/ (or the prefix) before it, `/*` after a plain name */
  const realPattern = (prefix: string | undefined, pattern: string) => {
    let real = prefix ?? (pattern.startsWith("refs/") ? "" : "refs/");
    real += pattern;
    if (!hasGlobSpecials(pattern)) real = `${real.endsWith("/") ? real : `${real}/`}*`;
    return real;
  };
  const kinds: Record<string, string> = {
    branches: "refs/heads/",
    tags: "refs/tags/",
    remotes: "refs/remotes/",
  };
  const done = (count: number) => {
    state.excludes = [];
    state.inputGiven = true;
    return count;
  };
  if (arg === "--all") {
    for (const ref of await refs()) add(ref.name, ref.id);
    const head = await options.head?.();
    if (head !== undefined) add("HEAD", head);
    return done(1);
  }
  const kind = /^--(branches|tags|remotes)(=(.*))?$/s.exec(arg);
  if (kind) {
    const prefix = kinds[kind[1] as string] as string;
    const pattern = kind[2] !== undefined ? realPattern(prefix, kind[3] as string) : undefined;
    for (const ref of await refs()) {
      if (!ref.name.startsWith(prefix) || ref.name.length === prefix.length) continue;
      if (pattern !== undefined && !wildmatch(pattern, ref.name)) continue;
      add(ref.name.slice(prefix.length), ref.id);
    }
    return done(1);
  }
  const glob = longOpt("glob");
  if (glob) {
    const pattern = realPattern(undefined, glob.value);
    for (const ref of await refs()) if (wildmatch(pattern, ref.name)) add(ref.name, ref.id);
    return done(glob.count);
  }
  const excluded = longOpt("exclude");
  if (excluded) {
    state.excludes.push(excluded.value);
    return excluded.count;
  }
  return 0;
}

/** git's die after an argument that is neither a revision nor a path (`git rev-parse x`). */
export function unknownRevisionMessage(arg: string): string {
  return [
    `fatal: ambiguous argument '${arg}': unknown revision or path not in the working tree.`,
    "Use '--' to separate paths from revisions, like this:",
    "'git <command> [<revision>...] -- [<file>...]'",
  ].join("\n");
}

/**
 * Reads revision arguments as `git rev-list <args> --` / `git log <args> --` do (`--not`
 * among them).
 *
 * @throws RevisionError with git's lines for an argument that names nothing, and where the
 *   resolver dies (`@{u}` without an upstream)
 */
export async function parseRevisionArgs(
  resolver: RevisionResolver,
  args: readonly RevisionArg[],
  options: RevisionArgOptions,
): Promise<ParsedRevisionArgs> {
  const entries: RevisionArgEntry[] = [];
  const state: RevisionArgState = { excludes: [], inputGiven: false, stdinPaths: [] };
  let not = false;
  let endOfOptions = false;
  const strings = args.map((arg) => (typeof arg === "string" ? arg : ""));
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as RevisionArg;
    if (typeof arg !== "string") {
      await readStdinRevisions(resolver, arg.stdin, options, state, entries);
      continue;
    }
    if (!endOfOptions && arg === "--end-of-options") {
      endOfOptions = true;
      continue;
    }
    if (!endOfOptions && arg === "--not") {
      not = !not;
      continue;
    }
    if (!endOfOptions && arg.startsWith("--")) {
      const taken = await handleRefOption(strings, i, not, options, state, entries);
      if (taken > 0) {
        i += taken - 1;
        continue;
      }
    }
    const ok = await handleRevisionArg(resolver, arg, not, options, entries, true);
    if (ok === false && !options.ignoreMissing) {
      // revisions given apart from paths (after them comes `--`): git's `bad revision`
      throw new RevisionError(
        arg,
        [...resolver.warnings, `fatal: bad revision '${arg}'`].join("\n"),
      );
    }
    state.inputGiven = true;
  }
  return {
    entries,
    warnings: resolver.warnings,
    inputGiven: state.inputGiven,
    stdinPaths: state.stdinPaths,
  };
}

/** revision.c's read_revisions_from_stdin over `text`, its `--not` its own. */
async function readStdinRevisions(
  resolver: RevisionResolver,
  text: string,
  options: RevisionArgOptions,
  state: RevisionArgState,
  out: RevisionArgEntry[],
): Promise<void> {
  // strbuf_getline: lines end at LF, a CR before it dropped; the last one may lack its LF
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const line = (i: number) => {
    const l = lines[i] as string;
    return l.endsWith("\r") ? l.slice(0, -1) : l;
  };
  let not = false;
  let endOfOptions = false;
  for (let i = 0; i < lines.length; i++) {
    const arg = line(i);
    if (arg === "") return;
    if (arg === "--") {
      for (let k = i + 1; k < lines.length; k++) state.stdinPaths.push(line(k));
      return;
    }
    if (!endOfOptions && arg.startsWith("-")) {
      if (arg === "--end-of-options") {
        endOfOptions = true;
        continue;
      }
      if (arg === "--not") {
        not = !not;
        continue;
      }
      // the option alone: a detached `--glob` takes no next line (git dies)
      if (await handleRefOption([arg], 0, not, options, state, out)) continue;
      throw new RevisionError(arg, `fatal: invalid option '${arg}' in --stdin mode`);
    }
    const ok = await handleRevisionArg(resolver, arg, not, options, out, true);
    if (ok === false && !options.ignoreMissing) {
      throw new RevisionError(
        arg,
        [...resolver.warnings, `fatal: bad revision '${arg}'`].join("\n"),
      );
    }
    state.inputGiven = true;
  }
}

/**
 * git's `handle_revision_arg_1`: the entries `arg` names appended to `out`; false where git
 * returns -1, else the name git's `verify_non_filename` checks when no `--` follows the
 * revisions (the whole `a..b`, a plain revision without its `^`, `^!` or `^-<n>`; none for
 * `x^@`).
 * `cantBeFilename` is git's `REVARG_CANNOT_BE_FILENAME` (the revisions are followed by
 * `--`): a lone `..` is then `HEAD..HEAD`, otherwise the parent directory's pathspec.
 */
export async function handleRevisionArg(
  resolver: RevisionResolver,
  arg: string,
  exclude: boolean,
  options: RevisionArgOptions,
  out: RevisionArgEntry[],
  cantBeFilename: boolean,
): Promise<false | { verifyName?: string }> {
  if (!cantBeFilename && arg === "..") return false;
  const dotdot = await handleDotdot(resolver, arg, exclude, options, out);
  if (dotdot) return { verifyName: arg };

  let rest = arg;
  let mark = rest.indexOf("^@");
  if (mark >= 0 && mark + 2 === rest.length) {
    // git returns before verify_non_filename here
    if (await addParentsOnly(resolver, rest.slice(0, mark), exclude, 0, out)) return {};
  }
  mark = rest.indexOf("^!");
  if (mark >= 0 && mark + 2 === rest.length) {
    const base = rest.slice(0, mark);
    if (await addParentsOnly(resolver, base, !exclude, 0, out)) rest = base;
  }
  mark = rest.indexOf("^-");
  if (mark >= 0) {
    let parent = 1;
    const digits = rest.slice(mark + 2);
    if (digits !== "") {
      // strtol_i: an optional sign and digits, nothing after them
      if (!/^\s*[+-]?\d+$/.test(digits)) return false;
      parent = Number(digits);
      if (!Number.isSafeInteger(parent) || parent > 2147483647 || parent < 1) return false;
    }
    const base = rest.slice(0, mark);
    if (await addParentsOnly(resolver, base, !exclude, parent, out)) rest = base;
  }

  let local = exclude;
  if (rest.startsWith("^")) {
    local = !local;
    rest = rest.slice(1);
  }
  const hint: DisambiguateHint | undefined = options.committish ? "committish" : undefined;
  const id = await resolver.resolve(rest, { hint });
  if (id === undefined) return false;
  out.push({ id, exclude: local, name: rest });
  return { verifyName: rest };
}

/** git's `handle_dotdot`: `a..b` and `a...b`; false when `arg` is none or a side names nothing. */
async function handleDotdot(
  resolver: RevisionResolver,
  arg: string,
  exclude: boolean,
  options: RevisionArgOptions,
  out: RevisionArgEntry[],
): Promise<boolean> {
  const at = arg.indexOf("..");
  if (at < 0) return false;
  let rest = arg.slice(at + 2);
  const symmetric = rest.startsWith(".");
  if (symmetric) rest = rest.slice(1);
  const aName = arg.slice(0, at) || "HEAD";
  const bName = rest || "HEAD";
  const a = await resolver.resolve(aName, { hint: "committish" });
  if (a === undefined) return false;
  const b = await resolver.resolve(bName, { hint: "committish" });
  if (b === undefined) return false;
  const aType = await resolver.objectType(a);
  const bType = await resolver.objectType(b);
  if (aType === undefined || bType === undefined) throw dotdotMissing(resolver, arg, symmetric);
  if (!symmetric) {
    out.push({ id: a, exclude: !exclude, name: aName }, { id: b, exclude, name: bName });
    return true;
  }
  // lookup_commit_reference of each side: git names the first that is no commit
  const ac = await resolver.commitReference(a);
  const bc = ac === undefined ? undefined : await resolver.commitReference(b);
  if (ac === undefined || bc === undefined) throw dotdotMissing(resolver, arg, symmetric);
  for (const base of await options.mergeBases(ac, bc)) out.push({ id: base, exclude: !exclude });
  out.push({ id: a, exclude, name: aName, left: true }, { id: b, exclude, name: bName });
  return true;
}

/** git's `dotdot_missing`, after what the resolver printed (`error: object x is a tree, ...`). */
function dotdotMissing(resolver: RevisionResolver, arg: string, symmetric: boolean): RevisionError {
  const fatal = symmetric
    ? `fatal: Invalid symmetric difference expression ${arg}`
    : `fatal: Invalid revision range ${arg}`;
  return new RevisionError(arg, [...resolver.warnings, fatal].join("\n"));
}

/**
 * git's `add_parents_only`: the parents of the commit `arg` names (only the nth with
 * `parent`), with `exclude` (flipped by a leading `^`); false when it names no commit or has
 * fewer parents.
 */
async function addParentsOnly(
  resolver: RevisionResolver,
  arg: string,
  exclude: boolean,
  parent: number,
  out: RevisionArgEntry[],
): Promise<boolean> {
  let name = arg;
  let flags = exclude;
  if (name.startsWith("^")) {
    flags = !flags;
    name = name.slice(1);
  }
  const id = await resolver.resolve(name, { hint: "committish", quiet: false });
  if (id === undefined) return false;
  const peeled = await resolver.peelTags(id);
  if (peeled.type !== "commit") return false;
  const parents = (await resolver.parentsOf(peeled.id)) ?? [];
  if (parent && parent > parents.length) return false;
  parents.forEach((p, i) => {
    if (parent && i + 1 !== parent) return;
    out.push({ id: p, exclude: flags, name });
  });
  return true;
}
