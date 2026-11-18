import type { Blobs, ObjectId, TreeEntry } from "@statewalker/vcs-core";

import type { CommandTrees } from "../git-command.js";

/**
 * A notes tree as git's notes.c holds it in memory: a non-balancing 16-tree keyed by the
 * nibbles of the annotated object's id, whose leaves are notes or not-yet-read subtrees of
 * the stored tree (read when a lookup or a change reaches them), and the entries that are no
 * notes (kept and written back). Written back, it takes git's fanout (`determine_fanout`):
 * notes move into 2-digit directories once every slot of a level is taken, so the trees
 * written are those native git writes for the same history of changes.
 *
 * @example
 * ```typescript
 * const t = await NotesTree.load({ blobs, trees }, treeId);
 * await t.add(commitId, noteBlobId, combineNotesOverwrite);
 * const newTree = await t.write();
 * ```
 */

const NULL_ID = "0".repeat(40);
const RAW = 20;
const HEX = 40;

const PTR_NULL = 0;
const PTR_INTERNAL = 1;
const PTR_NOTE = 2;
const PTR_SUBTREE = 3;

interface IntNode {
  type: typeof PTR_INTERNAL;
  a: Ptr[];
}

/**
 * A note (key: the object's id) or a subtree (key: the prefix, padded with zeros, its last
 * byte the prefix length in bytes, as notes.c keeps it).
 */
interface Leaf {
  type: typeof PTR_NOTE | typeof PTR_SUBTREE;
  key: string;
  val: ObjectId;
}

type Ptr = IntNode | Leaf | null;

interface NonNote {
  path: string;
  mode: number;
  id: ObjectId;
}

/** How a note added over an existing one combines with it (notes.h's combine_notes_fn). */
export type CombineNotes = (
  stores: NotesStores,
  cur: ObjectId,
  next: ObjectId,
) => Promise<ObjectId>;

/** The object stores a notes tree reads and writes. */
export interface NotesStores {
  blobs: Blobs;
  trees: CommandTrees;
}

const typeOf = (p: Ptr): number => (p === null ? PTR_NULL : p.type);
const nibble = (n: number, key: string): number => Number.parseInt(key[n] ?? "0", 16);
const prefixLength = (subtreeKey: string): number => Number.parseInt(subtreeKey.slice(HEX - 2), 16);
/** SUBTREE_SHA1_PREFIXCMP: whether `key` starts with the prefix of `subtree` (0: it does). */
const prefixMatches = (key: string, subtreeKey: string): boolean => {
  const len = prefixLength(subtreeKey) * 2;
  return key.slice(0, len) === subtreeKey.slice(0, len);
};
const isHex = (s: string): boolean => /^[0-9a-fA-F]*$/.test(s);
const isRegular = (mode: number): boolean => (mode & 0o170000) === 0o100000;
const isDir = (mode: number): boolean => (mode & 0o170000) === 0o040000;
const newNode = (): IntNode => ({ type: PTR_INTERNAL, a: new Array<Ptr>(16).fill(null) });

/** git's strcmp on paths: byte order. */
function compareBytes(a: string, b: string): number {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    if (x[i] !== y[i]) return (x[i] as number) - (y[i] as number);
  }
  return x.length - y.length;
}

async function readBytes(blobs: Blobs, id: ObjectId): Promise<Uint8Array | undefined> {
  if (id === NULL_ID) return undefined;
  const content = await blobs.load(id).catch(() => undefined);
  if (!content) return undefined;
  const chunks: Uint8Array[] = [];
  for await (const chunk of content) chunks.push(chunk);
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/** combine_notes_overwrite: the new note replaces the one there. */
export const combineNotesOverwrite: CombineNotes = async (_s, _cur, next) => next;

/** combine_notes_ignore: the note there stays. */
export const combineNotesIgnore: CombineNotes = async (_s, cur) => cur;

/**
 * combine_notes_concatenate: the two notes joined by a blank line (the current one's final
 * newline dropped); an empty or missing side gives the other.
 */
export const combineNotesConcatenate: CombineNotes = async (stores, cur, next) => {
  const nextMsg = await readBytes(stores.blobs, next);
  if (!nextMsg || nextMsg.length === 0) return cur;
  const curMsg = await readBytes(stores.blobs, cur);
  if (!curMsg || curMsg.length === 0) return next;
  const curLen = curMsg[curMsg.length - 1] === 0x0a ? curMsg.length - 1 : curMsg.length;
  const buf = new Uint8Array(curLen + 2 + nextMsg.length);
  buf.set(curMsg.subarray(0, curLen), 0);
  buf[curLen] = 0x0a;
  buf[curLen + 1] = 0x0a;
  buf.set(nextMsg, curLen + 2);
  return stores.blobs.store([buf]);
};

/** git's string_list_split on "\n" of a note's bytes (latin1: byte per character). */
async function noteLines(stores: NotesStores, id: ObjectId): Promise<string[]> {
  const bytes = await readBytes(stores.blobs, id);
  if (!bytes || bytes.length === 0) return [];
  let text = "";
  for (const b of bytes) text += String.fromCharCode(b);
  return text.split("\n");
}

/**
 * combine_notes_cat_sort_uniq: the lines of both notes, empty ones dropped, sorted (byte
 * order) and unique, each ended by a newline.
 */
export const combineNotesCatSortUniq: CombineNotes = async (stores, cur, next) => {
  const lines = [...(await noteLines(stores, cur)), ...(await noteLines(stores, next))].filter(
    (l) => l !== "",
  );
  lines.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const unique = lines.filter((l, i) => i === 0 || l !== lines[i - 1]);
  const text = unique.map((l) => `${l}\n`).join("");
  const buf = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) buf[i] = text.charCodeAt(i);
  return stores.blobs.store([buf]);
};

/** notes-utils.c's parse_combine_notes_fn (case-insensitive), undefined for another name. */
export function parseCombineNotes(name: string): CombineNotes | undefined {
  switch (name.toLowerCase()) {
    case "overwrite":
      return combineNotesOverwrite;
    case "ignore":
      return combineNotesIgnore;
    case "concatenate":
      return combineNotesConcatenate;
    case "cat_sort_uniq":
      return combineNotesCatSortUniq;
    default:
      return undefined;
  }
}

/** for_each_note flags (notes.h). */
export const FOR_EACH_NOTE_DONT_UNPACK_SUBTREES = 1;
export const FOR_EACH_NOTE_YIELD_SUBTREES = 2;

/** A for_each_note callback: true stops the walk. */
export type EachNote = (
  object: string,
  note: ObjectId,
  path: string,
) => Promise<boolean | undefined>;

interface WriteStack {
  next?: WriteStack;
  entries: TreeEntry[];
  /** The directory being written in `next` ("" when none) */
  path: string;
}

/** notes.c's in-memory notes tree (struct notes_tree). */
export class NotesTree {
  private readonly root: IntNode = newNode();
  private readonly nonNotes: NonNote[] = [];
  /** A change was made since loading (t->dirty) */
  dirty = false;

  private constructor(
    private readonly stores: NotesStores,
    /** The tree's combine function (t->combine_notes) */
    readonly combine: CombineNotes,
  ) {}

  /**
   * init_notes's load: the stored tree `treeId` as an unread subtree of the root (read
   * one level now); an empty tree without `treeId`.
   */
  static async load(
    stores: NotesStores,
    treeId: ObjectId | undefined,
    combine: CombineNotes = combineNotesConcatenate,
  ): Promise<NotesTree> {
    const t = new NotesTree(stores, combine);
    if (treeId) await t.loadSubtree({ type: PTR_SUBTREE, key: NULL_ID, val: treeId }, t.root, 0);
    return t;
  }

  /** get_note: the note of `object`, undefined when it has none. */
  async get(object: ObjectId): Promise<ObjectId | undefined> {
    const found = await this.search(this.root, 0, object);
    const p = found.node.a[found.i] ?? null;
    if (p !== null && p.type === PTR_NOTE && p.key === object) return p.val;
    return undefined;
  }

  /** add_note: `note` for `object`, combined with one there (default: the tree's). */
  async add(object: ObjectId, note: ObjectId, combine?: CombineNotes): Promise<void> {
    this.dirty = true;
    await this.insert(
      this.root,
      0,
      { type: PTR_NOTE, key: object, val: note },
      combine ?? this.combine,
    );
  }

  /** remove_note: whether `object` had a note (then removed). */
  async remove(object: ObjectId): Promise<boolean> {
    const removed = await this.removeLeaf(this.root, 0, object);
    if (removed === undefined) return false;
    this.dirty = true;
    return true;
  }

  /**
   * copy_note: the note of `from` copied to `to` (`to`'s removed when `from` has none);
   * false when `to` has one and `force` is not set.
   */
  async copy(
    from: ObjectId,
    to: ObjectId,
    force: boolean,
    combine?: CombineNotes,
  ): Promise<boolean> {
    const note = await this.get(from);
    const existing = await this.get(to);
    if (!force && existing) return false;
    if (note) await this.add(to, note, combine);
    else if (existing) await this.add(to, NULL_ID, combine);
    return true;
  }

  /** for_each_note: the notes (and with the flags, subtrees) in id order. */
  async forEach(flags: number, fn: EachNote): Promise<boolean> {
    return this.forEachHelper(this.root, 0, 0, flags, fn);
  }

  /**
   * write_notes_tree: the tree objects written, the root's id.
   *
   * The non-notes are woven in as git weaves them: after the last one written (nn_prev),
   * those up to each note's path. A subtree the walk reads meanwhile (one deeper than the
   * fanout) can bring a non-note that sorts before the last one written: git never goes
   * back for it, so it is dropped from the tree written, here too.
   *
   * Known difference: git writes each tree's entries in the order it weaves them, and that
   * order is not always git's tree order (`x` and `x-y` beside a directory `x`, or a
   * non-note of a subtree read late that sorts before an entry already written); git then
   * writes an unsorted tree. Trees here go through the tree store, which writes its entries
   * sorted (there is no writer of raw entry order), so such a tree gets another id.
   */
  async write(): Promise<ObjectId> {
    const root: WriteStack = { entries: [], path: "" };
    /** nn_prev: the last non-note woven in, and where it was in the list then */
    let prev: NonNote | undefined;
    let prevIndex = -1;
    const writeNonNotesUntil = async (notePath: string | undefined) => {
      // the entry after nn_prev (inserts before it shift its index)
      if (prev !== undefined && this.nonNotes[prevIndex] !== prev) {
        prevIndex = this.nonNotes.indexOf(prev);
      }
      let i = prevIndex + 1;
      while (i < this.nonNotes.length) {
        const n = this.nonNotes[i] as NonNote;
        const cmp = notePath === undefined ? -1 : compareBytes(n.path, notePath);
        if (notePath !== undefined && cmp > 0) break;
        // prefer note to non-note
        if (!(notePath !== undefined && cmp === 0)) {
          await this.writeEntry(root, n.path, n.mode, n.id);
        }
        prev = n;
        prevIndex = i;
        i++;
      }
    };
    await this.forEach(
      FOR_EACH_NOTE_DONT_UNPACK_SUBTREES | FOR_EACH_NOTE_YIELD_SUBTREES,
      async (_object, note, path) => {
        let notePath = path;
        let mode = 0o100644;
        if (notePath.endsWith("/")) {
          notePath = notePath.slice(0, -1);
          mode = 0o040000;
        }
        await writeNonNotesUntil(notePath);
        await this.writeEntry(root, notePath, mode, note);
        return false;
      },
    );
    await writeNonNotesUntil(undefined);
    await this.finishSubtree(root);
    return this.stores.trees.storeTree(root.entries);
  }

  /**
   * prune_notes's walk: the objects whose notes `exists` refuses, in the order git lists them
   * (the walk's, reversed).
   */
  async unreachableObjects(exists: (id: ObjectId) => Promise<boolean>): Promise<ObjectId[]> {
    const list: ObjectId[] = [];
    await this.forEach(0, async (object) => {
      if (!(await exists(object))) list.push(object);
      return false;
    });
    return list.reverse();
  }

  // ---- notes.c internals ----

  /** note_tree_search: the slot for `key` (subtrees on the way read). */
  private async search(
    tree: IntNode,
    n: number,
    key: string,
  ): Promise<{ node: IntNode; n: number; i: number }> {
    let p = tree.a[0] ?? null;
    if (p !== null && p.type === PTR_SUBTREE && prefixMatches(key, p.key)) {
      tree.a[0] = null;
      await this.loadSubtree(p, tree, n);
      return this.search(tree, n, key);
    }
    const i = nibble(n, key);
    p = tree.a[i] ?? null;
    if (p !== null && p.type === PTR_INTERNAL) return this.search(p, n + 1, key);
    if (p !== null && p.type === PTR_SUBTREE && prefixMatches(key, p.key)) {
      tree.a[i] = null;
      await this.loadSubtree(p, tree, n);
      return this.search(tree, n, key);
    }
    return { node: tree, n, i };
  }

  /** note_tree_consolidate: an int_node of one note (or none) replaced by it. */
  private consolidate(tree: IntNode, parent: IntNode, index: number): boolean {
    let p: Ptr = null;
    for (let i = 0; i < 16; i++) {
      if (typeOf(tree.a[i] ?? null) !== PTR_NULL) {
        if (p) return false;
        p = tree.a[i] ?? null;
      }
    }
    if (p && p.type !== PTR_NOTE) return false;
    parent.a[index] = p;
    return true;
  }

  /** note_tree_remove: the note of `key` removed, its value; undefined when none. */
  private async removeLeaf(tree: IntNode, n0: number, key: string): Promise<ObjectId | undefined> {
    const { node, n, i } = await this.search(tree, n0, key);
    const p = node.a[i] ?? null;
    if (p === null || p.type !== PTR_NOTE || p.key !== key) return undefined;
    node.a[i] = null;
    if (n === 0) return p.val;
    const stack: IntNode[] = [this.root];
    for (let k = 0; k < n; k++) {
      stack.push((stack[k] as IntNode).a[nibble(k, key)] as IntNode);
    }
    let k = n;
    while (
      k > 0 &&
      this.consolidate(stack[k] as IntNode, stack[k - 1] as IntNode, nibble(k - 1, key))
    ) {
      k--;
    }
    return p.val;
  }

  /** note_tree_insert */
  private async insert(
    tree: IntNode,
    n0: number,
    entry: Leaf,
    combine: CombineNotes,
  ): Promise<void> {
    const { node, n, i } = await this.search(tree, n0, entry.key);
    const l = node.a[i] ?? null;
    if (l === null) {
      if (entry.val !== NULL_ID) node.a[i] = entry;
      return;
    }
    if (l.type === PTR_NOTE) {
      if (entry.type === PTR_NOTE) {
        if (l.key === entry.key) {
          if (l.val === entry.val) return;
          l.val = await combine(this.stores, l.val, entry.val);
          if (l.val === NULL_ID) await this.removeLeaf(node, n, entry.key);
          return;
        }
      } else if (prefixMatches(l.key, entry.key)) {
        await this.loadSubtree(entry, node, n);
        return;
      }
    } else if (l.type === PTR_SUBTREE) {
      if (prefixMatches(entry.key, l.key)) {
        node.a[i] = null;
        await this.loadSubtree(l, node, n);
        return this.insert(node, n, entry, combine);
      }
    }
    // a non-matching leaf: both under a new int_node
    if (entry.val === NULL_ID) return;
    const created = newNode();
    await this.insert(created, n + 1, l as Leaf, combine);
    node.a[i] = created;
    await this.insert(created, n + 1, entry, combine);
  }

  /** add_non_note: sorted by path, a path given again replacing the entry. */
  private addNonNote(path: string, mode: number, id: ObjectId): void {
    let lo = 0;
    let hi = this.nonNotes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (compareBytes((this.nonNotes[mid] as NonNote).path, path) < 0) lo = mid + 1;
      else hi = mid;
    }
    const at = this.nonNotes[lo];
    if (at && at.path === path) {
      at.mode = mode;
      at.id = id;
      return;
    }
    this.nonNotes.splice(lo, 0, { path, mode, id });
  }

  /** load_subtree: the entries of a stored (sub)tree inserted at `node`, level `n`. */
  private async loadSubtree(subtree: Leaf, node: IntNode, n: number): Promise<void> {
    const prefixLen = prefixLength(subtree.key);
    const prefix = subtree.key.slice(0, prefixLen * 2);
    const entries: TreeEntry[] = [];
    const loaded = this.stores.trees.loadTree(subtree.val);
    for await (const e of loaded) entries.push(e);
    for (const entry of entries) {
      const name = entry.name;
      let leaf: Leaf | undefined;
      if (name.length === 2 * (RAW - prefixLen)) {
        if (isRegular(entry.mode) && isHex(name)) {
          leaf = { type: PTR_NOTE, key: prefix + name.toLowerCase(), val: entry.id };
        }
      } else if (name.length === 2) {
        if (isDir(entry.mode) && isHex(name)) {
          const len = prefixLen + 1;
          const key =
            prefix +
            name.toLowerCase() +
            "00".repeat(RAW - len - 1) +
            len.toString(16).padStart(2, "0");
          leaf = { type: PTR_SUBTREE, key, val: entry.id };
        }
      }
      if (leaf) {
        await this.insert(node, n, leaf, combineNotesConcatenate);
        continue;
      }
      // a non-note: its path from the fanout of the subtree it is in
      let path = "";
      for (let i = 0; i < prefixLen; i++) path += `${subtree.key.slice(2 * i, 2 * i + 2)}/`;
      this.addNonNote(path + name, entry.mode, entry.id);
    }
  }

  /** determine_fanout */
  private determineFanout(tree: IntNode, n: number, fanout: number): number {
    if (n % 2 || n > 2 * fanout) return fanout;
    for (let i = 0; i < 16; i++) {
      const t = typeOf(tree.a[i] ?? null);
      if (t !== PTR_SUBTREE && t !== PTR_INTERNAL) return fanout;
    }
    return fanout + 1;
  }

  /** for_each_note_helper */
  private async forEachHelper(
    tree: IntNode,
    n: number,
    fanoutIn: number,
    flags: number,
    fn: EachNote,
  ): Promise<boolean> {
    const fanout = this.determineFanout(tree, n, fanoutIn);
    for (let i = 0; i < 16; i++) {
      let ret = false;
      for (;;) {
        const p = tree.a[i] ?? null;
        if (p === null) break;
        if (p.type === PTR_INTERNAL) {
          ret = await this.forEachHelper(p, n + 1, fanout, flags, fn);
          break;
        }
        if (p.type === PTR_SUBTREE) {
          if (n < 2 * fanout && flags & FOR_EACH_NOTE_YIELD_SUBTREES) {
            const pathLen = prefixLength(p.key) * 2 + fanout;
            let path = pathWithFanout(p.key, fanout).slice(0, pathLen);
            if (!path.endsWith("/")) path += "/";
            ret = (await fn(p.key, p.val, path)) === true;
          }
          if (n >= 2 * fanout || !(flags & FOR_EACH_NOTE_DONT_UNPACK_SUBTREES)) {
            tree.a[i] = null;
            await this.loadSubtree(p, tree, n);
            if (ret) return true;
            continue;
          }
          break;
        }
        ret = (await fn(p.key, p.val, pathWithFanout(p.key, fanout))) === true;
        break;
      }
      if (ret) return true;
    }
    return false;
  }

  /** tree_write_stack_finish_subtree */
  private async finishSubtree(tws: WriteStack): Promise<void> {
    const n = tws.next;
    if (!n) return;
    await this.finishSubtree(n);
    const id = await this.stores.trees.storeTree(n.entries);
    tws.next = undefined;
    tws.entries.push({ mode: 0o040000, name: tws.path, id });
    tws.path = "";
  }

  /** write_each_note_helper */
  private async writeEntry(
    root: WriteStack,
    path: string,
    mode: number,
    id: ObjectId,
  ): Promise<void> {
    let tws: WriteStack = root;
    let n = 0;
    while (
      3 * n < path.length &&
      tws.path !== "" &&
      path.slice(3 * n, 3 * n + 2) === tws.path &&
      path[3 * n + 2] === "/"
    ) {
      n++;
      tws = tws.next as WriteStack;
    }
    await this.finishSubtree(tws);
    while (3 * n + 2 < path.length && path[3 * n + 2] === "/") {
      const next: WriteStack = { entries: [], path: "" };
      tws.next = next;
      tws.path = path.slice(3 * n, 3 * n + 2);
      n++;
      tws = next;
    }
    tws.entries.push({ mode, name: path.slice(3 * n), id });
  }
}

/** construct_path_with_fanout: `fanout` 2-digit directories, then the rest of the id. */
function pathWithFanout(key: string, fanout: number): string {
  let out = "";
  let j = 0;
  for (let f = 0; f < fanout; f++) {
    out += `${key.slice(j, j + 2)}/`;
    j += 2;
  }
  return out + key.slice(j);
}

/** notes.c's GIT_NOTES_DEFAULT_REF */
export const NOTES_DEFAULT_REF = "refs/notes/commits";

/** The null object id, which adding as a note removes one. */
export const NOTES_NULL_ID = NULL_ID;

/** Reads a note blob's bytes (undefined for a missing one). */
export function readNoteBytes(blobs: Blobs, id: ObjectId): Promise<Uint8Array | undefined> {
  return readBytes(blobs, id);
}
