import { pageLocks, randomLockId } from "./lock-paths.js";
import type { LfsLockStore, LfsStoredLock } from "./types.js";

/**
 * An {@link LfsLockStore} in memory: locks live as long as the store. Every
 * operation is synchronous underneath, so concurrent creates of one path
 * cannot both succeed.
 *
 * @example
 * ```typescript
 * const handler = serveLfs(objects, { locks: { store: createMemoryLockStore() } });
 * ```
 */
export function createMemoryLockStore(): LfsLockStore {
  /** By `ref\0path`. */
  const byKey = new Map<string, LfsStoredLock>();
  const byId = new Map<string, string>();
  const keyOf = (path: string, ref: string | undefined) => `${ref ?? ""}\0${path}`;
  const copy = (lock: LfsStoredLock): LfsStoredLock => ({ ...lock, owner: { ...lock.owner } });
  return {
    async create({ path, owner, ref }) {
      const key = keyOf(path, ref);
      const held = byKey.get(key);
      if (held) return { created: false, lock: copy(held) };
      const lock: LfsStoredLock = {
        id: randomLockId(),
        path,
        locked_at: new Date().toISOString(),
        owner: { name: owner.name },
        ...(ref !== undefined ? { ref } : {}),
      };
      byKey.set(key, lock);
      byId.set(lock.id, key);
      return { created: true, lock: copy(lock) };
    },
    async get(id) {
      const key = byId.get(id);
      const lock = key === undefined ? undefined : byKey.get(key);
      return lock && copy(lock);
    },
    async list(query) {
      const page = pageLocks(byKey.values(), query);
      return { ...page, locks: page.locks.map(copy) };
    },
    async remove(id) {
      const key = byId.get(id);
      const lock = key === undefined ? undefined : byKey.get(key);
      if (key === undefined || !lock) return undefined;
      byKey.delete(key);
      byId.delete(id);
      return copy(lock);
    },
  };
}
