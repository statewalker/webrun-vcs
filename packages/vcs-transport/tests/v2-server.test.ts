/**
 * Protocol **v2** server wiring: our v2 server (`serveOverDuplex` with
 * `protocolVersion: "2"`) ↔ our real-git-validated v2 client
 * (`fetchV2OverDuplex`), over an in-process loopback duplex.
 *
 * The v2 client is already proven wire-compatible with a real `git upload-pack`
 * speaking protocol v2 (see interop/fetch-v2-real-git.test.ts). Driving that
 * same client against OUR v2 server closes the loop: it proves the server FSM
 * emits bytes the real-git-validated client accepts, so by transitivity the
 * server is real-git wire-compatible too.
 *
 * The loopback reuses the webrun edge-adapter pair (`serveRepoOverWebrun` ⇄
 * `webrunClientDuplex`) exactly as tests/webrun-channel.test.ts does for v1 —
 * `protocolVersion` threads straight through `serveRepoOverWebrun`'s option
 * spread into `serveOverDuplex`.
 */

import { describe, expect, it } from "vitest";

import {
  fetchOverDuplex,
  fetchV2OverDuplex,
  serveRepoOverWebrun,
  webrunClientDuplex,
} from "../src/index.js";
import { commitInRepo, createTransportRepo } from "./interop/helpers.js";

describe("git protocol v2 server over serveOverDuplex", () => {
  it("v2 client ↔ v2 server loopback: fetches refs + objects under identical git oids", async () => {
    // Server repo: main c1 → c2, plus a branch at c1 (deterministic vcs-core).
    const server = await createTransportRepo();
    const c1 = await commitInRepo(server, "c1", { "a.txt": "hello\n" });
    const c2 = await commitInRepo(server, "c2", { "b.txt": "world\n" }, [c1]);
    await server.refStore.update("refs/heads/main", c2);
    await server.refStore.update("refs/heads/feature", c1);

    // The v2 server handler doubles as the client's webrun `call` (in-process
    // loopback). `protocolVersion: "2"` selects the v2 server FSM.
    const handler = serveRepoOverWebrun({
      repository: server.facade,
      refStore: server.refStore,
      service: "git-upload-pack",
      protocolVersion: "2",
    });

    const client = await createTransportRepo();
    try {
      const result = await fetchV2OverDuplex({
        duplex: webrunClientDuplex(handler),
        repository: client.facade,
        refStore: client.refStore,
      });

      expect(result.success, `v2 fetch failed: ${result.error}`).toBe(true);

      // (a) v2 ls-refs advertisement arrived over the channel, both refs.
      expect(result.updatedRefs?.get("refs/heads/main")).toBe(c2);
      expect(result.updatedRefs?.get("refs/heads/feature")).toBe(c1);

      // (b) Objects imported under IDENTICAL git oids — the sideband-framed pack
      //     the v2 server wrote demuxed cleanly through the client's readPack.
      expect(await client.facade.has(c1)).toBe(true);
      expect(await client.facade.has(c2)).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("default (no protocolVersion) keeps the v1 path: v1 client ↔ v1 server loopback works", async () => {
    // Same server repo, but serve it WITHOUT protocolVersion — the default must
    // stay v1. A v1 fetchOverDuplex loopback succeeding proves the v1 FSM ran.
    const server = await createTransportRepo();
    const c1 = await commitInRepo(server, "c1", { "a.txt": "hello\n" });
    const c2 = await commitInRepo(server, "c2", { "b.txt": "world\n" }, [c1]);
    await server.refStore.update("refs/heads/main", c2);
    await server.refStore.update("refs/heads/feature", c1);

    const handler = serveRepoOverWebrun({
      repository: server.facade,
      refStore: server.refStore,
      service: "git-upload-pack",
      // no protocolVersion → v1
    });

    const client = await createTransportRepo();
    try {
      const result = await fetchOverDuplex({
        duplex: webrunClientDuplex(handler),
        repository: client.facade,
        refStore: client.refStore,
      });

      expect(result.success, `v1 fetch failed: ${result.error}`).toBe(true);
      expect(result.updatedRefs?.get("refs/heads/main")).toBe(c2);
      expect(result.updatedRefs?.get("refs/heads/feature")).toBe(c1);
      expect(await client.facade.has(c1)).toBe(true);
      expect(await client.facade.has(c2)).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  // Best-effort: a REAL `git -c protocol.version=2 clone/fetch` driving OUR v2
  // server. Bridging real git as a *client* requires spawning the git binary
  // against our server (e.g. via an `ext::` helper). In this sandbox the git
  // client subprocess cannot complete such an exchange — the same environment
  // limitation that keeps interop/clone-real-git.test.ts's real-`git clone`
  // test skipped (the spawned git helper hangs before issuing any request).
  // The loopback above PLUS the v2 client's own real-git validation
  // (interop/fetch-v2-real-git.test.ts) together cover wire-compat both ways.
  it.skip("real git v2 client ↔ our v2 server (blocked: git client subprocess in sandbox)", () => {
    // Intentionally empty — see the rationale above. Re-enable in unsandboxed CI.
  });
});
