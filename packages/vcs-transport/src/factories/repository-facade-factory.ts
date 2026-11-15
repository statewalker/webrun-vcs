/**
 * Factory for creating RepositoryFacade from HistoryWithOperations.
 *
 * The RepositoryFacade provides a transport-friendly interface for
 * repository operations needed during Git protocol negotiation.
 *
 * Uses HistoryWithOperations for all operations:
 * - SerializationApi.exportPack() (listObjects + writePack) for pack export
 * - SerializationApi for pack import/export
 * - Typed stores (Blobs, Trees, Commits, Tags, Refs) for object access
 */

import {
  createHistoryFromComponents,
  DefaultSerializationApi,
  type History,
  type HistoryWithOperations,
  type ObjectQuarantine,
  type Ref,
  type SymbolicRef,
} from "@statewalker/vcs-core";
import type {
  CommitGraphInfo,
  ExportPackOptions,
  GitObjectTypeName,
  PackImportOptions,
  PackImportResult,
  RepositoryFacade,
  RepositoryQuarantine,
  TagTargetInfo,
  TreeEntryInfo,
} from "../api/repository-facade.js";
import { computeShallowUpdate } from "../fsm/fetch/upload-pack-graph.js";

/**
 * Configuration for creating RepositoryFacade using History facade.
 */
export interface HistoryFacadeConfig {
  /**
   * History facade for object access. A plain `History` gets a `DefaultSerializationApi`
   * over it (pack import and export through its object kernel); a `HistoryWithOperations`
   * brings its own.
   */
  history: History | HistoryWithOperations;
  /**
   * Whether the repository has no working tree (default true). receive-pack refuses to
   * update the checked-out branch of a non-bare one ("branch is currently checked out").
   */
  bare?: boolean;
}

/**
 * Creates a RepositoryFacade from History facade with backend.
 *
 * Pack export goes through SerializationApi.exportPack (listObjects + writePack).
 *
 * @param config - History facade configuration
 * @returns RepositoryFacade implementation
 *
 * @example
 * ```ts
 * const facade = createRepositoryFacade({ history });
 *
 * // Check if we have an object
 * const exists = await facade.has("abc123...");
 *
 * // Export pack
 * const packStream = facade.exportPack(wants, exclude);
 * ```
 */
export function createRepositoryFacade(config: HistoryFacadeConfig): RepositoryFacade {
  const facade = createRepositoryFacadeFromHistory(config.history);
  const bare = config.bare ?? true;
  facade.isBare = () => bare;
  return facade;
}

/**
 * A core quarantine as the transport's {@link RepositoryQuarantine}: its `repository` is a
 * facade over the quarantine's objects (the quarantined ones, then the repository's) and the
 * repository's refs, so receive-pack's checks and hooks see the pushed objects before anyone
 * else does.
 *
 * @example
 * ```ts
 * const { quarantine } = await serialization.importPack(pack, { quarantine: true });
 * if (quarantine) return { ...stats, quarantine: repositoryQuarantine(quarantine, history) };
 * ```
 */
export function repositoryQuarantine(
  quarantine: ObjectQuarantine,
  history: Pick<History, "refs">,
  options: Pick<RepositoryFacade, "isBare"> = {},
): RepositoryQuarantine {
  const view = createHistoryFromComponents({ objects: quarantine.objects, refs: history.refs });
  const repository = createRepositoryFacadeFromHistory(view);
  // the same repository: the same bareness
  if (options.isBare) repository.isBare = options.isBare;
  return {
    repository,
    commit: () => quarantine.commit(),
    discard: () => quarantine.discard(),
  };
}

/**
 * Create RepositoryFacade using new History interface (recommended)
 */
function createRepositoryFacadeFromHistory(
  history: History | HistoryWithOperations,
): RepositoryFacade {
  const { commits, tags, refs } = history;
  const serialization =
    (history as Partial<HistoryWithOperations>).serialization ??
    new DefaultSerializationApi({ history });

  const facade: RepositoryFacade = {
    // ─────────────────────────────────────────────────────────────────
    // Pack I/O - delegated to SerializationApi
    // ─────────────────────────────────────────────────────────────────

    async importPack(
      packStream: AsyncIterable<Uint8Array>,
      options?: PackImportOptions,
    ): Promise<PackImportResult> {
      const { quarantine, ...result } = await serialization.importPack(packStream, options);
      return quarantine
        ? {
            ...result,
            quarantine: repositoryQuarantine(quarantine, history, { isBare: facade.isBare }),
          }
        : result;
    },

    async *exportPack(
      wants: Set<string>,
      exclude: Set<string>,
      options?: ExportPackOptions,
    ): AsyncIterable<Uint8Array> {
      // listObjects + writePack: streamed, stored entries reused, deltas searched
      yield* serialization.exportPack(wants, exclude, {
        thinPack: options?.thin,
        shallow: options?.shallow,
        ofsDelta: options?.ofsDelta,
        includeTags: options?.includeTag
          ? (options.includeTags ?? (await tagRefIds(refs)))
          : undefined,
      });
    },

    // ─────────────────────────────────────────────────────────────────
    // Object existence - check across all stores
    // ─────────────────────────────────────────────────────────────────

    async has(oid: string): Promise<boolean> {
      if (await commits.has(oid)) return true;
      if (await history.trees.has(oid)) return true;
      if (await history.blobs.has(oid)) return true;
      if (await tags.has(oid)) return true;
      return false;
    },

    // ─────────────────────────────────────────────────────────────────
    // Commit ancestry - walk commit graph
    // ─────────────────────────────────────────────────────────────────

    async *walkAncestors(startOid: string): AsyncGenerator<string> {
      yield* commits.walkAncestry(startOid);
    },

    // ─────────────────────────────────────────────────────────────────
    // Optional Protocol V2 methods
    // ─────────────────────────────────────────────────────────────────

    async peelTag(oid: string): Promise<string | null> {
      return (await tags.getTarget(oid)) ?? null;
    },

    async getObjectSize(oid: string): Promise<number | null> {
      // Any type (git's object-info): the size in the object header; the content is released
      // unread
      if (history.objects) {
        const object = await history.objects.get(oid);
        if (!object) return null;
        await object.content[Symbol.asyncIterator]().return?.();
        return object.size;
      }
      // Without the object store only blobs can be sized
      const blobSize = await history.blobs.size(oid);
      return blobSize >= 0 ? blobSize : null;
    },

    // ─────────────────────────────────────────────────────────────────
    // Server-side validation methods
    // ─────────────────────────────────────────────────────────────────

    async getCommitInfo(oid: string): Promise<CommitGraphInfo | undefined> {
      const commit = await commits.load(oid);
      if (!commit) return undefined;
      return { parents: commit.parents, time: commit.committer.timestamp, tree: commit.tree };
    },

    async getObjectType(oid: string): Promise<GitObjectTypeName | undefined> {
      if (history.objects) {
        // the type from the object header; the content is released unread
        const object = await history.objects.get(oid);
        if (!object) return undefined;
        await object.content[Symbol.asyncIterator]().return?.();
        return object.type;
      }
      if (await commits.load(oid)) return "commit";
      if (await tags.load(oid).catch(() => undefined)) return "tag";
      if ((await facade.getTreeEntries?.(oid)) !== undefined) return "tree";
      return (await history.blobs.has(oid)) ? "blob" : undefined;
    },

    async getTreeEntries(oid: string): Promise<TreeEntryInfo[] | undefined> {
      try {
        const tree = await history.trees.load(oid);
        if (!tree) return undefined;
        const entries: TreeEntryInfo[] = [];
        for await (const entry of tree) {
          entries.push({ mode: entry.mode, name: entry.name, id: entry.id });
        }
        return entries;
      } catch {
        // not a tree, or a corrupt one
        return undefined;
      }
    },

    async resolvePrefix(prefix: string): Promise<string[]> {
      const found: string[] = [];
      if (!history.objects) return found;
      for await (const id of history.objects.list()) {
        if (id.startsWith(prefix)) {
          found.push(id);
          if (found.length > 1) break;
        }
      }
      return found;
    },

    async getTagInfo(oid: string): Promise<TagTargetInfo | undefined> {
      try {
        const tag = await tags.load(oid);
        if (!tag) return undefined;
        return { object: tag.object, type: OBJECT_TYPE_NAMES[tag.objectType] ?? "commit" };
      } catch {
        return undefined;
      }
    },

    async computeShallowBoundaries(wants: Set<string>, depth: number): Promise<Set<string>> {
      const update = await computeShallowUpdate(facade, { wants, clientShallow: [], depth });
      return new Set(update.shallow);
    },

    async isReachableFrom(oid: string, from: string | string[]): Promise<boolean> {
      const roots = Array.isArray(from) ? from : [from];

      for (const root of roots) {
        if (await commits.isAncestor(oid, root)) {
          return true;
        }
      }

      return false;
    },

    async isReachableFromAnyTip(oid: string): Promise<boolean> {
      const tips: string[] = [];
      for await (const ref of refs.list()) {
        const resolved = isSymbolicRef(ref) ? await refs.resolve(ref.name) : ref;
        if (resolved && "objectId" in resolved && resolved.objectId !== undefined) {
          tips.push(resolved.objectId);
        }
      }

      return facade.isReachableFrom?.(oid, tips) ?? false;
    },
  };

  return facade;
}

/** The ids of the `refs/tags/*` refs (candidates of `include-tag`). */
async function tagRefIds(refs: History["refs"]): Promise<string[]> {
  const ids: string[] = [];
  for await (const ref of refs.list("refs/tags/")) {
    if (!isSymbolicRef(ref) && ref.objectId) ids.push(ref.objectId);
  }
  return ids;
}

/** git's object type names by type code (vcs-core `ObjectType`). */
const OBJECT_TYPE_NAMES: Record<number, GitObjectTypeName> = {
  1: "commit",
  2: "tree",
  3: "blob",
  4: "tag",
};

/**
 * Type guard for SymbolicRef
 */
function isSymbolicRef(ref: Ref | SymbolicRef): ref is SymbolicRef {
  return "target" in ref;
}
