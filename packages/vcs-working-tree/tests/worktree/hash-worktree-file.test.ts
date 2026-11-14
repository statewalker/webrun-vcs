/**
 * Streaming worktree hashing: `hashWorktreeFile` hashes a file as it is read,
 * with the size from stat, retries once when the size changes underneath, and
 * then reports the file as modified (an id no blob has).
 */
import type { Blobs, Trees } from "@statewalker/vcs-core";
import { createSha1, type Hasher } from "@statewalker/vcs-utils/hash/hasher";
import { describe, expect, it } from "vitest";
import {
  createMemoryWorktree,
  hashWorktreeFile,
  isUnknownContentId,
  unknownContentId,
} from "../../src/worktree/index.js";

const enc = new TextEncoder();
const HELLO_ID = "ce013625030ba8dba906f756967f9e9ca394464a"; // blob "hello\n"

function countingSha1(counter: { hashers: number }): () => Hasher {
  return () => {
    counter.hashers++;
    return createSha1();
  };
}

describe("hashWorktreeFile", () => {
  it("hashes a stream with the size from stat", async () => {
    const id = await hashWorktreeFile("a.txt", {
      size: async () => 6,
      read: async function* () {
        yield enc.encode("hel");
        yield enc.encode("lo\n");
      },
    });
    expect(id).toBe(HELLO_ID);
  });

  it("uses the hasher factory it is given", async () => {
    const counter = { hashers: 0 };
    const id = await hashWorktreeFile(
      "a.txt",
      { size: async () => 6, read: () => [enc.encode("hello\n")] },
      countingSha1(counter),
    );
    expect(id).toBe(HELLO_ID);
    expect(counter.hashers).toBe(1);
  });

  it("re-stats and retries once when the file changed size while it was read", async () => {
    let stats = 0;
    let reads = 0;
    const id = await hashWorktreeFile("a.txt", {
      // first stat is stale (the file grew before it was read)
      size: async () => (++stats === 1 ? 3 : 6),
      read: () => {
        reads++;
        return [enc.encode("hello\n")];
      },
    });
    expect(id).toBe(HELLO_ID);
    expect(stats).toBe(2);
    expect(reads).toBe(2);
  });

  it("reports a file that keeps changing as modified", async () => {
    let reads = 0;
    const id = await hashWorktreeFile("a.txt", {
      size: async () => 3,
      read: () => {
        reads++;
        return [enc.encode("x".repeat(3 + reads))];
      },
    });
    expect(reads).toBe(2);
    expect(isUnknownContentId(id)).toBe(true);
    // never an id an index entry can hold: not all-zero, not empty, not hex, never repeated
    expect(id).not.toBe("0".repeat(40));
    expect(id).not.toMatch(/^[0-9a-f]*$/);
    expect(id).not.toBe(unknownContentId());
  });

  it("refuses a file that does not exist", async () => {
    await expect(
      hashWorktreeFile("gone.txt", { size: async () => undefined, read: () => [] }),
    ).rejects.toThrow(/gone\.txt/);
  });
});

describe("MemoryWorktree.computeHash", () => {
  it("hashes with the newHasher factory option", async () => {
    const counter = { hashers: 0 };
    const worktree = createMemoryWorktree({
      blobs: {} as Blobs,
      trees: {} as Trees,
      newHasher: countingSha1(counter),
    });
    await worktree.writeContent("a.txt", enc.encode("hello\n"));
    expect(await worktree.computeHash("a.txt")).toBe(HELLO_ID);
    expect(counter.hashers).toBe(1);
  });
});
