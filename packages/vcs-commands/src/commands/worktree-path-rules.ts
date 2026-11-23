/**
 * git's `verify_path` as checkout, reset, read-tree, merge and clone apply it: the rules of
 * the worktree (Windows paths) and of the configuration (`core.protectNTFS`,
 * `core.protectHFS`), and git's messages for a tree that holds a path it refuses.
 */

import {
  FileMode,
  InvalidTreeEntryNameError,
  isValidWorktreePath,
  type ObjectId,
  protectHFSDefault,
  type WorktreePathOptions,
} from "@statewalker/vcs-core";
import { decodeGitPath } from "@statewalker/vcs-utils/encoding";
import type { WorkingCopy, Worktree } from "@statewalker/vcs-working-tree";

import { EmptyTreeEntryNameError, InvalidPathError } from "../errors/index.js";
import type { CommandTrees } from "../git-command.js";
import { coreBool } from "./core-config.js";
import { hostEnvironmentOf } from "./git-ident.js";

/**
 * The path rules a command applies to the paths a tree gives the index and the worktree:
 * Windows rules on a Windows worktree, `core.protectNTFS` (default true) and
 * `core.protectHFS` (default {@link protectHFSDefault}: on for macOS and for an unknown
 * system, off for a known other one). A worktree that refuses more itself
 * (`capabilities.protects`: `FileWorktree` keeps both on everywhere) raises them, so a
 * command refuses such a path before writing anything rather than halfway through.
 *
 * @example
 * ```typescript
 * const rules = worktreePathRules(workingCopy, worktree);
 * isValidWorktreePath("git~1/config", undefined, rules); // false unless core.protectNTFS=false
 * ```
 */
export function worktreePathRules(
  workingCopy: WorkingCopy | undefined,
  worktree?: Worktree,
): WorktreePathOptions {
  const systemName = workingCopy ? hostEnvironmentOf(workingCopy)?.systemName : undefined;
  const protects = worktree?.capabilities?.protects;
  return {
    windows: worktree?.capabilities?.windowsPaths === true,
    protectNTFS:
      protects?.ntfs === true || (workingCopy ? coreBool(workingCopy, "protectNTFS", true) : true),
    protectHFS:
      protects?.hfs === true ||
      (workingCopy
        ? coreBool(workingCopy, "protectHFS", protectHFSDefault(systemName))
        : protectHFSDefault(systemName)),
  };
}

/** One entry of a raw tree, read without refusing any name. */
interface RawEntry {
  mode: number;
  name: string;
  id: ObjectId;
}

/** A tree's entries as stored, names unchecked (undefined when the tree cannot be read). */
async function rawEntries(trees: CommandTrees, treeId: ObjectId): Promise<RawEntry[] | undefined> {
  const bytes = await trees.raw?.(treeId);
  if (!bytes) return undefined;
  const idLength = treeId.length / 2;
  const out: RawEntry[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(0x20, offset);
    const nul = space < 0 ? -1 : bytes.indexOf(0, space + 1);
    if (nul < 0 || nul + 1 + idLength > bytes.length) return undefined;
    let mode = 0;
    for (let i = offset; i < space; i++) mode = mode * 8 + (bytes[i] - 0x30);
    const name = decodeGitPath(bytes.subarray(space + 1, nul));
    let id = "";
    for (let i = nul + 1; i < nul + 1 + idLength; i++) id += bytes[i].toString(16).padStart(2, "0");
    out.push({ mode, name, id });
    offset = nul + 1 + idLength;
  }
  return out;
}

/**
 * What git says of a tree holding a path it refuses, else undefined: walking the tree in its
 * order as unpack-trees adds its entries to the index, the first entry with an empty name
 * (git dies decoding it, {@link EmptyTreeEntryNameError}) or the first file, link or
 * submodule whose full path `verify_path` refuses ({@link InvalidPathError}). Reads the raw
 * trees, so it answers for names the tree decoder refuses (`..`, `/` in a name). One
 * deliberate divergence: a path below a name holding `/` (`c:/temp/x`) is refused here,
 * where git checks it out as nested directories (fsck's `fullPathname` warning); ours never
 * reads such a tree.
 *
 * @example
 * ```typescript
 * const refusal = await treePathRefusal(trees, treeId, rules);
 * if (refusal) throw refusal; // error: invalid path '../no'
 * ```
 */
export async function treePathRefusal(
  trees: CommandTrees,
  treeId: ObjectId,
  rules: WorktreePathOptions,
  prefix = "",
  slashed = false,
): Promise<EmptyTreeEntryNameError | InvalidPathError | undefined> {
  const entries = await rawEntries(trees, treeId);
  if (!entries) return undefined;
  for (const entry of entries) {
    if (entry.name === "") return new EmptyTreeEntryNameError();
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    const refused = slashed || entry.name.includes("/");
    if ((entry.mode & 0o170000) === FileMode.TREE) {
      const below = await treePathRefusal(trees, entry.id, rules, path, refused);
      if (below) return below;
    } else if (refused || !isValidWorktreePath(path, entry.mode, rules)) {
      return new InvalidPathError(path);
    }
  }
  return undefined;
}

/**
 * Runs `body`; when it fails on a tree name the decoder refuses (`..`, `.`, `/`, an empty
 * name), throws git's refusal for the first of `treeIds` that holds one instead
 * ({@link treePathRefusal}), passed through `wrap` (a command's own lines).
 */
export async function withTreePathRefusal<T>(
  trees: CommandTrees,
  treeIds: Array<ObjectId | undefined> | (() => Array<ObjectId | undefined>),
  rules: WorktreePathOptions,
  body: () => Promise<T>,
  wrap: (refusal: EmptyTreeEntryNameError | InvalidPathError) => Error = (refusal) => refusal,
): Promise<T> {
  try {
    return await body();
  } catch (error) {
    if (!(error instanceof InvalidTreeEntryNameError)) throw error;
    for (const treeId of typeof treeIds === "function" ? treeIds() : treeIds) {
      if (!treeId) continue;
      const refusal = await treePathRefusal(trees, treeId, rules);
      if (refusal) throw wrap(refusal);
    }
    throw error;
  }
}

/**
 * The first path (in index order) of `target` that `verify_path` refuses among those whose
 * entry is not already `base`'s (the index's entries passed the check when they were added),
 * else undefined: what unpack-trees reports (`invalid path '<path>'`) before it writes anything.
 *
 * @example
 * ```typescript
 * const path = firstInvalidPath(target, index, rules);
 * if (path) return { message: `error: invalid path '${path}'`, paths: [path] };
 * ```
 */
export function firstInvalidPath(
  target: ReadonlyMap<string, { objectId: ObjectId; mode: number }>,
  base: ReadonlyMap<string, { objectId: ObjectId; mode: number }>,
  rules: WorktreePathOptions,
): string | undefined {
  let first: string | undefined;
  for (const [path, entry] of target) {
    const known = base.get(path);
    if (known && known.objectId === entry.objectId && known.mode === entry.mode) continue;
    if (isValidWorktreePath(path, entry.mode, rules)) continue;
    if (first === undefined || compareIndexPaths(path, first) < 0) first = path;
  }
  return first;
}

/** The index's order of paths: their UTF-8 bytes compared (`cache_name_compare`). */
function compareIndexPaths(a: string, b: string): number {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return (x[i] as number) - (y[i] as number);
  return x.length - y.length;
}

const encoder = new TextEncoder();
