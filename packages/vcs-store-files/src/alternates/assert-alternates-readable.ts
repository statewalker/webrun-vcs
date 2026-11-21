/**
 * gc, repack and prune delete what nothing reachable names; in a repository that borrows
 * objects, what reaches a local object may live only in an alternate. Where git cannot read an
 * alternate either (a directory gone, a path that cannot be normalized, nesting too deep) we go
 * on as git does, printing its error lines: a ref, HEAD or index entry at a borrowed object
 * fails the walk (`MissingRootError`, git's `bad object`), and so does a borrowed parent, tree
 * or blob under a local commit (`MissingObjectError`), before anything is deleted.
 *
 * Where git reads the alternates but this store does not (`alternates: false`, an absolute
 * alternate outside the FilesApi's root) we refuse up front: the walk skips a reflog entry or
 * pseudo-ref whose commit it cannot read, as git does for a commit that is gone, so the local
 * objects only such a borrowed commit reaches would be deleted where git keeps them.
 *
 * @example
 * ```typescript
 * await assertAlternatesReadable({ files, gitDir: ".git", objects }, "gc");
 * ```
 */

import type { FilesApi, GitObjects } from "@statewalker/vcs-core";
import { joinPath } from "@statewalker/vcs-core";
import { OUTSIDE_STORAGE_ERROR } from "./object-alternates.js";

/** git reads an alternate this store cannot: gc, repack and prune refuse to run. */
export class AlternatesUnreadableError extends Error {
  constructor(
    message: string,
    /** git's error lines from reading the alternates */
    readonly errors: readonly string[] = [],
  ) {
    super(message);
    this.name = "AlternatesUnreadableError";
  }
}

/**
 * Throws {@link AlternatesUnreadableError} when `objects/info/alternates` exists while the store
 * reads no alternates (`createGitFilesBackend({ alternates: false })`), or when an alternate
 * lies outside the FilesApi's root. Other errors from reading the alternates are git's
 * non-fatal ones: returned (`objects.alternates.errors`, empty when there are none) for the
 * caller to report, as git prints them and goes on.
 */
export async function assertAlternatesReadable(
  target: { files: FilesApi; gitDir?: string; objects: Pick<GitObjects, "alternates"> },
  operation: string,
): Promise<readonly string[]> {
  const alternates = target.objects.alternates;
  if (alternates) {
    const errors = alternates.errors;
    const outside = errors.filter((line) => line.startsWith(OUTSIDE_STORAGE_ERROR));
    if (outside.length === 0) return errors;
    throw new AlternatesUnreadableError(
      `cannot ${operation}: an alternate object directory lies outside the storage, so the ` +
        `objects it holds look missing\n${outside.join("\n")}`,
      errors,
    );
  }
  const file = joinPath(target.gitDir ?? ".git", "objects", "info", "alternates");
  if ((await target.files.stats(file).catch(() => undefined))?.kind !== "file") return [];
  throw new AlternatesUnreadableError(
    `cannot ${operation}: the repository borrows objects (objects/info/alternates) but ` +
      "alternates are not read here (alternates: false)",
  );
}
