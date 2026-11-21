/**
 * VcsRepositoryFacade
 *
 * Implements RepositoryFacade using the History facade for object access.
 * Delegates pack export and import to SerializationApi (exportPack: listObjects + writePack).
 */

import type { History, SerializationApi } from "@statewalker/vcs-core";
import {
  createHistoryFromComponents,
  DefaultSerializationApi,
  isSymbolicRef,
  serializeCommit,
  serializeTag,
  serializeTree,
} from "@statewalker/vcs-core";
import {
  type CommitGraphInfo,
  type ExportPackOptions,
  type GitObjectTypeName,
  lenientCommitHeader,
  lenientTagTarget,
  type PackImportOptions,
  type PackImportResult,
  type RepositoryFacade,
  storedObjectType,
  type TagTargetInfo,
  type TreeEntryInfo,
} from "@statewalker/vcs-transport";
import { toArray } from "@statewalker/vcs-utils/streams";

/** git's object type names by type code. */
const OBJECT_TYPE_NAMES: Record<number, GitObjectTypeName> = {
  1: "commit",
  2: "tree",
  3: "blob",
  4: "tag",
};

/**
 * Configuration for VcsRepositoryFacade using History facade
 */
export interface VcsRepositoryFacadeConfig {
  /** History facade for object access */
  history: History;
  /** Serialization API for pack operations */
  serialization: SerializationApi;
  /**
   * Whether the repository has no working tree (default true). receive-pack refuses to
   * update the checked-out branch of a non-bare one ("branch is currently checked out").
   */
  bare?: boolean;
}

/**
 * Repository facade implementation using History facade.
 *
 * Provides RepositoryFacade interface for transport operations using
 * the unified History API. Delegates pack operations to SerializationApi.
 */
export class VcsRepositoryFacade implements RepositoryFacade {
  private readonly history: History;
  private readonly serialization: SerializationApi;
  private readonly bare: boolean;

  constructor(config: VcsRepositoryFacadeConfig) {
    this.history = config.history;
    this.serialization = config.serialization;
    this.bare = config.bare ?? true;
  }

  /** Whether the repository has no working tree (receive-pack's current-branch rule). */
  isBare(): boolean {
    return this.bare;
  }

  /**
   * Import a pack stream into the repository.
   * Delegates to SerializationApi.importPack; with `quarantine` (receive-pack) the objects
   * stay aside until the returned quarantine is committed, and its `repository` sees them.
   */
  async importPack(
    packStream: AsyncIterable<Uint8Array>,
    options?: PackImportOptions,
  ): Promise<PackImportResult> {
    const { quarantine, ...result } = await this.serialization.importPack(packStream, options);
    if (!quarantine) return result;
    // the push's view: the quarantined objects, then the repository's, with the same refs
    const history = createHistoryFromComponents({
      objects: quarantine.objects,
      refs: this.history.refs,
    });
    const repository = new VcsRepositoryFacade({
      history,
      serialization: new DefaultSerializationApi({ history }),
      bare: this.bare,
    });
    return {
      ...result,
      quarantine: {
        repository,
        commit: () => quarantine.commit(),
        discard: () => quarantine.discard(),
      },
    };
  }

  /**
   * Export objects as a pack stream.
   * The objects reachable from wants and not from exclude, streamed.
   * Delegates to SerializationApi.exportPack.
   */
  async *exportPack(
    wants: Set<string>,
    exclude: Set<string>,
    options?: ExportPackOptions,
  ): AsyncIterable<Uint8Array> {
    yield* this.serialization.exportPack(wants, exclude, {
      thinPack: options?.thin,
      shallow: options?.shallow,
      ofsDelta: options?.ofsDelta,
      // include-tag: upload-pack's candidates (the visible refs/tags/*), else our own tags
      includeTags: options?.includeTag
        ? (options.includeTags ?? (await this.tagRefIds()))
        : undefined,
    });
  }

  /** The ids of the `refs/tags/*` refs (the candidates of `includeTag` without `includeTags`). */
  private async tagRefIds(): Promise<string[]> {
    const ids: string[] = [];
    for await (const ref of this.history.refs.list("refs/tags/")) {
      if ("objectId" in ref && ref.objectId) ids.push(ref.objectId);
    }
    return ids;
  }

  /**
   * Check if an object exists in any store.
   * Checks in order: commits → trees → blobs → tags
   */
  async has(oid: string): Promise<boolean> {
    if (await this.history.commits.has(oid)) return true;
    if (await this.history.trees.has(oid)) return true;
    if (await this.history.blobs.has(oid)) return true;
    if (await this.history.tags.has(oid)) return true;
    return false;
  }

  /**
   * Walk commit ancestry from a starting point.
   * Yields commit OIDs in BFS order.
   */
  async *walkAncestors(startOid: string): AsyncGenerator<string> {
    const visited = new Set<string>();
    const queue: string[] = [startOid];

    while (queue.length > 0) {
      const oid = queue.shift();
      if (!oid || visited.has(oid)) continue;
      visited.add(oid);

      const commit = await this.history.commits.load(oid);
      if (commit) {
        yield oid;
        // Queue parents for BFS traversal
        for (const parentOid of commit.parents) {
          if (!visited.has(parentOid)) {
            queue.push(parentOid);
          }
        }
      }
    }
  }

  /**
   * Peel a tag to its underlying object.
   */
  async peelTag(oid: string): Promise<string | null> {
    return (await this.history.tags.getTarget(oid)) ?? null;
  }

  /**
   * Get the size of an object.
   */
  async getObjectSize(oid: string): Promise<number | null> {
    // Try blobs first - most efficient with size() method
    const blobSize = await this.history.blobs.size(oid);
    if (blobSize >= 0) return blobSize;

    // Try commits
    const commit = await this.history.commits.load(oid);
    if (commit) {
      const content = serializeCommit(commit);
      return content.length;
    }

    // Try trees: the stored bytes where the store has them (`load` reads modes canonical)
    const raw = await this.history.trees.raw?.(oid);
    if (raw) return raw.length;
    const tree = await this.history.trees.load(oid);
    if (tree) {
      const entries = await toArray(tree);
      const content = serializeTree(entries);
      return content.length;
    }

    // Try tags
    const tag = await this.history.tags.load(oid);
    if (tag) {
      const content = serializeTag(tag);
      return content.length;
    }

    return null;
  }

  /**
   * A commit's parents and committer time (upload-pack walks the graph with it), from the
   * commit-graph where the store has one. Without `checkExists` a commit the graph has is not
   * looked up in the object store (git's default for upload-pack walks); with it, a commit only
   * a stale graph lists (pruned since) is absent, as with git's GIT_COMMIT_GRAPH_PARANOIA:
   * receive-pack asks so for the object's type and its connectivity.
   */
  async getCommitInfo(
    oid: string,
    options: { checkExists?: boolean } = {},
  ): Promise<CommitGraphInfo | undefined> {
    const commits = this.history.commits;
    if (commits.getHeader) {
      // from the commit-graph when it has the commit (nothing is read)
      const h = await commits
        .getHeader(oid, { checkExists: options.checkExists })
        .catch(() => undefined);
      if (h) return { parents: h.parents, time: h.commitTime, tree: h.tree };
    } else {
      const commit = await commits.load(oid).catch(() => undefined);
      if (commit) {
        return { parents: commit.parents, time: commit.committer.timestamp, tree: commit.tree };
      }
    }
    // a commit the typed store cannot parse (an author line fsck refuses): git walks it
    return this.lenientObject(oid, "commit", lenientCommitHeader);
  }

  /**
   * An object the typed store could not parse, read leniently when it is of `type` (its header
   * read first: an object of another type, or absent, is not read whole); undefined otherwise,
   * and when it cannot be read.
   */
  private async lenientObject<T>(
    oid: string,
    type: GitObjectTypeName,
    parse: (content: Uint8Array) => T | undefined,
  ): Promise<T | undefined> {
    if ((await storedObjectType(this.history.objects, oid)) !== type) return undefined;
    try {
      const object = await this.loadObject(oid);
      return object?.type === type ? parse(object.content) : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * The entries of a tree (receive-pack's connectivity check), undefined when not a tree.
   */
  async getTreeEntries(oid: string): Promise<TreeEntryInfo[] | undefined> {
    try {
      const tree = await this.history.trees.load(oid);
      if (!tree) return undefined;
      return (await toArray(tree)).map((e) => ({ mode: e.mode, name: e.name, id: e.id }));
    } catch {
      return undefined;
    }
  }

  /**
   * What an annotated tag points at, undefined when not a tag.
   */
  async getTagInfo(oid: string): Promise<TagTargetInfo | undefined> {
    try {
      const tag = await this.history.tags.load(oid);
      if (tag) return { object: tag.object, type: OBJECT_TYPE_NAMES[tag.objectType] ?? "commit" };
    } catch {
      // a tag the typed store cannot parse: read as git's parse_tag_buffer reads it
    }
    return this.lenientObject(oid, "tag", lenientTagTarget);
  }

  /**
   * An object's type and content, undefined when absent (a fetch's `fetch.fsckObjects`).
   */
  async loadObject(
    oid: string,
  ): Promise<{ type: GitObjectTypeName; content: Uint8Array } | undefined> {
    const objects = this.history.objects;
    if (!objects) return undefined;
    const object = await objects.get(oid);
    if (!object) return undefined;
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of object.content) {
      chunks.push(chunk);
      size += chunk.length;
    }
    const content = chunks.length === 1 ? (chunks[0] as Uint8Array) : new Uint8Array(size);
    if (chunks.length !== 1) {
      let at = 0;
      for (const chunk of chunks) {
        content.set(chunk, at);
        at += chunk.length;
      }
    }
    return { type: object.type, content };
  }

  /**
   * The object's type (receive-pack checks branch tips are commits), undefined when absent.
   */
  async getObjectType(oid: string): Promise<GitObjectTypeName | undefined> {
    const objects = this.history.objects;
    if (objects) {
      // the type from the object header (a commit the typed store cannot parse is one too);
      // the content is released unread
      const object = await objects.get(oid);
      if (!object) return undefined;
      await object.content[Symbol.asyncIterator]().return?.();
      return object.type;
    }
    if (await this.history.commits.load(oid).catch(() => undefined)) return "commit";
    if (await this.getTagInfo(oid)) return "tag";
    if ((await this.getTreeEntries(oid)) !== undefined) return "tree";
    return (await this.history.blobs.has(oid)) ? "blob" : undefined;
  }

  /**
   * Check if an object is reachable from other objects.
   */
  async isReachableFrom(oid: string, from: string | string[]): Promise<boolean> {
    const roots = Array.isArray(from) ? from : [from];

    for (const root of roots) {
      for await (const ancestorOid of this.walkAncestors(root)) {
        if (ancestorOid === oid) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Check if an object is reachable from any ref tip.
   */
  async isReachableFromAnyTip(oid: string): Promise<boolean> {
    const tips: string[] = [];

    for await (const ref of this.history.refs.list()) {
      const resolved = isSymbolicRef(ref) ? await this.history.refs.resolve(ref.name) : ref;
      if (resolved && "objectId" in resolved && resolved.objectId !== undefined) {
        tips.push(resolved.objectId);
      }
    }

    return this.isReachableFrom(oid, tips);
  }

  /**
   * Compute shallow boundaries for depth-limited clone, as git's `deepen <depth>`: the
   * commits `depth` commits deep (the wants for depth 1), each at its smallest depth.
   */
  async computeShallowBoundaries(wants: Set<string>, depth: number): Promise<Set<string>> {
    const boundaries = new Set<string>();
    const seen = new Set<string>();
    let level = [...wants];
    for (let d = 1; level.length > 0; d++) {
      const next: string[] = [];
      for (const oid of level) {
        if (seen.has(oid)) continue;
        seen.add(oid);
        const commit = await this.history.commits.load(oid);
        if (!commit) continue;
        if (d >= depth) boundaries.add(oid);
        else next.push(...commit.parents);
      }
      level = next;
    }
    return boundaries;
  }

  /**
   * Compute shallow boundaries since a timestamp.
   */
  async computeShallowSince(wants: Set<string>, timestamp: number): Promise<Set<string>> {
    const boundaries = new Set<string>();

    for (const want of wants) {
      const queue: string[] = [want];
      const visited = new Set<string>();

      while (queue.length > 0) {
        const oid = queue.shift();
        if (!oid || visited.has(oid)) continue;
        visited.add(oid);

        const commit = await this.history.commits.load(oid);
        if (commit) {
          // Check if commit is before timestamp
          if (commit.committer.timestamp < timestamp) {
            boundaries.add(oid);
            continue;
          }

          // Continue walking parents
          for (const parent of commit.parents) {
            queue.push(parent);
          }
        }
      }
    }

    return boundaries;
  }

  /**
   * Compute shallow boundaries excluding refs.
   */
  async computeShallowExclude(wants: Set<string>, excludeRefs: string[]): Promise<Set<string>> {
    const boundaries = new Set<string>();

    // Resolve exclude refs to OIDs
    const excludeOids = new Set<string>();
    for (const refName of excludeRefs) {
      const ref = await this.history.refs.resolve(refName);
      if (ref && "objectId" in ref && ref.objectId) {
        excludeOids.add(ref.objectId);

        // Also add all ancestors of excluded refs
        for await (const ancestorOid of this.walkAncestors(ref.objectId)) {
          excludeOids.add(ancestorOid);
        }
      }
    }

    // Walk from wants and mark boundaries where we hit excluded commits
    for (const want of wants) {
      const queue: string[] = [want];
      const visited = new Set<string>();

      while (queue.length > 0) {
        const oid = queue.shift();
        if (!oid || visited.has(oid)) continue;
        visited.add(oid);

        if (excludeOids.has(oid)) {
          boundaries.add(oid);
          continue;
        }

        const commit = await this.history.commits.load(oid);
        if (commit) {
          for (const parent of commit.parents) {
            queue.push(parent);
          }
        }
      }
    }

    return boundaries;
  }
}

/**
 * Create RepositoryFacade from History facade.
 *
 * @param config - History facade and SerializationApi
 * @returns RepositoryFacade interface for transport operations
 */
export function createVcsRepositoryFacade(config: VcsRepositoryFacadeConfig): RepositoryFacade {
  return new VcsRepositoryFacade(config);
}
