import { beforeEach, describe, expect, it } from "vitest";
import type { PackImportResult, RepositoryFacade } from "../../src/api/repository-facade.js";
import type { PktLineResult, SidebandResult, TransportApi } from "../../src/api/transport-api.js";
import { HandlerOutput } from "../../src/context/handler-output.js";
import { ProcessConfiguration } from "../../src/context/process-config.js";
import type { ProcessContext, RefStore } from "../../src/context/process-context.js";
import { ProtocolState } from "../../src/context/protocol-state.js";
import {
  classifyError,
  createErrorInfo,
  errorRecoveryHandlers,
  errorRecoveryTransitions,
  withErrorRecovery,
  withErrorRecoveryHandlers,
} from "../../src/fsm/error-recovery/index.js";
import { Fsm } from "../../src/fsm/index.js";

// Mock transport with close method for testing
interface MockTransportApi extends TransportApi {
  closed: boolean;
  close(): Promise<void>;
}

function createMockTransport(): MockTransportApi {
  return {
    closed: false,

    async readPktLine(): Promise<PktLineResult> {
      return { type: "flush" };
    },

    async writePktLine(): Promise<void> {},

    async writeFlush(): Promise<void> {},

    async writeDelimiter(): Promise<void> {},

    async readLine(): Promise<string | null> {
      return null;
    },

    async writeLine(): Promise<void> {},

    async readSideband(): Promise<SidebandResult> {
      return { channel: 1, data: new Uint8Array(0) };
    },

    async writeSideband(): Promise<void> {},

    async *readPack(): AsyncGenerator<Uint8Array> {},

    async writePack(): Promise<void> {},

    async close(): Promise<void> {
      this.closed = true;
    },
  };
}

// Mock repository facade
function createMockRepository(): RepositoryFacade {
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
    async *exportPack(): AsyncIterable<Uint8Array> {},
    async has(): Promise<boolean> {
      return false;
    },
    async *walkAncestors(): AsyncGenerator<string> {},
  };
}

// Mock ref store
function createMockRefStore(): RefStore {
  return {
    async get(): Promise<string | undefined> {
      return undefined;
    },
    async update(): Promise<void> {},
    async listAll(): Promise<Iterable<[string, string]>> {
      return [];
    },
  };
}

describe("Error Classifier", () => {
  let context: ProcessContext;

  beforeEach(() => {
    context = {
      transport: createMockTransport(),
      repository: createMockRepository(),
      refStore: createMockRefStore(),
      state: new ProtocolState(),
      output: new HandlerOutput(),
      config: new ProcessConfiguration(),
    };
  });

  describe("classifyError", () => {
    it("classifies timeout errors", () => {
      const event = classifyError(context, new Error("Request timed out"));
      expect(event).toBe("TIMEOUT");
      expect(context.output.errorInfo?.category).toBe("TIMEOUT");
      expect(context.output.errorInfo?.recoverable).toBe(true);
      expect(context.output.errorInfo?.retryable).toBe(true);
    });

    it("classifies transport errors", () => {
      const event = classifyError(context, new Error("Connection reset"));
      expect(event).toBe("TRANSPORT_ERROR");
      expect(context.output.errorInfo?.category).toBe("TRANSPORT_ERROR");
      expect(context.output.errorInfo?.recoverable).toBe(true);
    });

    it("classifies transport errors as retryable when reconnect allowed", () => {
      context.config.allowReconnect = true;
      const event = classifyError(context, new Error("Connection refused"));
      expect(event).toBe("TRANSPORT_ERROR");
      expect(context.output.errorInfo?.retryable).toBe(true);
    });

    it("classifies pack errors", () => {
      const event = classifyError(context, new Error("Pack file corrupt"));
      expect(event).toBe("PACK_ERROR");
      expect(context.output.errorInfo?.category).toBe("PACK_ERROR");
      expect(context.output.errorInfo?.recoverable).toBe(false);
      expect(context.output.errorInfo?.retryable).toBe(false);
    });

    it("classifies validation errors", () => {
      const event = classifyError(context, new Error("Invalid object ID"));
      expect(event).toBe("VALIDATION_ERROR");
      expect(context.output.errorInfo?.category).toBe("VALIDATION_ERROR");
      expect(context.output.errorInfo?.recoverable).toBe(false);
    });

    it("defaults to protocol error", () => {
      const event = classifyError(context, new Error("Unknown protocol state"));
      expect(event).toBe("PROTOCOL_ERROR");
      expect(context.output.errorInfo?.category).toBe("PROTOCOL_ERROR");
      expect(context.output.errorInfo?.recoverable).toBe(false);
    });

    it("handles non-Error objects", () => {
      const event = classifyError(context, "String error");
      expect(event).toBe("PROTOCOL_ERROR");
      expect(context.output.error).toBe("String error");
    });
  });

  describe("createErrorInfo", () => {
    it("creates timeout error info", () => {
      const info = createErrorInfo("Connection timed out");
      expect(info.category).toBe("TIMEOUT");
      expect(info.event).toBe("TIMEOUT");
      expect(info.recoverable).toBe(true);
    });

    it("creates transport error info", () => {
      const info = createErrorInfo("connection closed");
      expect(info.category).toBe("TRANSPORT_ERROR");
      expect(info.event).toBe("TRANSPORT_ERROR");
    });

    it("creates transport error with reconnect flag", () => {
      const info = createErrorInfo("Connection reset", true);
      expect(info.retryable).toBe(true);
    });

    it("creates pack error info", () => {
      const info = createErrorInfo("Invalid pack checksum");
      expect(info.category).toBe("PACK_ERROR");
      expect(info.recoverable).toBe(false);
    });

    it("creates validation error info", () => {
      const info = createErrorInfo("Ref not found");
      expect(info.category).toBe("VALIDATION_ERROR");
    });
  });
});

describe("Error Recovery FSM", () => {
  let transport: ReturnType<typeof createMockTransport>;
  let context: ProcessContext;
  let progressMessages: string[];

  beforeEach(() => {
    transport = createMockTransport();
    progressMessages = [];
    context = {
      transport,
      repository: createMockRepository(),
      refStore: createMockRefStore(),
      state: new ProtocolState(),
      output: new HandlerOutput(),
      config: new ProcessConfiguration(),
    };
    context.config.onProgress = (msg) => progressMessages.push(msg);
    context.config.maxRetries = 3;
  });

  describe("HANDLE_PROTOCOL_ERROR state", () => {
    it("returns RECOVERABLE for recoverable errors with retries left", async () => {
      context.output.errorInfo = {
        category: "PROTOCOL_ERROR",
        message: "Test error",
        recoverable: true,
        retryable: true,
      };
      context.output.retryCount = 0;

      const fsm = new Fsm(errorRecoveryTransitions, errorRecoveryHandlers);
      fsm.setState("HANDLE_PROTOCOL_ERROR");
      await fsm.run(context, "RETRY_OPERATION");

      expect(fsm.getState()).toBe("RETRY_OPERATION");
    });

    it("returns FATAL for non-recoverable errors", async () => {
      context.output.errorInfo = {
        category: "PROTOCOL_ERROR",
        message: "Fatal error",
        recoverable: false,
        retryable: false,
      };

      const fsm = new Fsm(errorRecoveryTransitions, errorRecoveryHandlers);
      fsm.setState("HANDLE_PROTOCOL_ERROR");
      await fsm.run(context, "CLEANUP");

      expect(fsm.getState()).toBe("CLEANUP");
    });

    it("returns FATAL when max retries exceeded", async () => {
      context.output.errorInfo = {
        category: "PROTOCOL_ERROR",
        message: "Test error",
        recoverable: true,
        retryable: true,
      };
      context.output.retryCount = 3;

      const fsm = new Fsm(errorRecoveryTransitions, errorRecoveryHandlers);
      fsm.setState("HANDLE_PROTOCOL_ERROR");
      await fsm.run(context, "CLEANUP");

      expect(fsm.getState()).toBe("CLEANUP");
    });
  });

  describe("HANDLE_TRANSPORT_ERROR state", () => {
    it("returns RECONNECT when reconnect allowed and available", async () => {
      context.config.allowReconnect = true;
      context.config.reconnect = async () => ({
        readable: new ReadableStream(),
        writable: new WritableStream(),
      });
      context.output.errorInfo = {
        category: "TRANSPORT_ERROR",
        message: "Connection lost",
        recoverable: true,
        retryable: true,
      };

      const fsm = new Fsm(errorRecoveryTransitions, errorRecoveryHandlers);
      fsm.setState("HANDLE_TRANSPORT_ERROR");
      await fsm.run(context, "ATTEMPTING_RECONNECT");

      expect(fsm.getState()).toBe("ATTEMPTING_RECONNECT");
    });

    it("returns FATAL when reconnect not allowed", async () => {
      context.config.allowReconnect = false;
      context.output.errorInfo = {
        category: "TRANSPORT_ERROR",
        message: "Connection lost",
        recoverable: true,
        retryable: false,
      };

      const fsm = new Fsm(errorRecoveryTransitions, errorRecoveryHandlers);
      fsm.setState("HANDLE_TRANSPORT_ERROR");
      await fsm.run(context, "CLEANUP");

      expect(fsm.getState()).toBe("CLEANUP");
    });
  });

  describe("ATTEMPTING_RECONNECT state", () => {
    it("returns CONNECTED on successful reconnect", async () => {
      context.config.reconnect = async () => ({
        readable: new ReadableStream(),
        writable: new WritableStream(),
      });

      const fsm = new Fsm(errorRecoveryTransitions, errorRecoveryHandlers);
      fsm.setState("ATTEMPTING_RECONNECT");
      await fsm.run(context, "RESTORE_STATE");

      expect(fsm.getState()).toBe("RESTORE_STATE");
      expect(progressMessages).toContain("Reconnected successfully");
    });

    it("returns FAILED when reconnect returns null", async () => {
      context.config.reconnect = async () => null;

      const fsm = new Fsm(errorRecoveryTransitions, errorRecoveryHandlers);
      fsm.setState("ATTEMPTING_RECONNECT");
      await fsm.run(context, "CLEANUP");

      expect(fsm.getState()).toBe("CLEANUP");
    });

    it("returns FAILED when reconnect throws", async () => {
      context.config.reconnect = async () => {
        throw new Error("Cannot connect");
      };

      const fsm = new Fsm(errorRecoveryTransitions, errorRecoveryHandlers);
      fsm.setState("ATTEMPTING_RECONNECT");
      await fsm.run(context, "CLEANUP");

      expect(fsm.getState()).toBe("CLEANUP");
      expect(context.output.error).toContain("Cannot connect");
    });

    it("closes old transport before reconnecting", async () => {
      context.config.reconnect = async () => ({
        readable: new ReadableStream(),
        writable: new WritableStream(),
      });

      const fsm = new Fsm(errorRecoveryTransitions, errorRecoveryHandlers);
      fsm.setState("ATTEMPTING_RECONNECT");
      await fsm.run(context, "RESTORE_STATE");

      expect(transport.closed).toBe(true);
    });
  });

  describe("RESTORE_STATE state", () => {
    it("restores state from checkpoint", async () => {
      // Set up some state
      context.state.refs.set("refs/heads/main", "abc123");
      context.state.capabilities.add("ofs-delta");

      // Create checkpoint
      context.state.createCheckpoint();

      // Modify state
      context.state.refs.set("refs/heads/main", "modified");
      context.state.refs.set("refs/heads/feature", "new");

      // Call the handler directly to test state restoration
      const handler = errorRecoveryHandlers.get("RESTORE_STATE");
      expect(handler).toBeDefined();
      const result = await handler?.(context);

      expect(result).toBe("RESTORED");
      expect(context.state.refs.get("refs/heads/main")).toBe("abc123");
      expect(context.state.refs.has("refs/heads/feature")).toBe(false);
      expect(progressMessages).toContain("State restored from checkpoint");
    });
  });

  describe("HANDLE_TIMEOUT state", () => {
    it("returns RETRY when retries available", async () => {
      context.output.retryCount = 0;

      const fsm = new Fsm(errorRecoveryTransitions, errorRecoveryHandlers);
      fsm.setState("HANDLE_TIMEOUT");
      await fsm.run(context, "RETRY_OPERATION");

      expect(fsm.getState()).toBe("RETRY_OPERATION");
    });

    it("returns ABORT when max retries exceeded", async () => {
      context.output.retryCount = 3;

      const fsm = new Fsm(errorRecoveryTransitions, errorRecoveryHandlers);
      fsm.setState("HANDLE_TIMEOUT");
      await fsm.run(context, "CLEANUP");

      expect(fsm.getState()).toBe("CLEANUP");
    });
  });

  describe("HANDLE_PACK_ERROR state", () => {
    it("always returns FATAL", async () => {
      context.output.errorInfo = {
        category: "PACK_ERROR",
        message: "Corrupt pack",
        recoverable: false,
        retryable: false,
      };

      const fsm = new Fsm(errorRecoveryTransitions, errorRecoveryHandlers);
      fsm.setState("HANDLE_PACK_ERROR");
      await fsm.run(context, "CLEANUP");

      expect(fsm.getState()).toBe("CLEANUP");
    });
  });

  describe("HANDLE_VALIDATION_ERROR state", () => {
    it("always returns FATAL", async () => {
      context.output.errorInfo = {
        category: "VALIDATION_ERROR",
        message: "Invalid ref",
        recoverable: false,
        retryable: false,
      };

      const fsm = new Fsm(errorRecoveryTransitions, errorRecoveryHandlers);
      fsm.setState("HANDLE_VALIDATION_ERROR");
      await fsm.run(context, "CLEANUP");

      expect(fsm.getState()).toBe("CLEANUP");
    });
  });

  describe("RETRY_OPERATION state", () => {
    it("increments retry count and returns RETRY_OK", async () => {
      context.output.retryCount = 0;
      context.config.maxRetries = 5;

      // Call the handler directly to test retry logic
      const handler = errorRecoveryHandlers.get("RETRY_OPERATION");
      expect(handler).toBeDefined();

      // Mock setTimeout to avoid delays
      const originalSetTimeout = globalThis.setTimeout;
      globalThis.setTimeout = ((fn: () => void) => {
        fn();
        return 0;
      }) as typeof setTimeout;

      try {
        const result = await handler?.(context);
        expect(result).toBe("RETRY_OK");
        expect(context.output.retryCount).toBe(1);
      } finally {
        globalThis.setTimeout = originalSetTimeout;
      }
    });

    it("returns MAX_RETRIES when limit reached", async () => {
      context.output.retryCount = 2;
      context.config.maxRetries = 3;

      // Call the handler directly
      const handler = errorRecoveryHandlers.get("RETRY_OPERATION");
      expect(handler).toBeDefined();

      const originalSetTimeout = globalThis.setTimeout;
      globalThis.setTimeout = ((fn: () => void) => {
        fn();
        return 0;
      }) as typeof setTimeout;

      try {
        const result = await handler?.(context);
        expect(result).toBe("MAX_RETRIES");
      } finally {
        globalThis.setTimeout = originalSetTimeout;
      }
    });
  });

  describe("CLEANUP state", () => {
    it("closes transport", async () => {
      const fsm = new Fsm(errorRecoveryTransitions, errorRecoveryHandlers);
      fsm.setState("CLEANUP");
      const result = await fsm.run(context);

      expect(result).toBe(true);
      expect(transport.closed).toBe(true);
      expect(progressMessages).toContain("Cleanup complete");
    });

    it("runs rollback if provided", async () => {
      let rolledBack = false;
      context.output.rollback = async () => {
        rolledBack = true;
      };

      const fsm = new Fsm(errorRecoveryTransitions, errorRecoveryHandlers);
      fsm.setState("CLEANUP");
      await fsm.run(context);

      expect(rolledBack).toBe(true);
    });

    it("handles cleanup errors gracefully", async () => {
      context.output.rollback = async () => {
        throw new Error("Rollback failed");
      };

      const fsm = new Fsm(errorRecoveryTransitions, errorRecoveryHandlers);
      fsm.setState("CLEANUP");
      const result = await fsm.run(context);

      expect(result).toBe(true); // Should still complete
    });
  });
});

describe("Helper Functions", () => {
  it("withErrorRecovery merges transitions", () => {
    const protocolTransitions = [
      ["", "START", "READ_DATA"],
      ["READ_DATA", "DONE", ""],
    ] as [string, string, string][];

    const merged = withErrorRecovery(protocolTransitions);

    expect(merged.length).toBe(protocolTransitions.length + errorRecoveryTransitions.length);
    expect(merged[0]).toEqual(["", "START", "READ_DATA"]);
    expect(merged.some((t) => t[0] === "*" && t[1] === "PROTOCOL_ERROR")).toBe(true);
  });

  it("withErrorRecoveryHandlers merges handlers", () => {
    const protocolHandlers = new Map<string, () => Promise<string>>([
      ["READ_DATA", async () => "DONE"],
    ]);

    const merged = withErrorRecoveryHandlers(
      protocolHandlers as Map<string, () => Promise<string>>,
    );

    expect(merged.has("READ_DATA")).toBe(true);
    expect(merged.has("HANDLE_PROTOCOL_ERROR")).toBe(true);
    expect(merged.has("CLEANUP")).toBe(true);
  });
});

describe("ProtocolState Checkpoint", () => {
  it("creates and restores checkpoint", () => {
    const state = new ProtocolState();
    state.refs.set("refs/heads/main", "abc123");
    state.wants.add("def456");
    state.capabilities.add("ofs-delta");
    state.protocolVersion = 2;

    state.createCheckpoint();

    // Modify state
    state.refs.set("refs/heads/main", "modified");
    state.refs.set("refs/heads/new", "new-ref");
    state.wants.add("new-want");
    state.protocolVersion = 1;

    // Restore
    const restored = state.restoreCheckpoint();

    expect(restored).toBe(true);
    expect(state.refs.get("refs/heads/main")).toBe("abc123");
    expect(state.refs.has("refs/heads/new")).toBe(false);
    expect(state.wants.has("new-want")).toBe(false);
    expect(state.protocolVersion).toBe(2);
  });

  it("returns false when no checkpoint exists", () => {
    const state = new ProtocolState();
    const restored = state.restoreCheckpoint();
    expect(restored).toBe(false);
  });

  it("resets checkpoint on reset()", () => {
    const state = new ProtocolState();
    state.refs.set("refs/heads/main", "abc123");
    state.createCheckpoint();

    state.reset();

    expect(state.checkpoint).toBeUndefined();
    expect(state.refs.size).toBe(0);
  });
});
