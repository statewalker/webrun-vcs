import {
  type Commit,
  FileMode,
  type ObjectId,
  type PersonIdent,
  type TreeEntry,
} from "@statewalker/vcs-core";
import { FileStagingStore } from "@statewalker/vcs-store-files";
import { compilePosixRegex, type PosixRegex } from "@statewalker/vcs-utils";
import { compareGitPaths } from "@statewalker/vcs-utils/encoding";
import type { FilesApi } from "@statewalker/vcs-utils/files";
import {
  expandUserPath,
  type Staging,
  type StagingEntry,
  type StagingIndexLock,
  type Worktree,
  type WorktreeEntry,
} from "@statewalker/vcs-working-tree";

import {
  EmptyCommitError,
  GitApiError,
  HookFailedError,
  IncompatibleOptionsError,
  IndexLockFailedError,
  InvalidArgumentError,
  NoHeadError,
  NoMessageError,
  RefNotFoundError,
  StoreNotAvailableError,
  UnmergedPathsError,
} from "../errors/index.js";
import { GitCommand } from "../git-command.js";
import { RemoteConfigStore } from "../remote-config/index.js";
import { AddCommand } from "./add-command.js";
import {
  amendCommitText,
  autosquashSubject,
  commitSubjectLength,
  type FixupKind,
  parseFixupSpec,
  refuseIncompatible,
  skipBlankLines,
} from "./commit-reuse.js";
import { worktreeModeTrust } from "./core-config.js";
import { DEFAULT_DATE_MODE, showDate } from "./date-format.js";
import { approxidateCareful } from "./git-date.js";
import { hostEnvironmentOf, InvalidDateError, parseGitDate, withoutCrud } from "./git-ident.js";
import { IndexAdder, readGitlinkHead } from "./index-adder.js";
import { reencodedCommitParts } from "./log-output.js";
import {
  flatTree,
  OperationState,
  updateIndexCacheTree,
  writeIndexAsTree,
} from "./merge-support.js";
import {
  CleanupMode,
  cleanupWith,
  commentPrefixOf,
  commitCleanupMode,
  completeLine,
  editorCleanupMode,
  stripspace,
} from "./message-cleanup.js";
import { copyNotesForAmend } from "./notes-support.js";
import { canonicalObjectId } from "./object-id-input.js";
import {
  DO_MATCH_DIRECTORY,
  matchPathspecSeen,
  type PathspecItem,
  parsePathspec,
  pathspecErrors,
  pathspecItemMayMatch,
} from "./pathspec.js";
import { PathspecAttributes } from "./pathspec-attributes.js";
import { type CommitReflogKind, reflogMessages, updateHead } from "./reflog-messages.js";
import { applyAutostash } from "./sequencer-support.js";
import { refuseCommitSigning, signRequestOf } from "./signing.js";
import {
  cutLine,
  readShowUntrackedFiles,
  StatusCommand,
  type StatusTextResult,
  type UntrackedFilesMode,
} from "./status-command.js";
import { type CommitWhence, StatusPrinter } from "./status-format.js";
import { readDiffSubmoduleConfig } from "./submodule-summary.js";
import {
  amendWithTrailers,
  appendSignoff,
  ignoredLogMessageBytes,
  signoffLine,
  type TrailerCommandRunner,
  trailerConfigOf,
  validateTrailerArgs,
} from "./trailers.js";

/**
 * Result of a commit operation.
 *
 * Extends Commit with the ID of the created commit.
 * JGit's CommitCommand returns RevCommit which includes getId().
 */
export interface CommitResult extends Commit {
  /** The ObjectId of the created commit */
  id: ObjectId;
}

/**
 * Create a commit from staged changes.
 *
 * Equivalent to `git commit`.
 *
 * Based on JGit's CommitCommand.
 *
 * @example
 * ```typescript
 * // Simple commit
 * const commit = await git.commit()
 *   .setMessage("Fix bug in parser")
 *   .call();
 *
 * // Commit with author
 * const commit = await git.commit()
 *   .setMessage("Add feature")
 *   .setAuthor("John Doe", "john@example.com")
 *   .call();
 *
 * // Amend previous commit
 * const commit = await git.commit()
 *   .setMessage("Updated message")
 *   .setAmend(true)
 *   .call();
 *
 * // Allow empty commit
 * const commit = await git.commit()
 *   .setMessage("Empty commit")
 *   .setAllowEmpty(true)
 *   .call();
 *
 * // Commit only specific paths
 * const commit = await git.commit()
 *   .setMessage("Partial commit")
 *   .setOnly("src/file.ts", "tests/file.test.ts")
 *   .call();
 *
 * // Auto-stage and commit tracked changes (requires worktree)
 * const commit = await git.commit()
 *   .setMessage("All changes")
 *   .setAll(true)
 *   .setWorktree(worktree)
 *   .call();
 * ```
 */
export class CommitCommand extends GitCommand<CommitResult> {
  private message?: string;
  private author?: PersonIdent;
  private committer?: PersonIdent;
  /** `--author=<name> <email>`: dated when the commit is made */
  private authorName?: { name: string; email: string };
  /** A committer named without a date, dated when the commit is made */
  private committerName?: { name: string; email: string };
  private resetAuthor = false;
  private amend = false;
  private noPostRewrite = false;
  private noVerify = false;
  /** `-S[<keyid>]` / `--no-gpg-sign` (undefined: `commit.gpgSign`) */
  private sign?: boolean | string;
  private allowEmpty = false;
  private parents: ObjectId[] = [];
  private onlyPaths: string[] = [];
  private all = false;
  private include = false;
  private includePaths: string[] = [];
  private worktreeIterator: Worktree | undefined;
  private cleanupMode?: CleanupMode;
  private allowEmptyMessage = false;
  private editor?: CommitEditor;
  private edit?: boolean;
  private includeStatus?: boolean;
  private verbose?: number;
  private untrackedMode?: UntrackedFilesMode;
  private statusFormat?: "long" | "short" | "porcelain";
  private showBranch?: boolean;
  private nullTermination = false;
  private aheadBehind?: boolean;
  private templateFile?: string;
  /** `--author=<string>` as given: `Name <email>`, or a pattern of an existing author */
  private authorString?: string;
  /** `--date=<date>`, and the clock its relative forms count from */
  private forceDate?: { text: string; now?: number };
  private signoff = false;
  private trailerArgs: string[] = [];
  /** `-C <commit>`: the commit whose message (and author) are reused */
  private reuseMessage?: string;
  /** The commit `-C` (or `-c`) names, read once the options are checked */
  private reused?: Commit;
  /** `-c <commit>` */
  private reeditMessageFrom?: string;
  /** `--fixup=[(amend|reword):]<commit>` as given */
  private fixupSpec?: string;
  /** `--squash=<commit>` */
  private squashFrom?: string;
  /** --fixup, parsed when the commit runs */
  private fixup?: { kind: FixupKind; target: string };

  /**
   * Set the commit message, as git's `commit -m` takes it: its last line is ended and it is
   * cleaned up (`whitespace` by default, see {@link setCleanupMode}), so `"Fix"` is stored
   * as `"Fix\n"` and the commit gets native git's id.
   *
   * @param message Commit message
   */
  setMessage(message: string): this {
    this.checkCallable();
    this.message = message;
    return this;
  }

  /**
   * Add a paragraph to the message, as each further `-m` of `git commit` does: the
   * message so far gets its last line ended and a blank line, then this one (`-m a -m b`
   * is `"a\n\nb\n"`). The first call is {@link setMessage}.
   *
   * @example
   * ```typescript
   * await git.commit().addMessage("Subject").addMessage("Body paragraph.").call();
   * ```
   *
   * @param message One paragraph of the commit message
   */
  addMessage(message: string): this {
    this.checkCallable();
    // git's opt_parse_m: a newline before the next -m only when the buffer holds something
    this.message = !this.message
      ? message
      : `${this.message}${this.message.endsWith("\n") ? "" : "\n"}\n${message}`;
    return this;
  }

  /**
   * How the message is cleaned up (git's `--cleanup=<mode>`; default `commit.cleanup`, else
   * `default`, which without an editor is `whitespace`: trailing whitespace and surrounding
   * blank lines dropped, blank runs collapsed). `strip` also drops comment lines;
   * `verbatim` keeps the message as given (with its last line ended, as `-m` does).
   */
  setCleanupMode(mode: CleanupMode): this {
    this.checkCallable();
    this.cleanupMode = mode;
    return this;
  }

  /**
   * Allow a message that is empty after its cleanup (git's `--allow-empty-message`);
   * without it such a commit is refused: `Aborting commit due to empty commit message.`
   */
  setAllowEmptyMessage(allow: boolean): this {
    this.checkCallable();
    this.allowEmptyMessage = allow;
    return this;
  }

  /**
   * Set the author identity (git's `--author`): a name and an email, or one string as git's
   * `--author=<author>` takes it. A string with a `>` is `Name <email>` (refused as
   * `fatal: malformed --author parameter` without a `<`); any other is a pattern looked up as
   * git's `find_author_by_nickname` does: the newest commit of `--all` whose (mailmapped)
   * author matches it as a basic regular expression, ignoring case, gives its `Name <email>`,
   * else `fatal: --author '<x>' is not 'Name <email>' and matches no existing author`.
   *
   * @example
   * ```typescript
   * await git.commit().setAuthor("Ada <ada@example.com>").setMessage("m").call();
   * await git.commit().setAuthor("ada").setMessage("m").call(); // an existing author
   * ```
   *
   * @param name Author name, or the whole `--author` string when `email` is not given
   * @param email Author email
   */
  setAuthor(name: string, email?: string): this {
    this.checkCallable();
    // git's --author: the name and email; the date is the amended commit's, the picked
    // commit's, else GIT_AUTHOR_DATE or now
    this.author = undefined;
    if (email === undefined) {
      this.authorName = undefined;
      this.authorString = name;
    } else {
      this.authorString = undefined;
      this.authorName = { name, email };
    }
    return this;
  }

  /**
   * `--date=<date>`: the author's date, in any form git's `parse_date` reads (`@<seconds>
   * <offset>`, RFC 2822, ISO 8601, ...) or else as `approxidate` reads it (`yesterday`,
   * `2.weeks.ago`, `noon`), counting from `now` (seconds; default the command's clock, git's
   * `GIT_TEST_DATE_NOW`). A date git cannot read fails as `fatal: invalid date format: <date>`.
   */
  setDate(date: string, options: { now?: number } = {}): this {
    this.checkCallable();
    this.forceDate = { text: date, ...(options.now !== undefined ? { now: options.now } : {}) };
    return this;
  }

  /**
   * `-s` / `--signoff`: a `Signed-off-by: <committer>` trailer added to the message as git's
   * `append_signoff` adds it (after a blank line unless the message ends with trailers; none
   * when the last trailer is that line already).
   */
  setSignoff(signoff: boolean): this {
    this.checkCallable();
    this.signoff = signoff;
    return this;
  }

  /**
   * `--trailer <token>[(=|:)<value>]`: a trailer added to the message as `git
   * interpret-trailers --no-divider --trailer` adds it (`trailer.*` configuration applies).
   * Each call adds one, in order.
   */
  addTrailer(trailer: string): this {
    this.checkCallable();
    this.trailerArgs.push(trailer);
    return this;
  }

  /**
   * `-C <commit>`: the commit's message taken as it is, and its author (name, email and
   * date) unless {@link setResetAuthor}. With {@link setEdit}(true) it is `-c`.
   */
  setReuseMessage(commit: string): this {
    this.checkCallable();
    this.reuseMessage = commit;
    return this;
  }

  /**
   * Set the author identity from a PersonIdent.
   *
   * @param author Author identity
   */
  setAuthorIdent(author: PersonIdent): this {
    this.checkCallable();
    this.authorName = undefined;
    this.author = author;
    return this;
  }

  /**
   * Set the committer identity.
   *
   * @param name Committer name
   * @param email Committer email
   */
  setCommitter(name: string, email: string): this {
    this.checkCallable();
    // dated as git dates the committer: GIT_COMMITTER_DATE, else now
    this.committer = undefined;
    this.committerName = { name, email };
    return this;
  }

  /**
   * Set the committer identity from a PersonIdent.
   *
   * @param committer Committer identity
   */
  setCommitterIdent(committer: PersonIdent): this {
    this.checkCallable();
    this.committerName = undefined;
    this.committer = committer;
    return this;
  }

  /**
   * `--reset-author`: an amended commit, a `-C` commit, or the commit that concludes a
   * cherry-pick, is authored as a new one (the author resolved as git resolves it, dated now) instead of
   * keeping the earlier commit's author.
   *
   * @param reset Whether to reset the author
   */
  setResetAuthor(reset: boolean): this {
    this.checkCallable();
    this.resetAuthor = reset;
    return this;
  }

  /**
   * `--no-post-rewrite`: an amend does not carry the amended commit's notes over to the new
   * one (`notes.rewriteRef`, `notes.rewrite.amend`), as git skips its post-rewrite step.
   */
  setNoPostRewrite(noPostRewrite: boolean): this {
    this.checkCallable();
    this.noPostRewrite = noPostRewrite;
    return this;
  }

  /**
   * `-n` / `--no-verify`: the `pre-commit` and `commit-msg` hooks do not run
   * (`prepare-commit-msg` and `post-commit` still do, as in git).
   */
  setNoVerify(noVerify: boolean): this {
    this.checkCallable();
    this.noVerify = noVerify;
    return this;
  }

  /**
   * `-S` (true) / `--no-gpg-sign` (false): whether to sign the commit; undefined (the
   * default) leaves it to `commit.gpgSign`. No signer exists yet, so a commit asked to be
   * signed fails as git fails when gpg cannot sign (`error: gpg failed to sign the data:`,
   * `fatal: failed to write commit object`, exit 128: {@link SigningFailedError}) once
   * everything before the signing is done, and nothing is committed.
   */
  setSign(sign: boolean | undefined): this {
    this.checkCallable();
    this.sign = sign;
    return this;
  }

  /** `-S<keyid>`: sign with this key (see {@link setSign}). */
  setSigningKey(keyId: string): this {
    this.checkCallable();
    this.sign = keyId;
    return this;
  }

  /**
   * Set whether to amend the previous commit.
   *
   * @param amend Whether to amend
   */
  setAmend(amend: boolean): this {
    this.checkCallable();
    this.amend = amend;
    return this;
  }

  /**
   * Set whether to allow an empty commit.
   *
   * @param allowEmpty Whether to allow empty commits
   */
  setAllowEmpty(allowEmpty: boolean): this {
    this.checkCallable();
    this.allowEmpty = allowEmpty;
    return this;
  }

  /**
   * Set explicit parent commits.
   *
   * Normally parents are determined automatically, but this
   * can be used for merge commits or special cases.
   *
   * @param parents Parent commit IDs
   */
  setParentIds(...parents: ObjectId[]): this {
    this.checkCallable();
    this.parents = parents.map(canonicalObjectId);
    return this;
  }

  /**
   * Set paths to commit (`git commit --only <paths>`, git's partial commit).
   *
   * The paths are a pathspec, as git reads it (`d/`, `*.md`, `:(glob)d/**`, `:!d/x`,
   * `./a`). As git's `prepare_index`: the index entries (any stage) and HEAD's files the
   * pathspec matches are listed (`list_paths`); an element that matches none of them fails
   * with git's "error: pathspec '<path>' did not match any file(s) known to git". The index
   * lock is then held until HEAD has moved. Each listed path is taken from the worktree
   * literally (`add_remove_files`): a file (ignored or not) is staged as `git add` stages it
   * (cleaned by the content filters; an intent-to-add entry gets the content, a conflicted
   * path is resolved to the file, the entries it clashes with as a file or a directory
   * replaced), a path gone is removed, a submodule takes the commit checked out in it, and a
   * path that is now a directory holding no commit refuses the commit before anything
   * changes ("'<path>' does not have a commit checked out"). The index is
   * written into the lock with the paths updated, and the commit records HEAD's tree with
   * only these paths changed, whatever else is staged. The lock is renamed over the index
   * once the commit is made; on any failure it is removed and the index (and this instance's
   * staging, unwritten edits included) stays as it was. A skip-worktree path keeps its HEAD
   * version. A partial commit during a merge, a cherry-pick or a rebase is refused; other
   * unmerged paths do not stop it (they stay unmerged in the index).
   *
   * Cannot be combined with setAll().
   *
   * @param paths Paths to include in commit
   * @throws Error if combined with --all mode
   */
  setOnly(...paths: string[]): this {
    this.checkCallable();
    // git's parse_and_validate_options: paths and -a do not go together
    if (this.all && paths.length > 0) throw pathsWithAllError(paths);
    this.onlyPaths = paths;
    return this;
  }

  /**
   * Set whether to auto-stage modified tracked files before committing.
   *
   * If true, stages all modified and deleted tracked files before
   * creating the commit. Requires a working tree iterator. As git's: the index lock is held
   * from before the files are staged until HEAD has moved, and the index is left as it was
   * when the commit fails.
   *
   * Cannot be combined with setOnly().
   *
   * Equivalent to `git commit -a` or `git commit --all`.
   *
   * @param all Whether to auto-stage tracked changes
   * @returns this for chaining
   * @throws Error if combined with --only paths
   */
  setAll(all: boolean): this {
    this.checkCallable();
    // git's parse_and_validate_options: paths and -a do not go together
    if (all && this.onlyPaths.length > 0) throw pathsWithAllError(this.onlyPaths);
    this.all = all;
    return this;
  }

  /**
   * Commit the index with the tracked files `paths` names staged first (`git commit -i
   * <paths>` / `--include`, git's `prepare_index` "non partial, non as-is commit"): the index
   * lock is taken, the tracked paths the pathspec matches are staged from the worktree as
   * `git add -u <paths>` stages them (`add_files_to_cache`; untracked files are not added),
   * an element that matches no index entry fails with git's "error: pathspec '<path>' did
   * not match any file(s) known to git" (git 2.5x; 2.43 commits what is staged), and the
   * whole index, written into the lock, is committed; the lock is renamed over the index
   * once HEAD has moved, or removed on failure (the index stays as it was).
   *
   * As git: refused with {@link setOnly} paths ("options '-i/--include' and '-o/--only'
   * cannot be used together"), with {@link setAll} ("options '-i/--include' and
   * '-a/--all' cannot be used together"), and without paths ("No paths with
   * --include/--only does not make sense."), when the commit runs.
   *
   * @example
   * ```typescript
   * await git.commit().setInclude("src/a.ts").setMessage("Fix a").call();
   * ```
   */
  setInclude(...paths: string[]): this {
    this.checkCallable();
    this.include = true;
    this.includePaths = paths;
    return this;
  }

  /**
   * Whether --all mode is enabled.
   */
  isAll(): boolean {
    return this.all;
  }

  /**
   * Set a custom working tree iterator.
   *
   * Required when using setAll(true) if the store doesn't have
   * a built-in working tree.
   *
   * @param iterator Custom working tree iterator
   * @returns this for chaining
   */
  /**
   * The editor of the commit message (git's `core.editor` / `GIT_EDITOR`, which a library
   * cannot launch): called with the path of `COMMIT_EDITMSG` in the git directory and the
   * text written there, the template git prepares (the message so far, then, unless
   * {@link setIncludeStatus} is false, the commented help and status, and with
   * {@link setVerbose} the diff below the scissors line). It returns the edited text, or
   * nothing once it changed the file itself; the result is cleaned up as git cleans up an
   * edited message (`default` strips comments, `scissors` cuts at the scissors line). It is
   * used when no message is given, or with {@link setEdit}.
   *
   * @example
   * ```typescript
   * await git.commit().setEditor(async (_path, template) => `Subject\n\n${template}`).call();
   * ```
   */
  setEditor(editor: CommitEditor): this {
    this.checkCallable();
    this.editor = editor;
    return this;
  }

  /**
   * `-t <file>` / `--template=<file>`: the editor starts from this file's text (default
   * `commit.template`) when no message is given and nothing is in progress; a message the
   * editor leaves as the template was is refused (`Aborting commit; you did not edit the
   * message.`). A relative path is read from the worktree's top, through the host.
   *
   * @example
   * ```typescript
   * await git.commit().setTemplate("/home/me/.gitmessage").setEditor(edit).call();
   * ```
   */
  setTemplate(path: string): this {
    this.checkCallable();
    this.templateFile = path;
    return this;
  }

  /**
   * `-c <commit>` / `--reedit-message=<commit>`: as {@link setReuseMessage} (or `-C` with {@link setEdit}(true)), with the message
   * then given to the editor ({@link setEditor}; without one it is taken as it is).
   */
  setReeditMessage(commit: string): this {
    this.checkCallable();
    this.reeditMessageFrom = commit;
    return this;
  }

  /**
   * `--fixup=[(amend|reword):]<commit>`: a commit `rebase --autosquash` folds into `commit`.
   * Plain, its message is `fixup! <subject>` (then the {@link setMessage} text, if any) and
   * no editor runs. `amend:<commit>` makes `amend! <subject>` followed by the commit's whole
   * message (its body alone when it is an `amend!` commit itself) for the editor to change,
   * empty commits allowed and a message given with {@link setMessage} refused; `reword:` is
   * `amend:` committing HEAD's tree (only the message changes), refused with paths, `-a`,
   * `-i`, and during a merge or cherry-pick. An `amend!` message without a body is refused
   * (`Aborting commit due to empty commit message body.`).
   *
   * @example
   * ```typescript
   * await git.commit().setFixup("HEAD~1").call();
   * await git.commit().setFixup("reword:HEAD~1").setEditor(edit).call();
   * ```
   */
  setFixup(commit: string): this {
    this.checkCallable();
    this.fixupSpec = commit;
    return this;
  }

  /**
   * `--squash=<commit>`: the message starts with `squash! <subject>` and a blank line, then
   * the message given ({@link setMessage}, {@link setReuseMessage}: only `squash! ` when it
   * names the same commit as given here), else what the editor makes of it. Refused with
   * {@link setFixup}.
   */
  setSquash(commit: string): this {
    this.checkCallable();
    this.squashFrom = commit;
    return this;
  }

  /** `-e` / `--no-edit`: edit a given message too, or never edit (default: edit when none is given). */
  setEdit(edit: boolean): this {
    this.checkCallable();
    this.edit = edit;
    return this;
  }

  /** `--status` / `--no-status`: the status in the editor's template (default `commit.status`, true). */
  setIncludeStatus(include: boolean): this {
    this.checkCallable();
    this.includeStatus = include;
    return this;
  }

  /**
   * `-v` (1) / `-vv` (2): the staged diff below the template's scissors line (and the
   * unstaged one), or in {@link callDryRun}'s output (default `commit.verbose`)
   */
  setVerbose(level: number): this {
    this.checkCallable();
    this.verbose = level;
    return this;
  }

  /** `-u<mode>` / `--untracked-files=<mode>` of the template and the dry run */
  setUntrackedFiles(mode: UntrackedFilesMode): this {
    this.checkCallable();
    this.untrackedMode = mode;
    return this;
  }

  /** `--short`, `--porcelain`, `--long`: the format of {@link callDryRun} (git's commit has no v2) */
  setStatusFormat(format: "long" | "short" | "porcelain"): this {
    this.checkCallable();
    this.statusFormat = format;
    return this;
  }

  /** `--branch`: the branch header of the short and porcelain dry runs (default `status.branch`) */
  setShowBranch(show: boolean): this {
    this.checkCallable();
    this.showBranch = show;
    return this;
  }

  /** `-z`: NUL-terminated dry-run output (porcelain unless another format is set) */
  setNullTermination(z: boolean): this {
    this.checkCallable();
    this.nullTermination = z;
    return this;
  }

  /** `--[no-]ahead-behind` of the dry run (default `status.aheadBehind` for the human formats) */
  setAheadBehind(full: boolean): this {
    this.checkCallable();
    this.aheadBehind = full;
    return this;
  }

  /**
   * `git commit --dry-run` (and `--short`, `--porcelain`, `--long`, `-z`, which imply it):
   * the status of what would be committed, in the format set, with git's exit code (0
   * when there is something to commit, else 1). The index is prepared as the commit would
   * prepare it (`-a` stages the tracked changes, {@link setInclude} the named tracked paths,
   * {@link setOnly} builds the index of HEAD with the named paths), then left as it was
   * (rollback_index_files).
   *
   * @example
   * ```typescript
   * const { text, exitCode } = await git.commit().setAll(true).callDryRun();
   * ```
   */
  async callDryRun(): Promise<CommitDryRunResult> {
    this.checkCallable();
    this.setCallable(false);
    readShowUntrackedFiles(this.workingCopy);
    // ... and git_diff_ui_config: a diff.submodule without a value dies
    readDiffSubmoduleConfig(this.workingCopy);
    await this.readCurrentIndex();
    await this.checkReuseOptions();
    // `-i` refuses what it refuses for a commit, before anything is read
    if (this.include) this.checkIncludeOptions();
    const state = new OperationState(this.workingCopy.checkout, this.refsStore);
    const mergeHeads = await this.mergeHeads(state);
    const headId = (await this.refsStore.resolve("HEAD"))?.objectId;
    await this.checkAmend(state, mergeHeads, headId);
    const partial = this.onlyPaths.length > 0;
    const z = this.nullTermination;
    const format = this.statusFormat ?? (z ? "porcelain" : "long");
    const run = async (): Promise<StatusTextResult> =>
      this.commitStatus({
        format,
        z,
        ...(this.showBranch !== undefined ? { branch: this.showBranch } : {}),
        ...(this.aheadBehind !== undefined ? { aheadBehind: this.aheadBehind } : {}),
        verbose: this.verboseLevel(),
        commitTemplate: true,
        amend: this.amend,
      });
    let result: StatusTextResult;
    if (this.include) {
      // `-i <paths>`: the tracked paths staged on the held index, shown, then rolled back
      const index = await this.holdIndex();
      try {
        await this.stageTrackedChanges(this.includePaths);
        result = await run();
      } finally {
        await index.release();
      }
    } else if (this.all) {
      const index = await this.holdIndex();
      try {
        await this.stageTrackedChanges();
        result = await run();
      } finally {
        await index.release();
      }
    } else if (partial) {
      const paths = await this.listPartialPaths(state, mergeHeads, headId);
      const index = await this.holdIndex();
      try {
        // the false index shown, its tree never stored (git writes it into a lock only)
        const falseIndex = await this.preparePartialCommit(paths, headId, index);
        result = await this.withFalseIndex(await this.falseIndexFiles(falseIndex), run);
      } finally {
        await index.release();
      }
    } else {
      // an as-is commit (prepare_index): the index lock taken (git dies when another
      // process holds it), then the status of the index as it is
      const index = await this.holdIndex();
      await index.release();
      result = await run();
    }
    return { ...result, exitCode: result.committable ? 0 : 1 };
  }

  /** git's use_editor: an editor is set, and no message is given or `-e` asks for it. */
  private usesEditor(): boolean {
    if (!this.editor || this.edit === false) return false;
    return this.edit === true || this.editsByDefault();
  }

  /**
   * git's use_editor before `-e`/`--no-edit`: no message given (`-m`, `-C`) and no plain
   * `--fixup`, whose messages are taken as they are.
   */
  private editsByDefault(): boolean {
    if (this.message !== undefined || this.reuseMessage !== undefined) return false;
    if (this.fixupSpec === undefined) return true;
    const parsed = parseFixupSpec(this.fixupSpec);
    return !("kind" in parsed) || parsed.kind !== "fixup";
  }

  /** The revision `-c` or `-C` names (git's use_message), as given. */
  private reusedName(): string | undefined {
    return this.reeditMessageFrom ?? this.reuseMessage;
  }

  /**
   * prepare_to_commit with an editor: COMMIT_EDITMSG written with the message so far and
   * (`commit.status`) the commented help, identities and status of the template, the
   * editor run over it, and what it left cleaned up as the commit message.
   */
  private async editMessage(
    ctx: {
      state: OperationState;
      mergeHeads: ObjectId[];
      pickHead: ObjectId | undefined;
      partialTree: ObjectId | undefined;
      /** The tree the commit records */
      treeId: ObjectId;
      /** HEAD, or HEAD^1 when amending (none: an initial commit, or a root amended) */
      firstParent: ObjectId | undefined;
      previousCommit: Commit | undefined;
      author: PersonIdent;
      committer: PersonIdent;
      authorKept: boolean;
      /** The variables of the commit hooks */
      hookEnv: Record<string, string>;
    },
    editor: CommitEditor,
  ): Promise<{ message: string; cleanup: CleanupMode; untouched: boolean }> {
    const { state } = ctx;
    const config = RemoteConfigStore.from(this.workingCopy);
    const mode = editorCleanupMode(this.workingCopy, this.cleanupMode);
    // (-m, -C, -c and --fixup drop the template: git frees template_file)
    const templateText =
      this.message !== undefined || this.reused || this.fixup
        ? undefined
        : await this.readTemplate(config);
    const rebasing = (await state.read("rebase-merge/head-name")) !== undefined;
    const whence: CommitWhence =
      ctx.mergeHeads.length > 0
        ? "merge"
        : ctx.pickHead
          ? rebasing && (await state.ref("REBASE_HEAD")) === ctx.pickHead
            ? "rebase-pick"
            : "cherry-pick"
          : "commit";
    // the message so far
    let sb = "";
    let cutLineAdded = false;
    const mergeMsg = await state.read("MERGE_MSG");
    const squashMsg = await state.read("SQUASH_MSG");
    const reusedMessage = await this.reusedMessage();
    if (reusedMessage.text !== undefined) sb = reusedMessage.text;
    else if (this.message !== undefined) sb = completeLine(this.message);
    else if (this.amend && ctx.previousCommit) {
      sb = ctx.previousCommit.message.replace(/^(?:[ \t\r]*\n)+/, "");
    } else if (mergeMsg !== undefined) {
      sb = `${squashMsg ?? ""}${mergeMsg}`;
      if (mode === CleanupMode.SCISSORS) {
        const cut = `${commentPrefixOf(this.workingCopy)} ------------------------ >8 ------------------------\n`;
        if (mergeMsg.startsWith(cut) || mergeMsg.includes(`\n${cut}`)) cutLineAdded = true;
      }
    } else if (squashMsg !== undefined) sb = squashMsg;
    else if (templateText !== undefined) sb = templateText;
    sb = reusedMessage.prefix + sb;
    // clean_message_contents: not for a template, which goes in as it is
    const fromTemplate =
      reusedMessage.text === undefined &&
      this.message === undefined &&
      !(this.amend && ctx.previousCommit) &&
      mergeMsg === undefined &&
      squashMsg === undefined &&
      templateText !== undefined;
    if (mode !== CleanupMode.VERBATIM && !fromTemplate) sb = stripspace(sb);
    sb = this.signedOff(sb, ctx.committer);
    // core.commentChar=auto: a character the message does not start a line with
    const comment = commentPrefixOf(this.workingCopy, sb);
    // (a prepared message taken without an editor: as `--no-status`, unless asked for)
    const includeStatus =
      this.includeStatus ??
      (this.usesEditor() ? parseBool(config.value("commit.status"), true) : false);
    const verbose = this.verboseLevel();
    let template = sb;
    let committable: boolean;
    const p = new StatusPrinter(comment);
    if (includeStatus) {
      if (whence !== "commit") {
        if (mode === CleanupMode.SCISSORS && !cutLineAdded) {
          p.raw(cutLine(comment));
          cutLineAdded = true;
        }
        const what = whence === "merge" ? "a merge" : "a cherry-pick";
        const ref = whence === "merge" ? "MERGE_HEAD" : "CHERRY_PICK_HEAD";
        p.ln(
          `\nIt looks like you may be committing ${what}.\nIf this is not correct, please run\n\tgit update-ref -d ${ref}\nand try again.\n`,
        );
      }
      p.raw("\n");
      if (mode === CleanupMode.STRIP) {
        p.printf(
          this.allowEmptyMessage
            ? `Please enter the commit message for your changes. Lines starting\nwith '${comment}' will be ignored.\n`
            : `Please enter the commit message for your changes. Lines starting\nwith '${comment}' will be ignored, and an empty message aborts the commit.\n`,
        );
      } else if (mode === CleanupMode.SCISSORS) {
        if (whence === "commit" && !cutLineAdded) {
          p.raw(cutLine(comment));
          cutLineAdded = true;
        }
      } else {
        p.printf(
          this.allowEmptyMessage
            ? `Please enter the commit message for your changes. Lines starting\nwith '${comment}' will be kept; you may remove them yourself if you want to.\n`
            : `Please enter the commit message for your changes. Lines starting\nwith '${comment}' will be kept; you may remove them yourself if you want to.\nAn empty message aborts the commit.\n`,
        );
      }
      let identShown = 0;
      const { author, committer } = ctx;
      if (author.name !== committer.name || author.email !== committer.email) {
        p.ln(`${identShown++ ? "" : "\n"}Author:    ${author.name} <${author.email}>`);
      }
      if (ctx.authorKept) {
        const date = showDate(author.timestamp, author.tzOffset, DEFAULT_DATE_MODE);
        p.ln(`${identShown++ ? "" : "\n"}Date:      ${date}`);
      }
      if (!this.committerIdentGiven()) {
        p.ln(`${identShown++ ? "" : "\n"}Committer: ${committer.name} <${committer.email}>`);
      }
      p.ln("");
      const run = () =>
        this.commitStatus({
          format: "long",
          commentPrefix: comment,
          hints: false,
          nowarn: true,
          commitTemplate: true,
          amend: this.amend,
          verbose,
          toFile: true,
          cutLineAdded,
          whence,
        });
      const status = ctx.partialTree
        ? await this.withIndexOfTree(ctx.partialTree, run)
        : await run();
      committable = status.committable;
      template += p.out + status.text;
    } else {
      // no status in the template: prepare_to_commit's index_differs_from against HEAD
      // (HEAD^1 when amending), intent-to-add entries invisible; without that parent,
      // `cache_nr - ita_nr > 0`. The recorded tree says both without a status run.
      const parentTree = ctx.firstParent
        ? (await this.commits.load(ctx.firstParent))?.tree
        : this.objectFormat.emptyTreeId;
      committable = ctx.treeId !== parentTree;
    }
    // COMMIT_EDITMSG written in full, its trailers added (amend_file_with_trailers), then an
    // empty commit refused before the editor runs
    await state.write("COMMIT_EDITMSG", template);
    template = await this.withTrailers(template, state, comment);
    const isMerge = (ctx.previousCommit?.parents.length ?? 0) > 1;
    if (!committable && whence !== "merge" && !this.allowEmpty && !(this.amend && isMerge)) {
      throw new EmptyCommitError();
    }
    // prepare-commit-msg, the editor over what it left, then commit-msg
    let text = "";
    let edited: unknown;
    const hookArgs = this.prepareMessageHookArgs(
      mergeMsg,
      squashMsg,
      fromTemplate ? templateText : undefined,
      ctx.mergeHeads,
      ctx.pickHead,
    );
    const ran = await this.runMessageHooks(ctx.hookEnv, hookArgs, async () => {
      const current = this.hooks.enabled
        ? ((await state.read("COMMIT_EDITMSG")) ?? template)
        : template;
      edited = await editor("COMMIT_EDITMSG", current);
      if (typeof edited === "string") await state.write("COMMIT_EDITMSG", edited);
    });
    if (typeof edited === "string" && !ran) text = edited;
    else text = (await state.read("COMMIT_EDITMSG")) ?? "";
    // cleanup_message
    if (verbose > 0 || mode === CleanupMode.SCISSORS) {
      const cut = `${comment} ------------------------ >8 ------------------------\n`;
      if (text.startsWith(cut)) text = "";
      else {
        const at = text.indexOf(`\n${cut}`);
        if (at >= 0) text = text.slice(0, at + 1);
      }
    }
    if (mode !== CleanupMode.VERBATIM) {
      text = stripspace(text, mode === CleanupMode.STRIP ? comment : undefined);
    }
    return {
      message: text,
      cleanup: mode === CleanupMode.VERBATIM ? mode : CleanupMode.STRIP,
      untouched: templateUntouched(text, templateText, mode, comment),
    };
  }

  /**
   * `-s`: the message so far with the committer's sign-off (append_signoff with
   * ignored_log_message_bytes: before trailing comments and the scissors line).
   */
  private signedOff(message: string, committer: PersonIdent): string {
    if (!this.signoff) return message;
    const config = trailerConfigOf(this.workingCopy);
    return appendSignoff(
      message,
      signoffLine(committer),
      config,
      false,
      ignoredLogMessageBytes(message, config.commentString),
    );
  }

  /**
   * `--trailer`: COMMIT_EDITMSG (written as `message`) with the trailers added, as git's
   * amend_file_with_trailers (2.43: a child `interpret-trailers --in-place --no-divider`,
   * which takes an empty argument for nothing and refuses none); the new text, written back.
   */
  private async withTrailers(
    message: string,
    state: OperationState,
    comment: string | undefined,
  ): Promise<string> {
    if (this.trailerArgs.length === 0) return message;
    const hooks = this.hooks;
    const compatibility = hooks.compatibility;
    const config = {
      ...trailerConfigOf(this.workingCopy),
      ...(comment !== undefined ? { commentString: comment } : {}),
      compatibility,
    };
    let args = this.trailerArgs;
    if (compatibility === "2.43") args = args.filter((a) => a !== "");
    else {
      const refused = validateTrailerArgs(args, config);
      if (refused !== undefined) {
        throw new GitApiError(`${refused}\nfatal: unable to pass trailers to --trailers`, {
          exitCode: 128,
        });
      }
    }
    if (args.length === 0) return message;
    const runCommand: TrailerCommandRunner | undefined = hooks.enabled
      ? (command) => hooks.runShellCommand("trailer", command.command, command.args)
      : undefined;
    const { output } = await amendWithTrailers(message, args, config, runCommand);
    await state.write("COMMIT_EDITMSG", output);
    return output;
  }

  /**
   * The commit template (`-t`, else `commit.template`, `~/` expanded) read through the host,
   * undefined when none is set; one that cannot be read fails as git's `die_errno`.
   */
  private async readTemplate(config: RemoteConfigStore): Promise<string | undefined> {
    const configured = config.value("commit.template");
    const file =
      this.templateFile ?? (configured !== undefined && configured !== "" ? configured : undefined);
    if (file === undefined) return undefined;
    const environment = hostEnvironmentOf(this.workingCopy);
    const expanded = expandUserPath(file, environment);
    let bytes: Uint8Array | undefined;
    if (expanded !== undefined && environment) {
      let path = expanded;
      if (!path.startsWith("/")) {
        const base = (this.worktreeAccess as { hostPath?: string } | undefined)?.hostPath;
        if (base) path = `${base.replace(/\/+$/, "")}/${path}`;
      }
      bytes = await environment.readFile(path).catch(() => undefined);
    }
    if (!bytes) {
      throw new GitApiError(`fatal: could not read '${file}': No such file or directory`);
    }
    return new TextDecoder().decode(bytes);
  }

  /** committer_ident_sufficiently_given: a name and an email named, not guessed. */
  private committerIdentGiven(): boolean {
    const env = hostEnvironmentOf(this.workingCopy);
    const config = RemoteConfigStore.from(this.workingCopy);
    const name =
      env?.committer?.name !== undefined ||
      config.value("committer.name") !== undefined ||
      config.value("user.name") !== undefined;
    const email =
      env?.committer?.email !== undefined ||
      config.value("committer.email") !== undefined ||
      config.value("user.email") !== undefined ||
      !!env?.defaultEmail;
    return name && email;
  }

  /** parse_and_validate_options' checks of `--amend`. */
  private async checkAmend(
    state: OperationState,
    mergeHeads: ObjectId[],
    headId: ObjectId | undefined,
  ): Promise<void> {
    if (!this.amend) return;
    if (!headId) {
      throw new InvalidArgumentError("amend", true, "fatal: You have nothing to amend.");
    }
    if (mergeHeads.length > 0) {
      throw new InvalidArgumentError(
        "amend",
        true,
        "fatal: You are in the middle of a merge -- cannot amend.",
      );
    }
    if (await state.ref("CHERRY_PICK_HEAD")) {
      throw new InvalidArgumentError(
        "amend",
        true,
        "fatal: You are in the middle of a cherry-pick -- cannot amend.",
      );
    }
  }

  /** `-v` as given, else `commit.verbose` (a boolean or a level), else 0. */
  private verboseLevel(): number {
    if (this.verbose !== undefined) return this.verbose;
    const value = RemoteConfigStore.from(this.workingCopy).value("commit.verbose");
    if (value === undefined) return 0;
    if (/^\s*-?\d+\s*$/.test(value)) return Number.parseInt(value, 10);
    const v = value.toLowerCase();
    return v === "" || v === "false" || v === "no" || v === "off" ? 0 : 1;
  }

  /**
   * run_status for the commit: the status of the prepared index against HEAD (HEAD^1 for
   * `--amend`), its stats not written back (the commit holds the index).
   */
  private async commitStatus(
    options: Parameters<StatusCommand["callText"]>[0] & object,
  ): Promise<StatusTextResult> {
    const status = new StatusCommand(this.workingCopy).setWriteIndex(false);
    if (this.untrackedMode) status.setUntrackedFiles(this.untrackedMode);
    if (this.amend) {
      const headId = await this.resolveHead();
      const head = await this.commits.load(headId);
      status.setReferenceCommit(head?.parents[0] ?? null);
    }
    return status.callText(options);
  }

  /** {@link withFalseIndex} with the files of `tree` (a partial commit's stored tree). */
  private async withIndexOfTree<T>(tree: ObjectId, fn: () => Promise<T>): Promise<T> {
    return this.withFalseIndex(await flatTree(this.trees, tree), fn);
  }

  /**
   * Runs `fn` while the staging holds the entries `flat` names (a partial commit's false
   * index: HEAD with the named paths), each with the stat of the staging's same entry,
   * then puts the staging back exactly as it was: the same entry objects, so the ones kept
   * as read are still checked for racy-git smudging when the index is written
   * (`saveState`; a staging without it gets its entries rebuilt).
   */
  private async withFalseIndex<T>(
    flat: Map<string, { objectId: ObjectId; mode: number }>,
    fn: () => Promise<T>,
  ): Promise<T> {
    const staging = this.staging;
    const saved = staging.saveState?.();
    const before = (staging.entryList?.() ?? (await collectEntries(staging))).slice();
    const cacheTree = saved ? undefined : staging.getCacheTree?.();
    const known = new Map(before.filter((e) => e.stage === 0).map((e) => [e.path, e]));
    const builder = staging.createBuilder();
    for (const [path, entry] of flat) {
      const same = known.get(path);
      builder.add(
        same && same.objectId === entry.objectId && same.mode === entry.mode
          ? same
          : { path, mode: entry.mode, objectId: entry.objectId, stage: 0, size: 0, mtime: 0 },
      );
    }
    await builder.finish();
    try {
      return await fn();
    } finally {
      if (saved) staging.restoreState?.(saved);
      else {
        const restore = staging.createBuilder();
        for (const entry of before) restore.add(entry);
        await restore.finish();
        staging.setCacheTree?.(cacheTree);
      }
    }
  }

  setWorktree(iterator: Worktree): this {
    this.checkCallable();
    this.worktreeIterator = iterator;
    return this;
  }

  /**
   * Execute the commit.
   *
   * @returns The created commit with its ID
   * @throws NoMessageError if message is not set and not amending
   * @throws UnmergedPathsError if there are unresolved conflicts
   * @throws EmptyCommitError if nothing to commit and allowEmpty is false
   */
  async call(): Promise<CommitResult> {
    this.checkCallable();
    // git commit reads the status configuration first (git_status_config): a bad
    // status.showUntrackedFiles fails it before anything is done
    readShowUntrackedFiles(this.workingCopy);
    // ... and git_diff_ui_config: a diff.submodule without a value dies
    readDiffSubmoduleConfig(this.workingCopy);
    await this.parseAuthorOptions();
    // the index as it is now: one another writer replaced is read again (git reads the
    // index at its start), unless this instance holds unwritten edits (refused)
    await this.readCurrentIndex();
    if (this.include) return this.commitIncluded();
    // `--fixup=reword:` is a partial commit of no path: HEAD's tree (git sets `only`)
    const partial = this.onlyPaths.length > 0 || this.fixup?.kind === "reword";
    if (!this.all) return this.commitWith(partial, undefined);
    // `-a` (git's COMMIT_NORMAL): the index lock held from before the tracked changes are
    // staged until HEAD has moved
    const index = await this.holdIndex();
    try {
      // git writes the lock once (prepare_index): one post-index-change run, the lock held
      return await this.withOneIndexWrite("first", async () => {
        // Handle --all flag: auto-stage modified tracked files
        await this.stageTrackedChanges();
        return await this.commitWith(partial, index);
      });
    } catch (error) {
      await index.release();
      throw error;
    }
  }

  /**
   * `-i <paths>` (git's prepare_index for `also`): the option checks of
   * parse_and_validate_options and prepare_index, then the index lock held from before the
   * tracked paths are staged until HEAD has moved.
   */
  private async commitIncluded(): Promise<CommitResult> {
    this.checkIncludeOptions();
    const index = await this.holdIndex();
    try {
      await this.stageTrackedChanges(this.includePaths);
      return await this.commitWith(false, index);
    } catch (error) {
      await index.release();
      throw error;
    }
  }

  /**
   * parse_and_validate_options' handling of `--author`, `-m` with `-C`, `--reset-author`,
   * and `-C`'s commit (read_commit_message), in git's order.
   */
  private async parseAuthorOptions(): Promise<void> {
    if (this.authorString !== undefined) {
      let text = this.authorString;
      if (!text.includes(">")) text = await this.findAuthorByNickname(text);
      if (this.resetAuthor) {
        throw new IncompatibleOptionsError(
          ["--reset-author", "--author"],
          "fatal: options '--reset-author' and '--author' cannot be used together",
        );
      }
      // split_ident_line: the name up to the `<` (trailing spaces dropped), the email up to
      // the first `>` after it
      const lt = text.indexOf("<");
      const gt = lt < 0 ? -1 : text.indexOf(">", lt + 1);
      if (gt < 0) {
        throw new InvalidArgumentError(
          "author",
          this.authorString,
          "fatal: malformed --author parameter",
        );
      }
      const name = text.slice(0, lt).replace(/[ \t\n\v\f\r]+$/, "");
      this.authorName = { name, email: text.slice(lt + 1, gt) };
    }
    await this.checkReuseOptions();
    if (this.forceDate) this.forcedDate();
  }

  /**
   * `--date` (parse_force_date): the date as `parse_date` reads it, else as `approxidate`
   * does, refused as git refuses it.
   */
  private forcedDate(): Pick<PersonIdent, "timestamp" | "tzOffset"> | undefined {
    if (!this.forceDate) return undefined;
    const { text } = this.forceDate;
    const parsed = parseGitDate(text);
    if (parsed) return parsed;
    const approx = approxidateCareful(text, this.forceDate.now ?? this.clock());
    // fmt_ident's parse_date of `@<seconds>`: the local offset of that time
    const date = approx.error ? undefined : parseGitDate(`@${approx.timestamp}`);
    if (!date) throw new InvalidDateError(text);
    return date;
  }

  /**
   * builtin/commit.c's find_author_by_nickname: the first commit of `rev-list --all -i
   * --author=<name>` (newest first, the mailmap applied before matching) gives `%aN <%aE>`.
   */
  private async findAuthorByNickname(name: string): Promise<string> {
    let pattern: PosixRegex;
    try {
      pattern = compilePosixRegex(name, { icase: true });
    } catch (error) {
      throw new InvalidArgumentError(
        "author",
        name,
        `fatal: '${name}': ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const mailmap = await this.loadMailmap(RemoteConfigStore.from(this.workingCopy));
    const encoder = new TextEncoder();
    // revision.c's walk of --all: refs under refs/ in name order, then HEAD, tags peeled;
    // commits come out by commit date, newest first
    const starts: { name: string; id: ObjectId }[] = [];
    for await (const ref of this.refsStore.list()) {
      if (!ref.name.startsWith("refs/")) continue;
      let id = "objectId" in ref ? ref.objectId : undefined;
      if (!id) id = (await this.refsStore.resolve(ref.name).catch(() => undefined))?.objectId;
      if (id) starts.push({ name: ref.name, id });
    }
    starts.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const head = (await this.refsStore.resolve("HEAD").catch(() => undefined))?.objectId;
    const ids = starts.map((s) => s.id);
    if (head) ids.push(head);
    const queue: { id: ObjectId; commit: Commit; date: number; order: number }[] = [];
    const seen = new Set<ObjectId>();
    let order = 0;
    const put = async (start: ObjectId) => {
      let id = start;
      const tags = this.tagsStore;
      for (let depth = 0; depth < 32 && tags && (await tags.has(id).catch(() => false)); depth++) {
        const tag = await tags.load(id).catch(() => undefined);
        if (!tag) break;
        id = tag.object;
      }
      if (seen.has(id)) return;
      const commit = await this.commits.load(id).catch(() => undefined);
      if (!commit) return;
      seen.add(id);
      queue.push({ id, commit, date: commit.committer.timestamp, order: order++ });
    };
    for (const id of ids) await put(id);
    while (queue.length > 0) {
      let best = 0;
      for (let i = 1; i < queue.length; i++) {
        const a = queue[i] as (typeof queue)[number];
        const b = queue[best] as (typeof queue)[number];
        if (a.date > b.date || (a.date === b.date && a.order < b.order)) best = i;
      }
      const [next] = queue.splice(best, 1);
      if (!next) break;
      const who = mailmap.map(next.commit.author.name, next.commit.author.email);
      if (pattern.test(encoder.encode(`${who.name} <${who.email}>`))) {
        return `${who.name} <${who.email}>`;
      }
      for (const parent of next.commit.parents) await put(parent);
    }
    throw new InvalidArgumentError(
      "author",
      name,
      `fatal: --author '${name}' is not 'Name <email>' and matches no existing author`,
    );
  }

  /**
   * parse_and_validate_options for `-C`, `-c`, `--fixup` and `--squash`, in git's order: the
   * incompatible options, the commit `-C`/`-c` names read (`could not lookup commit`), then
   * `--fixup`'s suboption (`amend:`/`reword:` allow empty commits; `reword:` refuses paths,
   * `-a`, `-i` and a merge or cherry-pick in progress).
   */
  private async checkReuseOptions(): Promise<void> {
    if (this.fixupSpec !== undefined && this.squashFrom !== undefined) {
      throw new IncompatibleOptionsError(
        ["--squash", "--fixup"],
        "fatal: options '--squash' and '--fixup' cannot be used together",
      );
    }
    refuseIncompatible([
      ["-C", this.reuseMessage !== undefined],
      ["-c", this.reeditMessageFrom !== undefined],
      ["--fixup", this.fixupSpec !== undefined],
    ]);
    refuseIncompatible([
      ["-m", this.message !== undefined],
      ["-c", this.reeditMessageFrom !== undefined],
      ["-C", this.reuseMessage !== undefined],
    ]);
    const use = this.reusedName();
    if (use !== undefined) this.reused = await this.lookupCommit(use);
    if (this.fixupSpec === undefined) return;
    const parsed = parseFixupSpec(this.fixupSpec);
    if ("unknown" in parsed) {
      throw new InvalidArgumentError(
        "fixup",
        this.fixupSpec,
        `fatal: unknown option: --fixup=${parsed.unknown}:${parsed.target}`,
      );
    }
    this.fixup = parsed;
    if (parsed.kind === "fixup") return;
    this.allowEmpty = true;
    if (parsed.kind !== "reword") return;
    // check_fixup_reword_options
    const state = new OperationState(this.workingCopy.checkout, this.refsStore);
    if ((await this.mergeHeads(state)).length > 0) {
      throw new InvalidArgumentError(
        "fixup",
        this.fixupSpec,
        "fatal: You are in the middle of a merge -- cannot reword.",
      );
    }
    const pick = await state.ref("CHERRY_PICK_HEAD");
    // (a rebase stopped at a pick is no cherry-pick: git's is_from_cherry_pick)
    if (
      pick &&
      !(
        (await state.read("rebase-merge/head-name")) !== undefined &&
        (await state.ref("REBASE_HEAD")) === pick
      )
    ) {
      throw new InvalidArgumentError(
        "fixup",
        this.fixupSpec,
        "fatal: You are in the middle of a cherry-pick -- cannot reword.",
      );
    }
    const path = this.onlyPaths[0] ?? this.includePaths[0];
    if (path !== undefined) {
      throw new IncompatibleOptionsError(
        ["--fixup", "paths"],
        `fatal: reword option of '--fixup' and path '${path}' cannot be used together`,
      );
    }
    if (this.all || this.include) {
      throw new IncompatibleOptionsError(
        ["--fixup", "--all"],
        "fatal: reword option of '--fixup' and '--patch/--interactive/--all/--include/--only' cannot be used together",
      );
    }
  }

  /** git's lookup_commit_reference_by_name, dying as `could not lookup commit '<name>'`. */
  private async lookupCommit(name: string): Promise<Commit> {
    const fatal = `fatal: could not lookup commit '${name}'`;
    let id: ObjectId;
    try {
      id = await this.resolveRevision(name);
    } catch (error) {
      if (error instanceof RefNotFoundError) throw new GitApiError(fatal);
      throw error;
    }
    const peeled = await this.revisionResolver().peelTags(id);
    const commit = peeled.type === "commit" ? await this.commits.load(peeled.id) : undefined;
    if (!commit) {
      throw new GitApiError(
        peeled.type
          ? `error: object ${peeled.id} is a ${peeled.type}, not a commit\n${fatal}`
          : fatal,
      );
    }
    return this.inCommitOutputEncoding(peeled.id, commit);
  }

  /**
   * A commit's message and author as `git commit` reads another commit's (read_commit_message,
   * format_commit_message): converted from its `encoding` header into the commit output
   * encoding (`i18n.commitEncoding`, else UTF-8). Ours writes UTF-8 messages only, so a
   * commit is converted only when that encoding is UTF-8.
   */
  private async inCommitOutputEncoding(id: ObjectId, commit: Commit): Promise<Commit> {
    if (commit.encoding === undefined) return commit;
    const configured = RemoteConfigStore.from(this.workingCopy).value("i18n.commitEncoding");
    const output = configured ? configured : "UTF-8";
    if (!/^utf-?8$/i.test(output)) return commit;
    const raw = await this.readRawObject(id);
    const parts = raw && reencodedCommitParts(raw, output);
    if (!parts) return commit;
    return { ...commit, message: parts.message, ...(parts.author ? { author: parts.author } : {}) };
  }

  /** The stored bytes of an object (undefined where the store cannot give them). */
  private async readRawObject(id: ObjectId): Promise<Uint8Array | undefined> {
    const objects = this.workingCopy.history?.objects;
    if (!objects) return undefined;
    try {
      const obj = await objects.get(id);
      if (!obj) return undefined;
      if (obj.bytes) return obj.bytes;
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const c of obj.content) {
        chunks.push(c);
        size += c.length;
      }
      const out = new Uint8Array(size);
      let at = 0;
      for (const c of chunks) {
        out.set(c, at);
        at += c.length;
      }
      return out;
    } catch {
      return undefined;
    }
  }

  /**
   * The start of prepare_to_commit's message from `-C`/`-c`/`--fixup`/`--squash`: the
   * `squash! ` subject (`prefix`, put before whatever message follows) and, for `-C`/`-c`
   * and `--fixup`, the text that replaces the other sources (undefined: they apply).
   */
  private async reusedMessage(): Promise<{ prefix: string; text: string | undefined }> {
    let prefix = "";
    if (this.squashFrom !== undefined) {
      prefix =
        (this.reusedName() ?? (this.amend && !this.fixup ? "HEAD" : undefined)) === this.squashFrom
          ? "squash! "
          : autosquashSubject("squash", (await this.lookupCommit(this.squashFrom)).message);
    }
    if (this.reused) return { prefix, text: skipBlankLines(this.reused.message) };
    if (!this.fixup) return { prefix, text: undefined };
    const target = await this.lookupCommit(this.fixup.target);
    if (this.fixup.kind === "fixup") {
      const given = this.message !== undefined ? completeLine(this.message) : "";
      return { prefix, text: autosquashSubject("fixup", target.message) + given };
    }
    if (this.message !== undefined) {
      throw new IncompatibleOptionsError(
        ["-m", "--fixup"],
        `fatal: options '-m' and '--fixup:${this.fixup.kind}' cannot be used together`,
      );
    }
    return {
      prefix,
      text: autosquashSubject("amend", target.message) + amendCommitText(target.message),
    };
  }

  /** `-i <paths>`: parse_and_validate_options' and prepare_index's refusals. */
  private checkIncludeOptions(): void {
    if (this.onlyPaths.length > 0) {
      throw new IncompatibleOptionsError(
        ["-i/--include", "-o/--only"],
        "fatal: options '-i/--include' and '-o/--only' cannot be used together",
      );
    }
    if (this.all) {
      throw new IncompatibleOptionsError(
        ["-i/--include", "-a/--all"],
        "fatal: options '-i/--include' and '-a/--all' cannot be used together",
      );
    }
    if (this.includePaths.length === 0) {
      throw new InvalidArgumentError(
        "include",
        [],
        "fatal: No paths with --include/--only does not make sense.",
      );
    }
  }

  /**
   * The commit, once `-a` staged the tracked changes (`index`: the index lock it holds).
   * A partial commit takes the lock itself.
   */
  private async commitWith(partial: boolean, held: HeldIndex | undefined): Promise<CommitResult> {
    let index = held;

    // Check for conflicts (a partial commit records HEAD and the named paths: other
    // unmerged paths stay in the index, as git's)
    if (!partial && (await this.staging.hasConflicts())) {
      const conflictPaths = await this.staging.getConflictedPaths();
      throw new UnmergedPathsError(
        conflictPaths,
        [
          "error: Committing is not possible because you have unmerged files.",
          "hint: Fix them up in the work tree, and then use 'git add/rm <file>'",
          "hint: as appropriate to mark resolution and make a commit.",
          "fatal: Exiting because of an unresolved conflict.",
        ].join("\n"),
      );
    }

    // a merge, cherry-pick or revert in progress (git's whence: MERGE_HEAD,
    // CHERRY_PICK_HEAD, REVERT_HEAD), and the message it prepared
    const state = new OperationState(this.workingCopy.checkout, this.refsStore);
    const mergeHeads = await this.mergeHeads(state);
    const pickHead = await state.ref("CHERRY_PICK_HEAD");
    if (this.resetAuthor && !this.amend && !this.reused && !pickHead) {
      throw new InvalidArgumentError(
        "reset-author",
        true,
        "fatal: --reset-author can be used only with -C, -c or --amend.",
      );
    }
    if (this.amend && mergeHeads.length > 0) {
      throw new InvalidArgumentError(
        "amend",
        true,
        "fatal: You are in the middle of a merge -- cannot amend.",
      );
    }
    // a partial commit: the paths named, from the index and HEAD (git's list_paths)
    const headId = (await this.refsStore.resolve("HEAD"))?.objectId;
    let partialTree: ObjectId | undefined;
    let falseIndexFile: FalseIndexFile | undefined;
    // (`--fixup=reword:` names no path: the false index is HEAD's tree)
    const partialPaths = partial
      ? this.fixup?.kind === "reword"
        ? new Map<string, boolean>()
        : await this.listPartialPaths(state, mergeHeads, headId)
      : undefined;
    if (partialPaths) {
      // git's partial commit (prepare_index): the index lock taken once the paths are
      // listed, the named paths taken from the worktree into the index and written into
      // the lock (renamed over the index once HEAD has moved), the commit's tree HEAD's with
      // the same paths taken; any failure leaves the index as it was
      index = await this.holdIndex();
      try {
        const falseIndex = await this.preparePartialCommit(partialPaths, headId, index);
        partialTree = await this.storeFalseIndex(falseIndex);
        // the hooks are given the false index as a file (git's next-index-<pid>.lock),
        // removed once the commit is made or given up
        if (this.hooks.enabled) {
          falseIndexFile = await this.writeFalseIndexFile(falseIndex);
          if (falseIndexFile) index = withCleanup(index, falseIndexFile.remove);
        }
      } catch (error) {
        await falseIndexFile?.remove();
        await index.release();
        throw error;
      }
    }
    try {
      return await this.commitPrepared(
        partialTree,
        state,
        mergeHeads,
        pickHead,
        index,
        falseIndexFile,
      );
    } catch (error) {
      await index?.release();
      throw error;
    }
  }

  /**
   * A partial commit's false index written as git's `prepare_index` writes it for the hooks
   * (`$GIT_DIR/next-index-<pid>.lock`): HEAD's tree with the named paths taken, each entry
   * the index has unchanged keeping its stat data (create_base_index's one-way merge), the
   * others none. Undefined where the repository's files cannot hold it.
   */
  private async writeFalseIndexFile(falseIndex: FalseIndex): Promise<FalseIndexFile | undefined> {
    // git names it by its process id; any number no file has will do here
    let name = "";
    let target: { files: FilesApi; path: string } | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      name = `next-index-${10000 + Math.floor(Math.random() * 90000)}.lock`;
      target = await this.hooks.gitFile(name);
      if (!target) return undefined;
      if ((await target.files.stats(target.path)) === undefined) break;
      target = undefined;
    }
    if (!target) throw new Error("could not choose a name for the false index file");
    const lock = target;
    const files = await this.falseIndexFiles(falseIndex);
    const current = new Map<string, StagingEntry>();
    for await (const entry of this.staging.entries()) {
      if (entry.stage === 0) current.set(entry.path, entry);
    }
    const temp = new FileStagingStore(lock.files, lock.path);
    const builder = temp.createBuilder();
    for (const path of [...files.keys()].sort(compareGitPaths)) {
      const file = files.get(path) as { objectId: ObjectId; mode: number };
      const kept = current.get(path);
      if (kept && kept.objectId === file.objectId && kept.mode === file.mode && !kept.intentToAdd) {
        builder.add(kept);
      } else {
        builder.add({ path, mode: file.mode, objectId: file.objectId, size: 0, mtime: 0 });
      }
    }
    await builder.finish();
    const remove = async () => {
      await lock.files.remove(lock.path).catch(() => false);
    };
    // the file is ours from its first byte: a failure before it is handed over removes it
    try {
      await temp.write();
      return {
        hostPath: await this.hooks.gitPath(name, true),
        reread: async () => {
          await temp.read();
          return writeIndexAsTree(temp, this.trees, this.objectFormat, { write: false });
        },
        remove,
      };
    } catch (error) {
      await remove();
      throw error;
    }
  }

  /** The commit made from the index (or the partial commit's tree), after the index is ready. */
  private async commitPrepared(
    partialTreeIn: ObjectId | undefined,
    state: OperationState,
    mergeHeads: ObjectId[],
    pickHead: ObjectId | undefined,
    index: HeldIndex | undefined,
    falseIndexFile?: FalseIndexFile,
  ): Promise<CommitResult> {
    let partialTree = partialTreeIn;
    // an editor edits the message (git's use_editor): no message given, or -e; without an
    // editor set, a merge's or a pick's prepared message (MERGE_MSG, SQUASH_MSG) is taken as
    // `git commit --no-status` takes it once the editor leaves it as it is (the template
    // written to COMMIT_EDITMSG; the status too with setIncludeStatus(true)), unless
    // setEdit(false) (`--no-edit`)
    const mergeMsgPresent =
      (await state.read("MERGE_MSG")) !== undefined ||
      (await state.read("SQUASH_MSG")) !== undefined;
    const reused = this.reused;
    // (-c, --squash and --fixup=amend:/reword: prepare a message for the editor: without
    // one it is taken as it is, as with GIT_EDITOR=:)
    const preparedForEditor =
      this.reeditMessageFrom !== undefined ||
      this.squashFrom !== undefined ||
      (this.fixup !== undefined && this.fixup.kind !== "fixup");
    const editorLike =
      this.usesEditor() ||
      (this.edit !== false &&
        this.editsByDefault() &&
        ((!reused && !this.amend && mergeMsgPresent) || preparedForEditor));
    const editor: CommitEditor = this.usesEditor()
      ? (this.editor as CommitEditor)
      : async () => undefined;
    const message = this.message;
    if (
      !editorLike &&
      message === undefined &&
      !reused &&
      !this.amend &&
      !mergeMsgPresent &&
      !this.fixup &&
      this.squashFrom === undefined
    ) {
      throw new NoMessageError();
    }

    // prepare_to_commit's pre-commit hook (not with --no-verify), over the index the commit
    // records (the lock `-a` and a partial commit wrote); a hook that ran may have changed
    // the index, which is read again (git's discard_index + read_index_from)
    // (a partial commit's hooks see its false index; `-a` the index lock, read back from
    // the lock; a plain commit the index)
    const hookEnv = await this.commitHookEnv(editorLike, index, falseIndexFile?.hostPath);
    if (!this.noVerify && this.hooks.enabled) {
      if (index) await index.write();
      if (await this.runCommitHook("pre-commit", hookEnv)) {
        if (falseIndexFile) partialTree = await falseIndexFile.reread();
        else if (index) await index.reread();
        else await this.staging.read();
      }
    }

    // Determine parents
    let parents: ObjectId[];
    if (this.parents.length > 0) {
      parents = this.parents;
    } else if (this.amend) {
      // Use amended commit's parents
      const headId = await this.resolveHead();
      const headCommit = await this.commits.load(headId);
      if (!headCommit) {
        throw new NoHeadError("Cannot amend: HEAD commit not found");
      }
      parents = headCommit.parents;
    } else {
      // Normal commit - HEAD as parent (if exists)
      try {
        const headId = await this.resolveHead();
        parents = [headId];
      } catch {
        // Initial commit
        parents = [];
      }
      if (mergeHeads.length > 0) {
        // a merge commit: HEAD and MERGE_HEAD's commits; reduced to the independent ones
        // unless MERGE_MODE says no-ff (git's reduce_heads_replace)
        parents = [...parents, ...mergeHeads.filter((id) => !parents.includes(id))];
        const mode = (await state.read("MERGE_MODE")) ?? "";
        if (!/\bno-ff\b/.test(mode)) parents = await this.reduceHeads(parents);
      }
    }

    // Generate tree from staging area
    let treeId: ObjectId;
    if (partialTree) {
      treeId = partialTree;
    } else if (index) {
      // `-a`: the index with a fully valid cache-tree (cache_tree_update), written into the
      // lock
      treeId = await writeIndexAsTree(this.staging, this.trees, this.objectFormat, {
        write: false,
      });
      await index.write();
    } else {
      // Normal mode: use full staging area; as git's prepare_index, the index is written
      // again with a fully valid cache-tree (cache_tree_update, which keeps the valid nodes:
      // a stored subtree no edit touched stays the one stored)
      treeId = await writeIndexAsTree(this.staging, this.trees, this.objectFormat);
    }
    let previousCommit: Commit | undefined;
    let amendedId: ObjectId | undefined;

    if (this.amend) {
      const headId = await this.resolveHead();
      amendedId = headId;
      previousCommit = await this.commits.load(headId);
      if (!previousCommit) {
        throw new NoHeadError("Cannot amend: HEAD commit not found");
      }
      // (its message and author as git reads them: use_message = "HEAD")
      previousCommit = await this.inCommitOutputEncoding(headId, previousCommit);
    }

    // The author (git's determine_author_info): the one given; else an amended commit's or
    // a concluded cherry-pick's author (its date too; `--author` replaces only the name and
    // email), unless --reset-author; else resolved as git does (GIT_AUTHOR_*, author.*,
    // user.*, GIT_AUTHOR_DATE or now)
    // (`--amend --fixup` keeps no author: git's author_message is use_message's, which
    // --fixup leaves unset)
    const amendKeeps = this.amend && !!previousCommit && !this.fixup;
    let author = this.author;
    if (!author) {
      // (git's author_message: a cherry-pick's CHERRY_PICK_HEAD, else -C's commit, else the
      // amended HEAD)
      const kept = this.resetAuthor
        ? undefined
        : pickHead
          ? (await this.commits.load(pickHead))?.author
          : reused
            ? reused.author
            : amendKeeps
              ? previousCommit?.author
              : undefined;
      if (kept) {
        author = this.authorName
          ? {
              ...kept,
              name: withoutCrud(this.authorName.name),
              email: withoutCrud(this.authorName.email),
            }
          : kept;
      } else if (this.authorName) author = this.datedIdent("author", this.authorName);
      else author = this.resolveAuthor(this.committer ?? this.committerName);
    }
    // --date: the author's date, whatever gave the rest
    const forced = this.forcedDate();
    if (forced) author = { ...author, ...forced };
    // the committer: always resolved (GIT_COMMITTER_*, committer.*, user.*), unless given
    const committer =
      this.committer ??
      (this.committerName
        ? this.datedIdent("committer", this.committerName)
        : this.resolveCommitter(author));

    let finalMessage: string;
    let cleanup: CleanupMode;
    let untouched = false;
    if (editorLike) {
      const edited = await this.editMessage(
        {
          state,
          mergeHeads,
          pickHead,
          partialTree,
          treeId,
          firstParent: parents[0],
          previousCommit,
          author,
          committer,
          // author_date_is_interesting: an author_message, or --date
          authorKept:
            !this.author &&
            (this.forceDate !== undefined ||
              (!this.resetAuthor && (amendKeeps || !!pickHead || !!reused))),
          hookEnv,
        },
        editor,
      );
      finalMessage = edited.message;
      cleanup = edited.cleanup;
      untouched = edited.untouched;
    } else {
      // prepare_to_commit without an editor: the message so far (`-m`, the amended commit's,
      // else MERGE_MSG after SQUASH_MSG, or SQUASH_MSG) with its whitespace cleaned up
      // unless verbatim (`get_cleanup_mode` without an editor: default and scissors are
      // whitespace) is written to COMMIT_EDITMSG; then a commit with nothing to commit is
      // refused; then the file's text is cleaned up (cleanup_message) and checked
      cleanup = commitCleanupMode(this.workingCopy, this.cleanupMode);
      const reusedMessage = await this.reusedMessage();
      let sb: string;
      if (reusedMessage.text !== undefined) sb = reusedMessage.text;
      else if (message !== undefined) sb = completeLine(message);
      else if (previousCommit) sb = previousCommit.message.replace(/^(?:[ \t\r]*\n)+/, "");
      else {
        const mergeMsg = await state.read("MERGE_MSG");
        const squashMsg = await state.read("SQUASH_MSG");
        sb = mergeMsg !== undefined ? `${squashMsg ?? ""}${mergeMsg}` : (squashMsg ?? "");
      }
      sb = reusedMessage.prefix + sb;
      if (cleanup !== CleanupMode.VERBATIM) sb = stripspace(sb);
      sb = this.signedOff(sb, committer);
      await state.write("COMMIT_EDITMSG", sb);
      // amend_file_with_trailers over COMMIT_EDITMSG
      sb = await this.withTrailers(sb, state, undefined);
      await this.refuseNothingToCommit(treeId, parents, mergeHeads, previousCommit);
      // prepare-commit-msg and commit-msg, which may rewrite COMMIT_EDITMSG: the commit
      // takes the file's text (cmd_commit reads it back)
      // (git's hook arguments: read only when hooks can run)
      const hookArgs = this.hooks.enabled
        ? this.prepareMessageHookArgs(
            await state.read("MERGE_MSG"),
            await state.read("SQUASH_MSG"),
            undefined,
            mergeHeads,
            pickHead,
          )
        : [];
      let text = sb;
      if (await this.runMessageHooks(hookEnv, hookArgs, undefined)) {
        text = (await state.read("COMMIT_EDITMSG")) ?? "";
      }
      // cleanup_message: cut at the scissors line with -v (commit.verbose)
      if (this.verboseLevel() > 0) {
        const comment = commentPrefixOf(this.workingCopy, sb);
        const cut = `${comment} ------------------------ >8 ------------------------\n`;
        if (text.startsWith(cut)) text = "";
        else {
          const at = text.indexOf(`\n${cut}`);
          if (at >= 0) text = text.slice(0, at + 1);
        }
      }
      finalMessage = cleanupWith(this.workingCopy, text, cleanup, true);
    }

    // git's message_is_empty: nothing but whitespace and sign-offs (any text, verbatim);
    // then template_untouched (only an editor's message: -m, -F and -C drop the template)
    if (
      !this.allowEmptyMessage &&
      (cleanup !== CleanupMode.VERBATIM || finalMessage.length === 0) &&
      isEmptyMessage(finalMessage)
    ) {
      throw new NoMessageError("Aborting commit due to empty commit message.");
    }
    if (untouched && !this.allowEmptyMessage) {
      throw new NoMessageError("Aborting commit; you did not edit the message.");
    }
    // an `amend!` message needs a body (the message the amended commit takes)
    if (this.fixup && finalMessage.startsWith("amend! ") && !this.allowEmptyMessage) {
      const body = finalMessage.slice(commitSubjectLength(finalMessage));
      if ((cleanup !== CleanupMode.VERBATIM || body.length === 0) && isEmptyMessage(body)) {
        throw new NoMessageError("Aborting commit due to empty commit message body.");
      }
    }

    return this.finishCommit(treeId, parents, mergeHeads, pickHead, {
      author,
      committer,
      finalMessage,
      state,
      amendedId,
      commitIndex: index ? () => index.commit() : undefined,
      editorUsed: editorLike,
    });
  }

  /**
   * prepare_to_commit's refusal of a commit with nothing to commit: the tree is its first
   * parent's (HEAD's, HEAD^1's when amending), or empty without a first parent, unless a merge is concluded, empty commits are
   * allowed, or a merge commit is amended.
   */
  private async refuseNothingToCommit(
    treeId: ObjectId,
    parents: ObjectId[],
    mergeHeads: ObjectId[],
    previousCommit: Commit | undefined,
  ): Promise<void> {
    if (this.allowEmpty || mergeHeads.length > 0) return;
    if (parents.length === 0) {
      // no first parent (an initial commit, or --amend of a root commit): git counts the
      // index, `cache_nr - ita_nr > 0`; only intent-to-add entries (or none) leave the tree
      // empty
      if (treeId === this.objectFormat.emptyTreeId) throw new EmptyCommitError();
      return;
    }
    if (this.amend && (previousCommit?.parents.length ?? 0) > 1) return;
    const parentCommit = await this.commits.load(parents[0] as ObjectId);
    if (parentCommit && parentCommit.tree === treeId) throw new EmptyCommitError();
  }

  /** The commit of `treeId` made, HEAD moved to it, and what was in progress ended. */
  private async finishCommit(
    treeId: ObjectId,
    parents: ObjectId[],
    mergeHeads: ObjectId[],
    pickHead: ObjectId | undefined,
    info: {
      author: PersonIdent;
      committer: PersonIdent;
      finalMessage: string;
      state: OperationState;
      amendedId: ObjectId | undefined;
      /** Renames the index lock over the index, once HEAD has moved (git's commit_index_files) */
      commitIndex?: () => Promise<void>;
      /** An editor edited the message (git's use_editor): hooks get no `GIT_EDITOR=:` */
      editorUsed?: boolean;
    },
  ): Promise<CommitResult> {
    const { author, committer, finalMessage, state, amendedId } = info;

    // Create commit
    const commit: Commit = {
      tree: treeId,
      parents,
      author,
      committer,
      message: finalMessage,
    };

    // commit_tree_extended signs the commit before writing it: no signer, git's failure
    refuseCommitSigning(signRequestOf(this.workingCopy, this.sign));
    const commitId = await this.commits.store(commit);

    // Update HEAD/branch ref, with git's reflog line in the branch's log and HEAD's
    // (builtin/commit.c: initial, amend, merge, cherry-pick, else plain)
    const initial = !(await this.refsStore.resolve("HEAD"))?.objectId;
    const kind: CommitReflogKind = initial
      ? "initial"
      : this.amend
        ? "amend"
        : mergeHeads.length > 0
          ? "merge"
          : pickHead
            ? "cherry-pick"
            : undefined;
    const action = this.hasReflogAction() ? this.reflogAction("commit") : undefined;
    const log = this.reflogLine(reflogMessages.commit(kind, finalMessage, action), committer);
    if (this.hooks.enabled) {
      // update_head_with_reflog: one transaction on HEAD expecting the commit's parent (none
      // for an initial commit), as the reference-transaction hook sees it
      const current = (await this.refsStore.resolve("HEAD"))?.objectId;
      const result = await this.refsStore.batch(
        [{ name: "HEAD", old: current ?? null, new: commitId }],
        log,
      );
      if (!result.ok) {
        throw new GitApiError(
          `fatal: cannot lock ref 'HEAD': ${result.rejected.map((r) => r.reason).join(", ")}`,
        );
      }
    } else await updateHead(this.refsStore, commitId, log);

    this.setCallable(false);

    // the commit ends what was in progress (git's sequencer_post_commit_cleanup and the
    // state files cmd_commit unlinks), then the new index (commit_index_files), then applies
    // a merge's autostash
    await this.cleanupAfterCommit(state, info.commitIndex);

    // the post-commit hook, over the index (whatever the commit recorded)
    if (this.hooks.enabled) {
      await this.hooks.run("post-commit", {
        env: await this.commitHookEnv(info.editorUsed ?? false, undefined),
      });
    }

    // commit_post_rewrite: the amended commit's notes carried over (notes.rewriteRef), then
    // the post-rewrite hook told "amend" with "<old> <new>" on stdin
    if (amendedId && !this.noPostRewrite) {
      // git exports the amend's author (determine_author_info): the notes commit's too
      await copyNotesForAmend(this.notesContext(), amendedId, commitId, commit.author);
      if (this.hooks.enabled) {
        await this.hooks.run("post-rewrite", {
          args: ["amend"],
          stdin: `${amendedId} ${commitId}\n`,
        });
      }
    }

    // Return commit with its ID (like JGit's RevCommit)
    return { ...commit, id: commitId };
  }

  /**
   * The variables of the commit hooks (git's `run_commit_hook`): `GIT_INDEX_FILE` names the
   * index the commit records (the lock `-a` and a partial commit write; git's false index of
   * a partial commit is not kept as a file here), and `GIT_EDITOR=:` tells a hook that no
   * editor runs.
   */
  private async commitHookEnv(
    editorUsed: boolean,
    index: HeldIndex | undefined,
    /** A partial commit's false index (its host path), which the hooks see in its place */
    falseIndexPath?: string,
  ): Promise<Record<string, string>> {
    if (!this.hooks.enabled) return {};
    return {
      GIT_INDEX_FILE:
        falseIndexPath ??
        (index ? await this.hooks.gitPath("index.lock", true) : await this.hooks.gitPath("index")),
      ...(editorUsed ? {} : { GIT_EDITOR: ":" }),
    };
  }

  /** Runs a hook that can refuse the commit; whether it ran. */
  private async runCommitHook(
    name: string,
    env: Record<string, string>,
    args: string[] = [],
  ): Promise<boolean> {
    const result = await this.hooks.run(name, { args, env });
    if (result && result.exitCode !== 0) {
      throw new HookFailedError(
        name,
        result.exitCode,
        `the ${name} hook refused the commit (exit code ${result.exitCode})`,
        this.hooks.output,
      );
    }
    return result !== undefined;
  }

  /**
   * The arguments of prepare-commit-msg after the message file (prepare_to_commit's
   * hook_arg1 and hook_arg2): where the message came from.
   */
  private prepareMessageHookArgs(
    mergeMsg: string | undefined,
    squashMsg: string | undefined,
    templateText: string | undefined,
    mergeHeads: ObjectId[],
    pickHead: ObjectId | undefined,
  ): string[] {
    // --squash tells "message" whatever the message's source (an empty second argument)
    if (this.squashFrom !== undefined) return ["message", ""];
    if (this.message !== undefined) return ["message"];
    const reusedName = this.reusedName();
    if (reusedName !== undefined) return ["commit", reusedName];
    if (this.fixup) return ["message"];
    // --amend without a message reuses HEAD's (git's use_message = "HEAD")
    if (this.amend) return ["commit", "HEAD"];
    if (mergeMsg !== undefined) return [squashMsg !== undefined ? "squash" : "merge"];
    if (squashMsg !== undefined) return ["squash"];
    if (templateText !== undefined) return ["template"];
    if (mergeHeads.length > 0) return ["merge"];
    if (pickHead) return ["commit", "CHERRY_PICK_HEAD"];
    return [];
  }

  /**
   * prepare-commit-msg, the editor (when one runs) and commit-msg (not with --no-verify)
   * over COMMIT_EDITMSG, in prepare_to_commit's order; whether any hook ran (the file is then
   * to be read back). A non-zero commit-msg refuses the commit, as does prepare-commit-msg.
   */
  private async runMessageHooks(
    env: Record<string, string>,
    args: string[],
    edit: (() => Promise<void>) | undefined,
  ): Promise<boolean> {
    if (!this.hooks.enabled) {
      await edit?.();
      return false;
    }
    const file = await this.hooks.gitPath("COMMIT_EDITMSG");
    let ran = await this.runCommitHook("prepare-commit-msg", env, [file, ...args]);
    await edit?.();
    if (!this.noVerify) ran = (await this.runCommitHook("commit-msg", env, [file])) || ran;
    return ran;
  }

  /** The commits MERGE_HEAD names (one per line), none without a merge in progress. */
  private async mergeHeads(state: OperationState): Promise<ObjectId[]> {
    const text = await state.read("MERGE_HEAD");
    if (text !== undefined) {
      return text
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => /^[0-9a-f]{40,64}$/.test(l));
    }
    const id = await state.ref("MERGE_HEAD");
    return id ? [id] : [];
  }

  /** The heads none of the others reaches (git's reduce_heads), in their order. */
  private async reduceHeads(heads: ObjectId[]): Promise<ObjectId[]> {
    const out: ObjectId[] = [];
    for (const head of heads) {
      let reached = false;
      for (const other of heads) {
        if (other === head) continue;
        if (await this.commits.isAncestor(head, other)) {
          reached = true;
          break;
        }
      }
      if (!reached) out.push(head);
    }
    return out.length > 0 ? out : heads.slice(0, 1);
  }

  /**
   * After the commit: the merge state removed (MERGE_HEAD, MERGE_MSG, MERGE_MODE,
   * SQUASH_MSG, AUTO_MERGE), a stopped cherry-pick or revert ended (its sequencer state
   * too once it was the last pick), and MERGE_AUTOSTASH applied back, as `git commit`.
   */
  private async cleanupAfterCommit(
    state: OperationState,
    commitIndex: (() => Promise<void>) | undefined,
  ): Promise<void> {
    if (!state.supported) {
      await commitIndex?.();
      return;
    }
    const picking =
      (await state.ref("CHERRY_PICK_HEAD")) !== undefined ||
      (await state.ref("REVERT_HEAD")) !== undefined;
    // sequencer_post_commit_cleanup: CHERRY_PICK_HEAD and REVERT_HEAD when there, AUTO_MERGE
    // in any case (git 2.5x's reference-transaction hook hears of it)
    await state.removeRef("CHERRY_PICK_HEAD", "REVERT_HEAD");
    await state.deleteRef("AUTO_MERGE");
    await state.removeRef("MERGE_HEAD");
    await state.remove("MERGE_HEAD", "MERGE_MSG", "MERGE_MODE", "SQUASH_MSG");
    if (picking) {
      // have_finished_the_last_pick: the todo holds no more than the pick just committed
      const todo = (await state.read("sequencer/todo")) ?? "";
      const left = todo.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#"));
      if (left.length <= 1) await state.remove("sequencer");
    }
    await commitIndex?.();
    const autostash = (await state.read("MERGE_AUTOSTASH"))?.trim();
    if (autostash) {
      await state.remove("MERGE_AUTOSTASH");
      await applyAutostash(
        {
          workingCopy: this.workingCopy,
          worktree: this.worktreeIterator ?? this.worktreeAccess,
          staging: this.staging,
          blobs: this.blobs,
          trees: this.trees,
          commits: this.commits,
          refs: this.refsStore,
        },
        autostash,
      );
    }
  }

  /**
   * The index held for a commit that changes it (git's `repo_hold_locked_index`): the
   * index lock taken now (a staging with an index file), released on failure with the
   * staging as it was before (read again, or its unwritten edits put back).
   */
  private async holdIndex(): Promise<HeldIndex> {
    const staging = this.staging;
    const unwritten = staging.hasUnwrittenChanges?.() !== false;
    // what the staging held, for a staging that cannot read it back (no index file) or that
    // holds edits not yet written
    let lock: StagingIndexLock | undefined;
    try {
      lock = staging.lockIndex ? await staging.lockIndex() : undefined;
    } catch (error) {
      throw indexLockError(error, this.workingCopy);
    }
    // the staging as it is, put back exactly (the entry objects kept as read included)
    const saved = !lock || unwritten ? staging.saveState?.() : undefined;
    const snapshot =
      (!lock || unwritten) && !saved
        ? {
            entries: (staging.entryList?.() ?? (await collectEntries(staging))).slice(),
            cacheTree: staging.getCacheTree?.(),
          }
        : undefined;
    let done = false;
    return {
      write: async () => {
        await lock?.write();
      },
      reread: async () => {
        if (lock?.reread) await lock.reread();
        else if (lock) await staging.read();
      },
      commit: async () => {
        if (lock) await lock.commit();
        else await staging.write();
        done = true;
      },
      release: async () => {
        if (done) return;
        done = true;
        await lock?.rollback();
        if (saved) {
          staging.restoreState?.(saved);
          return;
        }
        if (!snapshot) {
          await staging.read();
          return;
        }
        const builder = staging.createBuilder();
        for (const entry of snapshot.entries) builder.add(entry);
        await builder.finish();
        staging.setCacheTree?.(snapshot.cacheTree);
      },
    };
  }

  /**
   * The paths a partial commit takes (git's `list_paths`): those of the index (any stage)
   * and of HEAD's tree the pathspec matches (`ce_path_match`, magic and globs as git's), in
   * git's order, each with whether its index entry is skip-worktree. Refused during a
   * merge, a cherry-pick or a rebase (git's whence), and when an element of the pathspec
   * matches nothing (`report_path_error`).
   */
  private async listPartialPaths(
    state: OperationState,
    mergeHeads: ObjectId[],
    headId: ObjectId | undefined,
  ): Promise<Map<string, boolean>> {
    if (mergeHeads.length > 0) {
      throw new InvalidArgumentError(
        "only",
        this.onlyPaths,
        "fatal: cannot do a partial commit during a merge.",
      );
    }
    const pick = await state.ref("CHERRY_PICK_HEAD");
    if (pick) {
      // sequencer_determine_whence: a rebase stopped at this pick, else a cherry-pick
      const rebasing =
        (await state.read("rebase-merge/head-name")) !== undefined &&
        (await state.ref("REBASE_HEAD")) === pick;
      throw new InvalidArgumentError(
        "only",
        this.onlyPaths,
        `fatal: cannot do a partial commit during a ${rebasing ? "rebase" : "cherry-pick"}.`,
      );
    }

    let items: PathspecItem[];
    try {
      items = parsePathspec(this.onlyPaths, { attr: true });
    } catch (error) {
      throw new InvalidArgumentError("only", this.onlyPaths, `fatal: ${(error as Error).message}`);
    }
    // the elements as given (and the "." git adds when every element excludes)
    const originals =
      items.length > this.onlyPaths.length ? [...this.onlyPaths, "."] : [...this.onlyPaths];
    // git's overlay_tree_on_index: HEAD's files at stage 1, among the index's entries (its
    // conflict stages hoisted to 3), a HEAD file the index has at stage 0 left out; matched
    // in that order (the order decides what an element matched exactly skips, as in git)
    type Listed = { path: string; key: number; mode: number; skipWorktree: boolean };
    const listed: Listed[] = [];
    const stage0 = new Set<string>();
    for await (const entry of this.staging.entries()) {
      if (entry.stage === 0) stage0.add(entry.path);
      listed.push({
        path: entry.path,
        key: entry.stage === 0 ? 0 : 3,
        mode: entry.mode,
        skipWorktree: entry.skipWorktree === true,
      });
    }
    if (headId) {
      const head = await this.commits.load(headId);
      if (!head) throw new RefNotFoundError(headId, "HEAD commit not found");
      // only the directories a positive element can match something in are read
      const positive = items.filter((i) => !i.exclude);
      const mayMatch = (dir: string) => positive.some((item) => pathspecItemMayMatch(item, dir));
      const files: Array<{ path: string; mode: number }> = [];
      await this.collectTreeFiles(head.tree, "", mayMatch, files);
      for (const file of files) {
        if (!stage0.has(file.path)) listed.push({ ...file, key: 1, skipWorktree: false });
      }
      listed.sort((a, b) => compareGitPaths(a.path, b.path) || a.key - b.key);
    }
    // `:(attr:...)`: the attributes of the listed paths (match_pathspec_attrs)
    const attributes = PathspecAttributes.forWorktree(items, this.getWorktreeIterator());
    await attributes?.load(listed.map((entry) => entry.path));
    const seen = items.map(() => 0);
    const paths = new Map<string, boolean>();
    for (const entry of listed) {
      const flags = isGitlink(entry.mode) ? DO_MATCH_DIRECTORY : 0;
      if (!matchPathspecSeen(items, entry.path, flags, seen)) continue;
      paths.set(entry.path, (paths.get(entry.path) ?? false) || entry.skipWorktree);
    }
    const errors = pathspecErrors(originals, seen);
    if (errors.length > 0) {
      // report_path_error: list_paths fails, prepare_index exits 1
      throw new InvalidArgumentError(
        "only",
        originals.filter((_, i) => !seen[i]),
        errors.join("\n"),
      );
    }
    // git's string_list: sorted by the paths' bytes
    return new Map([...paths].sort(([a], [b]) => compareGitPaths(a, b)));
  }

  /** The files (and gitlinks) of a tree, in the directories `mayMatch` lets in. */
  private async collectTreeFiles(
    treeId: ObjectId,
    prefix: string,
    mayMatch: (dir: string) => boolean,
    files: Array<{ path: string; mode: number }>,
  ): Promise<void> {
    for await (const entry of this.trees.loadTree(treeId)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.mode === FileMode.TREE) {
        if (mayMatch(path)) await this.collectTreeFiles(entry.id, path, mayMatch, files);
      } else {
        files.push({ path, mode: entry.mode });
      }
    }
  }

  /**
   * git's partial commit (`prepare_index`, `add_remove_files`): each listed path (but the
   * skip-worktree ones) as git's `add_remove_files` takes it, literally: a file (ignored or
   * not) hashed and staged, a path gone removed, a submodule staged at the commit checked
   * out in it, a directory without one refused before anything changes ("'<path>' does not
   * have a commit checked out"); the index then gets its
   * cache-tree (none while it holds conflicts) and is written into the lock. The tree
   * committed is HEAD's with the same paths taken (git's false index), returned as HEAD's
   * tree and those edits: stored by {@link storeFalseIndex}, never by a dry run.
   */
  private async preparePartialCommit(
    paths: Map<string, boolean>,
    headId: ObjectId | undefined,
    index: HeldIndex,
  ): Promise<FalseIndex> {
    const taken = [...paths].filter(([, skipWorktree]) => !skipWorktree).map(([path]) => path);
    // the lstat of each path, before the index is touched
    const found = new Map<string, WorktreeEntry | undefined>();
    let worktree: Worktree | undefined;
    if (taken.length > 0) {
      worktree = this.getWorktreeIterator();
      if (!worktree) {
        throw new StoreNotAvailableError(
          "Worktree",
          "Working tree iterator required for a partial commit. " +
            "Ensure WorkingCopy has worktree or call setWorktreeStore().",
        );
      }
    }
    if (worktree) {
      for (const path of taken) {
        const entry = await worktree.getEntry(path);
        // add_to_index of a directory: a gitlink to the commit checked out in the repository
        // there (index_path's resolve_gitlink_ref, a gitfile followed), refused before
        // anything changes when there is none; git 2.5x adds the "unable to index file" line
        if (entry?.isDirectory && !(await readGitlinkHead(worktree, path))) {
          throw new GitApiError(
            `error: '${path}' does not have a commit checked out\n` +
              `error: unable to index file '${path}'\nfatal: updating files failed`,
          );
        }
        found.set(path, entry);
      }
      const trust = worktreeModeTrust(this.workingCopy, worktree);
      const adder = await IndexAdder.open(this.staging, this.blobs, trust);
      for (const path of taken) {
        const entry = found.get(path);
        if (entry) await adder.add(worktree, path, entry);
        else adder.remove(path);
      }
      await adder.finish();
    }
    // the real index, with a cache-tree made valid as git's cache_tree_update before
    // write_locked_index (none while it holds conflicts: the edits' invalidations stay)
    await updateIndexCacheTree(this.staging, this.trees, this.objectFormat);
    await index.write();

    // the false index: HEAD's tree with the same paths as the index now has them
    const edits = new Map<string, { mode: number; id: ObjectId } | null>();
    for (const path of taken) {
      const entry = found.get(path) ? await this.staging.getEntry(path) : undefined;
      edits.set(
        path,
        entry && !entry.intentToAdd ? { mode: entry.mode, id: entry.objectId } : null,
      );
    }
    const head = headId ? await this.commits.load(headId) : undefined;
    if (headId && !head) throw new RefNotFoundError(headId, "HEAD commit not found");
    return { headTree: head?.tree, edits: [...edits] };
  }

  /** The tree of a partial commit's false index, stored (with the directories it changes). */
  private async storeFalseIndex(falseIndex: FalseIndex): Promise<ObjectId> {
    return (await this.editTree(falseIndex.headTree, falseIndex.edits)) ?? this.trees.store([]);
  }

  /** The files of a partial commit's false index, without storing a tree. */
  private async falseIndexFiles(
    falseIndex: FalseIndex,
  ): Promise<Map<string, { objectId: ObjectId; mode: number }>> {
    const flat: Map<string, { objectId: ObjectId; mode: number }> = await flatTree(
      this.trees,
      falseIndex.headTree,
    );
    for (const [path, edit] of falseIndex.edits) {
      if (edit) {
        // a file in place of a directory of HEAD (or the reverse) replaces it
        for (const key of [...flat.keys()]) if (key.startsWith(`${path}/`)) flat.delete(key);
        for (let at = path.indexOf("/"); at >= 0; at = path.indexOf("/", at + 1)) {
          flat.delete(path.slice(0, at));
        }
        flat.set(path, { objectId: edit.id, mode: edit.mode });
      } else flat.delete(path);
    }
    return flat;
  }

  /**
   * A tree with the given files set (or removed, for null), only the directories on their
   * paths stored again; undefined when nothing is left in it.
   */
  private async editTree(
    treeId: ObjectId | undefined,
    edits: Array<[string, { mode: number; id: ObjectId } | null]>,
  ): Promise<ObjectId | undefined> {
    const entries = new Map<string, TreeEntry>();
    if (treeId) {
      for await (const entry of this.trees.loadTree(treeId)) entries.set(entry.name, entry);
    }
    const subdirs = new Map<string, Array<[string, { mode: number; id: ObjectId } | null]>>();
    for (const [path, edit] of edits) {
      const slash = path.indexOf("/");
      if (slash >= 0) {
        const dir = path.slice(0, slash);
        const list = subdirs.get(dir) ?? [];
        list.push([path.slice(slash + 1), edit]);
        subdirs.set(dir, list);
      } else if (edit) {
        entries.set(path, { name: path, mode: edit.mode, id: edit.id });
      } else if (entries.get(path)?.mode !== FileMode.TREE) {
        entries.delete(path);
      }
    }
    for (const [dir, list] of subdirs) {
      const existing = entries.get(dir);
      const base = existing?.mode === FileMode.TREE ? existing.id : undefined;
      const id = await this.editTree(base, list);
      if (id) entries.set(dir, { name: dir, mode: FileMode.TREE, id });
      else if (base) entries.delete(dir);
    }
    if (entries.size === 0) return undefined;
    return this.trees.store([...entries.values()]);
  }

  /**
   * Stage all modified/deleted tracked files.
   *
   * Uses AddCommand with setUpdate(true) to stage changes,
   * equivalent to `git add -u .` which JGit does for --all.
   */
  private async stageTrackedChanges(paths: string[] = []): Promise<void> {
    // Get working tree iterator
    const worktree = this.getWorktreeIterator();
    if (!worktree) {
      throw new StoreNotAvailableError(
        "Worktree",
        "Working tree iterator required for --all mode. " +
          "Ensure WorkingCopy has worktree or call setWorktreeStore().",
      );
    }

    // Use AddCommand to stage all modified tracked files
    // git's add_files_to_cache without a pathspec (`commit -a`): no element to report
    const addCommand = new AddCommand(this._workingCopy);
    addCommand.setUpdate(true);
    // `-i <paths>`: the tracked paths they match (report_path_error: an element matching no
    // index entry fails, exit status 128)
    for (const path of paths) addCommand.addFilepattern(path);
    if (paths.length > 0) addCommand.setFilesToCache(true);
    // into the index lock the commit holds, once the commit's tree is made
    addCommand.setWriteIndex(false);
    addCommand.setWorktreeStore(worktree);
    await addCommand.call();
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
}

/** git's "paths '<first> ...' with -a does not make sense". */
function pathsWithAllError(paths: readonly string[]): IncompatibleOptionsError {
  return new IncompatibleOptionsError(
    ["--all", "--only"],
    `fatal: paths '${paths[0]} ...' with -a does not make sense`,
  );
}

/** A partial commit's false index written for the hooks (see `writeFalseIndexFile`). */
interface FalseIndexFile {
  /** Its absolute host path (else its path from the worktree top): `GIT_INDEX_FILE` */
  hostPath: string;
  /** Reads it back as a hook left it: the tree to commit */
  reread(): Promise<ObjectId>;
  /** Removes it (git's rollback of `false_lock`) */
  remove(): Promise<void>;
}

/** A held index whose commit or release also runs `cleanup` (after the index's own). */
function withCleanup(index: HeldIndex, cleanup: () => Promise<void>): HeldIndex {
  return {
    write: () => index.write(),
    reread: () => index.reread(),
    commit: async () => {
      try {
        await index.commit();
      } finally {
        await cleanup();
      }
    },
    release: async () => {
      try {
        await index.release();
      } finally {
        await cleanup();
      }
    },
  };
}

/** A partial commit's false index: HEAD's tree with the named paths set or removed. */
interface FalseIndex {
  headTree: ObjectId | undefined;
  edits: Array<[string, { mode: number; id: ObjectId } | null]>;
}

/**
 * The index lock another process holds, as git's `unable_to_lock_die` reports it (git 2.5x's
 * wording: 2.43 adds "e.g. an editor opened by 'git commit'..." instead); other errors as
 * they are.
 */
function indexLockError(error: unknown, workingCopy: unknown): unknown {
  if (!(error instanceof Error) || error.name !== "IndexLockedError") return error;
  const gitDir = (workingCopy as { config?: { hostGitDir?: string } }).config?.hostGitDir;
  const lockPath = gitDir ? `${gitDir.replace(/\/+$/, "")}/index.lock` : ".git/index.lock";
  return new IndexLockFailedError(
    lockPath,
    `fatal: Unable to create '${lockPath}': File exists.\n\n` +
      "Another git process seems to be running in this repository, or the lock file may be stale",
    { cause: error },
  );
}

/** The index a commit holds while it changes it (see `CommitCommand.holdIndex`). */
interface HeldIndex {
  /** Writes the staging's entries into the index lock (nothing without an index file). */
  write(): Promise<void>;
  /** Reads the index lock back into the staging, as a hook left it (git's read_index_from). */
  reread(): Promise<void>;
  /** The index lock renamed over the index (a staging without one: written). */
  commit(): Promise<void>;
  /** On failure: the lock removed, the staging as it was before. Idempotent. */
  release(): Promise<void>;
}

/** Every entry of the staging, in its order. */
async function collectEntries(staging: Staging): Promise<StagingEntry[]> {
  const out: StagingEntry[] = [];
  for await (const entry of staging.entries()) out.push(entry);
  return out;
}

const isGitlink = (mode: number) => (mode & 0o170000) === 0o160000;

/**
 * git's `template_untouched`: the cleaned-up message is the template (cleaned up the same
 * way, comments kept unless the mode strips them) followed by nothing but whitespace and
 * sign-offs. A verbatim message that is not empty is never untouched; nor is any without a
 * template (or with an empty one).
 */
function templateUntouched(
  message: string,
  template: string | undefined,
  mode: CleanupMode,
  comment: string,
): boolean {
  if (mode === CleanupMode.VERBATIM && message.length > 0) return false;
  if (!template) return false;
  const tmpl = stripspace(template, mode === CleanupMode.STRIP ? comment : undefined);
  const rest = message.startsWith(tmpl) ? message.slice(tmpl.length) : message;
  return isEmptyMessage(rest);
}

/** git's `rest_is_empty`: only whitespace and `Signed-off-by:` lines. */
function isEmptyMessage(message: string): boolean {
  return message
    .split("\n")
    .every((line) => line.startsWith("Signed-off-by: ") || /^[ \t\r]*$/.test(line));
}

/** A git boolean (`fallback` when unset or not one). */
function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const v = value.trim().toLowerCase();
  if (v === "" || v === "false" || v === "no" || v === "off" || v === "0") return false;
  if (v === "true" || v === "yes" || v === "on" || v === "1") return true;
  return fallback;
}

/**
 * The editor of a commit message (`CommitCommand.setEditor`): the path of the message file
 * within the git directory (`COMMIT_EDITMSG`) and its text; it returns the edited text, or
 * nothing (anything but a string) when it edited the file in place.
 */
export type CommitEditor = (path: string, text: string) => Promise<unknown>;

/** What `CommitCommand.callDryRun` gives: the status text and git's exit code. */
export interface CommitDryRunResult extends StatusTextResult {
  /** 0 when there is something to commit, 1 when not (dry_run_commit) */
  exitCode: number;
}
