/**
 * Replace refs and grafts, as git applies them when it reads commits for a history walk
 * (`git log`, `rev-list`, `merge-base`, revision parents such as `HEAD~2`).
 *
 * @example
 * ```typescript
 * const commits = createReplacedCommits(history.commits, () =>
 *   loadObjectReplacements({ refs: history.refs }),
 * );
 * await commits.load(id); // the replacement's content when refs/replace/<id> exists
 * await commits.getParents(id); // the grafted parents when info/grafts names id
 * ```
 *
 * A ref `refs/replace/<id>` (git's `replace_map`, under `GIT_REPLACE_REF_BASE`) makes every
 * read of object `<id>` read the object the ref names instead, followed through up to five
 * replacements (git dies past that: "replace depth too high"). The object keeps its own id:
 * `git log` shows commit `<id>` with the replacement's message, tree and parents. Replace
 * refs are off with `core.useReplaceRefs=false`, `GIT_NO_REPLACE_OBJECTS` or
 * `--no-replace-objects` (`useReplaceRefs: false`).
 *
 * A line `<commit> <parent>...` of `info/grafts` (git's commit grafts, deprecated) gives that
 * commit those parents instead of the ones it records, whatever its content (a replaced
 * commit's grafts are those of its own id). The first line for a commit wins; a malformed
 * line is reported (`bad graft data: <line>`) and skipped.
 *
 * Reads that must see the objects as stored (fsck's object checks, gc's reachability, the
 * packs a fetch or push sends) use the store itself, as git disables replacements there.
 *
 * @module
 */

import type { ObjectId } from "../../common/id/index.js";
import type { Refs } from "../refs/refs.js";
import { getMergeBases, isAncestorOf, type ReachSource } from "./commit-reach.js";
import type {
  AncestryOptions,
  Commit,
  CommitHeader,
  CommitHeaderReader,
  Commits,
} from "./commits.js";

/** git's MAXREPLACEDEPTH */
const MAX_REPLACE_DEPTH = 5;

const OID_PREFIX = /^[0-9a-fA-F]{40}/;
const OID = /^[0-9a-f]{40}$/;

/** The replacements a history walk reads commits through. */
export interface ObjectReplacements {
  /** Each replaced object's replacement (`refs/replace/<id>` → its value) */
  replace: ReadonlyMap<ObjectId, ObjectId>;
  /** Each grafted commit's parents (`info/grafts`) */
  grafts: ReadonlyMap<ObjectId, readonly ObjectId[]>;
}

/** What {@link loadObjectReplacements} found, and what git prints while reading it. */
export interface LoadedObjectReplacements extends ObjectReplacements {
  /** Whether a grafts file exists (git then advises it is deprecated) */
  graftFile: boolean;
  /** The errors and warnings git prints: `bad graft data: <line>`, `bad replace ref name: <x>` */
  messages: string[];
}

/** The commit grafts of an `info/grafts` text, and the errors git prints for its lines. */
export function parseGraftFile(text: string): {
  grafts: Map<ObjectId, ObjectId[]>;
  messages: string[];
} {
  const grafts = new Map<ObjectId, ObjectId[]>();
  const messages: string[] = [];
  for (const raw of text.split("\n")) {
    // read_graft_line: right-trimmed, blank and comment lines skipped
    const line = raw.replace(/\s+$/, "");
    if (line === "" || line.startsWith("#")) continue;
    const ids: ObjectId[] = [];
    let rest = line;
    let ok = OID_PREFIX.test(rest);
    while (ok) {
      ids.push(rest.slice(0, 40).toLowerCase());
      rest = rest.slice(40);
      if (rest === "") break;
      // one whitespace character, then the next id
      ok = /^\s/.test(rest) && OID_PREFIX.test(rest.slice(1));
      rest = rest.slice(1);
    }
    if (!ok) {
      messages.push(`error: bad graft data: ${line}`);
      continue;
    }
    const [commit, ...parents] = ids as [ObjectId, ...ObjectId[]];
    if (grafts.has(commit)) {
      messages.push(`error: duplicate graft data: ${line}`);
      continue;
    }
    grafts.set(commit, parents);
  }
  return { grafts, messages };
}

/** Options of {@link loadObjectReplacements}. */
export interface LoadObjectReplacementsOptions {
  /** The refs: `refs/replace/*` and the grafts file (`readGrafts`) */
  refs: Pick<Refs, "list" | "resolve"> & Partial<Pick<Refs, "readGrafts">>;
  /**
   * Whether replace refs apply (default true; false for `core.useReplaceRefs=false`,
   * `GIT_NO_REPLACE_OBJECTS`, `--no-replace-objects`)
   */
  useReplaceRefs?: boolean;
  /** Where replace refs live (`GIT_REPLACE_REF_BASE`; default `refs/replace/`) */
  replaceRefBase?: string;
}

/**
 * The replace refs and grafts of a repository, as git's prepare_replace_object and
 * prepare_commit_graft read them.
 */
export async function loadObjectReplacements(
  options: LoadObjectReplacementsOptions,
): Promise<LoadedObjectReplacements> {
  const replace = new Map<ObjectId, ObjectId>();
  const messages: string[] = [];
  if (options.useReplaceRefs ?? true) {
    let base = options.replaceRefBase ?? "refs/replace/";
    if (!base.endsWith("/")) base += "/";
    for await (const entry of options.refs.list(base)) {
      const name = entry.name.slice(base.length);
      if (!OID_PREFIX.test(name)) {
        messages.push(`warning: bad replace ref name: ${name}`);
        continue;
      }
      const value =
        "objectId" in entry && entry.objectId
          ? entry.objectId
          : (await options.refs.resolve(entry.name))?.objectId;
      if (value) replace.set(name.slice(0, 40).toLowerCase(), value);
    }
  }
  const text = options.refs.readGrafts ? await options.refs.readGrafts() : undefined;
  const parsed = text === undefined ? { grafts: new Map(), messages: [] } : parseGraftFile(text);
  messages.push(...parsed.messages);
  return { replace, grafts: parsed.grafts, graftFile: text !== undefined, messages };
}

/** Thrown past five replacements of one object (git's "replace depth too high"). */
export class ReplaceDepthError extends Error {
  constructor(readonly objectId: ObjectId) {
    super(`replace depth too high for object ${objectId}`);
    this.name = "ReplaceDepthError";
  }
}

/** The object read for `id`: its replacement, followed (git's lookup_replace_object). */
export function replacementOf(replace: ReadonlyMap<ObjectId, ObjectId>, id: ObjectId): ObjectId {
  if (replace.size === 0) return id;
  let current = id;
  for (let depth = 0; depth < MAX_REPLACE_DEPTH; depth++) {
    const next = replace.get(current);
    if (next === undefined) return current;
    current = next;
  }
  throw new ReplaceDepthError(id);
}

/** Whether there is anything to replace or graft. */
export function hasReplacements(r: ObjectReplacements | undefined): r is ObjectReplacements {
  return !!r && (r.replace.size > 0 || r.grafts.size > 0);
}

/**
 * `commits` as history walks read them: through the replacements `load` gives (read once,
 * on first use). Without any, every call goes to `commits` (its commit-graph included); with
 * some, commits are read from the object store (git does not use a commit-graph then), each
 * by its replacement, with its grafted parents. Writes go to `commits` unchanged.
 */
export function createReplacedCommits(
  commits: Commits,
  load: () => Promise<ObjectReplacements | undefined>,
): Commits {
  let loading: Promise<ObjectReplacements | undefined> | undefined;
  const active = async (): Promise<ObjectReplacements | undefined> => {
    loading ??= load().catch(() => undefined);
    const r = await loading;
    return hasReplacements(r) ? r : undefined;
  };
  const loadWith = async (r: ObjectReplacements, id: ObjectId): Promise<Commit | undefined> => {
    const commit = await commits.load(replacementOf(r.replace, id));
    if (!commit) return undefined;
    const grafted = r.grafts.get(id);
    return grafted ? { ...commit, parents: [...grafted] } : commit;
  };
  const header = async (r: ObjectReplacements, id: ObjectId): Promise<CommitHeader | undefined> => {
    const c = await loadWith(r, id);
    if (!c) return undefined;
    return {
      tree: c.tree,
      parents: c.parents,
      commitTime: c.committer.timestamp,
      generation: Number.POSITIVE_INFINITY,
    };
  };
  const reach =
    (r: ObjectReplacements): ReachSource =>
    async (id) => {
      const c = await loadWith(r, id);
      return c
        ? { parents: c.parents, date: c.committer.timestamp, generation: Number.POSITIVE_INFINITY }
        : undefined;
    };
  const replaced: Commits = {
    get commitGraph() {
      return commits.commitGraph;
    },
    store: (commit) => commits.store(commit),
    remove: (id) => commits.remove(id),
    keys: () => commits.keys(),
    has: (id) => commits.has(id),
    async load(id) {
      const r = await active();
      return r ? loadWith(r, id) : commits.load(id);
    },
    async getParents(id) {
      const r = await active();
      if (!r) return commits.getParents(id);
      return (await loadWith(r, id))?.parents ?? [];
    },
    async getTree(id) {
      const r = await active();
      if (!r) return commits.getTree(id);
      return (await loadWith(r, id))?.tree;
    },
    async getHeader(id, options) {
      const r = await active();
      if (r) return header(r, id);
      if (commits.getHeader) return commits.getHeader(id, options);
      const c = await commits.load(id);
      return c
        ? {
            tree: c.tree,
            parents: c.parents,
            commitTime: c.committer.timestamp,
            generation: Number.POSITIVE_INFINITY,
          }
        : undefined;
    },
    async headerReader(): Promise<CommitHeaderReader> {
      const r = await active();
      if (!r && commits.headerReader) return commits.headerReader();
      return {
        getHeader: (id, options) => (replaced.getHeader as Commits["getHeader"] & {})(id, options),
        correctedDates: false,
      };
    },
    async *walkAncestry(startIds: ObjectId | ObjectId[], options: AncestryOptions = {}) {
      const r = await active();
      if (!r) {
        yield* commits.walkAncestry(startIds, options);
        return;
      }
      const stack = [...(Array.isArray(startIds) ? startIds : [startIds])];
      const visited = new Set<ObjectId>();
      const stopAt = new Set(options.stopAt ?? []);
      let count = 0;
      while (stack.length > 0) {
        if (options.limit !== undefined && count >= options.limit) break;
        const id = stack.pop() as ObjectId;
        if (visited.has(id) || stopAt.has(id)) continue;
        visited.add(id);
        yield id;
        count++;
        const parents = (await loadWith(r, id))?.parents ?? [];
        if (options.firstParentOnly && parents.length > 0) stack.push(parents[0] as ObjectId);
        else for (let i = parents.length - 1; i >= 0; i--) stack.push(parents[i] as ObjectId);
      }
    },
    async findMergeBase(a, b) {
      const r = await active();
      if (!r) return commits.findMergeBase(a, b);
      return getMergeBases(reach(r), a, [b], { correctedDates: false });
    },
    async isAncestor(ancestor, descendant) {
      const r = await active();
      if (!r) return commits.isAncestor(ancestor, descendant);
      return isAncestorOf(reach(r), ancestor, descendant);
    },
  };
  return replaced;
}

/** Whether `name` names a replace ref's object (`refs/replace/<40 hex>`). */
export function isReplaceRefName(name: string, base = "refs/replace/"): boolean {
  return name.startsWith(base) && OID.test(name.slice(base.length));
}
