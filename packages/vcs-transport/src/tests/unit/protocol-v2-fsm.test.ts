import { beforeEach, describe, expect, it } from "vitest";
import type { PackImportResult, RepositoryFacade } from "../../api/repository-facade.js";
import type { PktLineResult, SidebandResult, TransportApi } from "../../api/transport-api.js";
import { HandlerOutput } from "../../context/handler-output.js";
import { ProcessConfiguration } from "../../context/process-config.js";
import type { ProcessContext, RefStore } from "../../context/process-context.js";
import { ProtocolState } from "../../context/protocol-state.js";
import { Fsm } from "../../fsm/index.js";
import {
  clientV2Handlers,
  clientV2Transitions,
  createEmptyFetchRequest,
  type FetchV2Request,
  SERVER_V2_CAPABILITIES,
  serverV2Handlers,
  serverV2Transitions,
} from "../../fsm/protocol-v2/index.js";

// Mock transport that records calls and returns configured responses
function createMockTransport(responses: PktLineResult[] = []): TransportApi & {
  written: string[];
  sidebandWritten: Array<{ channel: number; data: Uint8Array }>;
  packWritten: Uint8Array[];
  responseIndex: number;
} {
  let responseIndex = 0;

  return {
    written: [],
    sidebandWritten: [],
    packWritten: [],
    responseIndex: 0,

    async readPktLine(): Promise<PktLineResult> {
      if (responseIndex >= responses.length) {
        return { type: "flush" };
      }
      return responses[responseIndex++];
    },

    async writePktLine(data: string | Uint8Array): Promise<void> {
      const text = typeof data === "string" ? data : new TextDecoder().decode(data);
      this.written.push(text);
    },

    async writeFlush(): Promise<void> {
      this.written.push("FLUSH");
    },

    async writeDelimiter(): Promise<void> {
      this.written.push("DELIM");
    },

    async readLine(): Promise<string | null> {
      const pkt = await this.readPktLine();
      if (pkt.type === "data") return pkt.text;
      return null;
    },

    async writeLine(line: string): Promise<void> {
      this.written.push(line);
    },

    async readSideband(): Promise<SidebandResult> {
      return { channel: 1, data: new Uint8Array(0) };
    },

    async writeSideband(channel: 1 | 2 | 3, data: Uint8Array): Promise<void> {
      this.sidebandWritten.push({ channel, data });
    },

    async *readPack(): AsyncGenerator<Uint8Array> {
      // Return empty pack
    },

    async *readRawPack(): AsyncGenerator<Uint8Array> {
      // Return empty pack
    },

    async writePack(data: AsyncIterable<Uint8Array>): Promise<void> {
      for await (const chunk of data) {
        this.packWritten.push(chunk);
      }
    },

    async writeRawPack(data: AsyncIterable<Uint8Array>): Promise<void> {
      for await (const chunk of data) {
        this.packWritten.push(chunk);
      }
    },
  };
}

// Mock repository facade
function createMockRepository(objects: Set<string> = new Set()): RepositoryFacade {
  return {
    async importPack(): Promise<PackImportResult> {
      return {
        objectsImported: 0,
        blobsWithDelta: 0,
        treesImported: 0,
        commitsImported: 0,
        tagsImported: 0,
      };
    },
    async *exportPack(): AsyncIterable<Uint8Array> {
      // Return minimal pack header
      yield new Uint8Array([
        0x50, 0x41, 0x43, 0x4b, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x02, 0x9d, 0x08,
        0x82, 0x3b, 0xd8, 0xa8, 0xea, 0xb5, 0x10, 0xad, 0x6a, 0xc7, 0x5c, 0x82, 0x3c, 0xfd, 0x3e,
        0xd3, 0x1e,
      ]);
    },
    async has(oid: string): Promise<boolean> {
      return objects.has(oid);
    },
    async *walkAncestors(): AsyncGenerator<string> {
      // Empty generator
    },
    async getObjectSize(oid: string): Promise<number | null> {
      if (objects.has(oid)) return 42;
      return null;
    },
    async peelTag(oid: string): Promise<string | null> {
      // Just return the oid for simplicity
      return oid;
    },
  };
}

// Mock ref store with symref support
function createMockRefStore(
  refs: Map<string, string> = new Map(),
  symrefs: Map<string, string> = new Map(),
): RefStore & { getSymrefTarget?: (name: string) => Promise<string | undefined> } {
  return {
    async get(name: string): Promise<string | undefined> {
      return refs.get(name);
    },
    async update(name: string, oid: string): Promise<void> {
      refs.set(name, oid);
    },
    async listAll(): Promise<Iterable<[string, string]>> {
      return refs.entries();
    },
    async getSymrefTarget(name: string): Promise<string | undefined> {
      return symrefs.get(name);
    },
  };
}

describe("Protocol V2 FSM Types", () => {
  describe("createEmptyFetchRequest", () => {
    it("creates a properly initialized request", () => {
      const req = createEmptyFetchRequest();
      expect(req.wants).toEqual([]);
      expect(req.wantRefs).toEqual([]);
      expect(req.haves).toEqual([]);
      expect(req.done).toBe(false);
      expect(req.shallow).toEqual([]);
      expect(req.deepen).toBe(0);
      expect(req.filter).toBe(null);
    });
  });

  describe("SERVER_V2_CAPABILITIES", () => {
    it("includes required capabilities", () => {
      expect(SERVER_V2_CAPABILITIES).toContain("ls-refs");
      expect(SERVER_V2_CAPABILITIES.some((c) => c.startsWith("fetch="))).toBe(true);
      expect(SERVER_V2_CAPABILITIES.some((c) => c.startsWith("object-format="))).toBe(true);
    });
  });
});

describe("Client V2 FSM", () => {
  let transport: ReturnType<typeof createMockTransport>;
  let repository: RepositoryFacade;
  let refStore: ReturnType<typeof createMockRefStore>;
  let context: ProcessContext;

  beforeEach(() => {
    transport = createMockTransport();
    repository = createMockRepository();
    refStore = createMockRefStore(new Map([["refs/heads/main", "abc123".padEnd(40, "0")]]));
    context = {
      transport,
      repository,
      refStore,
      state: new ProtocolState(),
      output: new HandlerOutput(),
      config: new ProcessConfiguration(),
    };
  });

  describe("READ_CAPABILITIES state", () => {
    it("reads server capabilities", async () => {
      transport = createMockTransport([
        { type: "data", payload: new Uint8Array(0), text: "version 2" },
        { type: "data", payload: new Uint8Array(0), text: "ls-refs" },
        { type: "data", payload: new Uint8Array(0), text: "fetch=shallow filter" },
        { type: "data", payload: new Uint8Array(0), text: "server-option" },
        { type: "flush" },
      ]);
      context.transport = transport;

      const fsm = new Fsm(clientV2Transitions, clientV2Handlers);
      await fsm.run(context, "SEND_LS_REFS");

      expect(fsm.getState()).toBe("SEND_LS_REFS");
      expect(context.state.protocolVersion).toBe(2);
      expect(context.state.capabilities.has("ls-refs")).toBe(true);
      expect(context.state.capabilities.has("fetch")).toBe(true);
      expect(context.state.capabilityValues?.get("fetch")).toBe("shallow filter");
    });

    it("handles EOF error", async () => {
      transport = createMockTransport([{ type: "eof" }]);
      context.transport = transport;

      const fsm = new Fsm(clientV2Transitions, clientV2Handlers);
      await fsm.run(context);

      expect(fsm.getState()).toBe("");
      expect(context.output.error).toBe("Unexpected end of stream");
    });
  });

  describe("SEND_LS_REFS state", () => {
    it("sends ls-refs command with options", async () => {
      context.config.lsRefsSymrefs = true;
      context.config.lsRefsPeel = true;
      context.config.refPrefixes = ["refs/heads/"];

      const fsm = new Fsm(clientV2Transitions, clientV2Handlers);
      fsm.setState("SEND_LS_REFS");
      await fsm.run(context, "READ_LS_REFS_RESPONSE");

      expect(fsm.getState()).toBe("READ_LS_REFS_RESPONSE");
      expect(transport.written).toContain("command=ls-refs");
      expect(transport.written).toContain("DELIM");
      expect(transport.written).toContain("symrefs");
      expect(transport.written).toContain("peel");
      expect(transport.written).toContain("ref-prefix refs/heads/");
      expect(transport.written).toContain("FLUSH");
    });

    it("skips ls-refs when refs already known", async () => {
      context.state.refs.set("refs/heads/main", "a".repeat(40));
      context.config.forceRefFetch = false;

      const fsm = new Fsm(clientV2Transitions, clientV2Handlers);
      fsm.setState("SEND_LS_REFS");
      await fsm.run(context, "COMPUTE_WANTS");

      expect(fsm.getState()).toBe("COMPUTE_WANTS");
    });
  });

  describe("READ_LS_REFS_RESPONSE state", () => {
    it("parses ref list with attributes", async () => {
      const oid1 = "a".repeat(40);
      const oid2 = "b".repeat(40);

      transport = createMockTransport([
        {
          type: "data",
          payload: new Uint8Array(0),
          text: `${oid1} refs/heads/main symref-target:refs/heads/master`,
        },
        { type: "data", payload: new Uint8Array(0), text: `${oid2} refs/tags/v1.0 peeled:${oid1}` },
        { type: "flush" },
      ]);
      context.transport = transport;

      const fsm = new Fsm(clientV2Transitions, clientV2Handlers);
      fsm.setState("READ_LS_REFS_RESPONSE");
      await fsm.run(context, "COMPUTE_WANTS");

      expect(fsm.getState()).toBe("COMPUTE_WANTS");
      expect(context.state.refs.get("refs/heads/main")).toBe(oid1);
      expect(context.state.refs.get("refs/tags/v1.0")).toBe(oid2);
      expect(context.state.symrefs?.get("refs/heads/main")).toBe("refs/heads/master");
      expect(context.state.peeled?.get("refs/tags/v1.0")).toBe(oid1);
    });
  });

  describe("COMPUTE_WANTS state", () => {
    it("computes wants for missing objects", async () => {
      const oid1 = "a".repeat(40);
      const oid2 = "b".repeat(40);

      context.state.refs.set("refs/heads/main", oid1);
      context.state.refs.set("refs/heads/feature", oid2);
      // Repository doesn't have oid1
      repository = createMockRepository(new Set([oid2]));
      context.repository = repository;

      const fsm = new Fsm(clientV2Transitions, clientV2Handlers);
      fsm.setState("COMPUTE_WANTS");
      await fsm.run(context, "SEND_FETCH");

      expect(fsm.getState()).toBe("SEND_FETCH");
      expect(context.state.wants.has(oid1)).toBe(true);
      expect(context.state.wants.has(oid2)).toBe(false);
    });

    it("returns NO_WANTS when up to date", async () => {
      const oid = "a".repeat(40);

      context.state.refs.set("refs/heads/main", oid);
      repository = createMockRepository(new Set([oid]));
      context.repository = repository;

      const fsm = new Fsm(clientV2Transitions, clientV2Handlers);
      fsm.setState("COMPUTE_WANTS");
      const result = await fsm.run(context);

      expect(result).toBe(true);
      expect(fsm.getState()).toBe("");
    });
  });

  describe("SEND_FETCH state", () => {
    it("sends fetch command with wants and capabilities", async () => {
      const oid = "a".repeat(40);
      context.state.wants.add(oid);
      context.state.capabilities.add("thin-pack");
      context.state.capabilities.add("ofs-delta");
      context.config.statelessRpc = true; // Enables sending "done"

      const fsm = new Fsm(clientV2Transitions, clientV2Handlers);
      fsm.setState("SEND_FETCH");
      await fsm.run(context, "READ_FETCH_RESPONSE");

      expect(fsm.getState()).toBe("READ_FETCH_RESPONSE");
      expect(transport.written).toContain("command=fetch");
      expect(transport.written).toContain("DELIM");
      expect(transport.written).toContain("thin-pack");
      expect(transport.written).toContain("ofs-delta");
      expect(transport.written).toContain(`want ${oid}`);
      expect(transport.written).toContain("done");
      expect(transport.written).toContain("FLUSH");
    });

    it("sends want-ref when capability available", async () => {
      const oid = "a".repeat(40);
      context.state.wants.add(oid);
      context.state.wantedRefs = new Map([["refs/heads/main", oid]]);
      context.state.capabilities.add("want-ref");

      const fsm = new Fsm(clientV2Transitions, clientV2Handlers);
      fsm.setState("SEND_FETCH");
      await fsm.run(context, "READ_FETCH_RESPONSE");

      expect(transport.written).toContain("want-ref refs/heads/main");
    });

    it("sends shallow options", async () => {
      const oid = "a".repeat(40);
      context.state.wants.add(oid);
      context.config.depth = 5;
      context.config.deepenRelative = true;

      const fsm = new Fsm(clientV2Transitions, clientV2Handlers);
      fsm.setState("SEND_FETCH");
      await fsm.run(context, "READ_FETCH_RESPONSE");

      expect(transport.written).toContain("deepen 5");
      expect(transport.written).toContain("deepen-relative");
    });
  });

  describe("READ_FETCH_RESPONSE state", () => {
    it("parses acknowledgments section", async () => {
      const oid1 = "a".repeat(40);
      const oid2 = "b".repeat(40);

      transport = createMockTransport([
        { type: "data", payload: new Uint8Array(0), text: "acknowledgments" },
        { type: "data", payload: new Uint8Array(0), text: `ACK ${oid1}` },
        { type: "data", payload: new Uint8Array(0), text: `ACK ${oid2}` },
        { type: "data", payload: new Uint8Array(0), text: "ready" },
        { type: "delim" },
        { type: "data", payload: new Uint8Array(0), text: "packfile" },
      ]);
      context.transport = transport;
      context.state.sentDone = true;

      const fsm = new Fsm(clientV2Transitions, clientV2Handlers);
      fsm.setState("READ_FETCH_RESPONSE");
      await fsm.run(context, "RECEIVE_PACK");

      expect(fsm.getState()).toBe("RECEIVE_PACK");
      expect(context.state.commonBase?.has(oid1)).toBe(true);
      expect(context.state.commonBase?.has(oid2)).toBe(true);
      expect(context.state.serverReady).toBe(true);
    });

    it("returns ACKS_ONLY when flush received without done", async () => {
      transport = createMockTransport([
        { type: "data", payload: new Uint8Array(0), text: "acknowledgments" },
        { type: "flush" },
      ]);
      context.transport = transport;
      context.state.sentDone = false;

      const fsm = new Fsm(clientV2Transitions, clientV2Handlers);
      fsm.setState("READ_FETCH_RESPONSE");
      await fsm.run(context, "SEND_FETCH");

      expect(fsm.getState()).toBe("SEND_FETCH");
    });

    it("transitions to SHALLOW_INFO section", async () => {
      transport = createMockTransport([
        { type: "data", payload: new Uint8Array(0), text: "shallow-info" },
      ]);
      context.transport = transport;
      context.state.sentDone = true;

      const fsm = new Fsm(clientV2Transitions, clientV2Handlers);
      fsm.setState("READ_FETCH_RESPONSE");
      await fsm.run(context, "PROCESS_SHALLOW");

      expect(fsm.getState()).toBe("PROCESS_SHALLOW");
    });

    it("transitions to WANTED_REFS section", async () => {
      transport = createMockTransport([
        { type: "data", payload: new Uint8Array(0), text: "wanted-refs" },
      ]);
      context.transport = transport;
      context.state.sentDone = true;

      const fsm = new Fsm(clientV2Transitions, clientV2Handlers);
      fsm.setState("READ_FETCH_RESPONSE");
      await fsm.run(context, "PROCESS_REFS");

      expect(fsm.getState()).toBe("PROCESS_REFS");
    });
  });

  describe("PROCESS_SHALLOW state", () => {
    it("parses shallow and unshallow entries", async () => {
      const oid1 = "a".repeat(40);
      const oid2 = "b".repeat(40);

      transport = createMockTransport([
        { type: "data", payload: new Uint8Array(0), text: `shallow ${oid1}` },
        { type: "data", payload: new Uint8Array(0), text: `unshallow ${oid2}` },
        { type: "delim" },
      ]);
      context.transport = transport;

      const fsm = new Fsm(clientV2Transitions, clientV2Handlers);
      fsm.setState("PROCESS_SHALLOW");
      await fsm.run(context, "READ_FETCH_RESPONSE");

      expect(fsm.getState()).toBe("READ_FETCH_RESPONSE");
      expect(context.state.clientShallow?.has(oid1)).toBe(true);
      expect(context.state.serverUnshallow?.has(oid2)).toBe(true);
    });
  });

  describe("PROCESS_REFS state", () => {
    it("parses wanted-refs response", async () => {
      const oid1 = "a".repeat(40);
      const oid2 = "b".repeat(40);

      transport = createMockTransport([
        { type: "data", payload: new Uint8Array(0), text: `${oid1} refs/heads/main` },
        { type: "data", payload: new Uint8Array(0), text: `${oid2} refs/heads/feature` },
        { type: "delim" },
      ]);
      context.transport = transport;

      const fsm = new Fsm(clientV2Transitions, clientV2Handlers);
      fsm.setState("PROCESS_REFS");
      await fsm.run(context, "READ_FETCH_RESPONSE");

      expect(fsm.getState()).toBe("READ_FETCH_RESPONSE");
      expect(context.state.resolvedWantedRefs?.get("refs/heads/main")).toBe(oid1);
      expect(context.state.resolvedWantedRefs?.get("refs/heads/feature")).toBe(oid2);
    });
  });

  describe("UPDATE_REFS state", () => {
    it("updates local refs from resolved wanted-refs", async () => {
      const oid1 = "a".repeat(40);
      const oid2 = "b".repeat(40);

      context.state.resolvedWantedRefs = new Map([
        ["refs/heads/main", oid1],
        ["refs/heads/feature", oid2],
      ]);

      const refs = new Map<string, string>();
      refStore = createMockRefStore(refs);
      context.refStore = refStore;

      const fsm = new Fsm(clientV2Transitions, clientV2Handlers);
      fsm.setState("UPDATE_REFS");
      const result = await fsm.run(context);

      expect(result).toBe(true);
      expect(refs.get("refs/heads/main")).toBe(oid1);
      expect(refs.get("refs/heads/feature")).toBe(oid2);
    });
  });
});

describe("Server V2 FSM", () => {
  let transport: ReturnType<typeof createMockTransport>;
  let repository: RepositoryFacade;
  let refStore: ReturnType<typeof createMockRefStore>;
  let context: ProcessContext;

  beforeEach(() => {
    transport = createMockTransport();
    repository = createMockRepository();
    refStore = createMockRefStore(new Map([["refs/heads/main", "abc123".padEnd(40, "0")]]));
    context = {
      transport,
      repository,
      refStore,
      state: new ProtocolState(),
      output: new HandlerOutput(),
      config: new ProcessConfiguration(),
    };
  });

  describe("SEND_CAPABILITIES state", () => {
    it("sends version 2 and capabilities", async () => {
      const fsm = new Fsm(serverV2Transitions, serverV2Handlers);
      await fsm.run(context, "READ_COMMAND");

      expect(fsm.getState()).toBe("READ_COMMAND");
      expect(transport.written).toContain("version 2");
      expect(transport.written.some((w) => w.includes("ls-refs"))).toBe(true);
      expect(transport.written).toContain("FLUSH");
    });

    it("uses custom capabilities when configured", async () => {
      context.config.serverCapabilities = ["version 2", "ls-refs", "custom-cap"];

      const fsm = new Fsm(serverV2Transitions, serverV2Handlers);
      await fsm.run(context, "READ_COMMAND");

      expect(transport.written).toContain("custom-cap");
    });
  });

  describe("READ_COMMAND state", () => {
    it("recognizes ls-refs command", async () => {
      transport = createMockTransport([
        { type: "data", payload: new Uint8Array(0), text: "command=ls-refs" },
      ]);
      context.transport = transport;

      const fsm = new Fsm(serverV2Transitions, serverV2Handlers);
      fsm.setState("READ_COMMAND");
      await fsm.run(context, "HANDLE_LS_REFS");

      expect(fsm.getState()).toBe("HANDLE_LS_REFS");
      expect(context.state.currentCommand).toBe("ls-refs");
    });

    it("recognizes fetch command", async () => {
      transport = createMockTransport([
        { type: "data", payload: new Uint8Array(0), text: "command=fetch" },
      ]);
      context.transport = transport;

      const fsm = new Fsm(serverV2Transitions, serverV2Handlers);
      fsm.setState("READ_COMMAND");
      await fsm.run(context, "HANDLE_FETCH");

      expect(fsm.getState()).toBe("HANDLE_FETCH");
      expect(context.state.currentCommand).toBe("fetch");
    });

    it("recognizes object-info command", async () => {
      transport = createMockTransport([
        { type: "data", payload: new Uint8Array(0), text: "command=object-info" },
      ]);
      context.transport = transport;

      const fsm = new Fsm(serverV2Transitions, serverV2Handlers);
      fsm.setState("READ_COMMAND");
      await fsm.run(context, "HANDLE_OBJECT_INFO");

      expect(fsm.getState()).toBe("HANDLE_OBJECT_INFO");
    });

    it("returns FLUSH on client disconnect", async () => {
      transport = createMockTransport([{ type: "flush" }]);
      context.transport = transport;

      const fsm = new Fsm(serverV2Transitions, serverV2Handlers);
      fsm.setState("READ_COMMAND");
      const result = await fsm.run(context);

      expect(result).toBe(true);
      expect(fsm.getState()).toBe("");
    });

    it("returns ERROR on unknown command", async () => {
      transport = createMockTransport([
        { type: "data", payload: new Uint8Array(0), text: "command=unknown" },
      ]);
      context.transport = transport;

      const fsm = new Fsm(serverV2Transitions, serverV2Handlers);
      fsm.setState("READ_COMMAND");
      await fsm.run(context);

      expect(fsm.getState()).toBe("");
      expect(context.output.error).toContain("Unknown command");
    });
  });

  describe("HANDLE_LS_REFS state", () => {
    it("returns refs filtered by prefix", async () => {
      const oid1 = "a".repeat(40);
      const oid2 = "b".repeat(40);

      refStore = createMockRefStore(
        new Map([
          ["refs/heads/main", oid1],
          ["refs/tags/v1.0", oid2],
        ]),
      );
      context.refStore = refStore;

      transport = createMockTransport([
        { type: "delim" },
        { type: "data", payload: new Uint8Array(0), text: "ref-prefix refs/heads/" },
        { type: "flush" },
      ]);
      context.transport = transport;

      const fsm = new Fsm(serverV2Transitions, serverV2Handlers);
      fsm.setState("HANDLE_LS_REFS");
      await fsm.run(context, "READ_COMMAND");

      expect(fsm.getState()).toBe("READ_COMMAND");
      expect(transport.written.some((w) => w.includes("refs/heads/main"))).toBe(true);
      expect(transport.written.some((w) => w.includes("refs/tags/v1.0"))).toBe(false);
    });

    it("includes symref-target when requested", async () => {
      const oid = "a".repeat(40);

      refStore = createMockRefStore(
        new Map([["HEAD", oid]]),
        new Map([["HEAD", "refs/heads/main"]]),
      );
      context.refStore = refStore;

      transport = createMockTransport([
        { type: "delim" },
        { type: "data", payload: new Uint8Array(0), text: "symrefs" },
        { type: "flush" },
      ]);
      context.transport = transport;

      const fsm = new Fsm(serverV2Transitions, serverV2Handlers);
      fsm.setState("HANDLE_LS_REFS");
      await fsm.run(context, "READ_COMMAND");

      expect(transport.written.some((w) => w.includes("symref-target:refs/heads/main"))).toBe(true);
    });
  });

  describe("PARSE_FETCH state", () => {
    it("parses fetch arguments", async () => {
      const oid1 = "a".repeat(40);
      const oid2 = "b".repeat(40);

      // Initialize fetch request via HANDLE_FETCH first
      (context.state as { fetchRequest?: FetchV2Request }).fetchRequest = createEmptyFetchRequest();

      transport = createMockTransport([
        { type: "delim" },
        { type: "data", payload: new Uint8Array(0), text: `want ${oid1}` },
        { type: "data", payload: new Uint8Array(0), text: "want-ref refs/heads/main" },
        { type: "data", payload: new Uint8Array(0), text: `have ${oid2}` },
        { type: "data", payload: new Uint8Array(0), text: "thin-pack" },
        { type: "data", payload: new Uint8Array(0), text: "deepen 5" },
        { type: "data", payload: new Uint8Array(0), text: "filter blob:none" },
        { type: "data", payload: new Uint8Array(0), text: "done" },
        { type: "flush" },
      ]);
      context.transport = transport;

      const fsm = new Fsm(serverV2Transitions, serverV2Handlers);
      fsm.setState("PARSE_FETCH");
      await fsm.run(context, "VALIDATE_FETCH_WANTS");

      expect(fsm.getState()).toBe("VALIDATE_FETCH_WANTS");
      const state = context.state as { fetchRequest?: FetchV2Request };
      expect(state.fetchRequest?.wants).toContain(oid1);
      expect(state.fetchRequest?.wantRefs).toContain("refs/heads/main");
      expect(state.fetchRequest?.haves).toContain(oid2);
      expect(state.fetchRequest?.thinPack).toBe(true);
      expect(state.fetchRequest?.deepen).toBe(5);
      expect(state.fetchRequest?.filter).toBe("blob:none");
      expect(state.fetchRequest?.done).toBe(true);
    });
  });

  describe("VALIDATE_FETCH_WANTS state", () => {
    it("resolves want-refs to OIDs", async () => {
      const oid = "a".repeat(40);

      (context.state as { fetchRequest?: FetchV2Request }).fetchRequest = {
        ...createEmptyFetchRequest(),
        wantRefs: ["refs/heads/main"],
      };
      refStore = createMockRefStore(new Map([["refs/heads/main", oid]]));
      context.refStore = refStore;

      const fsm = new Fsm(serverV2Transitions, serverV2Handlers);
      fsm.setState("VALIDATE_FETCH_WANTS");
      await fsm.run(context, "PROCESS_HAVES");

      expect(fsm.getState()).toBe("PROCESS_HAVES");
      expect(context.state.wants.has(oid)).toBe(true);
      expect(context.state.wantedRefs?.get("refs/heads/main")).toBe(oid);
    });

    it("returns INVALID_WANT for unknown ref", async () => {
      (context.state as { fetchRequest?: FetchV2Request }).fetchRequest = {
        ...createEmptyFetchRequest(),
        wantRefs: ["refs/heads/nonexistent"],
      };

      const fsm = new Fsm(serverV2Transitions, serverV2Handlers);
      fsm.setState("VALIDATE_FETCH_WANTS");
      await fsm.run(context, "SEND_ERROR");

      expect(fsm.getState()).toBe("SEND_ERROR");
      expect(context.output.error).toContain("Unknown ref");
    });

    it("returns INVALID_WANT for unknown object", async () => {
      const oid = "a".repeat(40);

      (context.state as { fetchRequest?: FetchV2Request }).fetchRequest = {
        ...createEmptyFetchRequest(),
        wants: [oid],
      };
      repository = createMockRepository(new Set()); // Empty repo
      context.repository = repository;

      const fsm = new Fsm(serverV2Transitions, serverV2Handlers);
      fsm.setState("VALIDATE_FETCH_WANTS");
      await fsm.run(context, "SEND_ERROR");

      expect(fsm.getState()).toBe("SEND_ERROR");
      expect(context.output.error).toContain("Object not found");
    });
  });

  describe("PROCESS_HAVES state", () => {
    it("computes common base from haves", async () => {
      const oid1 = "a".repeat(40);
      const oid2 = "b".repeat(40);
      const oid3 = "c".repeat(40);

      (context.state as { fetchRequest?: FetchV2Request }).fetchRequest = {
        ...createEmptyFetchRequest(),
        haves: [oid1, oid2, oid3],
      };
      repository = createMockRepository(new Set([oid1, oid3])); // Has oid1 and oid3
      context.repository = repository;

      const fsm = new Fsm(serverV2Transitions, serverV2Handlers);
      fsm.setState("PROCESS_HAVES");
      await fsm.run(context, "CHECK_READY_TO_SEND");

      expect(fsm.getState()).toBe("CHECK_READY_TO_SEND");
      expect(context.state.commonBase.has(oid1)).toBe(true);
      expect(context.state.commonBase.has(oid3)).toBe(true);
      expect(context.state.commonBase.has(oid2)).toBe(false);
      expect(context.state.acks).toContain(oid1);
      expect(context.state.acks).toContain(oid3);
    });
  });

  describe("CHECK_READY_TO_SEND state", () => {
    it("returns READY when client sent done", async () => {
      (context.state as { fetchRequest?: FetchV2Request }).fetchRequest = {
        ...createEmptyFetchRequest(),
        done: true,
      };

      const fsm = new Fsm(serverV2Transitions, serverV2Handlers);
      fsm.setState("CHECK_READY_TO_SEND");
      await fsm.run(context, "SEND_FETCH_RESPONSE");

      expect(fsm.getState()).toBe("SEND_FETCH_RESPONSE");
    });

    it("returns NOT_READY when no common base and no done", async () => {
      (context.state as { fetchRequest?: FetchV2Request }).fetchRequest = {
        ...createEmptyFetchRequest(),
        haves: ["a".repeat(40)],
        done: false,
      };
      context.state.commonBase = new Set();

      const fsm = new Fsm(serverV2Transitions, serverV2Handlers);
      fsm.setState("CHECK_READY_TO_SEND");
      await fsm.run(context, "SEND_ACKS_ONLY");

      expect(fsm.getState()).toBe("SEND_ACKS_ONLY");
    });
  });

  describe("SEND_ACKS_ONLY state", () => {
    it("sends acknowledgments without packfile", async () => {
      const oid = "a".repeat(40);
      context.state.acks = [oid];

      const fsm = new Fsm(serverV2Transitions, serverV2Handlers);
      fsm.setState("SEND_ACKS_ONLY");
      await fsm.run(context, "READ_COMMAND");

      expect(fsm.getState()).toBe("READ_COMMAND");
      expect(transport.written).toContain("acknowledgments");
      expect(transport.written).toContain(`ACK ${oid}`);
      expect(transport.written).toContain("FLUSH");
    });
  });

  describe("SEND_ACKNOWLEDGMENTS state", () => {
    it("sends acks section with ready", async () => {
      const oid = "a".repeat(40);
      context.state.acks = [oid];

      const fsm = new Fsm(serverV2Transitions, serverV2Handlers);
      fsm.setState("SEND_ACKNOWLEDGMENTS");
      await fsm.run(context, "SEND_SHALLOW_INFO");

      expect(fsm.getState()).toBe("SEND_SHALLOW_INFO");
      expect(transport.written).toContain("acknowledgments");
      expect(transport.written).toContain(`ACK ${oid}`);
      expect(transport.written).toContain("ready");
      expect(transport.written).toContain("DELIM");
    });
  });

  describe("SEND_SHALLOW_INFO state", () => {
    it("skips when no shallow requested", async () => {
      (context.state as { fetchRequest?: FetchV2Request }).fetchRequest = createEmptyFetchRequest();

      const fsm = new Fsm(serverV2Transitions, serverV2Handlers);
      fsm.setState("SEND_SHALLOW_INFO");
      await fsm.run(context, "SEND_WANTED_REFS");

      expect(fsm.getState()).toBe("SEND_WANTED_REFS");
    });

    it("sends shallow info when deepen requested", async () => {
      const oid = "a".repeat(40);

      (context.state as { fetchRequest?: FetchV2Request }).fetchRequest = {
        ...createEmptyFetchRequest(),
        deepen: 5,
      };
      context.state.serverShallow = new Set([oid]);

      const fsm = new Fsm(serverV2Transitions, serverV2Handlers);
      fsm.setState("SEND_SHALLOW_INFO");
      await fsm.run(context, "SEND_WANTED_REFS");

      expect(fsm.getState()).toBe("SEND_WANTED_REFS");
      expect(transport.written).toContain("shallow-info");
      expect(transport.written).toContain(`shallow ${oid}`);
    });
  });

  describe("SEND_WANTED_REFS state", () => {
    it("skips when no want-refs used", async () => {
      (context.state as { fetchRequest?: FetchV2Request }).fetchRequest = createEmptyFetchRequest();

      const fsm = new Fsm(serverV2Transitions, serverV2Handlers);
      fsm.setState("SEND_WANTED_REFS");
      await fsm.run(context, "SEND_PACKFILE");

      expect(fsm.getState()).toBe("SEND_PACKFILE");
    });

    it("sends resolved wanted-refs", async () => {
      const oid = "a".repeat(40);

      (context.state as { fetchRequest?: FetchV2Request }).fetchRequest = {
        ...createEmptyFetchRequest(),
        wantRefs: ["refs/heads/main"],
      };
      context.state.wantedRefs = new Map([["refs/heads/main", oid]]);

      const fsm = new Fsm(serverV2Transitions, serverV2Handlers);
      fsm.setState("SEND_WANTED_REFS");
      await fsm.run(context, "SEND_PACKFILE");

      expect(fsm.getState()).toBe("SEND_PACKFILE");
      expect(transport.written).toContain("wanted-refs");
      expect(transport.written).toContain(`${oid} refs/heads/main`);
    });
  });

  describe("SEND_PACKFILE state", () => {
    it("sends packfile section and pack data", async () => {
      const oid = "a".repeat(40);

      (context.state as { fetchRequest?: FetchV2Request }).fetchRequest = createEmptyFetchRequest();
      context.state.wants = new Set([oid]);
      repository = createMockRepository(new Set([oid]));
      context.repository = repository;

      const fsm = new Fsm(serverV2Transitions, serverV2Handlers);
      fsm.setState("SEND_PACKFILE");
      await fsm.run(context, "READ_COMMAND");

      expect(fsm.getState()).toBe("READ_COMMAND");
      expect(transport.written).toContain("packfile");
      expect(transport.packWritten.length).toBeGreaterThan(0);
    });
  });

  describe("HANDLE_OBJECT_INFO state", () => {
    it("returns object sizes", async () => {
      const oid1 = "a".repeat(40);
      const oid2 = "b".repeat(40);

      repository = createMockRepository(new Set([oid1]));
      context.repository = repository;

      transport = createMockTransport([
        { type: "delim" },
        { type: "data", payload: new Uint8Array(0), text: `oid ${oid1}` },
        { type: "data", payload: new Uint8Array(0), text: `oid ${oid2}` },
        { type: "flush" },
      ]);
      context.transport = transport;

      const fsm = new Fsm(serverV2Transitions, serverV2Handlers);
      fsm.setState("HANDLE_OBJECT_INFO");
      await fsm.run(context, "READ_COMMAND");

      expect(fsm.getState()).toBe("READ_COMMAND");
      expect(transport.written).toContain("size");
      expect(transport.written.some((w) => w.includes(oid1) && w.includes("42"))).toBe(true);
    });
  });

  describe("SEND_ERROR state", () => {
    it("sends ERR message", async () => {
      context.output.error = "Something went wrong";

      const fsm = new Fsm(serverV2Transitions, serverV2Handlers);
      fsm.setState("SEND_ERROR");
      const result = await fsm.run(context);

      expect(result).toBe(true);
      expect(transport.written).toContain("ERR Something went wrong");
      expect(transport.written).toContain("FLUSH");
    });
  });
});
