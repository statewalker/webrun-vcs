import type { ObjectId } from "@statewalker/vcs-core";
import { wildmatch } from "@statewalker/vcs-working-tree";

import { DescribeError } from "../errors/command-errors.js";
import { GitCommand } from "../git-command.js";
import { commitLoaderOf, type NameRevInput, runNameRev } from "./name-rev.js";

/** `git name-rev`'s output. */
export interface NameRevResult {
  /** git's stdout */
  stdout: string;
  /** git's stderr lines (`Could not get sha1 for <rev>. Skipping.`) */
  stderr: string[];
  /** Each revision given and its name (undefined where git prints `undefined`) */
  names: { revision: string; name: string | undefined }[];
}

/**
 * Find symbolic names for commits: git name-rev (builtin/name-rev.c). Every ref (or the
 * ones `--tags`/`--refs`/`--exclude` keep) names the commits it reaches, the nearest first:
 * `main~2`, `tags/v1.0^0`, `main^2~3`; generations of the commit-graph (else commit dates
 * less a day) stop the walk below the oldest commit asked about.
 *
 * @example
 * ```typescript
 * const { stdout } = await git.nameRev().addRevisions("HEAD~2").call();
 * // "HEAD~2 main~2\n"
 * const { stdout } = await git.nameRev().setTags(true).setNameOnly(true).addRevisions(id).call();
 * const { stdout } = await git.nameRev().setAnnotateStdin(text).call(); // ids annotated
 * ```
 */
export class NameRevCommand extends GitCommand<NameRevResult> {
  private revisions: string[] = [];
  private nameOnly = false;
  private tags = false;
  private refs: string[] = [];
  private exclude: string[] = [];
  private allowUndefined = true;
  private always = false;
  private all = false;
  private annotate?: string;
  private peelTag = false;

  /** The revisions to name (`<commit>...`). */
  addRevisions(...revisions: string[]): this {
    this.checkCallable();
    this.revisions.push(...revisions);
    return this;
  }

  /** `--name-only`: the names alone, without the revisions. */
  setNameOnly(nameOnly: boolean): this {
    this.checkCallable();
    this.nameOnly = nameOnly;
    return this;
  }

  /** `--tags`: only tags name commits. */
  setTags(tags: boolean): this {
    this.checkCallable();
    this.tags = tags;
    return this;
  }

  /** `--refs=<pattern>` (repeatable): only refs a pattern matches, whole or a subpath. */
  addRefs(...patterns: string[]): this {
    this.checkCallable();
    this.refs.push(...patterns);
    return this;
  }

  /** `--exclude=<pattern>` (repeatable): no refs a pattern matches. */
  addExclude(...patterns: string[]): this {
    this.checkCallable();
    this.exclude.push(...patterns);
    return this;
  }

  /** `--[no-]undefined`: false dies on a commit no ref names (default true). */
  setUndefined(allow: boolean): this {
    this.checkCallable();
    this.allowUndefined = allow;
    return this;
  }

  /** `--always`: an unnamed object's abbreviated id (with `--no-undefined`). */
  setAlways(always: boolean): this {
    this.checkCallable();
    this.always = always;
    return this;
  }

  /** `--all`: every commit the refs reach. */
  setAll(all: boolean): this {
    this.checkCallable();
    this.all = all;
    return this;
  }

  /** `--annotate-stdin`: `text` with each full object id followed by its name. */
  setAnnotateStdin(text: string | undefined): this {
    this.checkCallable();
    this.annotate = text;
    return this;
  }

  /** `--peel-tag` (git's internal option): a tag given is named by its commit. */
  setPeelTag(peel: boolean): this {
    this.checkCallable();
    this.peelTag = peel;
    return this;
  }

  /**
   * @throws DescribeError where git dies (`cannot describe '<id>'`, exit 128; a list with
   * `--all` or `--annotate-stdin`, exit 129)
   */
  async call(): Promise<NameRevResult> {
    this.checkCallable();
    this.setCallable(false);
    const modes =
      (this.all ? 1 : 0) + (this.annotate !== undefined ? 1 : 0) + (this.revisions.length ? 1 : 0);
    if (modes > 1) {
      throw new DescribeError(
        "error: Specify either a list, or --all, not both!\nusage: git name-rev [<options>] <commit>...",
        "",
        129,
      );
    }
    let input: NameRevInput;
    if (this.all) input = { all: true };
    else if (this.annotate !== undefined) input = { annotate: this.annotate };
    else {
      input = {
        revs: await Promise.all(
          this.revisions.map(async (name) => ({
            name,
            id: await this.resolveRevision(name).catch(() => undefined as ObjectId | undefined),
          })),
        ),
      };
    }
    const resolver = this.revisionResolver();
    const tags = this.tagsStore;
    const run = await runNameRev(
      {
        refs: this.refsStore,
        objectType: (id) => resolver.objectType(id),
        loadTag: async (id) => tags?.load(id),
        loadCommit: commitLoaderOf(this.walkCommits, () => this.shallowCommits()),
        refExists: (name) => this.refsStore.has(name).catch(() => false),
        abbreviate: (id) => this.abbreviateObjectId(id),
        wildmatch: (pattern, text) => wildmatch(pattern, text),
      },
      {
        nameOnly: this.nameOnly,
        tags: this.tags,
        refs: this.refs,
        exclude: this.exclude,
        allowUndefined: this.allowUndefined,
        always: this.always,
        peelTag: this.peelTag,
        hexLength: this.objectFormat.hexLength,
      },
      input,
    );
    if (run.fatal) {
      throw new DescribeError([...run.stderr, run.fatal].join("\n"), run.stdout, 128);
    }
    const names: NameRevResult["names"] = [];
    if (!this.all && this.annotate === undefined && !this.nameOnly) {
      for (const line of run.stdout.split("\n")) {
        if (line === "") continue;
        const space = line.lastIndexOf(" ");
        const name = line.slice(space + 1);
        names.push({
          revision: line.slice(0, space),
          name: name === "undefined" ? undefined : name,
        });
      }
    }
    return { stdout: run.stdout, stderr: run.stderr, names };
  }
}
