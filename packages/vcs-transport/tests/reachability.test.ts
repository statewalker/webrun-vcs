/**
 * Reachability Validator Tests
 *
 * Ported from JGit's reachability validation test files:
 * - ReachableCommitRequestValidatorTest.java
 * - ReachableCommitTipRequestValidatorTest.java
 * - TipRequestValidatorTest.java
 *
 * Tests that the server fetch FSM correctly validates want requests
 * against different request policies using the repository's reachability
 * methods.
 */

import { describe, expect, it } from "vitest";

import {
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
import { serverFetchHandlers } from "../src/fsm/fetch/index.js";
import {
  createMockRefStore,
  createMockRepository,
  createMockTransport,
  type MockRefStore,
  type MockRepository,
  type MockTransport,
  randomOid,
} from "./helpers/test-protocol.js";

// ─────────────────────────────────────────────────────────────────────────────
// Test utilities
// ─────────────────────────────────────────────────────────────────────────────

function createValidationContext(overrides?: {
  transport?: MockTransport;
  repository?: MockRepository;
  refStore?: MockRefStore;
  config?: ProcessConfiguration;
}): ProcessContext {
  const ctx: ProcessContext = {};
  setTransport(ctx, overrides?.transport ?? createMockTransport());
  setRepository(ctx, overrides?.repository ?? createMockRepository());
  setRefStore(ctx, overrides?.refStore ?? createMockRefStore());
  setState(ctx, new ProtocolState());
  setOutput(ctx, new HandlerOutput());
  setConfig(ctx, overrides?.config ?? new ProcessConfiguration());
  return ctx;
}

async function validateWants(ctx: ProcessContext): Promise<string> {
  const handler = serverFetchHandlers.get("VALIDATE_WANTS");
  if (!handler) throw new Error("No VALIDATE_WANTS handler");
  return handler(ctx);
}

// ─────────────────────────────────────────────────────────────────────────────
// ReachableCommitRequestValidator
// ─────────────────────────────────────────────────────────────────────────────

describe("ReachableCommitRequestValidator", () => {
  it("should accept reachable commit", async () => {
    const repository = createMockRepository();
    const tipOid = randomOid();
    const reachableOid = randomOid();

    // Object is reachable from advertised tip
    repository._addObject(reachableOid);
    repository._setAncestors(tipOid, [reachableOid]);
    repository.isReachableFrom.mockResolvedValueOnce(true);

    const config = new ProcessConfiguration();
    config.requestPolicy = "REACHABLE_COMMIT";

    const ctx = createValidationContext({ repository, config });
    const state = getState(ctx);
    state.refs.set("refs/heads/main", tipOid);
    state.wants.add(reachableOid);

    const event = await validateWants(ctx);
    expect(event).toBe("VALID");
    expect(repository.isReachableFrom).toHaveBeenCalledWith(reachableOid, [tipOid]);
  });

  it("should reject unreachable commit", async () => {
    const repository = createMockRepository();
    const tipOid = randomOid();
    const unreachableOid = randomOid();

    // Object is NOT reachable from any tip
    repository.isReachableFrom.mockResolvedValueOnce(false);

    const config = new ProcessConfiguration();
    config.requestPolicy = "REACHABLE_COMMIT";

    const ctx = createValidationContext({ repository, config });
    const state = getState(ctx);
    state.refs.set("refs/heads/main", tipOid);
    state.wants.add(unreachableOid);

    const event = await validateWants(ctx);
    expect(event).toBe("INVALID_WANT");
    expect(getOutput(ctx).invalidWant).toBe(unreachableOid);
  });

  it("should accept a commit reachable from multiple branches", async () => {
    const repository = createMockRepository();
    const mainTip = randomOid();
    const devTip = randomOid();
    const commonAncestor = randomOid();

    // Reachable from one of the tips
    repository._addObject(commonAncestor);
    repository.isReachableFrom.mockResolvedValueOnce(true);

    const config = new ProcessConfiguration();
    config.requestPolicy = "REACHABLE_COMMIT";

    const ctx = createValidationContext({ repository, config });
    const state = getState(ctx);
    state.refs.set("refs/heads/main", mainTip);
    state.refs.set("refs/heads/dev", devTip);
    state.wants.add(commonAncestor);

    const event = await validateWants(ctx);
    expect(event).toBe("VALID");
    // Should pass all tip OIDs to isReachableFrom
    expect(repository.isReachableFrom).toHaveBeenCalledWith(
      commonAncestor,
      expect.arrayContaining([mainTip, devTip]),
    );
  });

  it("should fall back to advertised check when isReachableFrom not available", async () => {
    const repository = createMockRepository();
    // Remove the isReachableFrom method to test fallback
    delete (repository as Partial<MockRepository>).isReachableFrom;

    const tipOid = randomOid();

    const config = new ProcessConfiguration();
    config.requestPolicy = "REACHABLE_COMMIT";

    const ctx = createValidationContext({ repository, config });
    const state = getState(ctx);
    state.refs.set("refs/heads/main", tipOid);
    state.wants.add(tipOid); // Want the tip itself — should pass via fallback

    const event = await validateWants(ctx);
    expect(event).toBe("VALID");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ReachableCommitTipRequestValidator
// ─────────────────────────────────────────────────────────────────────────────

describe("ReachableCommitTipRequestValidator", () => {
  it("should accept tip commit", async () => {
    const repository = createMockRepository();
    const tipOid = randomOid();

    repository._addObject(tipOid);
    repository.isReachableFromAnyTip.mockResolvedValueOnce(true);

    const config = new ProcessConfiguration();
    config.requestPolicy = "REACHABLE_COMMIT_TIP";

    const ctx = createValidationContext({ repository, config });
    const state = getState(ctx);
    state.wants.add(tipOid);

    const event = await validateWants(ctx);
    expect(event).toBe("VALID");
  });

  it("should accept reachable-from-tip commit", async () => {
    const repository = createMockRepository();
    const reachableOid = randomOid();

    repository._addObject(reachableOid);
    repository.isReachableFromAnyTip.mockResolvedValueOnce(true);

    const config = new ProcessConfiguration();
    config.requestPolicy = "REACHABLE_COMMIT_TIP";

    const ctx = createValidationContext({ repository, config });
    const state = getState(ctx);
    state.wants.add(reachableOid);

    const event = await validateWants(ctx);
    expect(event).toBe("VALID");
    expect(repository.isReachableFromAnyTip).toHaveBeenCalledWith(reachableOid);
  });

  it("should reject unreachable commit", async () => {
    const repository = createMockRepository();
    const unreachableOid = randomOid();

    repository.isReachableFromAnyTip.mockResolvedValueOnce(false);

    const config = new ProcessConfiguration();
    config.requestPolicy = "REACHABLE_COMMIT_TIP";

    const ctx = createValidationContext({ repository, config });
    const state = getState(ctx);
    state.wants.add(unreachableOid);

    const event = await validateWants(ctx);
    expect(event).toBe("INVALID_WANT");
    expect(getOutput(ctx).invalidWant).toBe(unreachableOid);
  });

  it("should fall back to advertised check when isReachableFromAnyTip not available", async () => {
    const repository = createMockRepository();
    delete (repository as Partial<MockRepository>).isReachableFromAnyTip;

    const tipOid = randomOid();

    const config = new ProcessConfiguration();
    config.requestPolicy = "REACHABLE_COMMIT_TIP";

    const ctx = createValidationContext({ repository, config });
    const state = getState(ctx);
    state.refs.set("refs/heads/main", tipOid);
    state.wants.add(tipOid); // Exists in refs values — passes fallback

    const event = await validateWants(ctx);
    expect(event).toBe("VALID");
  });

  it("should validate multiple wants independently", async () => {
    const repository = createMockRepository();
    const reachableOid = randomOid();
    const unreachableOid = randomOid();

    repository._addObject(reachableOid);
    // First call: reachable, second call: unreachable
    repository.isReachableFromAnyTip.mockResolvedValueOnce(true);
    repository.isReachableFromAnyTip.mockResolvedValueOnce(false);

    const config = new ProcessConfiguration();
    config.requestPolicy = "REACHABLE_COMMIT_TIP";

    const ctx = createValidationContext({ repository, config });
    const state = getState(ctx);
    state.wants.add(reachableOid);
    state.wants.add(unreachableOid);

    const event = await validateWants(ctx);
    // Validation fails on first invalid want
    expect(event).toBe("INVALID_WANT");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TipRequestValidator
// ─────────────────────────────────────────────────────────────────────────────

describe("TipRequestValidator", () => {
  it("should accept tip commit", async () => {
    const refStore = createMockRefStore();
    const tipOid = randomOid();
    refStore._setRef("refs/heads/main", tipOid);

    const config = new ProcessConfiguration();
    config.requestPolicy = "TIP";

    const ctx = createValidationContext({ refStore, config });
    const state = getState(ctx);
    state.refs.set("refs/heads/main", tipOid);
    state.wants.add(tipOid);

    const event = await validateWants(ctx);
    expect(event).toBe("VALID");
    expect(refStore.isRefTip).toHaveBeenCalledWith(tipOid);
  });

  it("should reject non-tip commit", async () => {
    const refStore = createMockRefStore();
    const tipOid = randomOid();
    const nonTipOid = randomOid();
    refStore._setRef("refs/heads/main", tipOid);
    refStore.isRefTip.mockResolvedValueOnce(false);

    const config = new ProcessConfiguration();
    config.requestPolicy = "TIP";

    const ctx = createValidationContext({ refStore, config });
    const state = getState(ctx);
    state.refs.set("refs/heads/main", tipOid);
    state.wants.add(nonTipOid);

    const event = await validateWants(ctx);
    expect(event).toBe("INVALID_WANT");
    expect(getOutput(ctx).invalidWant).toBe(nonTipOid);
  });

  it("should accept tag tip", async () => {
    const refStore = createMockRefStore();
    const tagOid = randomOid();
    refStore._setRef("refs/tags/v1.0", tagOid);

    const config = new ProcessConfiguration();
    config.requestPolicy = "TIP";

    const ctx = createValidationContext({ refStore, config });
    const state = getState(ctx);
    state.refs.set("refs/tags/v1.0", tagOid);
    state.wants.add(tagOid);

    const event = await validateWants(ctx);
    expect(event).toBe("VALID");
  });

  it("should fall back to advertised check when isRefTip not available", async () => {
    const refStore = createMockRefStore();
    // Remove isRefTip to test fallback
    delete (refStore as Partial<MockRefStore>).isRefTip;

    const tipOid = randomOid();
    refStore._setRef("refs/heads/main", tipOid);

    const config = new ProcessConfiguration();
    config.requestPolicy = "TIP";

    const ctx = createValidationContext({ refStore, config });
    const state = getState(ctx);
    state.refs.set("refs/heads/main", tipOid);
    state.wants.add(tipOid); // In refs values — passes fallback

    const event = await validateWants(ctx);
    expect(event).toBe("VALID");
  });

  it("should reject object that is ancestor of tip but not a tip itself", async () => {
    const refStore = createMockRefStore();
    const tipOid = randomOid();
    const ancestorOid = randomOid();
    refStore._setRef("refs/heads/main", tipOid);
    refStore.isRefTip.mockResolvedValueOnce(false);

    const config = new ProcessConfiguration();
    config.requestPolicy = "TIP";

    const ctx = createValidationContext({ refStore, config });
    const state = getState(ctx);
    state.refs.set("refs/heads/main", tipOid);
    state.wants.add(ancestorOid);

    const event = await validateWants(ctx);
    expect(event).toBe("INVALID_WANT");
    expect(getOutput(ctx).invalidWant).toBe(ancestorOid);
  });

  it("should accept tip from any branch, not just main", async () => {
    const refStore = createMockRefStore();
    const mainTip = randomOid();
    const featureTip = randomOid();
    refStore._setRef("refs/heads/main", mainTip);
    refStore._setRef("refs/heads/feature", featureTip);

    const config = new ProcessConfiguration();
    config.requestPolicy = "TIP";

    const ctx = createValidationContext({ refStore, config });
    const state = getState(ctx);
    state.refs.set("refs/heads/main", mainTip);
    state.refs.set("refs/heads/feature", featureTip);
    state.wants.add(featureTip);

    const event = await validateWants(ctx);
    expect(event).toBe("VALID");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cross-validator comparison
// ─────────────────────────────────────────────────────────────────────────────

describe("Reachability: Cross-policy comparison", () => {
  it("ADVERTISED policy rejects object that TIP accepts (non-advertised tip)", async () => {
    const refStore = createMockRefStore();
    const repository = createMockRepository();
    const hiddenTip = randomOid();

    // Object exists in refStore but was NOT in the advertisement state.refs
    refStore._setRef("refs/hidden/internal", hiddenTip);
    repository._addObject(hiddenTip);

    // Test with ADVERTISED policy — should fail (not in state.refs)
    const config1 = new ProcessConfiguration();
    config1.requestPolicy = "ADVERTISED";
    const ctx1 = createValidationContext({ refStore, repository, config: config1 });
    getState(ctx1).wants.add(hiddenTip);
    // state.refs is empty — not advertised

    const event1 = await validateWants(ctx1);
    expect(event1).toBe("INVALID_WANT");

    // Test with TIP policy — should pass (isRefTip returns true)
    const config2 = new ProcessConfiguration();
    config2.requestPolicy = "TIP";
    const ctx2 = createValidationContext({ refStore, repository, config: config2 });
    getState(ctx2).wants.add(hiddenTip);

    const event2 = await validateWants(ctx2);
    expect(event2).toBe("VALID");
  });

  it("ANY policy accepts object that REACHABLE_COMMIT rejects", async () => {
    const repository = createMockRepository();
    const orphanOid = randomOid();
    repository._addObject(orphanOid);
    repository.isReachableFrom.mockResolvedValueOnce(false);

    // REACHABLE_COMMIT — fails (not reachable from tips)
    const config1 = new ProcessConfiguration();
    config1.requestPolicy = "REACHABLE_COMMIT";
    const ctx1 = createValidationContext({ repository, config: config1 });
    const state1 = getState(ctx1);
    state1.refs.set("refs/heads/main", randomOid());
    state1.wants.add(orphanOid);

    const event1 = await validateWants(ctx1);
    expect(event1).toBe("INVALID_WANT");

    // ANY — passes (object exists in repo)
    const config2 = new ProcessConfiguration();
    config2.requestPolicy = "ANY";
    const ctx2 = createValidationContext({ repository, config: config2 });
    getState(ctx2).wants.add(orphanOid);

    const event2 = await validateWants(ctx2);
    expect(event2).toBe("VALID");
  });
});
