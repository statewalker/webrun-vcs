/**
 * Commit filters: the stage of the revision walk that decides whether a commit the walk
 * reaches is shown (revision.c's `get_commit_action` after the walk's own marks). Filters
 * compose with {@link CommitFilters.and}, {@link CommitFilters.or} and {@link CommitFilters.not}
 * (JGit's `AndRevFilter`/`OrRevFilter`/`NotRevFilter`), and `LogCommand`, `RevListCommand` and
 * every command walking through them take one with `addCommitFilter`.
 *
 * @example
 * ```ts
 * import { CommitFilters } from "@statewalker/vcs-commands";
 *
 * // git log --author=alice --grep=fix -i, but not merges, from March on
 * const filter = CommitFilters.and(
 *   CommitFilters.grep({ authors: ["alice"], messages: ["fix"], ignoreCase: true }),
 *   CommitFilters.noMerges(),
 *   CommitFilters.commitTime({ since: Date.parse("2026-03-01") / 1000 }),
 * );
 * for await (const c of await git.log().addCommitFilter(filter).call()) console.log(c.id);
 * ```
 *
 * A filter only hides commits: the walk still goes through a hidden commit to its parents,
 * and `-n`/`--skip` count shown commits only, as git counts them. Filters that need a diff
 * (pickaxe) or keep state per commit (`-L`) implement {@link CommitFilter} themselves: `include`
 * may be async and gets the commit's id, parents and raw bytes.
 *
 * @module
 */

import type { Commit, ObjectId } from "@statewalker/vcs-core";

import { type CommitGrepOptions, compileCommitGrep } from "./commit-grep.js";

/** What a filter sees of a commit the walk is about to show */
export interface FilteredCommit {
  /** The commit's id */
  readonly id: ObjectId;
  /** Its parents as the walk read them (grafts and shallow commits applied) */
  readonly parentCount: number;
  /** The committer date, in seconds (what `--since`/`--until` compare) */
  readonly commitTime: number;
  /** The commit object as stored (a replacement's content when replace refs apply) */
  raw(): Promise<Uint8Array>;
  /** The commit decoded */
  commit(): Promise<Commit>;
}

/** Decides whether the walk shows a commit */
export interface CommitFilter {
  include(commit: FilteredCommit): boolean | Promise<boolean>;
}

const ALL: CommitFilter = { include: () => true };
const NONE: CommitFilter = { include: () => false };

/** Builders of {@link CommitFilter}s (JGit's RevFilter family, with git's options) */
export const CommitFilters = {
  /** Every commit (JGit's `RevFilter.ALL`) */
  all(): CommitFilter {
    return ALL;
  },

  /** No commit (JGit's `RevFilter.NONE`) */
  none(): CommitFilter {
    return NONE;
  },

  /** Commits every filter includes, asked in order until one says no */
  and(...filters: CommitFilter[]): CommitFilter {
    if (filters.length === 0) return ALL;
    if (filters.length === 1) return filters[0] as CommitFilter;
    return {
      async include(commit) {
        for (const f of filters) if (!(await f.include(commit))) return false;
        return true;
      },
    };
  },

  /** Commits some filter includes, asked in order until one says yes */
  or(...filters: CommitFilter[]): CommitFilter {
    if (filters.length === 0) return NONE;
    if (filters.length === 1) return filters[0] as CommitFilter;
    return {
      async include(commit) {
        for (const f of filters) if (await f.include(commit)) return true;
        return false;
      },
    };
  },

  /** Commits the filter does not include */
  not(filter: CommitFilter): CommitFilter {
    return { include: async (commit) => !(await filter.include(commit)) };
  },

  /** `--min-parents`/`--max-parents` (`max` negative: no limit) */
  parents(min: number, max = -1): CommitFilter {
    return {
      include: (c) => c.parentCount >= min && (max < 0 || c.parentCount <= max),
    };
  },

  /** `--no-merges` (JGit's `RevFilter.NO_MERGES`) */
  noMerges(): CommitFilter {
    return CommitFilters.parents(0, 1);
  },

  /** `--merges` (JGit's `RevFilter.ONLY_MERGES`) */
  onlyMerges(): CommitFilter {
    return CommitFilters.parents(2);
  },

  /**
   * Commits whose committer date is at or after `since` and at or before `until` (seconds):
   * `--since-as-filter` and `--until` (JGit's `CommitTimeRevFilter.after/before/between`).
   * Unlike `LogCommand.setSince` (`--since`), the walk is not cut at older commits.
   */
  commitTime(range: { since?: number; until?: number }): CommitFilter {
    const { since, until } = range;
    return {
      include: (c) =>
        (since === undefined || c.commitTime >= since) &&
        (until === undefined || c.commitTime <= until),
    };
  },

  /**
   * git's `--grep`/`--author`/`--committer` with `--all-match`, `--invert-grep`, `-i` and the
   * pattern type, matched as one `commit_match` (see `compileCommitGrep`). Throws
   * `GrepPatternError` at once for a pattern git refuses.
   */
  grep(options: CommitGrepOptions): CommitFilter {
    const grep = compileCommitGrep(options);
    return { include: async (c) => grep.matches(await c.raw()) };
  },

  /** `--author=<pattern>` (a basic regex unless `patternType` says otherwise) */
  author(pattern: string, options: Omit<CommitGrepOptions, "authors"> = {}): CommitFilter {
    return CommitFilters.grep({ ...options, authors: [pattern] });
  },

  /** `--committer=<pattern>` */
  committer(pattern: string, options: Omit<CommitGrepOptions, "committers"> = {}): CommitFilter {
    return CommitFilters.grep({ ...options, committers: [pattern] });
  },

  /**
   * `--grep=<pattern>` over the message; `{ patternType: "fixed", ignoreCase: true }` is
   * JGit's `MessageRevFilter` substring match (`RawSubStringPattern`)
   */
  message(pattern: string, options: Omit<CommitGrepOptions, "messages"> = {}): CommitFilter {
    return CommitFilters.grep({ ...options, messages: [pattern] });
  },
};
