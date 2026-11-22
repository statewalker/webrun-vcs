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
 * Content of unknown size is spooled (`spool`) to a `tmp_obj_*` file first.
 *
 * Writing an object that is already there writes nothing (git's `odb_freshen_object` before
 * `write_loose_object`): the loose file has its mtime renewed (`FilesApi.touch`, git's
 * `utime`) on every such write, as git's check_and_freshen_file, so a concurrent gc keeps it
 * for its grace period. Where the FilesApi cannot set times, a file older than
 * `freshenMaxAgeMs` (one hour by default) has the new temporary moved over it instead, which
 * renews it as well, and a younger file, or one whose mtime the FilesApi does not report, is
 * kept as it is: `PackSet.freshen` trusts a pack of unknown age the same way.
 *
 * With `cacheDirectoryChecks`, where the FilesApi offers a batch view
 * (`PosixFilesApi.withLstatCache`, as the Node one does), the store keeps one for its life:
 * the directories of the object database (`objects/`, its fan-out directories) are checked
 * not to be symbolic links at most once a second (`maxAgeMs: 1000`), not on every write, as
 * git creates a fan-out directory once and never checks it again. The view forgets what it
 * verified on any ENOENT/ENOTDIR/ELOOP, so a fan-out directory a prune removed is made again.
 * A fan-out directory replaced by a symbolic link within that second is followed by the
 * writes made meanwhile: accepted, as git itself follows such links in `objects/` (it never
 * lstats them), and only paths below `objects/` go through the view.
 */
import { noteObjectRemoved, type StagingBlobStore } from "@statewalker/vcs-core";
import {
  type FilesApi,
  joinPath,
  moveCompleting,
  type PosixFilesApi,
} from "@statewalker/vcs-utils/files";

const FANOUT = /^[0-9a-f]{2}$/;
const REST = /^[0-9a-f]{38}$/;
const TMP_PREFIX = "tmp_obj_";
/** git's freshen window, as `PackSet`'s `freshenMaxAgeMs`. */
const DEFAULT_FRESHEN_MAX_AGE_MS = 60 * 60 * 1000;
/** How long `cacheDirectoryChecks` trusts a directory it verified not to be a link. */
const DIRECTORY_CHECK_MAX_AGE_MS = 1000;

export interface FilesStagingStoreOptions {
  /**
   * Where the FilesApi cannot set times (no `touch`), a loose object last modified longer
   * ago than this is rewritten when it is written again (git's `freshen_loose_object`);
   * with `touch` it is touched on every such write. `renew` (repack's unpacking of
   * unreachable objects) touches only a file older than this. Default one hour, as
   * `PackSet`'s `freshenMaxAgeMs`. A file whose mtime is unknown is never rewritten.
   */
  freshenMaxAgeMs?: number;
  /**
   * Keep a batch view of the FilesApi for the store's life (`PosixFilesApi.withLstatCache`,
   * where it has one), so the directories of the object database are checked not to be
   * symbolic links at most once a second rather than on every write (see above). Default
   * false; `createGitFilesBackend` turns it on.
   */
  cacheDirectoryChecks?: boolean;
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
   * Whether a write of the object can be skipped: the loose file exists and this call renewed
   * its mtime (`FilesApi.touch`, as git on every write), or, where it cannot be touched, it
   * was last modified within `freshenMaxAgeMs` (or its age is unknown). False when it is
   * absent, or old and cannot be touched: the write then stores it (and so renews it).
   */
  isFresh(id: string): Promise<boolean>;
  /**
   * Whether an unpacked copy needs writing, telling apart a copy within `freshenMaxAgeMs` (or
   * of unknown age), left as it is ("fresh"), from an older one whose mtime this call renewed
   * ("renewed"); undefined when a write is needed (absent, or old and the FilesApi cannot set
   * times).
   */
  renew(id: string): Promise<"fresh" | "renewed" | undefined>;
}

/** Random characters for temporary names (`[0-9a-z]`). */
function randomPart(length: number): string {
  const r = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(r, (b) => (b % 36).toString(36)).join("");
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
  // the store's own batch view: directories verified not to be links stay verified (see above)
  const io: FilesApi =
    (options.cacheDirectoryChecks &&
      (files as PosixFilesApi).withLstatCache?.({ maxAgeMs: DIRECTORY_CHECK_MAX_AGE_MS })) ||
    files;
  // Temporary names: `tmp_obj_`, a random part per store (renewed on a collision) and a
  // counter, as unique as git's mkstemp names without asking for random bytes per object.
  // Drawn at the first write: a store opened only to read never asks for random bytes (the
  // first `getRandomValues` loads the runtime's crypto, milliseconds of a command's start).
  let tmpBase: string | undefined;
  let tmpSeq = 0;
  const tmpName = () => {
    tmpBase ??= `${TMP_PREFIX}${randomPart(8)}`;
    return `${tmpBase}${(tmpSeq++).toString(36)}`;
  };
  const pathOf = (id: string) => joinPath(objectsDir, id.slice(0, 2), id.slice(2));
  const isFile = async (path: string) => (await io.stats(path))?.kind === "file";
  /** "absent", "fresh" (young or of unknown age) or "stale" (older than the freshen window) */
  const state = async (path: string) => {
    const s = await io.stats(path);
    if (s?.kind !== "file") return "absent";
    const modified = s.lastModified;
    return modified !== undefined && Date.now() - modified > freshenMaxAge ? "stale" : "fresh";
  };
  /** The mtime of a stale file renewed in place (git's utime), where the FilesApi can. */
  const touch = async (path: string) =>
    io.touch ? await io.touch(path).catch(() => false) : false;
  const renew = async (id: string): Promise<"fresh" | "renewed" | undefined> => {
    const path = pathOf(id);
    const existing = await state(path);
    if (existing === "fresh") return "fresh";
    return existing === "stale" && (await touch(path)) ? "renewed" : undefined;
  };
  /**
   * Whether a write of the file can be skipped, as git's check_and_freshen_file: the file is
   * touched on every such write (git's utime). Where that fails (no such file, a FilesApi
   * without `touch`, or a composite one whose storage cannot set times), a young file (or
   * one of unknown age) is kept, and an old or absent one written.
   */
  const freshen = async (path: string): Promise<boolean> =>
    (await touch(path)) || (await state(path)) === "fresh";
  const ensureDir = async (dir: string) => {
    if (!(await io.exists(dir))) await io.mkdir(dir);
  };

  return {
    async putStaged(bytes, idOf, putOptions) {
      // The fewest operations: the temporary created with its content in one step (an
      // exclusive create where the FilesApi has one, which also creates `objects/`), the
      // target looked at once (not at all after `isFresh` said no), then one rename (whose
      // FilesApi creates the fan-out directory; else it is made and the rename tried again).
      // `bytes` is one-shot: it is iterated at most once. A create that found a file at the
      // temporary name (a collision) without reading the content is tried again under a
      // fresh name, as git's mkstemp does; one that read it and still answered `false` cannot
      // be retried (the content is gone), so it fails rather than write an empty object.
      let started = false;
      const once = {
        [Symbol.asyncIterator]() {
          if (started) throw new Error("staged content can be read only once");
          started = true;
          return bytes[Symbol.asyncIterator]();
        },
      };
      let tmp = joinPath(objectsDir, tmpName());
      let id: string;
      try {
        if (!io.createExclusive) {
          await io.write(tmp, once);
        } else {
          for (let attempt = 0; ; attempt++) {
            if (await io.createExclusive(tmp, once)) break;
            if (started) {
              throw new Error(`could not create ${tmp}: the content was read but not stored`);
            }
            if (attempt >= 8) throw new Error(`could not create a temporary in ${objectsDir}`);
            tmpBase = `${TMP_PREFIX}${randomPart(8)}`;
            tmp = joinPath(objectsDir, tmpName());
          }
        }
        id = await idOf();
      } catch (e) {
        if (started) await files.remove(tmp).catch(() => false);
        throw e;
      }
      const target = pathOf(id);
      let moved = false;
      try {
        // An existing object wins, as in git: it is touched (git's freshen_loose_object) or,
        // where times cannot be set, kept when young and replaced by the same bytes when old,
        // whose rename renews its mtime. Against a concurrent writer of the same new id,
        // FilesApi.move may overwrite (git uses link() and EEXIST): both files hold the same
        // bytes, so either rename leaves a valid object.
        if (!putOptions?.notFresh && (await freshen(target))) return { id, stored: false };
        moved = await moveCompleting(io, tmp, target).catch(() => false);
        if (moved) return { id, stored: true };
        await ensureDir(joinPath(objectsDir, id.slice(0, 2)));
        moved = await moveCompleting(io, tmp, target);
        if (moved) return { id, stored: true };
        if (await isFile(target)) return { id, stored: false };
        throw new Error(`could not move ${tmp} to ${target}`);
      } finally {
        if (!moved) await files.remove(tmp).catch(() => false);
      }
    },

    async spool(content) {
      // A tmp_obj_ file: native git ignores it and sweepStaged removes it after a crash.
      await ensureDir(objectsDir);
      const tmp = joinPath(objectsDir, tmpName());
      let size = 0;
      try {
        await files.write(
          tmp,
          (async function* () {
            for await (const chunk of content) {
              size += chunk.length;
              yield chunk;
            }
          })(),
        );
      } catch (e) {
        await files.remove(tmp).catch(() => false);
        throw e;
      }
      return {
        size,
        read: () => files.read(tmp),
        dispose: async () => {
          await files.remove(tmp).catch(() => false);
        },
      };
    },

    async *get(id) {
      // read at once: a missing file reads as nothing (one lookup instead of two); a
      // FilesApi that throws for it is asked whether the file is there
      const path = pathOf(id);
      try {
        yield* io.read(path);
      } catch (e) {
        if (await isFile(path)) throw e;
      }
    },

    has: (id) => isFile(pathOf(id)),

    isFresh: (id) => freshen(pathOf(id)),

    renew,

    async remove(id) {
      // through `files`: a removal through the view would make it forget what it verified
      const path = pathOf(id);
      const removed = (await isFile(path)) && (await files.remove(path));
      if (removed) noteObjectRemoved();
      return removed;
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

    async *listPrefix(prefix) {
      if (prefix.length < 2) {
        for await (const id of this.list()) if (id.startsWith(prefix)) yield id;
        return;
      }
      const fanout = prefix.slice(0, 2);
      const dir = joinPath(objectsDir, fanout);
      if (!FANOUT.test(fanout) || (await files.stats(dir))?.kind !== "directory") return;
      const rest = prefix.slice(2);
      const names: string[] = [];
      for await (const f of files.list(dir)) {
        if (f.kind === "file" && REST.test(f.name) && f.name.startsWith(rest)) names.push(f.name);
      }
      for (const name of names.sort()) yield fanout + name;
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
