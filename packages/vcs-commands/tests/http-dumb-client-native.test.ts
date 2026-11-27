/**
 * Our dumb HTTP client (remote-curl's `parse_info_refs` and http-walker.c's walk) against
 * native git's: both clone, fetch and list from a static file server (t5550's Apache
 * `/dumb/`, which answers `info/refs?service=...` with the plain file, so the client falls
 * back to the dumb protocol) and from native `git http-backend` asked without `?service=`
 * (`GIT_SMART_HTTP=0`, JGit's DumbClientSmartServerTest). Native git decides each result: the
 * refs, HEAD and objects of a clone, the FETCH_HEAD and refs of a fetch, `ls-remote`'s lines,
 * and which scenarios fail (corrupt packs and indexes, `--depth`, alternates and redirects
 * `http.followRedirects` or `protocol.<scheme>.allow` refuse). Objects are compared as sets:
 * git keeps each loose object loose and each pack as it was served, ours imports them as
 * packs of its own (unpacked below `transfer.unpackLimit`).
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitFilesBackend, openGitLinkedWorktrees } from "@statewalker/vcs-store-files";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Git } from "../src/index.js";
import { type LoopbackServer, serveOnLoopback } from "./http-loopback-support.js";
import { gitAsync } from "./native-connect-support.js";
import {
  nativeGitAvailable,
  nativeGitEnv,
  nativeGitHttpBackend,
  noMaintenance,
} from "./native-git-http-backend.js";
import { gitOut, putFile, testEnv } from "./status-native-support.js";
import { CLEANUP_TIMEOUT, removeTempDir } from "./temp-dir-support.js";

/** A native git that speaks HTTP (a git built without curl has no `git-remote-http`). */
function nativeGitHasHttp(): boolean {
  if (!nativeGitAvailable()) return false;
  const r = spawnSync("git", ["--exec-path"], { env: nativeGitEnv(tmpdir()) });
  return existsSync(join(r.stdout.toString().trim(), "git-remote-http"));
}

/** Whether the native git is older than `major.minor`. */
function nativeBefore(major: number, minor: number): boolean {
  const out = spawnSync("git", ["--version"]).stdout.toString();
  const [, a = "0", b = "0"] = /(\d+)\.(\d+)/.exec(out) ?? [];
  return Number(a) < major || (Number(a) === major && Number(b) < minor);
}

const describeHttp = nativeGitHasHttp() && process.platform === "linux" ? describe : describe.skip;

let root: string;
let docroot: string;
let server: LoopbackServer;
let counter = 0;
const git = (cwd: string, ...args: string[]) => gitOut(root, cwd, args);

/** `git -c key=value` as environment variables, after the two `nativeGitEnv` sets. */
function configEnv(pairs: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  const entries = Object.entries(pairs);
  entries.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i + 2}`] = key;
    env[`GIT_CONFIG_VALUE_${i + 2}`] = value;
  });
  env.GIT_CONFIG_COUNT = String(entries.length + 2);
  return env;
}

/**
 * A static file server, as t5550's Apache: `/dumb/<path>` is `<docroot>/<path>` (the query
 * ignored), `/dumb-redir/<path>` redirects there (301), `/redir-objects/<repo>/objects/...`
 * redirects to `/dumb/<repo>/objects/...` and serves everything else of `<repo>` itself,
 * and any other path is a file below `rootDir` (when given). Every file is `text/plain`, so
 * no answer reads as smart HTTP.
 */
function staticHandler(rootDir?: string): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    const path = decodeURIComponent(url.pathname);
    const redirect = (to: string) =>
      new Response(null, { status: 301, headers: { location: `${url.origin}${to}` } });
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("method not allowed\n", { status: 405 });
    }
    let file: string | undefined;
    if (path.startsWith("/dumb/")) file = join(docroot, path.slice("/dumb/".length));
    else if (path.startsWith("/dumb-redir/")) {
      return redirect(`/dumb/${path.slice("/dumb-redir/".length)}${url.search}`);
    } else if (path.startsWith("/redir-objects/")) {
      const rest = path.slice("/redir-objects/".length);
      if (/^[^/]+\/objects\//.test(rest)) return redirect(`/dumb/${rest}`);
      file = join(docroot, rest);
    } else if (rootDir) file = join(rootDir, path);
    if (!file || !existsSync(file) || !statSync(file).isFile()) {
      return new Response("not found\n", { status: 404, headers: { "content-type": "text/html" } });
    }
    return new Response(readFileSync(file), {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  };
}

/** Our side: the repository at `dir` (a worktree, or bare), with `env` as its environment. */
async function openOurs(dir: string, env: Record<string, string> = {}): Promise<Git> {
  const files = createNodeFilesApi({ rootDir: root });
  const rel = dir.slice(root.length + 1);
  const gitDir = existsSync(join(dir, ".git")) ? `${rel}/.git` : rel;
  const environment = createNodeGitHostEnvironment({ env: testEnv(root, env) });
  const { history } = await createGitFilesBackend({ files, gitDir, environment });
  const worktrees = await openGitLinkedWorktrees({ files, gitDir, history, environment });
  return Git.fromWorktreeAdmin(await worktrees.openAdmin());
}

/** What a clone or fetch leaves: object format, refs, HEAD, the objects every ref reaches. */
function stateOf(repo: string) {
  return {
    format: git(repo, "rev-parse", "--show-object-format").trim(),
    refs: git(repo, "for-each-ref", "--format=%(refname) %(objectname) %(symref)"),
    head: gitOut(root, repo, ["symbolic-ref", "-q", "HEAD"], {}).trim(),
    objects: git(repo, "rev-list", "--all", "--objects").split("\n").filter(Boolean).sort(),
  };
}

/** Native fsck's verdict on a repository: its exit status and what it reports. */
function fsckOf(repo: string): { status: number | null; stderr: string } {
  const r = spawnSync("git", ["fsck", "--strict", "--no-progress", "--no-dangling"], {
    cwd: repo,
    env: testEnv(root),
  });
  return { status: r.status, stderr: r.stderr.toString() };
}

function fsckClean(repo: string): void {
  const r = fsckOf(repo);
  expect(r.status, r.stderr).toBe(0);
}

/**
 * t5550's 'setup repository' and 'create http-accessible bare repository with loose
 * objects': `<docroot>/repo.git` (main, an annotated tag) kept up to date by
 * update-server-info, its objects loose; returns the source worktree pushing to it.
 */
function setupRepo(): string {
  const src = join(root, "src");
  mkdirSync(src, { recursive: true });
  git(src, "init", "-q", "-b", "main");
  putFile(src, "file", "content1\n");
  git(src, "add", "file");
  git(src, "commit", "-qm", "one");
  putFile(src, "file", "content2\n");
  git(src, "add", "file");
  git(src, "commit", "-qm", "two");
  git(src, "tag", "-a", "-m", "t", "v1");
  const bare = join(docroot, "repo.git");
  git(root, "init", "-q", "--bare", "-b", "main", bare);
  noMaintenance(bare);
  git(src, "push", "-q", bare, "main", "v1");
  git(bare, "update-server-info");
  return src;
}

/** Pushes a new commit (and tag `tag`) from `src` to `repo`, then update-server-info. */
function pushMore(src: string, repo: string, file: string, tag?: string): void {
  putFile(src, file, `${file}\n`);
  git(src, "add", "-A");
  git(src, "commit", "-qm", file);
  if (tag) git(src, "tag", "-a", "-m", tag, tag);
  git(src, "push", "-q", repo, "main", ...(tag ? [tag] : []));
  git(repo, "update-server-info");
}

/** A fresh directory below the test root. */
function fresh(name: string): string {
  return join(root, `${name}-${counter++}`);
}

/** `git clone <url>` by native git and by ours, with the same `git -c` settings. */
async function cloneBoth(
  url: string,
  config: Record<string, string> = {},
  extraEnv: Record<string, string> = {},
): Promise<{
  native: { dir: string; status: number | null; stderr: string };
  ours: { dir: string; error?: Error; messages: string[] };
}> {
  const env = { ...configEnv(config), ...extraEnv };
  const nativeDir = fresh("native");
  const r = await gitAsync(root, root, ["clone", "-q", url, nativeDir], env);
  const oursDir = fresh("ours");
  git(root, "init", "-q", oursDir);
  const ours = await openOurs(oursDir, env);
  let error: Error | undefined;
  let messages: string[] = [];
  try {
    messages = (await ours.clone().setURI(url).call()).messages ?? [];
  } catch (e) {
    error = e as Error;
  }
  return {
    native: { dir: nativeDir, status: r.status, stderr: r.stderr },
    ours: { dir: oursDir, messages, ...(error ? { error } : {}) },
  };
}

/** Both clones succeeded and agree; ours passes native fsck. */
function expectSameClone(result: Awaited<ReturnType<typeof cloneBoth>>): void {
  expect(result.native.status, result.native.stderr).toBe(0);
  expect(result.ours.error).toBeUndefined();
  expect(stateOf(result.ours.dir)).toEqual(stateOf(result.native.dir));
  // the walker's warnings about alternates, as git prints them
  const alternates = (lines: string[]) => lines.filter((l) => l.includes("alternate"));
  expect(alternates(result.ours.messages.join("").split("\n"))).toEqual(
    alternates(result.native.stderr.split("\n")),
  );
  // what native fsck says of the native clone (an empty tree the walk does not fetch, as
  // git's cached object, is missing from both)
  expect(fsckOf(result.ours.dir)).toEqual(fsckOf(result.native.dir));
}

/** Both clones failed. */
function expectBothFail(result: Awaited<ReturnType<typeof cloneBoth>>): void {
  expect(result.native.status, result.native.stderr).not.toBe(0);
  expect(result.ours.error, "ours succeeded where native git failed").toBeDefined();
}

/** `git ls-remote`'s lines without HEAD's (our result names HEAD's branch alone). */
function withoutHead(stdout: string): string {
  return stdout
    .split("\n")
    .filter((line) => line && !line.endsWith("\tHEAD"))
    .map((line) => `${line}\n`)
    .join("");
}

/** `git ls-remote` lines from our result (HEAD left out, as `withoutHead`). */
async function ourLsRemote(
  cwd: string,
  url: string,
  env: Record<string, string> = {},
): Promise<string> {
  const ours = await openOurs(cwd, env);
  const result = await ours.lsRemote().setRemote(url).call();
  return result.refs
    .flatMap((ref) => [
      `${ref.objectId}\t${ref.name}\n`,
      ...(ref.peeledObjectId ? [`${ref.peeledObjectId}\t${ref.name}^{}\n`] : []),
    ])
    .join("");
}

describeHttp("dumb HTTP client: as git's http-walker fetches", () => {
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "http-dumb-client-"));
    docroot = join(root, "www");
    mkdirSync(docroot);
    server = await serveOnLoopback(staticHandler());
  });
  afterEach(async () => {
    await server.close();
    await removeTempDir(root);
  }, CLEANUP_TIMEOUT);

  it('t5550-http-fetch-dumb.sh: "clone http repository"', async () => {
    setupRepo();
    const result = await cloneBoth(`${server.baseUrl}/dumb/repo.git`);
    expectSameClone(result);
    expect(readFileSync(join(result.ours.dir, "file"), "utf8")).toBe("content2\n");
    // t5550 "did not use upload-pack service"
    expect(server.requests.some((r) => r.url.includes("/git-upload-pack"))).toBe(false);
  });

  it('t5550-http-fetch-dumb.sh: "list refs from outside any repository"', async () => {
    setupRepo();
    const url = `${server.baseUrl}/dumb/repo.git`;
    const native = await gitAsync(root, root, ["ls-remote", url]);
    expect(native.status, native.stderr).toBe(0);
    const cwd = fresh("ls");
    git(root, "init", "-q", cwd);
    expect(await ourLsRemote(cwd, url)).toBe(withoutHead(native.stdout));
  });

  it('t5550-http-fetch-dumb.sh: "list detached HEAD from outside any repository"', async () => {
    setupRepo();
    const detached = join(docroot, "repo-detached.git");
    git(root, "clone", "-q", "--mirror", join(docroot, "repo.git"), detached);
    git(detached, "update-ref", "--no-deref", "HEAD", "refs/heads/main");
    git(detached, "update-server-info");
    const url = `${server.baseUrl}/dumb/repo-detached.git`;
    const native = await gitAsync(root, root, ["ls-remote", url]);
    expect(native.status, native.stderr).toBe(0);
    const cwd = fresh("ls");
    git(root, "init", "-q", cwd);
    expect(await ourLsRemote(cwd, url)).toBe(withoutHead(native.stdout));
    expectSameClone(await cloneBoth(url));
  });

  it('t5550-http-fetch-dumb.sh: "empty dumb HTTP repository falls back to SHA1"', async () => {
    const empty = join(docroot, "empty.git");
    git(root, "init", "-q", "--bare", empty);
    git(empty, "update-server-info");
    const result = await cloneBoth(`${server.baseUrl}/dumb/empty.git`);
    expect(result.native.status, result.native.stderr).toBe(0);
    expect(result.ours.error).toBeUndefined();
    expect(stateOf(result.ours.dir)).toEqual(stateOf(result.native.dir));
    expect(stateOf(result.ours.dir).format).toBe("sha1");
  });

  it('t5550-http-fetch-dumb.sh: "fetch changes via http"', async () => {
    const src = setupRepo();
    const repo = join(docroot, "repo.git");
    const result = await cloneBoth(`${server.baseUrl}/dumb/repo.git`);
    expectSameClone(result);
    // a new commit and a new annotated tag on it (followed in a second round: the dumb
    // protocol has no include-tag)
    pushMore(src, repo, "more.txt", "v2");
    const n = await gitAsync(root, result.native.dir, ["pull", "-q", "--no-rebase"]);
    expect(n.status, n.stderr).toBe(0);
    const ours = await openOurs(result.ours.dir);
    await ours.pull().setRemote("origin").call();
    expect(stateOf(result.ours.dir)).toEqual(stateOf(result.native.dir));
    expect(readFileSync(join(result.ours.dir, ".git/FETCH_HEAD"), "utf8")).toBe(
      readFileSync(join(result.native.dir, ".git/FETCH_HEAD"), "utf8"),
    );
    expect(readFileSync(join(result.ours.dir, "more.txt"), "utf8")).toBe("more.txt\n");
    fsckClean(result.ours.dir);
  });

  it('t5550-http-fetch-dumb.sh: "fetch packed objects"', async () => {
    const src = setupRepo();
    const repo = join(docroot, "repo.git");
    git(repo, "repack", "-q", "-a", "-d");
    // a second pack and a loose commit beside it
    pushMore(src, repo, "b.txt");
    git(repo, "repack", "-q", "-d");
    pushMore(src, repo, "c.txt");
    expect(readdirSync(join(repo, "objects/pack")).filter((f) => f.endsWith(".pack")).length).toBe(
      2,
    );
    expectSameClone(await cloneBoth(`${server.baseUrl}/dumb/repo.git`));
  });

  it('t5550-http-fetch-dumb.sh: "fetch can handle previously-fetched .idx files"', async () => {
    // a fetch of a second branch whose objects lie in another pack than the first's
    const src = setupRepo();
    const repo = join(docroot, "repo.git");
    git(repo, "repack", "-q", "-a", "-d");
    git(src, "checkout", "-q", "-b", "branch2");
    putFile(src, "file", "b2\n");
    git(src, "commit", "-qam", "b2");
    git(src, "push", "-q", repo, "branch2");
    git(repo, "repack", "-q", "-d");
    git(repo, "update-server-info");
    const url = `${server.baseUrl}/dumb/repo.git`;
    const dirs: string[] = [];
    for (const side of ["native", "ours"]) {
      const dir = fresh(side);
      git(root, "init", "-q", "--bare", dir);
      dirs.push(dir);
      for (const spec of ["main:main", "branch2:branch2"]) {
        if (side === "native") {
          const r = await gitAsync(root, dir, ["fetch", "-q", url, spec]);
          expect(r.status, r.stderr).toBe(0);
        } else {
          await (await openOurs(dir)).fetch().setRemote(url).setRefSpecs(spec).call();
        }
      }
    }
    expect(stateOf(dirs[1] as string)).toEqual(stateOf(dirs[0] as string));
    fsckClean(dirs[1] as string);
  });

  for (const [title, file] of [
    ["fetch notices corrupt pack", ".pack"],
    ["fetch notices corrupt idx", ".idx"],
  ] as const) {
    it(`t5550-http-fetch-dumb.sh: "${title}"`, async () => {
      setupRepo();
      const repo = join(docroot, "repo.git");
      git(repo, "repack", "-q", "-a", "-d");
      const pack = readdirSync(join(repo, "objects/pack")).find((f) => f.endsWith(file));
      const path = join(repo, "objects/pack", pack as string);
      const bytes = readFileSync(path);
      bytes.fill(0x30, 256, 512); // printf %0256d 0 | dd bs=256 count=1 seek=1
      rmSync(path, { force: true });
      writeFileSync(path, bytes);
      const url = `${server.baseUrl}/dumb/repo.git`;
      const results: Array<{ failed: boolean; packs: string[] }> = [];
      for (const side of ["native", "ours"]) {
        const dir = fresh(side);
        git(root, "init", "-q", "--bare", dir);
        let failed: boolean;
        if (side === "native") {
          failed = (await gitAsync(root, dir, ["fetch", url])).status !== 0;
        } else {
          failed = await (await openOurs(dir))
            .fetch()
            .setRemote(url)
            .call()
            .then(
              () => false,
              () => true,
            );
        }
        const packDir = join(dir, "objects/pack");
        const packs = readdirSync(packDir).filter((f) =>
          file === ".pack" ? f.endsWith(".pack") : true,
        );
        results.push({ failed, packs });
      }
      expect(results[0]).toEqual({ failed: true, packs: [] });
      expect(results[1]).toEqual(results[0]);
    });
  }

  it('t5550-http-fetch-dumb.sh: "dumb http can fetch index v1"', async () => {
    const repo = join(docroot, "idx-v1.git");
    git(root, "init", "-q", "--bare", "-b", "main", repo);
    git(repo, "--work-tree=.", "commit", "-q", "--allow-empty", "-m", "foo");
    git(repo, "-c", "pack.indexVersion=1", "gc", "-q");
    const idx = readdirSync(join(repo, "objects/pack")).find((f) => f.endsWith(".idx"));
    // v1 has no magic number: it starts with the fanout table
    expect(readFileSync(join(repo, "objects/pack", idx as string)).readUInt32BE(0)).not.toBe(
      0xff744f63,
    );
    expectSameClone(await cloneBoth(`${server.baseUrl}/dumb/idx-v1.git`));
  });

  it("dumb http refuses shallow fetches (fetch_dumb's die)", async () => {
    setupRepo();
    const url = `${server.baseUrl}/dumb/repo.git`;
    const native = await gitAsync(root, root, ["clone", "-q", "--depth", "1", url, fresh("n")]);
    expect(native.status).not.toBe(0);
    expect(native.stderr).toContain("dumb http transport does not support shallow capabilities");
    const dir = fresh("ours");
    git(root, "init", "-q", "-b", "main", dir);
    const ours = await openOurs(dir);
    await expect(ours.clone().setURI(url).setDepth(1).call()).rejects.toThrow(
      "dumb http transport does not support shallow capabilities",
    );
  });

  describe("redirects", () => {
    it('t5550-http-fetch-dumb.sh: "redirects can be forbidden/allowed"', async () => {
      setupRepo();
      const url = `${server.baseUrl}/dumb-redir/repo.git`;
      expectBothFail(await cloneBoth(url, { "http.followRedirects": "false" }));
      expectSameClone(await cloneBoth(url, { "http.followRedirects": "true" }));
    });

    it('t5550-http-fetch-dumb.sh: "non-initial redirects can be forbidden"', async () => {
      setupRepo();
      const url = `${server.baseUrl}/redir-objects/repo.git`;
      expectBothFail(await cloneBoth(url, { "http.followRedirects": "initial" }));
      expectSameClone(await cloneBoth(url, { "http.followRedirects": "true" }));
    });

    it('t5550-http-fetch-dumb.sh: "http.followRedirects defaults to \\"initial\\""', async () => {
      setupRepo();
      expectBothFail(await cloneBoth(`${server.baseUrl}/redir-objects/repo.git`));
    });

    it('t5550-http-fetch-dumb.sh: "can redirect through non-"info/refs?service=git-upload-pack" URL"', async () => {
      // the initial redirect of a base URL: later requests go to where it led
      setupRepo();
      expectSameClone(await cloneBoth(`${server.baseUrl}/dumb-redir/repo.git`));
    });
  });

  describe("alternates", () => {
    /** t5550's 'set up evil alternates scheme': evil.git names victim.git's commit. */
    function evil(): { victim: string; evil: string } {
      const victim = join(docroot, "victim.git");
      git(root, "init", "-q", "--bare", "-b", "main", victim);
      git(victim, "--work-tree=.", "commit", "-q", "--allow-empty", "-m", "secret");
      git(victim, "repack", "-q", "-ad");
      git(victim, "update-server-info");
      const id = git(victim, "rev-parse", "HEAD").trim();
      const evilDir = join(docroot, "evil.git");
      git(root, "init", "-q", "--template=", "--bare", evilDir);
      mkdirSync(join(evilDir, "info"));
      writeFileSync(join(evilDir, "info/refs"), `${id}\trefs/heads/main\n`);
      return { victim, evil: evilDir };
    }

    it('t5550-http-fetch-dumb.sh: "http-alternates is a non-initial redirect"', async () => {
      const { evil: evilDir } = evil();
      writeFileSync(
        join(evilDir, "objects/info/http-alternates"),
        `${server.baseUrl}/dumb/victim.git/objects\n`,
      );
      const url = `${server.baseUrl}/dumb/evil.git`;
      expectBothFail(await cloneBoth(url, { "http.followRedirects": "initial" }));
      expectSameClone(await cloneBoth(url, { "http.followRedirects": "true" }));
    });

    it('t5550-http-fetch-dumb.sh: "http-alternates cannot point at funny protocols"', async () => {
      const { victim, evil: evilDir } = evil();
      writeFileSync(join(evilDir, "objects/info/http-alternates"), `file://${victim}/objects\n`);
      expectBothFail(
        await cloneBoth(`${server.baseUrl}/dumb/evil.git`, { "http.followRedirects": "true" }),
      );
    });

    it('t5550-http-fetch-dumb.sh: "http-alternates triggers not-from-user protocol check"', async () => {
      const { evil: evilDir } = evil();
      writeFileSync(
        join(evilDir, "objects/info/http-alternates"),
        `${server.baseUrl}/dumb/victim.git/objects\n`,
      );
      const url = `${server.baseUrl}/dumb/evil.git`;
      expectBothFail(
        await cloneBoth(url, { "http.followRedirects": "true", "protocol.http.allow": "user" }),
      );
      expectSameClone(
        await cloneBoth(url, { "http.followRedirects": "true", "protocol.http.allow": "always" }),
      );
    });

    it('t5550-http-fetch-dumb.sh: "fetching via http alternates works"', async () => {
      const parent = join(docroot, "alt-parent.git");
      git(root, "init", "-q", "--bare", "-b", "main", parent);
      git(parent, "--work-tree=.", "commit", "-q", "--allow-empty", "-m", "foo");
      git(parent, "update-server-info");
      const commit = git(parent, "rev-parse", "HEAD").trim();
      const child = join(docroot, "alt-child.git");
      git(root, "init", "-q", "--bare", "-b", "main", child);
      writeFileSync(join(child, "objects/info/alternates"), "../../alt-parent.git/objects\n");
      git(child, "update-ref", "HEAD", commit);
      git(child, "update-server-info");
      const url = `${server.baseUrl}/dumb/alt-child.git`;
      expectSameClone(await cloneBoth(url, { "http.followredirects": "true" }));
      // without redirects allowed the alternate is not followed, and nothing has the commit
      expectBothFail(await cloneBoth(url));
    });

    it('t5550-http-fetch-dumb.sh: "absolute-path alternate when url has no path"', async () => {
      setupRepo();
      const alt = fresh("absolute-alt.git");
      git(root, "clone", "-q", "--bare", "--shared", join(docroot, "repo.git"), alt);
      writeFileSync(join(alt, "objects/info/http-alternates"), "/dumb/repo.git/objects\n");
      git(alt, "update-server-info");
      const top = fresh("top");
      mkdirSync(top);
      for (const entry of readdirSync(alt)) renameSync(join(alt, entry), join(top, entry));
      const rootServer = await serveOnLoopback(staticHandler(top));
      try {
        const result = await cloneBoth(rootServer.baseUrl, { "http.followRedirects": "true" });
        if (nativeBefore(2, 45)) {
          // git 2.43 crashes here (the fix and the test came later): ours alone, against
          // what the served repository holds
          expect(result.ours.error).toBeUndefined();
          expect(stateOf(result.ours.dir).objects).toEqual(
            git(join(docroot, "repo.git"), "rev-list", "--all", "--objects")
              .split("\n")
              .filter(Boolean)
              .sort(),
          );
          fsckClean(result.ours.dir);
          return;
        }
        expect(result.native.stderr).toContain(
          `adding alternate object store: ${rootServer.baseUrl}/dumb/repo.git`,
        );
        expectSameClone(result);
      } finally {
        await rootServer.close();
      }
    });
  });

  describe("JGit's DumbClientDumbServerTest", () => {
    it("DumbClientDumbServerTest: testListRemote", async () => {
      setupRepo();
      const url = `${server.baseUrl}/dumb/repo.git`;
      const native = await gitAsync(root, root, ["ls-remote", url]);
      const cwd = fresh("ls");
      git(root, "init", "-q", cwd);
      expect(await ourLsRemote(cwd, url)).toBe(withoutHead(native.stdout));
    });

    it("DumbClientDumbServerTest: testInitialClone_Loose", async () => {
      setupRepo();
      expectSameClone(await cloneBoth(`${server.baseUrl}/dumb/repo.git`));
    });

    it("DumbClientDumbServerTest: testInitialClone_Packed", async () => {
      setupRepo();
      git(join(docroot, "repo.git"), "repack", "-q", "-a", "-d");
      expectSameClone(await cloneBoth(`${server.baseUrl}/dumb/repo.git`));
    });

    it("DumbClientDumbServerTest: testPushNotSupported", async () => {
      const src = setupRepo();
      const url = `${server.baseUrl}/dumb/repo.git`;
      git(src, "commit", "-q", "--allow-empty", "-m", "unpushed");
      const before = git(join(docroot, "repo.git"), "rev-parse", "main");
      const native = await gitAsync(root, src, ["push", url, "main:main"]);
      expect(native.status).not.toBe(0);
      const ours = await openOurs(src);
      await expect(ours.push().setRemote(url).add("main:main").call()).rejects.toThrow();
      expect(git(join(docroot, "repo.git"), "rev-parse", "main")).toBe(before);
    });
  });

  describe("JGit's DumbClientSmartServerTest (GIT_SMART_HTTP=0)", () => {
    let backend: ReturnType<typeof nativeGitHttpBackend>;
    let smart: LoopbackServer;
    beforeEach(async () => {
      backend = nativeGitHttpBackend(docroot, root);
      smart = await serveOnLoopback((request) => backend.fetch(request));
    });
    afterEach(async () => {
      await smart.close();
      backend.close();
    });

    it("DumbClientSmartServerTest: testListRemote", async () => {
      setupRepo();
      const url = `${smart.baseUrl}/repo.git`;
      const native = await gitAsync(root, root, ["ls-remote", url], { GIT_SMART_HTTP: "0" });
      expect(native.status, native.stderr).toBe(0);
      const cwd = fresh("ls");
      git(root, "init", "-q", cwd);
      expect(await ourLsRemote(cwd, url, { GIT_SMART_HTTP: "0" })).toBe(withoutHead(native.stdout));
    });

    for (const packed of [false, true]) {
      it(`DumbClientSmartServerTest: ${packed ? "testInitialClone_Packed" : "testInitialClone_Small"}`, async () => {
        setupRepo();
        if (packed) git(join(docroot, "repo.git"), "repack", "-q", "-a", "-d");
        const before = smart.requests.length;
        expectSameClone(await cloneBoth(`${smart.baseUrl}/repo.git`, {}, { GIT_SMART_HTTP: "0" }));
        // neither asked for a service
        const asked = smart.requests.slice(before).map((r) => r.url);
        expect(asked.some((u) => u.includes("service=") || u.includes("/git-upload-pack"))).toBe(
          false,
        );
      });
    }
  });
});
