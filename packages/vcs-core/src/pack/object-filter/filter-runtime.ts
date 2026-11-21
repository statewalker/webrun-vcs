/**
 * The filters of list-objects-filter.c, as the revision walk asks them: for each object the
 * traversal meets (a commit, a tag, the start and end of a tree, a blob) a filter answers
 * with git's `LOFR_*` bits, whether to show the object, to mark it seen (never asked again)
 * and, for a tree, to skip its contents.
 *
 * ```typescript
 * const run = startObjectFilter(resolved, { objectSize: (id) => sizeOf(id) });
 * const r = await run.filter("blob", id, true, "dir/a.txt", "a.txt");
 * if (r & LOFR_DO_SHOW) list(id);
 * ```
 *
 * The answers depend on the order of the questions as git's do: `tree:<depth>` re-walks a tree
 * met again nearer the root, `sparse:oid` provisionally omits a blob another path may still
 * include, and each filter of a `combine:` keeps its own seen set, so a tree one of them saw
 * first under a deeper path stays unshown. Objects the user gave (wants, and what their tags
 * peel to) are shown whatever the filter says (git's `NOT_USER_GIVEN`).
 */
import type { ObjectId } from "../../common/id/index.js";
import type { ObjectTypeString } from "../../history/objects/object-types.js";
import type { ObjectFilter } from "./object-filter.js";

/** Mark the object seen: the traversal does not ask about it again. */
export const LOFR_MARK_SEEN = 1;
/** Show (list) the object. */
export const LOFR_DO_SHOW = 2;
/** Do not walk the tree's contents. */
export const LOFR_SKIP_TREE = 4;

/** Where the traversal is (git's `list_objects_filter_situation`). */
export type FilterSituation = "commit" | "tag" | "begin-tree" | "end-tree" | "blob";

/**
 * git's `path_matches_pattern_list` over a `sparse:oid` blob's patterns (non-cone,
 * gitignore-style): true when the last matching pattern includes the path, false when it is
 * negated, undefined when none matches. `pathname` has no leading or trailing slash ("" for a
 * root tree); `basename` is its last component.
 */
export type SparseFilterMatcher = (
  pathname: string,
  basename: string,
  isDirectory: boolean,
) => boolean | undefined;

/** A filter whose `sparse:oid` blobs were read into matchers. */
export type ResolvedObjectFilter =
  | Exclude<ObjectFilter, { choice: "sparse:oid" } | { choice: "combine" }>
  | { choice: "sparse:oid"; name: string; matcher: SparseFilterMatcher }
  | { choice: "combine"; filters: ResolvedObjectFilter[] };

/**
 * Reads the patterns of each `sparse:oid` filter (`loadSparse` resolves the blob-ish name and
 * parses its blob; it throws git's `unable to access sparse blob in '<name>'` or `unable to
 * parse sparse filter data in <id>`).
 */
export async function resolveObjectFilter(
  filter: ObjectFilter,
  loadSparse: (name: string) => Promise<SparseFilterMatcher>,
): Promise<ResolvedObjectFilter> {
  if (filter.choice === "sparse:oid") {
    return { ...filter, matcher: await loadSparse(filter.name) };
  }
  if (filter.choice === "combine") {
    const filters: ResolvedObjectFilter[] = [];
    for (const f of filter.filters) filters.push(await resolveObjectFilter(f, loadSparse));
    return { choice: "combine", filters };
  }
  return filter;
}

/** What a running filter needs from the store. */
export interface ObjectFilterEnvironment {
  /** A blob's size, undefined when the store does not have it (`blob:limit` then shows it) */
  objectSize(id: ObjectId): Promise<number | undefined>;
}

/** A filter running over one traversal. */
export interface ObjectFilterRun {
  /**
   * git's `list_objects_filter__filter_object`: the filter's answer for an object the
   * traversal did not get from the user (`notUserGiven`), else "show and mark seen" (nothing
   * at the end of a tree).
   */
  filter(
    situation: FilterSituation,
    id: ObjectId,
    notUserGiven: boolean,
    pathname: string,
    filename: string,
  ): number | Promise<number>;
}

type FilterFn = (
  situation: FilterSituation,
  id: ObjectId,
  pathname: string,
  filename: string,
) => number | Promise<number>;

/** Starts `filter` for one traversal (git's `list_objects_filter__init` without omits). */
export function startObjectFilter(
  filter: ResolvedObjectFilter,
  env: ObjectFilterEnvironment,
): ObjectFilterRun {
  // git's FILTER_SHOWN_BUT_REVISIT: an object flag, shared by every filter of the traversal
  const revisit = new Set<ObjectId>();
  const fn = filterFn(filter, env, revisit);
  return {
    filter(situation, id, notUserGiven, pathname, filename) {
      if (notUserGiven) return fn(situation, id, pathname, filename);
      return situation === "end-tree" ? 0 : LOFR_MARK_SEEN | LOFR_DO_SHOW;
    },
  };
}

const SHOW_SEEN = LOFR_MARK_SEEN | LOFR_DO_SHOW;

function filterFn(
  filter: ResolvedObjectFilter,
  env: ObjectFilterEnvironment,
  revisit: Set<ObjectId>,
): FilterFn {
  switch (filter.choice) {
    case "blob:none":
      return (s) => (s === "blob" ? LOFR_MARK_SEEN : s === "end-tree" ? 0 : SHOW_SEEN);
    case "blob:limit": {
      const limit = filter.limit;
      return (s, id) => {
        if (s !== "blob") return s === "end-tree" ? 0 : SHOW_SEEN;
        return env.objectSize(id).then((size) =>
          // a blob the store does not have is shown (the caller deals with it)
          size === undefined || size < limit ? SHOW_SEEN : LOFR_MARK_SEEN,
        );
      };
    }
    case "tree":
      return treeDepthFilter(filter.depth);
    case "sparse:oid":
      return sparseFilter(filter.matcher, revisit);
    case "object:type":
      return objectTypeFilter(filter.type);
    case "combine":
      return combineFilter(filter.filters.map((f) => filterFn(f, env, revisit)));
  }
}

/** git's filter_trees_depth (no omits collected). */
function treeDepthFilter(excludeDepth: number): FilterFn {
  const seenAtDepth = new Map<ObjectId, number>();
  let current = 0;
  return (s, id) => {
    const include = current < excludeDepth;
    switch (s) {
      case "tag":
      case "commit":
        return SHOW_SEEN;
      case "end-tree":
        current--;
        return 0;
      case "blob":
        return include ? SHOW_SEEN : 0;
      case "begin-tree": {
        const seen = seenAtDepth.get(id);
        const already = seen !== undefined && current >= seen;
        let result: number;
        if (already) result = LOFR_SKIP_TREE;
        else {
          seenAtDepth.set(id, current);
          result = include ? LOFR_DO_SHOW : LOFR_SKIP_TREE;
        }
        current++;
        return result;
      }
    }
  };
}

/** git's filter_sparse: patterns matched per path, inherited by a directory's contents. */
function sparseFilter(matcher: SparseFilterMatcher, revisit: Set<ObjectId>): FilterFn {
  // the root frame defaults to NOT_MATCHED
  const frames: { match: boolean; childProvOmit: boolean }[] = [
    { match: false, childProvOmit: false },
  ];
  const top = () => frames[frames.length - 1] as { match: boolean; childProvOmit: boolean };
  return (s, id, pathname, filename) => {
    switch (s) {
      case "tag":
      case "commit":
        return SHOW_SEEN;
      case "begin-tree": {
        const match = matcher(pathname, filename, true) ?? top().match;
        frames.push({ match, childProvOmit: false });
        // shown the first time only, but never marked seen: other paths may match otherwise
        if (revisit.has(id)) return 0;
        revisit.add(id);
        return LOFR_DO_SHOW;
      }
      case "end-tree": {
        const frame = frames.pop() as { match: boolean; childProvOmit: boolean };
        if (frame.childProvOmit) top().childProvOmit = true;
        return frame.childProvOmit ? 0 : LOFR_MARK_SEEN;
      }
      case "blob": {
        const frame = top();
        const match = matcher(pathname, filename, false) ?? frame.match;
        if (match) return SHOW_SEEN;
        // provisionally omitted: asked again if another path names it
        frame.childProvOmit = true;
        return 0;
      }
    }
  };
}

/** git's filter_object_type. */
function objectTypeFilter(type: ObjectTypeString): FilterFn {
  return (s) => {
    switch (s) {
      case "tag":
        return type === "tag" ? SHOW_SEEN : LOFR_MARK_SEEN;
      case "commit":
        return type === "commit" ? SHOW_SEEN : LOFR_MARK_SEEN;
      case "begin-tree":
        // only commits or tags wanted: no need to walk down trees
        if (type === "commit" || type === "tag") return LOFR_SKIP_TREE;
        return type === "tree" ? SHOW_SEEN : LOFR_MARK_SEEN;
      case "blob":
        return type === "blob" ? SHOW_SEEN : LOFR_MARK_SEEN;
      case "end-tree":
        return 0;
    }
  };
}

/** git's filter_combine: shown only when every filter shows, each with its own seen set. */
function combineFilter(subs: FilterFn[]): FilterFn {
  const state = subs.map((fn) => ({
    fn,
    seen: new Set<ObjectId>(),
    skipping: false,
    skipTree: "",
  }));
  return async (s, id, pathname, filename) => {
    let combined = LOFR_DO_SHOW | LOFR_MARK_SEEN | LOFR_SKIP_TREE;
    for (const sub of state) {
      let r = 0;
      // git's process_subfilter
      let skip = false;
      if (sub.skipping) {
        if (s === "end-tree" && id === sub.skipTree) sub.skipping = false;
        else skip = true;
      }
      if (!skip && !sub.seen.has(id)) {
        r = await sub.fn(s, id, pathname, filename);
        if (r & LOFR_MARK_SEEN) sub.seen.add(id);
        if (r & LOFR_SKIP_TREE) {
          sub.skipping = true;
          sub.skipTree = id;
        }
      }
      if (!(r & LOFR_DO_SHOW)) combined &= ~LOFR_DO_SHOW;
      if (!(r & LOFR_MARK_SEEN)) combined &= ~LOFR_MARK_SEEN;
      if (!sub.skipping) combined &= ~LOFR_SKIP_TREE;
    }
    return combined;
  };
}
