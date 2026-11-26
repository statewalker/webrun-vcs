import type { ObjectId } from "@statewalker/vcs-core";
import { collect } from "@statewalker/vcs-utils/streams";

import { GitApiError, InvalidArgumentError } from "../errors/index.js";
import { RemoteConfigStore } from "../remote-config/index.js";
import { StashInfoCommand } from "./stash-info.js";
import { STASH_REF } from "./stash-list-command.js";

/**
 * The ident of an export's base commit: git's fixed `git stash <git@stash>` at
 * 2001-09-17T00:00:00Z (format-patch's date), so the same stashes export to the same ids.
 */
const BASE_IDENT = "git stash <git@stash> 1000684800 +0000";
/** The subject prefix of every exported stash commit */
const EXPORT_PREFIX = "git stash: ";

/** What `git stash export` did. */
export interface StashExportResult {
  /** The tip of the exported chain; undefined when the export stopped at a bad reflog entry */
  readonly commit?: ObjectId;
  /**
   * git's `error:` lines of a run that still exits 0: a `refs/stash` reflog entry that is no
   * stash stops the export (nothing printed, no ref written), as builtin/stash.c does.
   */
  readonly errors: string[];
}

/** What `git stash import` did. */
export interface StashImportResult {
  /** The stash commits stored, oldest first (the last is `stash@{0}`) */
  readonly imported: ObjectId[];
  /**
   * git's `error:` lines of a run that still exits 0: a root commit without an author or a
   * committer stops the import before anything is stored, as builtin/stash.c does.
   */
  readonly errors: string[];
}

/** Bytes as a binary string (one character per byte), so commit headers keep their bytes */
function binary(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return out;
}

function binaryBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/** git's find_commit_header: the value of the first `<key> ` header line, else undefined */
function commitHeader(raw: string, key: string): string | undefined {
  const end = raw.indexOf("\n\n");
  const headers = end < 0 ? raw : raw.slice(0, end);
  for (const line of headers.split("\n")) {
    if (line.startsWith(`${key} `)) return line.slice(key.length + 1);
  }
  return undefined;
}

/** The message: what follows the first empty line, undefined when there is none */
function commitBody(raw: string): string | undefined {
  const at = raw.indexOf("\n\n");
  return at < 0 ? undefined : raw.slice(at + 2);
}

function error(message: string, exitCode = 1): GitApiError {
  return new GitApiError(message).withExitCode(exitCode);
}

/** The stash subcommands 2.43 lacks: `cmd_stash` takes the name for a pathspec of `push`. */
function absentIn243(subcommand: string): GitApiError {
  return error(
    `fatal: subcommand wasn't specified; 'push' can't be assumed due to unexpected token '${subcommand}'`,
    128,
  );
}

/**
 * What export and import share: raw commits read and written byte for byte, and git's
 * check_stash_topology.
 */
abstract class StashChainCommand<T> extends StashInfoCommand<T> {
  /** The object's content as stored, undefined when it is missing */
  protected async rawObject(id: ObjectId): Promise<{ type: string; raw: string } | undefined> {
    const objects = this.workingCopy.history?.objects;
    const object = await objects?.get(id).catch(() => undefined);
    if (!object) return undefined;
    return { type: object.type, raw: binary(object.bytes ?? (await collect(object.content))) };
  }

  /** git's lookup_commit_reference: the commit `id` names, tags peeled */
  protected async peelCommit(id: ObjectId): Promise<ObjectId | undefined> {
    const peeled = await this.revisionResolver()
      .peelTags(id)
      .catch(() => undefined);
    return peeled?.type === "commit" ? peeled.id : undefined;
  }

  /**
   * git's check_stash_topology: two or three parents, the second with one parent (the
   * first), the third with none.
   */
  protected async isStashTopology(id: ObjectId): Promise<boolean> {
    const load = (c: ObjectId) => this.commits.load(c).catch(() => undefined);
    const stash = await load(id);
    if (!stash || stash.parents.length < 2 || stash.parents.length > 3) return false;
    const [p1, p2, p3] = stash.parents as [ObjectId, ObjectId, ObjectId?];
    const first = await load(p1);
    const index = await load(p2);
    const untracked = p3 ? await load(p3) : undefined;
    if (!first || !index || (p3 && !untracked)) return false;
    if (index.parents.length !== 1 || (untracked && untracked.parents.length > 0)) return false;
    return index.parents[0] === p1;
  }

  /** `encoding <i18n.commitEncoding>` as commit_tree_extended writes it, else "" */
  protected encodingHeader(): string {
    const encoding = RemoteConfigStore.from(this.workingCopy).value("i18n.commitEncoding");
    if (encoding === undefined || /^utf-?8$/i.test(encoding)) return "";
    return `encoding ${encoding}\n`;
  }

  protected async writeCommit(text: string): Promise<ObjectId> {
    const objects = this.workingCopy.history?.objects;
    if (!objects) throw error("error: could not write commit");
    const bytes = binaryBytes(text);
    return objects.put("commit", bytes.length, [bytes]);
  }
}

/**
 * `git stash export (--print | --to-ref <ref>) [<stash>...]` (git 2.51+): the stashes, every
 * entry of `refs/stash` by default, written as a chain of commits that any transport carries,
 * as builtin/stash.c's do_export_stash writes it.
 *
 * The chain starts at a parentless commit of the empty tree by `git stash <git@stash>` dated
 * 2001-09-17 (the same in every repository). Each stash adds a commit of the empty tree whose
 * first parent is the previous link and whose second is the stash commit itself, with the
 * stash's author and committer and its message after `git stash: `. The oldest stash is linked
 * first, so the tip's second parent is `stash@{0}`; named stashes are linked last to first.
 * The tip is printed (`--print`, see {@link getOutput}) or written to the ref named
 * (`--to-ref`, no reflog message). `git stash import` reads the chain back.
 *
 * As git: `error: exactly one of --print and --to-ref is required`, `error: unable to find
 * stash entry <stash>`, `error: <revision> does not look like a stash commit` (exit 1); a
 * `refs/stash` entry that is no stash stops the export with exit 0 and nothing written
 * (`StashExportResult.errors`). Under `setCompatibility("2.43")` it refuses as git 2.43, which
 * has no such subcommand.
 *
 * @example
 * ```typescript
 * // git stash export --to-ref refs/heads/stashes
 * await git.stashExport().setToRef("refs/heads/stashes").call();
 * // git stash export --print stash@{1}
 * const { commit } = await git.stashExport().setPrint(true).addStash("stash@{1}").call();
 * ```
 */
export class StashExportCommand extends StashChainCommand<StashExportResult> {
  private print = false;
  private toRef?: string;
  private readonly stashes: string[] = [];

  /** `--print`: the chain's tip printed on stdout. */
  setPrint(print: boolean): this {
    this.checkCallable();
    this.print = print;
    return this;
  }

  /** `--to-ref <ref>`: the chain's tip written to `ref`. */
  setToRef(ref: string): this {
    this.checkCallable();
    this.toRef = ref;
    return this;
  }

  /** A stash to export (`stash@{n}`, `n` or any revision); none: every entry of `refs/stash`. */
  addStash(stash: string): this {
    this.checkCallable();
    this.stashes.push(stash);
    return this;
  }

  async call(): Promise<StashExportResult> {
    this.checkCallable();
    this.setCallable(false);
    if (this.compatibility === "2.43") {
      if (this.print)
        throw new InvalidArgumentError("print", true, "error: unknown option `print'").withExitCode(
          129,
        );
      if (this.toRef !== undefined) {
        throw new InvalidArgumentError(
          "to-ref",
          this.toRef,
          "error: unknown option `to-ref'",
        ).withExitCode(129);
      }
      throw absentIn243("export");
    }
    if (this.print === (this.toRef !== undefined)) {
      throw error("error: exactly one of --print and --to-ref is required");
    }

    // the base commit is written first, whatever follows
    const encoding = this.encodingHeader();
    let tip = await this.writeCommit(
      `tree ${this.objectFormat.emptyTreeId}\nauthor ${BASE_IDENT}\ncommitter ${BASE_IDENT}\n${encoding}\n`,
    );

    const stashes: ObjectId[] = [];
    const errors: string[] = [];
    if (this.stashes.length > 0) {
      for (const stash of this.stashes) {
        const revision = /^\d*$/.test(stash) ? `${STASH_REF}@{${stash}}` : stash;
        const id = await this.resolveRevision(revision).catch(() => undefined);
        if (id === undefined) throw error(`error: unable to find stash entry ${stash}`);
        const commit = await this.peelCommit(id);
        if (!commit || !(await this.isStashTopology(commit))) {
          throw error(`error: ${revision} does not look like a stash commit`);
        }
        stashes.push(commit);
      }
    } else {
      // refs/stash's reflog, newest first
      for (const id of await this.stashReflog()) {
        const commit = await this.peelCommit(id);
        if (!commit || !(await this.isStashTopology(commit))) {
          errors.push(`error: ${id} does not look like a stash commit`);
          return { errors };
        }
        stashes.push(commit);
      }
    }

    for (const stash of stashes.reverse()) {
      tip = await this.exportedCommit(tip, stash, encoding);
    }
    if (this.toRef !== undefined) {
      const result = await this.refsStore.batch([{ name: this.toRef, new: tip }], {
        ...this.reflogLine(""),
      });
      if (!result.ok) {
        const why = result.rejected.map((r) => r.reason).join(", ");
        throw error(`fatal: update_ref failed for ref '${this.toRef}': ${why}`, 128);
      }
    } else {
      this.output.push(tip);
    }
    return { commit: tip, errors };
  }

  /** The ids `refs/stash`'s reflog records, newest first (the ref alone for a store keeping no reflogs) */
  private async stashReflog(): Promise<ObjectId[]> {
    // git walks the reflog alone: a refs/stash without one exports no stash
    if (this.refsStore.getReflog) {
      const reflog = await this.refsStore.getReflog(STASH_REF);
      return reflog ? (await reflog.getReverseEntries()).map((e) => e.newId) : [];
    }
    const top = await this.refsStore.resolve(STASH_REF).catch(() => undefined);
    return top?.objectId ? [top.objectId] : [];
  }

  /** git's write_commit_with_parents: the stash linked after `previous`. */
  private async exportedCommit(
    previous: ObjectId,
    stash: ObjectId,
    encoding: string,
  ): Promise<ObjectId> {
    const raw = (await this.rawObject(stash))?.raw ?? "";
    const author = commitHeader(raw, "author");
    const committer = commitHeader(raw, "committer");
    if (author === undefined || committer === undefined) {
      throw error(`error: cannot parse commit ${stash}`);
    }
    const ident = /^[^<>\n]*<[^<>\n]*> \d+ [-+]\d{4}$/;
    if (!ident.test(author) || !ident.test(committer)) {
      throw error(`error: invalid author or committer for ${stash}`);
    }
    let message = `${EXPORT_PREFIX}${commitBody(raw) ?? ""}`;
    if (!message.endsWith("\n")) message += "\n";
    return this.writeCommit(
      `tree ${this.objectFormat.emptyTreeId}\nparent ${previous}\nparent ${stash}\n` +
        `author ${author}\ncommitter ${committer}\n${encoding}\n${message}`,
    );
  }
}

/**
 * `git stash import <commit>` (git 2.51+): the stashes of a chain `git stash export` wrote,
 * added to `refs/stash` oldest first, each with its own message as the reflog message (so
 * the chain's tip becomes `stash@{0}`; the entries already there stay below), as
 * builtin/stash.c's do_import_stash adds them.
 *
 * The whole chain is checked before anything is stored, with git's messages (exit 1):
 * `not a valid revision: <rev>`, `not a commit: <rev>`, `<id> is not a valid exported stash
 * commit` (a tree other than the empty one, or neither none nor two parents), `found stash
 * commit <id> without expected prefix`, `<id> does not look like a stash commit`, `found root
 * commit <id> with invalid data` (a base commit not by `git stash <git@stash>` at its date).
 * A base commit without an author or committer stops the import with exit 0 and nothing
 * stored (`StashImportResult.errors`). Under `setCompatibility("2.43")` it refuses as git
 * 2.43, which has no such subcommand.
 *
 * @example
 * ```typescript
 * // git fetch origin refs/heads/stashes && git stash import FETCH_HEAD
 * await git.stashImport().setCommit("FETCH_HEAD").call();
 * ```
 */
export class StashImportCommand extends StashChainCommand<StashImportResult> {
  private commit?: string;

  /** The tip of an exported chain (any revision naming it). */
  setCommit(commit: string): this {
    this.checkCallable();
    this.commit = commit;
    return this;
  }

  async call(): Promise<StashImportResult> {
    this.checkCallable();
    this.setCallable(false);
    if (this.compatibility === "2.43") throw absentIn243("import");
    const rev = this.commit;
    if (rev === undefined) {
      throw new InvalidArgumentError("commit", rev, "fatal: a revision is required").withExitCode(
        129,
      );
    }
    const id = await this.resolveRevision(rev).catch(() => undefined);
    if (id === undefined) throw error(`error: not a valid revision: ${rev}`);
    let current = await this.peelCommit(id);
    if (current === undefined) {
      const type = (await this.rawObject(id))?.type;
      throw error(
        `${type ? `error: object ${id} is a ${type}, not a commit\n` : ""}error: not a commit: ${rev}`,
      );
    }

    // the chain, tip first; the stashes collected oldest first
    const stashes: ObjectId[] = [];
    const errors: string[] = [];
    for (;;) {
      const commit = await this.commits.load(current).catch(() => undefined);
      const parents = commit?.parents ?? [];
      if (
        !commit ||
        commit.tree !== this.objectFormat.emptyTreeId ||
        (parents.length !== 0 && parents.length !== 2)
      ) {
        throw error(`error: ${current} is not a valid exported stash commit`);
      }
      const raw = (await this.rawObject(current))?.raw ?? "";
      if (parents.length === 0) {
        const author = commitHeader(raw, "author");
        const committer = commitHeader(raw, "committer");
        if (author === undefined || committer === undefined) {
          errors.push(`error: cannot parse commit ${current}`);
          return { imported: [], errors };
        }
        if (author !== BASE_IDENT || committer !== BASE_IDENT) {
          throw error(`error: found root commit ${current} with invalid data`);
        }
        break;
      }
      const body = commitBody(raw);
      if (body === undefined) throw error(`error: cannot parse commit ${current}`);
      if (!body.startsWith(EXPORT_PREFIX)) {
        throw error(`error: found stash commit ${current} without expected prefix`);
      }
      const [previous, stash] = parents as [ObjectId, ObjectId];
      if (!(await this.isStashTopology(stash))) {
        throw error(`error: ${stash} does not look like a stash commit`);
      }
      stashes.unshift(stash);
      current = previous;
    }

    const decoder = new TextDecoder();
    for (const stash of stashes) {
      const raw = (await this.rawObject(stash))?.raw;
      const body = raw === undefined ? undefined : commitBody(raw);
      if (body === undefined) throw error(`error: cannot parse commit ${stash}`);
      const message = decoder.decode(binaryBytes(body));
      const result = await this.refsStore.batch([{ name: STASH_REF, new: stash }], {
        ...this.reflogLine(message),
        createReflog: true,
      });
      if (!result.ok) throw error(`error: cannot save the stash for ${stash}`);
    }
    return { imported: stashes, errors };
  }
}
