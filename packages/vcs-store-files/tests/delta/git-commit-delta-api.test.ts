/**
 * Tests for GitFilesCommitDeltaApi
 *
 * Uses real PackDeltaStore with in-memory FilesApi to validate the full
 * deltify -> isDelta -> getDeltaChain -> undeltify cycle.
 */

import {
  createInMemoryFilesApi,
  type FilesApi,
  GitDeltaCompressor,
  GitFilesCommitDeltaApi,
  parseBinaryDelta,
} from "@statewalker/vcs-core";
import { setCompressionUtils } from "@statewalker/vcs-utils";
import { createNodeCompression } from "@statewalker/vcs-utils-node/compression";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PackDeltaStore } from "../../src/pack/index.js";

beforeAll(() => {
  setCompressionUtils(createNodeCompression());
});

function oid(seed: string): string {
  return seed.padStart(40, "0");
}

async function* toStream(data: Uint8Array): AsyncIterable<Uint8Array> {
  yield data;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const result = new Uint8Array(a.length + b.length);
  result.set(a, 0);
  result.set(b, a.length);
  return result;
}

describe("GitFilesCommitDeltaApi (real PackDeltaStore)", () => {
  let files: FilesApi;
  let packDeltaStore: PackDeltaStore;
  let api: GitFilesCommitDeltaApi;
  const compressor = new GitDeltaCompressor();

  beforeEach(async () => {
    files = createInMemoryFilesApi();
    packDeltaStore = new PackDeltaStore({ files, basePath: "/pack" });
    await packDeltaStore.initialize();

    api = new GitFilesCommitDeltaApi(packDeltaStore);
  });

  it("findCommitDelta returns null (computation is external)", async () => {
    async function* empty(): AsyncIterable<string> {}
    expect(await api.findCommitDelta(oid("abc"), empty())).toBeNull();
  });

  it("isCommitDelta returns false for non-existent object", async () => {
    expect(await api.isCommitDelta(oid("missing"))).toBe(false);
  });

  it("getCommitDeltaChain returns undefined for non-delta", async () => {
    expect(await api.getCommitDeltaChain(oid("missing"))).toBeUndefined();
  });

  it("deltifyCommit stores delta and isCommitDelta returns true", async () => {
    // Create real base and target content (simulating serialized commits)
    const base = new TextEncoder().encode(
      `tree ${oid("t1")}\nauthor Test <t@e.com> 1700000000 +0000\n` +
        `committer Test <t@e.com> 1700000000 +0000\n\nFirst commit message`,
    );
    const target = new TextEncoder().encode(
      `tree ${oid("t2")}\nparent ${oid("c1")}\nauthor Test <t@e.com> 1700000000 +0000\n` +
        `committer Test <t@e.com> 1700000000 +0000\n\nSecond commit message`,
    );

    // Store the base object in pack
    const update = packDeltaStore.startUpdate();
    const header = new TextEncoder().encode(`commit ${base.length}\0`);
    await update.storeObject(oid("base"), [concat(header, base)]);
    await update.close();

    // Compute a real delta
    const deltaResult = compressor.computeDelta(base, target);
    expect(deltaResult).not.toBeNull();
    if (!deltaResult) return;

    // deltifyCommit should parse the binary delta and store via PackDeltaStore
    await api.deltifyCommit(oid("target"), oid("base"), toStream(deltaResult.delta));
    expect(await api.isCommitDelta(oid("target"))).toBe(true);
  });

  it("full cycle: deltify -> isDelta -> getDeltaChain -> undeltify", async () => {
    // Create substantial content so delta works well
    const base = new Uint8Array(200);
    for (let i = 0; i < base.length; i++) {
      base[i] = ((i * 7 + 3) ^ (i >> 2)) & 0xff;
    }

    const target = new Uint8Array(base);
    target[0] = 0xff;
    target[100] = 0xff;

    // Compute delta
    const deltaResult = compressor.computeDelta(base, target);
    expect(deltaResult).not.toBeNull();
    if (!deltaResult) return;

    // Store base + delta in the same pack so chain resolution works
    // (PackReader resolves REF_DELTA within a single pack)
    const update = packDeltaStore.startUpdate();
    const header = new TextEncoder().encode(`commit ${base.length}\0`);
    await update.storeObject(oid("base"), [concat(header, base)]);
    const deltaInstructions = parseBinaryDelta(deltaResult.delta);
    await update.storeDelta({ baseKey: oid("base"), targetKey: oid("target") }, deltaInstructions);
    await update.close();

    // Verify delta state
    expect(await api.isCommitDelta(oid("target"))).toBe(true);

    // Verify chain info
    const chain = await api.getCommitDeltaChain(oid("target"));
    expect(chain).toBeDefined();
    if (!chain) return;
    expect(chain.depth).toBeGreaterThanOrEqual(1);
    expect(chain.baseIds.length).toBeGreaterThanOrEqual(1);

    // Undeltify removes the delta relationship
    await api.undeltifyCommit(oid("target"));
  });

  it("undeltifyCommit throws when object not found", async () => {
    await expect(api.undeltifyCommit(oid("missing"))).rejects.toThrow(/not found in pack files/);
  });

  it("deltifyCommit works with multi-chunk delta stream", async () => {
    const base = new Uint8Array(200);
    for (let i = 0; i < base.length; i++) {
      base[i] = ((i * 13 + 5) ^ (i >> 3)) & 0xff;
    }

    const target = new Uint8Array(base);
    target[50] = 0xaa;
    target[150] = 0xbb;

    // Store base
    const update = packDeltaStore.startUpdate();
    const header = new TextEncoder().encode(`commit ${base.length}\0`);
    await update.storeObject(oid("base2"), [concat(header, base)]);
    await update.close();

    // Compute delta and split into multiple chunks
    const deltaResult = compressor.computeDelta(base, target);
    expect(deltaResult).not.toBeNull();
    if (!deltaResult) return;

    const deltaBytes = deltaResult.delta;
    const mid = Math.floor(deltaBytes.length / 2);

    async function* multiChunkStream(): AsyncIterable<Uint8Array> {
      yield deltaBytes.subarray(0, mid);
      yield deltaBytes.subarray(mid);
    }

    await api.deltifyCommit(oid("target2"), oid("base2"), multiChunkStream());
    expect(await api.isCommitDelta(oid("target2"))).toBe(true);
  });

  it("getCommitDeltaChain maps fields correctly", async () => {
    const base = new Uint8Array(200);
    for (let i = 0; i < base.length; i++) {
      base[i] = ((i * 19 + 7) ^ (i >> 1)) & 0xff;
    }

    const target = new Uint8Array(base);
    target[10] = 0xcc;

    // Compute delta
    const deltaResult = compressor.computeDelta(base, target);
    expect(deltaResult).not.toBeNull();
    if (!deltaResult) return;

    // Store base + delta in same pack for chain resolution
    const update = packDeltaStore.startUpdate();
    const header = new TextEncoder().encode(`commit ${base.length}\0`);
    await update.storeObject(oid("chainbase"), [concat(header, base)]);
    const deltaInstructions = parseBinaryDelta(deltaResult.delta);
    await update.storeDelta(
      { baseKey: oid("chainbase"), targetKey: oid("chaintarget") },
      deltaInstructions,
    );
    await update.close();

    const chain = await api.getCommitDeltaChain(oid("chaintarget"));
    expect(chain).toBeDefined();
    if (!chain) return;
    expect(chain.depth).toBe(1);
    expect(typeof chain.totalSize).toBe("number");
    expect(Array.isArray(chain.baseIds)).toBe(true);
  });
});
