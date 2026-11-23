import type { ObjectId } from "@statewalker/vcs-core";

import { IncompatibleOptionsError, RevisionError } from "../errors/index.js";
import { GitCommand } from "../git-command.js";
import { RemoteConfigStore } from "../remote-config/index.js";
import { ChangeType, type DiffEntry } from "../results/diff-entry.js";
import { DiffCommand } from "./diff-command.js";
import {
  openSubmoduleRepository,
  readGitmodulesEntries,
  type SubmoduleRepository,
  type SubmoduleWalkCommit,
} from "./submodule-summary.js";

const S_IFMT = 0o170000;
const GITLINK = 0o160000;
const isGitlink = (mode: number) => (mode & S_IFMT) === GITLINK;

/** One changed submodule (submodule--helper.c's `module_cb`). */
interface ModuleChange {
  modSrc: number;
  modDst: number;
  oidSrc: ObjectId;
  oidDst: ObjectId;
  status: "A" | "D" | "M" | "T" | "R" | "C";
  path: string;
}

/**
 * Summarizes the commits of changed submodules, as `git submodule summary` (git's
 * builtin/submodule--helper.c `module_summary`): for each submodule that differs between a
 * commit (HEAD by default) and the worktree (or the index with {@link setCached}, or between
 * the index and the worktree with {@link setFiles}), a line
 * `* <path> <old>...<new> (<count>):` and the commits between the two sides, `  < subject`
 * for those only the old side has and `  > subject` for the new side's, newest first
 * (`git log --first-parent <old>...<new>` run in the submodule), then a blank line.
 *
 * A submodule added shows its newest commit, one deleted no commit; a file replaced by a
 * submodule is `* <path> <blob>(blob)->(<commit>)(submodule)`, and the reverse
 * `(submodule)->(blob)`. Commits the submodule lacks give a `  Warn: <path> doesn't contain
 * commit <id>` line. {@link setSummaryLimit} limits how many commits are listed per
 * submodule (0: nothing at all); {@link setForStatus} leaves out the submodules whose
 * `submodule.<name>.ignore` is `all`, as `git status` asks.
 *
 * @example
 * ```typescript
 * const text = await git.submoduleSummary().setSummaryLimit(5).call();
 * // "* lib 1234567...89abcde (2):\n  > Fix the parser\n  > Add a test\n\n"
 * ```
 */
export class SubmoduleSummaryCommand extends GitCommand<string> {
  private cached = false;
  private files = false;
  private forStatus = false;
  private summaryLimit = -1;
  private commit?: string;
  private readonly paths: string[] = [];

  /** `--cached`: compare the commit with the index's submodule commits, not their HEADs. */
  setCached(cached: boolean): this {
    this.checkCallable();
    this.cached = cached;
    return this;
  }

  /** `--files`: compare the index's submodule commits with the submodules' HEADs. */
  setFiles(files: boolean): this {
    this.checkCallable();
    this.files = files;
    return this;
  }

  /** `--for-status`: skip the submodules whose `submodule.<name>.ignore` is `all`. */
  setForStatus(forStatus: boolean): this {
    this.checkCallable();
    this.forStatus = forStatus;
    return this;
  }

  /**
   * `-n` / `--summary-limit`: list at most this many commits of a submodule (a negative
   * number: all, the default; 0: print nothing).
   */
  setSummaryLimit(limit: number): this {
    this.checkCallable();
    this.summaryLimit = limit;
    return this;
  }

  /**
   * The `<commit>` argument (default HEAD). As git reads it, an argument that names no
   * commit is taken as the first path instead (HEAD is then compared with).
   */
  setCommit(commit: string): this {
    this.checkCallable();
    this.commit = commit;
    return this;
  }

  /** A path (pathspec element) limiting the submodules summarized. */
  addPath(path: string): this {
    this.checkCallable();
    this.paths.push(path);
    return this;
  }

  /** The summary as `git submodule summary` prints it on stdout. */
  async call(): Promise<string> {
    this.checkCallable();
    this.setCallable(false);
    if (this.summaryLimit === 0) return "";
    const paths = [...this.paths];
    let head: ObjectId;
    const first = this.commit ?? "HEAD";
    const resolved = await this.resolveTree(first);
    if (resolved !== undefined) head = resolved;
    else if (first === "HEAD") {
      // before the first commit: compare with an empty tree
      head = this.objectFormat.emptyTreeId;
    } else {
      paths.unshift(first);
      const fallback = await this.resolveTree("HEAD");
      if (fallback === undefined) {
        throw new RevisionError("HEAD", "fatal: could not fetch a revision for HEAD");
      }
      head = fallback;
    }
    if (this.files && this.cached) {
      throw new IncompatibleOptionsError(
        ["--cached", "--files"],
        "options '--cached' and '--files' cannot be used together",
      );
    }
    const changes = await this.moduleList(this.files ? undefined : head, paths);
    let out = "";
    const ignores = this.forStatus ? await this.ignoreAll() : undefined;
    for (const p of changes) {
      if (p.status !== "D" && p.status !== "T") {
        if (p.status !== "A" && ignores?.has(p.path)) continue;
        // also show added or modified modules which are checked out
        const populated = await this.worktreeAccess
          ?.openGitlink?.(p.path)
          .then((wc) => wc !== undefined)
          .catch(() => false);
        if (!populated) continue;
      }
      out += await this.generate(p);
    }
    return out;
  }

  /** The commit `name` names (its tree is compared with), undefined when none. */
  private async resolveTree(name: string): Promise<ObjectId | undefined> {
    try {
      return await this.resolveRevision(name);
    } catch {
      return undefined;
    }
  }

  /**
   * compute_summary_module_list: `diff-index [--cached] <head>` (or `diff-files`) with
   * `--ignore-submodules=dirty`, the pairs with a submodule on either side.
   */
  private async moduleList(head: ObjectId | undefined, paths: string[]): Promise<ModuleChange[]> {
    const run = (configure: (d: DiffCommand) => void) => {
      const diff = new DiffCommand(this.workingCopy).setRenames(false).setIgnoreSubmodules("dirty");
      configure(diff);
      if (paths.length > 0) diff.setPathspec(paths);
      return diff.call();
    };
    let entries: DiffEntry[];
    if (head === undefined) entries = await run(() => {});
    else if (this.cached) entries = await run((d) => d.setOldTree(head).setCached(true));
    // diff-index: each index entry's worktree side against the tree, a submodule at
    // another commit than its entry reported even where it is back at the tree's
    // (show_modified's null id, here the submodule's HEAD)
    else entries = await run((d) => d.setOldTree(head));
    const out: ModuleChange[] = [];
    for (const e of entries) {
      if (e.unmerged) continue;
      const modSrc = e.changeType === ChangeType.ADD ? 0 : (e.oldMode ?? 0);
      const modDst = e.changeType === ChangeType.DELETE ? 0 : (e.newMode ?? 0);
      if (!isGitlink(modSrc) && !isGitlink(modDst)) continue;
      const status =
        e.changeType === ChangeType.ADD
          ? "A"
          : e.changeType === ChangeType.DELETE
            ? "D"
            : (modSrc & S_IFMT) !== (modDst & S_IFMT)
              ? "T"
              : "M";
      out.push({
        modSrc,
        modDst,
        oidSrc: modSrc ? (e.oldId ?? this.objectFormat.nullId) : this.objectFormat.nullId,
        oidDst: modDst ? (e.newId ?? this.objectFormat.nullId) : this.objectFormat.nullId,
        status,
        path: (e.oldPath ?? e.newPath) as string,
      });
    }
    return out;
  }

  /** The paths of the submodules whose `submodule.<name>.ignore` is `all` (`--for-status`). */
  private async ignoreAll(): Promise<Set<string>> {
    const out = new Set<string>();
    const entries = await readGitmodulesEntries(this.workingCopy).catch(() => undefined);
    const config = RemoteConfigStore.from(this.workingCopy);
    for (const e of entries ?? []) {
      if (e.path === undefined) continue;
      const value = config.value(`submodule.${e.name}.ignore`) ?? e.ignore;
      if (value === "all") out.add(e.path);
    }
    return out;
  }

  /**
   * The repository a command run in the submodule's directory reaches (`cp.dir = sm_path`):
   * the submodule's when it is checked out, the superproject's when the directory holds no
   * repository, none when there is no directory.
   *
   * Known gap: a submodule replaced by a symbolic link to a directory is a link here (the
   * worktree follows no link): `* sub <old>(submodule)-><link blob>(blob):`. git opens the
   * path through the link (generate_submodule_summary's `open` + `index_fd`), fails to hash
   * the directory ("error: couldn't hash object from 'sub'", the null id `0000000`), and
   * counts and lists the old commit with `rev-list` / `log` run through the link in whatever
   * repository it reaches (`(4):` and `  < subject`).
   */
  private async repositoryAt(path: string): Promise<SubmoduleRepository | undefined | "super"> {
    const sub = await openSubmoduleRepository(this.workingCopy, path);
    if (sub?.populated) return sub;
    const entry = await this.worktreeAccess?.getEntry(path).catch(() => undefined);
    return entry?.isDirectory ? "super" : undefined;
  }

  /** verify_submodule_committish: `rev-parse -q --short <id>^0` in the submodule. */
  private async verify(
    repo: SubmoduleRepository | undefined | "super",
    id: ObjectId,
  ): Promise<string | undefined> {
    if (repo === undefined) return undefined;
    if (repo === "super") {
      const found = await this.revisionResolver()
        .commitReference(id)
        .catch(() => undefined);
      return found ? this.abbreviateObjectId(found) : undefined;
    }
    const found = await repo.commitReference(id);
    return found ? repo.abbreviate(found) : undefined;
  }

  /** generate_submodule_summary and print_submodule_summary for one submodule. */
  private async generate(p: ModuleChange): Promise<string> {
    const worktree = this.worktreeAccess;
    if (!this.cached && p.oidDst === this.objectFormat.nullId && isGitlink(p.modDst)) {
      const sub = await openSubmoduleRepository(this.workingCopy, p.path);
      if (sub?.populated) p.oidDst = (await sub.head()) ?? this.objectFormat.nullId;
    }
    const repo = worktree ? await this.repositoryAt(p.path) : undefined;
    let missingSrc = false;
    let missingDst = false;
    let srcAbbrev: string | undefined;
    if (isGitlink(p.modSrc)) {
      if (p.status !== "D") srcAbbrev = await this.verify(repo, p.oidSrc);
      if (srcAbbrev === undefined) {
        missingSrc = true;
        srcAbbrev = p.oidSrc.slice(0, 7);
      }
    } else srcAbbrev = p.oidSrc.slice(0, 7);
    let dstAbbrev: string | undefined;
    if (isGitlink(p.modDst)) {
      dstAbbrev = await this.verify(repo, p.oidDst);
      if (dstAbbrev === undefined) {
        missingDst = true;
        dstAbbrev = p.oidDst.slice(0, 7);
      }
    } else dstAbbrev = p.oidDst.slice(0, 7);
    const displayPath = p.path;
    let total = -1;
    let errmsg: string | undefined;
    let walked: SubmoduleWalkCommit[] | undefined;
    const both = isGitlink(p.modSrc) && isGitlink(p.modDst);
    if (!missingSrc && !missingDst) {
      // rev-list --first-parent --count <src>...<dst> (or the one submodule side)
      walked = await this.walk(repo, both, p).catch(() => undefined);
      if (walked) total = walked.length;
    } else if (isGitlink(p.modDst)) {
      errmsg =
        missingSrc && missingDst
          ? `  Warn: ${displayPath} doesn't contain commits ${p.oidSrc} and ${p.oidDst}\n`
          : `  Warn: ${displayPath} doesn't contain commit ${missingSrc ? p.oidSrc : p.oidDst}\n`;
    }
    let out: string;
    if (p.status === "T") {
      out = isGitlink(p.modDst)
        ? `* ${displayPath} ${srcAbbrev}(blob)->${dstAbbrev}(submodule)`
        : `* ${displayPath} ${srcAbbrev}(submodule)->${dstAbbrev}(blob)`;
    } else out = `* ${displayPath} ${srcAbbrev}...${dstAbbrev}`;
    out += total < 0 ? ":\n" : ` (${total}):\n`;
    if (errmsg !== undefined) out += errmsg;
    else if (total > 0 && walked && repo !== undefined && repo !== "super") {
      // git log in the submodule
      if (both) {
        const shown = this.summaryLimit > 0 ? walked.slice(0, this.summaryLimit) : walked;
        for (const c of shown) out += await repo.formatLine("  %m %s", c);
      } else if (isGitlink(p.modDst)) {
        out += await repo.formatLine("  > %s", walked[0] as SubmoduleWalkCommit);
      } else {
        out += await repo.formatLine("  < %s", walked[0] as SubmoduleWalkCommit);
      }
    }
    return `${out}\n`;
  }

  /** The first-parent walk the count and the log list (in the submodule's repository). */
  private async walk(
    repo: SubmoduleRepository | undefined | "super",
    both: boolean,
    p: ModuleChange,
  ): Promise<SubmoduleWalkCommit[] | undefined> {
    if (repo === undefined || repo === "super") return undefined;
    if (both) {
      const src = (await repo.commitReference(p.oidSrc)) as ObjectId;
      const dst = (await repo.commitReference(p.oidDst)) as ObjectId;
      return repo.symmetricWalk(src, dst);
    }
    const start = (await repo.commitReference(
      isGitlink(p.modSrc) ? p.oidSrc : p.oidDst,
    )) as ObjectId;
    return repo.walkFirstParent([{ id: start }]);
  }
}
