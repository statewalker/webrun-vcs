import { atomicFilesOver, type FilesApi, joinPath } from "@statewalker/vcs-utils/files";
import { lockKeyHash, pageLocks, randomLockId } from "./lock-paths.js";
import type { LfsLockStore, LfsStoredLock } from "./types.js";

const KEY_LENGTH = 24;
/** An unreadable lock file older than this is a crashed writer's (ms). */
const STALE_MS = 2000;
/** Looks at an unreadable lock file (5, 10, 15 … ms apart; ~0.3 s in all) before taking it as stale. */
const STALE_ATTEMPTS = 10;
const ID = /^[0-9a-f]{32}$/;
const decoder = new TextDecoder();

async function bytesOf(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const c of chunks) {
    parts.push(c);
    size += c.length;
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function parseLock(text: string): LfsStoredLock | undefined {
  try {
    const v = JSON.parse(text) as Partial<LfsStoredLock> | null;
    if (
      !v ||
      typeof v.id !== "string" ||
      typeof v.path !== "string" ||
      typeof v.locked_at !== "string" ||
      typeof v.owner?.name !== "string" ||
      (v.ref !== undefined && typeof v.ref !== "string")
    )
      return undefined;
    return {
      id: v.id,
      path: v.path,
      locked_at: v.locked_at,
      owner: { name: v.owner.name },
      ...(v.ref !== undefined ? { ref: v.ref } : {}),
    };
  } catch {
    return undefined;
  }
}

/** Per FilesApi, per lock file: the tail of the removals queued on it. */
const removals = new WeakMap<FilesApi, Map<string, Promise<unknown>>>();

/**
 * An {@link LfsLockStore} on any `FilesApi`: one JSON file per lock at
 * `<root>/lfs/locks/<key>.json`, where `<key>` is the first 24 hex digits of
 * the SHA-256 of `ref\0path`, so a path (per ref) has exactly one place.
 * A lock is created with an exclusive create (`atomicFilesOver(...)
 * .createExclusive`: the FilesApi's own `createExclusive` where it has one,
 * which excludes other processes too; otherwise exclusive among stores over
 * the same FilesApi instance). Its id is the key followed by 8 random hex
 * digits, so `get` and `remove` find the file without a scan, and a path
 * locked again gets a new id. Listing reads every lock file (no index): fine
 * for the hundreds of locks a repository has, not for millions.
 *
 * A file another writer is still writing (not yet valid JSON) is waited for
 * briefly by `create`, and skipped by `list`. One that stays unreadable for
 * about 0.3 s, or was last written over 2 s ago, is a writer's that crashed
 * between its exclusive create and its write: `create` removes it and
 * creates over it (once), and `remove` of an id whose file is unreadable
 * removes that file. Removals of one lock file are
 * serialized within the process; across processes, a removal and a re-lock
 * of the same path in the same instant can race (the id is checked before the
 * file is removed).
 *
 * @example
 * ```typescript
 * const locks = createFilesLockStore(createNodeFilesApi({ rootDir: "/srv/repo.git" }));
 * const handler = serveLfs(createFilesLfsStore(files), { locks: { store: locks } });
 * ```
 */
export function createFilesLockStore(files: FilesApi, root = ""): LfsLockStore {
  const atomic = atomicFilesOver(files, root || "/");
  const dir = "lfs/locks";
  const fileOf = (key: string) => `${dir}/${key}.json`;

  /** The lock in a file, `"absent"`, or `"unreadable"` (empty or partial JSON: a writer still at it, or one that crashed). */
  async function readState(path: string): Promise<LfsStoredLock | "absent" | "unreadable"> {
    if (!(await atomic.exists(path))) return "absent";
    const text = decoder.decode(await bytesOf(atomic.read(path)));
    if (!(await atomic.exists(path))) return "absent"; // removed while read
    return parseLock(text) ?? "unreadable";
  }

  async function readLock(path: string): Promise<LfsStoredLock | undefined> {
    const state = await readState(path);
    return typeof state === "string" ? undefined : state;
  }

  /** Milliseconds since the file was last written; `0` when unknown. */
  async function age(path: string): Promise<number> {
    const modified = (await files.stats(joinPath(root || "/", path)))?.lastModified;
    return modified === undefined ? 0 : Date.now() - modified;
  }

  /** Removes `path` if it is (still) unreadable. */
  async function removeUnreadable(path: string): Promise<void> {
    await serial(path, async () => {
      if ((await readState(path)) === "unreadable") await atomic.remove(path);
    });
  }

  /** Runs `fn` after every earlier removal queued on `path` in this process. */
  async function serial<T>(path: string, fn: () => Promise<T>): Promise<T> {
    let queue = removals.get(files);
    if (!queue) {
      queue = new Map();
      removals.set(files, queue);
    }
    const key = `${root}\0${path}`;
    const run = (queue.get(key) ?? Promise.resolve()).then(fn, fn);
    const tail = run.catch(() => undefined);
    queue.set(key, tail);
    try {
      return await run;
    } finally {
      if (queue.get(key) === tail) queue.delete(key);
    }
  }

  return {
    async create({ path, owner, ref }) {
      const key = (await lockKeyHash(path, ref)).slice(0, KEY_LENGTH);
      const file = fileOf(key);
      let recovered = false;
      for (let attempt = 0; ; attempt++) {
        const lock: LfsStoredLock = {
          id: `${key}${randomLockId(4)}`,
          path,
          locked_at: new Date().toISOString(),
          owner: { name: owner.name },
          ...(ref !== undefined ? { ref } : {}),
        };
        const bytes = new TextEncoder().encode(`${JSON.stringify(lock)}\n`);
        if (await atomic.createExclusive(file, bytes)) return { created: true, lock };
        const held = await readState(file);
        if (typeof held !== "string") return { created: false, lock: held };
        if (held === "unreadable") {
          // another writer between its exclusive create and its write, or a
          // writer that crashed there: stale once it stays so for a while
          // (or is older than STALE_MS), then removed and created over once
          if (attempt >= STALE_ATTEMPTS || (await age(file)) > STALE_MS) {
            if (recovered) throw new Error(`lfs lock file ${file} stays unreadable`);
            recovered = true;
            await removeUnreadable(file);
            continue;
          }
        }
        // being written, or removed meanwhile: look again
        await new Promise((r) => setTimeout(r, 5 * (attempt + 1)));
      }
    },
    async get(id) {
      if (!ID.test(id)) return undefined;
      const lock = await readLock(fileOf(id.slice(0, KEY_LENGTH)));
      return lock?.id === id ? lock : undefined;
    },
    async list(query) {
      const all: LfsStoredLock[] = [];
      if (query.id !== undefined) {
        const lock = ID.test(query.id)
          ? await readLock(fileOf(query.id.slice(0, KEY_LENGTH)))
          : undefined;
        if (lock) all.push(lock);
      } else if (query.path !== undefined && query.ref !== undefined) {
        // one place per path and ref; a path in every ref needs the scan below
        const key = (await lockKeyHash(query.path, query.ref)).slice(0, KEY_LENGTH);
        const lock = await readLock(fileOf(key));
        if (lock) all.push(lock);
      } else {
        for await (const path of atomic.list(dir)) {
          if (!path.endsWith(".json")) continue;
          const lock = await readLock(path);
          if (lock) all.push(lock);
        }
      }
      return pageLocks(all, query);
    },
    async remove(id) {
      if (!ID.test(id)) return undefined;
      const file = fileOf(id.slice(0, KEY_LENGTH));
      return serial(file, async () => {
        const state = await readState(file);
        // an unreadable file at this id's place (a crashed writer) goes too
        if (state === "unreadable") await atomic.remove(file);
        if (typeof state === "string" || state.id !== id) return undefined;
        return (await atomic.remove(file)) ? state : undefined;
      });
    },
  };
}
