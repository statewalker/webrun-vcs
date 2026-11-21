/**
 * git's `compute_alternate_path` (odb.c): the repository a `git clone --reference <path>`
 * names, as the line its `objects/info/alternates` gets.
 *
 * @example
 * ```typescript
 * const ref = await computeAlternatePath(files, "/srv/mirror");
 * if ("error" in ref) throw new Error(`fatal: ${ref.error}`);
 * await objects.alternates?.add(`${ref.gitDir}/objects`); // "/srv/mirror/.git/objects"
 * ```
 */

import type { FilesApi } from "@statewalker/vcs-core";
import { decodeGitPath } from "@statewalker/vcs-utils/encoding";
import { HostPaths, hostRootOf } from "../workspace/git-dir/index.js";
import { alternateRealPath, isAbsolute, readAllBytes } from "./alternate-paths.js";

/** What {@link computeAlternatePath} found: the git directory, or git's message why not. */
export type AlternatePathResult = { gitDir: string } | { error: string };

/**
 * The real path of the git directory of the repository at `path` (a host path, or a path of
 * `files` when its root is unknown): `path` itself followed through its links, a gitfile there
 * or in `<path>/.git` followed, else `<path>/.git` when it has `objects`, else `path` when it
 * has. git's errors otherwise: "path '<path>' does not exist", "reference repository '<path>'
 * is not a local repository." (or "as a linked checkout is not supported yet."), "... is
 * shallow", "... is grafted" (naming `given`, the path as the user wrote it). The git
 * directory comes back as a host path where the root is known.
 */
export async function computeAlternatePath(
  files: FilesApi,
  path: string,
  /** The path as the user gave it, for the messages (default `path`) */
  given = path,
): Promise<AlternatePathResult> {
  const host = new HostPaths(hostRootOf(files));
  const display = (p: string) => (host.known ? host.hostPath(p) : p);
  const kind = async (p: string) => (await files.stats(p).catch(() => undefined))?.kind;
  const missing = { error: `path '${given}' does not exist` };
  if (host.known && isAbsolute(path) && !host.inside(path)) return missing;
  const real = await alternateRealPath(files, host.known ? host.filesPath(path) : path, host);
  // strbuf_realpath lets the last component be missing (then "not a local repository")
  if (real === undefined) return missing;
  const join = (dir: string, name: string) => (dir === "/" ? `/${name}` : `${dir}/${name}`);

  // read_gitfile: `path` itself, else `path/.git`
  let refGit = real;
  let repo = await readGitfile(files, real, host);
  if (repo === undefined) repo = await readGitfile(files, join(real, ".git"), host);
  if (repo !== undefined) refGit = repo;

  if (repo === undefined && (await kind(join(real, ".git/objects"))) === "directory") {
    refGit = join(real, ".git");
  } else if ((await kind(join(refGit, "objects"))) !== "directory") {
    if ((await kind(join(refGit, "commondir"))) === "file") {
      return {
        error: `reference repository '${given}' as a linked checkout is not supported yet.`,
      };
    }
    return { error: `reference repository '${given}' is not a local repository.` };
  }
  if ((await kind(join(refGit, "shallow"))) !== undefined) {
    return { error: `reference repository '${given}' is shallow` };
  }
  if ((await kind(join(refGit, "info/grafts"))) !== undefined) {
    return { error: `reference repository '${given}' is grafted` };
  }
  return { gitDir: display(refGit) };
}

/** The real directory a gitfile at `path` names; undefined when `path` is no gitfile. */
async function readGitfile(
  files: FilesApi,
  path: string,
  host: HostPaths,
): Promise<string | undefined> {
  if ((await files.stats(path).catch(() => undefined))?.kind !== "file") return undefined;
  const text = decodeGitPath(await readAllBytes(files, path).catch(() => new Uint8Array()));
  const match = /^gitdir: (.*?)\s*$/.exec(text.split("\n")[0] ?? "");
  if (!match) return undefined;
  const target = match[1] as string;
  const parent = path.slice(0, path.lastIndexOf("/")) || "/";
  const inner = isAbsolute(target)
    ? host.known
      ? host.inside(target)
        ? host.filesPath(target)
        : undefined
      : target
    : `${parent}/${target}`;
  if (inner === undefined) return undefined;
  const real = await alternateRealPath(files, inner, host);
  if (real === undefined || (await files.stats(real).catch(() => undefined))?.kind !== "directory")
    return undefined;
  return real;
}
