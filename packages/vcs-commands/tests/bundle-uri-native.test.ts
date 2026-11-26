/**
 * Bundle URIs against native git (t5558-clone-bundle-uri.sh, t5730/t5731/t5732's
 * lib-bundle-uri-protocol.sh, t5750-bundle-uri-parse.sh): `git clone --bundle-uri`,
 * bundle lists (`all`/`any` modes, the `creationToken` heuristic, `fetch.bundleURI` and
 * `fetch.bundleCreationToken`), and the v2 `bundle-uri` command between native git and ours
 * both ways. Each clone or fetch runs in native git and in ours, from the same repository and
 * bundles, and the bundle refs, the bundle settings and git's warnings are compared.
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createBasePathResolver,
  createServedFetchHandler,
  serveGitConnection,
} from "@statewalker/vcs-transport";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openLocalRemote } from "../src/commands/local-transport.js";
import {
  BundleList,
  type Git,
  parseBundleListConfig,
  parseBundleListLine,
  printBundleList,
  servedRepositoryOf,
} from "../src/index.js";
import { compatibility, ourClone, ourCloneFails } from "./clone-options-native-support.js";
import { type LoopbackServer, serveOnLoopback } from "./http-loopback-support.js";
import { openOurs } from "./merge-native-helpers.js";
import { gitAsync, startTcpServer } from "./native-connect-support.js";
import { nativeGitAvailable, nativeGitHttpBackend } from "./native-git-http-backend.js";
import { testEnv } from "./status-native-support.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

/** Whether the native git can fetch over HTTP (a build without curl has no remote-https). */
const nativeHttp = (() => {
  if (!nativeGitAvailable()) return false;
  const execPath = spawnSync("git", ["--exec-path"]).stdout?.toString().trim();
  return !!execPath && spawnSync("test", ["-x", join(execPath, "git-remote-https")]).status === 0;
})();

let home: string;

function run(cwd: string, args: string[], extra: Record<string, string> = {}) {
  const r = spawnSync("git", args, { cwd, env: testEnv(home, { TZ: "UTC", ...extra }) });
  return {
    status: r.status ?? 1,
    stdout: (r.stdout as Buffer).toString("utf8"),
    stderr: (r.stderr as Buffer).toString("utf8"),
  };
}

function gitOk(cwd: string, args: string[]): string {
  const r = run(cwd, args);
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

function sh(dir: string, script: string): void {
  const prelude = `
set -e
test_tick () {
  if test -z "\${test_tick+set}"; then test_tick=1112911993; else test_tick=$((test_tick + 60)); fi
  export GIT_COMMITTER_DATE="$test_tick -0700" GIT_AUTHOR_DATE="$test_tick -0700"
}
test_commit () { test_tick; echo "$1" >"$1.t"; git add "$1.t"; git commit -q -m "$1"; git tag "$1"; }
`;
  const r = spawnSync("bash", ["-c", prelude + script], { cwd: dir, env: testEnv(home) });
  if (r.status !== 0) throw new Error(`setup failed: ${r.stderr.toString()}`);
}

/** git's warning/error/fatal lines, the temporary list file and the destination normalised. */
function messageLines(text: string): string[] {
  return text
    .split("\n")
    .filter((l) => /^(fatal|error|warning): /.test(l))
    .map((l) => l.replace(/\S*\/bundles\/tmp_uri_\w{6}/g, "<tmp>"));
}

/** The refs under refs/bundles/ with their ids, and the bundle settings. */
function bundleState(dir: string) {
  const config = (key: string) => run(dir, ["config", "--get-all", key]).stdout;
  return {
    refs: gitOk(dir, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/bundles/"]),
    bundleUri: config("fetch.bundleuri"),
    token: config("fetch.bundlecreationtoken"),
  };
}

let counter = 0;

/**
 * `git clone [<options>] --bundle-uri=<uri> <source> <dir>` in native git and ours: the
 * bundle refs, settings and messages of each.
 */
async function cloneTwins(
  source: string,
  bundleUri: string | undefined,
  options: { config?: string[]; nativeArgs?: string[] } = {},
) {
  const n = ++counter;
  const nativeDir = join(home, `native-${n}`);
  const config = options.config ?? [];
  const native = await gitAsync(home, home, [
    "clone",
    ...config.flatMap((c) => ["-c", c]),
    ...(bundleUri !== undefined ? [`--bundle-uri=${bundleUri}`] : []),
    ...(options.nativeArgs ?? []),
    source,
    nativeDir,
  ]);
  if (native.status !== 0) throw new Error(`native clone failed: ${native.stderr}`);
  const oursDir = join(home, `ours-${n}`);
  const result = await ourClone(home, oursDir, (c) => {
    c.setURI(source);
    for (const entry of config) c.addConfig(entry);
    return bundleUri !== undefined ? c.setBundleUri(bundleUri) : c;
  });
  return {
    native: { ...bundleState(nativeDir), messages: messageLines(native.stderr) },
    ours: {
      ...bundleState(oursDir),
      messages: messageLines((result.messages ?? []).join("")),
    },
    nativeDir,
    oursDir,
  };
}

/** The ids every ref of `from` names are objects in `dir` (the clone is complete). */
function hasAllObjects(from: string, dir: string): boolean {
  const ids = gitOk(from, ["for-each-ref", "--format=%(objectname)"]);
  const r = spawnSync("git", ["cat-file", "--batch-check"], {
    cwd: dir,
    env: testEnv(home),
    input: ids,
  });
  return r.status === 0 && !r.stdout.toString().includes("missing");
}

describeGit("bundle URIs against native git", () => {
  let from: string;
  let fromTags: string;
  const list = (body: string) => {
    const file = join(home, `bundle-list-${++counter}`);
    writeFileSync(file, body);
    return file;
  };
  const fileUri = (name: string) => `file://${from}/${name}`;

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "bundle-uri-"));
    from = join(home, "clone-from");
    gitOk(home, ["init", "-q", "-b", "main", from]);
    sh(
      from,
      `git checkout -q -b topic
test_commit A
git bundle create -q A.bundle topic
test_commit B
git bundle create -q B.bundle topic
git checkout -q -b base
test_commit 1
git checkout -q -b left
test_commit 2
git checkout -q -b right base
test_commit 3
git checkout -q -b merge left
test_tick
git merge -q right -m "4"
git bundle create -q bundle-1.bundle base
git bundle create -q bundle-2.bundle base..left
git bundle create -q bundle-3.bundle base..right
git bundle create -q bundle-4.bundle merge --not left right
`,
    );
    fromTags = join(home, "clone-from-tags");
    gitOk(home, ["init", "-q", "-b", "main", fromTags]);
    sh(
      fromTags,
      `git checkout -q -b base
git checkout -q -b topic
test_commit A
git tag tag-A
git checkout -q -b base
git branch -q -d topic
test_commit B
git bundle create -q ALL.bundle --all
`,
    );
  });

  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('t5558-clone-bundle-uri.sh: "fail to clone from non-existent file"', async () => {
    const t = await cloneTwins(from, join(home, "does-not-exist"));
    expect(t.ours).toEqual(t.native);
    expect(t.native.messages.join("\n")).toContain("failed to download bundle from URI");
  });

  it('t5558-clone-bundle-uri.sh: "fail to clone from non-bundle file"', async () => {
    writeFileSync(join(home, "bogus"), "bogus\n");
    const t = await cloneTwins(from, join(home, "bogus"));
    expect(t.ours).toEqual(t.native);
    expect(t.native.messages.join("\n")).toContain("is not a bundle");
  });

  it('t5558-clone-bundle-uri.sh: "clone with path bundle"', async () => {
    const t = await cloneTwins(from, join(from, "B.bundle"));
    expect(t.ours).toEqual(t.native);
    expect(t.ours.refs).toContain("refs/bundles/");
  });

  it('t5558-clone-bundle-uri.sh: "clone with file:// bundle"', async () => {
    const t = await cloneTwins(from, fileUri("B.bundle"));
    expect(t.ours).toEqual(t.native);
  });

  it('t5558-clone-bundle-uri.sh: "clone with tags bundle"', async () => {
    // 2.43 writes refs/heads/ alone (as refs/bundles/<name>), 2.5x every ref
    const t = await cloneTwins(fromTags, join(fromTags, "ALL.bundle"));
    expect(t.ours).toEqual(t.native);
  });

  it('t5558-clone-bundle-uri.sh: "clone bundle list (file, no heuristic)"', async () => {
    const uri = `file://${list(`[bundle]
	version = 1
	mode = all

[bundle "bundle-1"]
	uri = ${fileUri("bundle-1.bundle")}

[bundle "bundle-2"]
	uri = ${fileUri("bundle-2.bundle")}

[bundle "bundle-3"]
	uri = ${fileUri("bundle-3.bundle")}

[bundle "bundle-4"]
	uri = ${fileUri("bundle-4.bundle")}
`)}`;
    const t = await cloneTwins(from, uri);
    expect(t.ours).toEqual(t.native);
    expect(t.ours.refs.split("\n").filter(Boolean)).toHaveLength(compatibility === "2.43" ? 4 : 4);
    expect(hasAllObjects(from, t.oursDir)).toBe(true);
  });

  it('t5558-clone-bundle-uri.sh: "clone bundle list (file, all mode, some failures)"', async () => {
    const uri = `file://${list(`[bundle]
	version = 1
	mode = all

# Does not exist. Should be skipped.
[bundle "bundle-0"]
	uri = ${fileUri("bundle-0.bundle")}

[bundle "bundle-1"]
	uri = ${fileUri("bundle-1.bundle")}

[bundle "bundle-2"]
	uri = ${fileUri("bundle-2.bundle")}

# No bundle-3 means bundle-4 will not apply.

[bundle "bundle-4"]
	uri = ${fileUri("bundle-4.bundle")}

# Does not exist. Should be skipped.
[bundle "bundle-5"]
	uri = ${fileUri("bundle-5.bundle")}
`)}`;
    const t = await cloneTwins(from, uri);
    expect(t.ours).toEqual(t.native);
    expect(hasAllObjects(from, t.oursDir)).toBe(true);
  });

  it('t5558-clone-bundle-uri.sh: "clone bundle list (file, all mode, all failures)"', async () => {
    const uri = `file://${list(`[bundle]
	version = 1
	mode = all

[bundle "bundle-0"]
	uri = ${fileUri("bundle-0.bundle")}

[bundle "bundle-5"]
	uri = ${fileUri("bundle-5.bundle")}
`)}`;
    const t = await cloneTwins(from, uri);
    expect(t.ours).toEqual(t.native);
    expect(t.ours.refs).toBe("");
  });

  it('t5558-clone-bundle-uri.sh: "clone bundle list (file, any mode)"', async () => {
    const uri = `file://${list(`[bundle]
	version = 1
	mode = any

[bundle "bundle-0"]
	uri = ${fileUri("bundle-0.bundle")}

[bundle "bundle-1"]
	uri = ${fileUri("bundle-1.bundle")}

[bundle "bundle-5"]
	uri = ${fileUri("bundle-5.bundle")}
`)}`;
    const t = await cloneTwins(from, uri);
    expect(t.ours).toEqual(t.native);
  });

  it('t5558-clone-bundle-uri.sh: "clone bundle list (file, any mode, all failures)"', async () => {
    const uri = `file://${list(`[bundle]
	version = 1
	mode = any

[bundle "bundle-0"]
	uri = ${fileUri("bundle-0.bundle")}

[bundle "bundle-5"]
	uri = ${fileUri("bundle-5.bundle")}
`)}`;
    const t = await cloneTwins(from, uri);
    expect(t.ours).toEqual(t.native);
  });

  it("clone with a creationToken bundle list stores fetch.bundleURI and the token", async () => {
    // t5558's "clone bundle list (http, creationToken)" over file:// URIs
    const uri = `file://${list(`[bundle]
	version = 1
	mode = all
	heuristic = creationToken

[bundle "bundle-1"]
	uri = ${fileUri("bundle-1.bundle")}
	creationToken = 1

[bundle "bundle-2"]
	uri = ${fileUri("bundle-2.bundle")}
	creationToken = 2
`)}`;
    const t = await cloneTwins(from, uri, { nativeArgs: ["--single-branch", "--branch=base"] });
    expect(t.ours).toEqual(t.native);
    expect(t.ours.bundleUri).toBe(`${uri}\n`);
    expect(t.ours.token).toBe("2\n");
  });

  it("clone --bundle-uri with --depth is refused as git refuses it", async () => {
    const native = run(home, ["clone", "--depth=1", "--bundle-uri=x", from, join(home, "d")]);
    const ours = await ourCloneFails(home, join(home, `ours-depth`), (c) =>
      c.setURI(from).setDepth(1).setBundleUri("x"),
    );
    expect(ours.message).toBe(native.stderr.trimEnd());
    expect(native.status).toBe(128);
  });

  it('t5558-clone-bundle-uri.sh: "fetch treats fetch.bundleCreationToken without a value as 0"', async () => {
    // git master's behaviour: 2.43 and 2.56.1 crash (a NULL value given to sscanf), so the
    // expected result is t5558's, not a native run's
    const uri = `file://${list(`[bundle]
	version = 1
	mode = all
	heuristic = creationToken

[bundle "bundle-1"]
	uri = ${fileUri("bundle-1.bundle")}
	creationToken = 1
`)}`;
    const oursDir = join(home, "token-ours");
    gitOk(home, ["clone", "-q", "--no-local", from, oursDir]);
    writeFileSync(
      join(oursDir, ".git/config"),
      `${readFileSync(join(oursDir, ".git/config"), "utf8")}[fetch]\n\tbundleURI = ${uri}\n\tbundleCreationToken\n`,
    );
    const git = await openOurs(
      home,
      createNodeGitHostEnvironment({ env: testEnv(home) }),
      undefined,
      oursDir.slice(home.length + 1),
    );
    const result = await git.fetch().setRemote("origin").setCompatibility(compatibility).call();
    expect(messageLines(result.messages.join("\n"))).toEqual([]);
    expect(gitOk(oursDir, ["config", "--get-all", "fetch.bundlecreationtoken"])).toBe("1\n");
  });

  // over file:// URIs
  it('t5558-clone-bundle-uri.sh: "creationToken heuristic with failed downloads (fetch)"', async () => {
    // a clone from bundles 1 and 2, then a fetch after the list gains 3 and 4: only the new
    // bundles are applied, the token moves to 4
    const head = `[bundle]
	version = 1
	mode = all
	heuristic = creationToken
`;
    const entry = (n: number) =>
      `\n[bundle "bundle-${n}"]\n\turi = ${fileUri(`bundle-${n}.bundle`)}\n\tcreationToken = ${n}\n`;
    const file = list(head + entry(1) + entry(2));
    const uri = `file://${file}`;
    const t = await cloneTwins(from, uri, { nativeArgs: ["--single-branch", "--branch=left"] });
    expect(t.ours).toEqual(t.native);
    writeFileSync(file, head + entry(1) + entry(2) + entry(3) + entry(4));
    const native = run(t.nativeDir, ["fetch", "origin"]);
    const git = await openOurs(
      home,
      createNodeGitHostEnvironment({ env: testEnv(home) }),
      undefined,
      t.oursDir.slice(home.length + 1),
    );
    const result = await git.fetch().setRemote("origin").setCompatibility(compatibility).call();
    expect(messageLines(result.messages.join("\n"))).toEqual(messageLines(native.stderr));
    expect(bundleState(t.oursDir)).toEqual(bundleState(t.nativeDir));
    expect(bundleState(t.oursDir).token).toBe("4\n");
  });

  describe.skipIf(!nativeHttp)("over HTTP", () => {
    let files: string;
    let server: Server;
    let base: string;
    const requests: string[] = [];

    beforeAll(async () => {
      files = join(home, "www");
      mkdirSync(files);
      for (const n of [1, 2, 3, 4]) {
        copyFileSync(join(from, `bundle-${n}.bundle`), join(files, `bundle-${n}.bundle`));
      }
      server = createServer((req, res) => {
        requests.push(req.url ?? "");
        try {
          const body = readFileSync(join(files, (req.url ?? "/").slice(1)));
          res.writeHead(200, { "content-type": "application/octet-stream" });
          res.end(body);
        } catch {
          res.writeHead(404);
          res.end();
        }
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    /** The clone twins and each one's GET requests, in order. */
    async function httpTwins(bundleUri: string, nativeArgs: string[] = []) {
      requests.length = 0;
      const n = ++counter;
      const nativeDir = join(home, `native-${n}`);
      const native = await gitAsync(home, home, [
        "clone",
        `--bundle-uri=${bundleUri}`,
        ...nativeArgs,
        from,
        nativeDir,
      ]);
      expect(native.status).toBe(0);
      const nativeRequests = [...requests];
      requests.length = 0;
      const oursDir = join(home, `ours-${n}`);
      const result = await ourClone(home, oursDir, (c) => {
        c.setURI(from).setBundleUri(bundleUri);
        if (nativeArgs.includes("--single-branch")) c.setSingleBranch(true);
        const branch = nativeArgs.find((a) => a.startsWith("--branch="));
        if (branch) c.setBranch(branch.slice("--branch=".length));
        return c;
      });
      return {
        native: {
          ...bundleState(nativeDir),
          messages: messageLines(native.stderr),
          requests: nativeRequests,
        },
        ours: {
          ...bundleState(oursDir),
          messages: messageLines((result.messages ?? []).join("")),
          requests: [...requests],
        },
      };
    }

    it('t5558-clone-bundle-uri.sh: "fail to fetch from non-existent HTTP URL"', async () => {
      const t = await httpTwins(`${base}/does-not-exist`);
      expect(t.ours).toEqual(t.native);
    });

    it('t5558-clone-bundle-uri.sh: "clone HTTP bundle"', async () => {
      const t = await httpTwins(`${base}/bundle-1.bundle`);
      expect(t.ours).toEqual(t.native);
      expect(t.ours.refs).toContain("refs/bundles/");
    });

    it('t5558-clone-bundle-uri.sh: "clone bundle list (http, creationToken)"', async () => {
      writeFileSync(
        join(files, "bundle-list"),
        `[bundle]
	version = 1
	mode = all
	heuristic = creationToken

[bundle "bundle-1"]
	uri = bundle-1.bundle
	creationToken = 1

[bundle "bundle-2"]
	uri = bundle-2.bundle
	creationToken = 2

[bundle "bundle-3"]
	uri = bundle-3.bundle
	creationToken = 3

[bundle "bundle-4"]
	uri = bundle-4.bundle
	creationToken = 4
`,
      );
      const t = await httpTwins(`${base}/bundle-list`, ["--single-branch", "--branch=base"]);
      expect(t.ours).toEqual(t.native);
      // newest first, then nothing re-downloaded
      expect(t.ours.requests).toEqual([
        "/bundle-list",
        "/bundle-4.bundle",
        "/bundle-3.bundle",
        "/bundle-2.bundle",
        "/bundle-1.bundle",
      ]);
    });

    it('t5558-clone-bundle-uri.sh: "clone incomplete bundle list (http, creationToken)"', async () => {
      writeFileSync(
        join(files, "bundle-list"),
        `[bundle]
	version = 1
	mode = all
	heuristic = creationToken

[bundle "bundle-1"]
	uri = bundle-1.bundle
	creationToken = 1
`,
      );
      const t = await httpTwins(`${base}/bundle-list`, ["--single-branch", "--branch=base"]);
      expect(t.ours).toEqual(t.native);
    });

    it('t5558-clone-bundle-uri.sh: "bundles with space in URI are rejected"', async () => {
      const t = await httpTwins(`${base}/bogus ${home}/busted/`);
      expect(t.ours.requests).toEqual([]);
      expect(t.ours.refs).toBe(t.native.refs);
      expect(t.ours.messages[0]).toMatch(/^error: bundle-uri: URI is malformed: /);
      expect(t.native.messages[0]).toMatch(/^error: bundle-uri: URI is malformed: /);
    });
  });

  describe("the v2 bundle-uri command (lib-bundle-uri-protocol.sh)", () => {
    let srv: string;
    let parent: string;
    let ourHttp: LoopbackServer;
    let ourDaemon: { port: number; close(): Promise<void> };
    let otherHost: LoopbackServer;
    /** Files our HTTP server also serves under /static/, and the headers each GET carried */
    const staticSeen: { url: string; authorization: string | null; secret: string | null }[] = [];
    let nativeHttpServer: { server: LoopbackServer; close(): Promise<void> } | undefined;
    let host: Git;

    beforeAll(async () => {
      srv = join(home, "srv");
      mkdirSync(srv);
      parent = join(srv, "parent");
      gitOk(home, ["init", "-q", "-b", "main", parent]);
      sh(parent, "test_commit one");
      gitOk(parent, ["config", "uploadpack.advertiseBundleURIs", "true"]);
      copyFileSync(join(from, "bundle-1.bundle"), join(home, "only.bundle"));
      host = await openOurs(
        srv,
        createNodeGitHostEnvironment({ env: { HOME: home } }),
        undefined,
        "parent",
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
      const served = createServedFetchHandler({ resolveRepository });
      const staticFile = (request: Request): Response => {
        const url = new URL(request.url);
        staticSeen.push({
          url: `${url.origin}${url.pathname}`,
          authorization: request.headers.get("authorization"),
          secret: request.headers.get("x-secret"),
        });
        try {
          return new Response(readFileSync(join(home, url.pathname.slice("/static/".length))));
        } catch {
          return new Response(null, { status: 404 });
        }
      };
      ourHttp = await serveOnLoopback(async (request) =>
        new URL(request.url).pathname.startsWith("/static/")
          ? staticFile(request)
          : served(request),
      );
      otherHost = await serveOnLoopback(async (request) => staticFile(request));
      ourDaemon = await startTcpServer((duplex) =>
        serveGitConnection({ duplex, resolveRepository }),
      );
      if (nativeHttp) {
        const backend = nativeGitHttpBackend(srv, home);
        const server = await serveOnLoopback((request) => backend.fetch(request));
        nativeHttpServer = {
          server,
          close: async () => {
            await server.close();
            backend.close();
          },
        };
      }
    });

    afterAll(async () => {
      await ourHttp?.close();
      await otherHost?.close();
      await ourDaemon?.close();
      await nativeHttpServer?.close();
    });

    /** The lines native git's packet trace shows the server sending (`< ...`). */
    function serverLines(trace: string): string[] {
      return trace
        .split("\n")
        .map((l) => /packet: +\S+< (.*)$/.exec(l)?.[1])
        .filter((l): l is string => l !== undefined && !l.startsWith("agent=") && l !== "0000");
    }

    const setBundles = (entries: [string, string][]) => {
      for (const key of ["bundle.only", "bundle.bundle1", "bundle.bundle2", "bundle.bundle3"]) {
        run(parent, ["config", "--remove-section", key]);
      }
      for (const [k, v] of entries) gitOk(parent, ["config", k, v]);
    };

    it.skipIf(!nativeHttp)(
      't5732-protocol-v2-bundle-uri-http.sh: "connect with http:// using protocol v2: have bundle-uri"',
      async () => {
        const lines: Record<string, string[]> = {};
        for (const [name, url] of [
          ["ours", ourHttp.baseUrl],
          ["native", nativeHttpServer?.server.baseUrl ?? ""],
        ] as const) {
          const trace = join(home, `trace-${name}`);
          const r = await gitAsync(
            home,
            home,
            ["-c", "protocol.version=2", "ls-remote", "--symref", `${url}/parent`],
            { GIT_TRACE_PACKET: trace },
          );
          expect(r.status).toBe(0);
          lines[name] = serverLines(readFileSync(trace, "utf8")).filter(
            (l) => !l.startsWith("session-id"),
          );
        }
        // the advertisement, up to the first command (2.43 advertises object-info by
        // default, 2.5x and ours do not)
        const advertised = (l: string[] = []) =>
          l.slice(0, l.indexOf("command=ls-refs")).filter((c) => c !== "object-info");
        expect(advertised(lines.ours)).toContain("bundle-uri");
        expect(advertised(lines.ours)).toEqual(advertised(lines.native));
      },
    );

    it.skipIf(!nativeHttp)(
      't5732-protocol-v2-bundle-uri-http.sh: "test bundle-uri with http:// using protocol v2 with list"',
      async () => {
        setBundles([
          ["bundle.bundle1.uri", `file://${home}/only.bundle`],
          ["bundle.bundle2.uri", `file://${home}/missing-2.bdl`],
          ["bundle.bundle3.uri", `file://${home}/only.bundle`],
          ["bundle.bundle1.extra", "bogus"],
        ]);
        const states: Record<string, unknown> = {};
        const answers: Record<string, string[]> = {};
        for (const [name, url] of [
          ["ours", ourHttp.baseUrl],
          ["native", nativeHttpServer?.server.baseUrl ?? ""],
        ] as const) {
          const trace = join(home, `trace-clone-${name}`);
          const dir = join(home, `served-${name}-${++counter}`);
          const r = await gitAsync(
            home,
            home,
            [
              "-c",
              "transfer.bundleURI=true",
              "-c",
              "protocol.version=2",
              "clone",
              `${url}/parent`,
              dir,
            ],
            { GIT_TRACE_PACKET: trace },
          );
          const traced = readFileSync(trace, "utf8");
          expect({ name, status: r.status }).toEqual({ name, status: 0 });
          expect(traced).toContain("> command=bundle-uri");
          answers[name] = serverLines(traced).filter((l) => l.startsWith("bundle."));
          states[name] = { ...bundleState(dir), messages: messageLines(r.stderr) };
        }
        expect(answers.ours).toEqual(answers.native);
        expect(states.ours).toEqual(states.native);
      },
    );

    it.skipIf(!nativeHttp)(
      't5732-protocol-v2-bundle-uri-http.sh: "test bundle-uri with http:// using protocol v2 with empty value"',
      async () => {
        // git master leaves the empty value out (2.43 and 2.56.1 send it, and their client
        // then fails the clone): native git against ours only
        setBundles([
          ["bundle.bundle1.uri", `file://${home}/only.bundle`],
          ["bundle.bundle2.uri", ""],
        ]);
        const trace = join(home, "trace-empty");
        const dir = join(home, `served-empty-${++counter}`);
        const r = await gitAsync(
          home,
          home,
          ["-c", "transfer.bundleURI=true", "clone", `${ourHttp.baseUrl}/parent`, dir],
          { GIT_TRACE_PACKET: trace },
        );
        expect(r.status).toBe(0);
        expect(
          serverLines(readFileSync(trace, "utf8")).filter((l) => l.startsWith("bundle.")),
        ).toEqual([`bundle.bundle1.uri=file://${home}/only.bundle`]);
        expect(bundleState(dir).refs).toContain("refs/bundles/");
      },
    );

    it('t5731-protocol-v2-bundle-uri-git.sh: "connect with git:// using protocol v2: have bundle-uri"', async () => {
      setBundles([["bundle.only.uri", `file://${home}/only.bundle`]]);
      const trace = join(home, "trace-daemon-ls");
      const r = await gitAsync(
        home,
        home,
        [
          "-c",
          "protocol.version=2",
          "ls-remote",
          "--symref",
          `git://127.0.0.1:${ourDaemon.port}/parent`,
        ],
        { GIT_TRACE_PACKET: trace },
      );
      expect(r.status).toBe(0);
      const lines = serverLines(readFileSync(trace, "utf8"));
      expect(lines).toContain("version 2");
      expect(lines).toContain("bundle-uri");
    });

    it('t5731-protocol-v2-bundle-uri-git.sh: "clone with git:// using protocol v2: request bundle-uris"', async () => {
      // native git against our daemon, and the same clone of the repository through native
      // upload-pack (file://): the same bundle refs and messages
      setBundles([["bundle.only.uri", `file://${home}/only.bundle`]]);
      const state = async (url: string, trace?: string) => {
        const dir = join(home, `daemon-clone-${++counter}`);
        const r = await gitAsync(
          home,
          home,
          ["-c", "transfer.bundleURI=true", "-c", "protocol.version=2", "clone", url, dir],
          trace ? { GIT_TRACE_PACKET: trace } : {},
        );
        expect(r.status).toBe(0);
        return { ...bundleState(dir), messages: messageLines(r.stderr) };
      };
      const trace = join(home, "trace-daemon-clone");
      const ours = await state(`git://127.0.0.1:${ourDaemon.port}/parent`, trace);
      expect(readFileSync(trace, "utf8")).toContain("> command=bundle-uri");
      expect(ours).toEqual(await state(`file://${parent}`));
      expect(ours.refs).toContain("refs/bundles/");
    });

    it("bundle downloads carry the static credentials and headers only to the remote's origin", async () => {
      // the bundle list is the server's content and may name any host
      const remote = `${ourHttp.baseUrl}/parent`;
      for (const [name, bundleUri, expected] of [
        ["same", `${ourHttp.baseUrl}/static/only.bundle`, true],
        ["other", `${otherHost.baseUrl}/static/only.bundle`, false],
      ] as const) {
        staticSeen.length = 0;
        const result = await ourClone(home, join(home, `auth-${name}-${++counter}`), (c) =>
          c
            .setURI(remote)
            .setBundleUri(bundleUri)
            .setCredentials({ username: "u", password: "p" })
            .setHeaders({ "X-Secret": "s" }),
        );
        expect(messageLines((result.messages ?? []).join(""))).toEqual([]);
        expect(staticSeen.map((r) => r.url)).toEqual([bundleUri]);
        expect(staticSeen[0]?.authorization !== null).toBe(expected);
        expect(staticSeen[0]?.secret).toBe(expected ? "s" : null);
      }
    });

    it('t5730-protocol-v2-bundle-uri-file.sh: "clone with file:// using protocol v2: request bundle-uris"', async () => {
      // ours as the client, native git as the server (a local upload-pack), and the same
      // clone in native git
      setBundles([["bundle.only.uri", `file://${home}/only.bundle`]]);
      const url = `file://${parent}`;
      const t = await cloneTwins(url, undefined, {
        config: ["transfer.bundleURI=true", "protocol.version=2"],
      });
      expect(t.ours).toEqual(t.native);
      expect(t.ours.refs).toContain("refs/bundles/");
    });

    it("an empty bundle list advertises nothing to download", async () => {
      setBundles([]);
      const t = await cloneTwins(`file://${parent}`, undefined, {
        config: ["transfer.bundleURI=true"],
      });
      expect(t.ours).toEqual(t.native);
      expect(t.ours.refs).toBe("");
    });
  });
});

describe("bundle list parsing (test-tool bundle-uri's lists, git's expected output)", () => {
  /** git's `test_cmp_config_output`: the lists as sorted `key=value` lines. */
  const configLines = (text: string): string[] => {
    const out: string[] = [];
    let section = "";
    for (const line of text.split("\n")) {
      const header = /^\[(\w+)(?: "(.*)")?\]$/.exec(line.trim());
      if (header) section = header[2] !== undefined ? `${header[1]}.${header[2]}` : `${header[1]}`;
      const kv = /^\s*(\w+) = (.*)$/.exec(line);
      if (kv) out.push(`${section}.${kv[1]?.toLowerCase()}=${kv[2]}`);
    }
    return out.sort();
  };
  const parseLines = (input: string) => {
    const list = new BundleList("<uri>");
    const errors: string[] = [];
    for (const line of input.split("\n").slice(0, -1)) {
      const error = parseBundleListLine(list, line, errors);
      if (error !== undefined) {
        if (error) errors.push(error);
        errors.push(`error: bad line: '${line}'`);
      }
    }
    return { list: printBundleList(list), errors };
  };

  it('t5750-bundle-uri-parse.sh: "bundle_uri_parse_line() just URIs"', () => {
    const { list, errors } = parseLines(
      "bundle.one.uri=http://example.com/bundle.bdl\nbundle.two.uri=https://example.com/bundle.bdl\nbundle.three.uri=file:///usr/share/git/bundle.bdl\n",
    );
    expect(errors).toEqual([]);
    expect(configLines(list)).toEqual(
      configLines(`[bundle]
	version = 1
	mode = all
[bundle "one"]
	uri = http://example.com/bundle.bdl
[bundle "two"]
	uri = https://example.com/bundle.bdl
[bundle "three"]
	uri = file:///usr/share/git/bundle.bdl
`),
    );
  });

  it('t5750-bundle-uri-parse.sh: "bundle_uri_parse_line(): relative URIs"', () => {
    const { list, errors } = parseLines(
      "bundle.one.uri=bundle.bdl\nbundle.two.uri=../bundle.bdl\nbundle.three.uri=sub/dir/bundle.bdl\n",
    );
    expect(errors).toEqual([]);
    expect(configLines(list)).toEqual(
      configLines(`[bundle]
	version = 1
	mode = all
[bundle "one"]
	uri = <uri>/bundle.bdl
[bundle "two"]
	uri = bundle.bdl
[bundle "three"]
	uri = <uri>/sub/dir/bundle.bdl
`),
    );
  });

  it('t5750-bundle-uri-parse.sh: "bundle_uri_parse_line(): relative URIs and parent paths"', () => {
    expect(() =>
      parseLines("bundle.one.uri=bundle.bdl\nbundle.three.uri=../../bundle.bdl\n"),
    ).toThrow(/cannot strip one component off url/);
  });

  it('t5750-bundle-uri-parse.sh: "bundle_uri_parse_line() parsing edge cases: empty key or value"', () => {
    const { list, errors } = parseLines("=bogus-value\nbogus-key=\n");
    expect(errors).toEqual([
      "error: bundle-uri: line has empty key or value",
      "error: bad line: '=bogus-value'",
      "error: bundle-uri: line has empty key or value",
      "error: bad line: 'bogus-key='",
    ]);
    expect(list).toBe("[bundle]\n\tversion = 1\n\tmode = all\n");
  });

  it('t5750-bundle-uri-parse.sh: "bundle_uri_parse_line() parsing edge cases: empty lines"', () => {
    const { errors } = parseLines(
      "bundle.one.uri=http://example.com/bundle.bdl\n\nbundle.two.uri=https://example.com/bundle.bdl\n\nbundle.three.uri=file:///usr/share/git/bundle.bdl\n",
    );
    expect(errors).toEqual([
      "error: bundle-uri: got an empty line",
      "error: bad line: ''",
      "error: bundle-uri: got an empty line",
      "error: bad line: ''",
    ]);
  });

  it('t5750-bundle-uri-parse.sh: "bundle_uri_parse_line() parsing edge cases: duplicate lines"', () => {
    const { list, errors } = parseLines(
      "bundle.one.uri=http://example.com/bundle.bdl\nbundle.two.uri=https://example.com/bundle.bdl\nbundle.one.uri=https://example.com/bundle-2.bdl\nbundle.three.uri=file:///usr/share/git/bundle.bdl\n",
    );
    expect(errors).toEqual(["error: bad line: 'bundle.one.uri=https://example.com/bundle-2.bdl'"]);
    expect(list).toContain("uri = http://example.com/bundle.bdl");
    expect(list).not.toContain("bundle-2.bdl");
  });

  const parseConfig = async (text: string, uri = "<uri>/list") => {
    const list = new BundleList();
    const messages: string[] = [];
    const ok = await parseBundleListConfig(
      uri,
      new TextEncoder().encode(text),
      "in",
      list,
      messages,
    );
    return { ok, list: printBundleList(list), messages };
  };

  it('t5750-bundle-uri-parse.sh: "parse config format: relative URIs"', async () => {
    const r = await parseConfig(`[bundle]
	version = 1
	mode = all
[bundle "one"]
	uri = bundle.bdl
[bundle "two"]
	uri = ../bundle.bdl
[bundle "three"]
	uri = sub/dir/bundle.bdl
`);
    expect(r.ok).toBe(true);
    expect(r.messages).toEqual([]);
    expect(configLines(r.list)).toEqual(
      configLines(`[bundle]
	version = 1
	mode = all
[bundle "one"]
	uri = <uri>/bundle.bdl
[bundle "two"]
	uri = bundle.bdl
[bundle "three"]
	uri = <uri>/sub/dir/bundle.bdl
`),
    );
  });

  it('t5750-bundle-uri-parse.sh: "parse config format edge cases: empty key or value"', async () => {
    for (const text of ["= bogus-value\n", "bogus-key =\n"]) {
      const r = await parseConfig(text);
      expect(r.ok).toBe(false);
      expect(r.messages).toEqual(["error: bad config line 1 in file in"]);
    }
  });

  it('t5750-bundle-uri-parse.sh: "parse config format: creationToken heuristic"', async () => {
    const text = `[bundle]
	version = 1
	mode = all
	heuristic = creationToken
[bundle "one"]
	uri = http://example.com/bundle.bdl
	creationToken = 123456
[bundle "two"]
	uri = https://example.com/bundle.bdl
	creationToken = 12345678901234567890
[bundle "three"]
	uri = file:///usr/share/git/bundle.bdl
	creationToken = 1
`;
    const r = await parseConfig(text);
    expect(r.ok).toBe(true);
    expect(r.messages).toEqual([]);
    expect(configLines(r.list)).toEqual(configLines(text));
  });

  it('t5750-bundle-uri-parse.sh: "parse config format edge cases: creationToken heuristic"', async () => {
    const r = await parseConfig(`[bundle]
	version = 1
	mode = all
	heuristic = creationToken
[bundle "one"]
	uri = http://example.com/bundle.bdl
	creationToken = bogus
`);
    expect(r.messages).toEqual([
      "warning: could not parse bundle list key creationToken with value 'bogus'",
    ]);
  });

  it('t5750-bundle-uri-parse.sh: "parse config format: bundle with missing uri"', async () => {
    const r = await parseConfig(`[bundle]
	version = 1
	mode = all
[bundle "missing-uri"]
	creationToken = 1
`);
    expect(r.ok).toBe(false);
    expect(r.messages.join("\n")).toContain("bundle 'missing-uri' has no uri");
  });

  it('t5750-bundle-uri-parse.sh: "parse config format: bundle with url instead of uri"', async () => {
    const r = await parseConfig(`[bundle]
	version = 1
	mode = all
[bundle "typo"]
	url = https://example.com/bundle.bdl
`);
    expect(r.ok).toBe(false);
    expect(r.messages.join("\n")).toContain("bundle 'typo' has no uri");
  });

  it('t5750-bundle-uri-parse.sh: "parse config format edge cases: keys without a value"', async () => {
    for (const key of ["mode", "heuristic"]) {
      const r = await parseConfig(`[bundle]\n\tversion = 1\n\t${key}\n`);
      expect(r.ok).toBe(false);
      expect(r.messages.join("\n")).toMatch(new RegExp(`missing value for .bundle.${key}.`));
    }
    for (const key of ["uri", "creationtoken"]) {
      const r = await parseConfig(
        `[bundle]\n\tversion = 1\n\tmode = all\n[bundle "one"]\n\t${key}\n`,
      );
      expect(r.ok).toBe(false);
      expect(r.messages.join("\n")).toMatch(new RegExp(`missing value for .bundle.one.${key}.`));
    }
  });
});
