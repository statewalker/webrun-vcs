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
 * Beyond git: the pseudo-refs of an operation in progress (`MERGE_HEAD`, `CHERRY_PICK_HEAD`,
 * `REVERT_HEAD`, `REBASE_HEAD`, `ORIG_HEAD`, `AUTO_MERGE`, `BISECT_HEAD`, `FETCH_HEAD`) and
 * the autostash of a merge or rebase (`MERGE_AUTOSTASH`, `rebase-merge/autostash`,
 * `rebase-apply/autostash`), of the repository and of each linked worktree, are roots too. git's `for_each_ref` does not list
 * them, so `git gc --prune=now` may delete a commit only they name (one fetched into
 * `FETCH_HEAD` alone, or a merged branch deleted mid-merge); we keep it.
 *
 * A split index (a `link` extension) is refused: its entries live partly in a shared index
 * file, so the blobs staged there would silently stop being roots. gc and repack throw before
 * changing anything; `git update-index --no-split-index` turns it back into one file.
 */

import type {
  CommitGraphProvider,
  FilesApi,
  GitObjects,
  ListedObject,
  ObjectId,
  Refs,
} from "@statewalker/vcs-core";
import { isSymbolicRef, joinPath, listObjects, readGraftParents } from "@statewalker/vcs-core";
import { bytesToHex } from "@statewalker/vcs-utils/hash/utils";
import { parseIndexFile, parseResolveUndo } from "@statewalker/vcs-working-tree";

import { readAllRefs } from "./refs/index.js";

const OID = /^[0-9a-f]{40}$/;
const ZERO = "0".repeat(40);
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
}

/**
 * The roots of reachability: every ref, HEAD, the old and new ids of every reflog entry
 * (`logs/HEAD`, `logs/refs/...`), the entries of the index (gitlinks excepted, every stage),
 * the trees of its cache-tree (TREE) and the blobs of its resolve-undo (REUC) extension, the
 * pseudo-refs (see above), and for each linked worktree (`worktrees/<name>/`) its HEAD
 * (detached or symbolic), index, reflogs and pseudo-refs, as git's `other_head_refs` and its
 * worktree index and reflog walks. Roots the store does not have are left out (a reflog may
 * name objects pruned long ago).
 *
 * Refs are listed strictly from the files: a ref that cannot be read or is malformed throws,
 * as does an unreadable reflog, index or worktree HEAD. A root skipped silently would let gc
 * and repack delete what it holds, so they abort instead, as `git gc` does.
 *
 * @example
 * ```typescript
 * const tips = await collectReachabilityRoots({ files, refs: history.refs, objects });
 * ```
 */
export async function collectReachabilityRoots(roots: ReachabilityRoots): Promise<ObjectId[]> {
  const { files, refs, objects } = roots;
  const gitDir = roots.gitDir ?? ".git";
  const tips = new Set<ObjectId>();

  // The refs on storage, strictly: a ref that cannot be read throws instead of being skipped
  const stored = await readAllRefs(files, gitDir, "", { strict: true });
  const byName = new Map(stored.map((r) => [r.name, r]));
  const resolveStored = (name: string): ObjectId | undefined => {
    let ref = byName.get(name);
    for (let depth = 0; ref && isSymbolicRef(ref) && depth < 5; depth++)
      ref = byName.get(ref.target);
    return ref && !isSymbolicRef(ref) ? ref.objectId : undefined;
  };
  for (const ref of stored) {
    const id = resolveStored(ref.name);
    if (id) tips.add(id);
  }
  // and through the Refs API too (a store that keeps refs elsewhere)
  for await (const ref of refs.list()) {
    const resolved = await refs.resolve(ref.name);
    if (resolved?.objectId) tips.add(resolved.objectId);
  }
  const head = await refs.resolve("HEAD");
  if (head?.objectId) tips.add(head.objectId);

  for (const id of await reflogIds(files, joinPath(gitDir, "logs"))) tips.add(id);
  for (const id of await indexIds(files, joinPath(gitDir, "index"))) tips.add(id);
  for (const id of await pseudoRefIds(files, gitDir)) tips.add(id);

  // Linked worktrees: their HEAD, index and reflogs live under worktrees/<name>/
  const worktrees = joinPath(gitDir, "worktrees");
  if ((await files.stats(worktrees))?.kind === "directory") {
    for await (const wt of files.list(worktrees)) {
      if (wt.kind !== "directory") continue;
      const id = await worktreeHead(files, joinPath(wt.path, "HEAD"), async (target) => {
        return resolveStored(target) ?? (await refs.resolve(target))?.objectId;
      });
      if (id) tips.add(id);
      // its per-worktree refs (refs/bisect/*, refs/worktree/*, refs/rewritten/*), always loose
      const own = await readAllRefs(files, wt.path, "refs/", { strict: true });
      const ownByName = new Map(own.map((r) => [r.name, r]));
      for (const ref of own) {
        let target: typeof ref | undefined = ref;
        for (let depth = 0; target && isSymbolicRef(target) && depth < 5; depth++) {
          const name: string = target.target;
          target = ownByName.get(name) ?? byName.get(name);
        }
        if (target && !isSymbolicRef(target) && target.objectId) tips.add(target.objectId);
      }
      for (const id of await reflogIds(files, joinPath(wt.path, "logs"))) tips.add(id);
      for (const id of await indexIds(files, joinPath(wt.path, "index"))) tips.add(id);
      for (const id of await pseudoRefIds(files, wt.path)) tips.add(id);
    }
  }

  const present: ObjectId[] = [];
  for (const id of tips) if (await objects.has(id)) present.push(id);
  return present;
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
  const wants = await collectReachabilityRoots(roots);
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
  for await (const o of listObjects(roots.objects, { wants, shallow, grafts, commitHeader })) {
    listed.push(o);
  }
  return listed;
}

/**
 * Pseudo-refs of an operation in progress, which name commits a reflog may not: a merge's
 * `MERGE_HEAD` (one line per merged head), `FETCH_HEAD` (one line per fetched ref), the
 * single-id ones, and the stash commits `--autostash` keeps while a merge or rebase runs
 * (`MERGE_AUTOSTASH`, `rebase-merge/autostash`, `rebase-apply/autostash`), which nothing else
 * names until they are applied or stored in the stash.
 */
const PSEUDO_REFS = [
  "ORIG_HEAD",
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "REBASE_HEAD",
  "AUTO_MERGE",
  "BISECT_HEAD",
  "FETCH_HEAD",
  "MERGE_AUTOSTASH",
  "rebase-merge/autostash",
  "rebase-apply/autostash",
];

/** The object ids at the start of the lines of the pseudo-refs in `dir`. */
async function pseudoRefIds(files: FilesApi, dir: string): Promise<ObjectId[]> {
  const ids: ObjectId[] = [];
  for (const name of PSEUDO_REFS) {
    const text = await readText(files, joinPath(dir, name));
    for (const line of text?.split("\n") ?? []) {
      const id = line.slice(0, 40).toLowerCase();
      if (OID.test(id) && id !== ZERO) ids.push(id);
    }
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

/** The object ids the index records (gitlinks excepted). */
async function indexIds(files: FilesApi, indexPath: string): Promise<ObjectId[]> {
  if ((await files.stats(indexPath))?.kind !== "file") return [];
  const parts: Uint8Array[] = [];
  let length = 0;
  for await (const c of files.read(indexPath)) {
    parts.push(c);
    length += c.length;
  }
  const data = new Uint8Array(length);
  let at = 0;
  for (const p of parts) {
    data.set(p, at);
    at += p.length;
  }
  const parsed = await parseIndexFile(data);
  if (parsed.extensions.includes("link")) {
    throw new Error(
      `${indexPath} is a split index (link extension), which gc and repack do not read: ` +
        "run `git update-index --no-split-index` first",
    );
  }
  const ids = parsed.entries.filter((e) => e.mode !== GITLINK).map((e) => e.objectId);
  for (const ext of parsed.extensionData) {
    if (ext.signature === "TREE") ids.push(...cacheTreeIds(ext.data, indexPath));
    else if (ext.signature === "REUC") {
      // git's add_resolve_undo_to_pending: `git checkout -m` recreates a conflict from them
      for (const record of parseResolveUndo(ext.data)) {
        record.objectIds.forEach((id, i) => {
          if (id && record.modes[i] !== GITLINK) ids.push(id);
        });
      }
    }
  }
  return ids;
}

/**
 * The trees of a cache-tree (TREE) extension: per node, a NUL-terminated path, the ASCII entry
 * count, a space, the ASCII subtree count and a newline, then the tree id unless the entry
 * count is -1 (an invalidated node). git's `add_cache_tree` keeps them.
 */
function cacheTreeIds(data: Uint8Array, indexPath: string): ObjectId[] {
  const ids: ObjectId[] = [];
  let p = 0;
  while (p < data.length) {
    const nul = data.indexOf(0, p);
    const lf = nul < 0 ? -1 : data.indexOf(10, nul);
    if (lf < 0) throw new Error(`${indexPath}: malformed cache-tree extension`);
    const [count] = new TextDecoder().decode(data.subarray(nul + 1, lf)).split(" ");
    p = lf + 1;
    if (Number(count) < 0) continue;
    if (p + 20 > data.length) throw new Error(`${indexPath}: malformed cache-tree extension`);
    ids.push(bytesToHex(data.subarray(p, p + 20)));
    p += 20;
  }
  return ids;
}
