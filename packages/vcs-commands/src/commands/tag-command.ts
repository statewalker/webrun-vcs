import type { AnnotatedTag, ObjectId, PersonIdent, Ref } from "@statewalker/vcs-core";
import { compareRefNames, isValidTagName, ObjectType } from "@statewalker/vcs-core";
import type { WorkingCopy } from "@statewalker/vcs-working-tree";

import {
  InvalidTagNameError,
  RefAlreadyExistsError,
  RefNotFoundError,
  StoreNotAvailableError,
} from "../errors/index.js";
import { type CommandCommits, GitCommand } from "../git-command.js";
import { abbrevLengths } from "./core-config.js";
import { type CleanupMode, tagMessageFromOption } from "./message-cleanup.js";

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
  private signed = false;
  private cleanupMode?: CleanupMode;

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
    this.objectId = objectId;
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
   * Set whether to create a signed tag.
   *
   * Note: Signing is not implemented yet.
   *
   * @param signed Whether to sign
   */
  setSigned(signed: boolean): this {
    this.checkCallable();
    this.signed = signed;
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
    this.checkCallable();

    if (!this.name) {
      throw new InvalidTagNameError("", "Tag name is required");
    }

    if (!isValidTagName(this.name)) {
      throw new InvalidTagNameError(this.name);
    }

    const refName = `refs/tags/${this.name}`;

    // Check if already exists
    if (!this.force && (await this.refsStore.has(refName))) {
      throw new RefAlreadyExistsError(refName, `Tag '${this.name}' already exists`);
    }

    // Resolve target object
    const targetId = this.objectId ?? (await this.resolveHead());

    // Determine if we should create annotated tag
    // (an empty message too: git's `tag -m ""` makes an annotated tag)
    const createAnnotated = this.annotated || this.message !== undefined || this.signed;

    let tagObjectId: ObjectId;

    if (createAnnotated) {
      // Create annotated tag object
      if (!this.tagsStore) {
        throw new StoreNotAvailableError(
          "TagStore",
          "Tag store is not available for annotated tags",
        );
      }

      // git's tagger: git_committer_info(IDENT_STRICT) (GIT_COMMITTER_*, committer.*,
      // user.*), unless given
      const tagger =
        this.tagger ??
        (this.taggerName ? this.datedIdent("committer", this.taggerName) : this.resolveCommitter());

      const tag: AnnotatedTag = {
        object: targetId,
        objectType: ObjectType.COMMIT,
        tag: this.name,
        tagger,
        message:
          this.message !== undefined
            ? tagMessageFromOption(this.message, this.cleanupMode, this.workingCopy)
            : "",
      };

      tagObjectId = await this.tagsStore.storeTag(tag);
    } else {
      // Lightweight tag - just point to the object
      tagObjectId = targetId;
    }

    // git's create_reflog_msg; refs/tags/ is logged only with core.logAllRefUpdates=always
    // or an existing reflog
    const log = await tagReflogMessage(
      this.workingCopy,
      { commits: this.commits, trees: this.trees, blobs: this.blobs, tags: this.tagsStore },
      targetId,
      this.hasReflogAction() ? this.reflogAction("tag") : undefined,
    );
    await this.refsStore.set(refName, tagObjectId, this.reflogLine(log));

    this.setCallable(false);

    const ref = await this.refsStore.get(refName);
    return ref as Ref;
  }
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

  /**
   * Set the tags to delete.
   *
   * @param tags Tag names (without refs/tags/ prefix)
   */
  setTags(...tags: string[]): this {
    this.checkCallable();
    this.tags.push(...tags);
    return this;
  }

  /**
   * Execute the tag deletion.
   *
   * @returns List of deleted tag names (full ref names)
   * @throws RefNotFoundError if tag doesn't exist
   */
  async call(): Promise<string[]> {
    this.checkCallable();
    this.setCallable(false);

    const deleted: string[] = [];

    for (const name of this.tags) {
      const refName = name.startsWith("refs/") ? name : `refs/tags/${name}`;

      if (!(await this.refsStore.has(refName))) {
        // git's delete_tags: error("tag '%s' not found."), exit status 1
        throw new RefNotFoundError(refName, `Tag '${name}' not found`).withExitCode(1);
      }

      await this.refsStore.delete(refName);
      deleted.push(refName);
    }

    return deleted;
  }
}

/**
 * List tags.
 *
 * Equivalent to `git tag -l`.
 *
 * @example
 * ```typescript
 * // List all tags
 * const tags = await git.tagList().call();
 * ```
 */
export class ListTagCommand extends GitCommand<Ref[]> {
  /**
   * Execute the tag listing.
   *
   * @returns List of tag refs
   */
  async call(): Promise<Ref[]> {
    this.checkCallable();
    this.setCallable(false);

    const tags: Ref[] = [];

    for await (const ref of this.refsStore.list("refs/tags/")) {
      if ("objectId" in ref) {
        tags.push(ref);
      }
    }

    // Sort by name
    tags.sort((a, b) => compareRefNames(a.name, b.name));

    return tags;
  }
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
