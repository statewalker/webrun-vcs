/**
 * `git fast-export` (builtin/fast-export.c): the history the revision arguments name as a
 * fast-import stream, written to stdout as git writes it.
 *
 * @example
 * ```typescript
 * // git fast-export --all > stream
 * const { stdout, exitCode } = await git.fastExport().addArgument("--all").callOutput();
 * // git fast-export --signed-tags=strip --export-marks=marks main~2..main
 * await git
 *   .fastExport()
 *   .setSignedTags("strip")
 *   .setExportMarks("marks")
 *   .setMarksFiles(files)
 *   .addArgument("main~2..main")
 *   .setStdout((chunk) => out.push(chunk))
 *   .call();
 * ```
 */

import type { ObjectId, TreeEntry } from "@statewalker/vcs-core";
import { encodeGitPath } from "@statewalker/vcs-utils/encoding";
import { quoteCStyleBody } from "../../results/quote-path.js";
import { configValue } from "../merge-config.js";
import { PlumbingCommand, PlumbingError } from "../plumbing-command.js";
import { RevListCommand } from "../rev-list-command.js";
import {
  type FastMarksFiles,
  latin1,
  latin1Bytes,
  readObjectBytes,
  type SignMode,
  signatureFormatOf,
  signatureStartOf,
  writableSink,
} from "./fast-stream-support.js";

/** `--tag-of-filtered-object=<mode>` */
export type TagOfFilteredMode = "abort" | "drop" | "rewrite";
/** `--reencode=<mode>` */
export type ReencodeMode = "yes" | "no" | "abort";

const TREE_MODE = 0o040000;
const GITLINK_MODE = 0o160000;
const NULL_SHA1 = "0".repeat(40);

/** One changed path of a commit's diff against its parent (diff_filepair). */
interface FilePair {
  status: "A" | "D" | "M" | "T";
  path: string;
  mode: number;
  id: ObjectId | undefined;
}

/**
 * git's `decoration` hash table of marks (object.c's `add_decoration`): export-marks lists
 * its commits in the table's slot order, which this keeps.
 */
class MarkDecoration {
  private slots: ({ id: ObjectId; mark: number; commit: boolean } | undefined)[] = [];
  private count = 0;

  insert(id: ObjectId, mark: number, commit: boolean): void {
    if ((this.count + 1) * 3 >= this.slots.length * 2) this.grow();
    this.place({ id, mark, commit });
    this.count++;
  }

  private place(entry: { id: ObjectId; mark: number; commit: boolean }): void {
    const size = this.slots.length;
    let j = hashObj(entry.id) % size;
    for (;;) {
      const at = this.slots[j];
      if (!at) break;
      if (at.id === entry.id) {
        at.mark = entry.mark;
        return;
      }
      if (++j >= size) j = 0;
    }
    this.slots[j] = entry;
  }

  private grow(): void {
    const old = this.slots;
    const size = Math.floor(((old.length + 1000) * 3) / 2);
    this.slots = new Array(size).fill(undefined);
    for (const e of old) if (e) this.place(e);
  }

  /** The commits' marks in slot order (export_marks). */
  commits(): { id: ObjectId; mark: number }[] {
    return this.slots.filter((s) => s?.commit) as { id: ObjectId; mark: number }[];
  }
}

/** object.c's hash_obj: the id's first four bytes as a little-endian unsigned int */
function hashObj(id: ObjectId): number {
  const b = (i: number) => Number.parseInt(id.slice(i * 2, i * 2 + 2), 16);
  return (b(0) | (b(1) << 8) | (b(2) << 16) | (b(3) << 24)) >>> 0;
}

/** A fetch refspec as fast-export applies it (`--refspec`): `src:dst`, with one `*` each. */
interface ExportRefspec {
  src: string;
  dst: string;
}

function parseRefspec(spec: string): ExportRefspec {
  const text = spec.startsWith("+") ? spec.slice(1) : spec;
  const colon = text.indexOf(":");
  return colon < 0
    ? { src: text, dst: "" }
    : { src: text.slice(0, colon), dst: text.slice(colon + 1) };
}

/** refspec.c's query_refspecs for one name: the first refspec mapping it, else undefined. */
function applyRefspecs(specs: readonly ExportRefspec[], name: string): string | undefined {
  for (const { src, dst } of specs) {
    if (!src) continue;
    const star = src.indexOf("*");
    if (star < 0) {
      if (src === name) return dst;
      continue;
    }
    const prefix = src.slice(0, star);
    const suffix = src.slice(star + 1);
    if (
      name.length >= prefix.length + suffix.length &&
      name.startsWith(prefix) &&
      name.endsWith(suffix)
    ) {
      const matched = name.slice(prefix.length, name.length - suffix.length);
      return dst.replace("*", matched);
    }
  }
  return undefined;
}

/**
 * Writes the history the revisions name as a fast-import stream (`git fast-export`).
 *
 * Commits come in git's order (a reversed topological walk, `--topo-order`), each with the
 * blobs its diff against its first parent adds before it (all of its tree for a root commit,
 * a commit whose first parent is not exported, or `--full-tree`), and is named by the ref it
 * was reached from (git's `revision_sources`); refs naming exported commits from another
 * name get `reset` lines, annotated tags `tag` commands, at the end. Marks are numbered as
 * git numbers them, so the stream is git's byte for byte.
 *
 * Not supported: pathspecs, `--anonymize`, rename and copy detection (`-M`, `-C`).
 *
 * Version differences (`setCompatibility`): 2.43 finds a tag's signature only as a PGP
 * signature after a newline and words several messages with a capital letter; 2.5x knows
 * every signature format and `--signed-commits`.
 */
export class FastExportCommand extends PlumbingCommand {
  private readonly revisions: string[] = [];
  private progressEvery = 0;
  private signedTags: SignMode = "abort";
  private signedCommits: SignMode = "strip";
  private tagOfFiltered: TagOfFilteredMode = "abort";
  private reencode: ReencodeMode = "abort";
  private exportMarksPath?: string;
  private importMarksPath?: string;
  private importMarksIfExistsPath?: string;
  private marksFiles?: FastMarksFiles;
  private fakeMissingTagger = false;
  private fullTree = false;
  private useDoneFeature = false;
  private noData = false;
  private readonly refspecs: ExportRefspec[] = [];
  private referenceExcluded = false;
  private showOriginalIds = false;
  private markTags = false;
  private compatibility: "2.43" | "2.56" = "2.56";

  // the run's state
  private lastIdnum = 0;
  private readonly marks = new Map<ObjectId, number>();
  private readonly decoration = new MarkDecoration();
  /** Blobs and commits already written or imported (git's SHOWN) */
  private readonly shown = new Set<ObjectId>();
  private progressCounter = 0;
  private quotePathFully = true;

  private outputStream?: WritableStream<Uint8Array>;

  /** Where the stream goes, as a Web Stream (in place of `setStdout`); not closed here. */
  setOutput(stream: WritableStream<Uint8Array>): this {
    this.checkCallable();
    this.outputStream = stream;
    return this;
  }

  override async call() {
    if (!this.outputStream) return super.call();
    const { sink, release } = writableSink(this.outputStream);
    this.setStdout(sink);
    try {
      return await super.call();
    } finally {
      release();
    }
  }

  /** A revision argument (`main`, `^v1`, `a..b`, `--all`, ...), as `git rev-list` reads it. */
  addArgument(arg: string): this {
    this.checkCallable();
    this.revisions.push(arg);
    return this;
  }

  /** `--progress=<n>`: a `progress <n> objects` line after every n objects. */
  setProgressEvery(every: number): this {
    this.checkCallable();
    this.progressEvery = every;
    return this;
  }

  /** `--signed-tags=<mode>` (default `abort`). */
  setSignedTags(mode: SignMode): this {
    this.checkCallable();
    this.signedTags = mode;
    return this;
  }

  /** `--signed-commits=<mode>` (git 2.50+, default `strip`). */
  setSignedCommits(mode: SignMode): this {
    this.checkCallable();
    this.signedCommits = mode;
    return this;
  }

  /** `--tag-of-filtered-object=<mode>` (default `abort`). */
  setTagOfFilteredObject(mode: TagOfFilteredMode): this {
    this.checkCallable();
    this.tagOfFiltered = mode;
    return this;
  }

  /** `--reencode=<mode>` (default `abort`). */
  setReencode(mode: ReencodeMode): this {
    this.checkCallable();
    this.reencode = mode;
    return this;
  }

  /** Where marks files are read and written ({@link setImportMarks}, {@link setExportMarks}). */
  setMarksFiles(files: FastMarksFiles): this {
    this.checkCallable();
    this.marksFiles = files;
    return this;
  }

  /** `--export-marks=<file>`: written only when the run marked something new. */
  setExportMarks(path: string | undefined): this {
    this.checkCallable();
    this.exportMarksPath = path;
    return this;
  }

  /** `--import-marks=<file>` (or `--import-marks-if-exists=<file>` with `ifExists`). */
  setImportMarks(path: string | undefined, options: { ifExists?: boolean } = {}): this {
    this.checkCallable();
    if (options.ifExists) this.importMarksIfExistsPath = path;
    else this.importMarksPath = path;
    return this;
  }

  /** `--fake-missing-tagger` */
  setFakeMissingTagger(fake: boolean): this {
    this.checkCallable();
    this.fakeMissingTagger = fake;
    return this;
  }

  /** `--full-tree`: every commit lists its whole tree after a `deleteall`. */
  setFullTree(full: boolean): this {
    this.checkCallable();
    this.fullTree = full;
    return this;
  }

  /** `--use-done-feature` */
  setUseDoneFeature(use: boolean): this {
    this.checkCallable();
    this.useDoneFeature = use;
    return this;
  }

  /** `--no-data`: blobs are named by id, never written. */
  setNoData(noData: boolean): this {
    this.checkCallable();
    this.noData = noData;
    return this;
  }

  /** `--refspec=<refspec>`: exported ref names are mapped (an empty source deletes). */
  addRefspec(refspec: string): this {
    this.checkCallable();
    this.refspecs.push(parseRefspec(refspec));
    return this;
  }

  /** `--reference-excluded-parents` */
  setReferenceExcludedParents(reference: boolean): this {
    this.checkCallable();
    this.referenceExcluded = reference;
    return this;
  }

  /** `--show-original-ids` */
  setShowOriginalIds(show: boolean): this {
    this.checkCallable();
    this.showOriginalIds = show;
    return this;
  }

  /** `--mark-tags` */
  setMarkTags(mark: boolean): this {
    this.checkCallable();
    this.markTags = mark;
    return this;
  }

  /** The git version whose output is followed (default 2.56). */
  setCompatibility(version: "2.43" | "2.56"): this {
    this.checkCallable();
    this.compatibility = version;
    return this;
  }

  private die(message: string, message243 = message): never {
    throw new PlumbingError(`fatal: ${this.compatibility === "2.43" ? message243 : message}`);
  }

  private async out(text: string | Uint8Array): Promise<void> {
    await this.write(typeof text === "string" ? latin1Bytes(text) : text);
  }

  private async showProgress(): Promise<void> {
    if (this.progressEvery && !(++this.progressCounter % this.progressEvery)) {
      await this.out(`progress ${this.progressCounter} objects\n`);
    }
  }

  private markNext(id: ObjectId, commit: boolean): number {
    const mark = ++this.lastIdnum;
    this.marks.set(id, mark);
    this.decoration.insert(id, mark, commit);
    return mark;
  }

  private get objects() {
    const objects = this.workingCopy.history?.objects;
    if (!objects) throw new Error("fast-export needs the object store (history.objects)");
    return objects;
  }

  protected async run(): Promise<number> {
    const quote = configValue(this.workingCopy, "core.quotePath");
    this.quotePathFully = quote === undefined ? true : !/^(false|no|off|0)$/i.test(quote);

    if (this.useDoneFeature) await this.out("feature done\n");
    if (this.importMarksPath !== undefined && this.importMarksIfExistsPath !== undefined) {
      this.die("options '--import-marks' and '--import-marks-if-exists' cannot be used together");
    }
    if (this.importMarksPath !== undefined) await this.importMarks(this.importMarksPath, false);
    else if (this.importMarksIfExistsPath !== undefined) {
      await this.importMarks(this.importMarksIfExistsPath, true);
    }
    const lastImportId = this.lastIdnum;

    // the command line's entries (rev_cmdline_info), objects as named
    const parsed = await this.revList().setCommittish(false).resolve();
    const extraRefs = new Map<string, ObjectId>();
    const tagRefs: { name: string; tag: ObjectId }[] = [];
    /** revision_sources set before the walk (get_tags_and_duplicates) */
    const preset = new Map<ObjectId, string>();
    /** The first positive entry's commit per name, for the walk's sources */
    const tipOfName = new Map<string, ObjectId>();
    const resolver = this.revisionResolver();
    for (const e of parsed.entries) {
      if (e.exclude || e.name === undefined) continue;
      let full: string;
      const found = await resolver.dwimRef(e.name).catch(() => []);
      const peeledForName = await this.peelToNonTag(e.id);
      if (peeledForName.type === "commit" && !tipOfName.has(e.name)) {
        tipOfName.set(e.name, peeledForName.id);
      }
      if (found.length !== 1) continue;
      full = (found[0] as { ref: string }).ref;
      if (this.refspecs.length > 0) full = applyRefspecs(this.refspecs, full) ?? full;

      const type = await this.typeOf(e.id);
      let target: { id: ObjectId; type: string } | undefined;
      if (type === "commit") target = { id: e.id, type };
      else if (type === "tag") {
        let id = e.id;
        let t: string | undefined = "tag";
        while (t === "tag") {
          tagRefs.push({ name: full, tag: id });
          id = await this.taggedOf(id);
          t = await this.typeOf(id);
        }
        if (t === undefined) {
          this.die(`tag ${e.name} points nowhere?`, `Tag ${e.name} points nowhere?`);
        }
        target = { id, type: t };
      }
      if (!target) {
        this.warn(
          this.compatibility === "2.43"
            ? `warning: ${e.name}: Unexpected object of type ${type}, skipping.`
            : `warning: ${e.name}: unexpected object of type ${type}, skipping.`,
        );
        continue;
      }
      if (target.type === "blob") {
        await this.exportBlob(target.id);
        continue;
      }
      if (target.type !== "commit") {
        this.warn(
          this.compatibility === "2.43"
            ? `warning: Tag points to object of unexpected type ${target.type}, skipping.`
            : `warning: tag points to object of unexpected type ${target.type}, skipping.`,
        );
        continue;
      }
      if (type !== "tag" && !extraRefs.has(full)) extraRefs.set(full, target.id);
      if (!preset.has(target.id)) preset.set(target.id, full);
    }

    // the walk: git's --topo-order, reversed, with each commit's source
    const walk = this.revList().setOrder("topo").setReverse(true).setSource(true);
    const commits = this.revisions.length > 0 ? await walk.call() : [];
    for await (const commit of commits) {
      if (this.shown.has(commit.id)) continue;
      let name = preset.get(commit.id);
      if (name === undefined) {
        const source = commit.source ?? "";
        const tip = tipOfName.get(source);
        name = (tip !== undefined ? preset.get(tip) : undefined) ?? source;
      }
      extraRefs.delete(name);
      await this.handleCommit(commit.id, name);
    }

    const sortedExtras = [...extraRefs.entries()].sort(([a], [b]) => compareBytes(a, b));
    for (let i = sortedExtras.length - 1; i >= 0; i--) {
      const [name, id] = sortedExtras[i] as [string, ObjectId];
      const mark = this.marks.get(id);
      if (!mark) {
        await this.out(`reset ${bin(name)}\nfrom ${this.referenceExcluded ? id : NULL_SHA1}\n\n`);
        continue;
      }
      await this.out(`reset ${bin(name)}\nfrom :${mark}\n\n`);
      await this.showProgress();
    }
    for (let i = tagRefs.length - 1; i >= 0; i--) {
      const { name, tag } = tagRefs[i] as { name: string; tag: ObjectId };
      await this.handleTag(name, tag);
    }
    for (const { src, dst } of this.refspecs) {
      if (!src) await this.out(`reset ${bin(dst)}\nfrom ${NULL_SHA1}\n\n`);
    }

    if (this.exportMarksPath !== undefined && lastImportId !== this.lastIdnum) {
      const text = this.decoration
        .commits()
        .map(({ id, mark }) => `:${mark} ${id}\n`)
        .join("");
      await this.marksFilesOrDie().write(this.exportMarksPath, latin1Bytes(text));
    }
    if (this.useDoneFeature) await this.out("done\n");
    return 0;
  }

  private revList(): RevListCommand {
    const cmd = new RevListCommand(this.workingCopy);
    for (const r of this.revisions) cmd.addRevision(r);
    return cmd;
  }

  private marksFilesOrDie(): FastMarksFiles {
    if (!this.marksFiles) throw new Error("fast-export marks files need setMarksFiles");
    return this.marksFiles;
  }

  private async typeOf(id: ObjectId): Promise<string | undefined> {
    const header = await this.objects.header?.(id).catch(() => undefined);
    if (header) return header.type;
    return (await readObjectBytes(this.objects, id))?.type;
  }

  private async taggedOf(tag: ObjectId): Promise<ObjectId> {
    const raw = await readObjectBytes(this.objects, tag);
    const text = raw ? latin1(raw.bytes) : "";
    return text.startsWith("object ") ? text.slice(7, text.indexOf("\n")) : "";
  }

  private async peelToNonTag(id: ObjectId): Promise<{ id: ObjectId; type?: string }> {
    let current = id;
    let type = await this.typeOf(current);
    for (let depth = 0; type === "tag" && depth < 64; depth++) {
      current = await this.taggedOf(current);
      type = await this.typeOf(current);
    }
    return { id: current, ...(type ? { type } : {}) };
  }

  private async importMarks(path: string, ifExists: boolean): Promise<void> {
    const bytes = await this.marksFilesOrDie().read(path);
    if (bytes === undefined) {
      if (ifExists) return;
      this.die(`could not open '${path}' for reading: No such file or directory`);
    }
    const text = latin1(bytes as Uint8Array);
    let at = 0;
    while (at < text.length) {
      const nl = text.indexOf("\n", at);
      const line = nl < 0 ? text.slice(at) : text.slice(at, nl);
      at = nl < 0 ? text.length : nl + 1;
      const m = /^:(\d+) ([0-9a-f]{40}|[0-9a-f]{64})$/.exec(line);
      if (!m || nl < 0 || m[1] === "0" || /^:0+ /.test(line)) {
        this.die(`corrupt mark line: ${line}${nl < 0 ? "" : ""}`);
      }
      const mark = Number((m as RegExpExecArray)[1]);
      const id = (m as RegExpExecArray)[2] as ObjectId;
      if (this.lastIdnum < mark) this.lastIdnum = mark;
      const type = await this.typeOf(id);
      if (type === undefined) this.die(`object not found: ${id}`);
      if (type !== "commit") continue;
      if (this.shown.has(id)) this.warn(`error: object ${id} already has a mark`);
      this.marks.set(id, mark);
      this.decoration.insert(id, mark, true);
      this.shown.add(id);
    }
  }

  private async exportBlob(id: ObjectId | undefined): Promise<void> {
    if (this.noData || id === undefined || /^0+$/.test(id)) return;
    if (this.shown.has(id)) return;
    const raw = await readObjectBytes(this.objects, id);
    if (!raw) this.die(`could not read blob ${id}`);
    const { bytes } = raw as { bytes: Uint8Array };
    const mark = this.markNext(id, false);
    let header = `blob\nmark :${mark}\n`;
    if (this.showOriginalIds) header += `original-oid ${id}\n`;
    header += `data ${bytes.length}\n`;
    await this.out(header);
    await this.out(bytes);
    await this.out("\n");
    await this.showProgress();
    this.shown.add(id);
  }

  /** print_path: C-quoted when needed, else in double quotes when it holds a space. */
  private pathText(path: string): string {
    const body = quoteCStyleBody(path, this.quotePathFully);
    if (body !== undefined) return latin1(encodeGitPath(`"${body}"`));
    const bytes = latin1(encodeGitPath(path));
    return bytes.includes(" ") ? `"${bytes}"` : bytes;
  }

  private async handleCommit(id: ObjectId, refname: string): Promise<void> {
    const raw = await readObjectBytes(this.objects, id);
    if (!raw) this.die(`could not read commit ${id}`);
    const buffer = latin1((raw as { bytes: Uint8Array }).bytes);
    const parents: ObjectId[] = [];
    let tree = "";
    const authorAt = buffer.indexOf("\nauthor ");
    if (authorAt < 0) this.die(`could not find author in commit ${id}`);
    const author = buffer.slice(authorAt + 1, lineEnd(buffer, authorAt + 1));
    let cursor = lineEnd(buffer, authorAt + 1);
    const committerAt = buffer.indexOf("\ncommitter ", cursor);
    if (committerAt < 0) this.die(`could not find committer in commit ${id}`);
    const committer = buffer.slice(committerAt + 1, lineEnd(buffer, committerAt + 1));
    cursor = lineEnd(buffer, committerAt + 1);
    for (const line of buffer.slice(0, authorAt + 1).split("\n")) {
      if (line.startsWith("tree ")) tree = line.slice(5);
      else if (line.startsWith("parent ")) parents.push(line.slice(7));
    }

    // the headers after the committer: encoding, then the signatures
    let encoding: string | undefined;
    const signatures: { text: string; hash: string }[] = [];
    const messageAt = buffer.indexOf("\n\n", cursor);
    const headerEnd = messageAt < 0 ? buffer.length : messageAt;
    const headers = buffer.slice(cursor + 1, headerEnd);
    const headerLines = cursor < headerEnd ? headers.split("\n") : [];
    if (this.compatibility === "2.43") {
      const enc = headerLines.find((l) => l.startsWith("encoding "));
      if (enc !== undefined) encoding = enc.slice(9);
    } else if (headerLines[0]?.startsWith("encoding ")) {
      encoding = headerLines[0].slice(9);
    }
    if (this.compatibility !== "2.43") {
      for (const [header, hash] of [
        ["gpgsig", "sha1"],
        ["gpgsig-sha256", "sha256"],
      ] as const) {
        for (let i = 0; i < headerLines.length; i++) {
          const line = headerLines[i] as string;
          if (!line.startsWith(`${header} `)) continue;
          let value = line.slice(header.length + 1);
          while (headerLines[i + 1]?.startsWith(" ")) {
            value += `\n${(headerLines[++i] as string).slice(1)}`;
          }
          signatures.push({ text: value, hash });
        }
      }
    }
    let message = messageAt < 0 ? undefined : buffer.slice(messageAt + 2);
    if (message?.includes("\0")) {
      message = message.slice(0, message.indexOf("\0"));
    }

    // the diff against the first parent, when it is exported (or referenced)
    const first = parents[0];
    const pairs =
      first !== undefined && (this.marks.has(first) || this.referenceExcluded) && !this.fullTree
        ? await this.diffTrees(await this.treeOf(first), tree)
        : await this.diffTrees(undefined, tree);
    for (const p of pairs) if (p.mode !== GITLINK_MODE) await this.exportBlob(p.id);

    const mark = this.markNext(id, true);
    let reencoded: string | undefined;
    if (encoding !== undefined) {
      if (this.reencode === "yes") reencoded = reencodeToUtf8(message ?? "", encoding);
      else if (this.reencode === "abort") {
        this.die(
          `encountered commit-specific encoding ${encoding} in commit ${id}; use --reencode=[yes|no] to handle it`,
          `Encountered commit-specific encoding ${encoding} in commit ${id}; use --reencode=[yes|no] to handle it`,
        );
      }
    }
    let text = "";
    if (parents.length === 0) text += `reset ${bin(refname)}\n`;
    text += `commit ${bin(refname)}\nmark :${mark}\n`;
    if (this.showOriginalIds) text += `original-oid ${id}\n`;
    text += `${author}\n${committer}\n`;
    // git prints as it goes: what came before a death is on stdout
    await this.out(text);
    text = "";
    if (signatures.length > 0) {
      switch (this.signedCommits) {
        case "warn-verbatim":
        case "warn":
        case "verbatim":
        case "ignore":
          if (this.signedCommits === "warn-verbatim" || this.signedCommits === "warn") {
            this.warn(`warning: exporting ${signatures.length} signature(s) for commit ${id}`);
          }
          for (const s of signatures) {
            text += `gpgsig ${s.hash} ${signatureFormatOf(s.text)}\ndata ${utf8Length(s.text)}\n${s.text}\n`;
          }
          break;
        case "warn-strip":
          this.warn(`warning: stripping signature(s) from commit ${id}`);
          break;
        case "strip":
          break;
        default:
          this.die(`encountered signed commit ${id}; use --signed-commits=<mode> to handle it`);
      }
    }
    if (reencoded === undefined && encoding !== undefined) text += `encoding ${encoding}\n`;
    const body = reencoded ?? message ?? "";
    text += `data ${body.length}\n${body}`;
    let i = 0;
    for (const p of parents) {
      const parentMark = this.marks.get(p);
      if (!parentMark && !this.referenceExcluded) continue;
      text += i === 0 ? "from " : "merge ";
      text += parentMark ? `:${parentMark}\n` : `${p}\n`;
      i++;
    }
    if (this.fullTree) text += "deleteall\n";
    text += this.fileChanges(pairs);
    text += "\n";
    await this.out(text);
    await this.showProgress();
  }

  /** show_filemodify: the changes sorted depth first, files below a directory before it. */
  private fileChanges(pairs: readonly FilePair[]): string {
    const sorted = [...pairs].sort((a, b) => depthFirst(a.path, b.path));
    let text = "";
    for (const p of sorted) {
      if (p.status === "D") {
        text += `D ${this.pathText(p.path)}\n`;
        continue;
      }
      const mode = p.mode.toString(8).padStart(6, "0");
      const ref =
        this.noData || p.mode === GITLINK_MODE ? p.id : `:${this.marks.get(p.id as string) ?? 0}`;
      text += `M ${mode} ${ref} ${this.pathText(p.path)}\n`;
    }
    return text;
  }

  private async treeOf(commit: ObjectId): Promise<ObjectId> {
    const raw = await readObjectBytes(this.objects, commit);
    const text = raw ? latin1(raw.bytes.subarray(0, 100)) : "";
    return text.startsWith("tree ") ? text.slice(5, text.indexOf("\n")) : "";
  }

  /** diff_tree_oid with `recursive`, in tree-diff order (no rename detection). */
  private async diffTrees(
    a: ObjectId | undefined,
    b: ObjectId,
    prefix = "",
    out: FilePair[] = [],
  ): Promise<FilePair[]> {
    const left = a ? await this.treeEntries(a) : [];
    const right = b ? await this.treeEntries(b) : [];
    const key = (e: TreeEntry) => (isTree(e.mode) ? `${e.name}/` : e.name);
    let i = 0;
    let j = 0;
    while (i < left.length || j < right.length) {
      const l = left[i];
      const r = right[j];
      const cmp = !l ? 1 : !r ? -1 : compareBytes(key(l), key(r));
      if (cmp < 0) {
        await this.side(l as TreeEntry, "D", prefix, out);
        i++;
      } else if (cmp > 0) {
        await this.side(r as TreeEntry, "A", prefix, out);
        j++;
      } else {
        const le = l as TreeEntry;
        const re = r as TreeEntry;
        i++;
        j++;
        if (le.id === re.id && le.mode === re.mode) continue;
        const path = prefix + re.name;
        if (isTree(le.mode)) {
          await this.diffTrees(le.id, re.id, `${path}/`, out);
          continue;
        }
        const typeChanged = (le.mode & 0o170000) !== (re.mode & 0o170000);
        out.push({ status: typeChanged ? "T" : "M", path, mode: re.mode, id: re.id });
      }
    }
    return out;
  }

  private async side(
    e: TreeEntry,
    status: "A" | "D",
    prefix: string,
    out: FilePair[],
  ): Promise<void> {
    const path = prefix + e.name;
    if (isTree(e.mode)) {
      for (const child of await this.treeEntries(e.id)) {
        await this.side(child, status, `${path}/`, out);
      }
      return;
    }
    out.push(
      status === "D"
        ? { status, path, mode: e.mode, id: undefined }
        : { status, path, mode: e.mode, id: e.id },
    );
  }

  private async handleTag(name: string, tagId: ObjectId): Promise<void> {
    // tags of trees (or of tags of trees) cannot be expressed
    let tagged = await this.taggedOf(tagId);
    let taggedType = await this.typeOf(tagged);
    const direct = { id: tagged, type: taggedType };
    while (taggedType === "tag") {
      tagged = await this.taggedOf(tagged);
      taggedType = await this.typeOf(tagged);
    }
    if (taggedType === "tree") {
      this.warn(
        this.compatibility === "2.43"
          ? `warning: Omitting tag ${tagId},\nsince tags of trees (or tags of tags of trees, etc.) are not supported.`
          : `warning: omitting tag ${tagId},\nsince tags of trees (or tags of tags of trees, etc.) are not supported.`,
      );
      return;
    }
    const raw = await readObjectBytes(this.objects, tagId);
    if (!raw) this.die(`could not read tag ${tagId}`);
    const buf = latin1((raw as { bytes: Uint8Array }).bytes);
    const messageAt = buf.indexOf("\n\n");
    let message: string | undefined;
    if (messageAt >= 0) {
      message = buf.slice(messageAt + 2);
      if (message.includes("\0")) message = message.slice(0, message.indexOf("\0"));
    }
    let messageSize = message?.length ?? 0;
    const headerPart = messageAt >= 0 ? buf.slice(0, messageAt + 2) : buf;
    const taggerAt = headerPart.indexOf("\ntagger ");
    let tagger: string;
    if (taggerAt < 0) {
      tagger = this.fakeMissingTagger
        ? "tagger Unspecified Tagger <unspecified-tagger> 0 +0000"
        : "";
    } else {
      tagger = buf.slice(taggerAt + 1, lineEnd(buf, taggerAt + 1));
    }

    if (message !== undefined) {
      const sigAt = signatureStartOf(message, this.compatibility);
      if (sigAt < message.length) {
        switch (this.signedTags) {
          case "warn-verbatim":
          case "warn":
            this.warn(`warning: exporting signed tag ${tagId}`);
            break;
          case "verbatim":
          case "ignore":
            break;
          case "warn-strip":
            this.warn(`warning: stripping signature from tag ${tagId}`);
            messageSize = sigAt;
            break;
          case "strip":
            messageSize = sigAt;
            break;
          default:
            this.die(`encountered signed tag ${tagId}; use --signed-tags=<mode> to handle it`);
        }
      }
    }

    let taggedMark = this.marks.get(direct.id) ?? 0;
    if (!taggedMark) {
      switch (this.tagOfFiltered) {
        case "abort":
          this.die(
            `tag ${tagId} tags unexported object; use --tag-of-filtered-object=<mode> to handle it`,
          );
          break;
        case "drop":
          return;
        default:
          if (direct.type === "tag" && !this.markTags) {
            this.die(
              "cannot export nested tags unless --mark-tags is specified.",
              "Error: Cannot export nested tags unless --mark-tags is specified.",
            );
          }
          taggedMark = this.marks.get(direct.id) ?? 0;
      }
    }

    let text = "";
    if (direct.type === "tag") text += `reset ${bin(name)}\nfrom ${NULL_SHA1}\n\n`;
    const short = name.startsWith("refs/tags/") ? name.slice(10) : name;
    text += `tag ${bin(short)}\n`;
    if (this.markTags) text += `mark :${this.markNext(tagId, false)}\n`;
    text += taggedMark ? `from :${taggedMark}\n` : `from ${direct.id}\n`;
    if (this.showOriginalIds) text += `original-oid ${tagId}\n`;
    const shown = (message ?? "").slice(0, messageSize);
    text += `${tagger}${tagger === "" ? "" : "\n"}data ${messageSize}\n${shown}\n`;
    await this.out(text);
  }
}

/** A name as the stream's bytes (a binary string). */
function bin(name: string): string {
  return latin1(encodeGitPath(name));
}

function isTree(mode: number): boolean {
  return (mode & 0o170000) === TREE_MODE;
}

function lineEnd(text: string, from: number): number {
  const nl = text.indexOf("\n", from);
  return nl < 0 ? text.length : nl;
}

/** Byte order of two binary strings (or of plain ASCII names). */
function compareBytes(a: string, b: string): number {
  const x = latin1(encodeGitPath(a));
  const y = latin1(encodeGitPath(b));
  return x < y ? -1 : x > y ? 1 : 0;
}

/** fast-export.c's depth_first: 'd/e' before 'd', otherwise byte order. */
function depthFirst(a: string, b: string): number {
  const x = latin1(encodeGitPath(a));
  const y = latin1(encodeGitPath(b));
  const len = Math.min(x.length, y.length);
  const px = x.slice(0, len);
  const py = y.slice(0, len);
  if (px !== py) return px < py ? -1 : 1;
  return y.length - x.length;
}

/** The byte length of a binary string (it is one byte per character). */
function utf8Length(text: string): number {
  return text.length;
}

/** reencode_string(message, "UTF-8", encoding): undefined when it cannot convert. */
function reencodeToUtf8(message: string, encoding: string): string | undefined {
  try {
    const decoded = new TextDecoder(encoding, { fatal: true }).decode(latin1Bytes(message));
    return latin1(new TextEncoder().encode(decoded));
  } catch {
    return undefined;
  }
}
