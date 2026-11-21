/**
 * A partial clone's promisor objects as gc and repack leave them out of their walks (git's
 * `--exclude-promisor-objects`): every object of a promisor pack, and every absent object a
 * promisor object names.
 */

import type { FilesApi, GitObjects, ObjectId } from "@statewalker/vcs-core";
import { readRepositoryFormat } from "./repository-format.js";

/** What a partial clone's gc and repack treat apart. */
export interface PromisorExclusions {
  /** The objects of the promisor packs (repack writes them into a promisor pack of their own) */
  readonly inPacks: ReadonlySet<ObjectId>;
  /** What the reachability walk neither lists nor walks through */
  readonly excluded: ReadonlySet<ObjectId>;
}

/**
 * The promisor objects of a repository with a promisor remote (git's
 * `repo_has_promisor_remote`: `extensions.partialClone` or a `remote.<name>.promisor`), as the
 * walks exclude them; undefined in any other repository.
 *
 * @example
 * ```typescript
 * const exclusions = await promisorExclusions(objects, files, ".git");
 * if (exclusions) console.log(exclusions.inPacks.size, "objects in promisor packs");
 * ```
 */
export async function promisorExclusions(
  objects: GitObjects,
  files: FilesApi,
  gitDir = ".git",
): Promise<PromisorExclusions | undefined> {
  const promisor = objects.promisor;
  if (!promisor) return undefined;
  const format = await readRepositoryFormat(files, gitDir);
  if (format.partialClone === undefined) return undefined;
  // the walks read no absent object: nothing is fetched (git's fetch_if_missing = 0)
  return promisor.withoutLazyFetch(async () => {
    const inPacks = await promisor.promisorPackObjects();
    const excluded = new Set(inPacks);
    for (const id of await promisor.promisedObjects()) {
      if (!excluded.has(id) && !(await objects.has(id))) excluded.add(id);
    }
    return { inPacks, excluded };
  });
}
