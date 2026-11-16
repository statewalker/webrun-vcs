/**
 * A process-wide count of object removals, so caches of parsed objects stay coherent with
 * stores that drop objects.
 *
 * ```typescript
 * const seen = objectRemovalEpoch();
 * const tree = decode(await read(id));
 * // later: a cached tree is served as is while nothing was removed since it was read
 * if (objectRemovalEpoch() !== seen && !(await objects.has(id))) forget(id);
 * ```
 *
 * A git object never changes (its id is its content's hash), so a parsed tree or commit
 * can be kept for as long as it is stored. What can happen is that it stops being stored:
 * gc prunes unreachable loose objects, a repack drops the packs it replaced, a refused push
 * discards its quarantine. Those paths remove through many layers (a `FileRawStorage` of
 * its own for gc, a KV or SQL raw store, a pack set), so the stores themselves report each
 * removal here, and a cache checks a hit against storage only when the count moved since
 * the entry was read. The count is shared by every repository in the process: a removal
 * elsewhere costs one `has` per later hit, never a stale read.
 *
 * Removals made by another process (native `git gc` on the same directory) are not seen,
 * as git's own parsed objects do not see them either.
 */

interface RemovalCounter {
  epoch: number;
}

const KEY = Symbol.for("@statewalker/vcs-core/object-removals");

/** One counter per process, even when this module is loaded more than once (two bundles). */
const counter: RemovalCounter = (() => {
  const g = globalThis as { [KEY]?: RemovalCounter };
  let c = g[KEY];
  if (!c) {
    c = { epoch: 0 };
    g[KEY] = c;
  }
  return c;
})();

/** A key that names an object: an id, alone or as the last segment (a quarantine's prefix). */
const OBJECT_KEY = /(?:^|\/)[0-9a-f]{40}$/;

/** The current count of removals; compare two readings to learn whether anything went. */
export function objectRemovalEpoch(): number {
  return counter.epoch;
}

/**
 * Report that an object store removed something. Call it after the removal is done (a read
 * that starts later then finds nothing to cache). With `key`, only a key that names an
 * object counts (temporaries of staged writes do not); without it, every call counts.
 */
export function noteObjectRemoved(key?: string): void {
  if (key === undefined || OBJECT_KEY.test(key)) counter.epoch++;
}
