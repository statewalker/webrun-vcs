/**
 * The files backend's quarantine, as git's receive-pack `tmp_objdir`: a pushed pack goes to
 * `objects/tmp_objdir-incoming-<id>/` (its loose objects in fan-out directories, a kept pack in
 * `pack/`), which no reader of the repository looks at: neither our `PackSet` (it scans
 * `objects/pack`) nor native git. Reads through the quarantine see it, then the repository.
 * `commit` moves the objects into `objects/` (loose objects first, then packs: `.keep`,
 * `.pack`, `.rev`, then `.idx`, git's `pack_copy_priority`, so a pack is never visible without
 * its data) and rescans the packs; `discard` removes the directory. A directory left by a crash
 * is removed by `sweepQuarantines` (gc), and native `git prune` removes it too (a `tmp_`
 * directory older than its expiry).
 */
import type { GitObjects, ObjectQuarantine, PackSet } from "@statewalker/vcs-core";
import { createGitObjects, joinPath, openPackSet, overlayObjects } from "@statewalker/vcs-core";
import { timestampedId, timestampOfId } from "@statewalker/vcs-utils";
import { type FilesApi, moveCompleting } from "@statewalker/vcs-utils/files";
import { skipPacked, withPacks } from "../pack/with-packs.js";
import { filesStagingStore } from "../storage/loose/files-staging-store.js";

/** Name prefix of a quarantine directory under `objects/` (git's own prefix). */
export const QUARANTINE_DIR_PREFIX = "tmp_objdir-incoming-";

const FANOUT = /^[0-9a-f]{2}$/;
const REST = /^[0-9a-f]{38}$/;

/** Quarantine directories open in this process: `sweepQuarantines` leaves them alone. */
const openDirs = new Set<string>();

export interface FilesQuarantineOptions {
  files: FilesApi;
  /** The repository's `objects` directory */
  objectsDir: string;
  /** The repository's objects (packs and loose), read after the quarantine */
  objects: GitObjects;
  /** The repository's packs, rescanned once a quarantined pack is moved in */
  packs: PackSet;
  /** Passed to the quarantine's loose store and packs (see `createGitFilesBackend`) */
  freshenMaxAgeMs?: number;
}

/** git's `pack_copy_priority`: `.keep`, `.pack`, `.rev`, `.idx`, then the rest. */
function packFileOrder(name: string): number {
  if (name.endsWith(".keep")) return 1;
  if (name.endsWith(".pack")) return 2;
  if (name.endsWith(".rev")) return 3;
  if (name.endsWith(".idx")) return 4;
  return 5;
}

/**
 * Opens a quarantine in a new `objects/tmp_objdir-incoming-<timestampedId>` directory.
 *
 * @example
 * ```typescript
 * const { objects, packs, files } = await createGitFilesBackend({ files, gitDir: "." });
 * const q = await objects.beginQuarantine!(); // beginFilesQuarantine underneath
 * await importPack(q.objects, pushed, { packs: q.packs });
 * await q.commit(); // objects/pack/pack-<id>.{pack,idx}, loose objects in objects/xx/
 * ```
 */
export async function beginFilesQuarantine(
  options: FilesQuarantineOptions,
): Promise<ObjectQuarantine> {
  const { files, objectsDir, freshenMaxAgeMs } = options;
  const dir = joinPath(objectsDir, `${QUARANTINE_DIR_PREFIX}${timestampedId()}`);
  const packDir = joinPath(dir, "pack");
  openDirs.add(dir);
  let closed = false;
  try {
    await files.mkdir(packDir);
  } catch (e) {
    openDirs.delete(dir);
    throw e;
  }
  const staging = filesStagingStore(files, dir, { freshenMaxAgeMs });
  const looseOnly = createGitObjects(staging);
  const packs = await openPackSet(files, packDir, {
    externalBase: async (id) => (await looseOnly.get(id)) ?? options.objects.get(id),
    freshenMaxAgeMs,
  });
  const quarantined = withPacks(createGitObjects(skipPacked(staging, packs)), packs);
  const view = overlayObjects(quarantined, options.objects);

  const close = async () => {
    closed = true;
    try {
      await files.remove(dir);
    } finally {
      openDirs.delete(dir);
    }
  };
  const checkOpen = () => {
    if (closed) throw new Error("the quarantine is closed");
  };

  const migrate = async () => {
    // loose objects: an object the repository already has is dropped
    const fanouts: string[] = [];
    for await (const e of files.list(dir)) {
      if (e.kind === "directory" && FANOUT.test(e.name)) fanouts.push(e.name);
    }
    for (const fanout of fanouts) {
      const targetDir = joinPath(objectsDir, fanout);
      for await (const f of files.list(joinPath(dir, fanout))) {
        if (f.kind !== "file" || !REST.test(f.name)) continue;
        const target = joinPath(targetDir, f.name);
        if ((await files.stats(target))?.kind === "file") continue;
        if (!(await files.exists(targetDir))) await files.mkdir(targetDir);
        if (!(await moveCompleting(files, f.path, target)))
          throw new Error(`could not move ${f.path} to ${target}`);
      }
    }
    // packs: the data before the index that makes it visible
    const packFiles: string[] = [];
    for await (const e of files.list(packDir)) {
      if (e.kind === "file" && e.name.startsWith("pack-")) packFiles.push(e.name);
    }
    packFiles.sort((a, b) => packFileOrder(a) - packFileOrder(b) || (a < b ? -1 : 1));
    if (packFiles.length > 0) {
      const mainPackDir = joinPath(objectsDir, "pack");
      if (!(await files.exists(mainPackDir))) await files.mkdir(mainPackDir);
      for (const name of packFiles) {
        const target = joinPath(mainPackDir, name);
        // a pack of the same name holds the same objects (its name is its checksum)
        if (await files.exists(target)) continue;
        const source = joinPath(packDir, name);
        if (!(await moveCompleting(files, source, target)))
          throw new Error(`could not move ${source} to ${target}`);
      }
      await options.packs.refresh();
    }
  };

  return {
    objects: view,
    packs: {
      install: (source, o) => {
        checkOpen();
        return packs.install(source, o);
      },
    },
    async commit() {
      checkOpen();
      try {
        await migrate();
      } finally {
        // what could not be moved is not left behind
        await close();
      }
    },
    async discard() {
      if (closed) return;
      await close();
    },
  };
}

/**
 * Removes quarantine directories (`objects/tmp_objdir-incoming-*`) older than `olderThanMs`,
 * left by a process that crashed (or never committed nor discarded its quarantine). The age is
 * read from the name (its `timestampedId`); a directory without one (native git's) is judged by
 * its mtime, and kept when that is unknown. Quarantines open in this process are kept.
 *
 * @returns The number of directories removed
 */
export async function sweepQuarantines(
  files: FilesApi,
  objectsDir: string,
  olderThanMs: number,
  now: number = Date.now(),
): Promise<number> {
  if ((await files.stats(objectsDir))?.kind !== "directory") return 0;
  const cutoff = now - olderThanMs;
  const stale: string[] = [];
  for await (const e of files.list(objectsDir)) {
    if (e.kind !== "directory" || !e.name.startsWith(QUARANTINE_DIR_PREFIX)) continue;
    const path = joinPath(objectsDir, e.name);
    if (openDirs.has(path)) continue;
    const made =
      timestampOfId(e.name.slice(QUARANTINE_DIR_PREFIX.length)) ??
      e.lastModified ??
      (await files.stats(path))?.lastModified;
    if (olderThanMs <= 0 || (made !== undefined && made < cutoff)) stale.push(path);
  }
  let removed = 0;
  for (const path of stale) if (!openDirs.has(path) && (await files.remove(path))) removed++;
  return removed;
}
