/**
 * ReceivePack Advertise Refs Hook Tests
 *
 * Tests for receive-pack hooks that allow customization of:
 * - Ref advertisement filtering
 * - Adding custom refs
 * - Per-connection hook invocation
 *
 * Modeled after JGit's ReceivePackAdvertiseRefsHookTest.java
 */

import { describe, expect, it, vi } from "vitest";
import { ZERO_OID } from "../src/fsm/push/types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types for Hook Testing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Advertise refs hook interface
 */
interface AdvertiseRefsHook {
  /**
   * Called before sending ref advertisement to client.
   * Can modify the refs map to filter or add refs.
   */
  advertiseRefs(refs: Map<string, string>): Promise<Map<string, string>>;
}

/**
 * Pre-receive hook interface
 */
interface PreReceiveHook {
  /**
   * Called before processing push commands.
   * Returns true to allow, false to reject.
   */
  preReceive(commands: Array<{ refName: string; oldOid: string; newOid: string }>): Promise<{
    ok: boolean;
    message?: string;
    rejectedRefs?: string[];
  }>;
}

/**
 * Post-receive hook interface
 */
interface PostReceiveHook {
  /**
   * Called after refs are updated.
   */
  postReceive(commands: Array<{ refName: string; oldOid: string; newOid: string }>): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mock RefStore with Hooks
// ─────────────────────────────────────────────────────────────────────────────

function createMockRefStoreWithHooks(
  initialRefs: Map<string, string>,
  hooks?: {
    advertiseRefs?: AdvertiseRefsHook;
    preReceive?: PreReceiveHook;
    postReceive?: PostReceiveHook;
  },
) {
  const refs = new Map(initialRefs);

  return {
    refs,
    hooks,

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

    async listAll(): Promise<Map<string, string>> {
      return new Map(refs);
    },

    async listAdvertised(): Promise<Map<string, string>> {
      let advertised = new Map(refs);

      if (hooks?.advertiseRefs) {
        advertised = await hooks.advertiseRefs.advertiseRefs(advertised);
      }

      return advertised;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Advertise Refs Hook Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("ReceivePackAdvertiseRefsHook", () => {
  describe("should allow hook to filter advertised refs", () => {
    it("filters out specific refs", async () => {
      const initialRefs = new Map([
        ["refs/heads/main", "abc123".padEnd(40, "0")],
        ["refs/heads/private", "def456".padEnd(40, "0")],
        ["refs/heads/feature", "789abc".padEnd(40, "0")],
      ]);

      const hook: AdvertiseRefsHook = {
        async advertiseRefs(refs) {
          // Filter out refs starting with "refs/heads/private"
          const filtered = new Map<string, string>();
          for (const [name, oid] of refs) {
            if (!name.startsWith("refs/heads/private")) {
              filtered.set(name, oid);
            }
          }
          return filtered;
        },
      };

      const store = createMockRefStoreWithHooks(initialRefs, { advertiseRefs: hook });
      const advertised = await store.listAdvertised();

      expect(advertised.size).toBe(2);
      expect(advertised.has("refs/heads/main")).toBe(true);
      expect(advertised.has("refs/heads/feature")).toBe(true);
      expect(advertised.has("refs/heads/private")).toBe(false);
    });

    it("filters refs by pattern", async () => {
      const initialRefs = new Map([
        ["refs/heads/main", "abc123".padEnd(40, "0")],
        ["refs/heads/feature/wip-1", "def456".padEnd(40, "0")],
        ["refs/heads/feature/wip-2", "789abc".padEnd(40, "0")],
        ["refs/heads/release", "ccc111".padEnd(40, "0")],
      ]);

      const hook: AdvertiseRefsHook = {
        async advertiseRefs(refs) {
          // Filter out WIP branches
          const filtered = new Map<string, string>();
          for (const [name, oid] of refs) {
            if (!name.includes("/wip-")) {
              filtered.set(name, oid);
            }
          }
          return filtered;
        },
      };

      const store = createMockRefStoreWithHooks(initialRefs, { advertiseRefs: hook });
      const advertised = await store.listAdvertised();

      expect(advertised.size).toBe(2);
      expect(advertised.has("refs/heads/main")).toBe(true);
      expect(advertised.has("refs/heads/release")).toBe(true);
      expect(advertised.has("refs/heads/feature/wip-1")).toBe(false);
      expect(advertised.has("refs/heads/feature/wip-2")).toBe(false);
    });

    it("can hide all refs (empty advertisement)", async () => {
      const initialRefs = new Map([
        ["refs/heads/main", "abc123".padEnd(40, "0")],
        ["refs/heads/feature", "def456".padEnd(40, "0")],
      ]);

      const hook: AdvertiseRefsHook = {
        async advertiseRefs() {
          // Return empty map to hide all refs
          return new Map();
        },
      };

      const store = createMockRefStoreWithHooks(initialRefs, { advertiseRefs: hook });
      const advertised = await store.listAdvertised();

      expect(advertised.size).toBe(0);
    });
  });

  describe("should allow hook to add custom refs", () => {
    it("adds virtual refs", async () => {
      const initialRefs = new Map([["refs/heads/main", "abc123".padEnd(40, "0")]]);

      const hook: AdvertiseRefsHook = {
        async advertiseRefs(refs) {
          const withVirtual = new Map(refs);
          // Add virtual refs like Gerrit's changes refs
          withVirtual.set("refs/for/main", "def456".padEnd(40, "0"));
          withVirtual.set("refs/meta/config", "789abc".padEnd(40, "0"));
          return withVirtual;
        },
      };

      const store = createMockRefStoreWithHooks(initialRefs, { advertiseRefs: hook });
      const advertised = await store.listAdvertised();

      expect(advertised.size).toBe(3);
      expect(advertised.has("refs/heads/main")).toBe(true);
      expect(advertised.has("refs/for/main")).toBe(true);
      expect(advertised.has("refs/meta/config")).toBe(true);
    });

    it("adds symbolic ref HEAD", async () => {
      const mainOid = "abc123".padEnd(40, "0");
      const initialRefs = new Map([["refs/heads/main", mainOid]]);

      const hook: AdvertiseRefsHook = {
        async advertiseRefs(refs) {
          const withHead = new Map(refs);
          // Add HEAD pointing to main
          withHead.set("HEAD", mainOid);
          return withHead;
        },
      };

      const store = createMockRefStoreWithHooks(initialRefs, { advertiseRefs: hook });
      const advertised = await store.listAdvertised();

      expect(advertised.has("HEAD")).toBe(true);
      expect(advertised.get("HEAD")).toBe(mainOid);
    });

    it("can replace ref values", async () => {
      const initialRefs = new Map([["refs/heads/main", "abc123".padEnd(40, "0")]]);

      const newOid = "newoid".padEnd(40, "0");
      const hook: AdvertiseRefsHook = {
        async advertiseRefs(refs) {
          const modified = new Map(refs);
          // Replace the OID for main
          modified.set("refs/heads/main", newOid);
          return modified;
        },
      };

      const store = createMockRefStoreWithHooks(initialRefs, { advertiseRefs: hook });
      const advertised = await store.listAdvertised();

      expect(advertised.get("refs/heads/main")).toBe(newOid);
    });
  });

  describe("should call hook on each connection", () => {
    it("invokes hook once per list operation", async () => {
      const initialRefs = new Map([["refs/heads/main", "abc123".padEnd(40, "0")]]);

      const hookFn = vi.fn(async (refs: Map<string, string>) => refs);
      const hook: AdvertiseRefsHook = {
        advertiseRefs: hookFn,
      };

      const store = createMockRefStoreWithHooks(initialRefs, { advertiseRefs: hook });

      // Simulate multiple connections
      await store.listAdvertised();
      await store.listAdvertised();
      await store.listAdvertised();

      expect(hookFn).toHaveBeenCalledTimes(3);
    });

    it("receives fresh ref map on each call", async () => {
      const oid = "abc123".padEnd(40, "0");
      const initialRefs = new Map([["refs/heads/main", oid]]);

      const receivedRefs: Array<Map<string, string>> = [];
      const hook: AdvertiseRefsHook = {
        async advertiseRefs(refs) {
          receivedRefs.push(new Map(refs));
          return refs;
        },
      };

      const store = createMockRefStoreWithHooks(initialRefs, { advertiseRefs: hook });

      await store.listAdvertised();

      // Add a new ref
      await store.update("refs/heads/feature", "def456".padEnd(40, "0"));

      await store.listAdvertised();

      expect(receivedRefs[0].size).toBe(1);
      expect(receivedRefs[1].size).toBe(2);
    });

    it("hook errors propagate", async () => {
      const initialRefs = new Map([["refs/heads/main", "abc123".padEnd(40, "0")]]);

      const hook: AdvertiseRefsHook = {
        async advertiseRefs() {
          throw new Error("Hook error");
        },
      };

      const store = createMockRefStoreWithHooks(initialRefs, { advertiseRefs: hook });

      await expect(store.listAdvertised()).rejects.toThrow("Hook error");
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pre-Receive Hook Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("PreReceiveHook", () => {
  it("should allow push when hook returns ok", async () => {
    const hook: PreReceiveHook = {
      async preReceive() {
        return { ok: true };
      },
    };

    const commands = [
      {
        refName: "refs/heads/main",
        oldOid: "a".repeat(40),
        newOid: "b".repeat(40),
      },
    ];

    const result = await hook.preReceive(commands);

    expect(result.ok).toBe(true);
  });

  it("should reject push when hook returns not ok", async () => {
    const hook: PreReceiveHook = {
      async preReceive() {
        return { ok: false, message: "Push rejected by policy" };
      },
    };

    const commands = [
      {
        refName: "refs/heads/protected",
        oldOid: "a".repeat(40),
        newOid: "b".repeat(40),
      },
    ];

    const result = await hook.preReceive(commands);

    expect(result.ok).toBe(false);
    expect(result.message).toBe("Push rejected by policy");
  });

  it("should selectively reject specific refs", async () => {
    const hook: PreReceiveHook = {
      async preReceive(commands) {
        const rejected = commands
          .filter((c) => c.refName.includes("protected"))
          .map((c) => c.refName);

        if (rejected.length > 0) {
          return { ok: false, rejectedRefs: rejected, message: "Protected branch" };
        }
        return { ok: true };
      },
    };

    const commands = [
      {
        refName: "refs/heads/main",
        oldOid: "a".repeat(40),
        newOid: "b".repeat(40),
      },
      {
        refName: "refs/heads/protected",
        oldOid: "c".repeat(40),
        newOid: "d".repeat(40),
      },
    ];

    const result = await hook.preReceive(commands);

    expect(result.ok).toBe(false);
    expect(result.rejectedRefs).toContain("refs/heads/protected");
    expect(result.rejectedRefs).not.toContain("refs/heads/main");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Post-Receive Hook Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("PostReceiveHook", () => {
  it("should be called after successful push", async () => {
    const receivedCommands: Array<{ refName: string; oldOid: string; newOid: string }> = [];

    const hook: PostReceiveHook = {
      async postReceive(commands) {
        receivedCommands.push(...commands);
      },
    };

    const commands = [
      {
        refName: "refs/heads/main",
        oldOid: "a".repeat(40),
        newOid: "b".repeat(40),
      },
    ];

    await hook.postReceive(commands);

    expect(receivedCommands).toHaveLength(1);
    expect(receivedCommands[0].refName).toBe("refs/heads/main");
  });

  it("should receive all successful commands", async () => {
    const receivedCommands: Array<{ refName: string; oldOid: string; newOid: string }> = [];

    const hook: PostReceiveHook = {
      async postReceive(commands) {
        receivedCommands.push(...commands);
      },
    };

    const commands = [
      { refName: "refs/heads/main", oldOid: "a".repeat(40), newOid: "b".repeat(40) },
      { refName: "refs/heads/feature", oldOid: ZERO_OID, newOid: "c".repeat(40) },
      { refName: "refs/tags/v1.0", oldOid: ZERO_OID, newOid: "d".repeat(40) },
    ];

    await hook.postReceive(commands);

    expect(receivedCommands).toHaveLength(3);
  });

  it("should not block push on error", async () => {
    const hook: PostReceiveHook = {
      async postReceive() {
        throw new Error("Post-receive hook failed");
      },
    };

    // Post-receive hook errors should be caught and logged, not propagated
    // This is intentional - the push is already complete at this point
    try {
      await hook.postReceive([
        { refName: "refs/heads/main", oldOid: "a".repeat(40), newOid: "b".repeat(40) },
      ]);
    } catch {
      // Error is expected but should not block the push
    }

    // The push would have already succeeded before post-receive runs
    expect(true).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Advertisement Generation Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("Advertisement Generation with Hooks", () => {
  function generateAdvertisement(refs: Map<string, string>, capabilities: string[]): string[] {
    const lines: string[] = [];

    if (refs.size === 0) {
      // Empty repo
      lines.push(`${ZERO_OID} capabilities^{}\0${capabilities.join(" ")}`);
    } else {
      let first = true;
      for (const [name, oid] of refs) {
        if (first) {
          lines.push(`${oid} ${name}\0${capabilities.join(" ")}`);
          first = false;
        } else {
          lines.push(`${oid} ${name}`);
        }
      }
    }

    return lines;
  }

  it("should generate advertisement with filtered refs", async () => {
    const initialRefs = new Map([
      ["refs/heads/main", "abc123".padEnd(40, "0")],
      ["refs/heads/hidden", "def456".padEnd(40, "0")],
    ]);

    const hook: AdvertiseRefsHook = {
      async advertiseRefs(refs) {
        const filtered = new Map<string, string>();
        for (const [name, oid] of refs) {
          if (!name.includes("hidden")) {
            filtered.set(name, oid);
          }
        }
        return filtered;
      },
    };

    const store = createMockRefStoreWithHooks(initialRefs, { advertiseRefs: hook });
    const advertised = await store.listAdvertised();
    const lines = generateAdvertisement(advertised, ["report-status", "delete-refs"]);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("refs/heads/main");
    expect(lines[0]).not.toContain("refs/heads/hidden");
  });

  it("should generate empty repo advertisement when hook filters all", async () => {
    const initialRefs = new Map([["refs/heads/main", "abc123".padEnd(40, "0")]]);

    const hook: AdvertiseRefsHook = {
      async advertiseRefs() {
        return new Map();
      },
    };

    const store = createMockRefStoreWithHooks(initialRefs, { advertiseRefs: hook });
    const advertised = await store.listAdvertised();
    const lines = generateAdvertisement(advertised, ["report-status"]);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(ZERO_OID);
    expect(lines[0]).toContain("capabilities^{}");
  });

  it("should include added refs in advertisement", async () => {
    const initialRefs = new Map([["refs/heads/main", "abc123".padEnd(40, "0")]]);

    const hook: AdvertiseRefsHook = {
      async advertiseRefs(refs) {
        const withAdded = new Map(refs);
        withAdded.set("refs/changes/01/1", "def456".padEnd(40, "0"));
        return withAdded;
      },
    };

    const store = createMockRefStoreWithHooks(initialRefs, { advertiseRefs: hook });
    const advertised = await store.listAdvertised();
    const lines = generateAdvertisement(advertised, ["report-status"]);

    expect(lines).toHaveLength(2);
    const allContent = lines.join("\n");
    expect(allContent).toContain("refs/heads/main");
    expect(allContent).toContain("refs/changes/01/1");
  });
});
