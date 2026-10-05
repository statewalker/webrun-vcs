/**
 * Delta instruction analyzer for random access
 *
 * Parses Git binary deltas into positioned instructions that can
 * be queried for range lookups.
 */

import { parseGitDelta } from "@statewalker/vcs-utils";
import type { AnalyzedDelta, PositionedInstruction } from "./random-access-delta.js";

/**
 * Analyze a Git binary delta into positioned instructions
 *
 * Parses the delta once and builds a position index mapping result
 * positions to their sources (base offset or insert data).
 *
 * Uses parseGitDelta from utils internally and converts to PositionedInstruction format.
 *
 * @param delta Raw delta bytes
 * @returns Analyzed delta with positioned instructions
 */
export function analyzeDelta(delta: Uint8Array): AnalyzedDelta {
  const parsed = parseGitDelta(delta);

  // Convert GitDeltaInstruction[] to PositionedInstruction[]
  const instructions: PositionedInstruction[] = [];
  let resultPos = 0;

  for (const instr of parsed.instructions) {
    if (instr.type === "copy") {
      instructions.push({
        resultStart: resultPos,
        length: instr.size,
        instruction: { type: "copy", baseOffset: instr.offset },
      });
      resultPos += instr.size;
    } else {
      instructions.push({
        resultStart: resultPos,
        length: instr.data.length,
        instruction: { type: "insert", dataOffset: instr.dataOffset },
      });
      resultPos += instr.data.length;
    }
  }

  return {
    baseSize: parsed.baseSize,
    resultSize: parsed.resultSize,
    instructions,
    rawDelta: delta,
  };
}

/**
 * Find instructions that overlap with a given range
 *
 * Uses binary search for O(log n) lookup to find the first instruction,
 * then collects all overlapping instructions.
 *
 * @param analyzed Analyzed delta
 * @param offset Start position in result
 * @param length Number of bytes
 * @returns Instructions that contribute to the range
 */
export function findInstructionsForRange(
  analyzed: AnalyzedDelta,
  offset: number,
  length: number,
): PositionedInstruction[] {
  if (length <= 0 || offset >= analyzed.resultSize) {
    return [];
  }

  const end = Math.min(offset + length, analyzed.resultSize);
  const result: PositionedInstruction[] = [];

  // Binary search for first potentially overlapping instruction
  let lo = 0;
  let hi = analyzed.instructions.length;

  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const instr = analyzed.instructions[mid];
    const instrEnd = instr.resultStart + instr.length;

    if (instrEnd <= offset) {
      // This instruction ends before our range starts
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }

  // Collect all overlapping instructions
  for (let i = lo; i < analyzed.instructions.length; i++) {
    const instr = analyzed.instructions[i];

    // Stop if this instruction starts after our range ends
    if (instr.resultStart >= end) {
      break;
    }

    result.push(instr);
  }

  return result;
}
