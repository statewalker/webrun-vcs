/**
 * Quarantined objects, as git's receive-pack keeps a pushed pack in `tmp_objdir` until the push
 * is accepted: writes go to a separate store, reads see that store and then the repository's.
 * `GitObjects.beginQuarantine` hands out such a view with `commit` and `discard`.
 */
import type { GitObjects } from "./git-objects.js";

function closeSource(content: AsyncIterable<Uint8Array> | Iterable<Uint8Array>): void {
  const it =
    Symbol.asyncIterator in Object(content)
      ? (content as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]()
      : (content as Iterable<Uint8Array>)[Symbol.iterator]();
  try {
    const r = it.return?.();
    if (r && typeof (r as Promise<unknown>).then === "function") {
      (r as Promise<unknown>).then(undefined, () => {});
    }
  } catch {
    // nothing to close
  }
}

/**
 * Objects written to `top`, read from `top` then `base`: the view of a quarantine. An object
 * `base` already has is not written to `top` again (`putRaw` checks first; `put` and
 * `putUnsized`, which learn the id at the end, drop the copy they wrote). `remove` removes from
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
    if (await base.has(id)) await top.remove(id);
    return id;
  };
  return {
    put: async (type, size, content) => dropIfPublished(await top.put(type, size, content)),
    putUnsized: async (type, content) => dropIfPublished(await top.putUnsized(type, content)),
    async putRaw(id, raw) {
      if (await base.has(id)) {
        closeSource(raw);
        return;
      }
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
    remove: (id) => top.remove(id),
  };
}
