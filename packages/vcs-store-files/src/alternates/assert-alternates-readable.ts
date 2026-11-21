/**
 * gc, repack and prune delete what nothing reachable names; in a repository that borrows
 * objects, what reaches a local object may live only in an alternate. When an alternate
 * cannot be read, its objects look absent, and a walk that went on would delete local
 * objects only they reach. git dies in that case (`bad object refs/heads/main` from
 * pack-objects); we refuse up front, before anything changes.
 *
 * @example
 * ```typescript
 * await assertAlternatesReadable({ files, gitDir: ".git", objects }, "gc");
 * ```
 */

import type { FilesApi, GitObjects } from "@statewalker/vcs-core";
import { joinPath } from "@statewalker/vcs-core";

/** An alternate of the repository could not be read: gc, repack and prune refuse to run. */
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
 * Throws {@link AlternatesUnreadableError} when reading the alternates reported errors
 * (`objects.alternates.errors`: a directory gone, a path that cannot be normalized, nesting
 * too deep), or when `objects/info/alternates` exists while the store reads no alternates
 * (`createGitFilesBackend({ alternates: false })`).
 */
export async function assertAlternatesReadable(
  target: { files: FilesApi; gitDir?: string; objects: Pick<GitObjects, "alternates"> },
  operation: string,
): Promise<void> {
  const alternates = target.objects.alternates;
  if (alternates) {
    const errors = alternates.errors;
    if (errors.length === 0) return;
    throw new AlternatesUnreadableError(
      `cannot ${operation}: an alternate object directory cannot be read, so the objects ` +
        `it holds look missing\n${errors.join("\n")}`,
      errors,
    );
  }
  const file = joinPath(target.gitDir ?? ".git", "objects", "info", "alternates");
  if ((await target.files.stats(file).catch(() => undefined))?.kind !== "file") return;
  throw new AlternatesUnreadableError(
    `cannot ${operation}: the repository borrows objects (objects/info/alternates) but ` +
      "alternates are not read here (alternates: false)",
  );
}
