/**
 * The `pack.*` settings git's pack-objects reads where repack and gc write packs
 * (pack-objects.c `git_pack_config`): the delta search window and depth, its memory limits,
 * the zlib level, and whether a `.rev` file goes beside the pack.
 */

import type { DeltaSearchOptions, FilesApi } from "@statewalker/vcs-core";
import type { GitHostEnvironment } from "@statewalker/vcs-working-tree";
import {
  configFilesApiOf,
  createWorkingCopyConfig,
} from "../workspace/working-copy/working-copy-config.files.js";
import { configBool, parseConfigInt, parseConfigSize } from "./delta-base-cache-limit.js";

/** What `readPackWriteSettings` reads; a field is absent when its key is unset. */
export interface PackWriteSettings {
  /** `pack.writeReverseIndex` (default true since git 2.41) */
  writeReverseIndex: boolean;
  /** `pack.window` */
  window?: number;
  /** `pack.depth` (git caps it at 4095) */
  depth?: number;
  /** `pack.windowMemory` (0: no limit) */
  windowMemory?: number;
  /** `pack.deltaCacheSize` (0: no limit) */
  deltaCacheSize?: number;
  /** `pack.compression`, else `core.compression` (-1 to 9) */
  compression?: number;
  /**
   * `pack.packSizeLimit`: read, but webrun-vcs writes one pack per repack (no splitting), so
   * it has no effect
   */
  packSizeLimit?: number;
}

/** A `pack.*` value git refuses (git dies: `bad numeric config value`, `bad pack compression level`). */
export class PackConfigError extends Error {
  override name = "PackConfigError";
}

/** git's deepest delta chain (pack-objects: `delta chain depth %d is too deep, forcing 4095`). */
const MAX_DEPTH = 4095;

/**
 * Reads the pack settings of a repository's config (system and global files too, and the
 * command line, with an environment), as pack-objects reads them.
 *
 * @example
 * ```typescript
 * const settings = await readPackWriteSettings(files, ".git");
 * const deltaSearch = packDeltaSearch(settings); // { window, depth, ... } from pack.*
 * ```
 */
export async function readPackWriteSettings(
  files: FilesApi,
  gitDir = ".git",
  options: { environment?: GitHostEnvironment } = {},
): Promise<PackWriteSettings> {
  const config = await createWorkingCopyConfig(
    configFilesApiOf(files, { readOnly: "reading the pack settings never writes the config" }),
    gitDir,
    undefined,
    options.environment ? { environment: options.environment } : {},
  );
  const int = (key: string): number | undefined => {
    const v = config.get(key);
    if (v === undefined || v === null) return undefined;
    const n = parseConfigInt(v);
    if (n === undefined) throw new PackConfigError(`bad numeric config value '${v}' for '${key}'`);
    return n;
  };
  const size = (key: string): number | undefined => {
    const v = config.get(key);
    if (v === undefined || v === null) return undefined;
    const n = parseConfigSize(v);
    if (n === undefined) throw new PackConfigError(`bad numeric config value '${v}' for '${key}'`);
    return n;
  };
  const settings: PackWriteSettings = {
    writeReverseIndex: configBool(config.get("pack.writeReverseIndex"), true),
  };
  const window = int("pack.window");
  if (window !== undefined) settings.window = Math.max(0, window);
  const depth = int("pack.depth");
  if (depth !== undefined) settings.depth = Math.min(MAX_DEPTH, Math.max(0, depth));
  const windowMemory = size("pack.windowMemory");
  if (windowMemory !== undefined) settings.windowMemory = windowMemory;
  const deltaCacheSize = size("pack.deltaCacheSize");
  if (deltaCacheSize !== undefined) settings.deltaCacheSize = deltaCacheSize;
  const packSizeLimit = size("pack.packSizeLimit");
  if (packSizeLimit !== undefined) settings.packSizeLimit = packSizeLimit;
  // core.compression sets the pack level unless pack.compression does (git_default_core_config)
  for (const key of ["core.compression", "pack.compression"]) {
    const level = int(key);
    if (level === undefined) continue;
    if (level < -1 || level > 9)
      throw new PackConfigError(
        key === "pack.compression"
          ? `bad pack compression level ${level}`
          : `bad zlib compression level ${level}`,
      );
    settings.compression = level;
  }
  return settings;
}

/**
 * The delta search of a repack: the caller's options first, then the config's `pack.*`
 * (0 for `pack.windowMemory`/`pack.deltaCacheSize` is no limit, as in git). `false` stays off.
 */
export function packDeltaSearch(
  settings: PackWriteSettings,
  given: boolean | DeltaSearchOptions | undefined,
): boolean | DeltaSearchOptions {
  if (given === false) return false;
  const fromConfig: DeltaSearchOptions = {};
  if (settings.window !== undefined) fromConfig.window = settings.window;
  if (settings.depth !== undefined) fromConfig.depth = settings.depth;
  if (settings.windowMemory !== undefined)
    fromConfig.windowMemory =
      settings.windowMemory === 0 ? Number.POSITIVE_INFINITY : settings.windowMemory;
  if (settings.deltaCacheSize !== undefined)
    fromConfig.deltaCacheSize =
      settings.deltaCacheSize === 0 ? Number.POSITIVE_INFINITY : settings.deltaCacheSize;
  const explicit = typeof given === "object" ? given : {};
  const merged = { ...fromConfig, ...explicit };
  return Object.keys(merged).length === 0 ? true : merged;
}
