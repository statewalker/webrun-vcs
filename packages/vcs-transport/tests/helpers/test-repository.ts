/**
 * Test Repository Helper
 *
 * Provides an in-memory Git repository for testing transport operations.
 * Inspired by JGit's TestRepository class.
 *
 * Features:
 * - Create commits, trees, blobs programmatically
 * - Manage refs and tags
 * - Support for shallow boundaries
 * - Implements RepositoryFacade interface
 */

import type {
  ExportPackOptions,
  PackImportResult,
  RepositoryFacade,
} from "../../src/api/repository-facade.js";
import type { RefStore } from "../../src/context/process-context.js";

/**
 * Simple object type enumeration
 */
export type ObjectType = "blob" | "tree" | "commit" | "tag";

/**
 * Base object stored in repository
 */
export interface StoredObject {
  type: ObjectType;
  data: Uint8Array;
}

/**
 * Commit object representation
 */
export interface TestCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/**
 * Tree entry
 */
export interface TreeEntry {
  mode: number;
  name: string;
  oid: string;
}

/**
 * Tag object representation
 */
export interface TestTag {
  object: string;
  type: ObjectType;
  name: string;
  tagger: string;
  message: string;
}

/**
 * Test repository with in-memory storage
 */
export class TestRepository implements RepositoryFacade, RefStore {
  private objects = new Map<string, StoredObject>();
  private refs = new Map<string, string>();
  private symbolicRefs = new Map<string, string>();
  private shallowBoundaries = new Set<string>();
  private packImportCallback?: (result: PackImportResult) => void;

  /**
   * Create a new test repository
   */
  static create(): TestRepository {
    return new TestRepository();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Object Creation
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Store a blob with given content
   */
  storeBlob(content: string | Uint8Array): string {
    const data = typeof content === "string" ? new TextEncoder().encode(content) : content;
    const oid = this.computeHash("blob", data);
    this.objects.set(oid, { type: "blob", data });
    return oid;
  }

  /**
   * Store a tree with given entries
   */
  storeTree(entries: TreeEntry[]): string {
    // Serialize tree entries
    const parts: Uint8Array[] = [];
    for (const entry of entries) {
      const modeName = `${entry.mode.toString(8)} ${entry.name}\0`;
      parts.push(new TextEncoder().encode(modeName));
      parts.push(this.hexToBytes(entry.oid));
    }

    const data = this.concatBytes(parts);
    const oid = this.computeHash("tree", data);
    this.objects.set(oid, { type: "tree", data });
    return oid;
  }

  /**
   * Store a commit
   */
  storeCommit(commit: TestCommit): string {
    let content = `tree ${commit.tree}\n`;
    for (const parent of commit.parents) {
      content += `parent ${parent}\n`;
    }
    content += `author ${commit.author}\n`;
    content += `committer ${commit.committer}\n`;
    content += `\n${commit.message}`;

    const data = new TextEncoder().encode(content);
    const oid = this.computeHash("commit", data);
    this.objects.set(oid, { type: "commit", data });
    return oid;
  }

  /**
   * Store a tag
   */
  storeTag(tag: TestTag): string {
    let content = `object ${tag.object}\n`;
    content += `type ${tag.type}\n`;
    content += `tag ${tag.name}\n`;
    content += `tagger ${tag.tagger}\n`;
    content += `\n${tag.message}`;

    const data = new TextEncoder().encode(content);
    const oid = this.computeHash("tag", data);
    this.objects.set(oid, { type: "tag", data });
    return oid;
  }

  /**
   * Store a raw object
   */
  storeObject(oid: string, type: ObjectType, data: Uint8Array): void {
    this.objects.set(oid, { type, data });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // High-level Commit Helpers
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Default author/committer for testing
   */
  static defaultAuthor(): string {
    return "Test Author <test@example.com> 1609459200 +0000";
  }

  /**
   * Create a commit with a single file
   */
  createCommitWithFile(
    filename: string,
    content: string,
    message: string,
    parents: string[] = [],
  ): string {
    const blobOid = this.storeBlob(content);
    const treeOid = this.storeTree([{ mode: 0o100644, name: filename, oid: blobOid }]);

    return this.storeCommit({
      tree: treeOid,
      parents,
      author: TestRepository.defaultAuthor(),
      committer: TestRepository.defaultAuthor(),
      message,
    });
  }

  /**
   * Create an empty commit
   */
  createEmptyCommit(message: string, parents: string[] = []): string {
    const treeOid = this.storeTree([]);
    return this.storeCommit({
      tree: treeOid,
      parents,
      author: TestRepository.defaultAuthor(),
      committer: TestRepository.defaultAuthor(),
      message,
    });
  }

  /**
   * Create a chain of commits
   */
  createCommitChain(length: number, startMessage = "Commit"): string[] {
    const oids: string[] = [];
    let parent: string | undefined;

    for (let i = 0; i < length; i++) {
      const oid = this.createEmptyCommit(`${startMessage} ${i + 1}`, parent ? [parent] : []);
      oids.push(oid);
      parent = oid;
    }

    return oids;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Ref Management
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Set a ref to point to an OID
   */
  setRef(name: string, oid: string): void {
    this.refs.set(name, oid);
  }

  /**
   * Get the OID a ref points to
   */
  getRef(name: string): string | undefined {
    return this.refs.get(name);
  }

  /**
   * Delete a ref
   */
  deleteRef(name: string): void {
    this.refs.delete(name);
  }

  /**
   * Set a symbolic ref
   */
  setSymbolicRef(name: string, target: string): void {
    this.symbolicRefs.set(name, target);
  }

  /**
   * Get all refs as a map
   */
  getAllRefs(): Map<string, string> {
    return new Map(this.refs);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // RefStore Implementation
  // ─────────────────────────────────────────────────────────────────────────────

  async get(name: string): Promise<string | undefined> {
    return this.refs.get(name);
  }

  async update(name: string, oid: string): Promise<void> {
    this.refs.set(name, oid);
  }

  async listAll(): Promise<Iterable<[string, string]>> {
    return this.refs.entries();
  }

  async getSymrefTarget(name: string): Promise<string | undefined> {
    return this.symbolicRefs.get(name);
  }

  async isRefTip(oid: string): Promise<boolean> {
    for (const refOid of this.refs.values()) {
      if (refOid === oid) return true;
    }
    return false;
  }

  /**
   * Set HEAD to point to a branch
   */
  setHead(branch: string): void {
    this.symbolicRefs.set("HEAD", `refs/heads/${branch}`);
  }

  /**
   * Get HEAD target
   */
  getHead(): string | undefined {
    const target = this.symbolicRefs.get("HEAD");
    if (target) {
      return this.refs.get(target);
    }
    return this.refs.get("HEAD");
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Shallow Boundaries
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Mark an OID as a shallow boundary
   */
  addShallow(oid: string): void {
    this.shallowBoundaries.add(oid);
  }

  /**
   * Check if an OID is a shallow boundary
   */
  isShallow(oid: string): boolean {
    return this.shallowBoundaries.has(oid);
  }

  /**
   * Get all shallow boundaries
   */
  getShallowBoundaries(): Set<string> {
    return new Set(this.shallowBoundaries);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Object Access
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Get an object by OID
   */
  getObject(oid: string): StoredObject | undefined {
    return this.objects.get(oid);
  }

  /**
   * Get commit object and parse it
   */
  getCommit(oid: string): TestCommit | undefined {
    const obj = this.objects.get(oid);
    if (!obj || obj.type !== "commit") return undefined;

    const text = new TextDecoder().decode(obj.data);
    const lines = text.split("\n");

    let tree = "";
    const parents: string[] = [];
    let author = "";
    let committer = "";
    let messageStart = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === "") {
        messageStart = i + 1;
        break;
      }

      if (line.startsWith("tree ")) {
        tree = line.slice(5);
      } else if (line.startsWith("parent ")) {
        parents.push(line.slice(7));
      } else if (line.startsWith("author ")) {
        author = line.slice(7);
      } else if (line.startsWith("committer ")) {
        committer = line.slice(10);
      }
    }

    return {
      tree,
      parents,
      author,
      committer,
      message: lines.slice(messageStart).join("\n"),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // RepositoryFacade Implementation
  // ─────────────────────────────────────────────────────────────────────────────

  async importPack(_packStream: AsyncIterable<Uint8Array>): Promise<PackImportResult> {
    // Simplified import - just count bytes received
    let bytesReceived = 0;
    for await (const chunk of _packStream) {
      bytesReceived += chunk.length;
    }

    const result: PackImportResult = {
      objectsImported: Math.floor(bytesReceived / 100), // Rough estimate
      blobsWithDelta: 0,
      treesImported: 0,
      commitsImported: 0,
      tagsImported: 0,
    };

    if (this.packImportCallback) {
      this.packImportCallback(result);
    }

    return result;
  }

  async *exportPack(
    wants: Set<string>,
    exclude: Set<string>,
    _options?: ExportPackOptions,
  ): AsyncIterable<Uint8Array> {
    // Collect objects reachable from wants, excluding those reachable from exclude
    const toSend = new Set<string>();
    const visited = new Set<string>();

    // Exclude objects reachable from exclude set
    for (const oid of exclude) {
      await this.markReachable(oid, visited);
    }

    // Collect objects reachable from wants but not in visited
    for (const oid of wants) {
      await this.collectReachable(oid, visited, toSend);
    }

    // Generate simple pack format
    yield this.createPackHeader(toSend.size);

    for (const oid of toSend) {
      const obj = this.objects.get(oid);
      if (obj) {
        yield this.packObject(obj);
      }
    }

    // Pack checksum (dummy)
    yield new Uint8Array(20);
  }

  async has(oid: string): Promise<boolean> {
    return this.objects.has(oid);
  }

  async *walkAncestors(startOid: string): AsyncGenerator<string> {
    const visited = new Set<string>();
    const queue = [startOid];

    while (queue.length > 0) {
      const oid = queue.shift();
      if (!oid || visited.has(oid)) continue;
      visited.add(oid);

      yield oid;

      // Don't walk past shallow boundaries
      if (this.shallowBoundaries.has(oid)) continue;

      const commit = this.getCommit(oid);
      if (commit) {
        queue.push(...commit.parents);
      }
    }
  }

  async peelTag(oid: string): Promise<string | null> {
    const obj = this.objects.get(oid);
    if (!obj || obj.type !== "tag") return oid;

    const text = new TextDecoder().decode(obj.data);
    const match = text.match(/^object ([a-f0-9]{40})/m);
    return match ? match[1] : null;
  }

  async getObjectSize(oid: string): Promise<number | null> {
    const obj = this.objects.get(oid);
    return obj ? obj.data.length : null;
  }

  async isReachableFrom(oid: string, from: string | string[]): Promise<boolean> {
    const sources = Array.isArray(from) ? from : [from];
    const visited = new Set<string>();

    const queue = [...sources];
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || visited.has(current)) continue;
      visited.add(current);

      if (current === oid) return true;

      const commit = this.getCommit(current);
      if (commit) {
        queue.push(...commit.parents);
      }
    }

    return false;
  }

  async isReachableFromAnyTip(oid: string): Promise<boolean> {
    for (const tipOid of this.refs.values()) {
      if (await this.isReachableFrom(oid, tipOid)) {
        return true;
      }
    }
    return false;
  }

  async computeShallowBoundaries(wants: Set<string>, depth: number): Promise<Set<string>> {
    const boundaries = new Set<string>();

    for (const want of wants) {
      const queue = [{ oid: want, depth: 0 }];
      const visited = new Set<string>();

      while (queue.length > 0) {
        const item = queue.shift();
        if (!item) continue;
        const { oid, depth: d } = item;
        if (visited.has(oid)) continue;
        visited.add(oid);

        if (d >= depth) {
          boundaries.add(oid);
          continue;
        }

        const commit = this.getCommit(oid);
        if (commit) {
          for (const parent of commit.parents) {
            queue.push({ oid: parent, depth: d + 1 });
          }
        }
      }
    }

    return boundaries;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Test Utilities
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Set a callback for pack import (for testing)
   */
  onPackImport(callback: (result: PackImportResult) => void): void {
    this.packImportCallback = callback;
  }

  /**
   * Count total objects
   */
  objectCount(): number {
    return this.objects.size;
  }

  /**
   * Clear all data
   */
  clear(): void {
    this.objects.clear();
    this.refs.clear();
    this.symbolicRefs.clear();
    this.shallowBoundaries.clear();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Private Helpers
  // ─────────────────────────────────────────────────────────────────────────────

  private computeHash(type: string, data: Uint8Array): string {
    // Simplified hash - use data length and first bytes
    // In production, would use SHA-1
    const header = `${type} ${data.length}\0`;
    const headerBytes = new TextEncoder().encode(header);
    const combined = this.concatBytes([headerBytes, data]);

    // Simple hash for testing (not cryptographically secure)
    let hash = 0;
    for (const byte of combined) {
      hash = (hash * 31 + byte) >>> 0;
    }

    // Generate 40-char hex string
    const hex = hash.toString(16).padStart(8, "0");
    return hex.repeat(5);
  }

  private hexToBytes(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
    }
    return bytes;
  }

  private concatBytes(arrays: Uint8Array[]): Uint8Array {
    const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const arr of arrays) {
      result.set(arr, offset);
      offset += arr.length;
    }
    return result;
  }

  private async markReachable(oid: string, visited: Set<string>): Promise<void> {
    if (visited.has(oid)) return;
    visited.add(oid);

    const obj = this.objects.get(oid);
    if (!obj) return;

    if (obj.type === "commit") {
      const commit = this.getCommit(oid);
      if (commit) {
        await this.markReachable(commit.tree, visited);
        for (const parent of commit.parents) {
          await this.markReachable(parent, visited);
        }
      }
    } else if (obj.type === "tree") {
      // Parse tree and mark children
      // Simplified - would need full tree parsing
    }
  }

  private async collectReachable(
    oid: string,
    excluded: Set<string>,
    collected: Set<string>,
  ): Promise<void> {
    if (excluded.has(oid) || collected.has(oid)) return;
    collected.add(oid);

    const obj = this.objects.get(oid);
    if (!obj) return;

    if (obj.type === "commit") {
      const commit = this.getCommit(oid);
      if (commit) {
        await this.collectReachable(commit.tree, excluded, collected);
        for (const parent of commit.parents) {
          await this.collectReachable(parent, excluded, collected);
        }
      }
    }
  }

  private createPackHeader(count: number): Uint8Array {
    const header = new Uint8Array(12);
    // "PACK"
    header[0] = 0x50;
    header[1] = 0x41;
    header[2] = 0x43;
    header[3] = 0x4b;
    // Version 2
    header[4] = 0x00;
    header[5] = 0x00;
    header[6] = 0x00;
    header[7] = 0x02;
    // Object count (big-endian)
    header[8] = (count >> 24) & 0xff;
    header[9] = (count >> 16) & 0xff;
    header[10] = (count >> 8) & 0xff;
    header[11] = count & 0xff;
    return header;
  }

  private packObject(obj: StoredObject): Uint8Array {
    // Simplified pack object format
    const typeNum = { commit: 1, tree: 2, blob: 3, tag: 4 }[obj.type];
    const size = obj.data.length;

    // Variable-length size encoding (simplified)
    const header: number[] = [];
    let s = size;
    header.push(((typeNum ?? 0) << 4) | (s & 0x0f));
    s >>= 4;
    while (s > 0) {
      header[header.length - 1] |= 0x80;
      header.push(s & 0x7f);
      s >>= 7;
    }

    return this.concatBytes([new Uint8Array(header), obj.data]);
  }
}

/**
 * Convenience function to create a test repository with initial content
 */
export function createTestRepository(): TestRepository {
  return TestRepository.create();
}

/**
 * Create a test repository with a single commit on main branch
 */
export async function createInitializedRepository(): Promise<{
  repo: TestRepository;
  initialCommit: string;
}> {
  const repo = TestRepository.create();

  const initialCommit = repo.createEmptyCommit("Initial commit");
  repo.setRef("refs/heads/main", initialCommit);
  repo.setHead("main");

  return { repo, initialCommit };
}

/**
 * Create a test repository with multiple branches and commits
 */
export async function createComplexRepository(): Promise<{
  repo: TestRepository;
  commits: { main: string[]; feature: string[] };
}> {
  const repo = TestRepository.create();

  // Main branch: 3 commits
  const main1 = repo.createCommitWithFile("README.md", "# Test", "Initial commit");
  const main2 = repo.createCommitWithFile("README.md", "# Test\nMore content", "Update README", [
    main1,
  ]);
  const main3 = repo.createCommitWithFile("README.md", "# Test\nEven more", "Another update", [
    main2,
  ]);

  repo.setRef("refs/heads/main", main3);
  repo.setHead("main");

  // Feature branch: 2 commits branching from main2
  const feature1 = repo.createCommitWithFile("feature.ts", "export {};", "Start feature", [main2]);
  const feature2 = repo.createCommitWithFile(
    "feature.ts",
    "export const x = 1;",
    "Complete feature",
    [feature1],
  );

  repo.setRef("refs/heads/feature", feature2);

  return {
    repo,
    commits: {
      main: [main1, main2, main3],
      feature: [feature1, feature2],
    },
  };
}
