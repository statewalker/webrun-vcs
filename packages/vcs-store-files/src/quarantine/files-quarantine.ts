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
import {
  createGitObjects,
  joinPath,
  noteObjectRemoved,
  openPackSet,
  overlayObjects,
  QUARANTINE_MAX_IDLE_MS,
} from "@statewalker/vcs-core";
import { timestampedId, timestampOfId } from "@statewalker/vcs-utils";
import { type FilesApi, moveCompleting } from "@statewalker/vcs-utils/files";
import { skipPacked, withPacks } from "../pack/with-packs.js";
import { filesStagingStore } from "../storage/loose/files-staging-store.js";

/** Name prefix of a quarantine directory under `objects/` (git's own prefix). */
export const QUARANTINE_DIR_PREFIX = "tmp_objdir-incoming-";

const FANOUT = /^[0-9a-f]{2}$/;
/** git's freshen window, as `createGitFilesBackend`'s default `freshenMaxAgeMs`. */
const DEFAULT_FRESHEN_MAX_AGE_MS = 60 * 60 * 1000;
const REST = /^[0-9a-f]{38}$/;

/**
 * Quarantine directories open in this process, with when each was last used:
 * `sweepQuarantines` leaves them alone while they are used (see `QUARANTINE_MAX_IDLE_MS`).
 */
const openDirs = new Map<string, number>();

/** Whether the open quarantine `dir` is in use, for a sweep with this expiry. */
function inUse(dir: string, olderThanMs: number, now: number): boolean {
  const last = openDirs.get(dir);
  return last !== undefined && now - last < Math.max(olderThanMs, QUARANTINE_MAX_IDLE_MS);
}

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
  const freshenWindow = freshenMaxAgeMs ?? DEFAULT_FRESHEN_MAX_AGE_MS;
  /**
   * "absent", "fresh" or "stale" (last modified longer ago than the freshen window): a stale
   * target is replaced by the quarantined copy (the same bytes), which renews its mtime, as
   * git's freshen; an unknown age counts as fresh.
   */
  const targetState = async (path: string) => {
    const st = await files.stats(path);
    if (st?.kind !== "file") return "absent";
    const m = st.lastModified;
    return m !== undefined && Date.now() - m > freshenWindow ? "stale" : "fresh";
  };
  const dir = joinPath(objectsDir, `${QUARANTINE_DIR_PREFIX}${timestampedId()}`);
  const packDir = joinPath(dir, "pack");
  let closed = false;
  const touch = () => {
    if (!closed) openDirs.set(dir, Date.now());
  };
  touch();
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
  const overlay = overlayObjects(quarantined, options.objects);

  const close = async () => {
    closed = true;
    try {
      await files.remove(dir);
    } finally {
      openDirs.delete(dir);
      // its objects are gone (published copies stay): cached parses are checked again
      noteObjectRemoved();
    }
  };
  const checkOpen = () => {
    if (closed) throw new Error("the quarantine is closed");
  };
  /** The overlay, refusing writes once closed and recording use (reads and writes) */
  const view: GitObjects = {
    ...overlay,
    put: (type, size, content) => {
      checkOpen();
      touch();
      return overlay.put(type, size, content);
    },
    putUnsized: (type, content) => {
      checkOpen();
      touch();
      return overlay.putUnsized(type, content);
    },
    putRaw: (id, raw) => {
      checkOpen();
      touch();
      return overlay.putRaw(id, raw);
    },
    get: (id, o) => {
      touch();
      return overlay.get(id, o);
    },
    getRaw: (id) => {
      touch();
      return overlay.getRaw(id);
    },
    has: (id) => {
      touch();
      return overlay.has(id);
    },
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
        // the repository has it: kept, and freshened when old (gc must not prune it now)
        if ((await targetState(target)) === "fresh") continue;
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
        // a pack of the same name holds the same objects (its name is its checksum): kept,
        // and freshened when old by moving the new copy over it
        if ((await targetState(target)) === "fresh") continue;
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
      install: async (source, o) => {
        checkOpen();
        touch();
        try {
          return await packs.install(source, o);
        } finally {
          touch();
        }
      },
    },
    async commit() {
      checkOpen();
      touch();
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
 * its mtime, and kept when that is unknown. Quarantines open in this process are kept while
 * used within `QUARANTINE_MAX_IDLE_MS` (or `olderThanMs`, if longer); one idle for longer
 * (a dropped or hung push) is removed like a crash leftover.
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
    if (inUse(path, olderThanMs, now)) continue;
    const made =
      timestampOfId(e.name.slice(QUARANTINE_DIR_PREFIX.length)) ??
      e.lastModified ??
      (await files.stats(path))?.lastModified;
    if (olderThanMs <= 0 || (made !== undefined && made < cutoff)) stale.push(path);
  }
  let removed = 0;
  for (const path of stale)
    if (!inUse(path, olderThanMs, now) && (await files.remove(path))) removed++;
  return removed;
}
