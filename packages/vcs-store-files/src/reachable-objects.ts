/**
 * What repack and gc keep: the objects reachable from every ref, HEAD, the reflogs, the index
 * (every stage, the trees of its cache-tree and the blobs of its resolve-undo extension) and
 * every linked worktree (its HEAD, index, reflogs and per-worktree refs: `refs/bisect/*`,
 * `refs/worktree/*`, `refs/rewritten/*` under `worktrees/<name>/`), as `git repack -a`
 * (`--all --reflog --indexed-objects`) and `git prune` walk them (git's
 * `mark_reachable_objects`). The main worktree's per-worktree refs live under `refs/` and are
 * read with the other refs.
 *
 * A commit named in `info/grafts` has its grafted parents walked as well as the ones it
 * records: git's gc keeps both (`repack --keep-true-parents` packs the real parents, `prune`
 * walks the grafted ones). Replace refs are refs: the replacements are roots, and the objects
 * they replace stay reachable through whatever names them.
 *
 * As git, the pseudo-refs of an operation in progress (`MERGE_HEAD`, `CHERRY_PICK_HEAD`,
 * `ORIG_HEAD`, `FETCH_HEAD`, `MERGE_AUTOSTASH`, ...) are no roots: `rev-list --all` (repack's
 * pack-objects) does not list them, so a commit only they name is unreachable (a cruft object
 * that expires, or gone with `--prune=now`). git's prune (`mark_reachable_objects`, 2.5x:
 * `add_rebase_files`) also keeps what `rebase-apply/` and `rebase-merge/`'s `autostash` and
 * `orig-head` name, in every worktree: `rebaseFiles` adds those.
 *
 * A split index (a `link` extension) is read with its shared index (`sharedindex.<id>`), so
 * the blobs staged there stay roots; a sparse index's sparse directories are roots as the
 * trees they name.
 */

import type {
  CommitGraphProvider,
  FilesApi,
  GitObjects,
  ListedObject,
  ObjectId,
  Ref,
  Refs,
  ResolvedObjectFilter,
  SymbolicRef,
} from "@statewalker/vcs-core";
import { isSymbolicRef, joinPath, listObjects, readGraftParents } from "@statewalker/vcs-core";
import { decodeGitPath } from "@statewalker/vcs-utils/encoding";
import { bytesToHex } from "@statewalker/vcs-utils/hash/utils";
import { parseResolveUndo, readIndexFileEntries } from "@statewalker/vcs-working-tree";

import { readAllRefs } from "./refs/index.js";

const OID = /^[0-9a-f]{40}$/;
const ZERO = "0".repeat(40);
/** The empty blob and tree: git reads them whether stored or not (`find_cached_object`). */
const VIRTUAL = new Set([
  "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391",
  "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
]);

/**
 * A root gc, repack and prune cannot do without is not stored: a ref, HEAD or an index entry
 * names an object the repository (and its alternates) lack. Nothing has changed.
 */
export class MissingRootError extends Error {
  constructor(
    message: string,
    /** The missing object */
    readonly objectId: ObjectId,
  ) {
    super(message);
    this.name = "MissingRootError";
  }
}
/** A gitlink (submodule commit): the object lives in another repository. */
const GITLINK = 0o160000;

/** Where the roots of reachability are read. */
export interface ReachabilityRoots {
  files: FilesApi;
  /** Path of the `.git` directory within `files` (default ".git"). */
  gitDir?: string;
  /** The refs: every ref and HEAD are roots. */
  refs: Refs;
  /** The objects, to drop roots that are not stored (a reflog entry already pruned). */
  objects: Pick<GitObjects, "has" | "get">;
  /**
   * The commit-graph: the walk takes the trees and parents of the commits it has from it
   * instead of reading them, as git's reachability walk does.
   */
  commitGraph?: CommitGraphProvider;
  /**
   * Reads the grafts file in place of `info/grafts` (git's `GIT_GRAFT_FILE`): the commits its
   * grafts name are walked too. Omit to read `info/grafts` (`refs.readGrafts`).
   */
  readGraftFile?: () => Promise<string | undefined>;
  /**
   * A partial clone's promisor objects (`promisorExclusions`): neither listed nor walked, as
   * git's gc and repack walk with `--exclude-promisor-objects`
   */
  excludeObjects?: ReadonlySet<ObjectId>;
  /**
   * More roots, walked when stored (a partial clone's local objects that promisor objects
   * link to: `PromisorExclusions.roots`)
   */
  extraRoots?: Iterable<ObjectId>;
  /** A filter the listing applies (`git repack --filter=<spec>`'s pack-objects `--filter`) */
  filter?: ResolvedObjectFilter;
  /**
   * Also the commits `rebase-apply/autostash`, `rebase-apply/orig-head`,
   * `rebase-merge/autostash` and `rebase-merge/orig-head` name, of the repository and of every
   * linked worktree: git 2.5x's prune (`add_rebase_files`); repack and 2.43 do not
   */
  rebaseFiles?: boolean;
}

/**
 * The roots of reachability: every ref, HEAD, the old and new ids of every reflog entry
 * (`logs/HEAD`, `logs/refs/...`), the entries of the index (gitlinks excepted, every stage),
 * the trees of its cache-tree (TREE) and the blobs of its resolve-undo (REUC) extension (with
 * `rebaseFiles`, the rebase files: see above), and for each linked worktree
 * (`worktrees/<name>/`) its HEAD (detached or symbolic), index and reflogs (and rebase
 * files), as git's `other_head_refs` and its
 * worktree index and reflog walks. Roots the store does not have are left out (a reflog may
 * name objects pruned long ago).
 *
 * Refs are listed strictly from the files: a ref that cannot be read or is malformed throws,
 * as does an unreadable reflog, index or worktree HEAD. A root skipped silently would let gc
 * and repack delete what it holds, so they abort instead, as `git gc` does.
 *
 * A ref, HEAD (a linked worktree's too) or index entry whose object is not stored throws
 * ({@link MissingRootError}: `bad object <name>`, `unable to read <id>`), as git's
 * `get_reference` and pack-objects die (an alternate that cannot be read hides what it holds:
 * pruning then would delete what the missing commits reach). Reflog entries, rebase files and
 * the cache-tree's and resolve-undo's ids are left out when missing, as git tolerates them.
 *
 * @example
 * ```typescript
 * const tips = await collectReachabilityRoots({ files, refs: history.refs, objects });
 * ```
 */
export async function collectReachabilityRoots(roots: ReachabilityRoots): Promise<ObjectId[]> {
  return (await collectRoots(roots)).ids;
}

/**
 * The roots, with the path git's `--indexed-objects` gives each tree or blob it adds first
 * (an index entry's name, a cache-tree node's directory, a resolve-undo record's path).
 */
async function collectRoots(
  roots: ReachabilityRoots,
): Promise<{ ids: ObjectId[]; paths: Map<ObjectId, string> }> {
  const { files, refs, objects } = roots;
  const gitDir = roots.gitDir ?? ".git";
  const tips = new Set<ObjectId>();
  // roots that must be stored, with git's message when one is not (the first naming wins)
  const required = new Map<ObjectId, string>();
  const require = (id: ObjectId, message: string) => {
    if (!required.has(id)) required.set(id, message);
  };
  // the name of a tree or blob the index adds before anything else names it (git's pending
  // path: an object a ref names first is listed as "")
  const paths = new Map<ObjectId, string>();
  const name = (id: ObjectId, path: string) => {
    if (!required.has(id) && !tips.has(id) && !paths.has(id)) paths.set(id, path);
  };
  const requireIndex = (ids: IndexRoots) => {
    for (const { id, path } of ids.entries) {
      name(id, path);
      require(id, `unable to read ${id}`);
    }
    for (const { id, path } of ids.extra) {
      name(id, path);
      tips.add(id);
    }
  };

  // a reftable repository keeps its refs, per-worktree refs and reflogs in its stacks: read
  // through the ref store (its `refs/heads` and HEAD files are stubs for older gits)
  const reftable = reftableRoots(refs);
  // The refs on storage, strictly: a ref that cannot be read throws instead of being skipped
  const stored = reftable ? [] : await readAllRefs(files, gitDir, "", { strict: true });
  const byName = new Map(stored.map((r) => [r.name, r]));
  const resolveStored = (name: string): ObjectId | undefined => {
    let ref = byName.get(name);
    for (let depth = 0; ref && isSymbolicRef(ref) && depth < 5; depth++)
      ref = byName.get(ref.target);
    return ref && !isSymbolicRef(ref) ? ref.objectId : undefined;
  };
  for (const ref of stored) {
    const id = resolveStored(ref.name);
    if (id) require(id, `bad object ${ref.name}`);
  }
  // and through the Refs API too (a store that keeps refs elsewhere)
  for await (const ref of refs.list()) {
    const resolved = await refs.resolve(ref.name);
    if (resolved?.objectId) require(resolved.objectId, `bad object ${ref.name}`);
  }
  const head = await refs.resolve("HEAD");
  if (head?.objectId) require(head.objectId, "bad object HEAD");

  const logIds = reftable
    ? await storeReflogIds(refs, await reftable.reflogNames())
    : await reflogIds(files, joinPath(gitDir, "logs"));
  for (const id of logIds) tips.add(id);
  requireIndex(await indexIds(files, joinPath(gitDir, "index")));
  if (roots.rebaseFiles) for (const id of await rebaseFileIds(files, gitDir)) tips.add(id);
  for (const id of roots.extraRoots ?? []) tips.add(id);

  // Linked worktrees: their HEAD, index and reflogs live under worktrees/<name>/
  const worktrees = joinPath(gitDir, "worktrees");
  if ((await files.stats(worktrees))?.kind === "directory") {
    for await (const wt of files.list(worktrees)) {
      if (wt.kind !== "directory") continue;
      const label = `worktrees/${wt.path.slice(wt.path.lastIndexOf("/") + 1)}`;
      const id = reftable
        ? (await refs.resolve(`${label}/HEAD`))?.objectId
        : await worktreeHead(files, joinPath(wt.path, "HEAD"), async (target) => {
            return resolveStored(target) ?? (await refs.resolve(target))?.objectId;
          });
      if (id) require(id, `bad object ${label}/HEAD`);
      // its per-worktree refs (refs/bisect/*, refs/worktree/*, refs/rewritten/*), always loose
      // (in its own stack in a reftable repository)
      const own = reftable
        ? await reftable.worktreeRefs(label.slice("worktrees/".length))
        : await readAllRefs(files, wt.path, "refs/", { strict: true });
      const ownByName = new Map(own.map((r) => [r.name, r]));
      for (const ref of own) {
        let target: typeof ref | undefined = ref;
        for (let depth = 0; target && isSymbolicRef(target) && depth < 5; depth++) {
          const name: string = target.target;
          target = ownByName.get(name) ?? byName.get(name);
        }
        if (target && !isSymbolicRef(target) && target.objectId)
          require(target.objectId, `bad object ${label}/${ref.name}`);
      }
      const wtLogIds = reftable
        ? await storeReflogIds(
            refs,
            (await reftable.reflogNames(label.slice("worktrees/".length))).filter((n) =>
              n.startsWith(`${label}/`),
            ),
          )
        : await reflogIds(files, joinPath(wt.path, "logs"));
      for (const id of wtLogIds) tips.add(id);
      requireIndex(await indexIds(files, joinPath(wt.path, "index")));
      if (roots.rebaseFiles) for (const id of await rebaseFileIds(files, wt.path)) tips.add(id);
    }
  }

  const present: ObjectId[] = [];
  for (const [id, message] of required) {
    if (!VIRTUAL.has(id) && !(await objects.has(id))) throw new MissingRootError(message, id);
    present.push(id);
    tips.delete(id);
  }
  for (const id of tips) if (await objects.has(id)) present.push(id);
  return { ids: present, paths };
}

/** A worktree's HEAD: a detached object id, or `ref: <name>` resolved through `resolve`. */
async function worktreeHead(
  files: FilesApi,
  path: string,
  resolve: (name: string) => Promise<ObjectId | undefined>,
): Promise<ObjectId | undefined> {
  const text = (await readText(files, path))?.trim();
  if (!text) return undefined;
  if (text.startsWith("ref:")) return resolve(text.slice(4).trim());
  const id = text.slice(0, 40).toLowerCase();
  if (!OID.test(id)) throw new Error(`Invalid worktree HEAD ${path}: ${text.slice(0, 60)}`);
  return id;
}

/**
 * Lists every object reachable from the roots (see `collectReachabilityRoots`), with its type
 * and path, as `git rev-list --objects --all --reflog --indexed-objects` does. Only ids, types
 * and paths are kept: the objects themselves are read one at a time.
 */
export async function listReachableObjects(roots: ReachabilityRoots): Promise<ListedObject[]> {
  const { ids: wants, paths: tipPaths } = await collectRoots(roots);
  const listed: ListedObject[] = [];
  if (wants.length === 0) return listed;
  // the parents of shallow commits are not there (git's grafts): not walked
  const shallow = (await roots.refs.getShallow?.()) ?? [];
  // a grafted commit's parents are walked too, besides the ones it records: git's repack
  // (`--keep-true-parents`) keeps the real parents and its prune walks the grafted ones
  const grafts = await readGraftParents(roots.refs, roots.readGraftFile);
  const graph = await roots.commitGraph?.get().catch(() => undefined);
  const commitHeader = graph
    ? async (id: ObjectId) => {
        const pos = graph.position(id);
        if (pos < 0) return undefined;
        return {
          tree: graph.treeAt(pos),
          parents: graph.parentsAt(pos),
          commitTime: graph.commitTimeAt(pos),
        };
      }
    : undefined;
  for await (const o of listObjects(roots.objects, {
    wants,
    shallow,
    grafts,
    commitHeader,
    tipPaths,
    ...(roots.excludeObjects ? { excludeObjects: roots.excludeObjects } : {}),
    ...(roots.filter ? { filter: roots.filter } : {}),
  })) {
    listed.push(o);
  }
  return listed;
}

/** The files git's prune (2.5x `add_rebase_files`) reads in each worktree's git directory. */
const REBASE_FILES = [
  "rebase-apply/autostash",
  "rebase-apply/orig-head",
  "rebase-merge/autostash",
  "rebase-merge/orig-head",
];

/**
 * The ids git 2.5x's prune adds from the rebase files (`add_rebase_files`) of the repository
 * and of each linked worktree.
 */
export async function rebaseFileRoots(files: FilesApi, gitDir = ".git"): Promise<ObjectId[]> {
  const ids = await rebaseFileIds(files, gitDir);
  const worktrees = joinPath(gitDir, "worktrees");
  if ((await files.stats(worktrees))?.kind === "directory")
    for await (const wt of files.list(worktrees))
      if (wt.kind === "directory") ids.push(...(await rebaseFileIds(files, wt.path)));
  return ids;
}

/** The object ids the rebase files in `dir` name (the first line of each). */
async function rebaseFileIds(files: FilesApi, dir: string): Promise<ObjectId[]> {
  const ids: ObjectId[] = [];
  for (const name of REBASE_FILES) {
    const text = await readText(files, joinPath(dir, name));
    const id = text?.slice(0, 40).toLowerCase();
    if (id && OID.test(id) && id !== ZERO) ids.push(id);
  }
  return ids;
}

async function readText(files: FilesApi, path: string): Promise<string | undefined> {
  if ((await files.stats(path))?.kind !== "file") return undefined;
  const dec = new TextDecoder();
  let out = "";
  for await (const c of files.read(path)) out += dec.decode(c, { stream: true });
  return out + dec.decode();
}

/** The reftable ref store's listings (`ReftableRefStore`), when `refs` is one. */
function reftableRoots(refs: Refs):
  | {
      reflogNames(worktree?: string): Promise<string[]>;
      worktreeRefs(worktree: string): Promise<(Ref | SymbolicRef)[]>;
    }
  | undefined {
  const r = refs as Partial<{
    reflogNames(worktree?: string): Promise<string[]>;
    worktreeRefs(worktree: string): Promise<(Ref | SymbolicRef)[]>;
  }>;
  return r.reflogNames && r.worktreeRefs
    ? {
        reflogNames: (w) => (r.reflogNames as (w?: string) => Promise<string[]>).call(refs, w),
        worktreeRefs: (w) =>
          (r.worktreeRefs as (w: string) => Promise<(Ref | SymbolicRef)[]>).call(refs, w),
      }
    : undefined;
}

/** The old and new ids of every entry of the reflogs `names`, read through the ref store. */
async function storeReflogIds(refs: Refs, names: string[]): Promise<ObjectId[]> {
  const ids: ObjectId[] = [];
  for (const name of names) {
    const reader = await refs.getReflog?.(name);
    if (!reader) continue;
    for (const e of await reader.getReverseEntries()) {
      if (OID.test(e.oldId) && e.oldId !== ZERO) ids.push(e.oldId);
      if (OID.test(e.newId) && e.newId !== ZERO) ids.push(e.newId);
    }
  }
  return ids;
}

/** The old and new ids of every entry of every reflog under `logsDir`. */
async function reflogIds(files: FilesApi, logsDir: string): Promise<ObjectId[]> {
  const ids: ObjectId[] = [];
  if ((await files.stats(logsDir))?.kind !== "directory") return ids;
  const walk = async (dir: string) => {
    for await (const e of files.list(dir)) {
      if (e.kind === "directory") {
        await walk(e.path);
        continue;
      }
      const text = await readText(files, e.path);
      for (const line of text?.split("\n") ?? []) {
        const oldId = line.slice(0, 40);
        const newId = line.slice(41, 81);
        if (OID.test(oldId) && oldId !== ZERO) ids.push(oldId);
        if (OID.test(newId) && newId !== ZERO) ids.push(newId);
      }
    }
  };
  await walk(logsDir);
  return ids;
}

/** An index's roots, each with the path git's `--indexed-objects` lists it with. */
interface IndexRoots {
  /** its entries (gitlinks excepted), which must be stored */
  entries: { id: ObjectId; path: string }[];
  /** the cache-tree's trees and the resolve-undo's blobs */
  extra: { id: ObjectId; path: string }[];
}

/**
 * The object ids the index records: its entries' (gitlinks excepted), and the cache-tree's
 * and resolve-undo's (`extra`), in git's order (do_add_index_objects_to_pending).
 */
async function indexIds(files: FilesApi, indexPath: string): Promise<IndexRoots> {
  if ((await files.stats(indexPath))?.kind !== "file") return { entries: [], extra: [] };
  // a split index merged with its shared index; a sparse index's directories stay trees
  const gitDir = indexPath.slice(0, Math.max(0, indexPath.lastIndexOf("/")));
  const read = await readIndexFileEntries(files, indexPath, { gitDir });
  if (!read) return { entries: [], extra: [] };
  const parsed = { entries: read.entries, extensionData: read.extensions };
  const entries = parsed.entries
    .filter((e) => e.mode !== GITLINK)
    // a sparse index's directory as its path without the slash (git expands it first)
    .map((e) => ({ id: e.objectId, path: e.path.endsWith("/") ? e.path.slice(0, -1) : e.path }));
  const ids: { id: ObjectId; path: string }[] = [];
  for (const ext of parsed.extensionData) {
    if (ext.signature === "TREE") ids.push(...cacheTreeIds(ext.data, indexPath));
    else if (ext.signature === "REUC") {
      // git's add_resolve_undo_to_pending: `git checkout -m` recreates a conflict from them
      for (const record of parseResolveUndo(ext.data)) {
        record.objectIds.forEach((id, i) => {
          if (id && record.modes[i] !== GITLINK) ids.push({ id, path: record.path });
        });
      }
    }
  }
  return { entries, extra: ids };
}

/**
 * The trees of a cache-tree (TREE) extension, with their directories: per node, a
 * NUL-terminated name, the ASCII entry count, a space, the ASCII subtree count and a newline,
 * then the tree id unless the entry count is -1 (an invalidated node); its subtrees follow it.
 * git's `add_cache_tree` keeps them.
 */
function cacheTreeIds(data: Uint8Array, indexPath: string): { id: ObjectId; path: string }[] {
  const ids: { id: ObjectId; path: string }[] = [];
  // the open directories: their path and how many subtrees are still to come
  const open: { path: string; left: number }[] = [];
  let p = 0;
  while (p < data.length) {
    const nul = data.indexOf(0, p);
    const lf = nul < 0 ? -1 : data.indexOf(10, nul);
    if (lf < 0) throw new Error(`${indexPath}: malformed cache-tree extension`);
    const component = decodeGitPath(data.subarray(p, nul));
    const [count, subtrees] = new TextDecoder().decode(data.subarray(nul + 1, lf)).split(" ");
    p = lf + 1;
    while (open.length > 0 && (open[open.length - 1] as { left: number }).left === 0) open.pop();
    const parent = open[open.length - 1];
    let path = component;
    if (parent) {
      parent.left--;
      path = parent.path ? `${parent.path}/${component}` : component;
    }
    open.push({ path, left: Math.max(0, Number(subtrees) || 0) });
    if (Number(count) < 0) continue;
    if (p + 20 > data.length) throw new Error(`${indexPath}: malformed cache-tree extension`);
    ids.push({ id: bytesToHex(data.subarray(p, p + 20)), path });
    p += 20;
  }
  return ids;
}
