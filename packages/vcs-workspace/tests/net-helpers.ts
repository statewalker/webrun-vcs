/**
 * Helpers of the network sync tests: in-memory workspaces and server repositories, a loopback
 * HTTP server in front of a Fetch handler, links that fail after N bytes, and native git.
 *
 * Test-only code: `node:*` is allowed here.
 */

import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { createMemoryHistoryWithOperations } from "@statewalker/vcs-core";
import {
  createMessagePortDuplex,
  createRepositoryFacade,
  createTransportRefStore,
} from "@statewalker/vcs-transport";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import {
  createSyncServer,
  duplexRemote,
  type GitWorkspace,
  openGitWorkspace,
  type SyncRemote,
  type SyncServer,
} from "../src/net/index.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

let clock = 1_700_000_000;
/** A clock that advances one second per call: commits made in a row get distinct dates. */
export const tick = () => clock++;

/** A workspace on an in-memory folder and repository. */
export async function workspace(
  name: string,
  files: Record<string, string> = {},
): Promise<GitWorkspace> {
  const history = createMemoryHistoryWithOperations();
  await history.initialize();
  const initialFiles: Record<string, string> = {};
  for (const [path, content] of Object.entries(files)) initialFiles[`/${path}`] = content;
  return openGitWorkspace({
    folder: new MemFilesApi({ initialFiles }),
    history,
    identity: { name, email: `${name.toLowerCase()}@example.com` },
    now: tick,
  });
}

/** The served repository: an empty in-memory history behind `createSyncServer`. */
export async function serverRepo() {
  const history = createMemoryHistoryWithOperations();
  await history.initialize();
  await history.refs.setSymbolic("HEAD", "refs/heads/main");
  const repository = createRepositoryFacade({ history });
  const refStore = createTransportRefStore(history.refs);
  const server = createSyncServer({ repository, refStore });
  return { history, repository, refStore, server };
}

export async function writeFile(ws: GitWorkspace, path: string, content: string): Promise<void> {
  await ws.folder.write(`/${path}`, [enc.encode(content)]);
}

export async function removeFile(ws: GitWorkspace, path: string): Promise<void> {
  await ws.folder.remove(`/${path}`);
}

export async function readFile(ws: GitWorkspace, path: string): Promise<string> {
  const parts: Uint8Array[] = [];
  for await (const p of ws.folder.read(`/${path}`)) parts.push(p);
  return dec.decode(Buffer.concat(parts));
}

/** Every file of the workspace folder, as text. */
export async function folderFiles(ws: GitWorkspace): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const paths: string[] = [];
  for await (const e of ws.folder.list("/", { recursive: true })) {
    if (e.kind === "file") paths.push(e.path.replace(/^\/+/, ""));
  }
  for (const p of paths.sort()) out[p] = await readFile(ws, p);
  return out;
}

export async function headOf(ws: GitWorkspace): Promise<string | undefined> {
  return (await ws.history.refs.resolve(ws.branch))?.objectId;
}

/** A remote served over a MessageChannel per connection. */
export function messageChannelRemote(server: SyncServer, name = "origin"): SyncRemote {
  return duplexRemote({
    name,
    connect: (service) => {
      const channel = new MessageChannel();
      void server.serve(createMessagePortDuplex(channel.port2), service).finally(() => {
        setTimeout(() => channel.port2.close(), 0);
      });
      return createMessagePortDuplex(channel.port1);
    },
  });
}

/** A Fetch handler on an ephemeral loopback port (request and response bodies streamed). */
export async function serveLoopback(
  handler: (request: Request) => Promise<Response>,
): Promise<{ baseUrl: string; close(): Promise<void> }> {
  let baseUrl = "";
  const server: Server = createServer((req, res) => {
    void (async () => {
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === "string") headers.set(key, value);
        else if (Array.isArray(value)) for (const v of value) headers.append(key, v);
      }
      const hasBody = req.method !== "GET" && req.method !== "HEAD";
      const response = await handler(
        new Request(`${baseUrl}${req.url}`, {
          method: req.method,
          headers,
          body: hasBody ? (Readable.toWeb(req) as ReadableStream<Uint8Array>) : undefined,
          duplex: hasBody ? "half" : undefined,
        } as RequestInit),
      );
      res.statusCode = response.status;
      response.headers.forEach((value, key) => {
        res.setHeader(key, value);
      });
      if (response.body) {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          if (!res.write(chunk)) await new Promise((r) => res.once("drain", r));
        }
      }
      res.end();
    })().catch((error: unknown) => {
      res.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    baseUrl,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A stream that passes `limit` bytes of `body`, then fails. */
function cutAfter(body: ReadableStream<Uint8Array>, limit: number): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let passed = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (passed >= limit) {
        void reader.cancel().catch(() => {});
        controller.error(new Error(`link cut after ${limit} bytes`));
        return;
      }
      const next = await reader.read();
      if (next.done) {
        controller.close();
        return;
      }
      const room = limit - passed;
      const chunk = next.value.length > room ? next.value.subarray(0, room) : next.value;
      passed += chunk.length;
      controller.enqueue(chunk);
    },
    cancel: (reason) => reader.cancel(reason),
  });
}

/**
 * A `fetchImpl` whose link fails once `limit` bytes of the fetch's response (`"fetch"`) or of
 * the push's request (`"push"`) have passed.
 */
export function failingLink(
  handler: (request: Request) => Promise<Response>,
  during: "fetch" | "push",
  limit: number,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    if (during === "push" && url.pathname.endsWith("/git-receive-pack") && request.body) {
      const cut = new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: cutAfter(request.body, limit),
        duplex: "half",
      } as RequestInit);
      return handler(cut);
    }
    const response = await handler(request);
    if (during === "fetch" && url.pathname.endsWith("/git-upload-pack") && response.body) {
      return new Response(cutAfter(response.body, limit), {
        status: response.status,
        headers: response.headers,
      });
    }
    return response;
  };
}

// ---- native git

export function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const PROXY_VARIABLES = new Set([
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
]);

/** `process.env` without proxy variables and with loopback in NO_PROXY, plus a fixed identity. */
export function loopbackEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !PROXY_VARIABLES.has(key)) env[key] = value;
  }
  const noProxy = [env.NO_PROXY, env.no_proxy, "127.0.0.1", "localhost"]
    .filter((v) => v !== undefined && v !== "")
    .join(",");
  env.NO_PROXY = noProxy;
  env.no_proxy = noProxy;
  Object.assign(env, {
    GIT_AUTHOR_NAME: "Native Tester",
    GIT_AUTHOR_EMAIL: "native@example.com",
    GIT_COMMITTER_NAME: "Native Tester",
    GIT_COMMITTER_EMAIL: "native@example.com",
    GIT_AUTHOR_DATE: "1700000000 +0000",
    GIT_COMMITTER_DATE: "1700000000 +0000",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  });
  return env;
}

/** Runs native git; resolves stdout, rejects with stderr. */
export function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      args,
      { cwd, env: loopbackEnv(), maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`git ${args.join(" ")}: ${stderr || error.message}`));
        else resolve(stdout.trim());
      },
    );
    // a git that exits before reading its stdin must not crash the test with EPIPE
    child.stdin?.on("error", () => {});
    child.stdin?.end();
  });
}

export function tmpDir(): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), "vcs-workspace-net-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
