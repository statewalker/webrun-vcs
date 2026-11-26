/**
 * The object stores a backend opened at an objects directory of its own (`$GIT_OBJECT_DIRECTORY`,
 * `createGitFilesBackend({ objectsDir })`). gc, repack and prune build their paths from the git
 * directory (`<gitDir>/objects`), so they refuse such stores rather than mix two directories.
 */

import { joinPath } from "@statewalker/vcs-core";

const relocated = new WeakMap<object, string>();

/** Records that these stores read and write `objectsDir` (not `<gitDir>/objects`). */
export function markRelocatedObjects(objectsDir: string, ...stores: (object | undefined)[]): void {
  for (const store of stores) if (store) relocated.set(store, objectsDir);
}

/**
 * Refuses an operation over stores opened at another objects directory than `<gitDir>/objects`
 * (a pre-receive hook's quarantine, a shared object store named by `$GIT_OBJECT_DIRECTORY`).
 */
export function assertObjectsAtGitDir(
  gitDir: string,
  operation: string,
  ...stores: (object | undefined)[]
): void {
  const expected = joinPath(gitDir, "objects");
  for (const store of stores) {
    const dir = store ? relocated.get(store) : undefined;
    if (dir !== undefined && dir !== expected) {
      throw new Error(
        `${operation} works on ${expected}, but these stores were opened at ${dir} ($GIT_OBJECT_DIRECTORY)`,
      );
    }
  }
}
