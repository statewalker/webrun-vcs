/**
 * Tests for mock implementations
 */

import { describe, expect, it } from "vitest";
import { MemoryRawStorage } from "../../src/storage/raw/index.js";
import { CommitGraphBuilder, MockCommitStore } from "./mock-commit-store.js";

describe("MockCommitStore", () => {
  it("should store and load commits", async () => {
    const store = new MockCommitStore();
    const commit = {
      tree: "tree123",
      parents: [],
      author: {
        name: "Test",
        email: "test@test.com",
        timestamp: 1234567890,
        tzOffset: "+0000",
      },
      committer: {
        name: "Test",
        email: "test@test.com",
        timestamp: 1234567890,
        tzOffset: "+0000",
      },
      message: "Test commit",
    };

    const id = await store.storeCommit(commit);
    const loaded = await store.loadCommit(id);

    expect(loaded.tree).toBe("tree123");
    expect(loaded.message).toBe("Test commit");
  });

  it("should walk ancestry", async () => {
    const store = new MockCommitStore();
    const person = {
      name: "Test",
      email: "test@test.com",
      timestamp: 1234567890,
      tzOffset: "+0000",
    };

    // Create a chain: c3 -> c2 -> c1
    const c1 = await store.storeCommit({
      tree: "t1",
      parents: [],
      author: person,
      committer: person,
      message: "First",
    });
    const c2 = await store.storeCommit({
      tree: "t2",
      parents: [c1],
      author: person,
      committer: person,
      message: "Second",
    });
    const c3 = await store.storeCommit({
      tree: "t3",
      parents: [c2],
      author: person,
      committer: person,
      message: "Third",
    });

    const ancestry: string[] = [];
    for await (const id of store.walkAncestry(c3)) {
      ancestry.push(id);
    }

    expect(ancestry).toEqual([c3, c2, c1]);
  });

  it("should check isAncestor", async () => {
    const store = new MockCommitStore();
    const person = {
      name: "Test",
      email: "test@test.com",
      timestamp: 1234567890,
      tzOffset: "+0000",
    };

    const c1 = await store.storeCommit({
      tree: "t1",
      parents: [],
      author: person,
      committer: person,
      message: "First",
    });
    const c2 = await store.storeCommit({
      tree: "t2",
      parents: [c1],
      author: person,
      committer: person,
      message: "Second",
    });

    expect(await store.isAncestor(c1, c2)).toBe(true);
    expect(await store.isAncestor(c2, c1)).toBe(false);
  });
});

describe("CommitGraphBuilder", () => {
  it("should build linear commit chain", async () => {
    const builder = new CommitGraphBuilder();
    const tip = await builder.linearChain("a", "b", "c", "d");

    expect(tip).toBe(builder.getId("d"));

    const store = builder.getStore();
    const parents = await store.getParents(tip);
    expect(parents).toEqual([builder.getId("c")]);
  });

  it("should build commits with specified parents", async () => {
    const builder = new CommitGraphBuilder();

    await builder.commit("a");
    await builder.commit("b");
    const merge = await builder.commit("merge", "a", "b");

    const store = builder.getStore();
    const parents = await store.getParents(merge);

    expect(parents).toContain(builder.getId("a"));
    expect(parents).toContain(builder.getId("b"));
  });
});

describe("MemoryRawStorage", () => {
  async function* toStream(data: Uint8Array): AsyncIterable<Uint8Array> {
    yield data;
  }

  it("should store and load data", async () => {
    const store = new MemoryRawStorage();
    const data = new Uint8Array([1, 2, 3, 4, 5]);

    await store.store("key1", toStream(data));
    const chunks: Uint8Array[] = [];
    for await (const chunk of store.load("key1")) {
      chunks.push(chunk);
    }

    const loaded = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      loaded.set(chunk, offset);
      offset += chunk.length;
    }

    expect(loaded).toEqual(data);
  });

  it("should check key existence", async () => {
    const store = new MemoryRawStorage();
    await store.store("exists", toStream(new Uint8Array([1])));

    expect(await store.has("exists")).toBe(true);
    expect(await store.has("nonexistent")).toBe(false);
  });

  it("should remove keys", async () => {
    const store = new MemoryRawStorage();
    await store.store("key", toStream(new Uint8Array([1])));

    expect(await store.remove("key")).toBe(true);
    expect(await store.has("key")).toBe(false);
  });
});
