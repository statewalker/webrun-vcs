/**
 * Twins of `git cat-file --batch-command`'s `remote-object-info` (git 2.56's t1017) and of
 * the v2 `object-info` command it sends (t5701), shared by `cat-file-remote-object-info-native`
 * (the git on PATH) and its `-git3-native` twin (`$GIT3`, git master).
 *
 * Every scenario runs through each server: native upload-pack over file://, `git daemon`,
 * native `git http-backend`, and ours over git:// and smart HTTP. The native client (when it
 * has `remote-object-info`: 2.56 and later) and ours ask each one; both must print what t1017
 * expects. Our client against a native server needs a server that answers `size` and `type`
 * (2.56: 2.43 advertises a bare `object-info`).
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createBasePathResolver,
  createDefaultTransports,
  createServedFetchHandler,
  type GitTransportRegistry,
  serveGitConnection,
} from "@statewalker/vcs-transport";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openLocalRemote } from "../src/commands/local-transport.js";
import { type Git, servedRepositoryOf } from "../src/index.js";
import { type LoopbackServer, serveOnLoopback } from "./http-loopback-support.js";
import { openOurs } from "./merge-native-helpers.js";
import { daemonOpener, openTcpSocket, startTcpServer } from "./native-connect-support.js";
import { nativeGitHttpBackend } from "./native-git-http-backend.js";
import { testEnv } from "./status-native-support.js";
import { CLEANUP_TIMEOUT, removeTempDir } from "./temp-dir-support.js";

/** One run of `git cat-file --batch-command`: its exit status, stdout and fatal line. */
interface Run {
  status: number;
  stdout: string;
  fatal: string | undefined;
}

/** Runs `bin` with `input` on stdin, without blocking the event loop (our servers answer it). */
function runNative(
  bin: string,
  home: string,
  cwd: string,
  args: string[],
  input: string,
): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, env: testEnv(home) });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("latin1");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("latin1");
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    child.on("close", (status) =>
      resolve({ status: status ?? -1, stdout, fatal: fatalLine(stderr) }),
    );
  });
}

function fatalLine(stderr: string): string | undefined {
  return stderr.split("\n").find((l) => l.startsWith("fatal: "));
}

/** Whether `bin` has `remote-object-info` (2.43: `unknown command`). */
function hasRemoteObjectInfo(bin: string | undefined): boolean {
  if (!bin) return false;
  const dir = mkdtempSync(join(tmpdir(), "roi-probe-"));
  try {
    execFileSync(bin, ["init", "-q", dir], { stdio: "ignore" });
    execFileSync(bin, ["cat-file", "--batch-command"], {
      input: "remote-object-info\n",
      stdio: ["pipe", "pipe", "pipe"],
      cwd: dir,
    });
    return false;
  } catch (error) {
    const stderr = String((error as { stderr?: Buffer }).stderr ?? "");
    return stderr.includes("remote-object-info requires arguments");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A scenario of t1017 over one server's URL. */
interface Scenario {
  title: string;
  format?: string;
  buffer?: boolean;
  nul?: boolean;
  /** Runs native git with `-c protocol.version=0` and ours with the same setting */
  protocol0?: boolean;
  /** The repository served (default `parent`, with `transfer.advertiseObjectInfo=true`) */
  repository?: "parent" | "noinfo";
  input(url: string, ids: Ids): string[];
  expected(ids: Ids): string[] | { fatal: RegExp };
}

interface Ids {
  hello: string;
  tree: string;
  commit: string;
  tag: string;
  unstored: string;
  local: string;
  /** `<id> <type> <size>` of each object, from native `cat-file --batch-check` */
  info: Record<string, { type: string; size: string }>;
}

const SCENARIOS: Scenario[] = [
  {
    title: `t1017-cat-file-remote-object-info.sh: "batch-command remote-object-info git://"`,
    format: "%(objectname) %(objectsize)",
    input: (url, i) => [
      ...[i.hello, i.tree, i.commit, i.tag].map((id) => `remote-object-info "${url}" ${id}`),
      ...[i.hello, i.tree, i.commit, i.tag].map((id) => `info ${id}`),
    ],
    expected: (i) => [
      ...[i.hello, i.tree, i.commit, i.tag].map((id) => `${id} ${i.info[id]?.size}`),
      ...[i.hello, i.tree, i.commit, i.tag].map((id) => `${id} missing`),
    ],
  },
  {
    title: `t1017-cat-file-remote-object-info.sh: "batch-command remote-object-info git:// multiple sha1 per line"`,
    format: "%(objectname) %(objectsize)",
    input: (url, i) => [`remote-object-info "${url}" ${i.hello} ${i.tree} ${i.commit} ${i.tag}`],
    expected: (i) => [i.hello, i.tree, i.commit, i.tag].map((id) => `${id} ${i.info[id]?.size}`),
  },
  {
    title: `t1017-cat-file-remote-object-info.sh: "batch-command remote-object-info git:// default filter"`,
    input: (url, i) => [
      `remote-object-info "${url}" ${i.hello} ${i.tree}`,
      `remote-object-info "${url}" ${i.commit} ${i.tag}`,
    ],
    expected: (i) =>
      [i.hello, i.tree, i.commit, i.tag].map(
        (id) => `${id} ${i.info[id]?.type} ${i.info[id]?.size}`,
      ),
  },
  {
    title: `t1017-cat-file-remote-object-info.sh: "remote-object-info and info can be mixed using the unified default format"`,
    input: (url, i) => [
      `info ${i.local}`,
      `remote-object-info "${url}" ${i.hello}`,
      `info ${i.local}`,
    ],
    expected: (i) => [
      `${i.local} blob 12`,
      `${i.hello} blob ${i.info[i.hello]?.size}`,
      `${i.local} blob 12`,
    ],
  },
  {
    title: `t1017-cat-file-remote-object-info.sh: "batch-command --buffer remote-object-info git://"`,
    format: "%(objectname) %(objectsize)",
    buffer: true,
    input: (url, i) => [
      `remote-object-info "${url}" ${i.hello} ${i.tree}`,
      `remote-object-info "${url}" ${i.commit} ${i.tag}`,
      ...[i.hello, i.tree, i.commit, i.tag].map((id) => `info ${id}`),
      "flush",
    ],
    expected: (i) => [
      ...[i.hello, i.tree, i.commit, i.tag].map((id) => `${id} ${i.info[id]?.size}`),
      ...[i.hello, i.tree, i.commit, i.tag].map((id) => `${id} missing`),
    ],
  },
  {
    title: `t1017-cat-file-remote-object-info.sh: "batch-command -Z remote-object-info git:// default filter"`,
    nul: true,
    input: (url, i) => [
      `remote-object-info ${url} ${i.hello} ${i.tree}`,
      `remote-object-info ${url} ${i.commit} ${i.tag}`,
      ...[i.hello, i.tree, i.commit, i.tag].map((id) => `info ${id}`),
    ],
    expected: (i) => [
      ...[i.hello, i.tree, i.commit, i.tag].map(
        (id) => `${id} ${i.info[id]?.type} ${i.info[id]?.size}`,
      ),
      ...[i.hello, i.tree, i.commit, i.tag].map((id) => `${id} missing`),
    ],
  },
  {
    title: `t1017-cat-file-remote-object-info.sh: "remote-object-info does not support short oids"`,
    input: (url, i) => [`remote-object-info ${url} ${i.hello.slice(0, 7)}`],
    expected: () => ({ fatal: /does not support short oids, 40 characters required$/ }),
  },
  {
    title: `t1017-cat-file-remote-object-info.sh: "remote-object-info does not die on missing oid like info"`,
    input: (url, i) => [`remote-object-info ${url} ${i.unstored}`],
    expected: (i) => [`${i.unstored} missing`],
  },
  {
    title: `t1017-cat-file-remote-object-info.sh: "objecttype is supported by remote-object-info"`,
    format: "%(objecttype)",
    input: (url, i) => [`remote-object-info "${url}" ${i.hello}`],
    expected: () => ["blob"],
  },
  {
    title: `t1017-cat-file-remote-object-info.sh: "unsupported placeholders on remote return empty string"`,
    format: "%(objectmode) %(objectsize:disk) %(rest) %(deltabase)",
    input: (url, i) => [`remote-object-info "${url}" ${i.hello}`],
    expected: () => ["   "],
  },
  {
    title: `t1017-cat-file-remote-object-info.sh: "remote-object-info fails on unsupported filter option (objectsize:disk)"`,
    format: "%(objectname) %(objectsize:disk)",
    input: (url, i) => [`remote-object-info "${url}" ${i.hello}`],
    expected: (i) => [`${i.hello} `],
  },
  {
    title: `t1017-cat-file-remote-object-info.sh: "remote-object-info fails on unsupported filter option (deltabase)"`,
    format: "%(deltabase)",
    input: (url, i) => [`remote-object-info "${url}" ${i.hello}`],
    expected: () => [""],
  },
  {
    title: `t1017-cat-file-remote-object-info.sh: "requesting only objectname echoes back"`,
    format: "%(objectname)",
    input: (url, i) => [`remote-object-info "${url}" ${i.hello}`],
    expected: (i) => [i.hello],
  },
  {
    title: `t1017-cat-file-remote-object-info.sh: "objectname goes through existence check"`,
    format: "%(objectname)",
    input: (url, i) => [`remote-object-info "${url}" ${i.unstored}`],
    expected: (i) => [`${i.unstored} missing`],
  },
  {
    title: `t1017-cat-file-remote-object-info.sh: "batch-command remote-object-info git:// fails when transfer.advertiseobjectinfo=false"`,
    format: "%(objectname) %(objectsize)",
    repository: "noinfo",
    input: (url, i) => [`remote-object-info ${url} ${i.hello} ${i.tree} ${i.commit} ${i.tag}`],
    expected: () => ({ fatal: /^fatal: object-info capability is not enabled on the server$/ }),
  },
  {
    title: `t1017-cat-file-remote-object-info.sh: "remote-object-info fails on server with legacy protocol"`,
    format: "%(objectname) %(objectsize)",
    protocol0: true,
    input: (url, i) => [`remote-object-info ${url} ${i.hello}`],
    expected: () => ({ fatal: /^fatal: object-info requires protocol v2$/ }),
  },
  {
    title: `t1017-cat-file-remote-object-info.sh: "remote-object-info fails on malformed OID"`,
    format: "%(objectname) %(objectsize)",
    input: (url) => [`remote-object-info ${url} xyz123`],
    expected: () => ({ fatal: /^fatal: not a valid object name 'xyz123'$/ }),
  },
  {
    title: `t1017-cat-file-remote-object-info.sh: "remote-object-info fails on not providing OID"`,
    format: "%(objectname) %(objectsize)",
    input: (url) => [`remote-object-info ${url}`],
    expected: () => ({ fatal: /^fatal: remote-object-info requires objects$/ }),
  },
];

/** A server the scenarios run through: the URL of a repository, and who can reach it. */
interface Server {
  name: string;
  /** The server is native git (the native server's version decides whether it applies) */
  native: boolean;
  url(repository: string): string;
  /** Our client's transports for it */
  transports(): GitTransportRegistry;
  /** The native client can reach it (HTTP needs a git built with curl) */
  nativeClient: boolean;
}

/**
 * Defines the twins with `bin` as the native client (`undefined`: no native git with
 * `remote-object-info`, so only ours runs against t1017's expectations).
 */
export function defineRemoteObjectInfoTwins(bin: string | undefined): void {
  const nativeAvailable = (() => {
    try {
      execFileSync("git", ["--version"], { stdio: "ignore" });
      return process.platform === "linux";
    } catch {
      return false;
    }
  })();
  const describeGit = nativeAvailable ? describe : describe.skip;
  const client = hasRemoteObjectInfo(bin) ? bin : undefined;
  // the native servers are the git on PATH: they answer size and type from 2.56 on
  const nativeServerAnswers = hasRemoteObjectInfo("git");

  describeGit("cat-file --batch-command remote-object-info against native git (t1017)", () => {
    let root: string;
    let srv: string;
    let clientDir: string;
    let ids: Ids;
    let ours: Git;
    let ourDaemon: { port: number; close(): Promise<void> };
    let ourHttp: LoopbackServer;
    let nativeHttp: LoopbackServer;
    let closeBackend: () => void;
    let nativeHttpClient = false;
    const servers: Server[] = [];

    beforeAll(async () => {
      root = mkdtempSync(join(tmpdir(), "remote-object-info-"));
      srv = join(root, "srv");
      mkdirSync(srv);
      const git = (cwd: string, ...args: string[]) =>
        execFileSync("git", args, { cwd, env: testEnv(root) }).toString("latin1");
      const parent = join(srv, "parent");
      git(root, "init", "-q", "-b", "main", parent);
      writeFileSync(join(parent, "hello"), "Hello World");
      git(parent, "add", "hello");
      git(parent, "commit", "-q", "-m", "Initial commit");
      const tagContent = [
        `object ${git(parent, "rev-parse", "HEAD:hello").trim()}`,
        "type blob",
        "tag hellotag",
        "tagger C O Mitter <committer@example.com> 0 +0000",
        "",
        "This is a tag",
      ].join("\n");
      const tagFile = join(root, "tag");
      writeFileSync(tagFile, tagContent);
      const tag = git(parent, "hash-object", "-t", "tag", "-w", tagFile).trim();
      git(parent, "config", "transfer.advertiseobjectinfo", "true");
      git(parent, "config", "http.receivepack", "true");
      git(root, "clone", "-q", "--bare", "--no-local", parent, join(srv, "noinfo"));
      git(join(srv, "noinfo"), "config", "transfer.advertiseobjectinfo", "false");
      // t1017's unstored "Hello Git", and the client's own object
      const unstoredFile = join(root, "unstored");
      writeFileSync(unstoredFile, "Hello Git");
      clientDir = join(root, "client");
      git(root, "init", "-q", "-b", "main", clientDir);
      const localFile = join(root, "local");
      writeFileSync(localFile, "local object");
      const local = git(clientDir, "hash-object", "-w", localFile).trim();
      const hello = git(parent, "rev-parse", "HEAD:hello").trim();
      const tree = git(parent, "rev-parse", "HEAD^{tree}").trim();
      const commit = git(parent, "rev-parse", "HEAD").trim();
      const info: Ids["info"] = {};
      const batch = execFileSync("git", ["cat-file", "--batch-check"], {
        cwd: parent,
        env: testEnv(root),
        input: `${[hello, tree, commit, tag].join("\n")}\n`,
      })
        .toString("latin1")
        .trim()
        .split("\n");
      for (const line of batch) {
        const [id, type, size] = line.split(" ") as [string, string, string];
        info[id] = { type, size };
      }
      ids = {
        hello,
        tree,
        commit,
        tag,
        unstored: git(root, "hash-object", unstoredFile).trim(),
        local,
        info,
      };

      ours = await openOurs(
        root,
        createNodeGitHostEnvironment({ env: testEnv(root) }),
        undefined,
        "client",
      );
      const host = ours;
      const resolveRepository = createBasePathResolver({
        files: createNodeFilesApi({ rootDir: srv }),
        exportAll: true,
        openRepository: async (gitDir) => {
          const opened = await openLocalRemote(host.workingCopy, `../srv${gitDir}`).catch(
            () => undefined,
          );
          return opened ? servedRepositoryOf(opened) : undefined;
        },
      });
      ourDaemon = await startTcpServer((duplex) =>
        serveGitConnection({ duplex, resolveRepository }),
      );
      ourHttp = await serveOnLoopback(createServedFetchHandler({ resolveRepository }));
      const backend = nativeGitHttpBackend(srv, root);
      nativeHttp = await serveOnLoopback((request) => backend.fetch(request));
      closeBackend = () => backend.close();
      // a native client built without curl has no git-remote-http
      nativeHttpClient =
        client !== undefined &&
        (
          await runNative(
            client,
            root,
            clientDir,
            ["ls-remote", `${nativeHttp.baseUrl}/parent`],
            "",
          )
        ).status === 0;

      servers.push(
        {
          name: "native upload-pack over file://",
          native: true,
          url: (r) => `file://${join(srv, r)}`,
          transports: () => createDefaultTransports(),
          nativeClient: true,
        },
        {
          name: "native git daemon",
          native: true,
          url: (r) => `git://127.0.0.1/${r}`,
          transports: () =>
            createDefaultTransports({ openSocket: daemonOpener(root, srv, [], false) }),
          // the native client reaches only a listening daemon: ours is asked over git:// below
          nativeClient: false,
        },
        {
          name: "native http-backend",
          native: true,
          url: (r) => `${nativeHttp.baseUrl}/${r}`,
          transports: () => createDefaultTransports(),
          nativeClient: nativeHttpClient,
        },
        {
          name: "our git:// server",
          native: false,
          url: (r) => `git://127.0.0.1:${ourDaemon.port}/${r}`,
          transports: () => createDefaultTransports({ openSocket: openTcpSocket }),
          nativeClient: true,
        },
        {
          name: "our smart HTTP server",
          native: false,
          url: (r) => `${ourHttp.baseUrl}/${r}`,
          transports: () => createDefaultTransports(),
          nativeClient: nativeHttpClient,
        },
      );
    });

    afterAll(async () => {
      await ourDaemon?.close();
      await ourHttp?.close();
      await nativeHttp?.close();
      closeBackend?.();
      if (root && existsSync(root)) await removeTempDir(root);
    }, CLEANUP_TIMEOUT);

    /** Our cat-file over the same input. */
    async function runOurs(scenario: Scenario, server: Server, input: string): Promise<Run> {
      const transports = server.transports();
      const command = ours
        .catFile()
        .setBatch("command", scenario.format)
        .setStdin(input)
        .setRemoteObjectInfo(() => {
          const c = ours.remoteObjectInfo().setTransports(transports);
          return c;
        });
      if (scenario.buffer) command.setBuffer(true);
      if (scenario.nul) command.setNulTerminated(true);
      const result = await command.callOutput();
      return {
        status: result.exitCode,
        stdout: Buffer.from(result.stdout).toString("latin1"),
        fatal: fatalLine(result.stderr),
      };
    }

    function check(run: Run, expected: string[] | { fatal: RegExp }, delim: string): void {
      if (Array.isArray(expected)) {
        expect(run.fatal).toBeUndefined();
        expect(run.stdout).toBe(expected.map((l) => `${l}${delim}`).join(""));
        expect(run.status).toBe(0);
      } else {
        expect(run.fatal).toMatch(expected.fatal);
        expect(run.status).toBe(128);
      }
    }

    // divergence: the stores report no on-disk size or delta base, so a local object still
    // refuses these atoms (git answers them); only remote-object-info lines print them empty
    it("refuses %(objectsize:disk) and %(deltabase) for a local object only", async () => {
      const result = await ours
        .catFile()
        .setBatch("command", "%(objectname) %(deltabase)")
        .setStdin(`info ${ids.unstored}\ninfo ${ids.local}\n`)
        .callOutput();
      expect(Buffer.from(result.stdout).toString("latin1")).toBe(`${ids.unstored} missing\n`);
      expect(fatalLine(result.stderr)).toBe("fatal: cat-file: %(deltabase) is not supported");
      expect(result.exitCode).toBe(128);
    });

    // the object-info answers cat-file builds on, through the command API
    for (const serverIndex of [1, 2, 3, 4]) {
      it(`t5701-git-serve.sh: "basics of object-info", "object-info supports type", "object-info with size for unrecognized OID" (server #${serverIndex})`, async (context) => {
        const server = servers[serverIndex] as Server;
        if (server.native && !nativeServerAnswers) context.skip();
        const result = await ours
          .remoteObjectInfo()
          .setTransports(server.transports())
          .setRemote(server.url("parent"))
          .addObjectId(ids.hello)
          .addObjectId(ids.unstored)
          .addObjectId(ids.tree)
          .call();
        expect(result.size).toBe(true);
        expect(result.type).toBe(true);
        expect(result.objects).toEqual([
          { id: ids.hello, missing: false, size: 11, type: "blob" },
          { id: ids.unstored, missing: true },
          { id: ids.tree, missing: false, size: Number(ids.info[ids.tree]?.size), type: "tree" },
        ]);
        // t5701 "object-info with bare unrecognized OID": no attribute asked, an existence check
        const bare = await ours
          .remoteObjectInfo()
          .setTransports(server.transports())
          .setRemote(server.url("parent"))
          .setSize(false)
          .setType(false)
          .addObjectId(ids.hello)
          .addObjectId(ids.unstored)
          .call();
        expect(bare).toMatchObject({
          size: false,
          type: false,
          objects: [
            { id: ids.hello, missing: false },
            { id: ids.unstored, missing: true },
          ],
        });
      });
    }

    for (const scenario of SCENARIOS) {
      describe(scenario.title, () => {
        for (const serverIndex of [0, 1, 2, 3, 4]) {
          it(`server #${serverIndex}`, async (context) => {
            const server = servers[serverIndex] as Server;
            if (server.native && !nativeServerAnswers) context.skip();
            const url = server.url(scenario.repository ?? "parent");
            const lines = scenario.input(url, ids);
            const delim = scenario.nul ? "\0" : "\n";
            const input = lines.map((l) => `${l}${delim}`).join("");
            const expected = scenario.expected(ids);
            const args = [
              ...(scenario.protocol0 ? ["-c", "protocol.version=0"] : []),
              "cat-file",
              scenario.format === undefined
                ? "--batch-command"
                : `--batch-command=${scenario.format}`,
              ...(scenario.buffer ? ["--buffer"] : []),
              ...(scenario.nul ? ["-Z"] : []),
            ];
            if (client && server.nativeClient) {
              check(await runNative(client, root, clientDir, args, input), expected, delim);
            }
            if (scenario.protocol0)
              execFileSync("git", ["config", "protocol.version", "0"], {
                cwd: clientDir,
                env: testEnv(root),
              });
            try {
              ours = await openOurs(
                root,
                createNodeGitHostEnvironment({ env: testEnv(root) }),
                undefined,
                "client",
              );
              check(await runOurs(scenario, server, input), expected, delim);
            } finally {
              if (scenario.protocol0)
                execFileSync("git", ["config", "--unset", "protocol.version"], {
                  cwd: clientDir,
                  env: testEnv(root),
                });
            }
          });
        }
      });
    }
  });
}
