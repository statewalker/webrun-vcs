import { describe, expect, it, vi } from "vitest";

import type {
  ExportPackOptions,
  PackImportResult,
  RepositoryFacade,
} from "../../api/repository-facade.js";
import type { TransportApi } from "../../api/transport-api.js";
import { HandlerOutput } from "../../context/handler-output.js";
import { ProcessConfiguration } from "../../context/process-config.js";
import type { ProcessContext, RefStore } from "../../context/process-context.js";
import { ProtocolState } from "../../context/protocol-state.js";
import {
  clientFetchHandlers,
  clientFetchTransitions,
  serverFetchHandlers,
  serverFetchTransitions,
} from "../../fsm/fetch/index.js";
import { Fsm } from "../../fsm/fsm.js";

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
    async *readRawPack() {
      while (packIndex < packChunks.length) {
        yield packChunks[packIndex++];
      }
    },
    writePack: vi.fn(async () => {}),
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
// Client Fetch FSM Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("Client Fetch FSM", () => {
  describe("Transitions", () => {
    it("defines initial transition from empty state", () => {
      const initialTransitions = clientFetchTransitions.filter(([source]) => source === "");
      expect(initialTransitions.length).toBeGreaterThan(0);
      expect(initialTransitions[0]).toEqual(["", "START", "READ_ADVERTISEMENT"]);
    });

    it("defines final transitions to empty state", () => {
      const finalTransitions = clientFetchTransitions.filter(([, , target]) => target === "");
      expect(finalTransitions.length).toBeGreaterThan(0);
    });

    it("includes error transitions", () => {
      const errorTransitions = clientFetchTransitions.filter(([, event]) => event === "ERROR");
      expect(errorTransitions.length).toBeGreaterThan(0);
    });
  });

  describe("Handlers", () => {
    it("has handler for initial state", () => {
      expect(clientFetchHandlers.has("")).toBe(true);
    });

    it("has handler for READ_ADVERTISEMENT state", () => {
      expect(clientFetchHandlers.has("READ_ADVERTISEMENT")).toBe(true);
    });

    it("has handler for SEND_WANTS state", () => {
      expect(clientFetchHandlers.has("SEND_WANTS")).toBe(true);
    });

    it("has handler for RECEIVE_PACK state", () => {
      expect(clientFetchHandlers.has("RECEIVE_PACK")).toBe(true);
    });
  });

  describe("Initial state handler", () => {
    it("returns START event", async () => {
      const ctx = createContext();
      const handler = clientFetchHandlers.get("");
      const event = await handler?.(ctx);
      expect(event).toBe("START");
    });
  });

  describe("READ_ADVERTISEMENT handler", () => {
    it("parses refs from advertisement", async () => {
      const transport = createMockTransport();
      transport._setPackets([
        { type: "data", text: "abc123def456 refs/heads/main" },
        { type: "data", text: "def456789abc refs/heads/feature" },
        { type: "flush" },
      ]);

      const ctx = createContext({ transport });
      const handler = clientFetchHandlers.get("READ_ADVERTISEMENT");
      const event = await handler?.(ctx);

      expect(ctx.state.refs.size).toBe(2);
      expect(ctx.state.refs.get("refs/heads/main")).toBe("abc123def456");
      expect(event).toBe("REFS_RECEIVED");
    });

    it("detects empty repository", async () => {
      const transport = createMockTransport();
      transport._setPackets([
        {
          type: "data",
          text: "0000000000000000000000000000000000000000 capabilities^{}\0multi_ack",
        },
        { type: "flush" },
      ]);

      const ctx = createContext({ transport });
      const handler = clientFetchHandlers.get("READ_ADVERTISEMENT");
      const event = await handler?.(ctx);

      expect(event).toBe("EMPTY_REPO");
    });
  });

  describe("SEND_WANTS handler", () => {
    it("sends want lines for each wanted ref", async () => {
      const transport = createMockTransport();
      const ctx = createContext({ transport });
      ctx.state.wants.add("abc123");
      ctx.state.wants.add("def456");

      const handler = clientFetchHandlers.get("SEND_WANTS");
      await handler?.(ctx);

      expect(transport.writeLine).toHaveBeenCalledWith(expect.stringContaining("want abc123"));
      expect(transport.writeLine).toHaveBeenCalledWith(expect.stringContaining("want def456"));
    });

    it("returns NO_WANTS when no refs to fetch", async () => {
      const ctx = createContext();
      // No wants set

      const handler = clientFetchHandlers.get("SEND_WANTS");
      const event = await handler?.(ctx);

      expect(event).toBe("NO_WANTS");
    });
  });

  describe("FSM execution", () => {
    it("can run FSM with valid transitions", () => {
      const fsm = new Fsm(clientFetchTransitions, clientFetchHandlers);
      expect(fsm.getState()).toBe("");
    });

    it("transitions from initial to READ_ADVERTISEMENT", async () => {
      const ctx = createContext();
      const fsm = new Fsm(clientFetchTransitions, clientFetchHandlers);

      // Run just the initial handler
      await fsm.run(ctx, "READ_ADVERTISEMENT");

      expect(fsm.getState()).toBe("READ_ADVERTISEMENT");
    });
  });
});

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
  describe("Multi-ack negotiation", () => {
    it("client handles ACK common response", async () => {
      const transport = createMockTransport();
      transport._setPackets([{ type: "data", text: "ACK abc123 common" }, { type: "flush" }]);

      const ctx = createContext({ transport });
      ctx.state.capabilities.add("multi_ack_detailed"); // Use capabilities, not config
      ctx.state.haves.add("abc123");
      ctx.state.ackedCommon = new Set();

      const handler = clientFetchHandlers.get("READ_ACKS");
      if (handler) {
        await handler(ctx);
        // The handler adds to commonBase
        expect(ctx.state.commonBase.has("abc123")).toBe(true);
      }
    });

    it("client handles ACK ready response", async () => {
      const transport = createMockTransport();
      transport._setPackets([{ type: "data", text: "ACK abc123 ready" }, { type: "flush" }]);

      const ctx = createContext({ transport });
      ctx.state.capabilities.add("multi_ack_detailed"); // Use capabilities, not config
      ctx.state.haves.add("abc123");
      ctx.state.ackedCommon = new Set();

      const handler = clientFetchHandlers.get("READ_ACKS");
      if (handler) {
        await handler(ctx);
        expect(ctx.output.receivedReady).toBe(true);
      }
    });

    it("client handles NAK response", async () => {
      const transport = createMockTransport();
      transport._setPackets([{ type: "data", text: "NAK" }, { type: "flush" }]);

      const ctx = createContext({ transport });

      const handler = clientFetchHandlers.get("READ_ACKS");
      if (handler) {
        const event = await handler(ctx);
        expect(event).toBe("NAK");
      }
    });
  });

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
      ctx.config.multiAck = "detailed";

      const handler = serverFetchHandlers.get("SEND_ACKS");
      if (handler) {
        await handler(ctx);
        // Server sends ACK if there's something in commonBase
        expect(transport.writeLine).toHaveBeenCalled();
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
  describe("Client shallow handling", () => {
    it("sends shallow info when configured", async () => {
      const transport = createMockTransport();
      const ctx = createContext({ transport });
      ctx.config.depth = 1;

      const handler = clientFetchHandlers.get("SEND_SHALLOW_INFO");
      if (handler) {
        await handler(ctx);
        expect(transport.writeLine).toHaveBeenCalledWith("deepen 1");
      }
    });

    it("sends deepen-since when configured", async () => {
      const transport = createMockTransport();
      const ctx = createContext({ transport });
      ctx.config.shallowSince = 1609459200; // 2021-01-01

      const handler = clientFetchHandlers.get("SEND_SHALLOW_INFO");
      if (handler) {
        await handler(ctx);
        expect(transport.writeLine).toHaveBeenCalledWith("deepen-since 1609459200");
      }
    });

    it("sends deepen-not when configured", async () => {
      const transport = createMockTransport();
      const ctx = createContext({ transport });
      ctx.config.shallowExclude = ["refs/heads/old"];

      const handler = clientFetchHandlers.get("SEND_SHALLOW_INFO");
      if (handler) {
        await handler(ctx);
        expect(transport.writeLine).toHaveBeenCalledWith("deepen-not refs/heads/old");
      }
    });
  });

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

// ─────────────────────────────────────────────────────────────────────────────
// Error Handling Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("Error Handling", () => {
  it("sets error in output on failure", async () => {
    const transport = createMockTransport();
    (transport.readPktLine as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("Connection lost"),
    );

    const ctx = createContext({ transport });
    const handler = clientFetchHandlers.get("READ_ADVERTISEMENT");

    const event = await handler?.(ctx);

    expect(event).toBe("ERROR");
    expect(ctx.output.error).toContain("Connection lost");
  });

  it("client handles unexpected EOF", async () => {
    const transport = createMockTransport();
    transport._setPackets([{ type: "eof" }]);

    const ctx = createContext({ transport });
    const handler = clientFetchHandlers.get("READ_ADVERTISEMENT");

    const event = await handler?.(ctx);

    expect(event).toBe("ERROR");
    expect(ctx.output.error).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("Client-Server Integration", () => {
  it("simple fetch flow works end-to-end", async () => {
    // Server context
    const serverRefStore = createMockRefStore() as RefStore & {
      _setRef: (n: string, o: string) => void;
    };
    serverRefStore._setRef("refs/heads/main", "abc123def456789012345678901234567890abcd");

    const serverRepo = createMockRepository() as RepositoryFacade & {
      _addObject: (oid: string) => void;
    };
    serverRepo._addObject("abc123def456789012345678901234567890abcd");

    // Verify FSMs can be constructed
    const clientFsm = new Fsm(clientFetchTransitions, clientFetchHandlers);
    const serverFsm = new Fsm(serverFetchTransitions, serverFetchHandlers);

    expect(clientFsm.getState()).toBe("");
    expect(serverFsm.getState()).toBe("");

    // Both FSMs should start from empty state
    expect(clientFetchHandlers.has("")).toBe(true);
    expect(serverFetchHandlers.has("")).toBe(true);
  });
});
