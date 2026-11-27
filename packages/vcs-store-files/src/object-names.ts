/**
 * The names git reads as objects of a repository: loose objects and packs are named by ids of
 * the repository's object format only (git's `for_each_loose_file_in_objdir` and
 * `prepare_packed_git` parse `the_hash_algo->hexsz` digits), so a name of the other width (a
 * 62-digit loose file in a SHA-1 repository, a `pack-<40 hex>.pack` in a SHA-256 one) is no
 * object of it: gc, repack and prune leave such files alone, as git does.
 */
import type { FilesApi } from "@statewalker/vcs-core";
import type { ObjectFormat } from "@statewalker/vcs-utils/hash";

const objectIds = new Map<number, RegExp>();
const packFiles = new Map<number, RegExp>();
const looseNames = new Map<number, RegExp>();

/** A full lowercase hex id of `format` (a loose object's key, `ab` + the file name). */
export function objectIdPattern(format: ObjectFormat): RegExp {
  let re = objectIds.get(format.hexLength);
  if (!re) {
    re = new RegExp(`^[0-9a-f]{${format.hexLength}}$`);
    objectIds.set(format.hexLength, re);
  }
  return re;
}

/** A loose object's file name in its fan-out directory (the id less its first two digits). */
export function looseFileNamePattern(format: ObjectFormat): RegExp {
  let re = looseNames.get(format.hexLength);
  if (!re) {
    re = new RegExp(`^[0-9a-f]{${format.hexLength - 2}}$`);
    looseNames.set(format.hexLength, re);
  }
  return re;
}

/** A pack's `.pack` file name: `pack-<id>.pack` with an id of `format`. */
export function packFilePattern(format: ObjectFormat): RegExp {
  let re = packFiles.get(format.hexLength);
  if (!re) {
    re = new RegExp(`^pack-[0-9a-f]{${format.hexLength}}\\.pack$`);
    packFiles.set(format.hexLength, re);
  }
  return re;
}

/**
 * `--keep-pack` arguments as pack base names, as git compares them with `pack_basename`:
 * `custom-<id>.pack` and `custom-<id>` name `custom-<id>`, a bare id names `pack-<id>`.
 */
export function keepPackNames(keepPacks: readonly string[] = []): Set<string> {
  return new Set(
    keepPacks.map((n) => {
      const base = n.replace(/\.pack$/, "");
      return /^[0-9a-f]+$/.test(base) ? `pack-${base}` : base;
    }),
  );
}

/**
 * The loose object ids of `objectsDir` in git's order (`for_each_loose_file_in_objdir`): the
 * fan-out directories `00` to `ff`, each in readdir order (`listKinds(..., { readdirOrder })`
 * where the FilesApi has it, else sorted). The order decides pack-objects' list position,
 * which breaks ties of its delta search.
 */
export async function looseObjectIdsInGitOrder(
  files: FilesApi,
  objectsDir: string,
  format: ObjectFormat,
): Promise<string[]> {
  const posix = files as FilesApi & {
    listKinds?(path: string, o?: { readdirOrder?: boolean }): Promise<{ name: string }[]>;
  };
  const pattern = looseFileNamePattern(format);
  const out: string[] = [];
  for (let i = 0; i < 256; i++) {
    const fan = i.toString(16).padStart(2, "0");
    const dir = `${objectsDir}/${fan}`;
    let names: string[] = [];
    try {
      if (posix.listKinds) {
        names = (await posix.listKinds(dir, { readdirOrder: true })).map((e) => e.name);
      } else {
        for await (const e of files.list(dir)) names.push(e.name);
      }
    } catch {
      continue;
    }
    for (const name of names) if (pattern.test(name)) out.push(fan + name);
  }
  return out;
}
