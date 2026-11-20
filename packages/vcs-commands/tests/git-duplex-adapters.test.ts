/**
 * The duplex adapters' conformance matrix: git's native protocol over an in-memory duplex
 * pair, a MessageChannel (one session per channel, and many over one through webrun-rpc's
 * multiplexer), a WebSocket (the `ws` package's server, Node's global WebSocket as the
 * client) and an in-memory libp2p-shaped stream. Each runs the same scenarios with our
 * `serveGitConnection` behind the adapter and our porcelain as the client, native git doing the
 * same against the local repository the oracle. Native git also reaches the WebSocket server
 * through an `ext::` bridge, and a large pack crosses the MessagePort and WebSocket adapters
 * with the bytes in flight bounded.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  connectGitOverPortMux,
  createBasePathResolver,
  createDuplexConnector,
  createLibp2pConnector,
  createMessagePortConnector,
  createWebrunConnector,
  createWebSocketConnector,
  DEFAULT_WEBSOCKET_MAX_FRAME_SIZE,
  GIT_LIBP2P_PROTOCOL,
  type GitTransportConnector,
  GitTransportRegistry,
  messagePortDuplex,
  type ServeGitConnectionOptions,
  serveGitConnection,
  serveGitOverLibp2pStream,
  serveGitOverPort,
  serveGitOverPortMux,
  serveGitOverWebSocket,
  type WebSocketLike,
  webrunServerDuplex,
  webSocketDuplex,
} from "@statewalker/vcs-transport";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
  createNodeHookRunner,
} from "@statewalker/vcs-utils-node/files";
import { serveDuplexOverPort } from "@statewalker/webrun-rpc";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer, WebSocket as WsWebSocket } from "ws";

import { openLocalRemote, remoteHookSession } from "../src/commands/local-transport.js";
import { type Git, servedRepositoryOf } from "../src/index.js";
import {
  bytesInFlightMeter,
  duplexPair,
  libp2pStreamPair,
  writeWebSocketBridge,
} from "./duplex-adapters-support.js";
import { openOurs } from "./merge-native-helpers.js";
import { gitAsync } from "./native-connect-support.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { gitOut, gitRun, putFile, testEnv } from "./status-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root: string;
let srv: string;
let counter = 0;
let host: Git;
const git = (cwd: string, ...args: string[]) => gitOut(root, cwd, args);

function environment() {
  const env = testEnv(root);
  return createNodeGitHostEnvironment({ env, hookRunner: createNodeHookRunner({ env }) });
}

async function ours(name: string): Promise<Git> {
  return openOurs(root, environment(), undefined, name);
}

/** An empty repository for our side of a twin. */
function emptyRepo(): string {
  const name = `o${counter++}`;
  mkdirSync(join(root, name));
  git(join(root, name), "init", "-q", "-b", "main");
  return name;
}

/** Two bare repositories below the served directory, seeded from `src`, for pushes. */
function bareTwins(config: Record<string, string> = {}): [string, string] {
  const names: [string, string] = [`dn${counter}.git`, `do${counter}.git`];
  counter++;
  for (const name of names) {
    git(srv, "init", "-q", "--bare", "-b", "main", name);
    git(join(srv, name), "config", "receive.advertisePushOptions", "true");
    for (const [key, value] of Object.entries(config)) git(join(srv, name), "config", key, value);
    git(join(srv, "src"), "push", "-q", join(srv, name), "main", "feat", "v1");
  }
  return names;
}

const refs = (dir: string) =>
  git(dir, "for-each-ref", "--format=%(refname) %(objectname) %(symref)");

const lsRemoteLines = (out: string) =>
  out
    .split("\n")
    .filter((l) => l && !l.startsWith("HEAD\t") && !l.endsWith("\tHEAD"))
    .map((l) => l.split("\t").reverse().join(" "));

/** What every adapter's server runs: git-daemon's side over the repositories below `srv`. */
function serveOptions(): Omit<ServeGitConnectionOptions, "duplex"> {
  return {
    enableReceivePack: true,
    resolveRepository: createBasePathResolver({
      files: createNodeFilesApi({ rootDir: root }),
      basePath: "/srv",
      exportAll: true,
      openRepository: async (gitDir) => {
        const opened = await openLocalRemote(host.workingCopy, `..${gitDir}`).catch(
          () => undefined,
        );
        if (!opened) return undefined;
        const hooks = remoteHookSession(host.workingCopy, opened);
        return servedRepositoryOf(opened, hooks ? { hooks } : {});
      },
    }),
  };
}

/** One adapter under test: the connector our client uses, the URL of a served path. */
interface AdapterSetup {
  connector: GitTransportConnector;
  url(path: string): string;
  close(): Promise<void>;
}

interface Adapter {
  name: string;
  setup(): Promise<AdapterSetup>;
}

const ADAPTERS: Adapter[] = [
  {
    name: "in-memory duplex pair",
    async setup() {
      return {
        connector: createDuplexConnector({
          name: "mem",
          schemes: ["mem"],
          open: async () => {
            const [client, server] = duplexPair();
            void serveGitConnection({ ...serveOptions(), duplex: server });
            return client;
          },
        }),
        url: (path) => `mem://local/${path}`,
        close: async () => {},
      };
    },
  },
  {
    name: "MessageChannel (a channel per session)",
    async setup() {
      return {
        connector: createMessagePortConnector({
          name: "port",
          schemes: ["port"],
          openPort: () => {
            const channel = new MessageChannel();
            serveGitOverPort(channel.port2, serveOptions());
            return channel.port1;
          },
        }),
        url: (path) => `port://worker/${path}`,
        close: async () => {},
      };
    },
  },
  {
    name: "MessageChannel (sessions multiplexed over one port)",
    async setup() {
      const channel = new MessageChannel();
      const stop = await serveGitOverPortMux(channel.port2, serveOptions());
      const peer = await connectGitOverPortMux(channel.port1);
      return {
        connector: createWebrunConnector({ name: "mux", schemes: ["mux"], call: () => peer.call }),
        url: (path) => `mux://worker/${path}`,
        close: async () => {
          await peer.close();
          await stop();
          channel.port1.close();
        },
      };
    },
  },
  {
    name: "WebSocket (ws server, global WebSocket client)",
    async setup() {
      const server = new WebSocketServer({
        host: "127.0.0.1",
        port: 0,
        maxPayload: DEFAULT_WEBSOCKET_MAX_FRAME_SIZE,
      });
      server.on("connection", (socket) => {
        void serveGitOverWebSocket(socket as unknown as WebSocketLike, serveOptions());
      });
      await new Promise<void>((resolve) => server.once("listening", () => resolve()));
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      return {
        connector: createWebSocketConnector(),
        url: (path) => `ws://127.0.0.1:${port}/${path}`,
        close: async () => {
          for (const client of server.clients) client.terminate();
          await new Promise<void>((resolve) => server.close(() => resolve()));
        },
      };
    },
  },
  {
    name: "libp2p-shaped stream",
    async setup() {
      const dialed: string[] = [];
      return {
        connector: createLibp2pConnector({
          dial: async (peer, protocol) => {
            dialed.push(`${peer} ${protocol}`);
            expect(protocol).toBe(GIT_LIBP2P_PROTOCOL);
            const [client, server] = libp2pStreamPair();
            void serveGitOverLibp2pStream(server, serveOptions());
            return client;
          },
        }),
        url: (path) => `libp2p://12D3KooWPeer/${path}`,
        close: async () => {
          expect(dialed.every((d) => d === `12D3KooWPeer ${GIT_LIBP2P_PROTOCOL}`)).toBe(true);
        },
      };
    },
  },
];

describeGit("git's native protocol over the duplex adapters", () => {
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "duplex-adapters-"));
    srv = join(root, "srv");
    mkdirSync(srv);
    const src = join(srv, "src");
    mkdirSync(src);
    git(src, "init", "-q", "-b", "main");
    for (const n of [1, 2, 3]) {
      putFile(src, "a.txt", `a${n}\n`);
      git(src, "add", "a.txt");
      git(src, "commit", "-qm", `c${n}`);
      if (n === 2) git(src, "tag", "-a", "-m", "v1", "v1");
    }
    git(src, "checkout", "-q", "-b", "feat");
    putFile(src, "b.txt", "b\n");
    git(src, "add", "b.txt");
    git(src, "commit", "-qm", "feat");
    git(src, "checkout", "-q", "main");
    // a repository with hidden refs
    git(srv, "clone", "-q", "--bare", "src", "hid.git");
    git(join(srv, "hid.git"), "update-ref", "refs/hidden/x", "main");
    git(join(srv, "hid.git"), "config", "uploadpack.hideRefs", "refs/hidden");
    host = await ours(emptyRepo());
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  for (const adapter of ADAPTERS) {
    describe(adapter.name, () => {
      let setup: AdapterSetup;
      let transports: GitTransportRegistry;
      beforeAll(async () => {
        setup = await adapter.setup();
        transports = new GitTransportRegistry();
        transports.register(setup.connector);
      });
      afterAll(async () => setup?.close());

      for (const version of ["0", "2"]) {
        it(`ls-remote (protocol v${version}) lists what native git lists`, async () => {
          const o = emptyRepo();
          git(join(root, o), "config", "protocol.version", version);
          const native = gitOut(root, root, [
            "-c",
            `protocol.version=${version}`,
            "ls-remote",
            join(srv, "src"),
          ]);
          const listed = await (await ours(o))
            .lsRemote()
            .setRemote(setup.url("src"))
            .setTransports(transports)
            .call();
          const got: string[] = [];
          for (const r of listed.refs) {
            got.push(`${r.name} ${r.objectId}`);
            if (r.peeledObjectId) got.push(`${r.name}^{} ${r.peeledObjectId}`);
          }
          expect(got).toEqual(lsRemoteLines(native));
          expect(listed.defaultBranch).toBe("main");
        });
      }

      it("clone, as native git clones the local repository", async () => {
        const n = `n${counter++}`;
        git(root, "clone", "-q", join(srv, "src"), n);
        const o = emptyRepo();
        await (await ours(o)).clone().setURI(setup.url("src")).setTransports(transports).call();
        expect(refs(join(root, o)).replaceAll(setup.url("src"), "URL")).toBe(
          refs(join(root, n)).replaceAll(join(srv, "src"), "URL"),
        );
        expect(git(join(root, o), "rev-parse", "HEAD")).toBe(
          git(join(root, n), "rev-parse", "HEAD"),
        );
        git(join(root, o), "fsck", "--strict");
      });

      for (const version of ["0", "2"]) {
        it(`incremental fetch (protocol v${version}), as native git`, async () => {
          const n = emptyRepo();
          const o = emptyRepo();
          for (const d of [n, o]) git(join(root, d), "config", "protocol.version", version);
          for (const specs of [
            ["refs/tags/v1:refs/tags/v1"],
            ["main:refs/heads/m", "feat:refs/heads/f"],
          ]) {
            git(join(root, n), "fetch", "-q", join(srv, "src"), ...specs);
            await (await ours(o))
              .fetch()
              .setRemote(setup.url("src"))
              .setRefSpecs(...specs)
              .setTransports(transports)
              .call();
            expect(refs(join(root, o))).toBe(refs(join(root, n)));
          }
          git(join(root, o), "fsck", "--strict");
        });
      }

      it("shallow fetch writes the shallow file native git writes", async () => {
        const n = emptyRepo();
        const o = emptyRepo();
        git(
          join(root, n),
          "fetch",
          "-q",
          "--depth=1",
          `file://${join(srv, "src")}`,
          "main:refs/heads/m",
        );
        await (await ours(o))
          .fetch()
          .setRemote(setup.url("src"))
          .setRefSpecs("main:refs/heads/m")
          .setDepth(1)
          .setTransports(transports)
          .call();
        expect(refs(join(root, o))).toBe(refs(join(root, n)));
        expect(readFileSync(join(root, o, ".git/shallow"), "utf8")).toBe(
          readFileSync(join(root, n, ".git/shallow"), "utf8"),
        );
      });

      it("push: updates, a deletion, atomic, push options", async () => {
        const [dn, dO] = bareTwins();
        const n = `n${counter++}`;
        git(root, "clone", "-q", join(srv, "src"), n);
        const o = emptyRepo();
        git(join(root, o), "fetch", "-q", join(srv, "src"), "main");
        git(join(root, o), "reset", "-q", "--hard", "FETCH_HEAD");
        for (const d of [n, o]) {
          putFile(join(root, d), "p.txt", "p\n");
          git(join(root, d), "add", "p.txt");
          git(join(root, d), "commit", "-qm", "pushed");
        }
        expect(git(join(root, o), "rev-parse", "HEAD")).toBe(
          git(join(root, n), "rev-parse", "HEAD"),
        );
        const specs = ["main:refs/heads/main", "main:refs/heads/new", ":refs/heads/feat"];
        git(join(root, n), "push", "-q", "--atomic", "-o", "x=1", join(srv, dn), ...specs);
        const result = await (await ours(o))
          .push()
          .setRemote(setup.url(dO))
          .setRefSpecs(...specs)
          .setAtomic(true)
          .setPushOptions(["x=1"])
          .setTransports(transports)
          .call();
        expect(result.remoteUpdates.map((u) => [u.remoteName, u.status]).sort()).toEqual([
          ["refs/heads/feat", "ok"],
          ["refs/heads/main", "ok"],
          ["refs/heads/new", "ok"],
        ]);
        expect(refs(join(srv, dO))).toBe(refs(join(srv, dn)));
        git(join(srv, dO), "fsck", "--strict");
      });

      it("refusals: a pre-receive hook and receive.denyDeletes, as native git's", async () => {
        const [dn, dO] = bareTwins({ "receive.denyDeletes": "true" });
        const o = emptyRepo();
        git(join(root, o), "fetch", "-q", join(srv, "src"), "feat:refs/heads/feat");
        const pushDelete = async (target: string) =>
          (await ours(o))
            .push()
            .setRemote(setup.url(target))
            .setRefSpecs(":refs/heads/feat")
            .setTransports(transports)
            .call();
        const nativeDelete = gitRun(root, join(srv, "src"), [
          "push",
          join(srv, dn),
          ":refs/heads/feat",
        ]);
        expect(nativeDelete.stderr).toContain("deletion prohibited");
        const deleted = await pushDelete(dO);
        expect(deleted.remoteUpdates.map((u) => [u.remoteName, u.status, u.message])).toEqual([
          ["refs/heads/feat", "rejected-other", "deletion prohibited"],
        ]);

        for (const d of [dn, dO]) {
          putFile(
            join(srv, d),
            "hooks/pre-receive",
            "#!/bin/sh\necho no pushes here >&2\nexit 1\n",
          );
          execFileSync("chmod", ["+x", join(srv, d, "hooks/pre-receive")]);
        }
        const nativeHook = gitRun(root, join(srv, "src"), [
          "push",
          join(srv, dn),
          "main:refs/heads/hooked",
        ]);
        expect(nativeHook.stderr).toContain("pre-receive hook declined");
        const hooked = await (await ours(o))
          .push()
          .setRemote(setup.url(dO))
          .setRefSpecs("refs/heads/feat:refs/heads/hooked")
          .setTransports(transports)
          .call();
        expect(hooked.remoteUpdates.map((u) => [u.remoteName, u.status, u.message])).toEqual([
          ["refs/heads/hooked", "rejected-other", "pre-receive hook declined"],
        ]);
        expect(refs(join(srv, dO))).toBe(refs(join(srv, dn)));
      });

      it("hidden refs stay hidden, as from native git's upload-pack", async () => {
        const native = gitOut(root, root, ["ls-remote", join(srv, "hid.git")]);
        const listed = await (await ours(emptyRepo()))
          .lsRemote()
          .setRemote(setup.url("hid.git"))
          .setTransports(transports)
          .call();
        const got: string[] = [];
        for (const r of listed.refs) {
          got.push(`${r.name} ${r.objectId}`);
          if (r.peeledObjectId) got.push(`${r.name}^{} ${r.peeledObjectId}`);
        }
        expect(got).toEqual(lsRemoteLines(native));
        expect(got.some((l) => l.startsWith("refs/hidden/"))).toBe(false);
      });

      it("refuses an unknown repository as git daemon does", async () => {
        const failure = await (await ours(emptyRepo()))
          .lsRemote()
          .setRemote(setup.url("nope"))
          .setTransports(transports)
          .call()
          .then(
            () => undefined,
            (e: Error) => e.message,
          );
        expect(failure).toContain("access denied or repository not exported: /nope");
      });
    });
  }

  describe("native git through an ext:: bridge to the WebSocket server", () => {
    let server: WebSocketServer;
    let port = 0;
    let bridge: string;
    beforeAll(async () => {
      bridge = writeWebSocketBridge(root);
      server = new WebSocketServer({
        host: "127.0.0.1",
        port: 0,
        maxPayload: DEFAULT_WEBSOCKET_MAX_FRAME_SIZE,
      });
      server.on("connection", (socket) => {
        void serveGitOverWebSocket(socket as unknown as WebSocketLike, serveOptions());
      });
      await new Promise<void>((resolve) => server.once("listening", () => resolve()));
      const address = server.address();
      port = typeof address === "object" && address ? address.port : 0;
    });
    afterAll(async () => {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const ext = (path: string) =>
      `ext::${process.execPath} ${bridge} ws://127.0.0.1:${port}/ %G/${path}`;
    const allowExt = ["-c", "protocol.ext.allow=always"];

    it("clone and fetch as from the local repository", async () => {
      const n = `n${counter++}`;
      const b = `b${counter++}`;
      git(root, "clone", "-q", join(srv, "src"), n);
      const cloned = await gitAsync(root, root, [...allowExt, "clone", "-q", ext("src"), b]);
      expect(cloned.stderr).toBe("");
      expect(cloned.status).toBe(0);
      expect(git(join(root, b), "rev-parse", "HEAD", "origin/feat")).toBe(
        git(join(root, n), "rev-parse", "HEAD", "origin/feat"),
      );
      git(join(root, b), "fsck", "--strict");
      const fetched = await gitAsync(root, join(root, b), [
        ...allowExt,
        "fetch",
        "-q",
        ext("src"),
        "refs/tags/v1:refs/tags/v1",
      ]);
      expect(fetched.status).toBe(0);
      expect(git(join(root, b), "rev-parse", "v1")).toBe(git(join(srv, "src"), "rev-parse", "v1"));
    });

    it("push (atomic, a deletion) lands as a local push does", async () => {
      const [dn, dO] = bareTwins();
      const n = `n${counter++}`;
      git(root, "clone", "-q", join(srv, "src"), n);
      const dir = join(root, n);
      putFile(dir, "q.txt", "q\n");
      git(dir, "add", "q.txt");
      git(dir, "commit", "-qm", "q");
      const specs = ["main:refs/heads/main", ":refs/heads/feat"];
      const viaBridge = await gitAsync(root, dir, [
        ...allowExt,
        "push",
        "--atomic",
        ext(dO),
        ...specs,
      ]);
      expect(viaBridge.status).toBe(0);
      git(dir, "push", "-q", "--atomic", join(srv, dn), ...specs);
      expect(refs(join(srv, dO))).toBe(refs(join(srv, dn)));
    });
  });

  describe("a large pack through MessagePort and WebSocket, the bytes in flight bounded", () => {
    const SIZE = 8 << 20;
    let big: string;
    beforeAll(() => {
      // three incompressible 8 MiB blobs, written straight into a bare repository
      big = "big.git";
      git(srv, "init", "-q", "--bare", "-b", "main", big);
      const entries: string[] = [];
      for (const name of ["r1.bin", "r2.bin", "r3.bin"]) {
        const data = Buffer.alloc(SIZE);
        for (let i = 0; i < SIZE; i += 65536) crypto.getRandomValues(data.subarray(i, i + 65536));
        const id = execFileSync("git", ["hash-object", "-w", "--stdin"], {
          cwd: join(srv, big),
          input: data,
          env: testEnv(root),
        })
          .toString()
          .trim();
        entries.push(`100644 blob ${id}\t${name}`);
      }
      const tree = execFileSync("git", ["mktree"], {
        cwd: join(srv, big),
        input: `${entries.join("\n")}\n`,
        env: testEnv(root),
      })
        .toString()
        .trim();
      const commit = git(join(srv, big), "commit-tree", "-m", "big", tree).trim();
      git(join(srv, big), "update-ref", "refs/heads/main", commit);
    });
    afterAll(() => rmSync(join(srv, big), { recursive: true, force: true }));

    const metered: Array<{
      name: string;
      bound: number;
      setup(meter: ReturnType<typeof bytesInFlightMeter>): Promise<AdapterSetup>;
    }> = [
      {
        name: "MessagePort",
        bound: 4 << 20,
        async setup(meter) {
          return {
            connector: createDuplexConnector({
              name: "port",
              schemes: ["port"],
              open: async () => {
                const channel = new MessageChannel();
                const handler = webrunServerDuplex((duplex) =>
                  serveGitConnection({ ...serveOptions(), duplex: meter.server(duplex) }),
                );
                serveDuplexOverPort(channel.port2, handler);
                return meter.client(messagePortDuplex(channel.port1));
              },
            }),
            url: (path) => `port://worker/${path}`,
            close: async () => {},
          };
        },
      },
      {
        name: "WebSocket",
        // the socket buffers (1 MiB each way), the paused reader's queue (4 MiB) and the kernel's
        bound: 16 << 20,
        async setup(meter) {
          const server = new WebSocketServer({
            host: "127.0.0.1",
            port: 0,
            maxPayload: DEFAULT_WEBSOCKET_MAX_FRAME_SIZE,
          });
          server.on("connection", (socket) => {
            void serveGitConnection({
              ...serveOptions(),
              duplex: meter.server(webSocketDuplex(socket as unknown as WebSocketLike)),
            });
          });
          await new Promise<void>((resolve) => server.once("listening", () => resolve()));
          const address = server.address();
          const port = typeof address === "object" && address ? address.port : 0;
          const inner = createWebSocketConnector({
            // the ws package's client pauses its socket when its reader lags
            createWebSocket: (url) => new WsWebSocket(url) as unknown as WebSocketLike,
          });
          return {
            connector: {
              ...inner,
              connect: async (request) => {
                const session = await inner.connect(request);
                return session.kind === "native"
                  ? { ...session, duplex: meter.client(session.duplex) }
                  : session;
              },
            },
            url: (path) => `ws://127.0.0.1:${port}/${path}`,
            close: async () => {
              for (const client of server.clients) client.terminate();
              await new Promise<void>((resolve) => server.close(() => resolve()));
            },
          };
        },
      },
    ];

    for (const adapter of metered) {
      it(`${adapter.name}: fetch, then push back, ${(3 * SIZE) >> 20} MiB of random blobs`, async () => {
        const meter = bytesInFlightMeter();
        const setup = await adapter.setup(meter);
        const transports = new GitTransportRegistry();
        transports.register(setup.connector);
        const o = emptyRepo();
        const target = `bt${counter++}.git`;
        git(srv, "init", "-q", "--bare", "-b", "main", target);
        try {
          await (await ours(o))
            .fetch()
            .setRemote(setup.url(big))
            .setRefSpecs("main:refs/heads/main")
            .setTransports(transports)
            .call();
          expect(git(join(root, o), "rev-parse", "refs/heads/main")).toBe(
            git(join(srv, big), "rev-parse", "main"),
          );
          expect(meter.counts.clientRead).toBeGreaterThan(3 * SIZE);
          const result = await (await ours(o))
            .push()
            .setRemote(setup.url(target))
            .setRefSpecs("refs/heads/main:refs/heads/main")
            .setTransports(transports)
            .call();
          expect(result.remoteUpdates.map((u) => u.status)).toEqual(["ok"]);
          expect(git(join(srv, target), "rev-parse", "main")).toBe(
            git(join(srv, big), "rev-parse", "main"),
          );
          expect(meter.counts.serverRead).toBeGreaterThan(3 * SIZE);
          expect(meter.peak.downstream).toBeLessThan(adapter.bound);
          expect(meter.peak.upstream).toBeLessThan(adapter.bound);
        } finally {
          await setup.close();
          rmSync(join(root, o), { recursive: true, force: true });
          rmSync(join(srv, target), { recursive: true, force: true });
        }
      }, 180_000);
    }
  });
});
