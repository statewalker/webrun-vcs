/**
 * The httpeers connectors through vcs-commands: clone, ls-remote, fetch and push of a peer's
 * repository by `httpeers://<peer>/<repo>` (smart HTTP over a peer connection, served by
 * `meshGitHandler`) and `httpeers+git://<peer>/<repo>` (git's native protocol over a duplex
 * stream, served by `meshGitDuplexHandler`), with the mesh's authorization on both.
 */

import { Git } from "@statewalker/vcs-commands";
import { createDefaultTransports, type GitTransportRegistry } from "@statewalker/vcs-transport";
import { afterEach, describe, expect, it } from "vitest";
import {
  createHttpeersConnector,
  gitRules,
  HTTPEERS_GIT_DUPLEX_PATH,
  type MeshDuplexHandler,
  meshGitDuplexHandler,
  meshGitHandler,
  servePeerConnection,
  type WebrunDuplex,
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

const repos: TestRepo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.close();
});

/** Peer B's repository: main = c1 <- c2. */
async function served() {
  const repo = await createRepo();
  repos.push(repo);
  const c1 = await commit(repo, "c1", { "a.txt": "one\n" });
  const c2 = await commit(repo, "c2", { "b.txt": "two\n" }, [c1]);
  await repo.refStore.update("refs/heads/main", c2);
  await repo.history.refs.setSymbolic("HEAD", "refs/heads/main");
  return { repo, c1, c2 };
}

/** An empty in-memory repository with a worktree, its remote commands on `transports`. */
async function client(transports: GitTransportRegistry) {
  const { workingCopy } = await Git.init().setDirectory("work").setWorktree(true).call();
  return { git: Git.fromWorkingCopy(workingCopy, { transports }), workingCopy };
}

const access = (hub: Hub) => ({
  issuer: hub.issuer,
  now: hub.now,
  rules: gitRules({ contributors: true }),
});

/** Smart HTTP: peer A's connector reaches B's `meshGitHandler` over a MessageChannel. */
function httpTransports(repo: TestRepo, hub: Hub, token: string | undefined) {
  const handler = meshGitHandler({
    repository: repo.facade,
    refStore: repo.refStore,
    access: access(hub),
  });
  const transports = createDefaultTransports();
  const peers: string[] = [];
  transports.register(
    createHttpeersConnector({
      token: token ?? "",
      call: (peer) => {
        peers.push(peer);
        const { port1, port2 } = new MessageChannel();
        // B's side of the connection: the transport proved the caller is peer-a
        messagePortServe(port2, servePeerConnection(handler, { remotePeer: "peer-a" }));
        return messagePortCaller(port1);
      },
    }),
  );
  return { transports, peers };
}

/** Native: the connector opens a stream on B's duplex mount (as httpeers-libp2p's `openDuplex`). */
function nativeTransports(
  repo: TestRepo,
  hub: Hub,
  token: string | undefined,
  enableReceivePack = true,
) {
  const handler: MeshDuplexHandler = meshGitDuplexHandler({
    access: access(hub),
    enableReceivePack,
    resolveRepository: async (path) =>
      path === "/repo.git" ? { repository: repo.facade, refStore: repo.refStore } : undefined,
  });
  const opened: string[] = [];
  let closed = 0;
  const transports = createDefaultTransports();
  transports.register(
    createHttpeersConnector({
      mode: "native",
      ...(token !== undefined ? { token } : {}),
      openStream: ({ peer, path, token: frameToken }) => {
        opened.push(`${peer} ${path}`);
        const call: WebrunDuplex = async function* (input) {
          yield* handler(input as AsyncIterable<Uint8Array>, {
            peerId: "peer-a",
            path,
            ...(frameToken !== undefined ? { token: frameToken } : {}),
          });
        };
        return {
          call,
          close: async () => {
            closed++;
          },
        };
      },
    }),
  );
  return { transports, opened, closes: () => closed };
}

describe("createHttpeersConnector (smart HTTP over the mesh)", () => {
  it("ls-remote, clone, fetch and push through vcs-commands", async () => {
    const hub = await createHub();
    const { repo, c2 } = await served();
    const token = await hub.token("peer-a", ["member"]);
    const { transports, peers } = httpTransports(repo, hub, token);
    const { git, workingCopy } = await client(transports);
    const url = "httpeers://Peer-B/repo.git";

    const listed = await git.lsRemote().setRemote(url).call();
    expect(listed.refs.find((r) => r.name === "refs/heads/main")?.objectId).toBe(c2);
    expect(peers[0]).toBe("Peer-B");

    await git.clone().setURI(url).call();
    expect((await workingCopy.history.refs.resolve("refs/heads/main"))?.objectId).toBe(c2);
    const listedFiles: string[] = [];
    for await (const entry of workingCopy.worktree.walk()) listedFiles.push(entry.path);
    // the commit helper writes a tree of the given files only: c2 holds b.txt
    expect(listedFiles).toEqual(["b.txt"]);

    const c3 = await commit(repo, "c3", { "c.txt": "three\n" }, [c2]);
    await repo.refStore.update("refs/heads/main", c3);
    await git.fetch().setRemote("origin").call();
    expect((await workingCopy.history.refs.resolve("refs/remotes/origin/main"))?.objectId).toBe(c3);

    const own = await git
      .push()
      .setRemote("origin")
      .setRefSpecs("main:refs/peers/peer-a/main")
      .call();
    expect(own.remoteUpdates.map((u) => [u.remoteName, u.status])).toEqual([
      ["refs/peers/peer-a/main", "ok"],
    ]);
    expect(await repo.refStore.get("refs/peers/peer-a/main")).toBe(c2);

    const other = await git
      .push()
      .setRemote("origin")
      .setRefSpecs("main:refs/heads/elsewhere")
      .call();
    expect(other.remoteUpdates[0]?.status).not.toBe("ok");
    expect(other.remoteUpdates[0]?.message).toContain("not allowed");
    expect(await repo.refStore.get("refs/heads/elsewhere")).toBeUndefined();
  });

  it("a token minted for another peer is refused", async () => {
    const hub = await createHub();
    const { repo } = await served();
    const { transports } = httpTransports(repo, hub, await hub.token("peer-z", ["member"]));
    const { git } = await client(transports);
    await expect(git.lsRemote().setRemote("httpeers://peer-b/repo.git").call()).rejects.toThrow(
      /Authentication failed/,
    );
  });

  it("a fetchImpl reaching peers by URL, without a token of its own", async () => {
    const hub = await createHub();
    const { repo, c2 } = await served();
    const token = await hub.token("peer-a", ["member"]);
    const handler = meshGitHandler({
      repository: repo.facade,
      refStore: repo.refStore,
      access: access(hub),
    });
    const edge = servePeerConnection(handler, { remotePeer: "peer-a" });
    const urls: string[] = [];
    const transports = createDefaultTransports();
    const { fetchOverDuplex } = await import("@statewalker/webrun-http-streams");
    transports.register(
      createHttpeersConnector({
        peerUrl: (peer) => `http://local/key/${peer}`,
        // a member's edge adds the token itself
        fetchImpl: async (request) => {
          urls.push(new URL(request.url).pathname);
          const headers = new Headers(request.headers);
          headers.set("x-httpeers-token", token);
          return fetchOverDuplex(
            edge,
            new Request(request, { headers, duplex: "half" } as RequestInit),
          );
        },
      }),
    );
    const { git } = await client(transports);
    const listed = await git.lsRemote().setRemote("httpeers://peer-b/repo.git").call();
    expect(listed.refs.find((r) => r.name === "refs/heads/main")?.objectId).toBe(c2);
    expect(urls[0]).toBe("/key/peer-b/repo.git/info/refs");
  });

  it("checks its options and URLs", async () => {
    expect(() => createHttpeersConnector({})).toThrow(/call or fetchImpl/);
    expect(() =>
      createHttpeersConnector({ call: () => (async function* () {})() as never }),
    ).toThrow(/token/);
    expect(() => createHttpeersConnector({ mode: "native" })).toThrow(/openStream/);
    const hub = await createHub();
    const { repo } = await served();
    const { transports } = httpTransports(repo, hub, "t");
    const { git } = await client(transports);
    await expect(git.lsRemote().setRemote("httpeers://peer-b").call()).rejects.toThrow(/no path/);
  });
});

describe("createHttpeersConnector (native protocol over an httpeers stream)", () => {
  it("ls-remote, clone, fetch and push through vcs-commands", async () => {
    const hub = await createHub();
    const { repo, c2 } = await served();
    const token = await hub.token("peer-a", ["member"]);
    const { transports, opened, closes } = nativeTransports(repo, hub, token);
    const { git, workingCopy } = await client(transports);
    const url = "httpeers+git://peer-b/repo.git";

    const listed = await git.lsRemote().setRemote(url).call();
    expect(listed.refs.find((r) => r.name === "refs/heads/main")?.objectId).toBe(c2);
    expect(opened[0]).toBe(`peer-b ${HTTPEERS_GIT_DUPLEX_PATH}`);

    await git.clone().setURI(url).call();
    expect((await workingCopy.history.refs.resolve("refs/heads/main"))?.objectId).toBe(c2);

    const c3 = await commit(repo, "c3", { "c.txt": "three\n" }, [c2]);
    await repo.refStore.update("refs/heads/main", c3);
    await git.fetch().setRemote("origin").call();
    expect((await workingCopy.history.refs.resolve("refs/remotes/origin/main"))?.objectId).toBe(c3);

    const own = await git
      .push()
      .setRemote("origin")
      .setRefSpecs("main:refs/peers/peer-a/main")
      .call();
    expect(own.remoteUpdates.map((u) => [u.remoteName, u.status])).toEqual([
      ["refs/peers/peer-a/main", "ok"],
    ]);
    expect(await repo.refStore.get("refs/peers/peer-a/main")).toBe(c2);

    const other = await git
      .push()
      .setRemote("origin")
      .setRefSpecs("main:refs/heads/elsewhere")
      .call();
    expect(other.remoteUpdates[0]?.status).not.toBe("ok");
    expect(other.remoteUpdates[0]?.message).toContain("not allowed");
    expect(await repo.refStore.get("refs/heads/elsewhere")).toBeUndefined();
    // every stream was released once its session closed
    expect(closes()).toBe(opened.length);
  });

  it("refuses a missing token with git's ERR packet", async () => {
    const hub = await createHub();
    const { repo } = await served();
    const { transports } = nativeTransports(repo, hub, undefined);
    const { git } = await client(transports);
    await expect(git.lsRemote().setRemote("httpeers+git://peer-b/repo.git").call()).rejects.toThrow(
      /access denied/,
    );
  });

  it("serves no push without enableReceivePack, and nothing without git:read", async () => {
    const hub = await createHub();
    const { repo } = await served();
    const admin = await hub.token("peer-a", ["admin"]);
    const { transports } = nativeTransports(repo, hub, admin, false);
    const { git } = await client(transports);
    await git.clone().setURI("httpeers+git://peer-b/repo.git").call();
    await expect(
      git.push().setRemote("origin").setRefSpecs("main:refs/heads/x").call(),
    ).rejects.toThrow();
    expect(await repo.refStore.get("refs/heads/x")).toBeUndefined();

    const stranger = await hub.token("peer-a", ["guest"]);
    const refused = nativeTransports(repo, hub, stranger);
    const other = await client(refused.transports);
    await expect(
      other.git.lsRemote().setRemote("httpeers+git://peer-b/repo.git").call(),
    ).rejects.toThrow(/access denied/);
  });
});

/** Native transports whose handler takes `extra` options, its streams proven as `peerId`. */
function nativeWith(
  repo: TestRepo,
  hub: Hub,
  token: string,
  extra: Partial<Parameters<typeof meshGitDuplexHandler>[0]>,
  peerId = "peer-a",
) {
  const handler = meshGitDuplexHandler({
    access: access(hub),
    resolveRepository: async (path) =>
      path === "/repo.git" ? { repository: repo.facade, refStore: repo.refStore } : undefined,
    ...extra,
  });
  const transports = createDefaultTransports();
  transports.register(
    createHttpeersConnector({
      mode: "native",
      token,
      openStream: ({ path, token: frameToken }) =>
        async function* (input) {
          yield* handler(input as AsyncIterable<Uint8Array>, {
            peerId,
            path,
            ...(frameToken !== undefined ? { token: frameToken } : {}),
          });
        },
    }),
  );
  return transports;
}

describe("review of the httpeers connectors (PR #181)", () => {
  it("meshGitDuplexHandler: an access.provenPeer cannot replace the stream's proven peer", async () => {
    const hub = await createHub();
    const { repo } = await served();
    // peer-a's stream presents peer-z's admin token; a provenPeer slipped into access claims peer-z
    const stolen = await hub.token("peer-z", ["admin"]);
    const transports = nativeWith(repo, hub, stolen, {
      access: { ...access(hub), provenPeer: () => "peer-z" } as ReturnType<typeof access>,
    });
    const { git } = await client(transports);
    await expect(git.lsRemote().setRemote("httpeers+git://peer-b/repo.git").call()).rejects.toThrow(
      /access denied/,
    );
  });

  it("refuses peers that are not peer ids, user@ and :port; a fetchImpl needs peerUrl", async () => {
    expect(() => createHttpeersConnector({ fetchImpl: async () => new Response() })).toThrow(
      /peerUrl/,
    );
    const hub = await createHub();
    const { repo } = await served();
    const { transports } = httpTransports(repo, hub, "t");
    const { git } = await client(transports);
    for (const [url, error] of [
      ["httpeers://user@peer-b/repo.git", /user or a port/],
      ["httpeers://peer-b:8080/repo.git", /user or a port/],
      ["httpeers://a%40b/repo.git", /not a peer id/],
      ["httpeers://peer.b/repo.git", /not a peer id/],
    ] as const) {
      await expect(git.lsRemote().setRemote(url).call()).rejects.toThrow(error);
    }
  });

  it("keeps a peer id's case and pins the token to the peer's base URL behind a shared edge", async () => {
    const hub = await createHub();
    const { repo, c2 } = await served();
    const token = await hub.token("peer-a", ["member"]);
    const handler = meshGitHandler({
      repository: repo.facade,
      refStore: repo.refStore,
      access: access(hub),
    });
    const edge = servePeerConnection(handler, { remotePeer: "peer-a" });
    const { fetchOverDuplex } = await import("@statewalker/webrun-http-streams");
    const seen: Array<[string, string | null]> = [];
    const transports = createDefaultTransports();
    transports.register(
      createHttpeersConnector({
        token,
        peerUrl: (peer) => `http://local/key/${peer}`,
        fetchImpl: async (request) => {
          const url = new URL(request.url);
          seen.push([url.pathname, request.headers.get("x-httpeers-token")]);
          // the edge sends every request of 12D3KooWRedirect to another peer behind it
          if (url.pathname.startsWith("/key/12D3KooWRedirect/"))
            return new Response(null, {
              status: 302,
              headers: { location: url.pathname.replace("12D3KooWRedirect", "12D3KooWOther") },
            });
          return fetchOverDuplex(edge, new Request(request, { duplex: "half" } as RequestInit));
        },
      }),
    );
    const { git } = await client(transports);
    const listed = await git.lsRemote().setRemote("httpeers://12D3KooWMixedCase/repo.git").call();
    expect(listed.refs.find((r) => r.name === "refs/heads/main")?.objectId).toBe(c2);
    expect(seen[0]).toEqual(["/key/12D3KooWMixedCase/repo.git/info/refs", token]);

    seen.length = 0;
    await expect(
      git.lsRemote().setRemote("httpeers://12D3KooWRedirect/repo.git").call(),
    ).rejects.toThrow();
    expect(seen.map(([path]) => path)).toEqual(["/key/12D3KooWRedirect/repo.git/info/refs"]);
  });

  it("guard wraps each authorized stream: guardStream ends a revoked member's, a newer token re-admits it", async () => {
    const { createRevocations, guardStream } = await import("@statewalker/httpeers-access");
    const hub = await createHub();
    const { repo, c2 } = await served();
    const revocations = createRevocations(hub.now);
    const callers: Array<number | undefined> = [];
    const extra = {
      guard: (
        serve: (input: AsyncIterable<Uint8Array>) => AsyncIterable<Uint8Array>,
        caller: { issuedAt?: number },
        context: { peerId: string },
      ) => {
        callers.push(caller.issuedAt);
        return guardStream(serve, {
          peerId: context.peerId,
          revocations,
          ...(caller.issuedAt !== undefined
            ? { claims: { sub: context.peerId, issuedAt: caller.issuedAt } }
            : {}),
        });
      },
    };
    const old = await hub.token("peer-a", ["member"]);
    revocations.revoke("peer-a");
    const refused = await client(nativeWith(repo, hub, old, extra));
    await expect(
      refused.git.lsRemote().setRemote("httpeers+git://peer-b/repo.git").call(),
    ).rejects.toThrow();

    const fresh = await hub.token("peer-a", ["member"]);
    const admitted = await client(nativeWith(repo, hub, fresh, extra));
    const listed = await admitted.git.lsRemote().setRemote("httpeers+git://peer-b/repo.git").call();
    expect(listed.refs.find((r) => r.name === "refs/heads/main")?.objectId).toBe(c2);
    expect(callers.every((at) => typeof at === "number")).toBe(true);
  });
});
