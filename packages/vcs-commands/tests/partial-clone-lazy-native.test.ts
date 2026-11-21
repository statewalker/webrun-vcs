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
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { GcOrchestrator, PromisorFetchError } from "@statewalker/vcs-core";
import { createGitFilesBackend, FileGcStrategy, gc, repack } from "@statewalker/vcs-store-files";
import { createBasePathResolver, createServedFetchHandler } from "@statewalker/vcs-transport";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openLocalRemote } from "../src/commands/local-transport.js";
import { type Git, installPromisorFetcher, servedRepositoryOf } from "../src/index.js";
import { type LoopbackServer, serveOnLoopback } from "./http-loopback-support.js";
import { openOurs } from "./merge-native-helpers.js";
import { gitAsync } from "./native-connect-support.js";
import {
  nativeGitAvailable,
  nativeGitHttpBackend,
  noMaintenance,
} from "./native-git-http-backend.js";
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

  /** A bare copy of the server's repository, served by both servers, for a test to change. */
  function serverCopy(name: string): { bare: string; path: string } {
    const bare = join(srv, `${name}.git`);
    git(root, "clone", "-q", "--bare", "--no-local", join(srv, "repo.git"), bare);
    git(bare, "config", "uploadpack.allowFilter", "true");
    git(bare, "config", "uploadpack.allowAnySHA1InWant", "true");
    noMaintenance(bare);
    return { bare, path: `/${name}.git` };
  }

  /**
   * Whether a repository stores an object, read without lazy fetch (native `cat-file` would
   * fetch it from the servers this process runs, which spawnSync would block)
   */
  const stores = async (dir: string, id: string) => {
    const { objects } = await createGitFilesBackend({
      files: createNodeFilesApi({ rootDir: dir }),
    });
    return objects.has(id);
  };

  /**
   * git 2.48+'s repack_local_links: a local commit C, pushed and repacked, that the server then
   * built D on. Native 2.56's filtered fetch of D packs C (with what it reaches outside the
   * promisor packs) into one more promisor pack, so gc keeps it; ours too. git 2.43 has no
   * repack_local_links: its gc then loses C (and dies on the missing object), which ours never
   * does (C is a root of its walk as a promisor object's local link).
   */
  async function localLinkTwins(name: string) {
    const { bare, path } = serverCopy(name);
    const url = `${native.server.baseUrl}${path}`;
    const theirs = join(root, `n-${name}-${counter++}`);
    expect(
      (await gitAsync(root, root, ["clone", "-q", "--filter=blob:none", url, theirs])).status,
    ).toBe(0);
    const { dir, ours } = await oursAt(`o-${name}`);
    await ours.clone().setURI(url).setFilter("blob:none").call();
    commitInBoth({ theirs, dir });
    const c = git(theirs, "rev-parse", "HEAD").trim();
    git(theirs, "push", "-q", bare, "main");
    git(theirs, "repack", "-a", "-d", "-q");
    await repack(await createGitFilesBackend({ files: createNodeFilesApi({ rootDir: dir }) }));
    // the server builds D on C
    const work = join(root, `w-${name}-${counter++}`);
    git(root, "clone", "-q", "--no-local", bare, work);
    putFile(work, "d.txt", "d\n");
    git(work, "add", "d.txt");
    gitOut(root, work, ["commit", "-qm", "D"], commitEnv(9));
    git(work, "push", "-q", bare, "main");
    return { theirs, dir, url, c };
  }

  /** main moved to origin/main, the reflogs gone: only promisor objects name C. */
  function forgetLocalCommit(dir: string) {
    git(dir, "update-ref", "refs/heads/main", "refs/remotes/origin/main");
    rmSync(join(dir, ".git/logs"), { recursive: true, force: true });
  }

  it("a fetch packs the local commits a promisor pack links to, so gc keeps them", async () => {
    const t = await localLinkTwins("locallinks");
    const r = await gitAsync(root, t.theirs, ["fetch", "-q", "origin"]);
    expect(r.status, r.stderr).toBe(0);
    await (await reopen(t.dir)).fetch().setRemote("origin").call();
    if (nativeVersion === "2.56") expect(packsOf(t.dir)).toEqual(packsOf(t.theirs));
    for (const dir of [t.theirs, t.dir]) forgetLocalCommit(dir);
    const backend = await createGitFilesBackend({ files: createNodeFilesApi({ rootDir: t.dir }) });
    const result = await gc({ ...backend, pruneExpireMs: 0, writeCommitGraph: false });
    expect(result.skipped).toBe(false);
    expect(await stores(t.dir, t.c)).toBe(true);
    const fsck = gitRun(root, t.dir, ["fsck"]);
    expect(fsck.status, fsck.stdout + fsck.stderr).toBe(0);
    if (nativeVersion === "2.56") {
      const g = gitRun(root, t.theirs, ["gc", "-q", "--prune=now"]);
      expect(g.status, g.stderr).toBe(0);
      expect(await stores(t.theirs, t.c)).toBe(true);
      expect(packsOf(t.dir)).toEqual(packsOf(t.theirs));
      expect(promisorFiles(t.dir)).toEqual(promisorFiles(t.theirs));
    }
  });

  it("gc keeps a local commit only a promisor commit links to, with no pack holding it apart", async () => {
    const t = await localLinkTwins("locallinks-gc");
    // native's fetch (2.43: no repack_local_links; 2.56: its extra pack made an ordinary one)
    const r = await gitAsync(root, t.theirs, ["fetch", "-q", "origin"]);
    expect(r.status, r.stderr).toBe(0);
    const pack = join(t.theirs, ".git/objects/pack");
    for (const name of readdirSync(pack).filter((n) => n.endsWith(".promisor"))) {
      const idx = join(pack, name.replace(/\.promisor$/, ".idx"));
      const ids = execFileSync("git", ["show-index"], {
        input: readFileSync(idx),
        env: testEnv(root),
      }).toString();
      if (ids.includes(t.c)) rmSync(join(pack, name));
    }
    forgetLocalCommit(t.theirs);
    const backend = await createGitFilesBackend({
      files: createNodeFilesApi({ rootDir: t.theirs }),
    });
    await gc({ ...backend, pruneExpireMs: 0, writeCommitGraph: false });
    expect(await stores(t.theirs, t.c)).toBe(true);
    const fsck = gitRun(root, t.theirs, ["fsck"]);
    expect(fsck.status, fsck.stdout + fsck.stderr).toBe(0);
  });

  it("a lazy fetch whose pack lacks the object fails as git's, and is not retried silently", async () => {
    const { bare, path } = serverCopy("wrongpack");
    const t = await twins("wrongpack");
    const wanted = git(t.theirs, "rev-parse", "origin/side:side.txt").trim();
    const other = git(bare, "rev-parse", "main:a.txt").trim();
    // a server whose pack-objects answers any want with one other blob
    const hook = join(root, `wrong-pack-${counter++}.sh`);
    writeFileSync(
      hook,
      `#!/bin/sh\ncat >/dev/null\necho ${other} | git pack-objects --stdout -q\n`,
      { mode: 0o755 },
    );
    const backend = nativeGitHttpBackend(srv, root, {
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_2: "uploadpack.packObjectsHook",
      GIT_CONFIG_VALUE_2: hook,
    });
    const server = await serveOnLoopback((r) => backend.fetch(r));
    try {
      const url = `${server.baseUrl}${path}`;
      for (const dir of [t.theirs, t.dir]) git(dir, "remote", "set-url", "origin", url);
      const n = await gitAsync(root, t.theirs, ["cat-file", "-p", wanted]);
      expect(n.status).toBe(128);
      const g = await reopen(t.dir);
      // the fetcher every command installs (none constructed here)
      const promisor = installPromisorFetcher(g.workingCopy, { compatibility: nativeVersion });
      const before = promisor?.fetchCount ?? 0;
      let error: unknown;
      try {
        await g.workingCopy.history.blobs.load(wanted);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(PromisorFetchError);
      const lines = [
        ...(error as PromisorFetchError).warnings,
        `fatal: ${(error as PromisorFetchError).message}`,
      ];
      expect(lines.join("\n")).toBe(n.stderr.trimEnd());
      expect(promisor?.fetchCount).toBe(before + 1);
      // nothing of the refused pack stays
      expect(await stores(t.dir, other)).toBe(await stores(t.theirs, other));
    } finally {
      await server.close();
      backend.close();
    }
  });

  it("the lazy fetch checks objects with transfer.fsckObjects, as fetch-pack's --fsck-objects", async () => {
    const { bare, path } = serverCopy("badtree");
    const blob = git(bare, "rev-parse", "main:a.txt").trim();
    // a tree with two entries of one name (duplicateEntries, an error), named by nothing
    const entry = Buffer.concat([Buffer.from("100644 a\0"), Buffer.from(blob, "hex")]);
    const tree = execFileSync(
      "git",
      ["hash-object", "-t", "tree", "--literally", "-w", "--stdin"],
      {
        cwd: bare,
        input: Buffer.concat([entry, entry]),
        env: testEnv(root),
      },
    )
      .toString()
      .trim();
    const url = `${native.server.baseUrl}${path}`;
    const theirs = join(root, `n-badtree-${counter++}`);
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
    const { dir, ours } = await oursAt("o-badtree");
    await ours.clone().setURI(url).setFilter("blob:none").setNoCheckout(true).call();
    for (const d of [theirs, dir]) git(d, "config", "transfer.fsckObjects", "true");
    const n = await gitAsync(root, theirs, ["cat-file", "-t", tree]);
    expect(n.status).toBe(128);
    const g = await reopen(dir);
    const promisor = installPromisorFetcher(g.workingCopy, { compatibility: nativeVersion });
    const before = promisor?.warnings.length ?? 0;
    expect(await g.workingCopy.history.objects?.get(tree)).toBeUndefined();
    // the fetch's lines (cat-file's own death after them is not ours to print)
    const nativeLines = n.stderr.trimEnd().split("\n");
    expect(promisor?.warnings.slice(before)).toEqual(nativeLines.slice(0, -1));
    expect(nativeLines.some((l) => l.includes("duplicateEntries"))).toBe(true);
    expect(await stores(dir, tree)).toBe(false);
  });

  it("fsck with a corrupt promisor pack: git's lines and exit code", async () => {
    const url = `${native.server.baseUrl}/repo.git`;
    const theirs = join(root, `n-corrupt-${counter++}`);
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
    const pack = join(theirs, ".git/objects/pack");
    const file = join(pack, readdirSync(pack).find((n) => n.endsWith(".pack")) as string);
    chmodSync(file, 0o644);
    const bytes = readFileSync(file);
    bytes.fill(0xff, bytes.length >> 1, (bytes.length >> 1) + 4);
    writeFileSync(file, bytes);
    const nativeFsck = gitRun(root, theirs, [
      "fsck",
      ...(nativeVersion === "2.56" ? ["--no-references"] : []),
    ]);
    const ours = await (await reopen(theirs))
      .fsck()
      .setRepositoryFiles({ files: createNodeFilesApi({ rootDir: theirs }), gitDir: ".git" })
      .setCompatibility(nativeVersion)
      .call();
    expect(ours.output).toBe(nativeFsck.stdout);
    expect(ours.errorOutput).toBe(nativeFsck.stderr);
    expect(ours.exitCode).toBe(nativeFsck.status);
  });

  it("a remote with only partialclonefilter is a promisor remote to gc, as git", async () => {
    const t = await twins("filteronly");
    for (const dir of [t.theirs, t.dir]) git(dir, "config", "--unset", "remote.origin.promisor");
    commitInBoth(t);
    git(t.theirs, "gc", "-q");
    const backend = await createGitFilesBackend({ files: createNodeFilesApi({ rootDir: t.dir }) });
    const result = await gc({ ...backend, writeCommitGraph: false });
    expect(result.skipped).toBe(false);
    expect(packsOf(t.dir)).toEqual(packsOf(t.theirs));
    expect(promisorFiles(t.dir)).toEqual(promisorFiles(t.theirs));
    const fsck = gitRun(root, t.dir, ["fsck"]);
    expect(fsck.status, fsck.stdout + fsck.stderr).toBe(0);
  });

  it("clone with credentials checks out through its own lazy fetch; later commands with the API", async () => {
    const auth = `Basic ${Buffer.from("user:secret").toString("base64")}`;
    const backend = nativeGitHttpBackend(srv, root);
    const server = await serveOnLoopback(async (request) =>
      request.headers.get("authorization") === auth
        ? backend.fetch(request)
        : new Response("auth needed", {
            status: 401,
            headers: { "WWW-Authenticate": 'Basic realm="git"' },
          }),
    );
    try {
      const url = `${server.baseUrl}/repo.git`;
      const credentials = { username: "user", password: "secret" };
      const { dir, ours } = await oursAt("o-auth");
      await ours.clone().setURI(url).setFilter("blob:none").setCredentials(credentials).call();
      const theirs = join(root, `n-auth-${counter++}`);
      const r = await gitAsync(root, root, [
        "clone",
        "-q",
        "--filter=blob:none",
        `${server.baseUrl.replace("http://", "http://user:secret@")}/repo.git`,
        theirs,
      ]);
      expect(r.status, r.stderr).toBe(0);
      expect(worktreeFiles(dir)).toEqual(worktreeFiles(theirs));
      // a later command: the fetcher the library installs for this store
      const g = await reopen(dir);
      installPromisorFetcher(g.workingCopy, { credentials });
      await g.switch().setName("side").call();
      expect((await gitAsync(root, theirs, ["switch", "-q", "side"])).status).toBe(0);
      expect(worktreeFiles(dir)).toEqual(worktreeFiles(theirs));
    } finally {
      await server.close();
      backend.close();
    }
  });

  it("a push received by a served partial clone never fetches lazily", async () => {
    // the served repository: a partial clone of the server, with a fetcher that counts
    const t = await twins("served-push");
    git(t.dir, "config", "http.receivepack", "true");
    git(t.dir, "config", "receive.denyCurrentBranch", "ignore");
    noMaintenance(t.dir);
    const asked: string[][] = [];
    const resolveRepository = createBasePathResolver({
      files: createNodeFilesApi({ rootDir: root }),
      exportAll: true,
      openRepository: async (gitDir) => {
        const opened = await openLocalRemote(host.workingCopy, `..${gitDir}`).catch(
          () => undefined,
        );
        opened?.history.objects?.promisor?.setFetcher({
          hasPromisorRemote: () => true,
          fetch: async (ids) => {
            asked.push([...ids]);
            return ids;
          },
        });
        return opened ? servedRepositoryOf(opened) : undefined;
      },
    });
    const server = await serveOnLoopback(createServedFetchHandler({ resolveRepository }));
    try {
      // a full clone pushes a commit changing one file of a tree whose other blobs the
      // partial clone lacks
      const full = join(root, `full-push-${counter++}`);
      git(root, "clone", "-q", "--no-local", join(srv, "repo.git"), full);
      git(full, "checkout", "-q", "-b", "pushed", "origin/side");
      putFile(full, "dir/c.txt", "pushed\n");
      git(full, "commit", "-qam", "pushed");
      const url = `${server.baseUrl}/${t.dir.slice(root.length + 1)}/.git`;
      const r = await gitAsync(root, full, ["push", "-q", url, "pushed"]);
      expect(r.status, r.stderr).toBe(0);
      expect(asked).toEqual([]);
      expect(git(t.dir, "rev-parse", "pushed").trim()).toBe(git(full, "rev-parse", "HEAD").trim());
    } finally {
      await server.close();
    }
  });

  /** Every object a repository stores (packed or loose), sorted. */
  const storedOf = (dir: string) =>
    git(dir, "cat-file", "--batch-all-objects", "--batch-check=%(objectname)")
      .split("\n")
      .filter(Boolean)
      .sort();

  it("the gc orchestrator prunes a partial clone as git gc --prune=now", async () => {
    const t = await twins("orchestrator");
    commitInBoth(t);
    // lazily fetched blobs: side's, by a switch there and back
    await (await reopen(t.dir)).switch().setName("side").call();
    await (await reopen(t.dir)).switch().setName("main").call();
    for (const args of [
      ["switch", "-q", "side"],
      ["switch", "-q", "main"],
    ]) {
      const r = await gitAsync(root, t.theirs, args);
      expect(r.status, r.stderr).toBe(0);
    }
    // unreachable loose objects: a blob, and a commit (with its tree and blob) left behind
    const dropped: string[] = [];
    for (const dir of [t.theirs, t.dir]) {
      putFile(dir, "dangling.txt", "dangling\n");
      dropped.push(git(dir, "hash-object", "-w", "dangling.txt").trim());
      rmSync(join(dir, "dangling.txt"));
      putFile(dir, "gone.txt", "gone\n");
      git(dir, "add", "gone.txt");
      gitOut(root, dir, ["commit", "-qm", "gone"], commitEnv(8));
      dropped.push(git(dir, "rev-parse", "HEAD").trim());
      git(dir, "reset", "-q", "--hard", "HEAD~1");
      rmSync(join(dir, ".git/logs"), { recursive: true, force: true });
      rmSync(join(dir, ".git/ORIG_HEAD"), { force: true });
    }
    expect(storedOf(t.dir)).toEqual(storedOf(t.theirs));
    const g = gitRun(root, t.theirs, ["gc", "-q", "--prune=now"]);
    expect(g.status, g.stderr).toBe(0);
    const backend = await createGitFilesBackend({ files: createNodeFilesApi({ rootDir: t.dir }) });
    const result = await new GcOrchestrator(backend.history, new FileGcStrategy(backend)).run({
      pruneExpireMs: 0,
      compact: true,
    });
    expect(result.prunedObjects).toBeGreaterThanOrEqual(4);
    const stored = storedOf(t.dir);
    expect(stored).toEqual(storedOf(t.theirs));
    for (const id of dropped) expect(stored).not.toContain(id);
    expect(objectsOf(t.dir)).toEqual(objectsOf(t.theirs));
    const fsck = gitRun(root, t.dir, ["fsck"]);
    expect(fsck.status, fsck.stdout + fsck.stderr).toBe(0);
    // still a working partial clone
    expect(git(t.dir, "status", "--porcelain")).toBe("");
  });

  describe.skipIf(nativeVersion === "2.43")("backfill, as git backfill", () => {
    let server: { server: LoopbackServer; requests: string[][]; close(): Promise<void> };
    let url: string;

    beforeAll(async () => {
      // a history of several commits over a few directories
      const work = join(root, "backfill-work");
      git(root, "init", "-q", "-b", "main", work);
      const files = ["top.txt", "a/x.txt", "a/y.txt", "b/z.txt", "b/sub/w.txt", "c/v.txt"];
      for (let round = 0; round < 4; round++) {
        files.forEach((f, i) => {
          if ((i + round) % 2 === 0 || round === 0) putFile(work, f, `${f} ${round}\n`);
        });
        if (round === 2) putFile(work, "a/copy.txt", "top.txt 0\n");
        git(work, "add", "-A");
        gitOut(root, work, ["commit", "-qm", `r${round}`], commitEnv(round + 1));
      }
      const bare = join(srv, "backfill.git");
      git(root, "clone", "-q", "--bare", "--no-local", work, bare);
      git(bare, "config", "uploadpack.allowFilter", "true");
      git(bare, "config", "uploadpack.allowAnySHA1InWant", "true");
      noMaintenance(bare);
      // a server recording the ids each fetch request wants
      const backend = nativeGitHttpBackend(srv, root);
      const requests: string[][] = [];
      const loopback = await serveOnLoopback(async (request) => {
        const u = new URL(request.url);
        if (request.method === "POST" && u.pathname.endsWith("/git-upload-pack")) {
          const raw = Buffer.from(await request.clone().arrayBuffer());
          const body = request.headers.get("content-encoding") === "gzip" ? gunzipSync(raw) : raw;
          const text = body.toString("latin1");
          if (!text.includes("command=ls-refs")) {
            requests.push(
              [...text.matchAll(/want ([0-9a-f]{40})/g)].map((m) => m[1] as string).sort(),
            );
          }
        }
        return backend.fetch(request);
      });
      server = {
        server: loopback,
        requests,
        close: async () => {
          await loopback.close();
          backend.close();
        },
      };
      url = `${loopback.baseUrl}/backfill.git`;
    });

    afterAll(async () => {
      await server?.close();
    });

    /** A native partial clone and ours, checked out, with `prepare` run natively in both. */
    async function backfillTwins(prepare?: (dir: string) => Promise<void>) {
      const theirs = join(root, `n-backfill-${counter++}`);
      const r = await gitAsync(root, root, ["clone", "-q", "--filter=blob:none", url, theirs]);
      expect(r.status, r.stderr).toBe(0);
      const { dir, ours } = await oursAt("o-backfill");
      await ours.clone().setURI(url).setFilter("blob:none").call();
      for (const d of [theirs, dir]) await prepare?.(d);
      return { theirs, dir };
    }

    /** The requests of native `git backfill <args>`, then ours, with the same options. */
    async function compare(
      args: string[],
      configure: (cmd: ReturnType<Git["backfill"]>) => void,
      prepare?: (dir: string) => Promise<void>,
    ) {
      const t = await backfillTwins(prepare);
      const before = server.requests.length;
      const r = await gitAsync(root, t.theirs, ["backfill", ...args]);
      expect(r.status, r.stderr).toBe(0);
      const theirs = server.requests.slice(before);
      const mid = server.requests.length;
      const cmd = (await reopen(t.dir)).backfill();
      configure(cmd);
      const result = await cmd.call();
      expect(result.exitCode).toBe(0);
      const mine = server.requests.slice(mid);
      expect(mine).toEqual(theirs);
      expect(result.batches.map((b) => [...b].sort())).toEqual(mine);
      expect(objectsOf(t.dir)).toEqual(objectsOf(t.theirs));
      return { theirs, mine, t };
    }

    it.each([1, 2, 3, 5])(
      "--min-batch-size=%i: the same requests, each asking the same blobs",
      async (n) => {
        const { mine, t } = await compare([`--min-batch-size=${n}`], (c) => c.setMinBatchSize(n));
        expect(mine.length).toBeGreaterThan(1);
        // nothing is missing any more
        expect(objectsOf(t.dir).some((id) => id.startsWith("?"))).toBe(false);
      },
    );

    it("the default batch size: one request for every missing blob", async () => {
      const { mine } = await compare([], () => {});
      expect(mine.length).toBe(1);
    });

    it("a revision range walks the boundary commits' trees, unless --no-include-edges", async () => {
      await compare(["--min-batch-size=2", "HEAD~1..HEAD"], (c) =>
        c.setMinBatchSize(2).addRevision("HEAD~1..HEAD"),
      );
      await compare(["--no-include-edges", "HEAD~2..HEAD"], (c) =>
        c.setIncludeEdges(false).addRevision("HEAD~2..HEAD"),
      );
    });

    it("--sparse is the default in a sparse checkout: paths outside the cone are left", async () => {
      const sparse = async (dir: string) => {
        const r = await gitAsync(root, dir, ["sparse-checkout", "set", "a", "b/sub"]);
        expect(r.status, r.stderr).toBe(0);
      };
      const { t } = await compare(["--min-batch-size=2"], (c) => c.setMinBatchSize(2), sparse);
      expect(objectsOf(t.dir).some((id) => id.startsWith("?"))).toBe(true);
      await compare(["--no-sparse"], (c) => c.setSparse(false), sparse);
    });

    it("2.43 has no backfill command", async () => {
      const { dir } = await oursAt("o-backfill-243");
      const result = await (await reopen(dir)).backfill().setCompatibility("2.43").call();
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe("git: 'backfill' is not a git command. See 'git --help'.\n");
    });
  });
});
