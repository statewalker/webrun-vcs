/**
 * git's native transports end to end, native git the oracle:
 *
 * - our client over `git://` against `git daemon --inetd` (spawned per connection through the
 *   test `openSocket`), native git reaching the same daemon through `GIT_PROXY_COMMAND`;
 * - our server (`serveGitConnection` behind a TCP server) answering native git's
 *   `git://127.0.0.1:<port>/...`, its refusals compared with the real daemon's;
 * - our client over ssh, the command run locally by the test `exec` (as sshd would), native git
 *   running the same through `GIT_SSH_COMMAND`.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
import { type Git, type GitApiError, servedRepositoryOf } from "../src/index.js";
import { openOurs } from "./merge-native-helpers.js";
import {
  daemonOpener,
  gitAsync,
  localSshExec,
  openTcpSocket,
  startTcpServer,
  writeNativeScripts,
} from "./native-connect-support.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { gitOut, gitRun, putFile, testEnv } from "./status-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root: string;
let srv: string;
let scripts: ReturnType<typeof writeNativeScripts>;
let counter = 0;
const git = (cwd: string, ...args: string[]) => gitOut(root, cwd, args);

async function ours(name: string): Promise<Git> {
  return openOurs(root, createNodeGitHostEnvironment({ env: testEnv(root) }), undefined, name);
}

/** Two directories for twins, `n<k>` (native) and `o<k>` (ours), the latter an empty repository. */
function twins(): [string, string] {
  const names: [string, string] = [`n${counter}`, `o${counter}`];
  counter++;
  mkdirSync(join(root, names[1]));
  git(join(root, names[1]), "init", "-q", "-b", "main");
  return names;
}

/** Two bare repositories below the served directory, for pushes. */
function bareTwins(seed?: string): [string, string] {
  const names: [string, string] = [`dn${counter}.git`, `do${counter}.git`];
  counter++;
  for (const name of names) {
    git(srv, "init", "-q", "--bare", "-b", "main", name);
    git(join(srv, name), "config", "receive.advertisePushOptions", "true");
    if (seed) git(join(srv, seed), "push", "-q", join(srv, name), "main", "feat", "v1");
  }
  return names;
}

const refs = (dir: string) =>
  git(dir, "for-each-ref", "--format=%(refname) %(objectname) %(symref)");

const lsRemoteLines = (out: string) =>
  out
    .split("\n")
    .filter((l) => l)
    .map((l) => l.split("\t").reverse().join(" "));

describeGit("git's native transports against native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "native-proto-"));
    srv = join(root, "srv");
    mkdirSync(srv);
    scripts = writeNativeScripts(root, srv);
    const src = join(srv, "src");
    mkdirSync(src);
    git(src, "init", "-q", "-b", "main");
    for (const n of [1, 2, 3]) {
      putFile(src, "a.txt", `a${n}\n`);
      git(src, "add", "a.txt");
      git(src, "commit", "-qm", `c${n}`);
    }
    git(src, "tag", "-a", "-m", "v1", "v1");
    git(src, "checkout", "-q", "-b", "feat");
    putFile(src, "b.txt", "b\n");
    git(src, "add", "b.txt");
    git(src, "commit", "-qm", "feat");
    git(src, "checkout", "-q", "main");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  describe("our client over git:// against git daemon", () => {
    const viaDaemon = (calls?: string[]) =>
      createDefaultTransports({ openSocket: daemonOpener(root, srv, calls) });
    const proxied = () => ({ GIT_PROXY_COMMAND: scripts.proxy });

    for (const version of ["2", "0"] as const) {
      it(`ls-remote (protocol v${version}): refs, peeled tags, the default branch`, async () => {
        const [, o] = twins();
        git(join(root, o), "config", "protocol.version", version);
        const native = gitOut(
          root,
          root,
          ["-c", `protocol.version=${version}`, "ls-remote", "git://localhost/src"],
          {
            GIT_PROXY_COMMAND: scripts.proxy,
          },
        );
        const calls: string[] = [];
        const listed = await (await ours(o))
          .lsRemote()
          .setRemote("git://localhost/src")
          .setTransports(viaDaemon(calls))
          .call();
        const expected = lsRemoteLines(native).filter((l) => !l.startsWith("HEAD "));
        const got: string[] = [];
        for (const r of listed.refs) {
          got.push(`${r.name} ${r.objectId}`);
          if (r.peeledObjectId) got.push(`${r.name}^{} ${r.peeledObjectId}`);
        }
        expect(got).toEqual(expected);
        expect(listed.defaultBranch).toBe("main");
        expect(calls).toEqual(["localhost:9418"]);

        const heads = await (await ours(o))
          .lsRemote()
          .setRemote("git://localhost/src")
          .setHeads(true)
          .setTransports(viaDaemon())
          .call();
        const nativeHeads = gitOut(
          root,
          root,
          ["-c", `protocol.version=${version}`, "ls-remote", "--heads", "git://localhost/src"],
          { GIT_PROXY_COMMAND: scripts.proxy },
        );
        expect(heads.refs.map((r) => `${r.name} ${r.objectId}`)).toEqual(
          lsRemoteLines(nativeHeads),
        );
        // HEAD is asked for (`ref-prefix HEAD` over v2) for the default branch, not listed
        expect(heads.defaultBranch).toBe("main");
        const tags = await (await ours(o))
          .lsRemote()
          .setRemote("git://localhost/src")
          .setTags(true)
          .setTransports(viaDaemon())
          .call();
        expect(tags.defaultBranch).toBe("main");
        expect(tags.refs.map((r) => r.name)).toEqual(["refs/tags/v1"]);
      });
    }

    it("clone, then fetch over v0 and v2, as native git through the same daemon", async () => {
      const [n, o] = twins();
      rmSync(join(root, o), { recursive: true, force: true });
      mkdirSync(join(root, o));
      git(join(root, o), "init", "-q", "-b", "main");
      gitOut(root, root, ["clone", "-q", "git://localhost/src", n], proxied());
      const g = await ours(o);
      await g.clone().setURI("git://localhost/src").setTransports(viaDaemon()).call();
      expect(refs(join(root, o))).toBe(refs(join(root, n)));
      expect(git(join(root, o), "rev-parse", "HEAD")).toBe(git(join(root, n), "rev-parse", "HEAD"));
      git(join(root, o), "fsck", "--strict");

      for (const version of ["0", "2"]) {
        const [n2, o2] = twins();
        mkdirSync(join(root, n2));
        git(join(root, n2), "init", "-q", "-b", "main");
        for (const d of [n2, o2]) git(join(root, d), "config", "protocol.version", version);
        gitOut(
          root,
          join(root, n2),
          ["fetch", "-q", "git://localhost/src", "feat:refs/heads/f", "v1"],
          proxied(),
        );
        await (await ours(o2))
          .fetch()
          .setRemote("git://localhost/src")
          .setRefSpecs("feat:refs/heads/f", "refs/tags/v1:refs/tags/v1")
          .setTransports(viaDaemon())
          .call();
        expect(refs(join(root, o2))).toBe(refs(join(root, n2)));
        git(join(root, o2), "fsck", "--strict");
      }
    });

    it("a shallow fetch writes the shallow file native git writes", async () => {
      const [n, o] = twins();
      mkdirSync(join(root, n));
      git(join(root, n), "init", "-q", "-b", "main");
      gitOut(
        root,
        join(root, n),
        ["fetch", "-q", "--depth=1", "git://localhost/src", "main:refs/heads/m"],
        proxied(),
      );
      await (await ours(o))
        .fetch()
        .setRemote("git://localhost/src")
        .setRefSpecs("main:refs/heads/m")
        .setDepth(1)
        .setTransports(viaDaemon())
        .call();
      expect(refs(join(root, o))).toBe(refs(join(root, n)));
      expect(readFileSync(join(root, o, ".git/shallow"), "utf8")).toBe(
        readFileSync(join(root, n, ".git/shallow"), "utf8"),
      );
    });

    it("push: updates, a deletion, atomic, push options", async () => {
      const [dn, dO] = bareTwins("src");
      const [n, o] = twins();
      rmSync(join(root, n), { recursive: true, force: true });
      git(root, "clone", "-q", join(srv, "src"), n);
      for (const d of [n, o]) {
        if (d === o) {
          git(join(root, o), "fetch", "-q", join(srv, "src"), "main");
          git(join(root, o), "reset", "-q", "--hard", "FETCH_HEAD");
        }
        putFile(join(root, d), "p.txt", "p\n");
        git(join(root, d), "add", "p.txt");
        git(join(root, d), "commit", "-qm", "pushed");
      }
      expect(git(join(root, o), "rev-parse", "HEAD")).toBe(git(join(root, n), "rev-parse", "HEAD"));
      gitOut(
        root,
        join(root, n),
        [
          "push",
          "-q",
          "--atomic",
          "-o",
          "x=1",
          `git://localhost/${dn}`,
          "main:refs/heads/main",
          "main:refs/heads/new",
          ":refs/heads/feat",
        ],
        proxied(),
      );
      const g = await ours(o);
      const result = await g
        .push()
        .setRemote(`git://localhost/${dO}`)
        .setRefSpecs("main:refs/heads/main", "main:refs/heads/new", ":refs/heads/feat")
        .setAtomic(true)
        .setPushOptions(["x=1"])
        .setTransports(viaDaemon())
        .call();
      expect(result.remoteUpdates.map((u) => [u.remoteName, u.status]).sort()).toEqual([
        ["refs/heads/feat", "ok"],
        ["refs/heads/main", "ok"],
        ["refs/heads/new", "ok"],
      ]);
      expect(refs(join(srv, dO))).toBe(refs(join(srv, dn)));
      git(join(srv, dO), "fsck", "--strict");
    });
  });

  describe("our server behind git://127.0.0.1:<port>", () => {
    let server: { port: number; close(): Promise<void> };
    let enableReceivePack = true;
    beforeAll(async () => {
      const [, host] = twins();
      const g = await ours(host);
      server = await startTcpServer((duplex) =>
        serveGitConnection({
          duplex,
          enableReceivePack,
          // git daemon --export-all --base-path=<srv>, as the test daemon runs
          resolveRepository: createBasePathResolver({
            files: createNodeFilesApi({ rootDir: root }),
            basePath: "/srv",
            exportAll: true,
            openRepository: async (gitDir) => {
              const opened = await openLocalRemote(g.workingCopy, `..${gitDir}`).catch(
                () => undefined,
              );
              return opened && (await servedRepositoryOf(opened));
            },
          }),
        }),
      );
    });
    afterAll(async () => server?.close());
    const url = (path: string) => `git://127.0.0.1:${server.port}/${path}`;

    for (const version of ["0", "1", "2"]) {
      it(`ls-remote, clone, fetch (protocol v${version}) as from git daemon`, async () => {
        const c = ["-c", `protocol.version=${version}`];
        const ourList = await gitAsync(root, root, [...c, "ls-remote", url("src")]);
        const daemonList = await gitAsync(root, root, [...c, "ls-remote", "git://localhost/src"], {
          GIT_PROXY_COMMAND: scripts.proxy,
        });
        expect(ourList.status).toBe(0);
        expect(ourList.stdout).toBe(daemonList.stdout);

        const name = `sc${counter++}`;
        const cloned = await gitAsync(root, root, [...c, "clone", "-q", url("src"), name]);
        expect(cloned.stderr).toBe("");
        expect(cloned.status).toBe(0);
        const fetched = await gitAsync(root, join(root, name), [
          ...c,
          "fetch",
          "-q",
          "--depth=1",
          url("src"),
          "feat:refs/heads/f",
        ]);
        expect(fetched.status).toBe(0);
        expect(git(join(root, name), "rev-parse", "refs/heads/f")).toBe(
          git(join(srv, "src"), "rev-parse", "feat"),
        );
        git(join(root, name), "fsck");
      });
    }

    it("push (atomic, push options, a deletion) lands as through git daemon", async () => {
      const [dn, dO] = bareTwins("src");
      const name = `sp${counter++}`;
      git(root, "clone", "-q", join(srv, "src"), name);
      const dir = join(root, name);
      putFile(dir, "q.txt", "q\n");
      git(dir, "add", "q.txt");
      git(dir, "commit", "-qm", "q");
      const args = ["push", "--porcelain", "--atomic", "-o", "x=1"];
      const specs = ["main:refs/heads/main", "main:refs/heads/new", ":refs/heads/feat"];
      const viaOurs = await gitAsync(root, dir, [...args, url(dO), ...specs]);
      const viaDaemon = await gitAsync(root, dir, [...args, `git://localhost/${dn}`, ...specs], {
        GIT_PROXY_COMMAND: scripts.proxy,
      });
      expect(viaOurs.status).toBe(0);
      expect(viaOurs.stdout.replace(url(dO), "URL")).toBe(
        viaDaemon.stdout.replace(`git://localhost/${dn}`, "URL"),
      );
      expect(refs(join(srv, dO))).toBe(refs(join(srv, dn)));
    });

    it("refuses an unknown repository, and receive-pack unless enabled, as git daemon does", async () => {
      const ourNope = await gitAsync(root, root, ["ls-remote", url("nope")]);
      const daemonNope = await gitAsync(root, root, ["ls-remote", "git://localhost/nope"], {
        GIT_PROXY_COMMAND: scripts.proxy,
      });
      expect(ourNope.status).toBe(128);
      expect(ourNope.stderr).toBe(daemonNope.stderr);
      expect(ourNope.stderr).toBe(
        "fatal: remote error: access denied or repository not exported: /nope\n",
      );
      // an alias git-daemon refuses before looking
      const alias = await gitAsync(root, root, ["ls-remote", url("x/../src")]);
      expect(alias.stderr).toBe(
        "fatal: remote error: access denied or repository not exported: /x/../src\n",
      );

      const [dn, dO] = bareTwins("src");
      enableReceivePack = false;
      try {
        const dir = join(srv, "src");
        const ourPush = await gitAsync(root, dir, ["push", url(dO), "main:refs/heads/x"]);
        const daemonPush = await gitAsync(
          root,
          dir,
          ["push", `git://localhost/${dn}`, "main:refs/heads/x"],
          {
            GIT_PROXY_COMMAND: scripts.proxyNoReceive,
          },
        );
        expect(ourPush.status).toBe(128);
        expect(ourPush.stderr.replace(String(server.port), "PORT")).toBe(
          daemonPush.stderr.replace(dn, dO).replace("localhost", "127.0.0.1:PORT"),
        );
      } finally {
        enableReceivePack = true;
      }
    });

    it("our client against our server over TCP: clone and push", async () => {
      const [, o] = twins();
      const transports = createDefaultTransports({ openSocket: openTcpSocket });
      const g = await ours(o);
      await g
        .fetch()
        .setRemote(url("src"))
        .setRefSpecs("main:refs/heads/main2")
        .setTransports(transports)
        .call();
      expect(git(join(root, o), "rev-parse", "refs/heads/main2")).toBe(
        git(join(srv, "src"), "rev-parse", "main"),
      );
      const [, dO] = bareTwins();
      const result = await (await ours(o))
        .push()
        .setRemote(url(dO))
        .setRefSpecs("refs/heads/main2:refs/heads/main")
        .setTransports(transports)
        .call();
      expect(result.remoteUpdates.map((u) => u.status)).toEqual(["ok"]);
      expect(git(join(srv, dO), "rev-parse", "main")).toBe(
        git(join(srv, "src"), "rev-parse", "main"),
      );
    });
  });

  describe("our client over ssh, git's command run locally", () => {
    const sshEnv = () => ({ GIT_SSH_COMMAND: scripts.ssh, GIT_SSH_VARIANT: "ssh" });

    it("clone and fetch (ssh:// and scp-like) run git's command, as native git over ssh", async () => {
      const [n, o] = twins();
      gitOut(root, root, ["clone", "-q", `ssh://me@localhost:2222${srv}/src`, n], sshEnv());
      const calls: string[] = [];
      const transports = createDefaultTransports({ exec: localSshExec(root, calls) });
      await (await ours(o))
        .clone()
        .setURI(`ssh://me@localhost:2222${srv}/src`)
        .setTransports(transports)
        .call();
      expect(refs(join(root, o))).toBe(refs(join(root, n)));
      expect(calls).toEqual([
        `me@localhost:2222 git-upload-pack '${srv}/src' {"GIT_PROTOCOL":"version=2"}`,
      ]);

      calls.length = 0;
      const [, o2] = twins();
      git(join(root, o2), "config", "protocol.version", "1");
      await (await ours(o2))
        .fetch()
        .setRemote(`localhost:${srv}/src`)
        .setRefSpecs("feat:refs/heads/f")
        .setTransports(transports)
        .call();
      expect(git(join(root, o2), "rev-parse", "refs/heads/f")).toBe(
        git(join(srv, "src"), "rev-parse", "feat"),
      );
      expect(calls).toEqual([
        `localhost git-upload-pack '${srv}/src' {"GIT_PROTOCOL":"version=1"}`,
      ]);
    });

    it("push runs git-receive-pack (protocol v0), remote.<name>.receivepack overrides it", async () => {
      const [dn, dO] = bareTwins("src");
      const [n, o] = twins();
      rmSync(join(root, n), { recursive: true, force: true });
      git(root, "clone", "-q", join(srv, "src"), n);
      git(join(root, o), "fetch", "-q", join(srv, "src"), "main");
      git(join(root, o), "reset", "-q", "--hard", "FETCH_HEAD");
      for (const d of [n, o]) {
        putFile(join(root, d), "s.txt", "s\n");
        git(join(root, d), "add", "s.txt");
        git(join(root, d), "commit", "-qm", "s");
      }
      gitOut(
        root,
        join(root, n),
        ["push", "-q", `localhost:${srv}/${dn}`, "main:refs/heads/main", ":refs/heads/feat"],
        sshEnv(),
      );
      git(join(root, o), "remote", "add", "up", `localhost:${srv}/${dO}`);
      git(join(root, o), "config", "remote.up.receivepack", "git receive-pack");
      const calls: string[] = [];
      await (await ours(o))
        .push()
        .setRemote("up")
        .setRefSpecs("main:refs/heads/main", ":refs/heads/feat")
        .setTransports(createDefaultTransports({ exec: localSshExec(root, calls) }))
        .call();
      expect(refs(join(srv, dO))).toBe(refs(join(srv, dn)));
      expect(calls).toEqual([`localhost git receive-pack '${srv}/${dO}' {}`]);
    });

    it("a path git quotes, ls-remote --upload-pack, option-looking hosts and paths blocked", async () => {
      const name = "it's !here.git";
      git(srv, "init", "-q", "--bare", "-b", "main", name);
      git(join(srv, "src"), "push", "-q", join(srv, name), "main");
      const [, o] = twins();
      const calls: string[] = [];
      const transports = createDefaultTransports({ exec: localSshExec(root, calls) });
      const listed = await (await ours(o))
        .lsRemote()
        .setRemote(`localhost:${srv}/${name}`)
        .setUploadPack("git upload-pack")
        .setTransports(transports)
        .call();
      expect(listed.refs.map((r) => r.name)).toEqual(["refs/heads/main"]);
      expect(calls).toEqual([
        `localhost git upload-pack '${srv}/it'\\''s '\\!'here.git' {"GIT_PROTOCOL":"version=2"}`,
      ]);
      const native = gitRun(root, root, ["ls-remote", `localhost:${srv}/${name}`], sshEnv());
      expect(native.status).toBe(0);
      expect(lsRemoteLines(native.stdout).filter((l) => !l.startsWith("HEAD "))).toEqual(
        listed.refs.map((r) => `${r.name} ${r.objectId}`),
      );

      const fails = async (url: string) => {
        try {
          await (await ours(o)).lsRemote().setRemote(url).setTransports(transports).call();
        } catch (e) {
          return (e as GitApiError).message;
        }
        return undefined;
      };
      expect(await fails("ssh://-oProxyCommand=x/r")).toBe(
        "fatal: strange hostname '-oProxyCommand=x' blocked",
      );
      expect(await fails("host:-x")).toBe("fatal: strange pathname '-x' blocked");
      expect(await fails("u@-oProxyCommand=x:r.git")).toBe(
        "fatal: strange hostname 'u@-oProxyCommand=x' blocked",
      );
      expect(calls.length).toBe(1);
    });

    it("remote.<name>.uploadpack for fetch and ls-remote, --upload-pack over it; clone -u", async () => {
      const [, o] = twins();
      git(join(root, o), "remote", "add", "up", `localhost:${srv}/src`);
      git(join(root, o), "config", "remote.up.uploadpack", "git upload-pack");
      const calls: string[] = [];
      const transports = createDefaultTransports({ exec: localSshExec(root, calls) });
      await (await ours(o)).lsRemote().setRemote("up").setTransports(transports).call();
      await (await ours(o))
        .fetch()
        .setRemote("up")
        .setRefSpecs("feat:refs/heads/f")
        .setTransports(transports)
        .call();
      await (await ours(o))
        .fetch()
        .setRemote("up")
        .setUploadPack("git-upload-pack")
        .setRefSpecs("main:refs/heads/m")
        .setTransports(transports)
        .call();
      expect(git(join(root, o), "rev-parse", "refs/heads/f")).toBe(
        git(join(srv, "src"), "rev-parse", "feat"),
      );
      const v2 = '{"GIT_PROTOCOL":"version=2"}';
      expect(calls).toEqual([
        `localhost git upload-pack '${srv}/src' ${v2}`,
        `localhost git upload-pack '${srv}/src' ${v2}`,
        `localhost git-upload-pack '${srv}/src' ${v2}`,
      ]);

      calls.length = 0;
      const [, c] = twins();
      await (await ours(c))
        .clone()
        .setURI(`localhost:${srv}/src`)
        .setUploadPack("git upload-pack")
        .setTransports(transports)
        .call();
      expect(calls).toEqual([`localhost git upload-pack '${srv}/src' ${v2}`]);
      // as git's clone, -u is not written to the new remote's config
      expect(gitRun(root, join(root, c), ["config", "remote.origin.uploadpack"]).status).toBe(1);
    });
  });
});
