/**
 * The v2 `promisor-remote` capability (git 2.49+) against native git, after t5710: a bare
 * "server" whose large blob lives only in "lop" (a Large Object Promisor it names as a
 * promisor remote) advertises lop under `promisor.advertise`; a client accepting it (per
 * `promisor.acceptFromServer`, `promisor.checkFields`) names it in its `ls-refs` request,
 * stores what `promisor.storeFields` asks for, and fetches the blob from lop itself, so the
 * server never needs it. Each scenario runs on a fresh copy of the server, once with native
 * git's clone and once with ours, both over git:// to `git daemon`, and compares the client's
 * config, the `promisor-remote=` line the server read, git's stderr lines and whether the
 * server had to fetch the blob. The second part has our server advertise to native clients.
 *
 * git 2.43 has no promisor-remote capability: these twins need 2.49 (fields 2.52, stored
 * fields and `--filter=auto` 2.54, `promisor.acceptFromServerUrl` 2.56).
 */
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createBasePathResolver,
  createDefaultTransports,
  serveGitConnection,
} from "@statewalker/vcs-transport";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openLocalRemote } from "../src/commands/local-transport.js";
import { type Git, servedRepositoryOf } from "../src/index.js";
import { openOurs } from "./merge-native-helpers.js";
import { childDuplex, daemonArgs, gitAsync, startTcpServer } from "./native-connect-support.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { gitOut, testEnv } from "./status-native-support.js";
import { CLEANUP_TIMEOUT, removeTempDir } from "./temp-dir-support.js";

const nativeVersion = (() => {
  if (!nativeGitAvailable()) return 0;
  const m = /git version (\d+)\.(\d+)/.exec(execFileSync("git", ["--version"]).toString());
  return m ? Number(m[1]) * 100 + Number(m[2]) : 0;
})();
// promisor-remote came with git 2.49; 2.43 neither advertises nor accepts
const describeGit = nativeVersion >= 249 && process.platform === "linux" ? describe : describe.skip;
const itFields = nativeVersion >= 252 ? it : it.skip; // promisor.sendFields, checkFields
const itStore = nativeVersion >= 254 ? it : it.skip; // promisor.storeFields
const itAuto = nativeVersion >= 254 ? it : it.skip; // clone/fetch --filter=auto
const itUrl = nativeVersion >= 256 ? it : it.skip; // promisor.acceptFromServerUrl

let root: string;
let lopUrl: string;
let largeOid: string;
let barOid: string;
let counter = 0;
const git = (cwd: string, ...args: string[]) => gitOut(root, cwd, args);
const env = (extra: Record<string, string> = {}) => ({ GIT_NO_LAZY_FETCH: "0", ...extra });

/** Ten KiB of fixed pseudo-random bytes (t5710's `test-tool genrandom foo 10k`). */
function largeContent(): Buffer {
  const out = Buffer.alloc(10240);
  let x = 0x2545f491;
  for (let i = 0; i < out.length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

/** The objects the server lacks (t5710's check_missing_objects). */
function missingOnServer(): string[] {
  return git(join(root, "server"), "rev-list", "--objects", "--all", "--missing=print")
    .split("\n")
    .filter((l) => l.startsWith("?"))
    .map((l) => l.slice(1));
}

/** A fresh server (the large blob missing again, as t5710's initialize_server), configured. */
function freshServer(config: string[][] = [], pristine = "server.pristine"): void {
  rmSync(join(root, "server"), { recursive: true, force: true });
  execFileSync("cp", ["-a", join(root, pristine), join(root, "server")]);
  for (const args of config) git(join(root, "server"), "config", ...args);
}

/** The `promisor-remote=` lines upload-pack read, from its GIT_TRACE_PACKET. */
function acceptedLines(trace: string): string[] {
  let text = "";
  try {
    text = readFileSync(trace, "latin1");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .map((l) => /packet:\s+upload-pack< (promisor-remote=.*)$/.exec(l)?.[1])
    .filter((l): l is string => l !== undefined);
}

/** The `filter` lines upload-pack read, from its GIT_TRACE_PACKET. */
function filterLines(trace: string): string[] {
  let text = "";
  try {
    text = readFileSync(trace, "latin1");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .map((l) => /packet:\s+upload-pack< (filter .*)$/.exec(l)?.[1])
    .filter((l): l is string => l !== undefined);
}

/** git's lines this capability prints (warnings, stored fields). */
const promisorLines = (stderr: string) =>
  stderr
    .split("\n")
    .filter((l) => /promisor|remote named|Storing new|^ {4}'|unsupported field|filter '/.test(l));

interface Outcome {
  config: string;
  accepted: string[];
  stderr: string[];
  missing: string[];
  status: number | null;
}

async function ours(name: string): Promise<Git> {
  return openOurs(
    root,
    createNodeGitHostEnvironment({ env: testEnv(root, env()) }),
    undefined,
    name,
  );
}

/** Our transports: each connection a `git daemon --inetd` tracing its packets to `trace`. */
const daemonTransports = (trace: string) =>
  createDefaultTransports({
    openSocket: async () =>
      childDuplex(
        spawn("git", daemonArgs(root, false), {
          env: testEnv(root, env({ GIT_TRACE_PACKET: trace })),
        }),
      ),
  });

/** The environment of a native client reaching `git daemon` through the proxy. */
const proxied = (trace: string, extra: Record<string, string> = {}) =>
  env({ GIT_PROXY_COMMAND: join(root, "proxy"), SERVER_TRACE: trace, ...extra });

/** The scenario's clone by native git and by ours, each against a fresh server. */
async function cloneTwins(
  clientConfig: string[],
  serverConfig: string[][] = [],
  filter = "blob:limit=5k",
): Promise<{ native: Outcome; ours: Outcome }> {
  const k = counter++;
  const outcome = async (side: "n" | "o"): Promise<Outcome> => {
    freshServer(serverConfig);
    const dir = `${side}${k}`;
    const trace = join(root, `${dir}.trace`);
    let status: number | null;
    let stderr: string;
    if (side === "n") {
      const run = await gitAsync(
        root,
        root,
        [
          "clone",
          ...clientConfig.flatMap((c) => ["-c", c]),
          `--filter=${filter}`,
          "git://localhost/server",
          dir,
        ],
        env({ GIT_PROXY_COMMAND: join(root, "proxy"), SERVER_TRACE: trace }),
      );
      status = run.status;
      stderr = run.stderr;
    } else {
      mkdirSync(join(root, dir));
      git(join(root, dir), "init", "-q");
      const transports = createDefaultTransports({
        openSocket: async () =>
          childDuplex(
            spawn("git", daemonArgs(root, false), {
              env: testEnv(root, env({ GIT_TRACE_PACKET: trace })),
            }),
          ),
      });
      try {
        const result = await (await ours(dir))
          .clone()
          .setURI("git://localhost/server")
          .setConfig(clientConfig)
          .setFilter(filter)
          .setTransports(transports)
          .call();
        status = 0;
        stderr = (result.messages ?? []).join("");
      } catch (error) {
        status = 128;
        stderr = String(error);
      }
    }
    let config = "";
    try {
      config = readFileSync(join(root, dir, ".git", "config"), "utf8");
    } catch {}
    return {
      config,
      accepted: acceptedLines(trace),
      stderr: promisorLines(stderr),
      missing: missingOnServer(),
      status,
    };
  };
  const native = await outcome("n");
  const oursOutcome = await outcome("o");
  return { native, ours: oursOutcome };
}

/** The client side of t5710's clones: config, `promisor-remote=` line, lines, server state. */
function expectTwins(t: { native: Outcome; ours: Outcome }): void {
  expect(t.ours.status).toBe(t.native.status);
  expect(t.ours.accepted).toEqual(t.native.accepted);
  expect(t.ours.stderr).toEqual(t.native.stderr);
  expect(t.ours.missing).toEqual(t.native.missing);
  expect(t.ours.config).toBe(t.native.config);
}

const lopClient = (accept: string, extra: string[] = []) => [
  "remote.lop.promisor=true",
  "remote.lop.fetch=+refs/heads/*:refs/remotes/lop/*",
  `remote.lop.url=${lopUrl}`,
  ...extra,
  `promisor.acceptfromserver=${accept}`,
];

// t5710's server has lazily fetched from lop by then: partial_clone_register gave it a filter
const otherLop = [
  ["remote.lop.partialCloneFilter", "blob:none"],
  ["remote.otherLop.url", "https://invalid.invalid"],
  ["remote.otherLop.fetch", "+refs/heads/*:refs/remotes/otherLop/*"],
  ["remote.otherLop.token", "fooBar"],
  ["remote.otherLop.stuff", "baz"],
  ["remote.otherLop.partialCloneFilter", "blob:limit=10k"],
];

describeGit("promisor-remote capability (t5710) against native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "promisor-cap-"));
    lopUrl = `file://${root}/lop`;
    writeFileSync(
      join(root, "proxy"),
      `#!/bin/sh\nGIT_TRACE_PACKET="$SERVER_TRACE" exec git ${daemonArgs(root, false)
        .map((a) => `'${a}'`)
        .join(" ")} 2>/dev/null\n`,
    );
    chmodSync(join(root, "proxy"), 0o755);
    const template = join(root, "template");
    git(root, "init", "-q", "-b", "main", template);
    for (const n of [1, 2, 3]) {
      writeFileSync(join(template, `${n}.t`), `${n}\n`);
      git(template, "add", `${n}.t`);
      git(template, "commit", "-qm", `${n}`);
    }
    writeFileSync(join(template, "foo"), largeContent());
    git(template, "add", "foo");
    git(template, "commit", "-qm", "foo");
    largeOid = git(template, "rev-parse", "HEAD:foo").trim();

    // "lop" holds the large blob alone
    git(root, "init", "-q", "--bare", "lop");
    const lop = join(root, "lop");
    git(lop, "hash-object", "-w", join(template, "foo"));
    git(lop, "config", "uploadpack.allowFilter", "true");
    git(lop, "config", "uploadpack.allowAnySHA1InWant", "true");

    // the server: everything but the large blob, in a promisor pack (initialize_server)
    const buildServer = (name: string, filtered: string) => {
      git(root, "clone", "-q", "--bare", "--no-local", template, name);
      const server = join(root, name);
      mkdirSync(join(root, filtered));
      git(
        server,
        "-c",
        "repack.writebitmaps=false",
        "repack",
        "-a",
        "-d",
        "-q",
        "--filter=blob:limit=5k",
        `--filter-to=${join(root, filtered, "pack")}`,
      );
      for (const pack of execFileSync("ls", [join(server, "objects", "pack")])
        .toString()
        .split("\n")) {
        if (pack.endsWith(".pack")) {
          writeFileSync(join(server, "objects", "pack", pack.replace(/\.pack$/, ".promisor")), "");
        }
      }
      git(server, "remote", "add", "lop", lopUrl);
      git(server, "config", "remote.lop.promisor", "true");
      git(server, "config", "uploadpack.allowFilter", "true");
      git(server, "config", "uploadpack.allowAnySHA1InWant", "true");
      git(server, "config", "promisor.advertise", "true");
    };
    buildServer("server.pristine", "filtered");
    // "setup for subsequent fetches": a later commit adds another large blob, `bar`, which
    // the server lacks too and lop holds
    const bar = Buffer.from(largeContent().map((b) => b ^ 0x5a));
    writeFileSync(join(template, "bar"), bar);
    git(template, "add", "bar");
    git(template, "commit", "-qm", "bar");
    barOid = git(template, "rev-parse", "HEAD:bar").trim();
    git(lop, "hash-object", "-w", join(template, "bar"));
    buildServer("server2.pristine", "filtered2");
    symlinkSync("lop", join(root, "serverTwo"));
    freshServer();
    expect(missingOnServer()).toEqual([largeOid]);
  });
  afterAll(() => removeTempDir(root), CLEANUP_TIMEOUT);

  describe("our client, git daemon serving", () => {
    it(`t5710-promisor-remote-capability.sh: "clone with promisor.advertise set to 'true'"`, async () => {
      const t = await cloneTwins(lopClient("All"));
      expectTwins(t);
      expect(t.native.accepted).toEqual(["promisor-remote=lop"]);
      expect(t.native.missing).toEqual([largeOid]);
    });

    it(`t5710-promisor-remote-capability.sh: "clone with promisor.advertise set to 'false'"`, async () => {
      const t = await cloneTwins(lopClient("All"), [["promisor.advertise", "false"]]);
      expectTwins(t);
      expect(t.native.accepted).toEqual([]);
      expect(t.native.missing).toEqual([]);
    });

    it(`t5710-promisor-remote-capability.sh: "clone with promisor.acceptfromserver set to 'None'"`, async () => {
      const t = await cloneTwins(lopClient("None"));
      expectTwins(t);
      expect(t.native.missing).toEqual([]);
    });

    it(`t5710-promisor-remote-capability.sh: "clone with promisor.acceptfromserver set to 'KnownName'"`, async () => {
      expectTwins(await cloneTwins(lopClient("KnownName")));
    });

    it(`t5710-promisor-remote-capability.sh: "clone with 'KnownName' and different remote names"`, async () => {
      const t = await cloneTwins([
        "remote.serverTwo.promisor=true",
        "remote.serverTwo.fetch=+refs/heads/*:refs/remotes/lop/*",
        `remote.serverTwo.url=${lopUrl}`,
        "promisor.acceptfromserver=KnownName",
      ]);
      expectTwins(t);
      expect(t.native.accepted).toEqual([]);
    });

    it(`t5710-promisor-remote-capability.sh: "clone with promisor.acceptfromserver set to 'KnownUrl'"`, async () => {
      expectTwins(await cloneTwins(lopClient("KnownUrl")));
    });

    it(`t5710-promisor-remote-capability.sh: "clone with 'KnownUrl' and different remote urls"`, async () => {
      const t = await cloneTwins([
        "remote.lop.promisor=true",
        "remote.lop.fetch=+refs/heads/*:refs/remotes/lop/*",
        `remote.lop.url=file://${root}/serverTwo`,
        "promisor.acceptfromserver=KnownUrl",
      ]);
      expectTwins(t);
      expect(t.native.accepted).toEqual([]);
      expect(t.native.stderr.some((l) => l.includes("known remote named 'lop'"))).toBe(true);
    });

    it(`t5710-promisor-remote-capability.sh: "clone with two promisors but only one advertised"`, async () => {
      git(root, "init", "-q", "--bare", "unused_lop");
      try {
        const t = await cloneTwins([
          "remote.unused_lop.promisor=true",
          "remote.unused_lop.fetch=+refs/heads/*:refs/remotes/unused_lop/*",
          `remote.unused_lop.url=file://${root}/unused_lop`,
          ...lopClient("All"),
        ]);
        expectTwins(t);
        expect(t.native.missing).toEqual([largeOid]);
      } finally {
        rmSync(join(root, "unused_lop"), { recursive: true, force: true });
      }
    });

    it(`t5710-promisor-remote-capability.sh: "init + fetch with promisor.advertise set to 'true'"`, async () => {
      const outcome = async (side: "n" | "o") => {
        freshServer();
        const dir = `${side}${counter++}`;
        const trace = join(root, `${dir}.trace`);
        git(root, "init", "-q", dir);
        const c = join(root, dir);
        git(c, "config", "remote.lop.promisor", "true");
        git(c, "config", "remote.lop.fetch", "+refs/heads/*:refs/remotes/lop/*");
        git(c, "config", "remote.lop.url", lopUrl);
        git(c, "config", "remote.server.url", "git://localhost/server");
        git(c, "config", "remote.server.fetch", "+refs/heads/*:refs/remotes/server/*");
        git(c, "config", "promisor.acceptfromserver", "All");
        if (side === "n") {
          const r = await gitAsync(root, c, ["fetch", "-q", "--filter=blob:limit=5k", "server"], {
            ...env({ GIT_PROXY_COMMAND: join(root, "proxy"), SERVER_TRACE: trace }),
          });
          expect(r.status).toBe(0);
        } else {
          const transports = createDefaultTransports({
            openSocket: async () =>
              childDuplex(
                spawn("git", daemonArgs(root, false), {
                  env: testEnv(root, env({ GIT_TRACE_PACKET: trace })),
                }),
              ),
          });
          await (await ours(dir))
            .fetch()
            .setRemote("server")
            .setFilter("blob:limit=5k")
            .setTransports(transports)
            .call();
        }
        return {
          config: readFileSync(join(c, ".git", "config"), "utf8"),
          accepted: acceptedLines(trace),
          missing: missingOnServer(),
        };
      };
      const native = await outcome("n");
      const oursOutcome = await outcome("o");
      expect(oursOutcome).toEqual(native);
      expect(native.accepted).toEqual(["promisor-remote=lop"]);
    });

    itFields(`t5710-promisor-remote-capability.sh: "clone with promisor.sendFields"`, async () => {
      const t = await cloneTwins(lopClient("All"), [
        ...otherLop,
        ["promisor.sendFields", "partialCloneFilter, token"],
      ]);
      expectTwins(t);
      expect(t.native.accepted).toEqual(["promisor-remote=lop;otherLop"]);
    });

    itFields(`t5710-promisor-remote-capability.sh: "clone with promisor.checkFields"`, async () => {
      const t = await cloneTwins(
        lopClient("All", [
          "remote.lop.partialCloneFilter=blob:none",
          "promisor.checkFields=partialcloneFilter",
        ]),
        [...otherLop, ["promisor.sendFields", "partialCloneFilter, token"]],
      );
      expectTwins(t);
      expect(t.native.accepted).toEqual(["promisor-remote=lop"]);
    });

    itStore(
      `t5710-promisor-remote-capability.sh: "clone with promisor.storeFields=partialCloneFilter"`,
      async () => {
        const t = await cloneTwins(
          lopClient("All", [
            "remote.lop.token=fooYYY",
            "remote.lop.partialCloneFilter=blob:none",
            "promisor.storeFields=partialcloneFilter",
          ]),
          [
            ...otherLop,
            ["remote.lop.token", "fooXXX"],
            ["remote.lop.partialCloneFilter", "blob:limit=8k"],
            ["promisor.sendFields", "partialCloneFilter, token"],
          ],
        );
        expectTwins(t);
        expect(t.native.stderr).toContain("Storing new filter from server for remote 'lop'.");
        expect(t.native.config).toContain("blob:limit=8k");
      },
    );

    it(`t5710-promisor-remote-capability.sh: "clone with 'KnownName' and missing URL in the config"`, async () => {
      const t = await cloneTwins([
        "remote.lop.promisor=true",
        "promisor.acceptfromserver=KnownName",
      ]);
      expectTwins(t);
      expect(t.native.accepted).toEqual([]);
      expect(t.native.missing).toEqual([]);
    });

    /** A clone both fail: the same status, line sent and server state (native removes its client). */
    const expectFailedTwins = (t: { native: Outcome; ours: Outcome }) => {
      expect(t.native.status).not.toBe(0);
      expect(t.ours.status).not.toBe(0);
      expect(t.ours.accepted).toEqual(t.native.accepted);
      expect(t.ours.missing).toEqual(t.native.missing);
    };

    it(`t5710-promisor-remote-capability.sh: "clone with 'KnownUrl' and url not configured on the server"`, async () => {
      const t = await cloneTwins(lopClient("KnownUrl"), [["--unset", "remote.lop.url"]]);
      expectFailedTwins(t);
      expect(t.native.accepted).toEqual([]);
      expect(t.native.missing).toEqual([largeOid]);
    });

    it(`t5710-promisor-remote-capability.sh: "clone with 'KnownUrl' and empty url, so not advertised"`, async () => {
      const t = await cloneTwins(lopClient("KnownUrl"), [["remote.lop.url", ""]]);
      expectFailedTwins(t);
      expect(t.native.missing).toEqual([largeOid]);
    });

    // the URL allowlist (git 2.56): t5710's `$ENCODED_TRASH_DIRECTORY_URL/*`
    const allowAll = () => `promisor.acceptFromServerUrl=file://${root}/*`;
    const lopNone = (url = lopUrl) => [
      "remote.lop.promisor=true",
      "remote.lop.fetch=+refs/heads/*:refs/remotes/lop/*",
      `remote.lop.url=${url}`,
      "promisor.acceptfromserver=None",
    ];

    itUrl(
      `t5710-promisor-remote-capability.sh: "clone with 'None' but URL allowlisted"`,
      async () => {
        const t = await cloneTwins([...lopNone(), allowAll()]);
        expectTwins(t);
        expect(t.native.accepted).toEqual(["promisor-remote=lop"]);
        expect(t.native.missing).toEqual([largeOid]);
      },
    );

    itUrl(
      `t5710-promisor-remote-capability.sh: "clone with 'None' but URL not in allowlist"`,
      async () => {
        const t = await cloneTwins([
          ...lopNone(),
          "promisor.acceptFromServerUrl=https://example.com/*",
        ]);
        expectTwins(t);
        expect(t.native.missing).toEqual([]);
      },
    );

    itUrl(
      `t5710-promisor-remote-capability.sh: "clone with 'None' but URL allowlisted in one pattern out of two"`,
      async () => {
        const t = await cloneTwins([
          ...lopNone(),
          "promisor.acceptFromServerUrl=https://example.com/*",
          allowAll(),
        ]);
        expectTwins(t);
        expect(t.native.missing).toEqual([largeOid]);
      },
    );

    itUrl(
      `t5710-promisor-remote-capability.sh: "clone with 'None', URL allowlisted, but client has different URL"`,
      async () => {
        const t = await cloneTwins([...lopNone(`file://${root}/serverTwo`), allowAll()]);
        expectTwins(t);
        expect(t.native.accepted).toEqual([]);
        expect(t.native.missing).toEqual([]);
      },
    );

    itUrl(
      `t5710-promisor-remote-capability.sh: "clone with URL allowlisted and no remote already configured"`,
      async () => {
        const t = await cloneTwins(["promisor.acceptfromserver=None", allowAll()]);
        expectTwins(t);
        expect(t.native.config).toMatch(/\[remote "promisor-auto-[^"]+-lop"\]/);
        expect(t.native.config).toContain("advertisedAs = lop");
        expect(t.native.missing).toEqual([largeOid]);
      },
    );

    itUrl(
      `t5710-promisor-remote-capability.sh: "clone with named URL allowlisted and no pre-configured remote"`,
      async () => {
        const t = await cloneTwins([
          "promisor.acceptfromserver=None",
          `promisor.acceptFromServerUrl=cdn=file://${root}/*`,
        ]);
        expectTwins(t);
        expect(t.native.config).toContain('[remote "cdn"]');
        expect(t.native.missing).toEqual([largeOid]);
      },
    );

    itUrl(
      `t5710-promisor-remote-capability.sh: "clone with URL allowlisted but colliding name"`,
      async () => {
        const t = await cloneTwins([
          "remote.cdn.promisor=true",
          "remote.cdn.fetch=+refs/heads/*:refs/remotes/lop/*",
          "remote.cdn.url=https://example.com/cdn",
          "promisor.acceptfromserver=None",
          `promisor.acceptFromServerUrl=cdn=file://${root}/*`,
        ]);
        expectTwins(t);
        expect(t.native.config).toContain('[remote "cdn-1"]');
        expect(t.native.missing).toEqual([largeOid]);
      },
    );

    itUrl(
      `t5710-promisor-remote-capability.sh: "clone with URL allowlisted and reusable remote"`,
      async () => {
        const t = await cloneTwins([
          "remote.cdn.fetch=+refs/heads/*:refs/remotes/lop/*",
          `remote.cdn.url=${lopUrl}`,
          "promisor.acceptfromserver=None",
          `promisor.acceptFromServerUrl=cdn=file://${root}/*`,
        ]);
        expectTwins(t);
        expect(t.native.config).not.toContain('[remote "cdn-1"]');
        expect(t.native.missing).toEqual([largeOid]);
      },
    );

    itUrl(
      `t5710-promisor-remote-capability.sh: "clone with invalid promisor.acceptFromServerUrl"`,
      async () => {
        const t = await cloneTwins([
          "promisor.acceptfromserver=None",
          "promisor.acceptFromServerUrl=bad name=https://example.com/*",
        ]);
        expectTwins(t);
        expect(t.native.stderr.some((l) => l.includes("invalid remote name 'bad name'"))).toBe(
          true,
        );
        expect(t.native.missing).toEqual([]);
      },
    );

    itAuto(
      `t5710-promisor-remote-capability.sh: "clone and fetch with --filter=auto"`,
      async () => {
        const outcome = async (side: "n" | "o") => {
          freshServer([
            ["remote.lop.partialCloneFilter", "blob:limit=9500"],
            ["promisor.sendFields", "partialCloneFilter"],
          ]);
          const server = join(root, "server");
          const dir = `${side}${counter++}`;
          const c = join(root, dir);
          const clientConfig = [
            "remote.lop.promisor=true",
            `remote.lop.url=${lopUrl}`,
            "promisor.acceptfromserver=All",
          ];
          const traces: string[] = [];
          const step = async (args: "clone" | string[]) => {
            const trace = join(root, `${dir}.${traces.length}.trace`);
            traces.push(trace);
            if (side === "n") {
              const r =
                args === "clone"
                  ? await gitAsync(
                      root,
                      root,
                      [
                        "clone",
                        ...clientConfig.flatMap((v) => ["-c", v]),
                        "--filter=auto",
                        "git://localhost/server",
                        dir,
                      ],
                      proxied(trace),
                    )
                  : await gitAsync(root, c, ["fetch", ...args], proxied(trace));
              expect(r.status, r.stderr).toBe(0);
            } else if (args === "clone") {
              mkdirSync(c);
              git(c, "init", "-q");
              await (await ours(dir))
                .clone()
                .setURI("git://localhost/server")
                .setConfig(clientConfig)
                .setFilter("auto")
                .setTransports(daemonTransports(trace))
                .call();
            } else {
              const fetch = (await ours(dir)).fetch().setTransports(daemonTransports(trace));
              if (args.length > 0) fetch.setFilter("auto");
              await fetch.call();
            }
          };
          /** A new commit on the server, so that a fetch runs fetch-pack */
          const newCommit = (message: string) => {
            const head = git(server, "rev-parse", "refs/heads/main").trim();
            const id = git(server, "commit-tree", "-p", head, "-m", message, `${head}^{tree}`);
            git(server, "update-ref", "refs/heads/main", id.trim());
          };
          await step("clone");
          const config = readFileSync(join(c, ".git", "config"), "utf8");
          const missing = [missingOnServer()];
          git(server, "config", "remote.lop.partialCloneFilter", "blob:limit=5678");
          newCommit("new-commit");
          await step(["--filter=auto"]);
          missing.push(missingOnServer());
          git(server, "config", "remote.lop.partialCloneFilter", "blob:limit=5432");
          newCommit("yet-a-new-commit");
          await step([]);
          missing.push(missingOnServer());
          return { config, filters: traces.map(filterLines), missing };
        };
        const native = await outcome("n");
        const oursOutcome = await outcome("o");
        expect(native.filters).toEqual([
          ["filter blob:limit=9500"],
          ["filter blob:limit=5678"],
          ["filter blob:limit=5432"],
        ]);
        expect(native.config).toContain("partialclonefilter = auto");
        expect(oursOutcome).toEqual(native);
      },
    );

    it(`t5710-promisor-remote-capability.sh: "init + fetch two promisors but only one advertised"`, async () => {
      const outcome = async (side: "n" | "o") => {
        freshServer();
        git(root, "init", "-q", "--bare", "unused_lop");
        const dir = `${side}${counter++}`;
        const trace = join(root, `${dir}.trace`);
        git(root, "init", "-q", dir);
        const c = join(root, dir);
        const set = (k: string, v: string) => git(c, "config", k, v);
        set("remote.unused_lop.promisor", "true");
        set("remote.unused_lop.fetch", "+refs/heads/*:refs/remotes/unused_lop/*");
        set("remote.unused_lop.url", `file://${root}/unused_lop`);
        set("remote.lop.promisor", "true");
        set("remote.lop.fetch", "+refs/heads/*:refs/remotes/lop/*");
        set("remote.lop.url", lopUrl);
        set("remote.server.url", "git://localhost/server");
        set("remote.server.fetch", "+refs/heads/*:refs/remotes/server/*");
        set("promisor.acceptfromserver", "All");
        let lazy: string[] = [];
        if (side === "n") {
          const r = await gitAsync(
            root,
            c,
            ["fetch", "-q", "--filter=blob:limit=5k", "server"],
            proxied(trace, { GIT_TRACE: join(root, `${dir}.client-trace`) }),
          );
          expect(r.status, r.stderr).toBe(0);
          // the fetch itself never needs the blob: no promisor remote is fetched from
          lazy = readFileSync(join(root, `${dir}.client-trace`), "utf8")
            .split("\n")
            .filter((l) => / fetch (unused_)?lop /.test(l));
        } else {
          const ourGit = await ours(dir);
          await ourGit
            .fetch()
            .setRemote("server")
            .setFilter("blob:limit=5k")
            .setTransports(daemonTransports(trace))
            .call();
        }
        const result = {
          config: readFileSync(join(c, ".git", "config"), "utf8"),
          accepted: acceptedLines(trace),
          missing: missingOnServer(),
          lazy,
        };
        rmSync(join(root, "unused_lop"), { recursive: true, force: true });
        return result;
      };
      const native = await outcome("n");
      const oursOutcome = await outcome("o");
      expect(oursOutcome).toEqual(native);
      expect(native.accepted).toEqual(["promisor-remote=lop"]);
      expect(native.lazy).toEqual([]);
      expect(native.missing).toEqual([largeOid]);
    });

    it(`t5710-promisor-remote-capability.sh: "init + fetch two promisors but only one advertised" (the accepted remote first)`, async () => {
      // within the fetching process (git's r->accepted), a lazy fetch tries the accepted lop
      // before unused_lop, which comes first in the configuration: the child fetch registers
      // the filter of the remote it tries (partial_clone_register), so only lop gets one
      freshServer();
      git(root, "init", "-q", "--bare", "unused_lop");
      const dir = `o${counter++}`;
      git(root, "init", "-q", dir);
      const c = join(root, dir);
      git(c, "config", "remote.unused_lop.promisor", "true");
      git(c, "config", "remote.unused_lop.url", `file://${root}/unused_lop`);
      git(c, "config", "remote.lop.promisor", "true");
      git(c, "config", "remote.lop.url", lopUrl);
      git(c, "config", "remote.server.url", "git://localhost/server");
      git(c, "config", "remote.server.fetch", "+refs/heads/*:refs/remotes/server/*");
      git(c, "config", "promisor.acceptfromserver", "All");
      try {
        const ourGit = await ours(dir);
        await ourGit
          .fetch()
          .setRemote("server")
          .setFilter("blob:limit=5k")
          .setTransports(daemonTransports(join(root, `${dir}.trace`)))
          .call();
        const blob = await ourGit.workingCopy.history.objects?.get(largeOid);
        expect(blob).toBeDefined();
        const config = readFileSync(join(c, ".git", "config"), "utf8");
        expect(config).toContain('[remote "lop"]\n\tpromisor = true\n\turl = ');
        expect(config).toMatch(/\[remote "lop"\][^[]*partialclonefilter = blob:none/);
        expect(config).not.toMatch(/\[remote "unused_lop"\][^[]*partialclonefilter/);
      } finally {
        rmSync(join(root, "unused_lop"), { recursive: true, force: true });
      }
    });

    /** A clone, then a pull of a commit adding `bar` (t5710's subsequent fetches). */
    async function subsequentTwins(advertise: boolean) {
      const outcome = async (side: "n" | "o") => {
        freshServer();
        const dir = `${side}${counter++}`;
        const c = join(root, dir);
        const trace = join(root, `${dir}.trace`);
        if (side === "n") {
          const r = await gitAsync(
            root,
            root,
            [
              "clone",
              ...lopClient("All").flatMap((v) => ["-c", v]),
              "--filter=blob:limit=5k",
              "git://localhost/server",
              dir,
            ],
            proxied(join(root, `${dir}.clone-trace`)),
          );
          expect(r.status, r.stderr).toBe(0);
        } else {
          mkdirSync(c);
          git(c, "init", "-q");
          await (await ours(dir))
            .clone()
            .setURI("git://localhost/server")
            .setConfig(lopClient("All"))
            .setFilter("blob:limit=5k")
            .setTransports(daemonTransports(join(root, `${dir}.clone-trace`)))
            .call();
        }
        freshServer([["promisor.advertise", String(advertise)]], "server2.pristine");
        if (side === "n") {
          const r = await gitAsync(root, c, ["pull", "-q", "origin"], proxied(trace));
          expect(r.status, r.stderr).toBe(0);
        } else {
          await (await ours(dir))
            .pull()
            .setRemote("origin")
            .setTransports(daemonTransports(trace))
            .call();
        }
        return {
          config: readFileSync(join(c, ".git", "config"), "utf8"),
          head: git(c, "rev-parse", "HEAD").trim(),
          bar: readFileSync(join(c, "bar")).equals(readFileSync(join(root, "template", "bar"))),
          accepted: acceptedLines(trace),
          missing: missingOnServer(),
        };
      };
      const native = await outcome("n");
      const oursOutcome = await outcome("o");
      expect(oursOutcome).toEqual(native);
      expect(native.head).toBe(git(join(root, "template"), "rev-parse", "HEAD").trim());
      expect(native.bar).toBe(true);
      return native;
    }

    it(`t5710-promisor-remote-capability.sh: "subsequent fetch from a client when promisor.advertise is true"`, async () => {
      const native = await subsequentTwins(true);
      expect(native.accepted).toEqual(["promisor-remote=lop"]);
      expect(native.missing.sort()).toEqual([largeOid, barOid].sort());
    });

    it(`t5710-promisor-remote-capability.sh: "subsequent fetch from a client when promisor.advertise is false"`, async () => {
      const native = await subsequentTwins(false);
      expect(native.accepted).toEqual([]);
      // the server fetched bar from lop itself
      expect(native.missing).toEqual([largeOid]);
    });
  });

  describe("our server, native clients", () => {
    /** The advertisement a native clone read, from its GIT_TRACE_PACKET. */
    const advertised = (trace: string) =>
      readFileSync(trace, "latin1")
        .split("\n")
        .map((l) => /packet:\s+clone< (promisor-remote=.*)$/.exec(l)?.[1])
        .filter((l): l is string => l !== undefined);

    async function serverTwins(clientConfig: string[], serverConfig: string[][] = []) {
      const k = counter++;
      const host = await ours(`host${k}`).catch(async () => {
        mkdirSync(join(root, `host${k}`));
        git(join(root, `host${k}`), "init", "-q");
        return ours(`host${k}`);
      });
      const resolveRepository = createBasePathResolver({
        files: createNodeFilesApi({ rootDir: root }),
        exportAll: true,
        openRepository: async (gitDir) => {
          const opened = await openLocalRemote(host.workingCopy, `..${gitDir}`).catch(
            () => undefined,
          );
          return opened && servedRepositoryOf(opened);
        },
      });
      const served = await startTcpServer((duplex) =>
        serveGitConnection({ duplex, resolveRepository }),
      );
      const run = async (url: string, dir: string, extra: Record<string, string>) => {
        freshServer(serverConfig);
        const trace = join(root, `${dir}.trace`);
        const r = await gitAsync(
          root,
          root,
          ["clone", ...clientConfig.flatMap((c) => ["-c", c]), "--filter=blob:limit=5k", url, dir],
          env({ GIT_TRACE_PACKET: trace, ...extra }),
        );
        return {
          status: r.status,
          advertised: advertised(trace),
          stderr: promisorLines(r.stderr),
          missing: missingOnServer(),
          config: (() => {
            try {
              return readFileSync(join(root, dir, ".git", "config"), "utf8");
            } catch {
              return "";
            }
          })(),
        };
      };
      try {
        const native = await run("git://localhost/server", `sn${k}`, {
          GIT_PROXY_COMMAND: join(root, "proxy"),
          SERVER_TRACE: join(root, `sn${k}.server-trace`),
        });
        const oursRun = await run(`git://127.0.0.1:${served.port}/server`, `so${k}`, {});
        return { native, ours: oursRun };
      } finally {
        await served.close();
      }
    }

    it(`t5710-promisor-remote-capability.sh: "clone with promisor.advertise set to 'true'"`, async () => {
      const t = await serverTwins(lopClient("All"));
      expect(t.ours.status).toBe(t.native.status);
      expect(t.ours.advertised).toEqual(t.native.advertised);
      expect(t.native.advertised).toEqual([`promisor-remote=name=lop,url=${lopUrl}`]);
      expect(t.ours.missing).toEqual(t.native.missing);
      // only remote.origin.url differs (the port of our server)
      expect(t.ours.config.replace(/127\.0\.0\.1:\d+/, "localhost")).toBe(t.native.config);
    });

    itFields(`t5710-promisor-remote-capability.sh: "clone with promisor.sendFields"`, async () => {
      const t = await serverTwins(lopClient("All"), [
        ...otherLop,
        ["promisor.sendFields", "partialCloneFilter, token"],
      ]);
      expect(t.ours.status).toBe(t.native.status);
      expect(t.ours.advertised).toEqual(t.native.advertised);
      expect(t.ours.missing).toEqual(t.native.missing);
    });

    it(`t5710-promisor-remote-capability.sh: "clone with promisor.advertise set to 'false'"`, async () => {
      const t = await serverTwins(lopClient("All"), [["promisor.advertise", "false"]]);
      expect(t.ours.advertised).toEqual([]);
      expect(t.native.advertised).toEqual([]);
    });
  });
});
