/**
 * Protocol v0 negotiation of our upload-pack as git's `get_common_commits` answers it: the
 * `ACK <oid> common|continue|ready` lines while haves are read, NAK at the end of every
 * batch in the multi_ack modes, and on `done` (or no-done after `ready`) the final
 * `ACK <oid>` before the pack.
 *
 * Checked byte for byte against `git upload-pack --stateless-rpc`, then end to end: a client
 * with a stale remote-tracking ref and many local commits (several negotiation rounds) fetches
 * from our server, with our fetch client (smart HTTP and a duplex) and with native git (smart
 * HTTP and a stateful pipe), with and without an annotated tag to follow.
 */

import { type ChildProcess, execFile, execFileSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";

import { ObjectType } from "@statewalker/vcs-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createFetchHandler, fetch, fetchOverDuplex, serveOverDuplex } from "../../src/index.js";
import {
  cleanupDir,
  createTransportRepo,
  gitAvailable,
  loopbackEnv,
  makeTmpDir,
  type TransportRepo,
} from "./helpers.js";
import { serveFetchHandler } from "./http-server.js";

const describeGit = gitAvailable() ? describe : describe.skip;
const TIMEOUT = 120000;

const GIT_ENV = {
  GIT_AUTHOR_NAME: "T",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "T",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};

const children = new Set<ChildProcess>();

/** git without blocking the event loop (our server answers in this process). */
function gitAsync(
  cwd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      "git",
      args,
      { cwd, env: { ...loopbackEnv(), ...GIT_ENV }, timeout: 60000, killSignal: "SIGKILL" },
      (error, stdout, stderr) => {
        children.delete(child);
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ code, stdout: String(stdout).trim(), stderr: String(stderr) });
      },
    );
    child.stdin?.on("error", () => {});
    children.add(child);
  });
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: { ...loopbackEnv(), ...GIT_ENV } })
    .toString()
    .trim();
}

/** Appends `count` commits to `branch` of `repo` (git fast-import); returns the new tip. */
function addCommits(
  repo: string,
  branch: string,
  from: string,
  count: number,
  time: (i: number) => number,
): string {
  let stream = "";
  for (let i = 0; i < count; i++) {
    const message = `local ${i}\n`;
    const content = `local ${i}\n`;
    stream += `commit ${branch}\ncommitter T <t@example.com> ${time(i)} +0000\n`;
    stream += `data ${Buffer.byteLength(message)}\n${message}`;
    if (i === 0) stream += `from ${from}\n`;
    stream += `M 100644 inline l${i % 7}.txt\ndata ${Buffer.byteLength(content)}\n${content}\n`;
  }
  execFileSync("git", ["fast-import", "--quiet"], {
    cwd: repo,
    input: stream,
    env: { ...process.env, ...GIT_ENV },
  });
  return git(repo, ["rev-parse", branch]);
}

const encoder = new TextEncoder();

async function commitAt(
  repo: TransportRepo,
  name: string,
  time: number,
  parents: string[] = [],
): Promise<string> {
  const blob = await repo.history.blobs.store([encoder.encode(`${name}\n`)]);
  const tree = await repo.history.trees.store([{ name: `${name}.txt`, mode: 0o100644, id: blob }]);
  const ident = { name: "T", email: "t@example.com", timestamp: time, tzOffset: "+0000" };
  return repo.history.commits.store({
    tree,
    parents,
    author: ident,
    committer: ident,
    message: `${name}\n`,
  });
}

function pkt(text: string): string {
  return (Buffer.byteLength(text) + 4).toString(16).padStart(4, "0") + text;
}

/** The text pkt-lines of a v0 answer up to the pack, and the pack's object count. */
function answer(body: Buffer): { lines: string[]; packObjects?: number } {
  const lines: string[] = [];
  const pack: Buffer[] = [];
  let pos = 0;
  while (pos + 4 <= body.length) {
    const len = Number.parseInt(body.subarray(pos, pos + 4).toString("latin1"), 16);
    if (Number.isNaN(len)) break;
    if (len < 4) {
      lines.push("0000");
      pos += 4;
      continue;
    }
    const payload = body.subarray(pos + 4, pos + len);
    pos += len;
    if (payload[0] === 1) pack.push(payload.subarray(1));
    else if (payload[0] !== 2) lines.push(payload.toString("latin1").replace(/\n$/, ""));
  }
  const bytes = Buffer.concat(pack);
  return { lines, packObjects: bytes.length >= 12 ? bytes.readUInt32BE(8) : undefined };
}

/** A serveOverDuplex v0 upload-pack behind a TCP port, for git's `--upload-pack` relay. */
function serveRelay(repo: TransportRepo): Server {
  return createServer({ allowHalfOpen: true }, (socket: Socket) => {
    void (async () => {
      const it = socket[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
      await serveOverDuplex({
        duplex: {
          async *[Symbol.asyncIterator]() {
            while (true) {
              const next = await it.next();
              if (next.done) return;
              yield new Uint8Array(next.value);
            }
          },
          write: (data: Uint8Array) =>
            new Promise<void>((resolve) => {
              socket.write(data, () => resolve());
            }),
        },
        repository: repo.facade,
        refStore: repo.refStore,
        service: "git-upload-pack",
        protocolVersion: "1",
      });
      socket.end();
    })().catch(() => socket.destroy());
  });
}

const RELAY = `
import net from "node:net";
const socket = net.connect(Number(process.argv[2]), "127.0.0.1", () => {
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
});
socket.on("close", () => {
  process.stdout.on("finish", () => process.exit(0));
  process.stdout.end();
});
socket.on("error", () => process.exit(1));
`;

function shellQuote(word: string): string {
  return `'${word.replace(/'/g, "'\\''")}'`;
}

describeGit("Interop · upload-pack v0 negotiation as git's", { timeout: TIMEOUT }, () => {
  let root: string;
  let server: TransportRepo;
  /** The same repository, native (bare) */
  let bare: string;
  let c0: string;
  let c1: string;
  let tag: string;
  let relay: Server;
  let uploadPack: string;

  beforeAll(async () => {
    root = makeTmpDir("vcs-negotiation-");
    server = await createTransportRepo();
    c0 = await commitAt(server, "c0", 1_700_000_000);
    await server.refStore.update("refs/heads/main", c0);
    await server.history.refs.setSymbolic("HEAD", "refs/heads/main");
    // the native copy at c0, the server then moves on to c1, tagged
    const http = await serveFetchHandler(
      createFetchHandler({
        resolveRepository: async () => ({ repository: server.facade, refStore: server.refStore }),
      }),
    );
    try {
      const r = await gitAsync(root, ["clone", "-q", "--bare", `${http.baseUrl}/r.git`, "r.git"]);
      if (r.code !== 0) throw new Error(r.stderr);
    } finally {
      await http.close();
    }
    bare = join(root, "r.git");
    c1 = await commitAt(server, "c1", 1_700_000_100, [c0]);
    await server.refStore.update("refs/heads/main", c1);
    tag = await server.history.tags.store({
      object: c1,
      objectType: ObjectType.COMMIT,
      tag: "v1",
      tagger: { name: "T", email: "t@example.com", timestamp: 1_700_000_200, tzOffset: "+0000" },
      message: "v1\n",
    });
    await server.refStore.update("refs/tags/v1", tag);
    // native gets the same c1 and tag
    const pack: Uint8Array[] = [];
    for await (const chunk of server.facade.exportPack(new Set([tag]), new Set([c0]))) {
      pack.push(chunk);
    }
    spawnSync("git", ["index-pack", "--stdin"], {
      cwd: bare,
      input: Buffer.concat(pack),
      env: { ...process.env, ...GIT_ENV },
    });
    git(bare, ["update-ref", "refs/heads/main", c1]);
    git(bare, ["update-ref", "refs/tags/v1", tag]);

    relay = serveRelay(server);
    await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
    const script = join(root, "relay.mjs");
    writeFileSync(script, RELAY);
    uploadPack = `${shellQuote(process.execPath)} ${shellQuote(script)} ${(relay.address() as AddressInfo).port}`;
  }, TIMEOUT);

  afterEach(() => {
    for (const child of children) child.kill("SIGKILL");
    children.clear();
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => relay?.close(() => resolve()));
    await server?.close();
    if (root) cleanupDir(root);
  });

  /** The same stateless v0 request to git and to ours. */
  async function both(
    body: string,
  ): Promise<[ReturnType<typeof answer>, ReturnType<typeof answer>]> {
    const native = spawnSync("git", ["upload-pack", "--stateless-rpc", bare], {
      input: Buffer.from(body, "latin1"),
      env: { ...loopbackEnv(), ...GIT_ENV },
    });
    const handler = createFetchHandler({
      resolveRepository: async () => ({ repository: server.facade, refStore: server.refStore }),
    });
    const response = await handler(
      new Request("http://ours.test/r.git/git-upload-pack", {
        method: "POST",
        headers: { "content-type": "application/x-git-upload-pack-request" },
        body: Buffer.from(body, "latin1"),
      }),
    );
    return [answer(native.stdout), answer(Buffer.from(await response.arrayBuffer()))];
  }

  const unknown = (n: number) =>
    Array.from({ length: n }, (_, i) => (i + 1).toString(16).padStart(40, "a"));

  describe("byte for byte with git upload-pack --stateless-rpc", () => {
    const cases: Array<[string, string, string[], boolean]> = [
      // name, capabilities, haves (filled in at run time: "C0" is c0), done
      [
        "multi_ack_detailed: unknown haves, then the common one",
        "multi_ack_detailed side-band-64k",
        ["U", "C0"],
        false,
      ],
      [
        "multi_ack_detailed: the common one, then unknown ones (ready)",
        "multi_ack_detailed side-band-64k",
        ["C0", "U"],
        false,
      ],
      [
        "multi_ack_detailed no-done: ready, NAK, final ACK and the pack",
        "multi_ack_detailed no-done side-band-64k",
        ["C0", "U"],
        false,
      ],
      [
        "multi_ack_detailed no-done: only the common one (ready at the flush)",
        "multi_ack_detailed no-done side-band-64k",
        ["C0"],
        false,
      ],
      ["multi_ack_detailed: nothing common", "multi_ack_detailed side-band-64k", ["U"], false],
      ["multi_ack: ACK continue and NAK", "multi_ack side-band-64k", ["U", "C0", "U"], false],
      ["single ack: one ACK, nothing at the flush", "side-band-64k", ["U", "C0", "C0"], false],
      [
        "multi_ack_detailed with done: common, then the final ACK",
        "multi_ack_detailed side-band-64k",
        ["U", "C0"],
        true,
      ],
      ["multi_ack with done", "multi_ack side-band-64k", ["C0", "U"], true],
      ["single ack with done", "side-band-64k", ["C0", "U"], true],
      ["done without a common have: NAK", "multi_ack_detailed side-band-64k", ["U"], true],
    ];
    for (const [name, caps, haves, done] of cases) {
      it(name, async () => {
        const lines = haves.flatMap((h) => (h === "C0" ? [c0] : unknown(3)));
        const body = `${pkt(`want ${c1} ${caps}\n`)}0000${lines.map((h) => pkt(`have ${h}\n`)).join("")}${done ? pkt("done\n") : "0000"}`;
        const [native, our] = await both(body);
        expect(our.lines).toEqual(native.lines);
        expect(our.packObjects).toBe(native.packObjects);
      });
    }
  });

  // local commits after c0, or all at c0's time (the client's walk then meets c0 in an early
  // batch: the server must still end every batch with NAK, which git's fetch-pack reads)
  const timings: Array<[string, (i: number) => number]> = [
    ["later than c0", (i) => 1_800_000_000 + i * 60],
    ["at c0's time", () => 1_700_000_000],
  ];
  for (const [count, [timing, time]] of [40, 200].flatMap((n) =>
    timings.map((t) => [n, t] as const),
  )) {
    describe(`a stale remote-tracking ref and ${count} local commits ${timing}`, () => {
      /** Our client repository: main at c0 fetched, tracking ref stale, `count` commits on top. */
      async function ourClient(): Promise<TransportRepo> {
        const client = await createTransportRepo();
        const pack: Uint8Array[] = [];
        for await (const chunk of server.facade.exportPack(new Set([c0]), new Set())) {
          pack.push(chunk);
        }
        await client.facade.importPack(
          (async function* () {
            yield* pack;
          })(),
        );
        await client.refStore.update("refs/remotes/origin/main", c0);
        let tip = c0;
        for (let i = 0; i < count; i++) {
          tip = await commitAt(client, `local${i}`, time(i), [tip]);
        }
        await client.refStore.update("refs/heads/main", tip);
        return client;
      }

      it("our fetch client over smart HTTP v0: the new commit, the tag, one pack", async () => {
        const client = await ourClient();
        try {
          const result = await fetch({
            url: "http://ours.test/r.git",
            fetchImpl: createFetchHandler({
              resolveRepository: async () => ({
                repository: server.facade,
                refStore: server.refStore,
              }),
            }),
            protocolVersion: 0,
            repository: client.facade,
            refStore: client.refStore,
            refspecs: ["+refs/heads/main:refs/remotes/origin/main"],
          });
          expect(await client.refStore.get("refs/remotes/origin/main")).toBe(c1);
          expect(result.packObjects).toBe(4); // c1, its tree, its blob, the tag (include-tag)
          expect(result.followedTags).toEqual(["refs/tags/v1"]);
          // the setup's import, then one pack: no backfill fetch for the tag
          expect(client.imports.length).toBe(2);
        } finally {
          await client.close();
        }
      });

      it("our fetch client over a duplex v0", async () => {
        const client = await ourClient();
        const toServer: Uint8Array[] = [];
        const toClient: Uint8Array[] = [];
        let wakeS: (() => void) | undefined;
        let wakeC: (() => void) | undefined;
        let endS = false;
        let endC = false;
        const reader = (q: Uint8Array[], ended: () => boolean, wait: (w: () => void) => void) =>
          async function* () {
            while (true) {
              const next = q.shift();
              if (next) {
                yield next;
                continue;
              }
              if (ended()) return;
              await new Promise<void>((r) => wait(r));
            }
          };
        try {
          const served = serveOverDuplex({
            duplex: {
              [Symbol.asyncIterator]: reader(
                toServer,
                () => endS,
                (w) => {
                  wakeS = w;
                },
              ),
              write: (d) => {
                toClient.push(d.slice());
                wakeC?.();
              },
            },
            repository: server.facade,
            refStore: server.refStore,
            service: "git-upload-pack",
            protocolVersion: "1",
          }).finally(() => {
            endC = true;
            wakeC?.();
          });
          const result = await fetchOverDuplex({
            duplex: {
              [Symbol.asyncIterator]: reader(
                toClient,
                () => endC,
                (w) => {
                  wakeC = w;
                },
              ),
              write: (d) => {
                toServer.push(d.slice());
                wakeS?.();
              },
              close: async () => {
                endS = true;
                wakeS?.();
              },
            },
            repository: client.facade,
            refStore: client.refStore,
            refspecs: ["+refs/heads/main:refs/remotes/origin/main"],
          });
          expect(result.success, result.error).toBe(true);
          expect(await client.refStore.get("refs/remotes/origin/main")).toBe(c1);
          expect(result.report?.packObjects).toBe(4);
          expect((await served).success).toBe(true);
        } finally {
          await client.close();
        }
      });

      /** A native clone at c0 with `count` commits on main; the tracking ref stays at c0. */
      function nativeClient(name: string): string {
        const dir = join(root, `${name}-${count}-${time(1)}`);
        git(root, ["init", "-q", "--bare", dir]);
        git(dir, ["fetch", "-q", bare, `${c0}:refs/remotes/origin/main`]);
        addCommits(dir, "refs/heads/main", c0, count, time);
        return dir;
      }

      it("native git over smart HTTP v0: fetches c1 and follows the tag", async () => {
        const http = await serveFetchHandler(
          createFetchHandler({
            resolveRepository: async () => ({
              repository: server.facade,
              refStore: server.refStore,
            }),
          }),
        );
        try {
          const dir = nativeClient("http");
          git(dir, ["remote", "add", "origin", `${http.baseUrl}/r.git`]);
          const r = await gitAsync(dir, ["-c", "protocol.version=0", "fetch", "origin"]);
          expect(r.code, r.stderr).toBe(0);
          expect(git(dir, ["rev-parse", "refs/remotes/origin/main"])).toBe(c1);
          expect(git(dir, ["rev-parse", "refs/tags/v1"])).toBe(tag);
          // later commits: several rounds, more than one POST (at c0's time c0 comes early)
          const posts = http.requests.filter((q) => q.method === "POST").length;
          if (time(1) !== time(0)) expect(posts).toBeGreaterThan(1);
        } finally {
          await http.close();
        }
      });

      it("native git over a stateful pipe v0: fetches c1 and follows the tag", async () => {
        const dir = nativeClient("pipe");
        git(dir, ["remote", "add", "origin", "file:///served/r.git"]);
        const r = await gitAsync(dir, [
          "-c",
          "protocol.version=0",
          "fetch",
          `--upload-pack=${uploadPack}`,
          "origin",
        ]);
        expect(r.code, r.stderr).toBe(0);
        expect(git(dir, ["rev-parse", "refs/remotes/origin/main"])).toBe(c1);
        expect(git(dir, ["rev-parse", "refs/tags/v1"])).toBe(tag);
      });
    });
  }
});
