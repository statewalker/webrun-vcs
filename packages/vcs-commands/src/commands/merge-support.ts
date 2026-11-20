/**
 * What `merge`, `cherry-pick`, `revert` and `rebase` share: flat trees, the operation's
 * state files (MERGE_HEAD, MERGE_MSG, sequencer/, rebase-merge/, ...), and writing a merge's
 * result to the worktree and the index as git's merge-ort does (`merge_switch_to_result`: a
 * two-way unpack-trees from HEAD to the result tree, refused before anything is written
 * where it would overwrite local changes or untracked files, then the conflicts staged).
 */

import {
  type Blobs,
  collectTreeBytes,
  FileMode,
  type ObjectId,
  type RefLogOptions,
  type TreeEntry,
} from "@statewalker/vcs-core";
import { bytesToHex, createSha1 } from "@statewalker/vcs-utils";
import { compareGitPaths, decodeGitPath, encodeGitPath } from "@statewalker/vcs-utils/encoding";
import {
  attributesIndexOf,
  type CacheTree,
  type Checkout,
  cacheTreeFullyValid,
  entryStatOf,
  type IndexEntryOptions,
  invalidateCacheTreeAgainstIndex,
  invalidateCacheTreeForIntentToAdd,
  invalidateCacheTreePath,
  type Staging,
  updateCacheTree,
  type WorkingCopy,
  type Worktree,
} from "@statewalker/vcs-working-tree";
import type { CommandRefs, CommandTrees } from "../git-command.js";
import { coreBool, worktreeModeTrust } from "./core-config.js";
import type { OrtConflict } from "./ort-merge.js";
import { markIndexUpdate } from "./post-index-change.js";
import { pushSparseWarnings, SparseUnpack } from "./sparse-checkout-support.js";
import {
  planFlatRestore,
  planTreeRestore,
  restoreCaseOptions,
  type TreeRestorePlan,
  writeTreeRestorePlan,
} from "./tree-restore.js";
import {
  type CheckedEntry,
  entryNotUptodate,
  findInTheWay,
  overwriteMessage,
  pruneEmptyParents,
} from "./worktree-overwrite-checks.js";

const sameEntry = (a: CheckedEntry | undefined, b: CheckedEntry | undefined) =>
  a === undefined || b === undefined ? a === b : a.objectId === b.objectId && a.mode === b.mode;

/** The blobs, links and gitlinks of a tree, by path (none for no tree). */
export async function flatTree(
  trees: CommandTrees,
  treeId: ObjectId | undefined,
): Promise<Map<string, CheckedEntry>> {
  const out = new Map<string, CheckedEntry>();
  if (!treeId) return out;
  const walk = async (id: ObjectId, prefix: string): Promise<void> => {
    for await (const entry of trees.loadTree(id)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.mode === FileMode.TREE) await walk(entry.id, path);
      else out.set(path, { objectId: entry.id, mode: entry.mode });
    }
  };
  await walk(treeId, "");
  return out;
}

/**
 * The trees `ids` as flat maps for a merge of them, as merge-ort reads them: a directory
 * that every one of the trees holds with the same tree id is not read at all, it stands in
 * each map as one entry of mode TREE carrying that id (merge-ort resolves such a directory
 * at once, `side1_matches_mbase && side2_matches_mbase`). Every other directory is read.
 * `dirs` gives, per tree, the id of each directory read or stood in for.
 */
export async function prunedFlatTrees(
  trees: CommandTrees,
  ids: (ObjectId | undefined)[],
): Promise<{ flats: Map<string, CheckedEntry>[]; dirs: Map<string, ObjectId>[] }> {
  const flats = ids.map(() => new Map<string, CheckedEntry>());
  const dirs = ids.map(() => new Map<string, ObjectId>());
  const read = async (id: ObjectId | undefined) => {
    const out: { name: string; mode: number; id: ObjectId }[] = [];
    if (id) for await (const e of trees.loadTree(id)) out.push(e);
    return out;
  };
  const walk = async (level: (ObjectId | undefined)[], prefix: string): Promise<void> => {
    const listed = await Promise.all(level.map(read));
    const byName = new Map<string, ({ mode: number; id: ObjectId } | undefined)[]>();
    listed.forEach((entries, i) => {
      for (const e of entries) {
        let slot = byName.get(e.name);
        if (!slot) {
          slot = level.map(() => undefined);
          byName.set(e.name, slot);
        }
        slot[i] = e;
      }
    });
    for (const [name, slot] of byName) {
      const path = prefix ? `${prefix}/${name}` : name;
      const first = slot[0];
      if (
        first?.mode === FileMode.TREE &&
        slot.every((e) => e !== undefined && e.mode === FileMode.TREE && e.id === first.id)
      ) {
        for (let i = 0; i < slot.length; i++) {
          flats[i].set(path, { objectId: first.id, mode: FileMode.TREE });
          dirs[i].set(path, first.id);
        }
        continue;
      }
      const sub: (ObjectId | undefined)[] = slot.map(() => undefined);
      let nested = false;
      slot.forEach((e, i) => {
        if (!e) return;
        if (e.mode === FileMode.TREE) {
          sub[i] = e.id;
          dirs[i].set(path, e.id);
          nested = true;
        } else flats[i].set(path, { objectId: e.id, mode: e.mode });
      });
      if (nested) await walk(sub, path);
    }
  };
  await walk(ids, "");
  return { flats, dirs };
}

/**
 * The paths where the trees `from` and `to` differ, with their entries on each side (a
 * path one side lacks is absent from its map): what comparing their flat maps finds, read
 * without descending into a subtree both hold with the same id.
 */
export async function treeDelta(
  trees: CommandTrees,
  from: ObjectId | undefined,
  to: ObjectId | undefined,
): Promise<{ from: Map<string, CheckedEntry>; to: Map<string, CheckedEntry> }> {
  const out = { from: new Map<string, CheckedEntry>(), to: new Map<string, CheckedEntry>() };
  const read = async (id: ObjectId | undefined) => {
    const map = new Map<string, { mode: number; id: ObjectId }>();
    if (id) for await (const e of trees.loadTree(id)) map.set(e.name, { mode: e.mode, id: e.id });
    return map;
  };
  const addAll = async (side: Map<string, CheckedEntry>, id: ObjectId, prefix: string) => {
    for await (const e of trees.loadTree(id)) {
      const path = `${prefix}/${e.name}`;
      if (e.mode === FileMode.TREE) await addAll(side, e.id, path);
      else side.set(path, { objectId: e.id, mode: e.mode });
    }
  };
  const walk = async (a: ObjectId | undefined, b: ObjectId | undefined, prefix: string) => {
    if (a === b) return;
    const [x, y] = await Promise.all([read(a), read(b)]);
    for (const name of new Set([...x.keys(), ...y.keys()])) {
      const ex = x.get(name);
      const ey = y.get(name);
      if (ex && ey && ex.mode === ey.mode && ex.id === ey.id) continue;
      const path = prefix ? `${prefix}/${name}` : name;
      const xTree = ex?.mode === FileMode.TREE;
      const yTree = ey?.mode === FileMode.TREE;
      if (xTree && yTree) {
        await walk(ex.id, ey.id, path);
        continue;
      }
      if (ex) {
        if (xTree) await addAll(out.from, ex.id, path);
        else out.from.set(path, { objectId: ex.id, mode: ex.mode });
      }
      if (ey) {
        if (yTree) await addAll(out.to, ey.id, path);
        else out.to.set(path, { objectId: ey.id, mode: ey.mode });
      }
    }
  };
  await walk(from, to, "");
  return out;
}

/** The index's entries of one directory: its files, its subdirectories, its tree id. */
interface IndexDir {
  files: Map<string, CheckedEntry>;
  dirs: Map<string, IndexDir>;
  id?: ObjectId;
}

/** The index's stage-0 entries as directories, each with the id its tree would have. */
async function indexDirs(index: Map<string, CheckedEntry>): Promise<IndexDir> {
  const root: IndexDir = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of index) {
    let dir = root;
    let from = 0;
    for (let k = path.indexOf("/"); k >= 0; k = path.indexOf("/", from)) {
      const name = path.slice(from, k);
      let next = dir.dirs.get(name);
      if (!next) {
        next = { files: new Map(), dirs: new Map() };
        dir.dirs.set(name, next);
      }
      dir = next;
      from = k + 1;
    }
    dir.files.set(path.slice(from), entry);
  }
  const hash = async (dir: IndexDir): Promise<ObjectId> => {
    const entries: TreeEntry[] = [];
    for (const [name, sub] of dir.dirs)
      entries.push({ name, mode: FileMode.TREE, id: await hash(sub) });
    for (const [name, e] of dir.files) entries.push({ name, mode: e.mode, id: e.objectId });
    let id: ObjectId;
    try {
      const bytes = await collectTreeBytes(entries);
      const hasher = createSha1().update(new TextEncoder().encode(`tree ${bytes.length}\0`));
      id = bytesToHex(hasher.update(bytes).digest());
    } catch {
      // a name no tree can hold: never the id of a stored tree
      id = "";
    }
    dir.id = id;
    return id;
  };
  await hash(root);
  return root;
}

/**
 * The paths where the index's stage-0 entries differ from the tree `treeId`, sorted (as
 * {@link indexChanges} over the tree's flat map). As git's cache-tree, each directory of the
 * index is given the id its tree would have: a subtree of `treeId` with that id holds what
 * the index holds there and is not read.
 */
export async function indexChangesFromTree(
  index: Map<string, CheckedEntry>,
  trees: CommandTrees,
  treeId: ObjectId | undefined,
): Promise<string[]> {
  const out: string[] = [];
  const all = (dir: IndexDir, prefix: string) => {
    for (const name of dir.files.keys()) out.push(join(prefix, name));
    for (const [name, sub] of dir.dirs) all(sub, join(prefix, name));
  };
  const allOfTree = async (id: ObjectId, prefix: string): Promise<void> => {
    for await (const e of trees.loadTree(id)) {
      const path = join(prefix, e.name);
      if (e.mode === FileMode.TREE) await allOfTree(e.id, path);
      else out.push(path);
    }
  };
  const compare = async (
    id: ObjectId | undefined,
    dir: IndexDir | undefined,
    prefix: string,
  ): Promise<void> => {
    if (!id) {
      if (dir) all(dir, prefix);
      return;
    }
    if (!dir) return allOfTree(id, prefix);
    if (dir.id === id) return;
    const files = new Map<string, { mode: number; id: ObjectId }>();
    const subtrees = new Map<string, ObjectId>();
    for await (const e of trees.loadTree(id)) {
      if (e.mode === FileMode.TREE) subtrees.set(e.name, e.id);
      else files.set(e.name, { mode: e.mode, id: e.id });
    }
    for (const name of new Set([...files.keys(), ...dir.files.keys()])) {
      const t = files.get(name);
      const i = dir.files.get(name);
      if (!t || !i || t.id !== i.objectId || t.mode !== i.mode) out.push(join(prefix, name));
    }
    for (const name of new Set([...subtrees.keys(), ...dir.dirs.keys()])) {
      await compare(subtrees.get(name), dir.dirs.get(name), join(prefix, name));
    }
  };
  await compare(treeId, index.size > 0 ? await indexDirs(index) : undefined, "");
  return out.sort();
}

const join = (prefix: string, name: string) => (prefix ? `${prefix}/${name}` : name);

/** Stores a flat path map as a tree. */
export async function storeFlatTree(
  trees: CommandTrees,
  entries: Map<string, CheckedEntry>,
): Promise<ObjectId> {
  type Node = Map<string, Node | CheckedEntry>;
  const root: Node = new Map();
  for (const [path, entry] of entries) {
    const parts = path.split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      let next = node.get(part);
      if (!(next instanceof Map)) {
        next = new Map();
        node.set(part, next);
      }
      node = next;
    }
    node.set(parts[parts.length - 1], entry);
  }
  const store = async (node: Node): Promise<ObjectId> => {
    const list: { name: string; mode: number; id: ObjectId }[] = [];
    for (const [name, value] of node) {
      if (value instanceof Map) list.push({ name, mode: FileMode.TREE, id: await store(value) });
      else list.push({ name, mode: value.mode, id: value.objectId });
    }
    return trees.storeTree(list);
  };
  return store(root);
}

/**
 * Stores `target` as a tree, given that `base` is the flat form of the stored tree
 * `baseTree`: only the directories holding a changed path are stored again, every other
 * subtree is taken from `baseTree` as it is (what a pick changes is a few paths of a large
 * tree). Without a base tree the whole map is stored.
 */
export async function storeFlatTreeOver(
  trees: CommandTrees,
  baseTree: ObjectId | undefined,
  base: Map<string, CheckedEntry>,
  target: Map<string, CheckedEntry>,
): Promise<ObjectId> {
  if (!baseTree) return storeFlatTree(trees, target);
  const changes = new Map<string, CheckedEntry | null>();
  for (const [path, entry] of target) {
    if (!sameEntry(base.get(path), entry)) changes.set(path, entry);
  }
  for (const path of base.keys()) if (!target.has(path)) changes.set(path, null);
  // a directory the target takes whole (one TREE entry): what the base held under it goes
  const whole = [...changes].filter(([, e]) => e?.mode === FileMode.TREE).map(([p]) => `${p}/`);
  if (whole.length > 0) {
    for (const path of [...changes.keys()]) {
      if (whole.some((dir) => path.startsWith(dir))) changes.delete(path);
    }
  }
  if (changes.size === 0) return baseTree;
  const rebuild = async (
    treeId: ObjectId | undefined,
    edits: Map<string, CheckedEntry | null>,
  ): Promise<ObjectId | undefined> => {
    const entries = new Map<string, { mode: number; id: ObjectId }>();
    if (treeId) {
      for await (const e of trees.loadTree(treeId)) entries.set(e.name, { mode: e.mode, id: e.id });
    }
    const direct = new Map<string, CheckedEntry | null>();
    const nested = new Map<string, Map<string, CheckedEntry | null>>();
    for (const [path, entry] of edits) {
      const k = path.indexOf("/");
      if (k < 0) direct.set(path, entry);
      else {
        const name = path.slice(0, k);
        const sub = nested.get(name) ?? new Map<string, CheckedEntry | null>();
        sub.set(path.slice(k + 1), entry);
        nested.set(name, sub);
      }
    }
    // removals first (a file `d` making way for `d/x`), then directories, then files
    for (const [name, entry] of direct) if (!entry) entries.delete(name);
    for (const [name, sub] of nested) {
      const current = entries.get(name);
      const childTree = current?.mode === FileMode.TREE ? current.id : undefined;
      const id = await rebuild(childTree, sub);
      if (id) entries.set(name, { mode: FileMode.TREE, id });
      else if (childTree) entries.delete(name);
    }
    for (const [name, entry] of direct) {
      if (entry) entries.set(name, { mode: entry.mode, id: entry.objectId });
    }
    if (entries.size === 0) return undefined;
    return trees.storeTree([...entries].map(([name, e]) => ({ name, mode: e.mode, id: e.id })));
  };
  return (await rebuild(baseTree, changes)) ?? (await trees.storeTree([]));
}

/**
 * Flat trees by tree id, for an operation that reads the same trees again and again (a
 * rebase: each pick's result is the next pick's HEAD, each commit the next one's parent).
 * Keeps the last few.
 */
export class FlatTreeCache {
  private readonly cache = new Map<ObjectId, Map<string, CheckedEntry>>();

  constructor(
    private readonly trees: CommandTrees,
    private readonly size = 8,
  ) {}

  /** The flat tree (none for no tree); the map is shared, never to be changed. */
  async get(treeId: ObjectId | undefined): Promise<Map<string, CheckedEntry>> {
    if (!treeId) return new Map();
    const hit = this.cache.get(treeId);
    if (hit) {
      this.cache.delete(treeId);
      this.cache.set(treeId, hit);
      return hit;
    }
    const flat = await flatTree(this.trees, treeId);
    this.put(treeId, flat);
    return flat;
  }

  /** Records the flat form of a tree just stored. */
  put(treeId: ObjectId, flat: Map<string, CheckedEntry>): void {
    this.cache.delete(treeId);
    this.cache.set(treeId, flat);
    while (this.cache.size > this.size) {
      const oldest = this.cache.keys().next().value as ObjectId;
      this.cache.delete(oldest);
    }
  }
}

/**
 * The restore plan of the paths in `writing`, taken from the flat `target` (the tree
 * `targetTree`): each path validated and its blob checked as {@link planTreeRestore} does,
 * without walking the whole tree. With `core.ignorecase` on a worktree that folds case (or
 * cannot tell) the whole tree is planned (case collisions are found across it).
 */
export async function planPathsRestore(
  ctx: MergeWriteContext,
  target: Map<string, CheckedEntry>,
  targetTree: ObjectId | undefined,
  writing: Set<string>,
  operation: string,
): Promise<TreeRestorePlan> {
  const worktree = ctx.worktree;
  const options = {
    symlinks: true,
    windows: worktree?.capabilities?.windowsPaths === true,
    reservedNames: worktree?.capabilities?.reservedNames,
  };
  const caseOptions = await restoreCaseOptions(
    worktree,
    coreBool(ctx.workingCopy, "ignorecase", false),
  );
  if (caseOptions.ignoreCase && caseOptions.foldsCase !== false) {
    const tree = targetTree ?? (await storeFlatTree(ctx.trees, target));
    const plan = await planTreeRestore(ctx.trees, ctx.blobs, tree, operation, {
      ...options,
      ...caseOptions,
      writing,
    });
    return {
      ...plan,
      entries: plan.entries.filter((e) => writing.has(e.path)),
      gitlinks: plan.gitlinks.filter((e) => writing.has(e.path)),
    };
  }
  return planFlatRestore(ctx.blobs, target, writing, operation, options);
}

/** The index: its stage-0 entries by path, and the paths with unmerged entries. */
export async function readIndex(
  staging: Staging,
): Promise<{ index: Map<string, CheckedEntry>; unmerged: string[] }> {
  const index = new Map<string, CheckedEntry>();
  const unmerged = new Set<string>();
  for (const entry of await indexEntryList(staging)) {
    if (entry.stage === 0) index.set(entry.path, entry);
    else unmerged.add(entry.path);
  }
  return { index, unmerged: [...unmerged].sort() };
}

/**
 * The tree of the index, as git's `write_index_as_tree` (`cherry-pick -n`, `revert -n`):
 * unless the index holds a fully valid cache-tree, the index file is written again with
 * one. That write smudges racily clean entries and gives the index a new timestamp, which
 * later overwrite checks compare entries with (an entry as new as it is read again).
 */
export async function writeIndexAsTree(
  staging: Staging,
  trees: CommandTrees,
  options: { write?: boolean } = {},
): Promise<ObjectId> {
  if (!staging.getCacheTree || !staging.setCacheTree) return staging.writeTree(trees);
  const previous = staging.getCacheTree();
  const treeId = await staging.writeTree(trees);
  if (!previous || !cacheTreeFullyValid(previous)) {
    // the valid directories kept, the others computed (cache_tree_update)
    const cacheTree = await updateCacheTree(trees, treeId, previous);
    for (const entry of await indexEntryList(staging)) {
      if (entry.intentToAdd) {
        invalidateCacheTreeForIntentToAdd(cacheTree, entry.path);
      }
    }
    staging.setCacheTree(cacheTree);
    // unless the caller writes the index itself (into the lock it holds)
    if (options.write !== false) await staging.write();
  }
  return treeId;
}

/**
 * git's `cache_tree_update(WRITE_TREE_SILENT | WRITE_TREE_REPAIR)` before an index write
 * (`checkout` after its unpack-trees): unless the cache-tree is fully valid, the invalid
 * directories are computed from the index (the valid ones kept, a stored tree included), the
 * directories of intent-to-add entries left invalid; nothing where the index has conflicts.
 * Sets the cache-tree the next `write` writes.
 */
export async function updateIndexCacheTree(staging: Staging, trees: CommandTrees): Promise<void> {
  if (!staging.getCacheTree || !staging.setCacheTree) return;
  if (await staging.hasConflicts()) return;
  const previous = staging.getCacheTree();
  if (previous && cacheTreeFullyValid(previous)) return;
  const treeId = await staging.writeTree(trees);
  const cacheTree = await updateCacheTree(trees, treeId, previous);
  for (const entry of await indexEntryList(staging)) {
    if (entry.intentToAdd) {
      invalidateCacheTreeForIntentToAdd(cacheTree, entry.path);
    }
  }
  staging.setCacheTree(cacheTree);
}

/** Every index entry in the index's order, at once where the staging can give them so. */
async function indexEntryList(staging: Staging): Promise<readonly IndexEntryInput[]> {
  const list = staging.entryList?.();
  if (list) return list;
  const out: IndexEntryInput[] = [];
  for await (const entry of staging.entries()) out.push(entry);
  return out;
}

/** An index entry to write: path, blob, mode, stage and the file's stat. */
export type IndexEntryInput = IndexEntryOptions;

/**
 * Rewrites the index: the entries of each path in `changes` replaced by the ones given
 * (none: the path removed, every stage), every other entry kept as it is.
 */
export async function rewriteIndex(
  staging: Staging,
  changes: Map<string, IndexEntryInput[]>,
  options: { updateCacheTreeWith?: CommandTrees; cacheTree?: CacheTree } = {},
): Promise<void> {
  // the kept entries are in the index's order already: only the changes are sorted, then
  // both merged (git's order: the paths' bytes, then the stage)
  const kept: IndexEntryInput[] = [];
  for (const entry of await indexEntryList(staging)) {
    if (!changes.has(entry.path)) kept.push(entry);
  }
  const keys = new Map<string, Uint8Array>();
  const key = (path: string) => {
    let k = keys.get(path);
    if (!k) {
      k = encodeGitPath(path);
      keys.set(path, k);
    }
    return k;
  };
  const compareBytes = (a: string, b: string) => {
    const x = key(a);
    const y = key(b);
    for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
    return x.length - y.length;
  };
  const compare = (a: IndexEntryInput, b: IndexEntryInput) => {
    if (a.path === b.path) return (a.stage ?? 0) - (b.stage ?? 0);
    // below the surrogates, UTF-16 code units order as the UTF-8 bytes do
    const x = a.path;
    const y = b.path;
    const n = Math.min(x.length, y.length);
    for (let i = 0; i < n; i++) {
      const cx = x.charCodeAt(i);
      const cy = y.charCodeAt(i);
      if (cx === cy) continue;
      return cx < 0xd800 && cy < 0xd800 ? cx - cy : compareBytes(x, y);
    }
    return x.length - y.length;
  };
  const added = [...changes.values()].flat().sort(compare);
  const builder = staging.createBuilder();
  let a = 0;
  for (const entry of kept) {
    while (a < added.length && compare(added[a], entry) < 0) builder.add(added[a++]);
    builder.add(entry);
  }
  while (a < added.length) builder.add(added[a++]);
  // the index is rewritten around the changed paths only: the kept entries count as up to
  // date (as after the whole-index refresh git runs first), so the write checks no untouched
  // racily clean file and the command reads only the paths it writes
  await builder.finish({ upToDate: true });
  // a cache-tree computed for the entries just built
  if (options.cacheTree) staging.setCacheTree?.(options.cacheTree);
  // unpack-trees' cache_tree_update before its index write
  if (options.updateCacheTreeWith) await updateIndexCacheTree(staging, options.updateCacheTreeWith);
  await staging.write();
}

/** Whether the index holds exactly `tree` (no staged change; git's index_differs_from). */
export function indexMatches(
  index: Map<string, CheckedEntry>,
  tree: Map<string, CheckedEntry>,
): boolean {
  return indexChanges(index, tree).length === 0;
}

/** The paths where the index differs from `tree`, sorted. */
export function indexChanges(
  index: Map<string, CheckedEntry>,
  tree: Map<string, CheckedEntry>,
): string[] {
  const out: string[] = [];
  for (const path of new Set([...index.keys(), ...tree.keys()])) {
    if (!sameEntry(index.get(path), tree.get(path))) out.push(path);
  }
  return out.sort();
}

/**
 * The state files of an operation in progress, in git's directory: plain files through the
 * checkout (`MERGE_MSG`, `sequencer/todo`, ...), pseudo refs through the ref store
 * (`MERGE_HEAD`, `ORIG_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `AUTO_MERGE`).
 */
export class OperationState {
  constructor(
    private readonly checkout: Checkout,
    private readonly refs: CommandRefs,
  ) {}

  /** Whether the checkout can keep state files at all. */
  get supported(): boolean {
    return typeof this.checkout.writeStateFile === "function";
  }

  async read(name: string): Promise<string | undefined> {
    const bytes = await this.checkout.readStateFile?.(name);
    // a path in a state file (MERGE_MSG's conflicts) is its bytes, as git writes it
    return bytes ? decodeGitPath(bytes) : undefined;
  }

  async write(name: string, content: string | Uint8Array): Promise<void> {
    const bytes = typeof content === "string" ? encodeGitPath(content) : content;
    await this.checkout.writeStateFile?.(name, bytes);
  }

  /** Appends to a state file (O_APPEND where the checkout can; else a rewrite). */
  async append(name: string, content: string): Promise<void> {
    if (this.checkout.appendStateFile) {
      // the same bytes `write` would store (escaped bytes as themselves)
      await this.checkout.appendStateFile(name, encodeGitPath(content));
      return;
    }
    await this.write(name, `${(await this.read(name)) ?? ""}${content}`);
  }

  async remove(...names: string[]): Promise<void> {
    for (const name of names) await this.checkout.removeStateFile?.(name);
  }

  /** The names in a state directory, sorted (empty: none, or a checkout that cannot list). */
  async listDir(name: string): Promise<string[]> {
    return (await this.checkout.listStateDir?.(name)) ?? [];
  }

  async exists(name: string): Promise<boolean> {
    if ((await this.checkout.readStateFile?.(name)) !== undefined) return true;
    return ((await this.checkout.listStateDir?.(name)) ?? []).length > 0;
  }

  async ref(name: string): Promise<ObjectId | undefined> {
    const ref = await this.refs.get(name).catch(() => undefined);
    return ref && "objectId" in ref && ref.objectId ? ref.objectId : undefined;
  }

  /**
   * Writes a pseudo ref. With `old` (an id, or `null` for none), as git's refs_update_ref
   * given the value it read: a ref store with a transaction hook shows it, and checks it under
   * the lock (a store that cannot batch the ref writes it plainly).
   */
  async setRef(
    name: string,
    id: ObjectId,
    options?: { old: ObjectId | null; log?: RefLogOptions },
  ): Promise<void> {
    if (options) {
      const result = await this.refs.batch([{ name, old: options.old, new: id }], options.log);
      if (result.ok) return;
      if (
        !result.rejected.every((r) => r.reason === "invalid-name" || r.reason === "unsupported")
      ) {
        throw Object.assign(
          new Error(
            `cannot update ${name}: ${result.rejected.map((r) => `${r.name}: ${r.reason}`).join(", ")}`,
          ),
          { rejected: result.rejected },
        );
      }
    }
    await this.refs.set(name, id);
  }

  async removeRef(...names: string[]): Promise<void> {
    for (const name of names) {
      if (await this.refs.has(name).catch(() => false)) await this.refs.delete(name);
    }
  }

  /**
   * Deletes pseudo refs whether they exist or not, as git's unconditional `refs_delete_ref`
   * calls (AUTO_MERGE after a commit): a ref store with a transaction hook tells it of the
   * deletion either way. Without one nothing can tell, and only the refs there are removed
   * (a check is far cheaper than a deletion's transaction). A failure is ignored, as git
   * ignores it there.
   */
  async deleteRef(...names: string[]): Promise<void> {
    if (!refsWatched(this.refs)) {
      await this.removeRef(...names).catch(() => undefined);
      return;
    }
    for (const name of names) await this.refs.delete(name).catch(() => false);
  }

  /**
   * A pseudo ref git's sequencer writes and deletes again before anyone else could read it
   * (CHERRY_PICK_HEAD of a rebase's pick that stops): written and deleted where a
   * transaction hook hears both, else only deleted (a stale one goes either way).
   */
  async writeAndDeleteRef(name: string, id: ObjectId): Promise<void> {
    if (refsWatched(this.refs)) await this.setRef(name, id);
    await this.deleteRef(name);
  }

  /**
   * Runs `body` with pseudo ref `name` at `id`, deleted once `body` succeeds (git's sequencer:
   * CHERRY_PICK_HEAD written before the commit, deleted by do_commit after it). Only hooks
   * can read it meanwhile, and they run only where a transaction hook is installed: without
   * one it is written only when `body` fails, which leaves it, as git does.
   */
  async withRefDuring<T>(name: string, id: ObjectId, body: () => Promise<T>): Promise<T> {
    const watched = refsWatched(this.refs);
    if (watched) await this.setRef(name, id);
    let result: T;
    try {
      result = await body();
    } catch (error) {
      if (!watched) await this.setRef(name, id).catch(() => undefined);
      throw error;
    }
    await this.deleteRef(name);
    return result;
  }
}

/**
 * Whether a reference-transaction hook is installed on `refs` (the files store while a
 * command with a hook runner runs, or a receive-pack): writes it alone would see can be
 * skipped without one.
 */
export function refsWatched(refs: unknown): boolean {
  return (refs as { getTransactionHook?(): unknown }).getTransactionHook?.() !== undefined;
}

/** The parts of a command a merge's write needs. */
export interface MergeWriteContext {
  workingCopy: WorkingCopy;
  worktree?: Worktree;
  staging: Staging;
  blobs: Blobs;
  trees: CommandTrees;
  /**
   * Collects what the sparse checkout prints on stderr while the write applies its patterns
   * (git's `warning:` lines for files left despite the patterns), one entry per line.
   */
  sparseWarnings?: string[];
}

/** Why a merge's write was refused: git's message, and the paths it lists. */
export interface MergeRefusal {
  message: string;
  paths: string[];
}

/** Whether an untracked, not ignored file or link stands at `path`. */
async function untrackedFileAt(worktree: Worktree, path: string): Promise<boolean> {
  const entry = await worktree.getEntry(path);
  if (!entry || entry.isDirectory) return false;
  return !(await worktree.isIgnored(path));
}

/**
 * git's two-way unpack-trees (`twoway_merge`, with update) from `head` to `target` on the
 * current index and worktree, as merge-ort's checkout of its result and a fast-forward
 * run it: a path the two trees agree on keeps its index entry and worktree file (local
 * edits survive); a path they differ on is switched when the index and the worktree still
 * hold `head`'s version, else everything is refused with git's messages. Then the
 * conflicts are staged at stages 1-3 (`record_conflicted_index_entries`).
 *
 * @returns the refusal (nothing written), or undefined once written
 */
export async function switchTrees(
  ctx: MergeWriteContext,
  head: Map<string, CheckedEntry>,
  target: Map<string, CheckedEntry>,
  options: SwitchTreesOptions,
): Promise<MergeRefusal | undefined> {
  // unpack-trees with a destination index: the index written next follows a worktree update
  // (post-index-change's first flag)
  markIndexUpdate(ctx.staging, { workdir: true });
  // in a sparse checkout: unpack-trees with its patterns (a conflict's file is written
  // whatever they say where its entry was outside the checkout, as
  // record_conflicted_index_entries does; one leaving the checkout is unlinked)
  const conflicts = [...(options.conflicts ?? [])];
  // without update nothing in the worktree is touched (unpack-trees skips the sparse
  // checkout: `skip_sparse_checkout` when `!o->update`)
  const sparse =
    options.update === false || options.skipSparseCheckout
      ? undefined
      : await SparseUnpack.start(ctx);
  sparse?.conflict(conflicts.map((c) => c.stagePath));
  const switched = await switchTreesWith(ctx, head, target, { ...options, conflicts }, sparse);
  if (switched.refused) return switched.refused;
  if (sparse) {
    const outcome = await sparse.finish(ctx, { written: switched.written });
    pushSparseWarnings(ctx.sparseWarnings, sparse, outcome, true);
  }
  return undefined;
}

/** Options of {@link switchTrees}. */
export interface SwitchTreesOptions {
  /** Names the operation in git's refusal messages */
  action: "merge" | "checkout";
  /** Names the operation in restore failures */
  operation: string;
  /** The conflicts to stage */
  conflicts?: Iterable<OrtConflict>;
  /**
   * The stored tree the switch leaves in the index (`target` whole, or the tree `target`
   * changes HEAD to): planned from (saves storing it again), and written as the index's
   * cache-tree, as unpack-trees does
   */
  targetTree?: ObjectId;
  /**
   * Whether the worktree is updated (default true: `-u`). False (`read-tree -m H M`
   * without `-u`): the entries are still checked against their files (`verify_uptodate`),
   * but nothing is written or removed and untracked files are not looked for.
   */
  update?: boolean;
  /** `--no-sparse-checkout`: the sparse-checkout patterns are not applied */
  skipSparseCheckout?: boolean;
  /**
   * unpack-trees without porcelain messages (`read-tree`): the refusal is the first path's
   * one `error:` line ("Entry 'x' would be overwritten by merge. Cannot merge.", ...)
   */
  plainErrors?: boolean;
}

/** git's default unpack-trees messages (`unpack_plumbing_errors`) for one refused path. */
export function plainUnpackError(
  kind: "wouldOverwrite" | "notUptodate" | "lostDir" | "untracked" | "untrackedRemoved",
  path: string,
): string {
  switch (kind) {
    case "wouldOverwrite":
      return `error: Entry '${path}' would be overwritten by merge. Cannot merge.`;
    case "notUptodate":
      return `error: Entry '${path}' not uptodate. Cannot merge.`;
    case "lostDir":
      return `error: Updating '${path}' would lose untracked files in it`;
    case "untracked":
      return `error: Untracked working tree file '${path}' would be overwritten by merge.`;
    case "untrackedRemoved":
      return `error: Untracked working tree file '${path}' would be removed by merge.`;
  }
}

async function switchTreesWith(
  ctx: MergeWriteContext,
  head: Map<string, CheckedEntry>,
  target: Map<string, CheckedEntry>,
  options: SwitchTreesOptions,
  sparse: SparseUnpack | undefined,
): Promise<{ refused?: MergeRefusal; written: Set<string> }> {
  const { index, unmerged } = await readIndex(ctx.staging);
  // a path staying outside the sparse checkout: neither checked nor touched in the worktree
  const quiet = (path: string) => sparse?.leavesAlone(path) === true;
  const update = options.update !== false;
  const checked = ctx.worktree;
  const worktree = update ? checked : undefined;
  const trust = checked ? worktreeModeTrust(ctx.workingCopy, checked) : undefined;
  const indexTime = ctx.staging.getUpdateTime();
  const ignoreCase = coreBool(ctx.workingCopy, "ignorecase", false);
  const staged: string[] = [];
  const local: string[] = [];
  const untrackedRemoved: string[] = [];
  const updates: string[] = [];
  const removes: string[] = [];
  const paths = [...new Set([...head.keys(), ...target.keys()])].sort();
  for (const path of paths) {
    const h = head.get(path);
    const t = target.get(path);
    const i = index.get(path);
    if (sameEntry(h, t)) continue;
    if (i) {
      if (t && sameEntry(i, t)) continue;
      if (!sameEntry(i, h)) {
        // a staged change the switch would lose (reject_merge)
        staged.push(path);
        continue;
      }
      if (checked && !quiet(path) && (await entryNotUptodate(checked, path, i, trust, indexTime))) {
        local.push(path);
        continue;
      }
      (t ? updates : removes).push(path);
      continue;
    }
    if (t) {
      // a staged deletion of a path the target changes
      if (h) staged.push(path);
      else updates.push(path);
      continue;
    }
    // a deletion already staged: an untracked file there would be removed
    if (worktree && (await untrackedFileAt(worktree, path))) untrackedRemoved.push(path);
  }
  // a dirty file the target deletes is reported as a local change only (git's
  // verify_clean_subdirectory counts tracked files under a replaced directory as such)
  const deleting = [...removes, ...local.filter((p) => !target.has(p))];
  // the files written: in a sparse checkout, those of the paths in its patterns only
  const writing = new Set(updates.filter((p) => !sparse || sparse.writes(p)));
  const found = worktree
    ? await findInTheWay(worktree, {
        writes: [...writing],
        removes: new Set(deleting),
        index,
        ...(await restoreCaseOptions(worktree, ignoreCase)),
      })
    : { untracked: [], lostDirs: [] };
  const message = options.plainErrors
    ? firstPlainError({
        wouldOverwrite: staged,
        notUptodate: local,
        lostDir: found.lostDirs,
        untracked: found.untracked,
        untrackedRemoved,
      })
    : overwriteMessage(options.action, {
        staged,
        local,
        lostDirs: found.lostDirs,
        untracked: found.untracked,
        untrackedRemoved,
      });
  if (message) {
    return {
      refused: {
        message,
        paths: [...staged, ...local, ...found.lostDirs, ...found.untracked, ...untrackedRemoved],
      },
      written: new Set(),
    };
  }

  // record_conflicted_index_entries checks out a conflict's stage-0 entry left skip-worktree
  // (the switch kept it: the trees agree on it, or the index holds the target's already):
  // its file is written whatever the patterns say, as checkout_entry with force writes it
  let planTarget = target;
  if (worktree && sparse) {
    for (const conflict of options.conflicts ?? []) {
      const path = conflict.stagePath;
      const i = index.get(path) as IndexEntryInput | undefined;
      if (!i?.skipWorktree || writing.has(path) || removes.includes(path)) continue;
      const t = target.get(path);
      if (t ? !sameEntry(i, t) : head.has(path)) continue;
      if (planTarget === target) planTarget = new Map(target);
      planTarget.set(path, i);
      writing.add(path);
    }
  }

  // the worktree: deletions first (a deleted file `d` makes way for `d/x`), then the files
  if (worktree) {
    if (sparse) {
      // apply_sparse_checkout before check_updates: the files leaving the checkout
      const removing = new Set(removes);
      const updating = new Set(updates);
      const unlink = await sparse.leaving(
        worktree,
        (p) => (removing.has(p) ? undefined : updating.has(p) ? target.get(p) : index.get(p)),
        { trust },
      );
      await sparse.unlink(worktree, unlink);
    }
    for (const path of removes) {
      if (quiet(path)) continue;
      await worktree.remove(path);
      await pruneEmptyParents(worktree, path);
    }
    if (writing.size > 0) {
      // only the written paths are planned (each validated, its blob checked)
      const plan = await planPathsRestore(
        ctx,
        planTarget,
        planTarget === target ? options.targetTree : undefined,
        writing,
        options.operation,
      );
      // the attributes of the index the switch leaves (git's o->result): only its
      // attributes files are looked up
      const result = new Map<string, ObjectId>();
      for (const [path, entry] of index) {
        if (path.endsWith(".gitattributes")) result.set(path, entry.objectId);
      }
      for (const path of removes) result.delete(path);
      for (const path of updates) result.set(path, (target.get(path) as CheckedEntry).objectId);
      await writeTreeRestorePlan(
        worktree,
        ctx.blobs,
        {
          ...plan,
          entries: plan.entries.filter((e) => writing.has(e.path)),
          gitlinks: plan.gitlinks.filter((e) => writing.has(e.path)),
        },
        options.operation,
        {
          symlinks: trust?.symlinks ?? true,
          gitlinks: true,
          replaceInTheWay: true,
          attributes: { direction: "checkout", index: attributesIndexOf(result) },
        },
      );
    }
  }

  // the index: the switched paths take the target's entries (with the stat of the files
  // just written), the conflicts their stages
  const changes = new Map<string, IndexEntryOptions[]>();
  for (const path of removes) changes.set(path, []);
  for (const path of updates) {
    const t = target.get(path) as CheckedEntry;
    // the stat of a file written (an entry left outside the checkout has none)
    const stats = worktree && writing.has(path) ? await worktree.getEntry(path) : undefined;
    // the skip-worktree bit of the entry replaced is kept (merged_entry: "Migrate old flags
    // over"); assume-unchanged is not
    const old = index.get(path) as IndexEntryInput | undefined;
    changes.set(path, [
      {
        path,
        objectId: t.objectId,
        mode: t.mode,
        ...entryStatOf(stats && !stats.isDirectory ? stats : {}),
        ...(old?.skipWorktree ? { skipWorktree: true } : {}),
      },
    ]);
  }
  const conflicts = [...(options.conflicts ?? [])];
  for (const conflict of conflicts) {
    const stages: [CheckedEntry | undefined, 1 | 2 | 3][] = [
      [conflict.base, 1],
      [conflict.ours, 2],
      [conflict.theirs, 3],
    ];
    const list: IndexEntryOptions[] = [];
    for (const [entry, stage] of stages) {
      if (!entry) continue;
      list.push({
        path: conflict.stagePath,
        objectId: entry.objectId,
        mode: entry.mode,
        stage,
        size: 0,
        mtime: 0,
      });
    }
    // a stage-0 entry the switch wrote here gives way to the conflict's stages
    changes.set(conflict.stagePath, [
      ...(changes.get(conflict.stagePath) ?? []).filter((e) => (e.stage ?? 0) > 0),
      ...list,
    ]);
  }
  // unpack-trees writes a new index: the resolve-undo records are gone (git keeps them only
  // through commands that edit the index in place)
  ctx.staging.clearResolveUndo?.();
  let switchedCacheTree: CacheTree | undefined;
  if (options.targetTree && ctx.staging.setCacheTree) {
    // the cache-tree of the target (unpack_trees: the index's cache-tree, each path changed
    // invalidated, then cache_tree_update: only invalid directories are read), the
    // directories of the intent-to-add entries kept and of the conflicts invalid
    // (record_conflicted_index_entries)
    const previous = ctx.staging.getCacheTree?.();
    if (previous) {
      for (const path of [...updates, ...removes]) invalidateCacheTreePath(previous, path);
    }
    const cacheTree = await updateCacheTree(ctx.trees, options.targetTree, previous);
    // the index the switch leaves is the target only where it switched: an entry it kept
    // (a staged change the two trees agree on, carried over) differs from the target, and
    // its directories are invalid, as cache_tree_update computes them from the index
    const result = new Map<string, CheckedEntry>();
    for (const [path, entry] of index) {
      const e = entry as IndexEntryInput;
      if (changes.has(path) || e.intentToAdd) continue;
      result.set(path, { objectId: entry.objectId, mode: entry.mode });
    }
    for (const path of updates) {
      if (changes.get(path)?.some((e) => (e.stage ?? 0) === 0)) {
        result.set(path, target.get(path) as CheckedEntry);
      }
    }
    await invalidateCacheTreeAgainstIndex(
      ctx.trees,
      cacheTree,
      options.targetTree,
      result,
      previous,
    );
    for (const path of unmerged) invalidateCacheTreePath(cacheTree, path);
    for (const [path, entry] of index) {
      const e = entry as IndexEntryInput;
      if (e.intentToAdd && !changes.has(path)) {
        invalidateCacheTreeForIntentToAdd(cacheTree, path);
      }
    }
    for (const conflict of conflicts) {
      invalidateCacheTreePath(cacheTree, conflict.stagePath);
    }
    switchedCacheTree = cacheTree;
  }
  // set once the changes are in: it describes the index they leave
  await rewriteIndex(ctx.staging, changes, { cacheTree: switchedCacheTree });
  return { written: worktree ? writing : new Set() };
}

/**
 * The refusal unpack-trees prints without porcelain messages: it stops at the first path
 * refused (in path order), with that path's one `error:` line.
 */
export function firstPlainError(
  found: Partial<Record<Parameters<typeof plainUnpackError>[0], string[]>>,
): string | undefined {
  let best: { kind: Parameters<typeof plainUnpackError>[0]; path: string } | undefined;
  for (const [kind, paths] of Object.entries(found) as [
    Parameters<typeof plainUnpackError>[0],
    string[] | undefined,
  ][]) {
    for (const path of paths ?? []) {
      if (!best || compareGitPaths(path, best.path) < 0) best = { kind, path };
    }
  }
  return best ? plainUnpackError(best.kind, best.path) : undefined;
}

/** git's `# Conflicts:` block appended to MERGE_MSG. */
export function conflictsComment(paths: string[], unclean = paths.length > 0): string {
  if (!unclean) return "";
  return `\n# Conflicts:\n${paths.map((p) => `#\t${p}\n`).join("")}`;
}

/** The commit's first line (git's subject, as in `<abbrev> (<subject>)`). */
export function subjectOf(message: string): string {
  // git's format_subject after skip_blank_lines: the first paragraph's lines, each without
  // its trailing blanks (git's isspace: ASCII space, tab, LF, CR; never a no-break space),
  // joined with a space
  const lines = message.split("\n").map((l) => l.replace(/[ \t\r]+$/, ""));
  let i = 0;
  while (i < lines.length && lines[i] === "") i++;
  const subject: string[] = [];
  for (; i < lines.length && lines[i] !== ""; i++) subject.push(lines[i] as string);
  return subject.join(" ");
}
