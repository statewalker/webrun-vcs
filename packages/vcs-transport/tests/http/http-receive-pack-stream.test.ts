/**
 * POST /git-receive-pack streams its answer: the response head goes out once the commands are
 * read and authorized (before the pack is imported), keep-alive packets follow while the push
 * is checked, then the report. Before the head, failures are HTTP statuses (400, 403, 413);
 * after it, they are answered in band.
 */

import { describe, expect, it } from "vitest";

import {
  type HttpRequest,
  handleReceivePack,
  httpServerSettings,
  serverSettingsFromConfig,
} from "../../src/index.js";
import {
  clientWithNewCommits,
  decodeAnswer,
  fullPackOf,
  pushRequest,
  serverRepo,
  ZERO,
} from "../helpers/receive-pack-harness.js";

function post(body: Uint8Array | ReadableStream<Uint8Array>, chunkSize = 1024): HttpRequest {
  const stream =
    body instanceof ReadableStream
      ? body
      : new ReadableStream<Uint8Array>({
          start(controller) {
            for (let i = 0; i < body.length; i += chunkSize) {
              controller.enqueue(body.slice(i, i + chunkSize));
            }
            controller.close();
          },
        });
  return {
    method: "POST",
    path: "/repo.git/git-receive-pack",
    query: {},
    headers: {},
    body: stream,
  };
}

async function read(body: Uint8Array | ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return body instanceof ReadableStream
    ? new Uint8Array(await new Response(body).arrayBuffer())
    : body;
}

describe("smart-HTTP receive-pack: streamed answer", () => {
  it("answers with the head before the pack is imported, keep-alives while it is checked", async () => {
    const { repo, c2 } = await serverRepo();
    const { client, commits } = await clientWithNewCommits(1);
    const n0 = commits[0] as string;
    let releaseImport: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseImport = resolve;
    });
    let imported = false;
    const importPack = repo.facade.importPack.bind(repo.facade);
    repo.facade.importPack = async (stream) => {
      const result = await importPack(stream);
      await gate; // a slow store
      imported = true;
      return result;
    };
    const response = await handleReceivePack(
      post(
        pushRequest({
          commands: [`${c2} ${n0} refs/heads/main`],
          pack: await fullPackOf(client, [n0], [c2]),
        }),
      ),
      repo.facade,
      repo.refStore,
      {
        receivePack: {
          keepAliveMs: 10,
          hooks: {
            update: () => new Promise<undefined>((r) => setTimeout(() => r(undefined), 80)),
          },
        },
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers["Content-Type"]).toBe("application/x-git-receive-pack-result");
    expect(imported).toBe(false);
    releaseImport();
    const answer = decodeAnswer(await read(response.body), true);
    expect(imported).toBe(true);
    expect(answer.report).toEqual(["unpack ok", "ok refs/heads/main"]);
    expect(answer.keepAlives).toBeGreaterThan(0);
  });

  it("a branch checked out in a linked worktree (checkedOutBranches) is refused over HTTP too", async () => {
    const { repo, c2 } = await serverRepo();
    await repo.refStore.update("refs/heads/topic", c2);
    const { client, commits } = await clientWithNewCommits(1);
    const n0 = commits[0] as string;
    const settings = httpServerSettings(
      serverSettingsFromConfig({
        getAll: (key) => (key === "receive.denyNonFastForwards" ? ["false"] : []),
      }),
    );
    const response = await handleReceivePack(
      post(
        pushRequest({
          commands: [`${c2} ${n0} refs/heads/topic`, `${c2} ${n0} refs/heads/main`],
          pack: await fullPackOf(client, [n0], [c2]),
        }),
      ),
      repo.facade,
      repo.refStore,
      {
        receivePack: {
          ...settings.receivePack,
          bare: true,
          checkedOutBranches: ["refs/heads/topic"],
        },
      },
    );
    const answer = decodeAnswer(await read(response.body), true);
    expect(answer.report).toEqual([
      "unpack ok",
      "ng refs/heads/topic branch is currently checked out",
      "ok refs/heads/main",
    ]);
    expect(answer.messages).toContain("'receive.denyCurrentBranch' configuration variable");
    expect(await repo.refStore.get("refs/heads/topic")).toBe(c2);
  });

  it("a pack over the body limit is answered in band (the head is out)", async () => {
    const { repo, c2 } = await serverRepo();
    const { client, commits } = await clientWithNewCommits(3);
    const tip = commits[2] as string;
    const request = pushRequest({
      commands: [`${c2} ${tip} refs/heads/main`],
      pack: await fullPackOf(client, [tip], [c2]),
    });
    const response = await handleReceivePack(post(request, 64), repo.facade, repo.refStore, {
      maxRequestBodyBytes: request.length - 50,
    });
    expect(response.status).toBe(200);
    const answer = decodeAnswer(await read(response.body), true);
    expect(answer.report[0]).toMatch(/^unpack request body larger than \d+ bytes$/);
    expect(answer.report[1]).toBe("ng refs/heads/main unpacker error");
    expect(await repo.refStore.get("refs/heads/main")).toBe(c2);
  });

  it("too many commands or a malformed command is a 400", async () => {
    const { repo, c2 } = await serverRepo();
    let response = await handleReceivePack(
      post(
        pushRequest({
          commands: Array.from({ length: 5 }, (_, i) => `${ZERO} ${c2} refs/heads/m${i}`),
        }),
      ),
      repo.facade,
      repo.refStore,
      { receivePack: { maxCommands: 4 } },
    );
    expect(response.status).toBe(400);
    response = await handleReceivePack(
      post(pushRequest({ commands: ["nonsense"] })),
      repo.facade,
      repo.refStore,
    );
    expect(response.status).toBe(400);
    expect(new TextDecoder().decode(await read(response.body))).toContain("protocol error");
  });

  it("a stalled body is abandoned after the idle timeout", async () => {
    const { repo, c2 } = await serverRepo();
    const { client, commits } = await clientWithNewCommits(1);
    const n0 = commits[0] as string;
    const request = pushRequest({
      commands: [`${c2} ${n0} refs/heads/main`],
      pack: await fullPackOf(client, [n0], [c2]),
    });
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(request.slice(0, request.length - 30)); // never closed
      },
    });
    const response = await handleReceivePack(post(stalled), repo.facade, repo.refStore, {
      receivePack: { idleTimeoutMs: 100 },
    });
    expect(response.status).toBe(200);
    const answer = decodeAnswer(await read(response.body), true);
    expect(answer.report).toEqual([
      "unpack request idle for 100 ms",
      "ng refs/heads/main unpacker error",
    ]);
  });
});

describe("smart-HTTP receive-pack: the idle timeout cancels the body", () => {
  it("cancels a stalled body's source (not only stops reading it)", async () => {
    const { repo, c2 } = await serverRepo();
    let cancelled: unknown;
    const request = pushRequest({
      commands: [`${c2} ${c2} refs/heads/main`],
      pack: new Uint8Array(12),
    });
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(request.slice(0, request.length - 6));
      },
      pull() {
        return new Promise(() => {}); // never more
      },
      cancel(reason) {
        cancelled = reason ?? "cancelled";
      },
    });
    const response = await handleReceivePack(post(stalled), repo.facade, repo.refStore, {
      receivePack: { idleTimeoutMs: 50 },
    });
    const answer = decodeAnswer(await read(response.body), true);
    expect(answer.report[0]).toBe("unpack request idle for 50 ms");
    expect(cancelled).toBeDefined();
  });

  it("readStreamWithIdleTimeout cancels the stream on a timeout", async () => {
    const { readStreamWithIdleTimeout } = await import("../../src/index.js");
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise(() => {});
      },
      cancel() {
        cancelled = true;
      },
    });
    const chunks = readStreamWithIdleTimeout(stream, 30);
    await expect(chunks.next()).rejects.toThrow("request idle for 30 ms");
    expect(cancelled).toBe(true);
  });
});
