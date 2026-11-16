/**
 * Quarantined objects, as git's receive-pack keeps a pushed pack in `tmp_objdir` until the push
 * is accepted: writes go to a separate store, reads see that store and then the repository's.
 * `GitObjects.beginQuarantine` hands out such a view with `commit` and `discard`.
 */
import type { GitObjects } from "./git-objects.js";

/**
 * Objects written to `top`, read from `top` then `base`: the view of a quarantine. An object
 * `base` already has is not written to `top` again: `putRaw` hands it to `base.putRaw`, and
 * `put` and `putUnsized`, which learn the id at the end, hand the copy they wrote to
 * `base.putRaw` and drop it from `top`. `base` then keeps its copy and renews it as it would
 * for any write of an object it has (the files backend's freshen: a loose file or pack older than
 * its freshen window is written again), so a concurrent gc does not prune an old unreachable
 * object a push is about to name, as git freshens objects found in the main object directory
 * while it writes into its quarantine. `remove` removes from
 * `top` only, so the view can never remove a published object. `list` yields `top`'s ids, then
 * `base`'s that are not in `top` (it holds `top`'s ids: the quarantine's objects, not the
 * repository's).
 *
 * @example
 * ```typescript
 * const staging = createGitObjects(rawStorageStaging(new MemoryRawStorage()));
 * const view = overlayObjects(staging, repositoryObjects);
 * await view.putRaw(id, raw); // in `staging` only
 * await view.get(id);         // found; repositoryObjects.get(id) is still undefined
 * ```
 */
export function overlayObjects(top: GitObjects, base: GitObjects): GitObjects {
  const dropIfPublished = async (id: string) => {
    if (await base.has(id)) {
      await base.putRaw(id, top.getRaw(id)); // freshens base's copy
      await top.remove(id);
    }
    return id;
  };
  return {
    put: async (type, size, content) => dropIfPublished(await top.put(type, size, content)),
    putUnsized: async (type, content) => dropIfPublished(await top.putUnsized(type, content)),
    async putRaw(id, raw) {
      // published already: base keeps (and freshens) its copy, nothing goes to the quarantine
      if (await base.has(id)) return base.putRaw(id, raw);
      return top.putRaw(id, raw);
    },
    async *getRaw(id) {
      if (await top.has(id)) yield* top.getRaw(id);
      else yield* base.getRaw(id);
    },
    async get(id, options) {
      return (await top.get(id, options)) ?? base.get(id, options);
    },
    async has(id) {
      return (await top.has(id)) || base.has(id);
    },
    async *list() {
      const seen = new Set<string>();
      for await (const id of top.list()) {
        seen.add(id);
        yield id;
      }
      for await (const id of base.list()) if (!seen.has(id)) yield id;
    },
    async approximateCount() {
      return ((await top.approximateCount?.()) ?? 0) + ((await base.approximateCount?.()) ?? 0);
    },
    remove: (id) => top.remove(id),
  };
}
