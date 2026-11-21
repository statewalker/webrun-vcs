/**
 * Which include directives of a repository's config are followed: git's rule (every one, a
 * `~/`, absolute or climbing path read from the host), `includes: "files"` (only files inside
 * the files API: nothing above its root, no `~/` path, no absolute path or symbolic link
 * leading out of it) and `includes: false` (none), on `GitWorkingCopyConfig` and through
 * `FileWorktree.openRepository(location, { configIncludes })`, the opener a server uses.
 */
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
      '[includeIf "gitdir:**"]',
      "\tpath = ../../../if.cfg",
      "",
    ].join("\n"),
  );
}

/** git's rule over the Node files API (which reads no symbolic link: a link reads as nothing) */
const ALL = ["beside", "climbing", "absoluteOutside", "absoluteInside", "home", "includeIfOutside"];
const INSIDE = ["beside", "absoluteInside"];

/** Which probes the config read, in order, with their file. */
function probes(get: (key: string) => unknown[]): string[] {
  const names = [
    "beside",
    "climbing",
    "absoluteOutside",
    "absoluteInside",
    "home",
    "linkInside",
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
                  ? { kind: "file" }
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
    expect(probes((k) => confined.getAll(k))).toEqual(["beside", "linkInside"]);
    // without lstat the check is lexical: such a storage must not follow links out itself
    const lexical = await createWorkingCopyConfig(storage(false), ".git", undefined, {
      includes: "files",
    });
    expect(probes((k) => lexical.getAll(k))).toEqual([
      "beside",
      "climbing",
      "absoluteOutside",
      "linkInside",
    ]);
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
