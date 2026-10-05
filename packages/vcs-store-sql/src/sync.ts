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

import type { History, ObjectId } from "@statewalker/vcs-core";
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

        // Load from Git store and convert to Commit object
        const commit = await gitStores.commits.load(id);
        if (!commit) throw new Error(`Commit not found: ${id}`);
        await (nativeStores.commits as any).store(commit);
        count++;
        break;
      }

      case "tree": {
        // Skip if already exists
        if (await nativeStores.trees.has(id)) continue;

        // Load entries from Git store
        const entries = await gitStores.trees.load(id);
        if (!entries) throw new Error(`Tree not found: ${id}`);
        await nativeStores.trees.store(entries);
        count++;
        break;
      }

      case "blob": {
        // Skip if already exists
        if (await nativeStores.blobs.has(id)) continue;

        // Load content from Git store
        const content = await gitStores.blobs.load(id);
        if (!content) throw new Error(`Blob not found: ${id}`);
        await nativeStores.blobs.store(content);
        count++;
        break;
      }

      case "tag": {
        // Skip if already exists
        if (await nativeStores.tags.has(id)) continue;

        // Load from Git store and convert to AnnotatedTag object
        const tag = await gitStores.tags.load(id);
        if (!tag) throw new Error(`Tag not found: ${id}`);
        await nativeStores.tags.store(tag);
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

        // Load from native store and store to Git store
        const commit = await (nativeStores.commits as any).load(id);
        if (!commit) throw new Error(`Commit not found: ${id}`);
        await gitStores.commits.store(commit);
        count++;
        break;
      }

      case "tree": {
        // Skip if already exists in Git store
        if (await gitStores.trees.has(id)) continue;

        // Load entries from native store
        const entries = await (nativeStores.trees as any).load(id);
        if (!entries) throw new Error(`Tree not found: ${id}`);
        await (gitStores.trees as any).store(entries);
        count++;
        break;
      }

      case "blob": {
        // Skip if already exists in Git store
        if (await gitStores.blobs.has(id)) continue;

        // Load content from native store
        const content = await nativeStores.blobs.load(id);
        if (!content) throw new Error(`Blob not found: ${id}`);
        await gitStores.blobs.store(content);
        count++;
        break;
      }

      case "tag": {
        // Skip if already exists in Git store
        if (await gitStores.tags.has(id)) continue;

        // Load from native store and store to Git store
        const tag = await (nativeStores.tags as any).load(id);
        if (!tag) throw new Error(`Tag not found: ${id}`);
        await (gitStores.tags as any).store(tag);
        count++;
        break;
      }
    }
  }

  return count;
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
