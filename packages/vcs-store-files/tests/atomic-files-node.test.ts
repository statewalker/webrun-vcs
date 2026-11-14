import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAtomicFilesTests } from "@statewalker/vcs-testing";
import { createNodeAtomicFiles } from "@statewalker/vcs-utils-node/files";

createAtomicFilesTests("Node", async () => {
  const root = mkdtempSync(join(tmpdir(), "atomic-files-"));
  return {
    files: createNodeAtomicFiles(root),
    cleanup: async () => rmSync(root, { recursive: true, force: true }),
  };
});
