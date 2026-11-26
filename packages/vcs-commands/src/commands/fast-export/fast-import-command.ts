/**
 * `git fast-import` (builtin/fast-import.c): objects and refs written from a fast-import
 * stream, as git writes them.
 *
 * @example
 * ```typescript
 * // git fast-import --quiet < stream
 * const { exitCode, stderr } = await git.fastImport().setInput(stream).callOutput();
 * // git fast-import --export-marks=marks --force < stream
 * await git.fastImport().setInput(stream).setForce(true).setExportMarks("marks").setMarksFiles(files).call();
 * ```
 */

import type { ObjectId } from "@statewalker/vcs-core";
import { isValidRefName, isValidWorktreePath } from "@statewalker/vcs-core";
import { decodeGitPath, encodeGitPath } from "@statewalker/vcs-utils/encoding";
import { cUnquote } from "../apply/latin1.js";
import { localTimezoneOffset, parseGitDate } from "../git-date.js";
import { PlumbingCommand, PlumbingError } from "../plumbing-command.js";
import {
  type FastMarksFiles,
  isSignMode,
  latin1,
  latin1Bytes,
  readObjectBytes,
  type SignMode,
  signatureStartOf,
} from "./fast-stream-support.js";

/** `--date-format=<fmt>` */
export type FastImportDateFormat = "raw" | "raw-permissive" | "rfc2822" | "now";

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;
const S_IFGITLINK = 0o160000;
const BRANCH_TABLE_SIZE = 1039;

/** A tree entry being built (fast-import.c's tree_entry): `id` undefined while dirty. */
interface Node {
  mode: number;
  id: ObjectId | undefined;
  /** The loaded entries, by name as a binary string; undefined until read */
  entries?: Map<string, Node>;
}

interface Branch {
  name: string;
  /** The tip, or undefined for git's null oid */
  oid: ObjectId | undefined;
  root: Node;
  delete: boolean;
}

interface MarkedObject {
  id: ObjectId;
  type: string;
}

/** fast-import.c's hc_str over the name's bytes as signed chars. */
function hcStr(name: string): number {
  let r = 0;
  for (const b of encodeGitPath(name)) {
    const c = b > 127 ? b - 256 : b;
    r = (Math.imul(r, 31) + c) >>> 0;
  }
  return r;
}

/** Thrown to end the run where git dies (its message, without `fatal: `). */
class FastImportDeath extends Error {}

/**
 * Writes the objects and refs a fast-import stream describes (`git fast-import`).
 *
 * Supported: `blob`, `commit` (`M`, `D`, `R`, `C`, `deleteall`, `ls`, `cat-blob` among its
 * changes; `from`, `merge`, `encoding`, `original-oid`, and 2.5x's `gpgsig`), `tag`,
 * `reset`, `checkpoint`, `progress`, `done`, `alias`, `get-mark`, `cat-blob`, `ls`,
 * `feature` and `option git`; marks files through {@link setMarksFiles}. Branches are
 * updated at the end (and at each `checkpoint`) in git's order, refusing to rewind one
 * unless {@link setForce} (`warning: not updating ...`, exit status 1); tags are written
 * unconditionally, every update logged as `fast-import`. Where git dies, the objects
 * written so far stay, marks are exported, and no ref moves.
 *
 * Not supported: notes (`N`), submodule rewriting (`rewrite-submodules-*`), the statistics
 * report (`--stats`; ours prints none, as `--quiet`), the crash report file, and pack
 * options (`--max-pack-size`, `--depth`, `--big-file-threshold`, accepted and ignored).
 *
 * Version differences (`setCompatibility("2.43")`): no `gpgsig` commands and no signature
 * modes, and git's capitalised death messages.
 */
export class FastImportCommand extends PlumbingCommand {
  private input: Uint8Array = new Uint8Array(0);
  private compatibility: "2.43" | "2.56" = "2.56";
  private marksFiles?: FastMarksFiles;

  // command-line options (undefined: not given, a stream feature may set it)
  private cliForce?: boolean;
  private cliDone?: boolean;
  private cliDateFormat?: FastImportDateFormat;
  private cliImportMarks?: { path: string; ifExists: boolean };
  private cliExportMarks?: string;
  private cliRelativeMarks?: boolean;
  private allowUnsafe = false;
  private cliSignedTags?: SignMode;
  private cliSignedCommits?: SignMode;

  // effective settings
  private force = false;
  private requireDone = false;
  private dateFormat: FastImportDateFormat = "raw";
  private importMarksFile?: { path: string; relative: boolean; ifExists: boolean };
  private importMarksFromStream = false;
  private exportMarksFile?: { path: string; relative: boolean };
  private relativeMarks = false;
  private signedTags: SignMode = "verbatim";
  private signedCommits: SignMode = "verbatim";

  // the stream
  private pos = 0;
  private line = "";
  private unread = false;
  private eof = false;
  private seenDataCommand = false;

  // the import's state
  private readonly marks = new Map<number, MarkedObject>();
  private readonly objectTypes = new Map<ObjectId, string>();
  private readonly branchTable: (Branch[] | undefined)[] = new Array(BRANCH_TABLE_SIZE);
  private readonly branches = new Map<string, Branch>();
  private tags: { name: string; id: ObjectId }[] = [];
  private nextMark = 0;
  private failure = false;
  private importMarksDone = false;

  /** The stream (git reads it from stdin). */
  setInput(input: string | Uint8Array): this {
    this.checkCallable();
    this.input = typeof input === "string" ? latin1Bytes(utf8Binary(input)) : input;
    return this;
  }

  /** `--force`: branches may be rewound. */
  setForce(force: boolean): this {
    this.checkCallable();
    this.cliForce = force;
    return this;
  }

  /** `--done`: the stream must end with a `done` command. */
  setDone(done: boolean): this {
    this.checkCallable();
    this.cliDone = done;
    return this;
  }

  /** `--date-format=<fmt>` (default `raw`). */
  setDateFormat(format: FastImportDateFormat): this {
    this.checkCallable();
    this.cliDateFormat = format;
    return this;
  }

  /** `--import-marks=<file>` (or `--import-marks-if-exists=<file>` with `ifExists`). */
  setImportMarks(path: string, options: { ifExists?: boolean } = {}): this {
    this.checkCallable();
    this.cliImportMarks = { path, ifExists: options.ifExists === true };
    return this;
  }

  /** `--export-marks=<file>` */
  setExportMarks(path: string): this {
    this.checkCallable();
    this.cliExportMarks = path;
    return this;
  }

  /** `--[no-]relative-marks` */
  setRelativeMarks(relative: boolean): this {
    this.checkCallable();
    this.cliRelativeMarks = relative;
    return this;
  }

  /** Where marks files are read and written. */
  setMarksFiles(files: FastMarksFiles): this {
    this.checkCallable();
    this.marksFiles = files;
    return this;
  }

  /** `--allow-unsafe-features`: the stream may name marks files. */
  setAllowUnsafeFeatures(allow: boolean): this {
    this.checkCallable();
    this.allowUnsafe = allow;
    return this;
  }

  /** `--signed-tags=<mode>` (git 2.50+, default `verbatim`). */
  setSignedTags(mode: SignMode): this {
    this.checkCallable();
    this.cliSignedTags = mode;
    return this;
  }

  /** `--signed-commits=<mode>` (git 2.50+, default `verbatim`). */
  setSignedCommits(mode: SignMode): this {
    this.checkCallable();
    this.cliSignedCommits = mode;
    return this;
  }

  /** The git version whose behaviour is followed (default 2.56). */
  setCompatibility(version: "2.43" | "2.56"): this {
    this.checkCallable();
    this.compatibility = version;
    return this;
  }

  // ---------------------------------------------------------------------------------------

  private die(message: string, message243?: string): never {
    throw new FastImportDeath(
      this.compatibility === "2.43" ? (message243 ?? capitalized243(message)) : message,
    );
  }

  private get objects() {
    const objects = this.workingCopy.history?.objects;
    if (!objects) throw new Error("fast-import needs the object store (history.objects)");
    return objects;
  }

  protected async run(): Promise<number> {
    try {
      while (await this.readNextCommand()) {
        const cmd = this.line;
        if (cmd === "blob") await this.parseNewBlob();
        else if (cmd.startsWith("commit ")) await this.parseNewCommit(cmd.slice(7));
        else if (cmd.startsWith("tag ")) await this.parseNewTag(cmd.slice(4));
        else if (cmd.startsWith("reset ")) await this.parseResetBranch(cmd.slice(6));
        else if (cmd.startsWith("ls ")) await this.parseLs(cmd.slice(3), undefined);
        else if (cmd.startsWith("cat-blob ")) await this.parseCatBlob(cmd.slice(9));
        else if (cmd.startsWith("get-mark ")) await this.parseGetMark(cmd.slice(9));
        else if (cmd === "checkpoint") {
          this.skipOptionalLf();
          await this.checkpoint();
        } else if (cmd === "done") break;
        else if (cmd === "alias") await this.parseAlias();
        else if (cmd.startsWith("progress ")) {
          await this.write(latin1Bytes(`${cmd}\n`));
          this.skipOptionalLf();
        } else if (cmd.startsWith("feature ")) this.parseFeature(cmd.slice(8));
        else if (cmd.startsWith("option git ")) this.parseOption(cmd.slice(11));
        else if (cmd.startsWith("option ")) {
          // non-git options are ignored
        } else this.die(`unsupported command: ${cmd}`);
      }
      if (!this.seenDataCommand) await this.parseArgv();
      if (this.requireDone && this.eof) this.die("stream ends early");
    } catch (e) {
      if (!(e instanceof FastImportDeath)) throw e;
      // die_nicely: the objects stay, the marks are dumped, no ref moves
      await this.dumpMarks().catch(() => undefined);
      throw new PlumbingError(`fatal: ${e.message}`);
    }
    await this.dumpBranches();
    await this.dumpTags();
    await this.dumpMarks();
    return this.failure ? 1 : 0;
  }

  // ---------------------------------------------------------------- stream reading

  /** strbuf_getline_lf: the next line without its newline; undefined at the end. */
  private readLine(): string | undefined {
    if (this.pos >= this.input.length) return undefined;
    let end = this.input.indexOf(10, this.pos);
    if (end < 0) end = this.input.length;
    const line = latin1(this.input.subarray(this.pos, end));
    this.pos = end + 1;
    return line;
  }

  /** read_next_command: false at the end of the stream. */
  private async readNextCommand(): Promise<boolean> {
    if (this.eof) {
      this.unread = false;
      this.line = "";
      return false;
    }
    for (;;) {
      if (this.unread) this.unread = false;
      else {
        const line = this.readLine();
        if (line === undefined) {
          this.eof = true;
          this.line = "";
          return false;
        }
        this.line = line;
        if (!this.seenDataCommand && !line.startsWith("feature ") && !line.startsWith("option ")) {
          await this.parseArgv();
        }
      }
      if (this.line.startsWith("#")) continue;
      return true;
    }
  }

  private skipOptionalLf(): void {
    if (this.input[this.pos] === 10) this.pos++;
  }

  /** parse_data: the bytes of a `data` command, as a binary string. */
  private parseData(): string {
    const cmd = this.line;
    if (!cmd.startsWith("data ")) this.die(`expected 'data n' command, found: ${cmd}`);
    let data = cmd.slice(5);
    let out: string;
    if (data.startsWith("<<")) {
      data = data.slice(2);
      const parts: string[] = [];
      for (;;) {
        const line = this.readLine();
        if (line === undefined) this.die(`EOF in data (terminator '${data}' not found)`);
        if (line === data) break;
        parts.push(`${line}\n`);
      }
      out = parts.join("");
    } else {
      const length = Number(/^\s*\+?(\d*)/.exec(data)?.[1] || "0");
      const available = this.input.length - this.pos;
      if (available < length) {
        this.pos = this.input.length;
        this.die(`EOF in data (${length - available} bytes remaining)`);
      }
      out = latin1(this.input.subarray(this.pos, this.pos + length));
      this.pos += length;
    }
    this.skipOptionalLf();
    return out;
  }

  private parseMark(): Promise<void> | void {
    if (this.line.startsWith("mark :")) {
      this.nextMark = Number(/^\d*/.exec(this.line.slice(6))?.[0] || "0");
      return this.readNextCommand().then(() => undefined);
    }
    this.nextMark = 0;
  }

  private async parseOriginalIdentifier(): Promise<void> {
    if (this.line.startsWith("original-oid ")) await this.readNextCommand();
  }

  // ---------------------------------------------------------------- options and features

  /** parse_argv: the command line's options win over the stream's features. */
  private async parseArgv(): Promise<void> {
    if (this.cliForce !== undefined) this.force = this.cliForce;
    if (this.cliDone !== undefined) this.requireDone = this.cliDone;
    if (this.cliDateFormat !== undefined) this.dateFormat = this.cliDateFormat;
    if (this.cliRelativeMarks !== undefined) this.relativeMarks = this.cliRelativeMarks;
    if (this.cliSignedTags !== undefined) this.signedTags = this.cliSignedTags;
    if (this.cliSignedCommits !== undefined) this.signedCommits = this.cliSignedCommits;
    if (this.cliImportMarks) {
      if (this.importMarksFile && !this.importMarksFromStream) await this.readMarks();
      this.importMarksFile = {
        path: this.cliImportMarks.path,
        relative: this.relativeMarks,
        ifExists: this.cliImportMarks.ifExists,
      };
      this.importMarksFromStream = false;
    }
    if (this.cliExportMarks !== undefined) {
      this.exportMarksFile = { path: this.cliExportMarks, relative: this.relativeMarks };
    }
    this.seenDataCommand = true;
    if (this.importMarksFile) await this.readMarks();
  }

  private checkUnsafe(feature: string, kind: "feature" | "option" = "feature"): void {
    if (!this.allowUnsafe) {
      this.die(`${kind} '${feature}' forbidden in input without --allow-unsafe-features`);
    }
  }

  private parseFeature(feature: string): void {
    if (this.seenDataCommand) this.die(`got feature command '${feature}' after data command`);
    const value = (prefix: string) =>
      feature.startsWith(prefix) ? feature.slice(prefix.length) : undefined;
    const dateFormat = value("date-format=");
    const importMarks = value("import-marks=");
    const importMarksIfExists = value("import-marks-if-exists=");
    const exportMarks = value("export-marks=");
    if (dateFormat !== undefined) {
      this.dateFormat = parseDateFormat(dateFormat, (m) => this.die(m));
    } else if (importMarks !== undefined) {
      this.checkUnsafe("import-marks");
      this.optionImportMarks(importMarks, false);
    } else if (importMarksIfExists !== undefined) {
      this.checkUnsafe("import-marks-if-exists");
      this.optionImportMarks(importMarksIfExists, true);
    } else if (exportMarks !== undefined) {
      this.checkUnsafe(feature);
      this.exportMarksFile = { path: exportMarks, relative: this.relativeMarks };
    } else if (feature === "relative-marks") this.relativeMarks = true;
    else if (feature === "no-relative-marks") this.relativeMarks = false;
    else if (feature === "done") this.requireDone = true;
    else if (feature === "force") this.force = true;
    else if (["alias", "get-mark", "cat-blob", "notes", "ls"].includes(feature)) {
      // supported
    } else {
      this.die(
        `this version of fast-import does not support feature ${feature}.`,
        `This version of fast-import does not support feature ${feature}.`,
      );
    }
  }

  private optionImportMarks(path: string, ifExists: boolean): void {
    if (this.importMarksFile) this.die("only one import-marks command allowed per stream");
    this.importMarksFile = { path, relative: this.relativeMarks, ifExists };
    this.importMarksFromStream = true;
  }

  private parseOption(option: string): void {
    if (this.seenDataCommand) this.die(`got option command '${option}' after data command`);
    if (
      option.startsWith("max-pack-size=") ||
      option.startsWith("big-file-threshold=") ||
      option.startsWith("depth=") ||
      option.startsWith("active-branches=") ||
      option === "stats" ||
      option === "quiet" ||
      option === "allow-unsafe-features"
    ) {
      return;
    }
    if (option.startsWith("export-pack-edges=")) {
      this.checkUnsafe("export-pack-edges", "option");
      return;
    }
    const mode = option.startsWith("signed-commits=")
      ? "commits"
      : option.startsWith("signed-tags=")
        ? "tags"
        : undefined;
    if (mode && this.compatibility !== "2.43") {
      const value = option.slice(option.indexOf("=") + 1);
      if (!isSignMode(value)) this.die(`unknown --signed-${mode} mode '${value}'`);
      if (mode === "commits") this.signedCommits = value;
      else this.signedTags = value;
      return;
    }
    this.die(
      `this version of fast-import does not support option: ${option}`,
      `This version of fast-import does not support option: ${option}`,
    );
  }

  // ---------------------------------------------------------------- marks

  private marksFilesOrDie(): FastMarksFiles {
    if (!this.marksFiles) throw new Error("fast-import marks files need setMarksFiles");
    return this.marksFiles;
  }

  private async readMarks(): Promise<void> {
    const file = this.importMarksFile;
    if (!file) return;
    const bytes = await this.marksFilesOrDie().read(file.path, { relative: file.relative });
    if (bytes === undefined) {
      if (file.ifExists) {
        this.importMarksDone = true;
        return;
      }
      this.die(`cannot read '${file.path}': No such file or directory`);
    }
    const text = latin1(bytes as Uint8Array);
    let at = 0;
    while (at < text.length) {
      const nl = text.indexOf("\n", at);
      const line = nl < 0 ? text.slice(at) : text.slice(at, nl);
      at = nl < 0 ? text.length : nl + 1;
      const m = /^:(\d+) ([0-9a-fA-F]{40}|[0-9a-fA-F]{64})/.exec(line);
      if (!m || nl < 0 || Number(m[1]) === 0) this.die(`corrupt mark line: ${line}`);
      const mark = Number((m as RegExpExecArray)[1]);
      const id = ((m as RegExpExecArray)[2] as string).toLowerCase();
      let type = this.objectTypes.get(id);
      if (!type) {
        type = await this.odbType(id);
        if (!type) this.die(`object not found: ${id}`);
        this.objectTypes.set(id, type as string);
      }
      this.marks.set(mark, { id, type: type as string });
    }
    this.importMarksDone = true;
  }

  private async dumpMarks(): Promise<void> {
    const file = this.exportMarksFile;
    if (!file || (this.importMarksFile && !this.importMarksDone)) return;
    const sorted = [...this.marks.entries()].sort(([a], [b]) => a - b);
    const text = sorted.map(([mark, o]) => `:${mark} ${o.id}\n`).join("");
    await this.marksFilesOrDie().write(file.path, latin1Bytes(text), {
      relative: file.relative,
    });
  }

  private findMark(mark: number): MarkedObject {
    const found = this.marks.get(mark);
    if (!found) this.die(`mark :${mark} not declared`, `mark :${mark} not declared`);
    return found as MarkedObject;
  }

  private insertMark(mark: number, object: MarkedObject): void {
    if (mark) this.marks.set(mark, object);
  }

  /** parse_mark_ref: `:<n>` at the start of `text`, and what follows it. */
  private parseMarkRef(text: string): { mark: number; rest: string } {
    const m = /^:(\d*)/.exec(text) as RegExpExecArray;
    if (!m[1]) this.die(`no value after ':' in mark: ${this.line}`);
    return { mark: Number(m[1]), rest: text.slice(m[0].length) };
  }

  private parseMarkRefEol(text: string): number {
    const { mark, rest } = this.parseMarkRef(text);
    if (rest !== "") this.die(`garbage after mark: ${this.line}`);
    return mark;
  }

  private parseMarkRefSpace(text: string): { mark: number; rest: string } {
    const { mark, rest } = this.parseMarkRef(text);
    if (!rest.startsWith(" ")) this.die(`missing space after mark: ${this.line}`);
    return { mark, rest: rest.slice(1) };
  }

  // ---------------------------------------------------------------- objects

  private async odbType(id: ObjectId): Promise<string | undefined> {
    const header = await this.objects.header?.(id).catch(() => undefined);
    if (header) return header.type;
    return (await readObjectBytes(this.objects, id))?.type;
  }

  private async typeOf(id: ObjectId): Promise<string | undefined> {
    return this.objectTypes.get(id) ?? (await this.odbType(id));
  }

  private async storeObject(type: string, data: string, mark: number): Promise<ObjectId> {
    const bytes = latin1Bytes(data);
    const id = await this.objects.put(type as "blob", bytes.length, [bytes]);
    this.objectTypes.set(id, type);
    this.insertMark(mark, { id, type });
    return id;
  }

  private async parseNewBlob(): Promise<void> {
    await this.readNextCommand();
    await this.parseMark();
    await this.parseOriginalIdentifier();
    const data = this.parseData();
    await this.storeObject("blob", data, this.nextMark);
  }

  /** The tree of a commit (peeling tags), undefined when it is not one. */
  private async commitTree(id: ObjectId): Promise<ObjectId | undefined> {
    let current = id;
    for (let depth = 0; depth < 64; depth++) {
      const raw = await readObjectBytes(this.objects, current);
      if (!raw) return undefined;
      const text = latin1(raw.bytes);
      if (raw.type === "commit") {
        const m = /^tree ([0-9a-f]+)\n/.exec(text);
        return m ? (m[1] as string) : undefined;
      }
      if (raw.type !== "tag") return undefined;
      current = text.slice(7, text.indexOf("\n"));
    }
    return undefined;
  }

  private async peelToCommit(id: ObjectId): Promise<ObjectId | undefined> {
    let current = id;
    for (let depth = 0; depth < 64; depth++) {
      const raw = await readObjectBytes(this.objects, current);
      if (!raw) return undefined;
      if (raw.type === "commit") return current;
      if (raw.type !== "tag") return undefined;
      const text = latin1(raw.bytes);
      current = text.slice(7, text.indexOf("\n"));
    }
    return undefined;
  }

  /** repo_get_oid, as fast-import resolves `from` and `merge` names. */
  private async getOid(name: string): Promise<ObjectId | undefined> {
    const hex = this.objectFormat.hexLength;
    if (name.length === hex && /^[0-9a-fA-F]+$/.test(name)) return name.toLowerCase();
    return this.revisionResolver()
      .resolve(decodeGitPath(latin1Bytes(name)))
      .catch(() => undefined);
  }

  // ---------------------------------------------------------------- idents

  private parseIdent(text: string): string {
    // ensure there is a space delimiter even if there is no name
    const buf = text.startsWith("<") ? ` ${text}` : text;
    const lt = buf.search(/[<>]/);
    if (lt < 0 || buf[lt] !== "<") this.die(`missing < in ident string: ${buf}`);
    if (lt !== 0 && buf[lt - 1] !== " ") {
      this.die(`missing space before < in ident string: ${buf}`);
    }
    const rest = buf.slice(lt + 1);
    const gt = rest.search(/[<>]/);
    if (gt < 0 || rest[gt] !== ">") this.die(`missing > in ident string: ${buf}`);
    const after = lt + 1 + gt + 1;
    if (buf[after] !== " ") this.die(`missing space after > in ident string: ${buf}`);
    const head = buf.slice(0, after + 1);
    const when = buf.slice(after + 1);
    switch (this.dateFormat) {
      case "raw":
      case "raw-permissive": {
        if (!validRawDate(when, this.dateFormat === "raw")) {
          this.die(`invalid raw date "${when}" in ident: ${buf}`);
        }
        return head + when;
      }
      case "rfc2822": {
        const parsed = parseGitDate(when);
        if (!parsed) this.die(`invalid rfc2822 date "${when}" in ident: ${buf}`);
        const { timestamp, tzOffset } = parsed as { timestamp: number; tzOffset: string };
        return `${head}${timestamp} ${tzOffset}`;
      }
      default: {
        if (when !== "now") this.die(`date in ident must be 'now': ${buf}`);
        const now = Math.floor(Date.now() / 1000);
        return `${head}${now} ${localTimezoneOffset(now)}`;
      }
    }
  }

  // ---------------------------------------------------------------- branches and trees

  private lookupBranch(name: string): Branch | undefined {
    return this.branches.get(name);
  }

  private newBranch(name: string): Branch {
    if (this.branches.has(name)) this.die(`invalid attempt to create duplicate branch: ${name}`);
    if (!isValidRefName(decodeGitPath(latin1Bytes(name)), { allowOneLevel: true })) {
      this.die(
        `branch name doesn't conform to Git standards: ${name}`,
        `Branch name doesn't conform to GIT standards: ${name}`,
      );
    }
    const b: Branch = {
      name,
      oid: undefined,
      root: { mode: S_IFDIR, id: undefined, entries: new Map() },
      delete: false,
    };
    const hc = hcStr(decodeGitPath(latin1Bytes(name))) % BRANCH_TABLE_SIZE;
    const bucket = this.branchTable[hc] ?? [];
    bucket.unshift(b);
    this.branchTable[hc] = bucket;
    this.branches.set(name, b);
    return b;
  }

  private async loadTree(node: Node): Promise<Map<string, Node>> {
    if (node.entries) return node.entries;
    const entries = new Map<string, Node>();
    if (node.id !== undefined) {
      const raw = await readObjectBytes(this.objects, node.id);
      if (!raw) this.die(`can't load tree ${node.id}`);
      if (raw?.type !== "tree") this.die(`can't load tree ${node.id}`);
      parseRawTree(raw?.bytes as Uint8Array, this.objectFormat.rawLength, entries);
    }
    node.entries = entries;
    return entries;
  }

  /** tree_content_set */
  private async treeSet(
    root: Node,
    path: string,
    id: ObjectId | undefined,
    mode: number,
    subtree?: Map<string, Node>,
  ): Promise<boolean> {
    const slash = path.indexOf("/");
    const name = slash < 0 ? path : path.slice(0, slash);
    if (!name) this.die("empty path component found in input");
    if (!isDir(root.mode)) this.die("non-directories cannot have subtrees");
    const entries = await this.loadTree(root);
    let e = entries.get(name);
    if (e) {
      if (slash < 0) {
        if (!isDir(mode) && e.mode === mode && e.id === id) return false;
        e.mode = mode;
        e.id = id;
        if (subtree) e.entries = subtree;
        else delete e.entries;
        root.id = undefined;
        return true;
      }
      if (!isDir(e.mode)) {
        e.entries = new Map();
        e.mode = S_IFDIR;
      }
      if (await this.treeSet(e, path.slice(slash + 1), id, mode, subtree)) {
        root.id = undefined;
        return true;
      }
      return false;
    }
    e = { mode: S_IFDIR, id: undefined, entries: new Map() };
    entries.set(name, e);
    if (slash < 0) {
      e.mode = mode;
      e.id = id;
      if (subtree) e.entries = subtree;
      else delete e.entries;
    } else {
      await this.treeSet(e, path.slice(slash + 1), id, mode, subtree);
    }
    root.id = undefined;
    return true;
  }

  /** tree_content_remove: the removed entry, or true when only something changed */
  private async treeRemove(
    root: Node,
    path: string,
    allowRoot: boolean,
  ): Promise<Node | true | undefined> {
    const entries = await this.loadTree(root);
    if (!path && allowRoot) {
      const removed: Node = { mode: root.mode, id: root.id, entries: new Map(entries) };
      root.entries = new Map();
      root.id = undefined;
      return removed;
    }
    const slash = path.indexOf("/");
    const name = slash < 0 ? path : path.slice(0, slash);
    const e = entries.get(name);
    if (!e || (name === "" && slash >= 0)) return undefined;
    if (slash >= 0 && !isDir(e.mode)) return true;
    if (slash < 0 || !isDir(e.mode)) {
      entries.delete(name);
      root.id = undefined;
      return e;
    }
    const removed = await this.treeRemove(e, path.slice(slash + 1), false);
    if (removed === undefined) return undefined;
    if ((e.entries?.size ?? 0) > 0) {
      root.id = undefined;
      return removed;
    }
    entries.delete(name);
    root.id = undefined;
    return removed;
  }

  /** tree_content_get */
  private async treeGet(root: Node, path: string, allowRoot: boolean): Promise<Node | undefined> {
    if (!path && allowRoot) return cloneNode(root);
    const entries = await this.loadTree(root);
    const slash = path.indexOf("/");
    const name = slash < 0 ? path : path.slice(0, slash);
    const e = entries.get(name);
    if (!e) return undefined;
    if (slash < 0) return cloneNode(e);
    if (!isDir(e.mode)) return undefined;
    return this.treeGet(e, path.slice(slash + 1), false);
  }

  /** store_tree: writes every dirty tree, giving each its id. */
  private async storeTree(node: Node): Promise<ObjectId> {
    if (node.id !== undefined) return node.id;
    const entries = await this.loadTree(node);
    for (const e of entries.values())
      if (isDir(e.mode) && e.id === undefined) await this.storeTree(e);
    const sorted = [...entries.entries()].sort(([a, x], [b, y]) =>
      compareBinary(isDir(x.mode) ? `${a}/` : a, isDir(y.mode) ? `${b}/` : b),
    );
    let data = "";
    for (const [name, e] of sorted) {
      data += `${e.mode.toString(8)} ${name}\0${hexToBinary(e.id as string)}`;
    }
    node.id = await this.storeObject("tree", data, 0);
    return node.id;
  }

  // ---------------------------------------------------------------- paths

  /** parse_path: a quoted or plain path, and what follows it */
  private parsePath(text: string, last: boolean, field: string): { path: string; rest: string } {
    if (text.startsWith('"')) {
      const unq = cUnquote(text, 0);
      if (!unq) this.die(`invalid ${field}: ${this.line}`, `Invalid ${field}: ${this.line}`);
      const { name, end } = unq as { name: string; end: number };
      if (name.includes("\0")) this.die(`NUL in ${field}: ${this.line}`);
      return { path: name, rest: text.slice(end) };
    }
    if (last) return { path: text, rest: "" };
    const space = text.indexOf(" ");
    return space < 0
      ? { path: text, rest: "" }
      : { path: text.slice(0, space), rest: text.slice(space) };
  }

  private parsePathEol(text: string, field: string): string {
    const { path, rest } = this.parsePath(text, true, field);
    if (rest !== "") {
      this.die(`garbage after ${field}: ${this.line}`, `Garbage after ${field} in: ${this.line}`);
    }
    return path;
  }

  private verifyPath(path: string, mode: number): void {
    // git 2.43 checked no path (t9300's "invalid file path" cases are 2.44+)
    if (this.compatibility === "2.43") return;
    const ok = isValidWorktreePath(decodeGitPath(latin1Bytes(path)), mode, {
      protectHFS: false,
      protectNTFS: true,
    });
    if (!ok) this.die(`invalid path '${path}'`, `Invalid path: ${path}`);
  }

  // ---------------------------------------------------------------- commits

  private async fileChangeM(text: string, b: Branch): Promise<void> {
    const m = /^([0-7]+) /.exec(text);
    if (!m || !/^[0-7]/.test(text)) this.die(`corrupt mode: ${this.line}`);
    let mode = Number.parseInt((m as RegExpExecArray)[1] as string, 8) & 0xffff;
    let p = text.slice((m as RegExpExecArray)[0].length);
    switch (mode) {
      case 0o644:
      case 0o755:
        mode |= S_IFREG;
        break;
      case S_IFREG | 0o644:
      case S_IFREG | 0o755:
      case S_IFLNK:
      case S_IFDIR:
      case S_IFGITLINK:
        break;
      default:
        this.die(`corrupt mode: ${this.line}`);
    }
    let id: ObjectId | undefined;
    let knownType: string | undefined;
    let inline = false;
    if (p.startsWith(":")) {
      const { mark, rest } = this.parseMarkRefSpace(p);
      const oe = this.findMark(mark);
      id = oe.id;
      knownType = oe.type;
      p = rest;
    } else if (p.startsWith("inline ")) {
      inline = true;
      p = p.slice(7);
    } else {
      const hex = this.objectFormat.hexLength;
      const candidate = p.slice(0, hex);
      if (!/^[0-9a-fA-F]+$/.test(candidate) || candidate.length !== hex) {
        this.die(`invalid dataref: ${this.line}`);
      }
      id = candidate.toLowerCase();
      knownType = this.objectTypes.get(id);
      if (p[hex] !== " ") this.die(`missing space after SHA1: ${this.line}`);
      p = p.slice(hex + 1);
    }
    const path = this.parsePathEol(p, "path");

    // git does not track empty, non-toplevel directories
    if (isDir(mode) && id === this.objectFormat.emptyTreeId && path) {
      await this.treeRemove(b.root, path, false);
      return;
    }
    if (mode === S_IFGITLINK) {
      if (inline) this.die(`Git links cannot be specified 'inline': ${this.line}`);
      if (knownType !== undefined && knownType !== "commit") {
        this.die(`not a commit (actually a ${knownType}): ${this.line}`);
      }
    } else if (inline) {
      if (isDir(mode)) this.die(`directories cannot be specified 'inline': ${this.line}`);
      while (await this.readNextCommand()) {
        if (this.line.startsWith("cat-blob ")) await this.parseCatBlob(this.line.slice(9));
        else {
          const data = this.parseData();
          id = await this.storeObject("blob", data, 0);
          break;
        }
      }
    } else {
      const expected = isDir(mode) ? "tree" : "blob";
      const type = knownType ?? (await this.odbType(id as string));
      if (type === undefined) {
        this.die(
          `${expected} not found: ${this.line}`,
          `${capitalized243(expected)} not found: ${this.line}`,
        );
      }
      if (type !== expected) this.die(`not a ${expected} (actually a ${type}): ${this.line}`);
    }
    if (!path) {
      if (!isDir(mode)) this.die("root cannot be a non-directory");
      b.root = { mode, id };
      return;
    }
    this.verifyPath(path, mode);
    await this.treeSet(b.root, path, id, mode);
  }

  private async fileChangeCR(text: string, b: Branch, rename: boolean): Promise<void> {
    const src = this.parsePath(text, false, "source");
    if (!src.rest.startsWith(" ")) {
      this.die(
        `missing space after source: ${this.line}`,
        `Missing space after source: ${this.line}`,
      );
    }
    const dest = this.parsePathEol(src.rest.slice(1), "dest");
    const leaf = rename
      ? await this.treeRemove(b.root, src.path, true)
      : await this.treeGet(b.root, src.path, true);
    if (leaf === undefined || leaf === true || !leaf.mode) {
      this.die(`path ${src.path} not in branch`);
    }
    const node = leaf as Node;
    if (!dest) {
      if (!isDir(node.mode)) this.die("root cannot be a non-directory");
      b.root = { mode: node.mode, id: node.id, ...(node.entries ? { entries: node.entries } : {}) };
      return;
    }
    this.verifyPath(dest, node.mode);
    await this.treeSet(b.root, dest, node.id, node.mode, node.entries);
  }

  private async parseObjectish(b: Branch, objectish: string): Promise<void> {
    const s = this.lookupBranch(objectish);
    if (s === b) this.die(`can't create a branch from itself: ${b.name}`);
    if (s) {
      b.oid = s.oid;
      b.root = { mode: S_IFDIR, id: s.oid ? await this.storeTree(s.root) : undefined };
      if (!s.oid) b.root.entries = new Map();
    } else if (objectish.startsWith(":")) {
      const mark = this.parseMarkRefEol(objectish);
      const oe = this.findMark(mark);
      if (oe.type !== "commit") this.die(`mark :${mark} not a commit`);
      if (b.oid !== oe.id) {
        b.oid = oe.id;
        await this.setRootFromCommit(b);
      }
    } else {
      const id = await this.getOid(objectish);
      if (id === undefined) {
        this.die(`invalid ref name or SHA1 expression: ${objectish}`);
      }
      b.oid = /^0+$/.test(id as string) ? undefined : id;
      if (b.oid === undefined) {
        b.root = { mode: S_IFDIR, id: undefined, entries: new Map() };
        b.delete = true;
      } else {
        const peeled = await this.peelToCommit(b.oid);
        if (!peeled) this.die(`not a valid commit: ${b.oid}`);
        b.oid = peeled;
        await this.setRootFromCommit(b);
      }
    }
    await this.readNextCommand();
  }

  private async setRootFromCommit(b: Branch): Promise<void> {
    const tree = await this.commitTree(b.oid as string);
    if (!tree) this.die(`not a valid commit: ${b.oid}`);
    b.root = { mode: S_IFDIR, id: tree };
  }

  private async parseMerge(): Promise<ObjectId[]> {
    const list: ObjectId[] = [];
    while (this.line.startsWith("merge ")) {
      const from = this.line.slice(6);
      const s = this.lookupBranch(from);
      let id: ObjectId;
      if (s) id = s.oid ?? this.objectFormat.nullId;
      else if (from.startsWith(":")) {
        const mark = this.parseMarkRefEol(from);
        const oe = this.findMark(mark);
        if (oe.type !== "commit") this.die(`mark :${mark} not a commit`);
        id = oe.id;
      } else {
        const named = await this.getOid(from);
        if (named === undefined) this.die(`invalid ref name or SHA1 expression: ${from}`);
        const peeled = await this.peelToCommit(named as string);
        if (!peeled) this.die(`not a valid commit: ${from}`);
        id = peeled as string;
      }
      list.push(id);
      await this.readNextCommand();
    }
    return list;
  }

  private async parseSignature(v: string): Promise<{ hash: string; data: string }> {
    const space = v.indexOf(" ");
    if (space < 0) {
      this.die(
        `expected gpgsig format: 'gpgsig <hash-algo> <signature-format>', got 'gpgsig ${v}'`,
      );
    }
    const hash = v.slice(0, space);
    const format = v.slice(space + 1);
    if (hash !== "sha1" && hash !== "sha256") {
      this.die(`unknown git hash algorithm in gpgsig: '${hash}'`);
    }
    if (!["openpgp", "x509", "ssh", "unknown"].includes(format)) {
      this.die(`invalid signature format in gpgsig: '${format}'`);
    }
    if (format === "unknown") this.warn("warning: 'unknown' signature format in gpgsig");
    await this.readNextCommand();
    return { hash, data: this.parseData() };
  }

  private async parseNewCommit(arg: string): Promise<void> {
    const b = this.lookupBranch(arg) ?? this.newBranch(arg);
    await this.readNextCommand();
    await this.parseMark();
    const mark = this.nextMark;
    await this.parseOriginalIdentifier();
    let author: string | undefined;
    let committer: string | undefined;
    if (this.line.startsWith("author ")) {
      author = this.parseIdent(this.line.slice(7));
      await this.readNextCommand();
    }
    if (this.line.startsWith("committer ")) {
      committer = this.parseIdent(this.line.slice(10));
      await this.readNextCommand();
    }
    if (committer === undefined) this.die("expected committer but didn't get one");

    const signatures: { sha1?: string; sha256?: string } = {};
    while (this.compatibility !== "2.43" && this.line.startsWith("gpgsig ")) {
      const v = this.line.slice(7);
      switch (this.signedCommits) {
        case "abort":
          this.die("encountered signed commit; use --signed-commits=<mode> to handle it");
          break;
        case "warn-strip":
        case "strip":
          if (this.signedCommits === "warn-strip") {
            this.warn("warning: stripping a commit signature");
          }
          await this.readNextCommand();
          this.parseData();
          break;
        default: {
          if (this.signedCommits === "warn-verbatim" || this.signedCommits === "warn") {
            this.warn("warning: importing a commit signature verbatim");
          }
          const sig = await this.parseSignature(v);
          const key = sig.hash === "sha1" ? "sha1" : "sha256";
          if (signatures[key] !== undefined) {
            this.warn(
              `warning: multiple ${key === "sha1" ? "SHA-1" : "SHA-256"} signatures found, ignoring additional signature`,
            );
          } else signatures[key] = sig.data;
        }
      }
      await this.readNextCommand();
    }
    let encoding: string | undefined;
    if (this.line.startsWith("encoding ")) {
      encoding = this.line.slice(9);
      await this.readNextCommand();
    }
    const msg = this.parseData();
    await this.readNextCommand();
    if (this.line.startsWith("from ")) await this.parseObjectish(b, this.line.slice(5));
    const merges = await this.parseMerge();

    while (this.line.length > 0) {
      const cmd = this.line;
      if (cmd.startsWith("M ")) await this.fileChangeM(cmd.slice(2), b);
      else if (cmd.startsWith("D ")) {
        await this.treeRemove(b.root, this.parsePathEol(cmd.slice(2), "path"), true);
      } else if (cmd.startsWith("R ")) await this.fileChangeCR(cmd.slice(2), b, true);
      else if (cmd.startsWith("C ")) await this.fileChangeCR(cmd.slice(2), b, false);
      else if (cmd.startsWith("N ")) {
        throw new PlumbingError("fatal: fast-import notes (N) are not supported");
      } else if (cmd === "deleteall") {
        b.root = { mode: S_IFDIR, id: undefined, entries: new Map() };
      } else if (cmd.startsWith("ls ")) await this.parseLs(cmd.slice(3), b);
      else if (cmd.startsWith("cat-blob ")) await this.parseCatBlob(cmd.slice(9));
      else {
        this.unread = true;
        break;
      }
      if (!(await this.readNextCommand())) break;
    }

    const tree = await this.storeTree(b.root);
    let data = `tree ${tree}\n`;
    if (b.oid !== undefined) data += `parent ${b.oid}\n`;
    for (const m of merges) data += `parent ${m}\n`;
    data += `author ${author ?? committer}\ncommitter ${committer}\n`;
    if (encoding !== undefined) data += `encoding ${encoding}\n`;
    for (const [header, sig] of [
      ["gpgsig", signatures.sha1],
      ["gpgsig-sha256", signatures.sha256],
    ] as const) {
      if (sig === undefined) continue;
      data += `${header} ${sig.split("\n").join("\n ")}\n`;
    }
    data += `\n${msg}`;
    b.oid = await this.storeObject("commit", data, mark);
    b.delete = false;
  }

  // ---------------------------------------------------------------- tags and resets

  private async parseNewTag(arg: string): Promise<void> {
    const entry = { name: arg, id: "" };
    this.tags.push(entry);
    await this.readNextCommand();
    await this.parseMark();
    const mark = this.nextMark;
    if (!this.line.startsWith("from ")) {
      this.die(
        `expected 'from' command, got '${this.line}'`,
        `Expected from command, got ${this.line}`,
      );
    }
    const from = this.line.slice(5);
    let id: ObjectId;
    let type: string;
    const s = this.lookupBranch(from);
    if (s) {
      if (s.oid === undefined) this.die("can't tag an empty branch.");
      id = s.oid as string;
      type = "commit";
    } else if (from.startsWith(":")) {
      const oe = this.findMark(this.parseMarkRefEol(from));
      id = oe.id;
      type = oe.type;
    } else {
      const named = await this.getOid(from);
      if (named === undefined) this.die(`invalid ref name or SHA1 expression: ${from}`);
      id = named as string;
      const t = await this.typeOf(id);
      if (!t) this.die(`not a valid object: ${from}`);
      type = t as string;
    }
    await this.readNextCommand();
    await this.parseOriginalIdentifier();
    let tagger: string | undefined;
    if (this.line.startsWith("tagger ")) {
      tagger = this.parseIdent(this.line.slice(7));
      await this.readNextCommand();
    }
    let msg = this.parseData();
    let data = `object ${id}\ntype ${type}\ntag ${arg}\n`;
    if (tagger !== undefined) data += `tagger ${tagger}\n`;
    if (this.compatibility !== "2.43") {
      const sigAt = signatureStartOf(msg, "2.56");
      if (sigAt < msg.length) {
        switch (this.signedTags) {
          case "warn-verbatim":
          case "warn":
            this.warn(`warning: importing a tag signature verbatim for tag '${arg}'`);
            break;
          case "verbatim":
          case "ignore":
            break;
          case "warn-strip":
            this.warn(`warning: stripping a tag signature for tag '${arg}'`);
            msg = msg.slice(0, sigAt);
            break;
          case "strip":
            msg = msg.slice(0, sigAt);
            break;
          default:
            this.die("encountered signed tag; use --signed-tags=<mode> to handle it");
        }
      }
    }
    data += `\n${msg}`;
    entry.id = await this.storeObject("tag", data, mark);
  }

  private async parseResetBranch(arg: string): Promise<void> {
    let b = this.lookupBranch(arg);
    if (b) {
      b.oid = undefined;
      b.root = { mode: S_IFDIR, id: undefined, entries: new Map() };
    } else b = this.newBranch(arg);
    await this.readNextCommand();
    if (this.line.startsWith("from ")) await this.parseObjectish(b, this.line.slice(5));
    if (b.delete && b.name.startsWith("refs/tags/")) {
      const tagName = b.name.slice(10);
      const at = this.tags.findIndex((t) => t.name === tagName);
      if (at >= 0) this.tags.splice(at, 1);
    }
    if (this.line.length > 0) this.unread = true;
  }

  // ---------------------------------------------------------------- queries

  private async catBlobWrite(text: string | Uint8Array): Promise<void> {
    await this.write(typeof text === "string" ? latin1Bytes(text) : text);
  }

  private async parseGetMark(p: string): Promise<void> {
    if (!p.startsWith(":")) this.die(`not a mark: ${p}`);
    const oe = this.findMark(this.parseMarkRefEol(p));
    await this.catBlobWrite(`${oe.id}\n`);
  }

  private async parseCatBlob(p: string): Promise<void> {
    let id: ObjectId;
    if (p.startsWith(":")) id = this.findMark(this.parseMarkRefEol(p)).id;
    else {
      const hex = this.objectFormat.hexLength;
      const candidate = p.slice(0, hex);
      if (candidate.length !== hex || !/^[0-9a-fA-F]+$/.test(candidate)) {
        this.die(`invalid dataref: ${this.line}`);
      }
      if (p.length > hex) this.die(`garbage after SHA1: ${this.line}`);
      id = candidate.toLowerCase();
    }
    const raw = await readObjectBytes(this.objects, id);
    if (!raw) {
      await this.catBlobWrite(`${id} missing\n`);
      return;
    }
    if (raw.type !== "blob") this.die(`object ${id} is a ${raw.type} but a blob was expected.`);
    await this.catBlobWrite(`${id} blob ${raw.bytes.length}\n`);
    await this.catBlobWrite(raw.bytes);
    await this.catBlobWrite("\n");
  }

  private async parseLs(p: string, b: Branch | undefined): Promise<void> {
    let root: Node;
    let rest = p;
    if (p.startsWith('"')) {
      if (!b) this.die(`not in a commit: ${this.line}`);
      root = (b as Branch).root;
    } else {
      let id: ObjectId;
      if (p.startsWith(":")) {
        const { mark, rest: r } = this.parseMarkRefSpace(p);
        id = this.findMark(mark).id;
        rest = r;
      } else {
        const hex = this.objectFormat.hexLength;
        const candidate = p.slice(0, hex);
        if (candidate.length !== hex || !/^[0-9a-fA-F]+$/.test(candidate)) {
          this.die(`invalid dataref: ${this.line}`);
        }
        id = candidate.toLowerCase();
        if (p[hex] !== " ") this.die(`missing space after tree-ish: ${this.line}`);
        rest = p.slice(hex + 1);
      }
      // dereference: commits to their trees, tags to what they tag
      for (let depth = 0; depth < 64; depth++) {
        const raw = await readObjectBytes(this.objects, id);
        if (!raw) this.die(`can't load object ${id}`);
        const t = (raw as { type: string }).type;
        if (t === "tree") break;
        const text = latin1((raw as { bytes: Uint8Array }).bytes);
        if (t === "commit") id = text.slice(5, text.indexOf("\n"));
        else if (t === "tag") id = text.slice(7, text.indexOf("\n"));
        else this.die(`not a tree-ish: ${this.line}`);
      }
      root = { mode: S_IFDIR, id };
    }
    const path = this.parsePathEol(rest, "path");
    const leaf = await this.treeGet(root, path, true);
    const quoted = quotePathBinary(path);
    if (!leaf?.mode) {
      await this.catBlobWrite(`missing ${quoted}\n`);
      return;
    }
    if (isDir(leaf.mode)) await this.storeTree(leaf);
    const type = leaf.mode === S_IFGITLINK ? "commit" : isDir(leaf.mode) ? "tree" : "blob";
    await this.catBlobWrite(
      `${leaf.mode.toString(8).padStart(6, "0")} ${type} ${leaf.id}\t${quoted}\n`,
    );
  }

  private async parseAlias(): Promise<void> {
    this.skipOptionalLf();
    await this.readNextCommand();
    await this.parseMark();
    const mark = this.nextMark;
    if (!mark) this.die(`expected 'mark' command, got ${this.line}`);
    if (!this.line.startsWith("to ")) this.die(`expected 'to' command, got ${this.line}`);
    const b: Branch = {
      name: "",
      oid: undefined,
      root: { mode: S_IFDIR, id: undefined },
      delete: false,
    };
    await this.parseObjectish(b, this.line.slice(3));
    if (b.oid) this.insertMark(mark, { id: b.oid, type: "commit" });
  }

  // ---------------------------------------------------------------- ref updates

  private async checkpoint(): Promise<void> {
    await this.dumpBranches();
    await this.dumpTags();
    await this.dumpMarks();
  }

  private async dumpBranches(): Promise<void> {
    for (const bucket of this.branchTable) {
      for (const b of bucket ?? []) if (await this.updateBranch(b)) this.failure = true;
    }
  }

  private refName(name: string): string {
    return decodeGitPath(latin1Bytes(name));
  }

  /** update_branch: true on a failure */
  private async updateBranch(b: Branch): Promise<boolean> {
    const name = this.refName(b.name);
    if (name.startsWith("refs/replace/") && name.slice(13) === b.oid) {
      await this.refsStore.delete(name).catch(() => false);
      return false;
    }
    if (b.oid === undefined) {
      if (b.delete) await this.refsStore.delete(name).catch(() => false);
      return false;
    }
    const old = (await this.refsStore.resolve(name).catch(() => undefined))?.objectId;
    if (!this.force && old !== undefined) {
      const oldCommit = await this.peelToCommit(old);
      const newCommit = await this.peelToCommit(b.oid);
      if (!oldCommit || !newCommit) {
        const branch = this.compatibility === "2.43" ? "Branch" : "branch";
        this.warn(`error: ${branch} ${b.name} is missing commits.`);
        return true;
      }
      if (!(await this.commits.isAncestor(oldCommit, newCommit))) {
        const not = this.compatibility === "2.43" ? "Not" : "not";
        this.warn(`warning: ${not} updating ${b.name} (new tip ${b.oid} does not contain ${old})`);
        return true;
      }
    }
    await this.refsStore.set(name, b.oid, this.reflogLine("fast-import"));
    return false;
  }

  private async dumpTags(): Promise<void> {
    for (const t of this.tags) {
      await this.refsStore.set(
        `refs/tags/${this.refName(t.name)}`,
        t.id,
        this.reflogLine("fast-import"),
      );
    }
  }
}

function isDir(mode: number): boolean {
  return (mode & S_IFMT) === S_IFDIR;
}

function cloneNode(node: Node): Node {
  const copy: Node = { mode: node.mode, id: node.id };
  if (node.entries && node.id === undefined) {
    copy.entries = new Map([...node.entries].map(([k, v]) => [k, cloneNode(v)]));
  }
  return copy;
}

/** git 2.43's wording: most of fast-import's messages started with a capital letter. */
function capitalized243(message: string): string {
  if (
    /^(mark :|feature '|option '|corrupt mark line|object not found|cannot read|stream ends early|unknown --date-format|EOF in)/.test(
      message,
    )
  ) {
    return message;
  }
  return message.charAt(0).toUpperCase() + message.slice(1);
}

/** A JavaScript string's UTF-8 bytes as a binary string. */
function utf8Binary(text: string): string {
  return latin1(new TextEncoder().encode(text));
}

function compareBinary(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function hexToBinary(hex: string): string {
  let out = "";
  for (let i = 0; i < hex.length; i += 2) {
    out += String.fromCharCode(Number.parseInt(hex.slice(i, i + 2), 16));
  }
  return out;
}

function parseRawTree(bytes: Uint8Array, rawLength: number, into: Map<string, Node>): void {
  let at = 0;
  while (at < bytes.length) {
    const space = bytes.indexOf(32, at);
    const nul = bytes.indexOf(0, space);
    if (space < 0 || nul < 0) break;
    const mode = Number.parseInt(latin1(bytes.subarray(at, space)), 8);
    const name = latin1(bytes.subarray(space + 1, nul));
    let id = "";
    for (const b of bytes.subarray(nul + 1, nul + 1 + rawLength)) {
      id += b.toString(16).padStart(2, "0");
    }
    into.set(name, { mode: canonMode(mode), id });
    at = nul + 1 + rawLength;
  }
}

/** canon_mode */
function canonMode(mode: number): number {
  if ((mode & S_IFMT) === S_IFREG) return S_IFREG | (mode & 0o111 ? 0o755 : 0o644);
  if ((mode & S_IFMT) === S_IFLNK) return S_IFLNK;
  if ((mode & S_IFMT) === S_IFDIR) return S_IFDIR;
  return S_IFGITLINK;
}

/** validate_raw_date */
function validRawDate(text: string, strict: boolean): boolean {
  const m = /^[ \t\n\v\f\r]*[+-]?\d+ ([+-])(\d+)$/.exec(text);
  if (!m) return false;
  return !(strict && Number(m[2]) > 1400);
}

function parseDateFormat(format: string, die: (message: string) => never): FastImportDateFormat {
  if (format === "raw" || format === "raw-permissive" || format === "rfc2822" || format === "now") {
    return format;
  }
  return die(`unknown --date-format argument ${format}`);
}

/** quote_c_style of a binary-string path, quoted only when it must be. */
function quotePathBinary(path: string): string {
  let needs = false;
  let body = "";
  for (let i = 0; i < path.length; i++) {
    const c = path.charCodeAt(i);
    const esc: Record<number, string> = {
      7: "a",
      8: "b",
      9: "t",
      10: "n",
      11: "v",
      12: "f",
      13: "r",
      34: '"',
      92: "\\",
    };
    if (esc[c] !== undefined) {
      needs = true;
      body += `\\${esc[c]}`;
    } else if (c < 0x20 || c >= 0x7f) {
      needs = true;
      body += `\\${(c >> 6) & 3}${(c >> 3) & 7}${c & 7}`;
    } else body += path[i];
  }
  return needs ? `"${body}"` : path;
}
