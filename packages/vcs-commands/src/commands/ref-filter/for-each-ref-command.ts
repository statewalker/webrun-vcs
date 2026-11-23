import type { ObjectId } from "@statewalker/vcs-core";

import { RefFilterError } from "../../errors/index.js";
import {
  filterAndFormatRefs,
  parseRefSorting,
  type RefFilterOptions,
  type RefSortKey,
} from "./ref-filter.js";
import { type RefFilterItem, RefFormat, RefKind } from "./ref-format.js";
import { RefListingCommand } from "./ref-listing-command.js";
import type { RefQuoteStyle } from "./ref-quote.js";

/** A ref `for-each-ref` showed. */
export interface ForEachRefEntry {
  /** Its full name */
  refname: string;
  /** The object it names */
  objectId: ObjectId;
}

/** What {@link ForEachRefCommand} printed. */
export interface ForEachRefResult {
  /** git's stdout, each ref's line and its newline (bytes outside UTF-8 as `decodeGitPath` keeps them) */
  output: string;
  /** Each shown ref's expanded format, in order (an empty one left out with `--omit-empty`) */
  lines: string[];
  /** The refs shown, in order */
  refs: ForEachRefEntry[];
  /** git's warnings on stderr (`warning: ignoring broken ref ...`) */
  warnings: string[];
}

/** git's default `for-each-ref` format. */
export const DEFAULT_FOR_EACH_REF_FORMAT = "%(objectname) %(objecttype)\t%(refname)";

/**
 * List refs with git's ref-filter.
 *
 * Equivalent to `git for-each-ref [--count=<n>] [--shell|--perl|--python|--tcl]
 * [(--sort=<key>)...] [--format=<format>] [--include-root-refs] [--points-at=<object>]
 * [--merged[=<commit>]] [--no-merged[=<commit>]] [--contains[=<commit>]]
 * [--no-contains[=<commit>]] [(--exclude=<pattern>)...] [--start-after=<marker>]
 * [--ignore-case] [--omit-empty] [--color] [<pattern>...]`.
 *
 * @example
 * ```typescript
 * const { output } = await git
 *   .forEachRef()
 *   .setFormat("%(refname:short) %(upstream:track)")
 *   .setSort("-committerdate")
 *   .setPatterns("refs/heads/")
 *   .call();
 * ```
 *
 * The format language is git's (`%(refname:short)`, `%(objectname:short=10)`,
 * `%(upstream:track)`, `%(push)`, `%(HEAD)`, `%(authorname:mailmap)`,
 * `%(committerdate:iso)`, `%(subject)`, `%(contents:lines=2)`, `%(trailers:key=...)`,
 * `%(*objectname)` of what a tag peels to, `%(if)...%(then)...%(else)...%(end)`,
 * `%(align:30,middle)...%(end)`, `%(color:red)`, `%(worktreepath)`, `%(describe)`,
 * `%(ahead-behind:<commit>)`, `%(is-base:<commit>)`, `%xx` bytes); patterns match full ref
 * names as paths (`refs/heads` matches `refs/heads/x`) or as globs. Sort keys are given in
 * command-line order (the last one is the primary key), `refname` after them unless
 * {@link setNoSort}; `-key` reverses and `version:key` compares as versions
 * (`versionsort.suffix`). Not supported: `%(objectsize:disk)`, `%(deltabase)` and signature
 * verification (`%(signature)` of a signed commit) refuse with a {@link RefFilterError}.
 */
export class ForEachRefCommand extends RefListingCommand<ForEachRefResult> {
  private format = DEFAULT_FOR_EACH_REF_FORMAT;
  /** git starts its `--sort` list with `refname`; `--no-sort` clears it */
  private defaultSort = true;
  private sortKeys: string[] = [];
  private patterns: string[] = [];
  private exclude: string[] = [];
  private pointsAt: string[] = [];
  private contains: string[] = [];
  private noContains: string[] = [];
  private merged: string[] = [];
  private noMerged: string[] = [];
  private count = 0;
  private omitEmpty = false;
  private quoteStyle: RefQuoteStyle = "none";
  private ignoreCase = false;
  private includeRootRefs = false;
  private color = false;
  private startAfter?: string;
  private now?: number;
  private compatibility: "2.43" | "2.56" = "2.56";

  /** `--format=<format>` (default `%(objectname) %(objecttype)\t%(refname)`). */
  setFormat(format: string): this {
    this.checkCallable();
    this.format = format;
    return this;
  }

  /** `--sort=<key>` for each key, in command-line order (the last is the primary key). */
  setSort(...keys: string[]): this {
    this.checkCallable();
    this.sortKeys = keys;
    return this;
  }

  /** `--no-sort`: the keys given so far and the default `refname` dropped. */
  setNoSort(): this {
    this.checkCallable();
    this.defaultSort = false;
    this.sortKeys = [];
    return this;
  }

  /** `<pattern>...`: refs matching one (a path prefix of whole components, or a glob). */
  setPatterns(...patterns: string[]): this {
    this.checkCallable();
    this.patterns = patterns;
    return this;
  }

  /** `--exclude=<pattern>`: refs matching one are left out. */
  setExclude(...patterns: string[]): this {
    this.checkCallable();
    this.exclude = patterns;
    return this;
  }

  /** `--points-at=<object>`: refs naming one of these objects, directly or through tags. */
  setPointsAt(...objects: string[]): this {
    this.checkCallable();
    this.pointsAt = objects;
    return this;
  }

  /** `--contains[=<commit>]` (HEAD without one): refs whose commit reaches one of them. */
  setContains(...commits: string[]): this {
    this.checkCallable();
    this.contains = commits.length ? commits : ["HEAD"];
    return this;
  }

  /** `--no-contains[=<commit>]` (HEAD without one): refs whose commit reaches none. */
  setNoContains(...commits: string[]): this {
    this.checkCallable();
    this.noContains = commits.length ? commits : ["HEAD"];
    return this;
  }

  /** `--merged[=<commit>]` (HEAD without one): refs one of them reaches. */
  setMerged(...commits: string[]): this {
    this.checkCallable();
    this.merged = commits.length ? commits : ["HEAD"];
    return this;
  }

  /** `--no-merged[=<commit>]` (HEAD without one): refs none of them reaches. */
  setNoMerged(...commits: string[]): this {
    this.checkCallable();
    this.noMerged = commits.length ? commits : ["HEAD"];
    return this;
  }

  /** `--count=<n>`: at most n refs (0: all). */
  setCount(count: number): this {
    this.checkCallable();
    this.count = count;
    return this;
  }

  /** `--omit-empty`: no line for a ref whose format expands to nothing. */
  setOmitEmpty(omit: boolean): this {
    this.checkCallable();
    this.omitEmpty = omit;
    return this;
  }

  /** `--shell`, `--perl`, `--python` or `--tcl`: each atom's value quoted for that language. */
  setQuoteStyle(style: RefQuoteStyle): this {
    this.checkCallable();
    this.quoteStyle = style;
    return this;
  }

  /** `--ignore-case`: patterns and sorting without case. */
  setIgnoreCase(ignore: boolean): this {
    this.checkCallable();
    this.ignoreCase = ignore;
    return this;
  }

  /** `--include-root-refs` (git 2.45+): HEAD and the root refs (`ORIG_HEAD`, ...) too. */
  setIncludeRootRefs(include: boolean): this {
    this.checkCallable();
    this.includeRootRefs = include;
    return this;
  }

  /** `--color[=always]`: `%(color:...)` atoms give their escape sequences. */
  setColor(color: boolean): this {
    this.checkCallable();
    this.color = color;
    return this;
  }

  /** `--start-after=<marker>` (git 2.51+): only refs sorting after the marker. */
  setStartAfter(marker: string): this {
    this.checkCallable();
    this.startAfter = marker;
    return this;
  }

  /** The time relative and human dates are counted from, in seconds (git's GIT_TEST_DATE_NOW); default the clock. */
  setNow(now: number): this {
    this.checkCallable();
    this.now = now;
    return this;
  }

  /**
   * The git version whose output to follow where versions differ (default 2.56): 2.43's
   * `%(*atom)` reads the object a tag names, not what nested tags peel to, and its
   * `%(trailers)` miss a signed tag's trailers, and a formatted date sorts by time (see
   * `RefFormatOptions.compatibility`).
   */
  setCompatibility(version: "2.43" | "2.56"): this {
    this.checkCallable();
    this.compatibility = version;
    return this;
  }

  async call(): Promise<ForEachRefResult> {
    this.checkCallable();
    this.setCallable(false);
    const usage = (message: string) => new RefFilterError(message, 129);
    const { pointsAt, contains, noContains, merged, noMerged } = await this.resolveFilterArgs({
      pointsAt: this.pointsAt,
      contains: this.contains,
      noContains: this.noContains,
      merged: this.merged,
      noMerged: this.noMerged,
    });
    if (this.count < 0) throw usage(`error: invalid --count argument: \`${this.count}'`);
    const formatSource = this.formatSource();
    if (this.now !== undefined) formatSource.dateContext = { now: this.now };
    const format = new RefFormat(this.format, formatSource, {
      quoteStyle: this.quoteStyle,
      useColor: this.color,
      compatibility: this.compatibility,
    });
    const sortKeys = this.defaultSort ? ["refname", ...this.sortKeys] : this.sortKeys;
    if (this.startAfter !== undefined && sortKeys.length > 1) {
      throw new RefFilterError("fatal: cannot use --start-after with custom sort options", 128);
    }
    const sorting: RefSortKey[] = parseRefSorting(sortKeys, format).map((s) =>
      this.ignoreCase ? { ...s, icase: true } : s,
    );
    if (this.startAfter !== undefined && this.patterns.length) {
      throw new RefFilterError("fatal: cannot use --start-after with patterns", 128);
    }
    const aheadBehindBases: ObjectId[] = [];
    const isBaseTips: { name: string; commit: ObjectId }[] = [];
    const baseWarnings: string[] = [];
    const source = this.filterSource();
    for (const atom of format.atoms) {
      if (atom.type !== "ahead-behind" && atom.type !== "is-base") continue;
      const name = atom.base as string;
      const commit = await source.commitByName(name, baseWarnings);
      if (!commit) throw new RefFilterError(`fatal: failed to find '${name}'`, 128);
      if (atom.type === "ahead-behind") aheadBehindBases.push(commit);
      else isBaseTips.push({ name, commit });
    }
    const filter: RefFilterOptions = {
      kind: this.includeRootRefs
        ? RefKind.REGULAR | RefKind.ROOT_REFS | RefKind.DETACHED_HEAD
        : RefKind.REGULAR,
      patterns: this.patterns,
      matchAsPath: true,
      ignoreCase: this.ignoreCase,
      exclude: this.exclude,
      pointsAt,
      contains,
      noContains,
      merged,
      noMerged,
      ...(this.startAfter !== undefined ? { startAfter: this.startAfter } : {}),
    };
    const result = await filterAndFormatRefs(source, filter, sorting, format, {
      count: this.count,
      omitEmpty: this.omitEmpty,
      aheadBehindBases,
      isBaseTips,
    });
    return {
      output: result.output,
      lines: result.lines,
      refs: result.items.map((i: RefFilterItem) => ({ refname: i.refname, objectId: i.objectId })),
      warnings: [...baseWarnings, ...result.warnings],
    };
  }
}
