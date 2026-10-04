/**
 * V3, V4: Algorithm Configuration Validation Tests for Commands Package
 *
 * These tests validate that DiffFormatter and BlameCommand correctly
 * accept and use the algorithm configuration.
 */
import { SupportedAlgorithm } from "@statewalker/vcs-utils";
import { afterEach, describe, expect, it } from "vitest";

import { DiffFormatter, Git } from "../src/index.js";
import { addFile, backends, createInitializedGitFromFactory } from "./test-helper.js";

describe.each(backends)(
  "V3: DiffFormatter Algorithm Configuration ($name backend)",
  ({ factory }) => {
    let cleanup: (() => Promise<void>) | undefined;

    afterEach(async () => {
      if (cleanup) {
        await cleanup();
        cleanup = undefined;
      }
    });

    async function createInitializedGit() {
      const result = await createInitializedGitFromFactory(factory);
      cleanup = result.cleanup;
      return result;
    }

    it("should accept algorithm option in constructor", async () => {
      const { repository } = await createInitializedGit();

      // Create with Myers
      const myersFormatter = new DiffFormatter(repository.blobs, {
        algorithm: SupportedAlgorithm.MYERS,
      });
      expect(myersFormatter).toBeDefined();

      // Create with Histogram
      const histogramFormatter = new DiffFormatter(repository.blobs, {
        algorithm: SupportedAlgorithm.HISTOGRAM,
      });
      expect(histogramFormatter).toBeDefined();
    });

    it("should use default algorithm when not specified", async () => {
      const { repository } = await createInitializedGit();

      // Create without algorithm option
      const formatter = new DiffFormatter(repository.blobs);
      expect(formatter).toBeDefined();

      // The formatter should work correctly with default algorithm
    });

    it("should produce valid output with different algorithms", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Add a file
      await addFile(workingCopy, "test.txt", "line 1\nline 2\nline 3\n");
      await git.commit().setMessage("add file").call();

      // Modify the file
      await addFile(workingCopy, "test.txt", "line 1\nmodified line 2\nline 3\n");
      await git.commit().setMessage("modify file").call();

      // Get the diff
      const entries = await git.diff().setOldTree("HEAD~1").setNewTree("HEAD").call();
      expect(entries.length).toBe(1);

      // Format with Myers
      const myersFormatter = new DiffFormatter(repository.blobs, {
        algorithm: SupportedAlgorithm.MYERS,
      });
      const myersDiff = await myersFormatter.format(entries[0]);
      expect(myersDiff.hunks.length).toBeGreaterThan(0);

      // Format with Histogram
      const histogramFormatter = new DiffFormatter(repository.blobs, {
        algorithm: SupportedAlgorithm.HISTOGRAM,
      });
      const histogramDiff = await histogramFormatter.format(entries[0]);
      expect(histogramDiff.hunks.length).toBeGreaterThan(0);

      // Both should produce valid results
      expect(myersDiff.isBinary).toBe(false);
      expect(histogramDiff.isBinary).toBe(false);
    });
  },
);

describe.each(backends)(
  "V4: BlameCommand Algorithm Configuration ($name backend)",
  ({ factory }) => {
    let cleanup: (() => Promise<void>) | undefined;

    afterEach(async () => {
      if (cleanup) {
        await cleanup();
        cleanup = undefined;
      }
    });

    async function createInitializedGit() {
      const result = await createInitializedGitFromFactory(factory);
      cleanup = result.cleanup;
      return result;
    }

    it("should have setAlgorithm method", async () => {
      const { workingCopy } = await createInitializedGit();

      const blameCommand = Git.fromWorkingCopy(workingCopy).blame();
      expect(typeof blameCommand.setAlgorithm).toBe("function");
    });

    it("should accept algorithm via setAlgorithm", async () => {
      const { workingCopy } = await createInitializedGit();

      const blameCommand = Git.fromWorkingCopy(workingCopy).blame();

      // Set Myers
      const withMyers = blameCommand.setAlgorithm(SupportedAlgorithm.MYERS);
      expect(withMyers).toBe(blameCommand); // Should return this for chaining

      // Set Histogram
      const withHistogram = blameCommand.setAlgorithm(SupportedAlgorithm.HISTOGRAM);
      expect(withHistogram).toBe(blameCommand);
    });

    it("should produce valid blame output with different algorithms", async () => {
      const { git, workingCopy } = await createInitializedGit();

      // Add a file
      await addFile(workingCopy, "test.txt", "line 1\nline 2\nline 3\n");
      await git.commit().setMessage("initial commit").call();

      // Test blame with Myers
      const myersBlame = await git
        .blame()
        .setFilePath("test.txt")
        .setAlgorithm(SupportedAlgorithm.MYERS)
        .call();
      expect(myersBlame.lineCount).toBe(3);
      expect(myersBlame.entries.length).toBeGreaterThan(0);

      // Test blame with Histogram
      const histogramBlame = await git
        .blame()
        .setFilePath("test.txt")
        .setAlgorithm(SupportedAlgorithm.HISTOGRAM)
        .call();
      expect(histogramBlame.lineCount).toBe(3);
      expect(histogramBlame.entries.length).toBeGreaterThan(0);

      // Both should attribute all lines to the same commit
      expect(myersBlame.getEntry(1)?.commitId).toBe(histogramBlame.getEntry(1)?.commitId);
      expect(myersBlame.getEntry(2)?.commitId).toBe(histogramBlame.getEntry(2)?.commitId);
      expect(myersBlame.getEntry(3)?.commitId).toBe(histogramBlame.getEntry(3)?.commitId);
    });

    it("should use default algorithm when not specified", async () => {
      const { git, workingCopy } = await createInitializedGit();

      // Add a file
      await addFile(workingCopy, "test.txt", "line 1\n");
      await git.commit().setMessage("initial").call();

      // Blame without setting algorithm
      const blameResult = await git.blame().setFilePath("test.txt").call();

      expect(blameResult.lineCount).toBe(1);
      expect(blameResult.getEntry(1)).toBeDefined();
    });
  },
);

describe("V5: End-to-end Algorithm Verification for Commands", () => {
  it("should verify SupportedAlgorithm enum is accessible", () => {
    expect(SupportedAlgorithm.MYERS).toBe("myers");
    expect(SupportedAlgorithm.HISTOGRAM).toBe("histogram");
  });
});
