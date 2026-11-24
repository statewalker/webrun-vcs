import type { FilesApi, GitObjects, ReflogEntry } from "@statewalker/vcs-core";
import { isValidRefName } from "@statewalker/vcs-core";
import {
  dropReflogs,
  type ExpireReflogsOptions,
  expireReflogs,
  parseExpiryDate,
  type ReflogEntrySelector,
  ReflogExpiryConfigError,
  writeReflogEntry,
} from "@statewalker/vcs-store-files";
import { approxidateCareful } from "@statewalker/vcs-utils";
import { GitApiError } from "../errors/index.js";
import { GitCommand } from "../git-command.js";
import { hostEnvironmentOf } from "./git-ident.js";
import type { LogOutputOptions } from "./log-output.js";
import { RevListCommand } from "./rev-list-command.js";

/**
 * Read reflog entries for a ref.
 *
 * Equivalent to `git reflog`.
 *
 * The reflog records when the tip of branches and other references
 * were updated in the local repository.
 *
 * Based on JGit's ReflogCommand.
 *
 * @example
 * ```typescript
 * // Get HEAD reflog entries
 * const entries = await git.reflog().call();
 *
 * // Get reflog for specific branch
 * const branchEntries = await git.reflog()
 *   .setRef("refs/heads/main")
 *   .call();
 *
 * // Iterate through entries
 * for (const entry of entries) {
 *   console.log(`${entry.newId.slice(0, 7)} ${entry.comment}`);
 * }
 *
 * // git reflog show -2 main: "1a2b3c4 main@{0}: commit: Second\n..."
 * const text = await git.reflog().setRef("main").setMaxCount(2).callText();
 *
 * // git reflog exists refs/heads/main
 * const exists = await git.reflog().setRef("refs/heads/main").callExists();
 *
 * // git reflog expire --expire=now --all; git reflog delete --rewrite main@{1}
 * await git.reflog().setExpire("now").setAll(true).callExpire();
 * await git.reflog().setRewrite(true).callDelete("main@{1}");
 * ```
 */
export class ReflogCommand extends GitCommand<ReflogEntry[]> {
  private ref = "HEAD";
  private maxCount?: number;
  private warnings: string[] = [];
  private compatibility?: "2.43" | "2.56";
  private expire?: string | number;
  private expireUnreachable?: string | number;
  private all = false;
  private singleWorktree = false;
  private staleFix = false;
  private rewrite = false;
  private updateRef = false;
  private dryRun = false;
  private verbose = false;

  /**
   * The git version to follow: 2.43 has no `reflog write` and `reflog drop` (git reads them
   * as a revision and dies). Default: the hooks' compatibility.
   */
  setCompatibility(version: "2.43" | "2.56"): this {
    this.checkCallable();
    this.compatibility = version;
    return this;
  }

  /**
   * `--expire=<time>` of `expire`: entries older go (a git expiry date: `now`/`all`,
   * `never`/`false`, `90.days.ago`, an epoch; a number is seconds since the epoch).
   */
  setExpire(time: string | number): this {
    this.checkCallable();
    this.expire = time;
    return this;
  }

  /** `--expire-unreachable=<time>` of `expire`: older entries the ref's tip does not reach go. */
  setExpireUnreachable(time: string | number): this {
    this.checkCallable();
    this.expireUnreachable = time;
    return this;
  }

  /** `--all` of `expire` and `drop`: every reflog of every worktree. */
  setAll(all: boolean): this {
    this.checkCallable();
    this.all = all;
    return this;
  }

  /** `--single-worktree` (with `--all`): the current worktree's reflogs and the shared ones. */
  setSingleWorktree(single: boolean): this {
    this.checkCallable();
    this.singleWorktree = single;
    return this;
  }

  /** `--stale-fix` of `expire`: entries naming commits with missing history or trees go. */
  setStaleFix(staleFix: boolean): this {
    this.checkCallable();
    this.staleFix = staleFix;
    return this;
  }

  /** `--rewrite`: each kept entry's old id becomes the new id of the kept entry before it. */
  setRewrite(rewrite: boolean): this {
    this.checkCallable();
    this.rewrite = rewrite;
    return this;
  }

  /** `--updateref`: the ref (not a symbolic one) set to the newest kept entry's new id. */
  setUpdateRef(updateRef: boolean): this {
    this.checkCallable();
    this.updateRef = updateRef;
    return this;
  }

  /** `-n`/`--dry-run`: nothing written. */
  setDryRun(dryRun: boolean): this {
    this.checkCallable();
    this.dryRun = dryRun;
    return this;
  }

  /** `--verbose`: `keep`/`prune`/`would prune <message>` per entry in the output. */
  setVerbose(verbose: boolean): this {
    this.checkCallable();
    this.verbose = verbose;
    return this;
  }

  /**
   * Set the ref to show reflog for.
   *
   * @param ref Ref name (default: "HEAD")
   */
  setRef(ref: string): this {
    this.checkCallable();
    this.ref = ref;
    return this;
  }

  /** `-<n>` / `-n <n>` of `git reflog show`: at most `n` entries. */
  setMaxCount(maxCount: number): this {
    this.checkCallable();
    this.maxCount = maxCount;
    return this;
  }

  /**
   * `git reflog [show] [<ref>]`'s output: `git log -g --abbrev-commit --pretty=oneline` of
   * the ref (`%h <ref>@{n}: <message>` per entry; the ref may carry a selector, `main@{2}`,
   * `HEAD@{now}`). `options` are log options over those defaults (`{ pretty: "short" }`
   * still abbreviates, `{ abbrevCommit: false }` is `--no-abbrev-commit`). Throws where git
   * dies (a ref that names nothing: `ambiguous argument`); {@link getWarnings} holds what it
   * warned.
   */
  async callText(options: LogOutputOptions = {}): Promise<string> {
    this.checkCallable();
    this.setCallable(false);
    const command = new RevListCommand(this._workingCopy)
      .setWalkReflogs(true)
      .addRevision(this.ref);
    if (this.maxCount !== undefined) command.setMaxCount(this.maxCount);
    try {
      const pretty = options.oneline ? {} : { pretty: "oneline" };
      return await command.callLogText({ ...pretty, abbrevCommit: true, ...options });
    } finally {
      this.warnings = command.getWarnings();
    }
  }

  /** What {@link callText} warned while reading the ref (`warning: log for ...`). */
  getWarnings(): string[] {
    return [...this.warnings];
  }

  /**
   * `git reflog exists <ref>`: whether the ref (a full name, `refs/heads/main`, or `HEAD`)
   * has a reflog, an empty one too.
   */
  async callExists(): Promise<boolean> {
    this.checkCallable();
    this.setCallable(false);
    if (!isValidRefName(this.ref, { allowOneLevel: true })) {
      throw new GitApiError(`fatal: invalid ref format: ${this.ref}`);
    }
    const reader = await this.refsStore.getReflog?.(this.ref).catch(() => undefined);
    return reader !== undefined;
  }

  /**
   * `git reflog expire [<refs>...]` (builtin/reflog.c, reflog.c, files_reflog_expire /
   * reftable_be_reflog_expire): the entries of each reflog named (`main`, `HEAD`, by git's
   * ref rules), or of every reflog with {@link setAll}, older than `--expire` (default
   * `gc.reflogExpire`, `gc.<pattern>.reflogExpire`, 90 days; `refs/stash` never), or older
   * than `--expire-unreachable` (`gc.reflogExpireUnreachable`, 30 days) and not reached from
   * the ref's tip (a HEAD's: from any ref), go. Returns git's stdout (`--verbose`), its error
   * lines and its exit status (255 when a reflog could not be found or locked); throws where
   * git dies (an invalid time, a bad `gc.reflogExpire*` value).
   */
  async callExpire(...refs: string[]): Promise<ReflogUpdateResult> {
    this.checkCallable();
    this.setCallable(false);
    const repository = await this.reflogRepository();
    const now = this.clock();
    const flag = (value: string | number | undefined, name: string) => {
      if (value === undefined || typeof value === "number") return value;
      try {
        return parseExpiryDate(value, now, `--${name}`);
      } catch (error) {
        if (!(error instanceof ReflogExpiryConfigError)) throw error;
        throw new GitApiError(`fatal: invalid timestamp '${value}' given to '--${name}'`);
      }
    };
    const expire = flag(this.expire, "expire");
    const expireUnreachable = flag(this.expireUnreachable, "expire-unreachable");
    const base = {
      ...repository.options,
      now,
      ...(expire !== undefined ? { expire } : {}),
      ...(expireUnreachable !== undefined ? { expireUnreachable } : {}),
      staleFix: this.staleFix,
      rewrite: this.rewrite,
      updateRef: this.updateRef,
      dryRun: this.dryRun,
      verbose: this.verbose,
      singleWorktree: this.singleWorktree,
      compatibility: this.compatibility ?? this.hooks.compatibility,
    };
    const result: ReflogUpdateResult = { status: 0, output: "", errors: [] };
    const run = async (options: ExpireReflogsOptions) => {
      try {
        const r = await expireReflogs(options);
        result.output += r.output;
        result.errors.push(...(r.warnings ?? []));
        if (r.errors.length > 0) {
          result.errors.push(...r.errors);
          result.status = 255;
        }
      } catch (error) {
        if (error instanceof ReflogExpiryConfigError) {
          throw new GitApiError(`fatal: ${error.message}`);
        }
        throw error;
      }
    };
    // --stale-fix marks once, then every reflog (--all) and those named are expired
    const names: string[] = [];
    for (const ref of refs) {
      const found = await this.dwimLog(ref, repository.worktree);
      if (!found) {
        result.errors.push(
          base.compatibility === "2.43"
            ? `error: ${ref} points nowhere!`
            : `error: reflog could not be found: '${ref}'`,
        );
        result.status = 255;
        continue;
      }
      names.push(found);
    }
    if (this.all || names.length > 0) await run({ ...base, names, all: this.all });
    return result;
  }

  /**
   * `git reflog delete <ref>@{<n>|<date>}...` (reflog_delete): the entry each selector
   * names is removed (`@{<date>}`: the newest entry older than the date), honouring
   * {@link setRewrite}, {@link setUpdateRef}, {@link setDryRun} and {@link setVerbose}. A
   * selector past the end deletes nothing.
   */
  async callDelete(...revisions: string[]): Promise<ReflogUpdateResult> {
    this.checkCallable();
    this.setCallable(false);
    const result: ReflogUpdateResult = { status: 0, output: "", errors: [] };
    if (revisions.length === 0) {
      return { status: 255, output: "", errors: ["error: no reflog specified to delete"] };
    }
    const repository = await this.reflogRepository();
    for (const rev of revisions) {
      const at = rev.indexOf("@{");
      if (at < 0) {
        result.errors.push(`error: not a reflog: ${rev}`);
        result.status = 255;
        continue;
      }
      const found = await this.dwimLog(rev.slice(0, at), repository.worktree);
      if (!found) {
        result.errors.push(`error: no reflog for '${rev}'`);
        result.status = 255;
        continue;
      }
      const spec = rev.slice(at + 2);
      const digits = /^\d+/.exec(spec)?.[0];
      let select: ReflogEntrySelector;
      if (digits !== undefined && spec[digits.length] === "}") select = { index: Number(digits) };
      else {
        const text = spec.endsWith("}") ? spec.slice(0, -1) : spec;
        select = { before: approxidateCareful(text, this.clock()).timestamp };
      }
      const r = await expireReflogs({
        ...repository.options,
        now: this.clock(),
        names: [found],
        select,
        rewrite: this.rewrite,
        updateRef: this.updateRef,
        dryRun: this.dryRun,
        verbose: this.verbose,
      });
      result.output += r.output;
      if (r.errors.length > 0) {
        result.errors.push(...r.errors);
        result.status = 255;
      }
    }
    return result;
  }

  /**
   * `git reflog drop [--all [--single-worktree] | <refs>...]` (git 2.5x): each reflog named,
   * or every one, removed whole. Refused under 2.43 compatibility as git 2.43 refuses it.
   */
  async callDrop(...refs: string[]): Promise<ReflogUpdateResult> {
    this.checkCallable();
    this.setCallable(false);
    this.refuseBefore251("drop");
    if (refs.length > 0 && this.all) {
      throw new GitApiError("usage: references specified along with --all", { exitCode: 129 });
    }
    const repository = await this.reflogRepository();
    const { files, gitDir, refs: store } = repository.options;
    const result: ReflogUpdateResult = { status: 0, output: "", errors: [] };
    if (this.all) {
      await dropReflogs({
        files,
        gitDir,
        refs: store,
        singleWorktree: this.singleWorktree,
        ...(repository.worktree !== undefined ? { worktree: repository.worktree } : {}),
      });
      return result;
    }
    for (const ref of refs) {
      const found = await this.dwimLog(ref, repository.worktree);
      if (!found) {
        result.errors.push(`error: reflog could not be found: '${ref}'`);
        result.status = 255;
        continue;
      }
      await dropReflogs({ files, gitDir, refs: store, names: [found] });
    }
    return result;
  }

  /**
   * `git reflog write <ref> <old-oid> <new-oid> <message>` (git 2.5x): one line appended to
   * the reflog of `ref` (a full name or a root ref; created when absent) with the committer
   * ident, the ref left alone. Throws where git dies (an invalid name, an id that is not a
   * full one or names a missing object); refused under 2.43 compatibility.
   */
  async callWrite(
    ref: string,
    oldId: string,
    newId: string,
    message: string,
  ): Promise<ReflogUpdateResult> {
    this.checkCallable();
    this.setCallable(false);
    this.refuseBefore251("write");
    if (!isRootRef(ref) && !isValidRefName(ref)) {
      throw new GitApiError(`fatal: invalid reference name: ${ref}`);
    }
    const format = this.objectFormat;
    const objects = this.historyObjects();
    const check = async (id: string, which: "old" | "new") => {
      const m = new RegExp(`^[0-9a-fA-F]{${format.hexLength}}`).exec(id);
      if (!m) throw new GitApiError(`fatal: invalid ${which} object ID: '${id}'`);
      const full = m[0].toLowerCase();
      if (!/^0+$/.test(full) && !(await objects.has(full))) {
        throw new GitApiError(`fatal: ${which} object '${id}' does not exist`);
      }
      return full;
    };
    const oldFull = await check(oldId, "old");
    const newFull = await check(newId, "new");
    const repository = await this.reflogRepository();
    const ident = this.reflogLine(message).ident as string;
    const worktree = repository.worktree;
    const name =
      worktree !== undefined && isPerWorktree(ref) ? `worktrees/${worktree}/${ref}` : ref;
    await writeReflogEntry({
      files: repository.options.files,
      gitDir: repository.options.gitDir,
      refs: repository.options.refs,
      name,
      line: { oldId: oldFull, newId: newFull, ident, message },
    });
    return { status: 0, output: "", errors: [] };
  }

  /** git 2.43's cmd_reflog reads `write`/`drop` as a revision of `git reflog show`. */
  private refuseBefore251(subcommand: string): void {
    if ((this.compatibility ?? this.hooks.compatibility) !== "2.43") return;
    throw new GitApiError(
      `fatal: ambiguous argument '${subcommand}': unknown revision or path not in the working tree.\n` +
        "Use '--' to separate paths from revisions, like this:\n" +
        "'git <command> [<revision>...] -- [<file>...]'",
    );
  }

  /** The objects of the repository (for the existence checks of `write`). */
  private historyObjects(): GitObjects {
    return (this.workingCopy.history as unknown as { objects: GitObjects }).objects;
  }

  /**
   * What the reflog engine works on: the common git directory and its FilesApi, the refs,
   * the objects, and the linked worktree this command runs in (its id).
   */
  private async reflogRepository(): Promise<{
    options: ExpireReflogsOptions & { gitDir: string; files: FilesApi };
    worktree: string | undefined;
  }> {
    const common = await this.hooks.commonGitFile("objects");
    const own = await this.hooks.gitFile("objects");
    if (!common || !own) throw new GitApiError("fatal: not a files repository");
    const gitDir = common.path.replace(/\/?objects$/, "");
    const ownDir = own.path.replace(/\/?objects$/, "");
    const m = /\/worktrees\/([^/]+)$/.exec(ownDir);
    const worktree = ownDir !== gitDir && m ? m[1] : undefined;
    const environment = hostEnvironmentOf(this.workingCopy);
    return {
      options: {
        files: common.files,
        gitDir,
        refs: this.refsStore,
        objects: this.historyObjects(),
        ...(environment ? { environment } : {}),
        ...(worktree !== undefined ? { worktree } : {}),
      },
      worktree,
    };
  }

  /**
   * repo_dwim_log: the reflog `name` names by the ref rules, as the engine names it (a
   * linked worktree's own refs as `worktrees/<id>/<ref>`); undefined when there is none.
   */
  private async dwimLog(name: string, worktree: string | undefined): Promise<string | undefined> {
    const found = (
      await this.revisionResolver()
        .dwimLogRefs(name)
        .catch(() => [])
    )[0];
    if (found === undefined) return undefined;
    return worktree !== undefined && isPerWorktree(found)
      ? `worktrees/${worktree}/${found}`
      : found;
  }

  /**
   * Execute the reflog command.
   *
   * @returns Array of reflog entries in reverse chronological order (most recent first)
   * @throws Error if reflog doesn't exist for the ref
   */
  async call(): Promise<ReflogEntry[]> {
    this.checkCallable();
    this.setCallable(false);

    // Check if the ref store supports reflog
    if (!this.refsStore.getReflog) {
      throw new Error("This ref store does not support reflog");
    }

    const reader = await this.refsStore.getReflog(this.ref);
    if (!reader) {
      // Return empty array if no reflog exists (consistent with git behavior)
      return [];
    }

    return reader.getReverseEntries();
  }
}

/** What `git reflog expire`, `delete`, `drop` and `write` print and exit with. */
export interface ReflogUpdateResult {
  /** git's exit status: 0, or 255 when a reflog was not found or could not be changed */
  status: number;
  /** git's stdout (`--verbose` lines) */
  output: string;
  /** git's stderr lines (`error: ...`) */
  errors: string[];
}

/** refs.c's is_root_ref (HEAD, `*_HEAD`, AUTO_MERGE and kin). */
function isRootRef(name: string): boolean {
  if (!/^[A-Z_-]+$/.test(name)) return false;
  if (name === "FETCH_HEAD" || name === "MERGE_HEAD") return false;
  if (name.endsWith("_HEAD") || name === "HEAD") return true;
  return [
    "AUTO_MERGE",
    "BISECT_EXPECTED_REV",
    "NOTES_MERGE_PARTIAL",
    "NOTES_MERGE_REF",
    "MERGE_AUTOSTASH",
  ].includes(name);
}

/** A ref every worktree has its own of (HEAD, root refs, `refs/bisect/` ...). */
function isPerWorktree(name: string): boolean {
  return (
    !name.startsWith("refs/") ||
    name.startsWith("refs/bisect/") ||
    name.startsWith("refs/worktree/") ||
    name.startsWith("refs/rewritten/")
  );
}
