/**
 * A repository whose `.git` (or `.git/objects`) is a symbolic link the user made to a
 * directory elsewhere, which git follows. The FilesApi never follows links, so the link is
 * resolved here, once, through the FilesApi itself: the link's target is mounted at its
 * path in a composed FilesApi the repository stores then use.
 */

import {
  createMountedFilesApi,
  createSubtreeFilesApi,
  type FilesApi,
  joinPath,
  normalizePath,
  type PosixFilesApi,
} from "@statewalker/vcs-utils/files";

/**
 * `files`, with the repository directory `gitDir` and its `objects` directory each mounted
 * from the directory its symbolic link points to, when they are links. A link is resolved
 * by the FilesApi (`openLinkTarget`, for a target it cannot name, e.g. outside its root),
 * else lexically within it (`readlink`, a relative or absolute virtual path). A link that
 * leads nowhere usable fails loudly; it never reads as an empty repository. Without `lstat`
 * (no links in the storage) `files` is returned as it is.
 *
 * @example
 * ```typescript
 * const repoFiles = await resolveLinkedGitDir(createNodeFilesApi({ rootDir }), ".git");
 * const { history } = await createGitFilesBackend({ files: repoFiles });
 * ```
 */
export async function resolveLinkedGitDir(files: FilesApi, gitDir: string): Promise<FilesApi> {
  const posix = files as PosixFilesApi;
  if (!posix.lstat) return files;
  const dir = normalizePath(gitDir);
  const mounts: Record<string, FilesApi> = {};
  const gitFiles = await followLink(posix, dir);
  if (gitFiles) mounts[dir] = gitFiles;
  const objectsFiles = gitFiles
    ? await followLink(gitFiles as PosixFilesApi, "/objects")
    : await followLink(posix, joinPath(dir, "objects"));
  if (objectsFiles) {
    if (gitFiles) mounts[dir] = createMountedFilesApi(gitFiles, { "/objects": objectsFiles });
    else mounts[joinPath(dir, "objects")] = objectsFiles;
  }
  return Object.keys(mounts).length > 0 ? createMountedFilesApi(files, mounts) : files;
}

/** The directory the link at `path` points to, as a FilesApi; undefined if no link. */
async function followLink(files: PosixFilesApi, path: string): Promise<FilesApi | undefined> {
  if (!files.lstat) return undefined;
  const stats = await files.lstat(path);
  if (stats?.kind !== "symlink") return undefined;
  const opened = await files.openLinkTarget?.(path);
  if (opened) return opened;
  const target = new TextDecoder().decode((await files.readlink?.(path)) ?? new Uint8Array());
  const resolved = resolveTarget(path, target);
  if (resolved && (await files.lstat(resolved))?.kind === "directory") {
    return createSubtreeFilesApi(files, resolved);
  }
  throw new Error(`${path} is a symbolic link to ${JSON.stringify(target)}, not a directory here`);
}

/** The virtual path a link target names, relative to the link's directory; undefined above `/`. */
function resolveTarget(linkPath: string, target: string): string | undefined {
  const parent = linkPath.slice(0, linkPath.lastIndexOf("/")) || "/";
  const parts = target.startsWith("/") ? [] : parent.split("/").filter(Boolean);
  for (const part of target.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return undefined;
      parts.pop();
    } else parts.push(part);
  }
  return `/${parts.join("/")}`;
}
