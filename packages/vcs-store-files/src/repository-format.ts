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
 * Beyond git's own check, what git knows but we do not implement is refused too: the
 * reftable ref storage (`extensions.refStorage = reftable`), sha256 objects
 * (`extensions.objectFormat = sha256`) and a compatibility object format
 * (`extensions.compatObjectFormat`).
 */

import type { FilesApi } from "@statewalker/vcs-core";
import { readFile } from "@statewalker/vcs-utils/files";

import { createWorkingCopyConfig } from "./workspace/working-copy/working-copy-config.files.js";

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
   * writes since git 2.29; git's `repo_has_promisor_remote` checks both)
   */
  partialClone?: string;
  /** `extensions.worktreeConfig`: linked worktrees read their own `config.worktree` */
  worktreeConfig: boolean;
  /** `extensions.relativeWorktrees` (version 1): worktree links are relative paths */
  relativeWorktrees: boolean;
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
        const name = String(value);
        if (name !== "sha1" && name !== "sha256") {
          throw new UnsupportedRepositoryFormatError(
            `invalid value for 'extensions.objectformat': '${String(value)}'`,
          );
        }
        if (name !== "sha1") unsupported.push(`extensions.objectFormat = ${name}`);
        break;
      }
      case "compatobjectformat": {
        const name = String(value);
        if (name !== "sha1" && name !== "sha256") {
          throw new UnsupportedRepositoryFormatError(
            `invalid value for 'extensions.compatobjectformat': '${String(value)}'`,
          );
        }
        unsupported.push(`extensions.compatObjectFormat = ${name}`);
        break;
      }
      case "refstorage": {
        const name = String(value);
        if (name !== "files" && name !== "reftable") {
          throw new UnsupportedRepositoryFormatError(
            `invalid value for 'extensions.refstorage': '${String(value)}'`,
          );
        }
        if (name !== "files") unsupported.push(`extensions.refStorage = ${name}`);
        break;
      }
      case "relativeworktrees":
        format.relativeWorktrees = configBool(value, key);
        break;
      case "submodulepathconfig":
        configBool(value, key);
        break;
      default:
        unknown.push(ext);
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
  if (unsupported.length > 0) {
    throw new UnsupportedRepositoryFormatError(
      `repository format not supported by webrun-vcs (files refs and sha1 objects only):${unsupported.map((e) => `\n\t${e}`).join("")}`,
    );
  }
  if (format.partialClone === undefined) {
    for (const key of config.listKeys("remote.")) {
      if (!key.endsWith(".promisor") || key.length <= "remote..promisor".length) continue;
      if (gitTrue(config.get(key))) {
        format.partialClone = key.slice("remote.".length, -".promisor".length);
        break;
      }
    }
  }
  return format;
}

/** A config value git reads as true; anything unparsable as false. */
function gitTrue(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  return false;
}

/**
 * Reads `<gitDir>/config` and checks its repository format (see `checkRepositoryFormat`). A
 * repository without a config reads as version 0 with no extensions.
 *
 * @example
 * ```typescript
 * const format = await readRepositoryFormat(files, ".git"); // throws for a reftable repository
 * ```
 */
export async function readRepositoryFormat(
  files: FilesApi,
  gitDir = ".git",
): Promise<RepositoryFormat> {
  const config = await createWorkingCopyConfig(
    {
      read: async (path) => ((await files.exists(path)) ? readFile(files, path) : undefined),
      write: async () => {
        throw new Error("the repository format check never writes the config");
      },
    },
    gitDir,
  );
  return checkRepositoryFormat(config);
}

/**
 * Refuses to delete objects where the repository format forbids it: `preciousObjects` (git's
 * "cannot prune in a precious-objects repo") and partial clones, whose absent objects a
 * promisor remote provides and whose promisor packs we do not handle. `operation` names what
 * was asked ("prune", "repack", "gc").
 *
 * @example
 * ```typescript
 * assertObjectsDeletable(await readRepositoryFormat(files, gitDir), "prune");
 * ```
 */
export function assertObjectsDeletable(format: RepositoryFormat, operation: string): void {
  if (format.preciousObjects) {
    throw new UnsupportedRepositoryFormatError(
      `cannot ${operation} in a precious-objects repo (extensions.preciousObjects)`,
    );
  }
  if (format.partialClone !== undefined) {
    throw new UnsupportedRepositoryFormatError(
      `cannot ${operation} in a partial clone (promisor remote ${format.partialClone}): ` +
        "promisor objects are not supported",
    );
  }
}

/**
 * Refuses gc and repack in a repository that borrows objects through
 * `objects/info/alternates`: those objects are not read here, so what only they hold would
 * look absent (a reachable one aborts the walk; a ref to one would silently stop being a
 * root). git handles alternates; we refuse instead of guessing.
 *
 * @example
 * ```typescript
 * await assertNoAlternates(files, ".git", "gc");
 * ```
 */
export async function assertNoAlternates(
  files: FilesApi,
  gitDir = ".git",
  operation = "gc",
): Promise<void> {
  const path = `${gitDir.replace(/\/+$/, "")}/objects/info/alternates`;
  if ((await files.stats(path))?.kind !== "file") return;
  const text = new TextDecoder().decode(await readFile(files, path));
  const used = text.split("\n").some((line) => line.trim() !== "" && !line.startsWith("#"));
  if (used) {
    throw new UnsupportedRepositoryFormatError(
      `cannot ${operation} in a repository with alternates (objects/info/alternates): ` +
        "the objects it borrows are not read",
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
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (value === "") return false;
  if (typeof value === "string") {
    const parsed = parseGitInt(value);
    if (parsed !== undefined) return parsed !== 0;
  }
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
