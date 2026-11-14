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
 */
import type { StagingBlobStore } from "@statewalker/vcs-core";
import { type FilesApi, joinPath } from "@statewalker/vcs-utils/files";

const FANOUT = /^[0-9a-f]{2}$/;
const REST = /^[0-9a-f]{38}$/;
const TMP_PREFIX = "tmp_obj_";

export interface FilesStagingStore extends StagingBlobStore {
  /**
   * Remove temporaries (`tmp_obj_*`, at the top level and in fan-out
   * directories) older than `olderThanMs`, left by a crash, as `git prune` does.
   * Files whose age the FilesApi does not report are kept. Returns how many
   * were removed.
   */
  sweepStaged(olderThanMs: number): Promise<number>;
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
export function filesStagingStore(files: FilesApi, objectsDir: string): FilesStagingStore {
  const pathOf = (id: string) => joinPath(objectsDir, id.slice(0, 2), id.slice(2));
  const isFile = async (path: string) => (await files.stats(path))?.kind === "file";
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
        // hold the same bytes, so either rename leaves a valid object.
        if (await isFile(target)) return { id, stored: false };
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
