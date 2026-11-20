/**
 * Merge drivers (git's `merge` attribute and `merge.<driver>.*`): the builtin `text`,
 * `binary` and `union` drivers are merge-ort's own; a host registers its drivers as callbacks
 * (git runs `merge.<driver>.driver` as a shell command, which is not portable), much as it
 * registers filter drivers.
 *
 * @example
 * ```typescript
 * installMergeDrivers(workingCopy, {
 *   // `*.json merge=keep-ours` in .gitattributes
 *   "keep-ours": createMergeDriver(async ({ ours }) => ({ content: ours, conflict: false })),
 * });
 * await git.merge().include("feature").call();
 * ```
 */

import {
  type ConflictStyle,
  type LineMergeOptions,
  mergeLines,
  parseGitBool,
} from "@statewalker/vcs-utils";
import type { WorkingCopy, Worktree } from "@statewalker/vcs-working-tree";

import { SimilarityIndex } from "../rename/index.js";
import { configBool, configValue } from "./merge-config.js";
import type { MergeAttributes, OrtMergeOptions } from "./ort-merge.js";

/** A `merge` attribute: set, unset, a driver name, or unspecified. */
export type MergeAttributeValue = true | false | string | undefined;

/** What a merge driver gets (git's `%O`, `%A`, `%B`, `%L`, `%P`, `%S`, `%X`, `%Y`). */
export interface MergeDriverInput {
  /** The path being merged */
  path: string;
  /** The merge base's content (empty when there is none) */
  base: Uint8Array;
  /** Our content */
  ours: Uint8Array;
  /** Their content */
  theirs: Uint8Array;
  /** The base's name (`%S`), ours (`%X`), theirs (`%Y`) */
  baseLabel: string;
  oursLabel: string;
  theirsLabel: string;
  /** The conflict marker length to use (`%L`) */
  markerSize: number;
}

/** What a merge driver gives back: the merged content, and whether it holds conflicts. */
export interface MergeDriverResult {
  content: Uint8Array;
  conflict: boolean;
}

/** A merge driver a host registers. */
export interface MergeDriver {
  merge(input: MergeDriverInput): Promise<MergeDriverResult>;
  /**
   * The driver used for the merges of merge bases that build a virtual base
   * (`merge.<driver>.recursive`); the configuration's value wins when it has one
   */
  recursive?: string;
}

/** Merge drivers by name. */
export type MergeDriverRegistry = ReadonlyMap<string, MergeDriver> | Record<string, MergeDriver>;

/** A merge driver from a callback. */
export function createMergeDriver(
  merge: (input: MergeDriverInput) => Promise<MergeDriverResult>,
  options: { recursive?: string } = {},
): MergeDriver {
  return { merge, ...(options.recursive ? { recursive: options.recursive } : {}) };
}

/** The driver registered under `name`, if any. */
export function lookupMergeDriver(
  registry: MergeDriverRegistry | undefined,
  name: string,
): MergeDriver | undefined {
  if (!registry) return undefined;
  if (registry instanceof Map) return registry.get(name);
  const record = registry as Record<string, MergeDriver>;
  return Object.hasOwn(record, name) ? record[name] : undefined;
}

const installed = new WeakMap<object, MergeDriverRegistry>();

/** Registers the merge drivers the merges of `workingCopy` use. */
export function installMergeDrivers(workingCopy: WorkingCopy, drivers: MergeDriverRegistry): void {
  installed.set(workingCopy, drivers);
}

/** The merge drivers registered for `workingCopy`. */
export function mergeDriversOf(workingCopy: WorkingCopy): MergeDriverRegistry | undefined {
  return installed.get(workingCopy);
}

/**
 * The driver for a path's `merge` attribute (git's `find_ll_merge_driver`): `text` when set
 * (or unspecified without `merge.default`), `binary` when unset, else the named driver: a
 * registered one, a builtin (`text`, `binary`, `union`), or `text` for an unknown name.
 */
export function findMergeDriver(
  attr: MergeAttributeValue,
  drivers: MergeDriverRegistry | undefined,
  defaultDriver?: string,
): { name: string; custom?: MergeDriver } {
  let name: string;
  if (attr === true) return { name: "text" };
  if (attr === false) return { name: "binary" };
  if (attr === undefined) {
    if (!defaultDriver) return { name: "text" };
    name = defaultDriver;
  } else name = attr;
  const custom = lookupMergeDriver(drivers, name);
  if (custom) return { name, custom };
  if (name === "binary" || name === "text" || name === "union") return { name };
  return { name: "text" };
}

/** The three versions of a path {@link lowLevelMerge} merges, with their marker labels. */
export interface LowLevelMergeInput {
  path: string;
  base: Uint8Array;
  ours: Uint8Array;
  theirs: Uint8Array;
  baseLabel: string;
  oursLabel: string;
  theirsLabel: string;
}

/** How {@link lowLevelMerge} merges (git's `ll_merge_options` and the path's attributes). */
export interface LowLevelMergeOptions {
  /** The path's `merge` and `conflict-marker-size` attributes */
  attributes?: MergeAttributes;
  /** Registered drivers, `merge.default`, `merge.<driver>.recursive` */
  drivers?: MergeDriverRegistry;
  defaultDriver?: string;
  recursiveDriver?: (name: string) => string | undefined;
  /** A merge of merge bases (`virtual_ancestor`): the recursive driver, the base on binary */
  virtualAncestor?: boolean;
  /** `-X ours` / `-X theirs` / `-X union` (ignored for a merge of merge bases) */
  favor?: "ours" | "theirs" | "union";
  style?: ConflictStyle;
  /** Added to the marker size (merge-ort's nested conflicts) */
  extraMarkerSize?: number;
  /** Files above this size are binary (core.bigFileThreshold; default 512 MiB) */
  bigFileThreshold?: number;
  /** The diff algorithm: merge-ort's histogram, `checkout -m`'s myers */
  algorithm?: LineMergeOptions["algorithm"];
}

/** What {@link lowLevelMerge} gives: `binary` is git's `LL_MERGE_BINARY_CONFLICT`. */
export interface LowLevelMergeResult {
  status: "ok" | "conflict" | "binary";
  content: Uint8Array;
}

/**
 * git's `ll_merge`: the driver of the path's `merge` attribute (text, binary, union or a
 * registered one) with the `conflict-marker-size` markers; binary content (or a `binary`
 * driver) keeps ours as a binary conflict, the base in a merge of merge bases.
 */
export async function lowLevelMerge(
  input: LowLevelMergeInput,
  options: LowLevelMergeOptions = {},
): Promise<LowLevelMergeResult> {
  const { path, base: orig, ours: src1, theirs: src2 } = input;
  const attrs = options.attributes ?? {};
  let markerSize = 7;
  const size = attrs.conflictMarkerSize;
  if (typeof size === "string") {
    const parsed = /^[+-]?\d+$/.test(size.trim()) ? Number.parseInt(size, 10) : Number.NaN;
    markerSize = Number.isNaN(parsed) || parsed <= 0 ? 7 : parsed;
  }
  let driver = findMergeDriver(attrs.merge, options.drivers, options.defaultDriver);
  if (options.virtualAncestor) {
    const recursive = driver.custom?.recursive ?? options.recursiveDriver?.(driver.name);
    if (recursive) driver = findMergeDriver(recursive, options.drivers, options.defaultDriver);
  }
  markerSize += options.extraMarkerSize ?? 0;
  const favor = options.virtualAncestor ? undefined : options.favor;
  const binaryMerge = (): LowLevelMergeResult => {
    // ll_binary_merge: the base for an inner merge, else ours (or the favored side)
    if (options.virtualAncestor) return { status: "ok", content: orig };
    if (favor === "ours") return { status: "ok", content: src1 };
    if (favor === "theirs") return { status: "ok", content: src2 };
    return { status: "binary", content: src1 };
  };
  if (driver.custom) {
    const out = await driver.custom.merge({
      path,
      base: orig,
      ours: src1,
      theirs: src2,
      baseLabel: input.baseLabel,
      oursLabel: input.oursLabel,
      theirsLabel: input.theirsLabel,
      markerSize,
    });
    return { status: out.conflict ? "conflict" : "ok", content: out.content };
  }
  if (driver.name === "binary") return binaryMerge();
  const threshold = options.bigFileThreshold ?? 512 * 1024 * 1024;
  if (
    [orig, src1, src2].some((bytes) => bytes.length > threshold || SimilarityIndex.isBinary(bytes))
  ) {
    return binaryMerge();
  }
  const lines = mergeLines(orig, src1, src2, {
    oursLabel: input.oursLabel,
    theirsLabel: input.theirsLabel,
    baseLabel: input.baseLabel,
    style: options.style,
    favor: driver.name === "union" ? "union" : favor,
    markerSize,
    ...(options.algorithm ? { algorithm: options.algorithm } : {}),
  });
  return { status: lines.conflicts > 0 ? "conflict" : "ok", content: lines.content };
}

/** The attributes interface a content filter may offer (GitContentFilter's). */
interface AttributeReader {
  attributes?(
    path: string,
    names: readonly string[],
    context?: { direction: "checkin" | "checkout"; index?: unknown },
  ): Promise<Map<string, MergeAttributeValue>>;
  renormalize?(
    path: string,
    content: Uint8Array,
    context?: { direction: "checkin" | "checkout"; index?: unknown },
  ): Promise<Uint8Array>;
}

/**
 * The settings of a merge from the configuration and the worktree: `merge.renames`,
 * `merge.directoryRenames`, `merge.renameLimit`, `merge.renormalize`, `merge.default`,
 * `merge.<driver>.recursive`, the `merge` / `conflict-marker-size` attributes as merge-ort
 * reads them (the worktree's `.gitattributes`, as git reads them with no index of its own),
 * and the registered drivers.
 */
export function ortConfigOptions(
  workingCopy: WorkingCopy,
  worktree: Worktree | undefined,
  overrides: {
    renormalize?: boolean;
    /**
     * Read the attributes as `ll_merge` reads them for a path of the index (`checkout -m`):
     * the worktree's `.gitattributes`, then the index's (merge-ort's attribute index is
     * none)
     */
    indexAttributes?: boolean;
  } = {},
): Partial<OrtMergeOptions> {
  const out: Partial<OrtMergeOptions> = {};
  // merge.renames over diff.renames (`copies` counts as on)
  const renamesKey =
    configValue(workingCopy, "merge.renames") !== undefined ? "merge.renames" : "diff.renames";
  const renames = configValue(workingCopy, renamesKey)?.trim().toLowerCase();
  if (renames !== undefined && renames !== "copies" && renames !== "copy") {
    if (!configBool(workingCopy, renamesKey, true)) out.renames = false;
  }
  const dirRenamesValue = configValue(workingCopy, "merge.directoryRenames");
  if (dirRenamesValue !== undefined) {
    const dirRenames = parseGitBool(dirRenamesValue);
    if (dirRenames === false) out.directoryRenames = "false";
    else if (dirRenames === true) out.directoryRenames = "true";
    else if (dirRenamesValue.toLowerCase() === "conflict") out.directoryRenames = "conflict";
  }
  const limit =
    configValue(workingCopy, "merge.renameLimit") ?? configValue(workingCopy, "diff.renameLimit");
  if (limit !== undefined && /^-?\d+$/.test(limit.trim())) {
    const n = Number.parseInt(limit, 10);
    out.renameLimit = n <= 0 ? 7000 : n;
  }
  const renormalize = overrides.renormalize ?? configBool(workingCopy, "merge.renormalize", false);
  const defaultDriver = configValue(workingCopy, "merge.default");
  if (defaultDriver) out.defaultDriver = defaultDriver;
  out.recursiveDriver = (name) => configValue(workingCopy, `merge.${name}.recursive`);
  const drivers = mergeDriversOf(workingCopy);
  if (drivers) out.drivers = drivers;
  const filter = worktree?.contentFilter as AttributeReader | undefined;
  if (filter?.attributes) {
    const read = filter.attributes.bind(filter);
    // merge-ort's attribute index is empty (no merge.renormalize) or holds the merged
    // .gitattributes; the worktree's files are read first either way
    const context = overrides.indexAttributes
      ? { direction: "checkin" as const }
      : { direction: "checkin" as const, index: { attributesBlob: () => undefined } };
    out.attributes = async (path): Promise<MergeAttributes> => {
      const values = await read(path, ["merge", "conflict-marker-size"], context);
      return { merge: values.get("merge"), conflictMarkerSize: values.get("conflict-marker-size") };
    };
  }
  if (renormalize) {
    out.renormalize = true;
    if (filter?.renormalize) {
      const norm = filter.renormalize.bind(filter);
      out.renormalizeContent = (path, content) => norm(path, content);
    }
  }
  return out;
}
