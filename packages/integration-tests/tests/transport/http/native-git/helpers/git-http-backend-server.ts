/**
 * Node.js HTTP server wrapping git-http-backend via CGI.
 *
 * Provides a real Git smart HTTP server for integration testing.
 * Each test creates isolated bare repositories in a temp directory.
 */

import { execSync, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface GitHttpBackendServer {
  /** Base URL including port, e.g., "http://127.0.0.1:9876" */
  url: string;
  /** Port the server is listening on */
  port: number;
  /** Path to the repos directory */
  reposDir: string;
  /** Create a bare repository, returns its URL */
  createBareRepo(name: string): Promise<string>;
  /** Shut down the server and clean up temp directory */
  close(): Promise<void>;
}

/**
 * Check if git-http-backend is available on this system.
 */
export function gitHttpBackendAvailable(): boolean {
  try {
    const execPath = execSync("git --exec-path", { encoding: "utf-8" }).trim();
    execSync(`test -x ${execPath}/git-http-backend`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Start a Node.js HTTP server that proxies to git-http-backend via CGI.
 */
export async function startGitHttpBackendServer(): Promise<GitHttpBackendServer> {
  const reposDir = await mkdtemp(join(tmpdir(), "vcs-test-repos-"));
  const execPath = execSync("git --exec-path", { encoding: "utf-8" }).trim();
  const gitBackendPath = join(execPath, "git-http-backend");

  const server = http.createServer((req, res) => {
    const parsed = new URL(req.url ?? "/", `http://${req.headers.host}`);

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      GIT_PROJECT_ROOT: reposDir,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: parsed.pathname,
      QUERY_STRING: parsed.search?.slice(1) ?? "",
      REQUEST_METHOD: req.method ?? "GET",
      CONTENT_TYPE: req.headers["content-type"] ?? "",
      CONTENT_LENGTH: req.headers["content-length"] ?? "",
      SERVER_PROTOCOL: "HTTP/1.1",
      REMOTE_ADDR: "127.0.0.1",
      REMOTE_USER: "",
    };

    const cgi = spawn(gitBackendPath, [], { env });

    req.pipe(cgi.stdin);

    let headersParsed = false;
    let buffer = Buffer.alloc(0);

    cgi.stdout.on("data", (chunk: Buffer) => {
      if (headersParsed) {
        res.write(chunk);
        return;
      }

      buffer = Buffer.concat([buffer, chunk]);

      // CGI headers may use \r\n\r\n or \n\n
      let headerEnd = buffer.indexOf("\r\n\r\n");
      let headerSep = "\r\n";
      let headerEndLen = 4;
      if (headerEnd === -1) {
        headerEnd = buffer.indexOf("\n\n");
        headerSep = "\n";
        headerEndLen = 2;
      }
      if (headerEnd === -1) return;

      const headerText = buffer.subarray(0, headerEnd).toString();
      const lines = headerText.split(headerSep);

      for (const line of lines) {
        const colonIdx = line.indexOf(":");
        if (colonIdx > 0) {
          const key = line.slice(0, colonIdx).trim();
          const value = line.slice(colonIdx + 1).trim();
          if (key.toLowerCase() === "status") {
            const statusCode = parseInt(value.split(" ")[0], 10);
            res.statusCode = statusCode;
          } else {
            res.setHeader(key, value);
          }
        }
      }

      headersParsed = true;
      const remaining = buffer.subarray(headerEnd + headerEndLen);
      if (remaining.length > 0) {
        res.write(remaining);
      }
    });

    cgi.stdout.on("end", () => res.end());

    cgi.stderr.on("data", (_d: Buffer) => {
      // git-http-backend writes informational messages to stderr
    });

    cgi.on("error", (err) => {
      res.statusCode = 500;
      res.end(`CGI error: ${err.message}`);
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address() as { port: number };

  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    reposDir,

    async createBareRepo(name: string): Promise<string> {
      const repoPath = join(reposDir, name);
      execSync(`git init --bare --initial-branch=main "${repoPath}"`, { stdio: "pipe" });
      execSync(`git -C "${repoPath}" config http.receivepack true`, {
        stdio: "pipe",
      });
      return `http://127.0.0.1:${address.port}/${name}`;
    },

    async close(): Promise<void> {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(reposDir, { recursive: true, force: true });
    },
  };
}
