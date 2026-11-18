/**
 * The small-blob cache the commands of one `git log -p` share (`sharingBlobs`): opens of one
 * id racing each other keep one copy and count its bytes once, and the byte count never
 * drives the eviction loop past an empty cache.
 */
import type { BlobRead, Blobs, ObjectId } from "@statewalker/vcs-core";
import { OrderedMap } from "@statewalker/vcs-utils";
import { describe, expect, it } from "vitest";
import { type SharedBlobs, sharingBlobs } from "../src/git-command.js";

async function* single(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
}

/** Blobs whose `open` answers after a turn of the event loop, a fresh buffer each time */
function slowBlobs(contents: Map<string, number>): { blobs: Blobs; reads: () => number } {
  let reads = 0;
  const blobs = {
    async open(id: ObjectId): Promise<BlobRead | undefined> {
      const size = contents.get(id);
      if (size === undefined) return undefined;
      reads++;
      await new Promise((resolve) => setTimeout(resolve, 1));
      const bytes = new Uint8Array(size).fill(id.charCodeAt(0));
      return { size, bytes, content: single(bytes) };
    },
  } as unknown as Blobs;
  return { blobs, reads: () => reads };
}

describe("sharingBlobs", () => {
  it("keeps one copy of a blob opened concurrently and counts it once", async () => {
    const shared: SharedBlobs = { recent: new OrderedMap(), bytes: 0 };
    const { blobs } = slowBlobs(new Map([["a".repeat(40), 100]]));
    const cached = sharingBlobs(blobs, shared);
    const id = "a".repeat(40) as ObjectId;
    const opened = await Promise.all([cached.open?.(id), cached.open?.(id), cached.open?.(id)]);
    expect(shared.recent.size).toBe(1);
    expect(shared.bytes).toBe(100);
    // every reader gets the kept buffer, so the line tables diffs keep by buffer are shared
    const kept = shared.recent.get(id);
    for (const blob of opened) expect(blob?.bytes).toBe(kept);
    // a later open is a hit
    expect((await cached.open?.(id))?.bytes).toBe(kept);
    expect(shared.bytes).toBe(100);
  });

  it("stops evicting at an empty cache when the byte count drifted", async () => {
    // a count above the limit with nothing kept would loop forever without the size check
    const shared: SharedBlobs = { recent: new OrderedMap(), bytes: 2 ** 40 };
    const { blobs } = slowBlobs(new Map([["b".repeat(40), 10]]));
    const cached = sharingBlobs(blobs, shared);
    const blob = await cached.open?.("b".repeat(40) as ObjectId);
    expect(blob?.size).toBe(10);
    expect(shared.recent.size).toBe(0);
    expect(shared.bytes).toBe(0);
  });
});
