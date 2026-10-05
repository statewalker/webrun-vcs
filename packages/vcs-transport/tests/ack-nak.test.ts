/**
 * Tests for ACK/NAK parsing.
 * Ported from JGit's PacketLineInTest.java (ACK/NAK tests)
 */

import { bytesToHex, hexToBytes } from "@statewalker/vcs-utils/hash/utils";
import { describe, expect, it } from "vitest";
import { formatAck, formatNak, parseAckNak, parseAckNakV2 } from "../src/protocol/ack-nak.js";
import { PackProtocolError } from "../src/protocol/errors.js";
import type { AckNackResult } from "../src/protocol/types.js";

/** Type guard for ACK results that have objectId */
function hasObjectId(result: AckNackResult): result is Exclude<AckNackResult, { type: "NAK" }> {
  return result.type !== "NAK";
}

const TEST_ID = "fcfcfb1fd94829c1a1704f894fc111d14770d34e";

describe("parseAckNak", () => {
  describe("NAK", () => {
    it("should parse NAK", () => {
      const result = parseAckNak("NAK");
      expect(result.type).toBe("NAK");
    });
  });

  describe("ACK", () => {
    it("should parse simple ACK", () => {
      const result = parseAckNak(`ACK ${TEST_ID}`);
      expect(result.type).toBe("ACK");
      expect(hasObjectId(result) && bytesToHex(result.objectId)).toBe(TEST_ID);
    });

    it("should parse ACK continue", () => {
      const result = parseAckNak(`ACK ${TEST_ID} continue`);
      expect(result.type).toBe("ACK_CONTINUE");
      expect(hasObjectId(result) && bytesToHex(result.objectId)).toBe(TEST_ID);
    });

    it("should parse ACK common", () => {
      const result = parseAckNak(`ACK ${TEST_ID} common`);
      expect(result.type).toBe("ACK_COMMON");
      expect(hasObjectId(result) && bytesToHex(result.objectId)).toBe(TEST_ID);
    });

    it("should parse ACK ready", () => {
      const result = parseAckNak(`ACK ${TEST_ID} ready`);
      expect(result.type).toBe("ACK_READY");
      expect(hasObjectId(result) && bytesToHex(result.objectId)).toBe(TEST_ID);
    });
  });

  describe("invalid", () => {
    it("should reject invalid header HELO", () => {
      expect(() => parseAckNak("HELO")).toThrow(PackProtocolError);
      expect(() => parseAckNak("HELO")).toThrow("Expected ACK/NAK, got: HELO");
    });

    it("should reject unsupported ACK modifier", () => {
      expect(() => parseAckNak(`ACK ${TEST_ID} neverhappen`)).toThrow(PackProtocolError);
    });

    it("should reject short object ID", () => {
      expect(() => parseAckNak("ACK abcd")).toThrow(PackProtocolError);
    });
  });

  describe("ERR", () => {
    it("should throw on ERR message", () => {
      expect(() => parseAckNak("ERR want is not valid")).toThrow(PackProtocolError);
      expect(() => parseAckNak("ERR want is not valid")).toThrow("want is not valid");
    });
  });
});

describe("parseAckNakV2", () => {
  describe("NAK", () => {
    it("should parse NAK", () => {
      const result = parseAckNakV2("NAK");
      expect(result.type).toBe("NAK");
    });
  });

  describe("ACK", () => {
    it("should parse ACK as ACK_COMMON", () => {
      const result = parseAckNakV2(`ACK ${TEST_ID}`);
      expect(result.type).toBe("ACK_COMMON");
      expect(hasObjectId(result) && bytesToHex(result.objectId)).toBe(TEST_ID);
    });
  });

  describe("ready", () => {
    it("should parse ready as ACK_READY", () => {
      const result = parseAckNakV2("ready");
      expect(result.type).toBe("ACK_READY");
    });
  });

  describe("ERR", () => {
    it("should throw on ERR message", () => {
      expect(() => parseAckNakV2("ERR want is not valid")).toThrow("want is not valid");
    });
  });

  describe("invalid", () => {
    it("should reject invalid input", () => {
      expect(() => parseAckNakV2("HELO")).toThrow("Expected ACK/NAK");
    });
  });
});

describe("formatAck", () => {
  it("should format simple ACK", () => {
    const id = hexToBytes(TEST_ID);
    const result = formatAck(id);
    expect(result).toBe(`ACK ${TEST_ID}\n`);
  });

  it("should format ACK with modifier", () => {
    const id = hexToBytes(TEST_ID);
    expect(formatAck(id, "continue")).toBe(`ACK ${TEST_ID} continue\n`);
    expect(formatAck(id, "common")).toBe(`ACK ${TEST_ID} common\n`);
    expect(formatAck(id, "ready")).toBe(`ACK ${TEST_ID} ready\n`);
  });
});

describe("formatNak", () => {
  it("should format NAK", () => {
    expect(formatNak()).toBe("NAK\n");
  });
});
