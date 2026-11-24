import { StashNotFoundError } from "../errors/index.js";
import type { StashApplyResult } from "../results/stash-result.js";
import { StashApplyStatus } from "../results/stash-result.js";
import { StashInfoCommand } from "./stash-info.js";

/** What `git stash pop` did: the apply's result, and whether the entry was dropped. */
export interface StashPopResult extends StashApplyResult {
  /** Whether the entry was dropped (false when the apply left conflicts: it is kept) */
  readonly dropped: boolean;
}

/**
 * `git stash pop [--index] [-q] [<stash>]`: the stash applied as `stash apply` applies it,
 * then dropped from `refs/stash`'s reflog.
 *
 * As git's pop_stash: the stash must be an entry of `refs/stash` (`error: '<rev>' is not a
 * stash reference`, nothing applied); an apply with conflicts keeps the entry (status
 * CONFLICTS, `dropped` false, `The stash entry is kept in case you need it again.`); a
 * refused apply throws and keeps it too. What git prints on stdout (the merge's messages,
 * `git status`, `Dropped refs/stash@{0} (<id>)`) is {@link getOutput}.
 *
 * @example
 * ```typescript
 * const result = await git.stashPop().call();
 * if (!result.dropped) console.log("conflicts in", result.conflicts);
 *
 * // git stash pop --index stash@{1}
 * await git.stashPop().setStashRef("stash@{1}").setRestoreIndex(true).call();
 * ```
 */
export class StashPopCommand extends StashInfoCommand<StashPopResult> {
  private stashRef?: string;
  private restoreIndex?: boolean;
  private quiet = false;

  /** The stash to pop: `stash@{n}`, `refs/stash@{n}` or a number n (default the newest). */
  setStashRef(stashRef: string): this {
    this.checkCallable();
    this.stashRef = stashRef;
    return this;
  }

  /** `--index` / `--no-index` (default `stash.index` in 2.5x, else off). */
  setRestoreIndex(restoreIndex: boolean): this {
    this.checkCallable();
    this.restoreIndex = restoreIndex;
    return this;
  }

  /** `-q`: neither the merge's messages, the status nor `Dropped ...` are printed. */
  setQuiet(quiet: boolean): this {
    this.checkCallable();
    this.quiet = quiet;
    return this;
  }

  async call(): Promise<StashPopResult> {
    this.checkCallable();
    this.setCallable(false);
    const info = await this.getStashInfo(this.stashRef);
    if (!info.isStashRef) {
      throw new StashNotFoundError(
        info.revision,
        `error: '${info.revision}' is not a stash reference`,
      ).withExitCode(this.failureExitCode);
    }
    const index = this.restoreIndex ?? this.configuredIndex();
    let result: StashApplyResult;
    try {
      result = await this.applyStash(info, { index, quiet: this.quiet });
    } catch (error) {
      this.output.push("The stash entry is kept in case you need it again.");
      throw error;
    }
    if (result.status === StashApplyStatus.CONFLICTS) {
      this.output.push("The stash entry is kept in case you need it again.");
      return { ...result, dropped: false };
    }
    await this.dropStash(info, this.quiet);
    return { ...result, dropped: true };
  }
}
