import { GitApiError, InvalidArgumentError } from "../errors/index.js";
import type { StashApplyResult } from "../results/stash-result.js";
import { StashApplyStatus } from "../results/stash-result.js";
import { CheckoutCommand, CheckoutStatus } from "./checkout-command.js";
import { StashInfoCommand } from "./stash-info.js";

/** What `git stash branch` did. */
export interface StashBranchResult extends StashApplyResult {
  /** The branch created (`refs/heads/<name>`) */
  readonly branch: string;
  /** Whether the entry was dropped (only an entry of `refs/stash` applied without conflicts) */
  readonly dropped: boolean;
}

/**
 * `git stash branch <name> [<stash>]`: a new branch at the commit the stash was made on
 * (`git checkout -b <name> <stash>^1`), the stash applied there with `--index`, and the
 * entry dropped when it applied cleanly and is one of `refs/stash`'s.
 *
 * As git's branch_stash: a stash that is not stash-like is refused before the checkout; the
 * checkout's refusal (a branch of that name, local changes in the way) throws, nothing
 * applied; conflicts keep the entry (status CONFLICTS, `dropped` false). git's stdout
 * (the status, `Dropped ...`) is {@link getOutput}.
 *
 * @example
 * ```typescript
 * await git.stashBranch().setBranchName("wip").call();
 * ```
 */
export class StashBranchCommand extends StashInfoCommand<StashBranchResult> {
  private branchName?: string;
  private stashRef?: string;

  /** The branch to create. */
  setBranchName(name: string): this {
    this.checkCallable();
    this.branchName = name;
    return this;
  }

  /** The stash: `stash@{n}`, a number n, or any stash-like commit (default the newest). */
  setStashRef(stashRef: string): this {
    this.checkCallable();
    this.stashRef = stashRef;
    return this;
  }

  async call(): Promise<StashBranchResult> {
    this.checkCallable();
    this.setCallable(false);
    const name = this.branchName;
    if (!name) {
      throw new InvalidArgumentError("branch", name, "No branch name specified").withExitCode(
        this.failureExitCode,
      );
    }
    const info = await this.getStashInfo(this.stashRef);

    // the `git checkout -b <name> <b_commit>` child: its refusal is its exit status
    // (2.43's cmd_stash exits 1 for any failure, 2.5x passes the child's status on)
    let checkout: Awaited<ReturnType<CheckoutCommand["call"]>>;
    try {
      checkout = await new CheckoutCommand(this.workingCopy)
        .setCreateBranch(true)
        .setName(name)
        .setStartPoint(info.bCommit)
        .call();
    } catch (error) {
      if (error instanceof GitApiError && this.compatibility === "2.43") error.withExitCode(1);
      throw error;
    }
    if (checkout.status !== CheckoutStatus.OK) {
      throw new GitApiError(checkout.message ?? `error: could not check out '${name}'`, {
        exitCode: 1,
      });
    }

    const result = await this.applyStash(info, { index: true, quiet: false });
    const branch = `refs/heads/${name}`;
    // only a clean apply drops the entry
    if (result.status !== StashApplyStatus.OK) {
      return { ...result, branch, dropped: false };
    }
    if (!info.isStashRef) return { ...result, branch, dropped: false };
    await this.dropStash(info, false);
    return { ...result, branch, dropped: true };
  }
}
