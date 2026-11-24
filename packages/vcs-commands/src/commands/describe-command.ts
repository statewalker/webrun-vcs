import type { ObjectId } from "@statewalker/vcs-core";
import { basicStatMatches, wildmatch } from "@statewalker/vcs-working-tree";

import { DescribeError } from "../errors/command-errors.js";
import { RefNotFoundError } from "../errors/ref-errors.js";
import { GitCommand } from "../git-command.js";
import { DESCRIBE_MAX_TAGS, DescribeDeath, Describer } from "./git-describe.js";
import { commitLoaderOf, type NameRevSource, runNameRev, withShallowParents } from "./name-rev.js";
import { canonicalObjectId } from "./object-id-input.js";
import { StatusCommand } from "./status-command.js";

/**
 * Result of describe operation.
 */
export interface DescribeResult {
  /** The description string (tag name or tag-depth-gSHA format) */
  readonly description: string | undefined;
  /** The tag that was found (if any) */
  readonly tag?: string;
  /** Distance from the tag (number of commits) */
  readonly depth?: number;
  /** Abbreviated commit hash */
  readonly abbrevHash?: string;
  /** One description per revision described, as git prints them */
  readonly descriptions: string[];
  /** What git prints on stderr (warnings, `--debug`) */
  readonly stderr: string[];
}

/** `git describe`'s output. */
export interface DescribeText {
  stdout: string;
  stderr: string[];
}

/**
 * Given a commit, show the most recent tag that is reachable from it: git describe
 * (builtin/describe.c), `--contains` through name-rev, a blob by the first commit that
 * brings it (`<description>:<path>`), `--dirty`/`--broken` marks of the worktree.
 *
 * {@link call} answers `description: undefined` where git dies for want of a tag;
 * {@link callText} gives git's stdout and stderr and throws {@link DescribeError} where git
 * dies.
 *
 * @example
 * ```typescript
 * const desc = await git.describe().call();                 // HEAD
 * const desc = await git.describe().setTags(true).call();   // lightweight tags too
 * const { stdout } = await git.describe().setRevisions("HEAD~2", "v1.0").callText();
 * const { stdout } = await git.describe().setDirty().callText(); // "v1.2-3-gabc1234-dirty"
 * const { stdout } = await git.describe().setContains(true).callText(); // "v2.0~3"
 * ```
 */
export class DescribeCommand extends GitCommand<DescribeResult> {
  private target?: ObjectId;
  private revisions: string[] = [];
  private longFormat = false;
  private useTags = false;
  private useAll = false;
  private always = false;
  private abbrev?: number;
  private matchPatterns: string[] = [];
  private excludePatterns: string[] = [];
  private maxCandidates = 10;
  private contains = false;
  private firstParent = false;
  private debug = false;
  private dirty?: string;
  private broken?: string;
  private compatibility: "2.43" | "2.56" = "2.56";
  /** What a child git (diff-index of `--broken`) printed on stderr */
  private childStderr: string[] = [];

  /**
   * Set the commit to describe.
   *
   * @param target ObjectId of commit to describe
   */
  setTarget(target: ObjectId): this {
    target = canonicalObjectId(target);
    this.checkCallable();
    this.target = target;
    return this;
  }

  /**
   * Set the commit to describe by reference.
   *
   * @param rev Reference string (branch, tag, commit ID)
   */
  async setTargetRef(rev: string): Promise<this> {
    this.checkCallable();
    const resolved = await this.refsStore.resolve(rev);
    if (!resolved?.objectId) {
      throw new RefNotFoundError(`Cannot resolve: ${rev}`);
    }
    this.target = resolved.objectId;
    return this;
  }

  /** The revisions to describe, as given to git (`<commit-ish>...`, blobs too). */
  setRevisions(...revisions: string[]): this {
    this.checkCallable();
    this.revisions = revisions;
    return this;
  }

  /**
   * Whether to always use long output format.
   *
   * When true, outputs tag-depth-gSHA even if commit matches a tag exactly.
   *
   * @param longFormat Whether to use long format (default: false)
   */
  setLong(longFormat: boolean): this {
    this.checkCallable();
    this.longFormat = longFormat;
    return this;
  }

  /**
   * Whether to use any tag (including lightweight tags).
   *
   * By default, only annotated tags are considered.
   *
   * @param tags Whether to include lightweight tags (default: false)
   */
  setTags(tags: boolean): this {
    this.checkCallable();
    this.useTags = tags;
    return this;
  }

  /**
   * Whether to use any ref in refs/ namespace.
   *
   * Enables matching branches and remote-tracking branches.
   *
   * @param all Whether to use all refs (default: false)
   */
  setAll(all: boolean): this {
    this.checkCallable();
    this.useAll = all;
    return this;
  }

  /**
   * Always output something, even if no tag is found.
   *
   * Falls back to abbreviated commit hash.
   *
   * @param always Whether to always output (default: false)
   */
  setAlways(always: boolean): this {
    this.checkCallable();
    this.always = always;
    return this;
  }

  /**
   * Set the abbreviation length for commit hash (`--abbrev=<n>`): 0 prints the tag alone,
   * other lengths are kept between 4 and 40.
   *
   * @param abbrev Abbreviation length (default: `core.abbrev`)
   */
  setAbbrev(abbrev: number): this {
    this.checkCallable();
    this.abbrev = abbrev === 0 ? 0 : Math.max(4, Math.min(40, abbrev));
    return this;
  }

  /**
   * Get the abbreviation length.
   */
  getAbbrev(): number {
    return this.abbrev ?? 7;
  }

  /**
   * Set glob patterns that tags must match.
   *
   * @param patterns Glob patterns (e.g., "v*", "release-*")
   */
  setMatch(...patterns: string[]): this {
    this.checkCallable();
    this.matchPatterns = patterns;
    return this;
  }

  /**
   * Set glob patterns to exclude tags.
   *
   * @param patterns Glob patterns to exclude
   */
  setExclude(...patterns: string[]): this {
    this.checkCallable();
    this.excludePatterns = patterns;
    return this;
  }

  /**
   * Set maximum number of tag candidates to consider (`--candidates=<n>`, at most 28).
   *
   * @param max Maximum candidates (default: 10)
   */
  setMaxCandidates(max: number): this {
    this.checkCallable();
    this.maxCandidates = max;
    return this;
  }

  /** `--candidates=<n>`: as {@link setMaxCandidates}. */
  setCandidates(max: number): this {
    return this.setMaxCandidates(max);
  }

  /** `--exact-match` (`--candidates=0`); false is `--no-exact-match` (10 candidates). */
  setExactMatch(exact: boolean): this {
    return this.setMaxCandidates(exact ? 0 : 10);
  }

  /** `--contains`: the tag that comes after the commit (name-rev). */
  setContains(contains: boolean): this {
    this.checkCallable();
    this.contains = contains;
    return this;
  }

  /** `--first-parent`: only first parents are followed. */
  setFirstParent(firstParent: boolean): this {
    this.checkCallable();
    this.firstParent = firstParent;
    return this;
  }

  /** `--debug`: the search strategy on stderr. */
  setDebug(debug: boolean): this {
    this.checkCallable();
    this.debug = debug;
    return this;
  }

  /**
   * `--dirty[=<mark>]`: HEAD described, `<mark>` (default `-dirty`) appended when the
   * worktree differs from it; `undefined` turns it off.
   */
  setDirty(mark: string | undefined = "-dirty"): this {
    this.checkCallable();
    this.dirty = mark;
    return this;
  }

  /**
   * `--broken[=<mark>]`: as `--dirty`, and `<mark>` (default `-broken`) when the worktree
   * cannot be compared (a broken submodule); `undefined` turns it off.
   */
  setBroken(mark: string | undefined = "-broken"): this {
    this.checkCallable();
    this.broken = mark;
    return this;
  }

  /** The git version whose behaviour to follow (see `DescribeOptions.compatibility`). */
  setCompatibility(version: "2.43" | "2.56"): this {
    this.checkCallable();
    this.compatibility = version;
    return this;
  }

  /**
   * Execute the describe command.
   *
   * @returns Description result with tag name, depth, and/or commit hash
   */
  async call(): Promise<DescribeResult> {
    this.checkCallable();
    this.setCallable(false);
    // describing HEAD: an unborn or missing HEAD is NoHeadError, before anything else
    if (this.revisions.length === 0 && !this.target) await this.resolveHead();
    try {
      return await this.run();
    } catch (e) {
      // only git's "nothing describes it" deaths answer undefined; the rest is thrown
      if (e instanceof DescribeError && e.undescribable) {
        return { description: undefined, descriptions: [], stderr: [e.message] };
      }
      throw e;
    }
  }

  /**
   * git describe's stdout (one line per revision) and stderr.
   *
   * @throws DescribeError where git dies (its stderr as the message, the lines printed
   * before in `stdout`)
   */
  async callText(): Promise<DescribeText> {
    this.checkCallable();
    this.setCallable(false);
    const result = await this.run();
    return {
      stdout: result.descriptions.map((d) => `${d}\n`).join(""),
      stderr: result.stderr,
    };
  }

  private abbreviate = async (id: ObjectId, length?: number): Promise<string> => {
    if (length === 0) return id;
    if (length === undefined) return this.abbreviateObjectId(id);
    const lengths = await this.idAbbreviator().lengths([id], length);
    return id.slice(0, lengths.get(id) ?? length);
  };

  private nameRevSource(): NameRevSource {
    const resolver = this.revisionResolver();
    const tags = this.tagsStore;
    return {
      refs: this.refsStore,
      objectType: (id) => resolver.objectType(id),
      loadTag: async (id) => tags?.load(id),
      loadCommit: commitLoaderOf(this.walkCommits, () => this.shallowCommits()),
      refExists: (name) => this.refsStore.has(name).catch(() => false),
      abbreviate: (id) => this.abbreviateObjectId(id),
      wildmatch: (pattern, text) => wildmatch(pattern, text),
    };
  }

  private async run(): Promise<DescribeResult> {
    const fail = (message: string, stdout = "", stderr: string[] = []) =>
      new DescribeError([...stderr, `fatal: ${message}`].join("\n"), stdout, 128, {
        undescribable: UNDESCRIBABLE.some((prefix) => message.startsWith(prefix)),
      });
    const revs = [...this.revisions];
    if (this.target) revs.push(this.target);
    const candidates = Math.min(Math.max(this.maxCandidates, 0), DESCRIBE_MAX_TAGS);
    if (this.longFormat && this.abbrev === 0) {
      throw fail("options '--long' and '--abbrev=0' cannot be used together");
    }
    if (this.contains) return this.runContains(revs);

    const describer = new Describer(
      {
        refs: this.refsStore,
        ...(this.tagsStore ? { tags: this.tagsStore } : {}),
        commits: withShallowParents(this.commits, () => this.shallowCommits()),
        trees: this.trees,
        abbreviate: this.abbreviate,
        wildmatch: (pattern, text) => wildmatch(pattern, text),
      },
      {
        tags: this.useTags,
        all: this.useAll,
        always: this.always,
        long: this.longFormat,
        firstParent: this.firstParent,
        candidates,
        debug: this.debug,
        match: this.matchPatterns,
        exclude: this.excludePatterns,
        compatibility: this.compatibility,
        ...(this.abbrev !== undefined ? { abbrev: this.abbrev } : {}),
      },
    );
    await describer.load();
    if (describer.nameCount === 0 && !this.always) {
      throw fail("No names found, cannot describe anything.");
    }
    let suffix: string | undefined;
    if (revs.length === 0) {
      suffix = await this.worktreeSuffix();
      revs.push("HEAD");
    } else if (this.dirty !== undefined) {
      throw fail("option '--dirty' and commit-ishes cannot be used together");
    } else if (this.broken !== undefined) {
      throw fail("option '--broken' and commit-ishes cannot be used together");
    }

    const resolver = this.revisionResolver();
    const descriptions: string[] = [];
    let first: { tag?: string; depth?: number; target?: ObjectId } | undefined;
    for (const rev of revs) {
      if (this.debug) describer.stderr.push(`describe ${rev}`);
      const died = (message: string) =>
        fail(message, descriptions.map((d) => `${d}\n`).join(""), describer.stderr);
      let id: ObjectId;
      try {
        id = await this.resolveRevision(rev);
      } catch (e) {
        if (e instanceof RefNotFoundError) throw died(`Not a valid object name ${rev}`);
        throw e;
      }
      const peeled = await resolver.peelTags(id);
      let text: string;
      try {
        if (peeled.type === "commit") {
          text = await describer.describeCommit(peeled.id, id);
          first ??= { ...describer.lastMatch, target: peeled.id };
        } else if ((await resolver.objectType(id)) === "blob") {
          const head = await this.resolveRevision("HEAD").catch(() => undefined);
          const headCommit = head ? (await resolver.peelTags(head)).id : undefined;
          text = await describer.describeBlob(id, headCommit);
        } else {
          throw new DescribeDeath(`${rev} is neither a commit nor blob`);
        }
      } catch (e) {
        if (e instanceof DescribeDeath) throw died(e.message);
        throw e;
      }
      descriptions.push(text + (suffix ?? ""));
    }
    const result: DescribeResult = {
      description: descriptions[0],
      descriptions,
      stderr: [...this.childStderr, ...describer.stderr],
      ...(first?.tag !== undefined ? { tag: first.tag } : {}),
      ...(first?.depth !== undefined ? { depth: first.depth } : {}),
      ...(first?.target !== undefined
        ? { abbrevHash: await this.abbreviate(first.target, this.abbrev || undefined) }
        : {}),
    };
    return result;
  }

  /** `--dirty`/`--broken`: the mark the worktree's state against HEAD gives. */
  private async worktreeSuffix(): Promise<string | undefined> {
    if (this.dirty === undefined && this.broken === undefined) return undefined;
    const status = new StatusCommand(this._workingCopy)
      .setUntrackedFiles("no")
      .setRenames(false)
      .setPlumbingSubmodules(true);
    if (this.broken !== undefined) {
      // 2.43 runs diff-index without refreshing the index first: a file whose stat
      // changed counts as dirty
      const legacy = this.compatibility === "2.43";
      if (legacy) status.setWriteIndex(false);
      let dirty: boolean;
      try {
        dirty = isDirty(await status.call()) || (legacy && (await this.statChanged()));
      } catch (e) {
        // diff-index dies (its stderr passes through): the worktree is broken
        const message = e instanceof Error ? e.message : String(e);
        this.childStderr.push(message.startsWith("fatal: ") ? message : `fatal: ${message}`);
        return this.broken;
      }
      return dirty ? (this.dirty ?? "-dirty") : undefined;
    }
    try {
      return isDirty(await status.call()) ? this.dirty : undefined;
    } catch (e) {
      if (e instanceof DescribeError) throw e;
      // git dies comparing the worktree (a submodule whose gitfile names no repository)
      const message = e instanceof Error ? e.message : String(e);
      throw new DescribeError(
        message.startsWith("fatal: ") ? message : `fatal: ${message}`,
        "",
        128,
      );
    }
  }

  /** Whether a stage-0 entry's file no longer matches its stat (`ce_match_stat_basic`). */
  private async statChanged(): Promise<boolean> {
    const worktree = this.worktreeAccess;
    if (!worktree) return false;
    for await (const entry of this.staging.entries()) {
      if (entry.stage !== 0 || entry.mode === 0o160000) continue;
      const current = await worktree.getEntry(entry.path).catch(() => undefined);
      if (!current || !basicStatMatches(entry, current)) return true;
    }
    return false;
  }

  /** `describe --contains`: `name-rev --peel-tag --name-only --no-undefined [--tags]`. */
  private async runContains(revs: string[]): Promise<DescribeResult> {
    // 2.43 passes the patterns only without --all
    const legacyAll = this.useAll && this.compatibility === "2.43";
    const refs = legacyAll ? [] : this.matchPatterns.map((p) => `refs/tags/${p}`);
    const exclude = legacyAll ? [] : this.excludePatterns.map((p) => `refs/tags/${p}`);
    if (this.useAll && !legacyAll) {
      for (const kind of ["refs/heads/", "refs/remotes/"]) {
        refs.push(...this.matchPatterns.map((p) => kind + p));
        exclude.push(...this.excludePatterns.map((p) => kind + p));
      }
    }
    if (revs.length === 0) revs.push("HEAD");
    const input = await Promise.all(
      revs.map(async (name) => ({
        name,
        id: await this.resolveRevision(name).catch(() => undefined),
      })),
    );
    const run = await runNameRev(
      this.nameRevSource(),
      {
        peelTag: true,
        nameOnly: true,
        allowUndefined: false,
        always: this.always,
        tags: !this.useAll,
        refs,
        exclude,
        hexLength: this.objectFormat.hexLength,
      },
      { revs: input },
    );
    if (run.fatal) {
      throw new DescribeError([...run.stderr, run.fatal].join("\n"), run.stdout, 128, {
        undescribable: true,
      });
    }
    const descriptions = run.stdout === "" ? [] : run.stdout.replace(/\n$/, "").split("\n");
    return { description: descriptions[0], descriptions, stderr: run.stderr };
  }
}

/** The deaths of git describe that say nothing describes the commit. */
const UNDESCRIBABLE = [
  "No names found, cannot describe anything.",
  "No tags can describe ",
  "No annotated tags can describe ",
  "no tag exactly matches ",
];

/** diff-index HEAD's answer: a tracked path differs between HEAD and the worktree. */
function isDirty(status: {
  files: {
    index: string;
    worktree: string;
    submoduleCommitChanged?: boolean;
    submoduleModified?: boolean;
    submoduleUntracked?: boolean;
  }[];
}): boolean {
  const changed = (c: string) => c !== " " && c !== "?" && c !== "!";
  return status.files.some(
    (f) =>
      changed(f.index) ||
      changed(f.worktree) ||
      !!f.submoduleCommitChanged ||
      !!f.submoduleModified ||
      !!f.submoduleUntracked,
  );
}
