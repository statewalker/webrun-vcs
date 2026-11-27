/**
 * Synchronization utilities for dual-store architecture
 *
 * These utilities enable data transfer between:
 * - Git-compatible streaming stores (for Git interop/transport)
 * - Native SQL stores (for queries and application logic)
 *
 * Both store types produce identical Git object IDs, so synchronization
 * is straightforward - load from source, store to destination.
 */

import { decodeTreeBytes, type History, type ObjectId } from "@statewalker/vcs-core";
import type { SqlNativeStores } from "./native/types.js";

/**
 * Object type for synchronization
 */
export type SyncObjectType = "commit" | "tree" | "blob" | "tag";

/**
 * Object reference for synchronization
 */
export interface SyncObject {
  id: ObjectId;
  type: SyncObjectType;
}

/**
 * Import Git objects into native SQL store format
 *
 * Use after fetching from remote Git repository to populate
 * the native stores with queryable data.
 *
 * Since both stores compute identical Git object IDs, the resulting
 * IDs in the native store will match the source.
 *
 * @param gitStores Source stores with Git-formatted objects
 * @param nativeStores Target stores with native format
 * @param objects Object IDs with their types to import
 * @returns Count of objects imported (skips existing)
 *
 * @example
 * ```typescript
 * const gitStores = createStreamingSqlStores(db);
 * const nativeStores = createSqlNativeStores(db);
 *
 * // After fetching objects from remote
 * const imported = await importToNative(
 *   gitStores,
 *   nativeStores,
 *   objects
 * );
 * console.log(`Imported ${imported} objects`);
 * ```
 */
export async function importToNative(
  gitStores: History,
  nativeStores: SqlNativeStores,
  objects: AsyncIterable<SyncObject>,
): Promise<number> {
  let count = 0;

  for await (const { id, type } of objects) {
    switch (type) {
      case "commit": {
        // Skip if already exists
        if (await nativeStores.commits.has(id)) continue;

        await copyCommitOrTag("Commit", id, gitStores.commits, nativeStores.commits);
        count++;
        break;
      }

      case "tree": {
        // Skip if already exists
        if (await nativeStores.trees.has(id)) continue;

        // Load entries from Git store, modes as stored (`load` reads them canonical, which
        // would store another tree)
        const raw = await gitStores.trees.raw?.(id);
        const entries = raw ? decodeTreeBytes(raw) : await gitStores.trees.load(id);
        if (!entries) throw new Error(`Tree not found: ${id}`);
        await nativeStores.trees.store(entries);
        count++;
        break;
      }

      case "blob": {
        // Skip if already exists
        if (await nativeStores.blobs.has(id)) continue;

        // Load content from Git store
        // With the size, the target stores the blob in one pass.
        const size = await gitStores.blobs.size(id);
        const content = await gitStores.blobs.load(id);
        if (!content || size < 0) throw new Error(`Blob not found: ${id}`);
        await nativeStores.blobs.store(content, size);
        count++;
        break;
      }

      case "tag": {
        // Skip if already exists
        if (await nativeStores.tags.has(id)) continue;

        await copyCommitOrTag("Tag", id, gitStores.tags, nativeStores.tags);
        count++;
        break;
      }
    }
  }

  return count;
}

/**
 * Export native store objects to Git format
 *
 * Use before pushing to remote Git repository to ensure all
 * objects are available in Git-compatible format.
 *
 * Since native stores compute Git-compatible IDs during storage,
 * the IDs are already known - we just load and re-store.
 *
 * @param nativeStores Source stores with native format
 * @param gitStores Target stores with Git-formatted objects
 * @param objects Object IDs with their types to export
 * @returns Count of objects exported (skips existing)
 *
 * @example
 * ```typescript
 * const nativeStores = createSqlNativeStores(db);
 * const gitStores = createStreamingSqlStores(db);
 *
 * // Before pushing to remote
 * const exported = await exportToGit(
 *   nativeStores,
 *   gitStores,
 *   objects
 * );
 * console.log(`Exported ${exported} objects`);
 * ```
 */
export async function exportToGit(
  nativeStores: SqlNativeStores,
  gitStores: History,
  objects: AsyncIterable<SyncObject>,
): Promise<number> {
  let count = 0;

  for await (const { id, type } of objects) {
    switch (type) {
      case "commit": {
        // Skip if already exists in Git store
        if (await gitStores.commits.has(id)) continue;

        await copyCommitOrTag("Commit", id, nativeStores.commits, gitStores.commits);
        count++;
        break;
      }

      case "tree": {
        // Skip if already exists in Git store
        if (await gitStores.trees.has(id)) continue;

        // Load entries from native store, modes as stored (`load` reads them canonical,
        // which would store another tree for one holding a 100664 blob)
        const raw = await nativeStores.trees.raw?.(id);
        const entries = raw ? decodeTreeBytes(raw) : await nativeStores.trees.load(id);
        if (!entries) throw new Error(`Tree not found: ${id}`);
        const stored = await gitStores.trees.store(entries);
        if (stored !== id) {
          throw new Error(`Tree ${id} cannot be exported as stored: it was written as ${stored}`);
        }
        count++;
        break;
      }

      case "blob": {
        // Skip if already exists in Git store
        if (await gitStores.blobs.has(id)) continue;

        // Load content from native store
        // With the size, the target stores the blob in one pass.
        const size = await nativeStores.blobs.size(id);
        const content = await nativeStores.blobs.load(id);
        if (!content || size < 0) throw new Error(`Blob not found: ${id}`);
        await gitStores.blobs.store(content, size);
        count++;
        break;
      }

      case "tag": {
        // Skip if already exists in Git store
        if (await gitStores.tags.has(id)) continue;

        await copyCommitOrTag("Tag", id, nativeStores.tags, gitStores.tags);
        count++;
        break;
      }
    }
  }

  return count;
}

/** The part of `Commits`/`Tags` a copy uses. */
interface CopyableStore<T> {
  load(id: ObjectId): Promise<T | undefined>;
  store(value: T): Promise<ObjectId>;
  raw?(id: ObjectId): Promise<Uint8Array | undefined>;
  storeRaw?(content: Uint8Array): Promise<ObjectId>;
}

/**
 * Copies a commit or tag byte for byte when the source gives its bytes and the target takes
 * them (`raw`/`storeRaw`: extra headers and bytes that are not UTF-8 survive), else as the parsed
 * object; refuses one that would be written under another id.
 */
async function copyCommitOrTag<T>(
  kind: "Commit" | "Tag",
  id: ObjectId,
  from: CopyableStore<T>,
  to: CopyableStore<T>,
): Promise<void> {
  const raw = to.storeRaw ? await from.raw?.(id) : undefined;
  let stored: ObjectId;
  if (raw && to.storeRaw) {
    stored = await to.storeRaw(raw);
  } else {
    const value = await from.load(id);
    if (!value) throw new Error(`${kind} not found: ${id}`);
    stored = await to.store(value);
  }
  if (stored !== id) {
    throw new Error(`${kind} ${id} cannot be copied as stored: it was written as ${stored}`);
  }
}

/**
 * Create sync object iterator from object IDs with type
 *
 * Helper function to create the objects parameter for sync functions.
 *
 * @param ids Object IDs to sync
 * @param type Object type for all IDs
 * @returns Async iterable of SyncObject
 */
export async function* syncObjects(
  ids: Iterable<ObjectId> | AsyncIterable<ObjectId>,
  type: SyncObjectType,
): AsyncIterable<SyncObject> {
  if (Symbol.asyncIterator in ids) {
    for await (const id of ids as AsyncIterable<ObjectId>) {
      yield { id, type };
    }
  } else {
    for (const id of ids as Iterable<ObjectId>) {
      yield { id, type };
    }
  }
}

/**
 * Combine multiple sync object sources
 *
 * Helper function to sync multiple object types at once.
 *
 * @param sources Async iterables of SyncObject
 * @returns Combined async iterable
 */
export async function* combineSyncSources(
  ...sources: AsyncIterable<SyncObject>[]
): AsyncIterable<SyncObject> {
  for (const source of sources) {
    yield* source;
  }
}
