/**
 * What git checks after a fetch or clone receives objects, before any ref names them:
 *
 * - index-pack's `--strict` (`fetch.fsckObjects` / `transfer.fsckObjects`): every received
 *   object passes fsck, and every object a received object names was received or is here
 *   ("did not receive expected object"); `--check-self-contained-and-connected` (a clone
 *   without `--depth` or a filter) does the second part and says whether the pack names
 *   nothing outside itself;
 * - connected.c's `check_connected` (`rev-list --objects <tips> --not --all --alternate-refs`):
 *   every object the new ref tips reach is here, down to what the existing refs (and the
 *   alternates' refs) reach.
 */

import type { PackEntryInfo } from "@statewalker/vcs-core";
import type { GitObjectTypeName, RepositoryFacade } from "../api/repository-facade.js";
import { PushConnectivity } from "../fsm/push/index.js";
import { TransportError } from "../protocol/index.js";

/**
 * A fetch or clone stopped by a check of what it received; nothing was written to the refs.
 * `lines` are git's stderr lines for it, `exitCode` git's exit code.
 *
 * - `pack`: index-pack refused the pack (an fsck error, an object it names missing); the lines
 *   end with git's `fatal: index-pack failed` (or `fatal: fetch-pack: invalid index-pack
 *   output` for a kept pack); exit 128.
 * - `deepen`: fetch-pack's check of a deepening fetch failed; the lines are rev-list's and
 *   `error: remote did not send all necessary objects`; exit 1. The shallow file is unchanged.
 * - `refs`: the check of the new ref tips failed; the lines are rev-list's only: `git fetch`
 *   adds `error: <url> did not send all necessary objects` (exit 1), `git clone` `fatal: remote
 *   did not send all necessary objects` (exit 128).
 */
export class FetchCheckError extends TransportError {
  constructor(
    readonly check: "pack" | "deepen" | "refs",
    readonly lines: string[],
    readonly exitCode: number,
  ) {
    super(lines.join("\n"));
    this.name = "FetchCheckError";
  }
}

const TYPE_CODES: Record<GitObjectTypeName, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const TYPE_BY_CODE: (GitObjectTypeName | undefined)[] = [
  undefined,
  "commit",
  "tree",
  "blob",
  "tag",
];

function hexDigit(c: number): number {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 97 && c <= 102) return c - 87;
  if (c >= 65 && c <= 70) return c - 55;
  return -1;
}

/**
 * The objects a pack brought, with their place in it, kept compactly (21 bytes and an index
 * each): the order index-pack checks them in, and a set to ask whether an id was received.
 */
export class ReceivedObjects {
  private ids = new Uint8Array(20 * 256);
  private types = new Uint8Array(256);
  private entries = new Uint32Array(256);
  private deltas = new Uint8Array(256);
  private slots = new Int32Array(512);
  private n = 0;

  /** How many objects were received. */
  get size(): number {
    return this.n;
  }

  /** Records a received object (the pack import's `onObject`). */
  add(id: string, type: GitObjectTypeName, entry: PackEntryInfo): void {
    if (id.length !== 40) return;
    if (this.n === this.types.length) this.grow();
    const at = this.n * 20;
    for (let i = 0; i < 20; i++) {
      this.ids[at + i] = (hexDigit(id.charCodeAt(2 * i)) << 4) | hexDigit(id.charCodeAt(2 * i + 1));
    }
    if (this.find(this.ids.subarray(at, at + 20)) >= 0) return; // a duplicate entry
    this.types[this.n] = TYPE_CODES[type];
    this.entries[this.n] = entry.index;
    this.deltas[this.n] = entry.delta ? 1 : 0;
    this.n++;
    if (this.n * 2 > this.slots.length) this.rehash(this.slots.length * 2);
    else this.insert(this.n - 1);
  }

  /** Whether the id at `raw[at..at+20)` came with the pack. */
  hasRaw(raw: Uint8Array, at: number): boolean {
    return this.find(raw, at) >= 0;
  }

  /** How many of the received objects are commits, trees or tags. */
  get nonBlobs(): number {
    let n = 0;
    for (let i = 0; i < this.n; i++) if (this.types[i] !== 3) n++;
    return n;
  }

  /** Whether `id` came with the pack. */
  has(id: string): boolean {
    if (id.length !== 40) return false;
    const raw = new Uint8Array(20);
    for (let i = 0; i < 20; i++) {
      const hi = hexDigit(id.charCodeAt(2 * i));
      const lo = hexDigit(id.charCodeAt(2 * i + 1));
      if (hi < 0 || lo < 0) return false;
      raw[i] = (hi << 4) | lo;
    }
    return this.find(raw) >= 0;
  }

  /**
   * The received objects in index-pack's order: the entries sent whole first, then the
   * deltas, each group in pack order.
   */
  *ordered(): Generator<{ id: string; type: GitObjectTypeName }> {
    const order = new Uint32Array(this.n);
    for (let i = 0; i < this.n; i++) order[i] = i;
    order.sort((a, b) =>
      this.deltas[a] !== this.deltas[b]
        ? (this.deltas[a] as number) - (this.deltas[b] as number)
        : (this.entries[a] as number) - (this.entries[b] as number),
    );
    for (const i of order) {
      let id = "";
      for (let k = 0; k < 20; k++) {
        id += (this.ids[i * 20 + k] as number).toString(16).padStart(2, "0");
      }
      yield { id, type: TYPE_BY_CODE[this.types[i] as number] as GitObjectTypeName };
    }
  }

  private grow(): void {
    const cap = this.types.length * 2;
    const ids = new Uint8Array(cap * 20);
    ids.set(this.ids);
    this.ids = ids;
    for (const key of ["types", "deltas"] as const) {
      const next = new Uint8Array(cap);
      next.set(this[key]);
      this[key] = next;
    }
    const entries = new Uint32Array(cap);
    entries.set(this.entries);
    this.entries = entries;
  }

  private hash(raw: Uint8Array, at = 0): number {
    return (
      (((raw[at] as number) << 24) |
        ((raw[at + 1] as number) << 16) |
        ((raw[at + 2] as number) << 8) |
        (raw[at + 3] as number)) >>>
      0
    );
  }

  private find(raw: Uint8Array, rawAt = 0): number {
    const mask = this.slots.length - 1;
    for (let s = this.hash(raw, rawAt) & mask; ; s = (s + 1) & mask) {
      const v = this.slots[s] as number;
      if (v === 0) return -1;
      const at = (v - 1) * 20;
      let same = true;
      for (let k = 0; k < 20; k++) {
        if (this.ids[at + k] !== raw[rawAt + k]) {
          same = false;
          break;
        }
      }
      if (same) return v - 1;
    }
  }

  private insert(i: number): void {
    const mask = this.slots.length - 1;
    let s = this.hash(this.ids, i * 20) & mask;
    while (this.slots[s] !== 0) s = (s + 1) & mask;
    this.slots[s] = i + 1;
  }

  private rehash(size: number): void {
    this.slots = new Int32Array(size);
    for (let i = 0; i < this.n; i++) this.insert(i);
  }
}

/** A set of raw 20-byte object ids, open addressing over one byte array. */
class RawIdSet {
  private ids = new Uint8Array(20 * 256);
  private slots = new Int32Array(512);
  private n = 0;

  get size(): number {
    return this.n;
  }

  /** Adds the id at `raw[at..at+20)`; false when it was there already. */
  add(raw: Uint8Array, at: number): boolean {
    const mask = this.slots.length - 1;
    let s = idHash(raw, at) & mask;
    for (; ; s = (s + 1) & mask) {
      const v = this.slots[s] as number;
      if (v === 0) break;
      if (sameId(this.ids, (v - 1) * 20, raw, at)) return false;
    }
    if (this.n * 20 === this.ids.length) {
      const ids = new Uint8Array(this.ids.length * 2);
      ids.set(this.ids);
      this.ids = ids;
    }
    this.ids.set(raw.subarray(at, at + 20), this.n * 20);
    this.n++;
    if (this.n * 2 > this.slots.length) {
      this.slots = new Int32Array(this.slots.length * 2);
      const m = this.slots.length - 1;
      for (let i = 0; i < this.n; i++) {
        let t = idHash(this.ids, i * 20) & m;
        while (this.slots[t] !== 0) t = (t + 1) & m;
        this.slots[t] = i + 1;
      }
    } else {
      this.slots[s] = this.n;
    }
    return true;
  }

  /** Calls `fn` with each id (the shared array and its offset), in insertion order. */
  forEach(fn: (raw: Uint8Array, at: number) => void): void {
    for (let i = 0; i < this.n; i++) fn(this.ids, i * 20);
  }
}

function idHash(raw: Uint8Array, at: number): number {
  return (
    (((raw[at] as number) << 24) |
      ((raw[at + 1] as number) << 16) |
      ((raw[at + 2] as number) << 8) |
      (raw[at + 3] as number)) >>>
    0
  );
}

function sameId(a: Uint8Array, ai: number, b: Uint8Array, bi: number): boolean {
  for (let k = 0; k < 20; k++) if (a[ai + k] !== b[bi + k]) return false;
  return true;
}

function rawToHex(raw: Uint8Array, at: number): string {
  let id = "";
  for (let k = 0; k < 20; k++) id += (raw[at + k] as number).toString(16).padStart(2, "0");
  return id;
}

/** Parses 40 hex digits of `content` at `at` into `out`; false when they are not hex. */
function parseHexId(content: Uint8Array, at: number, out: Uint8Array): boolean {
  if (at + 40 > content.length) return false;
  for (let i = 0; i < 20; i++) {
    const hi = hexDigit(content[at + 2 * i] as number);
    const lo = hexDigit(content[at + 2 * i + 1] as number);
    if (hi < 0 || lo < 0) return false;
    out[i] = (hi << 4) | lo;
  }
  return true;
}

/** Whether `content` has the ASCII `word` at `at`. */
function startsWith(content: Uint8Array, at: number, word: string): boolean {
  if (at + word.length > content.length) return false;
  for (let i = 0; i < word.length; i++) if (content[at + i] !== word.charCodeAt(i)) return false;
  return true;
}

/**
 * The objects the received commits, trees and tags name, read from their content while the
 * import holds it (the import's `onContent`), as index-pack's `fsck_walk` marks them
 * (`FLAG_LINK`) when it hashes each object: a commit's tree and parents (not those of a
 * shallow commit), a tree's entries (not gitlinks), a tag's object. Checking them afterwards
 * reads nothing back from the store.
 */
export class ReceivedLinks {
  private readonly links = new RawIdSet();
  private readonly reported = new RawIdSet();
  private readonly scratch = new Uint8Array(20);
  private shallow: ReadonlySet<string> | undefined;

  /** `shallow` gives the shallow commits index-pack is given, asked once the first commit comes. */
  constructor(private readonly shallowOf: () => ReadonlySet<string>) {}

  /** How many distinct objects were reported */
  get reportedCount(): number {
    return this.reported.size;
  }

  /** Records the links of a received object (the import's `onContent`). */
  add(id: string, type: GitObjectTypeName, content: Uint8Array): void {
    if (type === "blob" || !parseHexIdString(id, this.scratch)) return;
    if (!this.reported.add(this.scratch, 0)) return; // a duplicate entry
    if (type === "commit") {
      let at = 0;
      if (startsWith(content, at, "tree ") && parseHexId(content, at + 5, this.scratch)) {
        this.links.add(this.scratch, 0);
        at += 46;
      }
      this.shallow ??= this.shallowOf();
      if (this.shallow.has(id)) return;
      while (startsWith(content, at, "parent ") && parseHexId(content, at + 7, this.scratch)) {
        this.links.add(this.scratch, 0);
        at += 48;
      }
    } else if (type === "tag") {
      if (startsWith(content, 0, "object ") && parseHexId(content, 7, this.scratch))
        this.links.add(this.scratch, 0);
    } else {
      let at = 0;
      while (at < content.length) {
        let mode = 0;
        while (at < content.length && content[at] !== 32) {
          mode = mode * 8 + ((content[at] as number) - 48);
          at++;
        }
        while (at < content.length && content[at] !== 0) at++;
        at++;
        if (at + 20 > content.length) break;
        if ((mode & 0o170000) !== 0o160000) this.links.add(content, at); // gitlinks: not followed
        at += 20;
      }
    }
  }

  /** Calls `fn` with each linked id */
  forEach(fn: (raw: Uint8Array, at: number) => void): void {
    this.links.forEach(fn);
  }
}

function parseHexIdString(id: string, out: Uint8Array): boolean {
  if (id.length !== 40) return false;
  for (let i = 0; i < 20; i++) {
    const hi = hexDigit(id.charCodeAt(2 * i));
    const lo = hexDigit(id.charCodeAt(2 * i + 1));
    if (hi < 0 || lo < 0) return false;
    out[i] = (hi << 4) | lo;
  }
  return true;
}

/**
 * fsck of received objects, as index-pack's `--strict` runs it (the checks themselves are the
 * caller's: vcs-commands' `fsck` checks with `fetch.fsck.<msg-id>` and `fetch.fsck.skipList`).
 */
export interface ReceivedObjectsFsck {
  /** Why index-pack dies before reading the pack (an unreadable `fetch.fsck.skipList`) */
  startError?: string;
  /**
   * index-pack's fsck of one object (`sha1_object`): its report lines (`error: object <id>:
   * <msg-id>: <message>`, warnings too) added to `lines`; true when one is an error
   */
  checkObject(id: string, type: GitObjectTypeName, content: Uint8Array, lines: string[]): boolean;
  /**
   * Whether the fsck of the blob `id` would look at its content (a `.gitmodules` or
   * `.gitattributes` blob a checked tree named): blobs it would not are never read. Absent:
   * every blob is read and checked.
   */
  wantsBlob?(id: string): boolean;
  /** The `.gitmodules` / `.gitattributes` blobs a tree named that were not checked yet */
  pendingBlobs(): string[];
  /** index-pack's `fsck_finish` of one of them, read from the repository (or absent) */
  checkPendingBlob(
    id: string,
    object: { type: GitObjectTypeName; content: Uint8Array } | undefined,
    lines: string[],
  ): boolean;
}

/** Options of {@link checkReceivedPack}. */
export interface ReceivedPackCheckOptions {
  /** `fetch.fsckObjects`: fsck each received object */
  fsck?: ReceivedObjectsFsck;
  /** Check that every object a received object names was received or is here */
  links: boolean;
  /**
   * The links the import read from the objects' content: used when it reported every received
   * commit, tree and tag, else the objects are read back through `repository`
   */
  receivedLinks?: ReceivedLinks;
  /** The shallow commits index-pack is given (`--shallow-file`): their parents are not named */
  shallow: ReadonlySet<string>;
  /** Whether the pack was kept (git then reads index-pack's output, and words its death so) */
  kept: boolean;
}

/** What {@link checkReceivedPack} found, when nothing stopped the fetch. */
export interface ReceivedPackCheck {
  /** The fsck warnings index-pack printed */
  messages: string[];
  /** Whether every object a received object names was received (links were checked) */
  selfContained: boolean;
}

/**
 * index-pack's `--strict` / `--check-self-contained-and-connected` over the objects of one
 * pack, read through `repository` (where the received objects are visible, a quarantine's
 * view): fsck of each object in index-pack's order (stopping at the first with an error),
 * then every named object received or here (`did not receive expected object`), then the
 * `.gitmodules` blobs found and not checked yet. Throws {@link FetchCheckError} (`pack`).
 */
export async function checkReceivedPack(
  repository: RepositoryFacade,
  received: ReceivedObjects,
  options: ReceivedPackCheckOptions,
): Promise<ReceivedPackCheck> {
  const lines: string[] = [];
  const tail = options.kept
    ? "fatal: fetch-pack: invalid index-pack output"
    : "fatal: index-pack failed";
  const fail = (line: string): never => {
    throw new FetchCheckError("pack", [...lines, line, tail], 128);
  };
  const fsck = options.fsck;
  if (fsck?.startError) fail(fsck.startError);
  if (fsck && repository.loadObject) {
    for (const { id, type } of received.ordered()) {
      if (type === "blob" && fsck.wantsBlob && !fsck.wantsBlob(id)) continue;
      const object = await repository.loadObject(id);
      if (!object) continue;
      if (fsck.checkObject(id, type, object.content, lines))
        fail("fatal: fsck error in packed object");
    }
  }
  let selfContained = true;
  if (options.links) {
    const present = new Set<string>();
    const missing = new Set<string>();
    const check = async (link: string) => {
      if (received.has(link)) return;
      selfContained = false;
      if (present.has(link) || missing.has(link)) return;
      if (await repository.has(link)) present.add(link);
      else missing.add(link);
    };
    const collected = options.receivedLinks;
    if (collected && collected.reportedCount >= received.nonBlobs) {
      const foreign: string[] = [];
      collected.forEach((raw, at) => {
        if (!received.hasRaw(raw, at)) foreign.push(rawToHex(raw, at));
      });
      for (const link of foreign) await check(link);
    } else {
      for (const { id, type } of received.ordered()) {
        if (type === "commit") {
          const info = await repository.getCommitInfo?.(id);
          if (!info) continue;
          if (info.tree) await check(info.tree);
          if (!options.shallow.has(id)) for (const parent of info.parents) await check(parent);
        } else if (type === "tree") {
          for (const entry of (await repository.getTreeEntries?.(id)) ?? []) {
            if ((entry.mode & 0o170000) === 0o160000) continue; // a gitlink: not followed
            await check(entry.id);
          }
        } else if (type === "tag") {
          const tag = await repository.getTagInfo?.(id);
          if (tag) await check(tag.object);
        }
      }
    }
    if (missing.size > 0) {
      const first = firstInObjectTable(missing, received.size + present.size + missing.size);
      fail(`fatal: did not receive expected object ${first}`);
    }
  }
  if (fsck) {
    for (const id of fsck.pendingBlobs()) {
      const object = await repository.loadObject?.(id);
      // a blob found nowhere: index-pack hands it to fetch-pack, whose fsck_finish ignores it
      if (!object) continue;
      if (fsck.checkPendingBlob(id, object, lines)) fail("fatal: fsck error in pack objects");
    }
  }
  return { messages: lines, selfContained };
}

/**
 * The missing object index-pack's `check_objects` reports: it goes through git's object hash
 * table slot by slot, so the first missing object is the one in the lowest slot (`oidhash`,
 * the id's first four bytes as a little-endian number, masked by the table size: a power of
 * two of at least 32, doubled whenever it would be half full) among the `total` objects the
 * check created. Ties (a collision, which git resolves by probing) go to the object named
 * first.
 */
function firstInObjectTable(missing: Set<string>, total: number): string {
  let size = 0;
  for (let nr = 0; nr < total; nr++) if (size - 1 <= nr * 2) size = size < 32 ? 32 : size * 2;
  const mask = size - 1;
  let best: string | undefined;
  let bestSlot = Number.POSITIVE_INFINITY;
  for (const id of missing) {
    const hash =
      (Number.parseInt(id.slice(0, 2), 16) |
        (Number.parseInt(id.slice(2, 4), 16) << 8) |
        (Number.parseInt(id.slice(4, 6), 16) << 16) |
        (Number.parseInt(id.slice(6, 8), 16) << 24)) >>>
      0;
    const slot = hash & mask;
    if (slot < bestSlot) {
      bestSlot = slot;
      best = id;
    }
  }
  return best as string;
}

/** Options of {@link connectivityErrors}. */
export interface ConnectivityCheckOptions {
  /** The existing ref values (and the alternates' refs): history known to be complete */
  known: Iterable<string>;
  /** The shallow commits (their parents are not followed) */
  shallow: ReadonlySet<string>;
  /**
   * A deepening fetch: git checks without `--not --all` (the history below the old shallow
   * commits is new), so the walk does not stop at the existing refs
   */
  deepening?: boolean;
}

/**
 * git's `check_connected`: whether every object `tips` reach is here, down to `known`.
 * Returns undefined when it is, else the lines `git rev-list --objects --stdin --not --all`
 * prints where it stops (`fatal: bad object <id>`, `error: Could not read <id>` with `fatal:
 * revision walk setup failed` or `fatal: Failed to traverse parents of commit <id>`, `fatal:
 * bad tree object <id>`, `fatal: missing blob object '<id>'`).
 *
 * The walk is receive-pack's (`PushConnectivity`): it stops at the known tips and reads each
 * new commit's tree against its first parent's, so a fetch on top of the existing refs reads
 * only what it brought.
 */
export async function connectivityErrors(
  repository: RepositoryFacade,
  tips: Iterable<string>,
  options: ConnectivityCheckOptions,
): Promise<string[] | undefined> {
  const list = [...new Set(tips)];
  if (list.length === 0) return undefined;
  const known = options.deepening ? [] : [...new Set(options.known)];
  const conn = new PushConnectivity(repository, known, { shallow: options.shallow });
  await conn.analyze(list);
  if (list.every((tip) => conn.verdict(tip).ok)) return undefined;
  const failure = conn.failure() ?? { kind: "object" as const, id: list[0] as string };
  switch (failure.kind) {
    case "object":
      return [`fatal: bad object ${failure.id}`];
    case "tree":
      return [`fatal: bad tree object ${failure.id}`];
    case "blob":
      return [`fatal: missing blob object '${failure.id}'`];
    case "commit": {
      // with an uninteresting commit (an existing ref) rev-list limits the walk first
      // (limit_list), which fails as a whole; else the lazy walk dies at the commit naming it
      const limited = await anyCommit(repository, known);
      return [
        `error: Could not read ${failure.id}`,
        limited || failure.child === undefined
          ? "fatal: revision walk setup failed"
          : `fatal: Failed to traverse parents of commit ${failure.child}`,
      ];
    }
  }
}

/** Whether one of `ids` is (or peels to) a commit that is here. */
async function anyCommit(repository: RepositoryFacade, ids: readonly string[]): Promise<boolean> {
  for (const start of ids) {
    let id: string | undefined = start;
    for (let depth = 0; id && depth < 16; depth++) {
      if (await repository.getCommitInfo?.(id, { checkExists: true })) return true;
      id = (await repository.getTagInfo?.(id))?.object;
    }
  }
  return false;
}
