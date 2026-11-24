/**
 * ShowCommand - `git show` (builtin/log.c's cmd_show): each object named, as its kind is
 * shown. A commit as `git log -1 -p` shows it, merges with their dense combined diff (`--cc`,
 * show's default); an annotated tag as `tag <name>`, its tagger and message, then the object
 * it tags; a tree as `tree <name>`, an empty line and its entries (a directory with a `/`, not
 * recursive); a blob as its bytes (`--textconv` runs the path's textconv for `<rev>:<path>`).
 * A range (`A..B`, `^A`) or `-<n>` walks the history instead, as `git log` with show's
 * defaults.
 *
 * @example
 * ```typescript
 * // git show HEAD
 * const text = await git.show().callText();
 *
 * // git show --stat v1.0 main:README
 * const both = await git.show().addRevision("v1.0").addRevision("main:README").callText({ stat: true });
 *
 * // git show -s --format=%s main topic: the subjects only
 * const { stdout, exitCode } = await git.show().addArgument("main").addArgument("topic")
 *   .setOptions({ noPatch: true, pretty: "%s" }).call();
 * ```
 *
 * Objects are shown in the order named, with git's separators: a newline before a tag or
 * tree once something was shown, a commit's own separator as `git log` prints it (none for a
 * `tformat:`), nothing around a blob. A commit named twice is shown once (git's SHOWN flag);
 * with paths, a commit that changes none of them is not shown. A tag whose object is missing
 * prints its header, then git's `error: could not read object <id>` and exit status 255.
 *
 * @module
 */

import {
  CorruptObjectError,
  type ObjectId,
  type ObjectTypeString,
  type PersonIdent,
  parsePersonIdent,
} from "@statewalker/vcs-core";
import { decodeGitPath, encodeGitPath } from "@statewalker/vcs-utils/encoding";
import { collect } from "@statewalker/vcs-utils/streams";

import { GitApiError } from "../errors/index.js";
import { GitCommand } from "../git-command.js";
import { DiffCommand, type DiffTextOptions } from "./diff-command.js";
import { LogCommand, type ShowSession } from "./log-command.js";
import type { LogOutputOptions } from "./log-output.js";
import { revisionMergeBases } from "./rev-parse-command.js";
import { parseRevisionAndPathArgs } from "./revision-filenames.js";
import type { RefTip, RevisionArgEntry } from "./revision-range.js";

/** `git show`'s options: `git log`'s output options and its own. */
export interface ShowOptions extends LogOutputOptions {
  /**
   * `--textconv` / `--no-textconv`: a blob named `<rev>:<path>` (or `:<path>`) is shown
   * through the path's textconv only with an explicit `true`; `false` also turns textconv
   * off in the diffs (default: on there, off for blobs)
   */
  textconv?: boolean;
  /** `--first-parent`: merges' diffs against their first parent (and a range walks so) */
  firstParent?: boolean;
}

/** What `git show` printed and its exit status. */
export interface ShowResult {
  /** git's stdout */
  readonly stdout: Uint8Array;
  /** git's stderr lines (`error: could not read object <id>`, revision warnings) */
  readonly errors: string[];
  /** 0, 2 when `--check` found errors, or 255 when an object could not be read (cmd_show's `error()` return) */
  readonly exitCode: number;
}

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const NL = 0x0a;

/** `git show`. */
export class ShowCommand extends GitCommand<ShowResult> {
  private readonly args: string[] = [];
  private readonly paths: string[] = [];
  private options: ShowOptions = {};
  private diffOptions: DiffTextOptions = {};
  private maxCount?: number;
  private skip?: number;

  /** A revision to show (as given before `--`; it must not also name a file without one). */
  addRevision(revision: string): this {
    return this.addArgument(revision);
  }

  /**
   * An argument as git's command line gives it: revisions, then paths (after `--`, or from
   * the first argument that names no revision on, which must then exist as git checks them).
   */
  addArgument(arg: string): this {
    this.checkCallable();
    this.args.push(arg);
    return this;
  }

  /** A path the diffs (and the commits shown) are limited to, as after `--`. */
  addPath(path: string): this {
    this.checkCallable();
    this.paths.push(path);
    return this;
  }

  /** The output options (see {@link ShowOptions}); merged into those set before. */
  setOptions(options: ShowOptions): this {
    this.checkCallable();
    this.options = { ...this.options, ...options };
    return this;
  }

  /** Options of the diffs (context, algorithm, `--stat` widths...). */
  setDiffOptions(options: DiffTextOptions): this {
    this.checkCallable();
    this.diffOptions = { ...this.diffOptions, ...options };
    return this;
  }

  /** `-<n>` / `-n <n>`: walk the history, at most n commits (git's no-walk off). */
  setMaxCount(maxCount: number): this {
    this.checkCallable();
    this.maxCount = maxCount;
    return this;
  }

  /** `--skip=<n>`: walk the history, leaving out the first n commits. */
  setSkip(skip: number): this {
    this.checkCallable();
    this.skip = skip;
    return this;
  }

  /** {@link call}'s stdout as text; throws git's error when the exit status is not 0. */
  async callText(options?: ShowOptions): Promise<string> {
    return decodeGitPath(await this.callBytes(options));
  }

  /** {@link call}'s stdout; throws git's error when the exit status is not 0. */
  async callBytes(options?: ShowOptions): Promise<Uint8Array> {
    const result = await this.call(options);
    if (result.exitCode !== 0) {
      throw new GitApiError(result.errors.join("\n"), { exitCode: result.exitCode });
    }
    return result.stdout;
  }

  /**
   * Shows the objects.
   *
   * @throws RevisionError where git dies reading the arguments (`fatal: ambiguous argument`,
   *   `fatal: bad revision`, `fatal: path 'x' does not exist in 'HEAD'`), GitApiError where
   *   it dies otherwise (an unborn HEAD, `--graph` without a walk), exit status 128
   */
  async call(options?: ShowOptions): Promise<ShowResult> {
    this.checkCallable();
    if (options) this.options = { ...this.options, ...options };
    this.setCallable(false);
    const resolver = this.revisionResolver();
    let tips: Promise<RefTip[]> | undefined;
    const args = [...this.args];
    if (this.paths.length > 0) {
      if (!args.includes("--")) args.push("--");
      args.push(...this.paths);
    }
    const parsed = await parseRevisionAndPathArgs(resolver, args, this.argumentFiles(), {
      committish: false,
      mergeBases: (a, b) => revisionMergeBases(this.walkCommits, a, b),
      refs: () => {
        tips ??= this.refTips();
        return tips;
      },
      head: async () => (await this.refsStore.resolve("HEAD").catch(() => undefined))?.objectId,
    });
    const errors = [...parsed.warnings];
    let entries: RevisionArgEntry[] = parsed.entries;
    if (entries.length === 0 && !parsed.inputGiven) {
      entries = [{ id: await this.defaultHead(), exclude: false, name: "HEAD" }];
    }
    const { textconv, firstParent, ...logOptions } = this.options;
    const log = new LogCommand(this._workingCopy);
    for (const path of parsed.paths) log.addPath(path);
    if (firstParent) log.setFirstParent(true);
    log.setDiffOptions({
      ...logOptions.diff,
      ...this.diffOptions,
      ...(textconv === false ? { textconv: false } : {}),
    });
    const output = showDefaults(logOptions, !!firstParent);
    // revision.c: a range, `^x`, `-n` and `--skip` turn no-walk off (cmd_log_walk)
    if (entries.some((e) => e.exclude) || this.maxCount !== undefined || this.skip) {
      for (const e of entries) {
        if (e.exclude) log.not(e.id, e.name);
        else log.add(e.id, e.name);
      }
      if (this.maxCount !== undefined) log.setMaxCount(this.maxCount);
      if (this.skip) log.setSkip(this.skip);
      const stdout = await log.callBytes(output);
      return { stdout, errors, exitCode: log.exitCode };
    }
    const session = await log.showSession(output);
    let exitCode = 0;
    try {
      exitCode = await this.showObjects(entries, session, errors, textconv === true, log);
    } catch (error) {
      // a read git dies of: what was printed before stays on stdout
      if (!(error instanceof ShowDeath)) throw error;
      errors.push(...error.lines);
      exitCode = 128;
    }
    return { stdout: session.result(), errors, exitCode };
  }

  /** cmd_show's loop over the pending objects: its exit status (255 after an `error()`) */
  private async showObjects(
    entries: readonly RevisionArgEntry[],
    session: ShowSession,
    errors: string[],
    textconv: boolean,
    log: LogCommand,
  ): Promise<number> {
    for (const entry of entries) {
      const name = entry.name ?? entry.id;
      let id = entry.id;
      for (;;) {
        const type = await this.objectKind(id);
        if (type === "blob") {
          session.bytes(await this.blobContent(id, name, textconv));
        } else if (type === "tree") {
          session.separate();
          session.text(`${session.commitColor.set}tree ${name}${session.commitColor.reset}\n\n`);
          for (const e of await this.treeEntries(id)) {
            const dir = (e.mode & S_IFMT) === S_IFDIR;
            session.bytes(encodeGitPath(`${e.name}${dir ? "/" : ""}\n`));
          }
          session.markShown();
        } else if (type === "commit") {
          await session.commit(id);
          // cmd_log_walk's status: --check's errors end the loop with 2
          if (log.exitCode !== 0) return log.exitCode;
        } else if (type === "tag") {
          const target = await this.showTag(id, session);
          if (target === undefined || (await this.objectKind(target)) === undefined) {
            errors.push(`error: could not read object ${target ?? id}`);
            return 255;
          }
          id = target;
          continue;
        } else {
          errors.push(`error: could not read object ${id}`);
          return 255;
        }
        break;
      }
    }
    return 0;
  }

  /**
   * An object's kind: from its header where the store has it, else by reading it, which
   * fetches a missing object of a partial clone from its promisor remote (git's
   * parse_object); undefined when it cannot be found
   */
  private async objectKind(id: ObjectId): Promise<ObjectTypeString | undefined> {
    const known = await this.revisionResolver().objectType(id);
    if (known) return known;
    return (await this.readObject(id))?.type;
  }

  /**
   * show_tag_object: `tag <name>`, a `Tagger:` line (and date) for each `tagger` header, the
   * rest of the object from its empty line on; the id it tags, undefined when unreadable
   */
  private async showTag(id: ObjectId, session: ShowSession): Promise<ObjectId | undefined> {
    const raw = await this.rawObject(id);
    if (!raw) return undefined;
    let tagName = "";
    let object: ObjectId | undefined;
    const taggers: PersonIdent[] = [];
    let offset = 0;
    while (offset < raw.length && raw[offset] !== NL) {
      let end = raw.indexOf(NL, offset);
      if (end < 0) end = raw.length;
      const line = decodeGitPath(raw.subarray(offset, end));
      if (line.startsWith("object ")) object = line.slice(7);
      else if (line.startsWith("tag ")) tagName = line.slice(4);
      else if (line.startsWith("tagger ")) {
        try {
          taggers.push(parsePersonIdent(line.slice(7)));
        } catch {
          // split_ident_line failed: pp_user_info prints nothing
        }
      }
      offset = end + 1;
    }
    session.separate();
    session.text(`${session.commitColor.set}tag ${tagName}${session.commitColor.reset}\n`);
    for (const t of taggers) session.tagger(t);
    if (offset < raw.length) session.bytes(raw.subarray(offset));
    session.markShown();
    return object;
  }

  /** show_blob_object: the blob's bytes, through textconv for a named path under `--textconv` */
  private async blobContent(id: ObjectId, name: string, textconv: boolean): Promise<Uint8Array> {
    const read = async () => {
      const bytes = await this.rawObject(id);
      // a blob that went missing after its name was read: git's stream fails
      if (!bytes) throw new ShowDeath([`fatal: unable to read ${id}`]);
      return bytes;
    };
    if (textconv) {
      const where = await this.blobPath(name);
      if (where) {
        const diff = new DiffCommand(this._workingCopy).setOptions(this.diffOptions);
        const converted = await diff.textconvBlob(where.path, where.mode, read);
        if (converted) return converted;
      }
    }
    return read();
  }

  /**
   * get_oid_with_context's recorded path and mode of `<rev>:<path>`, `:<path>` and
   * `:<n>:<path>` (undefined for any other name)
   */
  private async blobPath(name: string): Promise<{ path: string; mode: number } | undefined> {
    if (name.startsWith(":")) {
      if (name.startsWith(":/")) return undefined;
      const staged = /^:([0-3]):/.exec(name);
      const path = staged ? name.slice(3) : name.slice(1);
      const stage = staged ? Number(staged[1]) : 0;
      const entry = await this.staging
        .getEntry(path, stage as 0 | 1 | 2 | 3)
        .catch(() => undefined);
      return entry ? { path, mode: entry.mode } : undefined;
    }
    let depth = 0;
    let colon = -1;
    for (let i = 0; i < name.length; i++) {
      const c = name[i];
      if (c === "{") depth++;
      else if (depth > 0 && c === "}") depth--;
      else if (depth === 0 && c === ":") {
        colon = i;
        break;
      }
    }
    if (colon < 0) return undefined;
    const path = name.slice(colon + 1);
    if (path === "") return undefined;
    const resolver = this.revisionResolver();
    const treeish = await resolver
      .resolve(name.slice(0, colon), { hint: "treeish", quiet: true })
      .catch(() => undefined);
    let tree = treeish && (await resolver.peelToType(treeish, "tree").catch(() => undefined));
    const parts = path.split("/");
    for (let k = 0; k < parts.length && tree; k++) {
      const entry = (await this.treeEntries(tree)).find((e) => e.name === parts[k]);
      if (!entry) return undefined;
      if (k === parts.length - 1) return { path, mode: entry.mode };
      tree = entry.id;
    }
    return undefined;
  }

  /** An object's content as stored, undefined when it is missing */
  private async rawObject(id: ObjectId): Promise<Uint8Array | undefined> {
    return (await this.readObject(id))?.bytes;
  }

  /**
   * An object as stored (a partial clone's missing object fetched first), undefined when it is
   * missing. A failed lazy fetch propagates (`PromisorFetchError`); a corrupt copy dies with
   * git's lines (exit 128).
   */
  private async readObject(
    id: ObjectId,
  ): Promise<{ type: ObjectTypeString; bytes: Uint8Array } | undefined> {
    const objects = this._workingCopy.history?.objects;
    if (!objects) return undefined;
    try {
      const obj = await objects.get(id);
      if (!obj) return undefined;
      return { type: obj.type, bytes: obj.bytes ?? (await collect(obj.content)) };
    } catch (error) {
      if (error instanceof CorruptObjectError) throw await this.corruptDeath(id, error);
      throw error;
    }
  }

  /**
   * git's death on a corrupt object (unpack_entry, read_object_file's die): zlib's `error:`
   * line, then `fatal: packed object <id> (stored in <pack>) is corrupt` or the loose
   * object's
   */
  private async corruptDeath(id: ObjectId, error: CorruptObjectError): Promise<ShowDeath> {
    const lines: string[] = [];
    const reason = inflateReason(error);
    if (reason !== undefined) lines.push(`error: inflate: data stream error (${reason})`);
    const packs = await this._workingCopy.history?.packs?.packs().catch(() => undefined);
    const pack = packs?.find((p) => p.has(id));
    if (pack) {
      const path =
        "packPath" in pack && typeof pack.packPath === "string"
          ? pack.packPath.replace(/^\/+/, "")
          : `.git/objects/pack/pack-${pack.packId}.pack`;
      lines.push(`fatal: packed object ${id} (stored in ${path}) is corrupt`);
    } else {
      lines.push(
        `fatal: loose object ${id} (stored in .git/objects/${id.slice(0, 2)}/${id.slice(2)}) is corrupt`,
      );
    }
    return new ShowDeath(lines);
  }

  /** setup_revisions' default `HEAD`, dying as diagnose_missing_default does */
  private async defaultHead(): Promise<ObjectId> {
    const head = await this.refsStore.resolve("HEAD").catch(() => undefined);
    if (head?.objectId) return head.objectId;
    const branch = await this.getCurrentBranch().catch(() => undefined);
    if (branch === undefined) {
      throw new GitApiError("fatal: your current branch appears to be broken");
    }
    const short = branch.startsWith("refs/heads/") ? branch.slice(11) : branch;
    throw new GitApiError(`fatal: your current branch '${short}' does not have any commits yet`);
  }

  /** The refs under `refs/` in name order (refs_for_each_ref), symbolic ones resolved. */
  private async refTips(): Promise<RefTip[]> {
    const tips: { key: string; name: string; id: ObjectId }[] = [];
    for await (const ref of this.refsStore.list()) {
      if (!ref.name.startsWith("refs/")) continue;
      let id = "objectId" in ref ? ref.objectId : undefined;
      if (!id) id = (await this.refsStore.resolve(ref.name).catch(() => undefined))?.objectId;
      if (id) tips.push({ key: latin1(encodeGitPath(ref.name)), name: ref.name, id });
    }
    tips.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return tips.map(({ name, id }) => ({ name, id }));
  }
}

/** A read git dies of, with its stderr lines (exit 128). */
class ShowDeath extends Error {
  constructor(readonly lines: string[]) {
    super(lines.join("\n"));
    this.name = "ShowDeath";
  }
}

/** zlib's message of an inflate failure in an error or its causes (`inflate failed: <msg>`) */
function inflateReason(error: unknown): string | undefined {
  for (let e = error, depth = 0; e instanceof Error && depth < 8; e = e.cause, depth++) {
    const m = /inflate failed: ([^\n]+)/.exec(e.message);
    if (m) return (m[1] as string).trim();
  }
  return undefined;
}

/** Bytes as a string that sorts as the bytes do */
function latin1(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

/**
 * cmd_show's settings over the options given: `rev.diff` with the patch when no output
 * format is given (show_setup_revisions_tweak), merges' diffs dense combined unless a merge
 * mode is given (first-parent under `--first-parent`)
 */
function showDefaults(options: LogOutputOptions, firstParent: boolean): LogOutputOptions {
  const formatGiven =
    !!options.patch ||
    !!options.stat ||
    !!options.shortstat ||
    !!options.numstat ||
    !!options.nameOnly ||
    !!options.nameStatus ||
    !!options.check ||
    !!options.summary;
  const mergesGiven =
    !!options.m || !!options.c || !!options.cc || !!options.diffMerges || !!options.remergeDiff;
  return {
    ...options,
    ...(!formatGiven && !options.noPatch ? { patch: true } : {}),
    ...(!mergesGiven && !firstParent ? { diffMerges: "dense-combined" as const } : {}),
  };
}
