/**
 * `git replace` (builtin/replace.c): replace refs created (`<object> <replacement>`), listed
 * (`-l [<pattern>]`, `--format=short|medium|long`), deleted (`-d`), made by editing an object
 * (`--edit`, `--raw`), by changing a commit's parents (`--graft`) and from the grafts file
 * (`--convert-graft-file`, which removes `info/grafts` once every graft converted).
 *
 * @example
 * ```typescript
 * // git replace --graft HEAD~2
 * await git.replace().setMode("graft").addArgument("HEAD~2").call();
 * // git replace --format=medium
 * const { stdout } = await git.replace().setFormat("medium").callOutput();
 * // git replace --convert-graft-file
 * const { exitCode, stderr } = await git.replace().setMode("convert-graft-file").call();
 * ```
 */

import { type ObjectId, overlayMethods, parseGraftFile } from "@statewalker/vcs-core";
import { parseGitBool } from "@statewalker/vcs-utils";
import { decodeGitPath, encodeGitPath } from "@statewalker/vcs-utils/encoding";
import { computeObjectId } from "@statewalker/vcs-utils/pack";
import { wildmatch } from "@statewalker/vcs-working-tree";

import { GitApiError } from "../errors/index.js";
import type { CommandCommits } from "../git-command.js";
import { RemoteConfigStore } from "../remote-config/index.js";
import { quotePath } from "../results/quote-path.js";
import { cUnquote } from "./apply/latin1.js";
import { FsckMessageTypes } from "./fsck/fsck-msg-ids.js";
import { fsckCommit, fsckTag, fsckTree } from "./fsck/fsck-object-checks.js";
import { hostEnvironmentOf } from "./git-ident.js";
import { PlumbingCommand, PlumbingError } from "./plumbing-command.js";

/** git replace's command modes (OPT_CMDMODE); unset: list without arguments, else replace. */
export type ReplaceMode = "list" | "delete" | "edit" | "graft" | "convert-graft-file" | "replace";

/**
 * The editor of `--edit`: the path git would edit (`REPLACE_EDITOBJ` in the git directory)
 * and the object as exported (`cat-file -p`, or the raw content with `--raw`). It returns the
 * edited content (bytes or text), or nothing to keep it as it was. A {@link GitApiError} it
 * throws gives its message lines before git's `error: editing object file failed`.
 */
export type ReplaceEditor = (
  path: string,
  content: Uint8Array,
) => Promise<Uint8Array | string | undefined | undefined>;

/** The long names of the modes, for git's refusal of two at once. */
const MODE_OPTIONS: Record<ReplaceMode, string> = {
  list: "--list",
  delete: "--delete",
  edit: "--edit",
  graft: "--graft",
  "convert-graft-file": "--convert-graft-file",
  replace: "",
};

/** git's `error()`, which the command returns: exit status 255 */
const ERROR = 255;

/** A failure of one step: git's error lines were already printed. */
class StepFailed extends Error {}

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFGITLINK = 0o160000;

/** git's object_type(mode) */
function modeType(mode: number): "tree" | "commit" | "blob" {
  const kind = mode & S_IFMT;
  if (kind === S_IFDIR) return "tree";
  if (kind === S_IFGITLINK) return "commit";
  return "blob";
}

/**
 * `git replace`. Results are git's stdout ({@link setStdout}, {@link callOutput}), stderr and
 * exit status: 255 where git returns an `error()` (a refused replacement, a bogus format), 1
 * when `-d` or `--convert-graft-file` failed for some names or lines; usage errors are thrown
 * as {@link PlumbingError} with git's `fatal:` line and status 129 (the usage text is the
 * CLI's), and a malformed edited object as git's death (128).
 *
 * Replace refs are not applied to the objects it reads (git's `disable_replace_refs`). The
 * names are read under `GIT_REPLACE_REF_BASE` (default `refs/replace/`). `--edit` exports and
 * imports in-process (cat-file and mktree), handing the content to {@link setEditor} rather
 * than writing `REPLACE_EDITOBJ`; without an editor the object stays as it was (git's
 * `GIT_EDITOR=:`), which git refuses as the same object. `--convert-graft-file` converts
 * `info/grafts` (a `GIT_GRAFT_FILE` elsewhere is refused): each line becomes a replace ref
 * (a graft changing nothing is a warning), and the file is removed only when every line
 * converted, else git's warning lists the lines left (exit 1). To roll a conversion back,
 * delete the replace refs (`-d`); the grafts can be written again from the replacements'
 * parents (`git replace --format=medium`, then `<commit> <parent>...` per replacement).
 */
export class ReplaceCommand extends PlumbingCommand {
  private mode?: ReplaceMode;
  private conflict?: [ReplaceMode, ReplaceMode];
  private readonly args: string[] = [];
  private force = false;
  private raw = false;
  private format?: string;
  private editor?: ReplaceEditor;
  private compatibility: "2.43" | "2.56" = "2.56";
  /** The grafts file as git loads it on the first commit parse (prepare_commit_graft) */
  private graftsLoad?: Promise<Map<ObjectId, ObjectId[]> | undefined>;
  /** Whether the grafts file was loaded (a commit was parsed) */
  private graftsLoaded = false;
  /** Commit objects git holds in memory: the grafts' commits, parsed commits' grafted parents */
  private readonly knownCommits = new Set<ObjectId>();
  private convertingGraftFile = false;

  /** The command mode (`-l`, `-d`, `-e`, `-g`, `--convert-graft-file`); one per command. */
  setMode(mode: ReplaceMode): this {
    this.checkCallable();
    if (this.mode !== undefined && this.mode !== mode && !this.conflict) {
      this.conflict = [this.mode, mode];
    }
    this.mode = mode;
    return this;
  }

  /** Arguments: objects, a commit and its new parents, or a listing pattern. */
  addArgument(...args: string[]): this {
    this.checkCallable();
    this.args.push(...args);
    return this;
  }

  /** `-f`/`--force`: an existing replace ref is overwritten, types are not checked. */
  setForce(force: boolean): this {
    this.checkCallable();
    this.force = force;
    return this;
  }

  /** `--raw`: `--edit` hands the raw content, not `cat-file -p`'s. */
  setRaw(raw: boolean): this {
    this.checkCallable();
    this.raw = raw;
    return this;
  }

  /** `--format=<short|medium|long>` of the listing. */
  setFormat(format: string): this {
    this.checkCallable();
    this.format = format;
    return this;
  }

  /** The editor of `--edit` (see {@link ReplaceEditor}). */
  setEditor(editor: ReplaceEditor): this {
    this.checkCallable();
    this.editor = editor;
    return this;
  }

  /**
   * The git version whose behaviour to follow (default 2.56): 2.5x reports a missing object
   * the grafts file names as a commit (`Could not read <id>`), and words the advice on the
   * grafts file as `git config set`.
   */
  setCompatibility(version: "2.43" | "2.56"): this {
    this.checkCallable();
    this.compatibility = version;
    return this;
  }

  /** git replace reads every object as stored (`disable_replace_refs`). */
  protected override readsReplacedObjects(): boolean {
    return false;
  }

  /**
   * The commits revisions are resolved through (`HEAD~1`, `HEAD^{tree}`): as stored, with
   * the grafts file's parents, each load being git's commit parse, which loads the grafts
   * file and gives its advice on the first one (prepare_commit_graft).
   */
  protected override get walkCommits(): CommandCommits {
    const stored = this.storedCommits;
    return overlayMethods(stored, {
      load: async (id: ObjectId) => {
        const commit = await stored.load(id);
        if (!commit) return commit;
        await this.commitParsed(id);
        const grafted = (await this.graftsLoad)?.get(id);
        return grafted ? { ...commit, parents: [...grafted] } : commit;
      },
    });
  }

  private get replaceRefBase(): string {
    return hostEnvironmentOf(this._workingCopy)?.replaceRefBase ?? "refs/replace/";
  }

  protected async run(): Promise<number> {
    if (this.conflict) {
      const [a, b] = this.conflict;
      throw new PlumbingError(
        `error: options '${MODE_OPTIONS[b]}' and '${MODE_OPTIONS[a]}' cannot be used together`,
        129,
      );
    }
    const argc = this.args.length;
    const mode: ReplaceMode = this.mode ?? (argc ? "replace" : "list");
    const usage = (message: string) => new PlumbingError(`fatal: ${message}`, 129);
    if (this.format !== undefined && mode !== "list") {
      throw usage("--format cannot be used when not listing");
    }
    if (this.force && (mode === "list" || mode === "delete")) {
      throw usage("-f only makes sense when writing a replacement");
    }
    if (this.raw && mode !== "edit") throw usage("--raw only makes sense with --edit");
    try {
      switch (mode) {
        case "delete":
          if (argc < 1) throw usage("-d needs at least one argument");
          return await this.deleteNames();
        case "replace":
          if (argc !== 2) throw usage("bad number of arguments");
          await this.replaceObject(this.args[0] as string, this.args[1] as string);
          return 0;
        case "edit":
          if (argc !== 1) throw usage("-e needs exactly one argument");
          await this.editAndReplace(this.args[0] as string);
          return 0;
        case "graft":
          if (argc < 1) throw usage("-g needs at least one argument");
          await this.createGraft(this.args, false);
          return 0;
        case "convert-graft-file":
          if (argc !== 0) throw usage("--convert-graft-file takes no argument");
          return await this.convertGraftFile();
        case "list":
          if (argc > 1) throw usage("only one pattern can be given with -l");
          return await this.list(this.args[0]);
      }
    } catch (e) {
      if (e instanceof StepFailed) return ERROR;
      throw e;
    }
  }

  /** Prints `error: <message>` and fails the step. */
  private fail(message: string): never {
    this.warn(`error: ${message}`);
    throw new StepFailed(message);
  }

  /** repo_get_oid with replace refs off; undefined when it names nothing. */
  private async getOid(name: string): Promise<ObjectId | undefined> {
    return this.revisionResolver()
      .resolve(name)
      .catch(() => undefined);
  }

  /** odb_read_object_info: the object's type, undefined when it is missing. */
  private async typeOf(id: ObjectId): Promise<string | undefined> {
    return this.revisionResolver()
      .objectType(id)
      .catch(() => undefined);
  }

  /** The object's content as stored. */
  private async readObject(id: ObjectId): Promise<Uint8Array | undefined> {
    const objects = this._workingCopy.history?.objects;
    const object = await objects?.get(id).catch(() => undefined);
    if (!object) return undefined;
    if (object.bytes) return object.bytes;
    const chunks: Uint8Array[] = [];
    for await (const c of object.content) chunks.push(c);
    return concat(chunks);
  }

  /** Writes an object (odb_write_object). */
  private async writeObject(type: "commit" | "tree" | "blob" | "tag", bytes: Uint8Array) {
    const objects = this._workingCopy.history?.objects;
    if (!objects) throw new Error("WorkingCopy.history.objects is required for git replace");
    return objects.put(type, bytes.length, [bytes]);
  }

  /** A replace ref's current value (refs_read_ref), undefined when there is none. */
  private async readRef(name: string): Promise<ObjectId | undefined> {
    const ref = await this.refsStore.resolve(name).catch(() => undefined);
    return ref?.objectId;
  }

  /** `git replace -l [<pattern>]` (list_replace_refs) */
  private async list(pattern = "*"): Promise<number> {
    const format = this.format;
    let kind: "short" | "medium" | "long";
    if (format === undefined || format === "" || format === "short") kind = "short";
    else if (format === "medium") kind = "medium";
    else if (format === "long") kind = "long";
    else {
      this.warn(
        `error: invalid replace format '${format}'\nvalid formats are 'short', 'medium' and 'long'`,
      );
      return ERROR;
    }
    const base = this.replaceRefBase;
    const objects = this._workingCopy.history?.objects;
    const refs: { name: string; id: ObjectId }[] = [];
    for await (const entry of this.refsStore.list(base)) {
      const id = (entry as { objectId?: ObjectId }).objectId;
      if (!entry.name.startsWith(base) || id === undefined) continue;
      // the ref iteration skips broken refs (no DO_FOR_EACH_INCLUDE_BROKEN)
      if (objects && !(await objects.has(id))) continue;
      refs.push({ name: entry.name.slice(base.length), id });
    }
    refs.sort((a, b) => compareBytes(encodeGitPath(a.name), encodeGitPath(b.name)));
    let out = "";
    for (const { name, id } of refs) {
      if (!wildmatch(pattern, name)) continue;
      if (kind === "short") out += `${name}\n`;
      else if (kind === "medium") out += `${name} -> ${id}\n`;
      else {
        const object = await this.getOid(name);
        if (object === undefined) {
          // the callback's error() stops the iteration; the listing still exits 0
          await this.write(out);
          this.warn(`error: failed to resolve '${name}' as a valid ref`);
          return 0;
        }
        const objType = (await this.typeOf(object)) ?? "(null)";
        const replType = (await this.typeOf(id)) ?? "(null)";
        out += `${name} (${objType}) -> ${id} (${replType})\n`;
      }
    }
    await this.write(out);
    return 0;
  }

  /** `git replace -d <object>...` (for_each_replace_name + delete_replace_ref) */
  private async deleteNames(): Promise<number> {
    let hadError = false;
    for (const name of this.args) {
      const id = await this.getOid(name);
      if (id === undefined) {
        this.warn(`error: failed to resolve '${name}' as a valid ref`);
        hadError = true;
        continue;
      }
      const ref = `${this.replaceRefBase}${id}`;
      const value = await this.readRef(ref);
      if (value === undefined) {
        this.warn(`error: replace ref '${id}' not found`);
        hadError = true;
        continue;
      }
      const result = await this.refsStore.batch([{ name: ref, old: value, new: null }]);
      if (!result.ok) {
        this.warn(`error: cannot lock ref '${ref}': ${rejectionText(result)}`);
        hadError = true;
        continue;
      }
      await this.write(`Deleted replace ref '${id}'\n`);
    }
    return hadError ? 1 : 0;
  }

  /** check_ref_valid: the replace ref's name and its current value (null when none). */
  private async checkRefValid(object: ObjectId): Promise<{ ref: string; prev: ObjectId | null }> {
    const ref = `${this.replaceRefBase}${object}`;
    const prev = await this.readRef(ref);
    if (prev !== undefined && !this.force) this.fail(`replace ref '${ref}' already exists`);
    return { ref, prev: prev ?? null };
  }

  /** replace_object_oid */
  private async replaceObjectOid(
    objectRef: string,
    object: ObjectId,
    replaceRef: string,
    repl: ObjectId,
  ): Promise<void> {
    const objType = await this.typeOf(object);
    const replType = await this.typeOf(repl);
    if (!this.force && objType !== replType) {
      this.fail(
        "Objects must be of the same type.\n" +
          `'${objectRef}' points to a replaced object of type '${objType ?? "(null)"}'\n` +
          `while '${replaceRef}' points to a replacement object of type '${replType ?? "(null)"}'.`,
      );
    }
    const { ref, prev } = await this.checkRefValid(object);
    const result = await this.refsStore.batch([{ name: ref, old: prev, new: repl }]);
    if (!result.ok) this.fail(`cannot lock ref '${ref}': ${rejectionText(result)}`);
  }

  /** `git replace <object> <replacement>` (replace_object) */
  private async replaceObject(objectRef: string, replaceRef: string): Promise<void> {
    const object = await this.getOid(objectRef);
    if (object === undefined) this.fail(`failed to resolve '${objectRef}' as a valid ref`);
    const repl = await this.getOid(replaceRef);
    if (repl === undefined) this.fail(`failed to resolve '${replaceRef}' as a valid ref`);
    await this.replaceObjectOid(objectRef, object, replaceRef, repl);
  }

  /** `git replace --edit <object>` (edit_and_replace) */
  private async editAndReplace(objectRef: string): Promise<void> {
    const oldId = await this.getOid(objectRef);
    if (oldId === undefined) this.fail(`not a valid object name: '${objectRef}'`);
    const type = await this.typeOf(oldId);
    if (type === undefined) this.fail(`unable to get object type for ${oldId}`);
    await this.checkRefValid(oldId);
    const exported = await this.exportObject(oldId, type);
    let edited: Uint8Array = exported;
    if (this.editor) {
      let result: Awaited<ReturnType<ReplaceEditor>>;
      try {
        result = await this.editor("REPLACE_EDITOBJ", exported);
      } catch (e) {
        if (e instanceof GitApiError && e.message) this.warn(e.message.replace(/\n$/, ""));
        this.fail("editing object file failed");
      }
      if (typeof result === "string") edited = encodeGitPath(result);
      else if (result instanceof Uint8Array) edited = result;
    }
    const newId = await this.importObject(type as "commit" | "tree" | "blob" | "tag", edited);
    if (newId === oldId) this.fail(`new object is the same as the old one: '${oldId}'`);
    await this.replaceObjectOid(objectRef, oldId, "replacement", newId);
  }

  /** export_object: `cat-file -p` (or `cat-file <type>` with `--raw`) of the object. */
  private async exportObject(id: ObjectId, type: string): Promise<Uint8Array> {
    if (!this.raw && type === "tree") {
      const config = RemoteConfigStore.from(this._workingCopy);
      const quoteFully = parseGitBool(config.value("core.quotePath")) ?? true;
      const entries = await this.listedTreeEntries(id);
      if (!entries) this.fail("cat-file reported failure");
      let out = "";
      for (const entry of entries) {
        const mode = entry.mode.toString(8).padStart(6, "0");
        out += `${mode} ${modeType(entry.mode)} ${entry.id}\t${quotePath(entry.name, quoteFully)}\n`;
      }
      return encodeGitPath(out);
    }
    const bytes = await this.readObject(id);
    if (!bytes) this.fail("cat-file reported failure");
    return bytes;
  }

  /** import_object: mktree for a pretty-printed tree, else the content format-checked. */
  private async importObject(
    type: "commit" | "tree" | "blob" | "tag",
    content: Uint8Array,
  ): Promise<ObjectId> {
    if (!this.raw && type === "tree") return this.mktree(content);
    // index_fd with INDEX_FORMAT_CHECK: fsck_buffer in strict mode, every report an error
    const types = new FsckMessageTypes({ strict: true });
    const messages: string[] = [];
    const report = (msgId: Parameters<FsckMessageTypes["severity"]>[0], message: string) => {
      if (types.severity(msgId) === "ignore") return 0;
      messages.push(`error: object fails fsck: ${msgId}: ${message}`);
      return 1;
    };
    const shape = {
      rawLength: this.objectFormat.rawLength,
      hexLength: this.objectFormat.hexLength,
    };
    const bad =
      type === "commit"
        ? fsckCommit(content, report, shape)
        : type === "tag"
          ? fsckTag(content, report, { shape })
          : type === "tree"
            ? fsckTree(
                content,
                types,
                report,
                (message) => messages.push(`error: ${message}`),
                { gitmodules: [], gitattributes: [] },
                undefined,
                shape,
              )
            : 0; // fsck_blob checks only blobs a tree named .gitmodules/.gitattributes
    if (bad) {
      throw new PlumbingError(
        [...messages, "fatal: refusing to create malformed object"].join("\n"),
      );
    }
    return this.writeObject(type, content);
  }

  /** builtin/mktree.c over the edited text (no `--missing`, no `-z`, no `--batch`). */
  private async mktree(content: Uint8Array): Promise<ObjectId> {
    // a binary string: one character per byte, so quoted names keep their bytes
    const text = latin1(content);
    const lines = text.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    const entries: { mode: number; name: Uint8Array; id: string }[] = [];
    const die = (message: string): never => {
      this.warn(`fatal: ${decodeGitPath(fromLatin1(message))}`);
      this.fail("mktree reported failure");
    };
    const hexLength = this.objectFormat.hexLength;
    for (const line of lines) {
      if (line === "") die("input format error: (blank line only valid in batch mode)");
      const modeMatch = /^[0-7]+/.exec(line);
      if (!modeMatch || line[modeMatch[0].length] !== " ") die(`input format error: ${line}`);
      const mode = Number.parseInt((modeMatch as RegExpExecArray)[0], 8);
      const typeStart = (modeMatch as RegExpExecArray)[0].length + 1;
      const space = line.indexOf(" ", typeStart);
      const id = space < 0 ? "" : line.slice(space + 1, space + 1 + hexLength);
      if (
        space < 0 ||
        !new RegExp(`^[0-9a-fA-F]{${hexLength}}$`).test(id) ||
        line[space + 1 + hexLength] !== "\t"
      ) {
        die(`input format error: ${line}`);
      }
      const typeName = line.slice(typeStart, space);
      let path = line.slice(space + 2 + hexLength);
      if (path.startsWith('"')) {
        const unquoted = cUnquote(path);
        if (!unquoted) die("invalid quoting");
        path = (unquoted as { name: string }).name;
      }
      const expected = modeType(mode);
      if (expected !== typeName) {
        die(`entry '${path}' object type (${typeName}) doesn't match mode type (${expected})`);
      }
      const oid = id.toLowerCase();
      const actual = await this.typeOf(oid);
      if (actual === undefined) {
        if ((mode & S_IFMT) !== S_IFGITLINK) die(`entry '${path}' object ${oid} is unavailable`);
      } else if (actual !== expected) {
        die(`entry '${path}' object ${oid} is a ${actual} but specified type was (${expected})`);
      }
      if (path.includes("/")) die(`path ${path} contains slash`);
      entries.push({ mode, name: fromLatin1(path), id: oid });
    }
    entries.sort((a, b) => baseNameCompare(a.name, a.mode, b.name, b.mode));
    const chunks: Uint8Array[] = [];
    for (const entry of entries) {
      chunks.push(new TextEncoder().encode(`${entry.mode.toString(8)} `));
      chunks.push(entry.name);
      chunks.push(new Uint8Array([0]));
      chunks.push(hexToBytes(entry.id));
    }
    return this.writeObject("tree", concat(chunks));
  }

  /**
   * `git replace --graft <commit> [<parent>...]` (create_graft); with `gentle` (the grafts
   * file's lines) a graft that changes nothing is a warning. Returns whether it failed.
   */
  private async createGraft(argv: string[], gentle: boolean): Promise<void> {
    const oldRef = argv[0] as string;
    const oldId = await this.getOid(oldRef);
    if (oldId === undefined) this.fail(`not a valid object name: '${oldRef}'`);
    const commit = await this.lookupCommitReference(oldId);
    if (commit === undefined) this.fail(`could not parse ${oldRef}`);
    const original = await this.readObject(commit);
    if (!original) this.fail(`could not parse ${oldRef}`);
    let buf = latin1(original);

    // replace_parents: the parent lines after `tree <id>\n`
    const hex = this.objectFormat.hexLength;
    const parentStart = hex + 6;
    let parentEnd = parentStart;
    while (buf.startsWith("parent ", parentEnd)) parentEnd += hex + 8;
    let newParents = "";
    const parentIds: (ObjectId | undefined)[] = [];
    for (const arg of argv.slice(1)) {
      const id = await this.getOid(arg);
      if (id === undefined) this.fail(`not a valid object name: '${arg}'`);
      parentIds.push(id);
      const parent = await this.lookupCommitReference(id);
      if (parent === undefined) this.fail(`could not parse ${arg} as a commit`);
      newParents += `parent ${parent}\n`;
    }
    buf = buf.slice(0, parentStart) + newParents + buf.slice(parentEnd);

    const unsigned = removeSignature(buf);
    if (unsigned.found) {
      this.warn(`warning: the original commit '${oldRef}' has a gpg signature`);
      this.warn("warning: the signature will be removed in the replacement commit!");
    }
    buf = unsigned.buffer;

    // check_mergetags: every mergetag of the original must name one of the new parents
    for (const value of mergetagValues(latin1(original))) {
      const tagId = await computeObjectId("tag", fromLatin1(value), this.objectFormat);
      const tagged = new RegExp(`^object ([0-9a-f]{${hex}})\ntype [a-z]+\n`).exec(value);
      if (!tagged) this.fail(`malformed mergetag in commit '${oldRef}'`);
      const target = (tagged as RegExpExecArray)[1];
      if (!parentIds.includes(target)) {
        this.fail(
          `original commit '${oldRef}' contains mergetag '${tagId}' that is discarded; ` +
            "use --edit instead of --graft",
        );
      }
    }

    const newId = await this.writeObject("commit", fromLatin1(buf));
    if (newId === commit) {
      if (gentle) {
        this.warn(`warning: graft for '${commit}' unnecessary`);
        return;
      }
      this.fail(`new commit is the same as the old one: '${commit}'`);
    }
    await this.replaceObjectOid(oldRef, commit, "replacement", newId);
  }

  /**
   * lookup_commit_reference: tags peeled to a commit; git's `object <id> is a <type>, not a
   * commit` for another type, undefined (silently) for a missing object.
   */
  private async lookupCommitReference(id: ObjectId): Promise<ObjectId | undefined> {
    const peeled = await this.revisionResolver()
      .peelTags(id)
      .catch(() => ({ id, type: undefined }));
    if (peeled.type === "commit") {
      await this.commitParsed(peeled.id);
      return peeled.id;
    }
    if (peeled.type !== undefined) {
      this.warn(`error: object ${peeled.id} is a ${peeled.type}, not a commit`);
    } else if (this.compatibility !== "2.43" && this.knownCommits.has(id)) {
      // repo_parse_commit of a commit object the grafts created, its object missing
      this.warn(`error: Could not read ${id}`);
    }
    return undefined;
  }

  /**
   * A commit was parsed: the first parse loads the grafts file (prepare_commit_graft, with
   * its deprecation advice unless converting it), which makes each graft's commit known; a
   * grafted commit's parse makes its grafted parents known.
   */
  private async commitParsed(id: ObjectId): Promise<void> {
    if (!this.graftsLoaded) {
      this.graftsLoaded = true;
      this.graftsLoad ??= this.readGraftFile();
      const grafts = await this.graftsLoad;
      if (grafts) {
        for (const commit of grafts.keys()) this.knownCommits.add(commit);
        if (!this.convertingGraftFile) this.adviseGraftFile();
      }
    }
    const grafts = await this.graftsLoad;
    for (const parent of grafts?.get(id) ?? []) this.knownCommits.add(parent);
  }

  /** The grafts file's grafts; undefined when there is none. */
  private async readGraftFile(): Promise<Map<ObjectId, ObjectId[]> | undefined> {
    const text = await this._workingCopy.history?.refs?.readGrafts?.();
    if (text === undefined) return undefined;
    return parseGraftFile(text).grafts;
  }

  /** advice.graftFileDeprecated, as git words it. */
  private adviseGraftFile(): void {
    const value = RemoteConfigStore.from(this._workingCopy).value("advice.graftFileDeprecated");
    if (value !== undefined && parseGitBool(value) === false) return;
    const empty = this.compatibility === "2.43" ? "hint: " : "hint:";
    const turnOff =
      this.compatibility === "2.43"
        ? 'hint: "git config advice.graftFileDeprecated false"'
        : 'hint: "git config set advice.graftFileDeprecated false"';
    for (const line of [
      "hint: Support for <GIT_DIR>/info/grafts is deprecated",
      "hint: and will be removed in a future Git version.",
      empty,
      'hint: Please use "git replace --convert-graft-file"',
      "hint: to convert the grafts into replace refs.",
      empty,
      "hint: Turn this message off by running",
      turnOff,
    ]) {
      this.warn(line);
    }
  }

  /** `git replace --convert-graft-file` (convert_graft_file) */
  private async convertGraftFile(): Promise<number> {
    const refs = this._workingCopy.history?.refs;
    if (hostEnvironmentOf(this._workingCopy)?.graftFile !== undefined) {
      throw new PlumbingError(
        "fatal: --convert-graft-file of a GIT_GRAFT_FILE is not supported",
        128,
      );
    }
    this.convertingGraftFile = true;
    // fopen_or_warn: a missing file fails silently
    const text = await refs?.readGrafts?.();
    if (text === undefined) return 1;
    let errors = "";
    const lines = text.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    for (const raw of lines) {
      // strbuf_getline drops a CR before the newline
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      if (line.startsWith("#")) continue;
      const args = line.split(/[ \t\n\v\f\r]+/).filter(Boolean);
      if (args.length === 0) continue;
      try {
        await this.createGraft(args, true);
      } catch (e) {
        if (!(e instanceof StepFailed)) throw e;
        errors += `\n\t${line}`;
      }
    }
    if (!errors) {
      await refs?.removeGrafts?.();
      return 0;
    }
    this.warn(`warning: could not convert the following graft(s):\n${errors}`);
    return 1;
  }
}

/** A refused batch's reason, as text. */
function rejectionText(result: { rejected?: readonly { reason?: string }[] }): string {
  return result.rejected?.map((r) => r.reason).join(", ") || "unable to update";
}

/** remove_signature: the `gpgsig` headers (and their continuation lines) dropped. */
function removeSignature(buf: string): { buffer: string; found: boolean } {
  let out = "";
  let found = false;
  let inSignature = false;
  let at = 0;
  while (at < buf.length) {
    const nl = buf.indexOf("\n", at);
    let next = nl < 0 ? buf.length : nl + 1;
    const line = buf.slice(at, next);
    if (inSignature && line.startsWith(" ")) {
      // still inside a signature
    } else if (line.startsWith("gpgsig")) {
      if (line.startsWith("gpgsig ") || line.startsWith("gpgsig-sha256 ")) {
        found = true;
        inSignature = true;
      }
    } else {
      if (line.startsWith("\n")) next = buf.length;
      inSignature = false;
      out += buf.slice(at, next);
    }
    at = next;
  }
  return { buffer: out, found };
}

/** The values of a commit's `mergetag` headers (read_commit_extra_header_lines). */
function mergetagValues(commit: string): string[] {
  const values: string[] = [];
  const end = commit.indexOf("\n\n");
  const lines = (end < 0 ? commit : commit.slice(0, end)).split("\n");
  let current: string | undefined;
  for (const line of lines) {
    if (current !== undefined && line.startsWith(" ")) {
      current += `${line.slice(1)}\n`;
      continue;
    }
    if (current !== undefined) values.push(current);
    current = line.startsWith("mergetag ") ? `${line.slice("mergetag ".length)}\n` : undefined;
  }
  if (current !== undefined) values.push(current);
  return values;
}

/** base_name_compare: names compared as bytes, a tree's as if it ended in `/`. */
function baseNameCompare(a: Uint8Array, modeA: number, b: Uint8Array, modeB: number): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const d = (a[i] as number) - (b[i] as number);
    if (d) return d;
  }
  const isDir = (mode: number) => (mode & S_IFMT) === S_IFDIR;
  const c1 = a.length > len ? (a[len] as number) : isDir(modeA) ? 0x2f : 0;
  const c2 = b.length > len ? (b[len] as number) : isDir(modeB) ? 0x2f : 0;
  return c1 - c2;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const d = (a[i] as number) - (b[i] as number);
    if (d) return d;
  }
  return a.length - b.length;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** Bytes as a binary string (one character per byte). */
function latin1(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return out;
}

/** A binary string's bytes. */
function fromLatin1(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
