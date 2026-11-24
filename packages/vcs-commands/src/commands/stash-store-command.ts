import type { ObjectId } from "@statewalker/vcs-core";

import { InvalidArgumentError, StashNotFoundError } from "../errors/index.js";
import { StashInfoCommand } from "./stash-info.js";
import { STASH_REF } from "./stash-list-command.js";

/**
 * `git stash store [-m <message>] [-q] <commit>`: a stash commit (one `stash create`
 * made) recorded as `stash@{0}`, `refs/stash` updated with a reflog line holding the
 * message (default `Created via "git stash store".`).
 *
 * As git's store_stash: the commit must be stash-like (`fatal: '<id>' is not a stash-like
 * commit`); a revision naming nothing is `Cannot update refs/stash with <rev>`.
 *
 * @example
 * ```typescript
 * const id = await git.stashCreate().setRef(null).call();
 * if (id) await git.stashStore().setCommit(id).setMessage("saved").call();
 * ```
 */
export class StashStoreCommand extends StashInfoCommand<ObjectId> {
  private commit?: string;
  private message?: string;
  private quiet = false;

  /** The stash commit to store (any revision naming it). */
  setCommit(commit: string): this {
    this.checkCallable();
    this.commit = commit;
    return this;
  }

  /** `-m <message>`: the reflog message (default `Created via "git stash store".`). */
  setMessage(message: string): this {
    this.checkCallable();
    this.message = message;
    return this;
  }

  /** `-q`: a failure says nothing but git's `error:` lines. */
  setQuiet(quiet: boolean): this {
    this.checkCallable();
    this.quiet = quiet;
    return this;
  }

  async call(): Promise<ObjectId> {
    this.checkCallable();
    this.setCallable(false);
    const commit = this.commit;
    if (commit === undefined) {
      throw new InvalidArgumentError(
        "commit",
        commit,
        this.quiet ? "" : '"git stash store" requires one <commit> argument',
      ).withExitCode(this.failureExitCode);
    }
    let id: ObjectId;
    try {
      id = await this.resolveRevision(commit);
    } catch {
      throw new StashNotFoundError(
        commit,
        this.quiet ? "" : `Cannot update ${STASH_REF} with ${commit}`,
      ).withExitCode(this.failureExitCode);
    }
    // do_store_stash: assert_stash_like of the id itself
    await this.getStashInfo(id);
    const result = await this.refsStore.batch([{ name: STASH_REF, new: id }], {
      ...this.reflogLine(this.message ?? 'Created via "git stash store".'),
      createReflog: true,
    });
    if (!result.ok) {
      const why = result.rejected.map((r) => `${r.name}: ${r.reason}`).join(", ");
      throw new StashNotFoundError(
        STASH_REF,
        `error: ${why}${this.quiet ? "" : `\nCannot update ${STASH_REF} with ${id}`}`,
      ).withExitCode(this.failureExitCode);
    }
    return id;
  }
}
