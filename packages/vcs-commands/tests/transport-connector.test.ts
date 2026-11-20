/**
 * Remote commands over registered transport connectors: a `test://` connector returning a
 * native session (our upload-pack / receive-pack served in process over an in-memory duplex,
 * the peer speaking first) and a `testhttp://` connector returning a smart-HTTP session (our
 * `createFetchHandler` called in process). fetch, ls-remote, clone, push and pull go through
 * them, and leave what native git leaves fetching the same repositories by path.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDefaultTransports,
  createFetchHandler,
  createRepositoryFacade,
  createTransportRefStore,
  type GitConnectRequest,
  type GitTransportRegistry,
  serveOverDuplex,
} from "@statewalker/vcs-transport";
import { createNodeGitHostEnvironment } from "@statewalker/vcs-utils-node/files";
import type { OpenedRepository } from "@statewalker/vcs-working-tree";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createDuplexPair, openLocalRemote } from "../src/commands/local-transport.js";
import { Git, type GitApiError } from "../src/index.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { gitOut, putFile, testEnv } from "./status-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root: string;
let counter = 0;
const git = (cwd: string, ...args: string[]) => gitOut(root, cwd, args);

async function ours(name: string): Promise<Git> {
  return openOurs(root, createNodeGitHostEnvironment({ env: testEnv(root) }), undefined, name);
}

/** Two empty repositories, `n<k>` (native) and `o<k>` (ours). */
function twins(): [string, string] {
  const names: [string, string] = [`n${counter}`, `o${counter}`];
  counter++;
  for (const name of names) {
    mkdirSync(join(root, name));
    git(join(root, name), "init", "-q", "-b", "main");
  }
  return names;
}

const refs = (dir: string) =>
  git(join(root, dir), "for-each-ref", "--format=%(refname) %(objectname)");

/** Every connect a connector was asked for: `<connector> <service> <path> v<version>`. */
let calls: string[] = [];

/**
 * The transports of the tests: `test://<host>/<repo>` serves `<root>/<repo>` natively,
 * `testhttp://<host>/<repo>` over smart HTTP, both opened through `git`'s working copy.
 */
function transportsFor(g: Git): GitTransportRegistry {
  const open = (path: string): Promise<OpenedRepository> =>
    openLocalRemote(g.workingCopy, `..${path}`);
  const transports = createDefaultTransports();
  transports.register({
    name: "test-native",
    schemes: ["test"],
    async connect(request: GitConnectRequest) {
      calls.push(`native ${request.service} ${request.url.path} v${request.protocolVersion}`);
      const repo = await open(request.url.path);
      const [client, server] = createDuplexPair();
      const head = await repo.history.refs.get("HEAD");
      void serveOverDuplex({
        duplex: server,
        repository: createRepositoryFacade({ history: repo.history }),
        refStore: createTransportRefStore(repo.history.refs),
        service: request.service,
        bare: repo.bare,
        ...(head && "target" in head ? { currentBranch: head.target } : {}),
        ...(request.service === "git-upload-pack" && request.protocolVersion === 2
          ? { protocolVersion: "2" as const }
          : {}),
      }).finally(() => server.close?.());
      return { kind: "native", duplex: client, handshake: "implicit" };
    },
  });
  const handler = createFetchHandler({
    resolveRepository: async (repoPath) => {
      const repo = await open(repoPath).catch(() => undefined);
      if (!repo) return null;
      return {
        repository: createRepositoryFacade({ history: repo.history }),
        refStore: createTransportRefStore(repo.history.refs),
      };
    },
  });
  transports.register({
    name: "test-http",
    schemes: ["testhttp"],
    async connect(request) {
      calls.push(`http ${request.service} ${request.url.path} v${request.protocolVersion}`);
      return {
        kind: "http",
        baseUrl: `http://in-process${request.url.path}`,
        fetchImpl: (req: Request) => handler(req),
      };
    },
  });
  return transports;
}

describeGit("remote commands over registered connectors", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "connector-"));
    const src = join(root, "src");
    mkdirSync(src);
    git(src, "init", "-q", "-b", "main");
    putFile(src, "a.txt", "a\n");
    git(src, "add", "a.txt");
    git(src, "commit", "-qm", "one");
    git(src, "tag", "-a", "-m", "v1", "v1");
    git(src, "checkout", "-q", "-b", "feat");
    putFile(src, "b.txt", "b\n");
    git(src, "add", "b.txt");
    git(src, "commit", "-qm", "two");
    git(src, "checkout", "-q", "main");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  beforeEach(() => {
    calls = [];
  });

  for (const scheme of ["test", "testhttp"] as const) {
    const kind = scheme === "test" ? "native" : "http";

    it(`${scheme}: ls-remote and fetch`, async () => {
      const [n, o] = twins();
      const g = await ours(o);
      const transports = transportsFor(g);
      const url = `${scheme}://peer/src`;

      const native = git(join(root, n), "ls-remote", "../src")
        .split("\n")
        .filter((l) => l && !l.endsWith("^{}") && !l.endsWith("\tHEAD"))
        .map((l) => l.split("\t").reverse().join(" "));
      const listed = await g.lsRemote().setRemote(url).setTransports(transports).call();
      expect(listed.refs.map((r) => `${r.name} ${r.objectId}`)).toEqual(native);
      expect(listed.uri).toBe(url);

      git(join(root, n), "fetch", "-q", "../src", "feat:refs/heads/f");
      await g
        .fetch()
        .setRemote(url)
        .setRefSpecs("feat:refs/heads/f")
        .setTransports(transports)
        .call();
      expect(refs(o)).toBe(refs(n));
      expect(calls).toEqual([`${kind} git-upload-pack /src v2`, `${kind} git-upload-pack /src v2`]);
    });

    it(`${scheme}: a configured remote, through the facade's transports; pull`, async () => {
      const [n, o] = twins();
      git(join(root, n), "remote", "add", "origin", "../src");
      git(join(root, o), "remote", "add", "origin", `${scheme}://peer/src`);
      git(join(root, o), "fetch", "-q", "../src", "main");
      git(join(root, o), "reset", "-q", "--hard", "FETCH_HEAD");
      const plain = await ours(o);
      const g = Git.fromWorkingCopy(plain.workingCopy, { transports: transportsFor(plain) });
      git(join(root, n), "fetch", "-q", "origin");
      await g.fetch().setRemote("origin").call();
      const tracking = (d: string) =>
        git(
          join(root, d),
          "for-each-ref",
          "--format=%(refname) %(objectname)",
          "refs/remotes/origin/",
        );
      expect(tracking(o).replace(/^refs\/remotes\/origin\/HEAD .*\n/m, "")).toBe(
        tracking(n).replace(/^refs\/remotes\/origin\/HEAD .*\n/m, ""),
      );
      const pulled = await g.pull().setRemote("origin").setRemoteBranchName("feat").call();
      expect(pulled.successful).toBe(true);
      expect(git(join(root, o), "rev-parse", "HEAD")).toBe(
        git(join(root, "src"), "rev-parse", "feat"),
      );
      expect(calls.length).toBe(2);
    });

    it(`${scheme}: clone`, async () => {
      const [n, o] = twins();
      rmSync(join(root, n), { recursive: true, force: true });
      git(root, "clone", "-q", "src", n);
      const g = await ours(o);
      await g.clone().setURI(`${scheme}://peer/src`).setTransports(transportsFor(g)).call();
      expect(refs(o)).toBe(refs(n));
      expect(git(join(root, o), "rev-parse", "HEAD")).toBe(git(join(root, n), "rev-parse", "HEAD"));
      expect(calls).toEqual([`${kind} git-upload-pack /src v2`]);
    });

    it(`${scheme}: push (receive-pack, protocol v0)`, async () => {
      const [, o] = twins();
      git(root, "init", "-q", "--bare", `${o}-dst.git`);
      const dir = join(root, o);
      git(dir, "fetch", "-q", "../src", "main");
      git(dir, "reset", "-q", "--hard", "FETCH_HEAD");
      putFile(dir, "p.txt", "p\n");
      git(dir, "add", "p.txt");
      git(dir, "commit", "-qm", "pushed");
      const g = await ours(o);
      const result = await g
        .push()
        .setRemote(`${scheme}://peer/${o}-dst.git`)
        .setRefSpecs("main:refs/heads/pushed")
        .setTransports(transportsFor(g))
        .call();
      expect(result.remoteUpdates.map((u) => [u.remoteName, u.status])).toEqual([
        ["refs/heads/pushed", "ok"],
      ]);
      expect(git(join(root, `${o}-dst.git`), "rev-parse", "refs/heads/pushed")).toBe(
        git(dir, "rev-parse", "HEAD"),
      );
      expect(calls).toEqual([`${kind} git-receive-pack /${o}-dst.git v2`]);
    });
  }

  it("protocol.version=0 reaches the connector; protocol.<scheme>.allow applies", async () => {
    const [n, o] = twins();
    const g = await ours(o);
    git(join(root, o), "config", "protocol.version", "0");
    git(join(root, n), "fetch", "-q", "../src", "main:refs/heads/m");
    const v0 = await ours(o);
    await v0
      .fetch()
      .setRemote("test://peer/src")
      .setRefSpecs("main:refs/heads/m")
      .setTransports(transportsFor(g))
      .call();
    expect(refs(o)).toBe(refs(n));
    expect(calls).toEqual(["native git-upload-pack /src v0"]);

    git(join(root, o), "config", "protocol.test.allow", "never");
    let error: GitApiError | undefined;
    try {
      await (await ours(o))
        .fetch()
        .setRemote("test://peer/src")
        .setTransports(transportsFor(g))
        .call();
    } catch (e) {
      error = e as GitApiError;
    }
    expect(error?.message).toBe("fatal: transport 'test' not allowed");
    expect(error?.exitCode).toBe(128);
  });

  it("an ssh URL goes to a connector registered for ssh; without one, git's errors stay", async () => {
    const [, o] = twins();
    const g = await ours(o);
    const transports = transportsFor(g);
    transports.register({
      name: "ssh-test",
      schemes: ["ssh"],
      connect: async (request) => {
        calls.push(`ssh ${request.url.host} ${request.url.path} scp=${request.url.scpLike}`);
        const native = transports.resolve("test://x/y");
        return (native as NonNullable<typeof native>).connect({
          ...request,
          url: { ...request.url, path: `/${request.url.path}` },
        });
      },
    });
    const listed = await g.lsRemote().setRemote("peer:src").setTransports(transports).call();
    expect(listed.refs.some((r) => r.name === "refs/heads/feat")).toBe(true);
    expect(calls[0]).toBe("ssh peer src scp=true");

    const fails = async (url: string) => {
      try {
        await (await ours(o)).lsRemote().setRemote(url).setTransports(transportsFor(g)).call();
      } catch (e) {
        return (e as GitApiError).message;
      }
      return undefined;
    };
    expect(await fails("nope://peer/src")).toBe("fatal: unable to find remote helper for 'nope'");
    expect(await fails("nope::peer")).toBe("fatal: unable to find remote helper for 'nope'");
    expect(await fails("peer:src")).toBe(
      "fatal: cannot connect to 'peer:src': only http(s) and local repositories are reachable here",
    );
  });
});
