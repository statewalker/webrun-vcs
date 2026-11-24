/**
 * Credentials and headers of the commands that reach several remotes in one call
 * (`fetchMultiple`, `remoteUpdate`, `remoteShow`, `remotePrune`) go only to the origins they
 * were given for: remotes are configuration and may name any host, as `.gitmodules` may for
 * submodules (statewalker-root#308's rule, `GuardedTransportCommand`). Connectors record what
 * each connection was given: a native `test://` connector serving `<root>/src` for every
 * host, a smart-HTTP `testhttp://` connector whose server redirects one host to another.
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
import { Git } from "../src/index.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { gitOut, putFile, testEnv } from "./status-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root: string;
let counter = 0;
const git = (cwd: string, ...args: string[]) => gitOut(root, cwd, args);

const CREDENTIALS = { username: "alice", token: "t0ken" };
const HEADERS = { "X-Token": "s3cret" };

/** What each connection carried: `<host> <credentials?> <header?>`. */
let seen: string[] = [];

function record(host: string, user: string | undefined, header: string | null | undefined) {
  seen.push(`${host} ${user ?? "-"} ${header ?? "-"}`);
}

function transportsFor(g: Git): GitTransportRegistry {
  const open = (): Promise<OpenedRepository> => openLocalRemote(g.workingCopy, "../src");
  const transports = createDefaultTransports();
  transports.register({
    name: "test-native",
    schemes: ["test"],
    async connect(request: GitConnectRequest) {
      record(request.url.host ?? "", request.credentials?.username, request.headers?.["X-Token"]);
      const repo = await open();
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
    resolveRepository: async () => {
      const repo = await open();
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
      const host = request.url.host ?? "";
      return {
        kind: "http",
        baseUrl: `http://${host}/src`,
        fetchImpl: async (req: Request) => {
          const url = new URL(req.url);
          const auth = req.headers.get("authorization");
          record(url.host, auth ? "auth" : undefined, req.headers.get("x-token"));
          // redirect.example sends every request on to evil.example
          if (url.host === "redirect.example") {
            return new Response(null, {
              status: 307,
              headers: { location: `http://evil.example${url.pathname}${url.search}` },
            });
          }
          return handler(req);
        },
      };
    },
  });
  return transports;
}

/** A clone of `src` with `remotes` (name to URL) configured, opened as ours. */
async function repo(remotes: Record<string, string>, extra: string[][] = []): Promise<Git> {
  const name = `r${counter++}`;
  mkdirSync(join(root, name));
  git(join(root, name), "init", "-q", "-b", "main");
  for (const [remote, url] of Object.entries(remotes)) {
    git(join(root, name), "remote", "add", remote, url);
  }
  for (const args of extra) git(join(root, name), ...args);
  const plain = await openOurs(
    root,
    createNodeGitHostEnvironment({ env: testEnv(root) }),
    undefined,
    name,
  );
  return Git.fromWorkingCopy(plain.workingCopy, { transports: transportsFor(plain) });
}

const TRUSTED = "test://trusted.example/src";
const EVIL = "test://evil.example/src";

describeGit("credentials of commands reaching several remotes", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "multi-auth-"));
    const src = join(root, "src");
    mkdirSync(src);
    git(src, "init", "-q", "-b", "main");
    putFile(src, "a.txt", "a\n");
    git(src, "add", "a.txt");
    git(src, "commit", "-qm", "one");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  beforeEach(() => {
    seen = [];
  });

  it("fetch --all: remotes on two origins get no static credentials or headers", async () => {
    const g = await repo({ origin: TRUSTED, fork: EVIL });
    const result = await g
      .fetchMultiple()
      .setAll(true)
      .setCredentials(CREDENTIALS)
      .setHeaders(HEADERS)
      .call();
    expect(result.exitCode).toBe(0);
    expect(seen).toEqual(["trusted.example - -", "evil.example - -"]);
  });

  it("fetch --all: a named origin gets them, the other none", async () => {
    const g = await repo({ origin: TRUSTED, fork: EVIL });
    await g
      .fetchMultiple()
      .setAll(true)
      .setCredentials(CREDENTIALS)
      .setHeaders(HEADERS)
      .addCredentialOrigin("test://trusted.example")
      .call();
    expect(seen).toEqual(["trusted.example alice s3cret", "evil.example - -"]);
  });

  it("fetch --all: remotes all on the default remote's origin get them", async () => {
    const g = await repo({ origin: TRUSTED, mirror: "test://trusted.example/src" });
    await g.fetchMultiple().setAll(true).setCredentials(CREDENTIALS).setHeaders(HEADERS).call();
    expect(seen).toEqual(["trusted.example alice s3cret", "trusted.example alice s3cret"]);
  });

  it("a per-URL provider answers for its URL's origin alone", async () => {
    const g = await repo({ origin: TRUSTED, fork: EVIL });
    await g
      .fetchMultiple()
      .setAll(true)
      .setCredentialsForUrl((url) => (url.startsWith("test://evil.") ? CREDENTIALS : undefined))
      .setHeadersForUrl(() => undefined)
      .call();
    expect(seen).toEqual(["trusted.example - -", "evil.example alice -"]);
  });

  it("remote update: no static credentials across origins, a named one gets them", async () => {
    let g = await repo({ origin: TRUSTED, fork: EVIL });
    await g.remoteUpdate().setCredentials(CREDENTIALS).setHeaders(HEADERS).call();
    expect(seen).toEqual(["trusted.example - -", "evil.example - -"]);
    seen = [];
    g = await repo({ origin: TRUSTED, fork: EVIL });
    await g
      .remoteUpdate()
      .setCredentials(CREDENTIALS)
      .setHeaders(HEADERS)
      .addCredentialOrigin(TRUSTED)
      .call();
    expect(seen).toEqual(["trusted.example alice s3cret", "evil.example - -"]);
  });

  it("a group holding a plain URL: the URL gets nothing", async () => {
    const g = await repo({ origin: TRUSTED }, [["config", "remotes.g", `origin ${EVIL}`]]);
    const result = await g
      .fetchMultiple()
      .setRemotes("g")
      .setCredentials(CREDENTIALS)
      .setHeaders(HEADERS)
      .addCredentialOrigin(TRUSTED)
      .call();
    expect(result.stdout).toBe(`Fetching origin\nFetching ${EVIL}\n`);
    expect(seen).toEqual(["trusted.example alice s3cret", "evil.example - -"]);
    // nested groups: the inner group's remotes are checked as well
    seen = [];
    const nested = await repo({ origin: TRUSTED, fork: EVIL }, [
      ["config", "remotes.inner", "fork origin"],
      ["config", "remotes.outer", "inner origin"],
    ]);
    await nested
      .remoteUpdate()
      .setGroups("outer")
      .setCredentials(CREDENTIALS)
      .addCredentialOrigin(TRUSTED)
      .call();
    expect(seen).toEqual([
      "evil.example - -",
      "trusted.example alice -",
      "trusted.example alice -",
    ]);
  });

  it("remote show with two names, and remote prune, send nothing across origins", async () => {
    const g = await repo({ origin: TRUSTED, fork: EVIL });
    await g
      .remoteShow()
      .setRemoteNames("origin", "fork")
      .setCredentials(CREDENTIALS)
      .setHeaders(HEADERS)
      .callText();
    expect(seen).toEqual(["trusted.example - -", "evil.example - -"]);
    seen = [];
    await g
      .remotePrune()
      .setRemoteNames("origin", "fork")
      .setCredentials(CREDENTIALS)
      .setHeaders(HEADERS)
      .addCredentialOrigin(TRUSTED)
      .call();
    expect(seen).toEqual(["trusted.example alice s3cret", "evil.example - -"]);
    // one remote, the default's origin: it gets them
    seen = [];
    await g
      .remoteShow()
      .setRemoteNames("origin")
      .setCredentials(CREDENTIALS)
      .setHeaders(HEADERS)
      .callText();
    expect(seen).toEqual(["trusted.example alice s3cret"]);
  });

  it("smart HTTP: a redirect to another origin carries no credentials", async () => {
    const g = await repo({ origin: "testhttp://redirect.example/src" });
    await g
      .remoteShow()
      .setRemoteNames("origin")
      .setCredentials(CREDENTIALS)
      .setHeaders(HEADERS)
      .addCredentialOrigin("testhttp://redirect.example/src")
      .callText();
    // each request is sent on: with them to the origin named, without them to the other
    const evil = seen.filter((l) => l.startsWith("evil.example "));
    expect(evil.length).toBeGreaterThan(0);
    for (const line of evil) expect(line).toBe("evil.example - -");
    for (const line of seen.filter((l) => !l.startsWith("evil.example "))) {
      expect(line).toBe("redirect.example auth s3cret");
    }
  });
});
