/**
 * The dumb HTTP protocol of the served handler (`createServedFetchHandler` over
 * `servedRepositoryOf`, `http.getanyfile` on by default) against native `git http-backend`:
 * the answers to the dumb paths (`HEAD`, `info/refs`, `objects/info/packs`, alternates, loose
 * objects, packs and indexes: status, content type, cache headers, body) agree, and a native
 * client with `GIT_SMART_HTTP=0` clones and fetches from each alike: a repository of loose
 * objects, one of packs, one borrowing from another through `objects/info/alternates`. A
 * POST of the wrong content type is answered 415 as http-backend answers it.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBasePathResolver, createServedFetchHandler } from "@statewalker/vcs-transport";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openLocalRemote } from "../src/commands/local-transport.js";
import { servedRepositoryOf } from "../src/index.js";
import { type LoopbackServer, serveOnLoopback } from "./http-loopback-support.js";
import { openOurs } from "./merge-native-helpers.js";
import { gitAsync } from "./native-connect-support.js";
import {
  nativeGitAvailable,
  nativeGitHttpBackend,
  noMaintenance,
} from "./native-git-http-backend.js";
import { gitOut, putFile, testEnv } from "./status-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root: string;
const git = (cwd: string, args: string[]) => gitOut(root, cwd, args);

type Fetcher = (request: Request) => Promise<Response>;

/** Our handler over the repositories under `dir` (opened through `src`'s worktree). */
async function ourHandler(dir: string): Promise<Fetcher> {
  const host = await openOurs(
    dir,
    createNodeGitHostEnvironment({ env: testEnv(root) }),
    undefined,
    "src",
  );
  return createServedFetchHandler({
    resolveRepository: createBasePathResolver({
      files: createNodeFilesApi({ rootDir: dir }),
      exportAll: true,
      openRepository: async (gitDir) => {
        const opened = await openLocalRemote(host.workingCopy, `..${gitDir}`).catch(
          () => undefined,
        );
        return opened ? servedRepositoryOf(opened) : undefined;
      },
    }),
  });
}

/** `dir` twice (`-native`, `-ours`), times kept (`Last-Modified` must agree). */
function twins(dir: string): [string, string] {
  const out = ["native", "ours"].map((suffix) => {
    const copy = `${dir}-${suffix}`;
    rmSync(copy, { recursive: true, force: true });
    execFileSync("cp", ["-a", dir, copy]);
    return copy;
  });
  return out as [string, string];
}

/** What a dumb answer tells: status, the headers http-backend sets, the body. */
async function answer(fetcher: Fetcher, url: string, init?: RequestInit) {
  const response = await fetcher(new Request(url, init));
  const body = Buffer.from(await response.arrayBuffer());
  const h = (name: string) => response.headers.get(name) ?? undefined;
  const cache = h("cache-control");
  return {
    status: response.status,
    contentType: h("content-type"),
    contentLength: h("content-length"),
    cacheControl: cache,
    pragma: h("pragma"),
    // hdr_cache_forever dates the answer: a year from Date
    expires:
      response.status === 200 && cache?.startsWith("public")
        ? Date.parse(h("expires") ?? "") - Date.parse(h("date") ?? "")
        : h("expires"),
    lastModified: h("last-modified"),
    body: body.toString("latin1"),
  };
}

/** The dumb paths of the repository `name` (its objects and packs as listed on disk). */
function dumbPaths(dir: string, name: string): string[] {
  const objects = join(dir, name, "objects");
  const paths = [
    "HEAD",
    "info/refs",
    "objects/info/packs",
    "objects/info/alternates",
    "objects/info/http-alternates",
    `objects/ab/${"0".repeat(38)}`,
    `objects/pack/pack-${"0".repeat(40)}.pack`,
  ];
  for (const sub of readdirSync(objects)) {
    if (/^[0-9a-f]{2}$/.test(sub)) {
      for (const file of readdirSync(join(objects, sub))) paths.push(`objects/${sub}/${file}`);
    }
  }
  for (const file of readdirSync(join(objects, "pack"))) {
    if (/\.(pack|idx)$/.test(file)) paths.push(`objects/pack/${file}`);
  }
  return paths.map((p) => `/${name}/${p}`);
}

/** Both servers' answers to every path, compared. */
async function expectSameAnswers(theirsDir: string, oursDir: string, paths: string[]) {
  const backend = nativeGitHttpBackend(theirsDir, root);
  const ours = await ourHandler(oursDir);
  try {
    for (const path of paths) {
      const expected = await answer(backend.fetch, `http://localhost${path}`);
      const got = await answer(ours, `http://localhost${path}`);
      if (expected.status === 200) {
        expect(got, path).toEqual(expected);
        continue;
      }
      // a refusal: http-backend repeats hdr_nocache after the headers its route set (a
      // second copy of each, or hdr_cache_forever's beside them); ours sends hdr_nocache once
      expect({ status: got.status, body: got.body }, path).toEqual({
        status: expected.status,
        body: expected.body,
      });
      for (const key of ["cacheControl", "pragma", "expires"] as const) {
        expect(got[key], `${path} ${key}`).toBeDefined();
        expect(String(expected[key]), `${path} ${key}`).toContain(String(got[key]));
      }
    }
  } finally {
    backend.close();
  }
}

/** A native client's dumb clone (`GIT_SMART_HTTP=0`) of `name` from each server, compared. */
async function expectSameClone(
  theirsDir: string,
  oursDir: string,
  name: string,
  then?: (clone: string, url: string) => Promise<void>,
) {
  const results: Array<{ status: number | null; refs: string; requests: string[] }> = [];
  for (const [dir, server] of [
    [theirsDir, await nativeLoopback(theirsDir)],
    [oursDir, await serveOnLoopback(await ourHandler(oursDir))],
  ] as const) {
    try {
      const clone = join(dir, "clone");
      const url = `${server.baseUrl}/${name}`;
      const r = await gitAsync(
        root,
        dir,
        [
          // http-walker follows alternates only with redirects allowed
          ...["-c", "http.followRedirects=true", "clone", "-q", url, "clone"],
        ],
        { GIT_SMART_HTTP: "0" },
      );
      expect(r.status, r.stderr).toBe(0);
      await then?.(clone, url);
      results.push({
        status: r.status,
        refs: git(clone, ["for-each-ref"]) + git(clone, ["rev-parse", "HEAD"]),
        // http-walker fetches in parallel: the set of requests, not their order
        requests: server.requests.map((q) => `${q.method} ${q.url} ${q.status}`).sort(),
      });
      git(clone, ["fsck", "--no-progress"]);
    } finally {
      await server.close();
    }
  }
  const [native, ours] = results as [(typeof results)[0], (typeof results)[0]];
  expect(ours.status).toBe(native.status);
  expect(ours.refs).toBe(native.refs);
  expect(ours.requests).toEqual(native.requests);
}

async function nativeLoopback(dir: string): Promise<LoopbackServer> {
  const backend = nativeGitHttpBackend(dir, root);
  const server = await serveOnLoopback((request) => backend.fetch(request));
  return {
    ...server,
    requests: server.requests,
    close: async () => {
      await server.close();
      backend.close();
    },
  };
}

/** `<dir>/src` (main, other, an annotated tag) and `<dir>/bare.git` holding them, loose. */
function base(dir: string): void {
  const src = join(dir, "src");
  mkdirSync(src, { recursive: true });
  git(src, ["init", "-q", "-b", "main"]);
  putFile(src, "a.txt", "a\n");
  git(src, ["add", "-A"]);
  git(src, ["commit", "-qm", "a"]);
  git(src, ["branch", "other"]);
  git(src, ["tag", "-a", "-m", "t", "v1"]);
  git(dir, ["init", "-q", "--bare", "-b", "main", "bare.git"]);
  noMaintenance(join(dir, "bare.git"));
  git(src, ["push", "-q", "../bare.git", "main", "other", "v1"]);
}

/** One more commit on main, pushed. */
function commit(dir: string, file: string): void {
  const src = join(dir, "src");
  putFile(src, file, `${file}\n`);
  git(src, ["add", "-A"]);
  git(src, ["commit", "-qm", file]);
  git(src, ["push", "-q", "../bare.git", "main"]);
}

describeGit("served dumb HTTP: as git http-backend serves it", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "http-dumb-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("a repository of loose objects: the answers and a dumb clone and fetch", async () => {
    const dir = join(root, "r");
    base(dir);
    const [theirs, mine] = twins(dir);
    await expectSameAnswers(theirs, mine, dumbPaths(dir, "bare.git"));
    // a dumb fetch of what was pushed after the clone
    await expectSameClone(theirs, mine, "bare.git", async (clone, url) => {
      commit(join(clone, ".."), "b.txt");
      const r = await gitAsync(root, clone, ["fetch", "-q", url], { GIT_SMART_HTTP: "0" });
      expect(r.status, r.stderr).toBe(0);
    });
    expect(git(join(theirs, "clone"), ["rev-parse", "FETCH_HEAD"])).toBe(
      git(join(mine, "clone"), ["rev-parse", "FETCH_HEAD"]),
    );
  });

  it("a repository of packs: objects/info/packs youngest first, packs and indexes", async () => {
    const dir = join(root, "r");
    base(dir);
    const bare = join(dir, "bare.git");
    git(bare, ["repack", "-q", "-d"]);
    commit(dir, "b.txt");
    git(bare, ["repack", "-q", "-d"]);
    commit(dir, "c.txt"); // and a loose commit beside them
    // the older pack dated younger: listed first (sort_pack), whatever the names
    const packs = readdirSync(join(bare, "objects/pack")).filter((f) => f.endsWith(".pack"));
    expect(packs.length).toBe(2);
    packs.forEach((pack, i) => {
      const at = 1_900_000_000 + i * 1000;
      utimesSync(join(bare, "objects/pack", pack), at, at);
    });
    const [theirs, mine] = twins(dir);
    await expectSameAnswers(theirs, mine, dumbPaths(dir, "bare.git"));
    await expectSameClone(theirs, mine, "bare.git");
  });

  it("a repository borrowing through objects/info/alternates", async () => {
    const dir = join(root, "r");
    base(dir);
    git(dir, ["clone", "-q", "--bare", "--shared", "bare.git", "borrower.git"]);
    noMaintenance(join(dir, "borrower.git"));
    // the annotated tag v1 is held by the alternate alone: info/refs peels it through it
    expect(git(join(dir, "borrower.git"), ["cat-file", "-t", "v1"]).trim()).toBe("tag");
    // relative, as http-walker follows it (`../../bare.git/objects` from the objects)
    writeFileSync(join(dir, "borrower.git/objects/info/alternates"), "../../bare.git/objects\n");
    git(join(dir, "src"), ["commit", "-q", "--allow-empty", "-m", "own"]);
    git(join(dir, "src"), ["push", "-q", "../borrower.git", "main"]);
    const [theirs, mine] = twins(dir);
    await expectSameAnswers(theirs, mine, dumbPaths(dir, "borrower.git"));
    await expectSameClone(theirs, mine, "borrower.git");
  });

  it("http.getanyfile=false: every dumb path refused", async () => {
    const dir = join(root, "r");
    base(dir);
    git(join(dir, "bare.git"), ["config", "http.getanyfile", "false"]);
    const [theirs, mine] = twins(dir);
    await expectSameAnswers(theirs, mine, dumbPaths(dir, "bare.git"));
  });

  it("a POST of the wrong Content-Type: 415 and http-backend's message", async () => {
    const dir = join(root, "r");
    base(dir);
    git(join(dir, "bare.git"), ["config", "http.receivepack", "true"]);
    const [theirs, mine] = twins(dir);
    const backend = nativeGitHttpBackend(theirs, root);
    const ours = await ourHandler(mine);
    try {
      for (const [service, type] of [
        ["git-upload-pack", "text/plain"],
        ["git-upload-pack", ""],
        ["git-receive-pack", "application/x-git-upload-pack-request"],
        ["git-upload-pack", "application/x-git-upload-pack-request; charset=utf-8"],
      ] as const) {
        const init: RequestInit = {
          method: "POST",
          body: new TextEncoder().encode("0000"),
          headers: type ? { "content-type": type } : {},
        };
        const url = `http://localhost/bare.git/${service}`;
        const expected = await answer(backend.fetch, url, init);
        const got = await answer(ours, url, init);
        expect(expected.status).toBe(415);
        // the body's length is the CGI's to set (a web server adds it)
        expect(
          { ...got, contentLength: undefined, contentType: undefined },
          `${service} ${type}`,
        ).toEqual({
          ...expected,
          contentLength: undefined,
          contentType: undefined,
        });
      }
    } finally {
      backend.close();
    }
  });
});
