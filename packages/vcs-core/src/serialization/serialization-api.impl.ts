/**
 * SerializationApi implementation
 *
 * Wraps existing pack and compression utilities to provide the SerializationApi interface.
 * Uses the History interface for accessing typed object stores.
 */

import { deflate } from "@statewalker/vcs-utils";
import type { ObjectId } from "../common/id/index.js";
import type { Blobs } from "../history/blobs/blobs.js";
import {
  collectCommitBytes,
  commitToEntries,
  decodeCommitEntries,
  encodeCommitEntries,
  entriesToCommit,
  parseCommitFromBytes,
} from "../history/commits/commit-format.js";
import type { Commits } from "../history/commits/commits.js";
import type { History } from "../history/history.js";
import type { GitObjects } from "../history/objects/git-objects.js";
import type { ObjectTypeString } from "../history/objects/object-types.js";
import {
  collectTagBytes,
  decodeTagEntries,
  encodeTagEntries,
  entriesToTag,
  parseTagFromBytes,
  tagToEntries,
} from "../history/tags/tag-format.js";
import type { Tags } from "../history/tags/tags.js";
import {
  collectTreeBytes,
  decodeTreeEntries,
  encodeTreeEntries,
  parseTreeFromBytes,
} from "../history/trees/tree-format.js";
import type { Trees } from "../history/trees/trees.js";
import {
  importPack,
  type ListedObject,
  listObjects,
  type PackSet,
  type UnpackTarget,
  type WritePackOptions,
  writePack,
} from "../pack/index.js";
import type {
  ExportOptions,
  PackImportResult,
  PackOptions,
  SerializationApi,
} from "./serialization-api.js";
import { typedStoreObjects } from "./typed-store-objects.js";

/**
 * Configuration for DefaultSerializationApi
 */
export interface SerializationApiConfig {
  /**
   * History stores for object access
   *
   * Only requires the object stores (blobs, trees, commits, tags).
   * Accepts a full History instance or just the required stores.
   */
  history: Pick<History, "blobs" | "trees" | "commits" | "tags"> &
    Partial<Pick<History, "objects" | "packs">>;

  /**
   * The object kernel received packs are written through. Defaults to `history.objects`; a
   * history without one (stores of parsed objects) is written through its typed stores, which
   * refuse objects they cannot store under their own id.
   */
  objects?: GitObjects;

  /** Where large received packs are kept. Defaults to `history.packs`; without it packs are unpacked. */
  packs?: PackSet;

  /** Packs with at least this many objects are kept when there are `packs` (git's transfer.unpackLimit, 100). */
  unpackLimit?: number;
}

/**
 * Default implementation of SerializationApi
 *
 * Uses existing pack utilities and compression functions.
 */
export class DefaultSerializationApi implements SerializationApi {
  /** Blob storage interface (new interface) */
  private readonly _blobs: Blobs;
  /** Tree storage interface (new interface) */
  private readonly _trees: Trees;
  /** Commit storage interface (new interface) */
  private readonly _commits: Commits;
  /** Tag storage interface (new interface) */
  private readonly _tags: Tags;
  /** The object kernel received packs are written through */
  private readonly objects: UnpackTarget;
  /** Where large received packs are kept, if anywhere */
  private readonly packs?: PackSet;
  private readonly unpackLimit?: number;

  constructor(config: SerializationApiConfig) {
    this._blobs = config.history.blobs;
    this._trees = config.history.trees;
    this._commits = config.history.commits;
    this._tags = config.history.tags;
    this.objects =
      config.objects ??
      config.history.objects ??
      typedStoreObjects({
        has: async (id) =>
          (await this._commits.has(id)) ||
          (await this._trees.has(id)) ||
          (await this._tags.has(id)) ||
          (await this._blobs.has(id)),
        exportObject: (id) => this.exportObject(id),
        importObject: (type, content) => this.importObject(type, content),
        reencode: (type, data) => reencode(type, data),
      });
    this.packs = config.packs ?? config.history.packs;
    this.unpackLimit = config.unpackLimit;
  }

  /**
   * Serialize an object to Git loose format: the kernel's raw object, deflated as it streams
   */
  async *serializeLooseObject(id: ObjectId): AsyncIterable<Uint8Array> {
    if (!(await this.objects.has(id))) throw new Error(`Object not found: ${id}`);
    yield* deflate(this.objects.getRaw(id), { raw: false });
  }

  /**
   * Create a pack file from objects, through `writePack`
   */
  async *createPack(
    objects: AsyncIterable<ObjectId>,
    options?: PackOptions,
  ): AsyncIterable<Uint8Array> {
    const ids: ObjectId[] = [];
    for await (const id of objects) ids.push(id);
    yield* writePack(this.objects, ids, this.writeOptions(options));
  }

  /**
   * The pack of what `wants` reach and `haves` do not: `listObjects`, then `writePack`
   */
  async *exportPack(
    wants: Iterable<ObjectId>,
    haves: Iterable<ObjectId>,
    options: ExportOptions = {},
  ): AsyncIterable<Uint8Array> {
    const listed: ListedObject[] = [];
    const boundary: ListedObject[] = [];
    for await (const o of listObjects(this.objects, {
      wants,
      haves,
      shallow: options.shallow,
      onBoundary: options.thinPack ? (b) => boundary.push(b) : undefined,
    })) {
      listed.push(o);
    }
    yield* writePack(this.objects, listed, {
      ...this.writeOptions(options),
      ...(options.thinPack ? { thin: true, haves: boundary } : {}),
    });
  }

  private writeOptions(options: PackOptions = {}): WritePackOptions {
    const reuse = options.reuse ?? true;
    return {
      packs: reuse ? this.packs : undefined,
      deltaSearch:
        options.useDelta === false
          ? false
          : options.maxChainDepth !== undefined
            ? { depth: options.maxChainDepth }
            : true,
      ofsDelta: options.ofsDelta ?? true,
    };
  }

  /**
   * Import objects from a pack stream, byte for byte, through `importPack`.
   */
  async importPack(pack: AsyncIterable<Uint8Array>): Promise<PackImportResult> {
    const r = await importPack(this.objects, pack, {
      packs: this.packs,
      unpackLimit: this.unpackLimit,
    });
    return {
      objectsImported: r.count,
      blobsWithDelta: 0,
      treesImported: r.types.tree,
      commitsImported: r.types.commit,
      tagsImported: r.types.tag,
      packId: r.kept?.packId,
    };
  }

  /**
   * Export single object
   */
  async exportObject(
    id: ObjectId,
  ): Promise<{ type: ObjectTypeString; content: AsyncIterable<Uint8Array> }> {
    // Check structured types first — their load() methods validate the type
    // header, so they work correctly even when all objects share the same
    // storage (e.g. file-backed .git/objects).  Blobs are checked last
    // because blobs.has() cannot discriminate types in shared storage.
    const commit = await this._commits.load(id);
    if (commit) {
      return { type: "commit", content: this.serializeCommit(id) };
    }

    const tree = await this._trees.load(id);
    if (tree) {
      return { type: "tree", content: this.serializeTree(id) };
    }

    const tag = await this._tags.load(id);
    if (tag) {
      return { type: "tag", content: this.serializeTag(id) };
    }

    if (await this._blobs.has(id)) {
      const content = await this._blobs.load(id);
      if (!content) throw new Error(`Blob not found: ${id}`);
      return { type: "blob", content };
    }

    throw new Error(`Object not found: ${id}`);
  }

  /**
   * Import single object
   */
  async importObject(
    type: ObjectTypeString,
    content: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  ): Promise<ObjectId> {
    switch (type) {
      case "blob":
        return this._blobs.store(content);
      case "tree":
        return this.storeTreeFromStream(content);
      case "commit":
        return this.storeCommitFromStream(content);
      case "tag":
        return this.storeTagFromStream(content);
      default:
        throw new Error(`Unknown object type: ${type}`);
    }
  }

  // ============ Private helpers ============

  private async *serializeTree(id: ObjectId): AsyncIterable<Uint8Array> {
    const tree = await this._trees.load(id);
    if (!tree) throw new Error(`Tree not found: ${id}`);
    yield* encodeTreeEntries(tree);
  }

  private async *serializeCommit(id: ObjectId): AsyncIterable<Uint8Array> {
    const commit = await this._commits.load(id);
    if (!commit) throw new Error(`Commit not found: ${id}`);
    yield* encodeCommitEntries(commitToEntries(commit));
  }

  private async *serializeTag(id: ObjectId): AsyncIterable<Uint8Array> {
    const tag = await this._tags.load(id);
    if (!tag) throw new Error(`Tag not found: ${id}`);
    yield* encodeTagEntries(tagToEntries(tag));
  }

  private async storeTreeFromStream(
    content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  ): Promise<ObjectId> {
    const entries = decodeTreeEntries(content);
    return await this._trees.store(entries);
  }

  private async storeCommitFromStream(
    content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  ): Promise<ObjectId> {
    const commit = await entriesToCommit(decodeCommitEntries(content));
    return this._commits.store(commit);
  }

  private async storeTagFromStream(
    content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  ): Promise<ObjectId> {
    const tag = await entriesToTag(decodeTagEntries(content));
    return this._tags.store(tag);
  }
}

/** The content typed stores keep for `data`: parsed, then encoded again (blobs as they are). */
async function reencode(type: ObjectTypeString, data: Uint8Array): Promise<Uint8Array> {
  switch (type) {
    case "blob":
      return data;
    case "tree":
      return collectTreeBytes(await parseTreeFromBytes(data));
    case "commit":
      return collectCommitBytes(await parseCommitFromBytes(data));
    case "tag":
      return collectTagBytes(await parseTagFromBytes(data));
  }
}
