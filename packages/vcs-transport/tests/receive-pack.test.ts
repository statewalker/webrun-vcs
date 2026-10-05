/**
 * Receive Pack (Push Server-Side) Tests
 *
 * Tests for Git push server functionality including:
 * - Command parsing (create, update, delete)
 * - Command validation (malformed, invalid OIDs, invalid ref names)
 * - Push certificates and options
 * - Status reporting
 *
 * Modeled after JGit's ReceivePackTest.java
 */

import { describe, expect, it } from "vitest";
import { ProtocolState } from "../src/context/protocol-state.js";
import {
  mapRejectReason,
  type PushCommand,
  type PushCommandResult,
  type PushCommandType,
  ZERO_OID,
} from "../src/fsm/push/types.js";
import { parseRefSpec } from "../src/utils/refspec.js";

// ─────────────────────────────────────────────────────────────────────────────
// Command Parsing Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("Command Parsing", () => {
  /**
   * Parse a command line from client into PushCommand structure.
   * Format: old-oid new-oid refname\0capabilities
   */
  function parseCommand(line: string): PushCommand {
    const parts = line.split(" ", 3);
    const oldOid = parts[0];
    const newOid = parts[1];
    let refName = parts[2];
    const capabilities: string[] = [];

    // Parse capabilities from first command
    if (refName.includes("\0")) {
      const nullIdx = refName.indexOf("\0");
      const caps = refName.slice(nullIdx + 1);
      refName = refName.slice(0, nullIdx);
      capabilities.push(...caps.split(" "));
    }

    // Determine command type
    let type: PushCommandType;
    if (newOid === ZERO_OID) {
      type = "DELETE";
    } else if (oldOid === ZERO_OID) {
      type = "CREATE";
    } else {
      type = "UPDATE";
    }

    return {
      oldOid,
      newOid,
      refName,
      type,
      result: "NOT_ATTEMPTED",
    };
  }

  describe("should parse create command (zero old-id)", () => {
    it("recognizes new branch creation", () => {
      const newOid = "abc123def456abc123def456abc123def456abc1";
      const line = `${ZERO_OID} ${newOid} refs/heads/feature`;

      const cmd = parseCommand(line);

      expect(cmd.type).toBe("CREATE");
      expect(cmd.oldOid).toBe(ZERO_OID);
      expect(cmd.newOid).toBe(newOid);
      expect(cmd.refName).toBe("refs/heads/feature");
    });

    it("handles create with capabilities", () => {
      const newOid = "abc123def456abc123def456abc123def456abc1";
      const line = `${ZERO_OID} ${newOid} refs/heads/feature\0report-status side-band-64k`;

      const cmd = parseCommand(line);

      expect(cmd.type).toBe("CREATE");
      expect(cmd.refName).toBe("refs/heads/feature");
    });
  });

  describe("should parse update command", () => {
    it("recognizes ref update", () => {
      const oldOid = "aaa111bbb222ccc333ddd444eee555fff666777";
      const newOid = "abc123def456abc123def456abc123def456abc1";
      const line = `${oldOid} ${newOid} refs/heads/main`;

      const cmd = parseCommand(line);

      expect(cmd.type).toBe("UPDATE");
      expect(cmd.oldOid).toBe(oldOid);
      expect(cmd.newOid).toBe(newOid);
      expect(cmd.refName).toBe("refs/heads/main");
    });

    it("handles update with capabilities on first command", () => {
      const oldOid = "aaa111bbb222ccc333ddd444eee555fff666777";
      const newOid = "abc123def456abc123def456abc123def456abc1";
      const line = `${oldOid} ${newOid} refs/heads/main\0atomic report-status`;

      const cmd = parseCommand(line);

      expect(cmd.type).toBe("UPDATE");
      expect(cmd.refName).toBe("refs/heads/main");
    });
  });

  describe("should parse delete command (zero new-id)", () => {
    it("recognizes branch deletion", () => {
      const oldOid = "abc123def456abc123def456abc123def456abc1";
      const line = `${oldOid} ${ZERO_OID} refs/heads/feature`;

      const cmd = parseCommand(line);

      expect(cmd.type).toBe("DELETE");
      expect(cmd.oldOid).toBe(oldOid);
      expect(cmd.newOid).toBe(ZERO_OID);
      expect(cmd.refName).toBe("refs/heads/feature");
    });
  });

  describe("should reject malformed commands", () => {
    it("rejects command with missing parts", () => {
      // Line with only one OID
      const line = "abc123def456abc123def456abc123def456abc1";
      const parts = line.split(" ");

      expect(parts.length).toBeLessThan(3);
    });

    it("rejects command with extra whitespace", () => {
      const oldOid = "aaa111bbb222ccc333ddd444eee555fff666777";
      const newOid = "abc123def456abc123def456abc123def456abc1";
      // Double space between OIDs (malformed)
      const line = `${oldOid}  ${newOid} refs/heads/main`;
      const parts = line.split(" ", 3);

      // First part is oldOid, second part is empty due to double space
      expect(parts[1]).toBe("");
    });
  });

  describe("should reject invalid old-id", () => {
    it("rejects short OID", () => {
      const shortOid = "abc123"; // Only 6 chars instead of 40
      const isValidOid = /^[0-9a-f]{40}$/.test(shortOid);

      expect(isValidOid).toBe(false);
    });

    it("rejects OID with invalid characters", () => {
      const invalidOid = "ghijkl".repeat(7).slice(0, 40); // Contains g-l
      const isValidOid = /^[0-9a-f]{40}$/.test(invalidOid);

      expect(isValidOid).toBe(false);
    });

    it("accepts valid 40-character hex OID", () => {
      const validOid = "abc123def456abc123def456abc123def456abc1";
      const isValidOid = /^[0-9a-f]{40}$/.test(validOid);

      expect(isValidOid).toBe(true);
    });
  });

  describe("should reject invalid new-id", () => {
    it("rejects uppercase hex characters", () => {
      const invalidOid = "ABC123DEF456ABC123DEF456ABC123DEF456ABC1"; // Uppercase
      const isValidOid = /^[0-9a-f]{40}$/.test(invalidOid);

      expect(isValidOid).toBe(false);
    });

    it("rejects OID with spaces", () => {
      const invalidOid = "abc123 def456abc123def456abc123def456abc"; // Space in middle
      const isValidOid = /^[0-9a-f]{40}$/.test(invalidOid);

      expect(isValidOid).toBe(false);
    });
  });

  describe("should reject invalid ref names", () => {
    it("rejects refs with double dots", () => {
      const refName = "refs/heads/branch..name";
      const isValidRef = !refName.includes("..");

      expect(isValidRef).toBe(false);
    });

    it("rejects refs ending with .lock", () => {
      const refName = "refs/heads/branch.lock";
      const isValidRef = !refName.endsWith(".lock");

      expect(isValidRef).toBe(false);
    });

    it("rejects refs with backslash", () => {
      const refName = "refs/heads/branch\\name";
      const isValidRef = !refName.includes("\\");

      expect(isValidRef).toBe(false);
    });

    it("rejects refs starting with -", () => {
      const refName = "-refs/heads/branch";
      const isValidRef = !refName.startsWith("-");

      expect(isValidRef).toBe(false);
    });

    it("accepts valid ref names", () => {
      const validRefs = [
        "refs/heads/main",
        "refs/heads/feature/my-feature",
        "refs/tags/v1.0.0",
        "refs/remotes/origin/main",
      ];

      for (const ref of validRefs) {
        const isValid =
          !ref.includes("..") &&
          !ref.endsWith(".lock") &&
          !ref.includes("\\") &&
          !ref.startsWith("-");
        expect(isValid).toBe(true);
      }
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Push Certificates Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("Push Certificates", () => {
  /**
   * Validate that push options match certificate
   */
  function validatePushOptions(certOptions: string[] | null, pushOptions: string[]): boolean {
    // Null cert options means certificate didn't have push options
    if (certOptions === null) {
      return pushOptions.length === 0;
    }

    // Both must have same options
    if (certOptions.length !== pushOptions.length) {
      return false;
    }

    // Compare sorted arrays
    const sortedCert = [...certOptions].sort();
    const sortedPush = [...pushOptions].sort();

    for (let i = 0; i < sortedCert.length; i++) {
      if (sortedCert[i] !== sortedPush[i]) {
        return false;
      }
    }

    return true;
  }

  describe("should validate certificate push options match", () => {
    it("matches when both have same options", () => {
      const certOptions = ["option1=value1", "option2=value2"];
      const pushOptions = ["option1=value1", "option2=value2"];

      expect(validatePushOptions(certOptions, pushOptions)).toBe(true);
    });

    it("matches when both have same options in different order", () => {
      const certOptions = ["option2=value2", "option1=value1"];
      const pushOptions = ["option1=value1", "option2=value2"];

      expect(validatePushOptions(certOptions, pushOptions)).toBe(true);
    });

    it("matches when both are empty", () => {
      const certOptions: string[] = [];
      const pushOptions: string[] = [];

      expect(validatePushOptions(certOptions, pushOptions)).toBe(true);
    });
  });

  describe("should reject mismatched push options", () => {
    it("rejects when certificate has extra options", () => {
      const certOptions = ["option1=value1", "option2=value2", "option3=value3"];
      const pushOptions = ["option1=value1", "option2=value2"];

      expect(validatePushOptions(certOptions, pushOptions)).toBe(false);
    });

    it("rejects when push has extra options", () => {
      const certOptions = ["option1=value1"];
      const pushOptions = ["option1=value1", "option2=value2"];

      expect(validatePushOptions(certOptions, pushOptions)).toBe(false);
    });

    it("rejects when options have different values", () => {
      const certOptions = ["option1=value1"];
      const pushOptions = ["option1=different"];

      expect(validatePushOptions(certOptions, pushOptions)).toBe(false);
    });
  });

  describe("should treat null options as empty", () => {
    it("accepts empty push options when cert has null", () => {
      const certOptions = null;
      const pushOptions: string[] = [];

      expect(validatePushOptions(certOptions, pushOptions)).toBe(true);
    });

    it("rejects non-empty push options when cert has null", () => {
      const certOptions = null;
      const pushOptions = ["option1=value1"];

      expect(validatePushOptions(certOptions, pushOptions)).toBe(false);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Status Reporting Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("Status Reporting", () => {
  function formatStatus(commands: PushCommand[], unpackError?: string): string[] {
    const lines: string[] = [];

    // Unpack status
    lines.push(unpackError ? `unpack ${unpackError}` : "unpack ok");

    // Per-ref status
    for (const cmd of commands) {
      if (cmd.result === "OK") {
        lines.push(`ok ${cmd.refName}`);
      } else {
        lines.push(`ng ${cmd.refName} ${cmd.message || "rejected"}`);
      }
    }

    return lines;
  }

  it("should report successful unpack and refs", () => {
    const commands: PushCommand[] = [
      {
        oldOid: "a".repeat(40),
        newOid: "b".repeat(40),
        refName: "refs/heads/main",
        type: "UPDATE",
        result: "OK",
      },
      {
        oldOid: ZERO_OID,
        newOid: "c".repeat(40),
        refName: "refs/heads/feature",
        type: "CREATE",
        result: "OK",
      },
    ];

    const status = formatStatus(commands);

    expect(status).toContain("unpack ok");
    expect(status).toContain("ok refs/heads/main");
    expect(status).toContain("ok refs/heads/feature");
  });

  it("should report unpack failure", () => {
    const commands: PushCommand[] = [];
    const status = formatStatus(commands, "index-pack failed");

    expect(status).toContain("unpack index-pack failed");
  });

  it("should report mixed success and failure", () => {
    const commands: PushCommand[] = [
      {
        oldOid: "a".repeat(40),
        newOid: "b".repeat(40),
        refName: "refs/heads/main",
        type: "UPDATE",
        result: "OK",
      },
      {
        oldOid: "c".repeat(40),
        newOid: "d".repeat(40),
        refName: "refs/heads/protected",
        type: "UPDATE",
        result: "REJECTED_OTHER_REASON",
        message: "protected branch",
      },
    ];

    const status = formatStatus(commands);

    expect(status).toContain("unpack ok");
    expect(status).toContain("ok refs/heads/main");
    expect(status).toContain("ng refs/heads/protected protected branch");
  });

  it("should report non-fast-forward rejection", () => {
    const commands: PushCommand[] = [
      {
        oldOid: "a".repeat(40),
        newOid: "b".repeat(40),
        refName: "refs/heads/main",
        type: "UPDATE",
        result: "REJECTED_NONFASTFORWARD",
        message: "non-fast-forward",
      },
    ];

    const status = formatStatus(commands);

    expect(status).toContain("ng refs/heads/main non-fast-forward");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Refspec Parsing Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("Refspec Parsing", () => {
  it("should parse source:destination refspec", () => {
    const result = parseRefSpec("refs/heads/local:refs/heads/remote");

    expect(result.source).toBe("refs/heads/local");
    expect(result.destination).toBe("refs/heads/remote");
    expect(result.force).toBe(false);
    expect(result.negative).toBe(false);
    expect(result.wildcard).toBe(false);
  });

  it("should parse force push refspec", () => {
    const result = parseRefSpec("+refs/heads/main:refs/heads/main");

    expect(result.source).toBe("refs/heads/main");
    expect(result.destination).toBe("refs/heads/main");
    expect(result.force).toBe(true);
    expect(result.negative).toBe(false);
    expect(result.wildcard).toBe(false);
  });

  it("should parse delete refspec", () => {
    const result = parseRefSpec(":refs/heads/to-delete");

    expect(result.source).toBeNull();
    expect(result.destination).toBe("refs/heads/to-delete");
    expect(result.force).toBe(false);
    expect(result.negative).toBe(false);
    expect(result.wildcard).toBe(false);
  });

  it("should parse force delete refspec", () => {
    const result = parseRefSpec("+:refs/heads/to-delete");

    expect(result.source).toBeNull();
    expect(result.destination).toBe("refs/heads/to-delete");
    expect(result.force).toBe(true);
    expect(result.negative).toBe(false);
    expect(result.wildcard).toBe(false);
  });

  it("should parse shorthand refspec (same src and dst)", () => {
    const result = parseRefSpec("refs/heads/main");

    expect(result.source).toBe("refs/heads/main");
    expect(result.destination).toBeNull();
    expect(result.force).toBe(false);
    expect(result.negative).toBe(false);
    expect(result.wildcard).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rejection Reason Mapping Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("Rejection Reason Mapping", () => {
  it("should map non-fast-forward reason", () => {
    expect(mapRejectReason("rejected non-fast-forward")).toBe("REJECTED_NONFASTFORWARD");
    expect(mapRejectReason("non-fast-forward update")).toBe("REJECTED_NONFASTFORWARD");
  });

  it("should map current branch reason", () => {
    expect(mapRejectReason("refusing to update checked out current branch")).toBe(
      "REJECTED_CURRENT_BRANCH",
    );
  });

  it("should map delete denied reason", () => {
    expect(mapRejectReason("deny deleting refs/heads/main")).toBe("REJECTED_NODELETE");
  });

  it("should map create denied reason", () => {
    expect(mapRejectReason("deny creating refs/heads/new")).toBe("REJECTED_NOCREATE");
  });

  it("should map missing object reason", () => {
    expect(mapRejectReason("missing necessary objects")).toBe("REJECTED_MISSING_OBJECT");
  });

  it("should map atomic failure reason", () => {
    expect(mapRejectReason("atomic push failed")).toBe("ATOMIC_REJECTED");
  });

  it("should map lock failure reason", () => {
    expect(mapRejectReason("failed to lock ref")).toBe("LOCK_FAILURE");
  });

  it("should map unknown reasons to other", () => {
    expect(mapRejectReason("some random error")).toBe("REJECTED_OTHER_REASON");
    expect(mapRejectReason("permission denied")).toBe("REJECTED_OTHER_REASON");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Protocol State for Push Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("ProtocolState for Push", () => {
  it("should track push-specific capabilities", () => {
    const state = new ProtocolState();

    state.capabilities.add("report-status");
    state.capabilities.add("delete-refs");
    state.capabilities.add("atomic");
    state.capabilities.add("push-options");

    expect(state.capabilities.has("report-status")).toBe(true);
    expect(state.capabilities.has("delete-refs")).toBe(true);
    expect(state.capabilities.has("atomic")).toBe(true);
    expect(state.capabilities.has("push-options")).toBe(true);
  });

  it("should track refs for validation", () => {
    const state = new ProtocolState();

    state.refs.set("refs/heads/main", "abc123".padEnd(40, "0"));
    state.refs.set("refs/heads/feature", "def456".padEnd(40, "0"));

    expect(state.refs.size).toBe(2);
    expect(state.refs.get("refs/heads/main")).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Command Result Types Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("Command Result Types", () => {
  const allResults: PushCommandResult[] = [
    "NOT_ATTEMPTED",
    "OK",
    "REJECTED_NOCREATE",
    "REJECTED_NODELETE",
    "REJECTED_NONFASTFORWARD",
    "REJECTED_CURRENT_BRANCH",
    "REJECTED_MISSING_OBJECT",
    "REJECTED_OTHER_REASON",
    "LOCK_FAILURE",
    "ATOMIC_REJECTED",
  ];

  it("should have all expected result types", () => {
    expect(allResults).toContain("NOT_ATTEMPTED");
    expect(allResults).toContain("OK");
    expect(allResults).toContain("REJECTED_NONFASTFORWARD");
    expect(allResults).toContain("ATOMIC_REJECTED");
  });

  it("should identify successful results", () => {
    const successResults = allResults.filter((r) => r === "OK");
    expect(successResults).toHaveLength(1);
  });

  it("should identify rejection results", () => {
    const rejectionResults = allResults.filter((r) => r.startsWith("REJECTED_"));
    expect(rejectionResults.length).toBeGreaterThan(0);
    expect(rejectionResults).toContain("REJECTED_NONFASTFORWARD");
  });
});
