/**
 * git:// through the Node socket adapter against native git (statewalker/webrun-vcs#452):
 * every socket is a `MessagePort` (`connectSocketPort`, `listenSocketPorts`), never wired to
 * a duplex by hand. Our client (ls-remote, fetch, push) talks to native `git daemon`, native
 * clients (ls-remote, clone, push) talk to `createGitDaemon().serve(port)`, and native git
 * decides what each side should see: the same refs and objects whichever daemon serves.
 * The pack is several MiB of incompressible data (backpressure through the port and the
 * socket both ways), each client half-closes after its request, and failures (a refused
 * connection, a daemon gone mid-session) reach the other side instead of hanging it.
 */

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

import {
  connectSocketPort,
  listenSocketPorts,
  type SocketPortServer,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createGitDaemon,
  createGitDaemonConnector,
  fetchFromConnection,
  type GitConnectRequest,
  lsRefs,
  openReceivePack,
  openUploadPack,
  parseGitUrl,
  pushToConnection,
  type ServeGitConnectionResult,
} from "../../src/index.js";
import {
  cleanupDir,
  createTransportRepo,
  git,
  gitAvailable,
  loopbackEnv,
  makeTmpDir,
  type TransportRepo,
} from "./helpers.js";

const describeGit = gitAvailable() ? describe : describe.skip;
const TIMEOUT = 120000;

const GIT_ENV = {
  GIT_AUTHOR_NAME: "T",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "T",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_AUTHOR_DATE: "1112911993 +0000",
  GIT_COMMITTER_DATE: "1112911993 +0000",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "maintenance.auto",
  GIT_CONFIG_VALUE_0: "false",
  GIT_CONFIG_KEY_1: "gc.auto",
  GIT_CONFIG_VALUE_1: "0",
};

/** Native git without blocking the event loop (our daemon answers in this process). */
function gitAsync(
  cwd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, env: { ...loopbackEnv(), ...GIT_ENV }, timeout: 60000, maxBuffer: 1 << 26 },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  await new Promise<void>((r) => server.close(() => r()));
  return typeof address === "object" && address ? address.port : 0;
}

/** Native `git daemon` on `port` serving every repository below `base`, once it accepts. */
async function nativeDaemon(base: string, port: number): Promise<ChildProcess> {
  const child = spawn(
    "git",
    [
      "daemon",
      "--listen=127.0.0.1",
      `--port=${port}`,
      "--reuseaddr",
      "--export-all",
      "--enable=receive-pack",
      `--base-path=${base}`,
      base,
    ],
    { env: { ...loopbackEnv(), ...GIT_ENV }, stdio: "ignore" },
  );
  for (let i = 0; i < 100; i++) {
    try {
      const probe = await connectSocketPort({ port });
      probe.close();
      return child;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  child.kill();
  throw new Error("git daemon did not start");
}

const request = (port: number, service: GitConnectRequest["service"], version: 0 | 2 = 2) => ({
  url: parseGitUrl(`git://127.0.0.1:${port}/repo.git`),
  service,
  protocolVersion: version,
});

/** git:// over the socket adapter: each session a socket's `MessagePort`. */
const sockets = createGitDaemonConnector({
  openSocket: (host, port) => connectSocketPort({ host, port }),
});

/** Every ref of a repository as `git ls-remote` prints them, HEAD's line first. */
function refLines(text: string): string[] {
  return text
    .trim()
    .split("\n")
    .filter((l) => l.length > 0);
}

describeGit("git:// over the socket adapter, against native git", { timeout: TIMEOUT }, () => {
  let root: string;
  let base: string;
  let nativePort: number;
  let native: ChildProcess;
  let fetched: TransportRepo;
  let ours: SocketPortServer;
  let oursPort: number;
  const served: Promise<ServeGitConnectionResult>[] = [];

  beforeAll(async () => {
    root = makeTmpDir("vcs-interop-socket-");
    base = join(root, "srv");
    mkdirSync(base);
    const work = join(root, "work");
    git(root, ["init", "-q", "-b", "main", work]);
    // 8 MiB that do not compress: the pack is as large on the wire
    writeFileSync(join(work, "big.bin"), randomBytes(8 << 20));
    writeFileSync(join(work, "a.txt"), "a\n");
    git(work, ["add", "."]);
    git(work, ["commit", "-q", "-m", "big"]);
    git(work, ["tag", "-a", "-m", "v1", "v1"]);
    git(root, ["clone", "-q", "--bare", work, join(base, "repo.git")]);

    nativePort = await freePort();
    native = await nativeDaemon(base, nativePort);

    fetched = await createTransportRepo();
    const daemon = createGitDaemon({
      resolveRepository: async (path) =>
        path === "/repo.git"
          ? { repository: fetched.facade, refStore: fetched.refStore }
          : undefined,
      enableReceivePack: true,
    });
    ours = await listenSocketPorts({ host: "127.0.0.1", port: 0 }, (port, peer) => {
      served.push(
        daemon.serve(port, {
          ...(peer.remoteAddress !== undefined ? { remoteAddress: peer.remoteAddress } : {}),
          ...(peer.remotePort !== undefined ? { remotePort: String(peer.remotePort) } : {}),
        }),
      );
    });
    oursPort = typeof ours.address === "object" ? ours.address.port : 0;
  });

  afterAll(async () => {
    native?.kill();
    await ours?.close();
    if (root) cleanupDir(root);
  });

  it("our ls-remote and fetch (v0, v2) from native git daemon", async () => {
    const expected = refLines((await gitAsync(root, ["ls-remote", join(base, "repo.git")])).stdout);

    const ls = await openUploadPack(
      await sockets.connect(request(nativePort, "git-upload-pack")),
      request(nativePort, "git-upload-pack"),
    );
    const refs = await lsRefs(ls, ["refs/"]);
    await ls.close();
    expect(refs.map((r) => `${r.oid}\t${r.name}`)).toEqual(
      expected.filter((l) => !l.endsWith("\tHEAD") && !l.endsWith("^{}")),
    );

    for (const version of [0, 2] as const) {
      const local = version === 2 ? fetched : await createTransportRepo();
      const connection = await openUploadPack(
        await sockets.connect(request(nativePort, "git-upload-pack", version)),
        request(nativePort, "git-upload-pack", version),
      );
      const result = await fetchFromConnection(connection, {
        repository: local.facade,
        refStore: local.refStore,
        refspecs: ["+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*"],
      });
      await connection.close();
      expect(result.refUpdates.length).toBeGreaterThan(0);
      for (const line of expected.filter((l) => l.includes("\trefs/") && !l.endsWith("^{}"))) {
        const [id, name] = line.split("\t") as [string, string];
        expect(await local.refStore.get(name)).toBe(id);
      }
    }
    await fetched.history.refs.setSymbolic("HEAD", "refs/heads/main");
  });

  it("native ls-remote and clone from our daemon see what native git daemon serves", async () => {
    const fromNative = await gitAsync(root, [
      "ls-remote",
      `git://127.0.0.1:${nativePort}/repo.git`,
    ]);
    const fromOurs = await gitAsync(root, ["ls-remote", `git://127.0.0.1:${oursPort}/repo.git`]);
    expect(fromOurs.code).toBe(0);
    expect(refLines(fromOurs.stdout)).toEqual(refLines(fromNative.stdout));

    for (const version of ["0", "2"]) {
      const dir = join(root, `clone-v${version}`);
      const cloned = await gitAsync(root, [
        "-c",
        `protocol.version=${version}`,
        "clone",
        "-q",
        `git://127.0.0.1:${oursPort}/repo.git`,
        dir,
      ]);
      expect(cloned.stderr).toBe("");
      expect(cloned.code).toBe(0);
      expect((await gitAsync(dir, ["fsck", "--strict"])).code).toBe(0);
      expect(git(dir, ["rev-parse", "HEAD:big.bin"])).toBe(
        git(join(base, "repo.git"), ["rev-parse", "HEAD:big.bin"]),
      );
    }
  });

  it("pushes a large pack both ways: native to ours, ours to native", async () => {
    const work = join(root, "clone-v2");
    writeFileSync(join(work, "big2.bin"), randomBytes(6 << 20));
    git(work, ["add", "."]);
    git(work, ["commit", "-q", "-m", "big2"]);
    const tip = git(work, ["rev-parse", "HEAD"]);
    const pushed = await gitAsync(work, ["push", "-q", "origin", "main"]);
    expect(pushed.stderr).toBe("");
    expect(pushed.code).toBe(0);
    expect(await fetched.refStore.get("refs/heads/main")).toBe(tip);

    // and from our repository (now holding that commit) to native git daemon
    const receive = await openReceivePack(
      await sockets.connect(request(nativePort, "git-receive-pack", 0)),
      request(nativePort, "git-receive-pack", 0),
    );
    const result = await pushToConnection(receive, {
      repository: fetched.facade,
      refStore: fetched.refStore,
      refspecs: ["refs/heads/main:refs/heads/main"],
    });
    await receive.close();
    expect(result.updates.map((u) => u.status)).toEqual(["ok"]);
    const bare = join(base, "repo.git");
    expect(git(bare, ["rev-parse", "main"])).toBe(tip);
    expect((await gitAsync(bare, ["fsck", "--strict"])).code).toBe(0);
  });

  it("a refused connection fails connect; a daemon gone mid-session fails the other side", async () => {
    const closed = await freePort();
    await expect(sockets.connect(request(closed, "git-upload-pack"))).rejects.toThrow(
      /ECONNREFUSED/,
    );

    // a peer resetting the connection after git-daemon's request line (a daemon gone mid-
    // session): the reset reaches our client as an error, never a hang
    const reset = createServer({ allowHalfOpen: true }, (socket) => {
      socket.once("data", () => socket.resetAndDestroy());
      socket.on("error", () => {});
    });
    await new Promise<void>((r) => reset.listen(0, "127.0.0.1", r));
    const resetPort = (reset.address() as { port: number }).port;
    await expect(
      openUploadPack(
        await sockets.connect(request(resetPort, "git-upload-pack")),
        request(resetPort, "git-upload-pack"),
      ),
    ).rejects.toThrow();
    await new Promise<void>((r) => reset.close(() => r()));

    // our daemon closing a connection mid-clone fails native git's clone
    const busy = await listenSocketPorts({ host: "127.0.0.1", port: 0 }, (port) => {
      // read the request line, then go away (destroys the socket)
      port.addEventListener("message", () => port.close(), { once: true });
      port.start();
    });
    const busyPort = typeof busy.address === "object" ? busy.address.port : 0;
    const clone = await gitAsync(root, [
      "clone",
      "-q",
      `git://127.0.0.1:${busyPort}/repo.git`,
      join(root, "never"),
    ]);
    await busy.close();
    expect(clone.code).not.toBe(0);
    expect(clone.stderr).toMatch(/fatal: /);
  });
});
