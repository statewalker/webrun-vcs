/**
 * A fetch over a duplex leaves our upload-pack server (`serveOverDuplex`) done, v0 and v2,
 * whether or not it fetched anything: a peer that serves its next request on the same port
 * (fetch, then push) must not be left waiting for wants. An incremental fetch sends haves and
 * gets only the new objects.
 */

import { ObjectType } from "@statewalker/vcs-core";
import { describe, expect, it } from "vitest";

import { fetchOverDuplex, serveOverDuplex } from "../src/index.js";
import { commitInRepo, createTransportRepo, type TransportRepo } from "./interop/helpers.js";

function channel() {
  const queue: Uint8Array[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  return {
    push: (data: Uint8Array) => {
      queue.push(data.slice());
      wake?.();
    },
    end: () => {
      ended = true;
      wake?.();
    },
    async *iterator(): AsyncGenerator<Uint8Array> {
      while (true) {
        const next = queue.shift();
        if (next) {
          yield next;
          continue;
        }
        if (ended) return;
        await new Promise<void>((r) => {
          wake = r;
        });
      }
    },
  };
}

function loopback(server: TransportRepo, v: "1" | "2") {
  const toServer = channel();
  const toClient = channel();
  const served = serveOverDuplex({
    duplex: { [Symbol.asyncIterator]: () => toServer.iterator(), write: toClient.push },
    repository: server.facade,
    refStore: server.refStore,
    service: "git-upload-pack",
    protocolVersion: v,
  }).finally(() => toClient.end());
  return {
    served,
    duplex: {
      [Symbol.asyncIterator]: () => toClient.iterator(),
      write: toServer.push,
      close: async () => toServer.end(),
    },
  };
}

/** Resolves to "TIMEOUT" when `promise` takes longer than `ms`. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | "TIMEOUT"> {
  return Promise.race([promise, new Promise<"TIMEOUT">((r) => setTimeout(() => r("TIMEOUT"), ms))]);
}

describe("fetchOverDuplex ↔ serveOverDuplex sessions", () => {
  it.each(["1", "2"] as const)(
    "protocol v%s: the server is done after each fetch, even an up-to-date one",
    async (v) => {
      const server = await createTransportRepo();
      const client = await createTransportRepo();
      try {
        const c1 = await commitInRepo(server, "c1", { "a.txt": "1" });
        await server.refStore.update("refs/heads/main", c1);
        const refspecs = ["+refs/heads/*:refs/remotes/peer/*"];
        const run = async () => {
          const lb = loopback(server, v);
          const result = await fetchOverDuplex({
            duplex: lb.duplex,
            repository: client.facade,
            refStore: client.refStore,
            refspecs,
          });
          expect(result.success, result.error).toBe(true);
          // the duplex is not closed: the server must end on what the client sent
          expect(await within(lb.served, 2000)).toMatchObject({ success: true });
          return result;
        };

        expect((await run()).report?.refUpdates[0]?.status).toBe("new");
        // nothing to fetch: no request, yet the session ends (git: a flush instead of wants)
        const same = await run();
        expect(same.report?.refUpdates[0]?.status).toBe("up-to-date");
        expect(same.report?.stats.rounds).toBe(0);

        const c2 = await commitInRepo(server, "c2", { "a.txt": "2" }, [c1]);
        await server.refStore.update("refs/heads/main", c2);
        const inc = await run();
        expect(inc.report?.refUpdates[0]?.status).toBe("fast-forward");
        expect(inc.report?.stats.haves).toBeGreaterThan(0);
        expect(inc.report?.packObjects).toBe(3); // the commit, its tree, its blob
      } finally {
        await client.close();
        await server.close();
      }
    },
  );
});

describe("tags a stateful v0 fetch cannot follow", () => {
  it("are reported in tagsNotFollowed (our server ignores include-tag; no second request)", async () => {
    const server = await createTransportRepo();
    const client = await createTransportRepo();
    try {
      const c1 = await commitInRepo(server, "c1", { "a.txt": "1" });
      await server.refStore.update("refs/heads/main", c1);
      const tag = await server.history.tags.store({
        object: c1,
        objectType: ObjectType.COMMIT,
        tag: "v1",
        tagger: { name: "T", email: "t@example.com", timestamp: 1112911993, tzOffset: "+0000" },
        message: "v1\n",
      });
      await server.refStore.update("refs/tags/v1", tag);
      const lb = loopback(server, "1");
      const result = await fetchOverDuplex({
        duplex: lb.duplex,
        repository: client.facade,
        refStore: client.refStore,
        refspecs: ["+refs/heads/*:refs/remotes/peer/*"],
      });
      expect(result.success, result.error).toBe(true);
      expect(result.report?.followedTags).toEqual([]);
      expect(result.report?.tagsNotFollowed).toEqual(["refs/tags/v1"]);
      expect(await client.refStore.get("refs/tags/v1")).toBeUndefined();
      await within(lb.served, 2000);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
