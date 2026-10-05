import type { AnnotatedTag, ObjectId, PersonIdent, Ref } from "@statewalker/vcs-core";
import { ObjectType } from "@statewalker/vcs-core";

import {
  InvalidTagNameError,
  RefAlreadyExistsError,
  RefNotFoundError,
  StoreNotAvailableError,
} from "../errors/index.js";
import { GitCommand } from "../git-command.js";

/**
 * Get current timezone offset as string (+HHMM or -HHMM).
 */
function getTimezoneOffset(): string {
  const offset = new Date().getTimezoneOffset();
  const sign = offset <= 0 ? "+" : "-";
  const absOffset = Math.abs(offset);
  const hours = Math.floor(absOffset / 60)
    .toString()
    .padStart(2, "0");
  const minutes = (absOffset % 60).toString().padStart(2, "0");
  return `${sign}${hours}${minutes}`;
}

/**
 * Validate a tag name according to Git rules.
 *
 * @param name Tag name to validate
 * @returns true if valid
 */
function isValidTagName(name: string): boolean {
  // Cannot be empty
  if (!name || name.length === 0) {
    return false;
  }

  // Cannot start or end with /
  if (name.startsWith("/") || name.endsWith("/")) {
    return false;
  }

  // Cannot contain ..
  if (name.includes("..")) {
    return false;
  }

  // Cannot contain special characters (control chars, space, ~^:?*[\)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Git ref validation requires checking for control characters
  if (/[\x00-\x1f\x7f ~^:?*[\\]/.test(name)) {
    return false;
  }

  // Cannot end with .lock
  if (name.endsWith(".lock")) {
    return false;
  }

  // Cannot start with -
  if (name.startsWith("-")) {
    return false;
  }

  // Cannot be @
  if (name === "@") {
    return false;
  }

  // Cannot contain @{
  if (name.includes("@{")) {
    return false;
  }

  return true;
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
  private annotated = false;
  private force = false;
  private signed = false;

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
   * Set the tag message.
   *
   * Setting a message implies an annotated tag.
   *
   * @param message Tag message
   */
  setMessage(message: string): this {
    this.checkCallable();
    this.message = message;
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
    this.tagger = {
      name,
      email,
      timestamp: Math.floor(Date.now() / 1000),
      tzOffset: getTimezoneOffset(),
    };
    return this;
  }

  /**
   * Set the tagger identity from a PersonIdent.
   *
   * @param tagger Tagger identity
   */
  setTaggerIdent(tagger: PersonIdent): this {
    this.checkCallable();
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
    const createAnnotated = this.annotated || this.message || this.signed;

    let tagObjectId: ObjectId;

    if (createAnnotated) {
      // Create annotated tag object
      if (!this.tagsStore) {
        throw new StoreNotAvailableError(
          "TagStore",
          "Tag store is not available for annotated tags",
        );
      }

      const tagger = this.tagger ?? {
        name: "Unknown",
        email: "unknown@example.com",
        timestamp: Math.floor(Date.now() / 1000),
        tzOffset: getTimezoneOffset(),
      };

      const tag: AnnotatedTag = {
        object: targetId,
        objectType: ObjectType.COMMIT,
        tag: this.name,
        tagger,
        message: this.message ?? "",
      };

      tagObjectId = await this.tagsStore.storeTag(tag);
    } else {
      // Lightweight tag - just point to the object
      tagObjectId = targetId;
    }

    await this.refsStore.set(refName, tagObjectId);

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
        throw new RefNotFoundError(refName, `Tag '${name}' not found`);
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
    tags.sort((a, b) => a.name.localeCompare(b.name));

    return tags;
  }
}
