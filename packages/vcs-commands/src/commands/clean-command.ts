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

  /** Whether a requested path names `path` itself. */
  private namesPath(path: string): boolean {
    for (const p of this.paths) {
      const spec = p.replace(/\/+$/, "");
      if (spec === path || (/[*?[]/.test(spec) && globToRegExp(spec).test(path))) return true;
    }
    return false;
  }

  /**
   * `git clean -X`: only what the ignore rules exclude goes, as git's `read_directory` with
   * `DIR_SHOW_IGNORED` finds it. Untracked directories are entered for the ignored files in
   * them; a directory that is ignored itself, or holds only ignored content (an empty
   * directory is untracked content; a nested repository is invisible without `-ff` and
   * untracked content with it), is one entry, removed with `-d` or when a path filter
   * matches it, whole as `git clean` removes directories (nested repositories inside kept
   * without `-ff`). A path filter that could match below such a directory enters it.
   */
  private async cleanIgnored(worktree: Worktree): Promise<CleanResult> {
    const tracked = new Set<string>();
    for await (const entry of this.staging.entries()) tracked.add(entry.path);
    const trackedDirs = directoriesOf(tracked);
    const root: CleanNode = {
      path: "",
      directory: true,
      ignored: false,
      repository: false,
      children: [],
    };
    const nodes = new Map<string, CleanNode>([["", root]]);
    const parentOf = (path: string) => nodes.get(path.slice(0, Math.max(0, path.lastIndexOf("/"))));
    const load = async (pathPrefix?: string) => {
      for await (const entry of worktree.walk({
        includeIgnored: true,
        includeDirectories: true,
        ...(pathPrefix ? { pathPrefix } : {}),
      })) {
        const parent = parentOf(entry.path);
        // inside a submodule, a nested repository or a file path: not ours to look at
        if (!parent?.directory || parent.repository) continue;
        if (tracked.has(entry.path)) continue;
        const node: CleanNode = {
          path: entry.path,
          directory: entry.isDirectory,
          ignored: entry.isIgnored === true,
          repository: false,
          children: [],
        };
        if (entry.isDirectory && entry.mode === FileMode.GITLINK) {
          node.repository = worktree.isRepository ? await worktree.isRepository(entry.path) : true;
        }
        parent.children.push(node);
        nodes.set(entry.path, node);
        // a `.git` that is no repository: an ordinary directory, whose content the walk
        // did not enter
        if (entry.isDirectory && entry.mode === FileMode.GITLINK && !node.repository) {
          await load(entry.path);
        }
      }
    };
    await load();

    const states = new Map<CleanNode, CleanState>();
    const hasFiles = (node: CleanNode): boolean =>
      node.children.some((c) => !c.directory || c.repository || hasFiles(c));
    const state = (node: CleanNode): CleanState => {
      const known = states.get(node);
      if (known) return known;
      let result: CleanState;
      if (!node.directory) result = node.ignored ? "ignored" : "untracked";
      else if (node.repository) {
        // git skips nested repositories without -ff; with it they are untracked content
        result = !this.forceNested ? "none" : node.ignored ? "ignored" : "untracked";
      } else if (node.ignored) result = hasFiles(node) ? "ignored" : "none";
      else {
        const inside = node.children.map(state);
        if (inside.includes("untracked") || !inside.includes("ignored")) result = "untracked";
        else result = "ignored";
      }
      states.set(node, result);
      return result;
    };

    const removeFiles: string[] = [];
    const removeDirs: CleanNode[] = [];
    const listDirs = this.directories || this.paths.size > 0;
    const visit = (dir: CleanNode) => {
      for (const child of dir.children) {
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
        const st = state(child);
        if (st === "untracked" && !child.repository) visit(child);
        else if (st === "ignored") {
          if (!child.ignored && !child.repository && this.pathspecBelow(child.path)) visit(child);
          else if (listDirs && this.matchesDirectoryEntry(child.path)) removeDirs.push(child);
        }
      }
    };
    visit(root);

    // git's remove_dirs: everything in the directory goes, nested repositories kept without
    // -ff; a directory not wholly removed reports what went in it
    const cleaned = new Set<string>();
    const skipped = new Set<string>();
    const files: string[] = [];
    const wholes: string[] = [];
    const dirs: string[] = [];
    const remove = (node: CleanNode): boolean => {
      if (node.repository) {
        if (!this.forceNested) {
          skipped.add(node.path);
          return false;
        }
        wholes.push(node.path);
        return true;
      }
      const dels: string[] = [];
      let gone = true;
      for (const child of node.children) {
        if (child.directory) {
          if (remove(child)) dels.push(child.path);
          else gone = false;
        } else {
          files.push(child.path);
          dels.push(child.path);
        }
      }
      dirs.push(node.path);
      if (!gone) for (const d of dels) cleaned.add(d);
      return gone;
    };
    for (const path of removeFiles) cleaned.add(path);
    for (const dir of removeDirs) if (remove(dir)) cleaned.add(`${dir.path}/`);

    if (!this.dryRun) {
      for (const path of [...removeFiles, ...files]) await worktree.remove(path);
      for (const path of wholes) await worktree.remove(path, { recursive: true });
      const deepestFirst = dirs.sort((a, b) => b.split("/").length - a.split("/").length);
      for (const dir of deepestFirst) await removeDirectoryIfEmpty(worktree, dir);
    }
    return { cleaned, skipped, dryRun: this.dryRun };
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
    const ancestors = (path: string) => {
      const parts = path.split("/");
      const out: string[] = [];
      for (let k = 1; k < parts.length; k++) out.push(parts.slice(0, k).join("/"));
      return out;
    };

    // whether something under `dir` stays (an ignored file without -x)
    const holdsKept = async (dir: string) => {
      if (removeIgnored) return false;
      for await (const inside of worktree.walk({ pathPrefix: dir, includeIgnored: true })) {
        if (inside.isIgnored) return true;
      }
      return false;
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
        if (trackedDirs.has(path)) continue;
        // a directory where the index has a file, link or submodule: git never enters it
        if (tracked.has(path) || !enterUntracked) {
          notEntered.add(path);
          continue;
        }
        if (entry.mode === FileMode.GITLINK) {
          notEntered.add(path);
          // a `.git` that is no repository (an empty directory): an ordinary directory
          // to git clean, removed with what is in it
          if (worktree.isRepository && !(await worktree.isRepository(path))) {
            if (keptAsIgnored || !this.matchesPaths(path) || (await holdsKept(path))) {
              keep(path, true);
            } else removeRepos.push(path);
            continue;
          }
          // a nested repository: only `git clean -ff` removes it (whole)
          if (keptAsIgnored || !this.matchesPaths(path)) keep(path, true);
          else if (!this.forceNested) {
            // git reports the ones it meets while removing an untracked directory
            // ("Would skip repository u/sub"); one directly under a tracked directory, or
            // named by a requested path, is passed over silently
            if (ancestors(path).some((dir) => !trackedDirs.has(dir)) && !this.namesPath(path)) {
              skipped.add(path);
            }
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
    const dirMode = this.directories || this.paths.size > 0;
    const removedDir = (dir: string) =>
      dirMode && !trackedDirs.has(dir) && !kept.has(dir) && this.matchesPaths(dir, true);
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
      // `git clean -ff` (or a `.git` that is no repository): the directory goes, whole
      for (const path of removeRepos) await worktree.remove(path, { recursive: true });
      if (dirMode) {
        const deepestFirst = [...untrackedDirs].sort(
          (a, b) => b.split("/").length - a.split("/").length || (a < b ? 1 : -1),
        );
        // only the directories the path filter names (a glob emptying one leaves it)
        for (const dir of deepestFirst) {
          if (this.matchesPaths(dir, true)) await removeDirectoryIfEmpty(worktree, dir);
        }
      }
    }

    return { cleaned, skipped, dryRun: this.dryRun };
  }
}

/** A worktree entry, as `git clean -X` sees it. */
interface CleanNode {
  path: string;
  directory: boolean;
  /** Excluded by the ignore rules itself */
  ignored: boolean;
  /** A nested repository (a directory with a `.git` that is one) */
  repository: boolean;
  children: CleanNode[];
}

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
