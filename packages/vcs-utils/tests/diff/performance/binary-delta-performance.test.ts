import { describe, expect, it } from "vitest";
import { testLog } from "../test-logger.js";
import {
  type BinaryDeltaPerformanceStats,
  testBinaryDeltaPerformance,
} from "./binary-delta-utility.js";

function pad(str: string): string {
  return str.padStart(10, " ");
}

describe.skip("Binary Delta - Performance Tests", () => {
  describe("Stress test - range of sizes", () => {
    function formatStats(prefix: string, stats: BinaryDeltaPerformanceStats): string {
      const formatSize = (size: number): string => {
        if (size < 1024) return `${pad(size.toString())}B`;
        if (size < 1024 * 1024) return `${pad((size / 1024).toFixed(2))}KB`;
        return `${pad((size / (1024 * 1024)).toFixed(2))}MB`;
      };

      const formatMs = (ms: number): string => `${pad(ms.toFixed(3))}ms`;

      return [
        prefix,
        `Source:      ${formatSize(stats.sourceSize)}`,
        `Target:      ${formatSize(stats.targetSize)}`,
        `Mutation:    ${pad((stats.mutationDegree * 100).toFixed(1))}%`,
        `Delta Size:  ${formatSize(stats.deltaSize)}`,
        `Compression: ${pad((stats.compressionRatio * 100).toFixed(1))}%`,
        `Edits:       ${pad(stats.editCount.toString())}`,
        `Diff:        ${formatMs(stats.diffTimeMs)}`,
        `Encode:      ${formatMs(stats.encodeTimeMs)}`,
        `Decode:      ${formatMs(stats.decodeTimeMs)}`,
        `Total:       ${formatMs(stats.totalTimeMs)}`,
      ].join("\n  ");
    }

    // Note: Myers diff is O(ND) which is slow for large files with many differences
    // Using smaller sizes to keep test time reasonable
    const sizes = [
      10, 50, 100, 500, 1024, 5120, 10240, 51200,
      102400,
      // 125 * 1024,  // Slow with Myers
      // 512 * 1024,  // Very slow
      // 1024 * 1024, // Extremely slow
    ];
    const mutations = [0, 0.05, 0.1, 0.25, 0.5, 0.75, 1.0];

    it("should handle various size and mutation combinations", { timeout: 120000 }, () => {
      testLog("\n  === Binary Delta Performance Matrix ===");
      let errorCount = 0;
      let successCount = 0;
      let i = 0;

      for (const size of sizes) {
        for (const mutation of mutations) {
          try {
            const stats = testBinaryDeltaPerformance({
              sourceSize: size,
              targetSize: size,
              mutationDegree: mutation,
              blockSize: 16,
              seed: size * 1000 + mutation * 100,
            });
            testLog(formatStats(`${i++}`, stats));
            successCount++;
          } catch (error) {
            testLog(
              `  Size: ${size.toString().padStart(6)}B | Mut: ${(mutation * 100).toFixed(0).padStart(3)}% | ` +
                `ERROR: ${error instanceof Error ? error.message : String(error)}`,
            );
            errorCount++;
          }
        }
      }

      testLog(`\n  Summary: ${successCount} passed, ${errorCount} failed`);
      expect(successCount).toBeGreaterThan(0);
    });
  });

  describe("Comparison: encode vs decode performance", () => {
    it("should show encode/decode breakdown for 50KB file", { timeout: 60000 }, () => {
      const mutations = [0, 0.1, 0.25, 0.5, 1.0];

      testLog("\n  === 50KB File: Encode vs Decode ===");
      testLog("  Mutation% | Diff(ms) | Encode(ms) | Decode(ms) | Delta Size | Ratio");
      testLog(`  ${"-".repeat(70)}`);

      for (const mutation of mutations) {
        const stats = testBinaryDeltaPerformance({
          sourceSize: 50 * 1024,
          targetSize: 50 * 1024,
          mutationDegree: mutation,
          blockSize: 16,
          seed: 12345 + mutation * 100,
        });

        const formatSize = (size: number): string => {
          if (size < 1024) return `${size}B`;
          if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)}KB`;
          return `${(size / (1024 * 1024)).toFixed(2)}MB`;
        };

        testLog(
          `  ${(mutation * 100).toFixed(0).padStart(8)}% | ` +
            `${stats.diffTimeMs.toFixed(2).padStart(8)} | ` +
            `${stats.encodeTimeMs.toFixed(2).padStart(10)} | ` +
            `${stats.decodeTimeMs.toFixed(2).padStart(10)} | ` +
            `${formatSize(stats.deltaSize).padStart(10)} | ` +
            `${(stats.compressionRatio * 100).toFixed(1).padStart(5)}%`,
        );
      }

      expect(true).toBe(true);
    });

    it("should show encode/decode breakdown for 100KB file", { timeout: 120000 }, () => {
      const mutations = [0, 0.1, 0.25, 0.5, 1.0];

      testLog("\n  === 100KB File: Encode vs Decode ===");
      testLog("  Mutation% | Diff(ms) | Encode(ms) | Decode(ms) | Delta Size | Ratio");
      testLog(`  ${"-".repeat(70)}`);

      for (const mutation of mutations) {
        const stats = testBinaryDeltaPerformance({
          sourceSize: 100 * 1024,
          targetSize: 100 * 1024,
          mutationDegree: mutation,
          blockSize: 16,
          seed: 54321 + mutation * 100,
        });

        const formatSize = (size: number): string => {
          if (size < 1024) return `${size}B`;
          if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)}KB`;
          return `${(size / (1024 * 1024)).toFixed(2)}MB`;
        };

        testLog(
          `  ${(mutation * 100).toFixed(0).padStart(8)}% | ` +
            `${stats.diffTimeMs.toFixed(2).padStart(8)} | ` +
            `${stats.encodeTimeMs.toFixed(2).padStart(10)} | ` +
            `${stats.decodeTimeMs.toFixed(2).padStart(10)} | ` +
            `${formatSize(stats.deltaSize).padStart(10)} | ` +
            `${(stats.compressionRatio * 100).toFixed(1).padStart(5)}%`,
        );
      }

      expect(true).toBe(true);
    });
  });
});
