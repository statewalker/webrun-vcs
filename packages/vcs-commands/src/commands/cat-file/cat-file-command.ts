/**
 * `git cat-file` (builtin/cat-file.c): an object's type, size, existence or content, one
 * object named on the command line (`-t`, `-s`, `-e`, `-p`, `<type> <object>`) or many read
 * from stdin (`--batch`, `--batch-check`, `--batch-command`, `--batch-all-objects`).
 *
 * @example
 * ```typescript
 * // git cat-file -p HEAD:README.md
 * await git.catFile().setMode("pretty").setObject("HEAD:README.md").setStdout(write).call();
 * // printf 'HEAD\nHEAD:a.txt\n' | git cat-file --batch-check
 * const { stdout } = await git.catFile().setBatch("info").setStdin("HEAD\nHEAD:a.txt\n").callOutput();
 * ```
 */

import {
  type CompatObjects,
  decodeTreeBytes,
  type GitObjects,
  type ObjectId,
} from "@statewalker/vcs-core";
import { ObjectInfoError } from "@statewalker/vcs-transport";
import { parseGitBool } from "@statewalker/vcs-utils";
import { decodeGitPath } from "@statewalker/vcs-utils/encoding";
import { RemoteConfigStore } from "../../remote-config/index.js";
import { quotePath } from "../../results/quote-path.js";
import { PlumbingCommand, PlumbingError } from "../plumbing-command.js";
import {
  RemoteObjectInfoCommand,
  type RemoteObjectInfoResult,
  RemoteObjectInfoUnsupportedError,
} from "../remote-object-info-command.js";
import { applyMailmapToHeader } from "../rev-filter/index.js";
import type { RevisionResolver } from "../revision-resolver.js";
import {
  type BatchFormat,
  type BatchObjectData,
  DEFAULT_BATCH_FORMAT,
  expandBatchFormat,
  parseBatchFormat,
} from "./batch-format.js";

/** `-t`, `-s`, `-e`, `-p`. */
export type CatFileMode = "type" | "size" | "exists" | "pretty";

/** `--batch` (contents), `--batch-check` (info), `--batch-command` (command). */
export type CatFileBatchMode = "contents" | "info" | "command";

/** What `--batch*` reads as stdin: text, bytes, or chunks read as they come. */
export type CatFileInput = string | Uint8Array | AsyncIterable<Uint8Array> | Iterable<Uint8Array>;

const OBJECT_TYPES = new Set(["blob", "tree", "commit", "tag"]);
const S_IFMT = 0o170000;
const S_IFGITLINK = 0o160000;
const encoder = new TextEncoder();
const MAILMAP_HEADERS = ["author ", "committer ", "tagger "].map((h) => encoder.encode(h));
/** git's `MAXREPLACEDEPTH` */
const MAX_REPLACE_DEPTH = 5;

interface ObjectInfo {
  type: string;
  size: number;
}

/**
 * `git cat-file`. Stdout goes to {@link setStdout} as git writes it: a blob's content is
 * streamed chunk by chunk as the store reads it (never held whole), and `--batch` input is
 * read line by line as {@link setStdin}'s chunks arrive, so a caller can feed names while it
 * reads the answers.
 *
 * Replace refs apply as in git (`OBJECT_INFO_LOOKUP_REPLACE`): the name printed is the one
 * asked, the type, size and content the replacement's; `--batch-all-objects` reads none.
 *
 * `--batch-command`'s `remote-object-info <remote> <id>...` (2.56) asks the remote's v2
 * `object-info` through {@link setRemoteObjectInfo}'s command: only the atoms the server
 * answered expand (`%(objectname)` always), and an object it lacks prints `<id> missing`.
 *
 * Not implemented: `--textconv`, `--filters`, `--path`, `--follow-symlinks`, `--filter`
 * (2.5x), and the `%(objectsize:disk)` and `%(deltabase)` atoms (refused: the stores report
 * neither; git's `remote-object-info` would print them empty). `--unordered` lists objects in
 * the store's listing order, not pack order. The promisor-remote warning of
 * `--batch-all-objects` is not printed.
 */
export class CatFileCommand extends PlumbingCommand {
  private mode?: CatFileMode;
  private type?: string;
  private object?: string;
  private batch?: CatFileBatchMode;
  private format?: string;
  private buffer?: boolean;
  private nulInput = false;
  private nulTerminated = false;
  private allObjects = false;
  private unordered = false;
  private useMailmap = false;
  private stdin?: CatFileInput;
  private compatibility: "2.43" | "2.56" = "2.56";

  /** `-t` (type), `-s` (size), `-e` (exists: exit 1 when absent), `-p` (pretty). */
  setMode(mode: CatFileMode): this {
    this.checkCallable();
    this.mode = mode;
    return this;
  }

  /** `<type> <object>`: the object peeled to this type (`blob`, `tree`, `commit`, `tag`). */
  setType(type: string): this {
    this.checkCallable();
    this.type = type;
    return this;
  }

  /** The object named on the command line. */
  setObject(name: string): this {
    this.checkCallable();
    this.object = name;
    return this;
  }

  /**
   * `--batch[=<format>]` (`contents`), `--batch-check[=<format>]` (`info`),
   * `--batch-command[=<format>]` (`command`).
   */
  setBatch(mode: CatFileBatchMode, format?: string): this {
    this.checkCallable();
    this.batch = mode;
    this.format = format;
    return this;
  }

  /** `--buffer` (`--batch-command`'s `flush` needs it; output itself is the same). */
  setBuffer(buffer: boolean): this {
    this.checkCallable();
    this.buffer = buffer;
    return this;
  }

  /** `-z`: stdin is NUL-terminated. */
  setNulInput(nul: boolean): this {
    this.checkCallable();
    this.nulInput = nul;
    return this;
  }

  /** `-Z`: stdin and stdout are NUL-terminated. */
  setNulTerminated(nul: boolean): this {
    this.checkCallable();
    this.nulTerminated = nul;
    return this;
  }

  /** `--batch-all-objects`: every object of the repository, stdin ignored. */
  setBatchAllObjects(all: boolean): this {
    this.checkCallable();
    this.allObjects = all;
    return this;
  }

  /** `--unordered` (with `--batch-all-objects`): the store's order, not sorted by id. */
  setUnordered(unordered: boolean): this {
    this.checkCallable();
    this.unordered = unordered;
    return this;
  }

  /**
   * The `remote-object-info` command a `--batch-command` line runs (default: one over the
   * default transports; `Git.catFile()` gives the facade's): its credentials and transports.
   */
  setRemoteObjectInfo(factory: () => RemoteObjectInfoCommand): this {
    this.checkCallable();
    this.remoteObjectInfoFactory = factory;
    return this;
  }

  private remoteObjectInfoFactory?: () => RemoteObjectInfoCommand;

  /** `--use-mailmap`: idents of commits and tags mapped through the mailmap. */
  setUseMailmap(use: boolean): this {
    this.checkCallable();
    this.useMailmap = use;
    return this;
  }

  /** The batch modes' stdin. */
  setStdin(input: CatFileInput): this {
    this.checkCallable();
    this.stdin = input;
    return this;
  }

  /** The git version whose behaviour to follow (default 2.56). */
  setCompatibility(version: "2.43" | "2.56"): this {
    this.checkCallable();
    this.compatibility = version;
    return this;
  }

  protected override writesNoObjects(): boolean {
    return true;
  }

  protected async run(): Promise<number> {
    this.checkOptions();
    if (this.batch) return this.runBatch();
    return this.catOne(this.object as string);
  }

  /** The option checks of cmd_cat_file that the setters can still break. */
  private checkOptions(): void {
    const usage = (message: string) => new PlumbingError(`fatal: ${message}`, 129);
    if (this.batch) {
      if (this.mode) throw usage(`'-${modeLetter(this.mode)}' is incompatible with batch mode`);
      if (this.object !== undefined || this.type !== undefined) {
        throw usage("batch modes take no arguments");
      }
      return;
    }
    const batchOption =
      this.buffer !== undefined
        ? "--buffer"
        : this.allObjects
          ? "--batch-all-objects"
          : this.nulInput
            ? "-z"
            : this.nulTerminated
              ? "-Z"
              : undefined;
    if (batchOption) throw usage(`'${batchOption}' requires a batch mode`);
    if (this.mode) {
      if (this.object === undefined) {
        throw usage(`<object> required with '-${modeLetter(this.mode)}'`);
      }
      if (this.type !== undefined) throw usage("too many arguments");
    } else if (this.object === undefined || this.type === undefined) {
      throw usage("only two arguments allowed in <type> <object> mode, not 1");
    }
  }

  private get objects(): GitObjects {
    const objects = this._workingCopy.history?.objects;
    if (!objects) throw new Error("WorkingCopy.history is required for commands");
    return objects;
  }

  /** `lookup_replace_object`: the object reads go to. */
  private async replaced(id: ObjectId): Promise<ObjectId> {
    const replacements = await this.objectReplacements();
    if (!replacements) return id;
    let current = id;
    for (let depth = 0; ; depth++) {
      const next = replacements.replace.get(current);
      if (next === undefined) return current;
      if (depth >= MAX_REPLACE_DEPTH) {
        throw new PlumbingError(`fatal: replace depth too high for object ${id}`);
      }
      current = next;
    }
  }

  /** `oid_object_info`: type and size from the headers, else from a read. */
  private async info(id: ObjectId): Promise<ObjectInfo | undefined> {
    const objects = this.objects;
    const header = await objects.header?.(id).catch(() => undefined);
    if (header) return header;
    const object = await objects.get(id).catch(() => undefined);
    if (!object) return undefined;
    await object.content[Symbol.asyncIterator]().return?.();
    return { type: object.type, size: object.size };
  }

  /** The whole content of a (small) object. */
  private async read(id: ObjectId): Promise<{ type: string; bytes: Uint8Array } | undefined> {
    const object = await this.objects.get(id).catch(() => undefined);
    if (!object) return undefined;
    if (object.bytes) {
      await object.content[Symbol.asyncIterator]().return?.();
      return { type: object.type, bytes: object.bytes };
    }
    const chunks: Uint8Array[] = [];
    for await (const c of object.content) chunks.push(c.slice());
    return { type: object.type, bytes: concat(chunks) };
  }

  /** `stream_blob`: the blob's content written chunk by chunk. */
  private async streamBlob(id: ObjectId): Promise<void> {
    const object = await this.objects.get(id).catch(() => undefined);
    if (!object) throw new PlumbingError(`fatal: unable to stream ${id} to stdout`);
    for await (const chunk of object.content) await this.write(chunk.slice());
  }

  private mailmapped?: Promise<(bytes: Uint8Array) => Uint8Array>;

  /** `replace_idents_using_mailmap` (identity without `--use-mailmap`). */
  private async mapIdents(bytes: Uint8Array): Promise<Uint8Array> {
    if (!this.useMailmap) return bytes;
    this.mailmapped ??= this.readMailmap().then(
      (mailmap) => (raw: Uint8Array) => applyMailmapToHeader(raw, mailmap, MAILMAP_HEADERS),
    );
    return (await this.mailmapped)(bytes);
  }

  /** cat_one_file */
  private async catOne(name: string): Promise<number> {
    const compat = this.compatObjects;
    // GET_OID_HASH_ANY: a full id of the compatibility format names the object as that
    // format sees it (its storage object converted)
    if (compat && name.length === compat.compat.hexLength && /^[0-9a-f]+$/.test(name)) {
      return this.catOneCompat(name, compat);
    }
    const resolver = this.revisionResolver();
    let id: ObjectId | undefined;
    try {
      id = await resolver.resolve(name, { onlyToDie: true });
    } finally {
      for (const line of resolver.warnings) this.warn(line);
      resolver.warnings.length = 0;
    }
    if (id === undefined) throw new PlumbingError(`fatal: Not a valid object name ${name}`);
    const couldNotGetInfo = () =>
      new PlumbingError("fatal: git cat-file: could not get object info");
    switch (this.mode) {
      case "type": {
        const info = await this.info(await this.replaced(id));
        if (!info) throw couldNotGetInfo();
        await this.write(`${info.type}\n`);
        return 0;
      }
      case "size": {
        const target = await this.replaced(id);
        const info = await this.info(target);
        if (!info) throw couldNotGetInfo();
        let size = info.size;
        if (this.useMailmap && (info.type === "commit" || info.type === "tag")) {
          const object = await this.read(target);
          if (object) size = (await this.mapIdents(object.bytes)).length;
        }
        await this.write(`${size}\n`);
        return 0;
      }
      case "exists":
        return (await this.objects.has(id)) ? 0 : 1;
      case "pretty":
        return this.pretty(name, await this.replaced(id));
      default:
        return this.catTyped(name, id, this.type as string);
    }
  }

  /**
   * cat_one_file for an id of the compatibility format: the object read through the map and
   * converted (`odb_read_object_info_extended` with an id of the other format).
   */
  private async catOneCompat(name: string, compat: CompatObjects): Promise<number> {
    const read = (id: string) => compat.readAsCompat(id);
    if (this.mode === "exists")
      return (await compat.toStorage(name)) !== undefined && (await read(name)) !== undefined
        ? 0
        : 1;
    const object = await read(name);
    if (!object) {
      if (this.mode === "type" || this.mode === "size") {
        throw new PlumbingError("fatal: git cat-file: could not get object info");
      }
      throw new PlumbingError(`fatal: Not a valid object name ${name}`);
    }
    switch (this.mode) {
      case "type":
        await this.write(`${object.type}\n`);
        return 0;
      case "size":
        await this.write(`${object.content.length}\n`);
        return 0;
      case "pretty":
        if (object.type === "tree") {
          const config = RemoteConfigStore.from(this._workingCopy);
          const quoteFully = parseGitBool(config.value("core.quotePath")) ?? true;
          let out = "";
          for (const entry of decodeTreeBytes(object.content, {
            idLength: compat.compat.rawLength,
            checkNames: false,
          })) {
            const kind = entry.mode & S_IFMT;
            const type = kind === 0o040000 ? "tree" : kind === S_IFGITLINK ? "commit" : "blob";
            const mode = entry.mode.toString(8).padStart(6, "0");
            out += `${mode} ${type} ${entry.id}\t${quotePath(entry.name, quoteFully)}\n`;
          }
          await this.write(out);
          return 0;
        }
        await this.write(
          object.type === "blob" ? object.content : await this.mapIdents(object.content),
        );
        return 0;
      default: {
        const type = this.type as string;
        if (!OBJECT_TYPES.has(type)) {
          throw new PlumbingError(`fatal: invalid object type "${type}"`);
        }
        // odb_read_object_peeled, through the compatibility ids
        let current: { type: string; content: Uint8Array } | undefined = object;
        while (current && current.type !== type) {
          const text = new TextDecoder().decode(current.content.subarray(0, 200));
          let next: RegExpExecArray | null = null;
          if (current.type === "tag") next = /^object ([0-9a-f]+)/.exec(text);
          else if (current.type === "commit" && type === "tree") {
            next = /^tree ([0-9a-f]+)/.exec(text);
          }
          current = next ? await read(next[1] as string) : undefined;
        }
        if (!current) throw new PlumbingError(`fatal: git cat-file ${name}: bad file`);
        await this.write(
          current.type === "blob" ? current.content : await this.mapIdents(current.content),
        );
        return 0;
      }
    }
  }

  /** `-p` */
  private async pretty(name: string, id: ObjectId): Promise<number> {
    const info = await this.info(id);
    if (!info) throw new PlumbingError(`fatal: Not a valid object name ${name}`);
    if (info.type === "tree") {
      await this.listTree(id);
      return 0;
    }
    if (info.type === "blob") {
      await this.streamBlob(id);
      return 0;
    }
    const object = await this.read(id);
    if (!object) throw new PlumbingError(`fatal: Cannot read object ${name}`);
    await this.write(await this.mapIdents(object.bytes));
    return 0;
  }

  /** `git ls-tree <tree>`, as `-p` prints a tree. */
  private async listTree(id: ObjectId): Promise<void> {
    const config = RemoteConfigStore.from(this._workingCopy);
    const quoteFully = parseGitBool(config.value("core.quotePath")) ?? true;
    const entries = await this.listedTreeEntries(id);
    if (!entries) throw new PlumbingError(`fatal: Cannot read object ${id}`);
    let out = "";
    for (const entry of entries) {
      const kind = entry.mode & S_IFMT;
      const type = kind === 0o040000 ? "tree" : kind === S_IFGITLINK ? "commit" : "blob";
      const mode = entry.mode.toString(8).padStart(6, "0");
      out += `${mode} ${type} ${entry.id}\t${quotePath(entry.name, quoteFully)}\n`;
      if (out.length >= 1 << 16) {
        await this.write(out);
        out = "";
      }
    }
    await this.write(out);
  }

  /** `<type> <object>` */
  private async catTyped(name: string, id: ObjectId, type: string): Promise<number> {
    if (!OBJECT_TYPES.has(type)) throw new PlumbingError(`fatal: invalid object type "${type}"`);
    if (type === "blob") {
      let blob = id;
      const target = await this.replaced(id);
      if ((await this.info(target))?.type === "tag") {
        const tag = await this.read(target);
        const match = tag && /^object ([0-9a-f]+)/.exec(new TextDecoder().decode(tag.bytes));
        if (!match || !this.isFullObjectId(match[1] as string)) {
          throw new PlumbingError(`fatal: ${id} not a valid tag`);
        }
        blob = match[1] as string;
      }
      const blobTarget = await this.replaced(blob);
      if ((await this.info(blobTarget))?.type === "blob") {
        await this.streamBlob(blobTarget);
        return 0;
      }
    }
    const bytes = await this.peeled(id, type);
    if (!bytes) throw new PlumbingError(`fatal: git cat-file ${name}: bad file`);
    await this.write(await this.mapIdents(bytes));
    return 0;
  }

  /** `odb_read_object_peeled`: tags followed, a commit's tree for a tree. */
  private async peeled(id: ObjectId, type: string): Promise<Uint8Array | undefined> {
    let current = id;
    for (;;) {
      const object = await this.read(await this.replaced(current));
      if (!object) return undefined;
      if (object.type === type) return object.bytes;
      const text = new TextDecoder().decode(object.bytes.subarray(0, 200));
      let next: RegExpExecArray | null = null;
      if (object.type === "tag") next = /^object ([0-9a-f]+)/.exec(text);
      else if (object.type === "commit" && type === "tree") next = /^tree ([0-9a-f]+)/.exec(text);
      if (!next || !this.isFullObjectId(next[1] as string)) return undefined;
      current = next[1] as string;
    }
  }

  /** batch_objects */
  private async runBatch(): Promise<number> {
    const compatibility = this.compatibility;
    // --batch-command defers %(objectsize:disk)/%(deltabase) to the first local object: a
    // remote-object-info line prints them empty, as git
    const format = parseBatchFormat(this.format ?? DEFAULT_BATCH_FORMAT, compatibility, {
      deferUnsupported: this.batch === "command",
    });
    const plain = this.format === undefined || this.format === DEFAULT_BATCH_FORMAT;
    const state: BatchState = {
      format,
      plain,
      delim: this.nulTerminated ? "\0" : "\n",
      contents: this.batch === "contents",
      replace: !this.allObjects,
    };
    if (this.allObjects) {
      const ids: ObjectId[] = [];
      for await (const id of this.objects.list()) ids.push(id);
      const listed = this.unordered ? ids : [...new Set(ids)].sort();
      const seen = new Set<ObjectId>();
      for (const id of listed) {
        if (seen.has(id)) continue;
        seen.add(id);
        await this.batchObjectWrite(state, undefined, { id });
      }
      return 0;
    }
    const resolver = this.revisionResolver();
    const lines = readLines(this.stdin ?? "", this.nulTerminated || this.nulInput ? 0 : 0x0a);
    if (this.batch === "command") {
      await this.batchCommands(state, resolver, lines);
      return 0;
    }
    for await (const line of lines) {
      let name = line;
      let rest: string | undefined;
      if (format.splitOnWhitespace) {
        const split = /[ \t]/.exec(line);
        if (split) {
          name = line.slice(0, split.index);
          rest = line.slice(split.index).replace(/^[ \t]+/, "");
        }
      }
      await this.batchOne(state, resolver, name, rest);
    }
    return 0;
  }

  /** batch_objects_command: `contents`, `info`, `flush` (and 2.5x's `mailmap`). */
  private async batchCommands(
    state: BatchState,
    resolver: RevisionResolver,
    lines: AsyncIterable<string>,
  ): Promise<void> {
    const buffer = this.buffer ?? false;
    const commands =
      this.compatibility === "2.43"
        ? [
            ["contents", true],
            ["info", true],
            ["flush", false],
          ]
        : [
            ["contents", true],
            ["flush", false],
            ["info", true],
            ["mailmap", true],
            ["remote-object-info", true],
          ];
    const queue: { name: string; arg: string }[] = [];
    const dispatch = async (name: string, arg: string) => {
      if (name === "mailmap") {
        const value = parseGitBool(arg);
        if (value === undefined)
          throw new PlumbingError(`fatal: mailmap: invalid boolean '${arg}'`);
        this.useMailmap = value;
        return;
      }
      if (name === "remote-object-info") {
        await this.remoteObjectInfo(state, arg);
        return;
      }
      await this.batchOne({ ...state, contents: name === "contents" }, resolver, arg, undefined);
    };
    const flush = async () => {
      if (!buffer) throw new PlumbingError("fatal: flush is only for --buffer mode");
      for (const call of queue.splice(0)) await dispatch(call.name, call.arg);
    };
    for await (const line of lines) {
      if (line === "") throw new PlumbingError("fatal: empty command in input");
      if (/^[ \t\n\v\f\r]/.test(line)) {
        throw new PlumbingError(`fatal: whitespace before command: '${line}'`);
      }
      let found: { name: string; arg: string } | undefined;
      for (const [name, takesArgs] of commands as [string, boolean][]) {
        if (!line.startsWith(name)) continue;
        const end = line.slice(name.length);
        if (takesArgs) {
          if (end[0] !== " ") throw new PlumbingError(`fatal: ${name} requires arguments`);
        } else if (end !== "") {
          throw new PlumbingError(`fatal: ${name} takes no arguments`);
        }
        found = { name, arg: end.slice(1) };
        break;
      }
      if (!found) throw new PlumbingError(`fatal: unknown command: '${line}'`);
      if (found.name === "flush") await flush();
      else if (!buffer) await dispatch(found.name, found.arg);
      else queue.push(found);
    }
    if (buffer && queue.length > 0) await flush();
  }

  /**
   * parse_cmd_remote_object_info: `<remote> <id>...` split as git's `split_cmdline` (quotes
   * and backslashes), the ids checked before the remote is asked, then one line per id in
   * order: `<id> missing` for an object the server lacks, else the format with only the
   * atoms the server answered (the default format prints the type and size it got).
   */
  private async remoteObjectInfo(state: BatchState, line: string): Promise<void> {
    if (line.length >= MAX_REMOTE_OBJ_INFO_LINE) {
      throw new PlumbingError("fatal: remote-object-info command too long");
    }
    const argv = splitCmdline(line);
    if (typeof argv === "string") {
      throw new PlumbingError(`fatal: remote-object-info: failed to parse command line: ${argv}`);
    }
    if (argv.length - 1 > MAX_ALLOWED_OBJ_LIMIT) {
      throw new PlumbingError(
        `fatal: remote-object-info supports at most ${MAX_ALLOWED_OBJ_LIMIT} objects`,
      );
    }
    // get_remote_info: get_oid_hex reads the first hexsz digits (any case) and nothing after
    const hexLength = this.objectFormat.hexLength;
    const ids: string[] = [];
    for (const arg of argv.slice(1)) {
      const head = arg.slice(0, hexLength);
      if (head.length === hexLength && /^[0-9a-fA-F]+$/.test(head)) {
        ids.push(head.toLowerCase());
        continue;
      }
      if (arg.length < hexLength && arg.length >= 4 && /^[0-9a-fA-F]+$/.test(arg)) {
        throw new PlumbingError(
          `fatal: remote-object-info does not support short oids, ${hexLength} characters required`,
        );
      }
      throw new PlumbingError(`fatal: not a valid object name '${arg}'`);
    }
    if (ids.length === 0) throw new PlumbingError("fatal: remote-object-info requires objects");
    const command = (
      this.remoteObjectInfoFactory?.() ?? new RemoteObjectInfoCommand(this.workingCopy)
    )
      .setRemote(argv[0] as string)
      .setSize(state.plain || state.format.needsSize)
      .setType(state.plain || state.format.needsType);
    for (const id of ids) command.addObjectId(id);
    let answer: RemoteObjectInfoResult;
    try {
      answer = await command.call();
    } catch (error) {
      if (error instanceof ObjectInfoError || error instanceof RemoteObjectInfoUnsupportedError) {
        throw new PlumbingError(`fatal: ${error.message}`);
      }
      throw error;
    }
    const remote = { size: answer.size, type: answer.type };
    for (const object of answer.objects) {
      if (object.missing) {
        await this.write(`${object.id} missing${state.delim}`);
        continue;
      }
      const data: BatchObjectData = {
        id: object.id,
        ...(object.type !== undefined ? { type: object.type } : {}),
        ...(object.size !== undefined ? { size: object.size } : {}),
      };
      await this.write(
        state.plain
          ? `${data.id} ${data.type ?? ""} ${data.size ?? 0}${state.delim}`
          : `${expandBatchFormat(state.format, data, remote)}${state.delim}`,
      );
    }
  }

  /** batch_one_object */
  private async batchOne(
    state: BatchState,
    resolver: RevisionResolver,
    name: string,
    rest: string | undefined,
  ): Promise<void> {
    let id: ObjectId | undefined;
    try {
      id = await resolver.resolve(name);
    } finally {
      for (const line of resolver.warnings) this.warn(line);
    }
    const ambiguous = resolver.warnings.some((l) => l.startsWith("error: short object ID "));
    resolver.warnings.length = 0;
    if (id === undefined) {
      await this.write(`${name} ${ambiguous ? "ambiguous" : "missing"}${state.delim}`);
      return;
    }
    await this.batchObjectWrite(state, name, {
      id,
      ...(resolver.lastMode !== undefined ? { mode: resolver.lastMode } : {}),
      ...(rest !== undefined ? { rest } : {}),
    });
  }

  /** batch_object_write */
  private async batchObjectWrite(
    state: BatchState,
    name: string | undefined,
    data: BatchObjectData,
  ): Promise<void> {
    const target = state.replace ? await this.replaced(data.id) : data.id;
    const info = await this.info(target);
    if (!info) {
      if (this.compatibility !== "2.43" && data.mode !== undefined) {
        if ((data.mode & S_IFMT) === S_IFGITLINK) {
          await this.write(`${data.id} submodule${state.delim}`);
          return;
        }
      }
      await this.write(`${name ?? data.id} missing${state.delim}`);
      return;
    }
    data.type = info.type;
    data.size = info.size;
    let content: Uint8Array | undefined;
    if (this.useMailmap && (info.type === "commit" || info.type === "tag")) {
      const object = await this.read(target);
      if (!object) throw new PlumbingError(`fatal: unable to read ${data.id}`);
      content = await this.mapIdents(object.bytes);
      data.size = content.length;
    }
    const header = state.plain
      ? `${data.id} ${data.type} ${data.size}${state.delim}`
      : `${expandBatchFormat(state.format, data)}${state.delim}`;
    await this.write(header);
    if (!state.contents) return;
    if (info.type === "blob") {
      await this.streamBlob(target);
    } else {
      if (!content) {
        const object = await this.read(target);
        if (!object) throw new PlumbingError(`fatal: object ${data.id} disappeared`);
        content = object.bytes;
      }
      await this.write(content);
    }
    await this.write(state.delim);
  }
}

interface BatchState {
  format: BatchFormat;
  /** No format, or the default one: git's print_default_format */
  plain: boolean;
  delim: string;
  /** `--batch`, or a `contents` command: the content follows the header */
  contents: boolean;
  /** Replace refs apply (not under `--batch-all-objects`) */
  replace: boolean;
}

/** cat-file.c's MAX_ALLOWED_OBJ_LIMIT: ids one remote-object-info line may ask about. */
const MAX_ALLOWED_OBJ_LIMIT = 10000;

/** cat-file.c's MAX_REMOTE_OBJ_INFO_LINE: a URL of 8 KiB and the ids (GIT_MAX_HEXSZ + 1 each). */
const MAX_REMOTE_OBJ_INFO_LINE = 8 * 1024 + MAX_ALLOWED_OBJ_LIMIT * (64 + 1);

/**
 * alias.c's split_cmdline: words split on whitespace, quotes removed, a backslash escaping
 * the next character outside single quotes; split_cmdline_strerror's text on an error.
 */
function splitCmdline(line: string): string[] | string {
  // one word to begin with; every whitespace run ends one and starts the next (a trailing
  // run leaves an empty last word, as git's)
  const args: string[] = [];
  let current = "";
  let quoted = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i] as string;
    if (!quoted && /[ \t\n\r]/.test(c)) {
      args.push(current);
      current = "";
      while (i + 1 < line.length && /[ \t\n\r]/.test(line[i + 1] as string)) i++;
    } else if (!quoted && (c === "'" || c === '"')) {
      quoted = c;
    } else if (c === quoted) {
      quoted = "";
    } else {
      if (c === "\\" && quoted !== "'") {
        i++;
        if (i >= line.length) return "cmdline ends with \\";
      }
      current += line[i];
    }
  }
  if (quoted) return "unclosed quote";
  args.push(current);
  return args;
}

function modeLetter(mode: CatFileMode): string {
  return mode === "type" ? "t" : mode === "size" ? "s" : mode === "exists" ? "e" : "p";
}

function concat(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0] as Uint8Array;
  let size = 0;
  for (const c of chunks) size += c.length;
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/**
 * `strbuf_getline` (`strbuf_getdelim_strip_crlf`) over the input as it arrives: each record
 * without its delimiter, and for newline-terminated input without a CR before it (`-z`'s
 * `strbuf_getline_nul` keeps the CR); a last record without a delimiter is read too.
 * Records are bytes: they are decoded as git paths ({@link decodeGitPath}), so a name that
 * is not UTF-8 resolves and is echoed (`<name> missing`) with its bytes.
 */
async function* readLines(input: CatFileInput, delimiter: number): AsyncGenerator<string> {
  const chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array> =
    typeof input === "string"
      ? [encoder.encode(input)]
      : input instanceof Uint8Array
        ? [input]
        : input;
  let pending: Uint8Array[] = [];
  const emit = (bytes: Uint8Array) => {
    let end = bytes.length;
    if (delimiter === 0x0a && end > 0 && bytes[end - 1] === 0x0d) end--;
    return decodeGitPath(bytes.subarray(0, end));
  };
  for await (const chunk of chunks) {
    let start = 0;
    for (;;) {
      const at = chunk.indexOf(delimiter, start);
      if (at < 0) break;
      const piece = chunk.subarray(start, at);
      const line = pending.length > 0 ? concat([...pending, piece]) : piece;
      pending = [];
      yield emit(line);
      start = at + 1;
    }
    if (start < chunk.length) pending.push(chunk.slice(start));
  }
  if (pending.length > 0) yield emit(concat(pending));
}
