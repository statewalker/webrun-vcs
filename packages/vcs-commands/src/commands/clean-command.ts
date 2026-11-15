import { FileMode, isValidWorktreePath } from "@statewalker/vcs-core";
import { directoriesOf, type Worktree } from "@statewalker/vcs-working-tree";
import { GitCommand } from "../git-command.js";
import { removeDirectoryIfEmpty } from "./worktree-overwrite-checks.js";

/**
 * Result of a clean operation
 */
export interface CleanResult {
  /** Files that were (or would be) removed */
  cleaned: Set<string>;
  /**
   * Nested repositories left in untracked directories (`git clean -n`: "Would skip
   * repository"); one directly under a tracked directory is passed over silently, as git
   */
  skipped: Set<string>;
  /** Whether this was a dry run (no files actually removed) */
  dryRun: boolean;
}

/**
 * Remove untracked files from working tree.
 *
 * Equivalent to `git clean`.
 *
 * Based on JGit's CleanCommand.
 *
 * This command DELETES files from the working tree when dry-run is disabled.
 * Dry-run is the default for exactly that reason: a caller must opt in to
 * destruction with `setDryRun(false)`. The returned `dryRun` flag always
 * reports what the caller asked for, so a `false` there means files were
 * really removed.
 *
 * @example
 * ```typescript
 * // Preview what would be cleaned (dry run - the default)
 * const result = await git.clean()
 *   .setDryRun(true)
 *   .call();
 * for (const file of result.cleaned) {
 *   console.log(`Would remove: ${file}`);
 * }
 *
 * // Actually delete the untracked files
 * const result = await git.clean()
 *   .setDryRun(false)
 *   .call();
 *
 * // Include directories
 * const result = await git.clean()
 *   .setCleanDirectories(true)
 *   .call();
 * ```
 */
export class CleanCommand extends GitCommand<CleanResult> {
  private paths = new Set<string>();
  private dryRun = true; // Default to dry-run for safety
  private directories = false;
  private ignore = true; // Respect .gitignore
  private forceNested = false;

  /**
   * Limit clean to specific paths.
   *
   * @param paths Set of paths to clean
   */
  setPaths(paths: Set<string>): this {
    this.checkCallable();
    this.paths = paths;
    return this;
  }

  /**
   * Set dry run mode.
   *
   * When true (default), no files are actually deleted.
   * The result will still contain the list of files that would be cleaned.
   *
   * @param dryRun Whether to run in dry-run mode
   */
  setDryRun(dryRun: boolean): this {
    this.checkCallable();
    this.dryRun = dryRun;
    return this;
  }

  /**
   * Set whether to also clean untracked directories (`git clean -d`): their untracked
   * files are removed and each directory once it is empty.
   *
   * @param directories Whether to clean directories
   */
  setCleanDirectories(directories: boolean): this {
    this.checkCallable();
    this.directories = directories;
    return this;
  }

  /**
   * Set whether to respect .gitignore patterns.
   *
   * When true (default), ignored files are not cleaned.
   * When false, ignored files are also cleaned.
   *
   * @param ignore Whether to respect .gitignore
   */
  setIgnore(ignore: boolean): this {
    this.checkCallable();
    this.ignore = ignore;
    return this;
  }

  /**
   * Set whether nested repositories (untracked directories with their own `.git`) are
   * removed too, as `git clean -ff`. Off by default: they are skipped, as `git clean -f`
   * skips them, and listed in `skipped`.
   *
   * @param force Whether to remove nested repositories
   */
  setForceNestedRepositories(force: boolean): this {
    this.checkCallable();
    this.forceNested = force;
    return this;
  }

  /**
   * Execute the clean command, as `git clean -f` (`-d` with `setCleanDirectories(true)`,
   * `-x` with `setIgnore(false)`, `-ff` with `setForceNestedRepositories(true)`, `-n` with
   * dry run):
   * - only files the index does not track are removed, one at a time;
   * - an untracked directory (one holding no tracked or staged path) is entered only with
   *   `-d` or a path filter; with `-d` it is removed once empty, deepest first and never
   *   recursively, so whatever stays in it (an ignored file without `-x`, a nested
   *   repository without `-ff`) keeps it;
   * - `cleaned` lists what `git clean -n` prints after "Would remove": a wholly removed
   *   untracked directory as `dir/`, else the files; `skipped` the nested repositories
   *   ("Would skip repository").
   *
   * @returns CleanResult with set of cleaned files
   */
  async call(): Promise<CleanResult> {
    this.checkCallable();
    this.setCallable(false);

    const worktree = this.worktreeAccess;
    if (!worktree) {
      throw new Error("CleanCommand requires a WorkingCopy with worktree");
    }
    return worktree.batch ? worktree.batch(() => this.clean(worktree)) : this.clean(worktree);
  }

  /** Whether `path` is (or holds, or lies in) one of the requested paths. */
  private matchesPaths(path: string): boolean {
    if (this.paths.size === 0) return true;
    for (const p of this.paths) {
      const prefix = p.replace(/\/+$/, "");
      if (prefix === "" || prefix === ".") return true;
      if (path === prefix || path.startsWith(`${prefix}/`) || prefix.startsWith(`${path}/`)) {
        return true;
      }
    }
    return false;
  }

  private async clean(worktree: Worktree): Promise<CleanResult> {
    // what the index tracks (any stage): git clean looks at the index, not at HEAD
    const tracked = new Set<string>();
    for await (const entry of this.staging.entries()) tracked.add(entry.path);
    const trackedDirs = directoriesOf(tracked);
    const removeIgnored = !this.ignore;
    // without -d (and without a path filter) git does not enter untracked directories
    const enterUntracked = this.directories || this.paths.size > 0;
    const ancestors = (path: string) => {
      const parts = path.split("/");
      const out: string[] = [];
      for (let k = 1; k < parts.length; k++) out.push(parts.slice(0, k).join("/"));
      return out;
    };

    const removeFiles: string[] = [];
    const removeRepos: string[] = [];
    const untrackedDirs: string[] = [];
    const notEntered = new Set<string>();
    const skipped = new Set<string>();
    // the untracked directories something stays in: they stay too
    const kept = new Set<string>();
    const keep = (path: string, isDirectory = false) => {
      for (const dir of ancestors(path)) kept.add(dir);
      if (isDirectory) kept.add(path);
    };

    for await (const entry of worktree.walk({ includeIgnored: true, includeDirectories: true })) {
      const path = entry.path;
      if (ancestors(path).some((dir) => notEntered.has(dir))) continue;
      const keptAsIgnored = entry.isIgnored && !removeIgnored;
      if (entry.isDirectory) {
        if (trackedDirs.has(path) || tracked.has(path)) continue;
        if (!enterUntracked) {
          notEntered.add(path);
          continue;
        }
        if (entry.mode === FileMode.GITLINK) {
          // a nested repository: only `git clean -ff` removes it (whole)
          if (keptAsIgnored || !this.matchesPaths(path)) keep(path, true);
          else if (!this.forceNested) {
            // git reports the ones it meets while removing an untracked directory
            // ("Would skip repository u/sub"); one directly under a tracked directory is
            // passed over silently
            if (ancestors(path).some((dir) => !trackedDirs.has(dir))) skipped.add(path);
            keep(path, true);
          } else removeRepos.push(path);
          continue;
        }
        untrackedDirs.push(path);
        // an ignored directory stays whole without -x
        if (keptAsIgnored) keep(path, true);
        continue;
      }
      if (tracked.has(path)) continue;
      if (
        keptAsIgnored ||
        !this.matchesPaths(path) ||
        // a name that spells `.git` is refused by the worktree (git's verify_path): left
        !isValidWorktreePath(path)
      ) {
        keep(path);
        continue;
      }
      removeFiles.push(path);
    }

    // what git clean -n prints: the topmost wholly removed untracked directory, else files
    const removedDir = (dir: string) =>
      this.directories && !trackedDirs.has(dir) && !kept.has(dir) && this.matchesPaths(dir);
    const reportFor = (path: string, suffix = "") => {
      for (const dir of ancestors(path)) if (removedDir(dir)) return `${dir}/`;
      return `${path}${suffix}`;
    };
    const cleaned = new Set<string>();
    for (const path of removeFiles) cleaned.add(reportFor(path));
    for (const path of removeRepos) cleaned.add(reportFor(path, "/"));
    for (const dir of untrackedDirs) if (removedDir(dir)) cleaned.add(reportFor(dir, "/"));

    if (!this.dryRun) {
      for (const path of removeFiles) await worktree.remove(path);
      // `git clean -ff`: the caller asked for the nested repositories to go, whole
      for (const path of removeRepos) await worktree.remove(path, { recursive: true });
      if (this.directories) {
        const deepestFirst = [...untrackedDirs].sort(
          (a, b) => b.split("/").length - a.split("/").length || (a < b ? 1 : -1),
        );
        for (const dir of deepestFirst) await removeDirectoryIfEmpty(worktree, dir);
      }
    }

    return { cleaned, skipped, dryRun: this.dryRun };
  }
}
