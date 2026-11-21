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
  /**
   * The stored objects outside the promisor packs that promisor objects link to (a local
   * commit the server built on, fetched back as a parent): walked as roots, so gc never
   * prunes them even where no promisor pack of `repack_local_links` holds them (git 2.43's
   * fetches, or one made before it)
   */
  readonly roots: ReadonlySet<ObjectId>;
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
  // `has` never fetches; the promisor's own reads never do
  const inPacks = await promisor.promisorPackObjects();
  const excluded = new Set(inPacks);
  const roots = new Set<ObjectId>();
  for (const id of await promisor.promisedObjects()) {
    if (excluded.has(id)) continue;
    if (await objects.has(id)) roots.add(id);
    else excluded.add(id);
  }
  return { inPacks, excluded, roots };
}
