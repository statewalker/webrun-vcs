import type { ObjectId } from "@statewalker/vcs-core";

import { GitApiError, StashApplyFailedError, StashNotFoundError } from "../errors/index.js";
import { GitCommand } from "../git-command.js";
import { type StashApplyResult, StashApplyStatus } from "../results/stash-result.js";
import { configBool } from "./merge-config.js";
import { StashApplyCommand } from "./stash-apply-command.js";
import { StashDropCommand } from "./stash-drop-command.js";
import { STASH_REF } from "./stash-list-command.js";
import { StatusCommand } from "./status-command.js";

/** Which git a stash command answers as, where 2.43 and 2.5x differ. */
export type StashCompatibility = "2.43" | "2.56";

/**
 * git's `struct stash_info`: a stash named on the command line, read as `get_stash_info` reads
 * it.
 */
export interface StashInfo {
  /** The revision as git spells it (`refs/stash@{0}` when none is named, `refs/stash@{n}` for `n`) */
  readonly revision: string;
  /** The stash commit (its tree is the worktree state) */
  readonly wCommit: ObjectId;
  /** Its first parent: the commit the stash was made on */
  readonly bCommit: ObjectId;
  /** Its second parent: the index state */
  readonly iCommit: ObjectId;
  /** Its third parent, when the untracked files were stashed */
  readonly uCommit?: ObjectId;
  readonly wTree: ObjectId;
  readonly bTree: ObjectId;
  readonly iTree: ObjectId;
  readonly uTree?: ObjectId;
  /** Whether the revision names an entry of `refs/stash` (git's `is_stash_ref`) */
  readonly isStashRef: boolean;
}

/** git's ref_rev_parse_rules, as dwim_ref tries them. */
const DWIM_RULES = [
  (n: string) => n,
  (n: string) => `refs/${n}`,
  (n: string) => `refs/tags/${n}`,
  (n: string) => `refs/heads/${n}`,
  (n: string) => `refs/remotes/${n}`,
  (n: string) => `refs/remotes/${n}/HEAD`,
];

/**
 * What the stash subcommands that read an entry share (`pop`, `show`, `branch`): git's
 * `parse_stash_revision` and `get_stash_info`, with their messages and exit statuses.
 */
export abstract class StashInfoCommand<T> extends GitCommand<T> {
  protected compatibility: StashCompatibility = "2.56";

  /**
   * Answer as git 2.43 or 2.5x where they differ: 2.5x exits 128 where a stash subcommand
   * fails (`cmd_stash` maps a failure to die's status, keeping 1 for a conflicted apply),
   * 2.43 exits 1; 2.5x reads `stash.index`.
   */
  setCompatibility(version: StashCompatibility): this {
    this.checkCallable();
    this.compatibility = version;
    return this;
  }

  /** The exit status of a subcommand's `error()` return (`ret < 0`) */
  protected get failureExitCode(): number {
    return this.compatibility === "2.43" ? 1 : 128;
  }

  /**
   * git's get_stash_info: the stash named by `commit` (none: `refs/stash@{0}`; a number n:
   * `refs/stash@{n}`), refused as git refuses it:
   *
   * - no stash named and none kept: `No stash entries found.`;
   * - a revision naming nothing: `error: <rev> is not a valid reference`;
   * - an entry beyond the reflog: `fatal: log for '<ref>' only has <n> entries` (dies);
   * - a commit that is no stash: `fatal: '<rev>' is not a stash-like commit` (dies).
   */
  protected async getStashInfo(commit?: string): Promise<StashInfo> {
    let revision: string;
    if (commit === undefined) {
      const top = await this.refsStore.resolve(STASH_REF).catch(() => undefined);
      if (!top?.objectId) {
        throw new StashNotFoundError(STASH_REF, "No stash entries found.").withExitCode(
          this.failureExitCode,
        );
      }
      revision = `${STASH_REF}@{0}`;
    } else if (/^\d*$/.test(commit)) {
      revision = `${STASH_REF}@{${commit}}`;
    } else {
      revision = commit;
    }

    let wCommit: ObjectId;
    try {
      wCommit = await this.resolveRevision(revision);
    } catch (error) {
      // get_oid dies on a reflog too short; anything else names nothing
      if (error instanceof GitApiError && error.message.startsWith("fatal:")) throw error;
      throw new StashNotFoundError(
        revision,
        `error: ${revision} is not a valid reference`,
      ).withExitCode(this.failureExitCode);
    }

    // assert_stash_like: <rev>^1, <rev>:, <rev>^1: and <rev>^2: must all name something
    const notStashLike = () =>
      new StashNotFoundError(revision, `fatal: '${revision}' is not a stash-like commit`);
    const peeled = await this.revisionResolver()
      .peelTags(wCommit)
      .catch(() => undefined);
    if (peeled?.type !== "commit") throw notStashLike();
    wCommit = peeled.id;
    const w = await this.commits.load(wCommit).catch(() => undefined);
    if (!w || w.parents.length < 2) throw notStashLike();
    const [bCommit, iCommit, uCommit] = w.parents as [ObjectId, ObjectId, ObjectId?];
    const b = await this.commits.load(bCommit).catch(() => undefined);
    const i = await this.commits.load(iCommit).catch(() => undefined);
    if (!b || !i) throw notStashLike();
    const u = uCommit ? await this.commits.load(uCommit).catch(() => undefined) : undefined;

    return {
      revision,
      wCommit,
      bCommit,
      iCommit,
      ...(u && uCommit ? { uCommit, uTree: u.tree } : {}),
      wTree: w.tree,
      bTree: b.tree,
      iTree: i.tree,
      isStashRef: await this.isStashRef(revision),
    };
  }

  /**
   * git's is_stash_ref: the revision's part before its first `@`, as dwim_ref expands it,
   * is `refs/stash`.
   */
  private async isStashRef(revision: string): Promise<boolean> {
    const at = revision.indexOf("@");
    const symbolic = at < 0 ? revision : revision.slice(0, at);
    if (symbolic === "") return false;
    for (const rule of DWIM_RULES) {
      const name = rule(symbolic);
      const ref = await this.refsStore.get(name).catch(() => undefined);
      if (ref) return name === STASH_REF;
    }
    return false;
  }

  /** What the subcommand printed on stdout, line by line (see {@link getOutput}) */
  protected readonly output: string[] = [];

  /**
   * What the subcommand printed on stdout as git prints it, once `call()` has returned or
   * thrown: the merge's messages, `git status`'s long format, then `Dropped <rev> (<id>)`
   * or `The stash entry is kept in case you need it again.`; empty when nothing was printed.
   */
  getOutput(): string {
    return this.output.map((line) => (line.endsWith("\n") ? line : `${line}\n`)).join("");
  }

  /**
   * git's do_apply_stash for `pop` and `branch`: the stash applied (see
   * {@link StashApplyCommand}), then, unless `quiet`, the merge's messages and `git status`
   * printed. A conflicted apply returns its result (`Index was not unstashed.` in its
   * warnings under `index`); a refusal throws, its exit status mapped as `cmd_stash` maps
   * it, after the status is printed where git prints it (a refused merge, not a refused
   * `--index` or an index with conflicts, which return before).
   */
  protected async applyStash(
    info: StashInfo,
    options: { index: boolean; quiet: boolean },
  ): Promise<StashApplyResult> {
    const apply = new StashApplyCommand(this.workingCopy)
      .setStashRef(info.wCommit)
      .setRestoreIndex(options.index);
    let result: StashApplyResult;
    try {
      result = await apply.call();
    } catch (error) {
      if (error instanceof GitApiError && error.exitCode !== 128) {
        error.withExitCode(this.failureExitCode);
      }
      const early =
        error instanceof StashApplyFailedError &&
        /conflicts in index|resolve your current index|could not write index/.test(error.message);
      if (!options.quiet && !early && error instanceof StashApplyFailedError) {
        await this.printStatus();
      }
      throw error;
    }
    // -q silences merge-ort's messages in 2.5x only (2.43 printed them whatever its verbosity)
    if (!options.quiet || this.compatibility === "2.43")
      this.output.push(...(result.messages ?? []));
    else if (result.messages?.[0] === "Already up to date.") this.output.push(result.messages[0]);
    if (result.status === StashApplyStatus.CONFLICTS && options.index) {
      result = { ...result, warnings: [...(result.warnings ?? []), "Index was not unstashed."] };
    }
    if (!options.quiet) await this.printStatus();
    return result;
  }

  /** `git status`, as do_apply_stash runs it after an apply. */
  private async printStatus(): Promise<void> {
    const { text } = await new StatusCommand(this.workingCopy).callText();
    if (text !== "") this.output.push(text);
  }

  /**
   * git's do_drop_stash: `reflog delete --rewrite --updateref <rev>`, then `Dropped <rev>
   * (<id>)` unless `quiet`; refs/stash goes with its last entry. A revision naming no
   * entry by number fails as reflog_delete does (`error: not a reflog: <rev>`).
   */
  protected async dropStash(info: StashInfo, quiet: boolean): Promise<void> {
    const index = this.reflogIndexOf(info.revision);
    if (index === undefined) {
      throw new StashNotFoundError(
        info.revision,
        `error: not a reflog: ${info.revision}\nerror: ${info.revision}: Could not drop stash entry`,
      ).withExitCode(this.failureExitCode);
    }
    await new StashDropCommand(this.workingCopy).setStashRef(index).call();
    if (!quiet) this.output.push(`Dropped ${info.revision} (${info.wCommit})`);
  }

  /** `stash.index` (2.5x): whether `pop` and `apply` default to `--index`. */
  protected configuredIndex(): boolean {
    if (this.compatibility === "2.43") return false;
    return configBool(this.workingCopy, "stash.index", false);
  }

  /**
   * The `refs/stash` reflog position `revision` names (`stash@{n}`, `refs/stash@{n}`),
   * for `reflog delete`; undefined when it names none by number.
   */
  protected reflogIndexOf(revision: string): number | undefined {
    const m = /@\{(\d+)\}$/.exec(revision);
    return m ? Number.parseInt(m[1] as string, 10) : undefined;
  }
}
