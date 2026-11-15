/**
 * Our smart-HTTP server against `git http-backend` (run as a CGI on a bare clone of the same
 * repository): the same requests must get the same protocol v2 answers, byte for byte where
 * git's output is deterministic, and git's no-cache headers. Errors git reports before
 * writing anything (it exits with an empty 200 body) are a 500 here carrying git's message.
 *
 * Three servers of ours: the defaults (no object-info, any object served over v2, as current
 * git), `advertiseObjectInfo` (compared with git under `transfer.advertiseObjectInfo=true`) and
 * `requestPolicy: "REACHABLE_COMMIT"` (a stricter v2 than any git setting gives).
 */

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createFetchHandler } from "../../src/index.js";
import {
  cleanupDir,
  commitInRepo,
  createTransportRepo,
  gitAvailable,
  loopbackEnv,
  makeTmpDir,
  type TransportRepo,
} from "./helpers.js";
import { type LoopbackHttpServer, serveFetchHandler } from "./http-server.js";

const describeGit = gitAvailable() ? describe : describe.skip;

const GIT_ENV = {
  GIT_AUTHOR_NAME: "a",
  GIT_AUTHOR_EMAIL: "a@example.com",
  GIT_COMMITTER_NAME: "a",
  GIT_COMMITTER_EMAIL: "a@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};
const GIT_TIMEOUT = 20000;
const children = new Set<ChildProcess>();

interface Answer {
  /** git: 200 unless it sent a Status header; ours: the HTTP status */
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  /** git's stderr */
  stderr: string;
}

function pkt(s: string): string {
  return (s.length + 4).toString(16).padStart(4, "0") + s;
}

/** `git http-backend` as a CGI for one request. */
function httpBackend(
  root: string,
  method: string,
  path: string,
  query: string,
  headers: Record<string, string>,
  body?: Buffer,
  config: Record<string, string> = {},
): Promise<Answer> {
  return new Promise((resolve) => {
    const env: Record<string, string> = {
      ...loopbackEnv(),
      ...GIT_ENV,
      GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: "1",
      REQUEST_METHOD: method,
      PATH_INFO: path,
      QUERY_STRING: query,
      CONTENT_TYPE: headers["content-type"] ?? "",
      REMOTE_ADDR: "127.0.0.1",
    };
    if (body) env.CONTENT_LENGTH = String(body.length);
    const entries = Object.entries(config);
    env.GIT_CONFIG_COUNT = String(entries.length);
    entries.forEach(([key, value], i) => {
      env[`GIT_CONFIG_KEY_${i}`] = key;
      env[`GIT_CONFIG_VALUE_${i}`] = value;
    });
    for (const [k, v] of Object.entries(headers)) {
      env[`HTTP_${k.toUpperCase().replace(/-/g, "_")}`] = v;
    }
    const child = spawn("git", ["http-backend"], { env });
    children.add(child);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), GIT_TIMEOUT);
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("close", () => {
      clearTimeout(timer);
      children.delete(child);
      const all = Buffer.concat(out);
      const end = all.indexOf("\r\n\r\n");
      const head = all.subarray(0, end).toString("latin1");
      const parsed: Record<string, string> = {};
      for (const line of head.split("\r\n")) {
        const colon = line.indexOf(":");
        if (colon > 0) parsed[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
      }
      resolve({
        status: parsed.status ? Number.parseInt(parsed.status, 10) : 200,
        headers: parsed,
        body: all.subarray(end + 4),
        stderr: Buffer.concat(err).toString(),
      });
    });
    // git http-backend answers a GET without reading stdin and may exit first; writing
    // the (empty) body then fails with EPIPE, which must not become an uncaught error.
    child.stdin.on("error", () => {});
    child.stdin.end(body ?? Buffer.alloc(0));
  });
}

async function ours(
  server: LoopbackHttpServer,
  method: string,
  path: string,
  query: string,
  headers: Record<string, string>,
  body?: Buffer,
): Promise<Answer> {
  const response = await fetch(`${server.baseUrl}${path}${query ? `?${query}` : ""}`, {
    method,
    headers,
    body,
  });
  const parsed: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    parsed[key] = value;
  });
  return {
    status: response.status,
    headers: parsed,
    body: Buffer.from(await response.arrayBuffer()),
    stderr: "",
  };
}

/** The body with the `agent=` capability line made comparable. */
function sameAgent(body: Buffer): string {
  return body.toString("latin1").replace(/[0-9a-f]{4}agent=[^\n]*\n/, "XXXXagent=*\n");
}

/**
 * git's advertisement as git 2.56 writes it. git 2.43 and 2.44 (the sandbox has 2.43)
 * advertise a bare `object-info` whatever `transfer.advertiseObjectInfo` says; 2.45 to 2.55
 * advertise the bare line only with that setting; 2.56 writes `object-info=size type` (serve.c
 * object_info_advertise). A bare line is dropped when the setting is off (2.43/2.44 only) and
 * written as 2.56 does when it is on.
 */
function asCurrentGit(body: Buffer, advertiseObjectInfo: boolean): Buffer {
  const legacy = pkt("object-info\n");
  const text = body.toString("latin1");
  if (!text.includes(legacy)) return body;
  return Buffer.from(
    text.replace(legacy, advertiseObjectInfo ? pkt("object-info=size type\n") : ""),
    "latin1",
  );
}

/** Whether a git advertisement offers object-info (2.43 always does). */
function offersObjectInfo(body: Buffer): boolean {
  return /[0-9a-f]{4}object-info(=[^\n]*)?\n/.test(body.toString("latin1"));
}

/** A v2 fetch response: its text pkt-lines up to the pack, and the pack's object count. */
function fetchSections(body: Buffer): { lines: string[]; packObjects?: number } {
  const lines: string[] = [];
  const pack: Buffer[] = [];
  let pos = 0;
  let inPack = false;
  while (pos + 4 <= body.length) {
    const len = Number.parseInt(body.subarray(pos, pos + 4).toString("latin1"), 16);
    if (len < 4) {
      if (!inPack) lines.push(len === 0 ? "FLUSH" : "DELIM");
      pos += 4;
      continue;
    }
    const payload = body.subarray(pos + 4, pos + len);
    pos += len;
    if (inPack) {
      if (payload[0] === 1) pack.push(payload.subarray(1));
      continue;
    }
    const text = payload.toString("latin1").replace(/\n$/, "");
    lines.push(text);
    if (text === "packfile") inPack = true;
  }
  const bytes = Buffer.concat(pack);
  return { lines, packObjects: bytes.length >= 12 ? bytes.readUInt32BE(8) : undefined };
}

describeGit("Interop · our smart-HTTP v2 server against git http-backend", () => {
  let repo: TransportRepo;
  let server: LoopbackHttpServer;
  /** Ours with `advertiseObjectInfo` */
  let infoServer: LoopbackHttpServer;
  /** Ours with `requestPolicy: "REACHABLE_COMMIT"` */
  let strictServer: LoopbackHttpServer;
  let root: string;
  let c1: string;
  let c2: string;
  /** A blob no ref reaches, in both repositories */
  let dangling: string;

  beforeAll(async () => {
    repo = await createTransportRepo();
    c1 = await commitInRepo(repo, "c1", { "a.txt": "a\n" });
    c2 = await commitInRepo(repo, "c2", { "a.txt": "b\n" }, [c1]);
    await repo.refStore.update("refs/heads/main", c2);
    await repo.history.refs.setSymbolic("HEAD", "refs/heads/main");
    const resolveRepository = async (p: string) =>
      p === "/r.git" ? { repository: repo.facade, refStore: repo.refStore } : null;
    server = await serveFetchHandler(createFetchHandler({ resolveRepository }));
    infoServer = await serveFetchHandler(
      createFetchHandler({ resolveRepository, advertiseObjectInfo: true }),
    );
    strictServer = await serveFetchHandler(
      createFetchHandler({ resolveRepository, requestPolicy: "REACHABLE_COMMIT" }),
    );
    root = makeTmpDir("vcs-oracle-");
    await new Promise<void>((resolve, reject) => {
      const child = execFile(
        "git",
        ["clone", "-q", "--bare", `${server.baseUrl}/r.git`, join(root, "r.git")],
        { env: { ...loopbackEnv(), ...GIT_ENV }, timeout: GIT_TIMEOUT, killSignal: "SIGKILL" },
        (error) => {
          children.delete(child);
          if (error) reject(error);
          else resolve();
        },
      );
      children.add(child);
    });
    // the same unreferenced blob on both sides
    dangling = await repo.history.blobs.store([new TextEncoder().encode("dangling\n")]);
    await new Promise<void>((resolve, reject) => {
      const child = execFile(
        "git",
        ["hash-object", "-w", "--stdin"],
        {
          cwd: join(root, "r.git"),
          env: { ...loopbackEnv(), ...GIT_ENV },
          timeout: GIT_TIMEOUT,
          killSignal: "SIGKILL",
        },
        (error, stdout) => {
          children.delete(child);
          if (error) reject(error);
          else if (stdout.trim() !== dangling) reject(new Error(`blob ${stdout} != ${dangling}`));
          else resolve();
        },
      );
      children.add(child);
      child.stdin?.on("error", () => {});
      child.stdin?.end("dangling\n");
    });
  }, 30000);

  afterEach(() => {
    for (const child of children) child.kill("SIGKILL");
    children.clear();
  });

  afterAll(async () => {
    await server?.close();
    await infoServer?.close();
    await strictServer?.close();
    await repo?.close();
    if (root) cleanupDir(root);
  });

  const V2 = { "git-protocol": "version=2" };
  const POST = { "content-type": "application/x-git-upload-pack-request", ...V2 };

  /**
   * The same request to git and to ours. "objectInfo": git with
   * `transfer.advertiseObjectInfo=true`, ours with `advertiseObjectInfo`; "strict": ours with
   * `requestPolicy: "REACHABLE_COMMIT"`, git as configured by `config`.
   */
  async function both(
    method: string,
    path: string,
    query: string,
    headers: Record<string, string>,
    body?: string,
    mode: "default" | "objectInfo" | "strict" = "default",
    config: Record<string, string> = {},
  ): Promise<[Answer, Answer]> {
    const bytes = body === undefined ? undefined : Buffer.from(body, "latin1");
    const gitConfig =
      mode === "objectInfo" ? { "transfer.advertiseObjectInfo": "true", ...config } : config;
    const target = mode === "objectInfo" ? infoServer : mode === "strict" ? strictServer : server;
    return [
      await httpBackend(root, method, path, query, headers, bytes, gitConfig),
      await ours(target, method, path, query, headers, bytes),
    ];
  }

  it("GET info/refs: the same advertisement (v2 without the service preamble), v0 by default", async () => {
    for (const gitProtocol of ["version=2", "version=2:foo=bar", "version=1:version=2"]) {
      const [git, our] = await both("GET", "/r.git/info/refs", "service=git-upload-pack", {
        "git-protocol": gitProtocol,
      });
      expect(sameAgent(our.body), gitProtocol).toBe(sameAgent(asCurrentGit(git.body, false)));
      expect(our.body.toString("latin1")).not.toContain("object-info");
    }
    // a padded entry is not version=2, for git as for us: both answer v0 (a header value's
    // leading and trailing spaces are dropped by HTTP itself, so only inner ones count)
    for (const gitProtocol of ["foo : version=2", "version=2 :foo"]) {
      const [git, our] = await both("GET", "/r.git/info/refs", "service=git-upload-pack", {
        "git-protocol": gitProtocol,
      });
      expect(git.body.toString("latin1")).toMatch(/^001e# service=git-upload-pack\n0000/);
      expect(our.body.toString("latin1")).toMatch(/^001e# service=git-upload-pack\n0000/);
    }
  });

  it("sends git's no-cache headers", async () => {
    for (const [method, path, query, headers, body] of [
      ["GET", "/r.git/info/refs", "service=git-upload-pack", V2, undefined],
      ["GET", "/r.git/info/refs", "service=git-upload-pack", {}, undefined],
      ["POST", "/r.git/git-upload-pack", "", POST, `${pkt("command=ls-refs\n")}0000`],
    ] as const) {
      const [git, our] = await both(method, path, query, headers, body);
      for (const name of ["expires", "pragma", "cache-control"]) {
        expect(our.headers[name], `${method} ${path} ${name}`).toBe(git.headers[name]);
      }
    }
  });

  it("answers ls-refs and an acks-only fetch byte for byte as git", async () => {
    const requests = [
      `${pkt("command=ls-refs\n")}${pkt("agent=git/2\n")}0001${pkt("symrefs\n")}${pkt("peel\n")}${pkt("unborn\n")}0000`,
      `${pkt("command=ls-refs\n")}0001${pkt("ref-prefix HEAD\n")}0000`,
      // two commands in one POST: git runs only the first
      `${pkt("command=ls-refs\n")}00010000${pkt("command=ls-refs\n")}00010000`,
      `${pkt("command=fetch\n")}0001${pkt(`want ${c2}\n`)}${pkt(`have ${"2".repeat(40)}\n`)}0000`,
      "",
      "0000",
    ];
    for (const body of requests) {
      const [git, our] = await both("POST", "/r.git/git-upload-pack", "", POST, body);
      expect(our.status, JSON.stringify(body)).toBe(200);
      expect(our.body.toString("latin1"), JSON.stringify(body)).toBe(git.body.toString("latin1"));
    }
  });

  it("object-info: not served by default (git 2.45+); git 2.43 and 2.44 serve it regardless", async () => {
    const [advert] = await both("GET", "/r.git/info/refs", "service=git-upload-pack", V2);
    const body = `${pkt("command=object-info\n")}0001${pkt("size\n")}${pkt(`oid ${c2}\n`)}0000`;
    const [git, our] = await both("POST", "/r.git/git-upload-pack", "", POST, body);
    expect(our.status).toBe(500);
    expect(our.body.toString()).toContain("invalid command 'object-info'");
    // git 2.45+ refuses it unless transfer.advertiseObjectInfo; 2.43 and 2.44 always offer it
    const legacy = advert.body.toString("latin1").includes(pkt("object-info\n"));
    if (!legacy) {
      expect(offersObjectInfo(advert.body)).toBe(false);
      expect(git.stderr).toContain("invalid command 'object-info'");
    }
  });

  it("object-info with advertiseObjectInfo: advertisement and sizes byte for byte as git", async () => {
    const [advertGit, advertOurs] = await both(
      "GET",
      "/r.git/info/refs",
      "service=git-upload-pack",
      V2,
      undefined,
      "objectInfo",
    );
    expect(sameAgent(advertOurs.body)).toBe(sameAgent(asCurrentGit(advertGit.body, true)));
    expect(advertOurs.body.toString("latin1")).toContain(pkt("object-info=size type\n"));

    const requests = [
      `${pkt("command=object-info\n")}0001${pkt("size\n")}${pkt(`oid ${c2}\n`)}${pkt(`oid ${"1".repeat(40)}\n`)}0000`,
      `${pkt("command=object-info\n")}0001${pkt(`oid ${c2}\n`)}0000`,
      `${pkt("command=object-info\n")}0001${pkt("size\n")}0000`,
    ];
    for (const body of requests) {
      const [git, our] = await both("POST", "/r.git/git-upload-pack", "", POST, body, "objectInfo");
      expect(our.status, JSON.stringify(body)).toBe(200);
      expect(our.body.toString("latin1"), JSON.stringify(body)).toBe(git.body.toString("latin1"));
    }
  });

  it("v2 fetch of an object no ref reaches: served by default, as git's upload-pack", async () => {
    const body = `${pkt("command=fetch\n")}0001${pkt(`want ${dangling}\n`)}${pkt("done\n")}0000`;
    const [git, our] = await both("POST", "/r.git/git-upload-pack", "", POST, body);
    expect(git.status).toBe(200);
    expect(our.status).toBe(200);
    const [gitFetch, ourFetch] = [fetchSections(git.body), fetchSections(our.body)];
    expect(gitFetch).toEqual({ lines: ["packfile"], packObjects: 1 });
    expect(ourFetch).toEqual(gitFetch);
  });

  it("v2 fetch of a missing object: 'not our ref' byte for byte as git", async () => {
    const missing = "3".repeat(40);
    const body = `${pkt("command=fetch\n")}0001${pkt(`want ${missing}\n`)}${pkt("done\n")}0000`;
    const [git, our] = await both("POST", "/r.git/git-upload-pack", "", POST, body);
    expect(git.body.toString("latin1")).toContain(`ERR upload-pack: not our ref ${missing}`);
    expect(our.body.toString("latin1")).toBe(git.body.toString("latin1"));
  });

  it("requestPolicy REACHABLE_COMMIT refuses it as git refuses a missing object; no git setting does", async () => {
    // git's v2 ignores uploadpack.allow*SHA1InWant: even all false, it serves the object
    const strictest = {
      "uploadpack.allowAnySHA1InWant": "false",
      "uploadpack.allowReachableSHA1InWant": "false",
      "uploadpack.allowTipSHA1InWant": "false",
    };
    const body = `${pkt("command=fetch\n")}0001${pkt(`want ${dangling}\n`)}${pkt("done\n")}0000`;
    const [git, our] = await both(
      "POST",
      "/r.git/git-upload-pack",
      "",
      POST,
      body,
      "strict",
      strictest,
    );
    expect(fetchSections(git.body)).toEqual({ lines: ["packfile"], packObjects: 1 });
    // ours: git's message for a want it refuses
    const missing = "3".repeat(40);
    const gitRefusal = (
      await both(
        "POST",
        "/r.git/git-upload-pack",
        "",
        POST,
        `${pkt("command=fetch\n")}0001${pkt(`want ${missing}\n`)}${pkt("done\n")}0000`,
      )
    )[0].body.toString("latin1");
    expect(our.body.toString("latin1")).toBe(gitRefusal.replaceAll(missing, dangling));
  });

  it("refuses what git refuses, with git's message", async () => {
    const requests = [
      `${pkt("command=bogus\n")}00010000`,
      `${pkt("command=ls-refsX\n")}00010000`,
      `${pkt("command=ls-refs\n")}${pkt("object-format=sha256\n")}00010000`,
    ];
    for (const body of requests) {
      const [git, our] = await both("POST", "/r.git/git-upload-pack", "", POST, body);
      const message = git.stderr.replace(/^fatal: /, "").trim();
      expect(message, JSON.stringify(body)).not.toBe("");
      expect(our.status, JSON.stringify(body)).toBe(500);
      expect(our.body.toString(), JSON.stringify(body)).toContain(message);
    }
  });
});
