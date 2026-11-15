/**
 * Test-only: native `git http-backend` (the CGI behind git's smart HTTP) as a Fetch API
 * handler, so a client's `fetchImpl` talks to real git without a network port.
 *
 * Each request spawns one `git http-backend` process: the request body goes to its stdin, its
 * CGI headers become the response status and headers, and the rest of its stdout streams out
 * as the response body. `Git-Protocol` reaches git as `GIT_PROTOCOL`, as a web server passes it.
 */

import { type ChildProcess, spawn } from "node:child_process";

import { loopbackEnv } from "./helpers.js";

/** A request the backend served: what a test can check about the client's exchange. */
export interface BackendRequest {
  method: string;
  /** Path and query, relative to the project root */
  path: string;
  gitProtocol: string | null;
  /** The request body (requests are small: wants, haves) */
  body: string;
}

export interface GitHttpBackend {
  handler: (request: Request) => Promise<Response>;
  requests: BackendRequest[];
  /** Kills any backend process still running */
  close(): void;
}

const GIT_ENV = {
  GIT_AUTHOR_NAME: "Interop Tester",
  GIT_AUTHOR_EMAIL: "interop@example.com",
  GIT_COMMITTER_NAME: "Interop Tester",
  GIT_COMMITTER_EMAIL: "interop@example.com",
  GIT_AUTHOR_DATE: "1112911993 +0000",
  GIT_COMMITTER_DATE: "1112911993 +0000",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};

/** Serves the repositories under `projectRoot` (`http://host/<name>.git/...`). */
export function gitHttpBackend(projectRoot: string): GitHttpBackend {
  const requests: BackendRequest[] = [];
  const children = new Set<ChildProcess>();
  const handler = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const body = request.method === "POST" ? Buffer.from(await request.arrayBuffer()) : undefined;
    const gitProtocol = request.headers.get("git-protocol");
    requests.push({
      method: request.method,
      path: `${url.pathname}${url.search}`,
      gitProtocol,
      body: body ? body.toString("latin1") : "",
    });
    const env: Record<string, string> = {
      ...loopbackEnv(),
      ...GIT_ENV,
      GIT_PROJECT_ROOT: projectRoot,
      GIT_HTTP_EXPORT_ALL: "1",
      REQUEST_METHOD: request.method,
      PATH_INFO: url.pathname,
      QUERY_STRING: url.search.replace(/^\?/, ""),
      CONTENT_TYPE: request.headers.get("content-type") ?? "",
      REMOTE_ADDR: "127.0.0.1",
    };
    if (body) env.CONTENT_LENGTH = String(body.length);
    if (gitProtocol) env.GIT_PROTOCOL = gitProtocol;
    const child = spawn("git", ["http-backend"], { env });
    children.add(child);
    child.on("close", () => children.delete(child));
    child.stderr.resume();
    // a backend that answers without reading its input (a GET) closes stdin first: EPIPE
    child.stdin.on("error", () => {});
    child.stdin.end(body ?? Buffer.alloc(0));

    // the CGI head, then the body as it comes
    const reader = child.stdout[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
    let head = Buffer.alloc(0);
    let rest = Buffer.alloc(0);
    while (true) {
      const next = await reader.next();
      if (next.done) break;
      head = Buffer.concat([head, next.value]);
      const end = head.indexOf("\r\n\r\n");
      if (end >= 0) {
        rest = head.subarray(end + 4);
        head = head.subarray(0, end);
        break;
      }
    }
    const headers = new Headers();
    let status = 200;
    for (const line of head.toString("latin1").split("\r\n")) {
      const colon = line.indexOf(":");
      if (colon <= 0) continue;
      const name = line.slice(0, colon).trim();
      const value = line.slice(colon + 1).trim();
      if (name.toLowerCase() === "status") status = Number.parseInt(value, 10);
      else headers.append(name, value);
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (rest.length > 0) controller.enqueue(new Uint8Array(rest));
      },
      async pull(controller) {
        const next = await reader.next();
        if (next.done) controller.close();
        else controller.enqueue(new Uint8Array(next.value));
      },
      cancel() {
        child.kill();
      },
    });
    return new Response(stream, { status, headers });
  };
  return {
    handler,
    requests,
    close() {
      for (const child of children) child.kill("SIGKILL");
    },
  };
}
