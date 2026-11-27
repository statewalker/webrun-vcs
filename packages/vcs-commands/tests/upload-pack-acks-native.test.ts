/**
 * Which haves protocol v2 upload-pack acknowledges, against native git
 * (statewalker/webrun-vcs#396). git 2.45+ builds its ACKs from `have_obj`: `do_got_oid` marks
 * every parent of a held commit `THEY_HAVE` before it looks at the commit's own flag, so a
 * have whose child came first in the request (or a repeated have) is not acknowledged. git
 * before 2.45 acknowledged every have it held (`process_haves`' `common`).
 *
 * Each scenario sends one raw request to `git daemon --inetd` and to our git:// server
 * (`servedRepositoryOf`, given the native git's compatibility) and compares the answers line
 * for line; a native `fetch --negotiate-only` is compared through its packet trace and its
 * output.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createBasePathResolver,
  type Duplex,
  serveGitConnection,
} from "@statewalker/vcs-transport";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openLocalRemote } from "../src/commands/local-transport.js";
import { servedRepositoryOf } from "../src/index.js";
import { openOurs } from "./merge-native-helpers.js";
import {
  childDuplex,
  daemonArgs,
  gitAsync,
  openTcpSocket,
  startTcpServer,
} from "./native-connect-support.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { nativeAtLeast } from "./plumbing-native-support.js";
import { gitOut, testEnv } from "./status-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root: string;
let srv: string;
let counter = 0;
const git = (cwd: string, ...args: string[]) => gitOut(root, cwd, args);

function pkt(line: string): string {
  const payload = `${line}\n`;
  return `${(payload.length + 4).toString(16).padStart(4, "0")}${payload}`;
}

/** pkt-lines of a raw answer, as text (`0000` flush, `0001` delim). */
function pktLines(bytes: Uint8Array): string[] {
  const out: string[] = [];
  const text = new TextDecoder("latin1");
  let at = 0;
  while (at + 4 <= bytes.length) {
    const len = Number.parseInt(text.decode(bytes.subarray(at, at + 4)), 16);
    if (Number.isNaN(len)) break;
    if (len < 4) {
      out.push(len === 0 ? "0000" : len === 1 ? "0001" : "0002");
      at += 4;
      continue;
    }
    out.push(text.decode(bytes.subarray(at + 4, at + len)).replace(/\n$/, ""));
    at += len;
  }
  return out;
}

/**
 * A raw v2 request to the git:// server behind `duplex`: the advertisement is read, then
 * `request` (pkt-lines) is sent and the whole answer read. Returns the answer's lines.
 */
async function rawV2(duplex: Duplex, path: string, request: string): Promise<string[]> {
  const head = `git-upload-pack ${path}\0host=localhost\0\0version=2\0`;
  await duplex.write(
    new TextEncoder().encode(`${(head.length + 4).toString(16).padStart(4, "0")}${head}`),
  );
  const chunks: number[] = [];
  let sent = false;
  const iterator = duplex[Symbol.asyncIterator]();
  while (true) {
    const next = await Promise.race([
      iterator.next(),
      new Promise<IteratorResult<Uint8Array>>((resolve) =>
        setTimeout(() => resolve({ value: undefined, done: true }), 10_000),
      ),
    ]);
    if (next.done) break;
    chunks.push(...next.value);
    if (!sent && new TextDecoder("latin1").decode(new Uint8Array(chunks)).includes("0000")) {
      // the advertisement ends with the first flush
      sent = true;
      chunks.length = 0;
      await duplex.write(new TextEncoder().encode(request));
      await duplex.end?.();
    }
  }
  await duplex.close?.().catch(() => {});
  return pktLines(new Uint8Array(chunks));
}

const request = (...args: string[]) => `${pkt("command=fetch")}0001${args.map(pkt).join("")}0000`;

describeGit("protocol v2 upload-pack acknowledgments, as native git", () => {
  let ours: { port: number; close(): Promise<void> };
  const ids: Record<string, string> = {};
  // git before 2.45 acknowledges every have it holds
  const compatibility = nativeAtLeast(2, 45) ? "2.56" : "2.43";

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "upload-pack-acks-"));
    srv = join(root, "srv");
    mkdirSync(srv);
    const repo = join(srv, "server");
    git(root, "init", "-q", "-b", "main", repo);
    const commit = (name: string, n: number) => {
      writeFileSync(join(repo, `${name}.t`), `${name}\n`);
      git(repo, "add", `${name}.t`);
      gitOut(root, repo, ["commit", "-qm", name], {
        GIT_AUTHOR_DATE: `${1700000000 + n} +0000`,
        GIT_COMMITTER_DATE: `${1700000000 + n} +0000`,
      });
      ids[name] = git(repo, "rev-parse", "HEAD").trim();
    };
    commit("one", 1);
    commit("two", 2);
    commit("three", 3);
    git(repo, "checkout", "-q", "-b", "side", ids.one as string);
    commit("side", 4);
    git(repo, "checkout", "-q", "main");
    gitOut(root, repo, ["merge", "-q", "--no-ff", "-m", "merge", "side"], {
      GIT_AUTHOR_DATE: "1700000005 +0000",
      GIT_COMMITTER_DATE: "1700000005 +0000",
    });
    ids.merge = git(repo, "rev-parse", "HEAD").trim();
    ids.tree = git(repo, "rev-parse", "HEAD^{tree}").trim();
    ids.blob = git(repo, "rev-parse", "HEAD:one.t").trim();
    git(repo, "tag", "-a", "v1", "-m", "v1", ids.two as string);
    ids.tag = git(repo, "rev-parse", "v1").trim();
    ids.missing = "1".repeat(40);

    const host = await openOurs(
      srv,
      createNodeGitHostEnvironment({ env: testEnv(root) }),
      undefined,
      "server",
    );
    const resolveRepository = createBasePathResolver({
      files: createNodeFilesApi({ rootDir: srv }),
      exportAll: true,
      openRepository: async (gitDir) => {
        const opened = await openLocalRemote(host.workingCopy, `..${gitDir}`).catch(
          () => undefined,
        );
        return opened ? servedRepositoryOf(opened, { host: { compatibility } }) : undefined;
      },
    });
    ours = await startTcpServer(async (duplex) => {
      await serveGitConnection({ duplex, resolveRepository });
    });
  });

  afterAll(async () => {
    await ours?.close();
    rmSync(root, { recursive: true, force: true });
  });

  const nativeDaemon = (extra: Record<string, string> = {}): Duplex =>
    childDuplex(spawn("git", daemonArgs(srv), { env: testEnv(root, extra) }));

  // `wait-for-done` keeps every answer to the acknowledgments section (never `ready`)
  const RAW: Array<[string, string[]]> = [
    [
      `t5702-protocol-v2.sh: "file:// --negotiate-only" (a have after its child)`,
      ["wait-for-done", "have three", "have two", "have one"],
    ],
    [
      `t5702-protocol-v2.sh: "file:// --negotiate-only" (a have before its child)`,
      ["wait-for-done", "have one", "have two", "have three"],
    ],
    [
      `t5702-protocol-v2.sh: "file:// --negotiate-only" (a repeated have)`,
      ["wait-for-done", "have two", "have two", "have missing", "have two"],
    ],
    [
      `t5702-protocol-v2.sh: "file:// --negotiate-only" (both parents of a merge)`,
      ["wait-for-done", "have merge", "have side", "have three", "have one"],
    ],
    [
      `t5702-protocol-v2.sh: "file:// --negotiate-only" (trees, blobs and tags)`,
      [
        "wait-for-done",
        "have tree",
        "have blob",
        "have tag",
        "have tree",
        "have blob",
        "have tag",
        "have two",
      ],
    ],
    [
      `t5702-protocol-v2.sh: "file:// --negotiate-only" (nothing held)`,
      ["wait-for-done", "have missing"],
    ],
    [
      `t5702-protocol-v2.sh: "fetch supports various ways of have lines" (not ready: ACKs only)`,
      ["want side", "have missing", "have three", "have two", "have three"],
    ],
    [
      `t5702-protocol-v2.sh: "fetch supports various ways of have lines" (not ready: NAK)`,
      ["want side", "have missing"],
    ],
    [
      `t5702-protocol-v2.sh: "fetch supports various ways of have lines" (ready)`,
      ["want merge", "have missing", "have side", "have one", "have side"],
    ],
  ];
  for (const [title, args] of RAW) {
    it(`${title}: our answer as upload-pack's`, async () => {
      const lines = args.map((a) => a.replace(/ ([a-z]+)$/, (_, k: string) => ` ${ids[k]}`));
      const body = request(...lines);
      const theirs = await rawV2(nativeDaemon(), "/server", body);
      const mine = await rawV2(await openTcpSocket("127.0.0.1", ours.port), "/server", body);
      // the pack's bytes are our pack writer's
      const cut = (answer: string[]) =>
        answer.includes("packfile") ? answer.slice(0, answer.indexOf("packfile") + 1) : answer;
      expect(theirs[0]).toBe("acknowledgments");
      expect(cut(mine)).toEqual(cut(theirs));
    });
  }

  it(`t5702-protocol-v2.sh: "file:// --negotiate-only": a native client, our server`, async () => {
    const client = join(root, `client-${counter++}`);
    git(root, "clone", "-q", join(srv, "server"), client);
    git(client, "reset", "-q", "--hard", ids.two as string);
    writeFileSync(join(client, "three-c.t"), "client\n");
    git(client, "add", "three-c.t");
    gitOut(root, client, ["commit", "-qm", "three-c"], {
      GIT_AUTHOR_DATE: "1700000010 +0000",
      GIT_COMMITTER_DATE: "1700000010 +0000",
    });
    const negotiate = async (url: string) => {
      const trace = join(root, `trace-${counter++}`);
      const r = await gitAsync(
        root,
        client,
        [
          "-c",
          "protocol.version=2",
          "fetch",
          "--no-tags",
          "--negotiate-only",
          `--negotiation-tip=${git(client, "rev-parse", "HEAD").trim()}`,
          url,
        ],
        { GIT_TRACE_PACKET: trace },
      );
      expect(r.status, r.stderr).toBe(0);
      const acks = readFileSync(trace, "latin1")
        .split("\n")
        .map((l) => /fetch< (ACK .*|NAK)$/.exec(l)?.[1])
        .filter((l) => l !== undefined);
      return { stdout: r.stdout, acks };
    };
    const theirs = await negotiate(`file://${join(srv, "server")}`);
    const mine = await negotiate(`git://127.0.0.1:${ours.port}/server`);
    expect(theirs.stdout).toContain(ids.two);
    expect(mine).toEqual(theirs);
  });
});
