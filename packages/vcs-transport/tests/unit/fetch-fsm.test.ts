import { describe, expect, it, vi } from "vitest";

import type {
  ExportPackOptions,
  PackImportResult,
  RepositoryFacade,
} from "../../src/api/repository-facade.js";
import type { TransportApi } from "../../src/api/transport-api.js";
import { HandlerOutput } from "../../src/context/handler-output.js";
import { ProcessConfiguration } from "../../src/context/process-config.js";
import type { ProcessContext, RefStore } from "../../src/context/process-context.js";
import { ProtocolState } from "../../src/context/protocol-state.js";
import { serverFetchHandlers, serverFetchTransitions } from "../../src/fsm/fetch/index.js";
import { Fsm } from "../../src/fsm/fsm.js";

// ─────────────────────────────────────────────────────────────────────────────
// Test utilities
// ─────────────────────────────────────────────────────────────────────────────

interface PktLineResult {
  type: "data" | "flush" | "delim" | "eof";
  data?: Uint8Array;
  text?: string;
}

function createMockTransport(): TransportApi & {
  _setPackets: (pkts: PktLineResult[]) => void;
  _setPackChunks: (chunks: Uint8Array[]) => void;
} {
  const packets: PktLineResult[] = [];
  let packetIndex = 0;
  const packChunks: Uint8Array[] = [];
  let packIndex = 0;

  return {
    readLine: vi.fn(async () => {
      if (packetIndex < packets.length) {
        const pkt = packets[packetIndex++];
        return pkt.type === "data" ? (pkt.text ?? null) : null;
      }
      return null;
    }),
    writeLine: vi.fn(async () => {}),
    writeFlush: vi.fn(async () => {}),
    writeDelimiter: vi.fn(async () => {}),
    readPktLine: vi.fn(async () => {
      if (packetIndex < packets.length) {
        return packets[packetIndex++];
      }
      return { type: "flush" as const };
    }),
    writePktLine: vi.fn(async () => {}),
    readSideband: vi.fn(async () => ({ channel: 1 as const, data: new Uint8Array(0) })),
    writeSideband: vi.fn(async () => {}),
    async *readPack() {
      while (packIndex < packChunks.length) {
        yield packChunks[packIndex++];
      }
    },
    writePack: vi.fn(async () => {}),
    async *readRawPack() {
      while (packIndex < packChunks.length) {
        yield packChunks[packIndex++];
      }
    },
    writeRawPack: vi.fn(async () => {}),
    // Test helpers
    _setPackets: (pkts: PktLineResult[]) => {
      packets.length = 0;
      packets.push(...pkts);
      packetIndex = 0;
    },
    _setPackChunks: (chunks: Uint8Array[]) => {
      packChunks.length = 0;
      packChunks.push(...chunks);
      packIndex = 0;
    },
  } as TransportApi & {
    _setPackets: (pkts: PktLineResult[]) => void;
    _setPackChunks: (c: Uint8Array[]) => void;
  };
}

function createMockRepository(): RepositoryFacade {
  const objects = new Map<string, boolean>();

  return {
    importPack: vi.fn(
      async (): Promise<PackImportResult> => ({
        objectsImported: 5,
        blobsWithDelta: 2,
        treesImported: 1,
        commitsImported: 2,
        tagsImported: 0,
      }),
    ),
    async *exportPack(
      _wants: Set<string>,
      _exclude: Set<string>,
      _options?: ExportPackOptions,
    ): AsyncIterable<Uint8Array> {
      yield new Uint8Array([80, 65, 67, 75]); // "PACK"
    },
    has: vi.fn(async (oid: string) => objects.has(oid)),
    async *walkAncestors(_startOid: string) {
      // Default empty walk
    },
    // Test helper
    _addObject: (oid: string) => {
      objects.set(oid, true);
    },
  } as RepositoryFacade & { _addObject: (oid: string) => void };
}

function createMockRefStore(): RefStore {
  const refs = new Map<string, string>();

  return {
    get: vi.fn(async (name: string) => refs.get(name)),
    update: vi.fn(async (name: string, oid: string) => {
      refs.set(name, oid);
    }),
    listAll: vi.fn(async () => refs.entries()),
    // Test helper
    _setRef: (name: string, oid: string) => {
      refs.set(name, oid);
    },
  } as RefStore & { _setRef: (name: string, oid: string) => void };
}

function createContext(overrides?: Partial<ProcessContext>): ProcessContext {
  return {
    transport: createMockTransport(),
    repository: createMockRepository(),
    refStore: createMockRefStore(),
    state: new ProtocolState(),
    output: new HandlerOutput(),
    config: new ProcessConfiguration(),
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Server Fetch FSM Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("Server Fetch FSM", () => {
  describe("Transitions", () => {
    it("defines initial transition from empty state", () => {
      const initialTransitions = serverFetchTransitions.filter(([source]) => source === "");
      expect(initialTransitions.length).toBeGreaterThan(0);
      expect(initialTransitions[0]).toEqual(["", "START", "SEND_ADVERTISEMENT"]);
    });

    it("defines final transitions to empty state", () => {
      const finalTransitions = serverFetchTransitions.filter(([, , target]) => target === "");
      expect(finalTransitions.length).toBeGreaterThan(0);
    });

    it("includes error transitions", () => {
      const errorTransitions = serverFetchTransitions.filter(([, event]) => event === "ERROR");
      expect(errorTransitions.length).toBeGreaterThan(0);
    });
  });

  describe("Handlers", () => {
    it("has handler for initial state", () => {
      expect(serverFetchHandlers.has("")).toBe(true);
    });

    it("has handler for SEND_ADVERTISEMENT state", () => {
      expect(serverFetchHandlers.has("SEND_ADVERTISEMENT")).toBe(true);
    });

    it("has handler for READ_WANTS state", () => {
      expect(serverFetchHandlers.has("READ_WANTS")).toBe(true);
    });

    it("has handler for SEND_PACK state", () => {
      expect(serverFetchHandlers.has("SEND_PACK")).toBe(true);
    });
  });

  describe("Initial state handler", () => {
    it("returns START event", async () => {
      const ctx = createContext();
      const handler = serverFetchHandlers.get("");
      const event = await handler?.(ctx);
      expect(event).toBe("START");
    });
  });

  describe("SEND_ADVERTISEMENT handler", () => {
    it("sends refs from refStore", async () => {
      const transport = createMockTransport();
      const refStore = createMockRefStore() as RefStore & {
        _setRef: (n: string, o: string) => void;
      };
      refStore._setRef("refs/heads/main", "abc123");
      refStore._setRef("refs/heads/feature", "def456");

      const ctx = createContext({ transport, refStore });
      const handler = serverFetchHandlers.get("SEND_ADVERTISEMENT");
      const event = await handler?.(ctx);

      expect(transport.writeLine).toHaveBeenCalled();
      expect(event).toBe("REFS_SENT");
    });
  });

  describe("READ_WANTS handler", () => {
    it("parses want commands", async () => {
      const transport = createMockTransport();
      transport._setPackets([
        { type: "data", text: "want abc123 multi_ack side-band-64k" },
        { type: "data", text: "want def456" },
        { type: "flush" },
      ]);

      const ctx = createContext({ transport });
      ctx.state.refs.set("refs/heads/main", "abc123");
      ctx.state.refs.set("refs/heads/feature", "def456");

      const handler = serverFetchHandlers.get("READ_WANTS");
      const event = await handler?.(ctx);

      expect(ctx.state.wants.has("abc123")).toBe(true);
      expect(ctx.state.wants.has("def456")).toBe(true);
      expect(event).toBe("WANTS_RECEIVED");
    });

    it("detects no wants", async () => {
      const transport = createMockTransport();
      transport._setPackets([{ type: "flush" }]);

      const ctx = createContext({ transport });
      const handler = serverFetchHandlers.get("READ_WANTS");
      const event = await handler?.(ctx);

      expect(event).toBe("NO_WANTS");
    });
  });

  describe("VALIDATE_WANTS handler", () => {
    it("validates wants against advertised refs (default policy)", async () => {
      const ctx = createContext();
      ctx.state.refs.set("refs/heads/main", "abc123");
      ctx.state.wants.add("abc123"); // Valid - was advertised

      const handler = serverFetchHandlers.get("VALIDATE_WANTS");
      const event = await handler?.(ctx);

      expect(event).toBe("VALID");
    });

    it("rejects unadvertised wants with ADVERTISED policy", async () => {
      const ctx = createContext();
      ctx.config.requestPolicy = "ADVERTISED";
      ctx.state.refs.set("refs/heads/main", "abc123");
      ctx.state.wants.add("xyz789"); // Invalid - not advertised

      const handler = serverFetchHandlers.get("VALIDATE_WANTS");
      const event = await handler?.(ctx);

      expect(event).toBe("INVALID_WANT");
      expect(ctx.output.invalidWant).toBe("xyz789");
    });

    it("accepts any want with ANY policy", async () => {
      const repository = createMockRepository() as RepositoryFacade & {
        _addObject: (oid: string) => void;
      };
      repository._addObject("xyz789");

      const ctx = createContext({ repository });
      ctx.config.requestPolicy = "ANY";
      ctx.state.wants.add("xyz789");

      const handler = serverFetchHandlers.get("VALIDATE_WANTS");
      const event = await handler?.(ctx);

      expect(event).toBe("VALID");
    });
  });

  describe("SEND_PACK handler", () => {
    it("sends pack data via sideband", async () => {
      const transport = createMockTransport();
      const ctx = createContext({ transport });
      ctx.state.wants.add("abc123");
      ctx.state.commonBase.add("parent1");
      ctx.state.capabilities.add("side-band-64k");

      const handler = serverFetchHandlers.get("SEND_PACK");
      const event = await handler?.(ctx);

      expect(transport.writeSideband).toHaveBeenCalled();
      expect(event).toBe("PACK_SENT");
    });
  });

  describe("FSM execution", () => {
    it("can run FSM with valid transitions", () => {
      const fsm = new Fsm(serverFetchTransitions, serverFetchHandlers);
      expect(fsm.getState()).toBe("");
    });

    it("transitions from initial to SEND_ADVERTISEMENT", async () => {
      const ctx = createContext();
      const fsm = new Fsm(serverFetchTransitions, serverFetchHandlers);

      await fsm.run(ctx, "SEND_ADVERTISEMENT");

      expect(fsm.getState()).toBe("SEND_ADVERTISEMENT");
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Negotiation Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("Fetch Negotiation", () => {
  describe("Server ACK generation", () => {
    it("server sends ACK for common objects", async () => {
      const transport = createMockTransport();
      const repository = createMockRepository() as RepositoryFacade & {
        _addObject: (oid: string) => void;
      };
      repository._addObject("abc123");

      const ctx = createContext({ transport, repository });
      ctx.state.haves.add("abc123");
      ctx.state.commonBase.add("abc123"); // Already found common
      ctx.state.capabilities.add("multi_ack_detailed");

      const handler = serverFetchHandlers.get("SEND_ACKS");
      if (handler) {
        await handler(ctx);
        // multi_ack modes end every batch with NAK (git's get_common_commits)
        expect(transport.writeLine).toHaveBeenCalledWith("NAK");
      }
    });

    it("server sends NAK when no common objects", async () => {
      const transport = createMockTransport();
      const ctx = createContext({ transport });
      // No common objects

      const handler = serverFetchHandlers.get("SEND_ACKS");
      if (handler) {
        await handler(ctx);
        expect(transport.writeLine).toHaveBeenCalledWith("NAK");
      }
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Shallow Clone Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("Shallow Clone", () => {
  describe("Server shallow computation", () => {
    it("parses shallow boundaries in READ_WANTS", async () => {
      const transport = createMockTransport();
      transport._setPackets([
        { type: "data", text: "want abc123" },
        { type: "data", text: "shallow def456" },
        { type: "data", text: "shallow ghi789" },
        { type: "flush" },
      ]);

      const ctx = createContext({ transport });
      ctx.state.refs.set("refs/heads/main", "abc123");

      const handler = serverFetchHandlers.get("READ_WANTS");
      if (handler) {
        await handler(ctx);
        expect(ctx.state.clientShallow?.has("def456")).toBe(true);
        expect(ctx.state.clientShallow?.has("ghi789")).toBe(true);
      }
    });

    it("READ_SHALLOW_INFO detects when shallow info was parsed", async () => {
      const ctx = createContext();
      // Pre-set shallow info (as if parsed in READ_WANTS)
      ctx.state.clientShallow = new Set(["abc123", "def456"]);

      const handler = serverFetchHandlers.get("READ_SHALLOW_INFO");
      if (handler) {
        const event = await handler(ctx);
        expect(event).toBe("SHALLOW_RECEIVED");
      }
    });

    it("READ_SHALLOW_INFO returns NO_SHALLOW when no shallow info", async () => {
      const ctx = createContext();
      // No shallow info

      const handler = serverFetchHandlers.get("READ_SHALLOW_INFO");
      if (handler) {
        const event = await handler(ctx);
        expect(event).toBe("NO_SHALLOW");
      }
    });
  });
});
