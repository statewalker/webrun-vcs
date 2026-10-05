import { describe, it } from "vitest";
import { testLog } from "../test-logger.js";
import { type PerformanceStats, testFossilLikeRanges } from "./test-utility.js";

function roundUpToPow2(x: number): number {
  const p = Math.ceil(Math.log2(x));
  return 1 << p;
}

function chooseBlockSize(fileSize: number): number {
  const min = 16; // or 32, 64…
  const max = 64 * 1024; // 64 KiB or whatever upper bound you like

  if (fileSize <= 0) return min;

  const raw = Math.sqrt(fileSize); // smooth scaling
  const rounded = roundUpToPow2(raw); // optional power-of-two
  return Math.min(max, Math.max(min, rounded));
}

function pad(str: string): string {
  return str.padStart(8, " ");
}

/**
 * Helper to format performance stats for console output
 */
function formatStats(prefix: string, stats: PerformanceStats): string {
  const formatSize = (size: number): string => {
    if (size < 1024) return `${pad(size.toString())}B`;
    if (size < 1024 * 1024) return `${pad((size / 1024).toFixed(2))}KB`;
    return `${pad((size / (1024 * 1024)).toFixed(2))}MB`;
  };
  return [
    prefix,
    `Source:     ${formatSize(stats.sourceSize)}`,
    `Target:     ${formatSize(stats.targetSize)}`,
    `Range Size: ${formatSize(stats.rangesSize)}`,
    `Ranges:     ${pad(stats.rangeCount.toString())}`,
    `Mutation:   ${pad((stats.mutationDegree * 100).toFixed(1))}%`,
    `Gen:        ${pad(stats.rangeGenerationTimeMs.toFixed(3))}ms`,
    `Apply:      ${pad(stats.rangeApplicationTimeMs.toFixed(3))}ms`,
  ].join("\n  ");
}

describe("createFossilLikeRanges - Performance and Correctness Tests", () => {
  describe.skipIf(process.env.CI)("Very large blocks (500KB)", () => {
    const mutationsDegrees = [0, 0.05, 0.1, 0.25, 0.5, 0.75, 1.0];
    const sourcesSizes = [
      500 * 1024,
      // 1024 * 1024,
      // 5 * 1024 * 1024,
      // 10 * 1024 * 1024,
      // 30 * 1024 * 1024,
    ];
    const targetSizesDelta = [0.75, 0.9, 1.0, 1.1, 1.25];
    let i = 0;
    for (const sourceSize of sourcesSizes) {
      for (const targetSizeDelta of targetSizesDelta) {
        for (const mutationDegree of mutationsDegrees) {
          it(`should handle ${sourceSize}B source, ${Math.floor(sourceSize * targetSizeDelta)}B target, ${(mutationDegree * 100).toFixed(1)}% mutation`, () => {
            i++;
            let blockSize = chooseBlockSize(sourceSize);
            blockSize = 16; // 32KB fixed for better comparison
            const stats = testFossilLikeRanges({
              sourceSize: sourceSize,
              targetSize: Math.floor(sourceSize * targetSizeDelta),
              mutationDegree: mutationDegree,
              seed:
                sourceSize + Math.floor(mutationDegree * 1000) + Math.floor(targetSizeDelta * 100),
              blockSize,
            });
            const report = formatStats(`${i}) ==============================`, stats);
            testLog(report);
            // expect(stats.actualMutationDegree).toBeGreaterThan(0);
            i++;
          });
        }
      }
    }
  });
});
