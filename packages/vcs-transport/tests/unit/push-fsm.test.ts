import { beforeEach, describe, expect, it } from "vitest";
import type { PackImportResult, RepositoryFacade } from "../../src/api/repository-facade.js";
import type { PktLineResult, SidebandResult, TransportApi } from "../../src/api/transport-api.js";
import { HandlerOutput } from "../../src/context/handler-output.js";
import { ProcessConfiguration } from "../../src/context/process-config.js";
import type { ProcessContext, RefStore } from "../../src/context/process-context.js";
import { ProtocolState } from "../../src/context/protocol-state.js";
import { Fsm } from "../../src/fsm/index.js";
import {
  clientPushHandlers,
  clientPushTransitions,
  mapRejectReason,
  type PushCommand,
  serverPushHandlers,
  serverPushTransitions,
  ZERO_OID,
} from "../../src/fsm/push/index.js";
import { parseRefSpec } from "../../src/utils/refspec.js";

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

    async writePack(data: AsyncIterable<Uint8Array>): Promise<void> {
      for await (const chunk of data) {
        this.packWritten.push(chunk);
      }
    },
  };
}

// Mock repository facade
// ancestorMap: maps a starting OID to its full ancestor chain (in walk order)
function createMockRepository(
  objects: Set<string> = new Set(),
  ancestorMap: Map<string, string[]> = new Map(),
): RepositoryFacade {
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
    async *walkAncestors(startOid: string): AsyncGenerator<string> {
      const chain = ancestorMap.get(startOid);
      if (chain) {
        for (const oid of chain) yield oid;
      }
    },
  };
}

// Mock ref store
function createMockRefStore(refs: Map<string, string> = new Map()): RefStore {
  return {
    async get(name: string): Promise<string | undefined> {
      return refs.get(name);
    },
    async update(name: string, oid: string): Promise<void> {
      if (oid === ZERO_OID) {
        refs.delete(name);
      } else {
        refs.set(name, oid);
      }
    },
    async listAll(): Promise<Iterable<[string, string]>> {
      return refs.entries();
    },
  };
}

describe("Push FSM Types", () => {
  describe("parseRefSpec", () => {
    it("parses simple refspec", () => {
      const result = parseRefSpec("refs/heads/main:refs/heads/main");
      expect(result).toEqual({
        source: "refs/heads/main",
        destination: "refs/heads/main",
        force: false,
        negative: false,
        wildcard: false,
      });
    });

    it("parses force refspec", () => {
      const result = parseRefSpec("+refs/heads/main:refs/heads/main");
      expect(result).toEqual({
        source: "refs/heads/main",
        destination: "refs/heads/main",
        force: true,
        negative: false,
        wildcard: false,
      });
    });

    it("parses refspec without colon", () => {
      const result = parseRefSpec("refs/heads/main");
      expect(result).toEqual({
        source: "refs/heads/main",
        destination: null,
        force: false,
        negative: false,
        wildcard: false,
      });
    });

    it("parses delete refspec", () => {
      const result = parseRefSpec(":refs/heads/feature");
      expect(result).toEqual({
        source: null,
        destination: "refs/heads/feature",
        force: false,
        negative: false,
        wildcard: false,
      });
    });
  });

  describe("mapRejectReason", () => {
    it("maps non-fast-forward", () => {
      expect(mapRejectReason("non-fast-forward")).toBe("REJECTED_NONFASTFORWARD");
    });

    it("maps current branch", () => {
      expect(mapRejectReason("updating current branch")).toBe("REJECTED_CURRENT_BRANCH");
    });

    it("maps unknown reason", () => {
      expect(mapRejectReason("some other error")).toBe("REJECTED_OTHER_REASON");
    });
  });
});

describe("Client Push FSM", () => {
  let transport: ReturnType<typeof createMockTransport>;
  let repository: RepositoryFacade;
  let refStore: RefStore;
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

  describe("READ_ADVERTISEMENT state", () => {
    it("reads refs from server advertisement", async () => {
      const oid1 = "a".repeat(40);
      const oid2 = "b".repeat(40);

      transport = createMockTransport([
        {
          type: "data",
          payload: new Uint8Array(0),
          text: `${oid1} refs/heads/main\0report-status ofs-delta\n`,
        },
        { type: "data", payload: new Uint8Array(0), text: `${oid2} refs/heads/feature\n` },
        { type: "flush" },
      ]);
      context.transport = transport;

      const fsm = new Fsm(clientPushTransitions, clientPushHandlers);
      await fsm.run(context, "COMPUTE_UPDATES");

      expect(fsm.getState()).toBe("COMPUTE_UPDATES");
      expect(context.state.refs.get("refs/heads/main")).toBe(oid1);
      expect(context.state.refs.get("refs/heads/feature")).toBe(oid2);
      expect(context.state.capabilities.has("report-status")).toBe(true);
      expect(context.state.capabilities.has("ofs-delta")).toBe(true);
    });

    it("handles empty repository", async () => {
      transport = createMockTransport([
        {
          type: "data",
          payload: new Uint8Array(0),
          text: `${ZERO_OID} capabilities^{}\0report-status\n`,
        },
        { type: "flush" },
      ]);
      context.transport = transport;

      const fsm = new Fsm(clientPushTransitions, clientPushHandlers);
      await fsm.run(context, "COMPUTE_UPDATES");

      expect(fsm.getState()).toBe("COMPUTE_UPDATES");
      expect(context.state.refs.size).toBe(0);
      expect(context.state.capabilities.has("report-status")).toBe(true);
    });
  });

  describe("COMPUTE_UPDATES state", () => {
    it("computes update for existing ref (fast-forward)", async () => {
      const localOid = "a".repeat(40);
      const remoteOid = "b".repeat(40);

      context.state.refs.set("refs/heads/main", remoteOid);
      refStore = createMockRefStore(new Map([["refs/heads/main", localOid]]));
      context.refStore = refStore;
      context.config.pushRefspecs = ["refs/heads/main:refs/heads/main"];

      // Ancestry: localOid descends from remoteOid (fast-forward)
      repository = createMockRepository(
        new Set([remoteOid, localOid]),
        new Map([[localOid, [localOid, remoteOid]]]),
      );
      context.repository = repository;

      const fsm = new Fsm(clientPushTransitions, clientPushHandlers);
      fsm.setState("COMPUTE_UPDATES");
      await fsm.run(context, "SEND_COMMANDS");

      expect(fsm.getState()).toBe("SEND_COMMANDS");
      const state = context.state as { pushCommands?: PushCommand[] };
      expect(state.pushCommands).toHaveLength(1);
      expect(state.pushCommands?.[0].type).toBe("UPDATE");
    });

    it("detects non-fast-forward when remote OID is not an ancestor of local OID", async () => {
      const localOid = "a".repeat(40);
      const remoteOid = "b".repeat(40);
      const commonAncestor = "c".repeat(40);

      context.state.refs.set("refs/heads/main", remoteOid);
      refStore = createMockRefStore(new Map([["refs/heads/main", localOid]]));
      context.refStore = refStore;
      context.config.pushRefspecs = ["+refs/heads/main:refs/heads/main"];

      // Ancestry: localOid descends from commonAncestor, NOT from remoteOid
      // Both objects exist locally but they diverged from a common ancestor
      repository = createMockRepository(
        new Set([remoteOid, localOid, commonAncestor]),
        new Map([[localOid, [localOid, commonAncestor]]]),
      );
      context.repository = repository;

      const fsm = new Fsm(clientPushTransitions, clientPushHandlers);
      fsm.setState("COMPUTE_UPDATES");
      await fsm.run(context, "SEND_COMMANDS");

      expect(fsm.getState()).toBe("SEND_COMMANDS");
      const state = context.state as { pushCommands?: PushCommand[] };
      expect(state.pushCommands).toHaveLength(1);
      // With force (+), non-FF is allowed, so type should be UPDATE_NONFASTFORWARD
      expect(state.pushCommands?.[0].type).toBe("UPDATE_NONFASTFORWARD");
    });

    it("rejects non-fast-forward without force flag", async () => {
      const localOid = "a".repeat(40);
      const remoteOid = "b".repeat(40);
      const commonAncestor = "c".repeat(40);

      context.state.refs.set("refs/heads/main", remoteOid);
      refStore = createMockRefStore(new Map([["refs/heads/main", localOid]]));
      context.refStore = refStore;
      // No force (+) prefix
      context.config.pushRefspecs = ["refs/heads/main:refs/heads/main"];

      // Ancestry: localOid descends from commonAncestor, NOT from remoteOid
      repository = createMockRepository(
        new Set([remoteOid, localOid, commonAncestor]),
        new Map([[localOid, [localOid, commonAncestor]]]),
      );
      context.repository = repository;

      const fsm = new Fsm(clientPushTransitions, clientPushHandlers);
      fsm.setState("COMPUTE_UPDATES");
      const result = await fsm.run(context);

      // Should fail with LOCAL_VALIDATION_FAILED (terminal state "")
      expect(result).toBe(true);
      expect(fsm.getState()).toBe("");
      expect(context.output.error).toContain("non-fast-forward");
    });

    it("computes create for new ref", async () => {
      const localOid = "a".repeat(40);

      refStore = createMockRefStore(new Map([["refs/heads/feature", localOid]]));
      context.refStore = refStore;
      context.config.pushRefspecs = ["refs/heads/feature:refs/heads/feature"];

      const fsm = new Fsm(clientPushTransitions, clientPushHandlers);
      fsm.setState("COMPUTE_UPDATES");
      await fsm.run(context, "SEND_COMMANDS");

      expect(fsm.getState()).toBe("SEND_COMMANDS");
      const state = context.state as { pushCommands?: PushCommand[] };
      expect(state.pushCommands).toHaveLength(1);
      expect(state.pushCommands?.[0].type).toBe("CREATE");
    });

    it("returns NO_UPDATES when nothing to push", async () => {
      const oid = "a".repeat(40);

      context.state.refs.set("refs/heads/main", oid);
      refStore = createMockRefStore(new Map([["refs/heads/main", oid]]));
      context.refStore = refStore;
      context.config.pushRefspecs = ["refs/heads/main:refs/heads/main"];

      const fsm = new Fsm(clientPushTransitions, clientPushHandlers);
      fsm.setState("COMPUTE_UPDATES");
      const result = await fsm.run(context);

      expect(result).toBe(true);
      expect(fsm.getState()).toBe("");
    });
  });

  describe("SEND_COMMANDS state", () => {
    it("sends push commands with capabilities", async () => {
      const oldOid = "b".repeat(40);
      const newOid = "a".repeat(40);

      context.state.capabilities.add("report-status");
      context.state.capabilities.add("side-band-64k");
      (context.state as { pushCommands?: PushCommand[] }).pushCommands = [
        {
          oldOid,
          newOid,
          refName: "refs/heads/main",
          type: "UPDATE",
          result: "NOT_ATTEMPTED",
        },
      ];

      const fsm = new Fsm(clientPushTransitions, clientPushHandlers);
      fsm.setState("SEND_COMMANDS");
      await fsm.run(context, "SEND_PACK");

      expect(fsm.getState()).toBe("SEND_PACK");
      expect(transport.written).toContain(
        `${oldOid} ${newOid} refs/heads/main\0report-status side-band-64k`,
      );
      expect(transport.written).toContain("FLUSH");
    });
  });
});

describe("Server Push FSM", () => {
  let transport: ReturnType<typeof createMockTransport>;
  let repository: RepositoryFacade;
  let refStore: RefStore;
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

  describe("SEND_ADVERTISEMENT state", () => {
    it("sends refs to client", async () => {
      const oid = "a".repeat(40);
      refStore = createMockRefStore(new Map([["refs/heads/main", oid]]));
      context.refStore = refStore;

      const fsm = new Fsm(serverPushTransitions, serverPushHandlers);
      await fsm.run(context, "READ_COMMANDS");

      expect(fsm.getState()).toBe("READ_COMMANDS");
      expect(transport.written[0]).toContain(oid);
      expect(transport.written[0]).toContain("refs/heads/main");
      expect(transport.written[0]).toContain("report-status");
    });

    it("handles empty repository", async () => {
      refStore = createMockRefStore(new Map());
      context.refStore = refStore;

      const fsm = new Fsm(serverPushTransitions, serverPushHandlers);
      await fsm.run(context, "READ_COMMANDS");

      expect(fsm.getState()).toBe("READ_COMMANDS");
      expect(transport.written[0]).toContain(ZERO_OID);
      expect(transport.written[0]).toContain("capabilities^{}");
    });
  });

  describe("READ_COMMANDS state", () => {
    it("reads push commands from client", async () => {
      const oldOid = "a".repeat(40);
      const newOid = "b".repeat(40);

      transport = createMockTransport([
        {
          type: "data",
          payload: new Uint8Array(0),
          text: `${oldOid} ${newOid} refs/heads/main\0report-status\n`,
        },
        { type: "flush" },
      ]);
      context.transport = transport;

      const fsm = new Fsm(serverPushTransitions, serverPushHandlers);
      fsm.setState("READ_COMMANDS");
      await fsm.run(context, "READ_PUSH_OPTIONS");

      expect(fsm.getState()).toBe("READ_PUSH_OPTIONS");
      const state = context.state as { pushCommands?: PushCommand[] };
      expect(state.pushCommands).toHaveLength(1);
      expect(state.pushCommands?.[0].oldOid).toBe(oldOid);
      expect(state.pushCommands?.[0].newOid).toBe(newOid);
      expect(state.pushCommands?.[0].refName).toBe("refs/heads/main");
    });

    it("detects delete command", async () => {
      const oldOid = "a".repeat(40);

      transport = createMockTransport([
        {
          type: "data",
          payload: new Uint8Array(0),
          text: `${oldOid} ${ZERO_OID} refs/heads/feature\n`,
        },
        { type: "flush" },
      ]);
      context.transport = transport;

      const fsm = new Fsm(serverPushTransitions, serverPushHandlers);
      fsm.setState("READ_COMMANDS");
      await fsm.run(context, "CHECK_DELETE_ALLOWED");

      expect(fsm.getState()).toBe("CHECK_DELETE_ALLOWED");
      const state = context.state as { pushCommands?: PushCommand[] };
      expect(state.pushCommands?.[0].type).toBe("DELETE");
    });
  });

  describe("VALIDATE_COMMANDS state", () => {
    it("validates fast-forward commands successfully", async () => {
      const oldOid = "a".repeat(40);
      const newOid = "b".repeat(40);

      context.state.refs.set("refs/heads/main", oldOid);
      // Ancestry: newOid descends from oldOid (fast-forward)
      repository = createMockRepository(
        new Set([oldOid, newOid]),
        new Map([[newOid, [newOid, oldOid]]]),
      );
      context.repository = repository;

      (context.state as { pushCommands?: PushCommand[] }).pushCommands = [
        {
          oldOid,
          newOid,
          refName: "refs/heads/main",
          type: "UPDATE",
          result: "NOT_ATTEMPTED",
        },
      ];

      const fsm = new Fsm(serverPushTransitions, serverPushHandlers);
      fsm.setState("VALIDATE_COMMANDS");
      // Stop at RUN_PRE_RECEIVE_HOOK or SEND_STATUS (depending on path)
      await fsm.run(context, "RUN_PRE_RECEIVE_HOOK", "SEND_STATUS");

      expect(fsm.getState()).toBe("RUN_PRE_RECEIVE_HOOK");
    });

    it("rejects non-fast-forward push on server", async () => {
      const oldOid = "a".repeat(40);
      const newOid = "b".repeat(40);
      const commonAncestor = "c".repeat(40);

      context.state.refs.set("refs/heads/main", oldOid);
      // Ancestry: newOid descends from commonAncestor, NOT from oldOid
      repository = createMockRepository(
        new Set([oldOid, newOid, commonAncestor]),
        new Map([[newOid, [newOid, commonAncestor]]]),
      );
      context.repository = repository;

      (context.state as { pushCommands?: PushCommand[] }).pushCommands = [
        {
          oldOid,
          newOid,
          refName: "refs/heads/main",
          type: "UPDATE",
          result: "NOT_ATTEMPTED",
        },
      ];

      const fsm = new Fsm(serverPushTransitions, serverPushHandlers);
      fsm.setState("VALIDATE_COMMANDS");
      await fsm.run(context, "SEND_STATUS");

      expect(fsm.getState()).toBe("SEND_STATUS");
      const state = context.state as { pushCommands?: PushCommand[] };
      expect(state.pushCommands?.[0].result).toBe("REJECTED_NONFASTFORWARD");
      expect(state.pushCommands?.[0].message).toBe("non-fast-forward");
    });

    it("allows non-fast-forward with allowNonFastForward config", async () => {
      const oldOid = "a".repeat(40);
      const newOid = "b".repeat(40);
      const commonAncestor = "c".repeat(40);

      context.state.refs.set("refs/heads/main", oldOid);
      context.config.allowNonFastForward = true;
      // Ancestry: newOid descends from commonAncestor, NOT from oldOid
      repository = createMockRepository(
        new Set([oldOid, newOid, commonAncestor]),
        new Map([[newOid, [newOid, commonAncestor]]]),
      );
      context.repository = repository;

      (context.state as { pushCommands?: PushCommand[] }).pushCommands = [
        {
          oldOid,
          newOid,
          refName: "refs/heads/main",
          type: "UPDATE",
          result: "NOT_ATTEMPTED",
        },
      ];

      const fsm = new Fsm(serverPushTransitions, serverPushHandlers);
      fsm.setState("VALIDATE_COMMANDS");
      await fsm.run(context, "RUN_PRE_RECEIVE_HOOK", "SEND_STATUS");

      expect(fsm.getState()).toBe("RUN_PRE_RECEIVE_HOOK");
      const state = context.state as { pushCommands?: PushCommand[] };
      // Should be reclassified as non-fast-forward but still allowed
      expect(state.pushCommands?.[0].type).toBe("UPDATE_NONFASTFORWARD");
      expect(state.pushCommands?.[0].result).toBe("NOT_ATTEMPTED");
    });

    it("rejects command when old OID doesnt match", async () => {
      const oldOid = "a".repeat(40);
      const newOid = "b".repeat(40);
      const currentOid = "c".repeat(40);

      context.state.refs.set("refs/heads/main", currentOid); // Different from oldOid
      repository = createMockRepository(new Set([newOid]));
      context.repository = repository;

      (context.state as { pushCommands?: PushCommand[] }).pushCommands = [
        {
          oldOid,
          newOid,
          refName: "refs/heads/main",
          type: "UPDATE",
          result: "NOT_ATTEMPTED",
        },
      ];

      const fsm = new Fsm(serverPushTransitions, serverPushHandlers);
      fsm.setState("VALIDATE_COMMANDS");
      await fsm.run(context, "SEND_STATUS");

      expect(fsm.getState()).toBe("SEND_STATUS");
      const state = context.state as { pushCommands?: PushCommand[] };
      expect(state.pushCommands?.[0].result).toBe("REJECTED_NONFASTFORWARD");
    });
  });

  describe("SEND_STATUS state", () => {
    it("sends success status", async () => {
      const oldOid = "a".repeat(40);
      const newOid = "b".repeat(40);

      (context.state as { pushCommands?: PushCommand[] }).pushCommands = [
        {
          oldOid,
          newOid,
          refName: "refs/heads/main",
          type: "UPDATE",
          result: "OK",
        },
      ];

      const fsm = new Fsm(serverPushTransitions, serverPushHandlers);
      fsm.setState("SEND_STATUS");
      const result = await fsm.run(context);

      expect(result).toBe(true);
      expect(transport.written).toContain("unpack ok");
      expect(transport.written).toContain("ok refs/heads/main");
    });

    it("sends failure status", async () => {
      const oldOid = "a".repeat(40);
      const newOid = "b".repeat(40);

      (context.state as { pushCommands?: PushCommand[] }).pushCommands = [
        {
          oldOid,
          newOid,
          refName: "refs/heads/main",
          type: "UPDATE",
          result: "REJECTED_NONFASTFORWARD",
          message: "non-fast-forward",
        },
      ];

      const fsm = new Fsm(serverPushTransitions, serverPushHandlers);
      fsm.setState("SEND_STATUS");
      const result = await fsm.run(context);

      expect(result).toBe(true);
      expect(transport.written).toContain("unpack ok");
      expect(transport.written).toContain("ng refs/heads/main non-fast-forward");
    });
  });
});
