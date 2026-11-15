import { generateSigner, mintToken, RevocationRegistry } from "@statewalker/httpeers-access/issuer";
import { fetchOverDuplex } from "@statewalker/webrun-http-streams";
import { afterEach, describe, expect, it } from "vitest";
import {
  gitRules,
  type MeshAccessOptions,
  meshGitFetch,
  meshGitHandler,
  meshGitPush,
  peerFetch,
  servePeerConnection,
} from "../src/index.js";
import {
  commit,
  createHub,
  createRepo,
  type Hub,
  messagePortCaller,
  messagePortServe,
  type TestRepo,
} from "./helpers.js";

const URL_ = "http://peer-b.mesh/repo.git";
const repos: TestRepo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.close();
});
async function repo(): Promise<TestRepo> {
  const r = await createRepo();
  repos.push(r);
  return r;
}

/** Peer B serving `served`; `connect(peer)` is a connection whose transport proved `peer`. */
function serving(served: TestRepo, hub: Hub, access: Partial<MeshAccessOptions> = {}) {
  const handler = meshGitHandler({
    repository: served.facade,
    refStore: served.refStore,
    access: { issuer: hub.issuer, now: hub.now, ...access },
  });
  const connect = (peer: string | undefined) => servePeerConnection(handler, { remotePeer: peer });
  return { handler, connect };
}

/** B with a history main = c1 <- c2. */
async function servedWithHistory() {
  const served = await repo();
  const c1 = await commit(served, "c1", { "a.txt": "one\n" });
  const c2 = await commit(served, "c2", { "b.txt": "two\n" }, [c1]);
  await served.refStore.update("refs/heads/main", c2);
  return { served, c1, c2 };
}

/** A client clone of B's main as refs/heads/main, plus a new commit on top. */
async function cloneAndCommit(
  call: ReturnType<ReturnType<typeof serving>["connect"]>,
  token: string,
) {
  const local = await repo();
  await meshGitFetch({
    url: URL_,
    call,
    token,
    repository: local.facade,
    refStore: local.refStore,
  });
  const base = (await local.refStore.get("refs/heads/main")) as string;
  const tip = await commit(local, "local", { "c.txt": "three\n" }, [base]);
  await local.refStore.update("refs/heads/main", tip);
  return { local, tip };
}

const pushFrom = (
  local: TestRepo,
  call: ReturnType<ReturnType<typeof serving>["connect"]>,
  token: string,
  refspec: string,
) =>
  meshGitPush({
    url: URL_,
    call,
    token,
    refspecs: [refspec],
    repository: local.facade,
    refStore: local.refStore,
  });

const status = async (
  call: ReturnType<ReturnType<typeof serving>["connect"]>,
  service: string,
  token?: string,
) => {
  const fetchImpl = token ? peerFetch(call, token) : (r: Request) => fetchOverDuplex(call, r);
  const res = await fetchImpl(
    new Request(`${URL_}/info/refs?service=${service}`, {
      headers: { "git-protocol": "version=2" },
    }),
  );
  await res.body?.cancel();
  return res.status;
};

describe("git between two peers over a duplex", () => {
  it("fetches, fetches again incrementally, and pushes back (admin)", async () => {
    const hub = await createHub();
    const { served, c2 } = await servedWithHistory();
    const b = serving(served, hub);
    const call = b.connect("A");
    const token = await hub.token("A", ["admin"]);

    const { local, tip } = await cloneAndCommit(call, token);
    expect(await local.facade.has(c2)).toBe(true);

    // B moves on; A fetches only what is new
    const c3 = await commit(served, "c3", { "d.txt": "four\n" }, [c2]);
    await served.refStore.update("refs/heads/upstream", c3);
    const again = await meshGitFetch({
      url: URL_,
      call,
      token,
      repository: local.facade,
      refStore: local.refStore,
      refspecs: ["+refs/heads/upstream:refs/remotes/b/upstream"],
    });
    expect(again.refUpdates.map((u) => u.localRef)).toEqual(["refs/remotes/b/upstream"]);
    expect(await local.refStore.get("refs/remotes/b/upstream")).toBe(c3);

    const pushed = await pushFrom(local, call, token, "refs/heads/main:refs/heads/from-a");
    expect(pushed.ok).toBe(true);
    expect(await served.refStore.get("refs/heads/from-a")).toBe(tip);
    expect(await served.facade.has(tip)).toBe(true);
  });

  it("works the same across a MessageChannel", async () => {
    const hub = await createHub();
    const { served, c2 } = await servedWithHistory();
    const b = serving(served, hub);
    const channel = new MessageChannel();
    messagePortServe(channel.port2, b.connect("A"));
    const call = messagePortCaller(channel.port1);
    try {
      const token = await hub.token("A", ["admin"]);
      const { local, tip } = await cloneAndCommit(call, token);
      expect(await local.facade.has(c2)).toBe(true);
      const pushed = await pushFrom(local, call, token, "refs/heads/main:refs/heads/over-port");
      expect(pushed.ok).toBe(true);
      expect(await served.refStore.get("refs/heads/over-port")).toBe(tip);
    } finally {
      channel.port1.close();
      channel.port2.close();
    }
  });
});

describe("roles and per-ref authorization", () => {
  it("no token is 401; readers fetch but cannot push (403)", async () => {
    const hub = await createHub();
    const { served, c2 } = await servedWithHistory();
    const b = serving(served, hub);
    expect(await status(b.connect("anon"), "git-upload-pack")).toBe(401);

    const call = b.connect("R");
    const reader = await hub.token("R", ["member"]);
    const { local } = await cloneAndCommit(call, reader);
    expect(await local.facade.has(c2)).toBe(true);
    expect(await status(call, "git-receive-pack", reader)).toBe(403);
    await expect(
      pushFrom(local, call, reader, "refs/heads/main:refs/peers/R/main"),
    ).rejects.toThrow(/403/);
    const hidden = await hub.token("R", ["hidden"]);
    expect(await status(call, "git-upload-pack", hidden)).toBe(200);
    expect(await status(call, "git-receive-pack", hidden)).toBe(403);
    expect(await served.refStore.get("refs/peers/R/main")).toBeUndefined();
  });

  it("contributors push into refs/peers/<self>/* only (ng elsewhere); admins anywhere", async () => {
    const hub = await createHub();
    const { served, c2 } = await servedWithHistory();
    const b = serving(served, hub, { rules: gitRules({ contributors: true }) });
    const call = b.connect("M");
    const member = await hub.token("M", ["member"]);
    const { local, tip } = await cloneAndCommit(call, member);

    let r = await pushFrom(local, call, member, "refs/heads/main:refs/heads/main");
    expect(r.ok).toBe(false);
    expect(r.updates.find((u) => u.remoteRef === "refs/heads/main")?.status === "ok").toBe(false);
    expect(r.updates.find((u) => u.remoteRef === "refs/heads/main")?.message).toMatch(
      /not allowed/,
    );
    expect(await served.refStore.get("refs/heads/main")).toBe(c2);
    // a push refused for every ref stores nothing
    expect(await served.facade.has(tip)).toBe(false);

    r = await pushFrom(local, call, member, "refs/heads/main:refs/peers/X/main");
    expect(r.updates.find((u) => u.remoteRef === "refs/peers/X/main")?.message).toMatch(
      /not allowed/,
    );

    r = await pushFrom(local, call, member, "refs/heads/main:refs/peers/M/main");
    expect(r.ok).toBe(true);
    expect(await served.refStore.get("refs/peers/M/main")).toBe(tip);

    const adminCall = b.connect("T");
    r = await pushFrom(
      local,
      adminCall,
      await hub.token("T", ["admin"]),
      "refs/heads/main:refs/heads/main",
    );
    expect(r.ok).toBe(true);
    expect(await served.refStore.get("refs/heads/main")).toBe(tip);
  });

  it("a push mixing allowed and refused refs updates only the allowed ones", async () => {
    const hub = await createHub();
    const { served } = await servedWithHistory();
    const b = serving(served, hub, { rules: gitRules({ contributors: true }) });
    const call = b.connect("M");
    const member = await hub.token("M", ["member"]);
    const { local, tip } = await cloneAndCommit(call, member);
    const r = await meshGitPush({
      url: URL_,
      call,
      token: member,
      refspecs: ["refs/heads/main:refs/peers/M/a", "refs/heads/main:refs/heads/b"],
      repository: local.facade,
      refStore: local.refStore,
    });
    expect(r.updates.find((u) => u.remoteRef === "refs/peers/M/a")?.status === "ok").toBe(true);
    expect(r.updates.find((u) => u.remoteRef === "refs/heads/b")?.status === "ok").toBe(false);
    expect(await served.refStore.get("refs/peers/M/a")).toBe(tip);
    expect(await served.refStore.get("refs/heads/b")).toBeUndefined();
  });

  it("two members write their own namespaces, read each other's, never overwrite", async () => {
    const hub = await createHub();
    const { served } = await servedWithHistory();
    const b = serving(served, hub, { rules: gitRules({ contributors: true }) });
    const callA = b.connect("A");
    const callC = b.connect("C");
    const ta = await hub.token("A", ["member"]);
    const tc = await hub.token("C", ["member"]);
    const a = await cloneAndCommit(callA, ta);
    const c = await cloneAndCommit(callC, tc);
    expect((await pushFrom(a.local, callA, ta, "refs/heads/main:refs/peers/A/main")).ok).toBe(true);
    expect((await pushFrom(c.local, callC, tc, "refs/heads/main:refs/peers/C/main")).ok).toBe(true);
    await meshGitFetch({
      url: URL_,
      call: callA,
      token: ta,
      repository: a.local.facade,
      refStore: a.local.refStore,
      refspecs: ["+refs/peers/*:refs/remotes/peers/*"],
    });
    expect(await a.local.refStore.get("refs/remotes/peers/C/main")).toBe(c.tip);
    // A's own next commit: A and C committed alike (deterministic ids), and an equal value would
    // be "up to date", never sent
    const a2 = await commit(a.local, "a only", { "a.txt": "a\n" }, [a.tip]);
    await a.local.refStore.update("refs/heads/main", a2);
    const r = await pushFrom(a.local, callA, ta, "+refs/heads/main:refs/peers/C/main");
    expect(r.ok).toBe(false);
    expect(await served.refStore.get("refs/peers/C/main")).toBe(c.tip);
  });

  it("a proven peer id that cannot name a namespace is refused own-namespace pushes", async () => {
    const hub = await createHub();
    const { served } = await servedWithHistory();
    const b = serving(served, hub, { rules: gitRules({ contributors: true }) });
    const call = b.connect("A/B");
    const token = await hub.token("A/B", ["member"]);
    const { local } = await cloneAndCommit(call, token);
    await expect(
      pushFrom(local, call, token, "refs/heads/main:refs/peers/A/B/main"),
    ).rejects.toThrow(/403/);
  });
});

describe("hostile and stale tokens", () => {
  it("expired → 401, another peer's → 401, another mesh's → 403, tampered → 403, unknown role → 403", async () => {
    const hub = await createHub();
    const { served } = await servedWithHistory();
    const b = serving(served, hub);
    const call = b.connect("A");
    const ask = (token: string) => status(call, "git-upload-pack", token);

    const expired = await hub.token("A", ["admin"], 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(await ask(expired)).toBe(401);
    // a token for Z presented over a connection that proved A (peer binding)
    expect(await ask(await hub.token("Z", ["admin"]))).toBe(401);
    const other = await generateSigner();
    expect(
      await ask(await mintToken({ signer: other, sub: "A", roles: ["admin"], ttlMs: 60_000 })),
    ).toBe(403);
    const good = await hub.token("A", ["admin"]);
    const tampered = `${good.slice(0, -4)}${good.slice(-4) === "AAAA" ? "BBBB" : "AAAA"}`;
    expect(await ask(tampered)).toBe(403);
    expect(await ask(await hub.token("A", ["stranger"]))).toBe(403);
    expect(await ask(good)).toBe(200);
  });

  it("a peer header the caller sends is replaced by the proven peer", async () => {
    const hub = await createHub();
    const { served } = await servedWithHistory();
    const b = serving(served, hub);
    const call = b.connect("A");
    const tokenOfT = await hub.token("T", ["admin"]);
    const res = await peerFetch(
      call,
      tokenOfT,
    )(
      new Request(`${URL_}/info/refs?service=git-upload-pack`, {
        headers: { "x-httpeers-peer": "T" },
      }),
    );
    await res.body?.cancel();
    expect(res.status).toBe(401);
  });

  it("a revoked or downgraded member is refused with its old token; a fresh one has the new roles", async () => {
    const hub = await createHub();
    const registry = new RevocationRegistry({ maxTokenTtlMs: 60_000, now: hub.now });
    const { served } = await servedWithHistory();
    const b = serving(served, hub, { revocation: registry });
    const call = b.connect("A");
    const admin = await hub.token("A", ["admin"]);
    expect(await status(call, "git-receive-pack", admin)).toBe(200);

    registry.changeRoles("A", ["member"]);
    expect(await status(call, "git-receive-pack", admin)).toBe(403);
    expect(await status(call, "git-upload-pack", admin)).toBe(403);
    const member = await hub.token("A", ["member"]);
    expect(await status(call, "git-upload-pack", member)).toBe(200);
    expect(await status(call, "git-receive-pack", member)).toBe(403);

    registry.revoke("A");
    expect(await status(call, "git-upload-pack", member)).toBe(403);
  });
});

describe("meshGitHandler: objects no ref reaches", () => {
  const pkt = (s: string) => (s.length + 4).toString(16).padStart(4, "0") + s;

  /** A raw protocol v2 `fetch` of `oid`; returns the response body as text. */
  async function fetchById(
    call: ReturnType<ReturnType<typeof serving>["connect"]>,
    token: string,
    oid: string,
  ): Promise<string> {
    const res = await peerFetch(
      call,
      token,
    )(
      new Request(`${URL_}/git-upload-pack`, {
        method: "POST",
        headers: {
          "git-protocol": "version=2",
          "content-type": "application/x-git-upload-pack-request",
        },
        body: `${pkt("command=fetch\n")}0001${pkt(`want ${oid}\n`)}${pkt("done\n")}0000`,
      }),
    );
    return new TextDecoder("latin1").decode(await res.arrayBuffer());
  }

  it("refuses them by default (REACHABLE_COMMIT), unlike git's v2; requestPolicy ANY serves them", async () => {
    const hub = await createHub();
    const { served, c1 } = await servedWithHistory();
    const dangling = await commit(served, "dangling", { "x.txt": "secret\n" }, [c1]);
    const token = await hub.token("A", ["admin"]);

    const strict = serving(served, hub).connect("A");
    const refused = await fetchById(strict, token, dangling);
    expect(refused).toContain(`ERR upload-pack: not our ref ${dangling}`);
    expect(refused).not.toContain("packfile");
    // a commit a ref reaches is served
    expect(await fetchById(strict, token, c1)).toContain("packfile");

    const handler = meshGitHandler({
      repository: served.facade,
      refStore: served.refStore,
      access: { issuer: hub.issuer, now: hub.now },
      requestPolicy: "ANY",
    });
    const asGit = servePeerConnection(handler, { remotePeer: "A" });
    expect(await fetchById(asGit, token, dangling)).toContain("packfile");
  });
});
