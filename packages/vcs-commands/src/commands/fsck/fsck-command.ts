import {
  type FilesApi,
  type GitObject,
  type GitObjects,
  isSymbolicRef,
  type PackIndex,
  type Refs,
  readPackIndex,
} from "@statewalker/vcs-core";
import { decodeGitPath } from "@statewalker/vcs-utils/encoding";
import {
  type CacheTree,
  parseCacheTree,
  parseIndexFile,
  parseResolveUndo,
  type ResolveUndoRecord,
  type Staging,
} from "@statewalker/vcs-working-tree";

import { GitCommand } from "../../git-command.js";
import { configValue } from "../merge-config.js";
import { readLooseObject } from "./fsck-loose.js";
import { FSCK_MSG_IDS, FsckMessageTypes, type FsckMsgId } from "./fsck-msg-ids.js";
import {
  canonMode,
  fsckBlob,
  fsckCommit,
  fsckTag,
  fsckTree,
  parseCommitBuffer,
  parseTagBuffer,
  walkTree,
} from "./fsck-object-checks.js";
import {
  HAS_OBJ,
  OBJ_BLOB,
  OBJ_COMMIT,
  OBJ_NONE,
  OBJ_TAG,
  OBJ_TREE,
  ObjectTable,
  type ObjType,
  PARSED,
  REACHABLE,
  SEEN,
  TYPE_NAME,
  typeOf,
  USED,
} from "./fsck-object-table.js";
import { collect, scanPack, unpackEntry } from "./fsck-pack.js";

/** Exit status bits, as `git fsck` returns them (git 2.43's builtin/fsck.c). */
export const FSCK_ERROR_OBJECT = 0o1;
export const FSCK_ERROR_REACHABLE = 0o2;
export const FSCK_ERROR_PACK = 0o4;
export const FSCK_ERROR_REFS = 0o10;

/** What one line of fsck's output reports. */
export type FsckFindingKind =
  /** a reachable object that is not stored (`missing <type> <id>`) */
  | "missing"
  /** an unreachable object nothing points to (`dangling <type> <id>`) */
  | "dangling"
  /** an unreachable object, with `--unreachable` */
  | "unreachable"
  /** a reachable object points to one that is not stored (`broken link from ...`) */
  | "broken-link"
  /** a message of git's object checks (`error in tree <id>: duplicateEntries: ...`) */
  | "object"
  /** `root <id>`, with `--root` */
  | "root"
  /** `tagged <type> <id> (<name>) in <id>`, with `--tags` */
  | "tagged"
  /** anything else git prints with `error()` (corrupt objects and packs, bad refs) */
  | "error"
  /** `notice: ...` and `bad sha1 file: ...` */
  | "notice";

/** One line of output, as git prints it, with what it is about. */
export interface FsckFinding {
  kind: FsckFindingKind;
  /** Where git prints it. */
  stream: "stdout" | "stderr";
  /** The line, without its newline. */
  text: string;
  objectId?: string;
  objectType?: string;
  /** The message id of an `object` finding. */
  msgId?: FsckMsgId;
  /** How an `object` finding was reported. */
  severity?: "error" | "warning";
}

/** Result of `git fsck`. */
export interface FsckResult {
  /** git's exit status: the `FSCK_ERROR_*` bits that apply (0 when nothing is wrong). */
  exitCode: number;
  /** Every line, in the order git prints them. */
  findings: FsckFinding[];
  /** What git prints on stdout. */
  output: string;
  /** What git prints on stderr. */
  errorOutput: string;
}

/** The git version whose output `FsckCommand` reproduces where versions differ. */
export type FsckCompatibility = "2.43" | "2.56";

/** The files of a git repository, for the checks that read them (`setRepositoryFiles`). */
export interface FsckRepositoryFiles {
  files: FilesApi;
  /** Path of the `.git` directory within `files` (default ".git"). */
  gitDir?: string;
}

const ZERO_ID = "0000000000000000000000000000000000000000";
const OID = /^[0-9a-f]{40}$/;
const LOOSE_NAME = /^[0-9a-f]{38}$/;
const PACK_IDX = /^pack-[0-9a-f]{40}\.idx$/;
/** Refs one worktree has of its own (git's `is_per_worktree_ref`). */
const PER_WORKTREE = /^(?:refs\/(?:bisect|worktree|rewritten)\/|[A-Z_]+$)/;
const dec = new TextDecoder();

/** A path within the repository's files, as git prints it (`.git/objects/ab/cd...`). */
const pathOf = (...parts: string[]) => parts.join("/");

/**
 * Verify the connectivity and validity of the objects in the repository.
 *
 * Equivalent to `git fsck`, after git's `builtin/fsck.c` and `fsck.c` (2.43): every stored
 * object is read and checked (git's message ids, severities and texts, `fsck.<msg-id>` config
 * and `--strict`), then everything reachable from the refs, the reflogs, the index (its
 * entries, cache-tree and resolve-undo), the HEADs of linked worktrees and the stash is
 * walked, and objects that are missing, dangling or (with `--unreachable`) unreachable are
 * listed in git's order.
 *
 * Over a files repository (`setRepositoryFiles`) loose objects are read from their files
 * (zlib streams, headers and hashes checked as git checks them) and packs are verified as
 * git's `verify_pack` does (idx and pack checksums, each entry's CRC-32 and hash); reflogs,
 * index files and linked worktrees are read from `.git`. Over any other store the objects of
 * `history.objects` are read and checked, the reflogs come from `refs.getReflog` and the index
 * from the staging area.
 *
 * Memory holds per object only its type, a few flags and a commit's tree and parents (as git
 * does); contents are read one object at a time.
 *
 * Not done: the ref database checks of `git refs verify` (git 2.45+), commit-graph,
 * multi-pack-index, bitmap and reverse-index verification, promisor objects, alternates,
 * `fsck.skipList`, and explicit `<object>` heads.
 *
 * @example
 * ```typescript
 * const result = await git.fsck().setRepositoryFiles({ files }).setUnreachable(true).call();
 * process.stdout.write(result.output);
 * process.stderr.write(result.errorOutput);
 * process.exitCode = result.exitCode;
 * ```
 */
export class FsckCommand extends GitCommand<FsckResult> {
  private _strict = false;
  private _connectivityOnly = false;
  private _dangling = true;
  private _unreachable = false;
  private _reflogs = true;
  private _nameObjects = false;
  private _root = false;
  private _tags = false;
  private _lostFound = false;
  private _compatibility: FsckCompatibility = "2.43";
  private _repository?: FsckRepositoryFiles;
  private readonly _messageTypes: [string, string][] = [];

  /** `--strict`: warnings are errors, and mode 100664 a bad file mode. */
  setStrict(strict: boolean): this {
    this.checkCallable();
    this._strict = strict;
    return this;
  }

  /** `--connectivity-only`: check only that reachable objects are there, not their contents. */
  setConnectivityOnly(connectivityOnly: boolean): this {
    this.checkCallable();
    this._connectivityOnly = connectivityOnly;
    return this;
  }

  /** `--[no-]dangling` (on by default): list unreachable objects nothing points to. */
  setDangling(dangling: boolean): this {
    this.checkCallable();
    this._dangling = dangling;
    return this;
  }

  /** `--unreachable`: list every unreachable object. */
  setUnreachable(unreachable: boolean): this {
    this.checkCallable();
    this._unreachable = unreachable;
    return this;
  }

  /** `--[no-]reflogs` (on by default): reflog entries are roots. */
  setReflogs(reflogs: boolean): this {
    this.checkCallable();
    this._reflogs = reflogs;
    return this;
  }

  /** `--name-objects`: name reachable objects by how they were reached (`HEAD~2:src/`). */
  setNameObjects(nameObjects: boolean): this {
    this.checkCallable();
    this._nameObjects = nameObjects;
    return this;
  }

  /** `--root`: report root commits. */
  setRoot(root: boolean): this {
    this.checkCallable();
    this._root = root;
    return this;
  }

  /** `--tags`: report tags. */
  setTags(tags: boolean): this {
    this.checkCallable();
    this._tags = tags;
    return this;
  }

  /**
   * `--lost-found`: write dangling objects to `.git/lost-found/commit/<id>` and
   * `.git/lost-found/other/<id>` (blobs with their content, others with their id). Needs
   * `setRepositoryFiles`; turns reflogs off, as git does.
   */
  setLostFound(lostFound: boolean): this {
    this.checkCallable();
    this._lostFound = lostFound;
    return this;
  }

  /**
   * Which git's output to reproduce where versions differ (default `2.43`):
   *  - `2.43`: refs are read after the objects; `notice: HEAD points to an unborn branch`,
   *    `HEAD points to something strange` and `detached HEAD points at nothing` are reported; an
   *    object that cannot be parsed is `<id>: object could not be parsed: <path>`; a bad pack
   *    sets exit bit 4 (`FSCK_ERROR_PACK`);
   *  - `2.56`: the refs and worktree HEADs are read (and created in the object hash) before the
   *    objects, then their reflogs; HEAD is not checked (git's `refs verify` does that); an
   *    unparsable object is `<id>: object corrupt or missing`; a bad pack sets bit 1.
   */
  setCompatibility(version: FsckCompatibility): this {
    this.checkCallable();
    this._compatibility = version;
    return this;
  }

  /** `fsck.<msg-id>=<type>` for this run (`error`, `warn` or `ignore`), after the config's. */
  setMessageType(msgId: string, type: string): this {
    this.checkCallable();
    this._messageTypes.push([msgId, type]);
    return this;
  }

  /**
   * The repository's files: loose objects, packs, reflogs, index files and linked worktrees
   * are then read and checked as git reads them.
   */
  setRepositoryFiles(repository: FsckRepositoryFiles): this {
    this.checkCallable();
    this._repository = repository;
    return this;
  }

  async call(): Promise<FsckResult> {
    this.checkCallable();
    this.setCallable(false);
    const types = new FsckMessageTypes({ strict: this._strict });
    for (const id of Object.keys(FSCK_MSG_IDS)) {
      const value = configValue(this.workingCopy, `fsck.${id}`);
      if (value !== undefined) types.set(id, value);
    }
    for (const [id, type] of this._messageTypes) types.set(id, type);
    const objects = this.workingCopy.history.objects;
    if (!objects) throw new Error("fsck needs the object store (history.objects)");
    const stores: RunStores = { refs: this.refsStore, staging: () => this.staging };
    const run = new FsckRun(stores, objects, types, {
      connectivityOnly: this._connectivityOnly,
      dangling: this._dangling,
      unreachable: this._unreachable,
      reflogs: this._reflogs && !this._lostFound,
      nameObjects: this._nameObjects,
      root: this._root,
      tags: this._tags,
      lostFound: this._lostFound,
      compatibility: this._compatibility,
      repository: this._repository,
    });
    return run.run();
  }
}

/** The stores a run reads besides the objects. */
interface RunStores {
  refs: Refs;
  /** The staging area (throws when the working copy has none). */
  staging: () => Staging;
}

interface RunOptions {
  connectivityOnly: boolean;
  dangling: boolean;
  unreachable: boolean;
  reflogs: boolean;
  nameObjects: boolean;
  root: boolean;
  tags: boolean;
  lostFound: boolean;
  compatibility: FsckCompatibility;
  repository?: FsckRepositoryFiles;
}

/** A pack of the repository, with its idx read (for `has_object_pack`). */
interface RepoPack {
  packPath: string;
  idxPath: string;
  idx: PackIndex;
}

/** The reflog of one ref: its name as git prints it and its entries, oldest first. */
interface Reflog {
  name: string;
  entries: { oldId: string; newId: string; timestamp: number }[];
}

/** One worktree's state: its HEAD, its reflogs and its index. */
interface WorktreeState {
  /** `HEAD`, or `worktrees/<id>/HEAD` */
  headName: string;
  /** Where the worktree's files are (the `.git` dir or `.git/worktrees/<id>`) */
  dir?: string;
  current: boolean;
}

/** One `git fsck` run (builtin/fsck.c's globals). */
class FsckRun {
  private readonly t = new ObjectTable();
  private readonly findings: FsckFinding[] = [];
  private errorsFound = 0;
  private readonly pending: number[] = [];
  private readonly names?: Map<string, string>;
  private defaultRefs = 0;
  private showUnreachable: boolean;
  private readonly gitmodulesFound = new Set<string>();
  private readonly gitmodulesDone = new Set<string>();
  private readonly gitattributesFound = new Set<string>();
  private readonly gitattributesDone = new Set<string>();
  private shallow = new Set<string>();
  private packs: RepoPack[] = [];
  private readonly files?: FilesApi;
  private readonly gitDir: string;

  constructor(
    private readonly stores: RunStores,
    private readonly objects: GitObjects,
    private readonly types: FsckMessageTypes,
    private readonly o: RunOptions,
  ) {
    if (o.nameObjects) this.names = new Map();
    this.showUnreachable = o.unreachable;
    this.files = o.repository?.files;
    this.gitDir = (o.repository?.gitDir ?? ".git").replace(/\/+$/, "");
  }

  async run(): Promise<FsckResult> {
    const refs = this.stores.refs;
    this.shallow = new Set((await refs.getShallow?.()) ?? []);
    if (this.files) this.packs = await this.listPacks();
    // git 2.45+: the refs are snapshotted before the objects are read
    const snapshot = this.o.compatibility === "2.56" ? await this.snapshotRefs() : undefined;

    if (this.o.connectivityOnly) {
      for await (const id of this.storedIds()) this.t.addFlags(this.t.lookupUnknown(id), HAS_OBJ);
    } else {
      if (this.files) {
        await this.fsckLooseObjects();
        await this.fsckPacks();
      } else {
        await this.fsckStoredObjects();
      }
      if (await this.fsckFinish()) this.errorsFound |= FSCK_ERROR_OBJECT;
    }

    if (snapshot) await this.processSnapshot(snapshot);
    else await this.processRefs();
    await this.processIndexes();
    await this.checkConnectivity();

    const out = this.findings.filter((f) => f.stream === "stdout").map((f) => `${f.text}\n`);
    const err = this.findings.filter((f) => f.stream === "stderr").map((f) => `${f.text}\n`);
    return {
      exitCode: this.errorsFound,
      findings: this.findings,
      output: out.join(""),
      errorOutput: err.join(""),
    };
  }

  // ------------------------------------------------------------------------------------------
  // Output

  private emit(finding: FsckFinding): void {
    this.findings.push(finding);
  }

  /** git's `error()`: `error: <message>` on stderr. */
  private error(message: string, objectId?: string): void {
    this.emit({ kind: "error", stream: "stderr", text: `error: ${message}`, objectId });
  }

  private describe(id: string): string {
    const name = this.names?.get(id);
    return name === undefined ? id : `${id} (${name})`;
  }

  private putName(id: string, name: string): void {
    if (this.names && !this.names.has(id)) this.names.set(id, name);
  }

  /** git's `printable_type`: the object's type, read from the store when not known yet. */
  private async printableType(n: number): Promise<string> {
    const type = this.t.type(n);
    if (type !== OBJ_NONE) return TYPE_NAME[type];
    const stored = await this.storeType(this.t.ids[n] as string);
    return stored ?? "unknown";
  }

  /** git's `objerror`. */
  private async objerror(n: number, message: string): Promise<void> {
    this.errorsFound |= FSCK_ERROR_OBJECT;
    const id = this.t.ids[n] as string;
    const type = await this.printableType(n);
    this.emit({
      kind: "error",
      stream: "stderr",
      text: `error in ${type} ${this.describe(id)}: ${message}`,
      objectId: id,
      objectType: type,
    });
  }

  /** The report function of git's object checks for one object. */
  private reporter(id: string, type: string) {
    return (msgId: FsckMsgId, message: string): number => {
      const severity = this.types.severity(msgId);
      if (severity === "ignore") return 0;
      const label = severity === "error" ? "error" : "warning";
      this.emit({
        kind: "object",
        stream: "stderr",
        text: `${label} in ${type} ${this.describe(id)}: ${msgId}: ${message}`,
        objectId: id,
        objectType: type,
        msgId,
        severity,
      });
      return severity === "error" ? 1 : 0;
    };
  }

  // ------------------------------------------------------------------------------------------
  // The object store

  /** The zlib error of the last failed read, as git's `git_inflate` prints it. */
  private lastZlibError?: string;

  private async readObject(id: string): Promise<GitObject | undefined> {
    this.lastZlibError = undefined;
    try {
      return await this.objects.get(id);
    } catch (e) {
      this.noteReadError(e);
      return undefined;
    }
  }

  private noteReadError(e: unknown): void {
    const inflate = /inflate failed: (.*)$/.exec(e instanceof Error ? e.message : "")?.[1];
    if (inflate) this.lastZlibError = `inflate: data stream error (${inflate})`;
  }

  private async readWhole(id: string): Promise<{ type: string; content: Uint8Array } | undefined> {
    const obj = await this.readObject(id);
    if (!obj) return undefined;
    try {
      return { type: obj.type, content: await collect(obj) };
    } catch (e) {
      this.noteReadError(e);
      return undefined;
    }
  }

  private async storeType(id: string): Promise<string | undefined> {
    const obj = await this.readObject(id);
    if (!obj) return undefined;
    await obj.content[Symbol.asyncIterator]().return?.();
    return obj.type;
  }

  /** git's `has_object`. */
  private async hasObject(id: string): Promise<boolean> {
    try {
      return await this.objects.has(id);
    } catch {
      return false;
    }
  }

  /** git's `has_object_pack`. */
  private inPack(id: string): boolean {
    return this.packs.some((p) => p.idx.has(id));
  }

  private looseDir(): string {
    return pathOf(this.gitDir, "objects");
  }

  private async listPacks(): Promise<RepoPack[]> {
    const files = this.files as FilesApi;
    const dir = pathOf(this.looseDir(), "pack");
    if ((await files.stats(dir))?.kind !== "directory") return [];
    const found: (RepoPack & { mtime: number })[] = [];
    for await (const e of files.list(dir)) {
      if (e.kind !== "file" || !PACK_IDX.test(e.name)) continue;
      const idxPath = pathOf(dir, e.name);
      const packPath = `${idxPath.slice(0, -4)}.pack`;
      const stats = await files.stats(packPath);
      if (stats?.kind !== "file") continue;
      try {
        const idx = readPackIndex(await readAll(files, idxPath));
        found.push({ packPath, idxPath, idx, mtime: stats.lastModified ?? 0 });
      } catch {
        // git does not list a pack whose idx cannot be opened
      }
    }
    // git's sort_pack: the most recently modified first
    found.sort((a, b) => b.mtime - a.mtime || (a.packPath < b.packPath ? -1 : 1));
    return found;
  }

  /** The loose object files of each fan-out directory, in directory order, and its other entries. */
  private async *looseEntries(): AsyncIterable<{ id?: string; path: string; name: string }> {
    const files = this.files as FilesApi;
    for (let i = 0; i < 256; i++) {
      const sub = i.toString(16).padStart(2, "0");
      const dir = pathOf(this.looseDir(), sub);
      if ((await files.stats(dir))?.kind !== "directory") continue;
      const entries: { name: string; path: string }[] = [];
      for await (const e of files.list(dir)) entries.push({ name: e.name, path: e.path });
      // in the order the files list them, as git's readdir loop: it decides hash collisions
      for (const e of entries) {
        const path = pathOf(dir, e.name);
        yield LOOSE_NAME.test(e.name)
          ? { id: sub + e.name, path, name: e.name }
          : { path, name: e.name };
      }
    }
  }

  /** Every stored id: loose ones, then each pack's in idx order (git's for_each_*_object). */
  private async *storedIds(): AsyncIterable<string> {
    if (!this.files) {
      const ids: string[] = [];
      for await (const id of this.objects.list()) ids.push(id);
      ids.sort();
      yield* ids;
      return;
    }
    for await (const e of this.looseEntries()) if (e.id) yield e.id;
    for (const p of this.packs) yield* p.idx.listObjects();
  }

  // ------------------------------------------------------------------------------------------
  // Reading and checking every object

  /** git's `parse_object_buffer`: the object, or undefined (git's errors printed). */
  private parseObjectBuffer(id: string, type: ObjType, content: Uint8Array): number | undefined {
    const t = this.t;
    const self = t.lookupTyped(id, type);
    if (typeof self !== "number") {
      this.error(self.error, id);
      return undefined;
    }
    const n = self;
    if (type === OBJ_BLOB || type === OBJ_TREE) {
      t.addFlags(n, PARSED);
      return n;
    }
    if (t.flags(n) & PARSED) return n;
    if (type === OBJ_COMMIT) {
      const parsed = parseCommitBuffer(content, id);
      if ("error" in parsed) {
        this.error(parsed.error, id);
        return undefined;
      }
      const tree = t.lookupTyped(parsed.tree, OBJ_TREE);
      if (typeof tree !== "number") {
        this.error(tree.error);
        this.error(`bad tree pointer ${parsed.tree} in commit ${id}`, id);
        return undefined;
      }
      const parents: number[] = [];
      if (!this.shallow.has(id)) {
        for (const p of parsed.parents) {
          const parent = t.lookupTyped(p, OBJ_COMMIT);
          if (typeof parent !== "number") {
            this.error(parent.error);
            this.error(`bad parent ${p} in commit ${id}`, id);
            return undefined;
          }
          parents.push(parent);
        }
      }
      t.links.set(n, { tree, parents });
      t.addFlags(n, PARSED);
      return n;
    }
    // tag
    const parsed = parseTagBuffer(content, id);
    if ("error" in parsed) {
      if (parsed.error) this.error(parsed.error, id);
      return undefined;
    }
    const tagged = t.lookupTyped(parsed.object, typeOf(parsed.type));
    if (typeof tagged !== "number") {
      this.error(tagged.error);
      this.error(`bad tag pointer to ${parsed.object} in ${id}`, id);
      return undefined;
    }
    if (parsed.tag === undefined) return undefined;
    t.links.set(n, { tagged, tag: parsed.tag });
    t.addFlags(n, PARSED);
    return n;
  }

  /** git's `parse_object`: an object already parsed, or read from the store and parsed. */
  private async parseObject(id: string): Promise<number | undefined> {
    const known = this.t.lookup(id);
    if (known >= 0 && this.t.flags(known) & PARSED) return known;
    const obj = await this.readWhole(id);
    if (!obj) {
      if (this.lastZlibError) this.error(this.lastZlibError);
      return undefined;
    }
    return this.parseObjectBuffer(id, typeOf(obj.type), obj.content);
  }

  /**
   * git's `fsck_obj_buffer` / the end of `fsck_loose`: parses the object, marks it stored and
   * checks it. Returns nonzero when the object is bad.
   */
  private async fsckObjBuffer(
    id: string,
    type: ObjType,
    content: Uint8Array,
    unparsable: string,
  ): Promise<number> {
    const n = this.parseObjectBuffer(id, type, content);
    if (n === undefined) {
      this.errorsFound |= FSCK_ERROR_OBJECT;
      this.error(unparsable, id);
      return -1;
    }
    this.t.clearFlags(n, REACHABLE | SEEN);
    this.t.addFlags(n, HAS_OBJ);
    return this.fsckObj(n, content);
  }

  /** git's `fsck_obj`. */
  private async fsckObj(n: number, content: Uint8Array): Promise<number> {
    const t = this.t;
    if (t.flags(n) & SEEN) return 0;
    t.addFlags(n, SEEN);
    const id = t.ids[n] as string;
    const type = t.type(n);
    if (this.walkUsed(n, content)) await this.objerror(n, "broken links");
    const err = this.fsckBuffer(id, type, content);
    if (err) return err;
    if (type === OBJ_COMMIT && this.o.root && t.links.get(n)?.parents?.length === 0) {
      this.emit({
        kind: "root",
        stream: "stdout",
        text: `root ${this.describe(id)}`,
        objectId: id,
      });
    }
    if (type === OBJ_TAG && this.o.tags) {
      const links = t.links.get(n);
      if (links?.tagged !== undefined) {
        const tagged = t.ids[links.tagged] as string;
        this.emit({
          kind: "tagged",
          stream: "stdout",
          text: `tagged ${await this.printableType(links.tagged)} ${this.describe(tagged)} (${links.tag}) in ${this.describe(id)}`,
          objectId: id,
        });
      }
    }
    return 0;
  }

  /** git's `fsck_walk` with `mark_used`: marks what the object points to as used. */
  private walkUsed(n: number, content: Uint8Array): number {
    const t = this.t;
    const type = t.type(n);
    if (type === OBJ_TREE) {
      const walk = walkTree(content);
      if (walk.initError) {
        this.error(walk.initError);
        return -1;
      }
      let res = 0;
      for (const e of walk.entries) {
        const mode = canonMode(e.mode);
        if (mode === 0o160000) continue;
        const child = t.lookupTyped(e.id, mode === 0o040000 ? OBJ_TREE : OBJ_BLOB);
        if (typeof child !== "number") {
          this.error(child.error);
          res ||= 1;
          continue;
        }
        t.addFlags(child, USED);
      }
      if (walk.error) this.error(walk.error);
      return res;
    }
    const links = t.links.get(n);
    if (type === OBJ_COMMIT && links) {
      if (links.tree !== undefined) t.addFlags(links.tree, USED);
      for (const p of links.parents ?? []) t.addFlags(p, USED);
    } else if (type === OBJ_TAG && links?.tagged !== undefined) {
      t.addFlags(links.tagged, USED);
    }
    return 0;
  }

  /** git's `fsck_buffer`: the object checks of `fsck.c`. */
  private fsckBuffer(id: string, type: ObjType, content: Uint8Array): number {
    const report = this.reporter(id, TYPE_NAME[type]);
    switch (type) {
      case OBJ_TREE: {
        const found = { gitmodules: [] as string[], gitattributes: [] as string[] };
        const r = fsckTree(content, this.types, report, (m) => this.error(m), found);
        for (const g of found.gitmodules) this.gitmodulesFound.add(g);
        for (const g of found.gitattributes) this.gitattributesFound.add(g);
        return r;
      }
      case OBJ_COMMIT:
        return fsckCommit(content, report);
      case OBJ_TAG:
        return fsckTag(content, report);
      case OBJ_BLOB:
        return this.fsckBlobOf(id, content, content.length, report);
      default:
        return report("unknownType", `unknown type '${type}' (internal fsck error)`);
    }
  }

  private fsckBlobOf(
    id: string,
    content: Uint8Array | undefined,
    size: number,
    report: ReturnType<FsckRun["reporter"]>,
  ): number {
    const gitmodules = this.gitmodulesFound.has(id);
    const gitattributes = this.gitattributesFound.has(id);
    if (!gitmodules && !gitattributes) return 0;
    if (gitmodules) this.gitmodulesDone.add(id);
    if (gitattributes) this.gitattributesDone.add(id);
    return fsckBlob(content, size, { gitmodules, gitattributes }, report);
  }

  /** git's `fsck_finish`: `.gitmodules` and `.gitattributes` blobs not checked yet. */
  private async fsckFinish(): Promise<number> {
    let ret = 0;
    const pass = async (
      found: Set<string>,
      done: Set<string>,
      missing: FsckMsgId,
      nonBlob: FsckMsgId,
      name: string,
    ) => {
      for (const id of found) {
        if (done.has(id)) continue;
        const obj = await this.readWhole(id);
        if (!obj) {
          ret |= this.reporter(id, "blob")(missing, `unable to read ${name} blob`);
          continue;
        }
        if (obj.type === "blob") {
          ret |= this.fsckBlobOf(id, obj.content, obj.content.length, this.reporter(id, "blob"));
        } else {
          ret |= this.reporter(id, obj.type)(nonBlob, `non-blob found at ${name}`);
        }
      }
    };
    await pass(
      this.gitmodulesFound,
      this.gitmodulesDone,
      "gitmodulesMissing",
      "gitmodulesBlob",
      ".gitmodules",
    );
    await pass(
      this.gitattributesFound,
      this.gitattributesDone,
      "gitattributesMissing",
      "gitattributesBlob",
      ".gitattributes",
    );
    return ret;
  }

  /** Blobs whose content a check needs (`.gitmodules`, `.gitattributes`). */
  private keepBlob = (id: string): boolean =>
    this.gitmodulesFound.has(id) || this.gitattributesFound.has(id);

  /** git's `fsck_object_dir`: every loose object file. */
  private async fsckLooseObjects(): Promise<void> {
    const files = this.files as FilesApi;
    for await (const e of this.looseEntries()) {
      if (!e.id) {
        if (!e.name.startsWith("tmp_obj_")) {
          this.emit({ kind: "notice", stream: "stderr", text: `bad sha1 file: ${e.path}` });
        }
        continue;
      }
      const read = await readLooseObject(files, e.path, e.id);
      for (const m of read.errors) this.error(m, e.id);
      if (!read.object) {
        if (read.realId)
          this.error(`${read.realId}: hash-path mismatch, found at: ${e.path}`, e.id);
        else this.error(`${e.id}: object corrupt or missing: ${e.path}`, e.id);
        this.errorsFound |= FSCK_ERROR_OBJECT;
        continue;
      }
      const r = await this.fsckObjBuffer(
        e.id,
        typeOf(read.object.type),
        read.object.content,
        this.o.compatibility === "2.56"
          ? `${e.id}: object corrupt or missing`
          : `${e.id}: object could not be parsed: ${e.path}`,
      );
      if (r > 0) this.errorsFound |= FSCK_ERROR_OBJECT;
    }
  }

  /** git's `verify_pack` for every pack, with `fsck_obj_buffer` for each object. */
  private async fsckPacks(): Promise<void> {
    const files = this.files as FilesApi;
    for (const p of this.packs) {
      let err = 0;
      const scan = await scanPack(
        files,
        p.packPath,
        p.idxPath,
        (m) => this.error(m),
        (id) => this.readObject(id),
      );
      if (scan.failed) err = 1;
      if (scan.pack) {
        try {
          for (const entry of scan.entries) {
            if (p.idx.version > 1 && !entry.crcOk) {
              this.error(
                `index CRC mismatch for object ${entry.id} from ${p.packPath} at offset ${entry.offset}`,
                entry.id,
              );
              err = 1;
            }
            const unpacked = await unpackEntry(scan.pack, p.packPath, entry, this.keepBlob);
            if ("error" in unpacked) {
              if (unpacked.zlib) this.error(unpacked.zlib);
              this.error(unpacked.error, entry.id);
              err = 1;
              continue;
            }
            if (
              (await this.fsckObjBuffer(
                entry.id,
                typeOf(unpacked.type),
                unpacked.content,
                `${entry.id}: object corrupt or missing`,
              )) !== 0
            ) {
              err = 1;
            }
          }
        } finally {
          scan.pack.close();
        }
      }
      if (err) {
        this.errorsFound |= this.o.compatibility === "2.56" ? FSCK_ERROR_OBJECT : FSCK_ERROR_PACK;
      }
    }
  }

  /** Every object of a store without files: read, hash-checked and checked. */
  private async fsckStoredObjects(): Promise<void> {
    const ids: string[] = [];
    for await (const id of this.objects.list()) ids.push(id);
    ids.sort();
    for (const id of ids) {
      let read: { type: string; content: Uint8Array } | undefined;
      try {
        const obj = await this.objects.get(id, { verify: true });
        if (obj) {
          if (obj.type === "blob" && !this.keepBlob(id)) {
            for await (const _ of obj.content) {
              // hashed as it streams
            }
            read = { type: obj.type, content: new Uint8Array(0) };
          } else {
            read = { type: obj.type, content: await collect(obj) };
          }
        }
      } catch {
        read = undefined;
      }
      if (!read) {
        this.error(`${id}: object corrupt or missing`, id);
        this.errorsFound |= FSCK_ERROR_OBJECT;
        continue;
      }
      const r = await this.fsckObjBuffer(
        id,
        typeOf(read.type),
        read.content,
        `${id}: object corrupt or missing`,
      );
      if (r > 0) this.errorsFound |= FSCK_ERROR_OBJECT;
    }
  }

  // ------------------------------------------------------------------------------------------
  // Roots: refs, HEADs, reflogs, index files

  /** git's `mark_object`. */
  private async markObject(
    n: number | undefined,
    type: ObjType | "any",
    parent: number | undefined,
  ): Promise<number> {
    const t = this.t;
    if (n === undefined) {
      const p = parent as number;
      this.emit({
        kind: "broken-link",
        stream: "stdout",
        text: `broken link from ${(await this.printableType(p)).padStart(7)} ${this.describe(t.ids[p] as string)}`,
        objectId: t.ids[p],
      });
      this.emit({
        kind: "broken-link",
        stream: "stdout",
        text: `broken link from ${(type === "any" ? "unknown" : TYPE_NAME[type]).padStart(7)} unknown`,
      });
      this.errorsFound |= FSCK_ERROR_REACHABLE;
      return 1;
    }
    if (type !== "any" && t.type(n) !== type && parent !== undefined) {
      await this.objerror(parent, "wrong object type in link");
    }
    if (t.flags(n) & REACHABLE) return 0;
    t.addFlags(n, REACHABLE);
    if (!(t.flags(n) & HAS_OBJ)) {
      const id = t.ids[n] as string;
      if (parent !== undefined && !(await this.hasObject(id))) {
        const pid = t.ids[parent] as string;
        this.emit({
          kind: "broken-link",
          stream: "stdout",
          text: `broken link from ${(await this.printableType(parent)).padStart(7)} ${this.describe(pid)}`,
          objectId: pid,
        });
        this.emit({
          kind: "broken-link",
          stream: "stdout",
          text: `              to ${(await this.printableType(n)).padStart(7)} ${this.describe(id)}`,
          objectId: id,
        });
        this.errorsFound |= FSCK_ERROR_REACHABLE;
      }
      return 1;
    }
    this.pending.push(n);
    return 0;
  }

  /** git's `fsck_handle_ref`. */
  private async handleRef(name: string, id: string): Promise<void> {
    const n = await this.parseObject(id);
    if (n === undefined) {
      this.error(`${name}: invalid sha1 pointer ${id}`, id);
      this.errorsFound |= FSCK_ERROR_REACHABLE;
      return;
    }
    if (this.t.type(n) !== OBJ_COMMIT && name.startsWith("refs/heads/")) {
      this.error(`${name}: not a commit`, id);
      this.errorsFound |= FSCK_ERROR_REFS;
    }
    this.defaultRefs++;
    this.t.addFlags(n, USED);
    this.putName(id, name);
    await this.markObject(n, "any", undefined);
  }

  /** git's `fsck_handle_reflog_oid`. */
  private async handleReflogOid(refname: string, id: string, timestamp: number): Promise<void> {
    if (id === ZERO_ID) return;
    const n = this.t.lookup(id);
    if (n >= 0 && this.t.flags(n) & HAS_OBJ) {
      if (timestamp) this.putName(id, `${refname}@{${timestamp}}`);
      this.t.addFlags(n, USED);
      await this.markObject(n, "any", undefined);
    } else {
      this.error(`${refname}: invalid reflog entry ${id}`, id);
      this.errorsFound |= FSCK_ERROR_REACHABLE;
    }
  }

  /** git's `get_default_heads`. */
  private async processRefs(): Promise<void> {
    const refs = this.stores.refs;
    const listed: string[] = [];
    for await (const ref of refs.list("refs/")) listed.push(ref.name);
    listed.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const name of [...new Set(listed)]) {
      const resolved = await refs.resolve(name);
      if (resolved?.objectId) await this.handleRef(name, resolved.objectId);
    }

    for (const wt of await this.worktrees()) {
      await this.headLink(wt);
      if (this.o.reflogs) await this.processReflogs(wt);
    }

    if (!this.defaultRefs) {
      this.emit({ kind: "notice", stream: "stderr", text: "notice: No default references" });
      this.showUnreachable = false;
    }
  }

  /** git 2.45+'s `snapshot_refs`: every ref, then each worktree's HEAD, parsed before the objects. */
  private async snapshotRefs(): Promise<{ name: string; id: string }[]> {
    const refs = this.stores.refs;
    const snapshot: { name: string; id: string }[] = [];
    const snapshotRef = async (name: string, id: string) => {
      const n = await this.parseObject(id);
      if (n === undefined) {
        this.error(`${name}: invalid sha1 pointer ${id}`, id);
        this.errorsFound |= FSCK_ERROR_REACHABLE;
        return;
      }
      if (this.t.type(n) !== OBJ_COMMIT && name.startsWith("refs/heads/")) {
        this.error(`${name}: not a commit`, id);
        this.errorsFound |= FSCK_ERROR_REFS;
      }
      this.defaultRefs++;
      snapshot.push({ name, id });
    };
    const listed: string[] = [];
    for await (const ref of refs.list("refs/")) listed.push(ref.name);
    listed.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const name of [...new Set(listed)]) {
      const resolved = await refs.resolve(name);
      if (resolved?.objectId) await snapshotRef(name, resolved.objectId);
    }
    for (const wt of await this.worktrees()) {
      const id = await this.headId(wt);
      if (id && id !== ZERO_ID) await snapshotRef(wt.headName, id);
    }
    return snapshot;
  }

  /** git 2.45+'s `process_refs`: the snapshotted refs, then every worktree's reflogs. */
  private async processSnapshot(snapshot: { name: string; id: string }[]): Promise<void> {
    for (const { name, id } of snapshot) {
      const n = await this.parseObject(id);
      if (n === undefined) continue;
      this.t.addFlags(n, USED);
      this.putName(id, name);
      await this.markObject(n, "any", undefined);
    }
    if (this.o.reflogs) {
      for (const wt of await this.worktrees()) await this.processReflogs(wt);
    }
    if (!this.defaultRefs) {
      this.emit({ kind: "notice", stream: "stderr", text: "notice: No default references" });
      this.showUnreachable = false;
    }
  }

  private async processReflogs(wt: WorktreeState): Promise<void> {
    for (const log of await this.reflogs(wt)) {
      for (const e of log.entries) {
        await this.handleReflogOid(log.name, e.oldId, 0);
        await this.handleReflogOid(log.name, e.newId, e.timestamp);
      }
    }
  }

  /** What a worktree's HEAD resolves to, if anything. */
  private async headId(wt: WorktreeState): Promise<string | undefined> {
    const refs = this.stores.refs;
    if (wt.current) return (await refs.resolve("HEAD"))?.objectId;
    const text = (await readText(this.files as FilesApi, pathOf(wt.dir as string, "HEAD")))?.trim();
    if (!text) return undefined;
    if (text.startsWith("ref:")) return (await refs.resolve(text.slice(4).trim()))?.objectId;
    return OID.test(text.slice(0, 40)) ? text.slice(0, 40) : undefined;
  }

  /** The main worktree, then the linked ones (`.git/worktrees/<id>`). */
  private async worktrees(): Promise<WorktreeState[]> {
    const list: WorktreeState[] = [{ headName: "HEAD", dir: this.gitDir, current: true }];
    const files = this.files;
    if (!files) return list;
    const dir = pathOf(this.gitDir, "worktrees");
    if ((await files.stats(dir))?.kind !== "directory") return list;
    const names: string[] = [];
    for await (const e of files.list(dir)) {
      if (e.kind === "directory" && (await files.stats(pathOf(e.path, "HEAD")))?.kind === "file") {
        names.push(e.name);
      }
    }
    names.sort();
    for (const name of names) {
      list.push({ headName: `worktrees/${name}/HEAD`, dir: pathOf(dir, name), current: false });
    }
    return list;
  }

  /** git's `fsck_head_link` and the HEAD of a worktree as a root. */
  private async headLink(wt: WorktreeState): Promise<void> {
    const name = wt.headName;
    let target: string | undefined;
    let id: string | undefined;
    if (wt.current) {
      const head = await this.stores.refs.get("HEAD");
      if (!head) {
        this.errorsFound |= FSCK_ERROR_REFS;
        this.error(`invalid ${name}`);
        return;
      }
      if (isSymbolicRef(head)) {
        target = head.target;
        id = (await this.stores.refs.resolve(target))?.objectId;
      } else {
        id = head.objectId;
      }
    } else {
      const text = (
        await readText(this.files as FilesApi, pathOf(wt.dir as string, "HEAD"))
      )?.trim();
      if (!text) {
        this.errorsFound |= FSCK_ERROR_REFS;
        this.error(`invalid ${name}`);
        return;
      }
      if (text.startsWith("ref:")) {
        target = text.slice(4).trim();
        id = (await this.stores.refs.resolve(target))?.objectId;
      } else if (OID.test(text.slice(0, 40))) {
        id = text.slice(0, 40);
      } else {
        this.errorsFound |= FSCK_ERROR_REFS;
        this.error(`invalid ${name}`);
        return;
      }
    }
    if (target !== undefined && !target.startsWith("refs/heads/")) {
      this.errorsFound |= FSCK_ERROR_REFS;
      this.error(`${name} points to something strange (${target})`);
      return;
    }
    if (!id || id === ZERO_ID) {
      if (target === undefined) {
        this.errorsFound |= FSCK_ERROR_REFS;
        this.error(`${name}: detached HEAD points at nothing`);
        return;
      }
      this.emit({
        kind: "notice",
        stream: "stderr",
        text: `notice: ${name} points to an unborn branch (${target.slice(11)})`,
      });
      return;
    }
    await this.handleRef(name, id);
  }

  /** The reflogs of one worktree, in git's order (sorted by name, as git 2.45+ lists them). */
  private async reflogs(wt: WorktreeState): Promise<Reflog[]> {
    const files = this.files;
    if (!files) return wt.current ? this.storeReflogs() : [];
    const logs: Reflog[] = [];
    const collectDir = async (base: string, keep: (name: string) => boolean, prefix: string) => {
      const found: { name: string; path: string }[] = [];
      const walk = async (dir: string, rel: string) => {
        if ((await files.stats(dir))?.kind !== "directory") return;
        const entries: { name: string; path: string; kind: string }[] = [];
        for await (const e of files.list(dir)) entries.push(e);
        entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        for (const e of entries) {
          const name = rel ? `${rel}/${e.name}` : e.name;
          if (e.kind === "directory") await walk(e.path, name);
          else if (keep(name)) found.push({ name, path: e.path });
        }
      };
      await walk(base, "");
      for (const f of found) {
        logs.push({ name: prefix + f.name, entries: parseReflog(await readText(files, f.path)) });
      }
    };
    if (wt.current) {
      await collectDir(pathOf(this.gitDir, "logs"), () => true, "");
    } else {
      const dir = wt.dir as string;
      const id = dir.slice(dir.lastIndexOf("/") + 1);
      await collectDir(pathOf(dir, "logs"), (n) => PER_WORKTREE.test(n), `worktrees/${id}/`);
      await collectDir(pathOf(this.gitDir, "logs"), (n) => !PER_WORKTREE.test(n), "");
      logs.sort((a, b) => {
        const x = a.name.replace(/^worktrees\/[^/]+\//, "");
        const y = b.name.replace(/^worktrees\/[^/]+\//, "");
        return x < y ? -1 : x > y ? 1 : 0;
      });
    }
    return logs;
  }

  /** Reflogs through the refs store (a store without files): HEAD and every ref. */
  private async storeReflogs(): Promise<Reflog[]> {
    const refs = this.stores.refs;
    if (!refs.getReflog) return [];
    const names = ["HEAD"];
    for await (const ref of refs.list("refs/")) names.push(ref.name);
    const sorted = [...new Set(names)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const logs: Reflog[] = [];
    for (const name of sorted) {
      const reader = await refs.getReflog(name);
      if (!reader) continue;
      const entries = (await reader.getReverseEntries()).reverse();
      if (entries.length === 0) continue;
      logs.push({
        name,
        entries: entries.map((e) => ({
          oldId: e.oldId,
          newId: e.newId,
          timestamp: e.who.timestamp,
        })),
      });
    }
    return logs;
  }

  /** git's index pass: every worktree's index (`fsck_index`). */
  private async processIndexes(): Promise<void> {
    const files = this.files;
    if (!files) {
      await this.storeIndex();
      return;
    }
    for (const wt of await this.worktrees()) {
      const indexPath = pathOf(wt.dir as string, "index");
      if ((await files.stats(indexPath))?.kind !== "file") continue;
      const parsed = await parseIndexFile(await readAll(files, indexPath));
      const prefix = wt.current ? "" : indexPath;
      const entries = parsed.entries.map((e) => ({
        path: e.path,
        mode: e.mode,
        objectId: e.objectId,
      }));
      let cacheTree: CacheTree | undefined;
      let resolveUndo: ResolveUndoRecord[] = [];
      for (const ext of parsed.extensionData) {
        if (ext.signature === "TREE") cacheTree = parseCacheTree(ext.data);
        else if (ext.signature === "REUC") resolveUndo = parseResolveUndo(ext.data);
      }
      await this.fsckIndex(entries, cacheTree, resolveUndo, indexPath, prefix);
    }
  }

  /** The staging area of a store without files, as the current worktree's index. */
  private async storeIndex(): Promise<void> {
    let staging: Staging;
    try {
      staging = this.stores.staging();
    } catch {
      return;
    }
    const entries: { path: string; mode: number; objectId: string }[] = [];
    for await (const e of staging.entries()) {
      entries.push({ path: e.path, mode: e.mode, objectId: e.objectId });
    }
    await this.fsckIndex(entries, staging.getCacheTree?.(), [], `${this.gitDir}/index`, "");
  }

  /** git's `fsck_index`. */
  private async fsckIndex(
    entries: { path: string; mode: number; objectId: string }[],
    cacheTree: CacheTree | undefined,
    resolveUndo: ResolveUndoRecord[],
    indexPath: string,
    prefix: string,
  ): Promise<void> {
    for (const e of entries) {
      if ((e.mode & 0o170000) === 0o160000) continue;
      const blob = this.t.lookupTyped(e.objectId, OBJ_BLOB);
      if (typeof blob !== "number") {
        this.error(blob.error);
        continue;
      }
      this.t.addFlags(blob, USED);
      this.putName(e.objectId, `${prefix}:${e.path}`);
      await this.markObject(blob, "any", undefined);
    }
    if (cacheTree) await this.fsckCacheTree(cacheTree, indexPath);
    // resolve-undo: git keeps it as a string list sorted by path
    const sorted = [...resolveUndo].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    );
    for (const record of sorted) {
      for (let i = 0; i < 3; i++) {
        const mode = record.modes[i] ?? 0;
        const id = record.objectIds[i];
        if (!mode || (mode & 0o170000) !== 0o100000 || !id) continue;
        const n = await this.parseObject(id);
        if (n === undefined) {
          this.error(`${id}: invalid sha1 pointer in resolve-undo of ${indexPath}`, id);
          this.errorsFound |= FSCK_ERROR_REFS;
          continue;
        }
        this.t.addFlags(n, USED);
        this.putName(id, `:(${i}):${record.path}`);
        await this.markObject(n, "any", undefined);
      }
    }
  }

  /** git's `fsck_cache_tree`. */
  private async fsckCacheTree(node: CacheTree, indexPath: string): Promise<void> {
    if (node.entryCount >= 0 && node.id) {
      const n = await this.parseObject(node.id);
      if (n === undefined) {
        this.error(`${node.id}: invalid sha1 pointer in cache-tree of ${indexPath}`, node.id);
        this.errorsFound |= FSCK_ERROR_REFS;
        return;
      }
      this.t.addFlags(n, USED);
      this.putName(node.id, ":");
      await this.markObject(n, "any", undefined);
      if (this.t.type(n) !== OBJ_TREE) await this.objerror(n, "non-tree in cache-tree");
    }
    for (const sub of node.subtrees) await this.fsckCacheTree(sub.tree, indexPath);
  }

  // ------------------------------------------------------------------------------------------
  // Connectivity

  /** git's `fsck_walk` with `mark_object` (`traverse_one_object`). */
  private async traverseOne(n: number): Promise<void> {
    const t = this.t;
    const id = t.ids[n] as string;
    // git's parse_object / repo_parse_commit / parse_tag before walking
    if (t.type(n) === OBJ_NONE || (t.type(n) !== OBJ_BLOB && !(t.flags(n) & PARSED))) {
      await this.parseObject(id);
    }
    const name = this.names?.get(id);
    switch (t.type(n)) {
      case OBJ_BLOB:
        return;
      case OBJ_TREE: {
        const obj = await this.readWhole(id);
        if (!obj) {
          if (this.lastZlibError) this.error(this.lastZlibError);
          this.error(`Could not read ${id}`);
          return;
        }
        const walk = walkTree(obj.content);
        if (walk.initError) {
          this.error(walk.initError);
          return;
        }
        for (const e of walk.entries) {
          const mode = canonMode(e.mode);
          if (mode === 0o160000) continue;
          const isTree = mode === 0o040000;
          const child = t.lookupTyped(e.id, isTree ? OBJ_TREE : OBJ_BLOB);
          let c: number | undefined;
          if (typeof child === "number") c = child;
          else this.error(child.error);
          if (name !== undefined && c !== undefined) {
            this.putName(e.id, `${name}${decodeGitPath(e.name)}${isTree ? "/" : ""}`);
          }
          await this.markObject(c, isTree ? OBJ_TREE : OBJ_BLOB, n);
        }
        if (walk.error) this.error(walk.error);
        return;
      }
      case OBJ_COMMIT: {
        if (!(t.flags(n) & PARSED)) {
          this.error(`Could not read ${id}`);
          return;
        }
        const links = t.links.get(n);
        if (!links || links.tree === undefined) return;
        if (name !== undefined) this.putName(t.ids[links.tree] as string, `${name}:`);
        await this.markObject(links.tree, OBJ_TREE, n);
        const parents = links.parents ?? [];
        let generation = 0;
        let prefixLength = 0;
        if (name !== undefined && parents.length > 0) {
          if (name.endsWith("^")) {
            generation = 1;
            prefixLength = name.length - 1;
          } else {
            const m = /~(\d+)$/.exec(name);
            if (m && (m[1] as string).length > 0) {
              generation = Number(m[1]);
              prefixLength = name.length - (m[1] as string).length - 1;
            } else {
              generation = 0;
              prefixLength = name.length;
            }
          }
        }
        let counter = 0;
        for (const p of parents) {
          if (name !== undefined) {
            const pid = t.ids[p] as string;
            if (counter++) this.putName(pid, `${name}^${counter}`);
            else if (generation > 0)
              this.putName(pid, `${name.slice(0, prefixLength)}~${generation + 1}`);
            else this.putName(pid, `${name}^`);
          }
          await this.markObject(p, OBJ_COMMIT, n);
        }
        return;
      }
      case OBJ_TAG: {
        const links = t.links.get(n);
        if (!(t.flags(n) & PARSED)) {
          this.error(`Could not read ${id}`);
          return;
        }
        if (links?.tagged === undefined) return;
        if (name !== undefined) this.putName(t.ids[links.tagged] as string, name);
        await this.markObject(links.tagged, "any", n);
        return;
      }
      default:
        this.error(`Unknown object type for ${this.describe(id)}`);
    }
  }

  /** git's `mark_unreachable_referents` (connectivity-only runs). */
  private async markUnreachableReferents(id: string): Promise<void> {
    const t = this.t;
    const n = t.lookup(id);
    if (n < 0 || !(t.flags(n) & HAS_OBJ) || t.flags(n) & REACHABLE) return;
    if (t.type(n) === OBJ_NONE) {
      const type = typeOf((await this.storeType(id)) ?? "");
      if (type !== OBJ_NONE) t.setType(n, type);
    }
    const type = t.type(n);
    if (type === OBJ_TREE) {
      const obj = await this.readWhole(id);
      if (!obj) return;
      this.walkUsed(n, obj.content);
    } else if (type === OBJ_COMMIT || type === OBJ_TAG) {
      if (!(t.flags(n) & PARSED)) await this.parseObject(id);
      if (t.flags(n) & PARSED) this.walkUsed(n, new Uint8Array(0));
    }
  }

  /** git's `check_connectivity`. */
  private async checkConnectivity(): Promise<void> {
    const t = this.t;
    while (this.pending.length > 0) await this.traverseOne(this.pending.pop() as number);
    if (this.o.connectivityOnly && (this.o.dangling || this.o.lostFound)) {
      for await (const id of this.storedIds()) await this.markUnreachableReferents(id);
    }
    for (const n of [...t.inSlotOrder()]) {
      const id = t.ids[n] as string;
      const flags = t.flags(n);
      if (flags & REACHABLE) {
        if (flags & HAS_OBJ || this.inPack(id)) continue;
        const type = await this.printableType(n);
        this.emit({
          kind: "missing",
          stream: "stdout",
          text: `missing ${type} ${this.describe(id)}`,
          objectId: id,
          objectType: type,
        });
        this.errorsFound |= FSCK_ERROR_REACHABLE;
        continue;
      }
      if (!(flags & HAS_OBJ)) continue;
      if (this.showUnreachable) {
        const type = await this.printableType(n);
        this.emit({
          kind: "unreachable",
          stream: "stdout",
          text: `unreachable ${type} ${this.describe(id)}`,
          objectId: id,
          objectType: type,
        });
        continue;
      }
      if (!(flags & USED)) {
        const type = await this.printableType(n);
        if (this.o.dangling) {
          this.emit({
            kind: "dangling",
            stream: "stdout",
            text: `dangling ${type} ${this.describe(id)}`,
            objectId: id,
            objectType: type,
          });
        }
        if (this.o.lostFound) await this.writeLostFound(id, type);
      }
    }
  }

  /** `--lost-found`: a dangling object into `.git/lost-found/{commit,other}/<id>`. */
  private async writeLostFound(id: string, type: string): Promise<void> {
    const files = this.files;
    if (!files) return;
    const dir = pathOf(this.gitDir, "lost-found", type === "commit" ? "commit" : "other");
    await files.mkdir(dir);
    const path = pathOf(dir, id);
    if (type === "blob") {
      const obj = await this.readObject(id);
      if (obj) await files.write(path, obj.content);
    } else {
      await files.write(path, [new TextEncoder().encode(`${id}\n`)]);
    }
  }
}

async function readAll(files: FilesApi, path: string): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let n = 0;
  for await (const c of files.read(path)) {
    parts.push(c);
    n += c.length;
  }
  if (parts.length === 1) return parts[0] as Uint8Array;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

async function readText(files: FilesApi, path: string): Promise<string | undefined> {
  if ((await files.stats(path))?.kind !== "file") return undefined;
  return dec.decode(await readAll(files, path));
}

/** The entries of a reflog file, oldest first: old id, new id and the entry's timestamp. */
function parseReflog(text: string | undefined): Reflog["entries"] {
  const entries: Reflog["entries"] = [];
  for (const line of text?.split("\n") ?? []) {
    const oldId = line.slice(0, 40);
    const newId = line.slice(41, 81);
    if (!OID.test(oldId) || !OID.test(newId)) continue;
    const tab = line.indexOf("\t");
    const ident = tab < 0 ? line.slice(82) : line.slice(82, tab);
    const m = /> (\d+) [+-]\d{4}$/.exec(ident);
    entries.push({ oldId, newId, timestamp: m ? Number(m[1]) : 0 });
  }
  return entries;
}
