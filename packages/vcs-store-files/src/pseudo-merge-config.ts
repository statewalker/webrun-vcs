/**
 * `bitmapPseudoMerge.<name>.*` as git's pseudo-merge.c reads it (`pseudo_merge_config`,
 * `load_pseudo_merges_from_config`), only when a bitmap is written:
 *
 *  - `pattern` (required): a POSIX ERE, `^` added in front unless it starts with one;
 *  - `decay` (default 1, non-negative), `sampleRate` (default 1, in (0, 1]), `maxMerges`
 *    (default 64, non-negative), `stableSize` (default 512, positive): a value out of range
 *    warns and takes the default;
 *  - `threshold` (default `1.week.ago`) and `stableThreshold` (default `1.month.ago`), expiry
 *    dates (`now`, `never`, approxidate); a threshold before the stable one dies.
 *
 * Deaths throw `PseudoMergeConfigError` with git's message; warnings are returned.
 */
import type { PseudoMergeGroup } from "@statewalker/vcs-core";
import { compilePosixRegex } from "@statewalker/vcs-utils";
import { parseConfigInt } from "./pack/index.js";
import { parseExpiryDate } from "./reflog-expire.js";

/** A configuration git dies on while writing a bitmap (the message without `fatal: `). */
export class PseudoMergeConfigError extends Error {
  override name = "PseudoMergeConfigError";
}

/** A config entry as `listWithOrigin` gives it. */
export interface PseudoMergeConfigEntry {
  key: string;
  value?: unknown;
  text?: string;
}

const SECTION = "bitmappseudomerge";

/** git_config_double: a number with an optional `k`/`m`/`g` unit. */
function configDouble(key: string, text: string | undefined): number {
  const m = /^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)([kKmMgG]?)$/.exec(text ?? "");
  if (!m) throw new PseudoMergeConfigError(`bad numeric config value '${text ?? ""}' for '${key}'`);
  const unit = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[(m[2] as string).toLowerCase()];
  return Number.parseFloat(m[1] as string) * (unit ?? 1);
}

function configInt(key: string, text: string | undefined): number {
  const n = parseConfigInt(text ?? "");
  if (n === undefined || n > 0x7fffffff || n < -0x80000000)
    throw new PseudoMergeConfigError(`bad numeric config value '${text ?? ""}' for '${key}'`);
  return n;
}

/**
 * The pseudo-merge groups of `entries` (the configuration in git's reading order), sorted by
 * name; `now` (seconds) is what the date thresholds are relative to.
 *
 * @example
 * ```typescript
 * const { groups } = pseudoMergeGroupsOf(config.listWithOrigin(), Date.now() / 1000);
 * ```
 */
export function pseudoMergeGroupsOf(
  entries: Iterable<PseudoMergeConfigEntry>,
  now: number,
): { groups: PseudoMergeGroup[]; warnings: string[] } {
  const seconds = Math.floor(now);
  const groups = new Map<string, PseudoMergeGroup & { hasPattern: boolean }>();
  const warnings: string[] = [];
  for (const e of entries) {
    const first = e.key.indexOf(".");
    const last = e.key.lastIndexOf(".");
    if (first < 0 || last <= first) continue;
    if (e.key.slice(0, first).toLowerCase() !== SECTION) continue;
    const name = e.key.slice(first + 1, last);
    if (!name) continue;
    const variable = e.key.slice(last + 1).toLowerCase();
    const text = e.text ?? (typeof e.value === "string" ? e.value : undefined);
    const fullKey = `${SECTION}.${name}.${variable}`;
    let group = groups.get(name);
    if (!group) {
      group = {
        name,
        pattern: compilePosixRegex("^", { extended: true }),
        hasPattern: false,
        decay: 1,
        maxMerges: 64,
        sampleRate: 1,
        stableSize: 512,
        threshold: parseExpiryDate("1.week.ago", seconds),
        stableThreshold: parseExpiryDate("1.month.ago", seconds),
      };
      groups.set(name, group);
    }
    switch (variable) {
      case "pattern": {
        if (text === undefined) throw new PseudoMergeConfigError(`missing value for '${fullKey}'`);
        const re = text.startsWith("^") ? text : `^${text}`;
        try {
          group.pattern = compilePosixRegex(re, { extended: true });
        } catch {
          throw new PseudoMergeConfigError(
            `failed to load pseudo-merge regex for ${name}: '${re}'`,
          );
        }
        group.hasPattern = true;
        break;
      }
      case "decay":
        group.decay = configDouble(fullKey, text);
        if (group.decay < 0) {
          warnings.push(`warning: ${fullKey} must be non-negative, using default`);
          group.decay = 1;
        }
        break;
      case "samplerate":
        group.sampleRate = configDouble(fullKey, text);
        if (!(group.sampleRate > 0 && group.sampleRate <= 1)) {
          warnings.push(`warning: ${fullKey} must be between 0 (exclusive) and 1, using default`);
          group.sampleRate = 1;
        }
        break;
      case "threshold":
        group.threshold = parseExpiryDate(text ?? "", seconds, fullKey);
        break;
      case "stablethreshold":
        group.stableThreshold = parseExpiryDate(text ?? "", seconds, fullKey);
        break;
      case "maxmerges":
        group.maxMerges = configInt(fullKey, text);
        if (group.maxMerges < 0) {
          warnings.push(`warning: ${fullKey} must be non-negative, using default`);
          group.maxMerges = 64;
        }
        break;
      case "stablesize":
        group.stableSize = configInt(fullKey, text);
        if (group.stableSize <= 0) {
          warnings.push(`warning: ${fullKey} must be positive, using default`);
          group.stableSize = 512;
        }
        break;
    }
  }
  const sorted = [...groups.values()].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  for (const g of sorted) {
    if (!g.hasPattern)
      throw new PseudoMergeConfigError(`pseudo-merge group '${g.name}' missing required pattern`);
    if (g.threshold < g.stableThreshold)
      throw new PseudoMergeConfigError(
        `pseudo-merge group '${g.name}' has unstable threshold before stable one`,
      );
  }
  return {
    groups: sorted.map(({ hasPattern: _, ...g }) => g),
    warnings,
  };
}
