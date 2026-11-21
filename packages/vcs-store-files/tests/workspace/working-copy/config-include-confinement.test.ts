/**
 * Which include directives of a repository's config are followed: git's rule (every one, a
 * `~/`, absolute or climbing path read from the host), `includes: "files"` (only files inside
 * the files API: nothing above its root, no `~/` path, no absolute path or symbolic link
 * leading out of it) and `includes: false` (none), on `GitWorkingCopyConfig` and through
 * `FileWorktree.openRepository(location, { configIncludes })`, the opener a server uses.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createGitFilesBackend } from "../../../src/create-git-files-backend.js";
import { createWorkingCopyConfig } from "../../../src/workspace/working-copy/index.js";
import { createFileWorktree } from "../../../src/workspace/worktree/index.js";

let tmp: string;
/** The files API's root and the repository's worktree: `<tmp>/srv/root` (`.git` in it) */
let root: string;

const cfg = (name: string) => `[probe]\n\t${name} = yes\n`;

/**
 * The repository at `<root>` whose config includes, one directive each: a file beside it, a
 * file above the root by `../../etc/x`, an absolute host path outside the root, an absolute
 * path inside the root, a `~/` path, links leading out of the root (relative and absolute)
 * and one staying inside, and an `includeIf` climbing out.
 */
function layout(): void {
  tmp = mkdtempSync(join(tmpdir(), "config-includes-"));
  root = join(tmp, "srv", "root");
  const git = join(root, ".git");
  mkdirSync(join(git, "objects"), { recursive: true });
  mkdirSync(join(git, "refs", "heads"), { recursive: true });
  writeFileSync(join(git, "HEAD"), "ref: refs/heads/main\n");
  mkdirSync(join(tmp, "srv", "etc"), { recursive: true });
  writeFileSync(join(tmp, "srv", "etc", "x"), cfg("climbing"));
  writeFileSync(join(tmp, "outside.cfg"), cfg("absoluteOutside"));
  mkdirSync(join(root, "shared"), { recursive: true });
  writeFileSync(join(root, "shared", "inside.cfg"), cfg("absoluteInside"));
  writeFileSync(join(root, "shared", "linked.cfg"), cfg("linkInside"));
  mkdirSync(join(tmp, "home"), { recursive: true });
  writeFileSync(join(tmp, "home", "user.cfg"), cfg("home"));
  writeFileSync(join(tmp, "if.cfg"), cfg("includeIfOutside"));
  writeFileSync(join(git, "beside.cfg"), cfg("beside"));
  symlinkSync("../../etc/x", join(git, "up.cfg"));
  symlinkSync(join(tmp, "outside.cfg"), join(git, "abs-link.cfg"));
  symlinkSync(join(root, "shared", "linked.cfg"), join(git, "in-link.cfg"));
  mkdirSync(join(git, "sub"), { recursive: true });
  writeFileSync(join(git, "sub", "inner.cfg"), cfg("linkInGit"));
  symlinkSync("sub/inner.cfg", join(git, "in-git-link.cfg"));
  writeFileSync(
    join(git, "config"),
    [
      "[core]",
      "\trepositoryformatversion = 0",
      "\tbare = false",
      "[include]",
      "\tpath = beside.cfg",
      "\tpath = ../../etc/x",
      `\tpath = ${join(tmp, "outside.cfg")}`,
      `\tpath = ${join(root, "shared", "inside.cfg")}`,
      "\tpath = ~/user.cfg",
      "\tpath = up.cfg",
      "\tpath = abs-link.cfg",
      "\tpath = in-link.cfg",
      "\tpath = in-git-link.cfg",
      '[includeIf "gitdir:**"]',
      "\tpath = ../../../if.cfg",
      "",
    ].join("\n"),
  );
}

/** git's rule over the Node files API (which reads no symbolic link: a link reads as nothing) */
const ALL = ["beside", "climbing", "absoluteOutside", "absoluteInside", "home", "includeIfOutside"];
/** Confined to the git directory: the file beside the config and a link staying inside it */
const INSIDE = ["beside", "linkInGit"];

/** Which probes the config read, in order, with their file. */
function probes(get: (key: string) => unknown[]): string[] {
  const names = [
    "beside",
    "climbing",
    "absoluteOutside",
    "absoluteInside",
    "home",
    "linkInside",
    "linkInGit",
    "includeIfOutside",
  ];
  return names.filter((n) => get(`probe.${n}`).length > 0);
}

const environment = () =>
  createNodeGitHostEnvironment({
    env: { HOME: join(tmp, "home"), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });

describe("config includes: git's rule, confined to the files API, or none", () => {
  beforeEach(layout);
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  async function configWith(includes: boolean | "files" | undefined) {
    const files = createNodeFilesApi({ rootDir: root });
    const read = async (p: string) => {
      if ((await files.stats(p))?.kind !== "file") return undefined;
      const chunks: Uint8Array[] = [];
      for await (const c of files.read(p)) chunks.push(c);
      return new Uint8Array(Buffer.concat(chunks));
    };
    return createWorkingCopyConfig(
      {
        read,
        write: (p, content) => files.write(p, [content]),
        rootDirectory: root,
        lstat: (p: string) => files.lstat?.(p) ?? Promise.resolve(undefined),
        readlink: (p: string) => files.readlink?.(p) ?? Promise.resolve(undefined),
      },
      ".git",
      undefined,
      { environment: environment(), ...(includes === undefined ? {} : { includes }) },
    );
  }

  it("by default follows every include, as git (host files through the environment)", async () => {
    const config = await configWith(undefined);
    expect(probes((k) => config.getAll(k))).toEqual(ALL);
  });

  it('"files": only the files inside the files API, links leading out skipped', async () => {
    const config = await configWith("files");
    expect(probes((k) => config.getAll(k))).toEqual(INSIDE);
    expect(config.get("core.bare")).toBe(false);
  });

  it("false: no include followed", async () => {
    const config = await configWith(false);
    expect(probes((k) => config.getAll(k))).toEqual([]);
  });

  it('"files" over a storage that follows links: a link leading out is refused', async () => {
    // a storage whose reads follow symbolic links (lexically, inside itself and to the host)
    const host: Record<string, string> = {
      "/host/root/.git/config":
        "[include]\n\tpath = beside.cfg\n\tpath = up.cfg\n\tpath = abs.cfg\n\tpath = in.cfg\n",
      "/host/root/.git/beside.cfg": cfg("beside"),
      "/host/etc/x": cfg("climbing"),
      "/host/outside.cfg": cfg("absoluteOutside"),
      "/host/root/shared/linked.cfg": cfg("linkInside"),
    };
    const links: Record<string, string> = {
      "/host/root/.git/up.cfg": "../../etc/x",
      "/host/root/.git/abs.cfg": "/host/outside.cfg",
      "/host/root/.git/in.cfg": "../shared/linked.cfg",
    };
    const enc = new TextEncoder();
    const hostOf = (p: string) => `/host/root/${p.replace(/^\/+/, "")}`;
    const follow = (path: string): string => {
      const target = links[path];
      if (target === undefined) return path;
      const dir = path.slice(0, path.lastIndexOf("/"));
      const joined = target.startsWith("/") ? target : `${dir}/${target}`;
      const out: string[] = [];
      for (const part of joined.split("/")) {
        if (part === "..") out.pop();
        else if (part && part !== ".") out.push(part);
      }
      return follow(`/${out.join("/")}`);
    };
    const storage = (withLinks: boolean) => ({
      read: async (p: string) => {
        const text = host[follow(hostOf(p))];
        return text === undefined ? undefined : enc.encode(text);
      },
      write: async () => {},
      rootDirectory: "/host/root",
      ...(withLinks
        ? {
            lstat: async (p: string) =>
              links[hostOf(p)] !== undefined
                ? { kind: "symlink" }
                : host[hostOf(p)] !== undefined
                  ? { kind: "file", size: enc.encode(host[hostOf(p)]).length }
                  : { kind: "directory" },
            readlink: async (p: string) => {
              const target = links[hostOf(p)];
              return target === undefined ? undefined : enc.encode(target);
            },
          }
        : {}),
    });
    const confined = await createWorkingCopyConfig(storage(true), ".git", undefined, {
      includes: "files",
    });
    // the link to ../shared/linked.cfg stays in the storage but leaves the git directory
    expect(probes((k) => confined.getAll(k))).toEqual(["beside"]);
    // a storage that cannot tell links apart follows no include at all
    const blind = await createWorkingCopyConfig(storage(false), ".git", undefined, {
      includes: "files",
    });
    expect(probes((k) => blind.getAll(k))).toEqual([]);
  });
});

describe("FileWorktree.openRepository: configIncludes", () => {
  beforeEach(layout);
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  async function open(configIncludes?: boolean | "files") {
    const files = createNodeFilesApi({ rootDir: root });
    const { history } = await createGitFilesBackend({ files, gitDir: ".git" });
    const worktree = createFileWorktree({
      files,
      rootPath: "",
      gitDir: ".git",
      blobs: history.blobs,
      trees: history.trees,
      environment: environment(),
    });
    const opened = await worktree.openRepository?.(
      root,
      configIncludes === undefined ? {} : { configIncludes },
    );
    if (!opened?.config) throw new Error("not opened");
    const config = opened.config;
    return probes((k) => config.getAll(k).filter((v): v is string => v !== null));
  }

  it('follows git\'s rule by default, confines with "files", follows none with false', async () => {
    expect(await open()).toEqual(ALL);
    expect(await open(true)).toEqual(ALL);
    expect(await open("files")).toEqual(INSIDE);
    expect(await open(false)).toEqual([]);
  });

  it("keeps serving the repository's own settings whatever the rule", async () => {
    const files = createNodeFilesApi({ rootDir: root });
    const { history } = await createGitFilesBackend({ files, gitDir: ".git" });
    const worktree = createFileWorktree({
      files,
      rootPath: "",
      gitDir: ".git",
      blobs: history.blobs,
      trees: history.trees,
      environment: environment(),
    });
    const opened = await worktree.openRepository?.(root, { configIncludes: "files" });
    expect(opened?.config?.getAll("core.bare")).toEqual(["false"]);
    expect(opened?.gitDir).toBe("/.git");
  });
});

describe('config includes "files": confined to the repository, size-capped', () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "config-tenants-"));
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  /** A bare repository `<base>/<name>.git` whose config has `lines` after its core section. */
  function bare(name: string, lines: string[]): string {
    const git = join(base, `${name}.git`);
    mkdirSync(join(git, "objects"), { recursive: true });
    mkdirSync(join(git, "refs", "heads"), { recursive: true });
    writeFileSync(join(git, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(
      join(git, "config"),
      ["[core]", "\trepositoryformatversion = 0", "\tbare = true", ...lines, ""].join("\n"),
    );
    return git;
  }

  async function served(name: string, configIncludes: boolean | "files") {
    const files = createNodeFilesApi({ rootDir: base });
    const { history } = await createGitFilesBackend({ files, gitDir: `${name}.git` });
    const worktree = createFileWorktree({
      files,
      rootPath: "",
      gitDir: `${name}.git`,
      blobs: history.blobs,
      trees: history.trees,
    });
    const opened = await worktree.openRepository?.(`${base}/${name}.git`, { configIncludes });
    if (!opened?.config) throw new Error("not opened");
    return opened.config;
  }

  it("another repository of the storage is not included, its own files are", async () => {
    bare("tenantB", ["[secret]", "\ttoken = b-secret"]);
    const a = bare("tenantA", [
      "[include]",
      "\tpath = ../tenantB.git/config",
      `\tpath = ${join(base, "tenantB.git", "config")}`,
      "\tpath = own.cfg",
    ]);
    writeFileSync(join(a, "own.cfg"), cfg("own"));
    const confined = await served("tenantA", "files");
    expect(confined.getAll("secret.token")).toEqual([]);
    expect(confined.getAll("probe.own")).toEqual(["yes"]);
    // git's rule reads the other repository's config by its relative path (the absolute one
    // is a host path, read through an environment this worktree has not)
    const open = await served("tenantA", true);
    expect(open.getAll("secret.token")).toEqual(["b-secret"]);
  });

  it("createGitFilesBackend's format check follows no include, whatever the rule", async () => {
    // tenantB's config would make tenantA's format one this store refuses, were it included:
    // git's read_repository_format reads the config file alone (git_config_from_file)
    const b = bare("tenantB", []);
    writeFileSync(join(b, "config"), "[core]\n\trepositoryformatversion = 2\n");
    bare("tenantA", ["[include]", "\tpath = ../tenantB.git/config"]);
    const files = createNodeFilesApi({ rootDir: base });
    await expect(createGitFilesBackend({ files, gitDir: "tenantA.git" })).resolves.toBeDefined();
    await expect(
      createGitFilesBackend({ files, gitDir: "tenantA.git", configIncludes: "files" }),
    ).resolves.toBeDefined();
    await expect(
      createGitFilesBackend({ files, gitDir: "tenantA.git", configIncludes: false }),
    ).resolves.toBeDefined();
  });

  it("a file above MAX_CONFINED_INCLUDE_SIZE is skipped, a smaller one read", async () => {
    const a = bare("big", ["[include]", "\tpath = big.cfg", "\tpath = small.cfg"]);
    const filler = `# ${"x".repeat(1022)}\n`.repeat(1025);
    writeFileSync(join(a, "big.cfg"), `${cfg("big")}${filler}`);
    writeFileSync(join(a, "small.cfg"), cfg("small"));
    const confined = await served("big", "files");
    expect(confined.getAll("probe.big")).toEqual([]);
    expect(confined.getAll("probe.small")).toEqual(["yes"]);
    expect((await served("big", true)).getAll("probe.big")).toEqual(["yes"]);
  });

  it("includeRoots widens the confinement to directories the caller names", async () => {
    tmp = mkdtempSync(join(tmpdir(), "config-includes-"));
    layout();
    const files = createNodeFilesApi({ rootDir: root });
    const config = await createWorkingCopyConfig(
      {
        read: async (p: string) => {
          if ((await files.stats(p))?.kind !== "file") return undefined;
          const chunks: Uint8Array[] = [];
          for await (const c of files.read(p)) chunks.push(c);
          return new Uint8Array(Buffer.concat(chunks));
        },
        write: (p, content) => files.write(p, [content]),
        rootDirectory: root,
        lstat: (p: string) => files.lstat?.(p) ?? Promise.resolve(undefined),
        readlink: (p: string) => files.readlink?.(p) ?? Promise.resolve(undefined),
      },
      ".git",
      undefined,
      { environment: environment(), includes: "files", includeRoots: [".git", "shared"] },
    );
    expect(probes((k) => config.getAll(k))).toEqual([
      "beside",
      "absoluteInside",
      "linkInside",
      "linkInGit",
    ]);
    rmSync(tmp, { recursive: true, force: true });
  });
});

describe("FileWorktree.openRepository of a linked worktree's git directory", () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "config-linked-"));
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it("reads its config.worktree, its HEAD for onbranch: and its directory for gitdir:", async () => {
    const env = {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "A",
      GIT_AUTHOR_EMAIL: "a@example.com",
      GIT_COMMITTER_NAME: "A",
      GIT_COMMITTER_EMAIL: "a@example.com",
    };
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", args, { cwd, env, stdio: "pipe" }).toString();
    const main = join(base, "main");
    mkdirSync(main);
    git(main, "init", "-q", "-b", "main");
    git(main, "commit", "-q", "--allow-empty", "-m", "c");
    git(main, "worktree", "add", "-q", "-b", "wt", join(base, "wt"));
    git(main, "config", "extensions.worktreeConfig", "true");
    git(join(base, "wt"), "config", "--worktree", "probe.worktree", "yes");
    const wtGitDir = join(main, ".git", "worktrees", "wt");
    writeFileSync(join(main, ".git", "onbranch.cfg"), cfg("onbranch"));
    writeFileSync(join(main, ".git", "gitdir.cfg"), cfg("gitdir"));
    git(main, "config", "includeIf.onbranch:wt.path", "onbranch.cfg");
    git(main, "config", `includeIf.gitdir:${wtGitDir}.path`, "gitdir.cfg");
    // native git's view from the linked worktree
    const native = (key: string) => {
      try {
        return git(join(base, "wt"), "config", "--get", key).trim();
      } catch {
        return undefined;
      }
    };
    expect([native("probe.worktree"), native("probe.onbranch"), native("probe.gitdir")]).toEqual([
      "yes",
      "yes",
      "yes",
    ]);
    const files = createNodeFilesApi({ rootDir: base });
    const { history } = await createGitFilesBackend({ files, gitDir: "main/.git" });
    const worktree = createFileWorktree({
      files,
      rootPath: "main",
      gitDir: "main/.git",
      blobs: history.blobs,
      trees: history.trees,
    });
    for (const configIncludes of [true, "files"] as const) {
      const opened = await worktree.openRepository?.(wtGitDir, { configIncludes });
      const config = opened?.config;
      if (!config) throw new Error("not opened");
      expect([
        config.getAll("probe.worktree"),
        config.getAll("probe.onbranch"),
        config.getAll("probe.gitdir"),
      ]).toEqual([["yes"], ["yes"], ["yes"]]);
    }
  });
});

describe('config includes "files": the size cap holds on the read itself (review fix)', () => {
  const enc = new TextEncoder();
  const big = enc.encode(`[probe]\n\tbig = yes\n${`# ${"x".repeat(1022)}\n`.repeat(1025)}`);
  const small = enc.encode("[probe]\n\tsmall = yes\n");
  const config = enc.encode("[include]\n\tpath = big.cfg\n\tpath = small.cfg\n");

  /** `.git/config` including big.cfg and small.cfg; `size` is what lstat tells of each. */
  async function openWith(size: (path: string, real: number) => number | undefined) {
    const contents = new Map([
      [".git/config", config],
      [".git/big.cfg", big],
      [".git/small.cfg", small],
    ]);
    const asked: { path: string; maxBytes?: number; length: number }[] = [];
    const read = async (path: string, maxBytes?: number) => {
      const bytes = contents.get(path);
      if (!bytes) return undefined;
      const out = maxBytes === undefined ? bytes : bytes.subarray(0, maxBytes);
      asked.push({ path, ...(maxBytes === undefined ? {} : { maxBytes }), length: out.length });
      return out;
    };
    const loaded = await createWorkingCopyConfig(
      {
        read: (path: string) => read(path),
        readPrefix: read,
        write: async () => {},
        lstat: async (path: string) => {
          const bytes = contents.get(path);
          if (!bytes) return undefined;
          const s = size(path, bytes.length);
          return s === undefined ? { kind: "file" } : { kind: "file", size: s };
        },
        readlink: async () => undefined,
      },
      ".git",
      undefined,
      { includes: "files" },
    );
    return { loaded, asked };
  }

  it("a file grown past the cap since its lstat is read no further than the cap plus one byte", async () => {
    // lstat reports the size from before the file grew
    const { loaded, asked } = await openWith((_path, real) => Math.min(real, 100));
    expect(loaded.getAll("probe.big")).toEqual([]);
    expect(loaded.getAll("probe.small")).toHaveLength(1);
    const bigRead = asked.find((a) => a.path === ".git/big.cfg");
    expect(bigRead?.maxBytes).toBe(1024 * 1024 + 1);
    expect(bigRead?.length).toBe(1024 * 1024 + 1);
  });

  it("an lstat that gives no size follows no include", async () => {
    const { loaded, asked } = await openWith((path, real) =>
      path.endsWith("small.cfg") ? undefined : real,
    );
    expect(loaded.getAll("probe.small")).toEqual([]);
    expect(asked.some((a) => a.path === ".git/small.cfg")).toBe(false);
  });
});
