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

import type { ObjectId } from "@statewalker/vcs-core";
import { encodeGitPath } from "@statewalker/vcs-utils/encoding";

import { GitCommand } from "../git-command.js";
import {
  BisectGraph,
  type BisectPending,
  estimateBisectSteps,
  FIND_BISECTION_FIRST_PARENT_ONLY,
  findBisection,
} from "./bisect/index.js";
import { LogCommand, type LogOrder, type LogResult } from "./log-command.js";
import type { LogOutputOptions } from "./log-output.js";
import type { CommitFilter, GrepPatternType } from "./rev-filter/index.js";
import { revisionMergeBases } from "./rev-parse-command.js";
import { parseRevisionAndPathArgs, type RevisionAndPathArgs } from "./revision-filenames.js";
import {
  type ParsedRevisionArgs,
  parseRevisionArgs,
  type RefTip,
  type RevisionArg,
} from "./revision-range.js";

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
  private readonly revisions: RevisionArg[] = [];
  private readonly mixed: string[] = [];
  private committish = true;
  private logConfig = false;
  private readonly configure: ((log: LogCommand) => void)[] = [];
  /** The paths of {@link addPath}, for `--bisect`'s walk */
  private readonly ownPaths: string[] = [];
  private firstParent = false;
  private bisect?: "bisect" | "vars";
  private exitStatus = 0;
  /** What {@link prepare} gave the log: the commits and paths, for `--bisect` */
  private prepared?: { pending: BisectPending[]; paths: string[] };
  /** The log that walks for this command, once called */
  private log?: LogCommand;

  /** What git prints while reading replace refs and grafts (see GitCommand). */
  override async replacementMessages(): Promise<string[]> {
    const own = await super.replacementMessages();
    return own.length > 0 || !this.log ? own : this.log.replacementMessages();
  }

  /**
   * A revision argument: `HEAD`, `^v1`, `a..b`, `a...b`, `x^@`, `x^!`, `x^-2`, `--not`, or a
   * ref option: `--all`, `--branches[=<pattern>]`, `--tags[=<pattern>]`,
   * `--remotes[=<pattern>]`, `--glob=<pattern>`, `--exclude=<pattern>` (`--glob` and
   * `--exclude` also take their pattern as the next argument). As in git, an `--exclude`
   * applies to the next ref option only (`--all`, `--branches`, ...), which clears it.
   *
   * @example
   * ```typescript
   * // git rev-list --exclude='*\/*' --branches --not --tags=v1*
   * git.revList().addRevision("--exclude=*\/*").addRevision("--branches")
   *   .addRevision("--not").addRevision("--tags=v1*");
   * ```
   */
  addRevision(revision: string): this {
    this.checkCallable();
    this.revisions.push(revision);
    return this;
  }

  /** `--all`: every ref under `refs/` (in name order), then HEAD. */
  addAll(): this {
    return this.addRevision("--all");
  }

  /** `--branches[=<pattern>]`: the branches (matching the pattern, `refs/heads/` implied). */
  addBranches(pattern?: string): this {
    return this.addRevision(pattern === undefined ? "--branches" : `--branches=${pattern}`);
  }

  /** `--tags[=<pattern>]`: the tags (matching the pattern, `refs/tags/` implied). */
  addTags(pattern?: string): this {
    return this.addRevision(pattern === undefined ? "--tags" : `--tags=${pattern}`);
  }

  /** `--remotes[=<pattern>]`: the remote-tracking refs (matching, `refs/remotes/` implied). */
  addRemotes(pattern?: string): this {
    return this.addRevision(pattern === undefined ? "--remotes" : `--remotes=${pattern}`);
  }

  /**
   * `--glob=<pattern>`: the refs matching the pattern (`refs/` implied when it does not start
   * so, `/*` appended when it has no glob character).
   */
  addGlob(pattern: string): this {
    return this.addRevision(`--glob=${pattern}`);
  }

  /** `--exclude=<pattern>`: refs the next ref option leaves out. */
  addExclude(pattern: string): this {
    return this.addRevision(`--exclude=${pattern}`);
  }

  /**
   * `--stdin` with what it reads, at this place among the revisions: one revision per line
   * up to an empty line, `--not` and the ref options among them (a `--not` there flips only
   * the lines after it), and after a `--` line, paths.
   *
   * @example
   * ```typescript
   * // printf 'main\n--not\nv1\n' | git rev-list --stdin
   * await git.revList().addStdin("main\n--not\nv1\n").callText();
   * ```
   */
  addStdin(text: string): this {
    this.checkCallable();
    this.revisions.push({ stdin: text });
    return this;
  }

  /** `--topo-order`, `--date-order`, `--author-date-order` (see `LogCommand.setOrder`). */
  setOrder(order: LogOrder | undefined): this {
    return this.configured((log) => log.setOrder(order));
  }

  /** `--reverse` (see `LogCommand.setReverse`). */
  setReverse(reverse: boolean): this {
    return this.configured((log) => log.setReverse(reverse));
  }

  /** `--boundary` (see `LogCommand.setBoundary`). */
  setBoundary(boundary: boolean): this {
    return this.configured((log) => log.setBoundary(boundary));
  }

  /** `--source` (`git log`'s; see `LogCommand.setSource`). */
  setSource(source: boolean): this {
    return this.configured((log) => log.setSource(source));
  }

  /** `--since=<seconds>` / `--max-age` (see `LogCommand.setSince`). */
  setSince(timestamp: number): this {
    return this.configured((log) => log.setSince(timestamp));
  }

  /** `--until=<seconds>` / `--min-age` (see `LogCommand.setUntil`). */
  setUntil(timestamp: number): this {
    return this.configured((log) => log.setUntil(timestamp));
  }

  /**
   * `--bisect` (`"bisect"`): {@link callText} prints the commit halfway between the included
   * and the excluded ones, as bisect.c's find_bisection picks it; `--bisect-vars`
   * (`"vars"`): the shell variables `git bisect` reads (`bisect_rev='<id>'`, `bisect_nr`,
   * `bisect_good`, `bisect_bad`, `bisect_all`, `bisect_steps`). Paths and `--first-parent`
   * apply; the order, `-n` and `--boundary` do not.
   */
  setBisect(mode: "bisect" | "vars" | undefined): this {
    this.checkCallable();
    this.bisect = mode;
    return this;
  }

  /**
   * git rev-list's exit status after {@link callText}: 0, or 1 where `--bisect-vars` found no
   * commit to test.
   */
  getExitStatus(): number {
    return this.exitStatus;
  }

  /** `--skip=<n>`. */
  setSkip(skip: number): this {
    return this.configured((log) => log.setSkip(skip));
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
    this.firstParent = firstParent;
    this.configure.push((log) => log.setFirstParent(firstParent));
    return this;
  }

  /** Only commits that change `path` (a pathspec element, as `LogCommand.addPath`). */
  addPath(path: string): this {
    this.checkCallable();
    this.ownPaths.push(path);
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
    let tips: Promise<RefTip[]> | undefined;
    const options = {
      committish: this.committish,
      mergeBases: (a: string, b: string) => revisionMergeBases(this.walkCommits, a, b),
      refs: () => {
        tips ??= this.refTips();
        return tips;
      },
      head: async () => (await this.refsStore.resolve("HEAD").catch(() => undefined))?.objectId,
    };
    const parsed: ParsedRevisionArgs = await parseRevisionArgs(resolver, this.revisions, options);
    const stdinPaths = parsed.stdinPaths ?? [];
    if (this.mixed.length === 0) return { ...parsed, paths: stdinPaths };
    const more = await parseRevisionAndPathArgs(
      resolver,
      this.mixed,
      this.argumentFiles(),
      options,
    );
    return {
      entries: [...parsed.entries, ...more.entries],
      warnings: resolver.warnings,
      inputGiven: !!parsed.inputGiven || more.entries.length > 0,
      paths: [...stdinPaths, ...more.paths],
    };
  }

  /** The refs under `refs/` in name order (refs_for_each_ref), symbolic ones resolved. */
  private async refTips(): Promise<RefTip[]> {
    const tips: { key: Uint8Array; name: string; id: ObjectId }[] = [];
    for await (const ref of this.refsStore.list()) {
      if (!ref.name.startsWith("refs/")) continue;
      let id = "objectId" in ref ? ref.objectId : undefined;
      if (!id) id = (await this.refsStore.resolve(ref.name).catch(() => undefined))?.objectId;
      if (id) tips.push({ key: encodeGitPath(ref.name), name: ref.name, id });
    }
    tips.sort((a, b) => compareBytes(a.key, b.key));
    return tips.map(({ name, id }) => ({ name, id }));
  }

  async call(): Promise<AsyncIterable<LogResult>> {
    const log = await this.prepare();
    return log ? log.call() : empty();
  }

  /**
   * `git rev-list <revisions>`'s output: each commit's id on a line, a boundary commit's
   * after a `-` (`--boundary`).
   */
  async callText(): Promise<string> {
    let out = "";
    // git rev-list has no default revision: nothing given, nothing listed
    const log = await this.prepare(false);
    if (this.bisect) return this.bisectText(log !== undefined);
    if (!log) return out;
    for await (const commit of await log.call())
      out += `${commit.boundary ? "-" : ""}${commit.id}\n`;
    return out;
  }

  /**
   * `git log <revisions>`'s output (see `LogCommand.callText`): the revisions of this
   * command walked and printed with `options`.
   *
   * @example
   * ```typescript
   * // git log --oneline --boundary --source main..topic
   * await git.revList().addRevision("main..topic").setBoundary(true).setSource(true)
   *   .callLogText({ oneline: true });
   * ```
   */
  async callLogText(options: LogOutputOptions = {}): Promise<string> {
    const log = await this.prepare();
    if (!log) return "";
    // git log's configuration (grep.patternType, log.mailmap...), whatever setLogConfig says
    return log.setLogConfig(true).callText(options);
  }

  /** rev-list's `--bisect` / `--bisect-vars` output (builtin/rev-list.c, show_bisect_vars). */
  private async bisectText(walk: boolean): Promise<string> {
    const prepared = this.prepared;
    const commits = this.walkCommits;
    const shallow = new Set((await this.refsStore.getShallow?.().catch(() => undefined)) ?? []);
    const comparer = new LogCommand(this._workingCopy).setLogConfig(false);
    for (const path of prepared?.paths ?? []) comparer.addPath(path);
    const graph = new BisectGraph({
      header: async (id) => {
        const commit = await commits.load(id).catch(() => undefined);
        if (!commit) return undefined;
        const parents = shallow.has(id) ? [] : commit.parents;
        return { tree: commit.tree, parents, date: commit.committer.timestamp };
      },
      differs: (from, to) => comparer.pathsDiffer(from, to),
    });
    const walked =
      walk && prepared
        ? await graph.walk(prepared.pending, {
            paths: prepared.paths,
            firstParent: this.firstParent,
          })
        : [];
    const found = findBisection(walked, this.firstParent ? FIND_BISECTION_FIRST_PARENT_ONLY : 0);
    const best = found.list[0];
    if (this.bisect === "bisect") return best ? `${best.id}\n` : "";
    // show_bisect_vars: nothing at all without a commit to test (it returns 1)
    if (!best) {
      this.exitStatus = 1;
      return "";
    }
    const { reaches, all } = found;
    const cnt = Math.max(all - reaches, reaches);
    return [
      `bisect_rev='${best.id}'`,
      `bisect_nr=${cnt - 1}`,
      `bisect_good=${all - reaches - 1}`,
      `bisect_bad=${reaches - 1}`,
      `bisect_all=${all}`,
      `bisect_steps=${estimateBisectSteps(all)}`,
      "",
    ].join("\n");
  }

  /** The log walking the revisions; undefined when they name nothing to walk. */
  private async prepare(defaultHead = true): Promise<LogCommand | undefined> {
    this.checkCallable();
    this.setCallable(false);
    const log = new LogCommand(this._workingCopy);
    this.log = log;
    if (this.useReplaceRefsOverride !== undefined)
      log.setUseReplaceRefs(this.useReplaceRefsOverride);
    log.setLogConfig(this.logConfig);
    for (const configure of this.configure) configure(log);
    // `--not` alone names no revision: git log falls back to HEAD (revs->def) as with none,
    // as it does after `--exclude=` alone or a `--stdin` that read nothing
    const named = (args: string[]) => args.some((arg) => arg !== "--not" && arg !== "--");
    if (this.revisions.length > 0 || named(this.mixed)) {
      const { entries, paths, inputGiven } = await this.resolve();
      for (const path of paths) log.addPath(path);
      const revised = entries.length > 0 || !!inputGiven;
      const resolver = this.revisionResolver();
      let included = 0;
      const pending: BisectPending[] = [];
      this.prepared = { pending, paths: [...this.ownPaths, ...paths] };
      for (const entry of entries) {
        // the walk takes commits: tags are peeled, other objects are not walked
        const peeled = await resolver.peelTags(entry.id);
        if (peeled.type !== "commit") continue;
        pending.push({ id: peeled.id, exclude: entry.exclude });
        if (entry.exclude) log.not(peeled.id, entry.name ?? entry.id);
        else {
          log.add(peeled.id, entry.name ?? entry.id);
          included++;
        }
      }
      if (included === 0 && (revised || !defaultHead)) return undefined;
    } else if (!defaultHead) return undefined;
    return log;
  }
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] as number) - (b[i] as number);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

async function* empty(): AsyncIterable<LogResult> {}
