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
 * Reads that must see the objects as stored (fsck's object checks, the packs a fetch or push
 * sends, the commit-graph) use the store itself, as git disables replace refs there. gc is
 * not one of those reads: replace refs are refs, so each replacement is a root, and the
 * replaced object stays reachable through whatever names it; grafts are not disabled in gc
 * either, and its walk keeps both a grafted commit's recorded and grafted parents (see
 * {@link readGraftParents}).
 *
 * @module
 */

import type { ObjectId } from "../../common/id/index.js";
import type { Blobs } from "../blobs/blobs.js";
import type { Refs } from "../refs/refs.js";
import type { Tags } from "../tags/tags.js";
import type { Trees } from "../trees/trees.js";
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
  /** Those of {@link messages} git prints while reading the replace refs (first) */
  replaceMessages: string[];
  /** Those of {@link messages} git prints while reading the grafts file (after its advice) */
  graftMessages: string[];
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
    // git's isspace: ASCII space, tab, LF and CR only (a no-break space is data)
    const line = raw.replace(/[ \t\n\r]+$/, "");
    if (line === "" || line.startsWith("#")) continue;
    const ids: ObjectId[] = [];
    let rest = line;
    let ok = OID_PREFIX.test(rest);
    while (ok) {
      ids.push(rest.slice(0, 40).toLowerCase());
      rest = rest.slice(40);
      if (rest === "") break;
      // one whitespace character, then the next id
      ok = /^[ \t\n\r]/.test(rest) && OID_PREFIX.test(rest.slice(1));
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

/**
 * The grafted parents of each commit in the repository's grafts file (none when there is no
 * file or the store has none), for reachability walks: gc keeps the objects a grafted commit
 * reaches through its grafted parents as well as through the ones it records, as git's repack
 * (`--keep-true-parents`) and prune together do. `readGraftFile` reads the grafts file in
 * place of `info/grafts` (git's `GIT_GRAFT_FILE`, see {@link graftFileReader}). A shallow
 * commit's graft is overridden by the shallow file (git's register_shallow): the walks give
 * it no parents at all.
 *
 * @example
 * ```typescript
 * const grafts = await readGraftParents(history.refs, graftFileReader(environment));
 * ```
 */
export async function readGraftParents(
  refs: Partial<Pick<Refs, "readGrafts">>,
  readGraftFile?: () => Promise<string | undefined>,
): Promise<Map<ObjectId, ObjectId[]>> {
  const text = readGraftFile
    ? await readGraftFile()
    : refs.readGrafts
      ? await refs.readGrafts()
      : undefined;
  return text === undefined ? new Map() : parseGraftFile(text).grafts;
}

/**
 * Where a relative `GIT_GRAFT_FILE` is read from: git opens it after its setup has changed
 * to the top of the worktree (to the git directory in a bare repository), so a relative
 * path names a file there, not in the process's current directory. `dir` is that directory:
 * a path in `files` when given (the repository's FilesApi), else a host path read through
 * the environment. See {@link graftFileBaseDir}.
 */
export interface GraftFileBase {
  /** The worktree top (the git directory when bare), in `files` or on the host */
  dir: string;
  /** The FilesApi `dir` is in; absent: `dir` is a host path */
  files?: { read(path: string): AsyncIterable<Uint8Array> } & {
    stats(path: string): Promise<{ kind: string } | undefined | null>;
  };
}

/**
 * The directory a relative `GIT_GRAFT_FILE` is read from for the git directory `gitDir`: the
 * worktree top (the directory holding `.git`), or `gitDir` itself in a bare repository
 * (`bare`; by default a git directory not named `.git` is taken as bare).
 *
 * @example
 * ```typescript
 * graftFileBaseDir(".git"); // ""
 * graftFileBaseDir("/srv/repo.git"); // "/srv/repo.git"
 * ```
 */
export function graftFileBaseDir(gitDir: string, bare?: boolean): string {
  const trimmed = gitDir.replace(/\/+$/, "");
  const at = trimmed.lastIndexOf("/");
  const name = trimmed.slice(at + 1);
  if (bare ?? name !== ".git") return trimmed;
  return at < 0 ? "" : at === 0 ? "/" : trimmed.slice(0, at);
}

/** `relative` resolved against `dir` (`..` taken out); undefined when it climbs above a root. */
function resolveBelow(dir: string, relative: string): string | undefined {
  const absolute = dir.startsWith("/");
  const parts: string[] = [];
  for (const part of `${dir}/${relative}`.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return undefined;
      parts.pop();
    } else parts.push(part);
  }
  return `${absolute ? "/" : ""}${parts.join("/")}`;
}

/**
 * The reader of the grafts file an environment names (git's `GIT_GRAFT_FILE`), for
 * {@link readGraftParents} and `LoadObjectReplacementsOptions.readGraftFile`; undefined when
 * the environment names none (then `info/grafts` is read). Set but empty, there is no grafts
 * file; a file that cannot be read gives no grafts, as git warns and goes on. A relative path
 * is read from `base` (the worktree top, see {@link GraftFileBase}), as git reads it; without
 * a base, the environment reads it (from the process's current directory).
 *
 * @example
 * ```typescript
 * await gc({
 *   ...backend,
 *   readGraftFile: graftFileReader(environment, { files, dir: graftFileBaseDir(".git") }),
 * });
 * ```
 */
export function graftFileReader(
  environment:
    | { graftFile?: string; readFile(path: string): Promise<Uint8Array | undefined> }
    | undefined,
  base?: GraftFileBase,
): (() => Promise<string | undefined>) | undefined {
  const graftFile = environment?.graftFile;
  if (environment === undefined || graftFile === undefined) return undefined;
  const decode = (bytes: Uint8Array | undefined) =>
    bytes === undefined ? undefined : new TextDecoder().decode(bytes);
  return async () => {
    if (!graftFile) return undefined;
    const relative = !graftFile.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(graftFile);
    if (!relative || base === undefined) {
      return decode(await environment.readFile(graftFile).catch(() => undefined));
    }
    const path = resolveBelow(base.dir, graftFile);
    if (path === undefined) return undefined;
    const files = base.files;
    if (!files) return decode(await environment.readFile(path).catch(() => undefined));
    try {
      if ((await files.stats(path))?.kind !== "file") return undefined;
      const chunks: Uint8Array[] = [];
      for await (const chunk of files.read(path)) chunks.push(chunk);
      const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
      let at = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, at);
        at += chunk.length;
      }
      return decode(bytes);
    } catch {
      return undefined;
    }
  };
}

/** Options of {@link loadObjectReplacements}. */
export interface LoadObjectReplacementsOptions {
  /** The refs: `refs/replace/*`, the grafts file (`readGrafts`) and the shallow commits */
  refs: Pick<Refs, "list" | "resolve"> & Partial<Pick<Refs, "readGrafts" | "getShallow">>;
  /**
   * Whether replace refs apply (default true; false for `core.useReplaceRefs=false`,
   * `GIT_NO_REPLACE_OBJECTS`, `--no-replace-objects`)
   */
  useReplaceRefs?: boolean;
  /**
   * Where replace refs live (`GIT_REPLACE_REF_BASE`; default `refs/replace/`). Taken as git
   * takes it, a plain prefix: an empty base makes every ref a candidate replace ref.
   */
  replaceRefBase?: string;
  /**
   * The grafts file's text, read in place of the repository's `info/grafts` (git's
   * `GIT_GRAFT_FILE`); undefined when that file does not exist. Omit to read `info/grafts`.
   */
  readGraftFile?: () => Promise<string | undefined>;
}

/**
 * The replace refs and grafts of a repository, as git's prepare_replace_object and
 * prepare_commit_graft read them. A replace ref's object is the last component of its name
 * (`refs/replace/foo/<id>` replaces `<id>`); a name whose last component does not start with
 * an object id is skipped with git's warning. Shallow commits (`.git/shallow`) are grafts with
 * no parents that override `info/grafts`, as git's register_shallow does.
 */
export async function loadObjectReplacements(
  options: LoadObjectReplacementsOptions,
): Promise<LoadedObjectReplacements> {
  const replace = new Map<ObjectId, ObjectId>();
  const messages: string[] = [];
  if (options.useReplaceRefs ?? true) {
    const base = options.replaceRefBase ?? "refs/replace/";
    for await (const entry of options.refs.list(base)) {
      if (!entry.name.startsWith(base) || !entry.name.startsWith("refs/")) continue;
      // git's register_replace_ref: the name below the base, the hex after its last slash
      const trimmed = entry.name.slice(base.length);
      const name = trimmed.slice(trimmed.lastIndexOf("/") + 1);
      if (!OID_PREFIX.test(name)) {
        messages.push(`warning: bad replace ref name: ${trimmed}`);
        continue;
      }
      const original = name.slice(0, 40).toLowerCase();
      const value =
        "objectId" in entry && entry.objectId
          ? entry.objectId
          : (await options.refs.resolve(entry.name))?.objectId;
      if (!value) continue;
      if (replace.has(original)) {
        // git dies here; the first one read is kept
        messages.push(`fatal: duplicate replace ref: ${trimmed}`);
        continue;
      }
      replace.set(original, value);
    }
  }
  const text = options.readGraftFile
    ? await options.readGraftFile()
    : options.refs.readGrafts
      ? await options.refs.readGrafts()
      : undefined;
  const parsed = text === undefined ? { grafts: new Map(), messages: [] } : parseGraftFile(text);
  const replaceMessages = [...messages];
  messages.push(...parsed.messages);
  const grafts: Map<ObjectId, ObjectId[]> = parsed.grafts;
  if (replace.size > 0 || grafts.size > 0) {
    const shallow = (await options.refs.getShallow?.().catch(() => [])) ?? [];
    for (const id of shallow) grafts.set(id, []);
  }
  return {
    replace,
    grafts,
    graftFile: text !== undefined,
    messages,
    replaceMessages,
    graftMessages: parsed.messages,
  };
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

/** Loads the replacements once, on first use; undefined when there are none. */
function lazyReplacements(
  load: () => Promise<ObjectReplacements | undefined>,
): () => Promise<ObjectReplacements | undefined> {
  let loading: Promise<ObjectReplacements | undefined> | undefined;
  return async () => {
    loading ??= load().catch(() => undefined);
    const r = await loading;
    return hasReplacements(r) ? r : undefined;
  };
}

/**
 * A view of `target` whose `overrides` replace some of its methods; every other property is
 * the target's own (methods bound to it), so a store's extra methods stay reachable.
 */
export function overlayMethods<T extends object>(
  target: T,
  overrides: Partial<Record<keyof T, unknown>>,
): T {
  // each method bound once (a read of a store's method is a hot path)
  const bound = new Map<PropertyKey, { of: unknown; fn: unknown }>();
  return new Proxy(target, {
    get(t, prop) {
      if (Object.hasOwn(overrides, prop)) return overrides[prop as keyof T];
      const value = Reflect.get(t, prop, t);
      if (typeof value !== "function") return value;
      const known = bound.get(prop);
      if (known && known.of === value) return known.fn;
      const fn = value.bind(t);
      bound.set(prop, { of: value, fn });
      return fn;
    },
    has(t, prop) {
      return Object.hasOwn(overrides, prop) || Reflect.has(t, prop);
    },
  });
}

/**
 * `commits` as git reads them: through the replacements `load` gives (read once, on first
 * use). Without any, every call goes to `commits` (its commit-graph included); with some,
 * commits are read from the object store (git does not use a commit-graph then), each by its
 * replacement, with its grafted parents (none for a shallow commit: `.git/shallow` overrides
 * `info/grafts`, as in git). Writes and other methods go to `commits` unchanged.
 */
export function createReplacedCommits(
  commits: Commits,
  load: () => Promise<ObjectReplacements | undefined>,
): Commits {
  const active = lazyReplacements(load);
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
  const overrides: Partial<Commits> = {
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
        getHeader: (id, options) => (overrides.getHeader as Commits["getHeader"] & {})(id, options),
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
  return overlayMethods(commits, overrides);
}

/**
 * `trees` as git reads them: a tree replaced by `refs/replace/<id>` reads as its replacement's
 * entries (its id kept). Writes and other methods go to `trees` unchanged.
 */
export function createReplacedTrees<T extends Trees>(
  trees: T,
  load: () => Promise<ObjectReplacements | undefined>,
): T {
  const active = lazyReplacements(load);
  const read = async (id: ObjectId) => {
    const r = await active();
    return r ? replacementOf(r.replace, id) : id;
  };
  const overrides: Partial<Trees> = {
    load: async (id) => trees.load(await read(id)),
    getEntry: async (treeId, name) => trees.getEntry(await read(treeId), name),
    ...(trees.entries ? { entries: async (id: ObjectId) => trees.entries?.(await read(id)) } : {}),
    ...(trees.raw ? { raw: async (id: ObjectId) => trees.raw?.(await read(id)) } : {}),
  };
  return overlayMethods(trees, overrides as Partial<T>);
}

/**
 * `blobs` as git reads them: a blob replaced by `refs/replace/<id>` reads as its replacement's
 * content and size (its id kept). Writes and other methods go to `blobs` unchanged.
 */
export function createReplacedBlobs<B extends Blobs>(
  blobs: B,
  load: () => Promise<ObjectReplacements | undefined>,
): B {
  const active = lazyReplacements(load);
  const read = async (id: ObjectId) => {
    const r = await active();
    return r ? replacementOf(r.replace, id) : id;
  };
  const overrides: Partial<Blobs> = {
    load: async (id) => blobs.load(await read(id)),
    size: async (id) => blobs.size(await read(id)),
    ...(blobs.open ? { open: async (id: ObjectId) => blobs.open?.(await read(id)) } : {}),
  };
  return overlayMethods(blobs, overrides as Partial<B>);
}

/**
 * `tags` as git reads them: an annotated tag replaced by `refs/replace/<id>` reads as its
 * replacement (its id kept), and so does each tag of a chain `getTarget` peels.
 */
export function createReplacedTags<T extends Tags>(
  tags: T,
  load: () => Promise<ObjectReplacements | undefined>,
): T {
  const active = lazyReplacements(load);
  const overrides: Partial<Tags> = {
    async load(id) {
      const r = await active();
      return tags.load(r ? replacementOf(r.replace, id) : id);
    },
    async getTarget(id, peel = false) {
      const r = await active();
      if (!r) return tags.getTarget(id, peel);
      const tag = await tags.load(replacementOf(r.replace, id));
      if (!tag) return undefined;
      let current = tag.object;
      if (!peel) return current;
      for (;;) {
        const read = replacementOf(r.replace, current);
        if (!(await tags.has(read))) return current;
        const next = await tags.load(read);
        if (!next) return current;
        current = next.object;
      }
    },
  };
  return overlayMethods(tags, overrides as Partial<T>);
}

/** Whether `name` names a replace ref's object (`refs/replace/<40 hex>`). */
export function isReplaceRefName(name: string, base = "refs/replace/"): boolean {
  return name.startsWith(base) && OID.test(name.slice(name.lastIndexOf("/") + 1));
}
