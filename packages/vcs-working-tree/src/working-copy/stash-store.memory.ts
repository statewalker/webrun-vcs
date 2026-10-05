/**
 * In-memory StashStore implementation for testing.
 *
 * Provides fast, isolated stash storage without filesystem access.
 * All state is stored in memory and lost when the instance is destroyed.
 */

import type { ObjectId } from "@statewalker/vcs-core";
import type { StashEntry, StashPushOptions, StashStore } from "../working-copy.js";

/**
 * Generate a test object ID for stash commits.
 * Creates a consistent hash-like string for testing purposes.
 */
function generateTestObjectId(): ObjectId {
  const timestamp = Date.now().toString(16).padStart(12, "0");
  const random = Math.random().toString(16).substring(2, 30);
  return (timestamp + random).padEnd(40, "0").substring(0, 40);
}

/**
 * In-memory implementation of StashStore.
 *
 * Stores stash entries in an array, maintaining proper ordering
 * (most recent first). Useful for unit tests where filesystem
 * access is not desired.
 */
export class MemoryStashStore implements StashStore {
  private entries: StashEntry[] = [];

  /**
   * List all stash entries.
   * Entries are yielded in order with stash@{0} first.
   */
  async *list(): AsyncIterable<StashEntry> {
    for (const entry of this.entries) {
      yield entry;
    }
  }

  /**
   * Push current changes to stash.
   * In memory implementation, creates a placeholder commit ID.
   */
  async push(messageOrOptions?: string | StashPushOptions): Promise<ObjectId> {
    // Parse options
    const options: StashPushOptions =
      typeof messageOrOptions === "string"
        ? { message: messageOrOptions }
        : (messageOrOptions ?? {});

    const commitId = generateTestObjectId();
    const entry: StashEntry = {
      index: 0,
      commitId,
      message: options.message ?? "WIP on branch",
      timestamp: Date.now(),
    };

    // Increment index of existing entries
    this.entries = this.entries.map((e) => ({
      ...e,
      index: e.index + 1,
    }));

    // Add new entry at front
    this.entries.unshift(entry);

    return commitId;
  }

  /**
   * Pop most recent stash entry.
   * Applies stash@{0} and removes it.
   */
  async pop(): Promise<void> {
    await this.apply(0);
    await this.drop(0);
  }

  /**
   * Apply stash entry without removing it.
   * In memory implementation, this is a no-op (actual apply would
   * modify working tree which we don't have in memory).
   */
  async apply(index = 0): Promise<void> {
    if (index >= this.entries.length) {
      throw new Error(`No stash entry at index ${index}`);
    }
    // In a real implementation, would apply changes to working tree
    // For memory implementation, this is a no-op
  }

  /**
   * Drop a stash entry.
   */
  async drop(index = 0): Promise<void> {
    if (index >= this.entries.length) {
      throw new Error(`No stash entry at index ${index}`);
    }
    this.entries.splice(index, 1);
    // Renumber remaining entries
    this.entries = this.entries.map((e, i) => ({
      ...e,
      index: i,
    }));
  }

  /**
   * Clear all stash entries.
   */
  async clear(): Promise<void> {
    this.entries = [];
  }

  /**
   * Get current number of stash entries.
   * Helper method for testing.
   */
  get size(): number {
    return this.entries.length;
  }
}

/**
 * Create a new MemoryStashStore instance.
 */
export function createMemoryStashStore(): StashStore {
  return new MemoryStashStore();
}
