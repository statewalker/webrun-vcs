/**
 * RevListCommand - `git log` / `git rev-list` over revision arguments: ranges (`a..b`,
 * `a...b`), exclusions (`^a`, `--not`) and parent shorthands (`x^@`, `x^!`, `x^-<n>`),
 * read as git's `handle_revision_arg` reads them (see `revision-range.ts`), walked by
 * {@link LogCommand}.
 *
 * @example
 * ```typescript
 * // git log --format=%H main...feat
 * for await (const commit of await git.revList().addRevision("main...feat").call()) {
 *   console.log(commit.id);
 * }
 * // git rev-list v1.0..HEAD --not release
 * const range = git.revList().addRevision("v1.0..HEAD").addRevision("--not").addRevision("release");
 * const { entries } = await range.resolve(); // what was included and excluded
 * ```
 */

import { GitCommand } from "../git-command.js";
import { LogCommand, type LogResult } from "./log-command.js";
import { revisionMergeBases } from "./rev-parse-command.js";
import { parseRevisionAndPathArgs, type RevisionAndPathArgs } from "./revision-filenames.js";
import { type ParsedRevisionArgs, parseRevisionArgs } from "./revision-range.js";

/**
 * Commits reachable from the included revisions and not from the excluded ones, the set
 * `git log <revisions> --` lists. It reads its arguments as `git log` does, not as
 * `git rev-list` does: without revisions (or with nothing but `--not`, which names none) it
 * lists HEAD's history, where `git rev-list` prints its usage; with only exclusions (`^main`)
 * it lists nothing, as git does.
 *
 * The commits come in `git log`'s order: {@link LogCommand}'s walk is git's (newest commit
 * date first, `limit_list` when revisions are excluded).
 *
 * Throws `RevisionError` with git's lines for an argument that names nothing
 * (`fatal: bad revision 'x'`, as `git log x --`).
 */
export class RevListCommand extends GitCommand<AsyncIterable<LogResult>> {
  private readonly revisions: string[] = [];
  private readonly mixed: string[] = [];
  private committish = true;
  private readonly configure: ((log: LogCommand) => void)[] = [];

  /** A revision argument: `HEAD`, `^v1`, `a..b`, `a...b`, `x^@`, `x^!`, `x^-2`, or `--not`. */
  addRevision(revision: string): this {
    this.checkCallable();
    this.revisions.push(revision);
    return this;
  }

  /**
   * An argument of `git log <args>` as given on its command line, revisions and paths mixed
   * (after the revisions of {@link addRevision}): `--` separates them; without it each
   * revision must not also name a file (`fatal: ambiguous argument 'x': both revision and
   * filename`), and from the first argument that is no revision on all are paths that must
   * exist (`fatal: path 'x' does not exist in 'HEAD'`, `fatal: ambiguous argument 'x':
   * unknown revision or path not in the working tree.`, ...), as git checks them.
   *
   * @example
   * ```typescript
   * // git log main a.txt
   * await git.revList().addArgument("main").addArgument("a.txt").call();
   * ```
   */
  addArgument(arg: string): this {
    this.checkCallable();
    this.mixed.push(arg);
    return this;
  }

  /**
   * Read plain revisions as committishes, as `git log` does (the default), or as given, as
   * `git rev-list` does (it matters only to an abbreviated id that names several objects).
   */
  setCommittish(committish: boolean): this {
    this.checkCallable();
    this.committish = committish;
    return this;
  }

  /** At most this many commits (`-n`). */
  setMaxCount(maxCount: number): this {
    this.checkCallable();
    this.configure.push((log) => log.setMaxCount(maxCount));
    return this;
  }

  /** Follow first parents only (`--first-parent`). */
  setFirstParent(firstParent: boolean): this {
    this.checkCallable();
    this.configure.push((log) => log.setFirstParent(firstParent));
    return this;
  }

  /** Only commits that change `path` (a pathspec element, as `LogCommand.addPath`). */
  addPath(path: string): this {
    this.checkCallable();
    this.configure.push((log) => log.addPath(path));
    return this;
  }

  /**
   * The revisions read: what is included and excluded, in git's pending order, and the
   * paths among the arguments of {@link addArgument}.
   */
  async resolve(): Promise<RevisionAndPathArgs> {
    const resolver = this.revisionResolver();
    const options = {
      committish: this.committish,
      mergeBases: (a: string, b: string) => revisionMergeBases(this.commits, a, b),
    };
    const parsed: ParsedRevisionArgs = await parseRevisionArgs(resolver, this.revisions, options);
    if (this.mixed.length === 0) return { ...parsed, paths: [] };
    const more = await parseRevisionAndPathArgs(
      resolver,
      this.mixed,
      this.argumentFiles(),
      options,
    );
    return {
      entries: [...parsed.entries, ...more.entries],
      warnings: resolver.warnings,
      paths: more.paths,
    };
  }

  async call(): Promise<AsyncIterable<LogResult>> {
    this.checkCallable();
    this.setCallable(false);
    const log = new LogCommand(this._workingCopy);
    for (const configure of this.configure) configure(log);
    // `--not` alone names no revision: git log falls back to HEAD (revs->def) as with none
    const named = (args: string[]) => args.some((arg) => arg !== "--not" && arg !== "--");
    if (named(this.revisions) || named(this.mixed)) {
      const { entries, paths } = await this.resolve();
      for (const path of paths) log.addPath(path);
      const revised = entries.length > 0 || this.revisions.some((r) => r !== "--not");
      const resolver = this.revisionResolver();
      let included = 0;
      for (const entry of entries) {
        // the walk takes commits: tags are peeled, other objects are not walked
        const peeled = await resolver.peelTags(entry.id);
        if (peeled.type !== "commit") continue;
        if (entry.exclude) log.not(peeled.id);
        else {
          log.add(peeled.id);
          included++;
        }
      }
      if (included === 0 && revised) return empty();
    }
    return log.call();
  }
}

async function* empty(): AsyncIterable<LogResult> {}
