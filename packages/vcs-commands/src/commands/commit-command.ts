import {
  type Commit,
  FileMode,
  type ObjectId,
  type PersonIdent,
  type TreeEntry,
} from "@statewalker/vcs-core";
import { compareGitPaths } from "@statewalker/vcs-utils/encoding";
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
import { worktreeModeTrust } from "./core-config.js";
import { DEFAULT_DATE_MODE, showDate } from "./date-format.js";
import { hostEnvironmentOf, withoutCrud } from "./git-ident.js";
import { IndexAdder, readGitlinkHead } from "./index-adder.js";
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
  commitMessageFromOption,
  completeLine,
  editorCleanupMode,
  preparedMessageCleanup,
  stripspace,
} from "./message-cleanup.js";
import { copyNotesForAmend } from "./notes-support.js";
import {
  DO_MATCH_DIRECTORY,
  DO_MATCH_LEADING_PATHSPEC,
  matchPathspec,
  matchPathspecSeen,
  type PathspecItem,
  parsePathspec,
  pathspecErrors,
} from "./pathspec.js";
import { type CommitReflogKind, reflogMessages, updateHead } from "./reflog-messages.js";
import { applyAutostash } from "./sequencer-support.js";
import {
  cutLine,
  readShowUntrackedFiles,
  StatusCommand,
  type StatusTextResult,
  type UntrackedFilesMode,
} from "./status-command.js";
import { type CommitWhence, StatusPrinter } from "./status-format.js";

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
  private allowEmpty = false;
  private parents: ObjectId[] = [];
  private onlyPaths: string[] = [];
  private all = false;
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
   * Set the author identity.
   *
   * @param name Author name
   * @param email Author email
   */
  setAuthor(name: string, email: string): this {
    this.checkCallable();
    // git's --author: the name and email; the date is the amended commit's, the picked
    // commit's, else GIT_AUTHOR_DATE or now
    this.author = undefined;
    this.authorName = { name, email };
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
   * `--reset-author`: an amended commit, or the commit that concludes a cherry-pick, is
   * authored as a new one (the author resolved as git resolves it, dated now) instead of
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
    this.parents = parents;
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
    // JGit: --all and --only are mutually exclusive
    if (this.all && paths.length > 0) {
      throw new IncompatibleOptionsError(["--only", "--all"]);
    }
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
    // JGit: --all and --only are mutually exclusive
    if (all && this.onlyPaths.length > 0) {
      throw new IncompatibleOptionsError(["--all", "--only"]);
    }
    this.all = all;
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
   * prepare it (`-a` stages the tracked changes, {@link setOnly} builds the index of HEAD
   * with the named paths), then left as it was (rollback_index_files).
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
    await this.readCurrentIndex();
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
    if (this.all) {
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
    return this.edit === true || this.message === undefined;
  }

  /**
   * prepare_to_commit with an editor: COMMIT_EDITMSG written with the message so far and
   * (`commit.status`) the commented help, identities and status of the template, the
   * editor run over it, and what it left cleaned up as the commit message.
   */
  private async editMessage(ctx: {
    state: OperationState;
    mergeHeads: ObjectId[];
    pickHead: ObjectId | undefined;
    partialTree: ObjectId | undefined;
    previousCommit: Commit | undefined;
    author: PersonIdent;
    committer: PersonIdent;
    authorKept: boolean;
  }): Promise<{ message: string; cleanup: CleanupMode; untouched: boolean }> {
    const { state } = ctx;
    const config = RemoteConfigStore.from(this.workingCopy);
    const mode = editorCleanupMode(this.workingCopy, this.cleanupMode);
    const templateText = await this.readTemplate(config);
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
    if (this.message !== undefined) sb = completeLine(this.message);
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
    // clean_message_contents: not for a template, which goes in as it is
    const fromTemplate =
      this.message === undefined &&
      !(this.amend && ctx.previousCommit) &&
      mergeMsg === undefined &&
      squashMsg === undefined &&
      templateText !== undefined;
    if (mode !== CleanupMode.VERBATIM && !fromTemplate) sb = stripspace(sb);
    // core.commentChar=auto: a character the message does not start a line with
    const comment = commentPrefixOf(this.workingCopy, sb);
    const includeStatus = this.includeStatus ?? parseBool(config.value("commit.status"), true);
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
      const run = () => this.commitStatus({ format: "porcelain" });
      const status = ctx.partialTree
        ? await this.withIndexOfTree(ctx.partialTree, run)
        : await run();
      committable = status.committable;
    }
    // COMMIT_EDITMSG written in full, then an empty commit refused before the editor runs
    await state.write("COMMIT_EDITMSG", template);
    const isMerge = (ctx.previousCommit?.parents.length ?? 0) > 1;
    if (!committable && whence !== "merge" && !this.allowEmpty && !(this.amend && isMerge)) {
      throw new EmptyCommitError();
    }
    const edited = await (this.editor as CommitEditor)("COMMIT_EDITMSG", template);
    let text: string;
    if (typeof edited === "string") {
      await state.write("COMMIT_EDITMSG", edited);
      text = edited;
    } else text = (await state.read("COMMIT_EDITMSG")) ?? "";
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
    // the index as it is now: one another writer replaced is read again (git reads the
    // index at its start), unless this instance holds unwritten edits (refused)
    await this.readCurrentIndex();
    const partial = this.onlyPaths.length > 0;
    if (!this.all) return this.commitWith(partial, undefined);
    // `-a` (git's COMMIT_NORMAL): the index lock held from before the tracked changes are
    // staged until HEAD has moved
    const index = await this.holdIndex();
    try {
      // Handle --all flag: auto-stage modified tracked files
      await this.stageTrackedChanges();
      return await this.commitWith(partial, index);
    } catch (error) {
      await index.release();
      throw error;
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
    const partialPaths = partial
      ? await this.listPartialPaths(state, mergeHeads, headId)
      : undefined;
    if (partialPaths) {
      // git's partial commit (prepare_index): the index lock taken once the paths are
      // listed, the named paths taken from the worktree into the index and written into
      // the lock (renamed over the index once HEAD has moved), the commit's tree HEAD's with
      // the same paths taken; any failure leaves the index as it was
      index = await this.holdIndex();
      try {
        partialTree = await this.storeFalseIndex(
          await this.preparePartialCommit(partialPaths, headId, index),
        );
      } catch (error) {
        await index.release();
        throw error;
      }
    }
    try {
      return await this.commitPrepared(partialTree, state, mergeHeads, pickHead, index);
    } catch (error) {
      await index?.release();
      throw error;
    }
  }

  /** The commit made from the index (or the partial commit's tree), after the index is ready. */
  private async commitPrepared(
    partialTree: ObjectId | undefined,
    state: OperationState,
    mergeHeads: ObjectId[],
    pickHead: ObjectId | undefined,
    index: HeldIndex | undefined,
  ): Promise<CommitResult> {
    // an editor edits the message (git's use_editor): no message given, or -e
    const editing = this.usesEditor();
    let message = this.message;
    const given = message !== undefined;
    if (!editing && message === undefined && !this.amend) {
      const prepared = (await state.read("MERGE_MSG")) ?? (await state.read("SQUASH_MSG"));
      // as git commit leaves it once the editor accepts it: comments stripped, or as
      // setCleanupMode / commit.cleanup say, with core.commentChar's character
      const cleaned =
        prepared !== undefined
          ? preparedMessageCleanup(this.workingCopy, prepared, this.cleanupMode)
          : "";
      if (cleaned) message = cleaned;
    }

    // Check message
    if (!editing && message === undefined && !this.amend) {
      throw new NoMessageError();
    }

    // Get message (from amend or new): a message given is git's `-m` (its line ended, then
    // cleaned up); one prepared by a merge or pick was cleaned up above
    let cleanup: CleanupMode = commitCleanupMode(this.workingCopy, this.cleanupMode);
    let finalMessage = editing
      ? undefined
      : given && message !== undefined
        ? commitMessageFromOption(message, this.cleanupMode, this.workingCopy, true)
        : message;
    let previousCommit: Commit | undefined;
    let amendedId: ObjectId | undefined;

    if (this.amend) {
      const headId = await this.resolveHead();
      amendedId = headId;
      previousCommit = await this.commits.load(headId);
      if (!previousCommit) {
        throw new NoHeadError("Cannot amend: HEAD commit not found");
      }
      if (finalMessage === undefined && !editing) {
        // `--amend --no-edit`: the amended commit's message, cleaned up as any other
        finalMessage = cleanupWith(this.workingCopy, previousCommit.message, cleanup, true);
      }
    }

    // The author (git's determine_author_info): the one given; else an amended commit's or
    // a concluded cherry-pick's author (its date too; `--author` replaces only the name and
    // email), unless --reset-author; else resolved as git does (GIT_AUTHOR_*, author.*,
    // user.*, GIT_AUTHOR_DATE or now)
    let author = this.author;
    if (!author) {
      const kept = this.resetAuthor
        ? undefined
        : this.amend && previousCommit
          ? previousCommit.author
          : pickHead
            ? (await this.commits.load(pickHead))?.author
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
    // the committer: always resolved (GIT_COMMITTER_*, committer.*, user.*), unless given
    const committer =
      this.committer ??
      (this.committerName
        ? this.datedIdent("committer", this.committerName)
        : this.resolveCommitter(author));

    let untouched = false;
    if (editing) {
      const edited = await this.editMessage({
        state,
        mergeHeads,
        pickHead,
        partialTree,
        previousCommit,
        author,
        committer,
        authorKept: !this.author && !this.resetAuthor && (!!previousCommit || !!pickHead),
      });
      finalMessage = edited.message;
      cleanup = edited.cleanup;
      untouched = edited.untouched;
    }

    // git's message_is_empty: nothing but whitespace and sign-offs (any text, verbatim)
    if (
      finalMessage === undefined ||
      (!this.allowEmptyMessage &&
        (cleanup !== CleanupMode.VERBATIM || finalMessage.length === 0) &&
        isEmptyMessage(finalMessage))
    ) {
      throw new NoMessageError("Aborting commit due to empty commit message.");
    }
    if (untouched && !this.allowEmptyMessage) {
      throw new NoMessageError("Aborting commit; you did not edit the message.");
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
      treeId = await writeIndexAsTree(this.staging, this.trees, { write: false });
      await index.write();
    } else {
      // Normal mode: use full staging area; as git's prepare_index, the index is written
      // again with a fully valid cache-tree (cache_tree_update, which keeps the valid nodes:
      // a stored subtree no edit touched stays the one stored)
      treeId = await writeIndexAsTree(this.staging, this.trees);
    }
    return this.finishCommit(treeId, parents, mergeHeads, pickHead, {
      author,
      committer,
      finalMessage,
      state,
      amendedId,
      commitIndex: index ? () => index.commit() : undefined,
    });
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
    },
  ): Promise<CommitResult> {
    const { author, committer, finalMessage, state, amendedId } = info;
    // Check for empty commit (a merge may record HEAD's tree)
    if (!this.allowEmpty && parents.length > 0 && mergeHeads.length === 0) {
      const parentCommit = await this.commits.load(parents[0]);
      if (parentCommit && parentCommit.tree === treeId) {
        throw new EmptyCommitError();
      }
    }

    // Create commit
    const commit: Commit = {
      tree: treeId,
      parents,
      author,
      committer,
      message: finalMessage,
    };

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
    await updateHead(
      this.refsStore,
      commitId,
      this.reflogLine(reflogMessages.commit(kind, finalMessage, action), committer),
    );

    this.setCallable(false);

    // the commit ends what was in progress (git's sequencer_post_commit_cleanup and the
    // state files cmd_commit unlinks), then the new index (commit_index_files), then applies
    // a merge's autostash
    await this.cleanupAfterCommit(state, info.commitIndex);

    // commit_post_rewrite: the amended commit's notes carried over (notes.rewriteRef)
    if (amendedId && !this.noPostRewrite) {
      // git exports the amend's author (determine_author_info): the notes commit's too
      await copyNotesForAmend(this.notesContext(), amendedId, commitId, commit.author);
    }

    // Return commit with its ID (like JGit's RevCommit)
    return { ...commit, id: commitId };
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
    await state.removeRef("CHERRY_PICK_HEAD", "REVERT_HEAD", "AUTO_MERGE", "MERGE_HEAD");
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
      items = parsePathspec(this.onlyPaths);
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
      const mayMatch = (dir: string) =>
        matchPathspec(positive, dir, DO_MATCH_DIRECTORY | DO_MATCH_LEADING_PATHSPEC) > 0;
      const files: Array<{ path: string; mode: number }> = [];
      await this.collectTreeFiles(head.tree, "", mayMatch, files);
      for (const file of files) {
        if (!stage0.has(file.path)) listed.push({ ...file, key: 1, skipWorktree: false });
      }
      listed.sort((a, b) => compareGitPaths(a.path, b.path) || a.key - b.key);
    }
    const seen = items.map(() => 0);
    const paths = new Map<string, boolean>();
    for (const entry of listed) {
      const flags = isGitlink(entry.mode) ? DO_MATCH_DIRECTORY : 0;
      if (!matchPathspecSeen(items, entry.path, flags, seen)) continue;
      paths.set(entry.path, (paths.get(entry.path) ?? false) || entry.skipWorktree);
    }
    const errors = pathspecErrors(originals, seen);
    if (errors.length > 0) {
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
    await updateIndexCacheTree(this.staging, this.trees);
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
  private async stageTrackedChanges(): Promise<void> {
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
