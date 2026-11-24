import {
  type BloomFilterSettings,
  bloomFilterContains,
  bloomKey,
  type Commit,
  type CommitGraph,
  canonTreeMode,
  commitFromBytes,
  type GitObject,
  isSymbolicRef,
  type ObjectId,
  type ObjectReplacements,
  type PersonIdent,
  parseGraphCommit,
  replacementOf,
} from "@statewalker/vcs-core";
import { ByteSink, OrderedMap, parseGitBool, type XdiffAlgorithm } from "@statewalker/vcs-utils";
import { decodeGitPath, encodeGitPath } from "@statewalker/vcs-utils/encoding";
import { bytesToHex, hexToBytes } from "@statewalker/vcs-utils/hash/utils";

import type { AttributesResolver, ContentAttributesContext } from "@statewalker/vcs-working-tree";

import {
  GitApiError,
  IncompatibleOptionsError,
  InvalidArgumentError,
  InvalidConfigError,
  NotImplementedError,
} from "../errors/index.js";
import { GitCommand } from "../git-command.js";
import { RemoteConfigStore } from "../remote-config/index.js";
import { type CombinedDiffOptions, writeCombinedDiff } from "../results/combined-diff.js";
import type { DiffColors } from "../results/diff-color.js";
import { DiffPickaxe } from "../results/diff-pickaxe.js";
import { quotePath } from "../results/quote-path.js";
import { bareAttributesResolver } from "./attributes-source.js";
import { parseGitColor } from "./config-value-types.js";
import {
  DEFAULT_DECORATION_COLORS,
  type DiffColorSettings,
  readDiffColorSettings,
} from "./diff-color-config.js";
import {
  checkPickaxeOptions,
  DiffCommand,
  type DiffOutputFormat,
  type DiffTextOptions,
  hasPickaxe,
} from "./diff-command.js";
import { hostEnvironmentOf } from "./git-ident.js";
import { GRAPH_COLUMN_COLORS_ANSI, graphColumnColors } from "./log-graph.js";
import {
  type LogOutputEntry,
  type LogOutputHost,
  type LogOutputOptions,
  LogPrinter,
  type LogReflogEntry,
} from "./log-output.js";
import type { Mailmap } from "./mailmap.js";
import { configBool, configValue } from "./merge-config.js";
import {
  addRefsByGlob,
  addRefsFromColonSep,
  defaultNotesRef,
  expandNotesRef,
  initNotes,
  type NotesHandle,
  notesEnvironmentOf,
} from "./notes-support.js";
import { combineNotesIgnore } from "./notes-tree.js";
import { canonicalObjectId } from "./object-id-input.js";
import { PatchIds } from "./patch-id.js";
import {
  ALL_ENTRIES_NOT_INTERESTING,
  bloomPathOf,
  ENTRY_NOT_INTERESTING,
  matchPathspec,
  NEED_ATTRIBUTES,
  type PathspecAttributeValue,
  type PathspecItem,
  parsePathspecItem,
  pathspecForbidsBloom,
  type TreePathspec,
  treeEntryInteresting,
  treePathspec,
} from "./pathspec.js";
import { PathspecAttributes } from "./pathspec-attributes.js";
import {
  type DecorationPalette,
  type LoadRefDecorationsOptions,
  loadRefDecorations,
  type RefDecorations,
} from "./pretty-format.js";
import { openReflogWalk, walkReflogs } from "./reflog-walk.js";
import { RemergeTreeCommand, remergeObjectsView } from "./remerge-diff.js";
import {
  type CommitFilter,
  CommitFilters,
  type FilteredCommit,
  type GrepPatternType,
} from "./rev-filter/index.js";
import {
  checkSignature,
  mergetagsOf,
  parseBufferSignedByHeader,
  parseSignature,
  type SignatureCheck,
  verifyCommitBytes,
} from "./signature-check.js";
import { readDiffSubmoduleConfig } from "./submodule-summary.js";
import { shortenUnambiguousRef } from "./worktree-list-command.js";

/** What {@link LogCommand.callBytes} asks of the walk. */
interface OutputWalk {
  /** `--topo-order` (and `--graph`) */
  topo: boolean;
  /** `--graph`: parents rewritten past the commits not shown */
  rewrite: boolean;
  entries: LogOutputEntry[];
  /**
   * Parents the walk never reached (`--first-parent` walks only first parents) that git's
   * get_commit_action would show: the graph counts them as interesting
   */
  unwalkedShown?: Set<ObjectId>;
}

/** A commit given to the walk: excluded or not, and the name it was given by. */
interface PendingCommit {
  id: ObjectId;
  exclude: boolean;
  name?: string;
  /** The left side of a symmetric difference (`a` of `a...b`, git's SYMMETRIC_LEFT) */
  left?: boolean;
}

/** A commit of the walk as the log printer takes it. */
function outputEntry(c: LogResult): LogOutputEntry {
  const { id, boundary, source, left, patchSame, reflog: _reflog, savedParents, ...commit } = c;
  return {
    id,
    commit,
    parents: c.parents,
    ...(savedParents ? { savedParents } : {}),
    ...(boundary ? { boundary: true } : {}),
    ...(source !== undefined ? { source } : {}),
    ...(left ? { left: true } : {}),
    ...(patchSame ? { patchSame: true } : {}),
  };
}

/** git's get_revision under `--reverse`: every commit read first, then given oldest first. */
async function* reversed<T>(source: AsyncIterable<T>): AsyncIterable<T> {
  const all: T[] = [];
  for await (const item of source) all.push(item);
  for (let i = all.length - 1; i >= 0; i--) yield all[i] as T;
}

/** git log reads no index: the in-tree attributes files are the worktree's only. */
const NO_INDEX = { attributesBlob: () => undefined };

/**
 * Result of a log command iteration.
 *
 * Extends Commit with the object ID.
 */
export interface LogResult extends Commit {
  /** The SHA-1 object ID of the commit */
  id: ObjectId;
  /**
   * A boundary commit ({@link LogCommand.setBoundary}): a parent of a commit listed that is
   * not listed itself, given after the others (git's `BOUNDARY`, the `-` mark)
   */
  boundary?: boolean;
  /**
   * On the left side of a symmetric difference (`a` of `a...b`, reached from it only): git's
   * SYMMETRIC_LEFT, the `<` mark of {@link LogCommand.setLeftRight} (`>` otherwise)
   */
  left?: boolean;
  /**
   * {@link LogCommand.setCherryMark}: the other side of the symmetric difference has a commit
   * with the same patch-id (git's PATCHSAME, the `=` mark)
   */
  patchSame?: boolean;
  /**
   * The name the commit was reached from ({@link LogCommand.setSource}, git's `--source`):
   * the revision as given, or the ref `--all`, `--branches`... named
   */
  source?: string;
  /** In a reflog walk ({@link LogCommand.addReflogWalk}), the entry the commit is listed for */
  reflog?: LogReflogEntry;
  /**
   * The parents before {@link LogCommand.setParents} rewrote `parents` (git's saved parents,
   * which `--full-diff` diffs against)
   */
  savedParents?: ObjectId[];
}

/**
 * What `git show` prints through one log printer (see {@link LogCommand.showSession}).
 *
 * @internal
 */
export interface ShowSession {
  /** Shows a commit as git show does; false when it was not shown (already, or TREESAME) */
  commit(id: ObjectId): Promise<boolean>;
  /** The newline before a tag or tree once something was shown */
  separate(): void;
  /** Marks something shown (a tag's or tree's header) */
  markShown(): void;
  text(text: string): void;
  bytes(bytes: Uint8Array): void;
  /** A tag's `tagger` line as `Tagger:` (and its date) in the format */
  tagger(ident: PersonIdent): void;
  /** Everything printed */
  result(): Uint8Array;
  /** The `color.diff.commit` color and its reset of a tag's or tree's header ("" without color) */
  readonly commitColor: { set: string; reset: string };
}

/**
 * The order of the commits listed: git's `--topo-order` (`topo`: no parent before all its
 * children, a line of history kept together), `--date-order` (`date`: no parent before its
 * children, else newest commit date first), `--author-date-order` (`author-date`: as `date`
 * by author date).
 */
export type LogOrder = "topo" | "date" | "author-date";

/**
 * What a path-limited walk did (git's trace2 `bloom` statistics, and the tree work behind
 * them): how often the changed-path filters answered, and how many tree entries the walk read
 * to compare commits with their parents.
 */
export interface LogPathStatistics {
  /** Comparisons a filter settled: the paths certainly did not change */
  bloomDefinitelyNot: number;
  /** Comparisons where a filter said the paths may have changed (trees compared then) */
  bloomMaybe: number;
  /** Of `bloomMaybe`, those where the trees did not differ */
  bloomFalsePositive: number;
  /** Comparisons of commits the graph has without a filter (its layer has none) */
  bloomNotPresent: number;
  /** Comparisons of a commit's trees with a parent's (or the empty tree), at the paths */
  treeComparisons: number;
  /** Tree entries looked up for those comparisons (each reads its tree, or finds it cached) */
  treeEntryReads: number;
  /** Commits the walk met (parsed, or seen as a parent) */
  commitsWalked?: number;
  /** Bytes the walk's table of commits takes (a few dozen per commit met) */
  walkTableBytes?: number;
}

/**
 * Revision filter for LogCommand.
 *
 * Based on JGit's RevFilter.
 */
export enum RevFilter {
  /** Include all commits (default) */
  ALL = "all",
  /** Only include merge commits (commits with more than one parent) */
  ONLY_MERGES = "only-merges",
  /** Exclude merge commits */
  NO_MERGES = "no-merges",
}

/**
 * Show commit history.
 *
 * Equivalent to `git log`.
 *
 * Based on JGit's LogCommand.
 *
 * @example
 * ```typescript
 * // Get all commits from HEAD
 * for await (const commit of await git.log().call()) {
 *   console.log(commit.message);
 * }
 *
 * // Get commits from a specific ref
 * const commits = await git.log().add(commitId).call();
 *
 * // Limit number of commits
 * const recent = await git.log().setMaxCount(10).call();
 *
 * // Skip first N commits
 * const older = await git.log().setSkip(10).setMaxCount(10).call();
 *
 * // Filter by date range
 * const thisWeek = await git.log()
 *   .setSince(Date.now() - 7 * 24 * 60 * 60 * 1000)
 *   .call();
 *
 * // Filter by author
 * const myCommits = await git.log()
 *   .setAuthorFilter("john@example.com")
 *   .call();
 *
 * // Exclude commits
 * const newCommits = await git.log()
 *   .not(oldBranchHead)
 *   .call();
 *
 * // Only merge commits
 * const merges = await git.log()
 *   .setRevFilter(RevFilter.ONLY_MERGES)
 *   .call();
 *
 * // Exclude merge commits
 * const nonMerges = await git.log()
 *   .setRevFilter(RevFilter.NO_MERGES)
 *   .call();
 *
 * // Range syntax (commits in feature not in main)
 * const newInFeature = await git.log()
 *   .addRange(mainHead, featureHead)
 *   .call();
 * ```
 */
export class LogCommand extends GitCommand<AsyncIterable<LogResult>> {
  private startCommits: ObjectId[] = [];
  /** The commits given, included and excluded, in the order given (git's pending list) */
  private readonly pending: PendingCommit[] = [];
  private paths: string[] = [];
  private excludePaths: string[] = [];
  private maxCount?: number;
  private skip = 0;
  private includeAll = false;
  /** Where `all()` puts the refs among the commits given (git's command-line order) */
  private allAt = 0;
  private firstParentOnly = false;
  /** git's `simplify_history`: off with `--full-history` (and `-m`, `--diff-merges=separate`) */
  private simplifyHistory = true;
  private sinceTime?: number;
  private untilTime?: number;
  private authorPattern?: string;
  private committerPattern?: string;
  private revFilter = RevFilter.ALL;
  /** `--grep` patterns */
  private readonly grepMessages: string[] = [];
  /** `--author` patterns */
  private readonly grepAuthors: string[] = [];
  /** `--committer` patterns */
  private readonly grepCommitters: string[] = [];
  private allMatch = false;
  private invertGrep = false;
  private regexpIgnoreCase = false;
  private patternType?: GrepPatternType;
  private useMailmap?: boolean;
  private logConfig = true;
  private readonly commitFilters: CommitFilter[] = [];
  /** The filter of the walk under way (git's options and the added filters) */
  private activeFilter?: CommitFilter;
  private useBloomFilters = true;
  private readonly statistics: LogPathStatistics = {
    bloomDefinitelyNot: 0,
    bloomMaybe: 0,
    bloomFalsePositive: 0,
    bloomNotPresent: 0,
    treeComparisons: 0,
    treeEntryReads: 0,
  };
  /** The commits of the last walk (for its statistics). */
  private lastWalk: RevTable | undefined;
  /** Set while {@link callBytes} collects the walk for its output */
  private outputWalk: OutputWalk | undefined;
  /** `-g <ref>...`: the reflogs walked instead of the history (names as given) */
  private reflogWalkNames?: string[];
  /** `--grep-reflog` patterns */
  private readonly grepReflogs: string[] = [];
  /** The git version whose behaviour differs where versions differ */
  private compatibility: "2.43" | "2.56" = "2.56";
  /** `--topo-order`, `--date-order`, `--author-date-order` */
  private order?: LogOrder;
  /** `--reverse` */
  private reverse = false;
  /** `--boundary` */
  private boundary = false;
  /** `--source` */
  private source = false;
  /** `--left-right` */
  private leftRight = false;
  /** `--left-only` */
  private leftOnly = false;
  /** `--right-only` (and `--cherry`) */
  private rightOnly = false;
  /** `--cherry-pick` */
  private cherryPick = false;
  /** `--cherry-mark` (and `--cherry`) */
  private cherryMark = false;
  /** `--cherry`: no merges (git's max_parents 1) */
  private cherry = false;
  /** `--simplify-merges` (and `--simplify-by-decoration`) */
  private simplifyMerges = false;
  /** `--simplify-by-decoration` */
  private simplifyByDecoration = false;
  /** git's `dense`: `--dense` (the default), off with `--sparse` */
  private dense = true;
  /** `--show-pulls` */
  private showPulls = false;
  /** `--parents` (git's `rewrite_parents` by itself) */
  private rewriteParents = false;
  /** `--ancestry-path` without a commit: the bottom commits are the ones */
  private ancestryPathImplicit = false;
  /** `--ancestry-path=<commit>`: the commits given */
  private readonly ancestryPathCommits: ObjectId[] = [];
  /**
   * Commits a revision reaches through an annotated tag `--ancestry-path=<tag>` names: the
   * tag's ANCESTRY_PATH passes to them (handle_commit's `object->flags |= flags`)
   */
  private readonly ancestryPathPeeled: ObjectId[] = [];
  /** `git log --reverse` collects the walk itself: shown commits keep their parents */
  private keepShownParents = false;
  /** Loads the decorations `--simplify-by-decoration` keeps (the log's filter), when set */
  private decorationLoader?: () => Promise<RefDecorations>;

  /**
   * The order of the commits ({@link LogOrder}); undefined is git's default, newest commit
   * date first as the walk meets them. A sorted walk reads the whole history it lists
   * before giving the first commit.
   *
   * @example
   * ```typescript
   * // git rev-list --topo-order main
   * await git.log().add(main).setOrder("topo").call();
   * ```
   */
  setOrder(order: LogOrder | undefined): this {
    this.checkCallable();
    this.order = order;
    return this;
  }

  /**
   * `--reverse`: the commits chosen (after `-n` and `--skip`, boundary commits included)
   * given oldest first.
   */
  setReverse(reverse: boolean): this {
    this.checkCallable();
    this.reverse = reverse;
    return this;
  }

  /**
   * `--boundary`: after the commits listed, the parents of those that are not listed
   * themselves (excluded, cut by `-n`, `--since` or a filter), each with `boundary: true`,
   * as git's get_revision lists them (sorted as `sort_in_topological_order` sorts them).
   *
   * @example
   * ```typescript
   * // git rev-list --boundary main..topic
   * for await (const c of await git.log().addRange(main, topic).setBoundary(true).call())
   *   console.log(`${c.boundary ? "-" : ""}${c.id}`);
   * ```
   */
  setBoundary(boundary: boolean): this {
    this.checkCallable();
    this.boundary = boundary;
    return this;
  }

  /**
   * `--source`: each commit carries the name it was reached from (`source`): the name given
   * to {@link add}/{@link not}, the ref of {@link all}, `HEAD` for the default, passed from
   * child to parent as the walk goes (the first name to reach a commit wins).
   */
  setSource(source: boolean): this {
    this.checkCallable();
    this.source = source;
    return this;
  }

  /**
   * `--left-right`: each commit is marked by the side of the symmetric difference it is
   * reached from: `<` for the left (`a` of `a...b`, {@link add} with `left`), `>` for the
   * right (`commit < <id>`, `< <id> <subject>` under `--oneline`, the graph's `<`/`>` in place
   * of `*`); `left` on each {@link LogResult} says it whatever this says.
   *
   * @example
   * ```typescript
   * // git log --left-right --oneline main...topic
   * await git.revList().addRevision("main...topic").setLeftRight(true).callLogText({ oneline: true });
   * ```
   */
  setLeftRight(leftRight: boolean): this {
    this.checkCallable();
    this.leftRight = leftRight;
    return this;
  }

  /**
   * `--left-only`: only the commits of the left side of a symmetric difference (none without
   * one). Refused with {@link setRightOnly} or {@link setCherry}, as git refuses them.
   */
  setLeftOnly(leftOnly: boolean): this {
    this.checkCallable();
    if (leftOnly && this.rightOnly) {
      throw new IncompatibleOptionsError(
        ["--left-only", "--right-only/--cherry"],
        "options '--left-only' and '--right-only/--cherry' cannot be used together",
      );
    }
    this.leftOnly = leftOnly;
    return this;
  }

  /** `--right-only`: only the commits of the right side (see {@link setLeftOnly}). */
  setRightOnly(rightOnly: boolean): this {
    this.checkCallable();
    if (rightOnly && this.leftOnly) {
      throw new IncompatibleOptionsError(
        ["--right-only", "--left-only"],
        "options '--right-only' and '--left-only' cannot be used together",
      );
    }
    this.rightOnly = rightOnly;
    return this;
  }

  /**
   * `--cherry-pick`: commits whose change (patch-id, as `git patch-id` computes it, limited to
   * the paths) a commit on the other side of the symmetric difference makes too are left out,
   * on both sides. The cheap id of each diff's headers is computed for the smaller side, and
   * full patch-ids only where those collide (revision.c's cherry_pick_list).
   *
   * @example
   * ```typescript
   * // git rev-list --left-right --cherry-pick main...topic
   * await git.revList().addRevision("main...topic").setLeftRight(true).setCherryPick(true).callText();
   * ```
   */
  setCherryPick(cherryPick: boolean): this {
    this.checkCallable();
    if (cherryPick && this.cherryMark) {
      throw new IncompatibleOptionsError(
        ["--cherry-pick", "--cherry-mark"],
        "options '--cherry-pick' and '--cherry-mark' cannot be used together",
      );
    }
    this.cherryPick = cherryPick;
    return this;
  }

  /**
   * `--cherry-mark`: as {@link setCherryPick}, but the equivalent commits are kept and marked
   * (`patchSame`, the `=` mark; the others `+` when nothing else marks them).
   */
  setCherryMark(cherryMark: boolean): this {
    this.checkCallable();
    if (cherryMark && this.cherryPick) {
      throw new IncompatibleOptionsError(
        ["--cherry-mark", "--cherry-pick"],
        "options '--cherry-mark' and '--cherry-pick' cannot be used together",
      );
    }
    this.cherryMark = cherryMark;
    return this;
  }

  /**
   * `--cherry`: `--right-only --cherry-mark --no-merges`, the commits of the right side marked
   * by whether the left side has their change (`git cherry` as a walk).
   */
  setCherry(cherry: boolean): this {
    this.checkCallable();
    if (cherry && this.leftOnly) {
      throw new IncompatibleOptionsError(
        ["--cherry", "--left-only"],
        "options '--cherry' and '--left-only' cannot be used together",
      );
    }
    this.cherry = cherry;
    if (cherry) {
      this.cherryMark = true;
      this.rightOnly = true;
    }
    return this;
  }

  /** The revision options of the marks the output prints (get_revision_mark). */
  private revisionMarks(): { leftRight: boolean; cherryMark: boolean } {
    return { leftRight: this.leftRight, cherryMark: this.cherryMark };
  }

  /**
   * `git log -g <ref>` (`--walk-reflogs`) for the printed log ({@link callText}): the
   * commits of `ref`'s reflog, newest entry first, each shown with its entry (`Reflog:`
   * lines, `<sel>: <message>` under `--oneline`, `%gd`/`%gD`/`%gs`/`%gn`/`%ge` in a format,
   * `<ref>@{<date>}` under an explicit `--date`). `-n`, `--skip` and the commit filters
   * (`--grep`, `--author`...) apply; entries whose object is no commit are passed over.
   */
  setReflogWalk(ref: string): this {
    this.checkCallable();
    this.reflogWalkNames = [ref];
    return this;
  }

  /**
   * One more reflog of a reflog walk (`git log -g <name>...`): `HEAD`, `main`,
   * `refs/heads/main`, with a selector of its first entry (`main@{2}`, `HEAD@{now}`,
   * `@{0}` for the current branch, `@{-1}`). The walk takes the newest of the logs' entries
   * each time (reflog-walk.c), so several logs interleave by date; a name without a reflog
   * shows nothing. {@link call} gives the commits, {@link callText} the log with each entry.
   *
   * @example
   * ```typescript
   * // git log -g --format='%gd %gs' HEAD main
   * await git.log().addReflogWalk("HEAD").addReflogWalk("main").callText({ pretty: "format:%gd %gs" });
   * ```
   */
  addReflogWalk(name: string): this {
    this.checkCallable();
    this.reflogWalkNames = [...(this.reflogWalkNames ?? []), name];
    return this;
  }

  /**
   * `-g` / `--walk-reflogs`: walk reflogs instead of history, those {@link addReflogWalk}
   * names, HEAD's when it names none (`git log -g`).
   */
  setWalkReflogs(walk: boolean): this {
    this.checkCallable();
    if (!walk) this.reflogWalkNames = undefined;
    else this.reflogWalkNames ??= [];
    return this;
  }

  /**
   * The git version to follow where versions differ (default 2.56): 2.43 refuses a reflog
   * walk's `--reverse` before a sorted walk (`--topo-order`, `--graph`), 2.56 after; 2.43's
   * `--left-only`/`--right-only` hide nothing in a walk nothing else limits (no excluded
   * commit: `a...b` of unrelated histories, or no range at all).
   */
  setCompatibility(version: "2.43" | "2.56"): this {
    this.checkCallable();
    this.compatibility = version;
    return this;
  }

  /**
   * `--grep-reflog=<pattern>`: a reflog walk shows only entries whose message matches (a
   * header pattern beside `--author`/`--committer`, combined with `--grep` as git's
   * commit_match). Without a reflog walk the log dies, as git does.
   */
  addGrepReflog(pattern: string): this {
    this.checkCallable();
    this.grepReflogs.push(pattern);
    return this;
  }

  /**
   * Add a starting commit for the log.
   *
   * Multiple start commits can be added - the log will include
   * ancestors of all of them. An annotated tag is walked from the commit it tags, as git
   * peels it; with {@link all} the refs are walked besides (`git log --all <commit>`).
   *
   * @param commit ObjectId of commit to start from
   * @param name The name it was given by, which {@link setSource} reports (the id without)
   * @param options `left`: the commit is the left side of a symmetric difference (`a` of
   * `a...b`): it and what only it reaches are marked so ({@link setLeftRight})
   */
  add(commit: ObjectId, name?: string, options: { left?: boolean } = {}): this {
    this.checkCallable();
    this.startCommits.push(commit);
    this.pending.push({
      id: commit,
      exclude: false,
      ...(name !== undefined ? { name } : {}),
      ...(options.left ? { left: true } : {}),
    });
    return this;
  }

  /**
   * Filter commits to only those affecting the given path.
   *
   * The path is a git pathspec element, as `git log -- <path>` reads it: a path from the top
   * of the repository (a directory names everything below it), with wildcards (`*`, `?`,
   * `[...]`, matched as git's `git_fnmatch` does) and magic (`:(glob)`, `:(literal)`,
   * `:(icase)`, `:(exclude)` or `:!`).
   *
   * @param path Repository-relative path to filter by
   */
  addPath(path: string): this {
    this.checkCallable();
    this.paths.push(path);
    return this;
  }

  /**
   * Exclude commits that only affect the given path.
   *
   * The path is an `:(exclude)` pathspec element (`git log -- . ':!<path>'`): changes below
   * it do not count when commits are compared with their parents. If a path is both added
   * and excluded, the exclusion wins.
   *
   * @param path Repository-relative path to exclude
   */
  excludePath(path: string): this {
    this.checkCallable();
    this.excludePaths.push(path);
    return this;
  }

  /**
   * Limit the number of commits returned.
   *
   * @param maxCount Maximum number of commits to return
   */
  setMaxCount(maxCount: number): this {
    this.checkCallable();
    this.maxCount = maxCount;
    return this;
  }

  /**
   * Skip the first N commits.
   *
   * @param skip Number of commits to skip
   */
  setSkip(skip: number): this {
    this.checkCallable();
    this.skip = skip;
    return this;
  }

  /**
   * Include commits from all refs (`--all`): every ref under `refs/` in name order, then HEAD,
   * as git's handle_refs adds them, where the call stands among {@link add}, {@link not} and
   * {@link addRange} (the commits given so far come first).
   *
   * When set, starts from all refs instead of just HEAD.
   */
  all(): this {
    this.checkCallable();
    this.includeAll = true;
    this.allAt = this.pending.length;
    return this;
  }

  /**
   * `--full-history`: a path-limited walk compares a merge with every parent and walks them
   * all, even one the merge matches at the paths (git's `simplify_history` off; `git log -m`
   * and `--diff-merges=separate` turn it off as well). Merges that match every relevant parent
   * are still not shown, unless the output rewrites parents (`--graph`) and two of them are
   * relevant.
   */
  setFullHistory(fullHistory: boolean): this {
    this.checkCallable();
    this.simplifyHistory = !fullHistory;
    return this;
  }

  /**
   * `--simplify-merges`: a path-limited walk keeps every parent of a merge (as
   * {@link setFullHistory}), then removes the merges whose parents simplify to one commit and
   * the parents another parent reaches (revision.c's simplify_merges). Commits come in
   * topological order (`--topo-order` unless another order is set), with their parents
   * rewritten past the commits not shown.
   */
  setSimplifyMerges(simplify: boolean): this {
    this.checkCallable();
    this.simplifyMerges = simplify;
    return this;
  }

  /**
   * `--simplify-by-decoration`: only commits a ref names (git's ref decorations: every ref and
   * HEAD, or `git log`'s decoration filter in {@link callText}), commits that change the
   * paths when paths are given, and merges tying them together; merges simplified as
   * {@link setSimplifyMerges}.
   */
  setSimplifyByDecoration(simplify: boolean): this {
    this.checkCallable();
    this.simplifyByDecoration = simplify;
    return this;
  }

  /**
   * `--dense` (true, the default) / `--sparse` (false): with `--sparse` a path-limited walk
   * shows every commit it walks, also those that change none of the paths (merges are still
   * simplified to the parent they match).
   */
  setDense(dense: boolean): this {
    this.checkCallable();
    this.dense = dense;
    return this;
  }

  /**
   * `--show-pulls`: a merge that differs from its first parent at the paths but matches
   * another parent is shown too (it "pulled" the change into the first-parent history).
   */
  setShowPulls(showPulls: boolean): this {
    this.checkCallable();
    this.showPulls = showPulls;
    return this;
  }

  /**
   * `--parents`: each commit's `parents` are the ones the walk shows (rewritten past the
   * commits a path-limited walk leaves out, as git's `rewrite_parents`), and TREESAME merges
   * of two relevant lines are kept to tie them together.
   */
  setParents(parents: boolean): this {
    this.checkCallable();
    this.rewriteParents = parents;
    return this;
  }

  /**
   * `--ancestry-path`: of `A..B`, only the commits that are descendants of an excluded
   * (bottom) commit and ancestors of B. A walk without bottom commits fails (`--ancestry-path
   * given but there are no bottom commits`). Turns history simplification off, as
   * {@link setFullHistory}.
   */
  setAncestryPath(ancestryPath: boolean): this {
    this.checkCallable();
    this.ancestryPathImplicit = ancestryPath;
    return this;
  }

  /**
   * `--ancestry-path=<commit>` (repeatable): only the commits that are the commit, its
   * ancestors or its descendants (of any commit given). A tag is peeled: its commit then
   * keeps only its descendants, as git marks the tag object and not the commit.
   */
  addAncestryPath(commit: ObjectId): this {
    this.checkCallable();
    this.ancestryPathCommits.push(canonicalObjectId(commit));
    return this;
  }

  /**
   * Follow only the first parent on merges.
   *
   * Useful for seeing the linear history of a branch.
   */
  setFirstParent(firstParent: boolean): this {
    this.checkCallable();
    this.firstParentOnly = firstParent;
    return this;
  }

  /**
   * Exclude commits reachable from the given commit.
   *
   * Equivalent to `git log ^commit` or `A..B` syntax.
   * Useful for finding commits in one branch but not another.
   *
   * @param commit ObjectId to exclude along with its ancestors
   * @param name The name it was given by (see {@link add})
   */
  not(commit: ObjectId, name?: string, options: { left?: boolean } = {}): this {
    this.checkCallable();
    this.pending.push({
      id: commit,
      exclude: true,
      ...(name !== undefined ? { name } : {}),
      ...(options.left ? { left: true } : {}),
    });
    return this;
  }

  /**
   * Set minimum commit time (--since/--after).
   *
   * Only include commits after this timestamp.
   *
   * @param timestamp Unix timestamp in milliseconds or seconds
   */
  setSince(timestamp: number): this {
    this.checkCallable();
    // Normalize to seconds (Git uses seconds)
    this.sinceTime = timestamp > 1e12 ? Math.floor(timestamp / 1000) : timestamp;
    return this;
  }

  /**
   * Set maximum commit time (--until/--before).
   *
   * Only include commits before this timestamp.
   *
   * @param timestamp Unix timestamp in milliseconds or seconds
   */
  setUntil(timestamp: number): this {
    this.checkCallable();
    // Normalize to seconds (Git uses seconds)
    this.untilTime = timestamp > 1e12 ? Math.floor(timestamp / 1000) : timestamp;
    return this;
  }

  /**
   * Filter by author name or email (case-insensitive).
   *
   * Matches against "Author Name <email>" string.
   *
   * @param pattern Substring to match in author field
   */
  setAuthorFilter(pattern: string): this {
    this.checkCallable();
    this.authorPattern = pattern.toLowerCase();
    return this;
  }

  /**
   * Filter by committer name or email (case-insensitive).
   *
   * Matches against "Committer Name <email>" string.
   *
   * @param pattern Substring to match in committer field
   */
  setCommitterFilter(pattern: string): this {
    this.checkCallable();
    this.committerPattern = pattern.toLowerCase();
    return this;
  }

  /**
   * Set revision filter.
   *
   * - ALL: Include all commits (default)
   * - ONLY_MERGES: Only include merge commits
   * - NO_MERGES: Exclude merge commits
   *
   * @param filter Revision filter
   */
  setRevFilter(filter: RevFilter): this {
    this.checkCallable();
    this.revFilter = filter;
    return this;
  }

  /**
   * `--grep=<pattern>`: commits whose message has a line matching the pattern (several:
   * any of them, every one with {@link setAllMatch}). Patterns are basic POSIX regexes unless
   * {@link setPatternType} or `grep.patternType`/`grep.extendedRegexp` say otherwise, matched
   * as git's grep.c matches them (`--grep=` matches every commit with a message part).
   *
   * @example
   * ```typescript
   * // git log --grep=fix --grep=bug --all-match -i
   * await git.log().addGrep("fix").addGrep("bug").setAllMatch(true).setRegexpIgnoreCase(true).call();
   * ```
   */
  addGrep(pattern: string): this {
    this.checkCallable();
    this.grepMessages.push(pattern);
    return this;
  }

  /**
   * `--author=<pattern>`: commits whose `author` header line (name and email, the date left
   * out; mapped through the mailmap under `log.mailmap`) matches the pattern; several are
   * or-ed. Unlike {@link setAuthorFilter}, the pattern is git's (a basic regex, case-sensitive
   * without {@link setRegexpIgnoreCase}).
   */
  addAuthor(pattern: string): this {
    this.checkCallable();
    this.grepAuthors.push(pattern);
    return this;
  }

  /** `--committer=<pattern>`: as {@link addAuthor}, on the `committer` header line. */
  addCommitter(pattern: string): this {
    this.checkCallable();
    this.grepCommitters.push(pattern);
    return this;
  }

  /** `--all-match`: every `--grep` pattern must match (author and committer patterns always must). */
  setAllMatch(allMatch: boolean): this {
    this.checkCallable();
    this.allMatch = allMatch;
    return this;
  }

  /** `--invert-grep`: commits whose message matches no `--grep` pattern (not `--author`'s). */
  setInvertGrep(invert: boolean): this {
    this.checkCallable();
    this.invertGrep = invert;
    return this;
  }

  /** `-i` / `--regexp-ignore-case`: the patterns fold ASCII case. */
  setRegexpIgnoreCase(ignoreCase: boolean): this {
    this.checkCallable();
    this.regexpIgnoreCase = ignoreCase;
    return this;
  }

  /**
   * The patterns' type: `--basic-regexp`, `-E` (`extended`), `-F` (`fixed`) or `-P`
   * (`perl`: refused as a git built without PCRE refuses it, unless the pattern has no regex
   * character). Default: `grep.patternType`, else `grep.extendedRegexp`, else basic.
   */
  setPatternType(type: GrepPatternType): this {
    this.checkCallable();
    this.patternType = type;
    return this;
  }

  /**
   * Whether `--author`/`--committer` match the identities as the mailmap maps them
   * (`--use-mailmap`/`--no-mailmap`; default `log.mailmap`, true, as `git log`).
   */
  setUseMailmap(use: boolean): this {
    this.checkCallable();
    this.useMailmap = use;
    return this;
  }

  /**
   * Whether the filters read `git log`'s configuration (default true): `grep.patternType`,
   * `grep.extendedRegexp` and `log.mailmap`. False reads none of them, as `git rev-list`.
   */
  setLogConfig(read: boolean): this {
    this.checkCallable();
    this.logConfig = read;
    return this;
  }

  /**
   * A filter of the commits shown (see `CommitFilters`); several must all include a commit,
   * as must git's options above. The walk still goes through the commits a filter hides, and
   * `setMaxCount`/`setSkip` count only shown ones.
   */
  addCommitFilter(filter: CommitFilter): this {
    this.checkCallable();
    this.commitFilters.push(filter);
    return this;
  }

  /**
   * Whether a path-limited walk asks the commit-graph's changed-path Bloom filters before it
   * compares trees (default true, as git does whenever the graph has filters).
   */
  setUseBloomFilters(use: boolean): this {
    this.checkCallable();
    this.useBloomFilters = use;
    return this;
  }

  /** What the path-limited walk did so far (see {@link LogPathStatistics}). */
  getStatistics(): LogPathStatistics {
    return {
      ...this.statistics,
      commitsWalked: this.lastWalk?.size ?? 0,
      walkTableBytes: this.lastWalk?.bytes ?? 0,
    };
  }

  /**
   * Add a commit range.
   *
   * Equivalent to `git log since..until` - includes commits reachable
   * from `until` but not from `since`.
   *
   * @param since Commits reachable from here are excluded
   * @param until Commits reachable from here are included (start point)
   */
  addRange(since: ObjectId, until: ObjectId): this {
    since = canonicalObjectId(since);
    until = canonicalObjectId(until);
    this.checkCallable();
    this.startCommits.push(until);
    this.pending.push({ id: since, exclude: true }, { id: until, exclude: false });
    return this;
  }

  /**
   * Execute the log command.
   *
   * @returns AsyncIterable of commits in reverse chronological order
   */
  async call(): Promise<AsyncIterable<LogResult>> {
    this.checkCallable();
    this.setCallable(false);
    // git_log_config ends in git_diff_ui_config: a diff.submodule without a value dies
    readDiffSubmoduleConfig(this.workingCopy);
    if (this.reflogWalkNames !== undefined || this.grepReflogs.length > 0) {
      await this.checkReflogWalkOptions({});
      const entries = await this.reflogEntries(this.reflogWalkNames ?? [], false);
      const walk = (async function* () {
        for (const e of entries) yield { ...e.commit, id: e.id, reflog: e.reflog } as LogResult;
      })();
      return walk;
    }
    this.activeFilter = await this.buildCommitFilter();

    // the commits given, in order, the refs of `all()` where it was called; HEAD without
    // either
    const pending: PendingCommit[] = [];
    for (let i = 0; i <= this.pending.length; i++) {
      if (this.includeAll && i === this.allAt) {
        for (const { id, name, raw } of await this.getAllRefs()) {
          if (raw !== id && this.ancestryPathCommits.includes(raw))
            this.ancestryPathPeeled.push(id);
          pending.push({ id, exclude: false, name });
        }
      }
      const e = this.pending[i];
      if (e && e.id !== (await this.peelToCommit(e.id)) && this.ancestryPathCommits.includes(e.id))
        this.ancestryPathPeeled.push(await this.peelToCommit(e.id));
      if (e)
        pending.push({
          id: await this.peelToCommit(e.id),
          exclude: e.exclude,
          name: e.name ?? e.id,
          ...(e.left ? { left: true } : {}),
        });
    }
    if (this.startCommits.length === 0 && !this.includeAll) {
      pending.push({ id: await this.resolveHead(), exclude: false, name: "HEAD" });
    }
    const walk = this.walk(pending);
    return this.reverse ? reversed(walk) : walk;
  }

  /**
   * The walk's filter: git's `--grep`/`--author`/`--committer` options as one `commit_match`
   * (revision.c), then the filters added. The walk reads `grep.patternType` (and refuses a
   * value git does not know) only when a pattern is given; the log output (`callBytes`, git
   * log and git show) reads it on every run, as git does.
   */
  private async buildCommitFilter(): Promise<CommitFilter | undefined> {
    const filters: CommitFilter[] = [];
    const headers =
      this.grepAuthors.length > 0 || this.grepCommitters.length > 0 || this.grepReflogs.length > 0;
    // the grep configuration and the mailmap are read only for a walk that greps: the
    // commands walking through LogCommand for git's other commands (bisect, notes, rev-list)
    // never see them
    if (this.grepMessages.length > 0 || headers) {
      let type = this.patternType;
      if (this.logConfig) {
        const configured = this.configuredPatternType();
        if (type === undefined) type = configured;
        if (type === undefined && configBool(this.workingCopy, "grep.extendedRegexp", false)) {
          type = "extended";
        }
      }
      let mailmap: Mailmap | undefined;
      const mapped =
        this.useMailmap ??
        (this.logConfig ? configBool(this.workingCopy, "log.mailmap", true) : false);
      if (headers && mapped) mailmap = await this.loadedMailmap();
      filters.push(
        CommitFilters.grep({
          messages: this.grepMessages,
          authors: this.grepAuthors,
          committers: this.grepCommitters,
          ...(this.grepReflogs.length > 0 ? { reflogs: this.grepReflogs } : {}),
          allMatch: this.allMatch,
          invertGrep: this.invertGrep,
          ignoreCase: this.regexpIgnoreCase,
          patternType: type,
          mailmap,
        }),
      );
    }
    filters.push(...this.commitFilters);
    return filters.length > 0 ? CommitFilters.and(...filters) : undefined;
  }

  /**
   * `grep.patternType` as grep_config reads it (`default` is undefined); a value git does not
   * know dies, as every `git log`/`git show` dies on it whatever it is asked.
   */
  private configuredPatternType(): GrepPatternType | undefined {
    const value = configValue(this.workingCopy, "grep.patternType");
    if (value === undefined || value === "default") return undefined;
    if (value === "basic" || value === "extended" || value === "fixed" || value === "perl") {
      return value;
    }
    throw new InvalidConfigError(
      "grep.patternType",
      `fatal: bad grep.patterntype argument: ${value}`,
    );
  }

  /** The bytes of a commit as the walk reads it (the replacement's under replace refs) */
  private async rawCommit(id: ObjectId, replacements?: ObjectReplacements): Promise<Uint8Array> {
    const read = replacements ? replacementOf(replacements.replace, id) : id;
    const bytes = await this.readObjectBytes(read);
    if (!bytes) throw new GitApiError(`could not read commit ${id}`);
    return bytes;
  }

  /**
   * The author date of a commit as commit.c's record_author_date reads it (0 when the
   * header has no well-formed author line).
   */
  private async authorDate(id: ObjectId): Promise<number> {
    const bytes = await this.readObjectBytes(
      replacementOf((await this.objectReplacements())?.replace ?? new Map(), id),
    ).catch(() => undefined);
    if (!bytes) return 0;
    const text = NAME_DECODER.decode(bytes);
    const end = text.indexOf("\n\n");
    for (const line of (end < 0 ? text : text.slice(0, end)).split("\n")) {
      if (!line.startsWith("author ")) continue;
      const m = /> (\d+) [+-]?\d+$/.exec(line) ?? /> (\d+)$/.exec(line);
      return m ? Number(m[1]) : 0;
    }
    return 0;
  }

  /** The commit an annotated tag (or a chain of them) tags; any other id as it is. */
  private async peelToCommit(start: ObjectId): Promise<ObjectId> {
    const tags = this.tagsStore;
    let id = start;
    for (let depth = 0; depth < 32 && tags && (await tags.has(id).catch(() => false)); depth++) {
      const tag = await tags.load(id).catch(() => undefined);
      if (!tag) break;
      id = tag.object;
    }
    return id;
  }

  /**
   * The commits of `--all` (revision.c's handle_refs): each ref under `refs/` in name order
   * (refs_for_each_ref, symbolic ones resolved), then HEAD (refs_head_ref); annotated tags
   * peeled.
   */
  private async getAllRefs(): Promise<{ id: ObjectId; name: string; raw: ObjectId }[]> {
    const named: { name: Uint8Array; id: ObjectId }[] = [];
    for await (const ref of this.refsStore.list()) {
      if (!ref.name.startsWith("refs/")) continue;
      let id = "objectId" in ref ? ref.objectId : undefined;
      if (!id) id = (await this.refsStore.resolve(ref.name).catch(() => undefined))?.objectId;
      if (id) named.push({ name: encodeGitPath(ref.name), id });
    }
    named.sort((a, b) => compareBytes(a.name, b.name));
    const ids: { id: ObjectId; name: string; raw: ObjectId }[] = [];
    for (const { id, name } of named)
      ids.push({ id: await this.peelToCommit(id), name: decodeGitPath(name), raw: id });
    const head = (await this.refsStore.resolve("HEAD").catch(() => undefined))?.objectId;
    if (head) ids.push({ id: await this.peelToCommit(head), name: "HEAD", raw: head });
    return ids;
  }

  /**
   * The walk of `git log`, ported from git's revision.c. Commits come out newest first by
   * committer date (equal dates in the order they were queued). With a pathspec, history is
   * simplified as try_to_simplify_commit does it: a commit is compared with each parent at the
   * paths; one that matches a relevant parent ("TREESAME") is not shown, and only that parent
   * is walked further. A root commit is shown when it has any of the paths. Before comparing a
   * commit with its first parent, the commit-graph's changed-path Bloom filter of the commit
   * is asked (check_maybe_different_in_bloom_filter): when it says no path changed, no tree is
   * read. Without a pathspec nothing is simplified (git's `revs->prune` is off).
   *
   * Without excluded commits the walk streams (get_revision_1). With some (`not`,
   * `addRange`), it is limited first as limit_list does it: one date-ordered queue holds the
   * included and the excluded commits, UNINTERESTING spreads to parents as commits are
   * taken, a commit's relevance is judged with what is marked so far, `--since` marks older
   * commits UNINTERESTING, and the walk stops once only uninteresting commits are left
   * (still_interesting); what is shown is filtered by the final marks.
   *
   * The commits met are held in a `RevTable` (typed arrays, a few dozen bytes each); commits
   * the commit-graph has are reached by their graph positions, without building their ids.
   */
  private async *walk(pending: PendingCommit[]): AsyncIterable<LogResult> {
    const hasPaths = this.paths.length > 0 || this.excludePaths.length > 0;
    const simplifyByDecoration = this.simplifyByDecoration;
    // --simplify-by-decoration prunes without paths: a commit no ref names is TREESAME
    const prune = hasPaths || simplifyByDecoration;
    const simplifyMerges = this.simplifyMerges || simplifyByDecoration;
    const ancestryPath = this.ancestryPathImplicit || this.ancestryPathCommits.length > 0;
    const dense = this.dense;
    const showPulls = this.showPulls;
    // git's want_ancestry: rewrite_parents (--parents, --graph, --simplify-merges)
    const wantAncestry = this.rewriteParents || simplifyMerges || !!this.outputWalk?.rewrite;
    const rewrite = prune && dense && wantAncestry;
    const decorations = simplifyByDecoration
      ? await (this.decorationLoader?.() ?? this.refDecorations())
      : undefined;
    // a shallow commit has no parents (git's shallow grafts); the graph is off then
    const shallowIds = (await this.refsStore.getShallow?.().catch(() => undefined)) ?? [];
    const shallow = new Set(shallowIds);
    // replace refs and grafts (git's parse_commit applies both; no commit-graph then)
    const replacements = await this.objectReplacements();
    this.markReplacementsRead();
    // trees compared for paths read through replace refs too (read_object_file)
    this.treeReplacements = replacements?.replace.size ? replacements.replace : undefined;
    const graph =
      shallow.size > 0 || replacements
        ? undefined
        : await this.commits.commitGraph?.get().catch(() => undefined);
    const pathspec = hasPaths ? this.pathspec() : undefined;
    const bloom =
      pathspec && this.useBloomFilters ? this.bloomKeys(graph, pathspec.items) : undefined;
    const bloomVersion = bloom ? this.changedPathsVersion() : -1;
    const fast = pathspec?.literal;
    const firstParentOnly = this.firstParentOnly;
    const simplifyHistory = this.simplifyHistory && !simplifyMerges && !ancestryPath;
    /**
     * Each merge's TREESAME to each parent (git's `treesame` decoration), kept when limiting
     * can make it TREESAME later (limiting_can_increase_treesame: full history, a limited walk)
     */
    const treesame = new Map<number, Uint8Array>();
    let trackTreesame = false;
    const t = new RevTable(graph);
    this.lastWalk = t;
    /** `--source`: the name each commit was reached from (git's revision_sources slab) */
    const sources = this.source ? new Map<number, string>() : undefined;
    /** Raw commits read by `parse` (no graph), kept until shown: read once, not twice. */
    const raw = new Map<number, Uint8Array>();

    /** git's parse_commit: tree, parents and date, from the graph when it has the commit */
    const parse = async (n: number): Promise<boolean> => {
      if (t.parsed(n)) return true;
      const gpos = t.gpos[n] as number;
      if (graph && gpos >= 0) {
        let parents: number[] | undefined;
        let date = 0;
        try {
          date = graph.commitTimeAt(gpos);
          parents = graph.parentPositionsAt(gpos);
        } catch {
          // a corrupt record: the commit is read instead
          parents = undefined;
        }
        if (parents) {
          t.setParsed(n, date, true, undefined, parents.length);
          for (let k = 0; k < parents.length; k++)
            t.setParent(n, k, t.lookupPos(parents[k] as number));
          return true;
        }
      }
      const id = t.idOf(n);
      const header = await this.readCommitHeader(id, replacements);
      if (!header) return false;
      const parents = shallow.has(id) ? [] : header.parents;
      t.setParsed(n, header.date, false, header.tree, parents.length);
      for (let k = 0; k < parents.length; k++) t.setParent(n, k, t.lookup(parents[k] as ObjectId));
      if (header.raw) raw.set(n, header.raw);
      return true;
    };
    const relevant = (n: number) => (t.flag(n) & (UNINTERESTING | BOTTOM)) !== UNINTERESTING;
    /** git's mark_parents_uninteresting: through the parents known (parsed) so far */
    const markParentsUninteresting = (n: number): void => {
      const stack: number[] = [];
      const markOne = (p: number) => {
        if (t.flag(p) & UNINTERESTING) return;
        t.mark(p, UNINTERESTING);
        for (let k = 0, c = t.parentCount(p); k < c; k++) stack.push(t.parent(p, k));
      };
      for (let k = 0, c = t.parentCount(n); k < c; k++) markOne(t.parent(n, k));
      for (let p = stack.pop(); p !== undefined; p = stack.pop()) markOne(p);
    };
    const emptyTree = this.objectFormat.emptyTreeId;
    /** git's rev_compare_tree (`from` given) and rev_same_tree_as_empty: whether n differs */
    const differs = async (
      from: ObjectId | undefined,
      n: number,
      nth: number,
    ): Promise<boolean> => {
      if (decorations && from !== undefined) {
        // a commit a ref names is worth showing; without paths, no other is
        if ((decorations.get(t.idOf(n))?.length ?? 0) > 0) return true;
        if (!pathspec) return false;
      }
      if (!pathspec) return t.treeOf(n) !== emptyTree;
      return this.differsAtPaths(
        from,
        t.treeOf(n),
        pathspec as TreePathspec,
        fast,
        nth === 0 ? bloom : undefined,
        bloomVersion,
        graph,
        t.bloomPos(n),
      );
    };
    /** git's try_to_simplify_commit */
    const simplify = async (n: number): Promise<void> => {
      // an unparsed commit has no tree (a parent --first-parent never read, met by rewriting)
      if (!prune || !t.parsed(n)) return;
      const count = t.parentCount(n);
      if (count === 0) {
        if (!(await differs(undefined, n, 0))) t.mark(n, TREESAME);
        return;
      }
      // --sparse: a non-merge always counts as a change
      if (!dense && count === 1) return;
      let relevantParents = 0;
      let relevantChange = false;
      let irrelevantChange = false;
      let ts: Uint8Array | undefined;
      for (let nth = 0; nth < count; nth++) {
        const p = t.parent(n, nth);
        if (relevant(p)) relevantParents++;
        if (nth === 1) {
          if (firstParentOnly) break;
          if (trackTreesame && !(t.flag(n) & UNINTERESTING)) {
            ts = new Uint8Array(count);
            treesame.set(n, ts);
            if (!(irrelevantChange || relevantChange)) ts[0] = 1;
          }
        }
        if (!(await parse(p))) {
          throw new GitApiError(`cannot simplify commit ${t.idOf(n)} (because of ${t.idOf(p)})`);
        }
        if (!(await differs(t.treeOf(p), n, nth))) {
          // a merge with an irrelevant side that brought the whole change keeps its others;
          // with the full history, every parent is kept
          if (!simplifyHistory || !relevant(p)) {
            if (ts) ts[nth] = 1;
            continue;
          }
          t.keepOnlyParent(n, p);
          // a merge diverted to a later parent is shown under --show-pulls
          if (!showPulls || nth === 0) t.mark(n, TREESAME);
          return;
        }
        if (relevant(p)) relevantChange = true;
        else irrelevantChange = true;
        if (nth === 0) t.mark(n, PULL_MERGE);
      }
      if (relevantParents ? !relevantChange : !irrelevantChange) t.mark(n, TREESAME);
    };
    /** git's process_parents */
    const processParents = async (n: number, queue: CommitQueue<number>): Promise<void> => {
      if (t.flag(n) & ADDED) return;
      t.mark(n, ADDED);
      if (t.flag(n) & UNINTERESTING) {
        for (let k = 0, c = t.parentCount(n); k < c; k++) {
          const p = t.parent(n, k);
          t.mark(p, UNINTERESTING);
          if (!(await parse(p))) continue;
          if (t.parentCount(p) > 0) markParentsUninteresting(p);
          if (t.flag(p) & SEEN) continue;
          t.mark(p, SEEN);
          queue.put(p, t.date(p));
        }
        return;
      }
      await simplify(n);
      const passFlags = t.flag(n) & (SYMMETRIC_LEFT | ANCESTRY_PATH);
      for (let k = 0, c = t.parentCount(n); k < c; k++) {
        const p = t.parent(n, k);
        if (!(await parse(p))) {
          throw new GitApiError(`Failed to traverse parents of commit ${t.idOf(n)}`);
        }
        if (passFlags) t.mark(p, passFlags);
        if (sources && !sources.has(p)) {
          const source = sources.get(n);
          if (source !== undefined) sources.set(p, source);
        }
        if (!(t.flag(p) & SEEN)) {
          t.mark(p, SEEN);
          queue.put(p, t.date(p));
        }
        if (firstParentOnly) break;
      }
    };
    /** git's get_commit_action (no parent rewriting: TREESAME commits are never shown) */
    const shown = async (n: number, ancestry = false): Promise<LogResult | undefined> => {
      const bytes = raw.get(n);
      if (bytes) raw.delete(n);
      // commit_early_ignore
      if (t.flag(n) & (UNINTERESTING | SHOWN)) return undefined;
      if (dense && t.flag(n) & TREESAME) {
        // with parents rewritten, a merge of two relevant lines ties the topology together
        if (!ancestry) return undefined;
        if (!(showPulls && t.flag(n) & PULL_MERGE)) {
          let relevantParents = 0;
          for (let k = 0, c = t.parentCount(n); k < c; k++)
            if (relevant(t.parent(n, k))) relevantParents++;
          if (relevantParents < 2) return undefined;
        }
      }
      if (this.untilTime !== undefined && t.date(n) > this.untilTime) return undefined;
      const parents = t.parentCount(n);
      if (this.revFilter === RevFilter.ONLY_MERGES && parents < 2) return undefined;
      if ((this.revFilter === RevFilter.NO_MERGES || this.cherry) && parents > 1) return undefined;
      const id = t.idOf(n);
      const commit = bytes ? decodeCommit(bytes) : await this.walkCommits.load(id);
      if (!commit) return undefined;
      const grafted = bytes ? replacements?.grafts.get(id) : undefined;
      if (grafted) commit.parents = [...grafted];
      // a shallow commit is shown without parents (its diff against the empty tree)
      if (shallow.has(id)) commit.parents = [];
      if (this.authorPattern !== undefined && !this.matchesAuthor(commit)) return undefined;
      if (this.committerPattern !== undefined && !this.matchesCommitter(commit)) return undefined;
      const filter = this.activeFilter;
      if (filter) {
        const view: FilteredCommit = {
          id,
          parentCount: parents,
          commitTime: t.date(n),
          raw: async () => bytes ?? (await this.rawCommit(id, replacements)),
          commit: async () => commit,
        };
        if (!(await filter.include(view))) return undefined;
      }
      const source = sources?.get(n);
      return {
        ...commit,
        id,
        ...(source !== undefined ? { source } : {}),
        ...sideOf(n),
      };
    };
    /** The side marks of a commit (SYMMETRIC_LEFT, PATCHSAME) */
    const sideOf = (n: number): { left?: true; patchSame?: true } => {
      const f = t.flag(n);
      return {
        ...(f & SYMMETRIC_LEFT ? { left: true } : {}),
        ...(f & PATCHSAME ? { patchSame: true } : {}),
      };
    };

    // --ancestry-path=<commit>: the commits (git marks the object named: a tag's commit is
    // not marked, only listed among the bottoms)
    const ancestryBottoms: number[] = [];
    for (const id of this.ancestryPathCommits) {
      const commit = await this.peelToCommit(id);
      const n = t.lookup(commit);
      if (commit === id) t.mark(n, ANCESTRY_PATH);
      ancestryBottoms.unshift(n);
    }
    for (const id of this.ancestryPathPeeled) t.mark(t.lookup(id), ANCESTRY_PATH);
    // prepare_revision_walk: the flags of every argument first, then handle_commit in order
    for (const e of pending) {
      if (e.left) t.mark(t.lookup(e.id), SYMMETRIC_LEFT);
      if (!e.exclude) continue;
      const n = t.lookup(e.id);
      t.mark(n, UNINTERESTING | BOTTOM);
    }
    const list: number[] = [];
    // --cherry-pick and --cherry-mark need limit_list, and so do --left-only and
    // --right-only from git 2.44 on (2.43 applies them only to a walk limited otherwise)
    // --ancestry-path and --simplify-merges limit the walk too (--parents does not: a
    // streaming walk rewrites parents as it goes)
    let limited =
      this.cherryPick ||
      this.cherryMark ||
      (this.compatibility !== "2.43" && (this.leftOnly || this.rightOnly)) ||
      ancestryPath ||
      simplifyMerges;
    /** git's update_treesame: TREESAME again from the per-parent marks, relevance as it is now */
    const updateTreesame = (n: number): void => {
      const count = t.parentCount(n);
      const st = treesame.get(n);
      if (count < 2 || !st) return;
      let relevantParents = 0;
      let relevantChange = false;
      let irrelevantChange = false;
      for (let k = 0; k < count; k++) {
        if (relevant(t.parent(n, k))) {
          relevantChange ||= !st[k];
          relevantParents++;
        } else irrelevantChange ||= !st[k];
      }
      if (relevantParents ? relevantChange : irrelevantChange) t.unmark(n, TREESAME);
      else t.mark(n, TREESAME);
    };
    /**
     * revision.c's limit_to_ancestry: of `list`, the commits neither descending from a bottom
     * (TMP_MARK) nor marked ANCESTRY_PATH (ancestors of a commit given) become UNINTERESTING.
     */
    const limitToAncestry = (bottoms: number[], list: number[]): void => {
      const marked = new Set(bottoms);
      const rlist = [...list].reverse();
      let progress: boolean;
      do {
        progress = false;
        for (const c of rlist) {
          if (marked.has(c) || t.flag(c) & UNINTERESTING) continue;
          for (let k = 0, n = t.parentCount(c); k < n; k++) {
            if (!marked.has(t.parent(c, k))) continue;
            marked.add(c);
            progress = true;
            break;
          }
        }
      } while (progress);
      for (const c of list) {
        if (marked.has(c) || t.flag(c) & ANCESTRY_PATH) continue;
        t.mark(c, UNINTERESTING);
      }
      for (const c of list) t.unmark(c, ANCESTRY_PATH);
      for (const c of bottoms) t.unmark(c, ANCESTRY_PATH);
    };
    /**
     * revision.c's compact_treesame: parent `nth` was just removed from n's parents (git's
     * treesame decoration follows; a merge become a non-merge takes its TREESAME at once).
     */
    const compactTreesame = async (n: number, nth: number): Promise<void> => {
      if (t.parentCount(n) === 0) {
        if (await differs(undefined, n, nth)) t.unmark(n, TREESAME);
        else t.mark(n, TREESAME);
        return;
      }
      const st = treesame.get(n);
      if (!st || nth >= st.length) throw new GitApiError(`compact_treesame ${nth}`);
      const next = new Uint8Array(st.length - 1);
      next.set(st.subarray(0, nth));
      next.set(st.subarray(nth + 1), nth);
      if (next.length === 1) {
        if (next[0] && dense) t.mark(n, TREESAME);
        else t.unmark(n, TREESAME);
        treesame.delete(n);
      } else treesame.set(n, next);
    };
    /** revision.c's remove_duplicate_parents: how many parents are left */
    const removeDuplicateParents = async (n: number): Promise<number> => {
      const tracked = treesame.has(n);
      const parents = t.parentList(n);
      const current = [...parents];
      let surviving = 0;
      for (const p of parents) {
        if (current.slice(0, surviving).includes(p)) {
          // the list shrinks before the treesame marks follow
          current.splice(surviving, 1);
          t.setParentList(n, current);
          if (tracked) await compactTreesame(n, surviving);
          continue;
        }
        surviving++;
      }
      return surviving;
    };
    /**
     * commit-reach.c's paint_down_to_common for remove_redundant (no generation cut): the
     * PARENT1 (from `one`) and PARENT2 (from `twos`) marks of the commits, through the
     * parents as the walk holds them (simplified ones included, as git's in-memory commits).
     */
    const paintDown = async (one: number, twos: number[]): Promise<Map<number, number>> => {
      const P1 = 1;
      const P2 = 2;
      const STALE = 4;
      const RESULT = 8;
      const marks = new Map<number, number>();
      const queue = new CommitQueue<number>();
      const markOf = (c: number) => marks.get(c) ?? 0;
      marks.set(one, P1);
      queue.put(one, t.date(one));
      for (const c of twos) {
        if (c === one) return marks;
        marks.set(c, markOf(c) | P2);
        queue.put(c, t.date(c));
      }
      const nonStale = () => queue.items().some((c) => !(markOf(c) & STALE));
      while (nonStale()) {
        const c = queue.get() as number;
        let flags = markOf(c) & (P1 | P2 | STALE);
        if (flags === (P1 | P2)) {
          marks.set(c, markOf(c) | RESULT);
          flags |= STALE;
        }
        for (let k = 0, n = t.parentCount(c); k < n; k++) {
          const p = t.parent(c, k);
          if ((markOf(p) & flags) === flags) continue;
          if (!(await parse(p))) {
            throw new GitApiError(`could not parse commit ${t.idOf(p)}`);
          }
          marks.set(p, markOf(p) | flags);
          queue.put(p, t.date(p));
        }
      }
      return marks;
    };
    /** commit-reach.c's reduce_heads: the commits no other one of `heads` reaches, in order */
    const reduceHeads = async (heads: number[]): Promise<number[]> => {
      const array = [...new Set(heads)];
      for (const c of array) await parse(c);
      const redundant = new Array<boolean>(array.length).fill(false);
      for (let i = 0; i < array.length; i++) {
        if (redundant[i]) continue;
        const others: number[] = [];
        const index: number[] = [];
        for (let j = 0; j < array.length; j++) {
          if (i === j || redundant[j]) continue;
          others.push(array[j] as number);
          index.push(j);
        }
        const marks = await paintDown(array[i] as number, others);
        if ((marks.get(array[i] as number) ?? 0) & 2) redundant[i] = true;
        for (let j = 0; j < others.length; j++) {
          if ((marks.get(others[j] as number) ?? 0) & 1) redundant[index[j] as number] = true;
        }
      }
      return array.filter((_, i) => !redundant[i]);
    };
    /** revision.c's simplify_merges over the sorted list: the commits that stay */
    const simplifyMergesOf = async (list: number[]): Promise<number[]> => {
      const simplified = new Map<number, number>();
      const simplifyOne = async (commit: number, tail: number[]): Promise<void> => {
        if (simplified.has(commit)) return;
        // an UNINTERESTING commit and a root simplify to themselves
        if (t.flag(commit) & UNINTERESTING || t.parentCount(commit) === 0) {
          simplified.set(commit, commit);
          return;
        }
        let pending = 0;
        for (let k = 0, c = t.parentCount(commit); k < c; k++) {
          const p = t.parent(commit, k);
          if (!simplified.has(p)) {
            tail.push(p);
            pending++;
          }
          if (firstParentOnly) break;
        }
        if (pending) {
          tail.push(commit);
          return;
        }
        // each parent rewritten to what it simplifies to
        for (let k = 0, c = t.parentCount(commit); k < c; k++) {
          t.setParent(commit, k, simplified.get(t.parent(commit, k)) as number);
          if (firstParentOnly) break;
        }
        let cnt = firstParentOnly ? 1 : await removeDuplicateParents(commit);
        if (cnt > 1) {
          // mark_redundant_parents and mark_treesame_root_parents (git's TMP_MARK)
          const parents = t.parentList(commit);
          const reduced = await reduceHeads(parents);
          const marked = new Set<number>();
          let count = 0;
          for (const p of parents) {
            if (!reduced.includes(p)) {
              marked.add(p);
              count++;
            }
          }
          for (const p of parents) {
            if (t.parentCount(p) === 0 && t.flag(p) & TREESAME) {
              marked.add(p);
              count++;
            }
          }
          if (count) {
            // leave_one_treesame_to_parent
            const ts = treesame.get(commit);
            let unmarked: number | undefined;
            let markedOne: number | undefined;
            for (let k = 0; k < parents.length; k++) {
              if (!ts?.[k]) continue;
              const p = parents[k] as number;
              if (marked.has(p)) markedOne ??= p;
              else {
                unmarked = p;
                break;
              }
            }
            if (unmarked === undefined && markedOne !== undefined) {
              marked.delete(markedOne);
              count--;
            }
          }
          if (count) {
            // remove_marked_parents
            const current = [...parents];
            let nth = 0;
            let removed = 0;
            for (const p of parents) {
              if (marked.has(p)) {
                current.splice(nth, 1);
                t.setParentList(commit, current);
                removed++;
                await compactTreesame(commit, nth);
                continue;
              }
              nth++;
            }
            // removing parents can only make the commit TREESAME
            if (removed && !(t.flag(commit) & TREESAME)) updateTreesame(commit);
            cnt = nth;
          }
        }
        const parent =
          !cnt || t.flag(commit) & UNINTERESTING || !(t.flag(commit) & TREESAME)
            ? undefined
            : oneRelevantParent(t, commit, firstParentOnly, relevant);
        if (parent === undefined || (showPulls && t.flag(commit) & PULL_MERGE)) {
          simplified.set(commit, commit);
        } else simplified.set(commit, simplified.get(parent) as number);
      };
      let yetToDo = [...list].reverse();
      while (yetToDo.length > 0) {
        const todo = yetToDo;
        yetToDo = [];
        for (const commit of todo) await simplifyOne(commit, yetToDo);
      }
      return list.filter((c) => simplified.get(c) === c);
    };
    /**
     * revision.c's rewrite_parents with rewrite_one in a streaming walk: each commit passed on
     * the way down is processed first (process_parents, its parents queued through a queue
     * of its own merged into the walk's), as git rewrites while it streams.
     */
    const rewriteStreaming = async (n: number, walkQueue: CommitQueue<number>) => {
      const out: number[] = [];
      for (let k = 0, c = t.parentCount(n); k < c; k++) {
        let p: number | undefined = t.parent(n, k);
        const own = new CommitQueue<number>();
        for (;;) {
          await processParents(p, own);
          if (t.flag(p) & UNINTERESTING || !(t.flag(p) & TREESAME)) break;
          if (t.parentCount(p) === 0) {
            p = undefined;
            break;
          }
          const next = oneRelevantParent(t, p, firstParentOnly, relevant);
          if (next === undefined) break;
          p = next;
        }
        for (let q = own.get(); q !== undefined; q = own.get()) walkQueue.put(q, t.date(q));
        if (p !== undefined && !out.includes(p)) out.push(p);
      }
      return out;
    };
    // `a...b`: git's get_merge_bases parsed every commit it painted while reading the
    // arguments, so mark_parents_uninteresting from the merge bases reaches through them
    for (let i = 0; i + 1 < pending.length; i++) {
      const a = pending[i] as PendingCommit;
      const b = pending[i + 1] as PendingCommit;
      if (!a.left || b.left || a.exclude !== b.exclude) continue;
      const na = t.lookup(a.id);
      const nb = t.lookup(b.id);
      if (!(await parse(na)) || !(await parse(nb))) continue;
      const marks = await paintDown(na, [nb]);
      const bases: number[] = [];
      for (const [c, m] of marks) if (m & 8 && !(m & 4)) bases.push(c);
      // get_merge_bases_many_0's remove_redundant over several candidates parses more
      if (bases.length > 1) await reduceHeads(bases);
    }
    for (const e of pending) {
      const n = t.lookup(e.id);
      if (!(await parse(n))) continue;
      if (sources && !sources.has(n) && e.name !== undefined) sources.set(n, e.name);
      if (t.flag(n) & UNINTERESTING) {
        markParentsUninteresting(n);
        limited = true;
      }
      if (!(t.flag(n) & SEEN)) {
        t.mark(n, SEEN);
        list.push(n);
      }
    }
    // commit_list_sort_by_date (stable), then into the date queue in that order
    list.sort((a, b) => t.date(b) - t.date(a));
    // limit_list's collect_bottom_commits
    if (this.ancestryPathImplicit) {
      for (const n of list) if (t.flag(n) & BOTTOM) ancestryBottoms.unshift(n);
      if (ancestryBottoms.length === 0) {
        throw new GitApiError("--ancestry-path given but there are no bottom commits");
      }
    }
    const queue = new CommitQueue<number>();
    for (const n of list) queue.put(n, t.date(n));

    const none = this.maxCount !== undefined && this.maxCount <= 0;
    const output = this.outputWalk;
    // --simplify-merges sorts topologically (in graph order unless another order is set)
    const order = this.order ?? (simplifyMerges ? "topo" : undefined);
    // the output's walk and a sorted one are limited (git without generation numbers limits
    // a topo walk); per-parent TREESAME is kept where limiting or simplify_merges needs it
    trackTreesame =
      prune &&
      !simplifyHistory &&
      !firstParentOnly &&
      (simplifyMerges || ((limited || !!output || !!order) && dense));
    /** git's sort_in_topological_order of `list` (parents as simplified, unparsed: none) */
    const sortTopo = async (list: number[], sort: LogOrder | undefined): Promise<number[]> => {
      if (list.length === 0) return list;
      const indegree = new Map<number, number>();
      for (const n of list) indegree.set(n, 1);
      const parentCount = (n: number) => (t.parsed(n) ? t.parentCount(n) : 0);
      for (const n of list) {
        for (let k = 0, c = parentCount(n); k < c; k++) {
          const p = t.parent(n, k);
          const d = indegree.get(p);
          if (d) indegree.set(p, d + 1);
        }
      }
      const out: number[] = [];
      let put: (n: number) => void;
      let get: () => number | undefined;
      if (sort === undefined || sort === "topo") {
        // REV_SORT_IN_GRAPH_ORDER: a LIFO, the tips first in the order given
        const stack: number[] = [];
        for (const n of list) if (indegree.get(n) === 1) stack.push(n);
        stack.reverse();
        put = (n) => stack.push(n);
        get = () => stack.pop();
      } else {
        const dates = new Map<number, number>();
        for (const n of list)
          dates.set(n, sort === "date" ? t.date(n) : await this.authorDate(t.idOf(n)));
        const queue = new CommitQueue<number>();
        put = (n) => queue.put(n, dates.get(n) ?? 0);
        get = () => queue.get();
        for (const n of list) if (indegree.get(n) === 1) put(n);
      }
      for (let n = get(); n !== undefined; n = get()) {
        for (let k = 0, c = parentCount(n); k < c; k++) {
          const p = t.parent(n, k);
          const d = indegree.get(p);
          if (!d) continue;
          indegree.set(p, d - 1);
          if (d - 1 === 1) put(p);
        }
        indegree.set(n, 0);
        out.push(n);
      }
      return out;
    };

    /** get_revision_1's commits, in the order they come out */
    let candidates: AsyncIterable<number> | Iterable<number>;
    /** The streaming walk's queue, which rewriting parents walks on (rewrite_one_1) */
    let streamQueue: CommitQueue<number> | undefined;
    if (!limited && !output && !order) {
      streamQueue = queue;
      // get_revision_1, streaming
      const since = this.sinceTime;
      candidates = (async function* () {
        for (let n = queue.get(); n !== undefined; n = queue.get()) {
          // --since: older commits are dropped without walking their parents (max_age)
          if (since !== undefined && t.date(n) < since) {
            raw.delete(n);
            continue;
          }
          await processParents(n, queue);
          yield n;
        }
      })();
    } else {
      // limit_list
      const newlist: number[] = [];
      let date = Number.POSITIVE_INFINITY;
      let slop = SLOP;
      let interestingCache = -1;
      /** git's everybody_uninteresting */
      const everybodyUninteresting = (): boolean => {
        if (interestingCache >= 0 && !(t.flag(interestingCache) & UNINTERESTING)) return false;
        for (const n of queue.items()) {
          if (t.flag(n) & UNINTERESTING) continue;
          interestingCache = n;
          return false;
        }
        return true;
      };
      /** git's still_interesting */
      const stillInteresting = (): number => {
        const head = queue.peek();
        if (head === undefined) return 0;
        if (date <= t.date(head)) return SLOP;
        if (!everybodyUninteresting()) return SLOP;
        return slop - 1;
      };
      for (let n = queue.get(); n !== undefined; n = queue.get()) {
        // what is shown is read again at the end: a limited walk does not keep raw commits
        raw.delete(n);
        if (n === interestingCache) interestingCache = -1;
        if (this.sinceTime !== undefined && t.date(n) < this.sinceTime) t.mark(n, UNINTERESTING);
        await processParents(n, queue);
        if (t.flag(n) & UNINTERESTING) {
          markParentsUninteresting(n);
          slop = stillInteresting();
          if (slop) continue;
          break;
        }
        if (this.untilTime !== undefined && t.date(n) > this.untilTime) continue;
        date = t.date(n);
        newlist.push(n);
      }
      if (this.cherryPick || this.cherryMark) {
        await this.cherryPickList(newlist, t, parse, pathspec ? this.pathspecItems() : undefined);
      }
      // limit_left_right
      if (this.leftOnly || this.rightOnly) {
        for (const n of newlist) {
          const left = !!(t.flag(n) & SYMMETRIC_LEFT);
          if (this.rightOnly ? left : !left) t.mark(n, SHOWN);
        }
      }
      if (ancestryPath) limitToAncestry(ancestryBottoms, newlist);
      // commits made TREESAME by parents that became UNINTERESTING
      if (trackTreesame && dense) {
        for (const n of newlist) {
          if (!(t.flag(n) & (UNINTERESTING | TREESAME))) updateTreesame(n);
        }
      }
      raw.clear();
      let sorted = output
        ? output.topo
          ? await sortTopo(newlist, order ?? "topo")
          : newlist
        : order
          ? await sortTopo(newlist, order)
          : newlist;
      if (simplifyMerges && prune) sorted = await simplifyMergesOf(sorted);
      if (output) {
        await this.finishOutputWalk(output, t, sorted, shown, relevant, parse, {
          ancestry: wantAncestry,
          rewrite,
        });
        return;
      }
      candidates = sorted;
    }

    // get_revision_internal: --skip, -n, then (--boundary) the parents of the commits
    // shown that were not shown themselves
    const collectBoundary = this.boundary;
    /** SHOWN */
    const shownSet = new Set<number>();
    /** CHILD_SHOWN, and git's boundary_commits array in the order marked */
    const childShown = new Set<number>();
    const boundaryCommits: number[] = [];
    let count = 0;
    let skipped = 0;
    // git's -n 0 reads nothing more in a streaming walk; a limited walk is done before
    if (!none) {
      for await (const n of candidates) {
        const commit = await shown(n, wantAncestry);
        if (!commit) continue;
        if (wantAncestry && t.parsed(n)) {
          // the parents shown: as the walk holds them (simplified), rewritten past the
          // commits not shown (simplify_commit's rewrite_parents changes commit->parents)
          const held = t.parentList(n);
          if (rewrite) {
            commit.savedParents = held.map((p) => t.idOf(p));
            const rewritten = streamQueue
              ? await rewriteStreaming(n, streamQueue)
              : rewriteParents(t, n, firstParentOnly, relevant);
            t.setParentList(n, rewritten);
            commit.parents = rewritten.map((p) => t.idOf(p));
          } else commit.parents = held.map((p) => t.idOf(p));
        }
        if (skipped < this.skip) {
          skipped++;
          continue;
        }
        shownSet.add(n);
        if (collectBoundary) {
          for (let k = 0, c = t.parentCount(n); k < c; k++) {
            const p = t.parent(n, k);
            if (shownSet.has(p) || childShown.has(p) || t.flag(p) & SHOWN) continue;
            childShown.add(p);
            boundaryCommits.push(p);
          }
        }
        yield commit;
        // git log and rev-list free a shown commit's parents (cmd_log_walk, finish_commit):
        // a later rewrite passing through it finds none (not under --reverse, which reads
        // the whole walk first)
        if (rewrite && !this.reverse && !this.keepShownParents) t.setParentList(n, []);
        if (this.maxCount !== undefined && ++count >= this.maxCount) break;
      }
    }
    if (!collectBoundary) return;
    // create_boundary_commit_list: each prepended (commit_list_insert), then sorted
    const boundaryList: number[] = [];
    const marked = new Set<number>();
    for (const n of boundaryCommits) {
      if (shownSet.has(n) || marked.has(n) || t.flag(n) & SHOWN) continue;
      marked.add(n);
      boundaryList.unshift(n);
    }
    for (const n of await sortTopo(boundaryList, order)) {
      const id = t.idOf(n);
      const commit = await this.walkCommits.load(id);
      if (!commit) continue;
      if (shallow.has(id)) commit.parents = [];
      const source = sources?.get(n);
      yield {
        ...commit,
        id,
        boundary: true,
        ...(source !== undefined ? { source } : {}),
        ...sideOf(n),
      };
    }
  }

  /**
   * The walk's commits for `git log`'s output (git's limited walk, then
   * sort_in_topological_order when asked, then get_commit_action and rewrite_parents): the
   * commits shown in order, with their parents as shown.
   */
  private async finishOutputWalk(
    output: OutputWalk,
    t: RevTable,
    newlist: number[],
    shown: (n: number, ancestry?: boolean) => Promise<LogResult | undefined>,
    relevant: (n: number) => boolean,
    parse: (n: number) => Promise<boolean>,
    mode: { ancestry: boolean; rewrite: boolean },
  ): Promise<void> {
    const order = newlist;
    const firstParentOnly = this.firstParentOnly;
    /** Rewritten parents the walk never reached (only with `--first-parent`) */
    const unwalked = new Set<number>();
    for (const n of order) {
      const commit = await shown(n, mode.ancestry);
      if (!commit) continue;
      // the parents as the walk holds them (simplified), as git's commit->parents
      let parents = t.parsed(n) ? t.parentList(n).map((p) => t.idOf(p)) : commit.parents;
      let savedParents: ObjectId[] | undefined;
      if (mode.rewrite) {
        // the parents before rewriting, which `--full-diff` diffs against (save_parents)
        savedParents = parents;
        const rewritten = rewriteParents(t, n, firstParentOnly, relevant);
        for (const p of rewritten) if (!(t.flag(p) & SEEN)) unwalked.add(p);
        parents = rewritten.map((p) => t.idOf(p));
      }
      const { id, source, boundary: _boundary, left, patchSame, ...rest } = commit;
      // the parents git frees once the commit is shown (cmd_log_walk; --skip's are not)
      if (mode.rewrite && output.entries.length >= this.skip) t.setParentList(n, []);
      output.entries.push({
        id,
        commit: rest,
        parents,
        ...(savedParents ? { savedParents } : {}),
        ...(source !== undefined ? { source } : {}),
        ...(left ? { left } : {}),
        ...(patchSame ? { patchSame } : {}),
      });
    }
    // graph.c's graph_is_interesting asks get_commit_action about a parent: one the walk
    // never reached has no TREESAME or SHOWN flag, so only the filters can hide it (with
    // `--first-parent` a merge whose first parent was rewritten away keeps a lane for it)
    if (unwalked.size > 0) {
      output.unwalkedShown = new Set();
      for (const p of unwalked) {
        if ((await parse(p)) && (await shown(p))) output.unwalkedShown.add(t.idOf(p));
      }
    }
  }

  /**
   * The log printed as `git log <options>` prints it to a pipe (no pager; colors only when
   * `setDiffOptions({ color })` or `color.ui`/`color.diff` say `always`): the
   * walk set up by this command (start points, ranges, paths, `-n`, `--skip`, filters), each
   * commit in the format asked for, with the graph and the diffs asked for. See
   * {@link LogOutputOptions}.
   *
   * @example
   * ```typescript
   * await git.log().setMaxCount(2).callText({ pretty: "format:%h %s" });
   * // "1a2b3c4 Second\n5d6e7f8 First"
   * ```
   */
  async callText(options: LogOutputOptions = {}): Promise<string> {
    return decodeGitPath(await this.callBytes(options));
  }

  /** {@link callText} as bytes (messages and file contents that are not UTF-8 kept as they are). */
  async callBytes(options: LogOutputOptions = {}): Promise<Uint8Array> {
    // one operation for the worktree: its attributes files (diff drivers) and configuration
    // are read once for every commit's diff, as git keeps its attribute stack (a bare
    // repository's working copy has none)
    return this.inOneOperation(() => this.printLog(options));
  }

  private async printLog(options: LogOutputOptions): Promise<Uint8Array> {
    const result = await this.printLogOutput(options);
    if (this.logConfig) await this.reportMailmapErrors(options, result.length > 0);
    return result;
  }

  private async printLogOutput(options: LogOutputOptions): Promise<Uint8Array> {
    const reverse = !!options.reverse || this.reverse;
    await this.checkReflogWalkOptions(options);
    // revision.c's setup_revisions: the graph cannot be reversed
    if (options.graph && reverse) {
      throw new IncompatibleOptionsError(
        ["--graph", "--reverse"],
        "options '--graph' and '--reverse' cannot be used together",
      );
    }
    // git log and git show read grep_config before anything else (a bad grep.patternType
    // dies there); the walk alone (rev-list, bisect's own walks) reads it only to grep
    if (this.logConfig) this.configuredPatternType();
    await this.preparePickaxe();
    // --use-mailmap/--no-mailmap: what --author/--committer match too
    if (options.mailmap !== undefined) this.useMailmap ??= options.mailmap;
    const colors = this.readColors();
    const host = this.outputHost(options);
    const paths = [...this.paths];
    // the pathspec as git holds it: the excluded paths as `:(exclude)` elements, `.` when
    // every element excludes
    const pathspec = [...paths, ...this.excludePaths.map((p) => `:(exclude)${p}`)];
    if (paths.length === 0 && this.excludePaths.length > 0) pathspec.push(".");
    const printer = new LogPrinter(
      host,
      { ...options, diff: { ...options.diff, ...this.diffOptions } },
      {
        interesting: (id) => shownIds.has(id) || unwalkedShown.has(id),
        firstParentOnly: this.firstParentOnly,
        paths: pathspec,
        ...this.revisionMarks(),
        ...(colors ? { colors } : {}),
      },
    );
    const follow = printer.followsPath;
    const countsShown = !printer.alwaysShowHeader;
    const graph = !!options.graph;
    const topo = graph;
    const boundary = !!options.boundary || this.boundary;
    if (graph && boundary) {
      // graph.c draws boundary commits as `o` in columns of their own: not reproduced
      throw new NotImplementedError("git log --graph --boundary");
    }
    // the walk's order, sources and boundary for the output (it reverses the list itself)
    const saved = { order: this.order, reverse: this.reverse, boundary: this.boundary };
    const saveSource = this.source;
    if (options.authorDateOrder) this.order = "author-date";
    else if (options.dateOrder) this.order = "date";
    else if (options.topoOrder) this.order ??= "topo";
    this.reverse = false;
    this.boundary = boundary;
    if (options.source || printer.wantsSource) this.source = true;
    const maxCount = this.maxCount;
    const skip = this.skip;
    const simplifyHistory = this.simplifyHistory;
    if (printer.fullHistory) this.simplifyHistory = false;
    // --parents: rewritten parents (the header's ids, %P)
    if (options.parents) this.rewriteParents = true;
    // --simplify-by-decoration keeps the commits git log's decoration filter decorates
    this.decorationLoader = () =>
      host.decorations({
        decorate: "short",
        ...(options.decorateRefs ? { decorateRefs: options.decorateRefs } : {}),
        ...(options.decorateRefsExclude
          ? { decorateRefsExclude: options.decorateRefsExclude }
          : {}),
        ...(options.clearDecorations ? { clearDecorations: true } : {}),
      });
    this.keepShownParents = reverse;
    // --follow walks every commit: its path changes as it goes
    if (follow) this.paths = [];
    const shownIds = new Set<ObjectId>();
    const unwalkedShown = new Set<ObjectId>();
    let entries: LogOutputEntry[];
    if (this.reflogWalkNames !== undefined) {
      entries = await this.reflogEntries(this.reflogWalkNames);
      for (const e of entries) shownIds.add(e.id);
    } else if (topo) {
      this.outputWalk = { topo, rewrite: graph, entries: [] };
      for await (const _ of await this.call()) {
        // the output walk collects its commits
      }
      entries = this.outputWalk.entries;
      for (const id of this.outputWalk.unwalkedShown ?? []) unwalkedShown.add(id);
      this.outputWalk = undefined;
      for (const e of entries) shownIds.add(e.id);
      entries = entries.slice(skip);
      // the commits shown count (--follow, pickaxe, --diff-filter): the print loop stops
      if (maxCount !== undefined && !countsShown) entries = entries.slice(0, Math.max(maxCount, 0));
      if (maxCount !== undefined && maxCount <= 0) entries = [];
    } else if (!reverse) {
      // cmd_log_walk: each commit shown as the walk gives it; --follow, pickaxe and
      // --diff-filter count the commits shown, not those walked (log.c gives max_count back
      // for a commit log_tree_commit did not show), so the walk stops once enough are shown
      if (countsShown) this.maxCount = undefined;
      await printer.start();
      try {
        if (maxCount === undefined || maxCount > 0) {
          let shownCount = 0;
          for await (const c of await this.call()) {
            const entry = outputEntry(c);
            const shown = await printer.showCommit(entry, []);
            if (shown && countsShown && maxCount !== undefined && ++shownCount >= maxCount) break;
          }
        }
      } finally {
        this.maxCount = maxCount;
        this.simplifyHistory = simplifyHistory;
        this.order = saved.order;
        this.reverse = saved.reverse;
        this.boundary = saved.boundary;
        this.source = saveSource;
        if (follow) this.paths = paths;
      }
      return printer.result();
    } else {
      // --reverse: the newest commits walked, reversed, then shown
      entries = [];
      for await (const c of await this.call()) {
        entries.push(outputEntry(c));
      }
    }
    this.simplifyHistory = simplifyHistory;
    this.order = saved.order;
    this.reverse = saved.reverse;
    this.boundary = saved.boundary;
    this.source = saveSource;
    if (follow && reverse && maxCount !== undefined) {
      entries = entries.slice(0, Math.max(maxCount, 0));
    }
    if (reverse) entries.reverse();
    await printer.start();
    if (graph) {
      const parentsOf = new Map(entries.map((e) => [e.id, e.parents]));
      printer.useGraph((id) => parentsOf.get(id) ?? []);
    }
    let count = 0;
    // -n 0: nothing is walked
    if (maxCount !== undefined && maxCount <= 0) entries = [];
    const countShown = countsShown && maxCount !== undefined && !reverse;
    for (let k = 0; k < entries.length; k++) {
      const e = entries[k] as LogOutputEntry;
      const lookahead = entries.slice(k + 1, k + 3).map((x) => x.id);
      const shown = await printer.showCommit(e, lookahead);
      if (shown && countShown && ++count >= (maxCount as number)) break;
    }
    if (follow) this.paths = paths;
    return printer.result();
  }

  /**
   * The refs' decorations (log-tree.c's load_ref_decorations): with `logOptions`, git log's
   * decoration filter; without, every ref and HEAD (get_name_decoration's own load).
   */
  private async refDecorations(
    logOptions?: LoadRefDecorationsOptions["logOptions"],
  ): Promise<RefDecorations> {
    const replacements = await this.objectReplacements();
    const shallow = (await this.refsStore.getShallow?.().catch(() => undefined)) ?? [];
    const environment = hostEnvironmentOf(this._workingCopy);
    const objects = this._workingCopy.history?.objects;
    const tags = this.tagsStore;
    return loadRefDecorations({
      refs: this.refsStore,
      ...(tags ? { tags } : {}),
      ...(environment?.replaceRefBase !== undefined
        ? { replaceRefBase: environment.replaceRefBase }
        : {}),
      useReplaceRefs: this.useReplaceRefs(),
      grafted: new Set([...(replacements?.grafts.keys() ?? []), ...shallow]),
      ...(objects ? { hasObject: (id: ObjectId) => objects.has(id) } : {}),
      ...(logOptions ? { logOptions } : {}),
    });
  }

  /** The mailmap, read once for the walk's filters and the output alike. */
  private loadedMailmap(): Promise<Mailmap> {
    this.mailmapLoad ??= this.readMailmap((line) => this.mailmapErrors.push(line));
    return this.mailmapLoad;
  }

  /**
   * git's `error:` lines of reading the mailmap (a `mailmap.blob` that is no blob), as git
   * log prints them: once when it reads the mailmap for the log (`log.mailmap`,
   * `--use-mailmap`), once more when a user format maps an identity (`%aN`, pretty.c's own
   * read) of a commit it shows.
   */
  private async reportMailmapErrors(options: LogOutputOptions, shown: boolean): Promise<void> {
    const forLog =
      options.mailmap ?? this.useMailmap ?? configBool(this.workingCopy, "log.mailmap", true);
    const pretty = options.pretty ?? configValue(this.workingCopy, "format.pretty") ?? "";
    const user = /^t?format:/.test(pretty) || (pretty.includes("%") && !options.oneline);
    const forFormat = shown && user && /%[ac][NEL]/.test(pretty);
    const times = (forLog ? 1 : 0) + (forFormat ? 1 : 0);
    if (times === 0) return;
    await this.loadedMailmap();
    for (let k = 0; k < times; k++) this.outputWarnings.push(...this.mailmapErrors);
  }

  /**
   * `git show`'s output of objects one at a time (builtin/log.c's cmd_show without a walk):
   * one printer for every object, so commits, tags and trees share git's `shown_one`
   * separators. Used by {@link ShowCommand}; the paths and filters set on this command
   * decide which commits show, as revision.c's no-walk mode simplifies each one.
   *
   * @internal
   */
  async showSession(options: LogOutputOptions): Promise<ShowSession> {
    this.checkCallable();
    this.setCallable(false);
    if (options.graph) {
      throw new IncompatibleOptionsError(
        ["--no-walk", "--graph"],
        "fatal: options '--no-walk' and '--graph' cannot be used together",
      );
    }
    if (this.logConfig) this.configuredPatternType();
    await this.preparePickaxe();
    if (options.mailmap !== undefined) this.useMailmap ??= options.mailmap;
    readDiffSubmoduleConfig(this.workingCopy);
    const colors = this.readColors();
    this.activeFilter = await this.buildCommitFilter();
    const host = this.outputHost(options);
    const pathspec = [...this.paths, ...this.excludePaths.map((p) => `:(exclude)${p}`)];
    if (this.paths.length === 0 && this.excludePaths.length > 0) pathspec.push(".");
    const printer = new LogPrinter(
      host,
      { ...options, diff: { ...options.diff, ...this.diffOptions } },
      {
        interesting: () => true,
        firstParentOnly: this.firstParentOnly,
        paths: pathspec,
        ...(colors ? { colors } : {}),
      },
    );
    await printer.start();
    const shown = new Set<ObjectId>();
    const limited = pathspec.length > 0;
    const commit = async (id: ObjectId): Promise<boolean> => {
      // get_revision's SHOWN flag: a commit named again is not shown again
      if (shown.has(id)) return false;
      const loaded = await this.walkCommits.load(id);
      if (!loaded) throw new GitApiError(`fatal: bad object ${id}`);
      // try_to_simplify_commit, then get_commit_action: a commit TREESAME to a parent (a
      // root without the paths) is ignored
      if (limited && (await this.treesameForShow(id, loaded, printer.fullHistory))) return false;
      const filter = this.activeFilter;
      if (filter) {
        const view: FilteredCommit = {
          id,
          parentCount: loaded.parents.length,
          commitTime: loaded.committer.timestamp,
          raw: async () => this.rawCommit(id),
          commit: async () => loaded,
        };
        if (!(await filter.include(view))) return false;
      }
      shown.add(id);
      await printer.showCommit({ id, commit: loaded, parents: loaded.parents }, []);
      return true;
    };
    const run = <T>(fn: () => Promise<T>): Promise<T> => {
      const worktree = this.worktreeAccess;
      return worktree?.batch ? worktree.batch(fn) : fn();
    };
    return {
      commit: (id) => run(() => commit(id)),
      separate: () => printer.separateObject(),
      markShown: () => printer.markShown(),
      text: (text) => printer.writeText(text),
      bytes: (bytes) => printer.writeBytes(bytes),
      tagger: (ident) => printer.writeTagger(ident),
      result: () => printer.result(),
      commitColor: { set: colors?.diff.commit ?? "", reset: colors?.diff.reset ?? "" },
    };
  }

  /**
   * revision.c's try_to_simplify_commit for a commit git shows without walking; without
   * `simplify_history` (`--full-history`, `-m`, `--remerge-diff`) a merge is TREESAME only
   * to every parent it looks at (update_treesame)
   */
  private async treesameForShow(id: ObjectId, commit: Commit, full = false): Promise<boolean> {
    if (commit.parents.length === 0) return !(await this.pathsDiffer(undefined, commit.tree));
    const merge = commit.parents.length > 1 && !this.firstParentOnly;
    const all = full || !this.simplifyHistory;
    for (let k = 0; k < commit.parents.length; k++) {
      if (k === 1 && this.firstParentOnly) break;
      const parent = await this.walkCommits.load(commit.parents[k] as ObjectId);
      if (!parent) {
        throw new GitApiError(
          `fatal: cannot simplify commit ${id} (because of ${commit.parents[k]})`,
        );
      }
      const same = !(await this.pathsDiffer(parent.tree, commit.tree));
      if (merge && all) {
        if (!same) return false;
      } else if (same) return true;
    }
    return merge && all;
  }

  /**
   * setup_revisions' refusals of a reflog walk: a sorted walk (`--topo-order`, `--graph`
   * without generation numbers: git's `limited`), then `--graph`/`--reverse`, then
   * `--grep-reflog` without `-g`.
   */
  private async checkReflogWalkOptions(options: LogOutputOptions): Promise<void> {
    const walking = this.reflogWalkNames !== undefined;
    if (walking) {
      const graph = !!options.graph;
      const reverse = !!options.reverse || this.reverse;
      if (reverse && this.compatibility === "2.43") {
        throw new IncompatibleOptionsError(
          ["--reverse", "--walk-reflogs"],
          "options '--reverse' and '--walk-reflogs' cannot be used together",
        );
      }
      const sorted =
        graph ||
        this.order !== undefined ||
        !!options.topoOrder ||
        !!options.dateOrder ||
        !!options.authorDateOrder;
      // a sorted walk is limited unless the commit-graph gives generation numbers
      if (sorted && !(await this.commits.commitGraph?.get().catch(() => undefined))) {
        throw new GitApiError("cannot combine --walk-reflogs with history-limiting options");
      }
      const set = [
        ...(graph ? ["--graph"] : []),
        ...(reverse ? ["--reverse"] : []),
        "--walk-reflogs",
      ];
      if (set.length > 1) {
        const quoted = set.map((o) => `'${o}'`);
        const list =
          quoted.length === 2
            ? `${quoted[0]} and ${quoted[1]}`
            : `${quoted[0]}, ${quoted[1]}, and ${quoted[2]}`;
        throw new IncompatibleOptionsError(set, `options ${list} cannot be used together`);
      }
    }
    if (!walking && this.grepReflogs.length > 0) {
      throw new GitApiError("the option '--grep-reflog' requires '--walk-reflogs'");
    }
  }

  /**
   * The entries of a reflog walk (reflog-walk.c's next_reflog_entry over the names given,
   * HEAD without): each entry's new commit, filtered as get_revision_1 filters a reflog walk
   * (`--since`/`--until` against the entry's date, path limiting against the commit's parents,
   * get_commit_action), then skipped and counted.
   */
  private async reflogEntries(names: readonly string[], claim = true): Promise<LogOutputEntry[]> {
    if (claim) {
      this.checkCallable();
      this.setCallable(false);
      readDiffSubmoduleConfig(this.workingCopy);
    }
    this.activeFilter = await this.buildCommitFilter();
    const resolver = this.revisionResolver();
    const refs = this.refsStore;
    const logs = await openReflogWalk(names.length > 0 ? names : ["HEAD"], {
      reflog: async (ref) => {
        const reader = await refs.getReflog?.(ref);
        return reader ? (await reader.getReverseEntries()).reverse() : undefined;
      },
      resolveRef: async (ref, reading) => {
        const value = await refs.get(ref).catch(() => undefined);
        if (!value) return undefined;
        if (!isSymbolicRef(value)) return reading && !value.objectId ? undefined : ref;
        let target = value.target;
        for (let i = 0; i < 10; i++) {
          const next = await refs.get(target).catch(() => undefined);
          if (!next || !isSymbolicRef(next)) {
            if (reading && !next) return undefined;
            return target;
          }
          target = next.target;
        }
        return undefined;
      },
      interpretBranchPrefix: (name) => resolver.interpretBranchPrefix(name),
      dwimLogRefs: (name) => resolver.dwimLogRefs(name),
      shortenRef: (ref) => shortenUnambiguousRef(refs, ref),
      now: () => resolver.currentTime(),
    });
    const out: LogOutputEntry[] = [];
    let skip = this.skip;
    const max = this.maxCount;
    if (max !== undefined && max <= 0) return out;
    const prune = this.paths.length > 0 || this.excludePaths.length > 0;
    const loadCommit = (id: ObjectId) => this.walkCommits.load(id).catch(() => undefined);
    for await (const step of walkReflogs(logs, loadCommit)) {
      const { id, commit } = step;
      if (this.sinceTime !== undefined && step.time < this.sinceTime) continue;
      if (this.untilTime !== undefined && step.time > this.untilTime) continue;
      const parents = commit.parents.length;
      if (this.revFilter === RevFilter.ONLY_MERGES && parents < 2) continue;
      if (this.revFilter === RevFilter.NO_MERGES && parents > 1) continue;
      if (this.authorPattern !== undefined && !this.matchesAuthor(commit)) continue;
      if (this.committerPattern !== undefined && !this.matchesCommitter(commit)) continue;
      const filter = this.activeFilter;
      if (filter) {
        const view: FilteredCommit = {
          id,
          parentCount: parents,
          commitTime: commit.committer.timestamp,
          raw: async () => this.rawCommit(id),
          commit: async () => commit,
          reflogMessage: step.reflog.message,
        };
        if (!(await filter.include(view))) continue;
      }
      if (prune && (await this.reflogCommitTreesame(commit))) continue;
      if (skip > 0) {
        skip--;
        continue;
      }
      out.push({ id, commit, parents: commit.parents, reflog: step.reflog });
      if (max !== undefined && out.length >= max) break;
    }
    return out;
  }

  /**
   * try_to_simplify_commit for a commit of a reflog walk (every parent relevant): TREESAME
   * at the paths to a parent (to every parent under `--full-history`), a root commit to the
   * empty tree.
   */
  private async reflogCommitTreesame(commit: Commit): Promise<boolean> {
    if (commit.parents.length === 0) return !(await this.pathsDiffer(undefined, commit.tree));
    let same = 0;
    let compared = 0;
    for (const parent of commit.parents) {
      if (compared === 1 && this.firstParentOnly) break;
      compared++;
      const p = await this.walkCommits.load(parent).catch(() => undefined);
      if (!p) throw new GitApiError(`cannot simplify commit ${parent}`);
      if (!(await this.pathsDiffer(p.tree, commit.tree))) {
        if (this.simplifyHistory) return true;
        same++;
      }
    }
    return same === compared;
  }

  /** What the log printer reads of the repository. */
  private outputHost(options: LogOutputOptions = {}): LogOutputHost {
    const config = RemoteConfigStore.from(this._workingCopy);
    const abbreviator = this.idAbbreviator();
    const abbrevs = new Map<string, string>();
    let notesTrees: Promise<NotesHandle[]> | undefined;
    let mailmap: Promise<Mailmap> | undefined;
    const trees = new OrderedMap<ObjectId, Promise<ObjectId>>();
    /** A commit's tree, as the walk parsed it (replace refs and grafts honoured) */
    const treeOf = (id: ObjectId): Promise<ObjectId> => {
      let tree = trees.get(id);
      if (!tree) {
        tree = (async () => {
          const header = await this.readCommitHeader(id, await this.objectReplacements());
          if (!header) throw new GitApiError(`could not parse commit ${id}`);
          return header.tree;
        })();
        trees.set(id, tree);
        if (trees.size > 4096) trees.deleteOldest();
      }
      return tree;
    };
    const runDiff = async (
      oldTree: ObjectId,
      newTree: ObjectId,
      formats: DiffOutputFormat[],
      options: { statWidth?: number; follow?: string; fullDiff?: boolean; abbrev?: number },
      prepare?: (diff: DiffCommand) => void,
    ) => {
      // the trees themselves: a full id names its object, so no revision is looked up
      const diff = new DiffCommand(this._workingCopy);
      prepare?.(diff);
      diff
        .setOldTree(oldTree)
        .setNewTree(newTree)
        // log's diffcore_rotate starts at the first path after a missing one
        .setRotateStrict(false)
        .shareReadsOf(this);
      if (this.colorSettings) diff.setColorSettings(this.colorSettings);
      diff.setOptions({
        ...this.diffOptions,
        ...(options.statWidth !== undefined
          ? { stat: { ...this.diffOptions.stat, width: options.statWidth } }
          : {}),
        ...(options.abbrev !== undefined ? { abbrev: options.abbrev } : {}),
      });
      if (!options.fullDiff && options.follow === undefined) {
        const spec = [...this.paths, ...this.excludePaths.map((p) => `:(exclude)${p}`)];
        if (spec.length > 0) diff.setPathspec(spec);
      }
      const shown = await diff.callFormats(formats, options.follow);
      if (diff.checkFoundErrors) this.checkFailed = true;
      return shown;
    };
    return {
      config: (key) => config.value(key),
      configAll: (key) => config.values(key),
      configNames: (section) => {
        const prefix = `${section.toLowerCase()}.`;
        const names = new Set<string>();
        for (const key of Object.keys(this._workingCopy.config ?? {})) {
          const parts = key.split(".");
          if (parts.length === 2 && key.toLowerCase().startsWith(prefix))
            names.add(parts[1] as string);
        }
        return [...names];
      },
      abbreviate: async (id, minLength) => {
        const key = `${id}:${minLength ?? ""}`;
        let short = abbrevs.get(key);
        if (short === undefined) {
          if (minLength === undefined) short = await abbreviator.abbreviate(id);
          else
            short = id.slice(0, (await abbreviator.lengths([id], minLength)).get(id) ?? minLength);
          abbrevs.set(key, short);
        }
        return short;
      },
      signature: (id) => this.signatureOf(id),
      signatureLines: (entry) => this.signatureLines(entry),
      rawCommit: async (id) => {
        // the replacement's content, as git's commit buffer is (core.useReplaceRefs)
        const replace = (await this.objectReplacements())?.replace;
        const bytes = await this.readObjectBytes(replace?.size ? replacementOf(replace, id) : id);
        return bytes ? decodeGitPath(bytes) : undefined;
      },
      decorations: (options) =>
        this.refDecorations({
          decorate: options.decorate,
          ...(options.decorateRefs ? { decorateRefs: options.decorateRefs } : {}),
          ...(options.decorateRefsExclude
            ? { decorateRefsExclude: options.decorateRefsExclude }
            : {}),
          ...(options.clearDecorations ? { clearDecorations: true } : {}),
          config,
        }),
      notes: async (id) => {
        notesTrees ??= this.loadNotes(config, options);
        const out: { ref: string; text: string }[] = [];
        for (const { ref, tree } of await notesTrees) {
          const blob = await tree.get(id);
          if (!blob) continue;
          const bytes = await this.readBlob(blob);
          if (bytes) out.push({ ref, text: decodeGitPath(bytes) });
        }
        return out;
      },
      mailmap: () => {
        mailmap ??= this.loadedMailmap();
        return mailmap;
      },
      diff: async (entry, parent, formats, options) =>
        runDiff(
          parent ? await treeOf(parent) : this.objectFormat.emptyTreeId,
          entry.commit.tree,
          formats,
          options,
        ),
      remergeDiff: async (entry, parents, formats, options) => {
        // log-tree.c's do_remerge_diff: the re-merge's objects live in a view of their own
        // (git's tmp_objdir), dropped after this merge
        const history = this._workingCopy.history;
        if (!history) throw new Error("WorkingCopy.history is required for commands");
        const view = remergeObjectsView(history);
        const remerge = new RemergeTreeCommand(this._workingCopy)
          .setObjectsView(view)
          .shareReadsOf(this)
          .setParents(parents[0], parents[1]);
        // git 2.43's cmd_log_walk freed the parents of every commit it had processed (2.44
        // keeps them under --remerge-diff), so its merge bases stop there (`--reverse`)
        if (
          this.compatibility === "2.43" &&
          this.reflogWalkNames === undefined &&
          options.processed?.size
        ) {
          remerge.setParentlessCommits(options.processed);
        }
        const remerged = await remerge.call();
        return runDiff(remerged.treeId, entry.commit.tree, formats, options, (diff) =>
          diff.setObjectsView(view).setAdditionalHeaders(remerged.pathMessages),
        );
      },
      combinedDiff: (entry, options) => this.combinedDiff(entry, options),
    };
  }

  private diffOptions: DiffTextOptions = {};
  /** `--check` found errors in a commit's diff (git's `check_failed`) */
  private checkFailed = false;

  /**
   * The exit status `git log` ends with: 2 when `--check` ({@link LogOutputOptions.check})
   * found errors in the diffs shown, else 0 (cmd_log_walk)
   */
  get exitCode(): number {
    return this.checkFailed ? 2 : 0;
  }

  /** The colors {@link callBytes} prints with */
  private colorSettings?: DiffColorSettings;
  private readonly outputWarnings: string[] = [];
  /** The mailmap as read once ({@link loadedMailmap}), and git's errors of reading it */
  private mailmapLoad?: Promise<Mailmap>;
  private readonly mailmapErrors: string[] = [];

  /**
   * What git prints on stderr while {@link callBytes} prints the log without dying: the
   * `log.graphColors` colors it cannot parse (`error: invalid color value: <c>`, then
   * `warning: ignored invalid color '<c>' in log.graphColors`)
   */
  get warnings(): readonly string[] {
    return this.outputWarnings;
  }

  /**
   * git_log_config (git_diff_ui_config): the colors, read once for every commit's diff; the
   * palettes of the log's own lines, undefined without color
   */
  private readColors():
    | { diff: DiffColors; decorations: DecorationPalette; graph: readonly string[] }
    | undefined {
    this.colorSettings = readDiffColorSettings(
      this.workingCopy,
      this.diffOptions,
      this.diffOptions.uiConfig !== false,
    );
    const colors = this.colorSettings.colors;
    if (!colors) return undefined;
    // graph_read_config: `log.graphColors` (its invalid colors left out with git's warning)
    const configured = configValue(this.workingCopy, "log.graphColors");
    const compatibility = this.diffOptions.colorCompatibility ?? "2.56";
    const graph =
      configured === undefined
        ? GRAPH_COLUMN_COLORS_ANSI
        : graphColumnColors(
            configured,
            (spec) => {
              const color = parseGitColor(spec, compatibility);
              // color_parse_mem's own error, before graph.c's warning
              if (color === undefined)
                this.outputWarnings.push(`error: invalid color value: ${spec}`);
              return color;
            },
            (message) => this.outputWarnings.push(message),
          );
    return {
      diff: colors,
      decorations: {
        ...(this.colorSettings.decorationColors ?? DEFAULT_DECORATION_COLORS),
        commit: colors.commit,
      },
      graph,
    };
  }

  /**
   * The pickaxe options checked before anything is shown, as git parses them (empty `-S`/
   * `-G`, `--find-object` names resolved once, the combinations, the regex compiled); `-i`
   * (`setRegexpIgnoreCase`) folds `-S`/`-G` too, as revision.c's `--regexp-ignore-case`
   */
  private async preparePickaxe(): Promise<void> {
    let o = this.diffOptions;
    if (!hasPickaxe(o)) return;
    if (this.regexpIgnoreCase && o.pickaxeIgnoreCase === undefined) {
      o = { ...o, pickaxeIgnoreCase: true };
    }
    checkPickaxeOptions(o);
    if (o.findObjects && o.findObjects.length > 0) {
      const ids: string[] = [];
      for (const name of o.findObjects) {
        const id = await this.revisionResolver()
          .resolve(name)
          .catch(() => undefined);
        if (id === undefined) {
          throw new InvalidArgumentError(
            "findObjects",
            name,
            `error: unable to resolve '${name}'`,
          ).withExitCode(129);
        }
        ids.push(id);
      }
      o = { ...o, findObjects: ids };
    }
    DiffPickaxe.compile({
      ...(o.pickaxeString !== undefined ? { string: o.pickaxeString } : {}),
      ...(o.pickaxeGrep !== undefined ? { grep: o.pickaxeGrep } : {}),
      regex: o.pickaxeRegex ?? false,
    });
    this.diffOptions = o;
  }

  /** `log` stores no objects: its abbreviations read each loose fan-out directory once */
  protected override writesNoObjects(): boolean {
    return true;
  }

  /** Options of the diffs {@link callBytes} prints (context, algorithm, `--stat` widths...) */
  setDiffOptions(options: DiffTextOptions): this {
    this.checkCallable();
    this.diffOptions = { ...this.diffOptions, ...options };
    return this;
  }

  private readonly signatureChecks = new OrderedMap<ObjectId, Promise<SignatureCheck>>();
  private signatureCwd?: Promise<string | undefined>;

  /** A commit's bytes as its buffer is read (the replacement's, core.useReplaceRefs) */
  private async commitBuffer(id: ObjectId): Promise<Uint8Array | undefined> {
    const replace = (await this.objectReplacements())?.replace;
    return this.readObjectBytes(replace?.size ? replacementOf(replace, id) : id);
  }

  /** `check_commit_signature` of a commit, made once */
  private signatureOf(id: ObjectId): Promise<SignatureCheck> {
    let check = this.signatureChecks.get(id);
    if (!check) {
      check = (async () => {
        const bytes = await this.commitBuffer(id);
        if (!bytes) return { result: "N", trustLevel: "undefined", failed: true, messages: [] };
        this.signatureCwd ??= this.hostWorkingDir();
        const cwd = await this.signatureCwd;
        return verifyCommitBytes(this._workingCopy, bytes, {
          objectFormat: this.objectFormat,
          ...(cwd !== undefined ? { cwd } : {}),
        });
      })();
      this.signatureChecks.set(id, check);
      if (this.signatureChecks.size > 1024) this.signatureChecks.deleteOldest();
    }
    return check;
  }

  /** log-tree.c's `show_signature` and `show_mergetag` for one commit */
  private async signatureLines(
    entry: LogOutputEntry,
  ): Promise<{ failed: boolean; text: string }[]> {
    const bytes = await this.commitBuffer(entry.id);
    if (!bytes) return [];
    this.signatureCwd ??= this.hostWorkingDir();
    const cwd = await this.signatureCwd;
    const out: { failed: boolean; text: string }[] = [];
    if (parseBufferSignedByHeader(bytes, this.objectFormat.signatureHeader)) {
      const check = await this.signatureOf(entry.id);
      out.push(
        check.failed && check.output === undefined
          ? { failed: true, text: "No signature\n" }
          : { failed: check.failed, text: check.output ?? "" },
      );
    }
    const parents = entry.commit.parents;
    for (const tag of mergetagsOf(bytes)) {
      const header = parseMergetag(tag, this.objectFormat.hexLength);
      let text: string;
      if (!header) text = "malformed mergetag\n";
      else if (parents.length === 2 && header.object === parents[1])
        text = `merged tag '${header.tag}'\n`;
      else {
        const nth = parents.indexOf(header.object);
        text =
          nth < 0
            ? `tag ${header.tag} names a non-parent ${header.object}\n`
            : `parent #${nth + 1}, tagged '${header.tag}'\n`;
      }
      let failed = true;
      const signed = parseSignature(tag);
      if (signed) {
        const check = await checkSignature(this._workingCopy, signed.payload, signed.signature, {
          payloadType: "tag",
          ...(cwd !== undefined ? { cwd } : {}),
        });
        failed = check.failed;
        text += check.output ?? "No signature\n";
      }
      out.push({ failed, text });
    }
    return out;
  }

  /** An object's content as stored (undefined when missing) */
  private async readObjectBytes(id: ObjectId): Promise<Uint8Array | undefined> {
    const objects = this._workingCopy.history?.objects;
    if (!objects) return undefined;
    try {
      const obj = await objects.get(id);
      if (!obj) return undefined;
      if (obj.bytes) return obj.bytes;
      const chunks: Uint8Array[] = [];
      for await (const c of obj.content) chunks.push(c);
      return concatBytes(chunks);
    } catch {
      return undefined;
    }
  }

  private async readBlob(id: ObjectId): Promise<Uint8Array | undefined> {
    try {
      const content = await this.blobs.load(id);
      if (!content) return undefined;
      const chunks: Uint8Array[] = [];
      for await (const c of content) chunks.push(c);
      return concatBytes(chunks);
    } catch {
      return undefined;
    }
  }

  /** The blobs of a tree, by path (empty for a missing tree) */
  private async flatTree(
    tree: ObjectId,
    prefix = "",
    out = new Map<string, { mode: number; id: ObjectId }>(),
  ): Promise<Map<string, { mode: number; id: ObjectId }>> {
    if (tree === this.objectFormat.emptyTreeId) return out;
    for await (const entry of this.trees.loadTree(tree)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if ((entry.mode & 0o170000) === 0o040000) await this.flatTree(entry.id, path, out);
      // the mode as git's tree walk reads it (canon_mode), as the tree store reads it
      else out.set(path, { mode: entry.mode, id: entry.id });
    }
    return out;
  }

  /**
   * The pickaxe of a combined diff: without rename detection `--find-object` keeps the paths
   * with the object in the merge or a parent (combined_objfind); with it, and for `-S`/`-G`,
   * find_paths_generic's way: a diff against each parent through diffcore (renames, pickaxe
   * and `--diff-filter`), keeping the paths every one of them still lists (intersect_paths)
   */
  private async combinedPickaxe(
    entry: LogOutputEntry,
    paths: string[],
    idsOf: (path: string) => (ObjectId | undefined)[],
  ): Promise<string[]> {
    const d = this.diffOptions;
    if (!hasPickaxe(d) || paths.length === 0) return paths;
    // need_generic_pathscan: rename detection (log's diff.renames, default on) or -S/-G
    const renames = configBool(this.workingCopy, "diff.renames", true);
    if (d.findObjects && d.findObjects.length > 0 && !renames) {
      const wanted = new Set(d.findObjects);
      return paths.filter((path) => idsOf(path).some((id) => id !== undefined && wanted.has(id)));
    }
    let kept = paths;
    for (const p of entry.parents) {
      const commit = await this.commits.load(p);
      const diff = new DiffCommand(this._workingCopy)
        .setOldTree(commit ? commit.tree : this.objectFormat.emptyTreeId)
        .setNewTree(entry.commit.tree)
        .shareReadsOf(this)
        .setRenames(renames)
        .setOptions(d);
      // the walk's pathspec: --pickaxe-all looks at the whole queue of each parent
      const spec = [...this.paths, ...this.excludePaths.map((x) => `:(exclude)${x}`)];
      if (spec.length > 0) diff.setPathspec(spec);
      const listed = new Set((await diff.call()).map((e) => e.newPath ?? e.oldPath));
      kept = kept.filter((path) => listed.has(path));
      if (kept.length === 0) break;
    }
    return kept;
  }

  /**
   * combine-diff.c's diff_tree_combined for a merge: the paths that differ from every
   * parent (within the pathspec), each as a combined diff of the trees.
   */
  private async combinedDiff(
    entry: LogOutputEntry,
    options: {
      dense: boolean;
      names?: "name-only" | "name-status";
      patch: boolean;
      follow?: string;
      parentPaths?: string[];
      parentStatus?: (string | undefined)[];
    },
  ): Promise<{ paths: number; names: Uint8Array; patch: Uint8Array }> {
    const { dense } = options;
    /** A parent's entry for a path (under `--follow`, the path it had the file under) */
    const sideOf = (m: Map<string, { mode: number; id: ObjectId }>, k: number, path: string) =>
      m.get(options.parentPaths?.[k] ?? path);
    const result = await this.flatTree(entry.commit.tree);
    const parents: Map<string, { mode: number; id: ObjectId }>[] = [];
    for (const p of entry.parents) {
      const commit = await this.commits.load(p);
      parents.push(commit ? await this.flatTree(commit.tree) : new Map());
    }
    // --follow: the one path followed (the walk's pathspec is set aside then)
    const spec =
      options.follow !== undefined
        ? [`:(literal)${options.follow}`]
        : [...this.paths, ...this.excludePaths.map((p) => `:(exclude)${p}`)];
    const items = spec.map((p) => parsePathspecItem(p, { attr: true }));
    if (items.length > 0 && items.every((i) => i.exclude)) items.push(parsePathspecItem("."));
    const all = new Set<string>(result.keys());
    for (const m of parents) for (const k of m.keys()) all.add(k);
    // `:(attr:...)`: the attributes of the paths, as the walk reads them
    if (items.some((i) => i.attr)) {
      await new PathspecAttributes(items, (path, names) => this.readAttributes(path, names)).load(
        all,
      );
    }
    const differs = (a?: { mode: number; id: ObjectId }, b?: { mode: number; id: ObjectId }) =>
      !a || !b ? a !== b : a.id !== b.id || a.mode !== b.mode;
    let paths = [...all]
      .filter((path) => items.length === 0 || matchPathspec(items, path, 0) > 0)
      .filter((path) =>
        parents.every(
          (m, k) =>
            (options.parentPaths !== undefined && options.parentPaths[k] !== path) ||
            differs(sideOf(m, k, path), result.get(path)),
        ),
      )
      .sort((a, b) => {
        const ea = encodeGitPath(a);
        const eb = encodeGitPath(b);
        for (let i = 0; i < ea.length && i < eb.length; i++) {
          if (ea[i] !== eb[i]) return (ea[i] as number) - (eb[i] as number);
        }
        return ea.length - eb.length;
      });
    paths = await this.combinedPickaxe(entry, paths, (path) => [
      result.get(path)?.id,
      ...parents.map((m, k) => sideOf(m, k, path)?.id),
    ]);
    const sink = new ByteSink();
    const quote =
      parseGitBool(RemoteConfigStore.from(this._workingCopy).value("core.quotePath")) ?? true;
    const names = new ByteSink();
    if (options.names) {
      for (const path of paths) {
        if (options.names === "name-status") {
          const r = result.get(path);
          parents.forEach((m, k) => {
            const found = options.parentStatus?.[k];
            names.text(found ?? (!sideOf(m, k, path) ? "A" : !r ? "D" : "M"));
          });
          names.text("\t");
        }
        names.text(`${quotePath(path, quote)}\n`);
      }
    }
    if (paths.length === 0 || !options.patch) {
      return { paths: paths.length, names: names.bytes(), patch: sink.bytes() };
    }
    const ids = new Set<string>([this.objectFormat.nullId]);
    for (const path of paths) {
      const r = result.get(path);
      if (r) ids.add(r.id);
      parents.forEach((m, k) => {
        const e = sideOf(m, k, path);
        if (e) ids.add(e.id);
      });
    }
    // combine-diff.c's index lines take DEFAULT_ABBREV, whatever --abbrev says
    const lengths = await this.idAbbreviator().lengths(ids);
    const read = async (e?: { mode: number; id: ObjectId }) => {
      if (!e) return new Uint8Array(0);
      if ((e.mode & 0o170000) === 0o160000) return encodeGitPath(`Subproject commit ${e.id}\n`);
      return (await this.readBlob(e.id)) ?? new Uint8Array(0);
    };
    const config = RemoteConfigStore.from(this._workingCopy);
    const context = Number(config.value("diff.context") ?? 3);
    // combine-diff.c diffs each parent with the xpparam flags of the diff options
    // (opt->xdl_opts): the algorithm, the indent heuristic, the whitespace flags
    const d = this.diffOptions;
    const xdiffOptions = {
      algorithm: d.algorithm ?? configAlgorithm(config.value("diff.algorithm")) ?? "myers",
      indentHeuristic:
        d.indentHeuristic ?? parseGitBool(config.value("diff.indentHeuristic")) ?? true,
      histogramRediff: d.histogramRediff,
      legacyMinimal: d.legacyMinimal,
      ignoreWhitespace: d.ignoreWhitespace,
      ignoreWhitespaceChange: d.ignoreWhitespaceChange,
      ignoreWhitespaceAtEol: d.ignoreWhitespaceAtEol,
      ignoreCrAtEol: d.ignoreCrAtEol,
      ignoreBlankLines: d.ignoreBlankLines,
    } satisfies CombinedDiffOptions;
    for (const path of paths) {
      const r = result.get(path);
      const sides = [];
      for (let k = 0; k < parents.length; k++) {
        const e = sideOf(parents[k] as Map<string, { mode: number; id: ObjectId }>, k, path);
        sides.push({
          id: e?.id ?? this.objectFormat.nullId,
          mode: e?.mode ?? 0,
          content: await read(e),
        });
      }
      writeCombinedDiff(
        sink,
        {
          path,
          parents: sides,
          result: {
            id: r?.id ?? this.objectFormat.nullId,
            mode: r?.mode ?? 0,
            content: await read(r),
          },
        },
        {
          ...xdiffOptions,
          dense,
          workingTreeFile: false,
          context: this.diffOptions.context ?? (Number.isFinite(context) ? context : 3),
          abbreviate: (id) =>
            id.slice(0, this.diffOptions.fullIndex ? id.length : (lengths.get(id) ?? 7)),
          quotePath: quote,
          ...(this.colorSettings?.colors ? { colors: this.colorSettings.colors } : {}),
        },
      );
    }
    return { paths: paths.length, names: names.bytes(), patch: sink.bytes() };
  }

  /**
   * notes.c's load_display_notes: the default notes ref (`GIT_NOTES_REF`, `core.notesRef`,
   * `refs/notes/commits`) and `GIT_NOTES_DISPLAY_REF` (else `notes.displayRef`), globs
   * expanded, unless only `--notes=<ref>` refs are asked for; then those refs.
   */
  private async loadNotes(
    config: RemoteConfigStore,
    options: LogOutputOptions,
  ): Promise<NotesHandle[]> {
    const ctx = this.notesContext();
    const extra = options.notesRefs ?? [];
    const refs: string[] = [];
    if (options.notes === true || extra.length === 0) {
      refs.push(defaultNotesRef(this._workingCopy));
      const env = notesEnvironmentOf(this._workingCopy).notesDisplayRef;
      if (env !== undefined) await addRefsFromColonSep(ctx, refs, env);
      else for (const r of config.values("notes.displayRef")) await addRefsByGlob(ctx, refs, r);
    }
    for (const r of extra) await addRefsByGlob(ctx, refs, expandNotesRef(r));
    const out: NotesHandle[] = [];
    for (const ref of refs) {
      try {
        out.push(await initNotes(ctx, ref, { combine: combineNotesIgnore }));
      } catch {
        // a ref that holds no tree-ish: git dies there, the log shows the others
      }
    }
    return out;
  }

  /**
   * The tree, parents and date of a commit (git's parse_commit_buffer), from its raw bytes
   * when the store gives them (kept in `raw` to be decoded whole if the commit is shown),
   * else from the commit store; undefined when it is missing or not a commit.
   */
  private async readCommitHeader(
    id: ObjectId,
    replacements?: ObjectReplacements,
  ): Promise<{ tree: ObjectId; parents: ObjectId[]; date: number; raw?: Uint8Array } | undefined> {
    if (replacements) {
      // the replacement's content read in place of the commit's; its grafted parents
      const read = replacementOf(replacements.replace, id);
      const header = await this.readCommitHeader(read);
      const grafted = replacements.grafts.get(id);
      return header && grafted ? { ...header, parents: [...grafted] } : header;
    }
    const objects = this._workingCopy.history?.objects;
    if (objects) {
      let obj: GitObject | undefined;
      let failed = false;
      try {
        const now = objects.getNow ? objects.getNow(id) : objects.get(id);
        obj = now instanceof Promise ? await now : now;
      } catch {
        obj = undefined;
        failed = true;
      }
      if (!obj && !failed) return undefined;
      if (obj?.bytes && obj.type === "commit") {
        try {
          const header = parseGraphCommit(obj.bytes, id, this.objectFormat);
          return { ...header, raw: obj.bytes };
        } catch {
          // read as the commit store reads it
        }
      } else if (obj) {
        await obj.content[Symbol.asyncIterator]().return?.();
      }
    }
    const commit = await this.commits.load(id).catch(() => undefined);
    if (!commit) return undefined;
    return { tree: commit.tree, parents: commit.parents, date: commit.committer.timestamp };
  }

  /**
   * The pathspec of the walk: the paths added, the excluded ones as `:(exclude)` elements,
   * and `.` when every element excludes (git's parse_pathspec). `literal` holds each
   * element's path components when all are plain paths (no wildcard, no magic, no trailing
   * slash): those are compared by looking their entries up, without a tree diff.
   */
  /** The walk's pathspec elements: the paths, the excluded ones, `.` when every one excludes */
  private pathspecItems(): PathspecItem[] {
    const parse = (p: string) => parsePathspecItem(p, { attr: true });
    const items: PathspecItem[] = this.paths.map(parse);
    for (const p of this.excludePaths) items.push({ ...parse(p), exclude: true });
    if (items.every((i) => i.exclude)) items.push(parse("."));
    return items;
  }

  /**
   * revision.c's cherry_pick_list over the limited list: the patch-ids of the side with fewer
   * commits are added (header ids only, see {@link PatchIds}), each commit of the other side
   * looked up, and every match on either side marked PATCHSAME (`--cherry-mark`) or SHOWN
   * (`--cherry-pick`, hidden). The diffs are limited to the walk's paths, and compare a
   * commit with its parent as the walk has it (simplified), as git's do.
   */
  private async cherryPickList(
    list: number[],
    t: RevTable,
    parse: (n: number) => Promise<boolean>,
    items: PathspecItem[] | undefined,
  ): Promise<void> {
    let leftCount = 0;
    let rightCount = 0;
    for (const n of list) {
      if (t.flag(n) & SYMMETRIC_LEFT) leftCount++;
      else rightCount++;
    }
    if (!leftCount || !rightCount) return;
    const leftFirst = leftCount < rightCount;
    const ids = new PatchIds<number>({
      trees: this.trees,
      blobs: this.blobs,
      objectFormat: this.objectFormat,
      change: async (n) => {
        const count = t.parentCount(n);
        if (count > 1) return undefined;
        if (count === 0) return { tree: t.treeOf(n) };
        const p = t.parent(n, 0);
        if (!(await parse(p))) return undefined;
        return { parentTree: t.treeOf(p), tree: t.treeOf(n) };
      },
      ...(items ? { paths: (path: string) => matchPathspec(items, path, 0) > 0 } : {}),
    });
    for (const n of list) {
      if (leftFirst !== !!(t.flag(n) & SYMMETRIC_LEFT)) continue;
      await ids.add(n);
    }
    const flag = this.cherryMark ? PATCHSAME : SHOWN;
    for (const n of list) {
      if (leftFirst === !!(t.flag(n) & SYMMETRIC_LEFT)) continue;
      const found = await ids.matches(n);
      if (found.length === 0) continue;
      t.mark(n, flag);
      for (const m of found) t.mark(m, flag);
    }
  }

  private pathspec(): TreePathspec & { literal: Uint8Array[][] | undefined } {
    const items = this.pathspecItems();
    const plain = items.every(
      (i) =>
        !i.exclude &&
        !i.icase &&
        !i.attr &&
        i.prefix === undefined &&
        i.nowildcardLen === i.match.length &&
        !i.match.endsWith("/"),
    );
    return {
      ...treePathspec(items),
      literal: plain
        ? items.map((i) => pathParts(i.match).map((part) => encodeGitPath(part)))
        : undefined,
    };
  }

  /** git's `commitGraph.changedPathsVersion` (-1: any; 0 when `readChangedPaths` is false). */
  private changedPathsVersion(): number {
    const raw = configValue(this._workingCopy, "commitGraph.changedPathsVersion");
    if (raw !== undefined && /^\s*[-+]?\d+\s*$/.test(raw)) return Number.parseInt(raw, 10);
    return configBool(this._workingCopy, "commitGraph.readChangedPaths", true) ? -1 : 0;
  }

  /**
   * The Bloom keys of the pathspec, one vector per element (its path and each leading
   * directory, git's bloom_keyvec_new), hashed with the graph's settings; undefined when the
   * graph has no filters or the pathspec cannot use them (git's prepare_to_use_bloom_filter:
   * exclude or icase magic, or an element without a literal leading directory).
   */
  private bloomKeys(
    graph: CommitGraph | undefined,
    items: PathspecItem[],
  ): { settings: BloomFilterSettings; keys: number[][][] } | undefined {
    const settings = graph?.bloomSettings;
    if (!settings || pathspecForbidsBloom(items)) return undefined;
    const keys: number[][][] = [];
    for (const item of items) {
      const path = bloomPathOf(item);
      if (path === undefined) return undefined;
      const bytes = Uint8Array.from(path, (ch) => ch.charCodeAt(0));
      const vec = [bloomKey(bytes, settings)];
      for (let end = bytes.length - 1; end > 0; end--) {
        if (bytes[end] === 0x2f) vec.push(bloomKey(bytes.subarray(0, end), settings));
      }
      keys.push(vec);
    }
    return { settings, keys };
  }

  private comparedPathspec?: TreePathspec & { literal: Uint8Array[][] | undefined };

  /**
   * Whether trees `from` (undefined: the empty tree) and `to` differ at the paths added
   * ({@link addPath}, {@link excludePath}): the pruned tree comparison of this walk's
   * history simplification (git's rev_compare_tree, no Bloom filter asked), for the walks of
   * other commands (`git bisect`). Trees read are cached as the walk's are.
   */
  async pathsDiffer(from: ObjectId | undefined, to: ObjectId): Promise<boolean> {
    this.comparedPathspec ??= this.pathspec();
    const ps = this.comparedPathspec;
    return this.differsAtPaths(from, to, ps, ps.literal, undefined, -1, undefined, -1);
  }

  /**
   * Whether the paths differ between tree `from` (undefined: the empty tree) and tree `to` of
   * the commit at graph position `pos` (git's rev_compare_tree / rev_same_tree_as_empty):
   * with `bloom`, the commit's filter is asked first and a "certainly not" ends it. A filter
   * of another hash version than `commitGraph.changedPathsVersion` asks for is not there
   * (git's get_bloom_filter).
   */
  private async differsAtPaths(
    from: ObjectId | undefined,
    to: ObjectId,
    pathspec: TreePathspec,
    literal: Uint8Array[][] | undefined,
    bloom: { settings: BloomFilterSettings; keys: number[][][] } | undefined,
    bloomVersion: number,
    graph: CommitGraph | undefined,
    pos: number,
  ): Promise<boolean> {
    const stats = this.statistics;
    let maybe = false;
    // a commit outside the graph is not asked (its generation is infinite)
    if (bloom && graph && pos >= 0) {
      const found = graph.bloomFilterAt(pos);
      const filter =
        found && (bloomVersion === -1 || found.settings.hashVersion === bloomVersion)
          ? found
          : undefined;
      if (!filter) {
        stats.bloomNotPresent++;
      } else {
        // bloom_filter_contains_vec over each path: one "maybe" (or an empty filter) is enough
        let result = 0;
        for (let i = 0; result === 0 && i < bloom.keys.length; i++) {
          result = 1;
          for (const key of bloom.keys[i] as number[][]) {
            result = bloomFilterContains(filter.data, key);
            if (result <= 0) break;
          }
        }
        if (result === 0) {
          stats.bloomDefinitelyNot++;
          return false;
        }
        stats.bloomMaybe++;
        maybe = result === 1;
      }
    }
    stats.treeComparisons++;
    let differs = false;
    if (literal) {
      for (const parts of literal) {
        if (await this.differsAtPath(from, to, parts, 0)) {
          differs = true;
          break;
        }
      }
    } else {
      differs = await this.treesDiffer(from, to, pathspec, EMPTY_TREE);
    }
    if (maybe && !differs) stats.bloomFalsePositive++;
    return differs;
  }

  /**
   * Whether trees `a` and `b` (undefined: empty) under `base` differ at a path in the
   * pathspec: git's pruned, recursive diff_tree_oid with `quick` (the first change ends it).
   * Entries are taken in git's tree order on both sides, those `tree_entry_interesting`
   * rejects skipped; a directory that differs, or is only on one side, is walked down.
   */
  private async treesDiffer(
    a: ObjectId | undefined,
    b: ObjectId | undefined,
    ps: TreePathspec,
    base: Uint8Array,
  ): Promise<boolean> {
    this.statistics.treeEntryReads++;
    // git reads the parent's tree, then the commit's
    const da = a ? await this.requireTree(a) : EMPTY_TREE;
    const db = b ? await this.requireTree(b) : EMPTY_TREE;
    const ca = new RawEntries(da, this.objectFormat.rawLength);
    const cb = new RawEntries(db, this.objectFormat.rawLength);
    // entries are matched where they lie in the tree's bytes: no name is decoded; an `:(attr)`
    // element waits for the attributes of a path, then the entry is matched again
    const skip = (c: RawEntries): Promise<void> | undefined => {
      while (!c.done) {
        c.read();
        const r = treeEntryInteresting(ps, c.d, c.nameStart, c.nul, c.mode, base);
        if (r === NEED_ATTRIBUTES) return this.loadAttributes(ps).then(() => skip(c));
        if (r === ALL_ENTRIES_NOT_INTERESTING) {
          c.at = c.d.length;
          return undefined;
        }
        if (r !== ENTRY_NOT_INTERESTING) return undefined;
        c.next();
      }
      return undefined;
    };
    for (;;) {
      const sa = skip(ca);
      if (sa) await sa;
      const sb = skip(cb);
      if (sb) await sb;
      if (ca.done && cb.done) return false;
      const cmp = ca.done ? 1 : cb.done ? -1 : ca.compare(cb);
      if (cmp === 0) {
        const same = ca.mode === cb.mode && ca.sameId(cb);
        if (!same) {
          if (!isTreeMode(ca.mode) || !isTreeMode(cb.mode)) return true;
          if (await this.treesDiffer(ca.id(), cb.id(), ps, ca.below(base))) return true;
        }
        ca.next();
        cb.next();
        continue;
      }
      // an entry on one side only: a file is a change, a directory is walked against nothing
      const one = cmp < 0 ? ca : cb;
      if (!isTreeMode(one.mode)) return true;
      const sub = one.id();
      const below =
        cmp < 0
          ? await this.treesDiffer(sub, undefined, ps, one.below(base))
          : await this.treesDiffer(undefined, sub, ps, one.below(base));
      if (below) return true;
      one.next();
    }
  }

  /**
   * The attributes `treeEntryInteresting` asks for (an `:(attr)` element), read as git's
   * match_pathspec_attrs reads them in `git log`: the check-in direction (the worktree's
   * `.gitattributes` first, then the index's) with no index read, so only the worktree's
   * files count, below `$GIT_DIR/info/attributes` and over `core.attributesFile` and the
   * system file; with an attribute source (`$GIT_ATTR_SOURCE`, `attr.tree`) the in-tree files
   * are its tree's. A bare repository has no in-tree files without one (git 2.56 reads none
   * without `attr.tree`): only the files outside the tree.
   */
  private async loadAttributes(ps: TreePathspec): Promise<void> {
    const attributes = ps.attributes;
    const path = attributes?.pending;
    if (!attributes || path === undefined) return;
    attributes.pending = undefined;
    attributes.values.set(path, await this.readAttributes(path, attributes.names));
  }

  /** The attributes `names` of `path` as {@link loadAttributes} reads them. */
  private async readAttributes(
    path: string,
    names: readonly string[],
  ): Promise<Map<string, PathspecAttributeValue>> {
    // a bare repository's working copy refuses its worktree: asked without touching it
    const worktree = "worktree" in this._workingCopy ? this.worktreeAccess : undefined;
    if (!worktree) return this.bareAttributes().get(path, names);
    const filter = worktree.contentFilter as
      | {
          attributes?(
            path: string,
            names: readonly string[],
            direction?: ContentAttributesContext,
          ): Promise<Map<string, PathspecAttributeValue>>;
        }
      | undefined;
    if (!filter?.attributes)
      throw new GitApiError("pathspec magic 'attr' needs the attributes of a worktree");
    return filter.attributes(path, names, { direction: "checkin", index: NO_INDEX });
  }

  private bareResolver?: AttributesResolver;

  /** The attributes of a bare repository (see {@link bareAttributesResolver}). */
  private bareAttributes(): AttributesResolver {
    this.bareResolver ??= bareAttributesResolver({
      workingCopy: this._workingCopy,
      trees: this.trees,
      blobs: this.blobs,
      revisions: () => this.revisionResolver(),
    });
    return this.bareResolver;
  }

  /** A tree's raw bytes; git's "unable to read tree" when it is missing. */
  private async requireTree(id: ObjectId): Promise<Uint8Array> {
    const raw = await this.rawTree(id);
    if (raw instanceof Uint8Array) return raw;
    if (raw === null) {
      // no raw object store: the entries are encoded back
      const entries = await this.trees.load(id);
      if (!entries) throw new GitApiError(`unable to read tree (${id})`);
      const parts: Uint8Array[] = [];
      for await (const e of entries) {
        parts.push(
          NAME_ENCODER.encode(`${e.mode.toString(8)} `),
          encodeGitPath(e.name),
          new Uint8Array(1),
          hexToBytes(e.id),
        );
      }
      return concatBytes(parts);
    }
    throw new GitApiError(`unable to read tree (${id})`);
  }

  /**
   * Whether the entries at `parts[i..]` below trees `a` and `b` differ (git's pathspec match:
   * the path itself, or anything below it). Equal subtrees end the walk down.
   */
  private async differsAtPath(
    a: ObjectId | undefined,
    b: ObjectId | undefined,
    parts: Uint8Array[],
    i: number,
  ): Promise<boolean> {
    // the whole tree (`.`, `:/`): a root commit compares with the empty tree, as in git
    const empty = this.objectFormat.emptyTreeId;
    if (parts.length === 0) return (a ?? empty) !== (b ?? empty);
    const name = parts[i] as Uint8Array;
    const ea = a ? await this.entryOf(a, name) : undefined;
    const eb = b ? await this.entryOf(b, name) : undefined;
    if (!ea && !eb) return false;
    if (ea && eb && ea.id === eb.id && canonTreeMode(ea.mode) === canonTreeMode(eb.mode)) {
      return false;
    }
    if (i === parts.length - 1) return true;
    const ta = ea && isTreeMode(ea.mode) ? ea.id : undefined;
    const tb = eb && isTreeMode(eb.mode) ? eb.id : undefined;
    if (!ta && !tb) return false;
    return this.differsAtPath(ta, tb, parts, i + 1);
  }

  /**
   * Entry `name` of tree `tree`: found in the tree's raw bytes (no entry is decoded but the
   * one asked for) when the store gives them, else through the tree store.
   */
  private async entryOf(
    tree: ObjectId,
    name: Uint8Array,
  ): Promise<{ id: ObjectId; mode: number } | undefined> {
    this.statistics.treeEntryReads++;
    const raw = await this.rawTree(tree);
    if (raw === null) return this.trees.getEntry(tree, NAME_DECODER.decode(name));
    if (raw === undefined) throw new GitApiError(`unable to read tree (${tree})`);
    return findRawEntry(raw, name, this.objectFormat.rawLength);
  }

  /** The replace refs a walk's tree reads follow; undefined without any. */
  private treeReplacements?: ReadonlyMap<ObjectId, ObjectId>;

  /** Raw trees read lately, most recently used last: a commit's trees are its child's parent trees. */
  private readonly rawTrees = new OrderedMap<ObjectId, Uint8Array>();
  private rawTreeBytes = 0;

  /** The raw bytes of a tree; undefined when it is missing, null without a raw object store. */
  private async rawTree(tree: ObjectId): Promise<Uint8Array | undefined | null> {
    const id = this.treeReplacements ? replacementOf(this.treeReplacements, tree) : tree;
    // the empty tree, which a store need not hold
    if (id === this.objectFormat.emptyTreeId) return EMPTY_TREE;
    const cached = this.rawTrees.get(id);
    if (cached) {
      this.rawTrees.delete(id);
      this.rawTrees.set(id, cached);
      return cached;
    }
    const objects = this._workingCopy.history?.objects;
    if (!objects) return null;
    let obj: GitObject | undefined;
    try {
      const now = objects.getNow ? objects.getNow(id) : objects.get(id);
      obj = now instanceof Promise ? await now : now;
    } catch {
      return null;
    }
    if (!obj) return undefined;
    if (obj.type !== "tree") {
      await obj.content[Symbol.asyncIterator]().return?.();
      return null;
    }
    let bytes = obj.bytes;
    if (!bytes) {
      const chunks: Uint8Array[] = [];
      for await (const c of obj.content) chunks.push(c);
      bytes = concatBytes(chunks);
    }
    this.rawTrees.set(id, bytes);
    this.rawTreeBytes += bytes.length;
    while (this.rawTrees.size > RAW_TREE_CACHE || this.rawTreeBytes > RAW_TREE_CACHE_BYTES) {
      const oldest = this.rawTrees.oldestKey() as ObjectId;
      if (oldest === id) break;
      this.rawTreeBytes -= (this.rawTrees.get(oldest) as Uint8Array).length;
      this.rawTrees.delete(oldest);
    }
    return bytes;
  }

  /**
   * Check if commit author matches the filter pattern.
   */
  private matchesAuthor(commit: Commit): boolean {
    if (!this.authorPattern) return true;
    const authorStr = `${commit.author.name} <${commit.author.email}>`.toLowerCase();
    return authorStr.includes(this.authorPattern);
  }

  /**
   * Check if commit committer matches the filter pattern.
   */
  private matchesCommitter(commit: Commit): boolean {
    if (!this.committerPattern) return true;
    const committerStr = `${commit.committer.name} <${commit.committer.email}>`.toLowerCase();
    return committerStr.includes(this.committerPattern);
  }
}

const isTreeMode = (mode: number) => (mode & 0o170000) === 0o040000;

const NAME_ENCODER = new TextEncoder();
const NAME_DECODER = new TextDecoder();

/** Raw trees a path-limited walk keeps. */
const RAW_TREE_CACHE = 512;

/** The bytes of raw trees a path-limited walk keeps at most (besides the one just read). */
const RAW_TREE_CACHE_BYTES = 32 * 1024 * 1024;

const EMPTY_TREE = new Uint8Array(0);

// revision.c's object flags, as the walk uses them
const UNINTERESTING = 1 << 1;
const BOTTOM = 1 << 2;
const SEEN = 1 << 3;
const ADDED = 1 << 4;
const TREESAME = 1 << 5;
/** The left side of `a...b` (passed from child to parent) */
const SYMMETRIC_LEFT = 1 << 8;
/** `--cherry-mark`: a commit whose change the other side has as well */
const PATCHSAME = 1 << 9;
/** Shown already, or hidden by `--cherry-pick`/`--left-only`/`--right-only` (git's SHOWN) */
const SHOWN = 1 << 10;
/** `--ancestry-path=<commit>`: an ancestor of a commit named (passed from child to parent) */
const ANCESTRY_PATH = 1 << 11;
/** `--show-pulls`: a merge that differs from its first parent at the paths */
const PULL_MERGE = 1 << 12;

/** How many extra uninteresting commits limit_list looks at (git's SLOP). */
const SLOP = 5;

/**
 * The commits a walk meets, as revision.c's object table holds them: flags, and once parsed
 * the date, the parents and (outside the commit-graph) the tree. Each commit is a number
 * indexing typed arrays, a few dozen bytes per commit instead of an object with its id, tree
 * and parent array. Commits the graph has are found by graph position (`lookupPos`), their
 * ids and trees read from the graph when needed; others by id.
 */
class RevTable {
  /** commits held */
  size = 0;
  /** revision.c flags (UNINTERESTING, SEEN, ...) */
  flags = new Uint16Array(INITIAL_REVS);
  /** committer dates (seconds) */
  private dates = new Float64Array(INITIAL_REVS);
  /** position in the commit-graph, -1 for a commit it does not have */
  gpos = new Int32Array(INITIAL_REVS);
  /** where the parents start in `pool`, once parsed */
  private parentAt = new Int32Array(INITIAL_REVS);
  /** how many parents, -1 before the commit is parsed */
  private parents = new Int32Array(INITIAL_REVS);
  /** every parsed commit's parents, in turn */
  private pool = new Int32Array(INITIAL_REVS);
  private poolUsed = 0;
  /** ids known without the graph (looked up by id), by commit */
  private readonly ids: (ObjectId | undefined)[] = [];
  /** trees of commits parsed outside the graph, by commit */
  private readonly trees: (ObjectId | undefined)[] = [];
  /** commits outside the graph, by id */
  private readonly byId = new Map<ObjectId, number>();
  /** commit + 1 by graph position (0: not met yet) */
  private readonly byPos: Int32Array | undefined;

  constructor(private readonly graph: CommitGraph | undefined) {
    this.byPos = graph ? new Int32Array(graph.size) : undefined;
  }

  /** Bytes the table's arrays take (the ids and trees kept besides them not counted). */
  get bytes(): number {
    return (
      this.flags.byteLength +
      this.dates.byteLength +
      this.gpos.byteLength +
      this.parentAt.byteLength +
      this.parents.byteLength +
      this.pool.byteLength +
      (this.byPos?.byteLength ?? 0)
    );
  }

  /** The commit `id`, added when first met (git's lookup_commit). */
  lookup(id: ObjectId): number {
    const known = this.byId.get(id);
    if (known !== undefined) return known;
    const pos = this.graph ? this.graph.position(id) : -1;
    if (pos >= 0) {
      const n = this.lookupPos(pos);
      this.ids[n] = id;
      return n;
    }
    const n = this.add(-1);
    this.ids[n] = id;
    this.byId.set(id, n);
    return n;
  }

  /** The commit at graph position `pos`, added when first met. */
  lookupPos(pos: number): number {
    const byPos = this.byPos as Int32Array;
    const known = (byPos[pos] as number) - 1;
    if (known >= 0) return known;
    const n = this.add(pos);
    byPos[pos] = n + 1;
    return n;
  }

  idOf(n: number): ObjectId {
    return this.ids[n] ?? (this.graph as CommitGraph).idAt(this.gpos[n] as number);
  }

  flag(n: number): number {
    return this.flags[n] as number;
  }

  mark(n: number, flags: number): void {
    this.flags[n] = (this.flags[n] as number) | flags;
  }

  unmark(n: number, flags: number): void {
    this.flags[n] = (this.flags[n] as number) & ~flags;
  }

  parsed(n: number): boolean {
    return (this.parents[n] as number) >= 0;
  }

  date(n: number): number {
    return this.dates[n] as number;
  }

  /** The tree of a parsed commit. */
  treeOf(n: number): ObjectId {
    if ((this.flags[n] as number) & GRAPH_PARSED)
      return (this.graph as CommitGraph).treeAt(this.gpos[n] as number);
    return this.trees[n] as ObjectId;
  }

  /** The graph position of a commit parsed from the graph (its Bloom filter), else -1. */
  bloomPos(n: number): number {
    return (this.flags[n] as number) & GRAPH_PARSED ? (this.gpos[n] as number) : -1;
  }

  /** Records a commit as parsed, with room for `count` parents (`setParent`). */
  setParsed(
    n: number,
    date: number,
    fromGraph: boolean,
    tree: ObjectId | undefined,
    count: number,
  ): void {
    this.dates[n] = date;
    if (fromGraph) this.mark(n, GRAPH_PARSED);
    else this.trees[n] = tree;
    if (this.poolUsed + count > this.pool.length) {
      const grown = new Int32Array(Math.max(this.pool.length * 2, this.poolUsed + count));
      grown.set(this.pool);
      this.pool = grown;
    }
    this.parentAt[n] = this.poolUsed;
    this.parents[n] = count;
    this.poolUsed += count;
  }

  setParent(n: number, k: number, p: number): void {
    this.pool[(this.parentAt[n] as number) + k] = p;
  }

  /** The parents of a parsed commit (0 before it is parsed). */
  parentCount(n: number): number {
    return Math.max(0, this.parents[n] as number);
  }

  parent(n: number, k: number): number {
    return this.pool[(this.parentAt[n] as number) + k] as number;
  }

  /** The parents of a parsed commit, as numbers. */
  parentList(n: number): number[] {
    const out: number[] = [];
    for (let k = 0, c = this.parentCount(n); k < c; k++) out.push(this.parent(n, k));
    return out;
  }

  /** Replaces the parents of a parsed commit by `list`, no longer than they were. */
  setParentList(n: number, list: readonly number[]): void {
    if (list.length > this.parentCount(n)) throw new Error("parents cannot grow");
    const at = this.parentAt[n] as number;
    for (let k = 0; k < list.length; k++) this.pool[at + k] = list[k] as number;
    this.parents[n] = list.length;
  }

  /** Simplification keeps only parent `p` (git rewrites `commit->parents`). */
  keepOnlyParent(n: number, p: number): void {
    this.pool[this.parentAt[n] as number] = p;
    this.parents[n] = 1;
  }

  private add(pos: number): number {
    const n = this.size++;
    if (n === this.flags.length) this.grow();
    this.gpos[n] = pos;
    this.parents[n] = -1;
    return n;
  }

  private grow(): void {
    const size = this.flags.length * 2;
    const flags = new Uint16Array(size);
    flags.set(this.flags);
    this.flags = flags;
    const dates = new Float64Array(size);
    dates.set(this.dates);
    this.dates = dates;
    const gpos = new Int32Array(size);
    gpos.set(this.gpos);
    this.gpos = gpos;
    const parentAt = new Int32Array(size);
    parentAt.set(this.parentAt);
    this.parentAt = parentAt;
    const parents = new Int32Array(size);
    parents.set(this.parents);
    this.parents = parents;
  }
}

/** Commits a `RevTable` has room for before it first grows. */
const INITIAL_REVS = 1024;
/** `RevTable` flag: parsed from the commit-graph (its tree and Bloom filter are there). */
const GRAPH_PARSED = 1 << 6;

/** revision.c's one_relevant_parent: the one parent a TREESAME commit simplifies to */
function oneRelevantParent(
  t: RevTable,
  n: number,
  firstParentOnly: boolean,
  relevant: (n: number) => boolean,
): number | undefined {
  const c = t.parentCount(n);
  if (c === 0) return undefined;
  if (firstParentOnly || c === 1) return t.parent(n, 0);
  let found: number | undefined;
  for (let k = 0; k < c; k++) {
    const p = t.parent(n, k);
    if (!relevant(p)) continue;
    if (found !== undefined) return undefined;
    found = p;
  }
  return found;
}

/**
 * revision.c's rewrite_parents: n's parents, each replaced by the first commit shown on its
 * way down (rewrite_one), roots TREESAME dropped, duplicates removed.
 */
function rewriteParents(
  t: RevTable,
  n: number,
  firstParentOnly: boolean,
  relevant: (n: number) => boolean,
): number[] {
  const out: number[] = [];
  for (let k = 0, c = t.parentCount(n); k < c; k++) {
    let p: number | undefined = t.parent(n, k);
    for (;;) {
      if (t.flag(p) & UNINTERESTING) break;
      if (!(t.flag(p) & TREESAME)) break;
      if (t.parentCount(p) === 0) {
        p = undefined;
        break;
      }
      const next = oneRelevantParent(t, p, firstParentOnly, relevant);
      if (next === undefined) break;
      p = next;
    }
    if (p !== undefined && !out.includes(p)) out.push(p);
  }
  return out;
}

/** A commit read whole, as the commit store decodes it; undefined if it does not parse. */
function decodeCommit(bytes: Uint8Array): Commit | undefined {
  try {
    return commitFromBytes(bytes);
  } catch {
    return undefined;
  }
}

/** memcmp order of two byte strings */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number);
  }
  return a.length - b.length;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0] as Uint8Array;
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** The entry named `name` (raw bytes) in raw tree `d`: its id and mode, or undefined. */
function findRawEntry(
  d: Uint8Array,
  name: Uint8Array,
  idLength: number,
): { id: ObjectId; mode: number } | undefined {
  let p = 0;
  const n = name.length;
  while (p < d.length) {
    let mode = 0;
    while (p < d.length && d[p] !== 0x20) mode = mode * 8 + ((d[p++] as number) - 0x30);
    p++;
    const start = p;
    while (p < d.length && d[p] !== 0) p++;
    const idAt = p + 1;
    if (p - start === n) {
      let k = 0;
      while (k < n && d[start + k] === name[k]) k++;
      if (k === n) return { id: bytesToHex(d.subarray(idAt, idAt + idLength)), mode };
    }
    p = idAt + idLength;
  }
  return undefined;
}

/** A path's components, without empty ones and "." (git's pathspec normalisation). */
const pathParts = (path: string) =>
  path.split("/").filter((part) => part.length > 0 && part !== ".");

/**
 * git's prio_queue with compare_commits_by_commit_date: the newest commit first, commits of
 * one date in the order they were put.
 */
class CommitQueue<T> {
  private entries: T[] = [];
  private dates: number[] = [];
  private ctrs: number[] = [];
  private ctr = 0;

  put(entry: T, date: number): void {
    const { entries, dates, ctrs } = this;
    let ix = entries.length;
    entries.push(entry);
    dates.push(date);
    ctrs.push(this.ctr++);
    while (ix > 0) {
      const parent = (ix - 1) >> 1;
      if (this.before(parent, ix)) break;
      this.swap(parent, ix);
      ix = parent;
    }
  }

  get(): T | undefined {
    const { entries } = this;
    if (entries.length === 0) return undefined;
    const top = entries[0];
    const last = entries.length - 1;
    this.swap(0, last);
    entries.pop();
    this.dates.pop();
    this.ctrs.pop();
    let ix = 0;
    for (;;) {
      let child = 2 * ix + 1;
      if (child >= entries.length) break;
      if (child + 1 < entries.length && this.before(child + 1, child)) child++;
      if (this.before(ix, child)) break;
      this.swap(ix, child);
      ix = child;
    }
    return top;
  }

  /** The entry `get` returns next (git's prio_queue_peek). */
  peek(): T | undefined {
    return this.entries[0];
  }

  /** The entries in heap order (git's prio_queue_for_each). */
  items(): readonly T[] {
    return this.entries;
  }

  /** Whether entry `a` comes out before entry `b`. */
  private before(a: number, b: number): boolean {
    const da = this.dates[a] as number;
    const db = this.dates[b] as number;
    if (da !== db) return da > db;
    return (this.ctrs[a] as number) < (this.ctrs[b] as number);
  }

  private swap(a: number, b: number): void {
    const { entries, dates, ctrs } = this;
    [entries[a], entries[b]] = [entries[b] as T, entries[a] as T];
    [dates[a], dates[b]] = [dates[b] as number, dates[a] as number];
    [ctrs[a], ctrs[b]] = [ctrs[b] as number, ctrs[a] as number];
  }
}

/**
 * A cursor over a raw tree's entries for the pruned diff: `read()` decodes the entry at `at`
 * (its mode, where its name starts and ends), `next()` moves past it. Names stay bytes.
 */
class RawEntries {
  at = 0;
  mode = 0;
  nameStart = 0;
  /** where the name ends (its NUL; the id follows) */
  nul = 0;
  /** @param idLength raw id bytes per entry: 20 (SHA-1) or 32 (SHA-256) */
  constructor(
    readonly d: Uint8Array,
    readonly idLength = 20,
  ) {}
  get done(): boolean {
    return this.at >= this.d.length;
  }
  read(): void {
    const d = this.d;
    let p = this.at;
    let mode = 0;
    while (p < d.length && d[p] !== 0x20) mode = mode * 8 + ((d[p++] as number) - 0x30);
    // the mode as git's tree walk reads it (canon_mode): 100664 is 100644
    this.mode = canonTreeMode(mode);
    this.nameStart = ++p;
    while (p < d.length && d[p] !== 0) p++;
    this.nul = p;
  }
  next(): void {
    this.at = this.nul + 1 + this.idLength;
  }
  id(): ObjectId {
    return bytesToHex(this.d.subarray(this.nul + 1, this.nul + 1 + this.idLength));
  }
  /** The base of the entries below this one (a directory): `base`, its name and "/". */
  below(base: Uint8Array): Uint8Array {
    const length = this.nul - this.nameStart;
    const out = new Uint8Array(base.length + length + 1);
    out.set(base);
    out.set(this.d.subarray(this.nameStart, this.nul), base.length);
    out[base.length + length] = 0x2f;
    return out;
  }
  sameId(other: RawEntries): boolean {
    for (let k = 1; k <= this.idLength; k++) {
      if (this.d[this.nul + k] !== other.d[other.nul + k]) return false;
    }
    return true;
  }
  /** git's base_name_compare of the names: a tree's name is followed by "/". */
  compare(other: RawEntries): number {
    const a = this.d;
    const b = other.d;
    const la = this.nul - this.nameStart;
    const lb = other.nul - other.nameStart;
    const n = Math.min(la, lb);
    for (let i = 0; i < n; i++) {
      const d = (a[this.nameStart + i] as number) - (b[other.nameStart + i] as number);
      if (d !== 0) return d;
    }
    const ca = n < la ? (a[this.nameStart + n] as number) : isTreeMode(this.mode) ? 0x2f : 0;
    const cb = n < lb ? (b[other.nameStart + n] as number) : isTreeMode(other.mode) ? 0x2f : 0;
    return ca - cb;
  }
}

/** `diff.algorithm` as diff.c's parse_algorithm_value reads it (undefined: not one) */
function configAlgorithm(v: string | undefined): XdiffAlgorithm | undefined {
  const s = v?.trim().toLowerCase();
  if (s === "default") return "myers";
  return s === "myers" || s === "minimal" || s === "patience" || s === "histogram" ? s : undefined;
}

/** tag.c's `parse_tag_buffer` of a mergetag: the object tagged and the tag's name. */
function parseMergetag(
  bytes: Uint8Array,
  hexLength: number,
): { object: ObjectId; tag: string } | undefined {
  const text = decodeGitPath(bytes);
  if (bytes.length < hexLength + 24) return undefined;
  const object = new RegExp(`^object ([0-9a-f]{${hexLength}})\n`).exec(text);
  if (!object) return undefined;
  let rest = text.slice(object[0].length);
  if (!rest.startsWith("type ")) return undefined;
  const nl = rest.indexOf("\n");
  if (nl < 0) return undefined;
  rest = rest.slice(nl + 1);
  const tag = /^tag ([^\n]*)\n/.exec(rest);
  return { object: object[1] as ObjectId, tag: tag ? (tag[1] as string) : "(null)" };
}
