/**
 * git:// over MessagePorts, no sockets: the git:// connector's `openSocket` and
 * `GitDaemon.serve` take a `MessagePort` as well as a `Duplex` (statewalker/webrun-vcs#452),
 * so a `MessageChannel`, a worker, a WebSocket bridge or a Node socket
 * (`socketMessagePort`) carry the same session. ls-remote, fetch and push run end to end
 * over a plain `MessageChannel`, both against `serveGitOverPort` (the port's far end serves
 * the session) and against `createGitDaemon().serve(port)` (the daemon takes the port the
 * host accepted); then half-close, a pack larger than any buffer, and failures on either end.
 */

import { describe, expect, it } from "vitest";
import {
  createGitDaemon,
  createGitDaemonConnector,
  type Duplex,
  fetchFromConnection,
  type GitConnectRequest,
  type GitTransportConnector,
  isDuplex,
  lsRefs,
  openReceivePack,
  openUploadPack,
  parseGitUrl,
  pushToConnection,
  type ServeGitConnectionResult,
  serveGitOverPort,
  serveOverPort,
} from "../src/index.js";
import { clientWithNewCommits, serverRepo } from "./helpers/receive-pack-harness.js";
import { commitInRepo, createTransportRepo, type TransportRepo } from "./interop/helpers.js";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function request(service: GitConnectRequest["service"], version: 0 | 1 | 2 = 2) {
  return { url: parseGitUrl("git://peer/repo.git"), service, protocolVersion: version };
}

const resolverOf = (repo: TransportRepo) => async (path: string) =>
  path === "/repo.git" ? { repository: repo.facade, refStore: repo.refStore } : undefined;

/** git:// whose `openSocket` gives a fresh `MessageChannel` port served by `serveGitOverPort`. */
function portConnector(repo: TransportRepo, opened: string[] = []): GitTransportConnector {
  return createGitDaemonConnector({
    openSocket: async (host, port) => {
      opened.push(`${host}:${port}`);
      const channel = new MessageChannel();
      serveGitOverPort(channel.port2, {
        resolveRepository: resolverOf(repo),
        enableReceivePack: true,
      });
      return channel.port1;
    },
  });
}

/**
 * git:// whose `openSocket` hands the daemon one end of a `MessageChannel` (as a host hands it
 * an accepted socket's port) and the client the other end's stream (`serveOverPort`: the
 * far end serves the stream, as `socketMessagePort` does for a socket).
 */
function daemonConnector(
  repo: TransportRepo,
  results: Promise<ServeGitConnectionResult>[] = [],
): GitTransportConnector {
  const daemon = createGitDaemon({ resolveRepository: resolverOf(repo), enableReceivePack: true });
  return createGitDaemonConnector({
    openSocket: (_host, _port) =>
      new Promise<Duplex>((resolve) => {
        const channel = new MessageChannel();
        results.push(daemon.serve(channel.port2, { remoteAddress: "10.0.0.1", remotePort: "1" }));
        serveOverPort(
          channel.port1,
          (duplex) =>
            new Promise<void>((done) => {
              resolve({
                ...duplex,
                close: async () => {
                  await duplex.close?.();
                  done();
                },
              });
            }),
        );
      }),
  });
}

for (const [name, connectorOf] of [
  ["serveGitOverPort", (repo: TransportRepo) => portConnector(repo)],
  ["GitDaemon.serve(port)", (repo: TransportRepo) => daemonConnector(repo)],
] as const) {
  describe(`git:// over a MessageChannel (${name})`, () => {
    it("ls-remote, fetch and push", async () => {
      const { repo, c2 } = await serverRepo();
      const git = connectorOf(repo);

      // ls-remote (v2 ls-refs)
      const ls = await openUploadPack(
        await git.connect(request("git-upload-pack")),
        request("git-upload-pack"),
      );
      const refs = await lsRefs(ls, ["refs/heads/"]);
      expect(refs.map((r) => [r.name, r.oid])).toEqual([["refs/heads/main", c2]]);
      await ls.close();

      // fetch, v0 and v2
      for (const version of [0, 2] as const) {
        const local = await createTransportRepo();
        const connection = await openUploadPack(
          await git.connect(request("git-upload-pack", version)),
          request("git-upload-pack", version),
        );
        const _fetched = await fetchFromConnection(connection, {
          repository: local.facade,
          refStore: local.refStore,
          refspecs: ["+refs/heads/*:refs/remotes/origin/*"],
        });
        await connection.close();
        expect(await local.refStore.get("refs/remotes/origin/main")).toBe(c2);
      }

      // push
      const { client, commits } = await clientWithNewCommits(2);
      await client.refStore.update("refs/heads/main", commits[1] as string);
      const receive = await openReceivePack(
        await git.connect(request("git-receive-pack")),
        request("git-receive-pack"),
      );
      const pushed = await pushToConnection(receive, {
        repository: client.facade,
        refStore: client.refStore,
        refspecs: ["refs/heads/main:refs/heads/main"],
      });
      await receive.close();
      expect(pushed.updates.map((u) => u.status)).toEqual(["ok"]);
      expect(await repo.refStore.get("refs/heads/main")).toBe(commits[1]);
    });

    it("moves a pack larger than the stream's buffers (backpressure both ways)", async () => {
      const repo = await createTransportRepo();
      // pseudo-random text barely compresses: several MiB on the wire
      let seed = 1;
      const big = Array.from({ length: 6 << 20 }, () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return String.fromCharCode(33 + (seed % 90));
      }).join("");
      const tip = await commitInRepo(repo, "big", { "big.txt": big });
      await repo.refStore.update("refs/heads/main", tip);
      const git = connectorOf(repo);

      const local = await createTransportRepo();
      const connection = await openUploadPack(
        await git.connect(request("git-upload-pack")),
        request("git-upload-pack"),
      );
      const _fetched = await fetchFromConnection(connection, {
        repository: local.facade,
        refStore: local.refStore,
        refspecs: ["+refs/heads/main:refs/heads/main"],
      });
      await connection.close();
      expect(await local.refStore.get("refs/heads/main")).toBe(tip);

      // and back: the pack goes the other way in a push to an empty repository
      const empty = await createTransportRepo();
      const back = connectorOf(empty);
      const receive = await openReceivePack(
        await back.connect(request("git-receive-pack")),
        request("git-receive-pack"),
      );
      const pushed = await pushToConnection(receive, {
        repository: local.facade,
        refStore: local.refStore,
        refspecs: ["refs/heads/main:refs/heads/main"],
      });
      await receive.close();
      expect(pushed.updates.map((u) => u.status)).toEqual(["ok"]);
      expect(await empty.refStore.get("refs/heads/main")).toBe(tip);
    }, 60000);
  });
}

describe("git:// over MessagePorts: failures", () => {
  it("openSocket failing fails the connection", async () => {
    const git = createGitDaemonConnector({
      openSocket: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:9418");
      },
    });
    await expect(git.connect(request("git-upload-pack"))).rejects.toThrow(/ECONNREFUSED/);
  });

  it("the far end closing its port mid-session fails the client instead of hanging", async () => {
    const { repo } = await serverRepo();
    const git = createGitDaemonConnector({
      openSocket: async () => {
        const channel = new MessageChannel();
        // read the request line, then go away (a socket reset, a worker terminated)
        channel.port2.addEventListener("message", () => channel.port2.close(), { once: true });
        channel.port2.start();
        return channel.port1;
      },
    });
    await expect(
      openUploadPack(await git.connect(request("git-upload-pack")), request("git-upload-pack")),
    ).rejects.toThrow();
    expect(repo).toBeDefined();
  });

  it("the client closing its port ends the daemon's session", async () => {
    const { repo } = await serverRepo();
    const daemon = createGitDaemon({ resolveRepository: resolverOf(repo) });
    const channel = new MessageChannel();
    const served = daemon.serve(channel.port2);
    expect(daemon.liveConnections).toBe(1);
    channel.port1.close();
    const result = await served;
    expect(result.success).toBe(false);
    expect(daemon.liveConnections).toBe(0);
  });

  it("isDuplex tells a Duplex from a port", async () => {
    const channel = new MessageChannel();
    expect(isDuplex(channel.port1)).toBe(false);
    const opened: string[] = [];
    const git = portConnector(await createTransportRepo(), opened);
    const session = await git.connect({
      ...request("git-upload-pack"),
      url: parseGitUrl("git://h:7/r"),
    });
    expect(session.kind === "native" && isDuplex(session.duplex)).toBe(true);
    expect(opened).toEqual(["h:7"]);
    if (session.kind === "native") await session.duplex.close?.();
    channel.port1.close();
    await tick();
  });
});
