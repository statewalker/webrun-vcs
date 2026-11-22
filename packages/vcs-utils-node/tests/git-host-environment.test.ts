import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInMemoryFilesApi } from "@statewalker/vcs-utils/files";
import { describe, expect, it } from "vitest";
import { commandLineConfigOf, createNodeGitHostEnvironment } from "../src/files/index.js";

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

  it("carries git's author and committer variables and $EMAIL", () => {
    const env = createNodeGitHostEnvironment({
      env: {
        GIT_AUTHOR_NAME: "A",
        GIT_AUTHOR_EMAIL: "a@example.com",
        GIT_AUTHOR_DATE: "@1700000000 +0100",
        GIT_COMMITTER_NAME: "C",
        EMAIL: "me@example.com",
      },
    });
    expect(env.author).toEqual({ name: "A", email: "a@example.com", date: "@1700000000 +0100" });
    expect(env.committer).toEqual({ name: "C" });
    expect(env.defaultEmail).toBe("me@example.com");
    const none = createNodeGitHostEnvironment({ env: {} });
    expect([none.author, none.committer, none.defaultEmail]).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });
});

describe("createNodeGitHostEnvironment: ownership checks and command-line config", () => {
  it("takes the effective uid from the process unless given or turned off", () => {
    const env = createNodeGitHostEnvironment({ env: {} });
    expect(env.effectiveUid).toBe(process.geteuid?.());
    expect(createNodeGitHostEnvironment({ env: {}, effectiveUid: 42 }).effectiveUid).toBe(42);
    expect(createNodeGitHostEnvironment({ env: {}, effectiveUid: null }).effectiveUid).toBe(
      undefined,
    );
    const sudo = createNodeGitHostEnvironment({
      env: { SUDO_UID: "1000", GIT_TEST_ASSUME_DIFFERENT_OWNER: "true" },
    });
    expect(sudo.sudoUid).toBe("1000");
    expect(sudo.assumeDifferentOwner).toBe(true);
    expect(env.prefix).toBe("/usr");
  });

  it("reads GIT_CONFIG_COUNT pairs, then GIT_CONFIG_PARAMETERS, as git passes `-c`", () => {
    expect(
      commandLineConfigOf({
        GIT_CONFIG_COUNT: "2",
        GIT_CONFIG_KEY_0: "Safe.Directory",
        GIT_CONFIG_VALUE_0: "/a",
        GIT_CONFIG_KEY_1: "url.HTTPS://X/.insteadOf",
        GIT_CONFIG_VALUE_1: "x:",
        GIT_CONFIG_PARAMETERS: "'safe.directory=/b' 'safe.directory'='/it'\\''s' 'core.bare'",
      }),
    ).toEqual([
      { key: "safe.directory", value: "/a" },
      { key: "url.HTTPS://X/.insteadof", value: "x:" },
      { key: "safe.directory", value: "/b" },
      { key: "safe.directory", value: "/it's" },
      { key: "core.bare", value: undefined },
    ]);
    // a missing pair or a bogus count gives nothing of that variable
    expect(
      commandLineConfigOf({
        GIT_CONFIG_COUNT: "2",
        GIT_CONFIG_KEY_0: "a.b",
        GIT_CONFIG_VALUE_0: "1",
      }),
    ).toEqual([]);
    expect(commandLineConfigOf({ GIT_CONFIG_COUNT: "x" })).toEqual([]);
    expect(commandLineConfigOf({ GIT_CONFIG_PARAMETERS: "safe.directory=/x" })).toEqual([]);
  });
});
