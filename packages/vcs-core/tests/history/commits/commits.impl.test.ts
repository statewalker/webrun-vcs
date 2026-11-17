/**
 * Tests for CommitsImpl using GitObjects over MemoryRawStorage
 *
 * Runs conformance tests against the new Commits implementation.
 */

import { describe, expect, it } from "vitest";
import { createCommits } from "../../../src/history/commits/commits.impl.js";
import type { Commits } from "../../../src/history/commits/commits.js";
import { createGitObjects, type GitObjects } from "../../../src/history/objects/index.js";
import { rawStorageStaging } from "../../../src/storage/adapters/staging-blob-store.js";
import { MemoryRawStorage } from "../../../src/storage/raw/memory-raw-storage.js";
import { commitsConformanceTests } from "./commits.conformance.test.js";

let storage: MemoryRawStorage;

commitsConformanceTests(
  "CommitsImpl",
  async (): Promise<Commits> => {
    storage = new MemoryRawStorage();
    const objects = createGitObjects(rawStorageStaging(storage));
    return createCommits(objects);
  },
  async (): Promise<void> => {
    storage.clear();
  },
);

describe("CommitsImpl reads", () => {
  it("take the object without a promise when the store has it in memory (getNow)", async () => {
    const objects = createGitObjects(rawStorageStaging(new MemoryRawStorage()));
    const commits = createCommits(objects);
    const author = { name: "A", email: "a@example.com", timestamp: 1, tzOffset: "+0000" };
    const id = await commits.store({
      tree: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
      parents: [],
      author,
      committer: author,
      message: "m\n",
    });
    // a store whose objects are all in memory: `get` is never needed
    const obj = await objects.get(id);
    const bytes = await collectBytes(obj?.content ?? []);
    let gets = 0;
    let nows = 0;
    const inMemory: GitObjects = {
      ...objects,
      get: async (oid, o) => {
        gets++;
        return objects.get(oid, o);
      },
      getNow: (oid) => {
        nows++;
        return oid === id
          ? {
              type: "commit",
              size: bytes.length,
              bytes,
              content: (async function* () {
                yield bytes;
              })(),
            }
          : undefined;
      },
    };
    const reader = createCommits(inMemory);
    const c = await reader.load(id);
    expect(c?.message).toBe("m\n");
    expect([gets, nows]).toEqual([0, 1]);
    // the caller's copy: changing it does not reach the cache
    c?.parents.push("x".repeat(40));
    expect((await reader.load(id))?.parents).toEqual([]);
  });
});

async function collectBytes(s: AsyncIterable<Uint8Array> | Iterable<Uint8Array>) {
  const parts: Uint8Array[] = [];
  for await (const p of s) parts.push(p);
  return Uint8Array.from(parts.flatMap((p) => [...p]));
}
