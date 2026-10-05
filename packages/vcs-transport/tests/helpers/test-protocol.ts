/**
 * Test Protocol Helper
 *
 * Provides mock transport and protocol testing utilities.
 * Inspired by JGit's TestProtocol class.
 *
 * Features:
 * - Mock transport for testing without network
 * - Capture sent/received packets
 * - Simulate protocol responses
 * - Support for testing both client and server sides
 */

import { type Mock, vi } from "vitest";
import type { RepositoryFacade } from "../../src/api/repository-facade.js";
import type { TransportApi } from "../../src/api/transport-api.js";
import { HandlerOutput } from "../../src/context/handler-output.js";
import { ProcessConfiguration } from "../../src/context/process-config.js";
import type { ProcessContext, RefStore } from "../../src/context/process-context.js";
import { ProtocolState } from "../../src/context/protocol-state.js";

/**
 * Packet line result from transport
 */
export interface PktLineResult {
  type: "data" | "flush" | "delim" | "eof";
  data?: Uint8Array;
  text?: string;
}

/**
 * Sideband message from transport
 */
export interface SidebandResult {
  channel: 1 | 2 | 3;
  data: Uint8Array;
}

/**
 * Mock transport for testing
 */
export interface MockTransport extends TransportApi {
  /** Set the packets to return from readLine/readPktLine */
  _setPackets(packets: PktLineResult[]): void;
  /** Set the pack chunks to return from readPack */
  _setPackChunks(chunks: Uint8Array[]): void;
  /** Set the sideband messages to return */
  _setSidebandMessages(messages: SidebandResult[]): void;
  /** Get all lines written */
  _getWrittenLines(): string[];
  /** Get all packets written */
  _getWrittenPackets(): PktLineResult[];
  /** Get all pack data written */
  _getWrittenPackData(): Uint8Array[];
  /** Reset all state */
  _reset(): void;
  /** Mock functions for verification */
  readLine: Mock;
  writeLine: Mock;
  writeFlush: Mock;
  writeDelimiter: Mock;
  readPktLine: Mock;
  writePktLine: Mock;
  readSideband: Mock;
  writeSideband: Mock;
  writePack: Mock;
  readRawPack: Mock;
  writeRawPack: Mock;
}

/**
 * Create a mock transport for testing
 */
export function createMockTransport(): MockTransport {
  const packets: PktLineResult[] = [];
  let packetIndex = 0;
  const packChunks: Uint8Array[] = [];
  let packIndex = 0;
  const sidebandMessages: SidebandResult[] = [];
  let sidebandIndex = 0;

  const writtenLines: string[] = [];
  const writtenPackets: PktLineResult[] = [];
  const writtenPackData: Uint8Array[] = [];

  const transport: MockTransport = {
    readLine: vi.fn(async () => {
      if (packetIndex < packets.length) {
        const pkt = packets[packetIndex++];
        return pkt.type === "data" ? (pkt.text ?? null) : null;
      }
      return null;
    }),

    writeLine: vi.fn(async (line: string) => {
      writtenLines.push(line);
      writtenPackets.push({ type: "data", text: line });
    }),

    writeFlush: vi.fn(async () => {
      writtenPackets.push({ type: "flush" });
    }),

    writeDelimiter: vi.fn(async () => {
      writtenPackets.push({ type: "delim" });
    }),

    readPktLine: vi.fn(async () => {
      if (packetIndex < packets.length) {
        return packets[packetIndex++];
      }
      return { type: "flush" as const };
    }),

    writePktLine: vi.fn(async (packet: PktLineResult) => {
      writtenPackets.push(packet);
      if (packet.type === "data" && packet.text) {
        writtenLines.push(packet.text);
      }
    }),

    readSideband: vi.fn(async () => {
      if (sidebandIndex < sidebandMessages.length) {
        return sidebandMessages[sidebandIndex++];
      }
      return { channel: 1 as const, data: new Uint8Array(0) };
    }),

    writeSideband: vi.fn(async (_channel: 1 | 2 | 3, data: Uint8Array) => {
      writtenPackData.push(data);
    }),

    async *readPack() {
      while (packIndex < packChunks.length) {
        yield packChunks[packIndex++];
      }
    },

    writePack: vi.fn(async (pack: AsyncIterable<Uint8Array>) => {
      for await (const chunk of pack) {
        writtenPackData.push(chunk);
      }
    }),

    readRawPack: vi.fn(async function* () {
      while (packIndex < packChunks.length) {
        yield packChunks[packIndex++];
      }
    }),

    writeRawPack: vi.fn(async (pack: AsyncIterable<Uint8Array>) => {
      for await (const chunk of pack) {
        writtenPackData.push(chunk);
      }
    }),

    // Test helper methods
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

    _setSidebandMessages: (messages: SidebandResult[]) => {
      sidebandMessages.length = 0;
      sidebandMessages.push(...messages);
      sidebandIndex = 0;
    },

    _getWrittenLines: () => [...writtenLines],

    _getWrittenPackets: () => [...writtenPackets],

    _getWrittenPackData: () => [...writtenPackData],

    _reset: () => {
      packets.length = 0;
      packetIndex = 0;
      packChunks.length = 0;
      packIndex = 0;
      sidebandMessages.length = 0;
      sidebandIndex = 0;
      writtenLines.length = 0;
      writtenPackets.length = 0;
      writtenPackData.length = 0;
      transport.readLine.mockClear();
      transport.writeLine.mockClear();
      transport.writeFlush.mockClear();
      transport.writeDelimiter.mockClear();
      transport.readPktLine.mockClear();
      transport.writePktLine.mockClear();
      transport.readSideband.mockClear();
      transport.writeSideband.mockClear();
      transport.writePack.mockClear();
      transport.readRawPack.mockClear();
      transport.writeRawPack.mockClear();
    },
  };

  return transport;
}

/**
 * Mock ref store for testing
 */
export interface MockRefStore extends RefStore {
  _setRef(name: string, oid: string): void;
  _getRefs(): Map<string, string>;
  _clear(): void;
  get: Mock;
  update: Mock;
  listAll: Mock;
  isRefTip: Mock;
}

/**
 * Create a mock ref store
 */
export function createMockRefStore(): MockRefStore {
  const refs = new Map<string, string>();

  const store: MockRefStore = {
    get: vi.fn(async (name: string) => refs.get(name)),
    update: vi.fn(async (name: string, oid: string) => {
      refs.set(name, oid);
    }),
    listAll: vi.fn(async () => refs.entries()),

    isRefTip: vi.fn(async (oid: string) => {
      for (const value of refs.values()) {
        if (value === oid) return true;
      }
      return false;
    }),

    _setRef: (name: string, oid: string) => {
      refs.set(name, oid);
    },

    _getRefs: () => new Map(refs),

    _clear: () => {
      refs.clear();
    },
  };

  return store;
}

/**
 * Create a process context for testing
 */
export function createTestContext(overrides?: Partial<ProcessContext>): ProcessContext {
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

/**
 * Mock repository type with test helpers.
 */
export type MockRepository = RepositoryFacade & {
  _addObject: (oid: string) => void;
  _hasObject: (oid: string) => boolean;
  _setAncestors: (oid: string, ancestors: string[]) => void;
  _setShallowBoundaries: (boundaries: Set<string>) => void;
  isReachableFrom: Mock;
  isReachableFromAnyTip: Mock;
  computeShallowBoundaries: Mock;
  computeShallowSince: Mock;
  computeShallowExclude: Mock;
};

/**
 * Create a minimal mock repository
 */
export function createMockRepository(): MockRepository {
  const objects = new Map<string, boolean>();
  const ancestorMap = new Map<string, string[]>();
  let shallowBoundaries = new Set<string>();

  return {
    importPack: vi.fn(async () => ({
      objectsImported: 0,
      blobsWithDelta: 0,
      treesImported: 0,
      commitsImported: 0,
      tagsImported: 0,
    })),

    async *exportPack() {
      yield new Uint8Array([0x50, 0x41, 0x43, 0x4b]); // "PACK"
    },

    has: vi.fn(async (oid: string) => objects.has(oid)),

    async *walkAncestors(startOid: string) {
      const anc = ancestorMap.get(startOid);
      if (anc) {
        for (const a of anc) yield a;
      }
    },

    isReachableFrom: vi.fn(async (oid: string, from: string | string[]) => {
      const fromArray = Array.isArray(from) ? from : [from];
      for (const f of fromArray) {
        const anc = ancestorMap.get(f);
        if (anc?.includes(oid)) return true;
      }
      return false;
    }),

    isReachableFromAnyTip: vi.fn(async (_oid: string) => false),

    computeShallowBoundaries: vi.fn(
      async (_wants: Set<string>, _depth: number) => new Set(shallowBoundaries),
    ),

    computeShallowSince: vi.fn(
      async (_wants: Set<string>, _timestamp: number) => new Set(shallowBoundaries),
    ),

    computeShallowExclude: vi.fn(
      async (_wants: Set<string>, _excludeRefs: string[]) => new Set(shallowBoundaries),
    ),

    _addObject: (oid: string) => {
      objects.set(oid, true);
    },

    _hasObject: (oid: string) => objects.has(oid),

    _setAncestors: (oid: string, ancestors: string[]) => {
      ancestorMap.set(oid, ancestors);
    },

    _setShallowBoundaries: (boundaries: Set<string>) => {
      shallowBoundaries = boundaries;
    },
  };
}

/**
 * Protocol test scenario configuration
 */
export interface ProtocolScenario {
  name: string;
  serverRefs?: Map<string, string>;
  clientRefs?: Map<string, string>;
  clientWants?: string[];
  serverPackets?: PktLineResult[];
  expectedClientPackets?: Array<{ type: string; pattern?: RegExp; text?: string }>;
}

/**
 * Run a protocol test scenario
 */
export async function runProtocolScenario(
  scenario: ProtocolScenario,
  clientHandler: (ctx: ProcessContext) => Promise<string | undefined>,
): Promise<{
  event: string | undefined;
  writtenLines: string[];
  writtenPackets: PktLineResult[];
}> {
  const transport = createMockTransport();

  if (scenario.serverPackets) {
    transport._setPackets(scenario.serverPackets);
  }

  const refStore = createMockRefStore();
  if (scenario.clientRefs) {
    for (const [name, oid] of scenario.clientRefs) {
      refStore._setRef(name, oid);
    }
  }

  const ctx = createTestContext({ transport, refStore });

  if (scenario.serverRefs) {
    for (const [name, oid] of scenario.serverRefs) {
      ctx.state.refs.set(name, oid);
    }
  }

  if (scenario.clientWants) {
    for (const want of scenario.clientWants) {
      ctx.state.wants.add(want);
    }
  }

  const event = await clientHandler(ctx);

  return {
    event,
    writtenLines: transport._getWrittenLines(),
    writtenPackets: transport._getWrittenPackets(),
  };
}

/**
 * Create a packet sequence builder for testing
 */
export class PacketSequenceBuilder {
  private packets: PktLineResult[] = [];

  data(text: string): PacketSequenceBuilder {
    this.packets.push({ type: "data", text });
    return this;
  }

  dataBytes(data: Uint8Array): PacketSequenceBuilder {
    this.packets.push({ type: "data", data });
    return this;
  }

  flush(): PacketSequenceBuilder {
    this.packets.push({ type: "flush" });
    return this;
  }

  delim(): PacketSequenceBuilder {
    this.packets.push({ type: "delim" });
    return this;
  }

  eof(): PacketSequenceBuilder {
    this.packets.push({ type: "eof" });
    return this;
  }

  build(): PktLineResult[] {
    return [...this.packets];
  }
}

/**
 * Create a packet sequence
 */
export function packets(): PacketSequenceBuilder {
  return new PacketSequenceBuilder();
}

/**
 * Helper to create common protocol messages
 */
export const ProtocolMessages = {
  /**
   * Create a ref advertisement line
   */
  refAdvertisement(oid: string, name: string, capabilities?: string): PktLineResult {
    const text = capabilities ? `${oid} ${name}\0${capabilities}` : `${oid} ${name}`;
    return { type: "data", text };
  },

  /**
   * Create a want line
   */
  want(oid: string, capabilities?: string): PktLineResult {
    const text = capabilities ? `want ${oid} ${capabilities}` : `want ${oid}`;
    return { type: "data", text };
  },

  /**
   * Create a have line
   */
  have(oid: string): PktLineResult {
    return { type: "data", text: `have ${oid}` };
  },

  /**
   * Create a done line
   */
  done(): PktLineResult {
    return { type: "data", text: "done" };
  },

  /**
   * Create an ACK line
   */
  ack(oid: string, type?: "common" | "ready"): PktLineResult {
    const text = type ? `ACK ${oid} ${type}` : `ACK ${oid}`;
    return { type: "data", text };
  },

  /**
   * Create a NAK line
   */
  nak(): PktLineResult {
    return { type: "data", text: "NAK" };
  },

  /**
   * Create a shallow line
   */
  shallow(oid: string): PktLineResult {
    return { type: "data", text: `shallow ${oid}` };
  },

  /**
   * Create an unshallow line
   */
  unshallow(oid: string): PktLineResult {
    return { type: "data", text: `unshallow ${oid}` };
  },

  /**
   * Create a deepen line
   */
  deepen(depth: number): PktLineResult {
    return { type: "data", text: `deepen ${depth}` };
  },

  /**
   * Create a filter line
   */
  filter(spec: string): PktLineResult {
    return { type: "data", text: `filter ${spec}` };
  },

  /**
   * Create empty repository advertisement (zero OID)
   */
  emptyRepoAdvertisement(capabilities: string): PktLineResult {
    return {
      type: "data",
      text: `${"0".repeat(40)} capabilities^{}\0${capabilities}`,
    };
  },
};

/**
 * Verify that written packets match expected patterns
 */
export function verifyPackets(
  actual: PktLineResult[],
  expected: Array<{ type: string; pattern?: RegExp; text?: string }>,
): void {
  if (actual.length !== expected.length) {
    throw new Error(
      `Expected ${expected.length} packets, got ${actual.length}\n` +
        `Actual: ${JSON.stringify(actual.map((p) => ({ type: p.type, text: p.text })))}\n` +
        `Expected: ${JSON.stringify(expected)}`,
    );
  }

  for (let i = 0; i < expected.length; i++) {
    const act = actual[i];
    const exp = expected[i];

    if (act.type !== exp.type) {
      throw new Error(`Packet ${i}: expected type ${exp.type}, got ${act.type}`);
    }

    if (exp.text !== undefined && act.text !== exp.text) {
      throw new Error(`Packet ${i}: expected text "${exp.text}", got "${act.text}"`);
    }

    if (exp.pattern && act.text && !exp.pattern.test(act.text)) {
      throw new Error(`Packet ${i}: text "${act.text}" does not match pattern ${exp.pattern}`);
    }
  }
}

/**
 * Helper to generate random test OIDs
 */
export function randomOid(): string {
  const chars = "0123456789abcdef";
  let oid = "";
  for (let i = 0; i < 40; i++) {
    oid += chars[Math.floor(Math.random() * 16)];
  }
  return oid;
}

/**
 * Generate a known test OID based on a seed
 */
export function testOid(seed: string | number): string {
  const str = String(seed);
  const hash = str.split("").reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return hash.toString(16).padStart(8, "0").repeat(5);
}

/**
 * Mock hooks for testing server-side upload-pack hooks.
 */
export interface MockHooks {
  preUpload: Mock;
  postUpload: Mock;
}

/**
 * Create mock hooks for testing.
 */
export function createMockHooks(): MockHooks {
  return {
    preUpload: vi.fn(async () => ({ ok: true })),
    postUpload: vi.fn(async () => {}),
  };
}
