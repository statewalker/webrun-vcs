/**
 * The file primitives git's lock-file protocol needs, beyond plain FilesApi:
 * create a file only if it does not exist, replace a file by renaming another
 * over it, append, and remove a directory only if it is empty.
 *
 * Paths are relative to a root (for refs: the `.git` directory) and use `/`.
 */
import type { FilesApi } from "./files-api.js";
import { dirname, joinPath } from "./path-utils.js";

export interface AtomicFiles {
  /** The file's bytes; nothing if it does not exist. */
  read(path: string): AsyncIterable<Uint8Array>;
  /** Whether a file (not a directory) exists at `path`. */
  exists(path: string): Promise<boolean>;
  /** Remove a file; `true` only for the caller that removed it. */
  remove(path: string): Promise<boolean>;
  /** Write a file the caller owns (such as its own lock), creating directories. */
  write(path: string, content: Uint8Array): Promise<void>;
  /** File paths (not directories) below `dir`, recursively, sorted. */
  list(dir: string): AsyncIterable<string>;
  /**
   * Create `path` with `content` only if nothing exists there, creating
   * directories; `false` if it already exists. With a FilesApi that has
   * `createExclusive` this is a real exclusive create, excluding other
   * processes and tabs; without it, a check then a write, exclusive only among
   * adapters over one FilesApi (see `atomicFilesOver`). Throws an error with
   * `code` "ENOTDIR" (or "EEXIST") when a parent is a file, so `refs/x/y.lock`
   * cannot be created while `refs/x` is a ref.
   */
  createExclusive(path: string, content: Uint8Array): Promise<boolean>;
  /** Move `source` over `target` (rename, replacing it), creating directories. */
  replace(source: string, target: string): Promise<void>;
  /** Append to a file, creating it and its directories (O_APPEND, as git writes reflogs). */
  append(path: string, content: Uint8Array): Promise<void>;
  /** Remove `dir` if it is an empty directory; `false` otherwise. */
  removeEmptyDir(dir: string): Promise<boolean>;
}

/**
 * How many times a delegated `createExclusive` is retried after ENOENT. webrun-files-node
 * runs `mkdir -p` and then `open "wx"`; another process (native git pruning empty ref
 * directories) can remove the directory in between. Git's `raceproof_create_file` retries
 * the same way.
 */
const ENOENT_RETRIES = 3;

const isEnoent = (error: unknown) =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";

/** `createExclusive` of the FilesApi, retried while its directory vanishes underneath it. */
async function createExclusiveRaceproof(
  fs: FilesApi,
  exclusive: NonNullable<FilesApi["createExclusive"]>,
  path: string,
  content: Uint8Array,
): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await exclusive.call(fs, path, [content]);
    } catch (error) {
      if (!isEnoent(error) || attempt >= ENOENT_RETRIES) throw error;
    }
  }
}

/** Paths held by an in-flight `createExclusive`, per FilesApi, shared by every adapter over it. */
const pending = new WeakMap<FilesApi, Set<string>>();
/**
 * The tail of the structural operations (exclusive create, empty-directory
 * removal) on each FilesApi. Running them one at a time makes each one's checks
 * and its change a single step for every adapter over that FilesApi.
 */
const structural = new WeakMap<FilesApi, Promise<unknown>>();

/**
 * `AtomicFiles` over any FilesApi, rooted at `root`.
 *
 * When the FilesApi has `createExclusive` (every webrun-files FilesApi from 0.11:
 * node, browser, mem, sqlite), `createExclusive` delegates to it, and a lock
 * excludes every writer the backend excludes: other processes such as native git,
 * other tabs, other FilesApi instances. A delegated call that fails with ENOENT
 * (its directory pruned by another process between `mkdir` and `open`) is retried.
 *
 * Without it, exclusive creation is guaranteed only among adapters over the same
 * FilesApi instance: exclusive creates and empty-directory removals on one
 * FilesApi run one at a time, so each one's checks and its change happen as one
 * step. Two FilesApi instances over one directory, even in one process, and other
 * processes are not excluded then: use one FilesApi instance per repository, and
 * do not run another writer on the same directory.
 *
 * In both cases exclusive creates and empty-directory removals through one
 * FilesApi run one at a time, so `removeEmptyDir` never removes a lock created
 * meanwhile in-process. `replace` is FilesApi's `move`, which is atomic only
 * where the backend's is.
 *
 * @example
 * ```typescript
 * const files = atomicFilesOver(createInMemoryFilesApi(), "/repo/.git");
 * if (await files.createExclusive("refs/heads/main.lock", bytes)) {
 *   await files.replace("refs/heads/main.lock", "refs/heads/main");
 * }
 * ```
 */
export function atomicFilesOver(fs: FilesApi, root: string): AtomicFiles {
  const abs = (path: string) => joinPath(root, path);
  let held = pending.get(fs);
  if (!held) {
    held = new Set();
    pending.set(fs, held);
  }
  const claims = held;
  const serial = <T>(op: () => Promise<T>): Promise<T> => {
    const run = (structural.get(fs) ?? Promise.resolve()).then(op, op);
    structural.set(
      fs,
      run.catch(() => {}),
    );
    return run;
  };
  const isFile = async (path: string) => (await fs.stats(abs(path)))?.kind === "file";
  const ensureDir = async (path: string) => {
    const dir = dirname(abs(path));
    if (dir && !(await fs.exists(dir))) await fs.mkdir(dir);
  };

  return {
    async *read(path) {
      if (await isFile(path)) yield* fs.read(abs(path));
    },
    exists: isFile,
    async remove(path) {
      if (!(await isFile(path))) return false;
      return fs.remove(abs(path));
    },
    async write(path, content) {
      await ensureDir(path);
      await fs.write(abs(path), [content]);
    },
    async *list(dir) {
      if ((await fs.stats(abs(dir)))?.kind !== "directory") return;
      const out: string[] = [];
      const base = abs("");
      for await (const info of fs.list(abs(dir), { recursive: true })) {
        if (info.kind !== "file") continue;
        out.push(info.path.slice(base.length).replace(/^\/+/, ""));
      }
      yield* out.sort();
    },
    createExclusive: (path, content) =>
      serial(async () => {
        // A file where a directory is needed: refuse, as open(2) does with ENOTDIR.
        const parts = path.split("/").filter(Boolean);
        for (let i = 1; i < parts.length; i++) {
          const parent = parts.slice(0, i).join("/");
          if ((await fs.stats(abs(parent)))?.kind === "file") {
            throw Object.assign(new Error(`ENOTDIR: ${parent} is a file`), { code: "ENOTDIR" });
          }
        }
        const key = abs(path);
        const exclusive = fs.createExclusive;
        if (exclusive) return createExclusiveRaceproof(fs, exclusive, key, content);
        if (claims.has(key)) return false;
        claims.add(key);
        try {
          if (await fs.exists(key)) return false;
          await ensureDir(path);
          await fs.write(key, [content]);
          return true;
        } finally {
          claims.delete(key);
        }
      }),
    async replace(source, target) {
      await ensureDir(target);
      if (!(await fs.move(abs(source), abs(target)))) {
        throw new Error(`replace: could not move ${source} to ${target}`);
      }
    },
    async append(path, content) {
      const old: Uint8Array[] = [];
      if (await isFile(path)) for await (const chunk of fs.read(abs(path))) old.push(chunk);
      await ensureDir(path);
      await fs.write(abs(path), [...old, content]);
    },
    // Serialized with createExclusive, so a lock created in this directory cannot
    // slip in between the emptiness check and the (possibly recursive) remove.
    removeEmptyDir: (dir) =>
      serial(async () => {
        if ((await fs.stats(abs(dir)))?.kind !== "directory") return false;
        for await (const _ of fs.list(abs(dir))) return false;
        return fs.remove(abs(dir));
      }),
  };
}
