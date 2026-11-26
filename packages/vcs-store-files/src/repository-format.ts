/**
 * The repository format check git runs before it touches a repository (setup.c:
 * `check_repository_format`, `verify_repository_format`): `core.repositoryformatversion`
 * and the `extensions.*` of the repository's config say how its refs and objects are stored,
 * and a reader that does not know one of them must not open it. A reftable repository read
 * as a files one looks empty; a sha256 repository's objects do not parse as sha1 ones; and
 * gc in a partial clone or a `preciousObjects` repository deletes what it must keep.
 *
 * As git: version 0 knows `noop`, `preciousObjects`, `partialClone` and `worktreeConfig` and
 * ignores every other extension, except the version-1 ones, which it refuses; version 1
 * refuses any extension it does not know; a version above 1 is refused.
 *
 * Beyond git's own check, what git knows but we do not implement is refused too (a payload
 * of `extensions.objectStorage`). A compatibility object format
 * (`extensions.compatObjectFormat`) opens: loose writes keep `objects/loose-object-idx` as git
 * does (`compat/`). A SHA-256 repository
 * (`extensions.objectFormat = sha256`) opens: its objects, refs and reflogs are read and
 * written with 32-byte ids, its packs, `.idx`, `.rev`, `.mtimes` and index file too; what has
 * no SHA-256 path yet (the commit-graph, the multi-pack-index, bitmaps, reftable tables, the
 * transports) refuses with `UnsupportedObjectFormatError`.
 * The reftable ref storage (`extensions.refStorage = reftable`) is read and written by its ref
 * store (`ReftableRefStore`).
 */

import type { FilesApi } from "@statewalker/vcs-core";
import { parseGitBool } from "@statewalker/vcs-utils/encoding";
import {
  type ObjectFormat,
  objectFormatByName,
  SHA1_OBJECT_FORMAT,
} from "@statewalker/vcs-utils/hash";

import {
  configFilesApiOf,
  createWorkingCopyConfig,
} from "./workspace/working-copy/working-copy-config.files.js";

/** The highest `core.repositoryformatversion` we read, as git's `GIT_REPO_VERSION_READ`. */
export const REPOSITORY_FORMAT_VERSION_READ = 1;

/** What the repository's format allows, once it passed the check. */
export interface RepositoryFormat {
  /** `core.repositoryformatversion` (0 when unset) */
  version: number;
  /** `extensions.preciousObjects`: gc and repack must not delete any object */
  preciousObjects: boolean;
  /**
   * The promisor remote of a partial clone, whose objects may be absent: `extensions.partialClone`,
   * else the first remote with `remote.<name>.promisor = true` (what `git clone --filter`
   * writes since git 2.29) or a `remote.<name>.partialclonefilter` (git's
   * `promisor_remote_config`; `repo_has_promisor_remote` checks them all)
   */
  partialClone?: string;
  /** `extensions.worktreeConfig`: linked worktrees read their own `config.worktree` */
  worktreeConfig: boolean;
  /** `extensions.relativeWorktrees` (version 1): worktree links are relative paths */
  relativeWorktrees: boolean;
  /**
   * The extensions git does not know, lowercased, in config order: ignored by version 0
   * (a version 1 repository with any is refused), they forbid `upgrade_repository_format`;
   * absent when there is none
   */
  unknownExtensions?: string[];
  /**
   * `extensions.refStorage` (version 1): `files` (loose refs and packed-refs, the default) or
   * `reftable` (`.git/reftable/`, `ReftableRefStore`)
   */
  refStorage: "files" | "reftable";
  /**
   * `extensions.objectFormat` (version 1): the hash naming the objects, SHA-1 (the default)
   * or SHA-256
   */
  objectFormat: ObjectFormat;
  /**
   * `extensions.submodulePathConfig` (version 1, git 2.52 and later): each submodule's git
   * directory is `submodule.<name>.gitdir`, which `git submodule init` writes
   */
  submodulePathConfig: boolean;
  /**
   * `extensions.compatObjectFormat` (version 1): the other hash whose ids the repository keeps
   * for its loose objects (`objects/loose-object-idx`), absent when unset
   */
  compatObjectFormat?: ObjectFormat;
}

/** A repository whose format version or extensions we cannot read or write safely. */
export class UnsupportedRepositoryFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedRepositoryFormatError";
  }
}

/** The config view the check needs (a `GitWorkingCopyConfig`). */
export interface RepositoryFormatConfig {
  get(key: string): unknown;
  listKeys(prefix?: string): string[];
}

/**
 * Checks the repository format of a parsed config, as git's `verify_repository_format`, and
 * refuses what we do not support. Throws `UnsupportedRepositoryFormatError` with git's
 * wording ("Expected git repo version <= 1, found 2", "unknown repository extension found:").
 *
 * @example
 * ```typescript
 * const format = checkRepositoryFormat(config);
 * if (format.preciousObjects) console.log("gc will not prune here");
 * ```
 */
export function checkRepositoryFormat(config: RepositoryFormatConfig): RepositoryFormat {
  const version = configInt(
    config.get("core.repositoryformatversion"),
    "core.repositoryformatversion",
  );
  if (version > REPOSITORY_FORMAT_VERSION_READ) {
    throw new UnsupportedRepositoryFormatError(
      `Expected git repo version <= ${REPOSITORY_FORMAT_VERSION_READ}, found ${version}`,
    );
  }
  const format: RepositoryFormat = {
    version,
    preciousObjects: false,
    worktreeConfig: false,
    relativeWorktrees: false,
    refStorage: "files",
    objectFormat: SHA1_OBJECT_FORMAT,
    submodulePathConfig: false,
  };
  const unknown: string[] = [];
  const v1Only: string[] = [];
  const unsupported: string[] = [];
  for (const key of config.listKeys("extensions.")) {
    const ext = key.slice("extensions.".length);
    const value = config.get(key);
    // the extensions version 0 knows (git's handle_extension_v0)
    switch (ext) {
      case "noop":
        continue;
      case "preciousobjects":
        format.preciousObjects = configBool(value, key);
        continue;
      case "partialclone":
        if (value === true || value === undefined || value === "") {
          throw new UnsupportedRepositoryFormatError(`missing value for '${key}'`);
        }
        format.partialClone = String(value);
        continue;
      case "worktreeconfig":
        format.worktreeConfig = configBool(value, key);
        continue;
    }
    // the version-1 extensions (git's handle_extension)
    switch (ext) {
      case "noop-v1":
        break;
      case "objectformat": {
        // git's hash_algo_by_name: the name exactly as git spells it
        const found = typeof value === "string" ? objectFormatByName(value) : undefined;
        if (!found) {
          throw new UnsupportedRepositoryFormatError(
            `invalid value for 'extensions.objectformat': '${String(value)}'`,
          );
        }
        format.objectFormat = found;
        break;
      }
      case "compatobjectformat": {
        // git's handle_extension: the compatibility format whose ids the loose object map
        // keeps (`compat/`)
        if (value === true || value === undefined) {
          throw new UnsupportedRepositoryFormatError(
            "missing value for 'extensions.compatobjectformat'",
          );
        }
        const found = typeof value === "string" ? objectFormatByName(value) : undefined;
        if (!found) {
          throw new UnsupportedRepositoryFormatError(
            `invalid value for 'extensions.compatobjectformat': '${String(value)}'`,
          );
        }
        format.compatObjectFormat = found;
        break;
      }
      case "refstorage": {
        const name = String(value);
        if (name !== "files" && name !== "reftable") {
          throw new UnsupportedRepositoryFormatError(
            `invalid value for 'extensions.refstorage': '${String(value)}'`,
          );
        }
        format.refStorage = name;
        break;
      }
      case "objectstorage": {
        // git master's `extensions.objectStorage` (setup.c handle_extension): `files`, or
        // `files://<objects directory>`, which we do not read (objects outside `objects/`)
        if (value === true || value === undefined) {
          throw new UnsupportedRepositoryFormatError(`missing value for '${key}'`);
        }
        const storage = objectStorageFormatByUri(String(value));
        if (!storage) {
          throw new UnsupportedRepositoryFormatError(
            `invalid value for 'extensions.objectstorage': '${String(value)}'`,
          );
        }
        if (storage.payload !== undefined) {
          unsupported.push(`extensions.objectStorage = ${String(value)}`);
        }
        break;
      }
      case "relativeworktrees":
        format.relativeWorktrees = configBool(value, key);
        break;
      case "submodulepathconfig":
        format.submodulePathConfig = configBool(value, key);
        break;
      default:
        unknown.push(ext);
        format.unknownExtensions = [...(format.unknownExtensions ?? []), ext.toLowerCase()];
        continue;
    }
    v1Only.push(ext);
  }
  if (version >= 1 && unknown.length > 0) {
    throw new UnsupportedRepositoryFormatError(
      `${unknown.length === 1 ? "unknown repository extension found:" : "unknown repository extensions found:"}${unknown.map((e) => `\n\t${e}`).join("")}`,
    );
  }
  if (version === 0 && v1Only.length > 0) {
    throw new UnsupportedRepositoryFormatError(
      `${v1Only.length === 1 ? "repo version is 0, but v1-only extension found:" : "repo version is 0, but v1-only extensions found:"}${v1Only.map((e) => `\n\t${e}`).join("")}`,
    );
  }
  if (format.compatObjectFormat?.name === format.objectFormat.name) {
    // git aborts here (repo_set_compat_hash_algo's BUG)
    throw new UnsupportedRepositoryFormatError(
      "BUG: repository.c:203: hash_algo and compat_hash_algo match",
    );
  }
  if (unsupported.length > 0) {
    throw new UnsupportedRepositoryFormatError(
      `repository format not supported by webrun-vcs:${unsupported.map((e) => `\n\t${e}`).join("")}`,
    );
  }
  if (format.partialClone === undefined) {
    // promisor_remote_config: a remote with `promisor = true`, or with a
    // `partialclonefilter` whatever its value, is a promisor remote (the first in config order)
    for (const key of config.listKeys("remote.")) {
      const lower = key.toLowerCase();
      const suffix = lower.endsWith(".promisor")
        ? ".promisor"
        : lower.endsWith(".partialclonefilter")
          ? ".partialclonefilter"
          : undefined;
      if (!suffix || key.length <= `remote.${suffix}`.length) continue;
      if (suffix === ".partialclonefilter" || gitTrue(config.get(key))) {
        format.partialClone = key.slice("remote.".length, -suffix.length);
        break;
      }
    }
  }
  return format;
}

/** An object storage format and its payload, as git's `object_storage_format_by_uri` reads them. */
export interface ObjectStorageFormat {
  /** the one format git knows: loose objects and packs */
  format: "files";
  /** the part after `://` when not empty: `files`' objects directory (relative to the common directory) */
  payload?: string;
}

/**
 * Reads an object storage format URI as git master's `object_storage_format_by_uri`
 * (`extensions.objectStorage`, `$GIT_OBJECT_STORAGE_FORMAT`,
 * `$GIT_DEFAULT_OBJECT_STORAGE_FORMAT`, `init.defaultObjectStorageFormat`): a name alone or
 * `<name>://<payload>`, an empty payload counting as none; undefined for a name git does
 * not know (only `files` exists).
 *
 * @example
 * ```typescript
 * objectStorageFormatByUri("files://objs"); // { format: "files", payload: "objs" }
 * objectStorageFormatByUri("garbage"); // undefined
 * ```
 */
export function objectStorageFormatByUri(uri: string): ObjectStorageFormat | undefined {
  const end = uri.indexOf("://");
  const name = end < 0 ? uri : uri.slice(0, end);
  if (name !== "files") return undefined;
  const payload = end < 0 ? "" : uri.slice(end + 3);
  return payload ? { format: "files", payload } : { format: "files" };
}

/**
 * Refuses an object storage format from the environment that we cannot honour, as git's
 * `setup_git_directory_gently` reads `$GIT_OBJECT_STORAGE_FORMAT` over the repository's
 * `extensions.objectStorage`: an unknown name is git's death (`unknown object storage
 * format: '<v>'`), a payload (objects outside `objects/`) is not supported here.
 *
 * @example
 * ```typescript
 * assertObjectStorageOverride(environment.objectStorageFormat); // throws for "files://objs"
 * ```
 */
export function assertObjectStorageOverride(uri: string | undefined): void {
  if (uri === undefined) return;
  const storage = objectStorageFormatByUri(uri);
  if (!storage) {
    throw new UnsupportedRepositoryFormatError(`unknown object storage format: '${uri}'`);
  }
  if (storage.payload !== undefined) {
    throw new UnsupportedRepositoryFormatError(
      `repository format not supported by webrun-vcs:\n\tGIT_OBJECT_STORAGE_FORMAT = ${uri}`,
    );
  }
}

/** A config value git reads as true; anything unparsable as false. */
function gitTrue(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  return false;
}

/**
 * Reads `<gitDir>/config` and checks its repository format (see `checkRepositoryFormat`). A
 * repository without a config reads as version 0 with no extensions. Include directives are
 * never followed here: git's `read_repository_format` reads the file through
 * `git_config_from_file`, which has no includes, so a `core.repositoryformatversion` set only
 * by an included file does not count.
 *
 * @example
 * ```typescript
 * const format = await readRepositoryFormat(files, ".git"); // throws for a sha256 repository
 * ```
 */
export async function readRepositoryFormat(
  files: FilesApi,
  gitDir = ".git",
): Promise<RepositoryFormat> {
  const config = await createWorkingCopyConfig(
    configFilesApiOf(files, { readOnly: "the repository format check never writes the config" }),
    gitDir,
    undefined,
    { includes: false },
  );
  return checkRepositoryFormat(config);
}

/**
 * Refuses to delete objects where the repository format forbids it: `preciousObjects` (git's
 * "cannot prune in a precious-objects repo") and partial clones, whose absent objects a
 * promisor remote provides, unless `partialClone: "allow"` (gc and repack, which keep the
 * promisor packs apart as git does; a bare prune does not). `operation`
 * names what was asked ("prune", "repack", "gc").
 *
 * @example
 * ```typescript
 * assertObjectsDeletable(await readRepositoryFormat(files, gitDir), "prune");
 * ```
 */
export function assertObjectsDeletable(
  format: RepositoryFormat,
  operation: string,
  options: { partialClone?: "refuse" | "allow" } = {},
): void {
  if (format.preciousObjects) {
    throw new UnsupportedRepositoryFormatError(
      `cannot ${operation} in a precious-objects repo (extensions.preciousObjects)`,
    );
  }
  if (format.partialClone !== undefined && options.partialClone !== "allow") {
    throw new UnsupportedRepositoryFormatError(
      `cannot ${operation} in a partial clone (promisor remote ${format.partialClone}): ` +
        "promisor objects are not supported",
    );
  }
}

/** git_config_int for the format version: unset is 0, anything else not an integer throws. */
function configInt(value: unknown, key: string): number {
  if (value === undefined) return 0;
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string") {
    const parsed = parseGitInt(value);
    if (parsed !== undefined) return parsed;
  }
  throw new UnsupportedRepositoryFormatError(
    `bad numeric config value '${String(value)}' for '${key}'`,
  );
}

/** git_config_bool: true/false spellings, numbers, and an empty value as false. */
function configBool(value: unknown, key: string): boolean {
  const parsed = parseGitBool(value);
  if (parsed !== undefined) return parsed;
  throw new UnsupportedRepositoryFormatError(
    `bad boolean config value '${String(value)}' for '${key}'`,
  );
}

/**
 * An integer as git_parse_int reads it: strtoimax with base 0 (decimal, `0x` hexadecimal,
 * leading-`0` octal) and an optional `k`, `m` or `g` unit. Undefined when it is not one.
 */
function parseGitInt(text: string): number | undefined {
  const match = /^\s*([+-]?)(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)([kKmMgG]?)\s*$/.exec(text);
  if (!match) return undefined;
  const [, sign, digits, unit] = match;
  const magnitude =
    digits.startsWith("0x") || digits.startsWith("0X")
      ? Number.parseInt(digits.slice(2), 16)
      : digits.length > 1 && digits.startsWith("0")
        ? Number.parseInt(digits.slice(1), 8)
        : Number.parseInt(digits, 10);
  const factor = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[unit.toLowerCase()] ?? 1;
  const result = (sign === "-" ? -1 : 1) * magnitude * factor;
  return Number.isSafeInteger(result) ? result : undefined;
}
