import { expect } from "vitest";
import type { BlobContent } from "../../history/blobs/blobs.js";
import type { Commit, Commits } from "../../history/commits/commits.js";
import type { Refs } from "../../history/refs/refs.js";
import type { TreeEntry } from "../../history/trees/tree-entry.js";
import type { Tree } from "../../history/trees/trees.js";

/**
 * Assert that a value is a valid SHA-1 hash.
 */
export function expectValidObjectId(id: unknown): asserts id is string {
  expect(typeof id).toBe("string");
  expect(id).toMatch(/^[0-9a-f]{40}$/);
}

/**
 * Collect all chunks from an async iterable.
 */
async function collectContent(content: BlobContent): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of content) {
    chunks.push(chunk);
  }
  // Concatenate chunks
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

/**
 * Assert that two blobs have identical content.
 */
export async function expectBlobsEqual(
  blob1: BlobContent | undefined,
  blob2: BlobContent | undefined,
): Promise<void> {
  expect(blob1).toBeDefined();
  expect(blob2).toBeDefined();
  if (blob1 && blob2) {
    const content1 = await collectContent(blob1);
    const content2 = await collectContent(blob2);
    expect(content1).toEqual(content2);
  }
}

/**
 * Assert that a tree contains expected entries.
 */
export async function expectTreeContains(
  tree: Tree | undefined,
  expected: Array<{ name: string; mode?: number }>,
): Promise<void> {
  expect(tree).toBeDefined();
  if (!tree) return;

  // Collect tree entries
  const entries: TreeEntry[] = [];
  if (Array.isArray(tree)) {
    entries.push(...tree);
  } else {
    for await (const entry of tree) {
      entries.push(entry);
    }
  }

  for (const exp of expected) {
    const entry = entries.find((e) => e.name === exp.name);
    expect(entry).toBeDefined();
    if (exp.mode !== undefined && entry) {
      expect(entry.mode).toBe(exp.mode);
    }
  }
}

/**
 * Assert that a commit has expected parent count.
 */
export function expectCommitParents(commit: Commit | undefined, count: number): void {
  expect(commit).toBeDefined();
  expect(commit?.parents).toHaveLength(count);
}

/**
 * Assert that a ref points to expected commit.
 */
export async function expectRefEquals(
  refs: Refs,
  refName: string,
  expectedCommit: string,
): Promise<void> {
  const resolved = await refs.resolve(refName);
  expect(resolved).toBeDefined();
  expect(resolved?.objectId).toBe(expectedCommit);
}

/**
 * Assert history is linear (each commit has at most 1 parent).
 */
export async function expectLinearHistory(
  commits: Commits,
  tip: string,
  length: number,
): Promise<void> {
  let current: string | undefined = tip;
  let count = 0;

  while (current) {
    const commit = await commits.load(current);
    expect(commit).toBeDefined();
    expect(commit?.parents.length).toBeLessThanOrEqual(1);

    count++;
    current = commit?.parents[0];
  }

  expect(count).toBe(length);
}

/**
 * Assert pack file is valid.
 */
export function expectValidPack(pack: Uint8Array): void {
  // Check header
  const header = new TextDecoder().decode(pack.slice(0, 4));
  expect(header).toBe("PACK");

  // Check version
  const version = new DataView(pack.buffer).getUint32(4, false);
  expect([2, 3]).toContain(version);

  // Check has checksum
  expect(pack.length).toBeGreaterThan(32);
}
