import { FileMode } from "@statewalker/vcs-core";
import { compareGitPaths } from "@statewalker/vcs-utils/encoding";
import {
  applyStatUpdate,
  compareWithWorktree,
  type IndexStatUpdate,
  type NestedRepositoryState,
  type SparseCheckoutPatterns,
  type StagingEntry,
  statUpdateOf,
  unreadableDirectoryWarning,
  type Worktree,
  type WorktreeEntry,
  withWorktreeEntries,
} from "@statewalker/vcs-working-tree";

import {
  AddFailedError,
  IncompatibleOptionsError,
  InvalidArgumentError,
  NoFilepatternError,
  StoreNotAvailableError,
} from "../errors/index.js";
import { GitCommand } from "../git-command.js";
import { worktreeModeTrust } from "./core-config.js";
import {
  AddToIndexError,
  chmodIndexEntries,
  gitlinkHeadState,
  IndexAdder,
  readGitlinkHead,
} from "./index-adder.js";
import { configBool } from "./merge-config.js";
import {
  DO_MATCH_DIRECTORY,
  DO_MATCH_LEADING_PATHSPEC,
  excludeMatchesPathspec,
  matchPathspec,
  matchPathspecSeen,
  type PathspecItem,
  type PathspecOriginStyle,
  parsePathspec,
  pathspecErrors,
  pathspecItemPath,
} from "./pathspec.js";
import { sparsePathAdvice } from "./sparse-checkout-support.js";
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
  private chmod: string | undefined;
  private refreshOnly = false;
  private compatibility: PathspecOriginStyle = "2.56";
  /** The sparse checkout's patterns, read at the start (undefined: not a sparse checkout) */
  private sparsePatterns?: SparseCheckoutPatterns;
  private verbose = false;

  /**
   * `git add --chmod=(+|-)x`: after adding, the index entries of the regular files the
   * pathspec matches get the executable bit set (`+x`) or cleared (`-x`), the files on disk
   * left as they are. Only with a pathspec, as in git. An entry that is no regular file (a
   * symbolic link, a submodule) is not changed: git's "error: cannot chmod +x '<path>'",
   * the command then rejects with `AddFailedError` after writing the index. Any other value
   * throws git's "fatal: --chmod param '<value>' must be either -x or +x".
   */
  setChmod(chmod: string | undefined): this {
    this.checkCallable();
    this.chmod = chmod;
    return this;
  }

  /**
   * `git add --refresh`: nothing is added; the index entries the pathspec matches whose
   * files still hold their content get the files' fresh stat (git's `refresh_index`). The
   * result's `output` holds what git prints: "<path>: needs merge" for a conflicted path,
   * and with {@link setVerbose} the porcelain lines ("Unstaged changes after refreshing
   * the index:", then `M`, `D`, `T`, `A` or `U`, a tab and the path) of every entry that
   * differs. An element that matches no entry throws git's "fatal: pathspec '<p>' did not
   * match any files" before the index is written.
   */
  setRefresh(refresh: boolean): this {
    this.checkCallable();
    this.refreshOnly = refresh;
    return this;
  }

  /**
   * `git add --verbose`: changes what {@link setRefresh} reports (the porcelain lines);
   * the paths added and removed are in `output` either way.
   */
  setVerbose(verbose: boolean): this {
    this.checkCallable();
    this.verbose = verbose;
    return this;
  }

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
   * the index does not hold the conversion back. Only tracked files are touched; as git, it
   * needs a pathspec unless {@link setUpdate} or {@link setAll} is set.
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
   * The git version whose messages are reproduced where versions differ (default 2.56):
   * the advice's last hint, `Disable this message with "git config set advice.<name>
   * false"` in 2.5x, `"git config advice.<name> false"` in 2.43.
   */
  setCompatibility(version: PathspecOriginStyle): this {
    this.checkCallable();
    this.compatibility = version;
    return this;
  }

  /** git's closing hint of an advice (`advise_if_enabled`), as the version words it. */
  private disableHint(name: string): string {
    const command = this.compatibility === "2.43" ? "git config" : "git config set";
    return `hint: Disable this message with "${command} advice.${name} false"`;
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
    this.sparsePatterns = await this.sparseCheckoutPatterns();

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
    if (this.chmod !== undefined && !/^[+-]x$/.test(this.chmod)) {
      throw new InvalidArgumentError(
        "chmod",
        this.chmod,
        `fatal: --chmod param '${this.chmod}' must be either -x or +x`,
      );
    }
    // git's require_pathspec ("Nothing specified, nothing added."), a renormalisation
    // included: only `-u` and `-A` go without one
    if (this.filepatterns.length === 0 && !(this.update || this.all === true)) {
      throw new NoFilepatternError("Nothing specified, nothing added.");
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
    await checkSymlinkLeadingPaths(worktree, items, originals);

    // one worktree batch: the ignore rules, the configuration and the attributes files are
    // read once for all the files
    const run = () =>
      this.refreshOnly
        ? this.refreshFiles(worktree, items, originals)
        : this.renormalize
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

    // 1. the untracked files (git's fill_directory and prune_directory)
    const seen = items.map(() => 0);
    const untracked: Array<{ path: string; entry: WorktreeEntry; repository: boolean }> = [];
    let ignored: string[] = [];
    if (addNewFiles) {
      const scan = await this.scanUntracked(worktree, items, index, seen);
      untracked.push(...scan.untracked);
      skipped.push(...scan.skipped);
      warnings.push(...scan.warnings);
      ignored = scan.ignored;
    }
    // what the index has matches too (add_pathspec_matches_against_index with
    // PS_IGNORE_SKIP_WORKTREE: a skip-worktree entry is advised on instead)
    for (const group of index) {
      if (isSkipWorktree(group) || this.outsideSparse(group.path)) continue;
      matchPathspecSeen(items, group.path, group.gitlink ? DO_MATCH_DIRECTORY : 0, seen);
    }

    // 2. an element that matched nothing must name an existing file, unless it matches
    //    entries outside the sparse checkout (git's advice, the command failing in the end)
    const sparse: string[] = [];
    let skipSeen: number[] | undefined;
    for (let i = 0; i < items.length; i++) {
      const item = items[i] as PathspecItem;
      if (item.exclude || seen[i]) continue;
      skipSeen ??= skipWorktreeSeen(items, index, (path) => this.outsideSparse(path));
      if (skipSeen[i]) {
        sparse.push(originals[i] as string);
        continue;
      }
      // "Don't complain at 'git add .' on empty repo"
      if (item.match === "") continue;
      // reported as given, its "/" kept (git's dir_add_ignored of the match)
      const literal = pathspecItemPath(item);
      const path = literal.replace(/\/+$/, "");
      if (!(await namesFile(worktree, item))) {
        if (!this.ignoreMissing) {
          throw new InvalidArgumentError(
            "filepattern",
            originals[i],
            `fatal: pathspec '${originals[i]}' did not match any files`,
          );
        }
        if (await worktree.isIgnored(path, path !== literal)) ignored.push(literal);
      }
    }

    const trust = worktreeModeTrust(this.workingCopy, worktree);
    const adder = await IndexAdder.open(this.staging, this.blobs, trust, { pretend: this.dryRun });
    const failed: string[] = [];
    const errors: string[] = [];
    const addedSet = new Set<string>();
    const addOne = async (
      path: string,
      entry: WorktreeEntry,
      displayPath: string,
      indexed?: StagingEntry,
    ): Promise<"ok" | "failed"> => {
      try {
        const outcome = await adder.add(worktree, path, entry, {
          intentToAdd: this.intentToAdd,
          displayPath,
          onWarning: (message) => warnings.push(message),
          ...(indexed ? { indexed } : {}),
        });
        // a file turned repository is met twice (`add .`): tracked, then untracked
        if (!addedSet.has(path)) {
          addedSet.add(path);
          added.push(path);
        }
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
    const matched = index.filter((group) =>
      matchPathspecSeen(items, group.path, group.gitlink ? DO_MATCH_DIRECTORY : 0, psMatched),
    );
    // the stat pass over the matched paths, a chunk at a time (git's preload_index)
    const stated = (group: (typeof index)[number]) => {
      const first = group.entries[0] as StagingEntry;
      return first.stage !== 0 || !(first.skipWorktree || first.assumeValid);
    };
    for await (const { item: group, current: found } of withWorktreeEntries(
      worktree,
      matched,
      stated,
    )) {
      const { path, entries } = group;
      const first = entries[0] as StagingEntry;
      const unmerged = first.stage !== 0;
      // up to date by promise: skip-worktree, assume-unchanged (CE_VALID)
      if (found === undefined) continue;
      // update_callback passes over paths outside the sparse checkout's patterns
      if (this.outsideSparse(path)) continue;
      const current = found ?? undefined;
      if (!current && (await worktree.isSpecialFile?.(path))) {
        // a FIFO, socket or device took its place: add_to_index refuses it
        errors.push(
          `error: ${path}: can only add regular files, symbolic links or git-directories`,
        );
        failed.push(path);
        if (ignoreErrors) continue;
        throw new AddFailedError(
          [...errors, "fatal: updating files failed"].join("\n"),
          [],
          failed,
          undefined,
          output,
          warnings,
        );
      }
      const removal = await this.removalState(worktree, first, current);
      if (removal === "unknown") {
        warnings.push(unreadableRepositoryWarning(path));
        continue;
      }
      const gone = removal === "removed";
      if (gone && !ignoreRemoval) {
        adder.remove(path);
        removed.push(path);
        output.push(`remove '${path}'`);
        continue;
      }
      if (gone && !unmerged) continue;
      if (!current) {
        // an unmerged path asked to be added (`--no-all`) that is not there
        throw new AddFailedError(
          [...errors, `fatal: unable to stat '${path}': No such file or directory`].join("\n"),
          [],
          [...failed, path],
          undefined,
          output,
          warnings,
        );
      }
      // an unpopulated submodule is no change (no commit checked out to compare)
      if (!unmerged && first.mode === FileMode.GITLINK && current.isDirectory) {
        if (!(await readGitlinkHead(worktree, path))) continue;
      }
      const indexed = unmerged ? undefined : first;
      if ((await addOne(path, current, path, indexed)) === "failed" && !ignoreErrors) {
        throw new AddFailedError(
          [...errors, "fatal: updating files failed"].join("\n"),
          [],
          failed,
          undefined,
          output,
          warnings,
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
    const messages: string[] = sparse.length > 0 ? this.sparseAdvice(sparse) : [];
    if (ignored.length > 0) {
      messages.push("The following paths are ignored by one of your .gitignore files:", ...ignored);
      if (this.advice("addIgnoredFile")) {
        messages.push(
          "hint: Use -f if you really want to add them.",
          this.disableHint("addIgnoredFile"),
        );
      }
    }
    let advisedEmbedded = false;
    // add_files: an untracked file outside the sparse checkout is advised on, not added
    const sparseUntracked: string[] = [];
    for (const file of untracked) {
      // (a repository is the directory entry `sub/`, asked and advised on as such)
      const displayPath = file.repository ? `${file.path}/` : file.path;
      if (this.outsideSparse(displayPath)) {
        sparseUntracked.push(displayPath);
        continue;
      }
      if ((await addOne(file.path, file.entry, displayPath)) === "failed") {
        if (!ignoreErrors) {
          throw new AddFailedError(
            [...messages, ...errors, "fatal: adding files failed"].join("\n"),
            ignored,
            failed,
            undefined,
            output,
            warnings,
          );
        }
        continue;
      }
      if (file.repository && this.warnEmbeddedRepo) {
        warnings.push(`warning: adding embedded git repository: ${file.path}`);
        if (!advisedEmbedded && this.advice("addEmbeddedRepo")) {
          advisedEmbedded = true;
          warnings.push(...embeddedRepoAdvice(file.path), this.disableHint("addEmbeddedRepo"));
        }
      }
    }

    if (sparseUntracked.length > 0) messages.push(...this.sparseAdvice(sparseUntracked));
    await adder.finish();
    // --chmod: the entries the pathspec matches, once everything is added (chmod_pathspec)
    const chmodErrors = this.chmod && items.length > 0 ? await this.chmodEntries(items) : [];
    // Persist staging changes (required for FileStagingStore)
    if (this.writeIndex && !this.dryRun) await this.writeIfChanged();

    const result: AddResult = {
      added,
      skipped,
      ignored,
      removed,
      totalProcessed: added.length + removed.length,
      warnings,
      output,
    };
    if (
      ignored.length > 0 ||
      failed.length > 0 ||
      chmodErrors.length > 0 ||
      sparse.length > 0 ||
      sparseUntracked.length > 0
    ) {
      throw new AddFailedError(
        [...messages, ...errors, ...chmodErrors].join("\n"),
        ignored,
        failed,
        result,
        output,
        warnings,
      );
    }
    return result;
  }

  /**
   * Writes the index when this add changed it (git's `write_locked_index` with
   * `SKIP_IF_UNCHANGED`: skip-worktree flags cleared on reading alone write nothing).
   */
  private async writeIfChanged(): Promise<void> {
    if (this.staging.hasUnwrittenChanges?.() === false) return;
    await this.staging.write();
  }

  /** Whether `path` is outside the sparse checkout's patterns (git's `!path_in_sparse_checkout`). */
  private outsideSparse(path: string): boolean {
    return this.sparsePatterns !== undefined && !this.sparsePatterns.includes(path);
  }

  /** `--chmod` over the entries the pathspec matches (see {@link chmodIndexEntries}). */
  private async chmodEntries(items: PathspecItem[]): Promise<string[]> {
    const flip = (this.chmod as string)[0] as "+" | "-";
    const flags = (entry: StagingEntry) =>
      entry.mode === FileMode.GITLINK ? DO_MATCH_DIRECTORY : 0;
    return chmodIndexEntries(
      this.staging,
      flip,
      (e) => !this.outsideSparse(e.path) && matchPathspec(items, e.path, flags(e)) > 0,
      {
        pretend: this.dryRun,
      },
    );
  }

  /**
   * `git add --refresh` (git's `refresh` over `refresh_index` with `REFRESH_QUIET`, or
   * `REFRESH_IN_PORCELAIN` when verbose): the matching entries compared with their files,
   * those still holding their content given the fresh stat; the lines git prints in
   * `output`. An element that matches no entry dies before the index is written.
   */
  private async refreshFiles(
    worktree: Worktree,
    items: PathspecItem[],
    originals: string[],
  ): Promise<AddResult> {
    const output: string[] = [];
    let first = true;
    const show = (porcelain: string, plain: string | undefined) => {
      if (this.verbose) {
        if (first) output.push("Unstaged changes after refreshing the index:");
        first = false;
        output.push(porcelain);
      } else if (plain !== undefined) output.push(plain);
    };
    const trust = worktreeModeTrust(this.workingCopy, worktree);
    const indexTime = this.staging.getUpdateTime();
    const seen = items.map(() => 0);
    const updates: IndexStatUpdate[] = [];
    const matched = new Map<StagingEntry, boolean>();
    const list = this.staging.entryList?.();
    const entries: StagingEntry[] = [];
    for await (const entry of list ?? this.staging.entries()) entries.push(entry);
    // the stat pass over the stage-0 entries the pathspec matches (refresh_index: skip-worktree
    // entries are passed over before the pathspec is asked)
    for (const entry of entries) {
      if (entry.skipWorktree) continue;
      const flags = entry.mode === FileMode.GITLINK ? DO_MATCH_DIRECTORY : 0;
      matched.set(entry, matchPathspecSeen(items, entry.path, flags, seen) > 0);
    }
    const stated = (entry: StagingEntry) =>
      entry.stage === 0 &&
      matched.get(entry) === true &&
      !entry.assumeValid &&
      entry.mode !== FileMode.GITLINK;
    let lastUnmerged: string | undefined;
    for await (const { item: entry, current } of withWorktreeEntries(worktree, entries, stated)) {
      if (!matched.has(entry)) continue;
      if (entry.stage !== 0) {
        if (entry.path === lastUnmerged) continue;
        lastUnmerged = entry.path;
        if (matched.get(entry)) show(`U\t${entry.path}`, `${entry.path}: needs merge`);
        continue;
      }
      // up to date by promise (CE_VALID without --really-refresh)
      if (!matched.get(entry) || entry.assumeValid) continue;
      const compared = await compareWithWorktree(worktree, entry, { trust, indexTime }, current);
      if (!compared.kind && !entry.intentToAdd) {
        const update = statUpdateOf(entry, compared);
        if (update && !update.smudge) updates.push(update);
        continue;
      }
      // quiet unless verbose: git prints nothing for an entry that needs updating
      const code =
        compared.kind === "deleted"
          ? "D"
          : entry.intentToAdd
            ? "A"
            : compared.kind === "typechange"
              ? "T"
              : "M";
      show(`${code}\t${entry.path}`, undefined);
    }
    // an element that matched nothing dies, unless it matches entries outside the sparse
    // checkout: git advises on those, writes the index and fails
    const sparse: string[] = [];
    let skipSeen: number[] | undefined;
    for (let i = 0; i < items.length; i++) {
      if ((items[i] as PathspecItem).exclude || seen[i]) continue;
      skipSeen ??= skipWorktreeSeen(items, entries.map(groupOf), (path) =>
        this.outsideSparse(path),
      );
      // (git asks the element itself as a path too: `path_in_sparse_checkout(original)`)
      if (skipSeen[i] || this.outsideSparse(originals[i] as string)) {
        sparse.push(originals[i] as string);
        continue;
      }
      throw new InvalidArgumentError(
        "filepattern",
        originals[i],
        `fatal: pathspec '${originals[i]}' did not match any files`,
      );
    }
    // (written with `--dry-run` too: git's refresh-only add ignores it)
    if (updates.length > 0) {
      const now = Date.now();
      const editor = this.staging.createEditor();
      for (const update of updates) {
        editor.add({
          path: update.path,
          apply: (existing) => applyStatUpdate(existing, update, now) ?? existing,
        });
      }
      await editor.finish();
      if (this.writeIndex) await this.staging.write();
    }
    const result: AddResult = {
      added: [],
      skipped: [],
      ignored: [],
      removed: [],
      totalProcessed: 0,
      warnings: [],
      output,
    };
    if (sparse.length > 0) {
      throw new AddFailedError(this.sparseAdvice(sparse).join("\n"), [], [], result, output);
    }
    return result;
  }

  /**
   * git's `advise_on_updating_sparse_paths`: the elements that matched only entries outside
   * the sparse checkout, and (unless `advice.updateSparsePath` is off) the hint, as git 2.5x
   * words it (2.43 ends with "git config advice.updateSparsePath false").
   */
  private sparseAdvice(elements: string[]): string[] {
    return sparsePathAdvice(elements, this.advice("updateSparsePath"), this.compatibility);
  }

  /**
   * git's `check_removed` for the index entry `entry` and what the worktree has at its path
   * (`current`): `"removed"` when missing, or a directory where a file was that is no
   * repository with a commit checked out (a gitlink keeps its directory, populated or not):
   * no repository, or one without a commit; `"unknown"` for a directory whose repository
   * cannot be read here (its `.git`, commondir or HEAD names a place beyond the worktree's
   * storage, or cannot be read), which git might stage as a gitlink.
   */
  private async removalState(
    worktree: Worktree,
    entry: StagingEntry,
    current: WorktreeEntry | undefined,
  ): Promise<"removed" | "present" | "unknown"> {
    if (!current) return "removed";
    if (!current.isDirectory || entry.mode === FileMode.GITLINK) return "present";
    const head = await gitlinkHeadState(worktree, entry.path);
    if (head.state === "commit") return "present";
    return head.state === "unknown" ? "unknown" : "removed";
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
   *
   * A directory is a repository of its own unless the index has a gitlink there or paths
   * under it (git's `directory_exists_in_index`): a tracked file replaced by a repository is
   * one too. A directory whose `.git` holds no repository is entered, its `.git` passed
   * over; one whose repository cannot be read here is skipped with a warning.
   */
  private async scanUntracked(
    worktree: Worktree,
    items: PathspecItem[],
    index: IndexGroup[],
    seen: number[],
  ): Promise<{
    untracked: Array<{ path: string; entry: WorktreeEntry; repository: boolean }>;
    skipped: string[];
    ignored: string[];
    warnings: string[];
  }> {
    const untracked: Array<{ path: string; entry: WorktreeEntry; repository: boolean }> = [];
    const skipped: string[] = [];
    const ignored: string[] = [];
    const warnings: string[] = [];
    const indexPaths = new Set<string>();
    const gitlinkPaths = new Set<string>();
    for (const group of index) {
      indexPaths.add(group.path);
      if (group.gitlink) gitlinkPaths.add(group.path);
    }
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
      // a directory whose `.git` is no repository is an ordinary one (git's treat_directory)
      enterNonRepositoryGitDirs: true,
      // a tracked file is passed over (below too), unstat'ed (git's treat_path)
      skipFile: (path) => indexPaths.has(path),
      ...(prefix ? { pathPrefix: prefix } : {}),
      // git's "could not open directory" for a directory its scan opens: not one it passes
      // over as ignored, nor one the pathspec cannot reach into
      onUnreadable: (path, error) => {
        if (path === "" || GIT_COMPONENT.test(path)) return;
        if (!this.force && (ignoredDirs.has(path) || ignoredDirs.has(parentOf(path)))) return;
        if (!matchPathspec(items, path, DO_MATCH_DIRECTORY | DO_MATCH_LEADING_PATHSPEC)) return;
        warnings.push(unreadableDirectoryWarning(path, error));
      },
    })) {
      // ...but git never adds a `.git` (treat_path)
      if (entry.path.includes(".git") && GIT_COMPONENT.test(entry.path)) continue;
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
          entry.mode !== FileMode.GITLINK ||
          gitlinkPaths.has(entry.path) ||
          trackedDirs.has(entry.path)
        ) {
          continue;
        }
        const state = await nestedRepositoryState(worktree, entry.path);
        if (state === "repository") {
          if (matchPathspecSeen(items, entry.path, DO_MATCH_DIRECTORY, seen)) {
            untracked.push({ path: entry.path, entry, repository: true });
          }
        } else if (state === "unknown" && matchPathspec(items, entry.path, DO_MATCH_DIRECTORY)) {
          warnings.push(unreadableRepositoryWarning(entry.path));
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
    return { untracked, skipped, ignored, warnings };
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
   * not), and reported by `--verbose` / `--dry-run` whatever its content. An element that
   * matches nothing tracked must name an existing file (`--ignore-missing` passes over it).
   * A tracked file that cannot be stat'ed is fatal (nothing written); one replaced by a
   * repository is staged as its gitlink, and a path that cannot be added (a directory with no
   * commit checked out, a FIFO) is reported after the others are written.
   */
  private async renormalizeFiles(
    worktree: Worktree,
    items: PathspecItem[],
    originals: string[],
  ): Promise<AddResult> {
    const added: string[] = [];
    const warnings: string[] = [];
    const output: string[] = [];
    const errors: string[] = [];
    const failed: string[] = [];
    const index = await this.indexGroups();
    const seen = items.map(() => 0);
    for (const group of index) {
      matchPathspecSeen(items, group.path, group.gitlink ? DO_MATCH_DIRECTORY : 0, seen);
    }
    for (let i = 0; i < items.length; i++) {
      const item = items[i] as PathspecItem;
      if (item.exclude || seen[i] || item.match === "") continue;
      // with --ignore-missing git collects an ignored one, but reports none here
      if (!this.ignoreMissing && !(await namesFile(worktree, item))) {
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
      if (entry.stage !== 0 || entry.skipWorktree || this.outsideSparse(path)) continue;
      const kind = entry.mode & 0o170000;
      if (kind !== 0o100000 && kind !== 0o120000) continue;
      if (!matchPathspec(items, path, 0)) continue;
      const worktreeEntry = await worktree.getEntry(path);
      if (!worktreeEntry) {
        if (await worktree.isSpecialFile?.(path)) {
          errors.push(
            `error: ${path}: can only add regular files, symbolic links or git-directories`,
          );
          failed.push(path);
          continue;
        }
        // git's add_file_to_index dies on a tracked file it cannot stat (the index is left
        // as it was)
        throw new AddFailedError(
          [...errors, `fatal: unable to stat '${path}': No such file or directory`].join("\n"),
          [],
          [...failed, path],
          undefined,
          output,
          warnings,
        );
      }
      try {
        await adder.add(worktree, path, worktreeEntry, {
          renormalize: true,
          onWarning: (message) => warnings.push(message),
        });
      } catch (error) {
        if (!(error instanceof AddToIndexError)) throw error;
        errors.push(...error.lines);
        failed.push(path);
        continue;
      }
      // no alias is looked up with ADD_CACHE_RENORMALIZE: git's was_same is false
      output.push(`add '${path}'`);
      added.push(path);
    }
    await adder.finish();
    if (this.writeIndex && !this.dryRun) await this.writeIfChanged();
    const result: AddResult = {
      added,
      skipped: [],
      ignored: [],
      removed: [],
      totalProcessed: added.length,
      warnings,
      output,
    };
    if (failed.length > 0) {
      throw new AddFailedError(errors.join("\n"), [], failed, result, output, warnings);
    }
    return result;
  }
}

/** The index entries of one path (its stages, in order). */
interface IndexGroup {
  path: string;
  entries: StagingEntry[];
  gitlink: boolean;
}

/** Whether the path's entry is a skip-worktree one (outside the sparse checkout). */
function isSkipWorktree(group: IndexGroup): boolean {
  const first = group.entries[0] as StagingEntry;
  return first.stage === 0 && first.skipWorktree === true;
}

/** One entry as its own group. */
function groupOf(entry: StagingEntry): IndexGroup {
  return { path: entry.path, entries: [entry], gitlink: entry.mode === FileMode.GITLINK };
}

/**
 * git's `find_pathspecs_matching_skip_worktree`: which elements match a skip-worktree entry
 * or one outside the sparse checkout's patterns (`matches_skip_worktree`).
 */
function skipWorktreeSeen(
  items: PathspecItem[],
  index: readonly IndexGroup[],
  outsideSparse: (path: string) => boolean,
): number[] {
  const seen = items.map(() => 0);
  for (const group of index) {
    if (!isSkipWorktree(group) && !outsideSparse(group.path)) continue;
    matchPathspecSeen(items, group.path, group.gitlink ? DO_MATCH_DIRECTORY : 0, seen);
  }
  return seen;
}

/** A path with a `.git` component: never added (git's treat_path). */
const GIT_COMPONENT = /(^|\/)\.git(\/|$)/;

/** What the add says of a directory whose repository it cannot read. */
function unreadableRepositoryWarning(path: string): string {
  return `warning: skipping '${path}/': the repository its .git names cannot be read here`;
}

/** Whether the directory at `path` holds a repository of its own, as far as `worktree` tells. */
async function nestedRepositoryState(
  worktree: Worktree,
  path: string,
): Promise<NestedRepositoryState> {
  if (worktree.repositoryState) return worktree.repositoryState(path);
  if (worktree.isRepository) return (await worktree.isRepository(path)) ? "repository" : "none";
  return "repository";
}

/**
 * git's `file_exists` check of a pathspec element that matched nothing: a literal path
 * there (`lstat`), a directory when it ends with "/" (`a/` names no file `a`); a glob or
 * case-folding element never names a file.
 */
async function namesFile(worktree: Worktree, item: PathspecItem): Promise<boolean> {
  if (item.glob || item.icase) return false;
  const literal = pathspecItemPath(item);
  const path = literal.replace(/\/+$/, "");
  const entry = await worktree.getEntry(path);
  if (!entry) return false;
  return path === literal || entry.isDirectory;
}

/**
 * git's `PATHSPEC_SYMLINK_LEADING_PATH` (`has_symlink_leading_path` of each element's
 * match): an element reaching through a symbolic link is fatal, before anything changes.
 */
async function checkSymlinkLeadingPaths(
  worktree: Worktree,
  items: PathspecItem[],
  originals: string[],
): Promise<void> {
  for (let i = 0; i < items.length; i++) {
    const path = pathspecItemPath(items[i] as PathspecItem);
    const cut = path.lastIndexOf("/");
    for (let at = path.indexOf("/"); at > 0 && at <= cut; at = path.indexOf("/", at + 1)) {
      const entry = await worktree.getEntry(path.slice(0, at));
      if (entry?.mode === FileMode.SYMLINK) {
        throw new InvalidArgumentError(
          "filepattern",
          originals[i],
          `fatal: pathspec '${originals[i]}' is beyond a symbolic link`,
        );
      }
      if (!entry?.isDirectory) break;
    }
  }
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
  ];
}
