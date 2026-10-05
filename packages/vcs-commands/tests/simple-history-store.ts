/**
 * SimpleHistory - A simple History implementation for testing
 *
 * Wraps individual stores (Blobs, Trees, etc.) into a History interface.
 * Used for creating WorkingCopy instances in tests without a full storage backend.
 */

import type { Blobs, Commits, History, ObjectId, Refs, Tags, Trees } from "@statewalker/vcs-core";

/**
 * Options for creating a SimpleHistory
 */
export interface SimpleHistoryOptions {
  /** Blob storage */
  blobs: Blobs;
  /** Tree storage */
  trees: Trees;
  /** Commit storage */
  commits: Commits;
  /** Tag storage */
  tags: Tags;
  /** Reference storage */
  refs: Refs;
}

/**
 * Simple in-memory History implementation for testing.
 *
 * Wraps individual stores without requiring a full storage backend.
 * Does not support GC operations or collectReachableObjects.
 */
export class SimpleHistory implements History {
  readonly blobs: Blobs;
  readonly trees: Trees;
  readonly commits: Commits;
  readonly tags: Tags;
  readonly refs: Refs;

  private _initialized = false;

  constructor(options: SimpleHistoryOptions) {
    this.blobs = options.blobs;
    this.trees = options.trees;
    this.commits = options.commits;
    this.tags = options.tags;
    this.refs = options.refs;
  }

  async initialize(): Promise<void> {
    if (this.refs.initialize) {
      await this.refs.initialize();
    }
    this._initialized = true;
  }

  async close(): Promise<void> {
    // No resources to clean up
  }

  isInitialized(): boolean {
    return this._initialized;
  }

  collectReachableObjects(_wants: Set<string>, _exclude: Set<string>): AsyncIterable<ObjectId> {
    throw new Error("collectReachableObjects not supported in SimpleHistory");
  }
}

/**
 * Create a SimpleHistory from store instances
 */
export function createSimpleHistory(options: SimpleHistoryOptions): SimpleHistory {
  return new SimpleHistory(options);
}
