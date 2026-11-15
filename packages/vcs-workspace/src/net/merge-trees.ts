/**
 * The three-way merge of a workspace sync: path by path over flat trees, and line by line
 * (`merge3Way` of `@statewalker/vcs-utils`, the same content merge `git merge` uses here) for
 * text files both sides changed. A conflict is never resolved silently: the file keeps both
 * sides — git's conflict markers for text, the other side next to it for binary content, the
 * changed side for a change against a deletion — and its path is reported.
 */

import { type History, probeBlob } from "@statewalker/vcs-core";
import { merge3Way } from "@statewalker/vcs-utils";
import { type FlatEntry, type FlatTree, MODE_FILE, sameEntry } from "./flat-tree.js";

/** What {@link mergeFlatTrees} produced. */
export interface FlatMergeResult {
  /** The merged files (conflicting paths hold both sides, as described above) */
  files: FlatTree;
  /** The paths that conflicted, sorted */
  conflicts: string[];
}

const TEXT_MODES = new Set([MODE_FILE, 0o100755]);

async function loadText(history: History, entry: FlatEntry | undefined) {
  if (!entry) return new Uint8Array(0);
  if (!TEXT_MODES.has(entry.mode)) return undefined;
  const probe = await probeBlob(history.blobs, entry.id, { loadText: true });
  return probe.binary ? undefined : probe.content;
}

/**
 * Merges `ours` and `theirs` against their common ancestor `base`. `theirsLabel` names the
 * copy of their side a binary conflict leaves next to ours (`<path>.<theirsLabel>`).
 */
export async function mergeFlatTrees(
  history: History,
  base: FlatTree,
  ours: FlatTree,
  theirs: FlatTree,
  theirsLabel = "theirs",
): Promise<FlatMergeResult> {
  const files: FlatTree = new Map();
  const conflicts = new Set<string>();
  const paths = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    if (sameEntry(o, b) || sameEntry(o, t)) {
      if (t) files.set(path, t);
      continue;
    }
    if (sameEntry(t, b)) {
      if (o) files.set(path, o);
      continue;
    }
    // both sides changed the path, differently
    if (!o || !t) {
      // a change against a deletion: the change is kept
      files.set(path, (o ?? t) as FlatEntry);
      conflicts.add(path);
      continue;
    }
    const [bt, ot, tt] = [
      await loadText(history, b),
      await loadText(history, o),
      await loadText(history, t),
    ];
    if (bt && ot && tt && o.mode === t.mode) {
      const merged = merge3Way(bt, ot, tt);
      const id = await history.blobs.store([merged.content]);
      files.set(path, { id, mode: o.mode });
      if (merged.hasConflicts) conflicts.add(path);
      continue;
    }
    // binary (or a mode change on one side and a content change on the other): both kept
    files.set(path, o);
    files.set(`${path}.${theirsLabel}`, t);
    conflicts.add(path);
  }
  // a path that is a file on one side and a directory on the other: the file moves aside
  for (const path of [...files.keys()]) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      const file = files.get(dir);
      if (!file) continue;
      files.delete(dir);
      files.set(`${dir}.${theirsLabel}`, file);
      conflicts.add(dir);
    }
  }
  return { files, conflicts: [...conflicts].sort() };
}
