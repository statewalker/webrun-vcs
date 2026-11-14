/**
 * The core AddCommand writes regular files in one pass, passing the size the
 * worktree reports, and falls back to collecting the file when it changed.
 */
import { createMemoryHistory } from "@statewalker/vcs-core";
import { MemoryStagingStore } from "@statewalker/vcs-store-mem";
import type { Worktree, WorktreeEntry } from "@statewalker/vcs-working-tree";
import { describe, expect, it } from "vitest";
import { AddCommand } from "../src/core-commands/index.js";

const enc = new TextEncoder();

function worktreeOf(files: Record<string, { content: string; size?: number }>): Worktree {
  const entry = (path: string): WorktreeEntry => ({
    path,
    name: path,
    mode: 0o100644,
    size: files[path]?.size ?? enc.encode(files[path]?.content ?? "").length,
    mtime: 0,
    isDirectory: false,
    isIgnored: false,
  });
  return {
    async *walk() {
      for (const path of Object.keys(files)) yield entry(path);
    },
    async getEntry(path: string) {
      return path in files ? entry(path) : undefined;
    },
    async *readContent(path: string) {
      yield enc.encode(files[path]?.content ?? "");
    },
  } as unknown as Worktree;
}

describe("AddCommand blob sizes", () => {
  it("passes the worktree size of a regular file to blobs.store", async () => {
    const history = createMemoryHistory();
    const sizes: (number | undefined)[] = [];
    const store = history.blobs.store.bind(history.blobs);
    history.blobs.store = (content, size) => {
      sizes.push(size);
      return store(content, size);
    };
    const add = new AddCommand({
      worktree: worktreeOf({ "a.txt": { content: "hello\n" } }),
      blobs: history.blobs,
      staging: new MemoryStagingStore(),
    });
    await add.add(["a.txt"]);
    expect(sizes).toEqual([6]);
    expect(await history.blobs.has("ce013625030ba8dba906f756967f9e9ca394464a")).toBe(true);
  });

  it("stores what the file holds when it changed after its size was read", async () => {
    const history = createMemoryHistory();
    const staging = new MemoryStagingStore();
    const add = new AddCommand({
      worktree: worktreeOf({ "a.txt": { content: "hello\n", size: 3 } }),
      blobs: history.blobs,
      staging,
    });
    await add.add(["a.txt"]);
    expect(await history.blobs.has("ce013625030ba8dba906f756967f9e9ca394464a")).toBe(true);
  });
});

describe("AddCommand when a file changes while it is hashed", () => {
  it("re-stats the file and retries once with its new size, as git does", async () => {
    const history = createMemoryHistory();
    const sizes: (number | undefined)[] = [];
    const store = history.blobs.store.bind(history.blobs);
    history.blobs.store = (content, size) => {
      sizes.push(size);
      return store(content, size);
    };
    // the walk reports the old size (3); a fresh stat reports what the file holds now (6)
    const base = worktreeOf({ "a.txt": { content: "hello\n" } });
    let stats = 0;
    const worktree = {
      ...base,
      async *walk() {
        for await (const e of base.walk()) yield { ...e, size: 3 };
      },
      async getEntry(path: string) {
        const e = await base.getEntry(path);
        return e && stats++ === 0 ? { ...e, size: 3 } : e;
      },
    } as unknown as Worktree;
    const add = new AddCommand({
      worktree,
      blobs: history.blobs,
      staging: new MemoryStagingStore(),
    });
    await add.add(["a.txt"]);
    expect(sizes).toEqual([3, 6]);
    expect(await history.blobs.has("ce013625030ba8dba906f756967f9e9ca394464a")).toBe(true);
  });
});
