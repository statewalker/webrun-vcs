/**
 * The loopback `node:http` bridge of the interop tests (`serveFetchHandler`): a client that
 * disconnects mid-response cancels the response body, so the pack source is finalized
 * instead of being left suspended until the server closes.
 */

import { request } from "node:http";
import { describe, expect, it } from "vitest";

import { createFetchHandler } from "../../src/index.js";
import { encodeDelim, encodeFlush, encodePacketLine } from "../../src/protocol/pkt-line-codec.js";
import { commitInRepo, createTransportRepo } from "./helpers.js";
import { serveFetchHandler } from "./http-server.js";

describe("interop HTTP bridge", () => {
  it("cancels the response body when the client disconnects", async () => {
    const repo = await createTransportRepo();
    const c1 = await commitInRepo(repo, "c1", { "a.txt": "a\n" });
    await repo.refStore.update("refs/heads/main", c1);
    let produced = 0;
    let finalized = false;
    repo.facade.exportPack = async function* () {
      try {
        while (true) {
          produced++;
          yield new Uint8Array(60000);
        }
      } finally {
        finalized = true;
      }
    } as typeof repo.facade.exportPack;
    const server = await serveFetchHandler(
      createFetchHandler({
        resolveRepository: async () => ({ repository: repo.facade, refStore: repo.refStore }),
      }),
    );
    try {
      const parts = [
        encodePacketLine("command=fetch\n"),
        encodeDelim(),
        encodePacketLine(`want ${c1}\n`),
        encodePacketLine("done\n"),
        encodeFlush(),
      ];
      await new Promise<void>((resolve) => {
        const req = request(
          `${server.baseUrl}/r.git/git-upload-pack`,
          {
            method: "POST",
            headers: {
              "git-protocol": "version=2",
              "content-type": "application/x-git-upload-pack-request",
            },
          },
          (res) => {
            res.once("data", () => {
              req.destroy();
              resolve();
            });
          },
        );
        req.on("error", () => {});
        req.end(Buffer.concat(parts));
      });
      for (let i = 0; i < 100 && !finalized; i++) await new Promise((r) => setTimeout(r, 20));
      expect(finalized).toBe(true);
      // nothing more is produced once the client is gone
      const at = produced;
      await new Promise((r) => setTimeout(r, 100));
      expect(produced).toBe(at);
    } finally {
      await server.close();
      await repo.close();
    }
  });
});
