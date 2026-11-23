import type { AnnotatedTag, ObjectId, PersonIdent, Ref } from "@statewalker/vcs-core";
import { compareRefNames, isValidTagName, ObjectType } from "@statewalker/vcs-core";
import { parseGitBool } from "@statewalker/vcs-utils";
import type { WorkingCopy } from "@statewalker/vcs-working-tree";

import {
  GitApiError,
  InvalidArgumentError,
  InvalidTagNameError,
  RefAlreadyExistsError,
  RefFilterError,
  RefNotFoundError,
  StoreNotAvailableError,
} from "../errors/index.js";
import { type CommandCommits, GitCommand } from "../git-command.js";
import { RemoteConfigStore } from "../remote-config/index.js";
import type { CommitEditor } from "./commit-command.js";
import { abbrevLengths } from "./core-config.js";
import { OperationState } from "./merge-support.js";
import { CleanupMode, commentPrefixOf, completeLine, stripspace } from "./message-cleanup.js";
import { canonicalObjectId, isFullHexObjectId } from "./object-id-input.js";
import {
  filterAndFormatRefs,
  filterRefs,
  parseRefSorting,
  type RefFilterOptions,
  RefFormat,
  RefKind,
  RefListingCommand,
  type RefSortKey,
} from "./ref-filter/index.js";
import { SIGNING_FAILED_LINES, SigningFailedError } from "./signing.js";
import {
  amendWithTrailers,
  type TrailerCommandRunner,
  trailerConfigOf,
  validateTrailerArgs,
} from "./trailers.js";

/** What `git tag <name>` printed ({@link TagCommand.callText}). */
export interface TagCreateResult {
  /** The tag's ref as written */
  ref: Ref;
  /** git's stdout: `Updated tag '<name>' (was <abbrev>)` and its newline under `-f`, else empty */
  output: string;
  /** git's stderr lines (the nested-tag advice) */
  warnings: string[];
  /** The value the tag had before (under `-f`) */
  previous?: ObjectId;
}

/** The object type codes of a tag's `type` header. */
const OBJECT_TYPE_CODES = {
  commit: ObjectType.COMMIT,
  tree: ObjectType.TREE,
  blob: ObjectType.BLOB,
  tag: ObjectType.TAG,
} as const;

/** builtin/tag.c's tag_template (strip) and tag_template_nocleanup (whitespace, verbatim). */
function tagTemplate(name: string, comment: string, cleanup: CleanupMode): string {
  const tail =
    cleanup === CleanupMode.STRIP
      ? `Lines starting with '${comment}' will be ignored.\n`
      : `Lines starting with '${comment}' will be kept; you may remove them yourself if you want to.\n`;
  return `\nWrite a message for tag:\n  ${name}\n${tail}`;
}

/**
 * strbuf_add_commented_lines: each line after the comment prefix, and a space unless the
 * line is empty or starts with a tab.
 */
function commentedLines(text: string, prefix: string): string {
  let out = "";
  for (const line of text.split(/(?<=\n)/)) {
    if (line === "") continue;
    out += prefix;
    if (line[0] !== "\n" && line[0] !== "\t") out += " ";
    out += line;
  }
  return out;
}

/** create_tag's advice when the tagged object is a tag (`advice.nestedTag`). */
function nestedTagAdvice(
  name: string,
  objectRef: string,
  compatibility: "2.43" | "2.56",
): string[] {
  return [
    "hint: You have created a nested tag. The object referred to by your new tag is",
    "hint: already a tag. If you meant to tag the object that it points to, use:",
    // 2.43's advise_if_enabled wrote "hint: " before an empty line too
    compatibility === "2.43" ? "hint: " : "hint:",
    `hint: \tgit tag -f ${name} ${objectRef}^{}`,
    compatibility === "2.43"
      ? 'hint: Disable this message with "git config advice.nestedTag false"'
      : 'hint: Disable this message with "git config set advice.nestedTag false"',
  ];
}

/**
 * Create a tag (lightweight or annotated).
 *
 * Equivalent to `git tag`.
 *
 * Based on JGit's TagCommand.
 *
 * @example
 * ```typescript
 * // Create lightweight tag at HEAD
 * await git.tag().setName("v1.0.0").call();
 *
 * // Create lightweight tag at specific commit
 * await git.tag()
 *   .setName("v1.0.0")
 *   .setObjectId(commitId)
 *   .call();
 *
 * // Create annotated tag
 * await git.tag()
 *   .setName("v1.0.0")
 *   .setMessage("Release version 1.0.0")
 *   .setAnnotated(true)
 *   .call();
 *
 * // Force overwrite existing tag
 * await git.tag()
 *   .setName("v1.0.0")
 *   .setForce(true)
 *   .call();
 * ```
 */
export class TagCommand extends GitCommand<Ref> {
  private name?: string;
  private message?: string;
  private objectId?: ObjectId;
  private tagger?: PersonIdent;
  /** A tagger named without a date, dated when the tag is made */
  private taggerName?: { name: string; email: string };
  private annotated = false;
  private force = false;
  /** `-s` / `--no-sign` (undefined: `tag.gpgSign`) */
  private signed?: boolean;
  /** `-u <key-id>` */
  private signingKey?: string;
  private cleanupMode?: CleanupMode;
  /** `-e` */
  private edit = false;
  private editor?: CommitEditor;
  private createReflog = false;
  /** `--trailer` arguments, in order */
  private trailerArgs: string[] = [];
  private compatibility?: "2.43" | "2.56";

  /**
   * Set the tag name.
   *
   * @param name Tag name (without refs/tags/ prefix)
   */
  setName(name: string): this {
    this.checkCallable();
    this.name = name;
    return this;
  }

  /**
   * Set the tag message, as git's `tag -m` takes it: cleaned up as `strip` by default
   * (comment lines dropped, trailing whitespace and surrounding blank lines dropped, a
   * final newline), so `"Release"` is stored as `"Release\n"`; see {@link setCleanupMode}.
   *
   * Setting a message implies an annotated tag, an empty one too.
   *
   * @param message Tag message
   */
  setMessage(message: string): this {
    this.checkCallable();
    this.message = message;
    return this;
  }

  /**
   * Add a paragraph to the message, as each further `-m` of `git tag` does: joined to the
   * message so far by a blank line (`-m a -m b` is `"a\n\nb"` before its cleanup). The
   * first call is {@link setMessage}.
   *
   * @param message One paragraph of the tag message
   */
  addMessage(message: string): this {
    this.checkCallable();
    // git's parse_msg_arg: "\n\n" before the next -m only after a non-empty one
    this.message = !this.message ? message : `${this.message}\n\n${message}`;
    return this;
  }

  /**
   * How the message is cleaned up (git's `tag --cleanup=<mode>`): `strip` (the default),
   * `whitespace` (comment lines kept) or `verbatim` (the message as given, no newline
   * added). `default` and `scissors` are refused, as git refuses them for a tag
   * (`fatal: Invalid cleanup mode default`).
   */
  setCleanupMode(mode: CleanupMode): this {
    this.checkCallable();
    this.cleanupMode = mode;
    return this;
  }

  /**
   * Set the object to tag.
   *
   * If not set, tags HEAD.
   *
   * @param objectId Object to tag
   */
  setObjectId(objectId: ObjectId): this {
    this.checkCallable();
    this.objectId = canonicalObjectId(objectId);
    return this;
  }

  /**
   * Set whether this is an annotated tag.
   *
   * Annotated tags are stored as objects and can have messages.
   *
   * @param annotated Whether to create annotated tag
   */
  setAnnotated(annotated: boolean): this {
    this.checkCallable();
    this.annotated = annotated;
    return this;
  }

  /**
   * Set the tagger identity.
   *
   * @param name Tagger name
   * @param email Tagger email
   */
  setTagger(name: string, email: string): this {
    this.checkCallable();
    // dated as git dates a tagger: GIT_COMMITTER_DATE, else now
    this.tagger = undefined;
    this.taggerName = { name, email };
    return this;
  }

  /**
   * Set the tagger identity from a PersonIdent.
   *
   * @param tagger Tagger identity
   */
  setTaggerIdent(tagger: PersonIdent): this {
    this.checkCallable();
    this.taggerName = undefined;
    this.tagger = tagger;
    return this;
  }

  /**
   * Set whether to force overwrite existing tag.
   *
   * @param force Whether to force
   */
  setForce(force: boolean): this {
    this.checkCallable();
    this.force = force;
    return this;
  }

  /**
   * `-s` (true) / `--no-sign` (false): whether to make a signed tag (an annotated one);
   * undefined (the default) leaves it to `tag.gpgSign`, and `tag.forceSignAnnotated` signs
   * a tag with a message not made with {@link setAnnotated}, as git's does.
   *
   * No signer exists yet: a tag asked to be signed fails as git fails when gpg cannot sign
   * (`error: gpg failed to sign the data:`, `error: unable to sign the tag`, exit 128:
   * {@link SigningFailedError}), and neither a tag object nor a ref is written.
   *
   * @param signed Whether to sign
   */
  setSigned(signed: boolean | undefined): this {
    this.checkCallable();
    this.signed = signed;
    return this;
  }

  /**
   * `-u <key-id>`: make a tag signed with this key (whatever {@link setSigned} says, as
   * git's `-u` with `--no-sign`); refused as {@link setSigned} says.
   */
  setSigningKey(keyId: string): this {
    this.checkCallable();
    this.signingKey = keyId;
    return this;
  }

  /**
   * `-e` / `--edit`: the message (`-m` or the default one) goes through the editor
   * ({@link setEditor}) before it is stored, as git's `tag -e`. git 2.5x makes an annotated
   * tag of `-e` alone; 2.43 ignored `-e` without a message (a lightweight tag).
   */
  setEdit(edit: boolean): this {
    this.checkCallable();
    this.edit = edit;
    return this;
  }

  /**
   * The editor of the tag message (git's `core.editor` / `GIT_EDITOR`): given the path of
   * the message file in the git directory (`TAG_EDITMSG`) and its text, it returns the edited
   * text, or anything else after editing the file in place. It runs where git launches the
   * editor: with {@link setEdit}, or for an annotated tag made without a message (the text is
   * then the previous tag's body under `-f`, else git's template, `# Write a message for
   * tag:`). Without an editor that text is taken as it is (as `GIT_EDITOR=:`), so an annotated
   * tag without a message fails as git's `fatal: no tag message?`. An editor that throws
   * fails the tag as git's `Please supply the message using either -m or -F option.` (exit 1).
   *
   * @example
   * ```typescript
   * await git.tag().setName("v1").setEdit(true).setMessage("Release")
   *   .setEditor(async (_path, text) => `${text}\nNotes.\n`).call();
   * ```
   */
  setEditor(editor: CommitEditor): this {
    this.checkCallable();
    this.editor = editor;
    return this;
  }

  /**
   * `--create-reflog`: create the tag's reflog (git's REF_FORCE_CREATE_REFLOG), whatever
   * `core.logAllRefUpdates` says.
   */
  setCreateReflog(create: boolean): this {
    this.checkCallable();
    this.createReflog = create;
    return this;
  }

  /**
   * `--trailer <token>[(=|:)<value>]` (git 2.46+): a trailer added to the message as git's
   * `interpret-trailers --no-divider --trailer` adds it (`trailer.*` configuration applies),
   * before the editor runs. A trailer alone makes an annotated tag and launches the editor,
   * as git does.
   */
  addTrailer(trailer: string): this {
    this.checkCallable();
    this.trailerArgs.push(trailer);
    return this;
  }

  /**
   * The git version to follow where versions differ (default: the hook runner's, else 2.56):
   * 2.43 ignores `-e` without a message, writes a `-m` message into the editor's file as
   * given (no newline added, an empty one too) and has no `--trailer`.
   */
  setCompatibility(version: "2.43" | "2.56"): this {
    this.checkCallable();
    this.compatibility = version;
    return this;
  }

  /**
   * Execute the tag creation.
   *
   * @returns The created tag ref
   * @throws InvalidTagNameError if tag name is invalid
   * @throws RefAlreadyExistsError if tag exists and force is false
   */
  async call(): Promise<Ref> {
    return (await this.callText()).ref;
  }

  /**
   * `git tag <name> [<object>]` with git's output: `Updated tag '<name>' (was <abbrev>)` when
   * `-f` moved an existing tag, and the nested-tag advice (`advice.nestedTag`) when the
   * tagged object is a tag itself.
   *
   * @throws GitApiError with git's message and exit status where git dies (`fatal: tag 'x'
   *   already exists`, `fatal: 'x' is not a valid tag name.`, `fatal: no tag message?`, ...)
   */
  async callText(): Promise<TagCreateResult> {
    this.checkCallable();

    if (this.name === undefined) {
      throw new InvalidTagNameError("", "Tag name is required");
    }
    const name = this.name;
    const compatibility = this.compatibility ?? this.hooks.compatibility;
    if (compatibility === "2.43" && this.trailerArgs.length > 0) {
      throw new GitApiError("error: unknown option `trailer'", { exitCode: 129 });
    }

    // cmd_tag: the object first, then the name, then whether the tag exists
    const objectRef = this.objectId ?? "HEAD";
    let targetId: ObjectId;
    try {
      // a full id in either case, else any revision (git's `get_oid`)
      targetId =
        this.objectId === undefined
          ? await this.resolveHead()
          : isFullHexObjectId(this.objectId)
            ? this.objectId
            : await this.resolveRevision(this.objectId);
    } catch (e) {
      if (!(e instanceof GitApiError)) throw e;
      throw new RefNotFoundError(
        objectRef,
        `fatal: Failed to resolve '${objectRef}' as a valid ref.`,
      );
    }

    // check_tag_ref: 2.43 took a tag named HEAD
    if (!isValidTagName(name) && !(compatibility === "2.43" && name === "HEAD")) {
      throw new InvalidTagNameError(name, `fatal: '${name}' is not a valid tag name.`);
    }
    const refName = `refs/tags/${name}`;

    const existing = await this.refsStore.resolve(refName).catch(() => undefined);
    const prev = existing && "objectId" in existing ? existing.objectId : undefined;
    if (prev !== undefined && !this.force) {
      throw new RefAlreadyExistsError(refName, `fatal: tag '${name}' already exists`);
    }
    const cleanup = this.cleanupMode ?? CleanupMode.STRIP;
    if (
      cleanup !== CleanupMode.STRIP &&
      cleanup !== CleanupMode.WHITESPACE &&
      cleanup !== CleanupMode.VERBATIM
    ) {
      throw new InvalidArgumentError("cleanup", cleanup, `fatal: Invalid cleanup mode ${cleanup}`);
    }

    // git's cmd_tag: -u signs whatever --no-sign says, -s/--no-sign win over tag.gpgSign
    const config = RemoteConfigStore.from(this.workingCopy);
    let sign =
      this.signingKey !== undefined ||
      (this.signed ?? configBool(config.value("tag.gpgSign"), false));
    // an annotated tag: -a, -m (an empty one too), -s, --trailer, and in 2.5x -e
    const createAnnotated =
      this.annotated ||
      this.message !== undefined ||
      sign ||
      this.trailerArgs.length > 0 ||
      (this.edit && compatibility !== "2.43");
    // tag.forceSignAnnotated signs a tag object not asked for with -a (git's
    // `force_sign_annotate && !annotate`)
    if (
      createAnnotated &&
      !this.annotated &&
      configBool(config.value("tag.forceSignAnnotated"), false)
    ) {
      sign = true;
    }

    const warnings: string[] = [];
    const state = new OperationState(this.workingCopy.checkout, this.refsStore);
    let tagObjectId: ObjectId;

    if (createAnnotated) {
      if (!this.tagsStore) {
        throw new StoreNotAvailableError(
          "TagStore",
          "Tag store is not available for annotated tags",
        );
      }
      const resolver = this.revisionResolver();
      const type = await resolver.objectType(targetId);
      if (type === undefined) throw new GitApiError("fatal: bad object type.");
      if (type === "tag" && configBool(config.value("advice.nestedTag"), true)) {
        warnings.push(...nestedTagAdvice(name, objectRef, compatibility));
      }

      const message = await this.tagMessage(name, prev, cleanup, compatibility, state);

      // git's tagger: git_committer_info(IDENT_STRICT) (GIT_COMMITTER_*, committer.*,
      // user.*), unless given
      const tagger =
        this.tagger ??
        (this.taggerName ? this.datedIdent("committer", this.taggerName) : this.resolveCommitter());

      const tag: AnnotatedTag = {
        object: targetId,
        objectType: OBJECT_TYPE_CODES[type],
        tag: name,
        tagger,
        message,
      };

      // build_tag_object signs before writing: no signer, git's failure (exit(128))
      if (sign) throw await this.tagSigningFailed();
      tagObjectId = await this.tagsStore.storeTag(tag);
    } else {
      // Lightweight tag - just point to the object
      tagObjectId = targetId;
    }

    // git's create_reflog_msg; refs/tags/ is logged only with core.logAllRefUpdates=always,
    // an existing reflog or --create-reflog
    const log = await tagReflogMessage(
      this.workingCopy,
      { commits: this.commits, trees: this.trees, blobs: this.blobs, tags: this.tagsStore },
      targetId,
      this.hasReflogAction() ? this.reflogAction("tag") : undefined,
    );
    // one transaction: the tag from the value read (none, or `prev` under -f)
    const result = await this.refsStore.batch(
      [{ name: refName, old: prev ?? null, new: tagObjectId, noDeref: true }],
      { ...this.reflogLine(log), ...(this.createReflog ? { createReflog: true } : {}) },
    );
    if (!result.ok) {
      const reasons = result.rejected.map((r) => r.reason).join(", ");
      throw new GitApiError(`fatal: cannot update ref '${refName}': ${reasons}`);
    }
    // the message file goes once the tag is made (unlink_or_warn of TAG_EDITMSG)
    if (createAnnotated && state.supported) await state.remove("TAG_EDITMSG");

    this.setCallable(false);

    let output = "";
    if (this.force && prev !== undefined && prev !== tagObjectId) {
      output = `Updated tag '${name}' (was ${await this.abbreviateObjectId(prev)})\n`;
    }
    const ref = (await this.refsStore.get(refName)) as Ref;
    return { ref, output, warnings, ...(prev !== undefined ? { previous: prev } : {}) };
  }

  /**
   * create_tag's message: the one given, else (or with -e) what the editor leaves of
   * TAG_EDITMSG (the message, the previous tag's body, or git's template), the trailers
   * added first, then cleaned up; an empty one refused unless a message was given.
   */
  private async tagMessage(
    name: string,
    prev: ObjectId | undefined,
    cleanup: CleanupMode,
    compatibility: "2.43" | "2.56",
    state: OperationState,
  ): Promise<string> {
    const messageGiven = this.message !== undefined;
    let buf = this.message ?? "";
    const shouldEdit = this.edit || !messageGiven;
    const comment = commentPrefixOf(this.workingCopy);
    if (shouldEdit || this.trailerArgs.length > 0) {
      let text: string;
      if (messageGiven && compatibility === "2.43") text = buf;
      else if (messageGiven && buf.length > 0) text = completeLine(buf);
      else if (prev !== undefined) text = await this.tagBody(prev);
      else text = `\n${commentedLines(tagTemplate(name, comment, cleanup), comment)}`;
      await state.write("TAG_EDITMSG", text);
      if (this.trailerArgs.length > 0) {
        const trailerConfig = { ...trailerConfigOf(this.workingCopy), commentString: comment };
        const refused = validateTrailerArgs(this.trailerArgs, trailerConfig);
        if (refused !== undefined) {
          throw new GitApiError(`${refused}\nfatal: unable to pass trailers to --trailers`, {
            exitCode: 128,
          });
        }
        const hooks = this.hooks;
        const runCommand: TrailerCommandRunner | undefined = hooks.enabled
          ? (command) => hooks.runShellCommand("trailer", command.command, command.args)
          : undefined;
        text = (await amendWithTrailers(text, this.trailerArgs, trailerConfig, runCommand)).output;
        await state.write("TAG_EDITMSG", text);
      }
      if (shouldEdit && this.editor) {
        let edited: unknown;
        try {
          edited = await this.editor("TAG_EDITMSG", text);
        } catch (e) {
          if (e instanceof GitApiError) throw e;
          throw new GitApiError("Please supply the message using either -m or -F option.", {
            exitCode: 1,
            cause: e,
          });
        }
        if (typeof edited === "string") {
          await state.write("TAG_EDITMSG", edited);
          buf = edited;
        } else {
          buf = (state.supported ? await state.read("TAG_EDITMSG") : undefined) ?? text;
        }
      } else {
        buf = text;
      }
    }
    if (cleanup !== CleanupMode.VERBATIM) {
      buf = stripspace(buf, cleanup === CleanupMode.STRIP ? comment : undefined);
    }
    if (!messageGiven && buf.length === 0) throw new GitApiError("fatal: no tag message?");
    return buf;
  }

  /** write_tag_body: the previous tag object's message without its signature, else nothing. */
  private async tagBody(prev: ObjectId): Promise<string> {
    if ((await this.revisionResolver().objectType(prev)) !== "tag") return "";
    const tag = await this.tagsStore?.loadTag(prev).catch(() => undefined);
    return tag?.message ?? "";
  }

  /**
   * git's failure to sign a tag (create_tag): gpg's error, `error: unable to sign the tag`,
   * and where the message was left (`TAG_EDITMSG` in the git directory, named as git names
   * it from the top of the worktree: `.git/TAG_EDITMSG`), exit 128.
   */
  private async tagSigningFailed(): Promise<SigningFailedError> {
    const gitDir = (await this.hooks.hostGitDir({ real: false }).catch(() => undefined))?.replace(
      /\/+$/,
      "",
    );
    const top = (await this.hostWorkingDir())?.replace(/\/+$/, "");
    const path =
      gitDir === undefined
        ? ".git/TAG_EDITMSG"
        : top !== undefined && gitDir.startsWith(`${top}/`)
          ? `${gitDir.slice(top.length + 1)}/TAG_EDITMSG`
          : `${gitDir}/TAG_EDITMSG`;
    return new SigningFailedError(
      [
        ...SIGNING_FAILED_LINES,
        "error: unable to sign the tag",
        `The tag message has been left in ${path}`,
      ].join("\n"),
      this.signingKey ?? "",
      128,
    );
  }
}

/** A git boolean (`git_config_bool`), else `fallback`. */
function configBool(value: string | undefined, fallback: boolean): boolean {
  return value === undefined ? fallback : (parseGitBool(value) ?? fallback);
}

/**
 * Delete tags.
 *
 * Equivalent to `git tag -d`.
 *
 * @example
 * ```typescript
 * // Delete a tag
 * const deleted = await git.tagDelete().setTags("v1.0.0").call();
 * ```
 */
export class DeleteTagCommand extends GitCommand<string[]> {
  private tags: string[] = [];
  private compatibility?: "2.43" | "2.56";

  /**
   * Set the tags to delete.
   *
   * @param tags Tag names (without refs/tags/ prefix: git deletes `refs/tags/<name>` for
   *   every name, so `refs/tags/x` names `refs/tags/refs/tags/x`)
   */
  setTags(...tags: string[]): this {
    this.checkCallable();
    this.tags.push(...tags);
    return this;
  }

  /**
   * The git version whose messages to follow (default: the hook runner's, else 2.56): a tag
   * named twice makes 2.43 print a second `error: could not delete references: ` line.
   */
  setCompatibility(version: "2.43" | "2.56"): this {
    this.checkCallable();
    this.compatibility = version;
    return this;
  }

  /**
   * Execute the tag deletion.
   *
   * @returns List of deleted tag names (full ref names)
   * @throws RefNotFoundError if tag doesn't exist (the others are still deleted)
   */
  async call(): Promise<string[]> {
    const result = await this.run();
    if (result.refusals.length > 0) throw GitApiError.ofRefusals(result.refusals);
    if (result.failure) throw result.failure;
    return result.deleted;
  }

  /**
   * `git tag -d <name>...` with git's output: `Deleted tag '<name>' (was <abbrev>)` per tag
   * deleted, `error: tag '<name>' not found.` per missing one (the others still deleted) and
   * exit status 1 after any error; a tag named twice deletes nothing (git's one transaction
   * refuses `multiple updates for ref`).
   */
  async callText(): Promise<TagDeleteResult> {
    const result = await this.run();
    return {
      deleted: result.deleted,
      output: result.output,
      errors: result.errors,
      exitCode: result.errors.length > 0 ? 1 : 0,
    };
  }

  /** git's delete_tags. */
  private async run(): Promise<{
    deleted: string[];
    output: string;
    errors: string[];
    refusals: { error: GitApiError; text: string }[];
    failure?: GitApiError;
  }> {
    this.checkCallable();
    this.setCallable(false);
    const compatibility = this.compatibility ?? this.hooks.compatibility;

    // for_each_tag_name: each name read as refs/tags/<name> (each missing one reported,
    // the others collected in order), then all of them deleted with one refs_delete_refs
    const collected: { name: string; refName: string; objectId: ObjectId }[] = [];
    const refusals: { error: GitApiError; text: string }[] = [];
    const errors: string[] = [];
    for (const name of this.tags) {
      const refName = `refs/tags/${name}`;
      const ref = await this.refsStore.resolve(refName).catch(() => undefined);
      if (!ref || !("objectId" in ref) || !ref.objectId) {
        const text = `error: tag '${name}' not found.`;
        refusals.push({
          error: new RefNotFoundError(refName, `Tag '${name}' not found`).withExitCode(1),
          text,
        });
        errors.push(text);
        continue;
      }
      collected.push({ name, refName, objectId: ref.objectId });
    }

    const names = collected.map((c) => c.refName);
    const duplicate = [...names].sort().find((n, i, sorted) => i > 0 && sorted[i - 1] === n);
    let failure: GitApiError | undefined;
    let removed: string[] = [];
    if (duplicate !== undefined) {
      // ref_update_reject_duplicates: the transaction refused whole
      const lines = [
        `error: could not delete references: multiple updates for ref '${duplicate}' not allowed`,
      ];
      // 2.43's files_delete_refs reports the packed store's failure, then its own
      if (compatibility === "2.43") lines.push("error: could not delete references: ");
      errors.push(...lines);
      failure = new GitApiError(lines.join("\n"), { exitCode: 1 });
    } else if (names.length > 0) {
      const outcome = await this.removeRefsAsGit(names);
      removed = outcome.removed;
      if (outcome.error !== undefined) throw outcome.error;
    }

    let output = "";
    for (const c of collected) {
      if (!removed.includes(c.refName)) continue;
      output += `Deleted tag '${c.name}' (was ${await this.abbreviateObjectId(c.objectId)})\n`;
    }
    return {
      deleted: removed,
      output,
      errors,
      refusals,
      ...(failure ? { failure } : {}),
    };
  }
}

/** What `git tag -d` printed ({@link DeleteTagCommand.callText}). */
export interface TagDeleteResult {
  /** The refs deleted (full names) */
  deleted: string[];
  /** git's stdout: a `Deleted tag '<name>' (was <abbrev>)` line per deleted tag */
  output: string;
  /** git's stderr lines (`error: tag 'x' not found.`, ...) */
  errors: string[];
  /** git's exit status: 1 after any error, else 0 */
  exitCode: number;
}

/** What `git tag --list` printed ({@link ListTagCommand.callText}). */
export interface TagListResult {
  /** git's stdout: each tag's line and its newline (bytes outside UTF-8 as `decodeGitPath` keeps them) */
  output: string;
  /** Each shown tag's line, in order (an empty one left out with `--omit-empty`) */
  lines: string[];
  /** The tags shown, in order */
  tags: { refname: string; objectId: ObjectId }[];
  /** git's warnings on stderr */
  warnings: string[];
}

/**
 * List tags.
 *
 * Equivalent to `git tag --list [-n[<num>]] [--contains <commit>] [--no-contains <commit>]
 * [--points-at <object>] [--merged <commit>] [--no-merged <commit>] [--sort=<key>]
 * [--format=<format>] [--omit-empty] [--[no-]color] [-i] [<pattern>...]`, on git's ref
 * filter: {@link call} gives the refs the filters keep, in name order; {@link callText}
 * gives git's output (`tag.sort` and `--sort` keys, `versionsort.suffix`, `-n<num>`'s
 * annotations as builtin/tag.c's `list_tags` formats them).
 *
 * @example
 * ```typescript
 * // List all tags
 * const tags = await git.tagList().call();
 *
 * // git tag -n2 --sort=-version:refname 'v*'
 * const { output } = await git
 *   .tagList()
 *   .setLines(2)
 *   .setSort("-version:refname")
 *   .setPatterns("v*")
 *   .callText();
 * ```
 */
export class ListTagCommand extends RefListingCommand<Ref[]> {
  private patterns: string[] = [];
  private lines?: number;
  private format?: string;
  /** git starts its sort list with `tag.sort` (else `refname`); `--no-sort` clears it */
  private configSort = true;
  private sortKeys: string[] = [];
  private ignoreCase = false;
  private omitEmpty = false;
  private color?: boolean;
  private pointsAt: string[] = [];
  private contains: string[] = [];
  private noContains: string[] = [];
  private merged: string[] = [];
  private noMerged: string[] = [];
  private compatibility: "2.43" | "2.56" = "2.56";

  /** `<pattern>...`: tags whose name (after `refs/tags/`) matches one of these globs. */
  setPatterns(...patterns: string[]): this {
    this.checkCallable();
    this.patterns = patterns;
    return this;
  }

  /**
   * `-n<num>` (`-n` alone is 1): each tag followed by `num` lines of its annotation (a
   * lightweight tag's commit message, a signed tag's message without the signature, nothing
   * for a tree or blob), as `%(align:15)%(refname:lstrip=2)%(end) %(contents:lines=<num>)`;
   * 0 lists the names alone. Ignored with {@link setFormat}.
   */
  setLines(lines = 1): this {
    this.checkCallable();
    this.lines = lines;
    return this;
  }

  /** `--format=<format>`: each tag through git's ref format language. */
  setFormat(format: string): this {
    this.checkCallable();
    this.format = format;
    return this;
  }

  /**
   * `--sort=<key>` for each key, in command-line order (the last is the primary key), after
   * the `tag.sort` keys; `version:refname` (`v:`) compares as versions (`versionsort.suffix`).
   */
  setSort(...keys: string[]): this {
    this.checkCallable();
    this.sortKeys = keys;
    return this;
  }

  /** `--no-sort`: the `tag.sort` keys, the default `refname` and the keys given so far dropped. */
  setNoSort(): this {
    this.checkCallable();
    this.configSort = false;
    this.sortKeys = [];
    return this;
  }

  /** `-i`: patterns and sorting without case. */
  setIgnoreCase(ignore: boolean): this {
    this.checkCallable();
    this.ignoreCase = ignore;
    return this;
  }

  /** `--omit-empty`: no line for a tag whose format expands to nothing. */
  setOmitEmpty(omit: boolean): this {
    this.checkCallable();
    this.omitEmpty = omit;
    return this;
  }

  /** `--color` (true) or `--no-color` (false); default: colors only under `color.ui=always`. */
  setColor(color: boolean): this {
    this.checkCallable();
    this.color = color;
    return this;
  }

  /** `--points-at[=<object>]` (HEAD without one): tags naming one of these, directly or through tags. */
  setPointsAt(...objects: string[]): this {
    this.checkCallable();
    this.pointsAt = objects.length ? objects.map(canonicalName) : ["HEAD"];
    return this;
  }

  /** `--contains[=<commit>]` (HEAD without one): tags whose commit reaches one of these. */
  setContains(...commits: string[]): this {
    this.checkCallable();
    this.contains = commits.length ? commits.map(canonicalName) : ["HEAD"];
    return this;
  }

  /** `--no-contains[=<commit>]` (HEAD without one): tags whose commit reaches none of these. */
  setNoContains(...commits: string[]): this {
    this.checkCallable();
    this.noContains = commits.length ? commits.map(canonicalName) : ["HEAD"];
    return this;
  }

  /** `--merged[=<commit>]` (HEAD without one): tags whose commit one of these reaches. */
  setMerged(...commits: string[]): this {
    this.checkCallable();
    this.merged = commits.length ? commits.map(canonicalName) : ["HEAD"];
    return this;
  }

  /** `--no-merged[=<commit>]` (HEAD without one): tags whose commit none of these reaches. */
  setNoMerged(...commits: string[]): this {
    this.checkCallable();
    this.noMerged = commits.length ? commits.map(canonicalName) : ["HEAD"];
    return this;
  }

  /**
   * The git version whose `--format` output to follow where versions differ (default 2.56;
   * see `ForEachRefCommand.setCompatibility`).
   */
  setCompatibility(version: "2.43" | "2.56"): this {
    this.checkCallable();
    this.compatibility = version;
    return this;
  }

  private async filterOptions(): Promise<RefFilterOptions> {
    const resolved = await this.resolveFilterArgs({
      pointsAt: this.pointsAt,
      contains: this.contains,
      noContains: this.noContains,
      merged: this.merged,
      noMerged: this.noMerged,
    });
    return {
      kind: RefKind.TAGS,
      patterns: this.patterns,
      ignoreCase: this.ignoreCase,
      ...resolved,
    };
  }

  /**
   * Execute the tag listing.
   *
   * @returns The tag refs the filters keep, in name order
   * @throws RefFilterError where git refuses an option (a name that is no commit)
   */
  async call(): Promise<Ref[]> {
    this.checkCallable();
    this.setCallable(false);
    const { items } = await filterRefs(this.filterSource(), await this.filterOptions());
    // one listing of the tags, not a lookup per kept tag (a packed ref's lookup reads
    // packed-refs again: quadratic over thousands of tags)
    const listed = new Map<string, Ref>();
    for await (const ref of this.refsStore.list("refs/tags/")) {
      if ("objectId" in ref) listed.set(ref.name, ref);
    }
    const tags: Ref[] = [];
    for (const item of items) {
      if (item.flags.symref) continue;
      const ref = listed.get(item.refname);
      if (ref) tags.push(ref);
    }
    tags.sort((a, b) => compareRefNames(a.name, b.name));
    return tags;
  }

  /**
   * `git tag --list`'s output.
   *
   * @throws RefFilterError where git refuses an option or dies (bad format, bad sort key,
   *   a name that is no commit)
   */
  async callText(): Promise<TagListResult> {
    this.checkCallable();
    this.setCallable(false);
    const config = RemoteConfigStore.from(this.workingCopy);
    // parse_options resolves --contains & co. in its callbacks, before anything else
    const filter = await this.filterOptions();
    // repo_config: tag.sort keys, else "refname"; --sort appends, --no-sort clears
    const configured = config.values("tag.sort");
    const sortKeys = this.configSort
      ? [...(configured.length ? configured : ["refname"]), ...this.sortKeys]
      : [...this.sortKeys];
    // want_color(GIT_COLOR_UNKNOWN): color.ui, and only `always` colors without a terminal
    const useColor = this.color ?? config.value("color.ui")?.trim().toLowerCase() === "always";
    const formatSource = this.formatSource();
    const compatibility = this.compatibility;
    const formatOptions = { useColor, compatibility } as const;
    // ref_sorting_options runs before list_tags verifies the format
    const sortFormat = new RefFormat("", formatSource, formatOptions);
    parseRefSorting(sortKeys, sortFormat);
    // git 2.43 collects `%(ahead-behind)` bases per format: atoms the sort keys parsed first
    // (into a dummy format) get none
    const sortedFirst = new Set(
      compatibility === "2.43" ? sortFormat.atoms.map((a) => a.name) : [],
    );
    // list_tags: -n<num> (negative: none) annotates with %(contents:lines=<num>)
    const lines = this.lines === undefined || this.lines === -1 ? 0 : this.lines;
    const formatText =
      this.format ??
      (lines
        ? `%(align:15)%(refname:lstrip=2)%(end) %(contents:lines=${lines})`
        : "%(refname:lstrip=2)");
    let format: RefFormat;
    try {
      format = new RefFormat(formatText, formatSource, formatOptions);
    } catch (e) {
      // verify_ref_format's error, then tag's death
      if (e instanceof RefFilterError && e.message.startsWith("error: malformed format string")) {
        throw new RefFilterError(`${e.message}\nfatal: unable to parse format string`, 128);
      }
      throw e;
    }
    const sorting: RefSortKey[] = parseRefSorting(sortKeys, format).map((key) =>
      this.ignoreCase ? { ...key, icase: true } : key,
    );
    const source = this.filterSource();
    const aheadBehindBases: ObjectId[] = [];
    const isBaseTips: { name: string; commit: ObjectId }[] = [];
    const baseWarnings: string[] = [];
    for (const atom of format.atoms) {
      if (atom.type !== "ahead-behind" && atom.type !== "is-base") continue;
      if (sortedFirst.has(atom.name)) continue;
      const name = atom.base as string;
      const commit = await source.commitByName(name, baseWarnings);
      if (!commit) throw new RefFilterError(`fatal: failed to find '${name}'`, 128);
      if (atom.type === "ahead-behind") aheadBehindBases.push(commit);
      else isBaseTips.push({ name, commit });
    }
    const result = await filterAndFormatRefs(source, filter, sorting, format, {
      omitEmpty: this.omitEmpty,
      aheadBehindBases,
      isBaseTips,
    });
    return {
      output: result.output,
      lines: result.lines,
      tags: result.items.map((i) => ({ refname: i.refname, objectId: i.objectId })),
      warnings: [...baseWarnings, ...result.warnings],
    };
  }
}

/** A full object id canonicalised (lowercase), any other name as given. */
function canonicalName(name: string): string {
  return isFullHexObjectId(name) ? canonicalObjectId(name) : name;
}

/**
 * git's create_reflog_msg (builtin/tag.c): `tag: tagging <abbrev> (<what>)`, or
 * `<GIT_REFLOG_ACTION> (<what>)` when an action is set. `<what>` is the commit's
 * `<subject>, <YYYY-MM-DD>`, else `tree object`, `blob object`, `other tag object`, or
 * `object of unknown type`.
 */
async function tagReflogMessage(
  workingCopy: WorkingCopy,
  stores: {
    commits: CommandCommits;
    trees: { has(id: ObjectId): Promise<boolean> };
    blobs: { has(id: ObjectId): Promise<boolean> };
    tags?: { has(id: ObjectId): Promise<boolean> };
  },
  target: ObjectId,
  action?: string,
): Promise<string> {
  const has = async (store: { has(id: ObjectId): Promise<boolean> } | undefined) =>
    (await store?.has(target).catch(() => false)) ?? false;
  const commit = await stores.commits.load(target).catch(() => undefined);
  let what: string;
  if (commit) {
    const date = new Date(commit.committer.timestamp * 1000).toISOString().slice(0, 10);
    what = `${commitSubject(commit.message)}, ${date}`;
  } else if (await has(stores.trees)) what = "tree object";
  else if (await has(stores.blobs)) what = "blob object";
  else if (await has(stores.tags)) what = "other tag object";
  else what = "object of unknown type";
  if (action !== undefined) return `${action} (${what})`;
  const abbrev = (await abbrevLengths(workingCopy, [target])).get(target) ?? 7;
  return `tag: tagging ${target.slice(0, abbrev)} (${what})`;
}

/** git's find_commit_subject: the first paragraph (whitespace collapses in the reflog). */
function commitSubject(message: string): string {
  const lines = message.split("\n");
  let start = 0;
  while (start < lines.length && lines[start]?.trim() === "") start++;
  const out: string[] = [];
  for (let i = start; i < lines.length && lines[i]?.trim() !== ""; i++) out.push(lines[i] ?? "");
  return out.join(" ");
}
