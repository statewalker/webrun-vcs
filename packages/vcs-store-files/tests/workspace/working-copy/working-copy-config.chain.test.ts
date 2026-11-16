/**
 * The configuration chain of `GitWorkingCopyConfig` over in-memory files: global files from
 * the host environment, `include.path`, `includeIf` (`onbranch:`, `gitdir:`), `config.worktree`,
 * and writes that touch only the repository's own file. (Native-git twins of the same
 * behaviour are in `@statewalker/vcs-commands`' config-chain-native test.)
 */
import { describe, expect, it } from "vitest";
import { GitWorkingCopyConfig } from "../../../src/workspace/working-copy/index.js";

function memory(files: Record<string, string>) {
  const enc = new TextEncoder();
  return {
    read: async (path: string) => (path in files ? enc.encode(files[path]) : undefined),
    write: async (path: string, content: Uint8Array) => {
      files[path] = new TextDecoder().decode(content);
    },
  };
}

describe("GitWorkingCopyConfig chain", () => {
  it("reads global, own and included values in git's order; writes only its own file", async () => {
    const home: Record<string, string> = {
      "/home/u/.gitconfig":
        "[core]\n\tautocrlf = true\n\teol = crlf\n[include]\n\tpath = ~/more.cfg\n",
      "/home/u/more.cfg": "[user]\n\tname = Home\n",
      "/home/u/.config/git/config": "[core]\n\teol = lf\n\tsafecrlf = warn\n",
    };
    const repo: Record<string, string> = {
      ".git/HEAD": "ref: refs/heads/topic/a\n",
      ".git/config":
        "[core]\n\tautocrlf = input\n[include]\n\tpath = local.cfg\n[core]\n\tsafecrlf = false\n" +
        '[includeIf "onbranch:topic/"]\n\tpath = topic.cfg\n' +
        '[includeIf "onbranch:main"]\n\tpath = main.cfg\n' +
        '[includeIf "gitdir:/work/"]\n\tpath = work.cfg\n' +
        "[extensions]\n\tworktreeConfig = true\n",
      ".git/local.cfg": "[core]\n\tsafecrlf = true\n\tignorecase = true\n",
      ".git/topic.cfg": "[test]\n\tbranch = topic\n",
      ".git/main.cfg": "[test]\n\tbranch = main\n",
      ".git/work.cfg": "[test]\n\twork = yes\n",
      ".git/config.worktree": "[core]\n\tautocrlf = false\n",
    };
    const homeFiles = memory(home);
    const config = new GitWorkingCopyConfig(memory(repo), ".git/config", {
      environment: { readFile: homeFiles.read, home: "/home/u" },
      gitDirPath: "/work/project/.git",
    });
    await config.load();
    expect(config.get("core.autocrlf")).toBe(false); // config.worktree wins
    expect(config.getAll("core.autocrlf")).toEqual([true, "input", false]);
    expect(config.get("core.eol")).toBe("crlf"); // ~/.gitconfig after the XDG file
    expect(config.get("core.safecrlf")).toBe(false); // after the include, in the file
    expect(config.get("core.ignorecase")).toBe(true);
    expect(config.get("user.name")).toBe("Home");
    expect(config.getAll("test.branch")).toEqual(["topic"]);
    expect(config.get("test.work")).toBe(true);
    expect(config.getLocal("core.autocrlf")).toEqual(["input"]);

    config.set("core.eol", "native");
    await config.save();
    expect(repo[".git/config"]).toContain("[include]\n\tpath = local.cfg\n");
    expect(repo[".git/config"]).toContain("eol = native");
    expect(home["/home/u/.gitconfig"]).not.toContain("native");
    expect(config.get("core.eol")).toBe("native");
    expect(config.get("core.ignorecase")).toBe(true); // the include is still followed
  });

  it("without an environment only the repository's files are read; circular includes fail", async () => {
    const config = new GitWorkingCopyConfig(
      memory({
        ".git/config": "[include]\n\tpath = ~/x.cfg\n\tpath = /abs.cfg\n\tpath = a.cfg\n",
        ".git/a.cfg": "[a]\n\tb = 1\n",
      }),
      ".git/config",
    );
    await config.load();
    expect(config.get("a.b")).toBe(1);
    const loop = new GitWorkingCopyConfig(
      memory({ ".git/config": "[include]\n\tpath = config\n" }),
      ".git/config",
    );
    await expect(loop.load()).rejects.toThrow(/exceeded maximum include depth \(10\)/);
  });
});
