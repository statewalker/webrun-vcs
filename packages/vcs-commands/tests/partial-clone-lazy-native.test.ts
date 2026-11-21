/**
 * Partial clones with lazy fetch, against native git (2.43 and 2.5x): our `clone
 * --filter=blob:none` with its checkout, `switch`, `diff` with renames, `log -p`, `merge`,
 * `fetch` (the remote's filter, `--refetch`), `repack -a`/gc and `fsck` in a partial clone, each
 * next to native git doing the same against the same server. The server (native http-backend,
 * or ours through `createServedFetchHandler`) counts the upload-pack `fetch` requests, and
 * ours must make as many as native git: one batch per checkout, per diff, per merge, one lazy
 * fetch per object read alone.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { PromisorFetchError } from "@statewalker/vcs-core";
import { createGitFilesBackend, gc, repack } from "@statewalker/vcs-store-files";
import { createBasePathResolver, createServedFetchHandler } from "@statewalker/vcs-transport";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openLocalRemote } from "../src/commands/local-transport.js";
import { type Git, servedRepositoryOf } from "../src/index.js";
import { type LoopbackServer, serveOnLoopback } from "./http-loopback-support.js";
import { openOurs } from "./merge-native-helpers.js";
import { gitAsync } from "./native-connect-support.js";
import { nativeGitAvailable, nativeGitHttpBackend } from "./native-git-http-backend.js";
import { gitOut, gitRun, putFile, testEnv } from "./status-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

const nativeVersion = (() => {
  if (!nativeGitAvailable()) return "2.56" as const;
  const m = /git version (\d+)\.(\d+)/.exec(execFileSync("git", ["--version"]).toString());
  return m && Number(m[1]) === 2 && Number(m[2]) < 45 ? ("2.43" as const) : ("2.56" as const);
})();

let root: string;
let srv: string;
let counter = 0;
const git = (cwd: string, ...args: string[]) => gitOut(root, cwd, args);
const commitEnv = (n: number) => ({
  GIT_AUTHOR_DATE: `170000000${n} +0000`,
  GIT_COMMITTER_DATE: `170000000${n} +0000`,
});

/** The upload-pack requests a server answered: `fetch` commands (v2) and v0 POSTs, ls-refs. */
interface Counts {
  fetch: number;
  lsRefs: number;
}

/** Wraps a handler, counting upload-pack requests into `counts`. */
function counting(
  handler: (request: Request) => Promise<Response>,
  counts: Counts,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname.endsWith("/git-upload-pack")) {
      const raw = Buffer.from(await request.clone().arrayBuffer());
      const body = request.headers.get("content-encoding") === "gzip" ? gunzipSync(raw) : raw;
      const text = body.toString("latin1");
      if (text.includes("command=ls-refs")) counts.lsRefs++;
      else counts.fetch++;
    }
    return handler(request);
  };
}

/** The files of a worktree (not `.git`), path to content, sorted. */
function worktreeFiles(dir: string, sub = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(join(dir, sub)).sort()) {
    if (sub === "" && name === ".git") continue;
    const path = sub ? `${sub}/${name}` : name;
    try {
      out[path] = readFileSync(join(dir, path), "latin1");
    } catch {
      Object.assign(out, worktreeFiles(dir, path));
    }
  }
  return out;
}

/** What a repository holds: present and missing (`?<id>`) objects, sorted. */
const objectsOf = (dir: string) =>
  git(dir, "rev-list", "--objects", "--all", "--missing=print")
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split(" ")[0] as string)
    .sort();

/** Each pack of a repository: whether it is a promisor pack, and its object ids. */
function packsOf(dir: string): string[] {
  const pack = join(dir, ".git/objects/pack");
  return readdirSync(pack)
    .filter((n) => n.endsWith(".idx"))
    .map((n) => {
      const ids = execFileSync("git", ["show-index"], {
        input: readFileSync(join(pack, n)),
        env: testEnv(root),
      })
        .toString()
        .split("\n")
        .filter(Boolean)
        .map((l) => l.split(" ")[1])
        .sort();
      const promisor = readdirSync(pack).includes(n.replace(/\.idx$/, ".promisor"));
      return `${promisor ? "promisor" : "pack"}: ${ids.join(",")}`;
    })
    .sort();
}

/** The loose objects of a repository, sorted. */
function looseOf(dir: string): string[] {
  const objects = join(dir, ".git/objects");
  const out: string[] = [];
  for (const d of readdirSync(objects)) {
    if (!/^[0-9a-f]{2}$/.test(d)) continue;
    for (const f of readdirSync(join(objects, d))) out.push(d + f);
  }
  return out.sort();
}

/** The `.promisor` files of a repository: how many, and their contents sorted. */
function promisorFiles(dir: string): string[] {
  const pack = join(dir, ".git/objects/pack");
  return readdirSync(pack)
    .filter((n) => n.endsWith(".promisor"))
    .map((n) => readFileSync(join(pack, n), "latin1"))
    .sort();
}

describeGit("partial clones with lazy fetch, as native git", () => {
  let native: { server: LoopbackServer; counts: Counts; close(): Promise<void> };
  let mine: { server: LoopbackServer; counts: Counts };
  let host: Git;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "partial-lazy-"));
    srv = join(root, "srv");
    mkdirSync(srv);
    const work = join(root, "work");
    git(root, "init", "-q", "-b", "main", work);
    const lines = (tag: string, n: number) =>
      Array.from({ length: n }, (_, i) => `${tag} line ${i}\n`).join("");
    putFile(work, "a.txt", lines("a", 12));
    putFile(work, "dir/b.txt", lines("b", 5));
    putFile(work, "dir/c.txt", lines("c", 5));
    putFile(work, "move.txt", lines("move", 30));
    putFile(work, "same.txt", lines("same", 8));
    git(work, "add", ".");
    gitOut(root, work, ["commit", "-qm", "c1"], commitEnv(1));
    ids.c1 = git(work, "rev-parse", "HEAD").trim();
    // c2: an inexact rename to another basename, an exact one, a modification
    git(work, "mv", "move.txt", "moved.txt");
    putFile(work, "moved.txt", `${lines("move", 30)}one more\n`);
    git(work, "mv", "same.txt", "dir/same-renamed.txt");
    putFile(work, "a.txt", `${lines("a", 12)}a end\n`);
    git(work, "add", "-A");
    gitOut(root, work, ["commit", "-qm", "c2"], commitEnv(2));
    ids.c2 = git(work, "rev-parse", "HEAD").trim();
    // side: from c1, other files
    git(work, "checkout", "-q", "-b", "side", ids.c1);
    putFile(work, "side.txt", lines("side", 4));
    putFile(work, "dir/b.txt", lines("b2", 5));
    git(work, "add", ".");
    gitOut(root, work, ["commit", "-qm", "s1"], commitEnv(3));
    // m1 and m2: both change a.txt from c2, apart (a clean content merge)
    git(work, "checkout", "-q", "-b", "m1", ids.c2);
    putFile(work, "a.txt", `first\n${lines("a", 12).slice(11)}a end\n`);
    git(work, "commit", "-qam", "m1");
    git(work, "checkout", "-q", "-b", "m2", ids.c2);
    putFile(work, "a.txt", `${lines("a", 12)}a end\nm2 end\n`);
    putFile(work, "dir/c.txt", lines("c2", 5));
    git(work, "commit", "-qam", "m2");
    git(work, "checkout", "-q", "main");
    git(root, "clone", "-q", "--bare", "--no-local", work, join(srv, "repo.git"));
    git(join(srv, "repo.git"), "config", "uploadpack.allowFilter", "true");
    git(join(srv, "repo.git"), "config", "uploadpack.allowAnySHA1InWant", "true");

    const backend = nativeGitHttpBackend(srv, root);
    const nativeCounts: Counts = { fetch: 0, lsRefs: 0 };
    const server = await serveOnLoopback(counting((r) => backend.fetch(r), nativeCounts));
    native = {
      server,
      counts: nativeCounts,
      close: async () => {
        await server.close();
        backend.close();
      },
    };
    host = await openOurs(
      root,
      createNodeGitHostEnvironment({ env: testEnv(root) }),
      undefined,
      "work",
    );
    const resolveRepository = createBasePathResolver({
      files: createNodeFilesApi({ rootDir: srv }),
      exportAll: true,
      openRepository: async (gitDir) => {
        const opened = await openLocalRemote(host.workingCopy, `../srv${gitDir}`).catch(
          () => undefined,
        );
        return opened ? servedRepositoryOf(opened) : undefined;
      },
    });
    const myCounts: Counts = { fetch: 0, lsRefs: 0 };
    mine = {
      server: await serveOnLoopback(
        counting(createServedFetchHandler({ resolveRepository }), myCounts),
      ),
      counts: myCounts,
    };
  });

  afterAll(async () => {
    await native?.close();
    await mine?.server.close();
    rmSync(root, { recursive: true, force: true });
  });

  /** An empty repository for our side. */
  async function oursAt(name: string): Promise<{ dir: string; ours: Git }> {
    const dir = join(root, `${name}-${counter++}`);
    git(root, "init", "-q", "-b", "main", dir);
    return { dir, ours: await reopen(dir) };
  }

  function reopen(dir: string, env: Record<string, string> = {}): Promise<Git> {
    return openOurs(
      root,
      createNodeGitHostEnvironment({ env: testEnv(root, env) }),
      undefined,
      dir.slice(root.length + 1),
    );
  }

  /** Runs `run` and returns how many fetch requests the server answered meanwhile. */
  async function fetchesOf(counts: Counts, run: () => Promise<unknown>): Promise<number> {
    const before = counts.fetch;
    await run();
    if (process.env.DEBUG_COUNTS) console.log("fetches", counts.fetch - before);
    return counts.fetch - before;
  }

  /** A native partial clone and ours of the native server's repository, checked out. */
  async function twins(name: string, server: { server: LoopbackServer; counts: Counts } = native) {
    const url = `${server.server.baseUrl}/repo.git`;
    const theirs = join(root, `n-${name}-${counter++}`);
    const nativeFetches = await fetchesOf(server.counts, async () => {
      const r = await gitAsync(root, root, ["clone", "-q", "--filter=blob:none", url, theirs]);
      expect(r.status, r.stderr).toBe(0);
    });
    const { dir, ours } = await oursAt(`o-${name}`);
    const ourFetches = await fetchesOf(server.counts, () =>
      ours.clone().setURI(url).setFilter("blob:none").call(),
    );
    return { theirs, dir, ours: await reopen(dir), nativeFetches, ourFetches, url };
  }

  it("clone --filter=blob:none with its checkout fetches as often as native git", async () => {
    const t = await twins("clone");
    expect(t.ourFetches).toBe(t.nativeFetches);
    expect(t.nativeFetches).toBe(2);
    expect(worktreeFiles(t.dir)).toEqual(worktreeFiles(t.theirs));
    expect(objectsOf(t.dir)).toEqual(objectsOf(t.theirs));
    expect(promisorFiles(t.dir)).toEqual(promisorFiles(t.theirs));
    expect(git(t.dir, "status", "--porcelain")).toBe("");
  });

  it("clone from our server: native git and ours fetch alike", async () => {
    const t = await twins("ours-server", mine);
    expect(t.ourFetches).toBe(t.nativeFetches);
    expect(worktreeFiles(t.dir)).toEqual(worktreeFiles(t.theirs));
    expect(objectsOf(t.dir)).toEqual(objectsOf(t.theirs));
  });

  it("switch to another branch fetches its missing blobs in one batch", async () => {
    const t = await twins("switch");
    const n = await fetchesOf(native.counts, async () => {
      const r = await gitAsync(root, t.theirs, ["switch", "-q", "side"]);
      expect(r.status, r.stderr).toBe(0);
    });
    const o = await fetchesOf(native.counts, () => t.ours.switch().setName("side").call());
    expect(o).toBe(n);
    expect(n).toBe(1);
    expect(worktreeFiles(t.dir)).toEqual(worktreeFiles(t.theirs));
    expect(promisorFiles(t.dir)).toEqual(promisorFiles(t.theirs));
  });

  it("diff HEAD~1 HEAD (a patch, renames) prefetches as git does", async () => {
    const t = await twins("diff");
    let theirs = "";
    const n = await fetchesOf(native.counts, async () => {
      theirs = (await gitAsync(root, t.theirs, ["diff", "HEAD~1", "HEAD"])).stdout;
    });
    let mineText = "";
    const o = await fetchesOf(native.counts, async () => {
      mineText = await t.ours.diff().setOldTree("HEAD~1").setNewTree("HEAD").callText();
    });
    expect(mineText).toBe(theirs);
    expect(o).toBe(n);
    expect(n).toBe(1);
  });

  it("diff --name-status of an inexact rename prefetches in rename detection", async () => {
    const t = await twins("diff-rename");
    let theirs = "";
    const n = await fetchesOf(native.counts, async () => {
      theirs = (await gitAsync(root, t.theirs, ["diff", "--name-status", "HEAD~1", "HEAD"])).stdout;
    });
    let mineText = "";
    const o = await fetchesOf(native.counts, async () => {
      mineText = await t.ours
        .diff()
        .setOldTree("HEAD~1")
        .setNewTree("HEAD")
        .callText("name-status");
    });
    expect(mineText).toBe(theirs);
    expect(o).toBe(n);
  });

  it("log -p fetches per commit as git's diff does", async () => {
    const t = await twins("log");
    let theirs = "";
    const n = await fetchesOf(native.counts, async () => {
      theirs = (await gitAsync(root, t.theirs, ["log", "-p"])).stdout;
    });
    let mineText = "";
    const o = await fetchesOf(native.counts, async () => {
      mineText = await t.ours.log().callText({ patch: true });
    });
    expect(mineText).toBe(theirs);
    expect(o).toBe(n);
  });

  it("merge of a content change prefetches the blobs to merge", async () => {
    const t = await twins("merge");
    expect((await gitAsync(root, t.theirs, ["switch", "-q", "m2"])).status).toBe(0);
    await t.ours.switch().setName("m2").call();
    const n = await fetchesOf(native.counts, async () => {
      const r = await gitAsync(root, t.theirs, ["merge", "-q", "--no-edit", "origin/m1"]);
      expect(r.status, r.stderr).toBe(0);
    });
    const ours = await reopen(t.dir);
    const o = await fetchesOf(native.counts, () => ours.merge().include("origin/m1").call());
    expect(o).toBe(n);
    expect(worktreeFiles(t.dir)).toEqual(worktreeFiles(t.theirs));
    expect(git(t.dir, "rev-parse", "HEAD^{tree}")).toBe(git(t.theirs, "rev-parse", "HEAD^{tree}"));
  });

  /** The same local commit in both twins, made by native git. */
  function commitInBoth(t: { theirs: string; dir: string }) {
    for (const dir of [t.theirs, t.dir]) {
      putFile(dir, "local.txt", "local\n");
      git(dir, "add", "local.txt");
      gitOut(root, dir, ["commit", "-qm", "local"], commitEnv(7));
    }
    expect(git(t.dir, "rev-parse", "HEAD")).toBe(git(t.theirs, "rev-parse", "HEAD"));
  }

  it("repack -a keeps the promisor objects in a promisor pack, as git", async () => {
    const t = await twins("repack");
    commitInBoth(t);
    git(t.theirs, "repack", "-a", "-d", "-q");
    const backend = await createGitFilesBackend({ files: createNodeFilesApi({ rootDir: t.dir }) });
    const result = await repack(backend);
    expect(result).not.toBeNull();
    expect(packsOf(t.dir)).toEqual(packsOf(t.theirs));
    expect(promisorFiles(t.dir)).toEqual([""]);
    expect(promisorFiles(t.dir)).toEqual(promisorFiles(t.theirs));
    expect(looseOf(t.dir)).toEqual(looseOf(t.theirs));
    const fsck = gitRun(root, t.dir, ["fsck"]);
    expect(fsck.status, fsck.stdout + fsck.stderr).toBe(0);
    expect(objectsOf(t.dir)).toEqual(objectsOf(t.theirs));
  });

  it("gc keeps the partial clone working: native fsck passes, the packs match git gc's", async () => {
    const t = await twins("gc");
    commitInBoth(t);
    git(t.theirs, "gc", "-q");
    const backend = await createGitFilesBackend({ files: createNodeFilesApi({ rootDir: t.dir }) });
    const result = await gc({ ...backend, writeCommitGraph: false });
    expect(result.skipped).toBe(false);
    expect(packsOf(t.dir)).toEqual(packsOf(t.theirs));
    expect(promisorFiles(t.dir)).toEqual(promisorFiles(t.theirs));
    const fsck = gitRun(root, t.dir, ["fsck"]);
    expect(fsck.status, fsck.stdout + fsck.stderr).toBe(0);
    // still a working partial clone: a switch fetches what it lacks
    await (await reopen(t.dir)).switch().setName("side").call();
    expect((await gitAsync(root, t.theirs, ["switch", "-q", "side"])).status).toBe(0);
    expect(worktreeFiles(t.dir)).toEqual(worktreeFiles(t.theirs));
  });

  it("fsck of a partial clone reports no missing promised object, as git", async () => {
    const t = await twins("fsck");
    for (const [dir, label] of [
      [t.dir, "ours"],
      [t.theirs, "native's"],
    ] as const) {
      const theirs = gitRun(root, dir, [
        "fsck",
        ...(nativeVersion === "2.56" ? ["--no-references"] : []),
      ]);
      const g = await reopen(dir);
      const ours = await g
        .fsck()
        .setRepositoryFiles({
          files: createNodeFilesApi({ rootDir: root }),
          gitDir: `${dir.slice(root.length + 1)}/.git`,
        })
        .setCompatibility(nativeVersion)
        .call();
      expect(ours.output, label).toBe(theirs.stdout);
      expect(ours.exitCode, label).toBe(theirs.status);
      expect(ours.exitCode, label).toBe(0);
    }
  });

  it("a later fetch uses the remote's partialclonefilter and writes a promisor pack", async () => {
    // the server grows by one commit with new blobs
    const grow = join(srv, "grow.git");
    git(root, "clone", "-q", "--bare", "--no-local", join(srv, "repo.git"), grow);
    git(grow, "config", "uploadpack.allowFilter", "true");
    const url = `${native.server.baseUrl}/grow.git`;
    const theirs = join(root, `n-fetch-${counter++}`);
    expect(
      (await gitAsync(root, root, ["clone", "-q", "--filter=blob:none", url, theirs])).status,
    ).toBe(0);
    const { dir, ours } = await oursAt("o-fetch");
    await ours.clone().setURI(url).setFilter("blob:none").call();
    const work = join(root, `w-fetch-${counter++}`);
    git(root, "clone", "-q", "--no-local", grow, work);
    putFile(work, "new.txt", "new blob\n");
    putFile(work, "a.txt", "changed\n");
    git(work, "add", ".");
    gitOut(root, work, ["commit", "-qm", "c3"], commitEnv(8));
    git(work, "push", "-q", grow, "main");
    const n = await fetchesOf(native.counts, async () => {
      const r = await gitAsync(root, theirs, ["fetch", "-q", "origin"]);
      expect(r.status, r.stderr).toBe(0);
    });
    const o = await fetchesOf(native.counts, async () => {
      await (await reopen(dir)).fetch().setRemote("origin").call();
    });
    expect(o).toBe(n);
    expect(objectsOf(dir)).toEqual(objectsOf(theirs));
    expect(promisorFiles(dir)).toEqual(promisorFiles(theirs));
    // the new blobs come when needed
    await (await reopen(dir)).merge().include("origin/main").call();
    expect((await gitAsync(root, theirs, ["merge", "-q", "origin/main"])).status).toBe(0);
    expect(worktreeFiles(dir)).toEqual(worktreeFiles(theirs));
  });

  it("fetch --refetch fetches the whole history again under the filter", async () => {
    const t = await twins("refetch");
    const n = await fetchesOf(native.counts, async () => {
      const r = await gitAsync(root, t.theirs, ["fetch", "-q", "--refetch", "origin"]);
      expect(r.status, r.stderr).toBe(0);
    });
    const o = await fetchesOf(native.counts, async () => {
      await (await reopen(t.dir)).fetch().setRemote("origin").setRefetch(true).call();
    });
    expect(o).toBe(n);
    expect(objectsOf(t.dir)).toEqual(objectsOf(t.theirs));
    expect(promisorFiles(t.dir).length).toBe(promisorFiles(t.theirs).length);
  });

  it("fetch --filter=blob:none in a full clone makes it a partial clone", async () => {
    const url = `${native.server.baseUrl}/repo.git`;
    const theirs = join(root, `n-filter-${counter++}`);
    expect((await gitAsync(root, root, ["clone", "-q", "--depth=1", url, theirs])).status).toBe(0);
    const { dir, ours } = await oursAt("o-filter");
    await ours.clone().setURI(url).setDepth(1).call();
    const r = await gitAsync(root, theirs, [
      "fetch",
      "-q",
      "--unshallow",
      "--filter=blob:none",
      "origin",
    ]);
    expect(r.status, r.stderr).toBe(0);
    await (await reopen(dir))
      .fetch()
      .setRemote("origin")
      .setUnshallow(true)
      .setFilter("blob:none")
      .call();
    const config = (d: string) =>
      git(
        d,
        "config",
        "--get-regexp",
        "^(core\\.repositoryformatversion|remote\\.origin\\.(promisor|partialclonefilter))$",
      );
    expect(config(dir)).toBe(config(theirs));
    expect(objectsOf(dir)).toEqual(objectsOf(theirs));
  });

  it.runIf(nativeVersion === "2.56")(
    "GIT_NO_LAZY_FETCH=1: the checkout's batch is refused with git's lines",
    async () => {
      const url = `${native.server.baseUrl}/repo.git`;
      const theirs = join(root, `n-nolazy-${counter++}`);
      expect(
        (
          await gitAsync(root, root, [
            "clone",
            "-q",
            "--no-checkout",
            "--filter=blob:none",
            url,
            theirs,
          ])
        ).status,
      ).toBe(0);
      const { dir, ours } = await oursAt("o-nolazy");
      await ours.clone().setURI(url).setFilter("blob:none").setNoCheckout(true).call();
      const n = await gitAsync(root, theirs, ["switch", "-q", "side"], { GIT_NO_LAZY_FETCH: "1" });
      expect(n.status).toBe(128);
      const g = await reopen(dir, { GIT_NO_LAZY_FETCH: "1" });
      let error: unknown;
      try {
        await g.switch().setName("side").call();
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(PromisorFetchError);
      const lines = [
        ...(error as PromisorFetchError).warnings,
        `fatal: ${(error as PromisorFetchError).message}`,
      ];
      expect(lines.join("\n")).toBe(n.stderr.trimEnd());
    },
  );

  it("native git reads our partial clone, and ours reads native's, fetching lazily", async () => {
    const t = await twins("cross");
    // native git in ours: log -p fetches what it lacks
    const theirsLog = (await gitAsync(root, t.theirs, ["log", "-p", "origin/side"])).stdout;
    const r = await gitAsync(root, t.dir, ["log", "-p", "origin/side"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe(theirsLog);
    // ours in native's clone (its .promisor content, its lazily fetched pack)
    const fresh = join(root, `n-cross2-${counter++}`);
    expect(
      (await gitAsync(root, root, ["clone", "-q", "--filter=blob:none", t.url, fresh])).status,
    ).toBe(0);
    const g = await reopen(fresh);
    expect(await g.log().callText({ patch: true })).toBe(
      (await gitAsync(root, t.dir, ["log", "-p"])).stdout,
    );
    await (await reopen(fresh)).switch().setName("m1").call();
    expect((await gitAsync(root, t.theirs, ["switch", "-q", "m1"])).status).toBe(0);
    expect(worktreeFiles(fresh)).toEqual(worktreeFiles(t.theirs));
    const fsck = gitRun(root, fresh, ["fsck"]);
    expect(fsck.status, fsck.stdout + fsck.stderr).toBe(0);
  });

  it("blame fetches each blob it reads, as git does", async () => {
    const t = await twins("blame");
    let theirs = "";
    const n = await fetchesOf(native.counts, async () => {
      theirs = (await gitAsync(root, t.theirs, ["blame", "-s", "a.txt"])).stdout;
    });
    let lineCount = 0;
    const o = await fetchesOf(native.counts, async () => {
      lineCount = (await t.ours.blame().setFilePath("a.txt").call()).lineCount;
    });
    expect(o).toBe(n);
    expect(lineCount).toBe(theirs.trimEnd().split("\n").length);
  });

  it("repack -a --filter=blob:none moves the blobs out of the new pack, as git", async () => {
    const url = `${native.server.baseUrl}/repo.git`;
    const theirs = join(root, `n-rfilter-${counter++}`);
    expect((await gitAsync(root, root, ["clone", "-q", url, theirs])).status).toBe(0);
    const { dir, ours } = await oursAt("o-rfilter");
    await ours.clone().setURI(url).call();
    const r = await gitAsync(root, theirs, ["repack", "-a", "-d", "-q", "--filter=blob:none"]);
    expect(r.status, r.stderr).toBe(0);
    const backend = await createGitFilesBackend({ files: createNodeFilesApi({ rootDir: dir }) });
    const result = await repack({ ...backend, filter: "blob:none" });
    expect(result?.filteredPack).toBeDefined();
    expect(packsOf(dir)).toEqual(packsOf(theirs));
    expect(gitRun(root, dir, ["fsck"]).status).toBe(0);
  });
});
