/**
 * The git transport riding a `@statewalker/webrun-streams` channel.
 *
 * Proves the edge-adapter (`serveRepoOverWebrun` ⇄ `webrunClientDuplex`) carries
 * a real, multi-round git v1 fetch and push over ONE webrun functional-duplex
 * exchange — with the protocol engine (FSMs, pkt-line, operations) unchanged.
 *
 * The loopback needs no transport/mux: a webrun caller `Duplex` and a webrun
 * handler `Duplex` share the same `(input) => AsyncGenerator` shape, so the
 * server handler IS the client's `call`.
 */

import { describe, expect, it } from "vitest";

import {
  fetchOverDuplex,
  pushOverDuplex,
  serveRepoOverWebrun,
  webrunClientDuplex,
} from "../src/index.js";
import { commitInRepo, createTransportRepo } from "./interop/helpers.js";

describe("git transport over a webrun-streams channel", () => {
  it("fetches refs and objects through the webrun client duplex", async () => {
    // Server: a small in-memory vcs-core repo with main → c2, feature @ c2.
    const server = await createTransportRepo();
    const c1 = await commitInRepo(server, "c1", { "a.txt": "hello\n" });
    const c2 = await commitInRepo(server, "c2", { "b.txt": "world\n" }, [c1]);
    await server.refStore.update("refs/heads/main", c2);
    await server.refStore.update("refs/heads/feature", c1);

    // The server handler doubles as the client's webrun `call` (in-process loopback).
    const handler = serveRepoOverWebrun({
      repository: server.facade,
      refStore: server.refStore,
      service: "git-upload-pack",
    });

    const client = await createTransportRepo();
    try {
      const result = await fetchOverDuplex({
        duplex: webrunClientDuplex(handler),
        repository: client.facade,
        refStore: client.refStore,
      });

      expect(result.success, `fetch failed: ${result.error}`).toBe(true);
      // Advertised refs arrived over the channel.
      expect(result.updatedRefs?.get("refs/heads/main")).toBe(c2);
      expect(result.updatedRefs?.get("refs/heads/feature")).toBe(c1);
      // Objects imported under identical git oids.
      expect(await client.facade.has(c1)).toBe(true);
      expect(await client.facade.has(c2)).toBe(true);
      expect(client.imports.at(-1)?.objectsImported ?? 0).toBeGreaterThan(0);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("pushes refs and objects through the webrun client duplex", async () => {
    // Client holds history to push; server is an empty receiving repo.
    const client = await createTransportRepo();
    const c1 = await commitInRepo(client, "c1", { "a.txt": "hello\n" });
    const c2 = await commitInRepo(client, "c2", { "b.txt": "world\n" }, [c1]);
    await client.refStore.update("refs/heads/main", c2);

    const server = await createTransportRepo();
    const handler = serveRepoOverWebrun({
      repository: server.facade,
      refStore: server.refStore,
      service: "git-receive-pack",
    });

    try {
      const result = await pushOverDuplex({
        duplex: webrunClientDuplex(handler),
        repository: client.facade,
        refStore: client.refStore,
        refspecs: ["refs/heads/main:refs/heads/main"],
      });

      expect(result.success, `push failed: ${result.error}`).toBe(true);
      // The served repo's ref advanced to the pushed tip, objects landed.
      expect(await server.refStore.get("refs/heads/main")).toBe(c2);
      expect(await server.facade.has(c1)).toBe(true);
      expect(await server.facade.has(c2)).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
