/**
 * `git range-diff` (builtin/range-diff.c and range-diff.c): two versions of a patch series
 * compared commit by commit.
 *
 * @example
 * ```typescript
 * // git range-diff main..topic main..topic-v2
 * const text = await git.rangeDiff().addArgument("main..topic").addArgument("main..topic-v2").callText();
 * // "1:  4de457d = 1:  a4b3333 s/5/A/\n2:  fccce22 ! 2:  f51d370 s/4/A/\n    @@ ..."
 * // git range-diff topic...topic-v2, and git range-diff main topic topic-v2, the same
 * ```
 *
 * The arguments are git's: `<base> <old-tip> <new-tip>`, `<old-range> <new-range>` or
 * `<old-tip>...<new-tip>` (either side defaulting to HEAD), each form recognized as git
 * recognizes it, a `--` among them saying which one is meant; what follows the ranges (paths
 * after `--`) goes to the `git log` that reads each range.
 */

import type { ObjectId } from "@statewalker/vcs-core";

import { GitApiError } from "../../errors/index.js";
import { GitCommand } from "../../git-command.js";
import { bytesToLatin1, latin1ToBytes } from "../apply/latin1.js";
import { readDiffColorSettings } from "../diff-color-config.js";
import type { LogOutputOptions } from "../log-output.js";
import { formatCommitPretty } from "../pretty-format.js";
import { RevListCommand } from "../rev-list-command.js";
import {
  findExactMatches,
  getCorrespondences,
  RANGE_DIFF_CREATION_FACTOR_DEFAULT,
  RangeDiffError,
  type RangeDiffPatch,
  readRangeDiffPatches,
  writeRangeDiff,
} from "./range-diff.js";

const USAGE = [
  "usage: git range-diff [<options>] <old-base>..<old-tip> <new-base>..<new-tip>",
  "   or: git range-diff [<options>] <old-tip>...<new-tip>",
  "   or: git range-diff [<options>] <base> <old-tip> <new-tip>",
].join("\n");

/** git's MINIMUM_ABBREV */
const MINIMUM_ABBREV = 4;

/** `--notes`, `--notes=<ref>` and `--no-notes` as given: true, the ref, false. */
export type RangeDiffNotesOption = boolean | string;

/**
 * What the `git log` reading a range is told of notes (`--show-notes-by-default` and the
 * notes options after it, revision.c's display_notes_opt).
 */
export function rangeDiffNotesOptions(
  given: readonly RangeDiffNotesOption[],
): Pick<LogOutputOptions, "notes" | "notesRefs"> {
  let show = false;
  let useDefault = -1;
  let refs: string[] = [];
  for (const value of given) {
    if (value === true) {
      show = true;
      useDefault = 1;
    } else if (value === false) {
      show = false;
      useDefault = -1;
      refs = [];
    } else {
      show = true;
      refs.push(value);
    }
  }
  // --show-notes-by-default: the default notes when no notes option was given
  if (given.length === 0) return { notes: true };
  if (!show) return { notes: false };
  if (useDefault > 0 || (useDefault === -1 && refs.length === 0))
    return { notes: true, notesRefs: refs };
  return { notesRefs: refs };
}

/** What reads the patches of a range and prints the pairs (shared with format-patch). */
export interface RangeDiffRun {
  creationFactor: number;
  /** `--notes`... passed to the log reading each range */
  notes: readonly RangeDiffNotesOption[];
  /** More arguments of that log (paths after `--`) */
  logArgs?: readonly string[];
  dualColor: boolean;
  /** The color of the output (`--color`): undefined reads the configuration */
  color?: boolean;
  leftOnly?: boolean;
  rightOnly?: boolean;
  patch?: boolean;
  stat?: boolean;
  noPatch?: boolean;
  /** `--abbrev=<n>` (undefined: the default length) */
  abbrev?: number;
}

/**
 * The base of commands printing range-diffs (`show_range_diff`): `git range-diff` and
 * format-patch's `--range-diff`.
 */
export abstract class RangeDiffBase<T> extends GitCommand<T> {
  /** `show_range_diff`: the output for two ranges, as bytes. */
  protected async showRangeDiff(
    range1: string,
    range2: string,
    run: RangeDiffRun,
  ): Promise<Uint8Array> {
    if (run.leftOnly && run.rightOnly) {
      throw new GitApiError(
        "error: options '--left-only' and '--right-only' cannot be used together",
        {
          exitCode: 255,
        },
      );
    }
    const a = await this.readPatches(range1, run);
    const b = await this.readPatches(range2, run);
    findExactMatches(a, b);
    getCorrespondences(a, b, run.creationFactor);
    const colors =
      run.color === false
        ? undefined
        : readDiffColorSettings(this.workingCopy, run.color ? { color: true } : {}).colors;
    const text = await writeRangeDiff(a, b, {
      ...(colors ? { colors } : {}),
      dualColor: run.dualColor,
      leftOnly: !!run.leftOnly,
      rightOnly: !!run.rightOnly,
      patch: !!run.patch,
      stat: !!run.stat,
      noPatch: !!run.noPatch,
      abbrev: (id) => this.shortId(id, run.abbrev),
      subject: (id) => this.subjectOf(id),
    });
    return latin1ToBytes(text);
  }

  private async readPatches(range: string, run: RangeDiffRun): Promise<RangeDiffPatch[]> {
    const log = new RevListCommand(this._workingCopy)
      .setNoMerges(true)
      .setOrder("date")
      .setReverse(true)
      .setDiffOptions({ color: false, noPrefix: true, submoduleFormat: "short" });
    log.addArgument(range);
    for (const arg of run.logArgs ?? []) log.addArgument(arg);
    let bytes: Uint8Array;
    try {
      bytes = await log.callLogBytes({
        patch: true,
        pretty: "medium",
        decorate: "no",
        abbrevCommit: false,
        ...rangeDiffNotesOptions(run.notes),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new GitApiError(`${message}\nerror: could not parse log for '${range}'`, {
        exitCode: 255,
      });
    }
    try {
      return readRangeDiffPatches(bytesToLatin1(bytes));
    } catch (error) {
      if (error instanceof RangeDiffError)
        throw new GitApiError(
          `error: ${error.message}\nerror: could not parse log for '${range}'`,
          {
            exitCode: 255,
          },
        );
      throw error;
    }
  }

  /** `find_unique_abbrev(oid, abbrev)` */
  private async shortId(id: ObjectId, abbrev: number | undefined): Promise<string> {
    if (abbrev === undefined) return this.abbreviateObjectId(id);
    if (abbrev >= id.length) return id;
    const lengths = await this.idAbbreviator().lengths([id], abbrev);
    return id.slice(0, lengths.get(id) ?? abbrev);
  }

  /** `pp_commit_easy(CMIT_FMT_ONELINE)` as a binary string. */
  private async subjectOf(id: ObjectId): Promise<string> {
    const commit = await this.commits.load(id);
    if (!commit) return "";
    const subject = await formatCommitPretty("%s", commit, id);
    return bytesToLatin1(new TextEncoder().encode(subject));
  }

  /** `is_range_diff_range`: a revision argument with both a positive and a negative side. */
  protected async isRangeDiffRange(arg: string): Promise<boolean> {
    try {
      const resolve = new RevListCommand(this._workingCopy).addRevision(arg);
      const { entries } = await resolve.resolve();
      return entries.some((e) => e.exclude) && entries.some((e) => !e.exclude);
    } catch {
      return false;
    }
  }

  /** `repo_get_oid_committish` succeeds */
  protected async isCommittish(arg: string): Promise<boolean> {
    const resolver = this.revisionResolver();
    const id = await resolver.resolve(arg).catch(() => undefined);
    if (id === undefined) return false;
    return (await resolver.commitReference(id).catch(() => undefined)) !== undefined;
  }
}

/** `git range-diff`. */
export class RangeDiffCommand extends RangeDiffBase<Uint8Array> {
  private readonly args: string[] = [];
  private creationFactor = RANGE_DIFF_CREATION_FACTOR_DEFAULT;
  /** `--no-dual-color` (1), `--dual-color` (0), neither (-1) */
  private simpleColor = -1;
  private color?: boolean;
  private leftOnly = false;
  private rightOnly = false;
  private readonly notes: RangeDiffNotesOption[] = [];
  private noPatch = false;
  private stat = false;
  private patch = false;
  private abbrev?: number;

  /**
   * A positional argument as git takes it: a range, a commit, `--`, or what follows the
   * ranges (paths after `--`).
   */
  addArgument(arg: string): this {
    this.checkCallable();
    this.args.push(arg);
    return this;
  }

  /** A path the ranges' logs are limited to (after a `--`, added when not there yet). */
  addPath(path: string): this {
    this.checkCallable();
    if (!this.args.includes("--")) this.args.push("--");
    this.args.push(path);
    return this;
  }

  /** `--creation-factor=<percent>` (default 60). */
  setCreationFactor(factor: number): this {
    this.checkCallable();
    this.creationFactor = factor;
    return this;
  }

  /** `--dual-color` (true: also forces colors) / `--no-dual-color` (false). */
  setDualColor(dual: boolean): this {
    this.checkCallable();
    this.simpleColor = dual ? 0 : 1;
    return this;
  }

  /** `--color` / `--no-color` (unset: `color.diff`/`color.ui`, `auto` is none). */
  setColor(color: boolean): this {
    this.checkCallable();
    this.color = color;
    return this;
  }

  /** `--left-only`: only what concerns the first range. */
  setLeftOnly(value: boolean): this {
    this.checkCallable();
    this.leftOnly = value;
    return this;
  }

  /** `--right-only`: only what concerns the second range. */
  setRightOnly(value: boolean): this {
    this.checkCallable();
    this.rightOnly = value;
    return this;
  }

  /** `--notes` (true), `--notes=<ref>`, `--no-notes` (false), in order. */
  addNotes(value: RangeDiffNotesOption): this {
    this.checkCallable();
    this.notes.push(value);
    return this;
  }

  /** `-s` / `--no-patch`: only the pairs. */
  setNoPatch(value: boolean): this {
    this.checkCallable();
    this.noPatch = value;
    return this;
  }

  /** `--stat`: the diffstat of each changed pair's patches. */
  setStat(value: boolean): this {
    this.checkCallable();
    this.stat = value;
    return this;
  }

  /** `-p`: the patches' diff too (with `--stat`). */
  setPatch(value: boolean): this {
    this.checkCallable();
    this.patch = value;
    return this;
  }

  /** `--abbrev[=<n>]` of the commit ids (true: the default length). */
  setAbbrev(abbrev: number | true): this {
    this.checkCallable();
    this.abbrev = abbrev === true ? undefined : Math.max(abbrev, MINIMUM_ABBREV);
    return this;
  }

  /** The output as bytes. */
  async call(): Promise<Uint8Array> {
    this.checkCallable();
    this.setCallable(false);
    const { range1, range2, logArgs } = await this.ranges();
    const color = this.simpleColor === 0 ? true : this.color;
    return this.showRangeDiff(range1, range2, {
      creationFactor: this.creationFactor,
      notes: this.notes,
      logArgs,
      dualColor: this.simpleColor < 1,
      ...(color !== undefined ? { color } : {}),
      leftOnly: this.leftOnly,
      rightOnly: this.rightOnly,
      patch: this.patch,
      stat: this.stat,
      noPatch: this.noPatch,
      ...(this.abbrev !== undefined ? { abbrev: this.abbrev } : {}),
    });
  }

  /** {@link call} as bytes. */
  callBytes(): Promise<Uint8Array> {
    return this.call();
  }

  /** {@link call} as text (UTF-8). */
  async callText(): Promise<string> {
    return new TextDecoder().decode(await this.call());
  }

  /** cmd_range_diff's reading of the arguments. */
  private async ranges(): Promise<{ range1: string; range2: string; logArgs: string[] }> {
    const argv = this.args;
    const dashDash = argv.indexOf("--");
    const usage = (message: string) =>
      new GitApiError(`fatal: ${message}\n\n${USAGE}`, { exitCode: 129 });
    const argc = argv.length;
    const arg = (k: number) => argv[k] as string;
    if (
      dashDash === 3 ||
      (dashDash < 0 &&
        argc > 2 &&
        (await this.isCommittish(arg(0))) &&
        (await this.isCommittish(arg(1))) &&
        (await this.isCommittish(arg(2))))
    ) {
      if (dashDash >= 0)
        for (const k of [0, 1, 2])
          if (!(await this.isCommittish(arg(k)))) throw usage(`not a revision: '${arg(k)}'`);
      return {
        range1: `${arg(0)}..${arg(1)}`,
        range2: `${arg(0)}..${arg(2)}`,
        logArgs: argv.slice(dashDash < 0 ? 3 : dashDash),
      };
    }
    if (
      dashDash === 2 ||
      (dashDash < 0 &&
        argc > 1 &&
        (await this.isRangeDiffRange(arg(0))) &&
        (await this.isRangeDiffRange(arg(1))))
    ) {
      if (dashDash >= 0)
        for (const k of [0, 1])
          if (!(await this.isRangeDiffRange(arg(k))))
            throw usage(`not a commit range: '${arg(k)}'`);
      return { range1: arg(0), range2: arg(1), logArgs: argv.slice(dashDash < 0 ? 2 : dashDash) };
    }
    if (dashDash === 1 || (dashDash < 0 && argc > 0 && arg(0).includes("..."))) {
      const dots = arg(0).indexOf("...");
      if (dots < 0) throw usage(`not a symmetric range: '${arg(0)}'`);
      const a = dots === 0 ? "HEAD" : arg(0).slice(0, dots);
      const b = arg(0).slice(dots + 3) || "HEAD";
      return {
        range1: `${b}..${a}`,
        range2: `${a}..${b}`,
        logArgs: argv.slice(dashDash < 0 ? 1 : dashDash),
      };
    }
    throw usage("need two commit ranges");
  }
}
