/**
 * Storage adapter for RepositoryAccess interface.
 *
 * Adapts GitStorage from @statewalker/vcs-core to the
 * RepositoryAccess interface used by protocol handlers.
 */

import type {
  HeadInfo,
  ObjectId,
  ObjectInfo,
  ObjectTypeCode,
  RefInfo,
  RepositoryAccess,
} from "@statewalker/vcs-transport";

/**
 * Minimal storage interface matching GitStorage.
 * This allows the adapter to work with any storage implementation.
 */
export interface MinimalStorage {
  refs: {
    list(): AsyncIterable<{ name: string; objectId?: string }>;
    get(name: string): Promise<{ objectId?: string; target?: string } | null>;
    set(name: string, objectId: string): Promise<void>;
    delete(name: string): Promise<boolean>;
    /**
     * Compare-and-swap update for concurrent safety (optional).
     *
     * If provided, enables atomic ref updates that only succeed
     * when the current value matches the expected old value.
     */
    compareAndSwap?(
      refName: string,
      expectedOld: string | undefined,
      newValue: string,
    ): Promise<{ success: boolean; previousValue?: string }>;
  };

  rawStorage: {
    has(id: string): Promise<boolean>;
    getSize(id: string): Promise<number>;
    load(id: string): AsyncIterable<Uint8Array>;
    store(data: AsyncIterable<Uint8Array> | Iterable<Uint8Array>): Promise<string>;
  };

  getHead(): Promise<string | null>;

  commits: {
    loadCommit(id: string): Promise<{
      tree: string;
      parents: string[];
      author: unknown;
      committer: unknown;
      message: string;
    }>;
  };

  trees: {
    loadTree(id: string): AsyncIterable<{ name: string; mode: number; id: string }>;
  };
}

/**
 * Create a RepositoryAccess adapter from storage.
 *
 * @param storage - Storage implementation
 * @returns RepositoryAccess interface
 */
export function createStorageAdapter(storage: MinimalStorage): RepositoryAccess {
  return {
    async *listRefs(): AsyncIterable<RefInfo> {
      for await (const ref of storage.refs.list()) {
        if (ref.objectId) {
          yield {
            name: ref.name,
            objectId: ref.objectId,
          };
        }
      }
    },

    async getHead(): Promise<HeadInfo | null> {
      const head = await storage.refs.get("HEAD");
      if (!head) {
        return null;
      }
      return {
        objectId: head.objectId,
        target: head.target,
      };
    },

    async hasObject(id: ObjectId): Promise<boolean> {
      return storage.rawStorage.has(id);
    },

    async getObjectInfo(id: ObjectId): Promise<ObjectInfo | null> {
      const size = await storage.rawStorage.getSize(id);
      if (size < 0) {
        return null;
      }

      // We need to read the object to determine type
      // This is inefficient but necessary without type-aware storage
      const chunks: Uint8Array[] = [];
      for await (const chunk of storage.rawStorage.load(id)) {
        chunks.push(chunk);
        // We only need the header to determine type
        break;
      }

      if (chunks.length === 0) {
        return null;
      }

      // Parse Git object header to get type
      const type = parseObjectType(chunks[0]);
      if (!type) {
        return null;
      }

      return { type, size };
    },

    async *loadObject(id: ObjectId): AsyncIterable<Uint8Array> {
      yield* storage.rawStorage.load(id);
    },

    async storeObject(type: ObjectTypeCode, content: Uint8Array): Promise<ObjectId> {
      // Create Git object with header
      const typeStr = typeCodeToName(type);
      const header = new TextEncoder().encode(`${typeStr} ${content.length}\0`);
      const fullData = new Uint8Array(header.length + content.length);
      fullData.set(header, 0);
      fullData.set(content, header.length);

      return storage.rawStorage.store([fullData]);
    },

    async updateRef(
      name: string,
      oldId: ObjectId | null,
      newId: ObjectId | null,
    ): Promise<boolean> {
      if (newId === null) {
        // Delete ref - check oldId if provided
        if (oldId !== null) {
          const current = await storage.refs.get(name);
          const currentId = current?.objectId;
          if (currentId !== oldId) {
            // Ref has changed since oldId was read
            return false;
          }
        }
        return storage.refs.delete(name);
      }

      // Use compare-and-swap if available for atomic updates
      if (storage.refs.compareAndSwap) {
        const result = await storage.refs.compareAndSwap(name, oldId ?? undefined, newId);
        return result.success;
      }

      // Fallback: non-atomic check-then-set
      // This is racy but better than no check at all
      if (oldId !== null) {
        const current = await storage.refs.get(name);
        const currentId = current?.objectId;
        if (currentId !== oldId) {
          // Ref has changed since oldId was read
          return false;
        }
      }

      await storage.refs.set(name, newId);
      return true;
    },

    async *walkObjects(
      wants: ObjectId[],
      haves: ObjectId[],
    ): AsyncIterable<{ id: ObjectId; type: ObjectTypeCode; content: Uint8Array }> {
      const haveSet = new Set(haves);
      const seen = new Set<string>();

      async function* collectObject(
        id: string,
        storage: MinimalStorage,
      ): AsyncGenerator<{ id: ObjectId; type: ObjectTypeCode; content: Uint8Array }> {
        if (seen.has(id) || haveSet.has(id)) {
          return;
        }
        seen.add(id);

        // Load raw object
        const chunks: Uint8Array[] = [];
        for await (const chunk of storage.rawStorage.load(id)) {
          chunks.push(chunk);
        }
        const rawData = concatBytes(chunks);

        // Parse header to get type and content
        const { type, content } = parseGitObject(rawData);

        yield { id, type, content };

        // Recursively collect referenced objects
        if (type === 1) {
          // Commit
          try {
            const commit = await storage.commits.loadCommit(id);
            yield* collectObject(commit.tree, storage);
            for (const parent of commit.parents) {
              yield* collectObject(parent, storage);
            }
          } catch {
            // Ignore errors loading commit details
          }
        } else if (type === 2) {
          // Tree
          try {
            for await (const entry of storage.trees.loadTree(id)) {
              yield* collectObject(entry.id, storage);
            }
          } catch {
            // Ignore errors loading tree entries
          }
        }
      }

      for (const wantId of wants) {
        yield* collectObject(wantId, storage);
      }
    },
  };
}

/**
 * Parse Git object type from raw object data.
 */
function parseObjectType(data: Uint8Array): ObjectTypeCode | null {
  // Find space after type
  let spaceIdx = -1;
  for (let i = 0; i < Math.min(data.length, 10); i++) {
    if (data[i] === 0x20) {
      // space
      spaceIdx = i;
      break;
    }
  }

  if (spaceIdx < 0) {
    return null;
  }

  const typeStr = new TextDecoder().decode(data.subarray(0, spaceIdx));

  switch (typeStr) {
    case "commit":
      return 1;
    case "tree":
      return 2;
    case "blob":
      return 3;
    case "tag":
      return 4;
    default:
      return null;
  }
}

/**
 * Parse Git object to extract type and content.
 */
function parseGitObject(data: Uint8Array): { type: ObjectTypeCode; content: Uint8Array } {
  // Find null byte after header
  let nullIdx = -1;
  for (let i = 0; i < Math.min(data.length, 32); i++) {
    if (data[i] === 0x00) {
      nullIdx = i;
      break;
    }
  }

  if (nullIdx < 0) {
    throw new Error("Invalid Git object: no header null byte");
  }

  const header = new TextDecoder().decode(data.subarray(0, nullIdx));
  const spaceIdx = header.indexOf(" ");
  if (spaceIdx < 0) {
    throw new Error("Invalid Git object header");
  }

  const typeStr = header.substring(0, spaceIdx);
  const type = typeStrToCode(typeStr);

  return {
    type,
    content: data.subarray(nullIdx + 1),
  };
}

/**
 * Convert type string to code.
 */
function typeStrToCode(typeStr: string): ObjectTypeCode {
  switch (typeStr) {
    case "commit":
      return 1;
    case "tree":
      return 2;
    case "blob":
      return 3;
    case "tag":
      return 4;
    default:
      throw new Error(`Unknown object type: ${typeStr}`);
  }
}

/**
 * Convert type code to name.
 */
function typeCodeToName(type: ObjectTypeCode): string {
  switch (type) {
    case 1:
      return "commit";
    case 2:
      return "tree";
    case 3:
      return "blob";
    case 4:
      return "tag";
    default:
      throw new Error(`Unknown type code: ${type}`);
  }
}

/**
 * Concatenate byte arrays.
 */
function concatBytes(arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}
