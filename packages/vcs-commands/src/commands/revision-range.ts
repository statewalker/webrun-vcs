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
 * one that names nothing fails with git's `fatal: bad revision '<arg>'`.
 */

import type { ObjectId } from "@statewalker/vcs-core";

import { RevisionError } from "../errors/index.js";
import type { DisambiguateHint, RevisionResolver } from "./revision-resolver.js";

/** One commit (or object) an argument named, and whether it is excluded (`^`). */
export interface RevisionArgEntry {
  readonly id: ObjectId;
  /** Excluded: it and its ancestors are left out (git's `UNINTERESTING`) */
  readonly exclude: boolean;
  /** The name it was given by (`a` of `a..b`; undefined for a merge base of `a...b`) */
  readonly name?: string;
}

/** What {@link parseRevisionArgs} needs besides the resolver. */
export interface RevisionArgOptions {
  /** The merge bases of two commits in git's order (`repo_get_merge_bases`), for `a...b` */
  mergeBases(a: ObjectId, b: ObjectId): Promise<ObjectId[]>;
  /** Read plain revisions as committishes (git's `REVARG_COMMITTISH`, as `git log` does) */
  committish?: boolean;
}

/** The arguments read. */
export interface ParsedRevisionArgs {
  /** In git's pending order */
  readonly entries: RevisionArgEntry[];
  /** What git printed while reading them (`warning:`, `error:`, `hint:` lines) */
  readonly warnings: string[];
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
  args: readonly string[],
  options: RevisionArgOptions,
): Promise<ParsedRevisionArgs> {
  const entries: RevisionArgEntry[] = [];
  let not = false;
  for (const arg of args) {
    if (arg === "--not") {
      not = !not;
      continue;
    }
    const ok = await handleRevisionArg(resolver, arg, not, options, entries);
    if (!ok) {
      // revisions given apart from paths (after them comes `--`): git's `bad revision`
      throw new RevisionError(
        arg,
        [...resolver.warnings, `fatal: bad revision '${arg}'`].join("\n"),
      );
    }
  }
  return { entries, warnings: resolver.warnings };
}

/** git's `handle_revision_arg_1`; false where git returns -1. */
async function handleRevisionArg(
  resolver: RevisionResolver,
  arg: string,
  exclude: boolean,
  options: RevisionArgOptions,
  out: RevisionArgEntry[],
): Promise<boolean> {
  // just ".." is the parent directory's pathspec, not a range
  if (arg === "..") return false;
  const dotdot = await handleDotdot(resolver, arg, exclude, options, out);
  if (dotdot) return true;

  let rest = arg;
  let mark = rest.indexOf("^@");
  if (mark >= 0 && mark + 2 === rest.length) {
    if (await addParentsOnly(resolver, rest.slice(0, mark), exclude, 0, out)) return true;
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
  return true;
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
  if (aType === undefined || bType === undefined) throw dotdotMissing(arg, symmetric);
  if (!symmetric) {
    out.push({ id: a, exclude: !exclude, name: aName }, { id: b, exclude, name: bName });
    return true;
  }
  const ac = await resolver.peelTags(a);
  const bc = await resolver.peelTags(b);
  if (ac.type !== "commit" || bc.type !== "commit") throw dotdotMissing(arg, symmetric);
  for (const base of await options.mergeBases(ac.id, bc.id))
    out.push({ id: base, exclude: !exclude });
  out.push({ id: a, exclude, name: aName }, { id: b, exclude, name: bName });
  return true;
}

function dotdotMissing(arg: string, symmetric: boolean): RevisionError {
  return new RevisionError(
    arg,
    symmetric
      ? `fatal: Invalid symmetric difference expression ${arg}`
      : `fatal: Invalid revision range ${arg}`,
  );
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
