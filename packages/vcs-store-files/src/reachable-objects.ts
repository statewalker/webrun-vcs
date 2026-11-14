/**
 * What repack and gc keep: the objects reachable from every ref, HEAD, the reflogs, the index
 * and every linked worktree (its HEAD, index and reflogs), as `git repack -a` (`--all --reflog
 * --indexed-objects`) and `git prune` walk them.
 *
 * Not read: the trees of the index's cache-tree (TREE) extension, which git also counts as
 * roots. The index parser does not expose that extension; a tree only it names may be pruned,
 * and git then rebuilds that part of the cache-tree (it checks each tree exists before use).
 */

import type { FilesApi, GitObjects, ListedObject, ObjectId, Refs } from "@statewalker/vcs-core";
import { isSymbolicRef, joinPath, listObjects } from "@statewalker/vcs-core";
import { parseIndexFile } from "@statewalker/vcs-working-tree";

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
}

/**
 * The roots of reachability: every ref, HEAD, the old and new ids of every reflog entry
 * (`logs/HEAD`, `logs/refs/...`), the entries of the index (gitlinks excepted), and for each
 * linked worktree (`worktrees/<name>/`) its HEAD (detached or symbolic), index and reflogs, as
 * git's `other_head_refs` and its worktree index and reflog walks. Roots the store does not
 * have are left out (a reflog may name objects pruned long ago).
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

  // Linked worktrees: their HEAD, index and reflogs live under worktrees/<name>/
  const worktrees = joinPath(gitDir, "worktrees");
  if ((await files.stats(worktrees))?.kind === "directory") {
    for await (const wt of files.list(worktrees)) {
      if (wt.kind !== "directory") continue;
      const id = await worktreeHead(files, joinPath(wt.path, "HEAD"), async (target) => {
        return resolveStored(target) ?? (await refs.resolve(target))?.objectId;
      });
      if (id) tips.add(id);
      for (const id of await reflogIds(files, joinPath(wt.path, "logs"))) tips.add(id);
      for (const id of await indexIds(files, joinPath(wt.path, "index"))) tips.add(id);
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
  for await (const o of listObjects(roots.objects, { wants })) listed.push(o);
  return listed;
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
  return parsed.entries.filter((e) => e.mode !== GITLINK).map((e) => e.objectId);
}
