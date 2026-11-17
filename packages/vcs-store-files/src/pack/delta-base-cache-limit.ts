/**
 * git's `core.deltaBaseCacheLimit`: the bytes of resolved delta bases a reader keeps across
 * object reads (git's delta_base_cache, 96 MiB by default). The value is a size with an
 * optional `k`, `m` or `g` unit, as git_parse_ulong reads it.
 */

import type { FilesApi } from "@statewalker/vcs-core";
import { readFile } from "@statewalker/vcs-utils/files";
import { createWorkingCopyConfig } from "../workspace/working-copy/working-copy-config.files.js";

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
): Promise<number | undefined> {
  const config = await createWorkingCopyConfig(
    {
      read: async (path) => ((await files.exists(path)) ? readFile(files, path) : undefined),
      write: async () => {
        throw new Error("reading core.deltaBaseCacheLimit never writes the config");
      },
    },
    gitDir,
  );
  return parseConfigSize(config.get("core.deltaBaseCacheLimit"));
}

/** A size as git_parse_ulong reads it (decimal, 0x hex or 0 octal, then k, m or g). */
function parseConfigSize(value: unknown): number | undefined {
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
