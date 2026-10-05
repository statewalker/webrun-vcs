/**
 * Tests for pkt-line codec.
 * Ported from JGit's PacketLineInTest.java and PacketLineOutTest.java
 *
 * Note: test vectors created with:
 * perl -e 'printf "%4.4x%s\n", 4+length($ARGV[0]),$ARGV[0]'
 */

import { describe, expect, it } from "vitest";
import { PacketLineError } from "../src/protocol/errors.js";
import {
  dataPacket,
  delimPacket,
  encodeDelim,
  encodeFlush,
  encodePacket,
  encodePacketLine,
  flushPacket,
  isDelimiter,
  isEnd,
  PKT_DELIM,
  PKT_FLUSH,
  packetDataToString,
  packetDataToStringRaw,
  parsePacket,
  pktLineReader,
  pktLineWriter,
} from "../src/protocol/pkt-line-codec.js";
import type { Packet } from "../src/protocol/types.js";

// Helper to create async iterable from string
async function* stringToStream(s: string): AsyncGenerator<Uint8Array> {
  yield new TextEncoder().encode(s);
}

// Helper to collect packets from reader
async function collectPackets(stream: AsyncIterable<Packet>): Promise<Packet[]> {
  const result: Packet[] = [];
  for await (const packet of stream) {
    result.push(packet);
  }
  return result;
}

// Helper to collect bytes from writer
async function collectBytes(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(result);
}

describe("PacketLineIn (Reader)", () => {
  describe("readString", () => {
    it("should read simple strings", async () => {
      const packets = await collectPackets(pktLineReader(stringToStream("0006a\n0007bc\n")));
      expect(packets).toHaveLength(2);
      expect(packetDataToString(packets[0])).toBe("a");
      expect(packetDataToString(packets[1])).toBe("bc");
    });

    it("should read want line", async () => {
      const packets = await collectPackets(
        pktLineReader(stringToStream("0032want fcfcfb1fd94829c1a1704f894fc111d14770d34e\n")),
      );
      expect(packets).toHaveLength(1);
      expect(packetDataToString(packets[0])).toBe("want fcfcfb1fd94829c1a1704f894fc111d14770d34e");
    });

    it("should read strings without newline", async () => {
      const packets = await collectPackets(pktLineReader(stringToStream("0005a0006bc")));
      expect(packets).toHaveLength(2);
      expect(packetDataToString(packets[0])).toBe("a");
      expect(packetDataToString(packets[1])).toBe("bc");
    });

    it("should accept both upper and lower case hex", async () => {
      // Upper case
      let packets = await collectPackets(pktLineReader(stringToStream("000Fhi i am a s")));
      expect(packetDataToString(packets[0])).toBe("hi i am a s");

      // Lower case
      packets = await collectPackets(pktLineReader(stringToStream("000fhi i am a s")));
      expect(packetDataToString(packets[0])).toBe("hi i am a s");
    });

    it("should reject invalid header HELO", async () => {
      await expect(collectPackets(pktLineReader(stringToStream("HELO")))).rejects.toThrow(
        PacketLineError,
      );
      await expect(collectPackets(pktLineReader(stringToStream("HELO")))).rejects.toThrow(
        "Invalid packet line header: HELO",
      );
    });

    it("should reject length 0002", async () => {
      await expect(collectPackets(pktLineReader(stringToStream("0002")))).rejects.toThrow(
        "Invalid packet line header: 0002",
      );
    });

    it("should reject length 0003", async () => {
      await expect(collectPackets(pktLineReader(stringToStream("0003")))).rejects.toThrow(
        "Invalid packet line header: 0003",
      );
    });

    it("should accept length 0004 as empty packet", async () => {
      const packets = await collectPackets(pktLineReader(stringToStream("0004")));
      expect(packets).toHaveLength(1);
      expect(packets[0].type).toBe("data");
      expect(packetDataToString(packets[0])).toBe("");
      expect(isEnd(packetDataToString(packets[0]))).toBe(false);
      expect(isDelimiter(packetDataToString(packets[0]))).toBe(false);
    });

    it("should recognize flush packet (0000)", async () => {
      const packets = await collectPackets(pktLineReader(stringToStream("0000")));
      expect(packets).toHaveLength(1);
      expect(packets[0].type).toBe("flush");
      expect(isEnd(PKT_FLUSH)).toBe(true);
      expect(isDelimiter(PKT_FLUSH)).toBe(false);
    });

    it("should recognize delimiter packet (0001)", async () => {
      const packets = await collectPackets(pktLineReader(stringToStream("0001")));
      expect(packets).toHaveLength(1);
      expect(packets[0].type).toBe("delim");
      expect(isDelimiter(PKT_DELIM)).toBe(true);
      expect(isEnd(PKT_DELIM)).toBe(false);
    });
  });

  describe("readStringRaw", () => {
    it("should read raw strings", async () => {
      const packets = await collectPackets(pktLineReader(stringToStream("0005a0006bc")));
      expect(packetDataToStringRaw(packets[0])).toBe("a");
      expect(packetDataToStringRaw(packets[1])).toBe("bc");
    });

    it("should read want line without newline stripping", async () => {
      const packets = await collectPackets(
        pktLineReader(stringToStream("0031want fcfcfb1fd94829c1a1704f894fc111d14770d34e")),
      );
      expect(packetDataToStringRaw(packets[0])).toBe(
        "want fcfcfb1fd94829c1a1704f894fc111d14770d34e",
      );
    });

    it("should handle empty packet", async () => {
      const packets = await collectPackets(pktLineReader(stringToStream("0004")));
      expect(packetDataToStringRaw(packets[0])).toBe("");
      expect(isEnd(packetDataToStringRaw(packets[0]))).toBe(false);
    });
  });
});

describe("PacketLineOut (Writer)", () => {
  describe("writeString", () => {
    it("should write simple strings", async () => {
      const packets = [dataPacket("a"), dataPacket("bc")];
      const result = await collectBytes(
        pktLineWriter(
          (async function* () {
            yield* packets;
          })(),
        ),
      );
      expect(result).toBe("0005a0006bc");
    });

    it("should write strings with newlines", async () => {
      const packets = [dataPacket("a\n"), dataPacket("bc\n")];
      const result = await collectBytes(
        pktLineWriter(
          (async function* () {
            yield* packets;
          })(),
        ),
      );
      expect(result).toBe("0006a\n0007bc\n");
    });

    it("should write empty string as 0004", async () => {
      const result = await collectBytes(
        pktLineWriter(
          (async function* () {
            yield dataPacket("");
          })(),
        ),
      );
      expect(result).toBe("0004");
    });
  });

  describe("end", () => {
    it("should write flush packet as 0000", async () => {
      const result = await collectBytes(
        pktLineWriter(
          (async function* () {
            yield flushPacket();
          })(),
        ),
      );
      expect(result).toBe("0000");
    });

    it("should write delimiter as 0001", async () => {
      const result = await collectBytes(
        pktLineWriter(
          (async function* () {
            yield delimPacket();
          })(),
        ),
      );
      expect(result).toBe("0001");
    });
  });

  describe("writePacket", () => {
    it("should write single byte packet", async () => {
      const packet: Packet = {
        type: "data",
        data: new Uint8Array([0x61]), // 'a'
      };
      const result = await collectBytes(
        pktLineWriter(
          (async function* () {
            yield packet;
          })(),
        ),
      );
      expect(result).toBe("0005a");
    });

    it("should write multi-byte packet", async () => {
      const packet: Packet = {
        type: "data",
        data: new Uint8Array([0x61, 0x62, 0x63, 0x64]), // 'abcd'
      };
      const result = await collectBytes(
        pktLineWriter(
          (async function* () {
            yield packet;
          })(),
        ),
      );
      expect(result).toBe("0008abcd");
    });

    it("should write large packets", async () => {
      const buflen = 65520 - 4; // MAX_BUF - HDR_SIZE (4 bytes header)
      const buf = new Uint8Array(buflen);
      for (let i = 0; i < buf.length; i++) {
        buf[i] = i & 0xff;
      }

      // Collect raw bytes instead of converting to string
      const chunks: Uint8Array[] = [];
      for await (const chunk of pktLineWriter(
        (async function* () {
          yield { type: "data", data: buf };
        })(),
      )) {
        chunks.push(chunk);
      }
      const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
      const resultBytes = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        resultBytes.set(chunk, offset);
        offset += chunk.length;
      }

      const explen = (buf.length + 4).toString(16);
      expect(resultBytes.length).toBe(4 + buf.length);
      expect(new TextDecoder().decode(resultBytes.slice(0, 4))).toBe(explen);
    });
  });
});

describe("encodePacket", () => {
  it("should encode string", () => {
    const result = encodePacket("a");
    expect(new TextDecoder().decode(result)).toBe("0005a");
  });

  it("should encode bytes", () => {
    const result = encodePacket(new Uint8Array([0x61, 0x62]));
    expect(new TextDecoder().decode(result)).toBe("0006ab");
  });

  it("should reject oversized packets", () => {
    const buf = new Uint8Array(65520);
    expect(() => encodePacket(buf)).toThrow("Packet too large");
  });
});

describe("encodePacketLine", () => {
  it("should add newline if missing", () => {
    const result = encodePacketLine("hello");
    expect(new TextDecoder().decode(result)).toBe("000ahello\n");
  });

  it("should not double newline", () => {
    const result = encodePacketLine("hello\n");
    expect(new TextDecoder().decode(result)).toBe("000ahello\n");
  });
});

describe("encodeFlush", () => {
  it("should encode as 0000", () => {
    const result = encodeFlush();
    expect(new TextDecoder().decode(result)).toBe("0000");
  });
});

describe("encodeDelim", () => {
  it("should encode as 0001", () => {
    const result = encodeDelim();
    expect(new TextDecoder().decode(result)).toBe("0001");
  });
});

describe("parsePacket", () => {
  it("should parse data packet", () => {
    const buffer = new TextEncoder().encode("0005a");
    const result = parsePacket(buffer);
    expect(result).not.toBeNull();
    expect(result?.packet.type).toBe("data");
    expect(new TextDecoder().decode(result?.packet.data)).toBe("a");
    expect(result?.remaining.length).toBe(0);
  });

  it("should parse flush packet", () => {
    const buffer = new TextEncoder().encode("0000");
    const result = parsePacket(buffer);
    expect(result).not.toBeNull();
    expect(result?.packet.type).toBe("flush");
    expect(result?.remaining.length).toBe(0);
  });

  it("should parse delim packet", () => {
    const buffer = new TextEncoder().encode("0001");
    const result = parsePacket(buffer);
    expect(result).not.toBeNull();
    expect(result?.packet.type).toBe("delim");
    expect(result?.remaining.length).toBe(0);
  });

  it("should return null for incomplete header", () => {
    const buffer = new TextEncoder().encode("000");
    const result = parsePacket(buffer);
    expect(result).toBeNull();
  });

  it("should return null for incomplete data", () => {
    const buffer = new TextEncoder().encode("0005");
    const result = parsePacket(buffer);
    expect(result).toBeNull();
  });

  it("should return remaining buffer", () => {
    const buffer = new TextEncoder().encode("0005a0006bc");
    const result = parsePacket(buffer);
    expect(result).not.toBeNull();
    expect(new TextDecoder().decode(result?.packet.data)).toBe("a");
    expect(new TextDecoder().decode(result?.remaining)).toBe("0006bc");
  });
});

describe("chunked input", () => {
  it("should handle packets split across chunks", async () => {
    // Split "0005a0006bc" across multiple chunks
    async function* chunked(): AsyncGenerator<Uint8Array> {
      yield new TextEncoder().encode("000");
      yield new TextEncoder().encode("5a");
      yield new TextEncoder().encode("0006");
      yield new TextEncoder().encode("bc");
    }

    const packets = await collectPackets(pktLineReader(chunked()));
    expect(packets).toHaveLength(2);
    expect(packetDataToString(packets[0])).toBe("a");
    expect(packetDataToString(packets[1])).toBe("bc");
  });

  it("should handle single-byte chunks", async () => {
    const input = "0005a";
    async function* singleByte(): AsyncGenerator<Uint8Array> {
      for (const char of input) {
        yield new TextEncoder().encode(char);
      }
    }

    const packets = await collectPackets(pktLineReader(singleByte()));
    expect(packets).toHaveLength(1);
    expect(packetDataToString(packets[0])).toBe("a");
  });
});
