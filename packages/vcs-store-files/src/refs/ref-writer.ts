/**
 * The refs directory layout.
 *
 * There are no unlocked ref writers: every write of a loose ref, packed-refs, HEAD,
 * a pseudo ref (ORIG_HEAD, MERGE_HEAD, …) or a reflog goes through `FileRefStore`
 * (`batch`, `set`, `setSymbolic`, `remove`, `deleteReflogEntry`, `packRefs`) or the
 * packed-refs writers, all under git's lock files (`createFilesRefOps`).
 */

import { type FilesApi, joinPath } from "@statewalker/vcs-core";

/**
 * Create refs directory structure
 *
 * @param files File system API
 * @param gitDir Path to .git directory
 */
export async function createRefsStructure(files: FilesApi, gitDir: string): Promise<void> {
  await files.mkdir(joinPath(gitDir, "refs"));
  await files.mkdir(joinPath(gitDir, "refs", "heads"));
  await files.mkdir(joinPath(gitDir, "refs", "tags"));
}
