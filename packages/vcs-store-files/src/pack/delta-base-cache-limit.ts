/**
 * git's `core.deltaBaseCacheLimit`: the bytes of resolved delta bases a reader keeps across
 * object reads (git's delta_base_cache, 96 MiB by default). The value is a size with an
 * optional `k`, `m` or `g` unit, as git_parse_ulong reads it.
 */

import type { FilesApi } from "@statewalker/vcs-core";
import { parseGitBool } from "@statewalker/vcs-utils/encoding";
import type { GitHostEnvironment } from "@statewalker/vcs-working-tree";
import {
  configFilesApiOf,
  createWorkingCopyConfig,
  type GitWorkingCopyConfig,
} from "../workspace/working-copy/working-copy-config.files.js";

/**
 * `core.deltaBaseCacheLimit` of the repository at `gitDir`, or undefined when it is unset or
 * not a size (the default then applies; git dies on a bad value, a reader can do without).
 *
 * @example
 * ```typescript
 * const limit = await readDeltaBaseCacheLimit(files, ".git"); // 100663296 for "96m"
 * const packs = await openPackSet(files, ".git/objects/pack", { baseCacheBytes: limit });
 * ```
 */
export async function readDeltaBaseCacheLimit(
  files: FilesApi,
  gitDir = ".git",
  options: {
    /** Which include directives of the repository's config are followed (git's: all) */
    includes?: boolean | "files";
    /** The user's environment: the whole sequence is read, the command line last */
    environment?: GitHostEnvironment;
  } = {},
): Promise<number | undefined> {
  return (await readPackSetSettings(files, gitDir, options)).baseCacheBytes;
}

/**
 * The config a pack set reads, in one pass: `core.deltaBaseCacheLimit` and
 * `core.multiPackIndex` (git's default true; an empty or unparsable value reads as git's
 * `git_config_bool` would, false for empty). With an `environment`, from git's whole sequence
 * (system, global, the repository's, `config.worktree`, the command line).
 */
export async function readPackSetSettings(
  files: FilesApi,
  gitDir = ".git",
  options: {
    includes?: boolean | "files";
    environment?: GitHostEnvironment;
    /** The config already loaded for these options: read instead of loading it again */
    config?: Pick<GitWorkingCopyConfig, "get">;
  } = {},
): Promise<{
  baseCacheBytes?: number;
  multiPackIndex: boolean;
  writeReverseIndex: boolean;
  readReverseIndex: boolean;
}> {
  const config =
    options.config ??
    (await createWorkingCopyConfig(
      configFilesApiOf(files, {
        readOnly: "reading the pack settings never writes the config",
      }),
      gitDir,
      undefined,
      {
        ...(options.includes === undefined ? {} : { includes: options.includes }),
        ...(options.environment ? { environment: options.environment } : {}),
      },
    ));
  const midx = config.get("core.multiPackIndex");
  const multiPackIndex =
    midx === undefined || midx === null
      ? true
      : typeof midx === "boolean"
        ? midx
        : (parseGitBool(String(midx)) ?? true);
  const baseCacheBytes = parseConfigSize(config.get("core.deltaBaseCacheLimit"));
  return {
    ...(baseCacheBytes !== undefined ? { baseCacheBytes } : {}),
    multiPackIndex,
    // git 2.41+ defaults: .rev files written with every pack and read where present
    writeReverseIndex: configBool(config.get("pack.writeReverseIndex"), true),
    readReverseIndex: configBool(config.get("pack.readReverseIndex"), true),
  };
}

/** A boolean setting with its default (an empty value is false, as git_config_bool). */
export function configBool(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  return parseGitBool(String(value)) ?? fallback;
}

/** A size as git_parse_ulong reads it (decimal, 0x hex or 0 octal, then k, m or g). */
export function parseConfigSize(value: unknown): number | undefined {
  if (typeof value === "number")
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  if (typeof value !== "string") return undefined;
  const match = /^\s*\+?(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)([kKmMgG]?)\s*$/.exec(value);
  if (!match) return undefined;
  const digits = match[1] as string;
  const unit = (match[2] as string).toLowerCase();
  const magnitude =
    digits.length > 2 && (digits[1] === "x" || digits[1] === "X")
      ? Number.parseInt(digits.slice(2), 16)
      : digits.length > 1 && digits.startsWith("0")
        ? Number.parseInt(digits.slice(1), 8)
        : Number.parseInt(digits, 10);
  const factor = unit === "k" ? 1024 : unit === "m" ? 1024 ** 2 : unit === "g" ? 1024 ** 3 : 1;
  const size = magnitude * factor;
  return Number.isSafeInteger(size) ? size : undefined;
}

/** An integer as git_config_int reads it (sign, decimal, 0x hex or 0 octal, then k, m or g). */
export function parseConfigInt(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const match = /^\s*([-+]?)(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)([kKmMgG]?)\s*$/.exec(value);
  if (!match) return undefined;
  const digits = match[2] as string;
  const magnitude =
    digits.length > 2 && (digits[1] === "x" || digits[1] === "X")
      ? Number.parseInt(digits.slice(2), 16)
      : digits.length > 1 && digits.startsWith("0")
        ? Number.parseInt(digits.slice(1), 8)
        : Number.parseInt(digits, 10);
  const unit = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[(match[3] as string).toLowerCase()];
  const n = magnitude * (unit ?? 1) * (match[1] === "-" ? -1 : 1);
  return Number.isSafeInteger(n) ? n : undefined;
}
