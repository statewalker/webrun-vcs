/**
 * Git commit store implementation
 *
 * Wraps GitObjects with commit serialization/deserialization.
 * Provides graph traversal operations for commit history.
 */

import { OrderedMap } from "@statewalker/vcs-utils";
import type { ObjectId } from "../../common/id/index.js";
import { objectRemovalEpoch } from "../../storage/raw/object-removals.js";
import { type CommitGraph, CommitGraphCorruptError } from "../commit-graph/commit-graph.js";
import type { CommitGraphProvider } from "../commit-graph/commit-graph-provider.js";
import type { GitObject, GitObjects } from "../objects/git-objects.js";
import {
  hasObjectOfType,
  objectHeader,
  removeObject,
  storeObject,
} from "../objects/typed-object-access.js";
import {
  commitFromBytes,
  commitToEntries,
  decodeCommitEntries,
  encodeCommitEntries,
  entriesToCommit,
} from "./commit-format.js";
import { countAheadBehind, getMergeBases, isAncestorOf, type ReachSource } from "./commit-reach.js";
import type {
  AncestryOptions,
  Commit,
  CommitHeader,
  CommitHeaderReader,
  Commits,
} from "./commits.js";

/** Options of `createCommits`. */
export interface CommitsOptions {
  /**
   * The repository's commit-graph: parents, trees, commit times and generation numbers of the
   * commits it has are read from it instead of from the commits (git's parse_commit_in_graph).
   */
  commitGraph?: CommitGraphProvider;
}

/**
 * Git commit store implementation
 *
 * Handles commit serialization and provides graph traversal.
 */
class GitCommitStore implements Commits {
  /**
   * Parsed commits by id, most recently used last (a commit never changes: its id is its
   * content's hash). Walks and rebases read the same commits again and again. A hit read
   * before the last object removal anywhere (`objectRemovalEpoch`: gc, a repack, a discarded
   * quarantine) is checked with `objects.has` first, so a pruned commit is not served.
   */
  private readonly cache = new OrderedMap<ObjectId, { commit: Commit; epoch: number }>();

  readonly commitGraph?: CommitGraphProvider;

  constructor(
    private readonly objects: GitObjects,
    options: CommitsOptions = {},
  ) {
    this.commitGraph = options.commitGraph;
  }

  /** The commit-graph, loaded on first use; undefined when there is none (or it failed to load). */
  private graph(): CommitGraph | undefined | Promise<CommitGraph | undefined> {
    const provider = this.commitGraph;
    if (!provider) return undefined;
    const now = provider.current();
    return now === null ? provider.get().catch(() => undefined) : now;
  }

  /**
   * The header of a commit the graph has, or undefined (not in it, or a corrupt record: the
   * graph's generations are then no longer trusted). The generation is read when asked for,
   * so a header used for its tree or parents does not check the graph's generations.
   */
  private fromGraph(graph: CommitGraph, id: ObjectId): CommitHeader | undefined {
    const pos = graph.position(id);
    if (pos < 0) return undefined;
    try {
      const header = {
        tree: graph.treeAt(pos),
        parents: graph.parentsAt(pos),
        commitTime: graph.commitTimeAt(pos),
      };
      return Object.defineProperty(header, "generation", {
        enumerable: true,
        get: () => graph.walkGenerationAt(pos),
      }) as CommitHeader;
    } catch (e) {
      // git dies on a corrupt graph; the commit itself is read instead
      if (e instanceof CommitGraphCorruptError) {
        graph.distrustGenerations();
        return undefined;
      }
      throw e;
    }
  }

  /**
   * The commit's tree, parents, committer time and generation: from the commit-graph when it
   * has the commit (nothing is read), else from the commit (generation Infinity). With
   * `checkExists`, a commit the graph has must also be in the object store (git's
   * GIT_COMMIT_GRAPH_PARANOIA): a graph left over after its commits were pruned does not make
   * them present.
   */
  async getHeader(
    id: ObjectId,
    options: { checkExists?: boolean } = {},
  ): Promise<CommitHeader | undefined> {
    const g = this.graph();
    return this.headerIn(g instanceof Promise ? await g : g, id, options);
  }

  /**
   * The header from `graph` when it has the commit, else from the object store (generation
   * Infinity): never from another graph the provider loaded since.
   */
  private async headerIn(
    graph: CommitGraph | undefined,
    id: ObjectId,
    options: { checkExists?: boolean } = {},
  ): Promise<CommitHeader | undefined> {
    if (graph) {
      const header = this.fromGraph(graph, id);
      if (header) {
        if (options.checkExists && !(await this.objects.has(id))) return undefined;
        return header;
      }
    }
    const commit = await this.load(id);
    if (!commit) return undefined;
    return {
      tree: commit.tree,
      parents: commit.parents,
      commitTime: commit.committer.timestamp,
      generation: Number.POSITIVE_INFINITY,
    };
  }

  /**
   * A header reader bound to the graph loaded now: every read of it uses that one graph (or
   * none), so a walk does not mix generations of a graph and the one written while it runs.
   */
  async headerReader(): Promise<CommitHeaderReader> {
    const g = this.graph();
    const graph = g instanceof Promise ? await g : g;
    return {
      getHeader: (id, options) => this.headerIn(graph, id, options),
      get correctedDates() {
        return (graph?.generationsTrusted && graph.correctedDates) ?? false;
      },
    };
  }

  /** The parents of a commit the loaded graph has (no promise), or undefined. */
  private graphParents(id: ObjectId): ObjectId[] | undefined {
    const graph = this.commitGraph?.current();
    if (!graph) return undefined;
    const pos = graph.position(id);
    if (pos < 0) return undefined;
    try {
      return graph.parentsAt(pos);
    } catch (e) {
      if (e instanceof CommitGraphCorruptError) {
        graph.distrustGenerations();
        return undefined;
      }
      throw e;
    }
  }

  /**
   * The header as a reachability walk reads it, over the one graph the walk captured: without
   * a promise for a commit that graph has (no tree id decoded), else from the object store
   * (generation Infinity), never through the provider, which may hold a newer graph by then.
   * Generations come from the graph only while it trusts them (`CommitGraph.generationsTrusted`,
   * checked before the first one is used), else they are Infinity: the walks then neither cut
   * nor reorder.
   */
  private reachIn(graph: CommitGraph | undefined): ReachSource {
    return (id) => {
      if (graph) {
        const pos = graph.position(id);
        if (pos >= 0) {
          try {
            return {
              parents: graph.parentsAt(pos),
              date: graph.commitTimeAt(pos),
              generation: graph.walkGenerationAt(pos),
            };
          } catch (e) {
            if (!(e instanceof CommitGraphCorruptError)) throw e;
            graph.distrustGenerations();
          }
        }
      }
      return this.load(id).then((c) =>
        c
          ? {
              parents: c.parents,
              date: c.committer.timestamp,
              generation: Number.POSITIVE_INFINITY,
            }
          : undefined,
      );
    };
  }

  /**
   * Runs a reachability walk over one graph, captured once (a graph written and loaded while
   * the walk runs is not mixed in); when the graph stopped trusting its generations during it
   * (a corrupt record met on the way), runs it again without them, so no cutoff taken on
   * generations read before is kept.
   */
  private async withGraph<T>(
    walk: (reach: ReachSource, graph: CommitGraph | undefined) => Promise<T>,
  ): Promise<T> {
    const g = this.graph();
    const graph = g instanceof Promise ? await g : g;
    const trusted = graph?.generationsTrusted ?? false;
    const reach = this.reachIn(graph);
    const result = await walk(reach, graph);
    if (graph && trusted && !graph.generationsTrusted) return walk(reach, graph);
    return result;
  }

  // ============ New Commits Interface ============

  /**
   * Store a commit object (new interface)
   */
  async store(commit: Commit): Promise<ObjectId> {
    const entries = commitToEntries(commit);
    return storeObject(this.objects, "commit", encodeCommitEntries(entries));
  }

  /**
   * Load a commit object by ID (new interface)
   * Returns undefined if commit doesn't exist.
   */
  async load(id: ObjectId): Promise<Commit | undefined> {
    const hit = this.cache.get(id);
    if (hit) {
      this.cache.delete(id);
      const epoch = objectRemovalEpoch();
      if (hit.epoch === epoch || (await this.objects.has(id))) {
        hit.epoch = epoch;
        this.cache.set(id, hit);
        return copyCommit(hit.commit);
      }
    }
    // the count before the read: a removal while reading leaves the entry to be checked
    const epoch = objectRemovalEpoch();
    // One read: the header says whether it is a commit, the same stream is decoded
    // (a has() check first would read and inflate the object twice).
    let obj: Awaited<ReturnType<GitObjects["get"]>>;
    try {
      // without a promise when the object is in memory (a loaded pack window)
      const read = this.objects.getNow ? this.objects.getNow(id) : this.objects.get(id);
      obj = read instanceof Promise ? await read : read;
    } catch {
      return undefined;
    }
    if (!obj) return undefined;
    // in memory already: decoded without another await
    const commit = obj.bytes ? fromBytes(obj.type, obj.bytes) : await this.readStream(obj);
    if (commit) {
      this.cache.set(id, { commit: copyCommit(commit), epoch });
      if (this.cache.size > MAX_CACHED_COMMITS) {
        this.cache.delete(this.cache.oldestKey() as ObjectId);
      }
    }
    return commit;
  }

  /** A commit object that is not in memory, decoded from its stream. */
  private async readStream(obj: GitObject): Promise<Commit | undefined> {
    const it = obj.content[Symbol.asyncIterator]();
    try {
      if (obj.type !== "commit") return undefined;
      return await entriesToCommit(decodeCommitEntries({ [Symbol.asyncIterator]: () => it }));
    } catch {
      return undefined;
    } finally {
      await it.return?.();
    }
  }

  /**
   * Remove commit (new interface)
   */
  async remove(id: ObjectId): Promise<boolean> {
    this.cache.delete(id);
    return removeObject(this.objects, id);
  }

  /**
   * Get parent commit IDs
   */
  async getParents(id: ObjectId): Promise<ObjectId[]> {
    const g = this.graph();
    if (g instanceof Promise) await g;
    return this.graphParents(id) ?? (await this.getHeader(id))?.parents ?? [];
  }

  /**
   * Get tree ID for a commit
   */
  async getTree(id: ObjectId): Promise<ObjectId | undefined> {
    return (await this.getHeader(id))?.tree;
  }

  /**
   * Walk commit ancestry (depth-first)
   */
  async *walkAncestry(
    startIds: ObjectId | ObjectId[],
    options: AncestryOptions = {},
  ): AsyncIterable<ObjectId> {
    const starts = Array.isArray(startIds) ? startIds : [startIds];
    const visited = new Set<ObjectId>();
    const stopAt = new Set(options.stopAt || []);
    const stack = [...starts];
    let count = 0;

    while (stack.length > 0) {
      if (options.limit !== undefined && count >= options.limit) {
        break;
      }

      const id = stack.pop();
      if (id === undefined) break;

      if (visited.has(id) || stopAt.has(id)) {
        continue;
      }

      visited.add(id);
      yield id;
      count++;

      // without a promise for a commit the loaded graph has
      const parents = this.graphParents(id) ?? (await this.getParents(id));
      if (options.firstParentOnly && parents.length > 0) {
        stack.push(parents[0]);
      } else {
        for (let i = parents.length - 1; i >= 0; i--) {
          stack.push(parents[i]);
        }
      }
    }
  }

  /**
   * The merge bases of two commits, as `git merge-base --all` lists them (git's
   * repo_get_merge_bases): best first, none for unrelated histories. With a commit-graph that
   * has corrected commit dates the walk is ordered by generation, as git orders it.
   */
  async findMergeBase(commitA: ObjectId, commitB: ObjectId): Promise<ObjectId[]> {
    return this.withGraph((reach, graph) =>
      getMergeBases(reach, commitA, [commitB], {
        correctedDates: (graph?.generationsTrusted && graph.correctedDates) ?? false,
      }),
    );
  }

  /** `rev-list --left-right --count ours...theirs`, the walk cut at the merge bases. */
  async countAheadBehind(
    ours: ObjectId,
    theirs: ObjectId,
  ): Promise<{ ahead: number; behind: number }> {
    return this.withGraph((reach) => countAheadBehind(reach, ours, theirs));
  }

  /**
   * Check if commit exists and is actually a commit object
   */
  async has(id: ObjectId): Promise<boolean> {
    return hasObjectOfType(this.objects, id, "commit");
  }

  /**
   * Enumerate all commit object IDs
   */
  async *keys(): AsyncIterable<ObjectId> {
    for await (const id of this.objects.list()) {
      try {
        const header = await objectHeader(this.objects, id);
        if (header?.type === "commit") {
          yield id;
        }
      } catch {
        // Skip invalid objects
      }
    }
  }

  /**
   * Check if commitA is ancestor of commitB
   */
  async isAncestor(ancestorId: ObjectId, descendantId: ObjectId): Promise<boolean> {
    // git's repo_in_merge_bases: the generations of commit-graph commits cut the walk short
    return this.withGraph((reach) => isAncestorOf(reach, ancestorId, descendantId));
  }
}

/** Parsed commits the store keeps at most. */
const MAX_CACHED_COMMITS = 10_000;

/** The commit in `bytes`, or undefined if it is not a commit or does not parse. */
function fromBytes(type: string, bytes: Uint8Array): Commit | undefined {
  if (type !== "commit") return undefined;
  try {
    return commitFromBytes(bytes);
  } catch {
    return undefined;
  }
}

/** A copy a caller may change without reaching the cache. */
function copyCommit(c: Commit): Commit {
  return { ...c, parents: [...c.parents], author: { ...c.author }, committer: { ...c.committer } };
}

/**
 * Create a Commits instance backed by GitObjects
 *
 * @param objects GitObjects implementation to use for persistence
 * @param options The commit-graph to read, if any
 * @returns Commits instance
 */
export function createCommits(objects: GitObjects, options: CommitsOptions = {}): Commits {
  return new GitCommitStore(objects, options);
}
