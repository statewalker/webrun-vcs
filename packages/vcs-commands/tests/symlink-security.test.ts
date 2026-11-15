/**
 * The symbolic-link security suite against every link-aware FilesApi: a real directory
 * (`PosixNodeFilesApi`), simulated links over memory (`createSymlinkFilesApi`), and simulated
 * links over a composite of two memory FilesApis (`createMountedFilesApi`).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createInMemoryFilesApi,
  createMountedFilesApi,
  createSymlinkFilesApi,
} from "@statewalker/vcs-core";
import { PosixNodeFilesApi } from "@statewalker/vcs-utils-node/files";

import { describeSymlinkSecurity } from "./symlink-security.suite.js";

const tempDir = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: async () => rmSync(dir, { recursive: true, force: true }) };
};

describeSymlinkSecurity({
  name: "PosixNodeFilesApi",
  create: async () => {
    const { dir, cleanup } = tempDir("links-node-");
    return { files: new PosixNodeFilesApi({ rootDir: dir }), cleanup };
  },
  windows: async () => {
    const { dir, cleanup } = tempDir("links-node-win-");
    return { files: new PosixNodeFilesApi({ rootDir: dir, platform: "win32" }), cleanup };
  },
});

describeSymlinkSecurity({
  name: "createSymlinkFilesApi over memory",
  create: async () => ({
    files: createSymlinkFilesApi(createInMemoryFilesApi()),
    cleanup: async () => {},
  }),
  windows: async () => ({
    files: createSymlinkFilesApi(createInMemoryFilesApi(), { pathSeparators: "/\\" }),
    cleanup: async () => {},
  }),
  caseInsensitive: async () => ({
    files: createSymlinkFilesApi(createInMemoryFilesApi(), {
      ignoreCase: true,
      precomposeUnicode: true,
    }),
    cleanup: async () => {},
  }),
});

describeSymlinkSecurity({
  name: "createSymlinkFilesApi over a mounted composite",
  create: async () => ({
    // the worktree on one memory FilesApi, everything else on another
    files: createSymlinkFilesApi(
      createMountedFilesApi(createInMemoryFilesApi(), { "/repo": createInMemoryFilesApi() }),
    ),
    cleanup: async () => {},
  }),
});
