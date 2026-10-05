import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createNodeFilesApi, NodeFilesApi } from "../src/files/index.js";

describe("Node.js Files API", () => {
  describe("createNodeFilesApi", () => {
    it("should create a FilesApi instance", () => {
      const files = createNodeFilesApi({ rootDir: tmpdir() });
      expect(files).toBeDefined();
      expect(files.read).toBeDefined();
      expect(files.write).toBeDefined();
      expect(files.list).toBeDefined();
    });
  });

  describe("NodeFilesApi export", () => {
    it("should export NodeFilesApi class", () => {
      expect(NodeFilesApi).toBeDefined();
      expect(typeof NodeFilesApi).toBe("function");
    });
  });
});
