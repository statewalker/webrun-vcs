import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAtomicFilesTests } from "@statewalker/vcs-testing";
import { createNodeAtomicFiles } from "../src/files/index.js";

createAtomicFilesTests("Node", async () => {
  const root = mkdtempSync(join(tmpdir(), "atomic-files-"));
  return {
    files: createNodeAtomicFiles(root),
    cleanup: async () => rmSync(root, { recursive: true, force: true }),
  };
});
