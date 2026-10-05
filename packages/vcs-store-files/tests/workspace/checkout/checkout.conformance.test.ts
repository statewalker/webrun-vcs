import type { Checkout, HeadValue } from "@statewalker/vcs-working-tree";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// This file exports a conformance test factory, not direct tests.
// Implementations use checkoutConformanceTests() to run tests.
describe("Checkout conformance test factory", () => {
  it("exports conformance test function", () => {
    expect(typeof checkoutConformanceTests).toBe("function");
  });
});

/**
 * Conformance test suite for Checkout implementations
 *
 * Run these tests against any Checkout implementation to verify
 * it correctly implements the interface contract.
 */
export function checkoutConformanceTests(
  name: string,
  createCheckout: () => Promise<Checkout>,
  cleanup: () => Promise<void>,
) {
  describe(`${name} Checkout conformance`, () => {
    let checkout: Checkout;

    beforeEach(async () => {
      checkout = await createCheckout();
      await checkout.initialize();
    });

    afterEach(async () => {
      await checkout.close();
      await cleanup();
    });

    describe("HEAD management", () => {
      it("getHead returns initial HEAD value", async () => {
        const head = await checkout.getHead();
        expect(head).toBeDefined();
        expect(head.type).toMatch(/^(symbolic|detached)$/);
      });

      it("setHead with symbolic reference", async () => {
        const symbolicHead: HeadValue = {
          type: "symbolic",
          target: "refs/heads/feature",
        };

        await checkout.setHead(symbolicHead);

        const head = await checkout.getHead();
        expect(head.type).toBe("symbolic");
        if (head.type === "symbolic") {
          expect(head.target).toBe("refs/heads/feature");
        }
      });

      it("setHead with detached HEAD", async () => {
        const commitId = "a".repeat(40);
        const detachedHead: HeadValue = {
          type: "detached",
          commitId,
        };

        await checkout.setHead(detachedHead);

        const head = await checkout.getHead();
        expect(head.type).toBe("detached");
        if (head.type === "detached") {
          expect(head.commitId).toBe(commitId);
        }
      });

      it("getCurrentBranch returns branch name for symbolic HEAD", async () => {
        await checkout.setHead({
          type: "symbolic",
          target: "refs/heads/main",
        });

        const branch = await checkout.getCurrentBranch();
        expect(branch).toBe("main");
      });

      it("getCurrentBranch returns undefined for detached HEAD", async () => {
        await checkout.setHead({
          type: "detached",
          commitId: "b".repeat(40),
        });

        const branch = await checkout.getCurrentBranch();
        expect(branch).toBeUndefined();
      });

      it("isDetached returns correct value", async () => {
        await checkout.setHead({
          type: "symbolic",
          target: "refs/heads/main",
        });
        expect(await checkout.isDetached()).toBe(false);

        await checkout.setHead({
          type: "detached",
          commitId: "c".repeat(40),
        });
        expect(await checkout.isDetached()).toBe(true);
      });
    });

    describe("operation state", () => {
      it("hasOperationInProgress returns false when clean", async () => {
        expect(await checkout.hasOperationInProgress()).toBe(false);
      });

      it("getOperationState returns undefined when clean", async () => {
        const state = await checkout.getOperationState();
        expect(state).toBeUndefined();
      });

      it("getMergeState returns undefined when no merge", async () => {
        const state = await checkout.getMergeState();
        expect(state).toBeUndefined();
      });

      it("setMergeState and getMergeState round-trip", async () => {
        const mergeState = {
          mergeHead: "d".repeat(40),
          originalHead: "e".repeat(40),
          message: "Merge branch 'feature'",
        };

        await checkout.setMergeState(mergeState);

        const retrieved = await checkout.getMergeState();
        expect(retrieved).toBeDefined();
        expect(retrieved?.mergeHead).toBe(mergeState.mergeHead);

        expect(await checkout.hasOperationInProgress()).toBe(true);

        const opState = await checkout.getOperationState();
        expect(opState?.type).toBe("merge");
      });

      it("setMergeState with null clears merge state", async () => {
        await checkout.setMergeState({
          mergeHead: "f".repeat(40),
          originalHead: "g".repeat(40),
        });

        expect(await checkout.getMergeState()).toBeDefined();

        await checkout.setMergeState(null);

        expect(await checkout.getMergeState()).toBeUndefined();
        expect(await checkout.hasOperationInProgress()).toBe(false);
      });

      it("getRebaseState returns undefined when no rebase", async () => {
        const state = await checkout.getRebaseState();
        expect(state).toBeUndefined();
      });

      it("setRebaseState and getRebaseState round-trip", async () => {
        const rebaseState = {
          type: "merge" as const,
          onto: "h".repeat(40),
          originalHead: "i".repeat(40),
          originalBranch: "feature",
          currentCommit: "j".repeat(40),
          totalCommits: 3,
          currentIndex: 1,
          commits: ["k".repeat(40), "l".repeat(40), "m".repeat(40)],
        };

        await checkout.setRebaseState(rebaseState);

        const retrieved = await checkout.getRebaseState();
        expect(retrieved).toBeDefined();
        expect(retrieved?.onto).toBe(rebaseState.onto);

        expect(await checkout.hasOperationInProgress()).toBe(true);

        const opState = await checkout.getOperationState();
        expect(opState?.type).toBe("rebase");
      });

      it("getCherryPickState returns undefined when no cherry-pick", async () => {
        const state = await checkout.getCherryPickState();
        expect(state).toBeUndefined();
      });

      it("getRevertState returns undefined when no revert", async () => {
        const state = await checkout.getRevertState();
        expect(state).toBeUndefined();
      });

      it("abortOperation clears operation state", async () => {
        await checkout.setMergeState({
          mergeHead: "n".repeat(40),
          originalHead: "o".repeat(40),
        });

        expect(await checkout.hasOperationInProgress()).toBe(true);

        await checkout.abortOperation();

        expect(await checkout.hasOperationInProgress()).toBe(false);
      });
    });

    describe("lifecycle", () => {
      it("isInitialized returns true after initialize", async () => {
        expect(checkout.isInitialized()).toBe(true);
      });

      it("refresh does not throw", async () => {
        await expect(checkout.refresh()).resolves.not.toThrow();
      });
    });

    describe("staging access", () => {
      it("provides staging interface", () => {
        expect(checkout.staging).toBeDefined();
        expect(typeof checkout.staging.getEntryCount).toBe("function");
      });
    });
  });
}
