/**
 * Protocol v2's packfile URIs (`uploadpack.blobPackfileUri` on the server, `fetch.uriProtocols`
 * on the client), against native git (2.43 and 2.5x), from t5702-protocol-v2's packfile-uri
 * cases. There, lib-httpd's Apache serves both the repository and the offloaded packs; here
 * the repository is served over git:// (native `git daemon --inetd`, or ours) or file://, and
 * the packs by a static HTTP server in this process: the URIs are http whatever the transport.
 *
 * Each scenario runs a native client against native upload-pack and the same client against
 * our server, or our client against native upload-pack: git decides what is right.
 */
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createBasePathResolver,
  createDefaultTransports,
  createServedFetchHandler,
  type Duplex,
  serveGitConnection,
} from "@statewalker/vcs-transport";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openLocalRemote } from "../src/commands/local-transport.js";
import { type Git, servedRepositoryOf } from "../src/index.js";
import { type LoopbackServer, serveOnLoopback } from "./http-loopback-support.js";
import { openOurs } from "./merge-native-helpers.js";
import {
  childDuplex,
  daemonArgs,
  gitAsync,
  openTcpSocket,
  startTcpServer,
} from "./native-connect-support.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { gitOut, gitRun, testEnv } from "./status-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root: string;
let srv: string;
let docroot: string;
let counter = 0;
const git = (cwd: string, ...args: string[]) => gitOut(root, cwd, args);

function fresh(name: string): string {
  return join(root, `${name}-${counter++}`);
}

/** `git daemon --inetd` over `srv` for one connection. */
function nativeDaemon(): Duplex {
  return childDuplex(spawn("git", daemonArgs(srv), { env: testEnv(root) }));
}

/** A static file server over `docroot` (lib-httpd's `/dumb/`), counting its requests. */
async function startStaticServer(): Promise<{
  url: string;
  requests: string[];
  close(): Promise<void>;
}> {
  const requests: string[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((req, res) => {
    requests.push(req.url ?? "");
    const name = (req.url ?? "").replace(/^\/dumb\//, "");
    const path = join(docroot, name);
    if (name.includes("/") || !existsSync(path)) {
      res.writeHead(404).end();
      return;
    }
    const body = readFileSync(path);
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": body.length,
    });
    res.end(body);
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/**
 * The fetch response of the last `command=fetch` in a native client's packet trace, as the
 * client read it (`\1` for a band-1 designator), up to the `packfile` line.
 */
function fetchResponse(trace: string): string[] {
  const lines = readFileSync(trace, "latin1")
    .split("\n")
    .map((l) => /packet: +(fetch|clone)([<>]) (.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null);
  let start = -1;
  lines.forEach((m, i) => {
    if (m[2] === ">" && m[3] === "command=fetch") start = i;
  });
  const out: string[] = [];
  for (const m of lines.slice(start + 1)) {
    if (m[2] !== "<") continue;
    out.push(m[3] as string);
    if ((m[3] as string).endsWith("packfile")) break;
  }
  return out;
}

/** What the client sent in its last `command=fetch`. */
function fetchRequest(trace: string, side = "(?:fetch|clone)>"): string[] {
  const lines = readFileSync(trace, "latin1")
    .split("\n")
    .map((l) => new RegExp(`packet: +\\S*${side} (.*)$`).exec(l)?.[1])
    .filter((l): l is string => l !== undefined);
  return lines.slice(lines.lastIndexOf("command=fetch"));
}

/** The objects each pack of `dir` holds (`verify-pack -v`'s object lines), sorted. */
function packContents(dir: string): string[][] {
  const packDir = join(dir, ".git", "objects", "pack");
  return readdirSync(packDir)
    .filter((n) => n.endsWith(".idx"))
    .map((n) =>
      git(dir, "verify-pack", "-v", join(packDir, n))
        .split("\n")
        .filter((l) => /^[0-9a-f]{40} /.test(l))
        .map((l) => l.slice(0, 40))
        .sort(),
    )
    .sort((a, b) => a.length - b.length || (a[0] ?? "").localeCompare(b[0] ?? ""));
}

/** The files of `dir`'s pack directory; with `uriPack`, every other pack's name as `<main>`. */
function packFiles(dir: string, uriPack?: string): string[] {
  return readdirSync(join(dir, ".git", "objects", "pack"))
    .map((n) =>
      uriPack === undefined || n.includes(uriPack) ? n : n.replace(/[0-9a-f]{40}/, "<main>"),
    )
    .sort();
}

function pkt(line: string): string {
  const payload = `${line}\n`;
  return `${(payload.length + 4).toString(16).padStart(4, "0")}${payload}`;
}

/** pkt-lines of a raw answer, as text (`0000` flush, `0001` delim). */
function pktLines(bytes: Uint8Array): string[] {
  const out: string[] = [];
  const text = new TextDecoder("latin1");
  let at = 0;
  while (at + 4 <= bytes.length) {
    const len = Number.parseInt(text.decode(bytes.subarray(at, at + 4)), 16);
    if (Number.isNaN(len)) break;
    if (len < 4) {
      out.push(len === 0 ? "0000" : len === 1 ? "0001" : "0002");
      at += 4;
      continue;
    }
    out.push(text.decode(bytes.subarray(at + 4, at + len)).replace(/\n$/, ""));
    at += len;
  }
  return out;
}

/** A raw v2 request over git://: the advertisement is skipped, the answer's lines returned. */
async function rawV2(duplex: Duplex, path: string, request: string): Promise<string[]> {
  const head = `git-upload-pack ${path}\0host=localhost\0\0version=2\0`;
  await duplex.write(
    new TextEncoder().encode(`${(head.length + 4).toString(16).padStart(4, "0")}${head}`),
  );
  const chunks: number[] = [];
  let sent = false;
  const iterator = duplex[Symbol.asyncIterator]();
  while (true) {
    const next = await Promise.race([
      iterator.next(),
      new Promise<IteratorResult<Uint8Array>>((resolve) =>
        setTimeout(() => resolve({ value: undefined, done: true }), 10_000),
      ),
    ]);
    if (next.done) break;
    chunks.push(...next.value);
    if (!sent && new TextDecoder("latin1").decode(new Uint8Array(chunks)).includes("0000")) {
      sent = true;
      chunks.length = 0;
      await duplex.write(new TextEncoder().encode(request));
      await duplex.end?.();
    }
  }
  await duplex.close?.().catch(() => {});
  return pktLines(new Uint8Array(chunks));
}

describeGit("protocol v2 packfile URIs, as native git", () => {
  let ours: { port: number; close(): Promise<void> };
  let oursHttp: LoopbackServer;
  let files: Awaited<ReturnType<typeof startStaticServer>>;
  const blobs: Record<string, string> = {};
  const packs: Record<string, string> = {};

  /**
   * t5702's configure_exclusion: `git pack-objects` of the blob `file` holds into the docroot,
   * its URI configured (with `hash`, else the pack's own checksum, as the pack hash).
   */
  const configureExclusion = (repo: string, file: string, hash?: (pack: string) => string) => {
    const obj = git(repo, "hash-object", file).trim();
    const pack = execFileSync("git", ["pack-objects", join(docroot, "mypack")], {
      cwd: repo,
      env: testEnv(root),
      input: `${obj}\n`,
    })
      .toString()
      .trim();
    git(
      repo,
      "config",
      "--add",
      "uploadpack.blobpackfileuri",
      `${obj} ${hash ? hash(pack) : pack} ${files.url}/dumb/mypack-${pack}.pack`,
    );
    blobs[file] = obj;
    packs[file] = pack;
    return obj;
  };

  /** A served repository `name` (sideband-all allowed) with `files` committed. */
  const makeRepo = (name: string, content: Record<string, string>, sidebandAll = true) => {
    const repo = join(srv, name);
    git(root, "init", "-q", "-b", "main", repo);
    if (sidebandAll) git(repo, "config", "uploadpack.allowSidebandAll", "true");
    for (const [file, text] of Object.entries(content)) {
      writeFileSync(join(repo, file), text);
      git(repo, "add", file);
    }
    gitOut(root, repo, ["commit", "-qm", "x"], {
      GIT_AUTHOR_DATE: "1700000000 +0000",
      GIT_COMMITTER_DATE: "1700000000 +0000",
    });
    return repo;
  };

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "packfile-uris-"));
    srv = join(root, "srv");
    docroot = join(root, "docroot");
    mkdirSync(srv);
    mkdirSync(docroot);
    files = await startStaticServer();

    // "part of packfile response provided as URI": two blobs, each offloaded
    const two = makeRepo("two", { "my-blob": "my-blob\n", "other-blob": "other-blob\n" });
    configureExclusion(two, "my-blob");
    configureExclusion(two, "other-blob");
    // "fetching with valid packfile URI but invalid hash fails": the object's id as pack hash
    const bad = makeRepo("bad", { "my-blob": "my-blob\n", "other-blob": "other-blob\n" });
    configureExclusion(bad, "my-blob");
    configureExclusion(bad, "other-blob", () => git(bad, "hash-object", "other-blob").trim());
    // one blob, for fetch instead of clone and the keep file
    const one = makeRepo("one", { "my-blob": "my-blob\n" });
    configureExclusion(one, "my-blob");
    // offloading needs sideband-all: without it the protocols are forgotten
    const nosba = makeRepo("nosba", { "my-blob": "my-blob\n" }, false);
    configureExclusion(nosba, "my-blob");
    // "packfile-uri with transfer.fsckobjects ... .gitmodules is separate from tree"
    const modules = makeRepo("modules", {
      ".gitmodules":
        "[submodule libfoo]\npath = include/foo\nurl = git://example.com/git/lib.git\n",
    });
    configureExclusion(modules, ".gitmodules");
    const badModules = makeRepo("badmodules", {
      ".gitmodules": '[submodule ".."]\npath = include/foo\nurl = git://example.com/git/lib.git\n',
    });
    configureExclusion(badModules, ".gitmodules");
    // "reject client packfile-uris if not advertised": none, any value
    makeRepo("plain", { a: "a\n" });
    const anything = makeRepo("anything", { a: "a\n" });
    git(anything, "config", "uploadpack.blobpackfileuri", "anything");

    const host = await openOurs(
      srv,
      createNodeGitHostEnvironment({ env: testEnv(root) }),
      undefined,
      "two",
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
    ours = await startTcpServer(async (duplex) => {
      await serveGitConnection({ duplex, resolveRepository });
    });
    oursHttp = await serveOnLoopback(createServedFetchHandler({ resolveRepository }));
  });

  afterAll(async () => {
    await ours?.close();
    await oursHttp?.close();
    await files?.close();
    rmSync(root, { recursive: true, force: true });
  });

  const nativeUrl = (repo: string) => `file://${join(srv, repo)}`;
  const ourUrl = (repo: string) => `git://127.0.0.1:${ours.port}/${repo}`;
  const URI_PROTOCOLS = ["-c", "protocol.version=2", "-c", "fetch.uriprotocols=http,https"];

  /** A native clone of `url` with `fetch.uriProtocols`, traced. */
  const nativeClone = async (url: string, ...config: string[]) => {
    const dir = fresh("clone");
    const trace = fresh("trace");
    const r = await gitAsync(root, root, [...URI_PROTOCOLS, ...config, "clone", "-q", url, dir], {
      GIT_TRACE_PACKET: trace,
    });
    return { dir, trace, ...r };
  };

  it(`t5701-git-serve.sh: "test capability advertisement": fetch=... packfile-uris with uploadpack.blobPackfileUri`, async () => {
    const capability = async (url: string) => {
      const trace = fresh("trace");
      const r = await gitAsync(root, root, ["-c", "protocol.version=2", "ls-remote", url], {
        GIT_TRACE_PACKET: trace,
      });
      expect(r.status, r.stderr).toBe(0);
      return readFileSync(trace, "latin1")
        .split("\n")
        .map((l) => /ls-remote< (fetch=.*)$/.exec(l)?.[1])
        .find((l) => l !== undefined);
    };
    // (a valueless uploadpack.blobPackfileUri kills 2.43's advertisement, 2.5x ignores it)
    for (const repo of ["two", "nosba", "plain", "anything"]) {
      expect(await capability(ourUrl(repo)), repo).toBe(await capability(nativeUrl(repo)));
    }
    expect(await capability(nativeUrl("two"))).toBe(
      "fetch=shallow wait-for-done sideband-all packfile-uris",
    );
  });

  it(`t5702-protocol-v2.sh: "part of packfile response provided as URI": a native client and our server`, async () => {
    const theirs = await nativeClone(nativeUrl("two"));
    expect(theirs.status, theirs.stderr).toBe(0);
    const mine = await nativeClone(ourUrl("two"));
    expect(mine.status, mine.stderr).toBe(0);
    // the section, on band 1 (its lines in git's object hash order: compared sorted)
    const response = fetchResponse(mine.trace);
    expect([...response].sort()).toEqual([...fetchResponse(theirs.trace)].sort());
    expect(response[0]).toBe("\\1packfile-uris");
    expect(response.at(-1)).toBe("\\1packfile");
    // three packs: each offloaded blob alone in its own
    expect(packContents(mine.dir)).toEqual(packContents(theirs.dir));
    expect(packContents(mine.dir).slice(0, 2)).toEqual(
      [[blobs["my-blob"]], [blobs["other-blob"]]].sort((a, b) =>
        (a[0] as string).localeCompare(b[0] as string),
      ),
    );
    expect(packFiles(mine.dir).filter((n) => /\.(pack|idx)$/.test(n))).toHaveLength(6);
    expect(gitOut(root, mine.dir, ["fsck", "--strict"])).toBe("");
    expect(git(mine.dir, "rev-parse", "HEAD")).toBe(git(theirs.dir, "rev-parse", "HEAD"));
  });

  it(`t5702-protocol-v2.sh: "part of packfile response provided as URI": a native client and our smart-HTTP server`, async () => {
    const theirs = await nativeClone(nativeUrl("two"));
    const mine = await nativeClone(`${oursHttp.baseUrl}/two`);
    expect(mine.status, mine.stderr).toBe(0);
    expect([...fetchResponse(mine.trace)].sort()).toEqual([...fetchResponse(theirs.trace)].sort());
    expect(packContents(mine.dir)).toEqual(packContents(theirs.dir));
    expect(gitOut(root, mine.dir, ["fsck", "--strict"])).toBe("");
  });

  it(`t5702-protocol-v2.sh: "part of packfile response provided as URI": our client and native upload-pack`, async () => {
    const dir = fresh("o");
    git(root, "init", "-q", "-b", "main", dir);
    git(dir, "config", "protocol.version", "2");
    git(dir, "config", "fetch.uriprotocols", "http,https");
    const before = files.requests.length;
    await (await oursAt(dir))
      .fetch()
      .setRemote("git://localhost/two")
      .setRefSpecs("+refs/heads/main:refs/remotes/o/main")
      .setTransports(createDefaultTransports({ openSocket: async () => nativeDaemon() }))
      .call();
    expect(files.requests.slice(before).sort()).toEqual(
      [`/dumb/mypack-${packs["my-blob"]}.pack`, `/dumb/mypack-${packs["other-blob"]}.pack`].sort(),
    );
    const theirs = await nativeClone(nativeUrl("two"));
    expect(packContents(dir)).toEqual(packContents(theirs.dir));
    // each offloaded pack is the server's, byte for byte (its name is its checksum)
    expect(packFiles(dir)).toContain(`pack-${packs["my-blob"]}.pack`);
    expect(packFiles(dir)).toContain(`pack-${packs["other-blob"]}.pack`);
    expect(packFiles(dir).some((n) => n.endsWith(".keep"))).toBe(false);
    expect(gitOut(root, dir, ["fsck", "--strict"])).toBe("");
  });

  it(`t5702-protocol-v2.sh: "packfile URIs with fetch instead of clone": a native client and our server`, async () => {
    const run = async (url: string) => {
      const dir = fresh("f");
      git(root, "init", "-q", dir);
      const r = await gitAsync(root, dir, [...URI_PROTOCOLS, "fetch", "-q", url]);
      expect(r.status, r.stderr).toBe(0);
      return dir;
    };
    const theirs = await run(nativeUrl("one"));
    const mine = await run(ourUrl("one"));
    expect(packContents(mine)).toEqual(packContents(theirs));
    expect(packContents(mine)[0]).toEqual([blobs["my-blob"]]);
    // the server's own pack differs by its bytes (our pack writer): named by its role; git
    // leaves its .keep behind (index-pack --keep, never registered as a lock to remove)
    expect(packFiles(mine, packs["my-blob"])).toEqual(packFiles(theirs, packs["my-blob"]));
    expect(packFiles(mine, packs["my-blob"])).toContain("pack-<main>.keep");
  });

  it(`t5702-protocol-v2.sh: "packfile URI preserves an existing keep file": our client and native upload-pack`, async () => {
    const run = async (ourClient: boolean) => {
      const dir = fresh(ourClient ? "o" : "n");
      git(root, "init", "-q", "-b", "main", dir);
      const keep = join(dir, ".git", "objects", "pack", `pack-${packs["my-blob"]}.keep`);
      mkdirSync(join(dir, ".git", "objects", "pack"), { recursive: true });
      writeFileSync(keep, "pre-existing\n");
      if (ourClient) {
        git(dir, "config", "protocol.version", "2");
        git(dir, "config", "fetch.uriprotocols", "http,https");
        await (await oursAt(dir))
          .fetch()
          .setRemote("git://localhost/one")
          .setRefSpecs("+refs/heads/main:refs/remotes/o/main")
          .setTransports(createDefaultTransports({ openSocket: async () => nativeDaemon() }))
          .call();
      } else {
        const r = await gitAsync(root, dir, [...URI_PROTOCOLS, "fetch", "-q", nativeUrl("one")]);
        // git before 2.5x's fix dies on the keep file http-fetch could not create
        if (r.status !== 0) {
          expect(r.stderr).toContain("expected keep then TAB at start of http-fetch output");
          return undefined;
        }
      }
      expect(readFileSync(keep, "utf8")).toBe("pre-existing\n");
      git(dir, "cat-file", "-e", blobs["my-blob"] as string);
      // our client leaves no .keep of its own (git's main pack keeps one: see above)
      return packFiles(dir, packs["my-blob"]).filter((n) => n !== "pack-<main>.keep");
    };
    const mine = await run(true);
    const theirs = await run(false);
    if (theirs) expect(mine).toEqual(theirs);
  });

  it(`t5702-protocol-v2.sh: "fetching with valid packfile URI but invalid hash fails"`, async () => {
    const theirs = await nativeClone(nativeUrl("bad"));
    expect(theirs.status).not.toBe(0);
    const line = /fatal: .*pack downloaded from .* does not match expected hash .*/.exec(
      theirs.stderr,
    )?.[0];
    expect(line, theirs.stderr).toBeDefined();
    // a native client and our server
    const mine = await nativeClone(ourUrl("bad"));
    expect(mine.status).toBe(theirs.status);
    expect(mine.stderr).toContain(line as string);
    expect(existsSync(mine.dir)).toBe(false);
    // our client and native upload-pack: git's line, the pack left out
    const dir = fresh("o");
    git(root, "init", "-q", "-b", "main", dir);
    git(dir, "config", "protocol.version", "2");
    git(dir, "config", "fetch.uriprotocols", "http,https");
    let message = "";
    try {
      await (await oursAt(dir))
        .fetch()
        .setRemote("git://localhost/bad")
        .setRefSpecs("+refs/heads/main:refs/remotes/o/main")
        .setTransports(createDefaultTransports({ openSocket: async () => nativeDaemon() }))
        .call();
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(line as string);
    expect(
      gitRun(root, dir, ["rev-parse", "-q", "--verify", "refs/remotes/o/main"]).status,
    ).not.toBe(0);
    expect(packFiles(dir)).not.toContain(`pack-${packs["other-blob"]}.pack`);
  });

  it(`t5702-protocol-v2.sh: "packfile-uri with transfer.fsckobjects": our client and native upload-pack`, async () => {
    for (const repo of ["one", "modules", "badmodules"]) {
      const theirs = await nativeClone(nativeUrl(repo), "-c", "transfer.fsckobjects=1");
      const dir = fresh("o");
      git(root, "init", "-q", "-b", "main", dir);
      git(dir, "config", "protocol.version", "2");
      git(dir, "config", "fetch.uriprotocols", "http,https");
      git(dir, "config", "transfer.fsckobjects", "true");
      let message = "";
      try {
        await (await oursAt(dir))
          .fetch()
          .setRemote(`git://localhost/${repo}`)
          .setRefSpecs("+refs/heads/main:refs/remotes/o/main")
          .setTransports(createDefaultTransports({ openSocket: async () => nativeDaemon() }))
          .call();
      } catch (error) {
        message = (error as Error).message;
      }
      if (repo === "badmodules") {
        // "... fails when .gitmodules separate from tree is invalid"
        expect(theirs.status, repo).not.toBe(0);
        expect(theirs.stderr).toContain("disallowed submodule name");
        expect(message, repo).toContain("disallowed submodule name");
      } else {
        expect(theirs.status, theirs.stderr).toBe(0);
        expect(message, repo).toBe("");
        expect(packContents(dir), repo).toEqual(packContents(theirs.dir));
      }
    }
  });

  /** A v2 fetch request (pkt-lines). */
  const request = (...args: string[]) => `${pkt("command=fetch")}0001${args.map(pkt).join("")}0000`;

  const RAW: Array<[string, string, string[]]> = [
    // "reject client packfile-uris if not advertised": no answer, no answer, an answer
    [
      `t5702-protocol-v2.sh: "reject client packfile-uris if not advertised"`,
      "plain",
      ["packfile-uris https", "done"],
    ],
    [
      `t5702-protocol-v2.sh: "reject client packfile-uris if not advertised" (any value)`,
      "anything",
      ["packfile-uris https", "done"],
    ],
    // without sideband-all the protocols are forgotten: the whole pack
    [
      `t5702-protocol-v2.sh: "part of packfile response provided as URI" (without sideband-all)`,
      "nosba",
      ["no-progress", "packfile-uris http", "want main", "done"],
    ],
    // a protocol no URI has: nothing offloaded
    [
      `t5702-protocol-v2.sh: "part of packfile response provided as URI" (https only)`,
      "two",
      ["no-progress", "sideband-all", "packfile-uris https", "want main", "done"],
    ],
    // the section, as upload-pack's relay_pack_data writes it
    [
      `t5702-protocol-v2.sh: "packfile URIs with fetch instead of clone" (the section)`,
      "one",
      ["no-progress", "sideband-all", "packfile-uris http", "want main", "done"],
    ],
  ];
  for (const [title, repo, args] of RAW) {
    it(`${title}: our answer as upload-pack's`, async () => {
      const main = git(join(srv, repo), "rev-parse", "main").trim();
      const body = request(...args.map((a) => (a === "want main" ? `want ${main}` : a)));
      const cut = (answer: string[]) => {
        const at = answer.findIndex((l) => l === "packfile" || l === "\x01packfile");
        return at < 0 ? answer : answer.slice(0, at + 1);
      };
      const theirs = await rawV2(nativeDaemon(), `/${repo}`, body);
      const mine = await rawV2(await openTcpSocket("127.0.0.1", ours.port), `/${repo}`, body);
      expect(cut(mine)).toEqual(cut(theirs));
    });
  }

  it(`t5702-protocol-v2.sh: "reject client packfile-uris if not advertised" (a malformed value with wants): pack-objects dies, as upload-pack's`, async () => {
    const main = git(join(srv, "anything"), "rev-parse", "main").trim();
    const body = request(`want ${main}`, "done");
    // git daemon's answer sometimes stops after `packfile` (the death races the client's
    // half-close, as "Refused wants race the client's write"): take the first whole one
    const whole = (lines: string[]) => lines.join("\n").includes("must be of the form");
    let theirs = await rawV2(nativeDaemon(), "/anything", body);
    for (let tries = 0; tries < 5 && !whole(theirs); tries++) {
      theirs = await rawV2(nativeDaemon(), "/anything", body);
    }
    const mine = await rawV2(await openTcpSocket("127.0.0.1", ours.port), "/anything", body);
    // (ours ends the answer with a flush after the abort, as for every pack-objects death)
    // and git 2.5x sends the abort without 2.43's trailing NUL, which ours keeps
    const noNul = (lines: string[]) => lines.map((l) => l.replace(/\0$/, ""));
    expect(noNul(mine.slice(0, theirs.length))).toEqual(noNul(theirs));
    expect(theirs.join("\n")).toContain("value of uploadpack.blobpackfileuri must be of the form");
  });

  it(`t5702-protocol-v2.sh: "part of packfile response provided as URI": our client asks only for http and https`, async () => {
    const dir = fresh("o");
    git(root, "init", "-q", "-b", "main", dir);
    git(dir, "config", "protocol.version", "2");
    git(dir, "config", "fetch.uriprotocols", "ftp,https,http");
    const serverTrace = fresh("trace");
    await (await oursAt(dir))
      .fetch()
      .setRemote("git://localhost/one")
      .setRefSpecs("+refs/heads/main:refs/remotes/o/main")
      .setTransports(
        createDefaultTransports({
          openSocket: async () =>
            childDuplex(
              spawn("git", daemonArgs(srv), {
                env: testEnv(root, { GIT_TRACE_PACKET: serverTrace }),
              }),
            ),
        }),
      )
      .call();
    // the native client's line for the same configuration
    const nativeTrace = fresh("trace");
    const n = fresh("n");
    git(root, "init", "-q", n);
    await gitAsync(
      root,
      n,
      [
        "-c",
        "protocol.version=2",
        "-c",
        "fetch.uriprotocols=ftp,https,http",
        "fetch",
        "-q",
        nativeUrl("one"),
      ],
      { GIT_TRACE_PACKET: nativeTrace },
    );
    const uris = (lines: string[]) => lines.filter((l) => l.startsWith("packfile-uris "));
    expect(uris(fetchRequest(serverTrace, "upload-pack<"))).toEqual(
      uris(fetchRequest(nativeTrace)),
    );
    expect(uris(fetchRequest(nativeTrace))).toEqual(["packfile-uris https,http"]);
  });
});

/** Our working copy of the repository at `dir` (below `root`). */
function oursAt(dir: string): Promise<Git> {
  return openOurs(
    root,
    createNodeGitHostEnvironment({ env: testEnv(root) }),
    undefined,
    dir.slice(root.length + 1),
  );
}
