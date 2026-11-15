/**
 * The FilesApi to open a repository with on Node: the worktree's files, where a `.git` (or
 * `.git/objects`) the user linked to a directory elsewhere is followed, as git follows it,
 * and no other link ever is.
 */

import {
  createMountedFilesApi,
  type FilesApi,
  normalizePath,
  type PosixFilesApi,
} from "@statewalker/vcs-utils/files";

import { PosixNodeFilesApi } from "./posix-node-files-api.js";

/**
 * A FilesApi over `rootDir` for opening the repository there: a `PosixNodeFilesApi` that
 * never follows a link, except that the repository directory `gitDir` and its `objects`,
 * when they are symbolic links to directories (inside or outside the root), are mounted
 * from their targets. Only those two paths reach beyond the root; `openLinkTarget` stays
 * off everywhere else.
 *
 * @example
 * ```typescript
 * const files = await openRepositoryFiles("/path/to/worktree");
 * const { history } = await createGitFilesBackend({ files });
 * ```
 */
export async function openRepositoryFiles(
  rootDir: string,
  options: { gitDir?: string; platform?: NodeJS.Platform } = {},
): Promise<PosixFilesApi> {
  const files = new PosixNodeFilesApi({ rootDir, platform: options.platform });
  const opener = new PosixNodeFilesApi({
    rootDir,
    platform: options.platform,
    openLinkTargets: true,
  });
  const gitDir = normalizePath(options.gitDir ?? ".git");
  const mounts: Record<string, FilesApi> = {};
  const repository = await opener.openLinkTarget(gitDir);
  if (repository) {
    const objects = await new PosixNodeFilesApi({
      rootDir: repository.rootDirectory,
      platform: options.platform,
      openLinkTargets: true,
    }).openLinkTarget("/objects");
    mounts[gitDir] = objects
      ? createMountedFilesApi(repository, { "/objects": objects })
      : repository;
  } else {
    const objects = await opener.openLinkTarget(`${gitDir}/objects`);
    if (objects) mounts[`${gitDir}/objects`] = objects;
  }
  return Object.keys(mounts).length > 0 ? createMountedFilesApi(files, mounts) : files;
}
