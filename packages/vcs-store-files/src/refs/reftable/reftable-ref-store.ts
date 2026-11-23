/**
 * The refs of a repository whose `extensions.refStorage` is `reftable`, read through the
 * `Refs` interface (git's `refs/reftable-backend.c`). Writes are refused until they are
 * implemented (`ReftableWriteUnsupportedError`, before anything changes).
 *
 * @example
 * ```typescript
 * const refs = createReftableRefStore({ files, gitDir: ".git" });
 * await refs.resolve("HEAD"); // HEAD's record in .git/reftable, through to its branch
 * for await (const ref of refs.list("refs/heads/")) console.log(ref.name);
 * await refs.set("refs/heads/x", id); // throws ReftableWriteUnsupportedError
 * ```
 *
 * The layout is git's: the repository's stack in `<common dir>/reftable` holds the shared refs
 * and the main worktree's own (HEAD, the root refs, `refs/bisect/`, `refs/worktree/`,
 * `refs/rewritten/`); a linked worktree's own refs are in `<common dir>/worktrees/<id>/reftable`.
 * `.git/HEAD` is a stub (`ref: refs/heads/.invalid`) for older gits and is never read. A store
 * opened for a linked worktree (`gitDir` its `worktrees/<id>` directory) reads its own refs from
 * its stack and the shared ones from the repository's; any store reads another worktree's as
 * `worktrees/<id>/<ref>` and the main worktree's as `main-worktree/<ref>` (parse_worktree_ref).
 * The pseudo refs `FETCH_HEAD` and `MERGE_HEAD` stay files in the git directory, as git keeps
 * them. Listings give `HEAD` first (when the prefix allows), then the refs under `refs/` in
 * name order: in a linked worktree its own refs merged with the shared ones, its own winning.
 */

import type {
  BatchOptions,
  BatchResult,
  FilesApi,
  ObjectId,
  PackRefsOptions,
  Ref,
  RefCommand,
  RefLogOptions,
  ReflogDeleteOptions,
  ReflogEntry,
  ReflogReader,
  RefRemoveAllOptions,
  RefRemoveOptions,
  Refs,
  RefUpdateResult,
  SymbolicRef,
  SymbolicRefLogOptions,
} from "@statewalker/vcs-core";
import {
  createPeeledTagRef,
  createRef,
  createSymbolicRef,
  isSymbolicRef,
  RefStorage,
} from "@statewalker/vcs-core";
import { joinPath } from "@statewalker/vcs-utils/files";

import { readLooseRef } from "../ref-reader.js";
import { createFileRefStore, type FileRefStore } from "../ref-store.files.js";
import { ReftableWriteUnsupportedError } from "./reftable-errors.js";
import { createReftableStackReader, type ReftableStackReader } from "./reftable-stack.js";
import { compareKeys, type ReftableRefRecord } from "./reftable-table.js";

/** git's symref depth limit while resolving. */
const MAX_SYMREF_DEPTH = 5;
const ZERO_ID = "0000000000000000000000000000000000000000";

/** Options of {@link createReftableRefStore}. */
export interface ReftableRefStoreOptions {
  /** The FilesApi the repository is in */
  files: FilesApi;
  /** The git directory: the repository's, or a linked worktree's (`<common>/worktrees/<id>`) */
  gitDir: string;
  /** The repository's directory (git's common dir); default `gitDir` */
  commonDir?: string;
}

/** git's is_root_ref_syntax: uppercase letters, `-` and `_` only. */
function isRootRefSyntax(name: string): boolean {
  return /^[A-Z_-]*$/.test(name);
}

/** git's is_current_worktree_ref: root ref syntax or a per-worktree prefix. */
function isCurrentWorktreeRef(name: string): boolean {
  return (
    isRootRefSyntax(name) ||
    name.startsWith("refs/worktree/") ||
    name.startsWith("refs/bisect/") ||
    name.startsWith("refs/rewritten/")
  );
}

/** git's is_pseudo_ref: the refs kept as files whatever the ref storage. */
function isPseudoRef(name: string): boolean {
  return name === "FETCH_HEAD" || name === "MERGE_HEAD";
}

type WorktreeRefKind =
  | { kind: "other"; worktree: string; name: string }
  | { kind: "main"; name: string }
  | { kind: "current"; name: string }
  | { kind: "shared"; name: string };

/** git's parse_worktree_ref. */
function parseWorktreeRef(name: string): WorktreeRefKind {
  if (name.startsWith("worktrees/")) {
    const rest = name.slice("worktrees/".length);
    const slash = rest.indexOf("/");
    if (slash < 0) return { kind: "other", worktree: rest, name: "" };
    const bare = rest.slice(slash + 1);
    if (isCurrentWorktreeRef(bare)) {
      return { kind: "other", worktree: rest.slice(0, slash), name: bare };
    }
  }
  if (name.startsWith("main-worktree/")) {
    const bare = name.slice("main-worktree/".length);
    if (isCurrentWorktreeRef(bare)) return { kind: "main", name: bare };
  }
  if (isCurrentWorktreeRef(name)) return { kind: "current", name };
  return { kind: "shared", name };
}

/** git's minutes_to_tz: `-480` is `-0800`. */
function minutesToTz(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  const hhmm = Math.floor(abs / 60) * 100 + (abs % 60);
  return `${sign}${String(hhmm).padStart(4, "0")}`;
}

/** The record as the Refs API gives it, under `name` (the name it was asked by). */
function toRef(name: string, record: ReftableRefRecord): Ref | SymbolicRef | undefined {
  const value = record.value;
  switch (value.type) {
    case "id":
      return createRef(name, value.id, RefStorage.PACKED);
    case "peeled":
      return createPeeledTagRef(name, value.id, value.peeled, RefStorage.PACKED);
    case "symref":
      return createSymbolicRef(name, value.target, RefStorage.PACKED);
    default:
      return undefined;
  }
}

/** The refs of a reftable repository (see the module's notes). */
export function createReftableRefStore(options: ReftableRefStoreOptions): ReftableRefStore {
  return new ReftableRefStore(options);
}

export class ReftableRefStore implements Refs {
  private readonly files: FilesApi;
  private readonly gitDir: string;
  private readonly commonDir: string;
  private readonly main: ReftableStackReader;
  /** This linked worktree's own stack (undefined in the main worktree) */
  private readonly own?: ReftableStackReader;
  private readonly others = new Map<string, ReftableStackReader>();
  /** The `shallow` and grafts files, which stay files */
  private readonly fileState: FileRefStore;

  constructor(options: ReftableRefStoreOptions) {
    this.files = options.files;
    this.gitDir = options.gitDir;
    this.commonDir = options.commonDir ?? options.gitDir;
    this.main = createReftableStackReader(this.files, joinPath(this.commonDir, "reftable"));
    if (this.gitDir !== this.commonDir) {
      this.own = createReftableStackReader(this.files, joinPath(this.gitDir, "reftable"));
    }
    this.fileState = createFileRefStore(this.files, this.commonDir);
  }

  /** The error every write throws: this store reads only. */
  writeRefusal(refName?: string): Error {
    return new ReftableWriteUnsupportedError(refName);
  }

  /** The stack that holds `name`, and the name it has there (git's backend_for). */
  private stackFor(name: string): { stack: ReftableStackReader; name: string } | undefined {
    const parsed = parseWorktreeRef(name);
    switch (parsed.kind) {
      case "other": {
        if (parsed.name === "" || parsed.worktree === "" || parsed.worktree.includes("..")) {
          return undefined;
        }
        let stack = this.others.get(parsed.worktree);
        if (!stack) {
          stack = createReftableStackReader(
            this.files,
            joinPath(this.commonDir, "worktrees", parsed.worktree, "reftable"),
          );
          this.others.set(parsed.worktree, stack);
        }
        return { stack, name: parsed.name };
      }
      case "current":
        return { stack: this.own ?? this.main, name: parsed.name };
      default:
        return { stack: this.main, name: parsed.name };
    }
  }

  async get(name: string): Promise<Ref | SymbolicRef | undefined> {
    if (isPseudoRef(name)) return readLooseRef(this.files, this.gitDir, name);
    const where = this.stackFor(name);
    if (!where) return undefined;
    const record = (await where.stack.read()).getRef(where.name);
    return record ? toRef(name, record) : undefined;
  }

  async resolve(name: string): Promise<Ref | undefined> {
    let current = await this.get(name);
    for (let depth = 0; current && isSymbolicRef(current); depth++) {
      if (depth >= MAX_SYMREF_DEPTH) return undefined;
      current = await this.get(current.target);
    }
    return current as Ref | undefined;
  }

  async has(name: string): Promise<boolean> {
    return (await this.get(name)) !== undefined;
  }

  async *list(prefix = ""): AsyncIterable<Ref | SymbolicRef> {
    if (prefix === "" || "HEAD".startsWith(prefix)) {
      const head = await this.get("HEAD");
      if (head) yield head;
    }
    // only refs under refs/ are listed: seek the longer of the prefix and "refs/"
    const seek = prefix.startsWith("refs/") ? prefix : "refs/".startsWith(prefix) ? "refs/" : "";
    if (seek === "") return;
    const main = await this.main.read();
    const own = this.own ? await this.own.read() : undefined;
    if (!own) {
      for (const record of main.refs(seek)) {
        const ref = toRef(record.name, record);
        if (ref) yield ref;
      }
      return;
    }
    // git's ref_iterator_select: the worktree's refs, and the repository's shared ones (the
    // worktree's own winning on equal names)
    const mine = own.refs(seek);
    const shared = (function* () {
      for (const r of main.refs(seek)) if (parseWorktreeRef(r.name).kind === "shared") yield r;
    })();
    let a = mine.next();
    let b = shared.next();
    while (!a.done || !b.done) {
      let record: ReftableRefRecord;
      if (!a.done && (b.done || compareKeys(a.value.key, b.value.key) <= 0)) {
        record = a.value;
        if (!b.done && compareKeys(a.value.key, b.value.key) === 0) b = shared.next();
        a = mine.next();
      } else {
        record = (b as IteratorYieldResult<ReftableRefRecord>).value;
        b = shared.next();
      }
      const ref = toRef(record.name, record);
      if (ref) yield ref;
    }
  }

  async getReflog(name: string): Promise<ReflogReader | undefined> {
    const where = this.stackFor(name);
    if (!where) return undefined;
    // a snapshot of the stack's tables; each read below walks the reflog lazily again,
    // decoding only the entries it returns (and those before them)
    const view = await where.stack.read();
    const refName = where.name;
    if (!view.hasLogs(refName)) return undefined;
    function* entries(): Generator<ReflogEntry> {
      for (const log of view.logs(refName)) {
        const u = log.update;
        // both ids zero: git's reflog existence marker, never shown
        if (!u || (u.oldId === ZERO_ID && u.newId === ZERO_ID)) continue;
        yield {
          oldId: u.oldId,
          newId: u.newId,
          who: {
            name: u.name,
            email: u.email,
            timestamp: u.time,
            tzOffset: minutesToTz(u.tzOffset),
          },
          comment: u.message.endsWith("\n") ? u.message.slice(0, -1) : u.message,
        };
      }
    }
    const take = (max: number): ReflogEntry[] => {
      const out: ReflogEntry[] = [];
      if (max <= 0) return out;
      for (const entry of entries()) {
        out.push(entry);
        if (out.length >= max) break;
      }
      return out;
    };
    return {
      getLastEntry: async () => take(1)[0],
      getReverseEntries: async (max = Number.MAX_SAFE_INTEGER) => take(max),
      getReverseEntry: async (index) => (index < 0 ? undefined : take(index + 1)[index]),
    };
  }

  getShallow(): Promise<ObjectId[]> {
    return this.fileState.getShallow();
  }

  readGrafts(): Promise<string | undefined> {
    return this.fileState.readGrafts();
  }

  // Writes: refused until the reftable writer exists, before anything changes

  async set(name: string, _objectId: ObjectId, _log?: RefLogOptions): Promise<void> {
    throw this.writeRefusal(name);
  }

  async setSymbolic(name: string, _target: string, _log?: SymbolicRefLogOptions): Promise<void> {
    throw this.writeRefusal(name);
  }

  async remove(name: string, _options?: RefRemoveOptions): Promise<boolean> {
    throw this.writeRefusal(name);
  }

  async removeAll(names: string[], _options?: RefRemoveAllOptions): Promise<void> {
    throw this.writeRefusal(names[0]);
  }

  async batch(commands: RefCommand[], _options?: BatchOptions): Promise<BatchResult> {
    throw this.writeRefusal(commands[0]?.name);
  }

  async compareAndSwap(
    name: string,
    _expected: ObjectId | undefined,
    _newValue: ObjectId,
  ): Promise<RefUpdateResult> {
    throw this.writeRefusal(name);
  }

  async setShallow(_commits: Iterable<ObjectId>, _expected?: Iterable<ObjectId>): Promise<void> {
    throw this.writeRefusal();
  }

  /** Nothing to create for reading; a stack without HEAD then fails at HEAD's write. */
  async initialize(): Promise<void> {}

  async optimize(): Promise<void> {
    throw this.writeRefusal();
  }

  async deleteReflogEntry(
    name: string,
    _index: number,
    _options?: ReflogDeleteOptions,
  ): Promise<number> {
    throw this.writeRefusal(name);
  }

  async packRefs(_refNames: string[], _options?: PackRefsOptions): Promise<number> {
    throw this.writeRefusal();
  }
}
