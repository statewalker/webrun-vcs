/**
 * git-daemon's front end against native `git daemon` (t5570-git-daemon.sh): the same raw
 * git:// requests sent to `git daemon` (inetd, or listening for `--max-connections`) and to
 * ours (`createGitDaemon` over `createBasePathResolver`), the answers compared packet by
 * packet (refusals exactly, advertisements by their ref lines: capabilities and agents differ).
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  type BasePathResolverOptions,
  createBasePathResolver,
  createGitDaemon,
  type Duplex,
  type GitDaemonOptions,
} from "@statewalker/vcs-transport";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
  createNodeHookRunner,
  listenSocketPorts,
  type SocketPortServer,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openLocalRemote } from "../src/commands/local-transport.js";
import { daemonAccessHookOf, type Git, servedRepositoryOf } from "../src/index.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { testEnv } from "./status-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root = "";
let srv = "";
let host: Git;

const pkt = (text: string) =>
  Buffer.concat([Buffer.from((text.length + 4).toString(16).padStart(4, "0")), Buffer.from(text)]);
/** A request line and the flush that ends a v0 upload-pack session (t5570's fake_nc input). */
const request = (line: string) => Buffer.concat([pkt(line), Buffer.from("0000")]);

/** The packets of an answer: ERR lines and ref lines (capabilities dropped), flushes. */
function summary(out: Buffer): string[] {
  const lines: string[] = [];
  let at = 0;
  while (at + 4 <= out.length) {
    const len = Number.parseInt(out.subarray(at, at + 4).toString("latin1"), 16);
    if (Number.isNaN(len)) {
      lines.push("garbage");
      break;
    }
    if (len === 0) {
      lines.push("0000");
      at += 4;
      continue;
    }
    const text = (
      out
        .subarray(at + 4, at + len)
        .toString("latin1")
        .split("\0")[0] ?? ""
    ).replace(/\n$/, "");
    at += len;
    lines.push(text);
  }
  return lines;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: testEnv(root), encoding: "utf8" });
}

/** A bare copy of the source repository at `dir` (below the root), exported or not. */
function bare(dir: string, exported = true): void {
  const at = join(root, dir);
  git(root, "clone", "-q", "--bare", join(root, "src"), at);
  if (exported) writeFileSync(join(at, "git-daemon-export-ok"), "");
}

/** `git daemon --inetd <args>` given `input` on stdin, kept open while `keepOpen`. */
function nativeExchange(args: string[], input: Buffer, keepOpen = false): Promise<Buffer> {
  return new Promise((resolve) => {
    const child = spawn(
      "git",
      ["daemon", "--inetd", `--base-path=${srv}`, "--log-destination=none", ...args, srv],
      { env: testEnv(root) },
    );
    const out: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", () => {});
    child.stdin.on("error", () => {});
    child.stdin.write(input);
    if (!keepOpen) child.stdin.end();
    const timer = setTimeout(() => child.kill(), 15_000);
    child.on("close", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(out));
    });
  });
}

/** Our resolver, its files the host's (rooted at `/`: paths are host paths, as git's). */
function resolverOf(options: Partial<BasePathResolverOptions> = {}) {
  return createBasePathResolver({
    files: createNodeFilesApi({ rootDir: "/" }),
    basePath: srv,
    whitelist: [srv],
    openRepository: async (gitDir) => {
      const opened = await openLocalRemote(
        host.workingCopy,
        relative(join(srv, "host"), gitDir),
      ).catch(() => undefined);
      return opened && servedRepositoryOf(opened);
    },
    ...options,
  });
}

/** Our daemon given `input` as one connection (kept open while `keepOpen`), its answer. */
async function oursExchange(
  options: Omit<GitDaemonOptions, "resolveRepository">,
  resolver: Partial<BasePathResolverOptions>,
  input: Buffer,
  keepOpen = false,
): Promise<Buffer> {
  const out: Buffer[] = [];
  let closed: () => void = () => {};
  const gone = new Promise<void>((resolve) => {
    closed = resolve;
  });
  const duplex: Duplex = {
    async *[Symbol.asyncIterator]() {
      yield new Uint8Array(input);
      if (keepOpen) await gone;
    },
    write(data) {
      out.push(Buffer.from(data));
    },
    end: async () => closed(),
    close: async () => closed(),
  };
  const daemon = createGitDaemon({ ...options, resolveRepository: resolverOf(resolver) });
  await daemon.serve(duplex, { remoteAddress: "127.0.0.1", remotePort: "40000" });
  return Buffer.concat(out);
}

async function twins(
  nativeArgs: string[],
  options: Omit<GitDaemonOptions, "resolveRepository">,
  resolver: Partial<BasePathResolverOptions>,
  input: Buffer,
): Promise<{ native: string[]; ours: string[] }> {
  const native = summary(await nativeExchange(nativeArgs, input));
  const ours = summary(await oursExchange(options, resolver, input));
  return { native, ours };
}

describeGit("git daemon front end (native twins)", () => {
  let mainId = "";

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "daemon-native-"));
    srv = join(root, "srv");
    const src = join(root, "src");
    mkdirSync(src);
    git(src, "init", "-q", "-b", "main");
    writeFileSync(join(src, "a.txt"), "a\n");
    git(src, "add", "a.txt");
    git(src, "commit", "-qm", "c1");
    mainId = git(src, "rev-parse", "HEAD").trim();
    bare("srv/repo.git");
    bare("srv/noexport.git", false);
    bare("srv/localhost/interp.git");
    bare("escape.git");
    bare("srv/ip/127.0.0.1-9418-127.0.0.1%%q/r.git");
    bare("srv/deny.git");
    bare("srv/silent.git");
    mkdirSync(join(srv, "host"));
    git(join(srv, "host"), "init", "-q", "-b", "main");
    host = await openOurs(
      srv,
      createNodeGitHostEnvironment({ env: testEnv(root) }),
      undefined,
      "host",
    );
  });

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  const advertised = () => [`${mainId} HEAD`, `${mainId} refs/heads/main`, "0000"];

  it("serves an exported repository below the base path", async () => {
    const { native, ours } = await twins(
      [],
      {},
      {},
      request("git-upload-pack /repo.git\0host=127.0.0.1\0"),
    );
    expect(native).toEqual(advertised());
    expect(ours).toEqual(native);
  });

  for (const informative of [false, true]) {
    const flag = informative ? ["--informative-errors"] : [];
    const label = informative ? "informative" : "generic";
    it(`t5570-git-daemon.sh: "clone non-existent" (${label})`, async () => {
      const { native, ours } = await twins(
        flag,
        { informativeErrors: informative },
        {},
        request("git-upload-pack /nowhere.git\0host=127.0.0.1\0"),
      );
      expect(native).toEqual([
        `ERR ${informative ? "no such repository" : "access denied or repository not exported"}: /nowhere.git`,
      ]);
      expect(ours).toEqual(native);
    });
    it(`t5570-git-daemon.sh: "push disabled" (${label})`, async () => {
      const { native, ours } = await twins(
        flag,
        { informativeErrors: informative },
        {},
        request("git-receive-pack /repo.git\0host=127.0.0.1\0"),
      );
      expect(native).toEqual([
        `ERR ${informative ? "service not enabled" : "access denied or repository not exported"}: /repo.git`,
      ]);
      expect(ours).toEqual(native);
    });
    it(`t5570-git-daemon.sh: "not exported" (${label})`, async () => {
      const { native, ours } = await twins(
        flag,
        { informativeErrors: informative },
        {},
        request("git-upload-pack /noexport.git\0host=127.0.0.1\0"),
      );
      expect(native).toEqual([
        `ERR ${informative ? "repository not exported" : "access denied or repository not exported"}: /noexport.git`,
      ]);
      expect(ours).toEqual(native);
    });
  }

  describe("--interpolated-path", () => {
    const template = () => `${srv}/%H%D`;
    const run = (line: string, informative = true) =>
      twins(
        [`--interpolated-path=${template()}`, ...(informative ? ["--informative-errors"] : [])],
        { informativeErrors: informative },
        { interpolatedPath: template() },
        request(line),
      );

    it('t5570-git-daemon.sh: "access repo via interpolated hostname"', async () => {
      for (const name of ["localhost", "LOCALHOST", "localhost:9418"]) {
        const { native, ours } = await run(`git-upload-pack /interp.git\0host=${name}\0`);
        expect(native, name).toEqual(advertised());
        expect(ours, name).toEqual(native);
      }
    });

    it('t5570-git-daemon.sh: "hostname cannot break out of directory"', async () => {
      for (const name of ["..", "...", "./..", "a/../.."]) {
        const { native, ours } = await run(`git-upload-pack /escape.git\0host=${name}\0`);
        expect(native, name).toEqual(["ERR no such repository: /escape.git"]);
        expect(ours, name).toEqual(native);
      }
    });

    it('t5570-git-daemon.sh: "hostname interpolation works after LF-stripping"', async () => {
      const { native, ours } = await run("git-upload-pack /interp.git\n\0host=localhost");
      expect(native).toEqual(advertised());
      expect(ours).toEqual(native);
    });

    it("applies to an empty host= too, never without one (base path then)", async () => {
      // an empty host: `<srv>//interp.git`, no such repository; no host=: below the base path
      for (const [line, served] of [
        ["git-upload-pack /interp.git\0host=\0", false],
        ["git-upload-pack /localhost/interp.git\0", true],
        ["git-upload-pack /repo.git\0", true],
      ] as const) {
        const { native, ours } = await run(line);
        expect(native[0]?.startsWith("ERR"), line).toBe(!served);
        expect(ours, line).toEqual(native);
      }
    });

    it("expands %IP, %P, %CH, %% and leaves an unknown placeholder", async () => {
      const ip = `${srv}/ip/%IP-%P-%CH%%%q%D`;
      const { native, ours } = await twins(
        [`--interpolated-path=${ip}`, "--informative-errors"],
        { informativeErrors: true },
        { interpolatedPath: ip },
        request("git-upload-pack /r.git\0host=127.0.0.1:9418\0"),
      );
      expect(native).toEqual(advertised());
      expect(ours).toEqual(native);
    });
  });

  describe("--access-hook", () => {
    let hook = "";
    let log = "";
    beforeAll(() => {
      hook = join(root, "access-hook");
      log = join(root, "access.log");
      writeFileSync(
        hook,
        [
          "#!/bin/sh",
          `printf '%s|' "$#" "$@" >>'${log}'`,
          `pwd -P >>'${log}'`,
          'case "$2" in',
          "*/deny.git) printf '  \\t denied by hook\\nsecond line\\n'; exit 1;;",
          "*/silent.git) echo '   ' >&2; exit 3;;",
          "esac",
          "echo ignored",
          "",
        ].join("\n"),
      );
      chmodSync(hook, 0o755);
    });

    const runner = () => createNodeHookRunner({ env: testEnv(root) });

    for (const informative of [true, false]) {
      it(`refuses with the hook's first line, runs it with git's arguments (${informative ? "informative" : "generic"})`, async () => {
        const lines = [
          "git-upload-pack /repo\0host=127.0.0.1:9418\0",
          "git-upload-pack /deny.git\0host=127.0.0.1\0",
          "git-upload-pack /silent\0",
          "git-upload-pack /nowhere.git\0host=127.0.0.1\0",
        ];
        const flag = informative ? ["--informative-errors"] : [];
        const answers: Array<{ native: string[]; ours: string[] }> = [];
        const logs: string[] = [];
        for (const side of ["native", "ours"] as const) {
          writeFileSync(log, "");
          for (const [i, line] of lines.entries()) {
            const out =
              side === "native"
                ? await nativeExchange([`--access-hook=${hook}`, ...flag], request(line))
                : await oursExchange(
                    {
                      accessHook: daemonAccessHookOf(runner(), hook, {
                        files: createNodeFilesApi({ rootDir: "/" }),
                      }),
                      informativeErrors: informative,
                    },
                    {},
                    request(line),
                  );
            answers[i] ??= { native: [], ours: [] };
            (answers[i] as { native: string[]; ours: string[] })[side] = summary(out);
          }
          logs.push(readFileSync(log, "utf8"));
        }
        for (const answer of answers) expect(answer.ours).toEqual(answer.native);
        expect(answers.map((a) => a.native[0])).toEqual([
          `${mainId} HEAD`,
          `ERR ${informative ? "denied by hook" : "access denied or repository not exported"}: /deny.git`,
          `ERR ${informative ? "service rejected" : "access denied or repository not exported"}: /silent`,
          `ERR ${informative ? "no such repository" : "access denied or repository not exported"}: /nowhere.git`,
        ]);
        expect(logs[1]).toBe(logs[0]);
        expect(logs[0]).toBe(
          [
            `6|upload-pack|${srv}/repo.git|127.0.0.1|127.0.0.1|127.0.0.1|9418|${srv}/repo.git`,
            `6|upload-pack|${srv}/deny.git|127.0.0.1|127.0.0.1|127.0.0.1||${srv}/deny.git`,
            `6|upload-pack|${srv}/silent.git|||||${srv}/silent.git`,
            "",
          ].join("\n"),
        );
      });
    }
  });

  it("--init-timeout and --timeout close a silent client's connection", async () => {
    // nothing sent: closed without an answer
    const idle = await Promise.all([
      nativeExchange(["--init-timeout=1"], Buffer.alloc(0), true),
      oursExchange({ initTimeout: 1000 }, {}, Buffer.alloc(0), true),
    ]);
    expect(idle[0].length).toBe(0);
    expect(idle[1].length).toBe(0);
    // the request, then silence: the advertisement, then closed
    const line = pkt("git-upload-pack /repo.git\0host=127.0.0.1\0");
    const silent = await Promise.all([
      nativeExchange(["--timeout=1"], line, true),
      oursExchange({ timeout: 1000 }, {}, line, true),
    ]);
    expect(summary(silent[0])).toEqual(advertised());
    expect(summary(silent[1])).toEqual(summary(silent[0]));
  });

  describe("--max-connections", () => {
    /** A client connection: what it received, whether the daemon closed it. */
    interface Client {
      socket: Socket;
      data: Buffer[];
      closed: Promise<void>;
      received: Promise<void>;
    }
    const open = (port: number): Promise<Client> =>
      new Promise((resolve, reject) => {
        const socket = connect({ port, host: "127.0.0.1", allowHalfOpen: true });
        const data: Buffer[] = [];
        let gotData: () => void = () => {};
        const received = new Promise<void>((r) => {
          gotData = r;
        });
        socket.on("data", (d: Buffer) => {
          data.push(d);
          gotData();
        });
        socket.on("end", () => socket.end());
        socket.on("error", () => {});
        const closed = new Promise<void>((r) => socket.once("close", () => r()));
        socket.once("connect", () => resolve({ socket, data, closed, received }));
        socket.once("error", reject);
      });
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const within = <T>(p: Promise<T>, ms: number) =>
      Promise.race([p.then(() => true), sleep(ms).then(() => false)]);
    const line = pkt("git-upload-pack /repo.git\0host=127.0.0.1\0");
    const finish = async (client: Client) => {
      client.socket.write(line);
      client.socket.end(Buffer.from("0000"));
      await within(client.closed, 10_000);
      return summary(Buffer.concat(client.data));
    };

    /** What each client of a scenario saw, against a daemon listening on `port`. */
    const scenarios: Record<string, (port: number) => Promise<string[]>> = {
      // max 1: a second client is dropped (no other connection of its address to cut off)
      async dropped(port) {
        const a = await open(port);
        await sleep(300);
        const b = await open(port);
        const bClosed = await within(b.closed, 5000);
        return [`b closed ${bClosed} with ${b.data.length} packets`, ...(await finish(a))];
      },
      // max 2: the newest idle connection of the address is cut off, the new one served
      async killed(port) {
        const a = await open(port);
        await sleep(300);
        const b = await open(port);
        await sleep(300);
        const c = await open(port);
        const bClosed = await within(b.closed, 5000);
        return [
          `b closed ${bClosed} with ${b.data.length} packets`,
          ...(await finish(c)),
          ...(await finish(a)),
        ];
      },
      // max 2: a connection being served is not cut off: the new one is dropped
      async served(port) {
        const a = await open(port);
        await sleep(300);
        const b = await open(port);
        b.socket.write(line);
        await within(b.received, 5000);
        const c = await open(port);
        const cClosed = await within(c.closed, 5000);
        b.socket.end(Buffer.from("0000"));
        await within(b.closed, 5000);
        a.socket.end();
        return [
          `c closed ${cClosed} with ${c.data.length} packets`,
          ...summary(Buffer.concat(b.data)),
        ];
      },
    };
    const limits: Record<string, number> = { dropped: 1, killed: 2, served: 2 };

    async function freePort(): Promise<number> {
      const server = createServer();
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const address = server.address();
      await new Promise<void>((r) => server.close(() => r()));
      return typeof address === "object" && address ? address.port : 0;
    }

    async function nativeDaemon(max: number): Promise<{ port: number; child: ChildProcess }> {
      const port = await freePort();
      const child = spawn(
        "git",
        [
          "daemon",
          "--listen=127.0.0.1",
          `--port=${port}`,
          "--reuseaddr",
          "--verbose",
          "--log-destination=stderr",
          "--export-all",
          `--base-path=${srv}`,
          `--max-connections=${max}`,
          srv,
        ],
        { env: testEnv(root) },
      );
      await new Promise<void>((resolve, reject) => {
        let err = "";
        const timer = setTimeout(
          () => reject(new Error(`git daemon did not start: ${err}`)),
          10_000,
        );
        child.stderr?.on("data", (d: Buffer) => {
          err += d.toString();
          if (err.includes("Ready to rumble")) {
            clearTimeout(timer);
            resolve();
          }
        });
      });
      return { port, child };
    }

    /** Our daemon behind the socket adapter: each connection a port, its peer's address. */
    async function ourDaemon(max: number): Promise<{ port: number; server: SocketPortServer }> {
      const daemon = createGitDaemon({
        maxConnections: max,
        resolveRepository: resolverOf({ exportAll: true }),
      });
      const server = await listenSocketPorts({ host: "127.0.0.1", port: 0 }, (port, peer) => {
        void daemon.serve(port, {
          ...(peer.remoteAddress !== undefined ? { remoteAddress: peer.remoteAddress } : {}),
          remotePort: String(peer.remotePort),
        });
      });
      const address = server.address;
      return { port: typeof address === "object" ? address.port : 0, server };
    }

    for (const name of Object.keys(scenarios)) {
      it(`${name} (max ${limits[name]})`, async () => {
        const max = limits[name] as number;
        const scenario = scenarios[name] as (port: number) => Promise<string[]>;
        const native = await nativeDaemon(max);
        let nativeSeen: string[];
        try {
          nativeSeen = await scenario(native.port);
        } finally {
          native.child.kill();
        }
        const ours = await ourDaemon(max);
        let oursSeen: string[];
        try {
          oursSeen = await scenario(ours.port);
        } finally {
          await ours.server.close();
        }
        const adv = advertised();
        const expected: Record<string, string[]> = {
          dropped: ["b closed true with 0 packets", ...adv],
          killed: ["b closed true with 0 packets", ...adv, ...adv],
          served: ["c closed true with 0 packets", ...adv],
        };
        expect(nativeSeen).toEqual(expected[name]);
        expect(oursSeen).toEqual(nativeSeen);
      }, 60_000);
    }
  });
});
