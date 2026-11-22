import { FileMode, isValidWorktreePath } from "@statewalker/vcs-core";
import { compareGitPaths, decodeGitPath } from "@statewalker/vcs-utils/encoding";
import {
  IndexPathLookup,
  unreadableDirectoryWarning,
  type Worktree,
} from "@statewalker/vcs-working-tree";
import { GitCommand } from "../git-command.js";
import { coreBool } from "./core-config.js";
import {
  DO_MATCH_LEADING_PATHSPEC,
  MATCHED_RECURSIVELY_LEADING_PATHSPEC,
  matchPathspec,
  type PathspecItem,
  parsePathspec,
  pathspecItemBytes,
  pathspecName,
  psEqual,
} from "./pathspec.js";
import { PathspecAttributes } from "./pathspec-attributes.js";
import { strerror } from "./strerror.js";
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
  /**
   * git's warnings, in order: "warning: could not open directory 'u/': Permission denied"
   * for each directory the scan could not list, then (not on a dry run) "warning: failed
   * to remove u: Directory not empty" for each such directory git's `remove_dirs` could not
   * remove (git then exits with status 1)
   */
  warnings: string[];
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
   * `setForceNestedRepositories(true)`, `-n` with dry run, path filters as git's
   * pathspecs). The worktree is read as git's directory scan reads it for `git clean`
   * (a port of `read_directory` with the flags `git clean` sets, and of
   * `correct_untracked_entries`), and each entry is removed as git removes it:
   * - a file by itself;
   * - a directory (only with `-d` or a path filter) as git's `remove_dirs`: everything in
   *   it, file by file and then each directory once empty, a `.git` that is no repository
   *   included; nested repositories are skipped ("Would skip repository") unless `-ff`
   *   removes them whole; an unreadable directory is removed only when empty (`rmdir`),
   *   else kept with git's "failed to remove" warning;
   * - `cleaned` lists what `git clean -n` prints after "Would remove": a directory removed
   *   whole as `dir/`, else what went in it; `skipped` the nested repositories.
   *
   * @returns CleanResult with set of cleaned files
   */
  async call(): Promise<CleanResult> {
    this.checkCallable();
    this.setCallable(false);
    // the index as it is now (git reads it at its start); clean writes none, so unwritten
    // edits of this instance are kept and used as they are
    await this.readCurrentIndex(false);

    const worktree = this.worktreeAccess;
    if (!worktree) {
      throw new Error("CleanCommand requires a WorkingCopy with worktree");
    }
    return worktree.batch ? worktree.batch(() => this.clean(worktree)) : this.clean(worktree);
  }

  /**
   * git's `cmd_clean`: the worktree is read as git's `fill_directory` reads it (with the
   * flags `git clean` sets), the entries are corrected as `correct_untracked_entries` does,
   * and each is removed as git removes it: a file by itself, a directory by `remove_dirs`.
   */
  private async clean(worktree: Worktree): Promise<CleanResult> {
    const tracked = new Set<string>();
    const gitlinks = new Set<string>();
    for await (const entry of this.staging.entries()) {
      tracked.add(entry.path);
      if (entry.mode === FileMode.GITLINK) gitlinks.add(entry.path);
    }
    // dir.c asks the index through its name hashes, which fold case under core.ignorecase
    // (index_file_exists, directory_exists_in_index_icase); index_name_is_other stays exact
    const index = new IndexPathLookup([...tracked], {
      ignoreCase: coreBool(this.workingCopy, "ignorecase", false),
      gitlinks,
    });
    const { root, nodes } = await this.loadTree(worktree, index);
    const removeDirectories = this.directories || this.paths.size > 0;
    const pathspec = parsePathspec([...this.paths], { attr: true });
    // `:(attr:...)`: the attributes of the files and directories read (a directory's by its
    // name with its "/", as dir.c matches it)
    const attributes = PathspecAttributes.forWorktree(pathspec, worktree);
    await attributes?.load([...nodes].map(([path, n]) => (n.directory ? `${path}/` : path)));
    await attributes?.load(nodes.keys());
    const scan = new DirectoryScan({
      nodes,
      tracked,
      index,
      pathspec,
      // -x: no ignore rules at all (git does not set up the standard excludes)
      excludes: this.ignoredOnly || this.ignore,
      showIgnored: this.ignoredOnly,
      showIgnoredToo: removeDirectories && !this.ignoredOnly,
      modeMatching: removeDirectories && !this.ignoredOnly && this.ignore,
      skipNestedGit: !this.forceNested,
    });
    scan.readDirectory(root);
    const entries = scan.correctedEntries();

    // what git deletes: entries the index does not have; directories only with -d (or a
    // path filter)
    const files: string[] = [];
    const dirs: CleanNode[] = [];
    for (const name of entries) {
      if (!scan.isOther(name)) continue;
      const path = name.endsWith("/") ? name.slice(0, -1) : name;
      const n = nodes.get(path);
      if (!n) continue;
      if (n.directory) {
        if (removeDirectories) dirs.push(n);
      } else if (isValidWorktreePath(path)) files.push(path);
    }
    return this.removeEntries(worktree, files, dirs, scan.warnings);
  }

  /**
   * The worktree as `git clean` sees it, as a tree: every entry (ignored ones too), nested
   * repositories (not entered), `.git` entries that name no repository (entered: git
   * removes what is in them when it removes their directory) and unreadable directories.
   */
  private async loadTree(
    worktree: Worktree,
    index: IndexPathLookup,
  ): Promise<{ root: CleanNode; nodes: Map<string, CleanNode> }> {
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
      made.tracked = index.has(dir);
      made.gitDir = parent.gitDir;
      parent.children.push(made);
      nodes.set(dir, made);
      return made;
    };
    const unreadable = new Map<string, unknown>();
    const load = async (pathPrefix?: string) => {
      for await (const entry of worktree.walk({
        includeIgnored: true,
        includeDirectories: true,
        enterNonRepositoryGitDirs: true,
        onUnreadable: (path, error) => unreadable.set(path, error),
        ...(pathPrefix ? { pathPrefix } : {}),
      })) {
        const parent = parentOf(entry.path);
        // inside a nested repository (one the index tracks nothing in) or a file path: not
        // ours to look at
        if (!parent?.directory || (parent.repository && !parent.entered)) continue;
        const n = node(entry.path, entry.isDirectory);
        n.ignored = entry.isIgnored === true;
        n.tracked = index.has(entry.path);
        n.gitDir = entry.name === ".git" || parent.gitDir;
        if (entry.isDirectory && entry.mode === FileMode.GITLINK) {
          const state = worktree.repositoryState
            ? await worktree.repositoryState(entry.path)
            : worktree.isRepository && !(await worktree.isRepository(entry.path))
              ? "none"
              : "unknown";
          n.repository = state !== "none";
          // a `.git` that cannot be checked here: never removed, not even with -ff
          n.unverified = state === "unknown";
        } else if (entry.isDirectory && worktree.repositoryState) {
          // a `.git` resolving to the superproject's git directory (a link to it): no
          // nested repository for the scan (treat_directory compares the real paths), but
          // one for remove_dirs (is_nonbare_repository_dir)
          n.ownGitDir = (await worktree.repositoryState(entry.path)) === "repository";
        }
        parent.children.push(n);
        nodes.set(entry.path, n);
        // git's scan enters a directory the index tracks paths in, a repository or not
        if (n.repository && index.indexDirectory(n.path) === "directory") {
          n.entered = true;
          await load(n.path);
        }
      }
    };
    await load();
    for (const [path, error] of unreadable) {
      const n = nodes.get(path);
      if (n) {
        n.unreadable = true;
        n.unreadableError = error;
      }
    }
    return { root, nodes };
  }

  /**
   * git's removal of the entries: a file is unlinked; a directory goes through
   * `remove_dirs`, which removes everything in it (a `.git` that is no repository included,
   * whatever the ignore rules say: the directory scan already decided), skips nested
   * repositories ("Would skip repository") unless `-ff` removes them whole, and reports a
   * directory wholly removed as `dir/`, else what went in it (directories without the
   * slash). Files are removed one by one and directories once empty, deepest first; only a
   * nested repository under `-ff` is removed recursively. An unreadable directory is never
   * removed.
   */
  private async removeEntries(
    worktree: Worktree,
    files: string[],
    dirs: CleanNode[],
    warnings: string[],
  ): Promise<CleanResult> {
    const cleaned = new Set<string>();
    const skipped = new Set<string>();
    const removeFiles = [...files];
    const removeDirs: string[] = [];
    const repositories: string[] = [];
    const options = { nonRepositoryGitDirs: true };
    const tops = new Set(dirs);
    const remove = async (n: CleanNode): Promise<boolean> => {
      if (n.repository || n.ownGitDir) {
        if (!this.forceNested || n.unverified) {
          skipped.add(n.path);
          return false;
        }
        repositories.push(n.path);
        return true;
      }
      // unreadable: git's dry run takes it as gone; a real run tries rmdir, which removes it
      // only when empty ("failed to remove" otherwise, the path as remove_dirs holds it)
      if (n.unreadable) {
        if (this.dryRun) return true;
        // warning_errno: rmdir's reason (a directory that is not empty, or the error's code)
        let reason = "Directory not empty";
        const removed = await removeDirectoryIfEmpty(worktree, n.path, options).catch((error) => {
          reason = strerror(error);
          return false;
        });
        if (!removed) {
          const shown = tops.has(n) ? `${n.path}/` : n.path;
          warnings.push(`warning: failed to remove ${shown}: ${reason}`);
        }
        return removed;
      }
      const dels: string[] = [];
      let all = true;
      for (const child of n.children) {
        if (child.directory) {
          if (await remove(child)) dels.push(child.path);
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
    for (const dir of dirs) if (await remove(dir)) cleaned.add(`${dir.path}/`);

    if (!this.dryRun) {
      for (const path of removeFiles) await worktree.remove(path, options);
      // `git clean -ff`: a nested repository goes whole, as git removes it
      for (const path of repositories) await worktree.remove(path, { ...options, recursive: true });
      const deepestFirst = removeDirs.sort(
        (a, b) => b.split("/").length - a.split("/").length || (a < b ? 1 : -1),
      );
      for (const dir of deepestFirst) await removeDirectoryIfEmpty(worktree, dir, options);
    }
    return { cleaned, skipped, dryRun: this.dryRun, warnings };
  }
}

/** A worktree entry, as `git clean` sees it. */
interface CleanNode {
  path: string;
  directory: boolean;
  /** Excluded by the ignore rules (itself, or a directory above it) */
  ignored: boolean;
  /** A nested repository (a directory with a `.git` that is one) */
  repository: boolean;
  /** The index has this path (a file, link or submodule) */
  tracked?: boolean;
  /** A `.git` that is no repository, or inside one */
  gitDir?: boolean;
  /** A directory whose listing failed */
  unreadable?: boolean;
  /** What the listing of an unreadable directory failed with */
  unreadableError?: unknown;
  /** A `.git` that cannot be checked here (beyond the root, unreadable): kept always */
  unverified?: boolean;
  /** A nested repository whose content was loaded (the index tracks paths in it) */
  entered?: boolean;
  /**
   * A directory whose `.git` resolves to the superproject's own git directory: walked as
   * any other, but skipped as a repository by the removal (removed whole with `-ff`)
   */
  ownGitDir?: boolean;
  children: CleanNode[];
}

const node = (path: string, directory: boolean): CleanNode => ({
  path,
  directory,
  ignored: false,
  repository: false,
  children: [],
});

// ============ git's directory scan for clean (dir.c read_directory) ============

const PATH_NONE = 0;
const PATH_RECURSE = 1;
const PATH_EXCLUDED = 2;
const PATH_UNTRACKED = 3;

/** git's byte order of names (`name_compare`). */
function compareNames(a: string, b: string): number {
  return compareGitPaths(a, b);
}

/**
 * A port of git's `read_directory` with the flags `git clean` uses
 * (`DIR_SHOW_OTHER_DIRECTORIES`, `DIR_SKIP_NESTED_GIT` without `-ff`, `DIR_SHOW_IGNORED` for
 * `-X`, `DIR_SHOW_IGNORED_TOO` (`_MODE_MATCHING` without `-x`) and
 * `DIR_KEEP_UNTRACKED_CONTENTS` with `-d` or a path filter), over the loaded tree.
 */
class DirectoryScan {
  /** git's "could not open directory" warnings, one per directory the scan opened */
  readonly warnings: string[] = [];
  private readonly warned = new Set<string>();
  private readonly entries: string[] = [];
  private readonly ignored: string[] = [];

  constructor(
    private readonly o: {
      nodes: Map<string, CleanNode>;
      /** The index's paths, as `index_name_is_other` asks them (exactly) */
      tracked: Set<string>;
      /** The index as the name hashes answer (folding case under `core.ignorecase`) */
      index: IndexPathLookup;
      pathspec: PathspecItem[];
      excludes: boolean;
      showIgnored: boolean;
      showIgnoredToo: boolean;
      modeMatching: boolean;
      skipNestedGit: boolean;
    },
  ) {}

  private match(name: string, flags: number): number {
    return matchPathspec(this.o.pathspec, name, flags);
  }

  private get hasPathspec(): boolean {
    return this.o.pathspec.length > 0;
  }

  /** git's `index_name_is_other`: the index has no entry of that name. */
  isOther(name: string): boolean {
    return !this.o.tracked.has(name.endsWith("/") ? name.slice(0, -1) : name);
  }

  /** git's `dir_add_name`: never a path the index has (`index_file_exists`, icase too). */
  private addName(name: string): void {
    if (this.o.index.has(name)) return;
    this.entries.push(name);
  }

  private addIgnored(name: string): void {
    if (!this.isOther(name)) return;
    this.ignored.push(name);
  }

  private addResult(name: string, state: number): void {
    if (state === PATH_EXCLUDED) {
      if (this.o.showIgnored) this.addName(name);
      else if (this.o.showIgnoredToo) this.addIgnored(name);
    } else if (state === PATH_UNTRACKED) {
      if (!this.o.showIgnored) this.addName(name);
    }
  }

  /** git's `simplify_away`: no element's literal prefix can lead to `path`. */
  private simplifyAway(path: string): boolean {
    if (!this.hasPathspec) return false;
    const name = pathspecName(path);
    for (const item of this.o.pathspec) {
      const len = Math.min(item.nowildcardLen, name.length);
      if (psEqual(item, item.match.slice(0, len), name.slice(0, len))) return false;
    }
    return true;
  }

  private treatPath(n: CleanNode): number {
    const name = n.path.slice(n.path.lastIndexOf("/") + 1);
    if (name === ".git") return PATH_NONE;
    if (this.simplifyAway(n.path)) return PATH_NONE;
    if (!n.directory && n.tracked) return PATH_NONE;
    const excluded = this.o.excludes && n.ignored;
    if (excluded && !(this.o.showIgnored || this.o.showIgnoredToo)) return PATH_EXCLUDED;
    if (n.directory) return this.treatDirectory(n, `${n.path}/`, excluded);
    if (this.hasPathspec && !this.match(n.path, 0)) return PATH_NONE;
    return excluded ? PATH_EXCLUDED : PATH_UNTRACKED;
  }

  private treatDirectory(n: CleanNode, dirname: string, excluded: boolean): number {
    // git's directory_exists_in_index: the index entry of the name itself sorts first, so a
    // submodule there wins over paths below it (under core.ignorecase the directory hash is
    // asked first, folding case)
    const inIndex = this.o.index.indexDirectory(n.path);
    if (inIndex === "gitlink") return PATH_NONE;
    if (inIndex === "directory") return PATH_RECURSE;
    let matchesHow = 0;
    if (this.hasPathspec && !excluded) {
      matchesHow = this.match(dirname, DO_MATCH_LEADING_PATHSPEC);
      if (!matchesHow) return PATH_NONE;
    }
    if (n.repository) {
      if (
        this.o.skipNestedGit ||
        n.unverified ||
        matchesHow === MATCHED_RECURSIVELY_LEADING_PATHSPEC
      ) {
        return PATH_NONE;
      }
      return excluded ? PATH_EXCLUDED : PATH_UNTRACKED;
    }
    if (matchesHow === MATCHED_RECURSIVELY_LEADING_PATHSPEC) return PATH_RECURSE;
    if (excluded) return PATH_EXCLUDED;
    if (!this.o.showIgnored && !this.o.showIgnoredToo) return PATH_UNTRACKED;
    const oldIgnored = this.ignored.length;
    let state = this.readDirectoryRecursive(n);
    if (state === PATH_EXCLUDED) {
      if (this.o.showIgnoredToo && this.o.modeMatching) state = PATH_NONE;
      else this.ignored.length = oldIgnored;
    }
    if (state === PATH_NONE) state = excluded ? PATH_EXCLUDED : PATH_UNTRACKED;
    return state;
  }

  private readDirectoryRecursive(dir: CleanNode): number {
    // an unreadable directory: git cannot open it (and warns), nothing in it is seen
    if (dir.unreadable) {
      if (!this.warned.has(dir.path)) {
        this.warned.add(dir.path);
        this.warnings.push(unreadableDirectoryWarning(dir.path, dir.unreadableError));
      }
      return PATH_NONE;
    }
    let dirState = PATH_NONE;
    for (const child of dir.children) {
      let state = this.treatPath(child);
      if (state > dirState) dirState = state;
      const name = child.directory ? `${child.path}/` : child.path;
      if (state === PATH_RECURSE) {
        const sub = this.readDirectoryRecursive(child);
        if (sub > dirState) dirState = sub;
        if (this.hasPathspec && !this.match(name, 0)) state = PATH_NONE;
      }
      this.addResult(name, state);
    }
    return dirState;
  }

  /** git's `read_directory` from the pathspec's common prefix (`fill_directory`). */
  readDirectory(root: CleanNode): void {
    const prefix = this.commonPrefix();
    if (!prefix) {
      this.readDirectoryRecursive(root);
      return;
    }
    // git's treat_leading_path: each leading directory must be one to recurse into
    const parts = prefix.replace(/\/+$/, "").split("/");
    let state = PATH_NONE;
    let last: CleanNode | undefined;
    for (let k = 1; k <= parts.length; k++) {
      const n = this.o.nodes.get(parts.slice(0, k).join("/"));
      // not a directory (a link to one included: has_symlink_leading_path)
      if (!n?.directory) return;
      last = n;
      state = this.treatPath(n);
      if (state !== PATH_RECURSE) break;
    }
    if (!last) return;
    this.addResult(`${last.path}/`, state);
    if (state === PATH_RECURSE && last.path === parts.join("/")) {
      this.readDirectoryRecursive(last);
    }
  }

  /** git's `common_prefix_len`: the leading directories every element starts with. */
  private commonPrefix(): string {
    // exclude elements do not count; an icase one has no literal prefix beyond the cwd's
    // (compared as bytes: the elements are held as their bytes)
    const items = this.o.pathspec.filter((item) => !item.exclude).map(pathspecItemBytes);
    if (items.length === 0) return "";
    let max = 0;
    for (let n = 0; n < items.length; n++) {
      let i = 0;
      let len = 0;
      const itemLen = items[n].icase ? 0 : items[n].nowildcardLen;
      while (i < itemLen && (n === 0 || i < max)) {
        const c = items[n].match[i];
        if (c !== items[0].match[i]) break;
        if (c === "/") len = i + 1;
        i++;
      }
      if (n === 0 || len < max) {
        max = len;
        if (!max) break;
      }
    }
    // whole names (it ends at a "/"): the path as the worktree names it
    const bytes = items[0].match.slice(0, max);
    return decodeGitPath(Uint8Array.from(bytes, (c) => c.charCodeAt(0)));
  }

  /** git's `correct_untracked_entries`, after sorting both lists. */
  correctedEntries(): string[] {
    const entries = [...this.entries].sort(compareNames);
    const ignored = [...this.ignored].sort(compareNames);
    const contains = (out: string, inner: string) =>
      out.length < inner.length && out.endsWith("/") && inner.startsWith(out);
    const result: string[] = [];
    let ign = 0;
    for (let src = 0; src < entries.length; src++) {
      while (ign < ignored.length && compareNames(entries[src], ignored[ign]) >= 0) ign++;
      if (ign < ignored.length && contains(entries[src], ignored[ign])) continue;
      const ent = entries[src];
      result.push(ent);
      while (src + 1 < entries.length && contains(ent, entries[src + 1])) src++;
    }
    return result;
  }
}
