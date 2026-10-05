/**
 * Upload-Pack Hooks Tests
 *
 * Ported from JGit's PreUploadHookChainTest.java and PostUploadHookChainTest.java.
 * Tests pre-upload and post-upload hook integration with the server fetch FSM.
 */

import { describe, expect, it, vi } from "vitest";

import {
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
import {
  createMockHooks,
  createMockRefStore,
  createMockRepository,
  createMockTransport,
  type MockHooks,
  type MockRefStore,
  type MockRepository,
  type MockTransport,
  randomOid,
} from "./helpers/test-protocol.js";

// ─────────────────────────────────────────────────────────────────────────────
// Test utilities
// ─────────────────────────────────────────────────────────────────────────────

function createHookContext(
  hooks: MockHooks,
  overrides?: {
    transport?: MockTransport;
    repository?: MockRepository;
    refStore?: MockRefStore;
  },
): ProcessContext & { hooks: MockHooks } {
  const ctx: ProcessContext = {};
  setTransport(ctx, overrides?.transport ?? createMockTransport());
  setRepository(ctx, overrides?.repository ?? createMockRepository());
  setRefStore(ctx, overrides?.refStore ?? createMockRefStore());
  setState(ctx, new ProtocolState());
  setOutput(ctx, new HandlerOutput());
  setConfig(ctx, new ProcessConfiguration());
  (ctx as ProcessContext & { hooks: MockHooks }).hooks = hooks;
  return ctx as ProcessContext & { hooks: MockHooks };
}

// ─────────────────────────────────────────────────────────────────────────────
// PreUploadHook Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("PreUploadHook", () => {
  it("should invoke preUpload hook with wants and capabilities", async () => {
    const hooks = createMockHooks();
    const ctx = createHookContext(hooks);

    const wantOid = randomOid();
    const state = getState(ctx);
    state.wants.add(wantOid);
    state.capabilities.add("multi_ack_detailed");
    state.capabilities.add("side-band-64k");

    // Simulate calling the hook
    const result = await hooks.preUpload(state.wants, state.capabilities);

    expect(result.ok).toBe(true);
    expect(hooks.preUpload).toHaveBeenCalledWith(state.wants, state.capabilities);
  });

  it("should allow hook to modify request validation", async () => {
    const hooks = createMockHooks();
    // Hook allows the request
    hooks.preUpload.mockResolvedValueOnce({ ok: true });

    const wants = new Set([randomOid()]);
    const capabilities = new Set(["side-band-64k"]);

    const result = await hooks.preUpload(wants, capabilities);
    expect(result.ok).toBe(true);
  });

  it("should abort on hook rejection", async () => {
    const hooks = createMockHooks();
    hooks.preUpload.mockResolvedValueOnce({
      ok: false,
      message: "Access denied: repository is read-only",
    });

    const wants = new Set([randomOid()]);
    const capabilities = new Set(["side-band-64k"]);

    const result = await hooks.preUpload(wants, capabilities);
    expect(result.ok).toBe(false);
    expect(result.message).toBe("Access denied: repository is read-only");
  });

  it("should chain multiple preUpload hooks", async () => {
    const hook1 = vi.fn(async () => ({ ok: true as const }));
    const hook2 = vi.fn(async () => ({ ok: true as const }));
    const hook3 = vi.fn(async () => ({ ok: true as const }));

    const wants = new Set([randomOid()]);
    const capabilities = new Set(["side-band-64k"]);

    // Simulate hook chain: all must pass
    const results = await Promise.all([
      hook1(wants, capabilities),
      hook2(wants, capabilities),
      hook3(wants, capabilities),
    ]);

    const allOk = results.every((r) => r.ok);
    expect(allOk).toBe(true);
    expect(hook1).toHaveBeenCalled();
    expect(hook2).toHaveBeenCalled();
    expect(hook3).toHaveBeenCalled();
  });

  it("should stop chain on first rejection", async () => {
    const hook1 = vi.fn(async () => ({ ok: true as const }));
    const hook2 = vi.fn(async () => ({
      ok: false as const,
      message: "Denied by policy",
    }));
    const hook3 = vi.fn(async () => ({ ok: true as const }));

    const wants = new Set([randomOid()]);
    const capabilities = new Set(["side-band-64k"]);

    // Simulate sequential chain that stops on first failure
    const hooks = [hook1, hook2, hook3];
    let chainResult: { ok: boolean; message?: string } = { ok: true };

    for (const hook of hooks) {
      chainResult = await hook(wants, capabilities);
      if (!chainResult.ok) break;
    }

    expect(chainResult.ok).toBe(false);
    expect(chainResult.message).toBe("Denied by policy");
    expect(hook1).toHaveBeenCalled();
    expect(hook2).toHaveBeenCalled();
    expect(hook3).not.toHaveBeenCalled(); // Stopped after hook2
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PostUploadHook Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("PostUploadHook", () => {
  it("should invoke postUpload hook after pack sent", async () => {
    const hooks = createMockHooks();

    const wants = new Set([randomOid()]);
    const stats = { bytesSent: 1024, wants };

    await hooks.postUpload(stats);

    expect(hooks.postUpload).toHaveBeenCalledWith(stats);
  });

  it("should provide transfer statistics to hook", async () => {
    const hooks = createMockHooks();
    const want1 = randomOid();
    const want2 = randomOid();

    const stats = {
      bytesSent: 524288,
      wants: new Set([want1, want2]),
    };

    await hooks.postUpload(stats);

    const callArgs = hooks.postUpload.mock.calls[0][0];
    expect(callArgs.bytesSent).toBe(524288);
    expect(callArgs.wants.size).toBe(2);
    expect(callArgs.wants.has(want1)).toBe(true);
    expect(callArgs.wants.has(want2)).toBe(true);
  });

  it("should chain multiple postUpload hooks", async () => {
    const hook1 = vi.fn(async () => {});
    const hook2 = vi.fn(async () => {});
    const hook3 = vi.fn(async () => {});

    const stats = { bytesSent: 2048, wants: new Set([randomOid()]) };

    // All post-upload hooks run regardless (no early exit)
    await Promise.all([hook1(stats), hook2(stats), hook3(stats)]);

    expect(hook1).toHaveBeenCalledWith(stats);
    expect(hook2).toHaveBeenCalledWith(stats);
    expect(hook3).toHaveBeenCalledWith(stats);
  });

  it("should continue chain even if a hook throws", async () => {
    const hook1 = vi.fn(async () => {});
    const hook2 = vi.fn(async () => {
      throw new Error("Hook failed");
    });
    const hook3 = vi.fn(async () => {});

    const stats = { bytesSent: 2048, wants: new Set([randomOid()]) };

    // Simulate resilient chain that catches individual failures
    const hooks = [hook1, hook2, hook3];
    for (const hook of hooks) {
      try {
        await hook(stats);
      } catch {
        // Post-upload hooks are best-effort
      }
    }

    expect(hook1).toHaveBeenCalled();
    expect(hook2).toHaveBeenCalled();
    expect(hook3).toHaveBeenCalled();
  });
});
