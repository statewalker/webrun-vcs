/**
 * What repack and gc keep: the objects reachable from every ref, HEAD, the reflogs and the
 * index, as `git repack -a` (`--all --reflog --indexed-objects`) and `git prune` walk them.
 */

import type { FilesApi, GitObjects, ListedObject, ObjectId, Refs } from "@statewalker/vcs-core";
import { joinPath, listObjects } from "@statewalker/vcs-core";
import { parseIndexFile } from "@statewalker/vcs-working-tree";

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
 * (`logs/HEAD`, `logs/refs/...`) and the entries of the index (gitlinks excepted). Roots the
 * store does not have are left out (a reflog may name objects pruned long ago).
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

  for await (const ref of refs.list()) {
    const resolved = await refs.resolve(ref.name);
    if (resolved?.objectId) tips.add(resolved.objectId);
  }
  const head = await refs.resolve("HEAD");
  if (head?.objectId) tips.add(head.objectId);

  for (const id of await reflogIds(files, joinPath(gitDir, "logs"))) tips.add(id);
  for (const id of await indexIds(files, joinPath(gitDir, "index"))) tips.add(id);

  const present: ObjectId[] = [];
  for (const id of tips) if (await objects.has(id)) present.push(id);
  return present;
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
