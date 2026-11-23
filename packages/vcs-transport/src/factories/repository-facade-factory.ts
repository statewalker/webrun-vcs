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
  findAbbrevLengths,
  type History,
  type HistoryWithOperations,
  type ObjectQuarantine,
  objectFormatOf,
  parseObjectFilter,
  type Ref,
  resolveObjectFilter,
  type SparseFilterMatcher,
  type SymbolicRef,
  TreeDepthError,
} from "@statewalker/vcs-core";
import { assertSha1ObjectFormat } from "@statewalker/vcs-utils/hash";
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
import { PackObjectsError } from "../fsm/fetch/pack-objects-error.js";
import { computeShallowUpdate } from "../fsm/fetch/upload-pack-graph.js";
import { resolveRevision } from "../push-client/revision.js";
import { lenientCommitHeader, lenientTagTarget, storedObjectType } from "../utils/index.js";

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
  /**
   * List the objects of served packs through the packs' reachability bitmap when there is
   * one (git's `pack.useBitmaps`, default true).
   */
  useBitmaps?: boolean;
  /**
   * Parses the patterns of a `sparse:oid=<blob-ish>` partial clone filter (the blob's text,
   * gitignore-style, non-cone: git's `add_patterns_from_blob_to_list` and
   * `path_matches_pattern_list`); vcs-working-tree's `sparseFilterMatcher`. Without it a
   * `sparse:oid` filter fails the pack.
   */
  sparseFilterPatterns?: (text: string) => SparseFilterMatcher;
  /**
   * git's `core.maxTreeDepth` for the served packs' walk (default 2048): a deeper tree fails
   * the pack as pack-objects dies (`fatal: exceeded maximum allowed tree depth`)
   */
  maxTreeDepth?: number;
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
  // the protocols' object-format capability and SHA-256 packs are not implemented yet: a
  // SHA-256 repository is neither served nor fetched into
  assertSha1ObjectFormat(objectFormatOf(config.history), "fetch, push and serving");
  const facade = createRepositoryFacadeFromHistory(
    config.history,
    config.useBitmaps,
    config.sparseFilterPatterns,
    config.maxTreeDepth,
  );
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
    ...(quarantine.path !== undefined ? { path: quarantine.path } : {}),
    commit: () => quarantine.commit(),
    discard: () => quarantine.discard(),
  };
}

/**
 * Create RepositoryFacade using new History interface (recommended)
 */
function createRepositoryFacadeFromHistory(
  history: History | HistoryWithOperations,
  useBitmaps?: boolean,
  sparseFilterPatterns?: (text: string) => SparseFilterMatcher,
  maxTreeDepth?: number,
): RepositoryFacade {
  const { commits, tags, refs } = history;
  const serialization =
    (history as Partial<HistoryWithOperations>).serialization ??
    new DefaultSerializationApi({ history });

  const alternates = history.objects?.alternates;
  /**
   * An object the typed store could not parse, read leniently when it is of `type` (its header
   * read first: an object of another type, or absent, is not read whole); undefined otherwise,
   * and when it cannot be read.
   */
  const lenientObject = async <T>(
    oid: string,
    type: GitObjectTypeName,
    parse: (content: Uint8Array) => T | undefined,
  ): Promise<T | undefined> => {
    if ((await storedObjectType(history.objects, oid)) !== type) return undefined;
    try {
      const object = await facade.loadObject?.(oid);
      return object?.type === type ? parse(object.content) : undefined;
    } catch {
      return undefined;
    }
  };
  /**
   * git's filter_sparse_oid__init: the blob-ish resolved (get_oid with GET_OID_BLOB) and its
   * patterns parsed, a blob over dir.c's PATTERN_MAX_FILE_SIZE refused before it is read
   */
  const loadSparse = async (name: string): Promise<SparseFilterMatcher> => {
    const id = await resolveBlobName(history, facade, name);
    if (id === undefined) throw new PackObjectsError(`unable to access sparse blob in '${name}'`);
    const size = await facade.getObjectSize?.(id).catch(() => null);
    if (size != null && size > PATTERN_MAX_FILE_SIZE) {
      throw new PackObjectsError(`unable to parse sparse filter data in ${id}`, {
        lines: [`warning: ignoring excessively large pattern blob: ${id}`],
      });
    }
    const object = await facade.loadObject?.(id).catch(() => undefined);
    if (object?.type !== "blob" || !sparseFilterPatterns) {
      throw new PackObjectsError(`unable to parse sparse filter data in ${id}`);
    }
    return sparseFilterPatterns(new TextDecoder().decode(object.content));
  };
  const facade: RepositoryFacade = {
    // the alternates' refs, for receive-pack's `.have` lines
    ...(alternates ? { alternateRefs: () => alternates.refs() } : {}),
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

    async markPromisorPack(packId: string, content: string): Promise<boolean> {
      return (await serialization.markPromisorPack?.(packId, content)) ?? false;
    },

    async repackLocalLinks(links: Iterable<string>): Promise<string | undefined> {
      const promisor = history.objects?.promisor;
      if (!promisor || !serialization.markPromisorPack) return undefined;
      const ids = await promisor.localLinkObjects(links);
      if (ids.length === 0) return undefined;
      // pack-objects writes the pack, index-pack the empty `.promisor` beside it
      const pack = serialization.createPack(
        (async function* () {
          yield* ids;
        })(),
      );
      const { packId } = await serialization.importPack(pack, { keepPack: true });
      if (packId === undefined) return undefined;
      await serialization.markPromisorPack(packId, "");
      return packId;
    },

    async *exportPack(
      wants: Set<string>,
      exclude: Set<string>,
      options?: ExportPackOptions,
    ): AsyncIterable<Uint8Array> {
      // the partial clone filter, its sparse:oid blob read (pack-objects dies on a bad one)
      const filter = options?.filterSpec
        ? await resolveObjectFilter(parseObjectFilter(options.filterSpec), loadSparse)
        : undefined;
      // listObjects + writePack: streamed, stored entries reused, deltas searched
      const pack = serialization.exportPack(wants, exclude, {
        ...(filter ? { filter } : {}),
        ...(maxTreeDepth !== undefined ? { maxTreeDepth } : {}),
        thinPack: options?.thin,
        shallow: options?.shallow,
        ...(useBitmaps === false ? { useBitmaps } : {}),
        ofsDelta: options?.ofsDelta,
        includeTags: options?.includeTag
          ? (options.includeTags ?? (await tagRefIds(refs)))
          : undefined,
      });
      try {
        yield* pack;
      } catch (error) {
        // the walk dies before any pack byte (it lists everything first): pack-objects' death
        if (error instanceof TreeDepthError) throw new PackObjectsError(error.message);
        throw error;
      }
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
      const commit = await commits.load(oid).catch(() => undefined);
      if (commit) {
        return { parents: commit.parents, time: commit.committer.timestamp, tree: commit.tree };
      }
      // a commit the typed store cannot parse (an author line fsck refuses): git walks it
      return lenientObject(oid, "commit", lenientCommitHeader);
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

    async loadObject(
      oid: string,
    ): Promise<{ type: GitObjectTypeName; content: Uint8Array } | undefined> {
      const objects = history.objects;
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

    async abbrevLengths(ids: readonly string[], minLength: number): Promise<Map<string, number>> {
      if (!history.objects) {
        const fixed = minLength < 0 ? 7 : minLength === 0 ? 40 : Math.min(minLength, 40);
        return new Map(ids.map((id) => [id, fixed]));
      }
      return findAbbrevLengths(history.objects, ids, minLength);
    },

    async getTagInfo(oid: string): Promise<TagTargetInfo | undefined> {
      try {
        const tag = await tags.load(oid);
        if (tag) return { object: tag.object, type: OBJECT_TYPE_NAMES[tag.objectType] ?? "commit" };
      } catch {
        // a tag the typed store cannot parse: read as git's parse_tag_buffer reads it
      }
      return lenientObject(oid, "tag", lenientTagTarget);
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

  // receive.shallowUpdate: the accepted shallow commits join the repository's shallow list
  const setShallow = refs.setShallow?.bind(refs);
  if (setShallow) {
    facade.updateShallow = async (oids) => {
      const current = (await refs.getShallow?.()) ?? [];
      await setShallow(new Set([...current, ...oids]), current);
    };
  }
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

/** dir.c's PATTERN_MAX_FILE_SIZE: a pattern blob larger than this is ignored (100 MiB). */
const PATTERN_MAX_FILE_SIZE = 100 * 1024 * 1024;

/**
 * A revision as git's get_oid reads it (`resolveRevision`: a full id first, refs by git's
 * short-name rules, an abbreviated id, `~`/`^`/`^{type}` suffixes), hex in any case.
 */
async function resolveRevisionOf(
  history: History,
  facade: RepositoryFacade,
  rev: string,
): Promise<string | undefined> {
  // get_oid_hex takes either case; a full id wins over a ref of that name
  const lower = /^[0-9a-fA-F]+$/.test(rev) ? rev.toLowerCase() : undefined;
  if (lower?.length === 40) return (await facade.has(lower)) ? lower : undefined;
  const refs = new Map<string, string>();
  let head: string | undefined;
  for await (const ref of history.refs.list()) {
    const resolved = isSymbolicRef(ref)
      ? await history.refs.resolve(ref.name).catch(() => undefined)
      : ref;
    if (!resolved || !("objectId" in resolved) || !resolved.objectId) continue;
    refs.set(ref.name, resolved.objectId);
  }
  const headRef = await history.refs.resolve("HEAD").catch(() => undefined);
  if (headRef && "objectId" in headRef && headRef.objectId) head = headRef.objectId;
  const source = { refs, ...(head ? { head: { oid: head } } : {}), repository: facade };
  const found = await resolveRevision(rev, source);
  if (found !== undefined || lower === undefined || lower === rev) return found;
  // an abbreviated id in upper case: no ref matched it as written
  return resolveRevision(lower, source);
}

/**
 * The blob a `sparse:oid=` filter names, as git's `get_oid_with_context` reads the common
 * forms: a revision (see {@link resolveRevisionOf}), or `<rev>:<path>` (the revision peeled
 * to its tree, the path looked up in it). Undefined when it names nothing.
 */
async function resolveBlobName(
  history: History,
  facade: RepositoryFacade,
  name: string,
): Promise<string | undefined> {
  const colon = name.indexOf(":");
  if (colon < 0) return resolveRevisionOf(history, facade, name);
  const rev = name.slice(0, colon);
  const path = name.slice(colon + 1);
  // `:<path>` names an index entry, which a served repository does not read
  if (rev === "") return undefined;
  let id = await resolveRevisionOf(history, facade, `${rev}^{tree}`);
  if (id === undefined) return undefined;
  for (const part of path.split("/").filter((p) => p.length > 0)) {
    const tree = await history.trees.load(id).catch(() => undefined);
    if (!tree) return undefined;
    let next: string | undefined;
    for await (const entry of tree) {
      if (entry.name === part) next = entry.id;
    }
    if (next === undefined) return undefined;
    id = next;
  }
  return id;
}
