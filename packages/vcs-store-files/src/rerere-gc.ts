/**
 * `git rerere gc`, as `git gc` runs it (rerere.c `rerere_gc`): in `rr-cache/<conflict id>/`,
 * a variant (`preimage`/`postimage`, or `preimage.<n>`/`postimage.<n>`) whose resolution
 * (`postimage`) was last used before `gc.rerereResolved` (default 60 days), or that was
 * never resolved and whose `preimage` dates from before `gc.rerereUnresolved` (default 15
 * days), loses its `thisimage`, `postimage` and `preimage`; a conflict directory left without
 * any variant is removed once empty (git's `rmdir`). Runs only where rerere is enabled
 * (`rerere.enabled`, or unset and `rr-cache/` exists); `rerere.enabled=true` creates
 * `rr-cache/` when it is missing, as `setup_rerere` does.
 */

import type { FilesApi } from "@statewalker/vcs-core";
import { joinPath } from "@statewalker/vcs-core";
import { parseGitBool } from "@statewalker/vcs-utils/encoding";
import type { GitHostEnvironment } from "@statewalker/vcs-working-tree";
import { parseExpiryDate } from "./reflog-expire.js";
import { readRepositoryFormat } from "./repository-format.js";
import {
  configFilesApiOf,
  createWorkingCopyConfig,
} from "./workspace/working-copy/working-copy-config.files.js";

const DAY = 86400;

export interface RerereGcOptions {
  files: FilesApi;
  /** The git directory (the common one: `rr-cache` is shared by worktrees) */
  gitDir?: string;
  /** System, global and command-line config besides the repository's */
  environment?: GitHostEnvironment;
  /** "Now", in seconds since the epoch (default the clock's) */
  now?: number;
}

export interface RerereGcResult {
  /** Whether rerere is enabled (else nothing was looked at) */
  enabled: boolean;
  /** Variants removed, as `<conflict id>/<file>` of their `preimage` */
  removedVariants: string[];
  /** Conflict directories removed */
  removedDirectories: string[];
}

/**
 * Prunes old rerere records (`git rerere gc`).
 *
 * @example
 * ```typescript
 * const { removedDirectories } = await rerereGc({ files, gitDir: ".git" });
 * ```
 */
export async function rerereGc(o: RerereGcOptions): Promise<RerereGcResult> {
  const { files } = o;
  const gitDir = o.gitDir ?? ".git";
  const now = o.now ?? Math.floor(Date.now() / 1000);
  const config = await createWorkingCopyConfig(
    configFilesApiOf(files, { readOnly: "rerere gc never writes the config" }),
    gitDir,
    undefined,
    o.environment ? { environment: o.environment } : {},
  );
  const result: RerereGcResult = { enabled: false, removedVariants: [], removedDirectories: [] };
  const cache = joinPath(gitDir, "rr-cache");
  const exists = (await files.stats(cache))?.kind === "directory";
  const enabledValue = config.get("rerere.enabled");
  const enabled =
    enabledValue === undefined || enabledValue === null
      ? exists
      : (parseGitBool(String(enabledValue)) ?? false);
  if (!enabled) return result;
  if (!exists) await files.mkdir(cache);
  result.enabled = true;

  const cutoff = (key: string, days: number): number => {
    const value = config.get(key);
    if (value === undefined || value === null) return now - days * DAY;
    const text = String(value).trim();
    // repo_config_get_expiry_in_days: a whole number of days, else an expiry date
    if (/^[-+]?\d+$/.test(text)) return now - Number(text) * DAY;
    const at = parseExpiryDate(text, now, key.toLowerCase());
    return at === Number.POSITIVE_INFINITY ? now : at;
  };
  const resolvedCutoff = cutoff("gc.rerereResolved", 60);
  const unresolvedCutoff = cutoff("gc.rerereUnresolved", 15);

  const mtime = async (path: string): Promise<number> => {
    const st = await files.stats(path);
    if (st?.kind !== "file") return 0;
    return st.lastModified === undefined ? now : Math.floor(st.lastModified / 1000);
  };
  // rerere's conflict ids are the repository's hash (rerere.c's hash_algo): its hex length
  const hexLength = (await readRepositoryFormat(files, gitDir)).objectFormat.hexLength;
  const CONFLICT_ID = new RegExp(`^[0-9a-fA-F]{${hexLength}}$`);
  const toRemove: string[] = [];
  for await (const entry of files.list(cache)) {
    if (entry.kind !== "directory" || !CONFLICT_ID.test(entry.name)) continue;
    const dir = joinPath(cache, entry.name);
    // scan_rerere_dir: the variants that have a preimage or a postimage
    const status = new Map<number, number>();
    for await (const f of files.list(dir)) {
      for (const [name, bit] of [
        ["postimage", 2],
        ["preimage", 1],
      ] as const) {
        const variant = variantOf(f.name, name);
        if (variant !== undefined) status.set(variant, (status.get(variant) ?? 0) | bit);
      }
    }
    let nowEmpty = true;
    for (const variant of [...status.keys()].sort((a, b) => a - b)) {
      const path = (file: string) => joinPath(dir, variant === 0 ? file : `${file}.${variant}`);
      let then = await mtime(path("postimage"));
      let limit = resolvedCutoff;
      if (!then) {
        then = await mtime(path("preimage"));
        limit = unresolvedCutoff;
      }
      if (then && then < limit) {
        // unlink_rr_item: thisimage, then the variant's postimage and preimage
        for (const file of ["thisimage", "postimage", "preimage"]) {
          const p = path(file);
          if ((await files.stats(p))?.kind === "file") await files.remove(p);
        }
        result.removedVariants.push(
          `${entry.name}/${variant === 0 ? "preimage" : `preimage.${variant}`}`,
        );
        status.set(variant, 0);
      }
      if (status.get(variant)) nowEmpty = false;
    }
    if (nowEmpty) toRemove.push(entry.name);
  }
  // rmdir: only directories left empty go
  for (const name of toRemove) {
    const dir = joinPath(cache, name);
    let empty = true;
    for await (const _ of files.list(dir)) {
      empty = false;
      break;
    }
    if (empty && (await files.remove(dir))) result.removedDirectories.push(name);
  }
  return result;
}

/** is_rr_file: `name` is `file` (variant 0) or `file.<n>` (strtol, nothing after). */
function variantOf(name: string, file: string): number | undefined {
  if (name === file) return 0;
  if (!name.startsWith(`${file}.`)) return undefined;
  const rest = name.slice(file.length + 1);
  if (!/^\s*[-+]?\d+$/.test(rest)) return undefined;
  const n = Number.parseInt(rest, 10);
  return n >= 0 ? n : undefined;
}
