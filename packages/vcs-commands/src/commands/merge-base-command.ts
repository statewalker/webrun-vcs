/**
 * MergeBaseCommand - `git merge-base` (builtin/merge-base.c): the best common ancestors of
 * commits, and its other modes: `--octopus`, `--independent`, `--is-ancestor` and
 * `--fork-point`.
 *
 * @example
 * ```typescript
 * // git merge-base --all main topic
 * const { bases } = await git.mergeBase().setAll(true).addCommit("main").addCommit("topic").call();
 *
 * // git merge-base --is-ancestor v1.0 HEAD: exit status 0 when it is
 * const { exitCode } = await git.mergeBase().setMode("is-ancestor").addCommit("v1.0").addCommit("HEAD").call();
 *
 * // git merge-base --fork-point origin/main topic: where topic forked, from origin/main's reflog
 * const { bases: [fork] } = await git.mergeBase().setMode("fork-point").addCommit("origin/main").addCommit("topic").call();
 * ```
 */

import type { ObjectId } from "@statewalker/vcs-core";

import { GitApiError } from "../errors/index.js";
import { GitCommand } from "../git-command.js";
import { findForkPoint } from "./fork-point.js";
import { commitsBaseSource, MergeBaseGraph } from "./merge-bases.js";

/**
 * What `git merge-base` does with its commits (its `OPT_CMDMODE` options): `"bases"` (the
 * default) the merge bases of the first commit and all the others.
 */
export type MergeBaseMode = "bases" | "octopus" | "independent" | "is-ancestor" | "fork-point";

/** What `git merge-base` printed and its exit status. */
export interface MergeBaseResult {
  /** The ids printed, one per line (none for `--is-ancestor`) */
  readonly bases: ObjectId[];
  /**
   * git's exit status: 0, or 1 when nothing was found (`--is-ancestor`: 1 when the first
   * commit is not an ancestor of the second)
   */
  readonly exitCode: 0 | 1;
  /** `--is-ancestor`: whether the first commit is an ancestor of the second (or the same) */
  readonly isAncestor?: boolean;
}

const USAGE = [
  "usage: git merge-base [-a | --all] <commit> <commit>...",
  "   or: git merge-base [-a | --all] --octopus <commit>...",
  "   or: git merge-base --is-ancestor <commit> <commit>",
  "   or: git merge-base --independent <commit>...",
  "   or: git merge-base --fork-point <ref> [<commit>]",
].join("\n");

/**
 * `git merge-base`. Commits are named as git reads them (any revision); a name that names no
 * object dies with `fatal: Not a valid object name <name>`, one that names no commit with
 * `fatal: Not a valid commit name <name>` (exit 128); a wrong number of commits is git's
 * usage (exit 129).
 */
export class MergeBaseCommand extends GitCommand<MergeBaseResult> {
  private readonly names: string[] = [];
  private all = false;
  private mode: MergeBaseMode = "bases";

  /**
   * A commit argument. For `"fork-point"` the first is the ref whose reflog is read, the
   * second (default HEAD) the commit that forked.
   */
  addCommit(name: string): this {
    this.checkCallable();
    this.names.push(name);
    return this;
  }

  /** `--all`: every merge base, not only the first (default false). */
  setAll(all: boolean): this {
    this.checkCallable();
    this.all = all;
    return this;
  }

  /** The mode (`--octopus`, `--independent`, `--is-ancestor`, `--fork-point`). */
  setMode(mode: MergeBaseMode): this {
    this.checkCallable();
    this.mode = mode;
    return this;
  }

  async call(): Promise<MergeBaseResult> {
    this.checkCallable();
    this.setCallable(false);
    const names = this.names;
    const graph = new MergeBaseGraph(commitsBaseSource(this.commits, async () => new Map()));
    const ids = (nodes: { id?: ObjectId }[]) =>
      nodes.map((n) => n.id).filter((id): id is ObjectId => id !== undefined);
    const printed = (bases: ObjectId[], all: boolean): MergeBaseResult => {
      const shown = all ? bases : bases.slice(0, 1);
      return { bases: shown, exitCode: shown.length > 0 ? 0 : 1 };
    };
    const commits = async () => {
      const out: ObjectId[] = [];
      for (const name of names) out.push(await this.commitReference(name));
      return out;
    };
    switch (this.mode) {
      case "is-ancestor": {
        if (names.length < 2) throw new GitApiError(USAGE);
        if (this.all) {
          throw new GitApiError(
            "fatal: options '--is-ancestor' and '--all' cannot be used together",
          );
        }
        if (names.length !== 2) {
          throw new GitApiError("fatal: --is-ancestor takes exactly two commits");
        }
        const [one, two] = (await commits()) as [ObjectId, ObjectId];
        const isAncestor = one === two || (await this.commits.isAncestor(one, two));
        return { bases: [], exitCode: isAncestor ? 0 : 1, isAncestor };
      }
      case "independent": {
        if (this.all) {
          throw new GitApiError(
            "fatal: options '--independent' and '--all' cannot be used together",
          );
        }
        const reduced = await graph.reduceHeads((await commits()).map((id) => graph.commit(id)));
        return printed(ids(reduced), true);
      }
      case "octopus": {
        const bases = await graph.octopusMergeBases(
          (await commits()).map((id) => graph.commit(id)),
        );
        return printed(ids(bases), this.all);
      }
      case "fork-point": {
        if (names.length < 1 || names.length > 2) throw new GitApiError(USAGE);
        const commitName = names[1] ?? "HEAD";
        const id = await this.revisionResolver().resolve(commitName);
        if (id === undefined) {
          throw new GitApiError(`fatal: Not a valid object name: '${commitName}'`);
        }
        const derived = await this.revisionResolver().commitReference(id);
        if (derived === undefined) {
          throw new GitApiError(`fatal: Not a valid commit name ${commitName}`);
        }
        const fork = await findForkPoint(this.forkPointSource(graph), names[0] as string, derived);
        return printed(fork ? [fork] : [], false);
      }
      default: {
        if (names.length < 2) throw new GitApiError(USAGE);
        const [one, ...twos] = (await commits()).map((id) => graph.commit(id));
        const bases = await graph.mergeBasesMany(one as ReturnType<typeof graph.commit>, twos);
        return printed(ids(bases), this.all);
      }
    }
  }

  /** builtin/merge-base.c's get_commit_reference. */
  private async commitReference(name: string): Promise<ObjectId> {
    const resolver = this.revisionResolver();
    const id = await resolver.resolve(name);
    if (id === undefined) throw new GitApiError(`fatal: Not a valid object name ${name}`);
    const peeled = await resolver.peelTags(id);
    if (peeled.type === "commit") return peeled.id;
    const lines = peeled.type
      ? [`error: object ${peeled.id} is a ${peeled.type}, not a commit`]
      : [];
    lines.push(`fatal: Not a valid commit name ${name}`);
    throw new GitApiError(lines.join("\n"));
  }
}
