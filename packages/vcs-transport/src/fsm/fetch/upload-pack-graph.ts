/**
 * Commit-graph walks upload-pack needs, after git's upload-pack.c and shallow.c:
 *
 * - {@link findUnreachableWant}: the "not our ref" check (git's `allowReachableSHA1InWant`),
 * - {@link okToGiveUp}: when negotiation may stop (git's `ok_to_give_up`),
 * - {@link computeShallowUpdate}: `deepen`, `deepen-relative`, `deepen-since`, `deepen-not`
 *   (git's `deepen`, `get_shallow_commits`, `get_shallow_commits_by_rev_list`).
 *
 * They read the graph through `RepositoryFacade.getCommitInfo`; a facade without it gets the
 * slower (or reduced) paths noted on each function.
 *
 * @example
 * ```ts
 * const bad = await findUnreachableWant(repository, wants, advertisedTips);
 * if (bad) await transport.writeLine(`ERR ${notOurRef(bad)}`);
 * ```
 */

import type { CommitGraphInfo, RepositoryFacade } from "../../api/repository-facade.js";
import type { RefStore } from "../../context/process-context.js";

/** The depth `git fetch --unshallow` asks for (git's INFINITE_DEPTH). */
export const INFINITE_DEPTH = 0x7fffffff;

/** git's message for a want the server does not serve. */
export function notOurRef(oid: string): string {
  return `upload-pack: not our ref ${oid}`;
}

/** A request upload-pack refuses (sent to the client as `ERR <message>`). */
export class UploadPackRequestError extends Error {}

const SERVED_SHALLOW = Symbol("servedShallow");

/**
 * The repository as upload-pack walks it when it is shallow itself (git reads its
 * `.git/shallow` as grafts without parents, `register_shallow`): `shallow`'s commits have no
 * parents in `getCommitInfo`, `walkAncestors` and `isReachableFrom` (so a want below the
 * boundary is refused, as git's reachability checks walk the grafted history), every pack
 * stops at them, and `isReachableFromAnyTip` is withheld (callers walk the grafted graph from
 * the ref store's tips instead). The same repository when `shallow` is empty (or it is
 * wrapped already).
 *
 * @throws UploadPackRequestError when the repository is shallow and has no commit graph
 * (`getCommitInfo`): its history could not be cut at the shallow commits
 *
 * @example
 * ```ts
 * const served = withServedShallow(repository, new Set(await refStore.getShallow()));
 * ```
 */
export function withServedShallow(
  repository: RepositoryFacade,
  shallow: ReadonlySet<string>,
): RepositoryFacade {
  if (shallow.size === 0 || (repository as { [SERVED_SHALLOW]?: true })[SERVED_SHALLOW]) {
    return repository;
  }
  const getCommitInfo = repository.getCommitInfo?.bind(repository);
  if (!getCommitInfo) {
    throw new UploadPackRequestError("serving a shallow repository is not supported");
  }
  const grafted: NonNullable<RepositoryFacade["getCommitInfo"]> = async (oid, options) => {
    const info = await getCommitInfo(oid, options);
    return info && shallow.has(oid) ? { ...info, parents: [] } : info;
  };
  const overrides: Partial<RepositoryFacade> & { [SERVED_SHALLOW]: true } = {
    [SERVED_SHALLOW]: true,
    getCommitInfo: grafted,
    walkAncestors: async function* (start: string) {
      const seen = new Set<string>();
      const stack = [start];
      while (stack.length > 0) {
        const oid = stack.pop() as string;
        if (seen.has(oid)) continue;
        seen.add(oid);
        const info = await grafted(oid);
        if (!info) continue;
        yield oid;
        stack.push(...info.parents);
      }
    },
    isReachableFrom: async (oid: string, from: string | string[]) => {
      const seen = new Set<string>();
      const stack = Array.isArray(from) ? [...from] : [from];
      while (stack.length > 0) {
        const c = stack.pop() as string;
        if (c === oid) return true;
        if (seen.has(c)) continue;
        seen.add(c);
        stack.push(...((await grafted(c))?.parents ?? []));
      }
      return false;
    },
    isReachableFromAnyTip: undefined,
    exportPack: (wants, exclude, options) =>
      repository.exportPack(wants, exclude, {
        ...options,
        shallow: new Set([...(options?.shallow ?? []), ...shallow]),
      }),
  };
  return new Proxy(repository, {
    get(target, prop, receiver) {
      if (Object.hasOwn(overrides, prop)) return (overrides as Record<PropertyKey, unknown>)[prop];
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Commit reads, memoized for one request. */
class CommitGraph {
  private readonly cache = new Map<string, CommitGraphInfo | null>();

  constructor(private readonly repository: RepositoryFacade) {}

  get supported(): boolean {
    return typeof this.repository.getCommitInfo === "function";
  }

  /** The commit, or undefined when `oid` is no commit here (absent, or another type). */
  async get(oid: string): Promise<CommitGraphInfo | undefined> {
    let info = this.cache.get(oid);
    if (info === undefined) {
      info = (await this.repository.getCommitInfo?.(oid)) ?? null;
      this.cache.set(oid, info);
    }
    return info ?? undefined;
  }

  /** The object a tag chain ends at (the oid itself when it is no tag). */
  async peel(oid: string): Promise<string> {
    let id = oid;
    for (let i = 0; i < 16 && this.repository.peelTag; i++) {
      const next = await this.repository.peelTag(id);
      if (!next || next === id) break;
      id = next;
    }
    return id;
  }
}

/**
 * The first of `wants` the server must refuse, or undefined when all may be served: a want is
 * served when it is one of `tips` (or the object a tip's tag chain ends at), or a commit
 * reachable from one, as git's `uploadpack.allowReachableSHA1InWant` (blobs and trees that are
 * no tip are refused, as there). The walk starts at the tips and stops once every want is found.
 *
 * Without `getCommitInfo` it asks `isReachableFrom` for each want (or serves tips only).
 */
export async function findUnreachableWant(
  repository: RepositoryFacade,
  wants: Iterable<string>,
  tips: Iterable<string>,
): Promise<string | undefined> {
  const graph = new CommitGraph(repository);
  const tipSet = new Set<string>();
  for (const tip of tips) {
    tipSet.add(tip);
    tipSet.add(await graph.peel(tip));
  }

  const pending: string[] = [];
  for (const want of new Set(wants)) {
    if (tipSet.has(want)) continue;
    if (!(await repository.has(want))) return want;
    pending.push(want);
  }
  if (pending.length === 0) return undefined;

  if (!graph.supported) {
    for (const want of pending) {
      const reachable = repository.isReachableFrom
        ? await repository.isReachableFrom(want, [...tipSet])
        : false;
      if (!reachable) return want;
    }
    return undefined;
  }

  for (const want of pending) {
    if (!(await graph.get(want))) return want; // not a commit, and not a tip
  }

  const left = new Set(pending);
  const seen = new Set<string>();
  const stack = [...tipSet];
  while (stack.length > 0 && left.size > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    left.delete(oid);
    const commit = await graph.get(oid);
    if (commit) stack.push(...commit.parents);
  }
  return left.values().next().value;
}

/**
 * git's `ok_to_give_up` (`can_all_from_reach_with_flag`): true when every want reaches a
 * commit the client has (a common `have`, or a parent of one), walking no parent older than
 * the oldest common have (a want itself is always walked). Each commit is walked once for all
 * wants: what an earlier want's walk learned (reaches, or not) holds for the later ones. A
 * want that is no commit (a tree, a blob) cannot be judged by ancestry and counts as reached,
 * as in git.
 *
 * Without `getCommitInfo` it walks `walkAncestors` of each want looking for a common have.
 */
export async function okToGiveUp(
  repository: RepositoryFacade,
  wants: Iterable<string>,
  common: ReadonlySet<string>,
): Promise<boolean> {
  if (common.size === 0) return false;
  const graph = new CommitGraph(repository);

  if (!graph.supported) {
    for (const want of wants) {
      let found = common.has(want);
      if (!found) {
        for await (const ancestor of repository.walkAncestors(want)) {
          if (common.has(ancestor)) {
            found = true;
            break;
          }
        }
      }
      if (!found) return false;
    }
    return true;
  }

  // THEY_HAVE: the common haves and their parents; the cutoff: the oldest common have
  const theyHave = new Set<string>(common);
  let oldest = Number.POSITIVE_INFINITY;
  for (const oid of common) {
    const commit = await graph.get(oid);
    if (!commit) continue;
    oldest = Math.min(oldest, commit.time);
    for (const parent of commit.parents) theyHave.add(parent);
  }

  // the want commits, oldest first (git orders them by generation)
  const starts: { oid: string; time: number }[] = [];
  for (const want of new Set(wants)) {
    const oid = await graph.peel(want);
    const commit = await graph.get(oid);
    if (commit) starts.push({ oid, time: commit.time });
  }
  starts.sort((a, b) => a.time - b.time);

  const visited = new Set<string>(); // git's assign_flag: walked by any want
  const result = new Set<string>(); // git's RESULT: reaches a commit they have
  const reaches = (oid: string) => theyHave.has(oid) || result.has(oid);
  for (const { oid: start } of starts) {
    visited.add(start);
    const stack = [start];
    while (stack.length > 0) {
      const top = stack[stack.length - 1] as string;
      if (reaches(top)) {
        stack.pop();
        if (stack.length > 0) result.add(stack[stack.length - 1] as string);
        continue;
      }
      let pushed = false;
      for (const parent of (await graph.get(top))?.parents ?? []) {
        if (reaches(parent)) result.add(top);
        if (visited.has(parent)) continue;
        visited.add(parent);
        const commit = await graph.get(parent);
        if (!commit || commit.time < oldest) continue;
        stack.push(parent);
        pushed = true;
        break;
      }
      if (!pushed) stack.pop();
    }
    if (!reaches(start)) return false;
  }
  return true;
}

/** What a fetch asks about the shallow boundary (protocol v2 `fetch` arguments). */
export interface ShallowRequest {
  /** The wants (commits, or tags of them) */
  wants: Iterable<string>;
  /** The client's shallow commits (`shallow <oid>` lines) */
  clientShallow: Iterable<string>;
  /** `deepen <n>` (0: none) */
  depth?: number;
  /** `deepen-relative`: the depth counts from the client's shallow commits */
  deepenRelative?: boolean;
  /** `deepen-since <timestamp>`: commits older than this are cut */
  deepenSince?: number;
  /** `deepen-not`, resolved: commits reachable from these are cut */
  deepenNot?: string[];
  /** The advertised tips (`deepen-relative` uses the client shallows reachable from them) */
  tips?: Iterable<string>;
  /**
   * The served repository's own shallow commits (`withServedShallow` walks them without
   * parents): a `deepen` walk reaching one makes it a shallow commit of the answer, as git's
   * get_shallow_commits does for a graft without parents, and `deepen 2147483647` walks the
   * history instead of unshallowing every client shallow commit
   */
  serverShallow?: ReadonlySet<string>;
}

/** The shallow section of a fetch response, and how the pack must be cut to match it. */
export interface ShallowUpdate {
  /** New shallow commits to send (`shallow <oid>`) */
  shallow: string[];
  /** Client shallow commits now inside the history sent (`unshallow <oid>`) */
  unshallow: string[];
  /** The pack's shallow set: their parents are not walked */
  packShallow: Set<string>;
  /** Further tips of the pack: the parents of the unshallowed commits */
  extraWants: Set<string>;
}

/**
 * The `shallow-info` of a fetch, as git's `deepen` and `deepen_by_rev_list`:
 *
 * - `deepen <n>`: the commits at depth n from the wants are the new shallow commits (a commit
 *   reached sooner on another path is not), `deepen-relative` counts n from the client's
 *   shallow commits instead, and `deepen 2147483647` unshallows them all;
 * - `deepen-since`/`deepen-not`: the commits reachable from the wants not older than the
 *   cutoff (and not reachable from the excluded refs) are sent, those of them with a parent
 *   left out are the new shallow commits;
 * - a client shallow commit inside the history sent is unshallowed, its parents become tips.
 *
 * Without `getCommitInfo` only `deepen` of a client that is not shallow is answered, through
 * `computeShallowBoundaries` (deepening a shallow client is refused: nothing could be
 * unshallowed).
 *
 * @throws UploadPackRequestError when the request cannot be answered
 */
export async function computeShallowUpdate(
  repository: RepositoryFacade,
  request: ShallowRequest,
): Promise<ShallowUpdate> {
  const graph = new CommitGraph(repository);
  const depth = request.depth ?? 0;
  const byRevList = request.deepenSince !== undefined || (request.deepenNot?.length ?? 0) > 0;
  if (depth > 0 && byRevList) {
    throw new UploadPackRequestError(
      "--depth and --shallow-since (or --shallow-exclude) cannot be used together",
    );
  }

  // client shallow commits unknown here are ignored, as git does
  const clientShallow = new Set<string>();
  for (const oid of request.clientShallow) {
    if (graph.supported ? await graph.get(oid) : await repository.has(oid)) clientShallow.add(oid);
  }
  const result = (shallow: Iterable<string>, notShallow: ReadonlySet<string>) =>
    finish(graph, clientShallow, shallow, notShallow);

  if (depth === 0 && !byRevList) {
    // no deepen: the pack still stops at the client's shallow commits
    return result([], new Set());
  }

  if (!graph.supported) {
    if (request.serverShallow?.size) {
      throw new UploadPackRequestError("serving a shallow repository is not supported");
    }
    if (byRevList || !repository.computeShallowBoundaries) {
      throw new UploadPackRequestError(
        byRevList ? "deepen-since and deepen-not are not supported" : "shallow is not supported",
      );
    }
    // without the graph, no client shallow commit can be unshallowed: the pack would stop at
    // them and leave holes, so a shallow client cannot be deepened
    if (clientShallow.size > 0) {
      throw new UploadPackRequestError("deepening a shallow repository is not supported");
    }
    // deepen-relative counts from the client's shallow commits: there are none
    if (depth >= INFINITE_DEPTH || request.deepenRelative) return result([], new Set());
    const boundary = await repository.computeShallowBoundaries(new Set(request.wants), depth);
    return result(boundary, new Set());
  }

  if (byRevList) {
    const { shallow, notShallow } = await shallowByRevList(graph, request);
    return result(shallow, notShallow);
  }

  const grafts = request.serverShallow ?? new Set<string>();
  if (depth >= INFINITE_DEPTH && grafts.size === 0) {
    // --unshallow: every client shallow commit goes
    return result([], clientShallow);
  }

  let heads: string[];
  let walkDepth = depth;
  if (request.deepenRelative) {
    const reachable = await reachableAmong(graph, clientShallow, request.tips ?? []);
    heads = [...reachable];
    walkDepth = depth + 1;
  } else {
    heads = [];
    for (const want of request.wants) heads.push(await graph.peel(want));
  }
  const { shallow, notShallow } = await shallowAtDepth(graph, heads, walkDepth, grafts);
  return result(shallow, notShallow);
}

async function finish(
  graph: CommitGraph,
  clientShallow: ReadonlySet<string>,
  shallowCommits: Iterable<string>,
  notShallow: ReadonlySet<string>,
): Promise<ShallowUpdate> {
  const shallow: string[] = [];
  for (const oid of shallowCommits) {
    if (!clientShallow.has(oid) && !notShallow.has(oid)) shallow.push(oid);
  }
  const unshallow = [...clientShallow].filter((oid) => notShallow.has(oid));
  const extraWants = new Set<string>();
  for (const oid of unshallow) {
    for (const parent of (await graph.get(oid))?.parents ?? []) extraWants.add(parent);
  }
  // all client shallow commits stay in the pack's shallow set: the unshallowed ones continue
  // through their parents, which are tips now (git registers them all, as here)
  const packShallow = new Set<string>([...clientShallow, ...shallow]);
  return { shallow, unshallow, packShallow, extraWants };
}

/**
 * git's get_shallow_commits (shallow.c `get_shallows_or_depth`), step for step: a depth-first
 * walk from each head in turn (its depth reset to 0), each commit's depth kept, a parent
 * walked again when it is reached at a smaller depth; a commit at `depth`, or a shallow commit
 * of the served repository (`grafts`, a graft without parents), is a shallow commit, listed
 * newest first (commit_list_insert) and again each time it is reached again, as git sends it.
 */
async function shallowAtDepth(
  graph: CommitGraph,
  heads: readonly string[],
  depth: number,
  grafts: ReadonlySet<string> = new Set(),
): Promise<{ shallow: string[]; notShallow: Set<string> }> {
  const result: string[] = [];
  const notShallow = new Set<string>();
  const depths = new Map<string, number>();
  const stack: string[] = [];
  let commit: string | undefined;
  let curDepth = 0;
  let i = 0;
  while (commit !== undefined || i < heads.length || stack.length > 0) {
    if (commit === undefined) {
      if (i < heads.length) {
        const head = heads[i++] as string;
        if (!(await graph.get(head))) continue;
        commit = head;
        depths.set(commit, 0);
        curDepth = 0;
      } else {
        commit = stack.pop() as string;
        curDepth = depths.get(commit) ?? 0;
      }
    }
    const info = await graph.get(commit);
    curDepth++;
    if (!info) {
      // a parent this repository lacks: git dies (parse_commit_or_die); nothing to walk
      commit = undefined;
      continue;
    }
    if ((depth < INFINITE_DEPTH && curDepth >= depth) || grafts.has(commit)) {
      result.unshift(commit);
      commit = undefined;
      continue;
    }
    notShallow.add(commit);
    const parents = info.parents;
    commit = undefined;
    for (let k = 0; k < parents.length; k++) {
      const parent = parents[k] as string;
      const known = depths.get(parent);
      if (known !== undefined && curDepth >= known) continue;
      depths.set(parent, curDepth);
      if (k < parents.length - 1) {
        stack.push(parent);
      } else {
        commit = parent;
      }
    }
  }
  return { shallow: result, notShallow };
}

/** git's get_shallow_commits_by_rev_list over `rev-list --max-age=<since> <wants> --not <refs>`. */
async function shallowByRevList(
  graph: CommitGraph,
  request: ShallowRequest,
): Promise<{ shallow: string[]; notShallow: Set<string> }> {
  const excluded = new Set<string>();
  const stack: string[] = [];
  for (const oid of request.deepenNot ?? []) stack.push(await graph.peel(oid));
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (excluded.has(oid)) continue;
    const commit = await graph.get(oid);
    if (!commit) continue;
    excluded.add(oid);
    stack.push(...commit.parents);
  }

  const since = request.deepenSince;
  const included = new Set<string>();
  for (const want of request.wants) stack.push(await graph.peel(want));
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (included.has(oid) || excluded.has(oid)) continue;
    const commit = await graph.get(oid);
    if (!commit) continue;
    if (since !== undefined && commit.time < since) continue;
    included.add(oid);
    stack.push(...commit.parents);
  }
  if (included.size === 0) {
    throw new UploadPackRequestError("no commits selected for shallow requests");
  }

  const shallow: string[] = [];
  for (const oid of included) {
    const commit = await graph.get(oid);
    if (commit?.parents.some((parent) => !included.has(parent))) shallow.push(oid);
  }
  const border = new Set(shallow);
  const notShallow = new Set([...included].filter((oid) => !border.has(oid)));
  return { shallow, notShallow };
}

/** The `targets` reachable from `tips`; the walk ends once all are found. */
async function reachableAmong(
  graph: CommitGraph,
  targets: ReadonlySet<string>,
  tips: Iterable<string>,
): Promise<Set<string>> {
  const found = new Set<string>();
  const seen = new Set<string>();
  const stack: string[] = [];
  for (const tip of tips) stack.push(await graph.peel(tip));
  while (stack.length > 0 && found.size < targets.size) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (targets.has(oid)) found.add(oid);
    const commit = await graph.get(oid);
    if (commit) stack.push(...commit.parents);
  }
  return found;
}

/**
 * A `deepen-not` ref, expanded as git's `expand_ref` (the name, refs/<name>, tags, heads,
 * remotes, a remote's HEAD); undefined unless exactly one ref matches (git: "ambiguous").
 */
export async function resolveDeepenNot(
  refStore: Pick<RefStore, "get">,
  name: string,
): Promise<string | undefined> {
  const found: string[] = [];
  for (const candidate of [
    name,
    `refs/${name}`,
    `refs/tags/${name}`,
    `refs/heads/${name}`,
    `refs/remotes/${name}`,
    `refs/remotes/${name}/HEAD`,
  ]) {
    const oid = await refStore.get(candidate);
    if (oid) found.push(oid);
  }
  return found.length === 1 ? found[0] : undefined;
}

/**
 * The object an annotated tag (or tag chain) finally points at; undefined for anything that
 * is not a tag, or without a way to peel.
 */
export async function peelFully(
  repository: RepositoryFacade | undefined,
  oid: string,
): Promise<string | undefined> {
  if (!repository?.peelTag) return undefined;
  let id = oid;
  for (let i = 0; i < 16; i++) {
    const target = await repository.peelTag(id);
    if (!target || target === id) break;
    id = target;
  }
  return id === oid ? undefined : id;
}
