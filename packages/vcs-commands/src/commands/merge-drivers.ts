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

import { parseGitBool } from "@statewalker/vcs-utils";
import type { WorkingCopy, Worktree } from "@statewalker/vcs-working-tree";

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
  overrides: { renormalize?: boolean } = {},
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
    const context = { direction: "checkin" as const, index: { attributesBlob: () => undefined } };
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
