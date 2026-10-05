/**
 * Git binary delta format encoder and utilities
 *
 * Converts DeltaRange[] and Delta[] to Git pack delta format.
 * This enables using rolling hash algorithms (createDeltaRanges, createFossilLikeRanges)
 * to produce Git-compatible pack files via PackWriterStream.
 *
 * Based on JGit's DeltaEncoder.java and BinaryDelta.java
 * @see https://github.com/eclipse-jgit/jgit/blob/master/org.eclipse.jgit/src/org/eclipse/jgit/internal/storage/pack/DeltaEncoder.java
 * @see https://github.com/eclipse-jgit/jgit/blob/master/org.eclipse.jgit/src/org/eclipse/jgit/internal/storage/pack/BinaryDelta.java
 */

import { appendVarint } from "../../encoding/varint.js";
import type { Delta, DeltaRange } from "./types.js";

/**
 * Maximum number of bytes to be copied in pack v2 format (64KB).
 * Historical limitations have this at 64k, even though current delta
 * decoders recognize larger copy instructions.
 */
const MAX_V2_COPY = 0x10000;

/**
 * Maximum length that an insert command can encode at once (127 bytes).
 */
const MAX_INSERT_DATA_SIZE = 0x7f;

/**
 * Encode a single COPY instruction
 *
 * Format: 1oooosss [offset bytes] [size bytes]
 * - Bit 7: always 1 (copy marker)
 * - Bits 0-3: which offset bytes are present
 * - Bits 4-6: which size bytes are present
 *
 * @param output Output array to append to
 * @param offset Offset in base object
 * @param len Length to copy (must be <= MAX_V2_COPY)
 */
function encodeCopy(output: number[], offset: number, len: number): void {
  let cmd = 0x80; // Copy command marker

  // Encode offset (up to 4 bytes, little-endian, sparse)
  // Only include bytes that are non-zero
  const offsetBytes: number[] = [];
  let b: number;

  b = offset & 0xff;
  if (b !== 0) {
    offsetBytes.push(b);
    cmd |= 0x01;
  }
  b = (offset >>> 8) & 0xff;
  if (b !== 0) {
    offsetBytes.push(b);
    cmd |= 0x02;
  }
  b = (offset >>> 16) & 0xff;
  if (b !== 0) {
    offsetBytes.push(b);
    cmd |= 0x04;
  }
  b = (offset >>> 24) & 0xff;
  if (b !== 0) {
    offsetBytes.push(b);
    cmd |= 0x08;
  }

  // Encode length (up to 3 bytes, sparse)
  // size=0 means 0x10000 (64KB default), so we omit size bytes if len === MAX_V2_COPY
  const lenBytes: number[] = [];
  if (len !== MAX_V2_COPY) {
    b = len & 0xff;
    if (b !== 0) {
      lenBytes.push(b);
      cmd |= 0x10;
    }
    b = (len >>> 8) & 0xff;
    if (b !== 0) {
      lenBytes.push(b);
      cmd |= 0x20;
    }
    b = (len >>> 16) & 0xff;
    if (b !== 0) {
      lenBytes.push(b);
      cmd |= 0x40;
    }
  }

  // Write command byte
  output.push(cmd);

  // Write offset bytes (in order they were collected)
  for (const byte of offsetBytes) {
    output.push(byte);
  }

  // Write length bytes (in order they were collected)
  for (const byte of lenBytes) {
    output.push(byte);
  }
}

/**
 * Encode a COPY instruction, splitting into chunks if > 64KB
 *
 * @param output Output array to append to
 * @param offset Offset in base object
 * @param len Total length to copy
 */
function encodeCopyChunked(output: number[], offset: number, len: number): void {
  let remaining = len;
  let currentOffset = offset;

  while (remaining > 0) {
    const chunkLen = Math.min(remaining, MAX_V2_COPY);
    encodeCopy(output, currentOffset, chunkLen);
    currentOffset += chunkLen;
    remaining -= chunkLen;
  }
}

/**
 * Encode an INSERT instruction
 *
 * Format: 0xxxxxxx [data bytes]
 * - Length is encoded in bits 0-6 (1-127)
 * - Special case: 0x00 means 128 bytes (reserved for future, but some implementations use it)
 *
 * Note: JGit's DeltaEncoder only uses 1-127 range, so we follow that pattern.
 *
 * @param output Output array to append to
 * @param data Data to insert (must be <= MAX_INSERT_DATA_SIZE)
 */
function encodeInsert(output: number[], data: Uint8Array): void {
  const len = data.length;
  if (len === 0) return;

  // Write insert command (length in bits 0-6)
  output.push(len);

  // Write data bytes
  for (let i = 0; i < len; i++) {
    output.push(data[i]);
  }
}

/**
 * Encode an INSERT instruction, splitting into chunks if > 127 bytes
 *
 * @param output Output array to append to
 * @param data Data to insert
 */
function encodeInsertChunked(output: number[], data: Uint8Array): void {
  let offset = 0;

  while (offset < data.length) {
    const remaining = data.length - offset;
    const chunkLen = Math.min(remaining, MAX_INSERT_DATA_SIZE);
    encodeInsert(output, data.subarray(offset, offset + chunkLen));
    offset += chunkLen;
  }
}

/**
 * Convert DeltaRange[] to Git binary delta format
 *
 * This bridges the rolling-hash delta algorithms (createDeltaRanges,
 * createFossilLikeRanges) with Git pack files (PackWriterStream).
 *
 * @param base Source/base data (for size header)
 * @param target Target data (for extracting insert content)
 * @param ranges Delta ranges from createDeltaRanges() or createFossilLikeRanges()
 * @returns Git binary delta suitable for PackWriterStream.addOfsDelta()
 */
export function deltaRangesToGitFormat(
  base: Uint8Array,
  target: Uint8Array,
  ranges: Iterable<DeltaRange>,
): Uint8Array {
  const output: number[] = [];

  // Write header: base size and result size as varints
  appendVarint(output, base.length);
  appendVarint(output, target.length);

  // Encode each range as copy or insert instructions
  for (const range of ranges) {
    // Skip zero-length ranges
    if (range.len === 0) continue;

    if (range.from === "source") {
      // COPY from base - may need chunking for large copies
      encodeCopyChunked(output, range.start, range.len);
    } else {
      // INSERT from target - may need chunking for large inserts
      const data = target.subarray(range.start, range.start + range.len);
      encodeInsertChunked(output, data);
    }
  }

  return new Uint8Array(output);
}

/**
 * Convert Delta[] instructions to Git binary delta format
 *
 * @param baseSize Size of base object
 * @param deltas Delta instructions from createDelta()
 * @returns Git binary delta
 */
export function deltaToGitFormat(baseSize: number, deltas: Iterable<Delta>): Uint8Array {
  const output: number[] = [];

  let targetSize = 0;

  // First pass: collect instructions and determine target size
  const instructions: Delta[] = [];
  for (const delta of deltas) {
    instructions.push(delta);
    if (delta.type === "start") {
      targetSize = delta.targetLen;
    }
  }

  // Write header
  appendVarint(output, baseSize);
  appendVarint(output, targetSize);

  // Encode instructions
  for (const delta of instructions) {
    switch (delta.type) {
      case "copy":
        if (delta.len > 0) {
          encodeCopyChunked(output, delta.start, delta.len);
        }
        break;
      case "insert":
        if (delta.data.length > 0) {
          encodeInsertChunked(output, delta.data);
        }
        break;
      case "start":
      case "finish":
        // Header and checksum are not part of Git delta format
        break;
    }
  }

  return new Uint8Array(output);
}

/**
 * Parsed Git delta instruction
 *
 * - copy: Copy `size` bytes from base object at `offset`
 * - insert: Insert literal `data` from delta buffer at `dataOffset`
 */
export type GitDeltaInstruction =
  | { type: "copy"; offset: number; size: number }
  | { type: "insert"; data: Uint8Array; dataOffset: number };

/**
 * Parse Git binary delta format to instructions
 *
 * Useful for debugging, testing, and format conversion.
 *
 * @param delta Git binary delta
 * @returns Parsed instructions with header info
 */
export function parseGitDelta(delta: Uint8Array): {
  baseSize: number;
  resultSize: number;
  instructions: GitDeltaInstruction[];
} {
  let pos = 0;

  // Read base size
  let baseSize = 0;
  let shift = 0;
  let c: number;
  do {
    c = delta[pos++];
    baseSize |= (c & 0x7f) << shift;
    shift += 7;
  } while ((c & 0x80) !== 0);

  // Read result size
  let resultSize = 0;
  shift = 0;
  do {
    c = delta[pos++];
    resultSize |= (c & 0x7f) << shift;
    shift += 7;
  } while ((c & 0x80) !== 0);

  // Parse instructions
  const instructions: GitDeltaInstruction[] = [];

  while (pos < delta.length) {
    const cmd = delta[pos++];

    if ((cmd & 0x80) !== 0) {
      // COPY instruction
      let offset = 0;
      if (cmd & 0x01) offset = delta[pos++];
      if (cmd & 0x02) offset |= delta[pos++] << 8;
      if (cmd & 0x04) offset |= delta[pos++] << 16;
      if (cmd & 0x08) offset |= delta[pos++] << 24;

      let size = 0;
      if (cmd & 0x10) size = delta[pos++];
      if (cmd & 0x20) size |= delta[pos++] << 8;
      if (cmd & 0x40) size |= delta[pos++] << 16;
      if (size === 0) size = MAX_V2_COPY;

      instructions.push({ type: "copy", offset, size });
    } else if (cmd !== 0) {
      // INSERT instruction
      const len = cmd;
      const dataOffset = pos;
      const data = delta.slice(pos, pos + len);
      pos += len;
      instructions.push({ type: "insert", data, dataOffset });
    } else {
      throw new Error("Unsupported delta command 0");
    }
  }

  return { baseSize, resultSize, instructions };
}

/**
 * Convert Git binary delta format to DeltaRange[]
 *
 * Useful for debugging, testing, and format conversion.
 * Note: Insert ranges use target offsets that must be tracked.
 *
 * @param delta Git binary delta
 * @returns Array of delta ranges
 */
export function gitFormatToDeltaRanges(delta: Uint8Array): DeltaRange[] {
  const parsed = parseGitDelta(delta);
  const ranges: DeltaRange[] = [];
  let targetPos = 0;

  for (const instr of parsed.instructions) {
    if (instr.type === "copy") {
      ranges.push({ from: "source", start: instr.offset, len: instr.size });
      targetPos += instr.size;
    } else {
      ranges.push({ from: "target", start: targetPos, len: instr.data.length });
      targetPos += instr.data.length;
    }
  }

  return ranges;
}

/**
 * Format Git binary delta as human-readable string
 *
 * Based on JGit's BinaryDelta.format()
 *
 * @param delta Git binary delta
 * @param includeHeader Whether to include base/result sizes
 * @returns Human-readable representation
 */
export function formatGitDelta(delta: Uint8Array, includeHeader = true): string {
  const parsed = parseGitDelta(delta);
  const lines: string[] = [];

  if (includeHeader) {
    lines.push(`DELTA( BASE=${parsed.baseSize} RESULT=${parsed.resultSize} )`);
  }

  for (const instr of parsed.instructions) {
    if (instr.type === "copy") {
      lines.push(`  COPY  (${instr.offset}, ${instr.size})`);
    } else {
      // Try to decode as UTF-8 for display, escape non-printable
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(instr.data);
        // Escape special characters
        text = text
          .replace(/\\/g, "\\\\")
          .replace(/\n/g, "\\n")
          .replace(/\r/g, "\\r")
          .replace(/\t/g, "\\t");
      } catch {
        // Binary data - show hex
        text = `<binary ${instr.data.length} bytes>`;
      }
      lines.push(`  INSERT(${text})`);
    }
  }

  return lines.join("\n");
}

/**
 * Get base object size from a Git delta
 *
 * @param delta Git binary delta
 * @returns Base object size
 */
export function getGitDeltaBaseSize(delta: Uint8Array): number {
  let pos = 0;
  let baseSize = 0;
  let shift = 0;
  let c: number;
  do {
    c = delta[pos++];
    baseSize |= (c & 0x7f) << shift;
    shift += 7;
  } while ((c & 0x80) !== 0);
  return baseSize;
}

/**
 * Get result object size from a Git delta
 *
 * @param delta Git binary delta
 * @returns Result object size
 */
export function getGitDeltaResultSize(delta: Uint8Array): number {
  let pos = 0;
  let c: number;

  // Skip base size
  do {
    c = delta[pos++];
  } while ((c & 0x80) !== 0);

  // Read result size
  let resultSize = 0;
  let shift = 0;
  do {
    c = delta[pos++];
    resultSize |= (c & 0x7f) << shift;
    shift += 7;
  } while ((c & 0x80) !== 0);

  return resultSize;
}

/**
 * Serialize Delta[] instructions to Git binary delta format
 *
 * Uses sourceLen from the start instruction for the base size header.
 * Falls back to computing from copy instructions if sourceLen is not present
 * (for backwards compatibility with older delta formats).
 *
 * @param delta Delta instructions (must have start, copy/insert, and finish)
 * @returns Git binary delta
 */
export function serializeDeltaToGit(delta: Delta[]): Uint8Array {
  // First try to get baseSize from start instruction's sourceLen
  let baseSize: number | undefined;
  for (const d of delta) {
    if (d.type === "start" && d.sourceLen !== undefined) {
      baseSize = d.sourceLen;
      break;
    }
  }

  // Fallback: compute from copy instructions (legacy behavior)
  if (baseSize === undefined) {
    baseSize = 0;
    for (const d of delta) {
      if (d.type === "copy") {
        baseSize = Math.max(baseSize, d.start + d.len);
      }
    }
  }

  return deltaToGitFormat(baseSize, delta);
}

/**
 * Deserialize Git binary delta format to Delta[] instructions
 *
 * Converts from Git's compact binary format to the format-agnostic Delta[] array.
 *
 * @param binary Git binary delta data
 * @returns Delta instructions array
 */
export function deserializeDeltaFromGit(binary: Uint8Array): Delta[] {
  const parsed = parseGitDelta(binary);
  const result: Delta[] = [];

  // Start instruction with source and target sizes
  result.push({ type: "start", sourceLen: parsed.baseSize, targetLen: parsed.resultSize });

  // Convert each Git instruction to Delta
  for (const instr of parsed.instructions) {
    if (instr.type === "copy") {
      result.push({ type: "copy", start: instr.offset, len: instr.size });
    } else {
      result.push({ type: "insert", data: instr.data });
    }
  }

  // Git format doesn't include checksum, add placeholder (0)
  // Consumers should validate content via other means if needed
  result.push({ type: "finish", checksum: 0 });

  return result;
}
