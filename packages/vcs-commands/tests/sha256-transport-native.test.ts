/**
 * SHA-256 repositories over the wire, against native git (2.43 and 2.5x): the
 * `object-format=sha256` capability (v0 first-ref line and `capabilities^{}`, v2
 * advertisement), clones, fetches and pushes in SHA-256, the clone of a SHA-256 remote making
 * a SHA-256 repository, and the refusals between formats, as git's t5702-protocol-v2 (clone,
 * fetch, push over file://, git:// and smart HTTP), t5551-http-fetch-smart and
 * t5550-http-fetch-dumb run them with `GIT_TEST_DEFAULT_HASH=sha256`, plus t5300's
 * "mismatched algorithms" checks (connect.c, serve.c, fetch-pack.c, send-pack.c).
 *
 * Native git clones, fetches and pushes against our served repositories (git:// over a TCP
 * port, smart HTTP through `createServedFetchHandler`), compared with the same commands
 * against `git daemon` and `git http-backend`; our client clones, fetches and pushes against
 * native git's servers and local paths, compared with native git doing the same. HTTP twins
 * run the system's git (the 2.56 build here has no curl).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitFilesBackend, openGitLinkedWorktrees } from "@statewalker/vcs-store-files";
import {
  createBasePathResolver,
  createDefaultTransports,
  createServedFetchHandler,
  serveGitConnection,
} from "@statewalker/vcs-transport";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
  createNodeHookRunner,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openLocalRemote, remoteHookSession } from "../src/commands/local-transport.js";
import { installPromisorFetcher } from "../src/commands/promisor-remote.js";
import { Git, servedRepositoryOf } from "../src/index.js";
import { nativeIs25x } from "./hooks-native-support.js";
import { type LoopbackServer, serveOnLoopback } from "./http-loopback-support.js";
import {
  daemonOpener,
  gitAsync,
  startTcpServer,
  writeNativeScripts,
} from "./native-connect-support.js";
import {
  nativeGitAvailable,
  nativeGitHttpBackend,
  noMaintenance,
} from "./native-git-http-backend.js";
import { gitOut, gitRun, putFile, testEnv } from "./status-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

/** The system's git, which speaks HTTP (a git built without curl does not). */
const SYSTEM_PATH = "/usr/bin:/bin";
const systemGitHasHttp =
  spawnSync("git", ["remote-https", "x", "y"], { env: { PATH: SYSTEM_PATH } }).error ===
    undefined && existsSync("/usr/lib/git-core/git-remote-https");

let root: string;
let srv: string;
let counter = 0;
const git = (cwd: string, ...args: string[]) => gitOut(root, cwd, args);

/**
 * A pre-receive hook logging its stdin (what receive-pack hands the hooks) in the git
 * directory, where receive-pack runs it.
 */
const PRE_RECEIVE = "#!/bin/sh\ncat >> pre-receive.log\n";

/** What a repository holds, as native git lists it. */
function stateOf(repo: string) {
  return {
    format: git(repo, "rev-parse", "--show-object-format").trim(),
    refs: git(repo, "for-each-ref", "--format=%(refname) %(objectname) %(symref)"),
    objects: git(repo, "rev-list", "--all", "--objects").split("\n").filter(Boolean).sort(),
    shallow: readShallow(repo),
  };
}

function readShallow(repo: string): string[] {
  const gitDir = existsSync(join(repo, ".git")) ? join(repo, ".git") : repo;
  const path = join(gitDir, "shallow");
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).sort() : [];
}

/** native fsck of a repository: clean. */
function fsckClean(repo: string): void {
  const r = gitRun(root, repo, ["fsck", "--strict", "--no-progress", "--no-dangling"]);
  expect(r.status, r.stdout + r.stderr).toBe(0);
}

/** A commit with fixed dates (each `n` its own second). */
function commit(repo: string, n: number, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) putFile(repo, path, content);
  git(repo, "add", "-A");
  gitOut(root, repo, ["commit", "-qm", `c${n}`], {
    GIT_AUTHOR_DATE: `${1700000000 + n} +0000`,
    GIT_COMMITTER_DATE: `${1700000000 + n} +0000`,
  });
}

/** Our Git over the repository `dir` (below `root`), through its linked worktrees. */
async function openLinked(dir: string, env: Record<string, string> = {}): Promise<Git> {
  const files = createNodeFilesApi({ rootDir: root });
  const rel = dir.slice(root.length + 1);
  const bare = !existsSync(join(dir, ".git"));
  const gitDir = bare ? rel : `${rel}/.git`;
  const environment = createNodeGitHostEnvironment({
    env: testEnv(root, env),
    hookRunner: createNodeHookRunner({
      env: testEnv(root, env),
      compatibility: nativeIs25x ? "2.56" : "2.43",
    }),
  });
  const { history } = await createGitFilesBackend({ files, gitDir, environment });
  const worktrees = await openGitLinkedWorktrees({ files, gitDir, history, environment });
  return Git.fromWorktreeAdmin(await worktrees.openAdmin());
}

/** A new empty repository of `format` for our side. */
async function ourEmpty(
  name: string,
  options: { format?: "sha1" | "sha256"; bare?: boolean; version?: string } = {},
): Promise<{ dir: string; ours: Git }> {
  const dir = join(root, `${name}-${counter++}`);
  git(
    root,
    "init",
    "-q",
    "-b",
    "main",
    ...(options.bare ? ["--bare"] : []),
    `--object-format=${options.format ?? "sha1"}`,
    dir,
  );
  if (options.version) git(dir, "config", "protocol.version", options.version);
  return { dir, ours: await openLinked(dir) };
}

describeGit("SHA-256 over the wire, as native git", () => {
  let scripts: ReturnType<typeof writeNativeScripts>;
  let host: Git;
  let ourDaemon: { port: number; close(): Promise<void> };
  let ourHttp: LoopbackServer;
  let nativeHttp: { server: LoopbackServer; close(): Promise<void> };
  const ourUrl = (path: string) => `git://127.0.0.1:${ourDaemon.port}/${path}`;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "sha256-transport-"));
    srv = join(root, "srv");
    mkdirSync(srv);
    scripts = writeNativeScripts(root, srv);
    // the SHA-256 source: branches, an annotated and a lightweight tag, a deeper history
    const work = join(root, "work256");
    git(root, "init", "-q", "-b", "main", "--object-format=sha256", work);
    for (let n = 1; n <= 5; n++) {
      commit(work, n, { "f.txt": `${n}\n`, [`d/${n}.txt`]: `file ${n}\n`.repeat(n * 20) });
    }
    git(work, "tag", "-a", "v1", "-m", "v1", "HEAD~2");
    git(work, "tag", "light", "HEAD~1");
    git(work, "branch", "side", "HEAD~3");
    git(root, "clone", "-q", "--bare", "--no-local", work, join(srv, "src256.git"));
    // the same history in SHA-1, for the mismatches
    const work1 = join(root, "work1");
    git(root, "init", "-q", "-b", "main", work1);
    commit(work1, 1, { "f.txt": "1\n" });
    git(root, "clone", "-q", "--bare", "--no-local", work1, join(srv, "src1.git"));
    git(
      root,
      "init",
      "-q",
      "--bare",
      "-b",
      "main",
      "--object-format=sha256",
      join(srv, "empty256.git"),
    );
    for (const repo of ["src256.git", "src1.git", "empty256.git"]) {
      git(join(srv, repo), "config", "uploadpack.allowfilter", "true");
      // a v0 lazy fetch wants objects no ref names (t5616)
      git(join(srv, repo), "config", "uploadpack.allowanysha1inwant", "true");
      git(join(srv, repo), "config", "http.receivepack", "true");
      noMaintenance(join(srv, repo));
    }

    git(root, "init", "-q", join(srv, "host"));
    host = await openLinked(join(srv, "host"));
    // `gitDir` is below the root (`/srv/<name>`): reached from srv/host
    const opener = async (gitDir: string, push: boolean) => {
      const opened = await openLocalRemote(host.workingCopy, `../..${gitDir}`).catch(
        () => undefined,
      );
      if (!opened) return undefined;
      return servedRepositoryOf(
        opened,
        push ? { hooks: remoteHookSession(host.workingCopy, opened) } : {},
      );
    };
    ourDaemon = await startTcpServer((duplex) =>
      serveGitConnection({
        duplex,
        enableReceivePack: true,
        resolveRepository: createBasePathResolver({
          files: createNodeFilesApi({ rootDir: root }),
          basePath: "/srv",
          exportAll: true,
          openRepository: (gitDir) => opener(gitDir, true),
        }),
      }),
    );
    ourHttp = await serveOnLoopback(
      createServedFetchHandler({
        resolveRepository: createBasePathResolver({
          files: createNodeFilesApi({ rootDir: srv }),
          exportAll: true,
          openRepository: async (gitDir) => {
            const opened = await openLocalRemote(host.workingCopy, `..${gitDir}`).catch(
              () => undefined,
            );
            return opened
              ? servedRepositoryOf(opened, { hooks: remoteHookSession(host.workingCopy, opened) })
              : undefined;
          },
        }),
      }),
    );
    const backend = nativeGitHttpBackend(srv, root);
    const server = await serveOnLoopback((request) => backend.fetch(request));
    nativeHttp = {
      server,
      close: async () => {
        await server.close();
        backend.close();
      },
    };
  });

  afterAll(async () => {
    await ourDaemon?.close();
    await ourHttp?.close();
    await nativeHttp?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  describe("native clients against our servers", () => {
    for (const version of ["0", "2"] as const) {
      it(`clone and fetch over git:// (v${version}) as from git daemon (t5702)`, async () => {
        const c = ["-c", `protocol.version=${version}`];
        const n = counter++;
        const mine = join(root, `nc-ours-${n}`);
        const theirs = join(root, `nc-native-${n}`);
        const a = await gitAsync(root, root, [...c, "clone", "-q", ourUrl("src256.git"), mine]);
        expect(a.status, a.stderr).toBe(0);
        const b = await gitAsync(
          root,
          root,
          [...c, "clone", "-q", "git://localhost/src256.git", theirs],
          {
            GIT_PROXY_COMMAND: scripts.proxy,
          },
        );
        expect(b.status, b.stderr).toBe(0);
        expect(stateOf(mine)).toEqual(stateOf(theirs));
        expect(stateOf(mine).format).toBe("sha256");
        fsckClean(mine);
        // ls-remote lists 64-digit ids
        const list = await gitAsync(root, root, [...c, "ls-remote", ourUrl("src256.git")]);
        const nativeList = await gitAsync(
          root,
          root,
          [...c, "ls-remote", "git://localhost/src256.git"],
          {
            GIT_PROXY_COMMAND: scripts.proxy,
          },
        );
        expect(list.stdout).toBe(nativeList.stdout);
      });

      it(`a shallow clone, then --unshallow, over git:// (v${version})`, async () => {
        const c = ["-c", `protocol.version=${version}`];
        const n = counter++;
        const mine = join(root, `sh-ours-${n}`);
        const theirs = join(root, `sh-native-${n}`);
        const a = await gitAsync(root, root, [
          ...c,
          "clone",
          "-q",
          "--depth",
          "2",
          "--no-single-branch",
          ourUrl("src256.git"),
          mine,
        ]);
        const b = await gitAsync(
          root,
          root,
          [
            ...c,
            "clone",
            "-q",
            "--depth",
            "2",
            "--no-single-branch",
            "git://localhost/src256.git",
            theirs,
          ],
          { GIT_PROXY_COMMAND: scripts.proxy },
        );
        expect(a.status, a.stderr).toBe(0);
        expect(b.status, b.stderr).toBe(0);
        expect(stateOf(mine)).toEqual(stateOf(theirs));
        expect(readShallow(mine).every((id) => id.length === 64)).toBe(true);
        const ua = await gitAsync(root, mine, [...c, "fetch", "-q", "--unshallow"]);
        const ub = await gitAsync(root, theirs, [...c, "fetch", "-q", "--unshallow"], {
          GIT_PROXY_COMMAND: scripts.proxy,
        });
        expect(ua.status, ua.stderr).toBe(0);
        expect(ub.status, ub.stderr).toBe(0);
        expect(stateOf(mine)).toEqual(stateOf(theirs));
      });

      it(`a partial clone (--filter=blob:none) and its lazy fetch over git:// (v${version})`, async () => {
        const c = ["-c", `protocol.version=${version}`];
        const n = counter++;
        const mine = join(root, `pc-ours-${n}`);
        const theirs = join(root, `pc-native-${n}`);
        const missing = (repo: string) =>
          git(repo, "rev-list", "--objects", "--all", "--missing=print")
            .split("\n")
            .filter(Boolean)
            .sort();
        const a = await gitAsync(root, root, [
          ...c,
          "clone",
          "-q",
          "--no-checkout",
          "--filter=blob:none",
          ourUrl("src256.git"),
          mine,
        ]);
        const b = await gitAsync(
          root,
          root,
          [
            ...c,
            "clone",
            "-q",
            "--no-checkout",
            "--filter=blob:none",
            "git://localhost/src256.git",
            theirs,
          ],
          { GIT_PROXY_COMMAND: scripts.proxy },
        );
        expect(a.status, a.stderr).toBe(0);
        expect(b.status, b.stderr).toBe(0);
        expect(missing(mine)).toEqual(missing(theirs));
        expect(missing(mine).some((l) => l.startsWith("?"))).toBe(true);
        // the checkouts fetch the missing blobs, from our server and from git daemon (v2: a v0
        // lazy fetch wants unadvertised objects, which our served repositories allow only
        // through the server's own request policy, not `uploadpack.allowAnySHA1InWant`)
        if (version === "0") return;
        const ca = await gitAsync(root, mine, [...c, "checkout", "-q", "main"]);
        const cb = await gitAsync(root, theirs, [...c, "checkout", "-q", "main"], {
          GIT_PROXY_COMMAND: scripts.proxy,
        });
        expect(cb.status, cb.stderr).toBe(0);
        expect(ca.status, ca.stderr).toBe(0);
        expect(readFileSync(join(mine, "d/5.txt"), "utf8")).toBe("file 5\n".repeat(100));
        expect(missing(mine)).toEqual(missing(theirs));
      });

      it(`clone of an empty SHA-256 repository (v${version}) gets its format from the capabilities`, async () => {
        const c = ["-c", `protocol.version=${version}`];
        const mine = join(root, `e-ours-${counter++}`);
        const r = await gitAsync(root, root, [...c, "clone", "-q", ourUrl("empty256.git"), mine]);
        expect(r.status, r.stderr).toBe(0);
        expect(git(mine, "rev-parse", "--show-object-format").trim()).toBe("sha256");
      });

      it(`push over git:// (v${version}): creates, updates, deletes, the hooks see 64-digit ids`, async () => {
        const c = ["-c", `protocol.version=${version}`];
        const n = counter++;
        // two copies of the source: one served by us, one by git daemon
        const ours = `push-ours-${n}.git`;
        const native = `push-native-${n}.git`;
        for (const d of [ours, native]) {
          git(root, "clone", "-q", "--bare", "--no-local", join(srv, "src256.git"), join(srv, d));
          noMaintenance(join(srv, d));
          writeFileSync(join(srv, d, "hooks/pre-receive"), PRE_RECEIVE, { mode: 0o755 });
        }
        const local = join(root, `push-work-${n}`);
        git(root, "clone", "-q", "--no-local", join(srv, "src256.git"), local);
        commit(local, 10, { "new.txt": "new\n" });
        const pushArgs = ["push", "-q"];
        const refspecs = ["main", "HEAD:refs/heads/created", ":refs/heads/side"];
        const a = await gitAsync(root, local, [...c, ...pushArgs, ourUrl(ours), ...refspecs]);
        const b = await gitAsync(
          root,
          local,
          [...c, ...pushArgs, `git://localhost/${native}`, ...refspecs],
          {
            GIT_PROXY_COMMAND: scripts.proxy,
          },
        );
        expect(a.status, a.stderr).toBe(0);
        expect(b.status, b.stderr).toBe(0);
        expect(stateOf(join(srv, ours))).toEqual(stateOf(join(srv, native)));
        fsckClean(join(srv, ours));
        // the hooks heard the same commands, 64-digit ids
        const hookLines = (d: string) => readFileSync(join(srv, d, "pre-receive.log"), "utf8");
        expect(hookLines(ours)).toBe(hookLines(native));
        const lines = hookLines(ours).split("\n").filter(Boolean);
        expect(lines.length).toBe(3);
        for (const line of lines) expect(line).toMatch(/^[0-9a-f]{64} [0-9a-f]{64} refs\/heads\//);
      });
    }

    const describeHttp = systemGitHasHttp ? describe : describe.skip;
    describeHttp("smart HTTP (system git)", () => {
      // the system git with its own helpers (a GIT_EXEC_PATH of another build has no curl)
      const http = { PATH: SYSTEM_PATH, GIT_EXEC_PATH: "/usr/lib/git-core" };
      for (const version of ["0", "2"] as const) {
        it(`clone, fetch and push (v${version}) as from http-backend (t5551)`, async () => {
          const c = ["-c", `protocol.version=${version}`];
          const n = counter++;
          const mine = join(root, `hc-ours-${n}`);
          const theirs = join(root, `hc-native-${n}`);
          const a = await gitAsync(
            root,
            root,
            [...c, "clone", "-q", `${ourHttp.baseUrl}/src256.git`, mine],
            http,
          );
          const b = await gitAsync(
            root,
            root,
            [...c, "clone", "-q", `${nativeHttp.server.baseUrl}/src256.git`, theirs],
            http,
          );
          expect(a.status, a.stderr).toBe(0);
          expect(b.status, b.stderr).toBe(0);
          expect(stateOf(mine)).toEqual(stateOf(theirs));
          fsckClean(mine);
          // a push into a copy served by each
          const ours = `hpush-ours-${n}.git`;
          const native = `hpush-native-${n}.git`;
          for (const d of [ours, native]) {
            git(root, "clone", "-q", "--bare", "--no-local", join(srv, "src256.git"), join(srv, d));
            git(join(srv, d), "config", "http.receivepack", "true");
            noMaintenance(join(srv, d));
          }
          commit(mine, 20, { "h.txt": "h\n" });
          const pa = await gitAsync(
            root,
            mine,
            [...c, "push", "-q", `${ourHttp.baseUrl}/${ours}`, "main", ":refs/heads/side"],
            http,
          );
          const pb = await gitAsync(
            root,
            mine,
            [
              ...c,
              "push",
              "-q",
              `${nativeHttp.server.baseUrl}/${native}`,
              "main",
              ":refs/heads/side",
            ],
            http,
          );
          expect(pa.status, pa.stderr).toBe(0);
          expect(pb.status, pb.stderr).toBe(0);
          expect(stateOf(join(srv, ours))).toEqual(stateOf(join(srv, native)));
          fsckClean(join(srv, ours));
        });

        it(`clone of an empty SHA-256 repository over HTTP (v${version})`, async () => {
          const c = ["-c", `protocol.version=${version}`];
          const mine = join(root, `he-ours-${counter++}`);
          const r = await gitAsync(
            root,
            root,
            [...c, "clone", "-q", `${ourHttp.baseUrl}/empty256.git`, mine],
            http,
          );
          expect(r.status, r.stderr).toBe(0);
          expect(git(mine, "rev-parse", "--show-object-format").trim()).toBe("sha256");
        });
      }

      it("a dumb HTTP clone of a SHA-256 repository (t5550)", async () => {
        const n = counter++;
        git(join(srv, "src256.git"), "update-server-info");
        const mine = join(root, `dumb-ours-${n}`);
        const theirs = join(root, `dumb-native-${n}`);
        const a = await gitAsync(
          root,
          root,
          ["clone", "-q", `${ourHttp.baseUrl}/src256.git`, mine],
          { ...http, GIT_SMART_HTTP: "0" },
        );
        const b = await gitAsync(
          root,
          root,
          ["clone", "-q", `${nativeHttp.server.baseUrl}/src256.git`, theirs],
          { ...http, GIT_SMART_HTTP: "0" },
        );
        expect(b.status, b.stderr).toBe(0);
        expect(a.status, a.stderr).toBe(0);
        expect(stateOf(mine)).toEqual(stateOf(theirs));
      });
    });
  });

  describe("our client against native servers", () => {
    for (const version of ["0", "2"] as const) {
      for (const via of ["daemon", "path", "file"] as const) {
        it(`clone of a SHA-256 remote (${via}, v${version}) makes a SHA-256 repository`, async () => {
          const native = join(root, `oc-native-${counter++}`);
          const source =
            via === "daemon"
              ? "git://localhost/src256.git"
              : via === "file"
                ? `file://${join(srv, "src256.git")}`
                : join(srv, "src256.git");
          const r = gitRun(
            root,
            root,
            ["-c", `protocol.version=${version}`, "clone", "-q", source, native],
            {
              GIT_PROXY_COMMAND: scripts.proxy,
            },
          );
          expect(r.status, r.stderr).toBe(0);
          const { dir, ours } = await ourEmpty("oc-ours", { version });
          const clone = ours.clone().setURI(source);
          if (via === "daemon") {
            clone.setTransports(createDefaultTransports({ openSocket: daemonOpener(root, srv) }));
          }
          const result = await clone.call();
          expect(result.workingCopy).toBeDefined();
          expect(stateOf(dir)).toEqual(stateOf(native));
          expect(readFileSync(join(dir, "d/5.txt"), "utf8")).toBe("file 5\n".repeat(100));
          fsckClean(dir);
          expect(gitOut(root, dir, ["status", "--porcelain"])).toBe("");
          // the facade took the reopened working copy: a commit and a fetch go on in SHA-256
          putFile(dir, "after.txt", "after\n");
          await ours.add().addFilepattern("after.txt").call();
          const c = await ours.commit().setMessage("after").call();
          expect(c.id).toMatch(/^[0-9a-f]{64}$/);
          fsckClean(dir);
          const fetch = ours.fetch().setRemote("origin");
          if (via === "daemon") {
            fetch.setTransports(createDefaultTransports({ openSocket: daemonOpener(root, srv) }));
          }
          await fetch.call();
        });
      }

      it(`clone of an empty SHA-256 remote (daemon, v${version})`, async () => {
        const { dir, ours } = await ourEmpty("oe-ours", { version });
        await ours
          .clone()
          .setURI("git://localhost/empty256.git")
          .setTransports(createDefaultTransports({ openSocket: daemonOpener(root, srv) }))
          .call();
        expect(git(dir, "rev-parse", "--show-object-format").trim()).toBe("sha256");
      });

      it(`shallow clone and deepening fetch from git daemon (v${version})`, async () => {
        const transports = createDefaultTransports({ openSocket: daemonOpener(root, srv) });
        const native = join(root, `os-native-${counter++}`);
        gitRun(
          root,
          root,
          [
            "-c",
            `protocol.version=${version}`,
            "clone",
            "-q",
            "--depth",
            "1",
            "git://localhost/src256.git",
            native,
          ],
          {
            GIT_PROXY_COMMAND: scripts.proxy,
          },
        );
        const { dir, ours } = await ourEmpty("os-ours", { version });
        await ours
          .clone()
          .setURI("git://localhost/src256.git")
          .setDepth(1)
          .setTransports(transports)
          .call();
        expect(stateOf(dir)).toEqual(stateOf(native));
        gitRun(root, native, ["-c", `protocol.version=${version}`, "fetch", "-q", "--depth", "3"], {
          GIT_PROXY_COMMAND: scripts.proxy,
        });
        await ours.fetch().setRemote("origin").setDepth(3).setTransports(transports).call();
        expect(stateOf(dir)).toEqual(stateOf(native));
      });

      it(`push to git daemon (v${version}) as native git pushes`, async () => {
        const transports = createDefaultTransports({ openSocket: daemonOpener(root, srv) });
        const n = counter++;
        const ours = `op-ours-${n}.git`;
        const native = `op-native-${n}.git`;
        for (const d of [ours, native]) {
          git(root, "clone", "-q", "--bare", "--no-local", join(srv, "src256.git"), join(srv, d));
          noMaintenance(join(srv, d));
          writeFileSync(join(srv, d, "hooks/pre-receive"), PRE_RECEIVE, { mode: 0o755 });
        }
        const { dir, ours: g } = await ourEmpty("op-work", { version });
        await g.clone().setURI(join(srv, "src256.git")).call();
        commit(dir, 30, { "p.txt": "p\n" });
        const refspecs = ["main", "main:refs/heads/created", ":refs/heads/side"];
        gitRun(
          root,
          dir,
          [
            "-c",
            `protocol.version=${version}`,
            "push",
            "-q",
            `git://localhost/${native}`,
            ...refspecs,
          ],
          {
            GIT_PROXY_COMMAND: scripts.proxy,
          },
        );
        // a fresh Git over the same repository (the clone above reopened it)
        const mine = await openLinked(dir);
        const push = mine.push().setRemote(`git://localhost/${ours}`).setTransports(transports);
        for (const r of refspecs) push.add(r);
        await push.call();
        expect(stateOf(join(srv, ours))).toEqual(stateOf(join(srv, native)));
        fsckClean(join(srv, ours));
      });
    }

    it("a partial clone from git daemon fetches missing blobs lazily (v2)", async () => {
      const transports = createDefaultTransports({ openSocket: daemonOpener(root, srv) });
      const { dir, ours } = await ourEmpty("opc", { version: "2" });
      await ours
        .clone()
        .setURI("git://localhost/src256.git")
        .setFilter("blob:none")
        .setNoCheckout(true)
        .setTransports(transports)
        .call();
      expect(
        git(dir, "rev-list", "--objects", "--all", "--missing=print")
          .split("\n")
          .some((l) => l.startsWith("?")),
      ).toBe(true);
      const blob = git(dir, "rev-parse", "main:d/5.txt").trim();
      expect(blob).toHaveLength(64);
      const reopened = await openLinked(dir);
      installPromisorFetcher(reopened.workingCopy, { transports });
      const content = await reopened.workingCopy.history.blobs.load(blob);
      const chunks: Uint8Array[] = [];
      for await (const chunk of content ?? []) chunks.push(chunk);
      expect(Buffer.concat(chunks).toString()).toBe("file 5\n".repeat(100));
    });

    const describeHttp = systemGitHasHttp ? describe : describe.skip;
    describeHttp("against http-backend", () => {
      for (const version of ["0", "2"] as const) {
        it(`clone and push (v${version})`, async () => {
          const n = counter++;
          const native = join(root, `oh-native-${n}`);
          gitRun(root, root, ["clone", "-q", join(srv, "src256.git"), native]);
          const { dir, ours } = await ourEmpty("oh-ours", { version });
          await ours.clone().setURI(`${nativeHttp.server.baseUrl}/src256.git`).call();
          expect(stateOf(dir).objects).toEqual(stateOf(native).objects);
          expect(stateOf(dir).format).toBe("sha256");
          const target = `ohp-${n}.git`;
          git(
            root,
            "clone",
            "-q",
            "--bare",
            "--no-local",
            join(srv, "src256.git"),
            join(srv, target),
          );
          git(join(srv, target), "config", "http.receivepack", "true");
          noMaintenance(join(srv, target));
          commit(dir, 40, { "q.txt": "q\n" });
          const mine = await openLinked(dir);
          await mine.push().setRemote(`${nativeHttp.server.baseUrl}/${target}`).add("main").call();
          expect(git(join(srv, target), "rev-parse", "main").trim()).toBe(
            git(dir, "rev-parse", "main").trim(),
          );
          fsckClean(join(srv, target));
        });
      }
    });
  });

  describe("mismatched formats fail as git does", () => {
    const fatal = (text: string) => text.split("\n").filter((l) => l.startsWith("fatal: "))[0];
    for (const version of ["0", "2"] as const) {
      for (const [local, remote] of [
        ["sha1", "src256.git"],
        ["sha256", "src1.git"],
      ] as const) {
        it(`fetch and push between a ${local} repository and a ${remote} remote (v${version})`, async () => {
          const transports = createDefaultTransports({ openSocket: daemonOpener(root, srv) });
          const { dir } = await ourEmpty(`mm-${local}`, { format: local, version });
          commit(dir, 50, { "m.txt": "m\n" });
          const url = `git://localhost/${remote}`;
          const nf = gitRun(
            root,
            dir,
            ["-c", `protocol.version=${version}`, "fetch", url, "main"],
            {
              GIT_PROXY_COMMAND: scripts.proxy,
            },
          );
          expect(nf.status).toBe(128);
          const mine = await openLinked(dir);
          await expect(
            mine.fetch().setRemote(url).setRefSpecs("main").setTransports(transports).call(),
          ).rejects.toThrow(fatal(nf.stderr) as string);
          // native git against our server says the same
          const nfo = await gitAsync(root, dir, [
            "-c",
            `protocol.version=${version}`,
            "fetch",
            ourUrl(remote),
            "main",
          ]);
          expect(fatal(nfo.stderr)).toBe(fatal(nf.stderr));
          const np = gitRun(
            root,
            dir,
            ["-c", `protocol.version=${version}`, "push", url, "main:refs/heads/x"],
            {
              GIT_PROXY_COMMAND: scripts.proxy,
            },
          );
          expect(np.status).toBe(128);
          await expect(
            mine.push().setRemote(url).add("main:refs/heads/x").setTransports(transports).call(),
          ).rejects.toThrow(fatal(np.stderr) as string);
          const npo = await gitAsync(root, dir, [
            "-c",
            `protocol.version=${version}`,
            "push",
            ourUrl(remote),
            "main:refs/heads/x",
          ]);
          expect(fatal(npo.stderr)).toBe(fatal(np.stderr));
          // ls-remote lists the remote's ids whatever the local format (git's too)
          const nl = gitRun(root, dir, ["-c", `protocol.version=${version}`, "ls-remote", url], {
            GIT_PROXY_COMMAND: scripts.proxy,
          });
          const list = await mine.lsRemote().setRemote(url).setTransports(transports).call();
          expect(nl.status).toBe(0);
          const ids = new Set(
            nl.stdout
              .split("\n")
              .filter(Boolean)
              .map((l) => l.split("\t")[0]),
          );
          for (const ref of list.refs ?? []) expect(ids.has(ref.objectId as string)).toBe(true);
        });
      }
    }
  });
});
