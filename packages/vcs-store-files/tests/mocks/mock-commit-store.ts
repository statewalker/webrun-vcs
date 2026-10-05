/**
 * Mock Commits implementation for testing
 *
 * Implements both old CommitStore and new Commits interfaces for backward compatibility.
 */

import type {
  AncestryOptions,
  Commit,
  Commits,
  ObjectId,
  PersonIdent,
} from "@statewalker/vcs-core";

/**
 * In-memory Commits implementation for testing
 *
 * Provides methods for building commit graphs programmatically.
 * Implements both old CommitStore and new Commits interfaces.
 */
export class MockCommitStore implements Commits {
  private readonly commits = new Map<ObjectId, Commit>();
  private idCounter = 0;

  async storeCommit(commit: Commit): Promise<ObjectId> {
    const id = this.generateId();
    this.commits.set(id, { ...commit });
    return id;
  }

  // New interface (Commits)
  async store(commit: Commit): Promise<ObjectId> {
    return this.storeCommit(commit);
  }

  async loadCommit(id: ObjectId): Promise<Commit> {
    const commit = this.commits.get(id);
    if (!commit) {
      throw new Error(`Commit not found: ${id}`);
    }
    return { ...commit };
  }

  // New interface (Commits)
  async load(id: ObjectId): Promise<Commit | undefined> {
    return this.commits.get(id);
  }

  async getParents(id: ObjectId): Promise<ObjectId[]> {
    const commit = await this.loadCommit(id);
    return [...commit.parents];
  }

  async getTree(id: ObjectId): Promise<ObjectId | undefined> {
    const commit = this.commits.get(id);
    return commit?.tree;
  }

  async remove(id: ObjectId): Promise<boolean> {
    return this.commits.delete(id);
  }

  async *walkAncestry(
    startIds: ObjectId | ObjectId[],
    options?: AncestryOptions,
  ): AsyncIterable<ObjectId> {
    const starts = Array.isArray(startIds) ? startIds : [startIds];
    const visited = new Set<ObjectId>();
    const stopAt = new Set(options?.stopAt ?? []);
    const queue: ObjectId[] = [...starts];
    let count = 0;
    const limit = options?.limit ?? Infinity;

    while (queue.length > 0 && count < limit) {
      const id = queue.shift();
      if (!id) continue;
      if (visited.has(id) || stopAt.has(id)) continue;
      visited.add(id);

      const commit = this.commits.get(id);
      if (!commit) continue;

      yield id;
      count++;
      if (options?.firstParentOnly) {
        const firstParent = commit.parents[0];
        if (firstParent) {
          queue.push(firstParent);
        }
      } else {
        queue.push(...commit.parents);
      }
    }
  }

  async findMergeBase(commitA: ObjectId, commitB: ObjectId): Promise<ObjectId[]> {
    // Simple implementation: find all ancestors of A, then find first common in B's ancestry
    const ancestorsA = new Set<ObjectId>();
    for await (const id of this.walkAncestry(commitA)) {
      ancestorsA.add(id);
    }

    const bases: ObjectId[] = [];
    for await (const id of this.walkAncestry(commitB)) {
      if (ancestorsA.has(id)) {
        bases.push(id);
        break; // Simple implementation returns first common ancestor
      }
    }
    return bases;
  }

  async has(id: ObjectId): Promise<boolean> {
    return this.commits.has(id);
  }

  async *keys(): AsyncIterable<ObjectId> {
    for (const id of this.commits.keys()) {
      yield id;
    }
  }

  async isAncestor(ancestorId: ObjectId, descendantId: ObjectId): Promise<boolean> {
    if (ancestorId === descendantId) return true;
    for await (const id of this.walkAncestry(descendantId)) {
      if (id === ancestorId) return true;
    }
    return false;
  }

  /**
   * Add a commit directly with a known ID (for testing)
   */
  addCommit(id: ObjectId, commit: Commit): void {
    this.commits.set(id, { ...commit });
  }

  /**
   * Get all stored commits for inspection
   */
  getAllCommits(): Map<ObjectId, Commit> {
    return new Map(this.commits);
  }

  /**
   * Clear all stored commits
   */
  clear(): void {
    this.commits.clear();
    this.idCounter = 0;
  }

  private generateId(): ObjectId {
    const id = this.idCounter++;
    return id.toString(16).padStart(40, "0");
  }
}

/**
 * Builder for creating commit graphs in tests
 *
 * Fluent API for programmatically building commit DAGs.
 */
export class CommitGraphBuilder {
  private readonly store: MockCommitStore;
  private readonly commitIds = new Map<string, ObjectId>();
  private defaultAuthor: PersonIdent;

  constructor(store?: MockCommitStore) {
    this.store = store ?? new MockCommitStore();
    this.defaultAuthor = {
      name: "Test Author",
      email: "test@example.com",
      timestamp: Math.floor(Date.now() / 1000),
      tzOffset: "+0000",
    };
  }

  /**
   * Set default author for subsequent commits
   */
  withAuthor(author: PersonIdent): this {
    this.defaultAuthor = author;
    return this;
  }

  /**
   * Create a commit with optional parents
   *
   * @param name Local reference name for this commit (used by parentOf)
   * @param parentNames Names of parent commits (created earlier)
   * @returns ObjectId of the created commit
   */
  async commit(name: string, ...parentNames: string[]): Promise<ObjectId> {
    const parents = parentNames.map((p) => {
      const id = this.commitIds.get(p);
      if (!id) throw new Error(`Unknown parent commit: ${p}`);
      return id;
    });

    const treeId = this.generateTreeId(name);
    const id = await this.store.storeCommit({
      tree: treeId,
      parents,
      author: { ...this.defaultAuthor },
      committer: { ...this.defaultAuthor },
      message: `Commit: ${name}`,
    });

    this.commitIds.set(name, id);
    return id;
  }

  /**
   * Get the ObjectId for a named commit
   */
  getId(name: string): ObjectId {
    const id = this.commitIds.get(name);
    if (!id) throw new Error(`Unknown commit: ${name}`);
    return id;
  }

  /**
   * Get the underlying store
   */
  getStore(): MockCommitStore {
    return this.store;
  }

  /**
   * Build a linear chain of commits
   *
   * @param names Commit names from oldest to newest
   * @returns ObjectId of the newest commit (tip)
   */
  async linearChain(...names: string[]): Promise<ObjectId> {
    if (names.length === 0) {
      throw new Error("linearChain requires at least one commit name");
    }
    let lastId: ObjectId | undefined;
    for (const name of names) {
      if (lastId) {
        const prevName = names[names.indexOf(name) - 1];
        lastId = await this.commit(name, prevName);
      } else {
        lastId = await this.commit(name);
      }
    }
    return lastId as ObjectId;
  }

  private generateTreeId(name: string): ObjectId {
    // Generate a deterministic tree ID based on commit name
    const hash = name.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0);
    return `tree${hash.toString(16).padStart(36, "0")}`;
  }
}
