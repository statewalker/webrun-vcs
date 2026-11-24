/**
 * `git cherry [-v] [<upstream> [<head> [<limit>]]]` (builtin/log.c's cmd_cherry): the commits
 * of `<head>` not in `<upstream>` (merges left out, oldest first), each marked `-` when
 * upstream has a commit making the same change (the same patch-id, see `PatchIds`) and `+`
 * when it has none. A `<limit>` leaves out the commits it reaches too.
 *
 * @example
 * ```typescript
 * // git cherry -v main topic
 * await git.cherry().setUpstream("main").setHead("topic").setVerbose(true).callText();
 * // "+ 1a2b... Add B.\n- 3c4d... Add C.\n"
 * ```
 */

import type { Commit, ObjectId } from "@statewalker/vcs-core";

import { GitApiError } from "../errors/index.js";
import { GitCommand } from "../git-command.js";
import { LogCommand, RevFilter } from "./log-command.js";
import { PatchIds } from "./patch-id.js";
import { formatCommitPretty } from "./pretty-format.js";

/** One commit `git cherry` lists. */
export interface CherryEntry {
  /** `-`: upstream has a commit with the same change; `+`: it has none */
  sign: "+" | "-";
  id: ObjectId;
  /** Its subject (`-v`'s oneline) */
  subject: string;
}

/** git's MINIMUM_ABBREV */
const MINIMUM_ABBREV = 4;

/**
 * The commits of a branch not yet upstream, by change rather than by id.
 *
 * Without an upstream, the current branch's (`branch.<name>.merge` of its remote) is taken;
 * without one either, git's usage error is thrown (exit 129). A name that is no commit dies
 * as git's `fatal: unknown commit <name>` (exit 128).
 */
export class CherryCommand extends GitCommand<CherryEntry[]> {
  private upstream?: string;
  private head = "HEAD";
  private limit?: string;
  private verbose = false;
  /** `--abbrev[=<n>]`: undefined for full ids (git's 0), -1 for the default length */
  private abbrev?: number;

  /** `<upstream>`: where the changes are looked for. */
  setUpstream(upstream: string): this {
    this.checkCallable();
    this.upstream = upstream;
    return this;
  }

  /** `<head>`: the branch whose commits are listed (default HEAD). */
  setHead(head: string): this {
    this.checkCallable();
    this.head = head;
    return this;
  }

  /** `<limit>`: commits it reaches are not listed (they are still not looked for upstream). */
  setLimit(limit: string): this {
    this.checkCallable();
    this.limit = limit;
    return this;
  }

  /** `-v`: each commit's subject after its id. */
  setVerbose(verbose: boolean): this {
    this.checkCallable();
    this.verbose = verbose;
    return this;
  }

  /**
   * `--abbrev[=<n>]`: ids abbreviated to at least `n` digits (at least 4), or to the default
   * length (`core.abbrev`) without `n`; `--no-abbrev` (undefined, the default) prints them
   * whole.
   */
  setAbbrev(abbrev: number | true | undefined): this {
    this.checkCallable();
    if (abbrev === true) this.abbrev = -1;
    else if (abbrev === undefined || abbrev === 0) this.abbrev = undefined;
    else this.abbrev = Math.max(abbrev, MINIMUM_ABBREV);
    return this;
  }

  async call(): Promise<CherryEntry[]> {
    this.checkCallable();
    this.setCallable(false);
    const upstreamName = this.upstream ?? (await this.defaultUpstream());
    const head = await this.commitNamed(this.head);
    const upstream = await this.commitNamed(upstreamName);
    // nothing to say when head and upstream are the same
    if (head === upstream) return [];
    const limit = this.limit !== undefined ? await this.commitNamed(this.limit) : undefined;

    const commits = new Map<ObjectId, Commit>();
    const walk = async (include: ObjectId, exclude: ObjectId[]): Promise<ObjectId[]> => {
      const log = new LogCommand(this._workingCopy).setLogConfig(false);
      log.setRevFilter(RevFilter.NO_MERGES);
      log.add(include);
      for (const id of exclude) log.not(id);
      const ids: ObjectId[] = [];
      for await (const c of await log.call()) {
        commits.set(c.id, c);
        ids.push(c.id);
      }
      return ids;
    };
    const parentTrees = new Map<ObjectId, ObjectId | undefined>();
    const ids = new PatchIds<ObjectId>({
      trees: this.trees,
      blobs: this.blobs,
      objectFormat: this.objectFormat,
      change: async (id) => {
        const commit = commits.get(id);
        if (!commit || commit.parents.length > 1) return undefined;
        const parent = commit.parents[0];
        if (parent && !parentTrees.has(parent)) {
          parentTrees.set(parent, (await this.walkCommits.load(parent))?.tree);
        }
        const parentTree = parent ? parentTrees.get(parent) : undefined;
        return { ...(parentTree ? { parentTree } : {}), tree: commit.tree };
      },
    });
    // get_patch_ids: upstream's side (upstream ^head)
    for (const id of await walk(upstream, [head])) await ids.add(id);
    const mine = await walk(head, limit ? [upstream, limit] : [upstream]);
    const entries: CherryEntry[] = [];
    for (let k = mine.length - 1; k >= 0; k--) {
      const id = mine[k] as ObjectId;
      const commit = commits.get(id) as Commit;
      entries.push({
        sign: (await ids.has(id)) ? "-" : "+",
        id,
        subject: await formatCommitPretty("%s", { ...commit, message: commit.message }, id),
      });
    }
    return entries;
  }

  /** git cherry's output: `<sign> <id>` per commit, with `-v` its subject after. */
  async callText(): Promise<string> {
    const entries = await this.call();
    let out = "";
    for (const e of entries) {
      const id = await this.shownId(e.id);
      out += this.verbose ? `${e.sign} ${id} ${e.subject}\n` : `${e.sign} ${id}\n`;
    }
    return out;
  }

  private async shownId(id: ObjectId): Promise<string> {
    if (this.abbrev === undefined) return id;
    if (this.abbrev < 0) return this.abbreviateObjectId(id);
    const lengths = await this.idAbbreviator().lengths([id], this.abbrev);
    return id.slice(0, lengths.get(id) ?? this.abbrev);
  }

  /** add_pending_commit: the commit a name gives (tags peeled), else git's death. */
  private async commitNamed(name: string): Promise<ObjectId> {
    const resolver = this.revisionResolver();
    const id = await resolver.resolve(name).catch(() => undefined);
    const commit = id !== undefined ? await resolver.commitReference(id) : undefined;
    if (commit === undefined) throw new GitApiError(`fatal: unknown commit ${name}`);
    return commit;
  }

  /** branch_get_upstream of the current branch, else git's usage error. */
  private async defaultUpstream(): Promise<string> {
    const upstream = await this.revisionResolver()
      .upstreamOf(undefined)
      .catch(() => undefined);
    if (upstream !== undefined) return upstream;
    throw new GitApiError(
      [
        "Could not find a tracked remote branch, please specify <upstream> manually.",
        "usage: git cherry [-v] [<upstream> [<head> [<limit>]]]",
      ].join("\n"),
      { exitCode: 129 },
    );
  }
}
