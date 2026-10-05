/**
 * File-based RefStore implementation
 *
 * Stores refs as files in the .git/refs directory structure.
 * Supports both loose refs and packed-refs.
 */

import type {
  FilesApi,
  ObjectId,
  Ref,
  ReflogReader,
  RefStore,
  RefUpdateResult,
  SymbolicRef,
} from "@statewalker/vcs-core";

import { packRefs } from "./packed-refs-writer.js";
import { readAllRefs, readRef, resolveRef } from "./ref-reader.js";
import {
  createRefsStructure,
  deleteRef,
  updateRef,
  writeObjectRef,
  writeSymbolicRef,
} from "./ref-writer.js";
import { createReflogReader } from "./reflog-reader.js";
import { hasReflog } from "./reflog-writer.js";

/**
 * File-based RefStore implementation
 *
 * Uses the standard Git refs directory structure:
 * - .git/refs/heads/* for branches
 * - .git/refs/tags/* for tags
 * - .git/refs/remotes/* for remote tracking branches
 * - .git/packed-refs for packed refs
 */
export class FileRefStore implements RefStore {
  constructor(
    private readonly files: FilesApi,
    private readonly gitDir: string,
  ) {}

  /**
   * Read a ref by exact name
   */
  async get(refName: string): Promise<Ref | SymbolicRef | undefined> {
    return readRef(this.files, this.gitDir, refName);
  }

  /**
   * Resolve a ref to its final object ID (follows symbolic refs)
   */
  async resolve(refName: string): Promise<Ref | undefined> {
    return resolveRef(this.files, this.gitDir, refName);
  }

  /**
   * Check if a ref exists
   */
  async has(refName: string): Promise<boolean> {
    const ref = await this.get(refName);
    return ref !== undefined;
  }

  /**
   * List all refs matching a prefix
   */
  async *list(prefix?: string): AsyncIterable<Ref | SymbolicRef> {
    const allRefs = await readAllRefs(this.files, this.gitDir, prefix ?? "");
    for (const ref of allRefs) {
      yield ref;
    }
  }

  /**
   * Set a ref to point to an object ID
   */
  async set(refName: string, objectId: ObjectId): Promise<void> {
    await writeObjectRef(this.files, this.gitDir, refName, objectId);
  }

  /**
   * Set a symbolic ref
   */
  async setSymbolic(refName: string, target: string): Promise<void> {
    await writeSymbolicRef(this.files, this.gitDir, refName, target);
  }

  /**
   * Delete a ref
   */
  async delete(refName: string): Promise<boolean> {
    return deleteRef(this.files, this.gitDir, refName);
  }

  /**
   * Compare-and-swap update (for concurrent safety)
   */
  async compareAndSwap(
    refName: string,
    expectedOld: ObjectId | undefined,
    newValue: ObjectId,
  ): Promise<RefUpdateResult> {
    const resolved = await this.resolve(refName);
    const currentValue = resolved?.objectId;

    if (currentValue !== expectedOld) {
      return {
        success: false,
        previousValue: currentValue,
        errorMessage: expectedOld
          ? `Expected ${expectedOld}, found ${currentValue ?? "nothing"}`
          : `Ref already exists with value ${currentValue}`,
      };
    }

    const success = await updateRef(this.files, this.gitDir, refName, expectedOld, newValue);
    return {
      success,
      previousValue: expectedOld,
    };
  }

  /**
   * Initialize storage structure
   */
  async initialize(): Promise<void> {
    await createRefsStructure(this.files, this.gitDir);
  }

  /**
   * Pack loose refs into packed-refs file
   */
  async optimize(): Promise<void> {
    // Get all loose refs to pack
    const refs = await readAllRefs(this.files, this.gitDir, "refs/");
    const refNames = refs.map((r) => r.name);
    if (refNames.length > 0) {
      await packRefs(this.files, this.gitDir, refNames, true);
    }
  }

  /**
   * Get reflog reader for a ref
   */
  async getReflog(refName: string): Promise<ReflogReader | undefined> {
    const exists = await hasReflog(this.files, this.gitDir, refName);
    if (!exists) {
      return undefined;
    }
    return createReflogReader(this.files, this.gitDir, refName);
  }

  /**
   * Pack loose refs into packed-refs file
   */
  async packRefs(
    refNames: string[],
    options?: { all?: boolean; deleteLoose?: boolean },
  ): Promise<void> {
    const deleteLoose = options?.deleteLoose ?? true;

    if (options?.all) {
      // Pack all refs
      const refs = await readAllRefs(this.files, this.gitDir, "refs/");
      const allRefNames = refs.map((r) => r.name);
      if (allRefNames.length > 0) {
        await packRefs(this.files, this.gitDir, allRefNames, deleteLoose);
      }
    } else if (refNames.length > 0) {
      // Pack specific refs
      await packRefs(this.files, this.gitDir, refNames, deleteLoose);
    }
  }
}

/**
 * Create a file-based ref store
 */
export function createFileRefStore(files: FilesApi, gitDir: string): FileRefStore {
  return new FileRefStore(files, gitDir);
}
