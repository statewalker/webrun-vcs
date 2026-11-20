/**
 * Test-only: native `git http-backend` (the CGI behind git's smart HTTP) as a
 * `globalThis.fetch` replacement, so the commands talk to real git without a network
 * port. Each request spawns one `git http-backend` over the repositories under
 * `projectRoot` (`http://<any host>/<name>.git/...`).
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";

/** A clean environment for native git: no user config, fixed identity. */
export function nativeGitEnv(home: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    LANG: "C",
    LC_ALL: "C",
    GIT_AUTHOR_NAME: "Interop Tester",
    GIT_AUTHOR_EMAIL: "interop@example.com",
    GIT_COMMITTER_NAME: "Interop Tester",
    GIT_COMMITTER_EMAIL: "interop@example.com",
    GIT_AUTHOR_DATE: "1112911993 +0000",
    GIT_COMMITTER_DATE: "1112911993 +0000",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    // git >= 2.5x runs `maintenance run --auto --detach` after commands such as commit;
    // the detached process repacks .git/objects while a test copies or reads the repository
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "maintenance.auto",
    GIT_CONFIG_VALUE_0: "false",
    GIT_CONFIG_KEY_1: "gc.auto",
    GIT_CONFIG_VALUE_1: "0",
    // the local timezone ours reads (Node's Date): native git must read dates in the same one
    ...(process.env.TZ !== undefined ? { TZ: process.env.TZ } : {}),
    // a git build run from outside its install (another version) finds its helpers here
    ...(process.env.GIT_EXEC_PATH ? { GIT_EXEC_PATH: process.env.GIT_EXEC_PATH } : {}),
  };
}

/** Whether native git (with http-backend) can be run. */
export function nativeGitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export interface NativeGitHttpBackend {
  /** A `globalThis.fetch` that serves every request from `git http-backend` */
  fetch: typeof globalThis.fetch;
  /** Kills any backend process still running */
  close(): void;
}

/**
 * Serves the repositories under `projectRoot` through `git http-backend`; `extraEnv` is added
 * to every backend's variables (`REMOTE_USER`, the variables of the repositories' hooks), or
 * computed per request.
 */
export function nativeGitHttpBackend(
  projectRoot: string,
  home: string,
  extraEnv: Record<string, string> | ((request: Request) => Record<string, string>) = {},
): NativeGitHttpBackend {
  const children = new Set<ChildProcess>();
  const handler = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const body = request.method === "POST" ? Buffer.from(await request.arrayBuffer()) : undefined;
    const gitProtocol = request.headers.get("git-protocol");
    const env: Record<string, string> = {
      ...nativeGitEnv(home),
      GIT_PROJECT_ROOT: projectRoot,
      GIT_HTTP_EXPORT_ALL: "1",
      REQUEST_METHOD: request.method,
      PATH_INFO: url.pathname,
      QUERY_STRING: url.search.replace(/^\?/, ""),
      CONTENT_TYPE: request.headers.get("content-type") ?? "",
      REMOTE_ADDR: "127.0.0.1",
      ...(typeof extraEnv === "function" ? extraEnv(request) : extraEnv),
    };
    if (body) env.CONTENT_LENGTH = String(body.length);
    if (gitProtocol) env.GIT_PROTOCOL = gitProtocol;
    const encoding = request.headers.get("content-encoding");
    if (encoding) env.HTTP_CONTENT_ENCODING = encoding;
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
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (input instanceof Request && init === undefined) return handler(input);
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const requestInit = init?.body ? { ...init, duplex: "half" } : init;
    return handler(new Request(url, requestInit as RequestInit));
  }) as typeof globalThis.fetch;
  return {
    fetch,
    close() {
      for (const child of children) child.kill("SIGKILL");
    },
  };
}
