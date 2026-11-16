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
  private ignoredOnly = false;
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
   * Set whether to remove only the files the ignore rules exclude (`git clean -X`),
   * keeping untracked files that are not ignored. Off by default; it takes precedence over
   * {@link setIgnore}.
   *
   * @param ignoredOnly Whether to remove only ignored files
   */
  setIgnoredOnly(ignoredOnly: boolean): this {
    this.checkCallable();
    this.ignoredOnly = ignoredOnly;
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
   * `-x` with `setIgnore(false)`, `-X` with `setIgnoredOnly(true)`, `-ff` with
   * `setForceNestedRepositories(true)`, `-n` with dry run):
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

  /**
   * Whether `path` is or lies in one of the requested paths, as git's pathspec matches it: a
   * plain path matches itself and what is below it; one with `*`, `?` or `[...]` is a glob
   * over the whole path (`*` matching `/` too).
   */
  private matchesPaths(path: string, isDirectory = false): boolean {
    if (this.paths.size === 0) return true;
    for (const p of this.paths) {
      const spec = p.replace(/\/+$/, "");
      if (spec === "" || spec === ".") return true;
      if (/[*?[]/.test(spec)) {
        // a directory is matched with its trailing slash too (`u/*` names `u/`, as git)
        const glob = globToRegExp(spec);
        if (glob.test(path) || (isDirectory && glob.test(`${path}/`))) return true;
        continue;
      }
      if (path === spec || path.startsWith(`${spec}/`)) return true;
    }
    return false;
  }

  /**
   * The worktree as `git clean` sees it, as a tree: what the index does not track, with
   * nested repositories (not entered), `.git` entries that name no repository (entered: git
   * removes what is in them when it removes their directory) and unreadable directories.
   */
  private async loadTree(worktree: Worktree, tracked: Set<string>): Promise<CleanNode> {
    const root: CleanNode = node("", true);
    const nodes = new Map<string, CleanNode>([["", root]]);
    // a worktree whose walk lists no directories (only files) still gives their tree
    const parentOf = (path: string): CleanNode | undefined => {
      const dir = path.slice(0, Math.max(0, path.lastIndexOf("/")));
      const known = nodes.get(dir);
      if (known) return known;
      const parent = parentOf(dir);
      if (!parent?.directory || parent.repository) return undefined;
      const made = node(dir, true);
      made.tracked = tracked.has(dir);
      made.gitDir = parent.gitDir;
      parent.children.push(made);
      nodes.set(dir, made);
      return made;
    };
    const unreadable = new Set<string>();
    for await (const entry of worktree.walk({
      includeIgnored: true,
      includeDirectories: true,
      enterNonRepositoryGitDirs: true,
      onUnreadable: (path) => unreadable.add(path),
    })) {
      const parent = parentOf(entry.path);
      // inside a nested repository or a file path: not ours to look at
      if (!parent?.directory || parent.repository) continue;
      const n = node(entry.path, entry.isDirectory);
      n.ignored = entry.isIgnored === true;
      n.tracked = tracked.has(entry.path);
      n.gitDir = entry.name === ".git" || parent.gitDir;
      if (entry.isDirectory && entry.mode === FileMode.GITLINK) {
        n.repository = worktree.isRepository ? await worktree.isRepository(entry.path) : true;
      }
      parent.children.push(n);
      nodes.set(entry.path, n);
    }
    for (const path of unreadable) {
      const n = nodes.get(path);
      if (n) n.unreadable = true;
    }
    return root;
  }

  /**
   * git's `remove_dirs` for the directory entries a clean removes: everything in each goes
   * (a `.git` that is no repository included, whatever the ignore rules say), nested
   * repositories are skipped ("Would skip repository") unless `-ff` removes them whole; a
   * directory wholly removed is reported as `dir/`, else what went in it (directories
   * without the slash). Files are removed one by one and directories once empty, deepest
   * first; only a nested repository under `-ff` is removed recursively.
   */
  private async removeEntries(
    worktree: Worktree,
    files: string[],
    dirs: CleanNode[],
  ): Promise<CleanResult> {
    const cleaned = new Set<string>();
    const skipped = new Set<string>();
    const removeFiles = [...files];
    const removeDirs: string[] = [];
    const repositories: string[] = [];
    const remove = (n: CleanNode): boolean => {
      if (n.repository) {
        if (!this.forceNested) {
          skipped.add(n.path);
          return false;
        }
        repositories.push(n.path);
        return true;
      }
      // unreadable: its content is unknown, it stays
      if (n.unreadable) return false;
      const dels: string[] = [];
      let all = true;
      for (const child of n.children) {
        if (child.tracked) {
          all = false;
          continue;
        }
        if (child.directory) {
          if (remove(child)) dels.push(child.path);
          else all = false;
        } else if (child.gitDir || isValidWorktreePath(child.path)) {
          removeFiles.push(child.path);
          dels.push(child.path);
        } else all = false;
      }
      removeDirs.push(n.path);
      if (!all) for (const d of dels) cleaned.add(d);
      return all;
    };
    for (const path of files) cleaned.add(path);
    for (const dir of dirs) if (remove(dir)) cleaned.add(`${dir.path}/`);

    if (!this.dryRun) {
      const options = { nonRepositoryGitDirs: true };
      for (const path of removeFiles) await worktree.remove(path, options);
      // `git clean -ff`: a nested repository goes whole, as git removes it
      for (const path of repositories) await worktree.remove(path, { ...options, recursive: true });
      const deepestFirst = removeDirs.sort(
        (a, b) => b.split("/").length - a.split("/").length || (a < b ? 1 : -1),
      );
      for (const dir of deepestFirst) await removeDirectoryIfEmpty(worktree, dir, options);
    }
    return { cleaned, skipped, dryRun: this.dryRun };
  }

  /**
   * `git clean -X`: only what the ignore rules exclude goes, as git's `read_directory` with
   * `DIR_SHOW_IGNORED` finds it. Untracked directories are entered for the ignored files in
   * them; a directory that is ignored itself, or holds only ignored content (an empty
   * directory is untracked content; a nested repository is invisible without `-ff` and
   * untracked content with it), is one entry, removed with `-d` or when a path filter
   * matches it, as `git clean` removes directories. A path filter that could match below
   * such a directory enters it. A `.git` that is no repository is never looked at here
   * (git's directory scan skips it), only removed with its directory.
   */
  private async cleanIgnored(worktree: Worktree): Promise<CleanResult> {
    const tracked = new Set<string>();
    for await (const entry of this.staging.entries()) tracked.add(entry.path);
    const trackedDirs = directoriesOf(tracked);
    const root = await this.loadTree(worktree, tracked);

    const states = new Map<CleanNode, CleanState>();
    const state = (n: CleanNode): CleanState => {
      const known = states.get(n);
      if (known) return known;
      let result: CleanState;
      if (n.gitDir || n.tracked) result = "none";
      else if (!n.directory) result = n.ignored ? "ignored" : "untracked";
      else if (n.unreadable) result = "untracked";
      else if (n.repository) {
        // git skips nested repositories without -ff; with it they are untracked content
        result = !this.forceNested ? "none" : n.ignored ? "ignored" : "untracked";
      } else if (n.ignored) {
        // an ignored directory is one ignored entry, empty or not (git removes it with -d)
        result = "ignored";
      } else {
        const inside = n.children.map(state);
        if (inside.includes("untracked") || !inside.includes("ignored")) result = "untracked";
        else result = "ignored";
      }
      states.set(n, result);
      return result;
    };

    const removeFiles: string[] = [];
    const removeDirs: CleanNode[] = [];
    const listDirs = this.directories || this.paths.size > 0;
    const visit = (dir: CleanNode) => {
      for (const child of dir.children) {
        if (child.gitDir || child.tracked) continue;
        if (!child.directory) {
          if (child.ignored && this.matchesPaths(child.path) && isValidWorktreePath(child.path)) {
            removeFiles.push(child.path);
          }
          continue;
        }
        if (trackedDirs.has(child.path)) {
          visit(child);
          continue;
        }
        if (child.unreadable) continue;
        const st = state(child);
        if (st === "untracked" && !child.repository) visit(child);
        else if (st === "ignored") {
          if (!child.ignored && !child.repository && this.pathspecBelow(child.path)) visit(child);
          else if (listDirs && this.matchesDirectoryEntry(child.path)) removeDirs.push(child);
        }
      }
    };
    visit(root);
    return this.removeEntries(worktree, removeFiles, removeDirs);
  }

  /**
   * Whether a requested path could match below `dir` (git's leading pathspec match): a
   * plain path inside it, or a glob whose literal part leads into it or ends before it.
   */
  private pathspecBelow(dir: string): boolean {
    for (const p of this.paths) {
      const spec = p.replace(/\/+$/, "");
      if (spec === "" || spec === ".") continue;
      if (!/[*?[]/.test(spec)) {
        if (spec.startsWith(`${dir}/`)) return true;
        continue;
      }
      const glob = globToRegExp(spec);
      if (glob.test(dir) || glob.test(`${dir}/`)) continue;
      const literal = spec.slice(0, spec.search(/[*?[]/));
      if (literal.startsWith(`${dir}/`) || `${dir}/`.startsWith(literal)) return true;
    }
    return false;
  }

  /**
   * Whether a requested path matches a directory entry of `git clean -X`: no path filter, a
   * plain path naming it, one of its ancestors or a path inside it, or a glob matching it
   * (or whose literal part leads into it).
   */
  private matchesDirectoryEntry(dir: string): boolean {
    if (this.paths.size === 0) return true;
    if (this.matchesPaths(dir, true)) return true;
    for (const p of this.paths) {
      const spec = p.replace(/\/+$/, "");
      if (!/[*?[]/.test(spec)) {
        if (spec.startsWith(`${dir}/`)) return true;
        continue;
      }
      const literal = spec.slice(0, spec.search(/[*?[]/));
      if (literal.startsWith(`${dir}/`) || `${dir}/`.startsWith(literal)) return true;
    }
    return false;
  }

  /**
   * `git clean [-d] [-x]`, as git's `read_directory` lists what to remove: untracked files
   * of the directories it enters (the root, directories holding tracked paths, untracked
   * ones with `-d` or a path filter) and, with `-d` (or a path filter naming them), each
   * untracked directory holding nothing kept (no ignored file without `-x`; a nested
   * repository does not count, `.git` content is not looked at) as one entry, removed as
   * git's `remove_dirs` removes it. A directory holding something kept is entered instead.
   * Ignored directories stay whole without `-x`; nested repositories met in the entered
   * directories are passed over silently (`-ff`: removed whole).
   */
  private async clean(worktree: Worktree): Promise<CleanResult> {
    if (this.ignoredOnly) return this.cleanIgnored(worktree);
    // what the index tracks (any stage): git clean looks at the index, not at HEAD
    const tracked = new Set<string>();
    for await (const entry of this.staging.entries()) tracked.add(entry.path);
    const trackedDirs = directoriesOf(tracked);
    const removeIgnored = !this.ignore;
    // without -d (and without a path filter) git does not enter untracked directories; a
    // path filter removes the directories it names as -d does
    const enterUntracked = this.directories || this.paths.size > 0;
    const root = await this.loadTree(worktree, tracked);

    // whether something in `dir` stays as git's directory scan sees it: an ignored entry
    // without -x, or an unreadable directory (nested repositories and `.git` do not count)
    const holdsKept = (n: CleanNode): boolean =>
      n.unreadable === true ||
      n.children.some((c) => {
        if (c.gitDir || c.repository || c.tracked) return false;
        if (c.ignored && !removeIgnored) return true;
        return c.directory && holdsKept(c);
      });

    const removeFiles: string[] = [];
    const removeDirs: CleanNode[] = [];
    const visit = (dir: CleanNode) => {
      for (const child of dir.children) {
        if (child.gitDir || child.tracked) continue;
        const keptAsIgnored = child.ignored && !removeIgnored;
        if (!child.directory) {
          // a name that spells `.git` is refused by the worktree (git's verify_path): left
          if (!keptAsIgnored && this.matchesPaths(child.path) && isValidWorktreePath(child.path)) {
            removeFiles.push(child.path);
          }
          continue;
        }
        if (trackedDirs.has(child.path)) {
          visit(child);
          continue;
        }
        // an ignored directory stays whole without -x; without -d (and no path filter)
        // untracked directories are not entered
        if (keptAsIgnored || !enterUntracked || child.unreadable) continue;
        if (child.repository) {
          // a nested repository: only `git clean -ff` removes it (whole)
          if (this.forceNested && this.matchesPaths(child.path)) removeDirs.push(child);
          continue;
        }
        if (this.matchesPaths(child.path, true) && !holdsKept(child)) removeDirs.push(child);
        else visit(child);
      }
    };
    visit(root);
    return this.removeEntries(worktree, removeFiles, removeDirs);
  }
}

/** A worktree entry, as `git clean` sees it. */
interface CleanNode {
  path: string;
  directory: boolean;
  /** Excluded by the ignore rules itself */
  ignored: boolean;
  /** A nested repository (a directory with a `.git` that is one) */
  repository: boolean;
  /** The index has this path (a file, link or submodule): never entered or removed */
  tracked?: boolean;
  /** A `.git` that is no repository, or inside one */
  gitDir?: boolean;
  /** A directory whose listing failed */
  unreadable?: boolean;
  children: CleanNode[];
}

const node = (path: string, directory: boolean): CleanNode => ({
  path,
  directory,
  ignored: false,
  repository: false,
  children: [],
});

/** How a directory counts to `git clean -X`: holding untracked content, only ignored, nothing. */
type CleanState = "untracked" | "ignored" | "none";

/** A pathspec glob as a regular expression over the whole path (`*` matches `/` too). */
function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") out += ".*";
    else if (c === "?") out += "[^/]";
    else if (c === "[") {
      const end = glob.indexOf("]", i + 1);
      if (end < 0) out += "\\[";
      else {
        const body = glob
          .slice(i + 1, end)
          .replace(/^!/, "^")
          .replace(/\\/g, "\\\\");
        out += `[${body}]`;
        i = end;
      }
    } else out += c.replace(/[.+^${}()|\\/]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}
