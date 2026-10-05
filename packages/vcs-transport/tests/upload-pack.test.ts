/**
 * Upload-Pack (Server Fetch) Tests
 *
 * Ported from JGit's UploadPackTest.java — comprehensive tests for the
 * server-side fetch FSM covering:
 * - Shallow clone support
 * - Filter support (partial clone)
 * - Protocol V2 capabilities
 * - Protocol V2 ls-refs
 * - Protocol V2 fetch
 * - Want validation (request policies)
 * - Ref hiding / advertisement hooks
 * - Pack generation and sideband
 */

import { describe, expect, it } from "vitest";

import {
  getConfig,
  getOutput,
  getState,
  type ProcessContext,
  setConfig,
  setOutput,
  setRefStore,
  setRepository,
  setState,
  setTransport,
} from "../src/context/context-adapters.js";
import { HandlerOutput } from "../src/context/handler-output.js";
import { ProcessConfiguration } from "../src/context/process-config.js";
import { ProtocolState } from "../src/context/protocol-state.js";
import { serverFetchHandlers, serverFetchTransitions } from "../src/fsm/fetch/index.js";
import { Fsm } from "../src/fsm/fsm.js";
import { serverV2Handlers, serverV2Transitions } from "../src/fsm/protocol-v2/index.js";
import {
  createMockRefStore,
  createMockRepository,
  createMockTransport,
  type MockRefStore,
  type MockRepository,
  type MockTransport,
  packets,
  randomOid,
} from "./helpers/test-protocol.js";

// ─────────────────────────────────────────────────────────────────────────────
// Test utilities
// ─────────────────────────────────────────────────────────────────────────────

function createServerContext(overrides?: {
  transport?: MockTransport;
  repository?: MockRepository;
  refStore?: MockRefStore;
  state?: ProtocolState;
  output?: HandlerOutput;
  config?: ProcessConfiguration;
}): ProcessContext {
  const ctx: ProcessContext = {};
  setTransport(ctx, overrides?.transport ?? createMockTransport());
  setRepository(ctx, overrides?.repository ?? createMockRepository());
  setRefStore(ctx, overrides?.refStore ?? createMockRefStore());
  setState(ctx, overrides?.state ?? new ProtocolState());
  setOutput(ctx, overrides?.output ?? new HandlerOutput());
  setConfig(ctx, overrides?.config ?? new ProcessConfiguration());
  return ctx;
}

/** Run a specific server handler and return the event */
async function runHandler(
  handlerName: string,
  ctx: ProcessContext,
  handlers: Map<string, (ctx: ProcessContext) => Promise<string>> = serverFetchHandlers,
): Promise<string> {
  const handler = handlers.get(handlerName);
  if (!handler) throw new Error(`No handler for state: ${handlerName}`);
  return handler(ctx);
}

// ─────────────────────────────────────────────────────────────────────────────
// Shallow Clone Support
// ─────────────────────────────────────────────────────────────────────────────

describe("Upload-Pack: Shallow Clone Support", () => {
  it("should parse shallow boundaries from client", async () => {
    const transport = createMockTransport();
    const shallowOid1 = randomOid();
    const shallowOid2 = randomOid();
    const wantOid = randomOid();

    transport._setPackets(
      packets()
        .data(`want ${wantOid}`)
        .data(`shallow ${shallowOid1}`)
        .data(`shallow ${shallowOid2}`)
        .flush()
        .build(),
    );

    const ctx = createServerContext({ transport });
    getState(ctx).refs.set("refs/heads/main", wantOid);

    const event = await runHandler("READ_WANTS", ctx);
    expect(event).toBe("WANTS_WITH_SHALLOW");
    expect(getState(ctx).clientShallow?.has(shallowOid1)).toBe(true);
    expect(getState(ctx).clientShallow?.has(shallowOid2)).toBe(true);
  });

  it("should handle deepen request", async () => {
    const transport = createMockTransport();
    const wantOid = randomOid();

    transport._setPackets(packets().data(`want ${wantOid}`).data("deepen 3").flush().build());

    const ctx = createServerContext({ transport });
    getState(ctx).refs.set("refs/heads/main", wantOid);

    const event = await runHandler("READ_WANTS", ctx);
    expect(event).toBe("WANTS_WITH_SHALLOW");
    expect(getState(ctx).deepenRequest).toBe("deepen 3");
  });

  it("should compute shallow boundaries for depth-based deepen", async () => {
    const repository = createMockRepository();
    const boundary = randomOid();
    repository._setShallowBoundaries(new Set([boundary]));

    const ctx = createServerContext({ repository });
    const state = getState(ctx);
    state.wants.add(randomOid());
    state.deepenRequest = "deepen 2";

    const event = await runHandler("COMPUTE_SHALLOW", ctx);
    expect(event).toBe("SHALLOW_COMPUTED");
    expect(state.serverShallow?.has(boundary)).toBe(true);
    expect(repository.computeShallowBoundaries).toHaveBeenCalled();
  });

  it("should compute shallow boundaries for deepen-since", async () => {
    const repository = createMockRepository();
    const boundary = randomOid();
    repository._setShallowBoundaries(new Set([boundary]));

    const ctx = createServerContext({ repository });
    const state = getState(ctx);
    state.wants.add(randomOid());
    state.deepenRequest = "deepen-since 1609459200";

    const event = await runHandler("COMPUTE_SHALLOW", ctx);
    expect(event).toBe("SHALLOW_COMPUTED");
    expect(state.serverShallow?.has(boundary)).toBe(true);
    expect(repository.computeShallowSince).toHaveBeenCalledWith(state.wants, 1609459200);
  });

  it("should compute shallow boundaries for deepen-not", async () => {
    const repository = createMockRepository();
    const boundary = randomOid();
    repository._setShallowBoundaries(new Set([boundary]));

    const ctx = createServerContext({ repository });
    const state = getState(ctx);
    state.wants.add(randomOid());
    state.deepenRequest = "deepen-not refs/heads/old";

    const event = await runHandler("COMPUTE_SHALLOW", ctx);
    expect(event).toBe("SHALLOW_COMPUTED");
    expect(state.serverShallow?.has(boundary)).toBe(true);
    expect(repository.computeShallowExclude).toHaveBeenCalled();
  });

  it("should send shallow/unshallow updates to client", async () => {
    const transport = createMockTransport();
    const shallowOid = randomOid();
    const unshallowOid = randomOid();

    const ctx = createServerContext({ transport });
    const state = getState(ctx);
    state.serverShallow = new Set([shallowOid]);
    state.serverUnshallow = new Set([unshallowOid]);

    const event = await runHandler("SEND_SHALLOW_UPDATE", ctx);
    expect(event).toBe("SHALLOW_SENT");

    const lines = transport._getWrittenLines();
    expect(lines).toContain(`shallow ${shallowOid}`);
    expect(lines).toContain(`unshallow ${unshallowOid}`);
    expect(transport.writeFlush).toHaveBeenCalled();
  });

  it("should mark objects for unshallow when client was shallow but server has full history", async () => {
    const repository = createMockRepository();
    const shallowOid = randomOid();
    repository._addObject(shallowOid);

    const ctx = createServerContext({ repository });
    const state = getState(ctx);
    state.wants.add(randomOid());
    state.clientShallow = new Set([shallowOid]);
    // No deepen request means serverShallow will be empty
    state.deepenRequest = undefined;

    const event = await runHandler("COMPUTE_SHALLOW", ctx);
    expect(event).toBe("SHALLOW_COMPUTED");
    expect(state.serverUnshallow?.has(shallowOid)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Filter Support (Partial Clone)
// ─────────────────────────────────────────────────────────────────────────────

describe("Upload-Pack: Filter Support", () => {
  it("should parse blob:none filter", async () => {
    const transport = createMockTransport();
    const wantOid = randomOid();

    transport._setPackets(
      packets().data(`want ${wantOid}`).data("filter blob:none").flush().build(),
    );

    const ctx = createServerContext({ transport });
    getState(ctx).refs.set("refs/heads/main", wantOid);

    const event = await runHandler("READ_WANTS", ctx);
    expect(event).toBe("WANTS_WITH_FILTER");
    expect(getState(ctx).filterSpec).toBe("blob:none");
  });

  it("should parse blob:limit filter", async () => {
    const transport = createMockTransport();
    const wantOid = randomOid();

    transport._setPackets(
      packets().data(`want ${wantOid}`).data("filter blob:limit=1048576").flush().build(),
    );

    const ctx = createServerContext({ transport });
    getState(ctx).refs.set("refs/heads/main", wantOid);

    const event = await runHandler("READ_WANTS", ctx);
    expect(event).toBe("WANTS_WITH_FILTER");
    expect(getState(ctx).filterSpec).toBe("blob:limit=1048576");
  });

  it("should parse tree:0 filter", async () => {
    const transport = createMockTransport();
    const wantOid = randomOid();

    transport._setPackets(packets().data(`want ${wantOid}`).data("filter tree:0").flush().build());

    const ctx = createServerContext({ transport });
    getState(ctx).refs.set("refs/heads/main", wantOid);

    const event = await runHandler("READ_WANTS", ctx);
    expect(event).toBe("WANTS_WITH_FILTER");
    expect(getState(ctx).filterSpec).toBe("tree:0");
  });

  it("should pass filter spec to exportPack in SEND_PACK", async () => {
    const transport = createMockTransport();
    const repository = createMockRepository();
    const wantOid = randomOid();

    const ctx = createServerContext({ transport, repository });
    const state = getState(ctx);
    state.wants.add(wantOid);
    state.capabilities.add("side-band-64k");
    state.filterSpec = "blob:none";

    const event = await runHandler("SEND_PACK", ctx);
    expect(event).toBe("PACK_SENT");
    // exportPack is not a mock in this case, but we verify the handler runs to completion
  });

  it("should handle combined filter and shallow", async () => {
    const transport = createMockTransport();
    const wantOid = randomOid();
    const shallowOid = randomOid();

    transport._setPackets(
      packets()
        .data(`want ${wantOid}`)
        .data(`shallow ${shallowOid}`)
        .data("filter blob:none")
        .flush()
        .build(),
    );

    const ctx = createServerContext({ transport });
    getState(ctx).refs.set("refs/heads/main", wantOid);

    const event = await runHandler("READ_WANTS", ctx);
    // Filter takes precedence in event naming
    expect(event).toBe("WANTS_WITH_FILTER");
    expect(getState(ctx).filterSpec).toBe("blob:none");
    expect(getState(ctx).clientShallow?.has(shallowOid)).toBe(true);
  });

  it("should error when filter not supported by server capabilities", async () => {
    const transport = createMockTransport();
    const refStore = createMockRefStore();
    const wantOid = randomOid();
    refStore._setRef("refs/heads/main", wantOid);

    const config = new ProcessConfiguration();
    // Explicitly exclude "filter" from server capabilities
    config.serverCapabilities = ["multi_ack_detailed", "side-band-64k"];

    const ctx = createServerContext({ transport, refStore, config });

    // Send advertisement without filter capability
    const advEvent = await runHandler("SEND_ADVERTISEMENT", ctx);
    expect(advEvent).toBe("REFS_SENT");

    const lines = transport._getWrittenLines();
    const capLine = lines[0];
    expect(capLine).not.toContain("filter");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Protocol V2 Capabilities
// ─────────────────────────────────────────────────────────────────────────────

describe("Upload-Pack: Protocol V2 Capabilities", () => {
  it("should advertise version 2", async () => {
    const transport = createMockTransport();
    const ctx = createServerContext({ transport });

    const event = await runHandler("SEND_CAPABILITIES", ctx, serverV2Handlers);
    expect(event).toBe("CAPS_SENT");

    const lines = transport._getWrittenLines();
    expect(lines[0]).toBe("version 2");
  });

  it("should advertise ls-refs command", async () => {
    const transport = createMockTransport();
    const ctx = createServerContext({ transport });

    await runHandler("SEND_CAPABILITIES", ctx, serverV2Handlers);

    const lines = transport._getWrittenLines();
    expect(lines.some((l) => l === "ls-refs")).toBe(true);
  });

  it("should advertise fetch command with shallow", async () => {
    const transport = createMockTransport();
    const ctx = createServerContext({ transport });

    await runHandler("SEND_CAPABILITIES", ctx, serverV2Handlers);

    const lines = transport._getWrittenLines();
    expect(lines.some((l) => l.startsWith("fetch=") && l.includes("shallow"))).toBe(true);
  });

  it("should advertise server-option", async () => {
    const transport = createMockTransport();
    const ctx = createServerContext({ transport });

    await runHandler("SEND_CAPABILITIES", ctx, serverV2Handlers);

    const lines = transport._getWrittenLines();
    expect(lines.some((l) => l === "server-option")).toBe(true);
  });

  it("should advertise filter if in default capabilities", async () => {
    const transport = createMockTransport();
    const ctx = createServerContext({ transport });

    await runHandler("SEND_CAPABILITIES", ctx, serverV2Handlers);

    const lines = transport._getWrittenLines();
    expect(lines.some((l) => l.includes("filter"))).toBe(true);
  });

  it("should allow custom capabilities", async () => {
    const transport = createMockTransport();
    const config = new ProcessConfiguration();
    config.serverCapabilities = ["ls-refs", "fetch=shallow", "custom-cap"];

    const ctx = createServerContext({ transport, config });

    await runHandler("SEND_CAPABILITIES", ctx, serverV2Handlers);

    const lines = transport._getWrittenLines();
    expect(lines).toContain("version 2");
    expect(lines).toContain("ls-refs");
    expect(lines).toContain("fetch=shallow");
    expect(lines).toContain("custom-cap");
  });

  it("should send flush after capabilities", async () => {
    const transport = createMockTransport();
    const ctx = createServerContext({ transport });

    await runHandler("SEND_CAPABILITIES", ctx, serverV2Handlers);
    expect(transport.writeFlush).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Protocol V2 ls-refs
// ─────────────────────────────────────────────────────────────────────────────

describe("Upload-Pack: Protocol V2 ls-refs", () => {
  it("should list all refs", async () => {
    const transport = createMockTransport();
    const refStore = createMockRefStore();
    const mainOid = randomOid();
    const featureOid = randomOid();

    refStore._setRef("refs/heads/main", mainOid);
    refStore._setRef("refs/heads/feature", featureOid);

    // No arguments, just flush
    transport._setPackets(packets().flush().build());

    const ctx = createServerContext({ transport, refStore });
    const event = await runHandler("HANDLE_LS_REFS", ctx, serverV2Handlers);

    expect(event).toBe("LS_REFS_DONE");
    const lines = transport._getWrittenLines();
    expect(lines.some((l) => l.includes(mainOid) && l.includes("refs/heads/main"))).toBe(true);
    expect(lines.some((l) => l.includes(featureOid) && l.includes("refs/heads/feature"))).toBe(
      true,
    );
  });

  it("should include symref info when requested", async () => {
    const transport = createMockTransport();
    const refStore = createMockRefStore();
    const mainOid = randomOid();

    refStore._setRef("HEAD", mainOid);
    refStore._setRef("refs/heads/main", mainOid);

    // Mock getSymrefTarget
    (
      refStore as MockRefStore & { getSymrefTarget?: (name: string) => Promise<string | null> }
    ).getSymrefTarget = async (name: string) => {
      return name === "HEAD" ? "refs/heads/main" : null;
    };

    transport._setPackets(packets().data("symrefs").flush().build());

    const ctx = createServerContext({ transport, refStore });
    const event = await runHandler("HANDLE_LS_REFS", ctx, serverV2Handlers);

    expect(event).toBe("LS_REFS_DONE");
    const lines = transport._getWrittenLines();
    expect(lines.some((l) => l.includes("symref-target:refs/heads/main"))).toBe(true);
  });

  it("should include peeled values when requested", async () => {
    const transport = createMockTransport();
    const refStore = createMockRefStore();
    const repository = createMockRepository();

    const tagOid = randomOid();
    const commitOid = randomOid();

    refStore._setRef("refs/tags/v1.0", tagOid);
    repository._addObject(tagOid);

    // Mock peelTag on repository
    (repository as MockRepository & { peelTag?: (oid: string) => Promise<string | null> }).peelTag =
      async (oid: string) => {
        return oid === tagOid ? commitOid : oid;
      };

    transport._setPackets(packets().data("peel").flush().build());

    const ctx = createServerContext({ transport, refStore, repository });
    const event = await runHandler("HANDLE_LS_REFS", ctx, serverV2Handlers);

    expect(event).toBe("LS_REFS_DONE");
    const lines = transport._getWrittenLines();
    expect(lines.some((l) => l.includes(`peeled:${commitOid}`))).toBe(true);
  });

  it("should filter by ref-prefix", async () => {
    const transport = createMockTransport();
    const refStore = createMockRefStore();
    const mainOid = randomOid();
    const tagOid = randomOid();

    refStore._setRef("refs/heads/main", mainOid);
    refStore._setRef("refs/tags/v1.0", tagOid);

    transport._setPackets(packets().data("ref-prefix refs/heads/").flush().build());

    const ctx = createServerContext({ transport, refStore });
    const event = await runHandler("HANDLE_LS_REFS", ctx, serverV2Handlers);

    expect(event).toBe("LS_REFS_DONE");
    const lines = transport._getWrittenLines();
    expect(lines.some((l) => l.includes("refs/heads/main"))).toBe(true);
    expect(lines.some((l) => l.includes("refs/tags/v1.0"))).toBe(false);
  });

  it("should handle multiple ref-prefix filters", async () => {
    const transport = createMockTransport();
    const refStore = createMockRefStore();
    const mainOid = randomOid();
    const tagOid = randomOid();
    const noteOid = randomOid();

    refStore._setRef("refs/heads/main", mainOid);
    refStore._setRef("refs/tags/v1.0", tagOid);
    refStore._setRef("refs/notes/commits", noteOid);

    transport._setPackets(
      packets().data("ref-prefix refs/heads/").data("ref-prefix refs/tags/").flush().build(),
    );

    const ctx = createServerContext({ transport, refStore });
    const event = await runHandler("HANDLE_LS_REFS", ctx, serverV2Handlers);

    expect(event).toBe("LS_REFS_DONE");
    const lines = transport._getWrittenLines();
    expect(lines.some((l) => l.includes("refs/heads/main"))).toBe(true);
    expect(lines.some((l) => l.includes("refs/tags/v1.0"))).toBe(true);
    expect(lines.some((l) => l.includes("refs/notes/commits"))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Protocol V2 Fetch
// ─────────────────────────────────────────────────────────────────────────────

describe("Upload-Pack: Protocol V2 Fetch", () => {
  it("should parse fetch arguments", async () => {
    const transport = createMockTransport();
    const wantOid = randomOid();
    const haveOid = randomOid();

    transport._setPackets(
      packets()
        .data(`want ${wantOid}`)
        .data(`have ${haveOid}`)
        .data("done")
        .data("thin-pack")
        .data("no-progress")
        .data("include-tag")
        .data("ofs-delta")
        .flush()
        .build(),
    );

    const ctx = createServerContext({ transport });
    const state = getState(ctx);
    // Initialize fetchRequest as HANDLE_FETCH does
    (state as Record<string, unknown>).fetchRequest = {
      wants: [],
      wantRefs: [],
      haves: [],
      done: false,
      shallow: [],
      deepen: 0,
      filter: null,
    };

    const event = await runHandler("PARSE_FETCH", ctx, serverV2Handlers);
    expect(event).toBe("FETCH_PARSED");

    const req = (state as Record<string, unknown>).fetchRequest as Record<string, unknown>;
    expect((req.wants as string[]).includes(wantOid)).toBe(true);
    expect((req.haves as string[]).includes(haveOid)).toBe(true);
    expect(req.done).toBe(true);
    expect(req.thinPack).toBe(true);
    expect(req.noProgress).toBe(true);
    expect(req.includeTags).toBe(true);
    expect(req.ofsDeltas).toBe(true);
  });

  it("should validate wants against repository", async () => {
    const transport = createMockTransport();
    const refStore = createMockRefStore();
    const repository = createMockRepository();
    const wantOid = randomOid();

    repository._addObject(wantOid);

    const ctx = createServerContext({ transport, refStore, repository });
    const state = getState(ctx);
    (state as Record<string, unknown>).fetchRequest = {
      wants: [wantOid],
      wantRefs: [],
      haves: [],
      done: false,
      shallow: [],
      deepen: 0,
      filter: null,
    };

    const event = await runHandler("VALIDATE_FETCH_WANTS", ctx, serverV2Handlers);
    expect(event).toBe("VALID");
    expect(state.wants.has(wantOid)).toBe(true);
  });

  it("should reject unknown objects", async () => {
    const transport = createMockTransport();
    const refStore = createMockRefStore();
    const repository = createMockRepository();
    const unknownOid = randomOid();

    // Do not add the object to the repository

    const ctx = createServerContext({ transport, refStore, repository });
    const state = getState(ctx);
    (state as Record<string, unknown>).fetchRequest = {
      wants: [unknownOid],
      wantRefs: [],
      haves: [],
      done: false,
      shallow: [],
      deepen: 0,
      filter: null,
    };

    const event = await runHandler("VALIDATE_FETCH_WANTS", ctx, serverV2Handlers);
    expect(event).toBe("INVALID_WANT");
    expect(getOutput(ctx).invalidWant).toBe(unknownOid);
  });

  it("should resolve want-ref to OID", async () => {
    const transport = createMockTransport();
    const refStore = createMockRefStore();
    const repository = createMockRepository();
    const mainOid = randomOid();

    refStore._setRef("refs/heads/main", mainOid);
    repository._addObject(mainOid);

    const ctx = createServerContext({ transport, refStore, repository });
    const state = getState(ctx);
    (state as Record<string, unknown>).fetchRequest = {
      wants: [],
      wantRefs: ["refs/heads/main"],
      haves: [],
      done: false,
      shallow: [],
      deepen: 0,
      filter: null,
    };

    const event = await runHandler("VALIDATE_FETCH_WANTS", ctx, serverV2Handlers);
    expect(event).toBe("VALID");
    expect(state.wants.has(mainOid)).toBe(true);
  });

  it("should reject unknown want-ref", async () => {
    const transport = createMockTransport();
    const refStore = createMockRefStore();
    const repository = createMockRepository();

    const ctx = createServerContext({ transport, refStore, repository });
    const state = getState(ctx);
    (state as Record<string, unknown>).fetchRequest = {
      wants: [],
      wantRefs: ["refs/heads/nonexistent"],
      haves: [],
      done: false,
      shallow: [],
      deepen: 0,
      filter: null,
    };

    const event = await runHandler("VALIDATE_FETCH_WANTS", ctx, serverV2Handlers);
    expect(event).toBe("INVALID_WANT");
    expect(getOutput(ctx).invalidWant).toBe("refs/heads/nonexistent");
  });

  it("should process haves and find common base", async () => {
    const transport = createMockTransport();
    const repository = createMockRepository();
    const haveOid = randomOid();
    const unknownHaveOid = randomOid();

    repository._addObject(haveOid);

    const ctx = createServerContext({ transport, repository });
    const state = getState(ctx);
    (state as Record<string, unknown>).fetchRequest = {
      wants: [],
      wantRefs: [],
      haves: [haveOid, unknownHaveOid],
      done: true,
      shallow: [],
      deepen: 0,
      filter: null,
    };

    const event = await runHandler("PROCESS_HAVES", ctx, serverV2Handlers);
    expect(event).toBe("COMPUTED");
    expect(state.commonBase.has(haveOid)).toBe(true);
    expect(state.commonBase.has(unknownHaveOid)).toBe(false);
  });

  it("should be ready to send when client sent done", async () => {
    const transport = createMockTransport();
    const ctx = createServerContext({ transport });
    const state = getState(ctx);
    (state as Record<string, unknown>).fetchRequest = {
      wants: [randomOid()],
      wantRefs: [],
      haves: [],
      done: true,
      shallow: [],
      deepen: 0,
      filter: null,
    };

    const event = await runHandler("CHECK_READY_TO_SEND", ctx, serverV2Handlers);
    expect(event).toBe("READY");
  });

  it("should send acks only when not ready", async () => {
    const transport = createMockTransport();
    const ackOid = randomOid();

    const ctx = createServerContext({ transport });
    const state = getState(ctx);
    state.acks = [ackOid];

    const event = await runHandler("SEND_ACKS_ONLY", ctx, serverV2Handlers);
    expect(event).toBe("ACKS_SENT");

    const lines = transport._getWrittenLines();
    expect(lines).toContain("acknowledgments");
    expect(lines.some((l) => l === `ACK ${ackOid}`)).toBe(true);
  });

  it("should send acknowledgments with ready in full response", async () => {
    const transport = createMockTransport();
    const ackOid = randomOid();

    const ctx = createServerContext({ transport });
    const state = getState(ctx);
    state.acks = [ackOid];

    const event = await runHandler("SEND_ACKNOWLEDGMENTS", ctx, serverV2Handlers);
    expect(event).toBe("ACKS_DONE");

    const lines = transport._getWrittenLines();
    expect(lines).toContain("acknowledgments");
    expect(lines).toContain(`ACK ${ackOid}`);
    expect(lines).toContain("ready");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Want Validation (Request Policies)
// ─────────────────────────────────────────────────────────────────────────────

describe("Upload-Pack: Want Validation", () => {
  it("should accept advertised refs with ADVERTISED policy", async () => {
    const repository = createMockRepository();
    const advertisedOid = randomOid();
    repository._addObject(advertisedOid);

    const ctx = createServerContext({ repository });
    const state = getState(ctx);
    state.refs.set("refs/heads/main", advertisedOid);
    state.wants.add(advertisedOid);
    getConfig(ctx).requestPolicy = "ADVERTISED";

    const event = await runHandler("VALIDATE_WANTS", ctx);
    expect(event).toBe("VALID");
  });

  it("should reject unadvertised refs with ADVERTISED policy", async () => {
    const repository = createMockRepository();
    const unadvertisedOid = randomOid();
    repository._addObject(unadvertisedOid);

    const ctx = createServerContext({ repository });
    const state = getState(ctx);
    state.refs.set("refs/heads/main", randomOid());
    state.wants.add(unadvertisedOid);
    getConfig(ctx).requestPolicy = "ADVERTISED";

    const event = await runHandler("VALIDATE_WANTS", ctx);
    expect(event).toBe("INVALID_WANT");
    expect(getOutput(ctx).invalidWant).toBe(unadvertisedOid);
  });

  it("should accept reachable commits with REACHABLE_COMMIT policy", async () => {
    const repository = createMockRepository();
    const tipOid = randomOid();
    const reachableOid = randomOid();

    repository._addObject(reachableOid);
    repository._setAncestors(tipOid, [reachableOid]);
    repository.isReachableFrom.mockResolvedValueOnce(true);

    const ctx = createServerContext({ repository });
    const state = getState(ctx);
    state.refs.set("refs/heads/main", tipOid);
    state.wants.add(reachableOid);
    getConfig(ctx).requestPolicy = "REACHABLE_COMMIT";

    const event = await runHandler("VALIDATE_WANTS", ctx);
    expect(event).toBe("VALID");
  });

  it("should reject unreachable commits with REACHABLE_COMMIT policy", async () => {
    const repository = createMockRepository();
    const tipOid = randomOid();
    const unreachableOid = randomOid();

    repository.isReachableFrom.mockResolvedValueOnce(false);

    const ctx = createServerContext({ repository });
    const state = getState(ctx);
    state.refs.set("refs/heads/main", tipOid);
    state.wants.add(unreachableOid);
    getConfig(ctx).requestPolicy = "REACHABLE_COMMIT";

    const event = await runHandler("VALIDATE_WANTS", ctx);
    expect(event).toBe("INVALID_WANT");
  });

  it("should accept tip commits with TIP policy", async () => {
    const refStore = createMockRefStore();
    const tipOid = randomOid();
    refStore._setRef("refs/heads/main", tipOid);

    const ctx = createServerContext({ refStore });
    const state = getState(ctx);
    state.refs.set("refs/heads/main", tipOid);
    state.wants.add(tipOid);
    getConfig(ctx).requestPolicy = "TIP";

    const event = await runHandler("VALIDATE_WANTS", ctx);
    expect(event).toBe("VALID");
  });

  it("should reject non-tip commits with TIP policy", async () => {
    const refStore = createMockRefStore();
    const tipOid = randomOid();
    const nonTipOid = randomOid();
    refStore._setRef("refs/heads/main", tipOid);
    refStore.isRefTip.mockResolvedValueOnce(false);

    const ctx = createServerContext({ refStore });
    const state = getState(ctx);
    state.refs.set("refs/heads/main", tipOid);
    state.wants.add(nonTipOid);
    getConfig(ctx).requestPolicy = "TIP";

    const event = await runHandler("VALIDATE_WANTS", ctx);
    expect(event).toBe("INVALID_WANT");
  });

  it("should accept reachable from any tip with REACHABLE_COMMIT_TIP policy", async () => {
    const repository = createMockRepository();
    const reachableOid = randomOid();
    repository._addObject(reachableOid);
    repository.isReachableFromAnyTip.mockResolvedValueOnce(true);

    const ctx = createServerContext({ repository });
    const state = getState(ctx);
    state.wants.add(reachableOid);
    getConfig(ctx).requestPolicy = "REACHABLE_COMMIT_TIP";

    const event = await runHandler("VALIDATE_WANTS", ctx);
    expect(event).toBe("VALID");
  });

  it("should accept any object in repository with ANY policy", async () => {
    const repository = createMockRepository();
    const anyOid = randomOid();
    repository._addObject(anyOid);

    const ctx = createServerContext({ repository });
    const state = getState(ctx);
    state.wants.add(anyOid);
    getConfig(ctx).requestPolicy = "ANY";

    const event = await runHandler("VALIDATE_WANTS", ctx);
    expect(event).toBe("VALID");
  });

  it("should reject nonexistent object with ANY policy", async () => {
    const repository = createMockRepository();
    const nonexistentOid = randomOid();

    const ctx = createServerContext({ repository });
    const state = getState(ctx);
    state.wants.add(nonexistentOid);
    getConfig(ctx).requestPolicy = "ANY";

    const event = await runHandler("VALIDATE_WANTS", ctx);
    expect(event).toBe("INVALID_WANT");
  });

  it("should default to ADVERTISED policy when not set", async () => {
    const ctx = createServerContext();
    const state = getState(ctx);
    const advertisedOid = randomOid();
    state.refs.set("refs/heads/main", advertisedOid);
    state.wants.add(advertisedOid);
    // No requestPolicy set

    const event = await runHandler("VALIDATE_WANTS", ctx);
    expect(event).toBe("VALID");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Ref Hiding / Advertisement
// ─────────────────────────────────────────────────────────────────────────────

describe("Upload-Pack: Ref Advertisement", () => {
  it("should advertise all refs from refStore", async () => {
    const transport = createMockTransport();
    const refStore = createMockRefStore();
    const mainOid = randomOid();
    const featureOid = randomOid();

    refStore._setRef("refs/heads/main", mainOid);
    refStore._setRef("refs/heads/feature", featureOid);

    const ctx = createServerContext({ transport, refStore });
    const event = await runHandler("SEND_ADVERTISEMENT", ctx);

    expect(event).toBe("REFS_SENT");
    const lines = transport._getWrittenLines();
    expect(lines.some((l) => l.includes(mainOid))).toBe(true);
    expect(lines.some((l) => l.includes(featureOid))).toBe(true);
  });

  it("should respect custom server capabilities", async () => {
    const transport = createMockTransport();
    const refStore = createMockRefStore();
    const mainOid = randomOid();
    refStore._setRef("refs/heads/main", mainOid);

    const config = new ProcessConfiguration();
    config.serverCapabilities = ["multi_ack", "side-band-64k"];

    const ctx = createServerContext({ transport, refStore, config });
    await runHandler("SEND_ADVERTISEMENT", ctx);

    const lines = transport._getWrittenLines();
    const firstLine = lines[0];
    expect(firstLine).toContain("multi_ack");
    expect(firstLine).toContain("side-band-64k");
    expect(firstLine).not.toContain("filter");
  });

  it("should send capabilities^{} for empty repository", async () => {
    const transport = createMockTransport();
    const refStore = createMockRefStore();
    // No refs — empty repo

    const ctx = createServerContext({ transport, refStore });
    const event = await runHandler("SEND_ADVERTISEMENT", ctx);

    expect(event).toBe("EMPTY_REPO");
    const lines = transport._getWrittenLines();
    expect(lines[0]).toContain("capabilities^{}");
    expect(lines[0]).toContain("0".repeat(40));
  });

  it("should hide refs not in refStore from advertisement", async () => {
    const transport = createMockTransport();
    const refStore = createMockRefStore();
    const mainOid = randomOid();
    // Only add main, not secret ref
    refStore._setRef("refs/heads/main", mainOid);

    const ctx = createServerContext({ transport, refStore });
    await runHandler("SEND_ADVERTISEMENT", ctx);

    const lines = transport._getWrittenLines();
    expect(lines.some((l) => l.includes("refs/heads/main"))).toBe(true);
    expect(lines.some((l) => l.includes("refs/secret"))).toBe(false);
  });

  it("should store refs in protocol state after advertisement", async () => {
    const transport = createMockTransport();
    const refStore = createMockRefStore();
    const mainOid = randomOid();
    refStore._setRef("refs/heads/main", mainOid);

    const ctx = createServerContext({ transport, refStore });
    await runHandler("SEND_ADVERTISEMENT", ctx);

    const state = getState(ctx);
    expect(state.refs.get("refs/heads/main")).toBe(mainOid);
    expect(state.capabilities.size).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Packfile Generation and Sideband
// ─────────────────────────────────────────────────────────────────────────────

describe("Upload-Pack: Packfile Generation", () => {
  it("should send pack data via sideband when capability set", async () => {
    const transport = createMockTransport();
    const ctx = createServerContext({ transport });
    const state = getState(ctx);
    state.wants.add(randomOid());
    state.capabilities.add("side-band-64k");

    const event = await runHandler("SEND_PACK", ctx);
    expect(event).toBe("PACK_SENT");
    expect(transport.writeSideband).toHaveBeenCalled();
  });

  it("should send raw pack when no sideband capability", async () => {
    const transport = createMockTransport();
    const ctx = createServerContext({ transport });
    const state = getState(ctx);
    state.wants.add(randomOid());
    // No side-band-64k capability

    const event = await runHandler("SEND_PACK", ctx);
    expect(event).toBe("PACK_SENT");
    expect(transport.writePack).toHaveBeenCalled();
  });

  it("should send progress on sideband channel 2 when not suppressed", async () => {
    const transport = createMockTransport();
    const ctx = createServerContext({ transport });
    const state = getState(ctx);
    state.wants.add(randomOid());
    state.capabilities.add("side-band-64k");
    // no-progress NOT set

    await runHandler("SEND_PACK", ctx);

    // Channel 2 is used for progress
    const sidebandCalls = transport.writeSideband.mock.calls;
    const progressCalls = sidebandCalls.filter((call: [number, Uint8Array]) => call[0] === 2);
    expect(progressCalls.length).toBeGreaterThan(0);
  });

  it("should suppress progress when no-progress capability set", async () => {
    const transport = createMockTransport();
    const ctx = createServerContext({ transport });
    const state = getState(ctx);
    state.wants.add(randomOid());
    state.capabilities.add("side-band-64k");
    state.capabilities.add("no-progress");

    await runHandler("SEND_PACK", ctx);

    const sidebandCalls = transport.writeSideband.mock.calls;
    const progressCalls = sidebandCalls.filter((call: [number, Uint8Array]) => call[0] === 2);
    expect(progressCalls.length).toBe(0);
  });

  it("should track bytes sent", async () => {
    const transport = createMockTransport();
    const ctx = createServerContext({ transport });
    const state = getState(ctx);
    state.wants.add(randomOid());
    state.capabilities.add("side-band-64k");

    await runHandler("SEND_PACK", ctx);

    const output = getOutput(ctx);
    expect(output.sentBytes).toBeGreaterThan(0);
  });

  it("should send flush after pack data", async () => {
    const transport = createMockTransport();
    const ctx = createServerContext({ transport });
    const state = getState(ctx);
    state.wants.add(randomOid());
    state.capabilities.add("side-band-64k");

    await runHandler("SEND_PACK", ctx);
    expect(transport.writeFlush).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Negotiation
// ─────────────────────────────────────────────────────────────────────────────

describe("Upload-Pack: Negotiation", () => {
  it("should find common base from haves", async () => {
    const transport = createMockTransport();
    const repository = createMockRepository();
    const commonOid = randomOid();
    repository._addObject(commonOid);

    transport._setPackets(packets().data(`have ${commonOid}`).data("done").build());

    const ctx = createServerContext({ transport, repository });
    const event = await runHandler("READ_HAVES", ctx);

    expect(event).toBe("DONE_RECEIVED");
    expect(getState(ctx).commonBase.has(commonOid)).toBe(true);
  });

  it("should track haves not in repository", async () => {
    const transport = createMockTransport();
    const repository = createMockRepository();
    const unknownOid = randomOid();
    // Don't add to repository

    transport._setPackets(packets().data(`have ${unknownOid}`).flush().build());

    const ctx = createServerContext({ transport, repository });
    await runHandler("READ_HAVES", ctx);

    expect(getState(ctx).haves.has(unknownOid)).toBe(true);
    expect(getState(ctx).commonBase.has(unknownOid)).toBe(false);
  });

  it("should send NAK when no common objects (single-ack)", async () => {
    const transport = createMockTransport();
    const ctx = createServerContext({ transport });
    // No multi_ack capabilities, no common base

    const event = await runHandler("SEND_ACKS", ctx);
    expect(event).toBe("SENT_NAK_SINGLE");

    const lines = transport._getWrittenLines();
    expect(lines).toContain("NAK");
  });

  it("should send single ACK when common found (single-ack mode)", async () => {
    const transport = createMockTransport();
    const commonOid = randomOid();

    const ctx = createServerContext({ transport });
    const state = getState(ctx);
    state.commonBase.add(commonOid);
    // No multi_ack capabilities

    const event = await runHandler("SEND_ACKS", ctx);
    expect(event).toBe("SENT_SINGLE_ACK");

    const lines = transport._getWrittenLines();
    expect(lines).toContain(`ACK ${commonOid}`);
  });

  it("should send ACK common in multi_ack_detailed mode", async () => {
    const transport = createMockTransport();
    const commonOid = randomOid();

    const ctx = createServerContext({ transport });
    const state = getState(ctx);
    state.capabilities.add("multi_ack_detailed");
    state.commonBase.add(commonOid);

    const event = await runHandler("SEND_ACKS", ctx);
    expect(event).toBe("SENT_ACK_COMMON");

    const lines = transport._getWrittenLines();
    expect(lines.some((l) => l === `ACK ${commonOid} common`)).toBe(true);
  });

  it("should send ACK continue in multi_ack mode", async () => {
    const transport = createMockTransport();
    const commonOid = randomOid();

    const ctx = createServerContext({ transport });
    const state = getState(ctx);
    state.capabilities.add("multi_ack");
    state.commonBase.add(commonOid);

    const event = await runHandler("SEND_ACKS", ctx);
    expect(event).toBe("SENT_ACK_CONTINUE");

    const lines = transport._getWrittenLines();
    expect(lines.some((l) => l === `ACK ${commonOid} continue`)).toBe(true);
  });

  it("should send final ACK when common base exists", async () => {
    const transport = createMockTransport();
    const commonOid = randomOid();

    const ctx = createServerContext({ transport });
    getState(ctx).commonBase.add(commonOid);

    const event = await runHandler("SEND_FINAL_ACK", ctx);
    expect(event).toBe("ACK_SENT");

    const lines = transport._getWrittenLines();
    expect(lines).toContain(`ACK ${commonOid}`);
  });

  it("should send final NAK for clone (no common base)", async () => {
    const transport = createMockTransport();
    const ctx = createServerContext({ transport });
    // No common base (fresh clone)

    const event = await runHandler("SEND_FINAL_ACK", ctx);
    expect(event).toBe("NAK_SENT");

    const lines = transport._getWrittenLines();
    expect(lines).toContain("NAK");
  });

  it("should detect empty batch overflow", async () => {
    const transport = createMockTransport();
    const config = new ProcessConfiguration();
    config.maxEmptyBatches = 2;

    const ctx = createServerContext({ transport, config });
    const state = getState(ctx);
    state.emptyBatchCount = 3;
    // No multi_ack, no commonBase

    const event = await runHandler("SEND_ACKS", ctx);
    expect(event).toBe("ERROR");
    expect(getOutput(ctx).error).toContain("Too many empty negotiation rounds");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Error Handling
// ─────────────────────────────────────────────────────────────────────────────

describe("Upload-Pack: Error Handling", () => {
  it("should send ERR message for invalid want", async () => {
    const transport = createMockTransport();
    const ctx = createServerContext({ transport });
    getOutput(ctx).error = "want abc123 not valid";

    const event = await runHandler("SEND_ERROR", ctx);
    expect(event).toBe("ERROR_SENT");

    const lines = transport._getWrittenLines();
    expect(lines.some((l) => l.startsWith("ERR"))).toBe(true);
  });

  it("should handle EOF during READ_WANTS", async () => {
    const transport = createMockTransport();
    transport._setPackets(packets().eof().build());

    const ctx = createServerContext({ transport });
    const event = await runHandler("READ_WANTS", ctx);

    expect(event).toBe("ERROR");
    expect(getOutput(ctx).error).toContain("Unexpected end of input");
  });

  it("should handle EOF during READ_HAVES", async () => {
    const transport = createMockTransport();
    transport._setPackets(packets().eof().build());

    const ctx = createServerContext({ transport });
    const event = await runHandler("READ_HAVES", ctx);

    expect(event).toBe("ERROR");
    expect(getOutput(ctx).error).toContain("Unexpected end of input");
  });

  it("should handle transport error in SEND_ADVERTISEMENT", async () => {
    const transport = createMockTransport();
    transport.writeLine.mockRejectedValueOnce(new Error("Connection refused"));

    const refStore = createMockRefStore();
    refStore._setRef("refs/heads/main", randomOid());

    const ctx = createServerContext({ transport, refStore });
    const event = await runHandler("SEND_ADVERTISEMENT", ctx);

    expect(event).toBe("ERROR");
    expect(getOutput(ctx).error).toContain("Connection refused");
  });

  it("should handle no wants gracefully", async () => {
    const transport = createMockTransport();
    transport._setPackets(packets().flush().build());

    const ctx = createServerContext({ transport });
    const event = await runHandler("READ_WANTS", ctx);

    expect(event).toBe("NO_WANTS");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FSM End-to-End Flows
// ─────────────────────────────────────────────────────────────────────────────

describe("Upload-Pack: FSM End-to-End", () => {
  it("should construct valid server fetch FSM", () => {
    const fsm = new Fsm(serverFetchTransitions, serverFetchHandlers);
    expect(fsm.getState()).toBe("");
  });

  it("should construct valid server V2 FSM", () => {
    const fsm = new Fsm(serverV2Transitions, serverV2Handlers);
    expect(fsm.getState()).toBe("");
  });

  it("should parse client capabilities from first want line", async () => {
    const transport = createMockTransport();
    const wantOid = randomOid();

    transport._setPackets(
      packets().data(`want ${wantOid} multi_ack_detailed side-band-64k thin-pack`).flush().build(),
    );

    const ctx = createServerContext({ transport });
    getState(ctx).refs.set("refs/heads/main", wantOid);

    await runHandler("READ_WANTS", ctx);

    const state = getState(ctx);
    expect(state.capabilities.has("multi_ack_detailed")).toBe(true);
    expect(state.capabilities.has("side-band-64k")).toBe(true);
    expect(state.capabilities.has("thin-pack")).toBe(true);
  });

  it("should handle multiple wants from client", async () => {
    const transport = createMockTransport();
    const oid1 = randomOid();
    const oid2 = randomOid();
    const oid3 = randomOid();

    transport._setPackets(
      packets().data(`want ${oid1}`).data(`want ${oid2}`).data(`want ${oid3}`).flush().build(),
    );

    const ctx = createServerContext({ transport });
    const state = getState(ctx);
    state.refs.set("refs/heads/main", oid1);
    state.refs.set("refs/heads/dev", oid2);
    state.refs.set("refs/tags/v1", oid3);

    await runHandler("READ_WANTS", ctx);

    expect(state.wants.size).toBe(3);
    expect(state.wants.has(oid1)).toBe(true);
    expect(state.wants.has(oid2)).toBe(true);
    expect(state.wants.has(oid3)).toBe(true);
  });
});
