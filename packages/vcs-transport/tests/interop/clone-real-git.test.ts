/**
 * Direction B (best-effort): our smart-HTTP server ↔ a real client.
 *
 * Bridges the transport's `createFetchHandler` onto a `node:http` server bound
 * to an ephemeral loopback port, serving a repository built from in-memory
 * vcs-core.
 *
 * Two parts:
 *  1. A LIVE test drives the server over the real loopback socket with a
 *     single-shot smart-HTTP exchange (GET /info/refs then POST
 *     /git-upload-pack) and asserts the advertisement + pack result are
 *     well-formed git wire bytes. This proves the HTTP adapter works over a
 *     real TCP socket, not just in-process.
 *  2. A SKIPPED test that would run the REAL `git clone` binary against the
 *     same server. In this sandbox the spawned `git-remote-http` helper hangs
 *     before it issues any HTTP request (the server logs receive nothing),
 *     even though a `fetch()` to the very same socket succeeds — i.e. the git
 *     HTTP subprocess cannot open the loopback connection here. This is an
 *     environment limitation, NOT a protocol defect: the server returns a
 *     valid `# service=…` advertisement and a valid `NAK` + side-band `PACK`
 *     for a single-shot request (asserted in part 1). The restructure should
 *     re-enable this against the real git binary in an unsandboxed CI.
 *
 * Direction A (fetch/push over upload-pack/receive-pack) is the required
 * deliverable and already covers the pkt-line/capability/pack wire both ways.
 */

import { type AddressInfo, createServer, type Server } from "node:http";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createFetchHandler } from "../../src/index.js";
import {
  cleanupDir,
  commitInRepo,
  createTransportRepo,
  makeTmpDir,
  type TransportRepo,
} from "./helpers.js";

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

  // See file header: real `git clone` cannot open the loopback socket from the
  // spawned git-remote-http helper in this sandbox. Unskip in unsandboxed CI.
  it.skip("real git clone over smart-HTTP (blocked: git http subprocess in sandbox)", () => {
    // Intentionally empty — see the describe rationale in the file header.
    // Reference wiring lives in git history; the server side is proven by the
    // single-shot socket test above and the http-transport unit suite.
  });
});
