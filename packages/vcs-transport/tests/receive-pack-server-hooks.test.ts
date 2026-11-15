/**
 * receive-pack's hooks, wired through the package's handlers (`serveOverDuplex` and the
 * smart-HTTP `createFetchHandler`): `authorize` before the pack is read, `preReceive`, the
 * per-ref `update` hook (non-atomic and atomic), and `postReceive` after the report.
 * Replaces the hollow receive-pack-hooks.test.ts, which called mocks of the hooks directly.
 */

import { describe, expect, it, vi } from "vitest";

import {
  createFetchHandler,
  createMessagePortDuplex,
  pushOverDuplex,
  type ReceiveCommand,
  type ReceivePackHooks,
  serveOverDuplex,
} from "../src/index.js";
import {
  clientWithNewCommits,
  decodeAnswer,
  fullPackOf,
  pushRequest,
  runReceivePack,
  serverRepo,
  ZERO,
} from "./helpers/receive-pack-harness.js";
import type { TransportRepo } from "./interop/helpers.js";

async function setup() {
  const { repo, c2 } = await serverRepo();
  const { client, commits } = await clientWithNewCommits(2);
  const [n0, n1] = commits as [string, string];
  const pack = await fullPackOf(client, [n1], [c2]);
  return { repo, c2, n0, n1, pack };
}

/** Spies on the facade's pack import. */
function spyImport(repo: TransportRepo) {
  const importPack = repo.facade.importPack.bind(repo.facade);
  const spy = vi.fn(importPack);
  repo.facade.importPack = spy;
  return spy;
}

describe("receive-pack hooks over a duplex (serveOverDuplex)", () => {
  it("authorize refusing the push: every command ng, the pack not imported", async () => {
    const { repo, c2, n1, pack } = await setup();
    const importSpy = spyImport(repo);
    const authorize = vi.fn(() => "permission denied");
    const run = await runReceivePack(
      repo,
      { commands: [`${c2} ${n1} refs/heads/main`, `${ZERO} ${n1} refs/heads/x`], pack },
      { hooks: { authorize } },
    );
    expect(run.report).toEqual([
      "unpack ok",
      "ng refs/heads/main permission denied",
      "ng refs/heads/x permission denied",
    ]);
    expect(importSpy).not.toHaveBeenCalled();
    expect(authorize).toHaveBeenCalledTimes(1);
    const [commands] = authorize.mock.calls[0] as unknown as [ReceiveCommand[]];
    expect(commands.map((c) => c.refName)).toEqual(["refs/heads/main", "refs/heads/x"]);
    expect(await repo.refStore.get("refs/heads/main")).toBe(c2);
  });

  it("authorize refusing some refs: those ng, the others applied", async () => {
    const { repo, c2, n1, pack } = await setup();
    const run = await runReceivePack(
      repo,
      { commands: [`${c2} ${n1} refs/heads/main`, `${ZERO} ${n1} refs/heads/protected`], pack },
      {
        hooks: {
          authorize: () => ({
            ok: false,
            message: "read-only",
            rejectedRefs: ["refs/heads/protected"],
          }),
        },
      },
    );
    expect(run.report).toEqual([
      "unpack ok",
      "ok refs/heads/main",
      "ng refs/heads/protected read-only",
    ]);
    expect(await repo.refStore.get("refs/heads/main")).toBe(n1);
  });

  it("the update hook refuses one ref; the others are applied (non-atomic)", async () => {
    const { repo, c2, n0, n1, pack } = await setup();
    const calls: string[] = [];
    const hooks: ReceivePackHooks = {
      update: (refName, oldOid, newOid) => {
        calls.push(`${refName} ${oldOid} ${newOid}`);
        return refName === "refs/heads/locked" ? "branch is locked" : undefined;
      },
    };
    const run = await runReceivePack(
      repo,
      {
        commands: [
          `${c2} ${n1} refs/heads/main`,
          `${ZERO} ${n0} refs/heads/locked`,
          `${ZERO} ${n1} refs/heads/other`,
        ],
        pack,
      },
      { hooks },
    );
    expect(run.report).toEqual([
      "unpack ok",
      "ok refs/heads/main",
      "ng refs/heads/locked hook declined",
      "ok refs/heads/other",
    ]);
    expect(run.messages).toContain("branch is locked");
    expect(run.messages).toContain("error: hook declined to update refs/heads/locked");
    expect(calls).toEqual([
      `refs/heads/main ${c2} ${n1}`,
      `refs/heads/locked ${ZERO} ${n0}`,
      `refs/heads/other ${ZERO} ${n1}`,
    ]);
    expect(await repo.refStore.get("refs/heads/locked")).toBeUndefined();
    expect(await repo.refStore.get("refs/heads/other")).toBe(n1);
  });

  it("the update hook refusing one ref of an atomic push refuses them all", async () => {
    const { repo, c2, n0, n1, pack } = await setup();
    const run = await runReceivePack(
      repo,
      {
        commands: [`${c2} ${n1} refs/heads/main`, `${ZERO} ${n0} refs/heads/locked`],
        caps: "report-status side-band-64k atomic",
        pack,
      },
      { hooks: { update: (refName) => refName !== "refs/heads/locked" } },
    );
    expect(run.report).toEqual([
      "unpack ok",
      "ng refs/heads/main atomic push failure",
      "ng refs/heads/locked hook declined",
    ]);
    expect(await repo.refStore.get("refs/heads/main")).toBe(c2);
  });

  it("pre-receive declines the push with a message for the user", async () => {
    const { repo, c2, n1, pack } = await setup();
    const run = await runReceivePack(
      repo,
      { commands: [`${c2} ${n1} refs/heads/main`], pack },
      { hooks: { preReceive: () => ({ ok: false, message: "line1\nline2" }) } },
    );
    expect(run.report).toEqual(["unpack ok", "ng refs/heads/main pre-receive hook declined"]);
    expect(run.messages).toContain("line1\nline2");
    expect(await repo.refStore.get("refs/heads/main")).toBe(c2);
  });

  it("post-receive runs after the report is written, and its failure stays on the server", async () => {
    const { repo, c2, n1, pack } = await setup();
    let reportDoneAt = 0;
    let hookAt = 0;
    let hookCommands: readonly ReceiveCommand[] = [];
    const errors: string[] = [];
    const run = await runReceivePack(
      repo,
      { commands: [`${c2} ${n1} refs/heads/main`], pack },
      {
        hooks: {
          postReceive: (commands) => {
            hookAt = performance.now();
            hookCommands = commands;
            throw new Error("notification service down");
          },
        },
        logger: { error: (message, error) => errors.push(`${message}: ${String(error)}`) },
      },
    );
    reportDoneAt = run.lastWriteAt;
    expect(run.result.success).toBe(true);
    expect(run.report).toEqual(["unpack ok", "ok refs/heads/main"]);
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(hookAt).toBeGreaterThanOrEqual(reportDoneAt);
    expect(hookCommands.map((c) => [c.refName, c.oldOid, c.newOid])).toEqual([
      ["refs/heads/main", c2, n1],
    ]);
    expect(errors[0]).toContain("notification service down");
  });

  it("keep-alive packets go out while a slow hook runs", async () => {
    const { repo, c2, n1, pack } = await setup();
    const run = await runReceivePack(
      repo,
      { commands: [`${c2} ${n1} refs/heads/main`], pack },
      {
        keepAliveMs: 20,
        hooks: { update: () => new Promise<undefined>((r) => setTimeout(() => r(undefined), 150)) },
      },
    );
    expect(run.report).toEqual(["unpack ok", "ok refs/heads/main"]);
    expect(run.keepAlives).toBeGreaterThan(1);
  });
});

/** A streamed request body that records how much was pulled. */
function trackedBody(bytes: Uint8Array, chunkSize = 64) {
  const log = { pulled: 0 };
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (log.pulled >= bytes.length) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.slice(log.pulled, log.pulled + chunkSize));
        log.pulled += chunkSize;
      },
    },
    { highWaterMark: 0 },
  );
  return { body, log };
}

function postReceive(
  handler: (request: Request) => Promise<Response>,
  body: ReadableStream<Uint8Array> | Uint8Array,
  headers: Record<string, string> = {},
) {
  return handler(
    new Request("http://localhost/repo.git/git-receive-pack", {
      method: "POST",
      headers: { "content-type": "application/x-git-receive-pack-request", ...headers },
      body,
      duplex: "half",
    } as RequestInit),
  );
}

describe("receive-pack hooks over smart HTTP (createFetchHandler)", () => {
  it("authorize refusing the push answers 403 before the pack is read", async () => {
    const { repo, c2, n1, pack } = await setup();
    const importSpy = spyImport(repo);
    const handler = createFetchHandler({
      resolveRepository: async () => ({ repository: repo.facade, refStore: repo.refStore }),
      receivePack: {
        hooks: {
          authorize: (_commands, ctx) =>
            ctx.request?.headers.authorization === "Bearer good" || "permission denied",
        },
      },
    });
    const commandsOnly = pushRequest({ commands: [`${c2} ${n1} refs/heads/main`] });
    const request = pushRequest({ commands: [`${c2} ${n1} refs/heads/main`], pack });
    const { body, log } = trackedBody(request, 64);
    const denied = await postReceive(handler, body, { authorization: "Bearer bad" });
    expect(denied.status).toBe(403);
    expect(await denied.text()).toBe("permission denied");
    // only the command section was pulled (whole chunks): not the pack
    expect(log.pulled).toBeLessThan(commandsOnly.length + 64);
    expect(log.pulled).toBeLessThan(request.length);
    expect(importSpy).not.toHaveBeenCalled();
    expect(await repo.refStore.get("refs/heads/main")).toBe(c2);

    const allowed = await postReceive(handler, request, { authorization: "Bearer good" });
    expect(allowed.status).toBe(200);
    const answer = decodeAnswer(new Uint8Array(await allowed.arrayBuffer()), true);
    expect(answer.report).toEqual(["unpack ok", "ok refs/heads/main"]);
  });

  it("the hooks get the repository path; update refusals are per ref", async () => {
    const { repo, c2, n0, n1, pack } = await setup();
    const paths: (string | undefined)[] = [];
    const handler = createFetchHandler({
      resolveRepository: async () => ({ repository: repo.facade, refStore: repo.refStore }),
      receivePack: {
        hooks: {
          update: (refName, _old, _new, ctx) => {
            paths.push(ctx.repoPath);
            return refName !== "refs/heads/locked";
          },
        },
      },
    });
    const response = await postReceive(
      handler,
      pushRequest({
        commands: [`${c2} ${n1} refs/heads/main`, `${ZERO} ${n0} refs/heads/locked`],
        pack,
      }),
    );
    const answer = decodeAnswer(new Uint8Array(await response.arrayBuffer()), true);
    expect(answer.report).toEqual([
      "unpack ok",
      "ok refs/heads/main",
      "ng refs/heads/locked hook declined",
    ]);
    expect(paths).toEqual(["/repo.git", "/repo.git"]);
  });

  it("post-receive starts once the client read the report", async () => {
    const { repo, c2, n1, pack } = await setup();
    let readDone = false;
    let readDoneWhenHookRan: boolean | undefined;
    const handler = createFetchHandler({
      resolveRepository: async () => ({ repository: repo.facade, refStore: repo.refStore }),
      receivePack: {
        hooks: {
          postReceive: () => {
            readDoneWhenHookRan = readDone;
          },
        },
      },
    });
    const response = await postReceive(
      handler,
      pushRequest({ commands: [`${c2} ${n1} refs/heads/main`], pack }),
    );
    // read slowly: the hook must not start before the report is out
    await new Promise((r) => setTimeout(r, 50));
    expect(readDoneWhenHookRan).toBeUndefined();
    const bytes = new Uint8Array(await response.arrayBuffer());
    readDone = true;
    expect(decodeAnswer(bytes, true).report).toEqual(["unpack ok", "ok refs/heads/main"]);
    await vi.waitFor(() => expect(readDoneWhenHookRan).toBe(true));
  });
});

describe("our duplex push client reads receive-pack's report", () => {
  it("pushOverDuplex gets each ref's verdict, keep-alives and side-band included", async () => {
    const { repo } = await serverRepo();
    const { client, commits } = await clientWithNewCommits(1);
    const n0 = commits[0] as string;
    await client.refStore.update("refs/heads/main", n0);
    await client.refStore.update("refs/heads/locked", n0);
    const channel = new MessageChannel();
    const serving = serveOverDuplex({
      duplex: createMessagePortDuplex(channel.port2),
      repository: repo.facade,
      refStore: repo.refStore,
      service: "git-receive-pack",
      keepAliveMs: 5,
      hooks: {
        update: async (refName) => {
          await new Promise((r) => setTimeout(r, 40));
          return refName !== "refs/heads/locked";
        },
      },
    });
    const result = await pushOverDuplex({
      duplex: createMessagePortDuplex(channel.port1),
      repository: client.facade,
      refStore: client.refStore,
      refspecs: ["refs/heads/main:refs/heads/main", "refs/heads/locked:refs/heads/locked"],
    });
    await serving;
    channel.port1.close();
    channel.port2.close();
    expect(result.success).toBe(false);
    expect(result.refStatus?.get("refs/heads/main")?.success).toBe(true);
    expect(result.refStatus?.get("refs/heads/locked")).toMatchObject({
      success: false,
      error: "hook declined",
    });
    expect(await repo.refStore.get("refs/heads/main")).toBe(n0);
  });
});

describe("receive-pack hook failures stay on the server", () => {
  it("authorize throwing over a duplex: every ref refused with a generic reason, the pack not imported", async () => {
    const { repo, c2, n1, pack } = await setup();
    const importSpy = spyImport(repo);
    const errors: unknown[] = [];
    const run = await runReceivePack(
      repo,
      { commands: [`${c2} ${n1} refs/heads/main`, `${ZERO} ${n1} refs/heads/x`], pack },
      {
        hooks: {
          authorize: () => {
            throw new Error("db password is hunter2");
          },
        },
        logger: { error: (_m, e) => errors.push(e) },
      },
    );
    expect(run.report).toEqual([
      "unpack ok",
      "ng refs/heads/main authorization failed",
      "ng refs/heads/x authorization failed",
    ]);
    expect(new TextDecoder().decode(run.bytes)).not.toContain("hunter2");
    expect(importSpy).not.toHaveBeenCalled();
    expect(String(errors[0])).toContain("hunter2");
  });

  it("authorize throwing over HTTP: a 500 without the exception text", async () => {
    const { repo, c2, n1, pack } = await setup();
    const errors: unknown[] = [];
    const handler = createFetchHandler({
      resolveRepository: async () => ({ repository: repo.facade, refStore: repo.refStore }),
      receivePack: {
        hooks: {
          authorize: () => {
            throw new Error("db password is hunter2");
          },
        },
      },
      logger: { info: () => {}, error: (_m, e) => errors.push(e) },
    });
    const response = await postReceive(
      handler,
      pushRequest({ commands: [`${c2} ${n1} refs/heads/main`], pack }),
    );
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).toBe("authorization failed");
    expect(errors.map(String).join(" ")).toContain("hunter2");
  });

  it("pre-receive and update hooks throwing: a generic 'hook error' to the client, details logged", async () => {
    const { repo, c2, n0, n1, pack } = await setup();
    const errors: unknown[] = [];
    let run = await runReceivePack(
      repo,
      { commands: [`${c2} ${n1} refs/heads/main`], pack },
      {
        hooks: {
          preReceive: () => {
            throw new Error("secret-pre");
          },
        },
        logger: { error: (_m, e) => errors.push(e) },
      },
    );
    expect(run.report).toEqual(["unpack ok", "ng refs/heads/main pre-receive hook declined"]);
    expect(run.messages).toContain("error: pre-receive hook error");
    expect(run.messages).not.toContain("secret-pre");

    run = await runReceivePack(
      repo,
      { commands: [`${c2} ${n1} refs/heads/main`, `${ZERO} ${n0} refs/heads/y`], pack },
      {
        hooks: {
          update: (refName) => {
            if (refName === "refs/heads/y") throw new Error("secret-update");
          },
        },
        logger: { error: (_m, e) => errors.push(e) },
      },
    );
    expect(run.report).toEqual([
      "unpack ok",
      "ok refs/heads/main",
      "ng refs/heads/y hook declined",
    ]);
    expect(run.messages).toContain("error: update hook error");
    expect(run.messages).not.toContain("secret-update");
    expect(errors.map(String).join(" ")).toContain("secret-pre");
    expect(errors.map(String).join(" ")).toContain("secret-update");
  });

  it("HTTP: a pack refused per ref after the head is drained, so the client reads its report", async () => {
    const { repo, c2, n1, pack } = await setup();
    const handler = createFetchHandler({
      resolveRepository: async () => ({ repository: repo.facade, refStore: repo.refStore }),
      receivePack: {
        hooks: {
          authorize: () => ({ ok: false, message: "no", rejectedRefs: ["refs/heads/main"] }),
        },
      },
    });
    const request = pushRequest({ commands: [`${c2} ${n1} refs/heads/main`], pack });
    const { body, log } = trackedBody(request, 64);
    const response = await postReceive(handler, body);
    const answer = decodeAnswer(new Uint8Array(await response.arrayBuffer()), true);
    expect(answer.report).toEqual(["unpack ok", "ng refs/heads/main no"]);
    expect(log.pulled).toBeGreaterThanOrEqual(request.length);
  });
});
