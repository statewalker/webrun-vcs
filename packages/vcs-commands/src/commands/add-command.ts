import { FileMode } from "@statewalker/vcs-core";
import { compareGitPaths } from "@statewalker/vcs-utils/encoding";
import type { StagingEntry, Worktree, WorktreeEntry } from "@statewalker/vcs-working-tree";

import {
  AddFailedError,
  IncompatibleOptionsError,
  InvalidArgumentError,
  NoFilepatternError,
  StoreNotAvailableError,
} from "../errors/index.js";
import { GitCommand } from "../git-command.js";
import { worktreeModeTrust } from "./core-config.js";
import { AddToIndexError, IndexAdder, readGitlinkHead } from "./index-adder.js";
import { configBool } from "./merge-config.js";
import {
  DO_MATCH_DIRECTORY,
  excludeMatchesPathspec,
  matchPathspec,
  matchPathspecSeen,
  type PathspecItem,
  parsePathspec,
  pathspecErrors,
  pathspecItemPath,
} from "./pathspec.js";
/**
 * Result of AddCommand execution.
 *
 * Contains lists of affected paths.
 */
export interface AddResult {
  /** Paths that were added or updated in the index */
  readonly added: string[];

  /** Paths that were skipped (ignored files the pathspec matches) */
  readonly skipped: string[];

  /**
   * The ignored paths git reports ("The following paths are ignored by one of your
   * .gitignore files"): those the pathspec names, not merely matches. When there are any,
   * `call` writes the index and then rejects with an `AddFailedError` carrying this result.
   */
  readonly ignored: string[];

  /** Paths that were removed from index (deleted files in --all mode) */
  readonly removed: string[];

  /** Total number of files processed */
  readonly totalProcessed: number;

  /**
   * The warnings git prints while adding (`core.safecrlf=warn`: "in the working copy of
   * 'x', LF will be replaced by CRLF the next time Git touches it"), in order
   */
  readonly warnings: string[];

  /**
   * What `git add --verbose` (and `--dry-run`) prints: `add '<path>'` for each path given a
   * new entry, `remove '<path>'` for each removed, in git's order
   */
  readonly output: string[];
}

/**
 * Command to stage files from working tree to index.
 *
 * Based on JGit's AddCommand. Provides fluent builder API
 * for staging files with various options.
 */
export class AddCommand extends GitCommand<AddResult> {
  private filepatterns: string[] = [];
  private update = false;
  private all: boolean | undefined;
  private force = false;
  private intentToAdd = false;
  private renormalize = false;
  private dryRun = false;
  private ignoreMissing = false;
  private ignoreErrors: boolean | undefined;
  private warnEmbeddedRepo = true;
  private worktreeIterator: Worktree | undefined;
  private writeIndex = true;

  /**
   * Only tell what would be added or removed (`git add --dry-run`): the result lists the
   * paths and `output` git's lines, nothing is stored and the index is left as it is.
   */
  setDryRun(dryRun: boolean): this {
    this.checkCallable();
    this.dryRun = dryRun;
    return this;
  }

  /**
   * With {@link setDryRun}, pass over pathspec elements that match no file, reporting the
   * ignored ones (`git add --dry-run --ignore-missing`); refused without a dry run, as git
   * refuses it.
   */
  setIgnoreMissing(ignoreMissing: boolean): this {
    this.checkCallable();
    this.ignoreMissing = ignoreMissing;
    return this;
  }

  /**
   * Go on past files that cannot be added (`git add --ignore-errors`, `add.ignoreErrors`):
   * the others are added and the index written, then `call` rejects with an
   * `AddFailedError` naming the failed paths.
   */
  setIgnoreErrors(ignoreErrors: boolean): this {
    this.checkCallable();
    this.ignoreErrors = ignoreErrors;
    return this;
  }

  /**
   * Whether adding a repository found inside the worktree warns "adding embedded git
   * repository" (default; `git add --no-warn-embedded-repo` turns it off).
   */
  setWarnEmbeddedRepo(warn: boolean): this {
    this.checkCallable();
    this.warnEmbeddedRepo = warn;
    return this;
  }

  /**
   * Add a path to a file/directory whose content should be added.
   *
   * A directory name (e.g., "src" to add "src/file1" and "src/file2")
   * can also be given to add all files in the directory recursively.
   *
   * If pattern "." is added, all changes in the repository will be added.
   *
   * Each pattern is a git pathspec from the top of the worktree (`*.ts` matches at any
   * depth, `:(glob)`, `:!` excludes, ...). As in git, `call` fails with "fatal: pathspec
   * 'x' did not match any files" (nothing changed) when one names nothing in the worktree
   * or the index, and with an `AddFailedError` (the index written) when one names ignored
   * files without {@link setForce}.
   *
   * @param filepattern Repository-relative path (with "/" as separator)
   * @returns this for chaining
   */
  addFilepattern(filepattern: string): this {
    this.checkCallable();
    this.filepatterns.push(filepattern);
    return this;
  }

  /**
   * Set whether to only match against already tracked files.
   *
   * If true, stages modified tracked files and removes deleted
   * tracked files from index, but never adds new files.
   *
   * Equivalent to `git add -u`.
   *
   * @param update Whether to only update tracked files
   * @returns this for chaining
   */
  setUpdate(update: boolean): this {
    this.checkCallable();
    this.update = update;
    return this;
  }

  /**
   * Whether update mode is enabled.
   */
  isUpdate(): boolean {
    return this.update;
  }

  /**
   * Set whether to also stage deletions.
   *
   * If true, removed files in the working tree will be
   * removed from the index as well.
   *
   * Equivalent to `git add -A` or `git add --all`.
   *
   * @param all Whether to stage deletions
   * @returns this for chaining
   */
  setAll(all: boolean): this {
    this.checkCallable();
    this.all = all;
    return this;
  }

  /**
   * Whether --all mode is enabled.
   */
  isAll(): boolean {
    return this.all === true;
  }

  /**
   * Set whether to add ignored files.
   *
   * If true, files normally ignored by .gitignore will be added.
   *
   * Equivalent to `git add -f` or `git add --force`.
   *
   * @param force Whether to add ignored files
   * @returns this for chaining
   */
  setForce(force: boolean): this {
    this.checkCallable();
    this.force = force;
    return this;
  }

  /**
   * Whether force mode is enabled.
   */
  isForce(): boolean {
    return this.force;
  }

  /**
   * Set whether to only record intent to add.
   *
   * If true, files are added as "intent to add" placeholders
   * without staging their content.
   *
   * Equivalent to `git add -N` or `git add --intent-to-add`.
   *
   * @param intentToAdd Whether to only record intent
   * @returns this for chaining
   */
  setIntentToAdd(intentToAdd: boolean): this {
    this.checkCallable();
    this.intentToAdd = intentToAdd;
    return this;
  }

  /**
   * Whether intent-to-add mode is enabled.
   */
  isIntentToAdd(): boolean {
    return this.intentToAdd;
  }

  /**
   * Apply the clean conversion freshly to every tracked file and add it again, whatever its
   * stat says (`git add --renormalize`): after a change of `.gitattributes` or
   * `core.autocrlf`, the index takes the line endings the new settings give. CRLF already in
   * the index does not hold the conversion back. Implies {@link setUpdate} (tracked files
   * only).
   *
   * @param renormalize Whether to renormalise
   * @returns this for chaining
   */
  setRenormalize(renormalize: boolean): this {
    this.checkCallable();
    this.renormalize = renormalize;
    return this;
  }

  /**
   * Whether renormalisation is enabled.
   */
  isRenormalize(): boolean {
    return this.renormalize;
  }

  /**
   * Set a custom working tree iterator.
   *
   * Allows using a custom implementation for filesystem access.
   *
   * @param iterator Custom working tree iterator
   * @returns this for chaining
   */
  setWorktreeStore(iterator: Worktree): this {
    this.checkCallable();
    this.worktreeIterator = iterator;
    return this;
  }

  /**
   * Whether the index is written at the end (the default). Without, the staging area is
   * only updated in memory and the caller writes it: git commit's partial commit
   * (`add_remove_files`), whose index is written only once the commit is made.
   *
   * @internal
   */
  setWriteIndex(write: boolean): this {
    this.checkCallable();
    this.writeIndex = write;
    return this;
  }

  /**
   * Execute the add command.
   *
   * @returns Result with lists of added, skipped, and removed paths
   * @throws NoFilepatternError if no file patterns specified and not in update/all mode
   * @throws Error if working tree iterator not available
   */
  async call(): Promise<AddResult> {
    this.checkCallable();
    this.setCallable(false);
    // the index as it is now, before the worktree or a ref is touched: one another writer
    // replaced is read again (git reads the index at its start), unless this instance holds
    // unwritten edits (refused)
    await this.readCurrentIndex();

    // Validate options - update and all are mutually exclusive
    if (this.update && this.all !== undefined) {
      throw new IncompatibleOptionsError(["--update", "--all/--no-all"]);
    }
    if (this.ignoreMissing && !this.dryRun) {
      throw new InvalidArgumentError(
        "ignoreMissing",
        true,
        "fatal: the option '--ignore-missing' requires '--dry-run'",
      );
    }
    // git's require_pathspec ("Nothing specified, nothing added."); a renormalisation
    // without one covers every tracked file here
    if (this.filepatterns.length === 0 && !(this.update || this.all === true || this.renormalize)) {
      throw new NoFilepatternError("At least one file pattern is required");
    }

    let items: PathspecItem[];
    try {
      items = parsePathspec(this.filepatterns);
    } catch (error) {
      throw new InvalidArgumentError(
        "filepattern",
        this.filepatterns,
        `fatal: ${(error as Error).message}`,
      );
    }
    // the elements as given (and the "." git adds when every element excludes)
    const originals =
      items.length > this.filepatterns.length
        ? [...this.filepatterns, "."]
        : [...this.filepatterns];

    // Get working tree iterator
    const worktree = this.getWorktreeIterator();
    if (!worktree) {
      throw new StoreNotAvailableError(
        "Worktree",
        "Working tree iterator not available. " +
          "Ensure WorkingCopy has worktree or call setWorktreeStore().",
      );
    }

    // one worktree batch: the ignore rules, the configuration and the attributes files are
    // read once for all the files
    const run = () =>
      this.renormalize
        ? this.renormalizeFiles(worktree, items, originals)
        : this.processFiles(worktree, items, originals);
    return worktree.batch ? worktree.batch(run) : run();
  }

  /**
   * Get working tree iterator from store or explicitly set.
   */
  private getWorktreeIterator(): Worktree | undefined {
    if (this.worktreeIterator) {
      return this.worktreeIterator;
    }

    // Get worktree from WorkingCopy
    return this.worktreeAccess;
  }

  /** `add.ignoreErrors` (or `add.ignore-errors`) unless set on the command. */
  private ignoringErrors(): boolean {
    if (this.ignoreErrors !== undefined) return this.ignoreErrors;
    try {
      return (
        configBool(this.workingCopy, "add.ignoreErrors", false) ||
        configBool(this.workingCopy, "add.ignore-errors", false)
      );
    } catch {
      return false;
    }
  }

  /** `advice.<name>`, true unless the configuration turns it off. */
  private advice(name: string): boolean {
    try {
      return configBool(this.workingCopy, `advice.${name}`, true);
    } catch {
      return true;
    }
  }

  /**
   * git's `cmd_add` without `--renormalize`:
   *
   * 1. the untracked files the pathspec matches are found (`fill_directory`, unless `-u`),
   *    ignored ones the pathspec names collected for the report, a repository inside the
   *    worktree found as one entry (a gitlink to come);
   * 2. an element that matched nothing, in the worktree or the index, names no file: git's
   *    "fatal: pathspec '<element>' did not match any files" before anything changes;
   * 3. the tracked paths the pathspec matches are brought up to date (`add_files_to_cache`):
   *    a file gone, or a directory in its place that holds no repository with a commit, is
   *    removed (unless `--no-all`), a changed one added again, a conflict resolved;
   * 4. the untracked files are added (`add_files`), and the index written; ignored paths,
   *    or files `--ignore-errors` passed over, then fail the command (git's exit status 1).
   */
  private async processFiles(
    worktree: Worktree,
    items: PathspecItem[],
    originals: string[],
  ): Promise<AddResult> {
    const added: string[] = [];
    const skipped: string[] = [];
    const removed: string[] = [];
    const warnings: string[] = [];
    const output: string[] = [];
    const ignoreErrors = this.ignoringErrors();
    const addNewFiles = !this.update;
    // `-A` (the default with a pathspec), or `-u`: removals are staged; `--no-all` keeps them
    const ignoreRemoval = !(this.update || this.all !== false);

    const index = await this.indexGroups();
    const indexPaths = new Set(index.map((g) => g.path));

    // 1. the untracked files (git's fill_directory and prune_directory)
    const seen = items.map(() => 0);
    const untracked: Array<{ path: string; entry: WorktreeEntry; repository: boolean }> = [];
    let ignored: string[] = [];
    if (addNewFiles) {
      const scan = await this.scanUntracked(worktree, items, indexPaths, seen);
      untracked.push(...scan.untracked);
      skipped.push(...scan.skipped);
      ignored = scan.ignored;
    }
    // what the index has matches too (add_pathspec_matches_against_index)
    // (a skip-worktree path matches here too, where git advises on it instead)
    for (const group of index) {
      matchPathspecSeen(items, group.path, group.gitlink ? DO_MATCH_DIRECTORY : 0, seen);
    }

    // 2. an element that matched nothing must name an existing file
    for (let i = 0; i < items.length; i++) {
      const item = items[i] as PathspecItem;
      if (item.exclude || seen[i]) continue;
      // "Don't complain at 'git add .' on empty repo"
      if (item.match === "") continue;
      const path = pathspecItemPath(item).replace(/\/+$/, "");
      if (item.glob || item.icase || !(await worktree.getEntry(path))) {
        if (!this.ignoreMissing) {
          throw new InvalidArgumentError(
            "filepattern",
            originals[i],
            `fatal: pathspec '${originals[i]}' did not match any files`,
          );
        }
        if (await worktree.isIgnored(path)) ignored.push(path);
      }
    }

    const trust = worktreeModeTrust(this.workingCopy, worktree);
    const adder = await IndexAdder.open(this.staging, this.blobs, trust, { pretend: this.dryRun });
    const failed: string[] = [];
    const errors: string[] = [];
    const addOne = async (
      path: string,
      entry: WorktreeEntry,
      displayPath: string,
    ): Promise<"ok" | "failed"> => {
      try {
        const outcome = await adder.add(worktree, path, entry, {
          intentToAdd: this.intentToAdd,
          displayPath,
          onWarning: (message) => warnings.push(message),
        });
        added.push(path);
        if (outcome === "added") output.push(`add '${displayPath}'`);
        return "ok";
      } catch (error) {
        if (!(error instanceof AddToIndexError)) throw error;
        errors.push(...error.lines);
        failed.push(path);
        return "failed";
      }
    };

    // 3. the tracked paths (add_files_to_cache: run_diff_files and update_callback)
    const psMatched = items.map(() => 0);
    for (const group of index) {
      const { path, entries } = group;
      const flags = group.gitlink ? DO_MATCH_DIRECTORY : 0;
      if (!matchPathspecSeen(items, path, flags, psMatched)) continue;
      const first = entries[0] as StagingEntry;
      const unmerged = first.stage !== 0;
      // up to date by promise: skip-worktree, assume-unchanged (CE_VALID)
      if (!unmerged && (first.skipWorktree || first.assumeValid)) continue;
      const current = await worktree.getEntry(path);
      const gone = await this.isRemoved(worktree, first, current);
      if (gone && !ignoreRemoval) {
        adder.remove(path);
        removed.push(path);
        output.push(`remove '${path}'`);
        continue;
      }
      if (gone && !unmerged) continue;
      if (!current) {
        // an unmerged path asked to be added (`--no-all`) that is not there
        throw new AddFailedError(`fatal: unable to stat '${path}': No such file or directory`);
      }
      // an unpopulated submodule is no change (no commit checked out to compare)
      if (!unmerged && first.mode === FileMode.GITLINK && current.isDirectory) {
        if (!(await readGitlinkHead(worktree, path))) continue;
      }
      if ((await addOne(path, current, path)) === "failed" && !ignoreErrors) {
        throw new AddFailedError(
          [...errors, "fatal: updating files failed"].join("\n"),
          [],
          failed,
        );
      }
    }
    if (this.update && !ignoreErrors) {
      const problems = pathspecErrors(originals, psMatched);
      if (problems.length > 0) {
        throw new InvalidArgumentError(
          "filepattern",
          originals.filter((_, i) => !psMatched[i]),
          problems.join("\n"),
        );
      }
    }

    // 4. the untracked files (add_files)
    const messages: string[] = [];
    if (ignored.length > 0) {
      messages.push("The following paths are ignored by one of your .gitignore files:", ...ignored);
      if (this.advice("addIgnoredFile")) {
        messages.push(
          "hint: Use -f if you really want to add them.",
          'hint: Disable this message with "git config set advice.addIgnoredFile false"',
        );
      }
    }
    let advisedEmbedded = false;
    for (const file of untracked) {
      const displayPath = file.repository ? `${file.path}/` : file.path;
      if ((await addOne(file.path, file.entry, displayPath)) === "failed") {
        if (!ignoreErrors) {
          throw new AddFailedError(
            [...messages, ...errors, "fatal: adding files failed"].join("\n"),
            ignored,
            failed,
          );
        }
        continue;
      }
      if (file.repository && this.warnEmbeddedRepo) {
        warnings.push(`warning: adding embedded git repository: ${file.path}`);
        if (!advisedEmbedded && this.advice("addEmbeddedRepo")) {
          advisedEmbedded = true;
          warnings.push(...embeddedRepoAdvice(file.path));
        }
      }
    }

    await adder.finish();
    // Persist staging changes (required for FileStagingStore)
    if (this.writeIndex && !this.dryRun) await this.staging.write();

    const result: AddResult = {
      added,
      skipped,
      ignored,
      removed,
      totalProcessed: added.length + removed.length,
      warnings,
      output,
    };
    if (ignored.length > 0 || failed.length > 0) {
      throw new AddFailedError([...messages, ...errors].join("\n"), ignored, failed, result);
    }
    return result;
  }

  /**
   * git's `check_removed` for the index entry `entry` and what the worktree has at its path
   * (`current`): missing, or a directory where a file was that is no repository with a
   * commit checked out (a gitlink keeps its directory, populated or not).
   */
  private async isRemoved(
    worktree: Worktree,
    entry: StagingEntry,
    current: WorktreeEntry | undefined,
  ): Promise<boolean> {
    if (!current) return true;
    if (!current.isDirectory || entry.mode === FileMode.GITLINK) return false;
    return !(await readGitlinkHead(worktree, entry.path));
  }

  /** The index's entries, every stage, grouped by path in the index's order. */
  private async indexGroups(): Promise<IndexGroup[]> {
    const groups: IndexGroup[] = [];
    const list = this.staging.entryList?.();
    const entries: Iterable<StagingEntry> | AsyncIterable<StagingEntry> =
      list ?? this.staging.entries();
    let last: IndexGroup | undefined;
    for await (const entry of entries) {
      if (last && last.path === entry.path) {
        last.entries.push(entry);
        continue;
      }
      last = { path: entry.path, entries: [entry], gitlink: entry.mode === FileMode.GITLINK };
      groups.push(last);
    }
    return groups;
  }

  /**
   * git's `fill_directory` with `DIR_COLLECT_IGNORED` and `prune_directory`: the untracked
   * files the pathspec matches (marking `seen`), a repository inside the worktree as one
   * entry (`sub/`), and the ignored paths the pathspec names (the topmost ignored directory
   * or file: git does not look inside an ignored directory). With `--force` nothing is
   * ignored.
   */
  private async scanUntracked(
    worktree: Worktree,
    items: PathspecItem[],
    indexPaths: Set<string>,
    seen: number[],
  ): Promise<{
    untracked: Array<{ path: string; entry: WorktreeEntry; repository: boolean }>;
    skipped: string[];
    ignored: string[];
  }> {
    const untracked: Array<{ path: string; entry: WorktreeEntry; repository: boolean }> = [];
    const skipped: string[] = [];
    const ignored: string[] = [];
    const trackedDirs = new Set<string>();
    for (const path of indexPaths) {
      for (let at = path.indexOf("/"); at >= 0; at = path.indexOf("/", at + 1)) {
        trackedDirs.add(path.slice(0, at));
      }
    }
    const ignoredDirs = new Set<string>();
    const prefix = await this.walkPrefix(worktree, items);
    if (prefix && !this.force) {
      // the topmost ignored directory on the way down to the prefix stands for all in it
      for (let at = 0; at >= 0 && at <= prefix.length; ) {
        const next = prefix.indexOf("/", at);
        const dir = next < 0 ? prefix : prefix.slice(0, next);
        if (await worktree.isIgnored(dir)) {
          ignoredDirs.add(prefix);
          if (!indexPaths.has(dir) && excludeMatchesPathspec(items, dir)) ignored.push(dir);
          break;
        }
        at = next < 0 ? -1 : next + 1;
      }
    }
    const parentOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));
    for await (const entry of worktree.walk({
      includeIgnored: true,
      includeDirectories: true,
      ...(prefix ? { pathPrefix: prefix } : {}),
    })) {
      const parent = parentOf(entry.path);
      const underIgnored = parent !== "" && ignoredDirs.has(parent);
      if (!this.force && (entry.isIgnored || underIgnored)) {
        if (entry.isDirectory) ignoredDirs.add(entry.path);
        if (indexPaths.has(entry.path)) continue;
        if (!entry.isDirectory && matchPathspec(items, entry.path, 0)) skipped.push(entry.path);
        if (!underIgnored && excludeMatchesPathspec(items, entry.path)) ignored.push(entry.path);
        continue;
      }
      if (entry.isDirectory) {
        // a repository of its own, nothing of it tracked: one entry, `sub/`
        if (
          entry.mode === FileMode.GITLINK &&
          !indexPaths.has(entry.path) &&
          !trackedDirs.has(entry.path) &&
          (worktree.isRepository ? await worktree.isRepository(entry.path) : true) &&
          matchPathspecSeen(items, entry.path, DO_MATCH_DIRECTORY, seen)
        ) {
          untracked.push({ path: entry.path, entry, repository: true });
        }
        continue;
      }
      if (indexPaths.has(entry.path)) continue;
      if (matchPathspecSeen(items, entry.path, 0, seen)) {
        untracked.push({ path: entry.path, entry, repository: false });
      }
    }
    // git's order: the names' bytes, a directory's with its "/"
    const key = (u: { path: string; repository: boolean }) =>
      u.repository ? `${u.path}/` : u.path;
    untracked.sort((a, b) => compareGitPaths(key(a), key(b)));
    ignored.sort(compareGitPaths);
    return { untracked, skipped, ignored };
  }

  /**
   * The directory every positive element's literal part lies in, where the scan for
   * untracked files can start (empty: the whole worktree). A real directory of the
   * worktree, never a link or a repository of its own.
   */
  private async walkPrefix(worktree: Worktree, items: PathspecItem[]): Promise<string> {
    const positive = items.filter((i) => !i.exclude);
    if (positive.length === 0 || positive.some((i) => i.icase || i.prefix !== undefined)) {
      return "";
    }
    let common: string | undefined;
    for (const item of positive) {
      const literal = item.match.slice(0, item.nowildcardLen);
      const cut = literal.lastIndexOf("/");
      const dirBytes = cut < 0 ? "" : literal.slice(0, cut);
      const dir = item.bytes ? decodeBytes(dirBytes) : dirBytes;
      if (common === undefined) common = dir;
      else {
        while (common !== "" && dir !== common && !dir.startsWith(`${common}/`)) {
          common = common.slice(0, Math.max(0, common.lastIndexOf("/")));
        }
      }
      if (common === "") return "";
    }
    let dir = common ?? "";
    while (dir !== "") {
      const entry = await worktree.getEntry(dir);
      if (entry?.isDirectory && entry.mode !== FileMode.GITLINK) return dir;
      dir = dir.slice(0, Math.max(0, dir.lastIndexOf("/")));
    }
    return "";
  }

  /**
   * git's `renormalize_tracked_files`: every tracked regular file and link (stage 0, not
   * skip-worktree) the pathspec matches is added again, cleaned with renormalisation (each
   * one's cache-tree path invalidated, as `add_index_entry` does, its content changed or
   * not). An element that matches nothing tracked must name an existing file.
   */
  private async renormalizeFiles(
    worktree: Worktree,
    items: PathspecItem[],
    originals: string[],
  ): Promise<AddResult> {
    const added: string[] = [];
    const warnings: string[] = [];
    const output: string[] = [];
    const index = await this.indexGroups();
    const seen = items.map(() => 0);
    for (const group of index) {
      matchPathspecSeen(items, group.path, group.gitlink ? DO_MATCH_DIRECTORY : 0, seen);
    }
    for (let i = 0; i < items.length; i++) {
      const item = items[i] as PathspecItem;
      if (item.exclude || seen[i] || item.match === "") continue;
      const path = pathspecItemPath(item).replace(/\/+$/, "");
      if (item.glob || item.icase || !(await worktree.getEntry(path))) {
        throw new InvalidArgumentError(
          "filepattern",
          originals[i],
          `fatal: pathspec '${originals[i]}' did not match any files`,
        );
      }
    }
    const trust = worktreeModeTrust(this.workingCopy, worktree);
    const adder = await IndexAdder.open(this.staging, this.blobs, trust, { pretend: this.dryRun });
    for (const { path, entries } of index) {
      const entry = entries[0] as StagingEntry;
      if (entry.stage !== 0 || entry.skipWorktree) continue;
      const kind = entry.mode & 0o170000;
      if (kind !== 0o100000 && kind !== 0o120000) continue;
      if (!matchPathspec(items, path, 0)) continue;
      const worktreeEntry = await worktree.getEntry(path);
      // git's add_file_to_index dies on a tracked file it cannot stat (the index is left
      // as it was)
      if (!worktreeEntry) {
        throw new Error(`unable to stat '${path}': No such file or directory`);
      }
      if (worktreeEntry.isDirectory) continue;
      const outcome = await adder.add(worktree, path, worktreeEntry, {
        renormalize: true,
        onWarning: (message) => warnings.push(message),
      });
      if (outcome === "added") output.push(`add '${path}'`);
      added.push(path);
    }
    await adder.finish();
    if (this.writeIndex && !this.dryRun) await this.staging.write();
    return {
      added,
      skipped: [],
      ignored: [],
      removed: [],
      totalProcessed: added.length,
      warnings,
      output,
    };
  }
}

/** The index entries of one path (its stages, in order). */
interface IndexGroup {
  path: string;
  entries: StagingEntry[];
  gitlink: boolean;
}

/** A string of one character per byte, decoded as a path. */
function decodeBytes(bytes: string): string {
  return pathspecItemPath({ match: bytes, bytes: true } as PathspecItem);
}

/** git's advice after the first embedded repository added (`advice.addEmbeddedRepo`). */
function embeddedRepoAdvice(path: string): string[] {
  return [
    "hint: You've added another git repository inside your current repository.",
    "hint: Clones of the outer repository will not contain the contents of",
    "hint: the embedded repository and will not know how to obtain it.",
    "hint: If you meant to add a submodule, use:",
    "hint:",
    `hint: \tgit submodule add <url> ${path}`,
    "hint:",
    "hint: If you added this path by mistake, you can remove it from the",
    "hint: index with:",
    "hint:",
    `hint: \tgit rm --cached ${path}`,
    "hint:",
    'hint: See "git help submodule" for more information.',
    'hint: Disable this message with "git config set advice.addEmbeddedRepo false"',
  ];
}
