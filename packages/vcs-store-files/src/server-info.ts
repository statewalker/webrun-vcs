/**
 * `git update-server-info`, as `git repack` runs it at its end (repack.c, unless `-n`): the
 * files a dumb HTTP client reads, `info/refs` (each ref under `refs/` in name order, `<id>\t<name>`,
 * an annotated tag followed by `<peeled id>\t<name>^{}`) and `objects/info/packs` (`P
 * pack-<id>.pack` per local pack, then an empty line). Each file is rewritten only when its
 * content changed, as git's `update_info_file`; packs the old `objects/info/packs` listed keep
 * their order and new ones follow.
 */

import type { FilesApi, GitObjects, ObjectId, PackSet } from "@statewalker/vcs-core";
import { isSymbolicRef, joinPath } from "@statewalker/vcs-core";
import { objectLinks } from "./cruft-pack.js";
import { readAllRefs } from "./refs/index.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** What `updateServerInfo` reads. */
export interface ServerInfoOptions {
  files: FilesApi;
  /** The git directory (the common one of a linked worktree) */
  gitDir?: string;
  /** The objects, to peel annotated tags */
  objects: GitObjects;
  /** The local packs */
  packs: PackSet;
}

/**
 * Writes `info/refs` and `objects/info/packs` (git's `update_server_info`) and removes a
 * leftover `info/rev-cache`.
 *
 * @example
 * ```typescript
 * await updateServerInfo({ files, gitDir: ".git", objects: history.objects, packs: history.packs });
 * ```
 */
export async function updateServerInfo(o: ServerInfoOptions): Promise<void> {
  const gitDir = o.gitDir ?? ".git";
  await writeIfChanged(o.files, joinPath(gitDir, "info", "refs"), await infoRefs(o, gitDir));
  const packsFile = joinPath(gitDir, "objects", "info", "packs");
  await writeIfChanged(o.files, packsFile, await infoPacks(o, packsFile));
  const revCache = joinPath(gitDir, "info", "rev-cache");
  if (await o.files.exists(revCache)) await o.files.remove(revCache);
}

async function infoRefs(o: ServerInfoOptions, gitDir: string): Promise<string> {
  const refs = await readAllRefs(o.files, gitDir, "refs/");
  const byName = new Map(refs.map((r) => [r.name, r]));
  let out = "";
  for (const ref of refs) {
    let target: (typeof refs)[number] | undefined = ref;
    for (let depth = 0; target && isSymbolicRef(target) && depth < 5; depth++)
      target = byName.get(target.target);
    if (!target || isSymbolicRef(target) || !target.objectId) continue;
    const id = target.objectId;
    const type = await o.objects.objectType?.(id).catch(() => undefined);
    if (!type && !(await o.objects.has(id).catch(() => false))) continue;
    out += `${id}\t${ref.name}\n`;
    if (type === "tag") {
      const peeled = await peel(o.objects, id);
      if (peeled) out += `${peeled}\t${ref.name}^{}\n`;
    }
  }
  return out;
}

/** The object an annotated tag (chain) finally names. */
async function peel(objects: GitObjects, id: ObjectId): Promise<ObjectId | undefined> {
  let current = id;
  for (let depth = 0; depth < 64; depth++) {
    const type = await objects.objectType?.(current).catch(() => undefined);
    if (type !== "tag") return current;
    const [next] = await objectLinks(objects, current);
    if (!next) return undefined;
    current = next;
  }
  return undefined;
}

async function infoPacks(o: ServerInfoOptions, path: string): Promise<string> {
  await o.packs.refresh();
  const names = (await o.packs.packs()).map((p) => `pack-${p.packId}.pack`);
  const old = (await readText(o.files, path)) ?? "";
  const oldOrder = old
    .split("\n")
    .filter((l) => l.startsWith("P "))
    .map((l) => l.slice(2));
  const known = new Set(names);
  const listed = oldOrder.filter((n) => known.has(n));
  const seen = new Set(listed);
  for (const n of names) if (!seen.has(n)) listed.push(n);
  return `${listed.map((n) => `P ${n}\n`).join("")}\n`;
}

async function readText(files: FilesApi, path: string): Promise<string | undefined> {
  if ((await files.stats(path))?.kind !== "file") return undefined;
  let out = "";
  for await (const c of files.read(path)) out += dec.decode(c, { stream: true });
  return out + dec.decode();
}

/** Replaces `path` through a temporary file and a rename, when its content changes. */
async function writeIfChanged(files: FilesApi, path: string, text: string): Promise<void> {
  if ((await readText(files, path)) === text) return;
  const dir = path.slice(0, path.lastIndexOf("/"));
  await files.mkdir(dir);
  const tmp = `${path}_${Math.random().toString(36).slice(2, 8)}`;
  await files.write(tmp, [enc.encode(text)]);
  if (!(await files.move(tmp, path))) {
    await files.remove(tmp).catch(() => false);
    throw new Error(`unable to update ${path}`);
  }
}
