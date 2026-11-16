/**
 * Which attributes a checkout reads, against native git. git's unpack-trees (branch switch,
 * `reset --hard`, merges, `stash apply`, clone) smudges every file with the attributes of
 * the index it leaves behind (`check_updates` reads `o->result`), whatever order the files
 * are written in; a path checkout (`checkout -- <path>`) reads the worktree's
 * `.gitattributes` first. Also: linked worktrees and the configuration chain they read,
 * conditional includes that follow HEAD, links held as files, and `add --renormalize`.
 *
 * Every repository is built twice (never copied). The branch-switch + stash fuzz runs a few
 * seeds by default; `CHECKOUT_FUZZ_START` / `CHECKOUT_FUZZ_COUNT` run others.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createFileWorktree,
  createGitFilesBackend,
  FileStagingStore,
  GitCheckout,
  type GitCheckoutFilesApi,
  GitWorkingCopyConfig,
  GitWorkingCopyFactory,
} from "@statewalker/vcs-store-files";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { type GitHostEnvironment, MemoryWorkingCopy } from "@statewalker/vcs-working-tree";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { formatStatusPorcelain, Git, ResetMode } from "../src/index.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

const FUZZ_START = Number(process.env.CHECKOUT_FUZZ_START ?? 90000);
const FUZZ_COUNT = Number(process.env.CHECKOUT_FUZZ_COUNT ?? 40);

let root = "";
let home = "";
const run = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    env: nativeGitEnv(home),
    encoding: "latin1",
    stdio: ["ignore", "pipe", "pipe"],
  });
const runResult = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", args, { cwd, env: nativeGitEnv(home), encoding: "latin1" });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};
const put = (dir: string, path: string, content: string) => {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), content);
};
const bytes = (dir: string, path: string) => {
  try {
    return JSON.stringify(readFileSync(join(dir, path)).toString("latin1"));
  } catch {
    return "(missing)";
  }
};

async function open(dir: string, environment?: GitHostEnvironment) {
  const files = createNodeFilesApi({ rootDir: dir });
  const { history } = await createGitFilesBackend({ files });
  const io = {
    read: async (path: string) => {
      try {
        return new Uint8Array(readFileSync(join(dir, path)));
      } catch {
        return undefined;
      }
    },
    write: async (path: string, content: Uint8Array) => writeFileSync(join(dir, path), content),
  };
  const config = new GitWorkingCopyConfig(io, ".git/config", {
    gitDirPath: join(dir, ".git"),
    ...(environment ? { environment } : {}),
  });
  await config.load();
  const staging = new FileStagingStore(files, ".git/index");
  await staging.read();
  const checkout = new GitCheckout({
    staging,
    refs: history.refs,
    files: {
      read: io.read,
      write: (p: string, c: Uint8Array) => files.write(p, [c]),
      stats: async () => undefined,
      remove: async () => {},
    } as unknown as GitCheckoutFilesApi,
    gitDir: ".git",
  });
  const worktree = createFileWorktree({
    files,
    rootPath: "",
    gitDir: ".git",
    blobs: history.blobs,
    trees: history.trees,
  });
  const wc = new MemoryWorkingCopy({ history, checkout, worktree, config });
  return { git: Git.fromWorkingCopy(wc), wc, worktree, config };
}

/** Builds the same repository twice: `native` and `ours`. */
function twins(name: string, build: (dir: string) => void): { native: string; ours: string } {
  const native = join(root, `${name}-native`);
  const ours = join(root, `${name}-ours`);
  for (const dir of [native, ours]) {
    mkdirSync(dir, { recursive: true });
    run(dir, "init", "-q", "-b", "main");
    build(dir);
  }
  return { native, ours };
}

/** The index, git's status and the bytes of `files`, as native git sees them. */
const observe = (dir: string, files: string[]) =>
  [
    run(dir, "ls-files", "-s", "--eol"),
    run(dir, "status", "--porcelain=v1", "-uall"),
    ...files.map((f) => `${f}: ${bytes(dir, f)}`),
  ].join("\n");
const nativeStatus = (dir: string) => run(dir, "status", "--porcelain=v1", "-uall");
async function ourStatus(dir: string) {
  return formatStatusPorcelain(await (await open(dir)).git.status().call(), 1);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "attr-checkout-"));
  home = join(root, "home");
  mkdirSync(home);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describeGit("checkout attributes: the index the checkout leaves, as git", () => {
  it("a branch switch smudges .gitattributes and files sorting before it with the target's rules", async () => {
    const { native, ours } = twins("sort-first", (d) => {
      put(d, ".gitattributes", "*.txt -text\n");
      put(d, "-a.txt", "x\n");
      put(d, "b.txt", "x\n");
      put(d, "s/-c.txt", "x\n");
      put(d, "s/.gitattributes", "*.txt -text\n");
      run(d, "add", ".");
      run(d, "commit", "-qm", "c1");
      run(d, "checkout", "-qb", "b");
      put(d, ".gitattributes", "*.txt eol=crlf\n.gitattributes eol=crlf\n");
      put(d, "s/.gitattributes", "*.txt eol=crlf\n");
      put(d, "-a.txt", "y\n");
      put(d, "b.txt", "y\n");
      put(d, "s/-c.txt", "y\n");
      run(d, "add", ".");
      run(d, "commit", "-qm", "c2");
      run(d, "checkout", "-q", "main");
    });
    run(native, "checkout", "-q", "b");
    await (await open(ours)).git.checkout().setName("b").call();
    const files = [".gitattributes", "-a.txt", "b.txt", "s/-c.txt"];
    expect(observe(ours, files)).toBe(observe(native, files));
    expect(await ourStatus(ours)).toBe(nativeStatus(native));
  });

  it("a .gitattributes written through the worktree does not pin the rules of a later switch", async () => {
    const { native, ours } = twins("written", (d) => {
      put(d, ".gitattributes", "*.txt -text\n");
      put(d, "b.txt", "x\n");
      run(d, "add", ".");
      run(d, "commit", "-qm", "c1");
      run(d, "checkout", "-qb", "b");
      put(d, "b.txt", "y\n");
      run(d, "add", ".");
      run(d, "commit", "-qm", "c2");
      run(d, "checkout", "-q", "main");
    });
    put(native, ".gitattributes", "*.txt eol=crlf\n");
    run(native, "checkout", "-q", "b");
    const o = await open(ours);
    await o.worktree.writeContent(".gitattributes", new TextEncoder().encode("*.txt eol=crlf\n"));
    await o.git.checkout().setName("b").call();
    const files = ["b.txt", ".gitattributes"];
    expect(observe(ours, files)).toBe(observe(native, files));
  });

  it("reset --mixed then checkout -- <path>: the worktree's .gitattributes, as git", async () => {
    const { native, ours } = twins("mixed-path", (d) => {
      put(d, ".gitattributes", "*.txt -text\n");
      put(d, "b.txt", "x\n");
      run(d, "add", ".");
      run(d, "commit", "-qm", "c1");
      run(d, "checkout", "-qb", "b");
      put(d, ".gitattributes", "*.txt eol=crlf\n");
      put(d, "b.txt", "y\n");
      run(d, "add", ".");
      run(d, "commit", "-qm", "c2");
      run(d, "checkout", "-q", "main");
    });
    run(native, "checkout", "-q", "b");
    run(native, "reset", "-q", "main");
    unlinkSync(join(native, "b.txt"));
    run(native, "checkout", "--", "b.txt");
    const o = await open(ours);
    await o.git.checkout().setName("b").call();
    await o.git.reset().setMode(ResetMode.MIXED).setRef("main").call();
    unlinkSync(join(ours, "b.txt"));
    await (await open(ours)).git.checkout().addPath("b.txt").call();
    expect(observe(ours, ["b.txt"])).toBe(observe(native, ["b.txt"]));
  });

  it("checkout -- <path> with a modified .gitattributes in the worktree", async () => {
    const { native, ours } = twins("path-direction", (d) => {
      put(d, ".gitattributes", "*.txt -text\n");
      put(d, "b.txt", "x\n");
      run(d, "add", ".");
      run(d, "commit", "-qm", "c1");
      put(d, ".gitattributes", "*.txt eol=crlf\n");
      unlinkSync(join(d, "b.txt"));
    });
    run(native, "checkout", "--", "b.txt");
    await (await open(ours)).git.checkout().addPath("b.txt").call();
    expect(observe(ours, ["b.txt"])).toBe(observe(native, ["b.txt"]));
  });

  it("reset --hard with a staged .gitattributes change reads HEAD's rules", async () => {
    const { native, ours } = twins("reset-staged", (d) => {
      put(d, ".gitattributes", "*.txt -text\n");
      put(d, "b.txt", "x\n");
      run(d, "add", ".");
      run(d, "commit", "-qm", "c1");
      put(d, "b.txt", "y\n");
      put(d, ".gitattributes", "*.txt eol=crlf\n");
      run(d, "add", ".");
    });
    run(native, "reset", "-q", "--hard");
    await (await open(ours)).git.reset().setMode(ResetMode.HARD).setRef("HEAD").call();
    expect(observe(ours, ["b.txt"])).toBe(observe(native, ["b.txt"]));
  });

  it("reset --mixed under eol=crlf, then status", async () => {
    const { native, ours } = twins("mixed-status", (d) => {
      put(d, ".gitattributes", "*.txt eol=crlf\n");
      put(d, "a.txt", "a\nb\n");
      run(d, "add", ".");
      run(d, "commit", "-qm", "c1");
      put(d, "b.txt", "b\n");
      put(d, "a.txt", "a\nb\nc\n");
      run(d, "add", ".");
      run(d, "commit", "-qm", "c2");
      run(d, "reset", "-q", "--hard");
    });
    run(native, "reset", "-q", "HEAD~1");
    await (await open(ours)).git.reset().setMode(ResetMode.MIXED).setRef("HEAD~1").call();
    expect(await ourStatus(ours)).toBe(nativeStatus(native));
    expect(nativeStatus(ours)).toBe(nativeStatus(native));
  });

  it("stash and stash pop with a modified .gitattributes", async () => {
    const { native, ours } = twins("stash-attrs", (d) => {
      put(d, ".gitattributes", "*.txt -text\n");
      put(d, "a.txt", "a\r\nb\r\n");
      run(d, "add", ".");
      run(d, "commit", "-qm", "c1");
      put(d, ".gitattributes", "*.txt text eol=crlf\n");
      put(d, "a.txt", "a\r\nB\r\n");
    });
    run(native, "stash", "-q");
    await (await open(ours)).git.stashCreate().call();
    const files = ["a.txt", ".gitattributes"];
    expect(run(ours, "ls-tree", "-r", "stash@{0}") + observe(ours, files)).toBe(
      run(native, "ls-tree", "-r", "stash@{0}") + observe(native, files),
    );
    run(native, "stash", "pop", "-q");
    await (await open(ours)).git.stashApply().call();
    expect(observe(ours, files)).toBe(observe(native, files));
  });
});

describeGit("checkout attributes: links, renormalize, configuration", () => {
  // git's ce_modified_check_fs goes by the worktree's file type: a regular file is compared
  // with ce_compare_data, cleaned as any file (ce_compare_link only for a real link)
  it("a link held as a file (core.symlinks=false) is compared cleaned, as git does", async () => {
    const { native, ours } = twins("link-file", (d) => {
      put(d, ".gitattributes", "* ident\n");
      symlinkSync("$Id: abc $", join(d, "l"));
      run(d, "add", ".");
      run(d, "commit", "-qm", "c1");
      run(d, "config", "core.symlinks", "false");
      unlinkSync(join(d, "l"));
      run(d, "checkout", "--", "l");
    });
    expect(bytes(ours, "l")).toBe(JSON.stringify("$Id: abc $"));
    expect(await ourStatus(ours)).toBe(nativeStatus(native));
    expect(nativeStatus(native)).toBe(" M l\n");
  });

  it("status finds a worktree rename by the cleaned content (and by size where nothing converts)", async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i}\n`).join("");
    const { native, ours } = twins("rename", (d) => {
      run(d, "config", "core.autocrlf", "true");
      put(d, ".gitattributes", "*.bin -text\n");
      put(d, "a.txt", lines);
      put(d, "c.bin", lines);
      run(d, "add", ".");
      run(d, "commit", "-qm", "c1");
      unlinkSync(join(d, "a.txt"));
      unlinkSync(join(d, "c.bin"));
      put(d, "b.txt", lines.replaceAll("\n", "\r\n"));
      put(d, "d.bin", lines);
      run(d, "add", "-N", "b.txt", "d.bin");
    });
    expect(await ourStatus(ours)).toBe(nativeStatus(native));
    expect(nativeStatus(native)).toContain("R a.txt -> b.txt");
  });

  it("add --renormalize fails on a deleted tracked file as git does, the index untouched", async () => {
    const { native, ours } = twins("renorm-deleted", (d) => {
      put(d, "a.txt", "a\r\n");
      put(d, "b.txt", "b\r\n");
      run(d, "add", ".");
      run(d, "commit", "-qm", "c1");
      put(d, ".gitattributes", "*.txt text\n");
      unlinkSync(join(d, "b.txt"));
    });
    const n = runResult(native, "add", "--renormalize", ".");
    expect(n.status).toBe(128);
    let error = "";
    try {
      await (await open(ours)).git.add().setRenormalize(true).addFilepattern(".").call();
    } catch (e) {
      error = (e as Error).message;
    }
    expect(`fatal: ${error}\n`).toBe(n.stderr);
    expect(observe(ours, [])).toBe(observe(native, []));
  });

  it("add --renormalize keeps content a bad working-tree-encoding cannot convert (no write flags)", async () => {
    const { native, ours } = twins("renorm-encoding", (d) => {
      put(d, "a.txt", "abc\n");
      run(d, "add", ".");
      run(d, "commit", "-qm", "c1");
      put(d, ".gitattributes", "*.txt working-tree-encoding=UTF-16\n");
    });
    const n = runResult(native, "add", "--renormalize", ".");
    expect(n.status).toBe(0);
    await (await open(ours)).git.add().setRenormalize(true).addFilepattern(".").call();
    expect(observe(ours, ["a.txt"])).toBe(observe(native, ["a.txt"]));
    // a plain add of the same file fails in both
    put(native, "a.txt", "abcd\n");
    put(ours, "a.txt", "abcd\n");
    expect(runResult(native, "add", "a.txt").status).not.toBe(0);
    await expect((await open(ours)).git.add().addFilepattern("a.txt").call()).rejects.toThrow(
      /BOM is required/,
    );
  });

  it("includeIf.onbranch: follows HEAD after a branch switch in the same working copy", async () => {
    const { native, ours } = twins("onbranch", (d) => {
      put(d, ".git/extra.inc", "[core]\n\tautocrlf = true\n");
      run(d, "config", "includeIf.onbranch:b.path", "extra.inc");
      put(d, "a.txt", "a\n");
      run(d, "add", ".");
      run(d, "commit", "-qm", "c1");
      run(d, "branch", "b");
    });
    run(native, "checkout", "-q", "b");
    put(native, "c.txt", "c\r\n");
    run(native, "add", "c.txt");
    const o = await open(ours);
    expect(o.config.get("core.autocrlf")).toBeUndefined();
    await o.git.checkout().setName("b").call();
    put(ours, "c.txt", "c\r\n");
    await o.git.add().addFilepattern("c.txt").call();
    expect(String(o.config.get("core.autocrlf"))).toBe("true");
    expect(observe(ours, ["c.txt"])).toBe(observe(native, ["c.txt"]));
  });

  it("re-opening a working copy on the same worktree applies the new configuration", async () => {
    const { ours } = twins("reopen", (d) => {
      put(d, "a.txt", "a\n");
      run(d, "add", ".");
      run(d, "commit", "-qm", "c1");
    });
    const first = await open(ours);
    put(ours, "c.txt", "c\r\n");
    const raw = await first.worktree.computeHash("c.txt");
    expect(raw).toBe(run(ours, "hash-object", "c.txt").trim());
    // a new working copy over the same worktree, with its own configuration and drivers
    const config = new GitWorkingCopyConfig(
      {
        read: async () => new TextEncoder().encode("[core]\n\tautocrlf = true\n"),
        write: async () => {},
      },
      ".git/config",
    );
    await config.load();
    const before = first.worktree.contentFilter;
    new MemoryWorkingCopy({
      history: first.wc.history,
      checkout: first.wc.checkout,
      worktree: first.worktree,
      config,
    });
    expect(first.worktree.contentFilter).not.toBe(before);
    const converted = await first.worktree.computeHash("c.txt");
    expect(converted).not.toBe(raw);
    expect(converted).toBe(run(ours, "-c", "core.autocrlf=true", "hash-object", "c.txt").trim());
  });
});

/** A FilesApi for GitWorkingCopyFactory over `base` (node:fs, as a host gives one). */
function factoryFiles(base: string) {
  const at = (p: string) => join(base, p);
  return {
    rootDirectory: base,
    read: async (p: string) => {
      try {
        return new Uint8Array(readFileSync(at(p)));
      } catch {
        return undefined;
      }
    },
    write: async (p: string, content: Uint8Array) => {
      mkdirSync(dirname(at(p)), { recursive: true });
      writeFileSync(at(p), content);
    },
    exists: async (p: string) => existsSync(at(p)),
    stats: async (p: string) => {
      try {
        return { isDirectory: statSync(at(p)).isDirectory() };
      } catch {
        return undefined;
      }
    },
    mkdir: async (p: string) => {
      mkdirSync(at(p), { recursive: true });
    },
    writeFile: async (p: string, content: string) => writeFileSync(at(p), content),
  };
}

/** A factory whose working copies read the repository `repo` (relative to `base`). */
function factory(base: string, repo: string, environment?: GitHostEnvironment) {
  const files = createNodeFilesApi({ rootDir: base });
  return new GitWorkingCopyFactory(
    factoryFiles(base),
    async () => {
      const { history } = await createGitFilesBackend({ files, gitDir: `${repo}/.git` });
      return {
        history,
        createCheckout: async (gitDir: string) => {
          const staging = new FileStagingStore(files, `${gitDir}/index`);
          await staging.read();
          return new GitCheckout({
            staging,
            refs: history.refs,
            files: factoryFiles(base) as unknown as GitCheckoutFilesApi,
            gitDir,
          });
        },
        createWorktree: (path: string) =>
          createFileWorktree({
            files,
            rootPath: path,
            gitDir: `${repo}/.git`,
            blobs: history.blobs,
            trees: history.trees,
          }),
      };
    },
    environment ? { environment } : {},
  );
}

describeGit("working copies from the factory: linked worktrees, global includes", () => {
  it("a linked worktree reads the repository's config (core.autocrlf) and its config.worktree", async () => {
    const base = join(root, "linked");
    mkdirSync(base);
    const repo = join(base, "repo");
    mkdirSync(repo);
    run(repo, "init", "-q", "-b", "main");
    put(repo, "a.txt", "a\n");
    run(repo, "add", ".");
    run(repo, "commit", "-qm", "c1");
    run(repo, "config", "core.autocrlf", "true");
    run(repo, "worktree", "add", "-q", "../wt", "-b", "w");
    put(join(base, "wt"), "c.txt", "c\r\n");
    const wc = await factory(base, "repo").openWorkingCopy("wt", "repo/.git/worktrees/wt");
    const config = wc.config as GitWorkingCopyConfig;
    expect(String(config.get("core.autocrlf"))).toBe(
      run(join(base, "wt"), "config", "core.autocrlf").trim(),
    );
    expect(await wc.worktree.computeHash("c.txt")).toBe(
      run(join(base, "wt"), "hash-object", "c.txt").trim(),
    );
    // extensions.worktreeConfig: the worktree's own config.worktree overrides
    run(repo, "config", "extensions.worktreeConfig", "true");
    run(join(base, "wt"), "config", "--worktree", "core.autocrlf", "false");
    const again = await factory(base, "repo").openWorkingCopy("wt", "repo/.git/worktrees/wt");
    expect(String((again.config as GitWorkingCopyConfig).get("core.autocrlf"))).toBe(
      run(join(base, "wt"), "config", "core.autocrlf").trim(),
    );
    expect(await again.worktree.computeHash("c.txt")).toBe(
      run(join(base, "wt"), "hash-object", "c.txt").trim(),
    );
  });

  it("a global includeIf gitdir: matches the repository's real path; GIT_CONFIG_GLOBAL is read", async () => {
    const base = join(root, "gitdir");
    mkdirSync(base);
    const repo = join(base, "repo");
    mkdirSync(repo);
    run(repo, "init", "-q", "-b", "main");
    const userHome = join(base, "home");
    put(userHome, "inc.cfg", "[core]\n\tautocrlf = input\n");
    put(userHome, ".gitconfig", `[includeIf "gitdir:${repo}/"]\n\tpath = inc.cfg\n`);
    const env = { ...nativeGitEnv(userHome), HOME: userHome };
    delete (env as Record<string, string | undefined>).GIT_CONFIG_GLOBAL;
    const nativeValue = execFileSync("git", ["config", "core.autocrlf"], {
      cwd: repo,
      env,
      encoding: "utf8",
    }).trim();
    expect(nativeValue).toBe("input");
    const environment = createNodeGitHostEnvironment({ env });
    const wc = await factory(base, "repo", environment).openWorkingCopy("repo", "repo/.git");
    expect(String((wc.config as GitWorkingCopyConfig).get("core.autocrlf"))).toBe(nativeValue);

    // GIT_CONFIG_GLOBAL names the one global file
    put(userHome, "other.cfg", "[core]\n\teol = crlf\n");
    const globalEnv = { ...env, GIT_CONFIG_GLOBAL: join(userHome, "other.cfg") };
    const read = (key: string) =>
      spawnSync("git", ["config", key], {
        cwd: repo,
        env: globalEnv,
        encoding: "utf8",
      }).stdout.trim();
    const wc2 = await factory(
      base,
      "repo",
      createNodeGitHostEnvironment({ env: globalEnv }),
    ).openWorkingCopy("repo", "repo/.git");
    const config = wc2.config as GitWorkingCopyConfig;
    expect(String(config.get("core.eol") ?? "")).toBe(read("core.eol"));
    expect(String(config.get("core.autocrlf") ?? "")).toBe(read("core.autocrlf"));
  });
});

/** xorshift32 */
function rng(seed: number) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 2 ** 32;
  };
}

describeGit(
  "checkout attributes: branch switch and stash round trip fuzz against native git",
  () => {
    it("switches, stashes and pops as git does", async () => {
      const mismatches: string[] = [];
      const DIRS = ["", "a", "a/b"];
      const NAMES = ["x.txt", "-y.txt", "z.bin", "w", "q.c"];
      const PATTERNS = ["*.txt", "*", "x.txt", "*.c", "w", "-y.txt", "b/*"];
      const STATES = [
        "text",
        "-text",
        "text=auto",
        "eol=lf",
        "eol=crlf",
        "binary",
        "crlf",
        "ident",
        "text eol=crlf",
        "!text",
      ];
      const PIECES = ["a", "b c", "\n", "\n", "\r\n", "\r\n", "\r", "$Id$", "\0"];
      const CONFIGS = [
        ["core.autocrlf", "true"],
        ["core.autocrlf", "input"],
        ["core.eol", "crlf"],
        ["core.safecrlf", "false"],
      ];
      for (let seed = FUZZ_START; seed < FUZZ_START + FUZZ_COUNT; seed++) {
        const r = rng(seed);
        const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
        const paths = new Set<string>();
        for (let i = 0; i < 4 + Math.floor(r() * 4); i++) {
          const d = pick(DIRS);
          paths.add(d ? `${d}/${pick(NAMES)}` : pick(NAMES));
        }
        const content = () => {
          let c = "";
          for (let k = Math.floor(r() * 8); k > 0; k--) c += pick(PIECES);
          return c;
        };
        const attrs = () => {
          const m = new Map<string, string>();
          for (let i = 0; i < 1 + Math.floor(r() * 2); i++) {
            m.set(
              pick(DIRS),
              `${pick(PATTERNS)} ${pick(STATES)}\n${pick(PATTERNS)} ${pick(STATES)}\n`,
            );
          }
          return m;
        };
        const v1 = new Map([...paths].map((p) => [p, content()]));
        const v2 = new Map([...paths].map((p) => [p, r() < 0.7 ? content() : (v1.get(p) ?? "")]));
        const a1 = attrs();
        const a2 = r() < 0.8 ? attrs() : a1;
        const cfg = r() < 0.5 ? [pick(CONFIGS)] : [];
        const mods = new Map([...paths].filter(() => r() < 0.5).map((p) => [p, content()]));
        const writeAll = (d: string, files: Map<string, string>, at: Map<string, string>) => {
          for (const [p, c] of files) put(d, p, c);
          for (const dd of DIRS) rmSync(join(d, dd, ".gitattributes"), { force: true });
          for (const [dd, c] of at) put(d, dd ? `${dd}/.gitattributes` : ".gitattributes", c);
        };
        let pair: { native: string; ours: string };
        try {
          pair = twins(`fuzz-${seed}`, (d) => {
            for (const [k, v] of cfg) run(d, "config", k, v);
            run(d, "config", "core.safecrlf", "false");
            writeAll(d, v1, a1);
            run(d, "add", "-A");
            run(d, "commit", "-qm", "c1");
            run(d, "checkout", "-qb", "b");
            writeAll(d, v2, a2);
            run(d, "add", "-A");
            run(d, "commit", "-qm", "c2", "--allow-empty");
            run(d, "checkout", "-qf", "main");
            run(d, "reset", "-q", "--hard");
          });
        } catch (e) {
          mismatches.push(`${seed}: setup ${e}`);
          continue;
        }
        const { native, ours } = pair;
        const files = [
          ...paths,
          ...DIRS.map((d) => (d ? `${d}/.gitattributes` : ".gitattributes")),
        ].sort();
        // git's status once every file is re-read (each given a new mtime, the same in both
        // twins): a file whose content does not survive smudge + clean shows as modified or
        // not depending on whether its entry is racy, i.e. on timing, in git itself; re-read,
        // it always does. Our status is compared with git's on the same repository, before.
        let stamp = Math.floor(Date.now() / 1000) + 1000;
        const look = (d: string, time: number) => {
          for (const f of files) {
            if (existsSync(join(d, f))) utimesSync(join(d, f), time, time);
          }
          return [nativeStatus(d), ...files.map((f) => `${f}=${bytes(d, f)}`)].join("|");
        };
        const lookBoth = () => {
          stamp += 10;
          return [look(native, stamp), look(ours, stamp)];
        };
        const before = lookBoth();
        if (before[0] !== before[1]) {
          mismatches.push(`${seed}: twins differ before the switch`);
          continue;
        }
        const switched = runResult(native, "checkout", "-q", "b").status;
        let error = "";
        try {
          await (await open(ours)).git.checkout().setName("b").call();
        } catch (e) {
          error = String(e);
        }
        const mine = await ourStatus(ours);
        const gitOnOurs = nativeStatus(ours);
        const l1 = lookBoth();
        if (l1[0] !== l1[1] || mine !== gitOnOurs) {
          mismatches.push(
            `${seed}: checkout b (git ${switched}, ours ${error})\n  git =${l1[0]}\n  ours=${l1[1]}\n  our status=${mine}\n  git status=${gitOnOurs}`,
          );
        }
        for (const d of [native, ours]) for (const [p, c] of mods) put(d, p, c);
        const stashed = runResult(native, "stash", "-q").status;
        error = "";
        try {
          await (await open(ours)).git.stashCreate().call();
        } catch (e) {
          error = String(e);
        }
        const l2 = lookBoth();
        const t1 = runResult(native, "ls-tree", "-r", "stash@{0}").stdout;
        const t2 = runResult(ours, "ls-tree", "-r", "stash@{0}").stdout;
        if (l2[0] !== l2[1] || t1 !== t2) {
          mismatches.push(
            `${seed}: stash (git ${stashed}, ours ${error})\n  git =${l2[0]} ${t1}\n  ours=${l2[1]} ${t2}`,
          );
        }
        const popped = runResult(native, "stash", "pop", "-q").status;
        error = "";
        try {
          await (await open(ours)).git.stashApply().call();
        } catch (e) {
          error = String(e);
        }
        const l3 = lookBoth();
        if (l3[0] !== l3[1]) {
          mismatches.push(
            `${seed}: pop (git ${popped}, ours ${error})\n  git =${l3[0]}\n  ours=${l3[1]}`,
          );
        }
        rmSync(native, { recursive: true, force: true });
        rmSync(ours, { recursive: true, force: true });
      }
      expect(mismatches).toEqual([]);
    }, 600_000);
  },
);
