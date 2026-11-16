/**
 * git's merge-ort on flat trees (path -> blob, link or gitlink): the merge `merge`,
 * `cherry-pick`, `revert`, `rebase` and `stash apply` run, without writing anything.
 *
 * Renames on each side are detected (exact, then by similarity) and carry the other side's
 * change to the new path; files both sides changed are merged line by line with git's
 * markers; binary files, links changed on both sides, modify/delete, rename/delete,
 * rename/rename, distinct types and file/directory collisions are conflicts placed and staged
 * as merge-ort places and stages them. The messages merge-ort prints come along, sorted by
 * path as git prints them.
 */

import { type Blobs, FileMode, type ObjectId } from "@statewalker/vcs-core";
import { type ConflictStyle, mergeLines } from "@statewalker/vcs-utils";

import { detectRenames, type RenameCandidate, SimilarityIndex } from "../rename/index.js";
import type { CheckedEntry } from "./worktree-overwrite-checks.js";

/** A path the merge could not resolve, as merge-ort leaves it. */
export interface OrtConflict {
  base?: CheckedEntry;
  ours?: CheckedEntry;
  theirs?: CheckedEntry;
  /** Where the stages (and the worktree file) go: the path, or `<path>~<side>` */
  stagePath: string;
  /** The file with conflict markers, for a text conflict */
  content?: Uint8Array;
  /** The blob the worktree gets at `stagePath` where the merge writes another side's */
  write?: CheckedEntry;
  /** The path a file/directory or distinct-types conflict moves ours away from */
  moveFrom?: string;
  /** What merge-ort's result tree holds at `stagePath` (none: nothing there) */
  tree?: CheckedEntry;
  mode: number;
}

/** Options of {@link ortMerge}. */
export interface OrtMergeOptions {
  /** Our side's name in markers and messages (git's branch1, e.g. `HEAD`) */
  oursLabel: string;
  /** Their side's name (git's branch2: the branch, or `<abbrev> (<subject>)`) */
  theirsLabel: string;
  /** The base's name after `|||||||` (diff3, zdiff3) */
  baseLabel?: string;
  /** Names a file moved aside gets (`<path>~<name>`); default the labels */
  oursName?: string;
  theirsName?: string;
  /** merge.conflictStyle */
  style?: ConflictStyle;
  /** `-X ours`, `-X theirs`: conflicting hunks (and binary files) resolved to a side */
  favor?: "ours" | "theirs" | "union";
  /** A case-folding worktree (core.ignorecase): names taken in another case are taken */
  ignoreCase?: boolean;
  /** Detect renames (default true) */
  renames?: boolean;
  /** Files above this size are binary to the merge (core.bigFileThreshold) */
  bigFileThreshold?: number;
}

/** What {@link ortMerge} found. */
export interface OrtMergeResult {
  /** The cleanly merged entries */
  result: Map<string, CheckedEntry>;
  /** The conflicts, by the path they came from */
  conflicts: Map<string, OrtConflict>;
  /** merge-ort's messages (`Auto-merging x`, `CONFLICT (...)`), in git's order */
  messages: string[];
}

const sameEntry = (a: CheckedEntry | undefined, b: CheckedEntry | undefined) =>
  a === undefined || b === undefined ? a === b : a.objectId === b.objectId && a.mode === b.mode;

const isRegular = (e?: CheckedEntry) =>
  e !== undefined && (e.mode === FileMode.REGULAR_FILE || e.mode === FileMode.EXECUTABLE_FILE);

/** The S_IFMT kind of a mode: file, link, gitlink. */
const kindOf = (mode: number) =>
  mode === FileMode.SYMLINK ? "link" : mode === FileMode.GITLINK ? "gitlink" : "file";

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** Reads a blob whole. */
export async function readBlob(blobs: Blobs, id: ObjectId): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of (await blobs.load(id)) ?? []) chunks.push(chunk);
  return concatBytes(chunks);
}

/**
 * The paths `side` renamed from `base`: deleted paths paired with added ones as git's
 * rename detection pairs them (exact renames, then the best scoring at least 50%).
 */
async function sideRenames(
  blobs: Blobs,
  base: Map<string, CheckedEntry>,
  side: Map<string, CheckedEntry>,
): Promise<Map<string, string>> {
  const candidate = (path: string, e: CheckedEntry): RenameCandidate => ({
    path,
    mode: e.mode,
    id: e.objectId,
  });
  const deleted = [...base].filter(([p]) => !side.has(p)).map(([p, e]) => candidate(p, e));
  const added = [...side].filter(([p]) => !base.has(p)).map(([p, e]) => candidate(p, e));
  const renames = new Map<string, string>();
  if (deleted.length === 0 || added.length === 0) return renames;
  const pairs = await detectRenames(deleted, added, {
    // merge-ort never pairs empty files
    renameEmpty: false,
    load: (c) => readBlob(blobs, c.id),
  });
  for (const pair of pairs) renames.set(pair.from, pair.to);
  return renames;
}

/**
 * Merges `theirs` into `ours` against `base`, as git's merge-ort (non-recursive: one base).
 * Content-merged blobs are stored in `blobs`.
 */
export async function ortMerge(
  blobs: Blobs,
  baseIn: Map<string, CheckedEntry>,
  oursIn: Map<string, CheckedEntry>,
  theirsIn: Map<string, CheckedEntry>,
  options: OrtMergeOptions,
): Promise<OrtMergeResult> {
  const { oursLabel, theirsLabel } = options;
  const base = new Map(baseIn);
  const ours = new Map(oursIn);
  const theirs = new Map(theirsIn);
  const conflicts = new Map<string, OrtConflict>();
  const notes: { path: string; order: number; text: string }[] = [];
  let order = 0;
  const say = (path: string, text: string) => notes.push({ path, order: order++, text });
  // where each side's version of a renamed path came from (for the markers' labels)
  const origin = new Map<string, { base: string; ours: string; theirs: string }>();
  const threshold = options.bigFileThreshold ?? 512 * 1024 * 1024;
  const read = async (e?: CheckedEntry) => (e ? readBlob(blobs, e.objectId) : new Uint8Array(0));

  /**
   * merge-ort's handle_content_merge of three regular files: the blob and mode, whether it
   * is clean, the text with markers for a conflict. `from` names the three paths when a
   * rename made them differ (the labels then read `HEAD:path`).
   */
  const mergeContents = async (
    path: string,
    b: CheckedEntry | undefined,
    o: CheckedEntry,
    t: CheckedEntry,
    from?: { base: string; ours: string; theirs: string },
  ): Promise<{ objectId: ObjectId; mode: number; clean: boolean; content?: Uint8Array }> => {
    let mode = o.mode;
    let clean = true;
    if (o.mode === t.mode || (b && o.mode === b.mode)) mode = t.mode;
    else clean = b !== undefined && t.mode === b.mode;
    if (o.objectId === t.objectId || (b && o.objectId === b.objectId)) {
      return { objectId: t.objectId, mode, clean };
    }
    if (b && t.objectId === b.objectId) return { objectId: o.objectId, mode, clean };
    const [bb, ob, tb] = [await read(b), await read(o), await read(t)];
    const labels =
      from && !(from.base === from.ours && from.ours === from.theirs)
        ? {
            oursLabel: `${oursLabel}:${from.ours}`,
            theirsLabel: `${theirsLabel}:${from.theirs}`,
            baseLabel: `${options.baseLabel ?? ""}:${from.base}`,
          }
        : { oursLabel, theirsLabel, baseLabel: options.baseLabel };
    const binary = [bb, ob, tb].some(
      (bytes) => bytes.length > threshold || SimilarityIndex.isBinary(bytes),
    );
    if (binary) {
      // ll_binary_merge: ours (or the favored side) stands, a conflict unless favored
      say(
        path,
        `warning: Cannot merge binary files: ${path} (${labels.oursLabel} vs. ${labels.theirsLabel})`,
      );
      say(path, `Auto-merging ${path}`);
      if (options.favor === "theirs") return { objectId: t.objectId, mode, clean };
      return { objectId: o.objectId, mode, clean: clean && options.favor === "ours" };
    }
    say(path, `Auto-merging ${path}`);
    const lines = mergeLines(bb, ob, tb, { ...labels, style: options.style, favor: options.favor });
    const objectId = await blobs.store([lines.content]);
    if (lines.conflicts > 0) return { objectId, mode, clean: false, content: lines.content };
    return { objectId, mode, clean };
  };

  if (options.renames !== false) {
    const oursRenames = await sideRenames(blobs, baseIn, oursIn);
    const theirsRenames = await sideRenames(blobs, baseIn, theirsIn);
    // both sides renamed the same path: to one path, it merges there; to two, git's
    // CONFLICT (rename/rename): the original at stage 1, each side's at its path
    for (const [from, oursTo] of [...oursRenames]) {
      const theirsTo = theirsRenames.get(from);
      const original = base.get(from);
      if (theirsTo === undefined || !original) continue;
      oursRenames.delete(from);
      theirsRenames.delete(from);
      if (theirsTo === oursTo) {
        base.delete(from);
        base.set(oursTo, original);
        origin.set(oursTo, { base: from, ours: oursTo, theirs: oursTo });
        continue;
      }
      const o = ours.get(oursTo);
      const t = theirs.get(theirsTo);
      if (!o || !t || theirs.has(oursTo) || ours.has(theirsTo)) continue;
      base.delete(from);
      ours.delete(oursTo);
      theirs.delete(theirsTo);
      say(
        from,
        `CONFLICT (rename/rename): ${from} renamed to ${oursTo} in ${oursLabel} and to ${theirsTo} in ${theirsLabel}.`,
      );
      conflicts.set(from, { base: original, stagePath: from, mode: original.mode });
      // the three versions merged, the result recorded (and written) at both new paths
      const merged =
        isRegular(original) && isRegular(o) && isRegular(t)
          ? await mergeContents(from, original, o, t, {
              base: from,
              ours: oursTo,
              theirs: theirsTo,
            })
          : undefined;
      const oursEntry = merged ? { objectId: merged.objectId, mode: merged.mode } : o;
      const theirsEntry = merged ? { objectId: merged.objectId, mode: merged.mode } : t;
      conflicts.set(oursTo, {
        ours: oursEntry,
        stagePath: oursTo,
        mode: oursEntry.mode,
        tree: oursEntry,
        ...(sameEntry(oursEntry, o) ? {} : { write: oursEntry }),
      });
      conflicts.set(theirsTo, {
        theirs: theirsEntry,
        stagePath: theirsTo,
        mode: theirsEntry.mode,
        write: theirsEntry,
        tree: theirsEntry,
      });
    }
    // a path one side renamed: the other side's change merges at the new path; deleted on
    // the other side, git's CONFLICT (rename/delete): stage 1 and the renaming side's
    for (const [renames, side, other, sideIsOurs] of [
      [oursRenames, ours, theirs, true],
      [theirsRenames, theirs, ours, false],
    ] as const) {
      for (const [from, to] of renames) {
        const original = base.get(from);
        if (!original) continue;
        if (other.has(to)) {
          // merge-ort's rename/add: the other side added a file where this one renamed
          // to. The renamed file (the other side's change of the original merged in) and
          // the added one meet there as an add/add: stages 2 and 3, no base
          const renamed = side.get(to);
          if (base.has(to) || !renamed) continue;
          const changed = other.get(from);
          base.delete(from);
          other.delete(from);
          if (changed && isRegular(original) && isRegular(changed) && isRegular(renamed)) {
            const merged = sideIsOurs
              ? await mergeContents(from, original, renamed, changed, {
                  base: from,
                  ours: to,
                  theirs: from,
                })
              : await mergeContents(from, original, changed, renamed, {
                  base: from,
                  ours: from,
                  theirs: to,
                });
            side.set(to, { objectId: merged.objectId, mode: merged.mode });
          }
          continue;
        }
        const moved = other.get(from);
        base.delete(from);
        if (moved) {
          other.delete(from);
          other.set(to, moved);
          base.set(to, original);
          origin.set(
            to,
            sideIsOurs
              ? { base: from, ours: to, theirs: from }
              : { base: from, ours: from, theirs: to },
          );
          continue;
        }
        const kept = side.get(to);
        if (!kept) continue;
        side.delete(to);
        say(
          to,
          `CONFLICT (rename/delete): ${from} renamed to ${to} in ${sideIsOurs ? oursLabel : theirsLabel}, but deleted in ${sideIsOurs ? theirsLabel : oursLabel}.`,
        );
        if (kept.objectId !== original.objectId || kept.mode !== original.mode) {
          // renamed and changed: the deletion is a modify/delete as well
          const [deletedIn, modifiedIn] = sideIsOurs
            ? [theirsLabel, oursLabel]
            : [oursLabel, theirsLabel];
          say(
            to,
            `CONFLICT (modify/delete): ${to} deleted in ${deletedIn} and modified in ${modifiedIn}.  Version ${modifiedIn} of ${to} left in tree.`,
          );
        }
        conflicts.set(to, {
          base: original,
          ...(sideIsOurs ? { ours: kept } : { theirs: kept, write: kept }),
          stagePath: to,
          mode: kept.mode,
          tree: kept,
        });
      }
    }
  }

  const result = new Map<string, CheckedEntry>();
  const paths = [...new Set([...base.keys(), ...ours.keys(), ...theirs.keys()])].sort();
  // names merge-ort moves a file aside to (`<path>~<side>`), unique as its unique_path
  const dirsOf = (keys: Iterable<string>) => {
    const dirs = new Set<string>();
    for (const path of keys) {
      for (let k = path.indexOf("/"); k > 0; k = path.indexOf("/", k + 1)) {
        dirs.add(path.slice(0, k));
      }
    }
    return dirs;
  };
  const fold = (name: string) => (options.ignoreCase ? name.toLowerCase() : name);
  const taken = new Set<string>();
  for (const map of [baseIn, oursIn, theirsIn, base, ours, theirs]) {
    for (const path of map.keys()) taken.add(fold(path));
    for (const dir of dirsOf(map.keys())) taken.add(fold(dir));
  }
  const flatten = (name: string) => name.replaceAll("/", "_");
  const oursName = flatten(options.oursName ?? oursLabel);
  const theirsName = flatten(options.theirsName ?? theirsLabel);
  const uniquePath = (path: string, name: string) => {
    let candidate = `${path}~${name}`;
    for (let n = 0; taken.has(fold(candidate)); n++) candidate = `${path}~${name}_${n}`;
    taken.add(fold(candidate));
    return candidate;
  };

  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    if (sameEntry(o, t) || sameEntry(b, t)) {
      if (o) result.set(path, o);
      continue;
    }
    if (sameEntry(b, o)) {
      if (t) result.set(path, t);
      continue;
    }
    if (!o || !t) {
      // modify/delete: the surviving side stays in the worktree, staged 1 and 2 or 3
      const kept = (o ?? t) as CheckedEntry;
      const [deletedIn, modifiedIn] = o ? [theirsLabel, oursLabel] : [oursLabel, theirsLabel];
      say(
        path,
        `CONFLICT (modify/delete): ${path} deleted in ${deletedIn} and modified in ${modifiedIn}.  Version ${modifiedIn} of ${path} left in tree.`,
      );
      conflicts.set(path, {
        base: b,
        ours: o,
        theirs: t,
        stagePath: path,
        mode: kept.mode,
        ...(t ? { write: t } : {}),
        tree: kept,
      });
      continue;
    }
    if (kindOf(o.mode) !== kindOf(t.mode)) {
      // CONFLICT (distinct types): a regular file moves aside (with the base, if it was a
      // file too), the other kind keeps the path; neither a file, both move
      const moveOurs = isRegular(o) || !isRegular(t);
      const moveTheirs = isRegular(t) || !isRegular(o);
      say(
        path,
        `CONFLICT (distinct types): ${path} had different types on each side; renamed ${moveOurs && moveTheirs ? "both" : "one"} of them so each can be recorded somewhere.`,
      );
      const baseGoes = b && isRegular(b) ? (isRegular(o) ? "ours" : "theirs") : "path";
      const oursPath = moveOurs ? uniquePath(path, oursName) : path;
      const theirsPath = moveTheirs ? uniquePath(path, theirsName) : path;
      const withBase = (side: "ours" | "theirs") => (baseGoes === side ? { base: b } : {});
      if (baseGoes === "path" && b && oursPath !== path && theirsPath !== path) {
        conflicts.set(path, { base: b, stagePath: path, mode: b.mode });
      }
      conflicts.set(oursPath, {
        ...withBase("ours"),
        ...(baseGoes === "path" && oursPath === path ? { base: b } : {}),
        ours: o,
        stagePath: oursPath,
        mode: o.mode,
        tree: o,
        ...(oursPath !== path ? { moveFrom: path, write: o } : {}),
      });
      conflicts.set(theirsPath, {
        ...withBase("theirs"),
        ...(baseGoes === "path" && theirsPath === path ? { base: b } : {}),
        theirs: t,
        stagePath: theirsPath,
        mode: t.mode,
        write: t,
        tree: t,
      });
      continue;
    }
    // the merged mode: the side that changed it; both changed (an add/add) is a conflict
    let mode = o.mode;
    if (o.mode === t.mode || (b && o.mode === b.mode)) mode = t.mode;
    if (isRegular(o) && isRegular(t)) {
      const merged = await mergeContents(path, b, o, t, origin.get(path));
      if (merged.clean) {
        result.set(path, { objectId: merged.objectId, mode: merged.mode });
        continue;
      }
      say(path, `CONFLICT (${b ? "content" : "add/add"}): Merge conflict in ${path}`);
      conflicts.set(path, {
        base: b,
        ours: o,
        theirs: t,
        stagePath: path,
        mode: merged.mode,
        ...(merged.content ? { content: merged.content } : {}),
        tree: { objectId: merged.objectId, mode: merged.mode },
      });
      continue;
    }
    // a link or submodule changed on both sides: ours stays, all three staged
    say(
      path,
      `CONFLICT (${o.mode === FileMode.GITLINK ? "submodule" : b ? "content" : "add/add"}): Merge conflict in ${path}`,
    );
    conflicts.set(path, { base: b, ours: o, theirs: t, stagePath: path, mode, tree: o });
  }

  // a path cannot be a file and a directory at once (CONFLICT (file/directory)): the
  // directory keeps the name, the file (a merged one, or the side a conflict keeps) moves
  // aside to `<path>~<side>`
  const outcomeDirs = dirsOf([
    ...result.keys(),
    ...[...conflicts.values()].filter((c) => c.tree).map((c) => c.stagePath),
  ]);
  // the directories of their tree as it is (not as renames carried our changes into it)
  const theirsDirs = dirsOf(theirsIn.keys());
  const files = [
    ...result.keys(),
    ...[...conflicts.entries()]
      .filter(([key, c]) => (c.ours || c.theirs) && c.stagePath === key)
      .map(([p]) => p),
  ].sort();
  for (const path of files) {
    if (!outcomeDirs.has(path)) continue;
    // the side whose tree has the directory keeps it; the file is the other side's
    const oursFile = theirsDirs.has(path);
    const label = oursFile ? oursName : theirsName;
    const moveFrom = oursFile && ours.has(path) ? { moveFrom: path } : {};
    const newPath = uniquePath(path, label);
    // merge-ort files the message under the path the file moves to
    say(
      newPath,
      `CONFLICT (file/directory): directory in the way of ${path} from ${oursFile ? oursLabel : theirsLabel}; moving it to ${newPath} instead.`,
    );
    const merged = result.get(path);
    if (merged) {
      result.delete(path);
      conflicts.set(path, {
        ...(oursFile ? { ours: merged } : { theirs: merged }),
        stagePath: newPath,
        mode: merged.mode,
        write: merged,
        tree: merged,
        ...moveFrom,
      });
      continue;
    }
    const conflict = conflicts.get(path) as OrtConflict;
    const kept = oursFile ? conflict.ours : conflict.theirs;
    conflicts.set(path, {
      ...conflict,
      stagePath: newPath,
      ...(kept && !conflict.content ? { write: kept } : {}),
      ...moveFrom,
    });
  }
  const messages = notes
    .sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : x.order - y.order))
    .map((n) => n.text);
  return { result, conflicts, messages };
}

/**
 * merge-ort's result tree as a flat map: the merged entries, and at each conflict's path
 * what git's result tree holds there (the file with markers, the surviving side, ours).
 */
export async function ortResultEntries(
  blobs: Blobs,
  merge: OrtMergeResult,
): Promise<Map<string, CheckedEntry>> {
  const out = new Map(merge.result);
  for (const conflict of merge.conflicts.values()) {
    if (conflict.content) {
      out.set(conflict.stagePath, {
        objectId: await blobs.store([conflict.content]),
        mode: conflict.mode,
      });
    } else if (conflict.tree) {
      out.set(conflict.stagePath, conflict.tree);
    }
  }
  return out;
}
