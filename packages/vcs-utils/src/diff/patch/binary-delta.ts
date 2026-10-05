/**
 * Git binary delta format decoder/encoder
 *
 * Based on JGit's BinaryDelta.java and DeltaEncoder.java
 * @see https://github.com/eclipse-jgit/jgit/blob/master/org.eclipse.jgit/src/org/eclipse/jgit/internal/storage/pack/BinaryDelta.java
 * @see https://github.com/eclipse-jgit/jgit/blob/master/org.eclipse.jgit/src/org/eclipse/jgit/internal/storage/pack/DeltaEncoder.java
 *
 * Git binary delta format:
 * - Base size (variable-length encoding)
 * - Result size (variable-length encoding)
 * - Delta instructions:
 *   - 0xxxxxxx: insert next (x+1) bytes (or 0x80 if x=0)
 *   - 1xxxxxxx: copy from base
 *     - Offset and size encoded in the x bits
 */

import type { EditList } from "../text-diff/edit.js";

/**
 * Read a variable-length integer from the delta stream
 *
 * Git uses a variable-length encoding where each byte contributes 7 bits,
 * and the MSB indicates if more bytes follow.
 *
 * @param data Delta data
 * @param pos Current position
 * @returns [value, new position]
 */
function readVariableInt(data: Uint8Array, pos: number): [number, number] {
  let value = 0;
  let shift = 0;
  let offset = pos;

  while (offset < data.length) {
    const byte = data[offset++];
    value |= (byte & 0x7f) << shift;
    shift += 7;

    if ((byte & 0x80) === 0) {
      break;
    }
  }

  return [value, offset];
}

/**
 * Write a variable-length integer to the output
 *
 * @param output Output array
 * @param value Value to write
 */
function writeVariableInt(output: number[], value: number): void {
  let remaining = value;

  while (remaining >= 0x80) {
    output.push((remaining & 0x7f) | 0x80);
    remaining >>>= 7;
  }

  output.push(remaining & 0x7f);
}

/**
 * Decode a Git binary delta
 *
 * @param base Base (old) data
 * @param delta Delta instructions
 * @returns Reconstructed result data
 * @throws Error if delta is invalid or base size doesn't match
 */
export function decodeGitBinaryDelta(base: Uint8Array, delta: Uint8Array): Uint8Array {
  // Read base size
  const [baseSize, pos1] = readVariableInt(delta, 0);
  if (baseSize !== base.length) {
    throw new Error(`Base size mismatch: expected ${baseSize}, got ${base.length}`);
  }

  // Read result size
  const [resultSize, pos2] = readVariableInt(delta, pos1);

  // Decode instructions
  const result = new Uint8Array(resultSize);
  let resultPos = 0;
  let pos = pos2;

  while (pos < delta.length) {
    const cmd = delta[pos++];

    if ((cmd & 0x80) === 0) {
      // Insert command: 0xxxxxxx
      // Insert the next (cmd) bytes, or 0x80 bytes if cmd is 0
      const len = cmd === 0 ? 0x80 : cmd;

      if (pos + len > delta.length) {
        throw new Error(`Insert command exceeds delta bounds: need ${len} bytes at ${pos}`);
      }

      result.set(delta.slice(pos, pos + len), resultPos);
      pos += len;
      resultPos += len;
    } else {
      // Copy command: 1xxxxxxx
      let offset = 0;
      let len = 0;

      // Decode offset (up to 4 bytes)
      if (cmd & 0x01) offset = delta[pos++];
      if (cmd & 0x02) offset |= delta[pos++] << 8;
      if (cmd & 0x04) offset |= delta[pos++] << 16;
      if (cmd & 0x08) offset |= delta[pos++] << 24;

      // Decode length (up to 3 bytes)
      if (cmd & 0x10) len = delta[pos++];
      if (cmd & 0x20) len |= delta[pos++] << 8;
      if (cmd & 0x40) len |= delta[pos++] << 16;

      // Default length is 0x10000 (64KB) if not specified
      if (len === 0) len = 0x10000;

      // Validate copy operation
      if (offset + len > base.length) {
        throw new Error(
          `Copy command exceeds base bounds: offset=${offset}, len=${len}, base=${base.length}`,
        );
      }

      if (resultPos + len > resultSize) {
        throw new Error(
          `Copy command exceeds result bounds: resultPos=${resultPos}, len=${len}, resultSize=${resultSize}`,
        );
      }

      // Copy from base
      result.set(base.slice(offset, offset + len), resultPos);
      resultPos += len;
    }
  }

  if (resultPos !== resultSize) {
    throw new Error(`Result size mismatch: expected ${resultSize}, got ${resultPos}`);
  }

  return result;
}

/**
 * Encode a copy instruction
 *
 * @param output Output array
 * @param offset Offset in base
 * @param len Length to copy
 */
function encodeCopyInstruction(output: number[], offset: number, len: number): void {
  let cmd = 0x80; // Copy command marker

  // Encode offset
  const offsetBytes: number[] = [];
  if (offset & 0x000000ff) {
    offsetBytes.push(offset & 0xff);
    cmd |= 0x01;
  }
  if (offset & 0x0000ff00) {
    offsetBytes.push((offset >> 8) & 0xff);
    cmd |= 0x02;
  }
  if (offset & 0x00ff0000) {
    offsetBytes.push((offset >> 16) & 0xff);
    cmd |= 0x04;
  }
  if (offset & 0xff000000) {
    offsetBytes.push((offset >> 24) & 0xff);
    cmd |= 0x08;
  }

  // Encode length
  const lenBytes: number[] = [];
  if (len !== 0x10000) {
    // Default length
    if (len & 0x0000ff) {
      lenBytes.push(len & 0xff);
      cmd |= 0x10;
    }
    if (len & 0x00ff00) {
      lenBytes.push((len >> 8) & 0xff);
      cmd |= 0x20;
    }
    if (len & 0xff0000) {
      lenBytes.push((len >> 16) & 0xff);
      cmd |= 0x40;
    }
  }

  // Write command byte
  output.push(cmd);

  // Write offset bytes
  for (const byte of offsetBytes) {
    output.push(byte);
  }

  // Write length bytes
  for (const byte of lenBytes) {
    output.push(byte);
  }
}

/**
 * Maximum number of bytes to be copied in pack v2 format (64KB).
 * Historical limitations from JGit, even though current decoders recognize larger instructions.
 */
const MAX_V2_COPY = 0x10000;

/**
 * Maximum length that an insert command can encode at once (127 bytes).
 */
const MAX_INSERT_DATA_SIZE = 0x7f;

/**
 * Encode a Git binary delta directly from an EditList (JGit-style direct encoding)
 *
 * This function follows JGit's approach of directly encoding delta instructions
 * from Edit objects without an intermediate representation.
 *
 * @param base Base (old) data
 * @param target Target (new) data
 * @param edits EditList from Myers diff algorithm
 * @returns Encoded delta
 */
export function encodeGitBinaryDelta(
  base: Uint8Array,
  target: Uint8Array,
  edits: EditList,
): Uint8Array {
  const output: number[] = [];

  // Write base size
  writeVariableInt(output, base.length);

  // Write result size
  writeVariableInt(output, target.length);

  // Process edits directly
  let posA = 0; // Position in base (sequence A)

  for (const edit of edits) {
    // Copy unchanged prefix from base
    if (edit.beginA > posA) {
      const copyLen = edit.beginA - posA;
      encodeCopyInstructionChunked(output, posA, copyLen);
    }

    // Handle the edit based on type
    const type = edit.getType();

    switch (type) {
      case "INSERT":
        // Insert from target
        encodeInsertInstructionChunked(output, target.slice(edit.beginB, edit.endB));
        break;

      case "DELETE":
        // Delete: no instruction needed (content removed)
        break;

      case "REPLACE":
        // Replace: insert new content from target
        encodeInsertInstructionChunked(output, target.slice(edit.beginB, edit.endB));
        break;

      case "EMPTY":
        // No operation
        break;
    }

    posA = edit.endA;
  }

  // Copy unchanged suffix from base
  if (posA < base.length) {
    const copyLen = base.length - posA;
    encodeCopyInstructionChunked(output, posA, copyLen);
  }

  return new Uint8Array(output);
}

/**
 * Encode a copy instruction, splitting into chunks if necessary (MAX_V2_COPY limit)
 *
 * @param output Output array
 * @param offset Offset in base
 * @param len Total length to copy
 */
function encodeCopyInstructionChunked(output: number[], offset: number, len: number): void {
  let remaining = len;
  let currentOffset = offset;

  // Split into MAX_V2_COPY chunks if necessary
  while (remaining > 0) {
    const chunkLen = Math.min(remaining, MAX_V2_COPY);
    encodeCopyInstruction(output, currentOffset, chunkLen);
    currentOffset += chunkLen;
    remaining -= chunkLen;
  }
}

/**
 * Encode an insert instruction, splitting into chunks if necessary (MAX_INSERT_DATA_SIZE limit)
 *
 * @param output Output array
 * @param data Data to insert
 */
function encodeInsertInstructionChunked(output: number[], data: Uint8Array): void {
  let offset = 0;

  // Split into MAX_INSERT_DATA_SIZE chunks if necessary
  while (offset < data.length) {
    const remaining = data.length - offset;
    const chunkLen = Math.min(remaining, MAX_INSERT_DATA_SIZE);

    // Write insert command (0xxxxxxx where x is length)
    output.push(chunkLen);

    // Write data
    for (let i = 0; i < chunkLen; i++) {
      output.push(data[offset + i]);
    }

    offset += chunkLen;
  }
}
