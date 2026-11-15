/**
 * Checkout writes stream: the commands hand a blob's content stream to the
 * worktree (or FilesApi) instead of collecting it first, so a large file is
 * written chunk by chunk.
 */
import {
  type Blobs,
  createInMemoryFilesApi,
  FileMode,
  type FilesApi,
  type ObjectId,
} from "@statewalker/vcs-core";
import { createFileWorktree } from "@statewalker/vcs-store-files";
import {
  createMemoryObjectStores,
  MemoryRefs,
  MemoryStagingStore,
} from "@statewalker/vcs-store-mem";
import type { Staging, Worktree } from "@statewalker/vcs-working-tree";
import { MemoryWorkingCopy } from "@statewalker/vcs-working-tree";
import { describe, expect, it } from "vitest";
import { writeTreeRestorePlan } from "../src/commands/tree-restore.js";
import { CheckoutCommand, type CheckoutCommandOptions } from "../src/core-commands/index.js";
import { Git } from "../src/index.js";
import { createSimpleHistory } from "./simple-history-store.js";
import { testAuthor } from "./test-helper.js";

const MiB = 1024 * 1024;
const BIG = 50 * MiB;
const CHUNK = 256 * 1024;

/**
 * A blob store serving one lazily produced 50 MiB blob, and a consumer that
 * records how many chunks were loaded but not yet written.
 */
function streamProbe(blobId: ObjectId) {
  const probe = { produced: 0, consumed: 0, maxOutstanding: 0, largestChunk: 0, written: 0 };
  const blobs = {
    has: async (id: string) => id === blobId,
    load: async (id: string) =>
      id === blobId
        ? (async function* () {
            for (let off = 0; off < BIG; off += CHUNK) {
              probe.produced++;
              yield new Uint8Array(Math.min(CHUNK, BIG - off));
            }
          })()
        : undefined,
  } as unknown as Blobs;
  const consume = async (content: AsyncIterable<Uint8Array> | Iterable<Uint8Array>) => {
    for await (const chunk of content) {
      probe.consumed++;
      probe.maxOutstanding = Math.max(probe.maxOutstanding, probe.produced - probe.consumed);
      probe.largestChunk = Math.max(probe.largestChunk, chunk.length);
      probe.written += chunk.length;
    }
  };
  return { probe, blobs, consume };
}

describe("core CheckoutCommand streams blobs into FilesApi.write", () => {
  it("writes a 50 MiB blob incrementally", async () => {
    const blobId = "b".repeat(40);
    const { probe, blobs, consume } = streamProbe(blobId);
    const files = {
      mkdir: async () => {},
      write: async (_p: string, content: AsyncIterable<Uint8Array>) => consume(content),
    } as unknown as FilesApi;
    const staging = {
      getEntry: async (path: string) =>
        path === "big.bin" ? { path, objectId: blobId, mode: FileMode.REGULAR_FILE } : undefined,
    } as unknown as Staging;
    const checkout = new CheckoutCommand({
      files,
      workTreeRoot: "/repo",
      blobs,
      staging,
    } as unknown as CheckoutCommandOptions);

    const result = await checkout.checkoutPaths(["big.bin"]);
    expect(result.conflicts).toEqual([]);
    expect(probe.written).toBe(BIG);
    expect(probe.largestChunk).toBeLessThanOrEqual(CHUNK);
    expect(probe.maxOutstanding).toBe(0);
  });
});

describe("writeTreeRestorePlan streams blobs into the worktree", () => {
  it("writes a 50 MiB blob incrementally", async () => {
    const blobId = "c".repeat(40);
    const { probe, blobs, consume } = streamProbe(blobId);
    const worktree = {
      writeContent: async (
        _p: string,
        content: AsyncIterable<Uint8Array> | Iterable<Uint8Array> | Uint8Array,
      ) => consume(content instanceof Uint8Array ? [content] : content),
    } as unknown as Worktree;

    await writeTreeRestorePlan(
      worktree,
      blobs,
      {
        entries: [{ path: "big.bin", objectId: blobId, mode: FileMode.REGULAR_FILE }],
        paths: new Set(["big.bin"]),
      },
      "test",
    );
    expect(probe.written).toBe(BIG);
    expect(probe.maxOutstanding).toBe(0);
  });
});

describe("Git checkout streams blobs into the worktree", () => {
  it("hands writeContent the blob stream, not a collected array", async () => {
    const files = createInMemoryFilesApi();
    const stores = createMemoryObjectStores();
    const staging = new MemoryStagingStore();
    const refs = new MemoryRefs();
    const fileWorktree = createFileWorktree({
      files,
      rootPath: "",
      blobs: stores.blobs,
      trees: stores.trees,
    });
    const arrays: string[] = [];
    const worktree = new Proxy(fileWorktree, {
      get(target, prop, receiver) {
        if (prop === "writeContent") {
          return (path: string, content: unknown, options?: unknown) => {
            if (Array.isArray(content)) arrays.push(path);
            return target.writeContent(path, content as Uint8Array, options as never);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Worktree;
    const history = createSimpleHistory({
      blobs: stores.blobs,
      trees: stores.trees,
      commits: stores.commits,
      tags: stores.tags,
      refs,
    });
    const git = Git.fromWorkingCopy(
      new MemoryWorkingCopy({ history, checkout: { staging } as never, worktree }),
    );

    const blobId = await stores.blobs.store([new TextEncoder().encode("hello\n")]);
    const treeId = await stores.trees.store([
      { name: "a.txt", mode: FileMode.REGULAR_FILE, id: blobId },
    ]);
    const emptyTree = await stores.trees.store([]);
    const author = testAuthor();
    const base = await stores.commits.store({
      tree: emptyTree,
      parents: [],
      author,
      committer: author,
      message: "base",
    });
    const next = await stores.commits.store({
      tree: treeId,
      parents: [base],
      author,
      committer: author,
      message: "add a.txt",
    });
    await refs.set("refs/heads/main", base);
    await refs.set("refs/heads/next", next);
    await refs.setSymbolic("HEAD", "refs/heads/main");
    await staging.readTree(stores.trees, emptyTree);

    await git.checkout().setName("next").setForced(true).call();

    const chunks: Uint8Array[] = [];
    for await (const c of files.read("a.txt")) chunks.push(c);
    expect(new TextDecoder().decode(chunks[0])).toBe("hello\n");
    expect(arrays).toEqual([]);
  });
});
