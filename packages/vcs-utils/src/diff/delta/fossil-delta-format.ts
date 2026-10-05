import type { Delta } from "./types.js";

// Fossil delta format uses a custom base64 encoding for integers
const Z_DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz~"
  .split("")
  .map((x) => x.charCodeAt(0));

const Z_VALUE = [
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  0,
  1,
  2,
  3,
  4,
  5,
  6,
  7,
  8,
  9, // 0-9
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  10,
  11,
  12,
  13,
  14,
  15,
  16,
  17,
  18,
  19,
  20,
  21,
  22,
  23,
  24,
  25,
  26,
  27,
  28,
  29,
  30,
  31,
  32,
  33,
  34,
  35, // A-Z
  -1,
  -1,
  -1,
  -1,
  36,
  -1, // _
  37,
  38,
  39,
  40,
  41,
  42,
  43,
  44,
  45,
  46,
  47,
  48,
  49,
  50,
  51,
  52,
  53,
  54,
  55,
  56,
  57,
  58,
  59,
  60,
  61,
  62, // a-z
  -1,
  -1,
  -1,
  63,
  -1, // ~
];

const COLON = 58; // ':'
const AT = 64; // '@'
const COMMA = 44; // ','
const SEMICOLON = 59; // ';'

const NEWLINE = 10; // '\n'

/**
 * Serialize deltas to Fossil delta format using generators
 *
 * Format: <targetSize>\n[<count>:<data>|<count>@<offset>,]*<checksum>;
 *
 * @param deltas Iterable of delta operations
 * @param targetSize Size of the target data
 * @yields Uint8Array chunks of serialized delta
 */
export function* encodeDeltaBlocks(deltas: Iterable<Delta>): Generator<Uint8Array> {
  // First, emit the target size header

  for (const delta of deltas) {
    switch (delta.type) {
      case "start":
        // Target size header
        yield encodeIntWithSuffix(delta.targetLen, NEWLINE); // '\n'
        continue;
      case "finish":
        // Checksum operation in the end
        yield encodeIntWithSuffix(delta.checksum, SEMICOLON); // ';'
        break;
      case "insert":
        // Literal/insert operation
        yield encodeIntWithSuffix(delta.data.length, COLON); // ':'
        yield delta.data;
        continue;
      case "copy":
        // Copy operation
        yield encodeIntWithSuffix(delta.len, AT); // '@'
        yield encodeIntWithSuffix(delta.start, COMMA); // ','
        continue;
    }
  }

  function encodeIntWithSuffix(value: number, end: number): Uint8Array {
    if (value === 0) {
      return new Uint8Array([48, end]); // '0'
    }

    const zBuf: number[] = [];
    let v = value;
    while (v > 0) {
      zBuf.push(Z_DIGITS[v & 0x3f]);
      v >>>= 6;
    }
    return new Uint8Array([...zBuf.reverse(), end]);
  }
}

export function* decodeDeltaBlocks(deltas: Uint8Array): Generator<Delta> {
  let pos = 0;
  const end = deltas.length;
  let foundChecksum = false;

  // Skip the target size header (format: <size>\n)
  const {
    pos: afterHeaderPos,
    value: expectedTargetLen,
    end: headerEnd,
  } = decodeIntWithSuffix(deltas, pos);
  if (headerEnd !== NEWLINE) {
    throw new Error("delta must start with target size followed by newline");
  }
  yield {
    type: "start",
    targetLen: expectedTargetLen,
  };
  pos = afterHeaderPos;

  while (pos < end) {
    const { value, end: endChar, pos: newPos } = decodeIntWithSuffix(deltas, pos);
    if (endChar === COLON) {
      // ':'
      // Insert operation
      const len = value;
      const data = deltas.subarray(newPos, newPos + len);
      yield { type: "insert", data };
      pos = newPos + len;
    } else if (endChar === AT) {
      // '@'
      // Copy operation
      const len = value;
      const {
        value: offset,
        pos: afterOffsetPos,
        end: afterOffsetEnd,
      } = decodeIntWithSuffix(deltas, newPos);
      if (afterOffsetEnd !== COMMA) {
        // ','
        throw new Error("copy command not terminated by ','");
      }
      yield { type: "copy", start: offset, len };
      pos = afterOffsetPos;
    } else if (endChar === SEMICOLON) {
      // ';'
      // Checksum (ensure unsigned 32-bit integer)
      const checksum = value >>> 0;
      yield { type: "finish", checksum };
      foundChecksum = true;
      break;
    } else {
      // Unknown terminator or end of buffer
      throw new Error("unexpected terminator in delta blocks");
    }
  }

  // Ensure delta was properly terminated with a checksum
  if (!foundChecksum) {
    throw new Error("delta not terminated with checksum");
  }

  function decodeIntWithSuffix(
    buffer: Uint8Array,
    pos: number,
  ): { value: number; pos: number; end: number } {
    let value = 0;
    let i: number;
    let endChar = -1;
    for (i = pos; i < buffer.length; i++) {
      const c = buffer[i];
      if (c === COLON || c === AT || c === SEMICOLON || c === COMMA || c === NEWLINE) {
        endChar = c;
        i++;
        break;
      }
      const digit = Z_VALUE[0x7f & c];
      if (digit < 0) {
        throw new Error("invalid base64 digit");
      }
      value = (value << 6) + digit;
    }
    return { value, pos: i, end: endChar };
  }
}

/**
 * Serialize Delta[] instructions to Fossil binary delta format
 *
 * This is a convenience function that collects encoded chunks into a single array.
 *
 * @param delta Delta instructions array
 * @returns Fossil binary delta
 */
export function serializeDeltaToFossil(delta: Delta[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const chunk of encodeDeltaBlocks(delta)) {
    chunks.push(chunk);
  }

  // Calculate total length
  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

/**
 * Deserialize Fossil binary delta format to Delta[] instructions
 *
 * This is a convenience function that collects decoded deltas into an array.
 *
 * @param binary Fossil binary delta data
 * @returns Delta instructions array
 */
export function deserializeDeltaFromFossil(binary: Uint8Array): Delta[] {
  return [...decodeDeltaBlocks(binary)];
}
