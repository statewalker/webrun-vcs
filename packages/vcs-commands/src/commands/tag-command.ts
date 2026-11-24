import type { AnnotatedTag, ObjectId, PersonIdent, Ref } from "@statewalker/vcs-core";
import { compareRefNames, isValidTagName, ObjectType } from "@statewalker/vcs-core";
import { parseGitBool } from "@statewalker/vcs-utils";
import type { WorkingCopy } from "@statewalker/vcs-working-tree";

import {
  GitApiError,
  InvalidTagNameError,
  RefAlreadyExistsError,
  RefFilterError,
  RefNotFoundError,
  StoreNotAvailableError,
} from "../errors/index.js";
import { type CommandCommits, GitCommand } from "../git-command.js";
import { RemoteConfigStore } from "../remote-config/index.js";
import { abbrevLengths } from "./core-config.js";
import { type CleanupMode, tagMessageFromOption } from "./message-cleanup.js";
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
   * Not signed yet: a tag asked to be signed fails as git fails when gpg cannot sign
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
    // a full id in either case, else any revision (git's `get_oid`)
    const targetId =
      this.objectId === undefined
        ? await this.resolveHead()
        : isFullHexObjectId(this.objectId)
          ? this.objectId
          : await this.resolveRevision(this.objectId);

    // git's cmd_tag: -u signs whatever --no-sign says, -s/--no-sign win over tag.gpgSign
    const config = RemoteConfigStore.from(this.workingCopy);
    let sign =
      this.signingKey !== undefined ||
      (this.signed ?? configBool(config.value("tag.gpgSign"), false));
    // Determine if we should create annotated tag
    // (an empty message too: git's `tag -m ""` makes an annotated tag)
    const createAnnotated = this.annotated || this.message !== undefined || sign;
    // tag.forceSignAnnotated signs a tag object not asked for with -a (git's
    // `force_sign_annotate && !annotate`)
    if (
      createAnnotated &&
      !this.annotated &&
      configBool(config.value("tag.forceSignAnnotated"), false)
    ) {
      sign = true;
    }

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

      // build_tag_object signs before writing: no signer, git's failure (exit(128))
      if (sign) throw await this.tagSigningFailed();
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

    // git's delete_tags: each name checked (each missing one reported, the others still
    // deleted), then all of them deleted with one delete_refs
    const toDelete: string[] = [];
    const refusals: { error: GitApiError; text: string }[] = [];
    for (const name of this.tags) {
      const refName = name.startsWith("refs/") ? name : `refs/tags/${name}`;
      if (!(await this.refsStore.has(refName))) {
        // git's delete_tags: error("tag '%s' not found."), exit status 1
        refusals.push({
          error: new RefNotFoundError(refName, `Tag '${name}' not found`).withExitCode(1),
          text: `error: tag '${name}' not found.`,
        });
        continue;
      }
      if (!toDelete.includes(refName)) toDelete.push(refName);
    }

    const { removed: deleted, error } =
      toDelete.length > 0 ? await this.removeRefsAsGit(toDelete) : { removed: [] };
    if (refusals.length > 0) throw GitApiError.ofRefusals(refusals);
    if (error !== undefined) throw error;
    return deleted;
  }
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
