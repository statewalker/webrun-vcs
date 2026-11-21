/**
 * git clone's `clone_local` without `--shared` (builtin/clone.c `copy_or_link_directory`,
 * `copy_alternates`): the source's objects directory copied into the new repository's, file
 * by file, through the FilesApi.
 *
 * @example
 * ```typescript
 * await copyLocalObjects({
 *   source: { files, objectsDir: "src/.git/objects", repo: "/host/src/.git" },
 *   target: { files, objectsDir: "dst/.git/objects" },
 *   addAlternate: (path) => alternates.add(path),
 * });
 * ```
 *
 * Every file but `info/alternates` is copied as it is (loose objects, packs with their
 * `.idx`/`.rev`/`.bitmap`/`.keep`, `info/packs`, `info/commit-graph`, leftovers alike), its
 * modification time kept where the target FilesApi can set times (`copy_file_with_time`).
 * git hardlinks the files unless `--no-hardlinks` (falling back to a copy); the FilesApi has
 * no hard-link primitive, so ours always copies: the same bytes, without the shared inodes.
 * The source's `info/alternates` is not copied: each of its entries is appended to the new
 * repository's alternates (`odb_add_to_alternates_file`), a relative one made absolute from
 * the source's git directory as clone.c names it (`<src_repo>/objects/<entry>`, normalized;
 * one climbing above the root is skipped with git's warning). A symbolic link in the source's
 * objects directory refuses the clone, as git refuses it (`symlink '<path>' exists, refusing
 * to clone with --local`; the directory itself a link: `'<dir>' is a symlink, refusing to
 * clone with --local`), where the FilesApi tells links apart (`lstat`/`listKinds`). git's
 * ownership check of the source (`die_upon_dubious_ownership`) has no FilesApi counterpart.
 */

import type { FilesApi } from "@statewalker/vcs-core";
import { type PosixFilesApi, readFile } from "@statewalker/vcs-utils/files";
import { TransportError } from "../errors/index.js";

/** Where {@link copyLocalObjects} copies from and to. */
export interface LocalObjectsCopy {
  source: {
    files: FilesApi;
    /** The source's objects directory in `files` (`<common dir>/objects`) */
    objectsDir: string;
    /** The source's git directory as clone.c names it (`src_repo`), a host path */
    repo: string;
    /**
     * The objects directory as clone.c names it in its messages (`get_common_dir(src_repo)`
     * plus `/objects`, a host path); default `objectsDir`
     */
    objectsPath?: string;
  };
  target: {
    files: FilesApi;
    /** The new repository's objects directory in `files` */
    objectsDir: string;
  };
  /** `odb_add_to_alternates_file` of the new repository (an absolute host path) */
  addAlternate(path: string): Promise<void>;
}

/** What the copy reports: git's warnings (`warning: ...` lines). */
export interface LocalObjectsCopyResult {
  warnings: string[];
}

type Kind = "file" | "directory" | "symlink" | "other";

/** The entries of `dir`, links told apart where the FilesApi can. */
async function entriesOf(storage: FilesApi, dir: string): Promise<{ name: string; kind: Kind }[]> {
  const files = storage as PosixFilesApi;
  const out: { name: string; kind: Kind }[] = [];
  if (files.listKinds) {
    for (const e of await files.listKinds(dir)) {
      const path = `${dir}/${e.name}`;
      const kind =
        e.kind ?? (await files.lstat?.(path))?.kind ?? (await files.stats(path))?.kind ?? "other";
      out.push({ name: e.name, kind });
    }
    return out;
  }
  for await (const info of files.list(dir)) {
    const path = `${dir}/${info.name}`;
    const kind = (await files.lstat?.(path))?.kind ?? info.kind;
    out.push({ name: info.name, kind });
  }
  return out;
}

/** git's `normalize_path_copy` of an absolute path: undefined when `..` climbs above the root. */
function normalizeAbsolute(path: string): string | undefined {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return undefined;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `/${parts.join("/")}`;
}

/** Copies one file between FilesApis (or within one), keeping its modification time. */
async function copyFile(
  from: FilesApi,
  src: string,
  to: FilesApi,
  dest: string,
  mtime: number | undefined,
): Promise<void> {
  await to.remove(dest).catch(() => false);
  if (from === to) {
    if (!(await to.copy(src, dest))) {
      throw new TransportError(`fatal: failed to copy file to '${dest}'`);
    }
  } else {
    await to.write(dest, from.read(src));
  }
  if (mtime !== undefined) await to.touch?.(dest, mtime);
}

/**
 * Copies the source's objects directory into the target's (see the module notes).
 */
export async function copyLocalObjects(copy: LocalObjectsCopy): Promise<LocalObjectsCopyResult> {
  const { source, target } = copy;
  const warnings: string[] = [];
  const srcRoot = source.objectsDir.replace(/\/+$/, "");
  const destRoot = target.objectsDir.replace(/\/+$/, "");
  if ((await (source.files as PosixFilesApi).lstat?.(srcRoot))?.kind === "symlink") {
    const shown = source.objectsPath ?? srcRoot;
    throw new TransportError(`fatal: '${shown}' is a symlink, refusing to clone with --local`);
  }
  if ((await source.files.stats(srcRoot))?.kind !== "directory") {
    throw new TransportError(
      `fatal: failed to start iterator over '${source.objectsPath ?? srcRoot}': No such file or directory`,
    );
  }
  await target.files.mkdir(destRoot);

  const walk = async (rel: string): Promise<void> => {
    const dir = rel ? `${srcRoot}/${rel}` : srcRoot;
    for (const { name, kind } of await entriesOf(source.files, dir)) {
      const relative = rel ? `${rel}/${name}` : name;
      const src = `${srcRoot}/${relative}`;
      const dest = `${destRoot}/${relative}`;
      if (kind === "symlink") {
        throw new TransportError(
          `fatal: symlink '${relative}' exists, refusing to clone with --local`,
        );
      }
      if (kind === "directory") {
        await target.files.mkdir(dest);
        await walk(relative);
        continue;
      }
      if (relative === "info/alternates") {
        await copyAlternates(src);
        continue;
      }
      const stats = await source.files.stats(src);
      await copyFile(source.files, src, target.files, dest, stats?.lastModified);
    }
  };

  // copy_alternates: each entry appended to the new repository's alternates, made absolute
  const copyAlternates = async (src: string) => {
    const text = new TextDecoder().decode(await readFile(source.files, src));
    const lines = text.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    for (const raw of lines) {
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      if (!line || line.startsWith("#")) continue;
      if (line.startsWith("/")) {
        await copy.addAlternate(line);
        continue;
      }
      const abs = normalizeAbsolute(`${source.repo}/objects/${line}`);
      if (abs !== undefined) await copy.addAlternate(abs);
      else warnings.push(`warning: skipping invalid relative alternate: ${source.repo}/${line}`);
    }
  };

  await walk("");
  return { warnings };
}
