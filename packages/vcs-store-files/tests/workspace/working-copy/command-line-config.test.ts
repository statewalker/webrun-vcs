/**
 * The command line's configuration (`GitHostEnvironment.commandLineConfig`) in the config
 * chain: read last in scope `command` (do_git_config_sequence), its includes followed
 * (handle_path_include: a relative one is fatal, a `gitdir:./` condition false), never
 * written, left out where `commandLine: false` or `withoutCommandLineConfig` say so, and
 * fatal when git could not parse it. (Native twins in vcs-commands'
 * command-line-config-native test.)
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import type { GitHostEnvironment } from "@statewalker/vcs-working-tree";
import { withoutCommandLineConfig } from "@statewalker/vcs-working-tree";
import { describe, expect, it } from "vitest";
import { createGitFilesBackend, FileWorktree } from "../../../src/index.js";
import { readProtectedConfig } from "../../../src/safety/index.js";
import {
  CommandLineConfigError,
  GitWorkingCopyConfig,
  showOrigin,
} from "../../../src/workspace/working-copy/index.js";

function memory(files: Record<string, string>) {
  const enc = new TextEncoder();
  return {
    read: async (path: string) => (path in files ? enc.encode(files[path]) : undefined),
    write: async (path: string, content: Uint8Array) => {
      files[path] = new TextDecoder().decode(content);
    },
  };
}

function hostOf(files: Record<string, string>, over: Partial<GitHostEnvironment> = {}) {
  return { readFile: memory(files).read, home: "/home/u", ...over } as GitHostEnvironment;
}

describe("command-line config in the chain", () => {
  it("comes last, in scope command, after config.worktree", async () => {
    const repo: Record<string, string> = {
      ".git/config": "[core]\n\tautocrlf = input\n[extensions]\n\tworktreeConfig = true\n",
      ".git/config.worktree": "[core]\n\tautocrlf = false\n",
    };
    const environment = hostOf(
      { "/home/u/.gitconfig": "[core]\n\tautocrlf = true\n" },
      {
        commandLineConfig: [
          { key: "core.autocrlf", value: "true" },
          { key: "flag.alone", value: undefined },
        ],
      },
    );
    const config = new GitWorkingCopyConfig(memory(repo), ".git/config", { environment });
    await config.load();
    expect(config.getAll("core.autocrlf")).toEqual([true, "input", false, true]);
    expect(config.get("core.autocrlf")).toBe(true);
    expect(config.get("flag.alone")).toBe(true);
    const listed = config.listWithOrigin().map((e) => `${e.scope}\t${showOrigin(e)}\t${e.key}`);
    expect(listed.slice(-2)).toEqual([
      "command\tcommand line:\tcore.autocrlf",
      "command\tcommand line:\tflag.alone",
    ]);
    expect(config.listWithOrigin().at(-1)).toEqual({
      key: "flag.alone",
      value: true,
      text: undefined,
      scope: "command",
    });
    // a write keeps the command line out of the file, and it still wins after it
    config.set("core.autocrlf", "input");
    await config.save();
    expect(repo[".git/config"]).not.toContain("flag");
    expect(config.get("core.autocrlf")).toBe(true);
    expect(config.getLocal("core.autocrlf")).toEqual(["input"]);
  });

  it("follows includes of the command line: absolute and ~/ paths, scope command", async () => {
    const host = {
      "/etc/inc.cfg": "[foo]\n\tbar = abs\n",
      "/home/u/inc.cfg": "[foo]\n\tbaz = home\n",
      "/home/u/c.cfg": "[cond]\n\tx = 1\n",
    };
    const environment = hostOf(host, {
      commandLineConfig: [
        { key: "include.path", value: "/etc/inc.cfg" },
        { key: "include.path", value: "~/inc.cfg" },
        { key: "includeif.gitdir:/work/**.path", value: "/home/u/c.cfg" },
        { key: "includeif.gitdir:./.path", value: "/home/u/c.cfg" },
        { key: "after.include", value: "1" },
      ],
    });
    // 2.43: the relative condition of the command line never holds (2.5x: see below)
    const config = new GitWorkingCopyConfig(memory({}), ".git/config", {
      environment,
      gitDirPath: "/work/p/.git",
      compatibility: "2.43",
    });
    await config.load();
    expect(config.loadErrors).toEqual([
      "error: relative config include conditionals must come from files",
    ]);
    expect(config.get("foo.bar")).toBe("abs");
    expect(config.get("foo.baz")).toBe("home");
    expect(config.getAll("cond.x")).toEqual([1]);
    const listed = config.listWithOrigin().map((e) => `${e.scope}\t${showOrigin(e)}\t${e.key}`);
    expect(listed).toEqual([
      "command\tcommand line:\tinclude.path",
      "command\tfile:/etc/inc.cfg\tfoo.bar",
      "command\tcommand line:\tinclude.path",
      "command\tfile:/home/u/inc.cfg\tfoo.baz",
      "command\tcommand line:\tincludeif.gitdir:/work/**.path",
      "command\tfile:/home/u/c.cfg\tcond.x",
      "command\tcommand line:\tincludeif.gitdir:./.path",
      "command\tcommand line:\tafter.include",
    ]);
  });

  it("refuses a relative include of the command line as git dies", async () => {
    const environment = hostOf({}, { commandLineConfig: [{ key: "include.path", value: "x" }] });
    const config = new GitWorkingCopyConfig(memory({}), ".git/config", { environment });
    const error = await config.load().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(CommandLineConfigError);
    expect((error as Error).message).toBe(
      "error: relative config includes must come from files\nfatal: unable to parse command-line config",
    );
  });

  it("throws the environment's parse error once the files are read", async () => {
    const message = "error: bogus config parameter: =x\nfatal: unable to parse command-line config";
    const environment = hostOf({}, { commandLineConfigError: message });
    const config = new GitWorkingCopyConfig(memory({}), ".git/config", { environment });
    await expect(config.load()).rejects.toThrow(message);
    // a file git cannot parse dies first
    const broken = new GitWorkingCopyConfig(memory({ ".git/config": "[core\n" }), ".git/config", {
      environment,
    });
    await expect(broken.load()).rejects.toThrow("bad config line 1");
  });

  it("is left out with commandLine: false, and by withoutCommandLineConfig", async () => {
    const environment = hostOf(
      {},
      {
        commandLineConfig: [{ key: "a.b", value: "1" }],
        commandLineConfigError: undefined,
      },
    );
    const off = new GitWorkingCopyConfig(memory({}), ".git/config", {
      environment,
      commandLine: false,
    });
    await off.load();
    expect(off.get("a.b")).toBeUndefined();
    const stripped = withoutCommandLineConfig(environment);
    expect(stripped.commandLineConfig).toBeUndefined();
    expect(stripped.home).toBe("/home/u");
    const local = new GitWorkingCopyConfig(memory({}), ".git/config", { environment: stripped });
    await local.load();
    expect(local.get("a.b")).toBeUndefined();
    // a class instance keeps its methods
    class Host {
      home = "/h";
      commandLineConfig = [{ key: "a.b", value: "1" }];
      async readFile() {
        return undefined;
      }
    }
    const instance = withoutCommandLineConfig(new Host() as unknown as GitHostEnvironment);
    expect(instance.commandLineConfig).toBeUndefined();
    expect(await instance.readFile("/x")).toBeUndefined();
    expect(instance.home).toBe("/h");
    expect(withoutCommandLineConfig(undefined)).toBeUndefined();
  });

  it("the protected configuration follows the command line's includes", async () => {
    const environment = hostOf(
      { "/etc/safe.cfg": "[safe]\n\tdirectory = /srv/x\n" },
      {
        commandLineConfig: [
          { key: "include.path", value: "/etc/safe.cfg" },
          { key: "safe.directory", value: "/srv/y" },
        ],
      },
    );
    const entries = await readProtectedConfig(environment);
    expect(entries).toEqual([
      { key: "include.path", value: "/etc/safe.cfg", scope: "command" },
      { key: "safe.directory", value: "/srv/x", scope: "command", file: "/etc/safe.cfg", line: 2 },
      { key: "safe.directory", value: "/srv/y", scope: "command" },
    ]);
  });
});

describe("Worktree.openRepository and the command line", () => {
  it("applies it by default (a server's own -c), not with commandLineConfig: false", async () => {
    const T = realpathSync(mkdtempSync(join(tmpdir(), "open-cmdline-")));
    try {
      execFileSync("git", ["init", "-q", "--bare", join(T, "r.git")], {
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", HOME: T },
      });
      execFileSync("git", ["init", "-q", join(T, "w")], {
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", HOME: T },
      });
      const files = createNodeFilesApi({ rootDir: "/" });
      const { history } = await createGitFilesBackend({ files, gitDir: `${T}/w/.git` });
      const worktree = new FileWorktree({
        files,
        rootPath: `${T}/w`,
        gitDir: `${T}/w/.git`,
        blobs: history.blobs,
        trees: history.trees,
        environment: {
          readFile: async () => undefined,
          commandLineConfig: [{ key: "uploadpack.hiderefs", value: "refs/x" }],
        },
      });
      const served = await worktree.openRepository(join(T, "r.git"));
      expect(served?.config?.getAll("uploadpack.hiderefs")).toEqual(["refs/x"]);
      expect(served?.config?.listWithOrigin?.().at(-1)).toEqual({
        key: "uploadpack.hiderefs",
        value: "refs/x",
        scope: "command",
      });
      const local = await worktree.openRepository(join(T, "r.git"), { commandLineConfig: false });
      expect(local?.config?.getAll("uploadpack.hiderefs")).toEqual([]);
    } finally {
      rmSync(T, { recursive: true, force: true });
    }
  });
});
