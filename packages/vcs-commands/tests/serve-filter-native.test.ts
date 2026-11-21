/**
 * Serving partial clone filters, against native git (2.43 and 2.5x): native `git clone
 * --filter=<spec> --no-checkout` from our upload-pack (smart HTTP v0 and v2 through
 * `createServedFetchHandler`, git:// through `serveGitConnection`) receives exactly the
 * objects it receives from native `git http-backend` (and native upload-pack over file://)
 * serving the same repository: `rev-list --objects --all --missing=print` of both clones,
 * present and missing objects alike. Bitmapped repositories give the same sets, the allow-list
 * (`uploadpackfilter.*`) refuses with git's lines, and a server without
 * `uploadpack.allowFilter` gets git's warning and a full clone.
 *
 * Our listObjects with a filter is also compared with native `rev-list --filter` on the same
 * repository (the order-dependent `tree:<depth>`, `sparse:oid` and `combine:`).
 */
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMemoryHistoryWithOperations,
  listObjects,
  parseObjectFilter,
  resolveObjectFilter,
} from "@statewalker/vcs-core";
import {
  createBasePathResolver,
  createRepositoryFacade,
  createServedFetchHandler,
  createTransportRefStore,
  fetchFromConnection,
  openHttpConnection,
  serveGitConnection,
} from "@statewalker/vcs-transport";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { sparseFilterMatcher } from "@statewalker/vcs-working-tree";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openLocalRemote } from "../src/commands/local-transport.js";
import { type Git, servedRepositoryOf } from "../src/index.js";
import { type LoopbackServer, serveOnLoopback } from "./http-loopback-support.js";
import { openOurs } from "./merge-native-helpers.js";
import { gitAsync, startTcpServer } from "./native-connect-support.js";
import { nativeGitAvailable, nativeGitHttpBackend } from "./native-git-http-backend.js";
import { gitOut, putFile } from "./status-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root: string;
let srv: string;
let counter = 0;
const git = (cwd: string, ...args: string[]) => gitOut(root, cwd, args);

/** What a clone holds: its objects present and missing (`?<id>`), sorted, and its refs. */
function objectsOf(repo: string): { objects: string[]; refs: string } {
  return {
    objects: git(repo, "rev-list", "--objects", "--all", "--missing=print")
      .split("\n")
      .filter(Boolean)
      .map((l) => l.split(" ")[0] as string)
      .sort(),
    refs: git(repo, "for-each-ref", "--format=%(refname) %(objectname)"),
  };
}

/** The `fatal:`, `remote:` and `warning:` lines of a run, without git's progress noise. */
function messages(stderr: string): string[] {
  return stderr
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => /^(fatal|warning|remote|error):/.test(l));
}

const SPECS = [
  "blob:none",
  "blob:limit=1k",
  "tree:0",
  "tree:1",
  "tree:2",
  "tree:3",
  "sparse:oid=main:spec",
  "object:type=blob",
  "object:type=tree",
  "object:type=commit",
  "object:type=tag",
  "combine:blob:none+tree:2",
  "combine:tree:3+sparse:oid=main:spec",
  "combine:blob:limit=1k+object:type=blob",
];

describeGit("serving partial clone filters, as native git", () => {
  let nativeHttp: { server: LoopbackServer; close(): Promise<void> };
  let ourHttp: LoopbackServer;
  let ourDaemon: { port: number; close(): Promise<void> };
  let host: Git;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "serve-filter-"));
    srv = join(root, "srv");
    mkdirSync(srv);
    const repo = join(srv, "repo");
    git(root, "init", "-q", "-b", "main", repo);
    // files at several depths, a big blob, one subtree at two depths (tree:<depth> re-walks
    // it nearer the root), and a sparse spec
    const big = "x".repeat(3000);
    putFile(repo, "a.txt", "a\n");
    putFile(repo, "big.bin", `${big}\n`);
    putFile(repo, "dir/b.txt", "b\n");
    putFile(repo, "dir/sub/c.txt", "c\n");
    putFile(repo, "dir/sub/deep/d.txt", "d\n");
    putFile(repo, "dir/lib/l.txt", "lib\n");
    putFile(repo, "lib/l.txt", "lib\n");
    putFile(repo, "spec", "/a.txt\n/dir/\n!/dir/sub/\n/dir/sub/deep/\n");
    git(repo, "add", ".");
    const commit = (n: number, msg: string) =>
      gitOut(root, repo, ["commit", "-qm", msg], {
        GIT_AUTHOR_DATE: `170000000${n} +0000`,
        GIT_COMMITTER_DATE: `170000000${n} +0000`,
      });
    commit(1, "c1");
    putFile(repo, "dir/sub/c.txt", "c2\n");
    putFile(repo, "big2.bin", `${big}2\n`);
    git(repo, "add", ".");
    commit(2, "c2");
    git(repo, "tag", "-a", "v1", "-m", "v1", "HEAD~1");
    // a tag of a blob the filters omit, and one of a tree
    const blobId = git(repo, "rev-parse", "HEAD:big.bin").trim();
    git(repo, "tag", "-a", "blobtag", "-m", "blob", blobId);
    git(repo, "tag", "-a", "treetag", "-m", "tree", git(repo, "rev-parse", "HEAD:dir").trim());
    git(repo, "branch", "side", "HEAD~1");
    git(repo, "config", "uploadpack.allowFilter", "true");
    git(repo, "repack", "-adq");
    // the same repository with a bitmap
    cpSync(repo, join(srv, "bm"), { recursive: true });
    git(join(srv, "bm"), "repack", "-adbq");
    // the allow-list: blob:none and tree up to depth 1 only
    cpSync(repo, join(srv, "restricted"), { recursive: true });
    for (const [k, v] of [
      ["uploadpackfilter.allow", "false"],
      ["uploadpackfilter.blob:none.allow", "true"],
      ["uploadpackfilter.tree.maxDepth", "1"],
    ]) {
      git(join(srv, "restricted"), "config", k as string, v as string);
    }
    // no uploadpack.allowFilter: no filter advertised
    cpSync(repo, join(srv, "nofilter"), { recursive: true });
    git(join(srv, "nofilter"), "config", "--unset", "uploadpack.allowFilter");

    const backend = nativeGitHttpBackend(srv, root);
    const server = await serveOnLoopback((request) => backend.fetch(request));
    nativeHttp = {
      server,
      close: async () => {
        await server.close();
        backend.close();
      },
    };
    host = await openOurs(
      srv,
      createNodeGitHostEnvironment({ env: { HOME: root } }),
      undefined,
      "repo",
    );
    const resolveRepository = createBasePathResolver({
      files: createNodeFilesApi({ rootDir: srv }),
      exportAll: true,
      openRepository: async (gitDir) => {
        const opened = await openLocalRemote(host.workingCopy, `..${gitDir}`).catch(
          () => undefined,
        );
        return opened ? servedRepositoryOf(opened) : undefined;
      },
    });
    ourHttp = await serveOnLoopback(createServedFetchHandler({ resolveRepository }));
    ourDaemon = await startTcpServer((duplex) => serveGitConnection({ duplex, resolveRepository }));
  });

  afterAll(async () => {
    await nativeHttp?.close();
    await ourHttp?.close();
    await ourDaemon?.close();
    rmSync(root, { recursive: true, force: true });
  });

  /** A native clone, its exit status, stderr and what it holds. */
  const clone = async (
    url: string,
    version: string,
    spec: string | undefined,
    name: string,
    extra: string[] = [],
  ) => {
    const dest = join(root, `${name}-${counter++}`);
    const r = await gitAsync(root, root, [
      "-c",
      `protocol.version=${version}`,
      "clone",
      "-q",
      "--no-checkout",
      ...extra,
      ...(spec ? [`--filter=${spec}`] : []),
      url,
      dest,
    ]);
    const state = r.status === 0 ? objectsOf(dest) : undefined;
    rmSync(dest, { recursive: true, force: true });
    return { ...r, state };
  };

  for (const version of ["0", "2"] as const) {
    for (const repo of ["repo", "bm"]) {
      for (const spec of SPECS) {
        it(`native clone (v${version}, ${repo}) --filter=${spec}: our server sends what http-backend sends`, async () => {
          const theirs = await clone(`${nativeHttp.server.baseUrl}/${repo}`, version, spec, "n");
          const mine = await clone(`${ourHttp.baseUrl}/${repo}`, version, spec, "o");
          expect(theirs.status, theirs.stderr).toBe(0);
          expect(mine.status, mine.stderr).toBe(0);
          expect(mine.state).toEqual(theirs.state);
          // git:// from our daemon, against native upload-pack over file://
          const daemon = await clone(
            `git://127.0.0.1:${ourDaemon.port}/${repo}`,
            version,
            spec,
            "d",
          );
          const file = await clone(`file://${join(srv, repo)}`, version, spec, "f");
          expect(daemon.status, daemon.stderr).toBe(0);
          expect(daemon.state).toEqual(file.state);
          expect(file.state).toEqual(theirs.state);
        });
      }
    }

    for (const spec of [
      "blob:none",
      "tree:1",
      "tree:2",
      "object:type=blob",
      "combine:blob:none+tree:1",
    ]) {
      it(`native clone (v${version}) --filter=${spec} of a server with an allow-list`, async () => {
        const theirs = await clone(`${nativeHttp.server.baseUrl}/restricted`, version, spec, "n");
        const mine = await clone(`${ourHttp.baseUrl}/restricted`, version, spec, "o");
        expect(mine.status === 0, mine.stderr).toBe(theirs.status === 0);
        if (theirs.status === 0) expect(mine.state).toEqual(theirs.state);
        else {
          const fatal = (s: string) => messages(s).filter((l) => l.startsWith("fatal: remote"));
          expect(fatal(mine.stderr)).toEqual(fatal(theirs.stderr));
          expect(fatal(theirs.stderr).length).toBe(1);
          // the native protocol sends the same ERR
          const daemon = await clone(
            `git://127.0.0.1:${ourDaemon.port}/restricted`,
            version,
            spec,
            "d",
          );
          expect(fatal(daemon.stderr)).toEqual(fatal(theirs.stderr));
        }
      });
    }

    // shallow (deepen) and a single branch's followed tags (include-tag) with a filter
    for (const extra of [
      ["--depth", "1"],
      ["--depth", "2", "--single-branch", "--branch", "main"],
      ["--single-branch", "--branch", "side"],
    ]) {
      for (const spec of ["blob:none", "tree:1", "object:type=blob", "object:type=commit"]) {
        it(`native clone (v${version}) ${extra.join(" ")} --filter=${spec}`, async () => {
          const theirs = await clone(
            `${nativeHttp.server.baseUrl}/repo`,
            version,
            spec,
            "n",
            extra,
          );
          const mine = await clone(`${ourHttp.baseUrl}/repo`, version, spec, "o", extra);
          expect(theirs.status, theirs.stderr).toBe(0);
          expect(mine.status, mine.stderr).toBe(0);
          expect(mine.state).toEqual(theirs.state);
        });
      }
    }

    it(`native clone (v${version}) of a server without uploadpack.allowFilter: git's warning, a full clone`, async () => {
      const theirs = await clone(
        `${nativeHttp.server.baseUrl}/nofilter`,
        version,
        "blob:none",
        "n",
      );
      const mine = await clone(`${ourHttp.baseUrl}/nofilter`, version, "blob:none", "o");
      expect(mine.status, mine.stderr).toBe(0);
      expect(messages(mine.stderr)).toEqual(messages(theirs.stderr));
      expect(messages(theirs.stderr)).toContain(
        "warning: filtering not recognized by server, ignoring",
      );
      expect(mine.state).toEqual(theirs.state);
    });

    it(`native clone (v${version}) with a sparse:oid naming no blob fails as from http-backend`, async () => {
      const spec = "sparse:oid=main:nope";
      const theirs = await clone(`${nativeHttp.server.baseUrl}/repo`, version, spec, "n");
      const mine = await clone(`${ourHttp.baseUrl}/repo`, version, spec, "o");
      expect(theirs.status).not.toBe(0);
      expect(mine.status).not.toBe(0);
      const remote = (s: string) => messages(s).filter((l) => l.startsWith("remote:"));
      expect(remote(mine.stderr)).toEqual(remote(theirs.stderr));
    });

    it(`native fetch (v${version}) into a partial clone from our server`, async () => {
      const results: ReturnType<typeof objectsOf>[] = [];
      for (const base of [nativeHttp.server.baseUrl, ourHttp.baseUrl]) {
        const name = `fsrc-${counter++}`;
        const work = join(srv, name);
        cpSync(join(srv, "repo"), work, { recursive: true });
        const dest = join(root, `fdst-${counter++}`);
        const url = `${base}/${name}`;
        const v = ["-c", `protocol.version=${version}`];
        const c = await gitAsync(root, root, [
          ...v,
          "clone",
          "-q",
          "--bare",
          "--filter=blob:none",
          url,
          dest,
        ]);
        expect(c.status, c.stderr).toBe(0);
        // one more commit on the server, with a new blob and a changed subtree
        putFile(work, "dir/sub/new.txt", "new\n");
        git(work, "add", ".");
        gitOut(root, work, ["commit", "-qm", "c3"], {
          GIT_AUTHOR_DATE: "1700000009 +0000",
          GIT_COMMITTER_DATE: "1700000009 +0000",
        });
        const r = await gitAsync(root, dest, [
          ...v,
          "fetch",
          "-q",
          "origin",
          "+refs/heads/*:refs/heads/*",
        ]);
        expect(r.status, r.stderr).toBe(0);
        results.push(objectsOf(dest));
        rmSync(dest, { recursive: true, force: true });
        rmSync(work, { recursive: true, force: true });
      }
      expect(results[1]).toEqual(results[0]);
    });
  }

  for (const version of [0, 2] as const) {
    it(`our client (v${version}) fetches with a filter from http-backend and from our server alike`, async () => {
      const fetchWith = async (url: string) => {
        const history = createMemoryHistoryWithOperations();
        await history.initialize();
        const warnings: string[] = [];
        const connection = await openHttpConnection({ url, protocolVersion: version });
        try {
          await fetchFromConnection(connection, {
            repository: createRepositoryFacade({ history }),
            refStore: createTransportRefStore(history.refs),
            refspecs: ["+refs/heads/*:refs/remotes/origin/*"],
            filter: "blob:none",
            onWarning: (line) => warnings.push(line),
          });
        } finally {
          await connection.close();
        }
        const ids: string[] = [];
        for await (const id of history.objects?.list() ?? []) ids.push(id);
        return { ids: ids.sort(), warnings };
      };
      for (const repo of ["repo", "bm", "nofilter"]) {
        const theirs = await fetchWith(`${nativeHttp.server.baseUrl}/${repo}`);
        const mine = await fetchWith(`${ourHttp.baseUrl}/${repo}`);
        expect(mine, repo).toEqual(theirs);
        // a server that takes no filter: git's warning, and everything comes
        expect(theirs.warnings).toEqual(
          repo === "nofilter" ? ["warning: filtering not recognized by server, ignoring"] : [],
        );
      }
    });
  }

  it("lists the objects native rev-list --filter lists", async () => {
    const repo = join(srv, "repo");
    const opened = await openLocalRemote(host.workingCopy, "../repo");
    const objects = opened.history.objects;
    if (!objects) throw new Error("no object store");
    const refs = git(repo, "for-each-ref", "--format=%(objectname)").split("\n").filter(Boolean);
    for (const spec of SPECS) {
      const theirs = git(repo, "rev-list", "--objects", `--filter=${spec}`, "--all")
        .split("\n")
        .filter(Boolean)
        .map((l) => l.split(" ")[0])
        .sort();
      const filter = await resolveObjectFilter(parseObjectFilter(spec), async (name) => {
        const id = git(repo, "rev-parse", name).trim();
        return sparseFilterMatcher(git(repo, "cat-file", "blob", id));
      });
      const mine: string[] = [];
      for await (const o of listObjects(objects, { wants: refs, filter })) mine.push(o.id);
      expect(mine.sort(), spec).toEqual(theirs);
    }
  });
});
