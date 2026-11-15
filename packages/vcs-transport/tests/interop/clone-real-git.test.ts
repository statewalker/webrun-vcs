/**
 * Direction B: our smart-HTTP server <-> a real client.
 *
 * Bridges the transport's `createFetchHandler` onto a `node:http` server bound
 * to an ephemeral loopback port, serving a repository built from in-memory
 * vcs-core.
 *
 * Two parts:
 *  1. A LIVE test drives the server over the real loopback socket with a
 *     single-shot smart-HTTP exchange (GET /info/refs then POST
 *     /git-upload-pack) and asserts the advertisement + pack result are
 *     well-formed git wire bytes.
 *  2. The REAL `git clone` binary against the same server. git must run
 *     asynchronously: the server answers in this process, so a synchronous
 *     git call (execFileSync) blocks it, and git then waits forever for the
 *     answer (which an earlier version of this test blamed on the sandbox).
 *
 * interop/http-real-git.test.ts covers real git over HTTP in depth (protocol
 * v2 and v0, shallow, deepening, multi-round negotiation).
 */

import { type ChildProcess, execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
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

/** Each git call is killed after this; the test that runs it has longer (TEST_TIMEOUT). */
const GIT_TIMEOUT = 20000;
const TEST_TIMEOUT = 60000;

/** git processes still running (killed after each test). */
const children = new Set<ChildProcess>();

describe("Interop B · smart-HTTP server over a real socket", () => {
  let server: Server;
  let port: number;
  let repo: TransportRepo;
  let head: string;
  let root: string;

  beforeAll(async () => {
    root = makeTmpDir("vcs-interop-http-");
    repo = await createTransportRepo();
    const c1 = await commitInRepo(repo, "c1", { "a.txt": "hello\n" });
    head = await commitInRepo(repo, "c2", { "b.txt": "world\n" }, [c1]);
    await repo.refStore.update("refs/heads/main", head);
    await repo.history.refs.setSymbolic("HEAD", "refs/heads/main");

    const handler = createFetchHandler({
      resolveRepository: async (repoPath) =>
        repoPath === "/repo.git" ? { repository: repo.facade, refStore: repo.refStore } : null,
    });

    server = createServer((req, res) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const body = Buffer.concat(chunks);
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) {
          if (typeof v === "string") headers.set(k, v);
        }
        const request = new Request(`http://127.0.0.1:${port}${req.url}`, {
          method: req.method,
          headers,
          body: req.method === "POST" ? body : undefined,
        });
        const response = await handler(request);
        res.statusCode = response.status;
        response.headers.forEach((value, key) => {
          res.setHeader(key, value);
        });
        res.end(Buffer.from(await response.arrayBuffer()));
      })();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(() => {
    for (const child of children) child.kill("SIGKILL");
    children.clear();
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await repo.close();
    cleanupDir(root);
  });

  it("advertises refs (GET /info/refs) and returns a valid pack (POST /git-upload-pack)", async () => {
    const base = `http://127.0.0.1:${port}/repo.git`;

    // 1. Ref advertisement.
    const infoRes = await fetch(`${base}/info/refs?service=git-upload-pack`);
    expect(infoRes.status).toBe(200);
    expect(infoRes.headers.get("content-type")).toBe("application/x-git-upload-pack-advertisement");
    const advert = await infoRes.text();
    expect(advert).toContain("# service=git-upload-pack");
    expect(advert).toContain(head);
    expect(advert).toContain("refs/heads/main");

    // 2. Single-shot upload-pack request (want <head> + done).
    const pkt = (s: string) => {
      const b = Buffer.from(s, "utf8");
      return Buffer.concat([Buffer.from((b.length + 4).toString(16).padStart(4, "0")), b]);
    };
    const body = Buffer.concat([
      pkt(`want ${head} multi_ack_detailed side-band-64k thin-pack ofs-delta\n`),
      Buffer.from("0000"),
      pkt("done\n"),
    ]);
    const packRes = await fetch(`${base}/git-upload-pack`, {
      method: "POST",
      headers: { "content-type": "application/x-git-upload-pack-request" },
      body,
    });
    expect(packRes.status).toBe(200);
    expect(packRes.headers.get("content-type")).toBe("application/x-git-upload-pack-result");
    const bytes = new Uint8Array(await packRes.arrayBuffer());
    const asText = new TextDecoder().decode(bytes);
    // NAK (no common objects) followed by side-band-framed PACK payload.
    expect(asText).toContain("NAK");
    expect(asText).toContain("PACK");
  });

  it.skipIf(!gitAvailable())("real git clone over smart-HTTP", { timeout: TEST_TIMEOUT }, async () => {
    const dst = join(root, "clone");
    const run = (cwd: string, args: string[]) =>
      new Promise<string>((resolve, reject) => {
        const child = execFile(
          "git",
          args,
          {
            cwd,
            timeout: GIT_TIMEOUT,
            killSignal: "SIGKILL",
            env: {
              // no proxy for the loopback server
              ...loopbackEnv(),
              GIT_CONFIG_GLOBAL: "/dev/null",
              GIT_CONFIG_NOSYSTEM: "1",
              GIT_TERMINAL_PROMPT: "0",
              GIT_AUTHOR_NAME: "Interop Tester",
              GIT_AUTHOR_EMAIL: "interop@example.com",
              GIT_COMMITTER_NAME: "Interop Tester",
              GIT_COMMITTER_EMAIL: "interop@example.com",
              GIT_AUTHOR_DATE: "1112911993 +0000",
              GIT_COMMITTER_DATE: "1112911993 +0000",
            },
          },
          (error, stdout, stderr) => {
            children.delete(child);
            if (error) reject(new Error(`git ${args.join(" ")}: ${stderr}`));
            else resolve(stdout.trim());
          },
        );
        children.add(child);
      });
    await run(root, ["clone", `http://127.0.0.1:${port}/repo.git`, dst]);
    expect(await run(dst, ["rev-parse", "HEAD"])).toBe(head);
    expect(await run(dst, ["rev-list", "--count", "HEAD"])).toBe("2");
    await run(dst, ["fsck", "--strict", "--no-dangling"]);
  });
});
