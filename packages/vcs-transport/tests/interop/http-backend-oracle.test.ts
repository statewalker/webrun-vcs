/**
 * Our smart-HTTP server against `git http-backend` (run as a CGI on a bare clone of the same
 * repository): the same requests must get the same protocol v2 answers, byte for byte where
 * git's output is deterministic, and git's no-cache headers. Errors git reports before
 * writing anything (it exits with an empty 200 body) are a 500 here carrying git's message.
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
): Promise<Answer> {
  return new Promise((resolve) => {
    const env: Record<string, string> = {
      ...loopbackEnv(),
      ...GIT_ENV,
      GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: "1",
      // Newer git (CI runs 2.5x) no longer advertises or serves object-info unless
      // `transfer.advertiseObjectInfo` is set; older git ignores the key. We serve
      // object-info, so pin the oracle to advertise it too.
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "transfer.advertiseObjectInfo",
      GIT_CONFIG_VALUE_0: "true",
      REQUEST_METHOD: method,
      PATH_INFO: path,
      QUERY_STRING: query,
      CONTENT_TYPE: headers["content-type"] ?? "",
      REMOTE_ADDR: "127.0.0.1",
    };
    if (body) env.CONTENT_LENGTH = String(body.length);
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
  return (
    body
      .toString("latin1")
      .replace(/[0-9a-f]{4}agent=[^\n]*\n/, "XXXXagent=*\n")
      // git's object-info line depends on its version: 2.43 sends `object-info`, newer git
      // sends `object-info=size type` (and only when transfer.advertiseObjectInfo is set).
      // We serve the `size` attribute, so compare everything else byte for byte.
      .replace(/[0-9a-f]{4}object-info(=[^\n]*)?\n/, "XXXXobject-info*\n")
  );
}

describeGit("Interop · our smart-HTTP v2 server against git http-backend", () => {
  let repo: TransportRepo;
  let server: LoopbackHttpServer;
  let root: string;
  let c1: string;
  let c2: string;

  beforeAll(async () => {
    repo = await createTransportRepo();
    c1 = await commitInRepo(repo, "c1", { "a.txt": "a\n" });
    c2 = await commitInRepo(repo, "c2", { "a.txt": "b\n" }, [c1]);
    await repo.refStore.update("refs/heads/main", c2);
    await repo.history.refs.setSymbolic("HEAD", "refs/heads/main");
    server = await serveFetchHandler(
      createFetchHandler({
        resolveRepository: async (p) =>
          p === "/r.git" ? { repository: repo.facade, refStore: repo.refStore } : null,
      }),
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
  }, 30000);

  afterEach(() => {
    for (const child of children) child.kill("SIGKILL");
    children.clear();
  });

  afterAll(async () => {
    await server?.close();
    await repo?.close();
    if (root) cleanupDir(root);
  });

  const V2 = { "git-protocol": "version=2" };
  const POST = { "content-type": "application/x-git-upload-pack-request", ...V2 };

  async function both(
    method: string,
    path: string,
    query: string,
    headers: Record<string, string>,
    body?: string,
  ): Promise<[Answer, Answer]> {
    const bytes = body === undefined ? undefined : Buffer.from(body, "latin1");
    return [
      await httpBackend(root, method, path, query, headers, bytes),
      await ours(server, method, path, query, headers, bytes),
    ];
  }

  it("GET info/refs: the same advertisement (v2 without the service preamble), v0 by default", async () => {
    for (const gitProtocol of ["version=2", "version=2:foo=bar", "version=1:version=2"]) {
      const [git, our] = await both("GET", "/r.git/info/refs", "service=git-upload-pack", {
        "git-protocol": gitProtocol,
      });
      expect(sameAgent(our.body), gitProtocol).toBe(sameAgent(git.body));
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

  it("answers ls-refs, object-info and an acks-only fetch byte for byte as git", async () => {
    const requests = [
      `${pkt("command=ls-refs\n")}${pkt("agent=git/2\n")}0001${pkt("symrefs\n")}${pkt("peel\n")}${pkt("unborn\n")}0000`,
      `${pkt("command=ls-refs\n")}0001${pkt("ref-prefix HEAD\n")}0000`,
      // two commands in one POST: git runs only the first
      `${pkt("command=ls-refs\n")}00010000${pkt("command=ls-refs\n")}00010000`,
      `${pkt("command=object-info\n")}0001${pkt("size\n")}${pkt(`oid ${c2}\n`)}${pkt(`oid ${"1".repeat(40)}\n`)}0000`,
      `${pkt("command=object-info\n")}0001${pkt(`oid ${c2}\n`)}0000`,
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
