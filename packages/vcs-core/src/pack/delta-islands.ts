/**
 * Delta islands, as git's delta-islands.c: `pack.island` regexes name islands after the refs
 * they match, each object is marked with the islands whose refs reach it, and a delta is
 * allowed only onto a base that is in every island its target is in (`in_same_island`).
 * `pack.islandCore` names the island whose objects are written first.
 */

import { compilePosixRegex, PosixRegexError } from "@statewalker/vcs-utils";
import type { ObjectId } from "../common/id/index.js";
import type { GitObjects } from "../history/objects/git-objects.js";
import { decodeTreeBytes } from "../history/trees/tree-format.js";
import { type ListedObject, parseCommitHeader, parseTagTarget } from "./list-objects.js";
import type { DeltaIslandRules } from "./write-pack.js";

/** What {@link computeDeltaIslands} reads. */
export interface DeltaIslandOptions {
  /** The `pack.island` values, in config order (the last matching one wins). */
  patterns: readonly string[];
  /** `pack.islandCore`: the island whose objects go first in the pack. */
  core?: string;
  /** Every ref (`refs_for_each_ref`: names under `refs/`), with the object it names. */
  refs: Iterable<{ name: string; id: ObjectId }>;
  /** Where commits, trees and tags are read. */
  objects: Pick<GitObjects, "get">;
  /** The objects being packed (git's `to_pack`): marks propagate through their trees. */
  listed: readonly ListedObject[];
  /**
   * The commits the traversal showed (pack-objects' `show_commit` propagates through each,
   * those a `.keep` pack holds included); default the listed commits.
   */
  walkedCommits?: readonly ObjectId[];
  /** Raw id length of the repository's format (20, or 32 for SHA-256). */
  idLength?: number;
  /** git's warnings (a regex with too many capture groups). */
  warn?: (line: string) => void;
}

/** A `pack.island` value git cannot compile: git dies with this message. */
export class DeltaIslandRegexError extends Error {
  override name = "DeltaIslandRegexError";
}

const MAX_MATCHES = 16;
const enc = new TextEncoder();

/**
 * Builds the island rules of a pack (git's `load_delta_islands`, `propagate_island_marks` over
 * the commits in topological order, children first, then `resolve_tree_islands` over the trees
 * by depth). Objects no island reaches have no marks: as targets they may delta onto anything,
 * as bases only for unmarked targets.
 *
 * @example
 * ```typescript
 * const islands = await computeDeltaIslands({ patterns: ["refs/heads/(.*)"], refs, objects, listed });
 * writePack(objects, listed, { packs, deltaSearch: true, islands });
 * ```
 */
export async function computeDeltaIslands(o: DeltaIslandOptions): Promise<DeltaIslandRules> {
  const regexes = o.patterns.map((value) => {
    const re = value.startsWith("^") ? value : `^${value}`;
    try {
      return compilePosixRegex(re, { extended: true });
    } catch (e) {
      if (e instanceof PosixRegexError)
        throw new DeltaIslandRegexError(
          `fatal: failed to load island regex for 'pack.island': ${re}`,
        );
      throw e;
    }
  });

  // find_island_for_ref: the last regex matching a ref names its island after its groups
  const islands = new Map<string, ObjectId[]>();
  if (regexes.length > 0) {
    for (const ref of o.refs) {
      const name = enc.encode(ref.name);
      let match: ReturnType<(typeof regexes)[number]["exec"]>;
      for (let i = regexes.length - 1; i >= 0; i--) {
        match = (regexes[i] as (typeof regexes)[number]).exec(name, name.length, MAX_MATCHES);
        if (match) break;
      }
      if (!match) continue;
      if (match.groups[MAX_MATCHES - 2] !== undefined)
        o.warn?.(
          `warning: island regex from config has too many capture groups (max=${MAX_MATCHES - 2})`,
        );
      const parts: string[] = [];
      for (const g of match.groups.slice(0, MAX_MATCHES - 1))
        if (g) parts.push(ref.name.slice(g[0], g[1]));
      const island = parts.join("-");
      const ids = islands.get(island);
      if (ids) ids.push(ref.id);
      else islands.set(island, [ref.id]);
    }
  }

  const marks = new Map<ObjectId, bigint>();
  const or = (id: ObjectId, bits: bigint) => marks.set(id, (marks.get(id) ?? 0n) | bits);
  const read = async (id: ObjectId) => {
    const obj = await o.objects.get(id);
    if (!obj) return undefined;
    const chunks: Uint8Array[] = [];
    let length = 0;
    for await (const c of obj.content) {
      chunks.push(c);
      length += c.length;
    }
    const data = new Uint8Array(length);
    let at = 0;
    for (const c of chunks) {
      data.set(c, at);
      at += c.length;
    }
    return { type: obj.type, data };
  };

  // mark_remote_island_1: each island's refs, tags peeled, get its bit
  let bit = 0n;
  let coreBit = 0n;
  for (const [name, ids] of islands) {
    const mask = 1n << bit;
    if (o.core !== undefined && name === o.core) coreBit = bit;
    for (const id of ids) {
      let at: ObjectId | undefined = id;
      let obj = await read(at);
      if (!obj) continue;
      or(at, mask);
      while (obj?.type === "tag") {
        at = parseTagTarget(at, obj.data);
        obj = await read(at);
        or(at, mask);
      }
    }
    bit++;
  }

  if (marks.size > 0) {
    // propagate_island_marks, from each walked commit (topologically, children first) to its
    // tree and parents
    const commits = o.walkedCommits ?? o.listed.filter((l) => l.type === "commit").map((l) => l.id);
    const info = new Map<ObjectId, { tree: ObjectId; parents: ObjectId[] }>();
    for (const id of commits) {
      const obj = await read(id);
      if (obj) info.set(id, parseCommitHeader(id, obj.data));
    }
    for (const id of topologicalOrder(commits, info)) {
      const m = marks.get(id);
      const c = info.get(id);
      if (m === undefined || !c) continue;
      or(c.tree, m);
      for (const p of c.parents) or(p, m);
    }
    // resolve_tree_islands: trees by depth, each passing its marks to its entries
    const trees = o.listed
      .filter((l) => l.type === "tree")
      .map((l, i) => ({ id: l.id, i, depth: depthOf(l.path) }))
      .sort((a, b) => a.depth - b.depth || a.i - b.i);
    for (const t of trees) {
      const m = marks.get(t.id);
      if (m === undefined) continue;
      const obj = await read(t.id);
      if (!obj) continue;
      for (const e of decodeTreeBytes(obj.data, { idLength: o.idLength ?? 20 })) {
        if (e.mode === 0o160000) continue;
        or(e.id, m);
      }
    }
  }

  const subset = (a: bigint, b: bigint) => (a & b) === a;
  const coreMask = 1n << coreBit;
  return {
    sameIsland(target, base) {
      const t = marks.get(target);
      if (t === undefined) return true;
      const b = marks.get(base);
      if (b === undefined) return false;
      return subset(t, b);
    },
    compare(a, b) {
      const am = marks.get(a);
      const bm = marks.get(b);
      if (am !== undefined && (bm === undefined || !subset(am, bm))) return -1;
      if (bm !== undefined && (am === undefined || !subset(bm, am))) return 1;
      return 0;
    },
    // compute_pack_layers: only with pack.islandCore (an unmatched name is bit 0, as git's
    // island_counter_core keeps its initial value)
    ...(o.core !== undefined
      ? {
          layer(id: ObjectId) {
            const m = marks.get(id);
            return m !== undefined && (m & coreMask) !== 0n ? 0 : 1;
          },
        }
      : {}),
  };
}

/** A tree's depth below its root tree ("" is 0). */
function depthOf(path: string | undefined): number {
  if (!path) return 0;
  let d = 1;
  for (let i = 0; i < path.length; i++) if (path.charCodeAt(i) === 47) d++;
  return d;
}

/** The commits with every child before its parents (git's `--topo-order`), else listing order. */
function topologicalOrder(
  commits: readonly ObjectId[],
  info: Map<ObjectId, { parents: ObjectId[] }>,
): ObjectId[] {
  const children = new Map<ObjectId, number>();
  for (const id of commits)
    for (const p of info.get(id)?.parents ?? [])
      if (info.has(p)) children.set(p, (children.get(p) ?? 0) + 1);
  const out: ObjectId[] = [];
  const ready = commits.filter((id) => !children.get(id));
  // a stack keeps one line of history together, as git's topo walk does
  ready.reverse();
  while (ready.length) {
    const id = ready.pop() as ObjectId;
    out.push(id);
    const parents = info.get(id)?.parents ?? [];
    for (let i = parents.length - 1; i >= 0; i--) {
      const p = parents[i] as ObjectId;
      if (!info.has(p)) continue;
      const left = (children.get(p) ?? 0) - 1;
      children.set(p, left);
      if (left === 0) ready.push(p);
    }
  }
  return out;
}
