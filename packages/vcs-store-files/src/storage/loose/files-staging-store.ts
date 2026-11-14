/**
 * Git's loose-object directory as a `StagingBlobStore`: objects at
 * `<objectsDir>/ab/cdef…`, each written first as `<objectsDir>/tmp_obj_*` and
 * renamed into place once its id is known, as git (`finalize_object_file`) and
 * JGit (`ObjectDirectoryInserter`) do. Rooted at `.git/objects`, this is the
 * object database native git reads and writes.
 *
 * Memory per write depends on the FilesApi: one whose `write` streams keeps it
 * bounded; one that collects the chunks first (the in-memory FilesApi, and the
 * Node one in `@statewalker/webrun-files-node` 0.10) holds the compressed object.
 *
 * A write of an object whose loose file is older than `freshenMaxAgeMs` (one hour by default)
 * moves the new temporary over it, so the rename renews its mtime and a concurrent gc keeps it
 * for its grace period, as git's `freshen_loose_object` does by touching the file. A younger
 * file, or one whose mtime the FilesApi does not report, is kept as it is: `PackSet.freshen`
 * trusts a pack of unknown age the same way.
 */
import type { StagingBlobStore } from "@statewalker/vcs-core";
import { type FilesApi, joinPath } from "@statewalker/vcs-utils/files";

const FANOUT = /^[0-9a-f]{2}$/;
const REST = /^[0-9a-f]{38}$/;
const TMP_PREFIX = "tmp_obj_";
/** git's freshen window, as `PackSet`'s `freshenMaxAgeMs`. */
const DEFAULT_FRESHEN_MAX_AGE_MS = 60 * 60 * 1000;

export interface FilesStagingStoreOptions {
  /**
   * A loose object last modified longer ago than this is rewritten when it is written again,
   * which renews its mtime (git's `freshen_loose_object`). Default one hour, as `PackSet`'s
   * `freshenMaxAgeMs`. A file whose mtime is unknown is never rewritten.
   */
  freshenMaxAgeMs?: number;
}

export interface FilesStagingStore extends StagingBlobStore {
  /**
   * Remove temporaries (`tmp_obj_*`, at the top level and in fan-out
   * directories) older than `olderThanMs`, left by a crash, as `git prune` does.
   * Files whose age the FilesApi does not report are kept. Returns how many
   * were removed.
   */
  sweepStaged(olderThanMs: number): Promise<number>;
  /**
   * Whether the loose object exists and needs no freshening: last modified within
   * `freshenMaxAgeMs`, or of unknown age. A write of an object that is not fresh stores it
   * (absent) or renews its mtime (old).
   */
  isFresh(id: string): Promise<boolean>;
}

/** git's temporary-object name: `tmp_obj_` plus random characters. */
function tmpName(): string {
  const r = crypto.getRandomValues(new Uint8Array(9));
  return `${TMP_PREFIX}${btoa(String.fromCharCode(...r)).replace(/[+/=]/g, "_")}`;
}

/**
 * @example
 * ```typescript
 * const objects = createGitObjects(filesStagingStore(files, "/repo/.git/objects"));
 * await objects.put("blob", 6, [new TextEncoder().encode("hello\n")]);
 * // /repo/.git/objects/ce/013625030ba8dba906f756967f9e9ca394464a, as git writes it
 * ```
 */
export function filesStagingStore(
  files: FilesApi,
  objectsDir: string,
  options: FilesStagingStoreOptions = {},
): FilesStagingStore {
  const freshenMaxAge = options.freshenMaxAgeMs ?? DEFAULT_FRESHEN_MAX_AGE_MS;
  const pathOf = (id: string) => joinPath(objectsDir, id.slice(0, 2), id.slice(2));
  const isFile = async (path: string) => (await files.stats(path))?.kind === "file";
  /** "absent", "fresh" (young or of unknown age) or "stale" (older than the freshen window) */
  const state = async (path: string) => {
    const s = await files.stats(path);
    if (s?.kind !== "file") return "absent";
    const modified = s.lastModified;
    return modified !== undefined && Date.now() - modified > freshenMaxAge ? "stale" : "fresh";
  };
  const ensureDir = async (dir: string) => {
    if (!(await files.exists(dir))) await files.mkdir(dir);
  };

  return {
    async putStaged(bytes, idOf) {
      await ensureDir(objectsDir);
      const tmp = joinPath(objectsDir, tmpName());
      let id: string;
      try {
        await files.write(tmp, bytes);
        id = await idOf();
      } catch (e) {
        await files.remove(tmp).catch(() => false);
        throw e;
      }
      const target = pathOf(id);
      let moved = false;
      try {
        // An existing object wins, as in git. Against a concurrent writer of the same
        // new id, FilesApi.move may overwrite (git uses link() and EEXIST): both files
        // hold the same bytes, so either rename leaves a valid object. An existing file
        // older than the freshen window is replaced by the same bytes: the rename renews
        // its mtime at once (git's freshen_loose_object touches it).
        const existing = await state(target);
        if (existing === "fresh") return { id, stored: false };
        if (existing === "stale") {
          moved = await files.move(tmp, target);
          return { id, stored: moved };
        }
        await ensureDir(joinPath(objectsDir, id.slice(0, 2)));
        moved = await files.move(tmp, target);
        if (moved) return { id, stored: true };
        if (await isFile(target)) return { id, stored: false };
        throw new Error(`could not move ${tmp} to ${target}`);
      } finally {
        if (!moved) await files.remove(tmp).catch(() => false);
      }
    },

    async *get(id) {
      const path = pathOf(id);
      if (await isFile(path)) yield* files.read(path);
    },

    has: (id) => isFile(pathOf(id)),

    isFresh: async (id) => (await state(pathOf(id))) === "fresh",

    async remove(id) {
      const path = pathOf(id);
      return (await isFile(path)) && files.remove(path);
    },

    async *list() {
      if ((await files.stats(objectsDir))?.kind !== "directory") return;
      const fanouts: string[] = [];
      for await (const dir of files.list(objectsDir)) {
        if (dir.kind === "directory" && FANOUT.test(dir.name)) fanouts.push(dir.name);
      }
      for (const fanout of fanouts.sort()) {
        const names: string[] = [];
        for await (const f of files.list(joinPath(objectsDir, fanout))) {
          if (f.kind === "file" && REST.test(f.name)) names.push(f.name);
        }
        for (const name of names.sort()) yield fanout + name;
      }
    },

    async sweepStaged(olderThanMs) {
      if ((await files.stats(objectsDir))?.kind !== "directory") return 0;
      const cutoff = Date.now() - olderThanMs;
      const stale: string[] = [];
      const scan = async (dir: string, descend: boolean) => {
        for await (const info of files.list(dir)) {
          if (info.kind === "directory") {
            if (descend && FANOUT.test(info.name)) await scan(info.path, false);
          } else if (
            info.name.startsWith(TMP_PREFIX) &&
            // An unknown age is never stale: the file may be a write in flight.
            info.lastModified !== undefined &&
            info.lastModified < cutoff
          ) {
            stale.push(info.path);
          }
        }
      };
      await scan(objectsDir, true);
      let removed = 0;
      for (const path of stale) if (await files.remove(path)) removed++;
      return removed;
    },
  };
}
