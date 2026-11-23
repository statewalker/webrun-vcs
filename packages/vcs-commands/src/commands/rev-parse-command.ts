/**
 * RevParseCommand - `git rev-parse --verify <rev>`: the object a revision names, through
 * the same resolver every command uses (see `revision-resolver.ts` for the syntax).
 *
 * @example
 * ```typescript
 * const { objectId } = await git.revParse().setRevision("main@{upstream}").call();
 * const { objectId: tree } = await git.revParse().setRevision("v1.0^{tree}").call();
 * const { warnings } = await git.revParse().setRevision("main@{1.year.ago}").call();
 * // warnings: ["warning: log for 'main' only goes back to Thu, 7 Apr 2005 22:13:13 +0000"]
 *
 * // without --verify: ranges and set notation, one line per object as git prints them
 * const { lines } = await git.revParse().addArgument("main..feat").addArgument("v1^!").call();
 * // lines: ["<feat>", "^<main>", "<v1's commit>", "^<its parent>"]
 * ```
 */

import type { ObjectId } from "@statewalker/vcs-core";

import { MissingArgumentError, RefNotFoundError, RevisionError } from "../errors/index.js";
import { GitCommand } from "../git-command.js";
import { commitsBaseSource, MergeBaseGraph } from "./merge-bases.js";
import { verifyFilename } from "./revision-filenames.js";
import type { RevisionResolver } from "./revision-resolver.js";

/** What {@link RevParseCommand} found. */
export interface RevParseResult {
  /** The object the revision names (an annotated tag as the tag object) */
  readonly objectId: ObjectId;
  /** git's warnings while resolving it (`warning: log for 'x' only goes back to ...`) */
  readonly warnings: string[];
  /**
   * What `git rev-parse <args>...` prints for the arguments given with `addArgument`: an id
   * per line, `^<id>` for an excluded one (empty in `setRevision` mode)
   */
  readonly lines: string[];
}

/**
 * Resolve one revision as `git rev-parse --verify` does.
 *
 * Throws `RefNotFoundError` ("fatal: Needed a single revision") when it names nothing, and
 * `RevisionError` with git's own `fatal:` line where git dies interpreting it
 * (`fatal: no upstream configured for branch 'x'`, `fatal: HEAD does not point to a
 * branch`, `fatal: log for 'x' only has 2 entries`).
 */
export class RevParseCommand extends GitCommand<RevParseResult> {
  /** Never writes refs: runs in a repository whose ref store only reads. */
  protected override get writesRefs(): boolean {
    return false;
  }

  private revision?: string;
  private readonly args: string[] = [];
  private prefix = "";

  /**
   * An argument of `git rev-parse` without `--verify`: a revision (`HEAD`, `^v1`), a range
   * (`a..b`, `a...b`, either side defaulting to HEAD) or a parent shorthand (`x^@`, `x^!`,
   * `x^-<n>`). The result's `lines` hold what git prints for all of them.
   */
  addArgument(arg: string): this {
    this.checkCallable();
    this.args.push(arg);
    return this;
  }

  /**
   * The current directory below the top of the worktree (`sub/dir/`), for `<rev>:./<path>`
   * and `<rev>:../<path>` as git reads them run from there.
   */
  setPrefix(prefix: string): this {
    this.checkCallable();
    this.prefix = prefix === "" || prefix.endsWith("/") ? prefix : `${prefix}/`;
    return this;
  }

  /** The revision to resolve (`HEAD~2`, `@{u}`, `main@{yesterday}`, `:/fix`, `HEAD:a.txt`). */
  setRevision(revision: string): this {
    this.checkCallable();
    this.revision = revision;
    return this;
  }

  async call(): Promise<RevParseResult> {
    this.checkCallable();
    this.setCallable(false);
    if (this.revision === undefined && this.args.length > 0) return this.parseArgs();
    if (this.revision === undefined) throw new MissingArgumentError("revision");
    const resolver = this.revisionResolver();
    resolver.cwdPrefix = this.prefix;
    // git tries ranges and parent shorthands first even with --verify: it prints them, then
    // finds no single revision
    const printed: string[] = [];
    if (
      (await this.tryDifference(resolver, this.revision, printed)) ||
      (await this.tryParentShorthands(resolver, this.revision, printed))
    ) {
      const lines = [...resolver.warnings, "fatal: Needed a single revision"];
      throw new RevisionError(this.revision, lines.join("\n"), printed);
    }
    let objectId: ObjectId | undefined;
    try {
      objectId = await resolver.resolve(this.revision);
    } catch (error) {
      // what git printed before it died comes first
      if (error instanceof RevisionError && resolver.warnings.length > 0) {
        throw new RevisionError(this.revision, [...resolver.warnings, error.message].join("\n"));
      }
      throw error;
    }
    if (objectId === undefined) {
      const lines = [...resolver.warnings, "fatal: Needed a single revision"];
      // a symmetric difference with a side that is no commit printed both sides first
      if (printed.length > 0) throw new RevisionError(this.revision, lines.join("\n"), printed);
      throw new RefNotFoundError(this.revision, lines.join("\n"));
    }
    const read = await this.replacementMessages();
    return { objectId, warnings: [...read, ...resolver.warnings], lines: [] };
  }

  /**
   * `git rev-parse <args>...` (builtin/rev-parse.c: try_difference, try_parent_shorthands,
   * then a revision, else a path): `--` and everything after it printed as they are (with a
   * `--` an argument before it that names nothing is git's `bad revision`); without it the
   * first argument that is no revision is printed as a path that must exist
   * (`verify_filename`, diagnosed as a misspelt revision: `path 'x' does not exist in
   * 'HEAD'`, `'../x' is outside repository at '<dir>'`), and the arguments after it are
   * paths too (`x: no such path in the working tree.`).
   */
  private async parseArgs(): Promise<RevParseResult> {
    const resolver = this.revisionResolver();
    resolver.cwdPrefix = this.prefix;
    const files = this.argumentFiles(this.prefix);
    const hasDashdash = this.args.includes("--");
    const lines: string[] = [];
    // git's as_is: 1 after the first path (later ones verified), 2 after `--`
    let asIs = 0;
    for (const arg of this.args) {
      if (asIs) {
        lines.push(arg);
        if (asIs < 2) await verifyFilename(files, resolver, arg, false, lines);
        continue;
      }
      if (arg === "--") {
        asIs = 2;
        lines.push(arg);
        continue;
      }
      if (await this.tryDifference(resolver, arg, lines)) continue;
      if (await this.tryParentShorthands(resolver, arg, lines)) continue;
      const reversed = arg.startsWith("^");
      let id: ObjectId | undefined;
      try {
        id = await resolver.resolve(reversed ? arg.slice(1) : arg);
      } catch (error) {
        if (error instanceof RevisionError && resolver.warnings.length > 0) {
          throw new RevisionError(arg, [...resolver.warnings, error.message].join("\n"));
        }
        throw error;
      }
      if (id !== undefined) {
        lines.push(reversed ? `^${id}` : id);
        continue;
      }
      if (hasDashdash) {
        throw new RevisionError(
          arg,
          [...resolver.warnings, `fatal: bad revision '${arg}'`].join("\n"),
          lines,
        );
      }
      // printed as a path, which must exist; before it dies git reads it again quietly
      // (maybe_die_on_misspelt_object_name): what it prints regardless of GET_OID_QUIETLY
      // (`error: object x is a tree, not a commit`) comes out twice
      asIs = 1;
      lines.push(arg);
      await verifyFilename(files, resolver, arg, true, lines);
    }
    const first = lines[0] ?? "";
    return {
      objectId: first.startsWith("^") ? first.slice(1) : first,
      warnings: [...(await this.replacementMessages()), ...resolver.warnings],
      lines,
    };
  }

  /**
   * git's `try_difference`: `a..b` prints b and ^a; `a...b` prints b, a and ^ each merge base.
   * A symmetric difference with a side that is no commit has printed b and a when git finds
   * that (`error: object x is a tree, not a commit`) and gives up on it.
   */
  private async tryDifference(
    resolver: RevisionResolver,
    arg: string,
    lines: string[],
  ): Promise<boolean> {
    const at = arg.indexOf("..");
    if (at < 0) return false;
    let end = arg.slice(at + 2);
    const symmetric = end.startsWith(".");
    if (symmetric) end = end.slice(1);
    const startName = at === 0 ? "HEAD" : arg.slice(0, at);
    const endName = end === "" ? "HEAD" : end;
    // just ".." is the parent directory's pathspec
    if (at === 0 && end === "" && !symmetric) return false;
    const start = await resolver.resolve(startName, { hint: "committish" });
    if (start === undefined) return false;
    const stop = await resolver.resolve(endName, { hint: "committish" });
    if (stop === undefined) return false;
    lines.push(stop, symmetric ? start : `^${start}`);
    if (symmetric) {
      const a = await resolver.commitReference(start);
      const b = a === undefined ? undefined : await resolver.commitReference(stop);
      if (a === undefined || b === undefined) return false;
      for (const base of await this.mergeBases(a, b)) lines.push(`^${base}`);
    }
    return true;
  }

  /** git's `try_parent_shorthands`: `x^!`, `x^@`, `x^-[<n>]`. */
  private async tryParentShorthands(
    resolver: RevisionResolver,
    arg: string,
    lines: string[],
  ): Promise<boolean> {
    let includeRev = false;
    let includeParents = false;
    let excludeParent = 0;
    const bang = arg.indexOf("^!");
    const at = arg.indexOf("^@");
    const dash = arg.indexOf("^-");
    const mark = bang >= 0 ? bang : at >= 0 ? at : dash;
    if (bang >= 0) {
      includeRev = true;
      if (mark + 2 !== arg.length) return false;
    } else if (at >= 0) {
      includeParents = true;
      if (mark + 2 !== arg.length) return false;
    } else if (dash >= 0) {
      includeRev = true;
      excludeParent = 1;
      const digits = arg.slice(mark + 2);
      if (digits !== "") {
        // strtoul: the whole rest a number, not 0
        if (!/^\s*\+?\d+$/.test(digits)) return false;
        excludeParent = Number(digits);
        if (!excludeParent) return false;
      }
    } else {
      return false;
    }
    const name = arg.slice(0, mark);
    const id = await resolver.resolve(name, { hint: "committish" });
    if (id === undefined) return false;
    const commit = await resolver.commitReference(id);
    if (commit === undefined) return false;
    const parents = (await resolver.parentsOf(commit)) ?? [];
    if (excludeParent && excludeParent > parents.length) return false;
    if (includeRev) lines.push(id);
    parents.forEach((p, i) => {
      if (excludeParent && i + 1 !== excludeParent) return;
      lines.push(includeParents ? p : `^${p}`);
    });
    return true;
  }

  private mergeBases(a: ObjectId, b: ObjectId): Promise<ObjectId[]> {
    return revisionMergeBases(this.walkCommits, a, b);
  }
}

/** The merge bases of two commits in git's order (`repo_get_merge_bases`). */
export async function revisionMergeBases(
  commits: Parameters<typeof commitsBaseSource>[0],
  a: ObjectId,
  b: ObjectId,
): Promise<ObjectId[]> {
  const graph = new MergeBaseGraph(commitsBaseSource(commits, async () => new Map()));
  const bases = await graph.mergeBases(graph.commit(a), graph.commit(b));
  return bases.map((n) => n.id).filter((id): id is ObjectId => id !== undefined);
}
