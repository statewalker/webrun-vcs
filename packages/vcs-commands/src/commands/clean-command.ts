import { FileMode, isValidWorktreePath } from "@statewalker/vcs-core";
import { compareGitPaths } from "@statewalker/vcs-utils/encoding";
import { directoriesOf, type Worktree, wildmatch } from "@statewalker/vcs-working-tree";
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
   * `setForceNestedRepositories(true)`, `-n` with dry run, path filters as git's
   * pathspecs). The worktree is read as git's directory scan reads it for `git clean`
   * (a port of `read_directory` with the flags `git clean` sets, and of
   * `correct_untracked_entries`), and each entry is removed as git removes it:
   * - a file by itself;
   * - a directory (only with `-d` or a path filter) as git's `remove_dirs`: everything in
   *   it, file by file and then each directory once empty, a `.git` that is no repository
   *   included; nested repositories are skipped ("Would skip repository") unless `-ff`
   *   removes them whole; an unreadable directory is never removed;
   * - `cleaned` lists what `git clean -n` prints after "Would remove": a directory removed
   *   whole as `dir/`, else what went in it; `skipped` the nested repositories.
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
    const { root, nodes } = await this.loadTree(worktree, tracked);
    const removeDirectories = this.directories || this.paths.size > 0;
    const scan = new DirectoryScan({
      nodes,
      tracked,
      trackedDirs: directoriesOf(tracked),
      gitlinks,
      pathspec: parsePathspec([...this.paths]),
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
    return this.removeEntries(worktree, files, dirs);
  }

  /**
   * The worktree as `git clean` sees it, as a tree: every entry (ignored ones too), nested
   * repositories (not entered), `.git` entries that name no repository (entered: git
   * removes what is in them when it removes their directory) and unreadable directories.
   */
  private async loadTree(
    worktree: Worktree,
    tracked: Set<string>,
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
      made.tracked = tracked.has(dir);
      made.gitDir = parent.gitDir;
      parent.children.push(made);
      nodes.set(dir, made);
      return made;
    };
    const unreadable = new Set<string>();
    const trackedDirs = directoriesOf(tracked);
    const load = async (pathPrefix?: string) => {
      for await (const entry of worktree.walk({
        includeIgnored: true,
        includeDirectories: true,
        enterNonRepositoryGitDirs: true,
        onUnreadable: (path) => unreadable.add(path),
        ...(pathPrefix ? { pathPrefix } : {}),
      })) {
        const parent = parentOf(entry.path);
        // inside a nested repository (one the index tracks nothing in) or a file path: not
        // ours to look at
        if (!parent?.directory || (parent.repository && !parent.entered)) continue;
        const n = node(entry.path, entry.isDirectory);
        n.ignored = entry.isIgnored === true;
        n.tracked = tracked.has(entry.path);
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
        }
        parent.children.push(n);
        nodes.set(entry.path, n);
        // git's scan enters a directory the index tracks paths in, a repository or not
        if (n.repository && trackedDirs.has(n.path)) {
          n.entered = true;
          await load(n.path);
        }
      }
    };
    await load();
    for (const path of unreadable) {
      const n = nodes.get(path);
      if (n) n.unreadable = true;
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
  ): Promise<CleanResult> {
    const cleaned = new Set<string>();
    const skipped = new Set<string>();
    const removeFiles = [...files];
    const removeDirs: string[] = [];
    const repositories: string[] = [];
    const remove = (n: CleanNode): boolean => {
      if (n.repository) {
        if (!this.forceNested || n.unverified) {
          skipped.add(n.path);
          return false;
        }
        repositories.push(n.path);
        return true;
      }
      // unreadable: git's dry run takes it as gone (it would try rmdir), a real run keeps it
      if (n.unreadable) return this.dryRun;
      const dels: string[] = [];
      let all = true;
      for (const child of n.children) {
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
  /** A `.git` that cannot be checked here (beyond the root, unreadable): kept always */
  unverified?: boolean;
  /** A nested repository whose content was loaded (the index tracks paths in it) */
  entered?: boolean;
  children: CleanNode[];
}

const node = (path: string, directory: boolean): CleanNode => ({
  path,
  directory,
  ignored: false,
  repository: false,
  children: [],
});

// ============ git's pathspec matching (pathspec.c, dir.c match_pathspec_item) ============

const MATCHED_RECURSIVELY = 1;
const MATCHED_RECURSIVELY_LEADING_PATHSPEC = 2;
const MATCHED_FNMATCH = 3;
const MATCHED_EXACTLY = 4;
const DO_MATCH_DIRECTORY = 1;
const DO_MATCH_LEADING_PATHSPEC = 2;
const DO_MATCH_EXCLUDE = 4;

/** One pathspec element as git's `init_pathspec_item` parses it. */
interface PathspecItem {
  /** The path from the top of the worktree (normalised), without its magic */
  match: string;
  /** The length of its leading literal part (git's `nowildcard_len`) */
  nowildcardLen: number;
  /** `*` followed by no other wildcard after the literal prefix (git's ONESTAR) */
  oneStar: boolean;
  /** `:(exclude)` / `:!` / `:^`: a path it matches is left out */
  exclude: boolean;
  /** `:(glob)`: wildmatch with WM_PATHNAME (`*` stops at `/`, `**` spans directories) */
  glob: boolean;
  /** `:(icase)`: case-insensitive */
  icase: boolean;
}

/** git's characters that may introduce short pathspec magic (`GIT_PATHSPEC_MAGIC`). */
const SHORT_MAGIC_CHARS = new Set([..."!\"#%&',-;<=>@_`~^/"]);

/**
 * The pathspec elements as git's `parse_pathspec` reads them from the top of the worktree:
 * short magic (`:/` top, `:!` and `:^` exclude) and long magic (`:(top,literal,glob,icase,
 * exclude)`), the path normalised as `prefix_path` does (`.`, `..`, repeated slashes; above
 * the top refused), and an implicit `.` when every element excludes.
 */
function parsePathspec(paths: string[]): PathspecItem[] {
  const items = paths.map(parsePathspecItem);
  if (items.length > 0 && items.every((i) => i.exclude)) {
    items.push(parsePathspecItem("."));
  }
  return items;
}

function parsePathspecItem(elem: string): PathspecItem {
  let exclude = false;
  let literal = false;
  let glob = false;
  let icase = false;
  let rest = elem;
  if (elem.startsWith(":(")) {
    const end = elem.indexOf(")");
    if (end < 0) throw new Error(`Missing ')' at the end of pathspec magic in '${elem}'`);
    for (const raw of elem.slice(2, end).split(",")) {
      const name = raw.trim();
      if (name === "" || name === "top") continue;
      if (name === "literal") literal = true;
      else if (name === "glob") glob = true;
      else if (name === "icase") icase = true;
      else if (name === "exclude") exclude = true;
      else if (name.startsWith("attr:") || name === "attr") {
        throw new Error(`Unsupported pathspec magic 'attr' in '${elem}'`);
      } else throw new Error(`Invalid pathspec magic '${name}' in '${elem}'`);
    }
    rest = elem.slice(end + 1);
  } else if (elem.startsWith(":")) {
    let pos = 1;
    for (; pos < elem.length && elem[pos] !== ":"; pos++) {
      const ch = elem[pos];
      if (ch === "!" || ch === "^") exclude = true;
      else if (ch === "/") {
        // top: the paths are from the top already
      } else if (!SHORT_MAGIC_CHARS.has(ch)) break;
      else throw new Error(`Unimplemented pathspec magic '${ch}' in '${elem}'`);
    }
    if (elem[pos] === ":") pos++;
    rest = elem.slice(pos);
  }
  if (literal && glob) throw new Error("'literal' and 'glob' are incompatible");
  const match = normalizePathspecPath(rest, elem);
  let nowildcardLen = match.length;
  if (!literal) {
    nowildcardLen = 0;
    while (nowildcardLen < match.length && !isGlobSpecial(match[nowildcardLen])) nowildcardLen++;
  }
  const after = match.slice(nowildcardLen + 1);
  const oneStar =
    !glob &&
    nowildcardLen < match.length &&
    match[nowildcardLen] === "*" &&
    ![...after].some((c) => isGlobSpecial(c));
  return { match, nowildcardLen, oneStar, exclude, glob, icase };
}

const isGlobSpecial = (c: string) => c === "*" || c === "?" || c === "[" || c === "\\";

/** git's `normalize_path_copy` of a path from the top (trailing slash kept; "." is ""). */
function normalizePathspecPath(path: string, elem: string): string {
  const trailing = path.endsWith("/") && path.replace(/\/+$/, "") !== "";
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) throw new Error(`'${elem}' is outside repository`);
      out.pop();
    } else out.push(part);
  }
  const joined = out.join("/");
  return joined && trailing ? `${joined}/` : joined;
}

/** git's `ps_strncmp` / `ps_strcmp`: equal, case-insensitively for `:(icase)`. */
const psEqual = (item: PathspecItem, a: string, b: string) =>
  item.icase ? a.toLowerCase() === b.toLowerCase() : a === b;

/** git's `git_fnmatch` of an element against a name. */
function pathspecFnmatch(item: PathspecItem, name: string): boolean {
  const prefix = item.nowildcardLen;
  if (prefix > 0 && !psEqual(item, name.slice(0, prefix), item.match.slice(0, prefix))) {
    return false;
  }
  const string = name.slice(prefix);
  const pattern = item.match.slice(prefix);
  if (item.oneStar) {
    const tail = pattern.slice(1);
    return (
      string.length >= tail.length && psEqual(item, string.slice(string.length - tail.length), tail)
    );
  }
  return wildmatch(pattern, string, { pathname: item.glob, casefold: item.icase });
}

/** git's `match_pathspec_item`. */
function matchPathspecItem(item: PathspecItem, name: string, flags: number): number {
  const { match } = item;
  const matchlen = match.length;
  const namelen = name.length;
  if (matchlen === 0) return MATCHED_RECURSIVELY;
  if (matchlen <= namelen && psEqual(item, name.slice(0, matchlen), match)) {
    if (matchlen === namelen) return MATCHED_EXACTLY;
    if (match[matchlen - 1] === "/" || name[matchlen] === "/") return MATCHED_RECURSIVELY;
  } else if (
    flags & DO_MATCH_DIRECTORY &&
    match[matchlen - 1] === "/" &&
    namelen === matchlen - 1 &&
    psEqual(item, match.slice(0, namelen), name)
  ) {
    return MATCHED_EXACTLY;
  }
  if (item.nowildcardLen < matchlen && pathspecFnmatch(item, name)) return MATCHED_FNMATCH;
  if (flags & DO_MATCH_LEADING_PATHSPEC && !(flags & DO_MATCH_EXCLUDE)) {
    const offset = name.endsWith("/") ? 1 : 0;
    if (
      namelen < matchlen &&
      match[namelen - offset] === "/" &&
      psEqual(item, match.slice(0, namelen), name)
    ) {
      return MATCHED_RECURSIVELY_LEADING_PATHSPEC;
    }
    const n = item.nowildcardLen;
    if (n < matchlen && !psEqual(item, name.slice(0, n), match.slice(0, n))) return 0;
    if (n === matchlen) return 0;
    return MATCHED_RECURSIVELY_LEADING_PATHSPEC;
  }
  return 0;
}

/** git's `match_pathspec_with_flags`: the best positive match, unless an exclude matches. */
function matchPathspec(items: PathspecItem[], name: string, flags: number): number {
  if (items.length === 0) return MATCHED_RECURSIVELY;
  let positive = 0;
  for (const item of items) {
    if (!item.exclude) positive = Math.max(positive, matchPathspecItem(item, name, flags));
  }
  if (!positive || !items.some((i) => i.exclude)) return positive;
  for (const item of items) {
    if (item.exclude && matchPathspecItem(item, name, flags | DO_MATCH_EXCLUDE)) return 0;
  }
  return positive;
}

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
  private readonly entries: string[] = [];
  private readonly ignored: string[] = [];

  constructor(
    private readonly o: {
      nodes: Map<string, CleanNode>;
      tracked: Set<string>;
      trackedDirs: Set<string>;
      gitlinks: Set<string>;
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

  private addName(name: string): void {
    if (this.o.tracked.has(name)) return;
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
    for (const item of this.o.pathspec) {
      const len = Math.min(item.nowildcardLen, path.length);
      if (psEqual(item, item.match.slice(0, len), path.slice(0, len))) return false;
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
    // submodule there wins over paths below it
    if (this.o.gitlinks.has(n.path)) return PATH_NONE;
    if (this.o.trackedDirs.has(n.path)) return PATH_RECURSE;
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
    // an unreadable directory: git cannot open it, nothing in it is seen
    if (dir.unreadable) return PATH_NONE;
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
    const items = this.o.pathspec.filter((item) => !item.exclude);
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
    return items[0].match.slice(0, max);
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
