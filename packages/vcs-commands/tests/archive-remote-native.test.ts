/**
 * `git archive --remote` and upload-archive, native git as the oracle (t5000-tar-tree's
 * remote cases): native `git archive --remote=<path>` against ours over the same local
 * repository, native clients against our git:// server (`serveGitConnection` with
 * `enableUploadArchive`), and our client against `git daemon --inetd
 * --enable=upload-archive`. The archives are compared byte for byte, stderr line by line
 * (sorted where a local server's own `fatal:` line races the client's).
 */

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createBasePathResolver,
  createDefaultTransports,
  type ServeGitConnectionResult,
  serveGitConnection,
} from "@statewalker/vcs-transport";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openLocalRemote } from "../src/commands/local-transport.js";
import { type Git, servedRepositoryOf } from "../src/index.js";
import { archiveEnv, openArchiveRepo } from "./archive-native-support.js";
import { openOurs } from "./merge-native-helpers.js";
import { childDuplex, startTcpServer } from "./native-connect-support.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

type Outcome = { status: number; out: Buffer; err: string };

let home = "";
let srv = "";
let repo = "";
let unreachable = "";

function git(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, env: archiveEnv(home), encoding: "latin1" });
}

/** Native `git <args>` without blocking the event loop (our in-process server answers it). */
function nativeAsync(dir: string, args: string[]): Promise<Outcome> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd: dir, env: archiveEnv(home) });
    const out: Buffer[] = [];
    let err = "";
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => {
      err += d.toString("latin1");
    });
    child.stdin.end();
    child.on("close", (status) => resolve({ status: status ?? -1, out: Buffer.concat(out), err }));
  });
}

async function ours(
  dir: string,
  remote: string,
  args: string[],
  options: { output?: string; configure?: (git: Git) => void; daemon?: boolean } = {},
): Promise<Outcome> {
  const g = await openArchiveRepo(home, dir);
  const command = g
    .archiveRemote()
    .setRemote(remote)
    .addArguments(...args);
  if (options.output) command.setOutputName(options.output);
  if (options.daemon) {
    command.setTransports(
      createDefaultTransports({
        openSocket: async () =>
          childDuplex(
            spawn(
              "git",
              [
                "daemon",
                "--inetd",
                "--export-all",
                "--enable=upload-archive",
                `--base-path=${srv}`,
              ],
              { env: archiveEnv(home) },
            ),
          ),
      }),
    );
  }
  const r = await command.call();
  return { status: r.exitCode, out: Buffer.from(r.archive), err: r.stderr };
}

/** A repository whose FilesApi reaches every served one (`srv`): the server's host. */
function servingHost(): Promise<Git> {
  const environment = createNodeGitHostEnvironment({ env: archiveEnv(home) });
  return openOurs(srv, environment, undefined, "repo");
}

const sortedLines = (text: string) => text.split("\n").filter(Boolean).sort();

describeGit("git archive --remote (native twins)", () => {
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "archive-remote-"));
    srv = join(home, "srv");
    repo = join(srv, "repo");
    mkdirSync(join(repo, "a"), { recursive: true });
    git(srv, ["init", "-q", "repo"]);
    writeFileSync(join(repo, "a", "a"), "simple textfile\n");
    writeFileSync(join(repo, "b"), "another\n");
    writeFileSync(join(repo, ".gitattributes"), "b export-ignore\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-q", "-m", "initial"]);
    git(repo, ["tag", "v1"]);
    // t5000 "clients cannot access unreachable commits"
    writeFileSync(join(repo, "c"), "unreachable\n");
    git(repo, ["add", "c"]);
    git(repo, ["commit", "-q", "-m", "unreachable"]);
    unreachable = git(repo, ["rev-parse", "HEAD"]).trim();
    git(repo, ["reset", "-q", "--hard", "HEAD^"]);
  });
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  /** native `git archive --remote=<remote> <args>` and ours, in `repo`. */
  async function localTwins(
    remote: string,
    args: string[],
    output?: string,
  ): Promise<{ native: Outcome; ours: Outcome }> {
    const native = await nativeAsync(repo, [
      "archive",
      `--remote=${remote}`,
      ...(output ? ["--output", join(home, output)] : []),
      ...args,
    ]);
    if (output) {
      native.out = readFileSync(join(home, output));
      rmSync(join(home, output));
    }
    return { native, ours: await ours(repo, remote, args, output ? { output } : {}) };
  }

  it('t5000-tar-tree.sh: "git archive --remote"', async () => {
    const { native, ours: our } = await localTwins(".", ["HEAD"]);
    const local = execFileSync("git", ["archive", "HEAD"], { cwd: repo, env: archiveEnv(home) });
    expect(native.status).toBe(0);
    expect(our.status).toBe(0);
    expect(our.out.equals(native.out)).toBe(true);
    expect(our.out.equals(local)).toBe(true);
    expect(our.err).toBe(native.err);
  });

  it('t5000-tar-tree.sh: "git archive --remote with configured remote"', async () => {
    git(repo, ["config", "remote.foo.url", "."]);
    // the format the output name gives is sent first (archive_format_from_filename)
    const { native, ours: our } = await localTwins("foo", ["--prefix=p/", "v1"], "out.zip");
    expect(native.status).toBe(0);
    expect(our.status).toBe(0);
    expect(native.out.subarray(0, 2).toString()).toBe("PK");
    expect(our.out.equals(native.out)).toBe(true);
  });

  it('t5000-tar-tree.sh: "clients cannot access unreachable commits"', async () => {
    const { native, ours: our } = await localTwins(".", [unreachable]);
    expect(native.status).toBe(1);
    expect(our.status).toBe(1);
    expect(our.out.length).toBe(0);
    expect(sortedLines(our.err)).toEqual(sortedLines(native.err));
  });

  it('t5000-tar-tree.sh: "upload-archive can allow unreachable commits"', async () => {
    git(repo, ["config", "uploadarchive.allowUnreachable", "true"]);
    try {
      const { native, ours: our } = await localTwins(".", [unreachable]);
      expect(native.status).toBe(0);
      expect(our.status).toBe(0);
      expect(our.out.equals(native.out)).toBe(true);
    } finally {
      git(repo, ["config", "--unset", "uploadarchive.allowUnreachable"]);
    }
  });

  it('t5000-tar-tree.sh: "only enabled filters are available remotely"', async () => {
    git(repo, ["config", "tar.tar.foo.command", "cat"]);
    try {
      const refused = await localTwins(".", ["--format=tar.foo", "HEAD"]);
      expect(refused.native.status).toBe(1);
      expect(refused.ours.status).toBe(1);
      expect(sortedLines(refused.ours.err)).toEqual(sortedLines(refused.native.err));
      // tgz is served remotely by default: the gzip bytes differ (pako), the tar inside not
      const tgz = await localTwins(".", ["--format=tgz", "HEAD"]);
      expect(tgz.native.status).toBe(0);
      expect(tgz.ours.status).toBe(0);
      const { gunzipSync } = await import("node:zlib");
      expect(gunzipSync(tgz.ours.out).equals(gunzipSync(tgz.native.out))).toBe(true);
      // tar.tgz.remote=false takes it away
      git(repo, ["config", "tar.tgz.remote", "false"]);
      const off = await localTwins(".", ["--format=tgz", "HEAD"]);
      expect(off.native.status).toBe(1);
      expect(off.ours.status).toBe(1);
      expect(sortedLines(off.ours.err)).toEqual(sortedLines(off.native.err));
    } finally {
      git(repo, ["config", "--remove-section", "tar.tar.foo"]);
      git(repo, ["config", "--unset", "tar.tgz.remote"]);
    }
  });

  it("--add-file and --add-virtual-file are refused remotely", async () => {
    for (const arg of ["--add-file=b", "--add-virtual-file=x:y"]) {
      const { native, ours: our } = await localTwins(".", [arg, "HEAD"]);
      expect(native.status).toBe(1);
      expect(our.status).toBe(1);
      expect(our.out.length).toBe(0);
      expect(sortedLines(our.err)).toEqual(sortedLines(native.err));
    }
  });

  it("--list served remotely, -v's paths as remote lines", async () => {
    git(repo, ["config", "tar.tar.foo.command", "cat"]);
    try {
      const list = await localTwins(".", ["--list"]);
      expect(list.ours.status).toBe(0);
      expect(list.ours.out.toString()).toBe(list.native.out.toString());
      expect(list.ours.out.toString()).toBe("tar\ntgz\ntar.gz\nzip\n");
    } finally {
      git(repo, ["config", "--remove-section", "tar.tar.foo"]);
    }
    const verbose = await localTwins(".", ["-v", "--format=zip", "-0", "HEAD", "a"]);
    expect(verbose.ours.status).toBe(0);
    expect(verbose.ours.out.equals(verbose.native.out)).toBe(true);
    expect(verbose.ours.err).toBe(verbose.native.err);
  });

  describe("over git://", () => {
    let server: { port: number; close(): Promise<void> } | undefined;
    const results: ServeGitConnectionResult[] = [];

    beforeAll(async () => {
      const host = await servingHost();
      const resolveRepository = createBasePathResolver({
        files: createNodeFilesApi({ rootDir: srv }),
        exportAll: true,
        openRepository: async (gitDir) => {
          const opened = await openLocalRemote(host.workingCopy, `..${gitDir}`).catch(
            () => undefined,
          );
          return opened && servedRepositoryOf(opened);
        },
      });
      server = await startTcpServer(async (duplex) => {
        results.push(
          await serveGitConnection({ duplex, resolveRepository, enableUploadArchive: true }),
        );
      });
    });
    afterAll(() => server?.close());

    it('t5000-tar-tree.sh: "git archive --remote" (native client, our git:// server)', async () => {
      const url = `git://127.0.0.1:${server?.port}/repo`;
      const against = await nativeAsync(repo, ["archive", `--remote=${url}`, "HEAD"]);
      const local = execFileSync("git", ["archive", "HEAD"], { cwd: repo, env: archiveEnv(home) });
      expect(against.err).toBe("");
      expect(against.status).toBe(0);
      expect(against.out.equals(local)).toBe(true);
      expect(against.err).toBe("");
      // refused: an unreachable commit, the remote's lines as native git prints them
      const refused = await nativeAsync(repo, ["archive", `--remote=${url}`, unreachable]);
      expect(refused.status).toBe(1);
      expect(refused.err).toBe(
        `remote: fatal: no such ref: ${unreachable}        \n` +
          "remote: git upload-archive: archiver died with error\n",
      );
    });

    it('t5000-tar-tree.sh: "git archive --remote" (our client, git daemon)', async () => {
      const url = "git://127.0.0.1/repo";
      const native = await ours(repo, url, ["--format=zip", "-0", "v1"], { daemon: true });
      const local = execFileSync("git", ["archive", "--format=zip", "-0", "v1"], {
        cwd: repo,
        env: archiveEnv(home),
      });
      expect(native.status).toBe(0);
      expect(native.out.equals(local)).toBe(true);
      const refused = await ours(repo, url, [unreachable], { daemon: true });
      expect(refused.status).toBe(1);
      expect(refused.err).toBe(
        `remote: fatal: no such ref: ${unreachable}        \n` +
          "remote: git upload-archive: archiver died with error\n",
      );
    });

    it("refuses upload-archive unless enabled, as git daemon (daemon.uploadarch)", async () => {
      const g = await servingHost();
      const resolveRepository = createBasePathResolver({
        files: createNodeFilesApi({ rootDir: srv }),
        exportAll: true,
        openRepository: async (gitDir) => {
          const opened = await openLocalRemote(g.workingCopy, `..${gitDir}`).catch(() => undefined);
          return opened && servedRepositoryOf(opened);
        },
      });
      const off = await startTcpServer((duplex) =>
        serveGitConnection({ duplex, resolveRepository }),
      );
      try {
        const url = `git://127.0.0.1:${off.port}/repo`;
        const refused = await nativeAsync(repo, ["archive", `--remote=${url}`, "HEAD"]);
        expect(refused.status).toBe(128);
        expect(refused.err).toBe(
          "fatal: remote error: access denied or repository not exported: /repo\n",
        );
        git(repo, ["config", "daemon.uploadarch", "true"]);
        const allowed = await nativeAsync(repo, ["archive", `--remote=${url}`, "HEAD"]);
        expect(allowed.status).toBe(0);
      } finally {
        git(repo, ["config", "--unset", "daemon.uploadarch"]);
        await off.close();
      }
    });
  });
});
