/**
 * Loading and clearing the multi-pack-index files of a pack directory through the FilesApi
 * (midx.c's `load_multi_pack_index`, `clear_midx_file`, `clear_incremental_midx_files`).
 *
 * ```typescript
 * const loaded = await loadMultiPackIndex(files, ".git/objects/pack");
 * if (loaded.midx?.containsPack("pack-1234.pack")) await clearMultiPackIndex(files, packDir);
 * ```
 */
import type { ObjectFormat } from "@statewalker/vcs-utils/hash";
import type { FilesApi } from "../common/files/index.js";
import {
  MIDX_CHAIN_DIR,
  MIDX_CHAIN_FILE,
  MIDX_FILE,
  type MultiPackIndex,
  MultiPackIndexError,
  parseMultiPackIndex,
} from "./multi-pack-index.js";

/**
 * The most layers, and layer bytes in all, of an incremental chain we load (git has no limit). A
 * crafted served repository could otherwise make every lookup walk tens of thousands of layers,
 * or hold gigabytes; past either the chain is refused (a recorded warning) and the packs are
 * searched without it.
 */
export const MAX_MIDX_CHAIN_LAYERS = 4096;
export const MAX_MIDX_CHAIN_BYTES = 2 ** 31;

/** What loading a pack directory's midx gave. */
export interface LoadedMultiPackIndex {
  /** the midx (the tip layer of a chain), undefined when there is none or it was refused */
  midx?: MultiPackIndex;
  /** git's stderr lines while loading (`error:`/`warning:`/`fatal:` prefixed) */
  errors: string[];
  /** the refusal where git dies (a wrong signature, version or missing required chunk) */
  fatal?: MultiPackIndexError;
  /** whether `multi-pack-index` exists as a file (verify's "exists, but failed to parse") */
  fileExists: boolean;
}

async function readFile(files: FilesApi, path: string): Promise<Uint8Array | undefined> {
  const st = await files.stats(path);
  if (st?.kind !== "file") return undefined;
  const parts: Uint8Array[] = [];
  let n = 0;
  for await (const c of files.read(path)) {
    parts.push(c);
    n += c.length;
  }
  if (parts.length === 1) return parts[0] as Uint8Array;
  const out = new Uint8Array(n);
  let at = 0;
  for (const c of parts) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/**
 * git's `load_multi_pack_index`: `multi-pack-index`, else the incremental chain in
 * `multi-pack-index.d/` (layers loaded until one fails, the chain so far kept, as git keeps it).
 */
export async function loadMultiPackIndex(
  files: FilesApi,
  packDir: string,
  options: {
    /** 2.43 does not check the fan-out's order on load, and dies on a version 2 file */
    compatibility?: "2.43" | "2.56";
    /**
     * The repository's object format (default SHA-1): the files' hash version and id width,
     * and the chain's lines (`hexLength` digits each)
     */
    objectFormat?: ObjectFormat;
  } = {},
): Promise<LoadedMultiPackIndex> {
  const parseOptions = {
    checkFanoutOrder: options.compatibility !== "2.43",
    acceptVersion2: options.compatibility !== "2.43",
    ...(options.objectFormat ? { objectFormat: options.objectFormat } : {}),
  };
  const hexLength = options.objectFormat?.hexLength ?? 40;
  const chainLine = hexLength === 64 ? /^[0-9a-f]{64}$/ : /^[0-9a-f]{40}$/;
  const errors: string[] = [];
  const path = `${packDir}/${MIDX_FILE}`;
  const bytes = await readFile(files, path);
  if (bytes) {
    try {
      return {
        midx: parseMultiPackIndex(bytes, path, undefined, parseOptions),
        errors,
        fileExists: true,
      };
    } catch (e) {
      if (!(e instanceof MultiPackIndexError)) throw e;
      errors.push(...e.lines);
      if (e.fatal) return { errors, fatal: e, fileExists: true };
    }
  }
  const fileExists = bytes !== undefined;
  const chainPath = `${packDir}/${MIDX_CHAIN_DIR}/${MIDX_CHAIN_FILE}`;
  const chain = await readFile(files, chainPath);
  if (!chain || chain.length === 0) return { errors, fileExists };
  if (chain.length < hexLength) {
    errors.push("warning: multi-pack-index chain file too small");
    return { errors, fileExists };
  }
  const count = Math.floor(chain.length / (hexLength + 1));
  if (count > MAX_MIDX_CHAIN_LAYERS) {
    errors.push(
      `warning: multi-pack-index chain has too many layers (${count} > ${MAX_MIDX_CHAIN_LAYERS}); ignoring it`,
    );
    return { errors, fileExists };
  }
  const lines = new TextDecoder().decode(chain).split("\n");
  let tip: MultiPackIndex | undefined;
  let chainBytes = 0;
  for (let i = 0; i < count && i < lines.length; i++) {
    const line = lines[i] as string;
    if (!chainLine.test(line)) {
      errors.push(`warning: invalid multi-pack-index chain: line '${line}' not a hash`);
      break;
    }
    const layerPath = `${packDir}/${MIDX_CHAIN_DIR}/multi-pack-index-${line}.midx`;
    chainBytes += (await files.stats(layerPath))?.size ?? 0;
    if (chainBytes > MAX_MIDX_CHAIN_BYTES) {
      errors.push(
        `warning: multi-pack-index chain layers exceed ${MAX_MIDX_CHAIN_BYTES} bytes; ignoring it`,
      );
      return { errors, fileExists };
    }
    const layer = await readFile(files, layerPath);
    let m: MultiPackIndex | undefined;
    if (layer) {
      try {
        m = parseMultiPackIndex(layer, layerPath, tip, parseOptions);
      } catch (e) {
        if (!(e instanceof MultiPackIndexError)) throw e;
        errors.push(...e.lines);
        if (e.fatal) return { errors, fatal: e, fileExists };
      }
    }
    if (!m) {
      errors.push("warning: unable to find all multi-pack index files");
      break;
    }
    tip = m;
  }
  return { ...(tip ? { midx: tip } : {}), errors, fileExists };
}

async function removeMatching(
  files: FilesApi,
  dir: string,
  ext: string,
  keep: ReadonlySet<string>,
): Promise<void> {
  const names: string[] = [];
  try {
    for await (const e of files.list(dir)) names.push(e.name);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith("multi-pack-index-") || !name.endsWith(ext)) continue;
    if (keep.has(name)) continue;
    if (!(await files.remove(`${dir}/${name}`))) throw new Error(`failed to remove ${dir}/${name}`);
  }
}

/**
 * git's `clear_midx_file`: removes `multi-pack-index` and every `multi-pack-index-*.bitmap`
 * and `-*.rev` of the pack directory.
 */
export async function clearMultiPackIndex(files: FilesApi, packDir: string): Promise<void> {
  const path = `${packDir}/${MIDX_FILE}`;
  if ((await files.stats(path)) && !(await files.remove(path)))
    throw new Error(`failed to clear multi-pack-index at ${path}`);
  await removeMatching(files, packDir, "bitmap", new Set());
  await removeMatching(files, packDir, "rev", new Set());
}

/**
 * git's `clear_incremental_midx_files`: removes the chain file (unless `keepHashes` is given)
 * and the layers, bitmaps and reverse indexes of `multi-pack-index.d/` not named by
 * `keepHashes`.
 */
export async function clearIncrementalMultiPackIndex(
  files: FilesApi,
  packDir: string,
  keepHashes?: readonly string[],
): Promise<void> {
  const dir = `${packDir}/${MIDX_CHAIN_DIR}`;
  const chain = `${dir}/${MIDX_CHAIN_FILE}`;
  if (!keepHashes && (await files.stats(chain)) && !(await files.remove(chain)))
    throw new Error(`failed to clear multi-pack-index chain at ${chain}`);
  for (const ext of ["bitmap", "rev", "midx"]) {
    const keep = new Set((keepHashes ?? []).map((h) => `multi-pack-index-${h}.${ext}`));
    await removeMatching(files, dir, ext, keep);
  }
}

/**
 * What git's repack does before it deletes a redundant pack (`repack_remove_redundant_pack`):
 * when the midx (or a layer of its chain) names one of `packNames`, the midx and its bitmaps
 * are cleared, and the incremental chain too unless the repack wrote an incremental layer.
 * Returns whether anything was cleared.
 */
export async function clearMultiPackIndexNaming(
  files: FilesApi,
  packDir: string,
  packNames: readonly string[],
  options: { wroteIncremental?: boolean; midx?: MultiPackIndex; objectFormat?: ObjectFormat } = {},
): Promise<boolean> {
  const midx =
    options.midx ??
    (
      await loadMultiPackIndex(
        files,
        packDir,
        options.objectFormat ? { objectFormat: options.objectFormat } : {},
      )
    ).midx;
  if (!midx) return false;
  if (!packNames.some((name) => midx.containsPack(name.endsWith(".pack") ? name : `${name}.pack`)))
    return false;
  await clearMultiPackIndex(files, packDir);
  if (!options.wroteIncremental) await clearIncrementalMultiPackIndex(files, packDir);
  return true;
}
