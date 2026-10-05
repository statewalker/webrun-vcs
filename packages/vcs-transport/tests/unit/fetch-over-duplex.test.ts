/**
 * Unit tests for fetchOverDuplex refspec mapping.
 *
 * Verifies that server-advertised refs are correctly mapped
 * through refspecs before writing to the local refStore.
 *
 * The Fsm is mocked to skip actual protocol exchange —
 * these tests focus on the post-FSM ref mapping logic.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Duplex } from "../../src/api/duplex.js";
import type { RepositoryFacade } from "../../src/api/repository-facade.js";
import type { RefStore } from "../../src/context/process-context.js";
import type { ProtocolState } from "../../src/context/protocol-state.js";

// Deterministic test OIDs
const OID_MAIN = "a".repeat(40);
const OID_FEATURE = "b".repeat(40);

/**
 * Server refs to inject into the mock FSM.
 * Set by each test before calling fetchOverDuplex.
 */
let mockServerRefs: Map<string, string>;

// Mock the Fsm class so run() populates state.refs and returns true,
// bypassing the complex Git protocol exchange.
vi.mock("../../src/fsm/fsm.js", () => ({
  Fsm: class MockFsm {
    async run(ctx: { state: ProtocolState }) {
      for (const [name, oid] of mockServerRefs) {
        ctx.state.refs.set(name, oid);
      }
      return true;
    }
  },
}));

// Import fetchOverDuplex AFTER the mock is set up
const { fetchOverDuplex } = await import("../../src/operations/fetch-over-duplex.js");

/**
 * Create a no-op Duplex (the mock FSM ignores it anyway).
 */
function createNoopDuplex(): Duplex {
  return {
    async *[Symbol.asyncIterator]() {
      // never yields
    },
    write() {},
  };
}

/**
 * Create a mock refStore that tracks updates.
 */
function createMockRefStore(): RefStore & {
  _getRefs(): Map<string, string>;
} {
  const refs = new Map<string, string>();
  return {
    get: vi.fn(async (name: string) => refs.get(name)),
    update: vi.fn(async (name: string, oid: string) => {
      refs.set(name, oid);
    }),
    listAll: vi.fn(async () => refs.entries()),
    _getRefs: () => new Map(refs),
  };
}

/**
 * Create a minimal mock repository.
 */
function createMockRepository(): RepositoryFacade {
  return {
    async importPack() {
      return {
        objectsImported: 0,
        blobsWithDelta: 0,
        treesImported: 0,
        commitsImported: 0,
        tagsImported: 0,
      };
    },
    async *exportPack() {},
    async has() {
      return false;
    },
    async *walkAncestors() {},
  };
}

describe("fetchOverDuplex refspec mapping", () => {
  let repository: RepositoryFacade;
  let refStore: ReturnType<typeof createMockRefStore>;
  let duplex: Duplex;

  beforeEach(() => {
    repository = createMockRepository();
    refStore = createMockRefStore();
    duplex = createNoopDuplex();
    mockServerRefs = new Map();
  });

  it("writes refs directly when no refspecs provided (backward compatible)", async () => {
    mockServerRefs = new Map([
      ["refs/heads/main", OID_MAIN],
      ["refs/heads/feature", OID_FEATURE],
    ]);

    const result = await fetchOverDuplex({
      duplex,
      repository,
      refStore,
    });

    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    const refs = refStore._getRefs();
    expect(refs.get("refs/heads/main")).toBe(OID_MAIN);
    expect(refs.get("refs/heads/feature")).toBe(OID_FEATURE);
  });

  it("maps refs through wildcard refspec", async () => {
    mockServerRefs = new Map([
      ["refs/heads/main", OID_MAIN],
      ["refs/heads/feature", OID_FEATURE],
    ]);

    const result = await fetchOverDuplex({
      duplex,
      repository,
      refStore,
      refspecs: ["+refs/heads/*:refs/remotes/origin/*"],
    });

    expect(result.success).toBe(true);
    const refs = refStore._getRefs();
    // Refs should be mapped to remotes namespace
    expect(refs.get("refs/remotes/origin/main")).toBe(OID_MAIN);
    expect(refs.get("refs/remotes/origin/feature")).toBe(OID_FEATURE);
    // Server-side names should NOT be written
    expect(refs.has("refs/heads/main")).toBe(false);
    expect(refs.has("refs/heads/feature")).toBe(false);
  });

  it("maps refs through exact refspec", async () => {
    mockServerRefs = new Map([
      ["refs/heads/main", OID_MAIN],
      ["refs/heads/feature", OID_FEATURE],
    ]);

    const result = await fetchOverDuplex({
      duplex,
      repository,
      refStore,
      refspecs: ["refs/heads/main:refs/remotes/peer/main"],
    });

    expect(result.success).toBe(true);
    const refs = refStore._getRefs();
    // Only refs/heads/main should be mapped
    expect(refs.get("refs/remotes/peer/main")).toBe(OID_MAIN);
    // refs/heads/feature doesn't match the refspec, so it's not written
    expect(refs.has("refs/heads/feature")).toBe(false);
    expect(refs.has("refs/heads/main")).toBe(false);
  });

  it("skips negative refspecs during mapping", async () => {
    mockServerRefs = new Map([
      ["refs/heads/main", OID_MAIN],
      ["refs/heads/feature", OID_FEATURE],
    ]);

    const result = await fetchOverDuplex({
      duplex,
      repository,
      refStore,
      refspecs: ["+refs/heads/*:refs/remotes/origin/*", "^refs/heads/feature"],
    });

    expect(result.success).toBe(true);
    const refs = refStore._getRefs();
    // Both should be mapped through the wildcard spec since negative refspecs
    // are skipped during the mapping phase
    expect(refs.get("refs/remotes/origin/main")).toBe(OID_MAIN);
    expect(refs.get("refs/remotes/origin/feature")).toBe(OID_FEATURE);
  });

  it("returns mapped ref names in updatedRefs", async () => {
    mockServerRefs = new Map([["refs/heads/main", OID_MAIN]]);

    const result = await fetchOverDuplex({
      duplex,
      repository,
      refStore,
      refspecs: ["+refs/heads/*:refs/remotes/peer/*"],
    });

    expect(result.success).toBe(true);
    expect(result.updatedRefs?.get("refs/remotes/peer/main")).toBe(OID_MAIN);
    expect(result.updatedRefs?.has("refs/heads/main")).toBe(false);
  });
});
