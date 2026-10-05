/**
 * The git smart-HTTP client/server riding a `@statewalker/webrun-http-streams`
 * `Duplex` instead of a network `fetch`.
 *
 * Proves the bridge (`serveGitOverWebrunHttp` server `Duplex` ⇄
 * `webrunHttpFetch` client `fetchImpl`) carries the stateless smart-HTTP
 * exchanges (GET /info/refs, then POST /git-upload-pack | /git-receive-pack)
 * with the client operations (`fetch`, `clone`, `lsRemote`, `push`) and the
 * server handlers unchanged — no network port.
 *
 * The loopback needs no adapter: the server `Duplex` from
 * `serveGitOverWebrunHttp` IS the client's webrun `call`.
 */

import { describe, expect, it } from "vitest";

import {
  clone,
  fetch as httpFetch,
  lsRemote,
  push,
  serveGitOverWebrunHttp,
  webrunHttpFetch,
} from "../src/index.js";
import { commitInRepo, createTransportRepo, type TransportRepo } from "./interop/helpers.js";

/** hex-encode a 20-byte oid so it can be compared to a git oid string. */
function toHex(oid: Uint8Array): string {
  return Array.from(oid)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function* once(chunk: Uint8Array): AsyncGenerator<Uint8Array> {
  yield chunk;
}

/** A webrun-HTTP `fetchImpl` bound to a server that serves `repo` at any path. */
function serveRepo(repo: TransportRepo): (request: Request) => Promise<Response> {
  const serverDuplex = serveGitOverWebrunHttp({
    resolveRepository: async () => ({ repository: repo.facade, refStore: repo.refStore }),
  });
  return webrunHttpFetch(serverDuplex);
}

describe("git smart-HTTP over a webrun-http-streams duplex", () => {
  it("fetches refs and objects with the injected fetchImpl", async () => {
    const server = await createTransportRepo();
    const c1 = await commitInRepo(server, "c1", { "a.txt": "hello\n" });
    const c2 = await commitInRepo(server, "c2", { "b.txt": "world\n" }, [c1]);
    await server.refStore.update("refs/heads/main", c2);
    await server.refStore.update("refs/heads/feature", c1);

    const client = await createTransportRepo();
    try {
      const result = await httpFetch({
        url: "http://localhost/repo.git",
        fetchImpl: serveRepo(server),
      });

      // Advertised refs arrived over the webrun duplex.
      expect(toHex(result.refs.get("refs/heads/main") as Uint8Array)).toBe(c2);
      expect(toHex(result.refs.get("refs/heads/feature") as Uint8Array)).toBe(c1);
      expect(result.isEmpty).toBe(false);

      // The returned pack imports into the client under identical git oids.
      const imported = await client.facade.importPack(once(result.packData));
      expect(imported.objectsImported).toBeGreaterThan(0);
      expect(await client.facade.has(c1)).toBe(true);
      expect(await client.facade.has(c2)).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("clones a repository with the injected fetchImpl", async () => {
    const server = await createTransportRepo();
    const c1 = await commitInRepo(server, "c1", { "a.txt": "hello\n" });
    const c2 = await commitInRepo(server, "c2", { "b.txt": "world\n" }, [c1]);
    await server.refStore.update("refs/heads/main", c2);

    const client = await createTransportRepo();
    try {
      const result = await clone({
        url: "http://localhost/repo.git",
        fetchImpl: serveRepo(server),
      });

      expect(toHex(result.refs.get("refs/heads/main") as Uint8Array)).toBe(c2);

      const imported = await client.facade.importPack(once(result.packData));
      expect(imported.objectsImported).toBeGreaterThan(0);
      expect(await client.facade.has(c1)).toBe(true);
      expect(await client.facade.has(c2)).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("lists advertised refs (ls-remote) with the injected fetchImpl", async () => {
    const server = await createTransportRepo();
    const c1 = await commitInRepo(server, "c1", { "a.txt": "hello\n" });
    const c2 = await commitInRepo(server, "c2", { "b.txt": "world\n" }, [c1]);
    await server.refStore.update("refs/heads/main", c2);
    await server.refStore.update("refs/heads/feature", c1);

    try {
      const refs = await lsRemote("http://localhost/repo.git", {
        fetchImpl: serveRepo(server),
      });

      expect(refs.get("refs/heads/main")).toBe(c2);
      expect(refs.get("refs/heads/feature")).toBe(c1);
    } finally {
      await server.close();
    }
  });

  it("pushes a ref update with the injected fetchImpl", async () => {
    // Client holds the history to push; server is an empty receiving repo.
    const client = await createTransportRepo();
    const c1 = await commitInRepo(client, "c1", { "a.txt": "hello\n" });
    const c2 = await commitInRepo(client, "c2", { "b.txt": "world\n" }, [c1]);
    await client.refStore.update("refs/heads/main", c2);

    const server = await createTransportRepo();
    try {
      const result = await push({
        url: "http://localhost/repo.git",
        fetchImpl: serveRepo(server),
        refspecs: ["refs/heads/main:refs/heads/main"],
        getLocalRef: (ref) => client.refStore.get(ref),
        exportPack: (wants, exclude) => client.facade.exportPack(wants, exclude),
      });

      expect(result.ok, `push failed: ${result.unpackStatus}`).toBe(true);
      expect(result.updates.get("refs/heads/main")?.ok).toBe(true);

      // The served repo's ref advanced to the pushed tip; objects landed.
      expect(await server.refStore.get("refs/heads/main")).toBe(c2);
      expect(await server.facade.has(c1)).toBe(true);
      expect(await server.facade.has(c2)).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
