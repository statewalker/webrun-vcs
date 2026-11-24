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
import type { CommitFilter, GrepPatternType } from "./rev-filter/index.js";
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
  private logConfig = false;
  private readonly configure: ((log: LogCommand) => void)[] = [];
  /** The log that walks for this command, once called */
  private log?: LogCommand;

  /** What git prints while reading replace refs and grafts (see GitCommand). */
  override async replacementMessages(): Promise<string[]> {
    const own = await super.replacementMessages();
    return own.length > 0 || !this.log ? own : this.log.replacementMessages();
  }

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

  /** `--grep=<pattern>` (see `LogCommand.addGrep`). */
  addGrep(pattern: string): this {
    return this.configured((log) => log.addGrep(pattern));
  }

  /** `--author=<pattern>` (see `LogCommand.addAuthor`). */
  addAuthor(pattern: string): this {
    return this.configured((log) => log.addAuthor(pattern));
  }

  /** `--committer=<pattern>` (see `LogCommand.addCommitter`). */
  addCommitter(pattern: string): this {
    return this.configured((log) => log.addCommitter(pattern));
  }

  /** `--all-match`. */
  setAllMatch(allMatch: boolean): this {
    return this.configured((log) => log.setAllMatch(allMatch));
  }

  /** `--invert-grep`. */
  setInvertGrep(invert: boolean): this {
    return this.configured((log) => log.setInvertGrep(invert));
  }

  /** `-i` / `--regexp-ignore-case`. */
  setRegexpIgnoreCase(ignoreCase: boolean): this {
    return this.configured((log) => log.setRegexpIgnoreCase(ignoreCase));
  }

  /** `--basic-regexp`, `-E`, `-F` or `-P` (see `LogCommand.setPatternType`). */
  setPatternType(type: GrepPatternType): this {
    return this.configured((log) => log.setPatternType(type));
  }

  /** `--use-mailmap` / `--no-mailmap` for `--author`/`--committer` (`git log`'s). */
  setUseMailmap(use: boolean): this {
    return this.configured((log) => log.setUseMailmap(use));
  }

  /**
   * Whether `git log`'s configuration applies to the patterns (`grep.patternType`,
   * `grep.extendedRegexp`, `log.mailmap`). Default false, as `git rev-list`, which reads none
   * of it; true reads the revisions' patterns as `git log` does.
   */
  setLogConfig(read: boolean): this {
    this.checkCallable();
    this.logConfig = read;
    return this;
  }

  /** A filter of the commits listed (see `CommitFilters`). */
  addCommitFilter(filter: CommitFilter): this {
    return this.configured((log) => log.addCommitFilter(filter));
  }

  private configured(step: (log: LogCommand) => void): this {
    this.checkCallable();
    this.configure.push(step);
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
      mergeBases: (a: string, b: string) => revisionMergeBases(this.walkCommits, a, b),
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
    this.log = log;
    if (this.useReplaceRefsOverride !== undefined)
      log.setUseReplaceRefs(this.useReplaceRefsOverride);
    log.setLogConfig(this.logConfig);
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
