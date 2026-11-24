/**
 * GitWorkingCopyConfig <-> native git interoperability tests.
 *
 * Both directions matter:
 * - a config this class writes must be readable by real `git`
 * - a config real `git` wrote must load (and survive a re-save) through this class
 *
 * git is invoked via execFile (no shell) with the global/system config disabled
 * and LC_ALL=C, so results do not depend on the developer's machine.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { type ConfigFilesApi, GitWorkingCopyConfig } from "@statewalker/vcs-store-files";
import { parseGitBool } from "@statewalker/vcs-utils";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  LC_ALL: "C",
};

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, env: GIT_ENV, encoding: "utf-8" });
  // strip only git's final newline: trailing spaces can be part of a value
  return stdout.replace(/\n$/, "");
}

/**
 * ConfigFilesApi backed by the real Node FilesApi implementation
 * (@statewalker/vcs-utils-node), so the bytes on disk are produced by the
 * same path production code would use.
 */
function createConfigFiles(rootDir: string): ConfigFilesApi {
  const files = createNodeFilesApi({ rootDir });
  return {
    async read(p: string): Promise<Uint8Array | undefined> {
      const chunks: Uint8Array[] = [];
      try {
        for await (const chunk of files.read(p)) chunks.push(chunk);
      } catch {
        return undefined;
      }
      if (chunks.length === 0) return new Uint8Array(0);
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const out = new Uint8Array(total);
      let at = 0;
      for (const c of chunks) {
        out.set(c, at);
        at += c.length;
      }
      return out;
    },
    async write(p: string, content: Uint8Array): Promise<void> {
      await files.write(p, [content]);
    },
  };
}

describe("GitWorkingCopyConfig <-> native git", () => {
  let testDir: string;
  let repoDir: string;
  let files: ConfigFilesApi;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "vcs-config-interop-"));
    repoDir = path.join(testDir, "repo");
    await fs.mkdir(repoDir);
    await git(["init", "-q"], repoDir);
    // FilesApi paths are relative to repoDir
    files = createConfigFiles(repoDir);
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  function openConfig(): GitWorkingCopyConfig {
    return new GitWorkingCopyConfig(files, ".git/config");
  }

  describe("we write -> git reads", () => {
    it("git resolves a remote we added", async () => {
      const config = openConfig();
      await config.load();
      config.set("remote.origin.url", "https://github.com/statewalker/vcs.git");
      config.set("remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
      await config.save();

      expect(await git(["config", "--get", "remote.origin.url"], repoDir)).toBe(
        "https://github.com/statewalker/vcs.git",
      );
      expect(await git(["remote"], repoDir)).toBe("origin");
      expect(await git(["remote", "-v"], repoDir)).toBe(
        "origin\thttps://github.com/statewalker/vcs.git (fetch)\n" +
          "origin\thttps://github.com/statewalker/vcs.git (push)",
      );
    });

    it("git reads back values with spaces and comment characters", async () => {
      const config = openConfig();
      await config.load();
      config.set("user.name", "Test User");
      config.set("user.email", "test@example.com");
      config.set("alias.hashy", "log --format=%h #1");
      config.set("alias.spacey", "  padded  ");
      config.set("alias.quoted", 'echo "hi"');
      config.set("alias.backslash", "C:\\path\\to");
      await config.save();

      expect(await git(["config", "--get", "user.name"], repoDir)).toBe("Test User");
      expect(await git(["config", "--get", "alias.hashy"], repoDir)).toBe("log --format=%h #1");
      expect(await git(["config", "--get", "alias.spacey"], repoDir)).toBe("  padded  ");
      expect(await git(["config", "--get", "alias.quoted"], repoDir)).toBe('echo "hi"');
      expect(await git(["config", "--get", "alias.backslash"], repoDir)).toBe("C:\\path\\to");
    });

    it("git keeps every value of a multivar we wrote", async () => {
      const config = openConfig();
      await config.load();
      config.set("remote.origin.url", "https://example.com/x.git");
      config.set("remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
      config.add("remote.origin.fetch", "+refs/tags/*:refs/tags/*");
      await config.save();

      expect(await git(["config", "--get-all", "remote.origin.fetch"], repoDir)).toBe(
        "+refs/heads/*:refs/remotes/origin/*\n+refs/tags/*:refs/tags/*",
      );
    });

    it("git keeps the settings it wrote at init time", async () => {
      const before = await git(["config", "--get", "core.repositoryformatversion"], repoDir);
      const config = openConfig();
      await config.load();
      config.set("remote.origin.url", "https://example.com/x.git");
      await config.save();

      expect(await git(["config", "--get", "core.repositoryformatversion"], repoDir)).toBe(before);
      expect(await git(["config", "--get", "core.bare"], repoDir)).toBe("false");
    });

    it("git reads a subsection containing a space", async () => {
      const config = openConfig();
      await config.load();
      config.set("remote.up stream.url", "https://example.com/u.git");
      await config.save();

      expect(await git(["config", "--get", "remote.up stream.url"], repoDir)).toBe(
        "https://example.com/u.git",
      );
    });

    it("git preserves the case of a subsection we wrote", async () => {
      const config = openConfig();
      await config.load();
      config.set("remote.Origin.url", "https://example.com/upper.git");
      await config.save();

      expect(await git(["config", "--get", "remote.Origin.url"], repoDir)).toBe(
        "https://example.com/upper.git",
      );
      await expect(git(["config", "--get", "remote.origin.url"], repoDir)).rejects.toThrow();
    });

    it("git does not reinterpret a zero-padded number", async () => {
      const config = openConfig();
      await config.load();
      config.set("user.name", "007");
      await config.save();

      expect(await git(["config", "--get", "user.name"], repoDir)).toBe("007");
    });
  });

  describe("git writes -> we read", () => {
    it("loads a remote added by git", async () => {
      await git(["remote", "add", "origin", "https://github.com/statewalker/vcs.git"], repoDir);

      const config = openConfig();
      await config.load();

      expect(config.get("remote.origin.url")).toBe("https://github.com/statewalker/vcs.git");
      expect(config.get("remote.origin.fetch")).toBe("+refs/heads/*:refs/remotes/origin/*");
    });

    it("loads every value of a multivar written by git", async () => {
      await git(["remote", "add", "origin", "https://example.com/x.git"], repoDir);
      await git(["config", "--add", "remote.origin.fetch", "+refs/tags/*:refs/tags/*"], repoDir);

      const config = openConfig();
      await config.load();

      expect(config.getAll("remote.origin.fetch")).toEqual([
        "+refs/heads/*:refs/remotes/origin/*",
        "+refs/tags/*:refs/tags/*",
      ]);
    });

    it("loads values with spaces and quotes written by git", async () => {
      await git(["config", "user.name", "Test User"], repoDir);
      await git(["config", "alias.quoted", 'echo "hi"'], repoDir);
      await git(["config", "alias.spacey", "  padded  "], repoDir);

      const config = openConfig();
      await config.load();

      expect(config.get("user.name")).toBe("Test User");
      expect(config.get("alias.quoted")).toBe('echo "hi"');
      expect(config.get("alias.spacey")).toBe("  padded  ");
    });

    it("loads the config git init wrote", async () => {
      const config = openConfig();
      await config.load();

      expect(config.get("core.repositoryformatversion")).toBe(0);
      expect(config.get("core.bare")).toBe(false);
    });
  });

  describe("round-trip through both", () => {
    it("git can still read a config we re-saved after git wrote it", async () => {
      await git(["remote", "add", "origin", "https://example.com/x.git"], repoDir);
      await git(["config", "--add", "remote.origin.fetch", "+refs/tags/*:refs/tags/*"], repoDir);
      await git(["config", "user.name", "Test User"], repoDir);

      const config = openConfig();
      await config.load();
      config.set("branch.main.remote", "origin");
      config.set("branch.main.merge", "refs/heads/main");
      await config.save();

      expect(await git(["config", "--get", "remote.origin.url"], repoDir)).toBe(
        "https://example.com/x.git",
      );
      expect(await git(["config", "--get-all", "remote.origin.fetch"], repoDir)).toBe(
        "+refs/heads/*:refs/remotes/origin/*\n+refs/tags/*:refs/tags/*",
      );
      expect(await git(["config", "--get", "user.name"], repoDir)).toBe("Test User");
      expect(await git(["config", "--get", "branch.main.remote"], repoDir)).toBe("origin");
      expect(await git(["remote", "-v"], repoDir)).toContain("https://example.com/x.git");
    });

    it("preserves a hand-written comment across our save", async () => {
      const configPath = path.join(repoDir, ".git", "config");
      const original = await fs.readFile(configPath, "utf-8");
      await fs.writeFile(
        configPath,
        `# hand written header\n${original}[remote "origin"]\n\t; where it lives\n\turl = https://example.com/x.git\n`,
      );

      const config = openConfig();
      await config.load();
      config.set("user.name", "Test User");
      await config.save();

      const after = await fs.readFile(configPath, "utf-8");
      expect(after).toContain("# hand written header");
      expect(after).toContain("; where it lives");
      expect(await git(["config", "--get", "remote.origin.url"], repoDir)).toBe(
        "https://example.com/x.git",
      );
      expect(await git(["config", "--get", "user.name"], repoDir)).toBe("Test User");
    });

    it("git's own view of the file is unchanged by a no-op save", async () => {
      await git(["remote", "add", "origin", "https://example.com/x.git"], repoDir);
      await git(["config", "user.name", "Test User"], repoDir);
      const before = await git(["config", "--list"], repoDir);

      const config = openConfig();
      await config.load();
      await config.save();

      expect(await git(["config", "--list"], repoDir)).toBe(before);
    });

    it("git accepts a config written from scratch by this class", async () => {
      const scratchDir = path.join(testDir, "scratch");
      await fs.mkdir(path.join(scratchDir, ".git"), { recursive: true });
      const scratchFiles = createConfigFiles(scratchDir);
      const config = new GitWorkingCopyConfig(scratchFiles, ".git/config");
      config.set("core.repositoryformatversion", 0);
      config.set("core.bare", false);
      config.set("remote.origin.url", "https://example.com/x.git");
      config.set("remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
      await config.save();
      // minimal .git for git to accept the directory
      await fs.writeFile(path.join(scratchDir, ".git", "HEAD"), "ref: refs/heads/main\n");
      await fs.mkdir(path.join(scratchDir, ".git", "refs", "heads"), { recursive: true });
      await fs.mkdir(path.join(scratchDir, ".git", "objects"), { recursive: true });

      expect(await git(["config", "--get", "remote.origin.url"], scratchDir)).toBe(
        "https://example.com/x.git",
      );
      expect(await git(["remote"], scratchDir)).toBe("origin");
    });
  });

  describe("unsetting, as git config --unset-all and --add write it", () => {
    /** Applies `edit` to `content` through ours and `gitArgs` through native git; same bytes. */
    async function both(
      content: string,
      edit: (config: GitWorkingCopyConfig) => void,
      gitArgs: string[][],
    ): Promise<void> {
      const ours = path.join(repoDir, ".git", "config");
      const native = path.join(testDir, "native-config");
      await fs.writeFile(ours, content);
      await fs.writeFile(native, content);
      const config = openConfig();
      await config.load();
      edit(config);
      await config.save();
      for (const args of gitArgs) await git(["config", "-f", native, ...args], testDir);
      expect(await fs.readFile(ours, "latin1")).toBe(await fs.readFile(native, "latin1"));
    }

    it("removes a section left empty, with the blank lines before it", async () => {
      await both("[b]\n\ty = 2\n\n[a]\n\tx = 1\n\tx = 2\n\n[c]\n\tz = 3\n", (c) => c.unset("a.x"), [
        ["--unset-all", "a.x"],
      ]);
    });

    it("keeps a section with a comment in it or right before it", async () => {
      await both("[a]\n\tx = 1\n\t# note\n[b]\n\ty = 2\n", (c) => c.unset("a.x"), [
        ["--unset-all", "a.x"],
      ]);
      await both("# about a\n[a]\n\tx = 1\n[b]\n\ty = 2\n", (c) => c.unset("a.x"), [
        ["--unset-all", "a.x"],
      ]);
    });

    it("keeps a section that still has variables", async () => {
      await both("[a]\n\tx = 1\n\ty = 2\n", (c) => c.unset("a.x"), [["--unset-all", "a.x"]]);
    });

    it("writes a key unset and added again at its section's end", async () => {
      await both(
        '[branch "x"]\n\tmerge = refs/heads/old\n\trebase = true\n[core]\n\tbare = false\n',
        (c) => {
          c.set("branch.x.remote", "origin");
          c.unset("branch.x.merge");
          c.add("branch.x.merge", "refs/heads/a");
          c.add("branch.x.merge", "refs/heads/b");
        },
        [
          ["branch.x.remote", "origin"],
          ["--unset-all", "branch.x.merge"],
          ["--add", "branch.x.merge", "refs/heads/a"],
          ["--add", "branch.x.merge", "refs/heads/b"],
        ],
      );
    });

    it("keeps a section whose header line carries a comment", async () => {
      await both(
        '[core]\n\tbare = false\n[branch "topic"] # PR 42 review notes\n\tremote = origin\n\tmerge = refs/heads/topic\n',
        (c) => {
          c.unset("branch.topic.remote");
          c.unset("branch.topic.merge");
        },
        [
          ["--unset-all", "branch.topic.remote"],
          ["--unset-all", "branch.topic.merge"],
        ],
      );
      await both(
        "[core] ; sparse\n\tsparseCheckout = true\n",
        (c) => c.unset("core.sparseCheckout"),
        [["--unset-all", "core.sparseCheckout"]],
      );
      await both('[a "x]y"] # c\n\tx = 1\n[b]\n\ty = 1\n', (c) => c.unset("a.x]y.x"), [
        ["--unset-all", "a.x]y.x"],
      ]);
    });

    it("treats a run of headers of one section as one section", async () => {
      await both("[a]\n\tx = 1\n[a]\n\ty = 2\n", (c) => c.unset("a.x"), [["--unset-all", "a.x"]]);
      await both("[a]\n\tx = 1\n[a]\n\tx = 2\n[b]\n\ty = 1\n", (c) => c.unset("a.x"), [
        ["--unset-all", "a.x"],
      ]);
      await both("[a] ; c\n\tx = 1\n[a]\n\tx = 2\n", (c) => c.unset("a.x"), [
        ["--unset-all", "a.x"],
      ]);
      await both("[a]\n\tx = 1\n[a] # c\n\tx = 2\n", (c) => c.unset("a.x"), [
        ["--unset-all", "a.x"],
      ]);
      await both("[a]\n\tx = 1\n[b]\n\ty=1\n[a]\n\tz=1\n", (c) => c.unset("a.x"), [
        ["--unset-all", "a.x"],
      ]);
      await both("[a]\n\tx = 1 # c\n[b]\n\ty=1\n", (c) => c.unset("a.x"), [["--unset-all", "a.x"]]);
    });

    it("adds after the removals: to the section left, else a new one at the end", async () => {
      await both(
        "[a]\n\tx = 1\n\ty = 0\n[a]\n\tx = 2\n",
        (c) => {
          c.unset("a.x");
          c.add("a.x", "3");
        },
        [
          ["--unset-all", "a.x"],
          ["--add", "a.x", "3"],
        ],
      );
      await both(
        "[a]\n\tx = 1\n[b]\n\ty=1\n",
        (c) => {
          c.unset("a.x");
          c.add("a.x", "3");
        },
        [
          ["--unset-all", "a.x"],
          ["--add", "a.x", "3"],
        ],
      );
      await both(
        "[a]\n\tx = 1\n[b]\n\ty=1\n",
        (c) => {
          c.unset("a.x");
          c.set("a.z", "2");
        },
        [
          ["--unset-all", "a.x"],
          ["a.z", "2"],
        ],
      );
    });

    it("ends the file with a newline once its last lines are removed", async () => {
      await both("[b]\n\ty=1\n[a]\n\tx = 1", (c) => c.unset("a.x"), [["--unset-all", "a.x"]]);
      await both("[a]\n\ty=1\n\tx = 1", (c) => c.unset("a.x"), [["--unset-all", "a.x"]]);
      await both("[a]\n\tx = 1\n[b]\n\ty=1", (c) => c.unset("a.x"), [["--unset-all", "a.x"]]);
    });
  });

  describe("booleans, as git_config_bool reads them", () => {
    it("a key with no `=` is true, an empty value false, and integers count", async () => {
      const lines = [
        "\tbare",
        "\tempty =",
        '\tquotedEmpty = ""',
        "\tyes = YES",
        "\toff = Off",
        "\thex = 0x10",
        "\thexZero = 0x0",
        "\toctal = 010",
        "\tunit = 1k",
        "\tzeroUnit = 0k",
        "\tplus = +3",
        "\tminusZero = -0",
        '\tleadingBlank = " 1"',
        '\tspacedTrue = " true"',
        "\tnotOctal = 09",
        "\tgarbage = maybe",
      ];
      await fs.writeFile(path.join(repoDir, ".git/config"), `[t]\n${lines.join("\n")}\n`);
      const config = openConfig();
      await config.load();
      for (const line of lines) {
        const key = `t.${line.trim().split(/[ =]/)[0]}`;
        const native = await git(["config", "--bool", key], repoDir).then(
          (out) => out === "true",
          () => undefined,
        );
        expect([key, parseGitBool(config.get(key))]).toEqual([key, native]);
      }
    });

    it("an integer must fit git's int, with its unit (git_parse_int: ERANGE)", async () => {
      const values = [
        "2147483648",
        "-2147483649",
        "4294967296",
        "0x80000000",
        "2g",
        "2048m",
        "2097152k",
        "9223372036854775807",
        "1.5",
        "2147483647",
        "-2147483647",
        "1g",
        "0x7fffffff",
      ];
      const lines = values.map((v, i) => `\tk${i} = ${v}`);
      await fs.writeFile(path.join(repoDir, ".git/config"), `[t]\n${lines.join("\n")}\n`);
      const config = openConfig();
      await config.load();
      const refused = new Set(values.slice(0, 9));
      for (const [i, value] of values.entries()) {
        const key = `t.k${i}`;
        const native = await git(["config", "--bool", key], repoDir).then(
          (out) => out === "true",
          () => undefined,
        );
        expect([value, native]).toEqual([value, refused.has(value) ? undefined : true]);
        expect([value, parseGitBool(config.get(key))]).toEqual([value, native]);
      }
    });
  });
});
