import type { ObjectId } from "@statewalker/vcs-core";

import type { CommandTrees } from "../git-command.js";

/**
 * Directory mode constant.
 */
const TREE_MODE = 0o040000;

/**
 * The object and file mode a tree records for one path.
 */
interface PathEntry {
  id: ObjectId;
  mode: number;
}

/**
 * The outcome of a three-way tree merge.
 *
 * `conflicts` is absent on a clean merge. When it is present `tree` is the
 * *theirs* tree, not a merged one: a conflicting merge never builds a tree, so
 * callers must halt rather than record `tree` as a result.
 */
export interface TreeMergeResult {
  tree: ObjectId;
  conflicts?: string[];
}

/**
 * Recursively walk a tree, yielding all entries with full paths.
 */
async function* walkTreeRecursive(
  trees: CommandTrees,
  treeId: ObjectId,
  prefix = "",
): AsyncGenerator<{ path: string; id: ObjectId; mode: number }> {
  for await (const entry of trees.loadTree(treeId)) {
    const fullPath = prefix ? `${prefix}/${entry.name}` : entry.name;

    if ((entry.mode & TREE_MODE) === TREE_MODE) {
      // It's a directory - recurse into it
      yield* walkTreeRecursive(trees, entry.id, fullPath);
    } else {
      // It's a file
      yield { path: fullPath, id: entry.id, mode: entry.mode };
    }
  }
}

/**
 * Build a tree from flat path entries (handles nested directories).
 */
async function buildTreeFromPaths(
  trees: CommandTrees,
  entries: Map<string, PathEntry>,
): Promise<ObjectId> {
  // Group entries by top-level directory
  const rootEntries: Map<string, PathEntry> = new Map();
  const subDirs: Map<string, Map<string, PathEntry>> = new Map();

  for (const [path, entry] of entries) {
    const slashIndex = path.indexOf("/");
    if (slashIndex === -1) {
      // Top-level file
      rootEntries.set(path, entry);
    } else {
      // Nested path - group by first component
      const dirName = path.substring(0, slashIndex);
      const restPath = path.substring(slashIndex + 1);

      if (!subDirs.has(dirName)) {
        subDirs.set(dirName, new Map());
      }
      subDirs.get(dirName)?.set(restPath, entry);
    }
  }

  // Recursively create subtrees
  for (const [dirName, subEntries] of subDirs) {
    const subTreeId = await buildTreeFromPaths(trees, subEntries);
    rootEntries.set(dirName, { id: subTreeId, mode: TREE_MODE });
  }

  // Create the tree
  const treeEntries = Array.from(rootEntries.entries()).map(([name, { id, mode }]) => ({
    name,
    id,
    mode,
  }));

  return trees.storeTree(treeEntries);
}

/**
 * Whether two optional tree entries denote the same state for a path.
 *
 * Both absent means the path is absent on both sides. When both are present,
 * content *and* mode must match: comparing object ids alone treats a
 * mode-only change (setting the executable bit on unchanged content, say) as
 * no change at all, which silently discards it.
 */
function entriesEqual(a: PathEntry | undefined, b: PathEntry | undefined): boolean {
  if (!a || !b) {
    return !a && !b;
  }
  return a.id === b.id && a.mode === b.mode;
}

/**
 * The paths in a merged entry set that a directory would overwrite.
 *
 * Every entry is a file - the recursive walk never yields a tree - so a path
 * is claimed as a *directory* only implicitly, by another entry lying below
 * it. `a` and `a/b` cannot both exist in a tree: building one from that set
 * writes `a` as a file and then overwrites it with the `a/` subtree, losing
 * the file. The separator is what makes a prefix a directory boundary - `ab`
 * is not inside `a/` and does not collide with it.
 *
 * @param paths The paths of the merged entries
 * @returns The colliding file paths, sorted
 */
function findDirectoryCollisions(paths: Iterable<string>): string[] {
  const allPaths = [...paths];
  const directories = new Set<string>();
  for (const path of allPaths) {
    for (let at = path.indexOf("/"); at !== -1; at = path.indexOf("/", at + 1)) {
      directories.add(path.substring(0, at));
    }
  }
  return allPaths.filter((path) => directories.has(path)).sort();
}

/**
 * Path-level three-way tree merge with recursive support.
 *
 * Merges per path against the `base` tree: a path only one side changed takes
 * that side, a path both sides changed identically merges cleanly, and a path
 * the two sides changed differently is reported as a conflict. So is a path
 * one side made a file and the other made a directory, which no tree can
 * represent.
 *
 * The merge is path-level only - it never merges the *contents* of a file.
 * Two sides editing different regions of the same file conflict here where
 * git would resolve them.
 *
 * Shared by `rebase` (base = the replayed commit's parent, ours = that commit,
 * theirs = the commit being replayed onto) and `stash apply` (base = the
 * commit the stash was taken from, ours = the stash, theirs = HEAD). It is
 * *not* what `merge` uses: that command keeps its own entry-level merge
 * because it also resolves conflicts at the content level and writes conflict
 * stages into the index.
 *
 * @param trees The tree store to read from and write the merged tree to
 * @param base The common ancestor tree
 * @param ours The tree whose changes are being applied
 * @param theirs The tree being applied onto
 * @returns The merged tree, or `theirs` plus the conflicting paths
 */
export async function mergeTreesThreeWay(
  trees: CommandTrees,
  base: ObjectId,
  ours: ObjectId,
  theirs: ObjectId,
): Promise<TreeMergeResult> {
  // Simplified merge: if trees are identical, no conflict
  if (ours === theirs) {
    return { tree: theirs };
  }
  if (base === ours) {
    return { tree: theirs };
  }
  if (base === theirs) {
    return { tree: ours };
  }

  // Collect all entries from all trees recursively
  const conflicts: string[] = [];
  const mergedEntries: Map<string, PathEntry> = new Map();

  const baseEntries = new Map<string, PathEntry>();
  const oursEntries = new Map<string, PathEntry>();
  const theirsEntries = new Map<string, PathEntry>();

  // Recursively walk all trees
  for await (const entry of walkTreeRecursive(trees, base)) {
    baseEntries.set(entry.path, { id: entry.id, mode: entry.mode });
  }
  for await (const entry of walkTreeRecursive(trees, ours)) {
    oursEntries.set(entry.path, { id: entry.id, mode: entry.mode });
  }
  for await (const entry of walkTreeRecursive(trees, theirs)) {
    theirsEntries.set(entry.path, { id: entry.id, mode: entry.mode });
  }

  // Collect all paths
  const allPaths = new Set([...baseEntries.keys(), ...oursEntries.keys(), ...theirsEntries.keys()]);

  for (const path of allPaths) {
    const baseEntry = baseEntries.get(path);
    const oursEntry = oursEntries.get(path);
    const theirsEntry = theirsEntries.get(path);

    // Only one side changed the path relative to base - take that side. If
    // that side deleted the path, it is simply not carried into the merge.
    if (entriesEqual(oursEntry, baseEntry)) {
      if (theirsEntry) {
        mergedEntries.set(path, theirsEntry);
      }
      continue;
    }
    if (entriesEqual(theirsEntry, baseEntry)) {
      if (oursEntry) {
        mergedEntries.set(path, oursEntry);
      }
      continue;
    }

    // Both sides changed the path. Identical changes merge cleanly - and
    // that includes both sides deleting it, which leaves it deleted.
    if (entriesEqual(oursEntry, theirsEntry)) {
      if (oursEntry) {
        mergedEntries.set(path, oursEntry);
      }
      continue;
    }

    // Conflict: both sides changed the path differently. Conflicts are only
    // collected here - a conflicting merge never builds a tree from
    // `mergedEntries` (see the early return below) and the caller halts, so
    // there is no merged content to record for this path.
    conflicts.push(path);
  }

  // One side made a path a file while the other made it a directory. Both are
  // one-sided carries above - a path both sides changed cannot collide, since
  // carrying it needs the two sides to agree and no single tree holds `a` as a
  // file and `a/b` at once - so this is only detectable once the whole merged
  // set is known, not inside the loop.
  conflicts.push(...findDirectoryCollisions(mergedEntries.keys()));

  if (conflicts.length > 0) {
    return { tree: theirs, conflicts };
  }

  // Build tree from merged entries (handles nested paths)
  const newTree = await buildTreeFromPaths(trees, mergedEntries);
  return { tree: newTree };
}
