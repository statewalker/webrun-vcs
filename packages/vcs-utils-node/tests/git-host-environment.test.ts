import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInMemoryFilesApi } from "@statewalker/vcs-utils/files";
import { describe, expect, it } from "vitest";
import { createNodeGitHostEnvironment } from "../src/files/index.js";

describe("createNodeGitHostEnvironment", () => {
  it("reads host files by absolute path through a Node FilesApi", async () => {
    const dir = await mkdtemp(join(tmpdir(), "host-env-"));
    try {
      await writeFile(join(dir, ".gitconfig"), "[core]\n\tautocrlf = input\n");
      const env = createNodeGitHostEnvironment({ home: dir, env: {} });
      const bytes = await env.readFile(join(dir, ".gitconfig"));
      expect(new TextDecoder().decode(bytes)).toContain("autocrlf = input");
      expect(await env.readFile(join(dir, "missing"))).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reads from the FilesApi it is given", async () => {
    const files = createInMemoryFilesApi();
    await files.write("/home/u/.gitconfig", [new TextEncoder().encode("[user]\n")]);
    const env = createNodeGitHostEnvironment({ home: "/home/u", env: {}, files });
    expect(new TextDecoder().decode(await env.readFile("/home/u/.gitconfig"))).toBe("[user]\n");
    expect(await env.readFile("/etc/gitconfig")).toBeUndefined();
    expect(env.systemConfig).toBe("/etc/gitconfig");
  });

  it("follows symbolic links, as git reads these files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "host-env-"));
    try {
      await mkdir(join(dir, "dotfiles", "git"), { recursive: true });
      await writeFile(join(dir, "dotfiles", "gitconfig"), "[a]\n");
      await writeFile(join(dir, "dotfiles", "git", "config"), "[b]\n");
      await symlink(join(dir, "dotfiles", "gitconfig"), join(dir, ".gitconfig"));
      await symlink(join(dir, "dotfiles"), join(dir, ".config"));
      const env = createNodeGitHostEnvironment({ home: dir, env: {} });
      const text = async (path: string) => new TextDecoder().decode(await env.readFile(path));
      expect(await text(join(dir, ".gitconfig"))).toBe("[a]\n");
      expect(await text(join(dir, ".config", "git", "config"))).toBe("[b]\n");
      expect(await env.readFile(join(dir, ".config"))).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reads a relative path from the current directory", async () => {
    const env = createNodeGitHostEnvironment({ env: {} });
    const bytes = await env.readFile("package.json");
    expect(new TextDecoder().decode(bytes)).toContain("@statewalker/vcs-utils-node");
  });
});
