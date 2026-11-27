/**
 * Credentials and headers on the `--recurse-submodules` paths of clone, fetch, pull and push
 * (statewalker-root#332): a submodule's URL comes from `.gitmodules`, repository content that
 * can name any host, so the credentials and headers given for the superproject's remote go
 * to a submodule only on that remote's origin, never to another origin, and never across a
 * redirect to another origin (statewalker-root#308's rule, `guardSubmoduleTransports`).
 *
 * A smart-HTTP `testhttp://` connector serves the case's bare repositories by path for every
 * host and records what each request carried; a path under `/redir/` on any host is
 * redirected to `evil.example`. The superproject's remote is always
 * `testhttp://trusted.example/super.git`; its submodule's URL is on another origin, on the
 * same one, or on the same one redirecting to another.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDefaultTransports,
  createFetchHandler,
  createRepositoryFacade,
  createTransportRefStore,
  type GitTransportRegistry,
} from "@statewalker/vcs-transport";
import { createNodeGitHostEnvironment } from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { openLocalRemote } from "../src/commands/local-transport.js";
import { Git } from "../src/index.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { testEnv } from "./status-native-support.js";
import { CLEANUP_TIMEOUT, removeTempDir } from "./temp-dir-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

const CREDENTIALS = { username: "alice", token: "t0ken" };
const HEADERS = { "X-Token": "s3cret" };
const SUPER = "testhttp://trusted.example/super.git";

/** The submodule URLs: another origin, the superproject's, the superproject's redirecting. */
const SUB_URLS = {
  other: "testhttp://evil.example/sub.git",
  same: "testhttp://trusted.example/sub.git",
  redirect: "testhttp://trusted.example/redir/sub.git",
} as const;
type Kind = keyof typeof SUB_URLS;

/** Submodule clones run with GIT_PROTOCOL_FROM_USER=0: the test scheme allowed always. */
const ENV_EXTRA = { GIT_CONFIG_PARAMETERS: "'protocol.allow'='always'" };

let root: string;
let counter = 0;
/** What each request for the submodule's repository carried: `<host> <auth> <header>`. */
let seen: string[] = [];

function sh(cwd: string, script: string): void {
  execFileSync("bash", ["-euc", script], {
    cwd,
    env: { ...testEnv(root), GIT_CONFIG_PARAMETERS: "'protocol.file.allow'='always'" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** The connectors: every host serves the case's `<name>.git` for `/<name>.git` (and `/redir/...`). */
function transportsFor(g: Git): GitTransportRegistry {
  const transports = createDefaultTransports();
  const nameOf = (path: string) => /([^/]+\.git)/.exec(path)?.[1] ?? "";
  const handler = createFetchHandler({
    resolveRepository: async (path: string) => {
      const repo = await openLocalRemote(g.workingCopy, `../${nameOf(path)}`);
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
        baseUrl: `http://${host}${request.url.path ?? ""}`,
        fetchImpl: async (req: Request) => {
          const url = new URL(req.url);
          if (nameOf(url.pathname) === "sub.git") {
            const auth = req.headers.get("authorization");
            seen.push(`${url.host} ${auth ? "auth" : "-"} ${req.headers.get("x-token") ?? "-"}`);
          }
          if (url.pathname.startsWith("/redir/")) {
            return new Response(null, {
              status: 307,
              headers: {
                location: `http://evil.example${url.pathname.slice("/redir".length)}${url.search}`,
              },
            });
          }
          return handler(req);
        },
      };
    },
  });
  return transports;
}

/**
 * A case: `sub.git` and `super.git` (its gitlink at sub's first commit, `.gitmodules` naming
 * `subUrl`), `down` cloned from them with its submodule populated and every URL then set to
 * the test scheme; the upstreams moved on (sub's second commit recorded in super).
 */
function fixture(kind: Kind): string {
  const name = `c${counter++}`;
  const dir = join(root, name);
  mkdirSync(dir);
  const subUrl = SUB_URLS[kind];
  sh(
    dir,
    `git init -q -b main src-sub; (cd src-sub; echo a > a; git add a; git commit -qm a)
git clone -q --bare src-sub sub.git
A=$(git -C src-sub rev-parse HEAD)
git init -q -b main src-super; cd src-super; printf '[submodule "sub"]\\n\\tpath = sub\\n\\turl = ${subUrl}\\n' > .gitmodules
git add .gitmodules; git update-index --add --cacheinfo 160000 $A sub; git commit -qm super; cd ..
git clone -q --bare src-super super.git
git clone -q super.git down; git -C down remote set-url origin ${SUPER}
git -C down submodule -q init; git -C down config submodule.sub.url "$PWD/sub.git"
git -C down submodule -q update; git -C down config submodule.sub.url ${subUrl}
git -C down/sub remote set-url origin ${subUrl}
(cd src-sub; echo b > b; git add b; git commit -qm b; git push -q ../sub.git main)
B=$(git -C src-sub rev-parse HEAD)
(cd src-super; git update-index --cacheinfo 160000 $B sub; git commit -qm moved; git push -q ../super.git main)`,
  );
  return name;
}

/** Our working copy of `<case>/<sub>` with the recording transports. */
async function ours(caseDir: string, sub = "down"): Promise<Git> {
  const plain = await openOurs(
    root,
    createNodeGitHostEnvironment({ env: testEnv(root, ENV_EXTRA) }),
    undefined,
    `${caseDir}/${sub}`,
  );
  return Git.fromWorkingCopy(plain.workingCopy, { transports: transportsFor(plain) });
}

/** What the submodule's requests must carry for each kind of URL. */
function expectGuarded(kind: Kind): void {
  expect(seen.length, "the submodule was reached").toBeGreaterThan(0);
  if (kind === "same") {
    for (const line of seen) expect(line).toBe("trusted.example auth s3cret");
    return;
  }
  for (const line of seen.filter((l) => l.startsWith("evil.example "))) {
    expect(line).toBe("evil.example - -");
  }
  expect(seen.some((l) => l.startsWith("evil.example "))).toBe(true);
  // a redirect leaves from the trusted origin, which got them
  for (const line of seen.filter((l) => !l.startsWith("evil.example "))) {
    expect(line).toBe("trusted.example auth s3cret");
  }
}

describeGit("credentials on the --recurse-submodules paths", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "recurse-auth-"));
  });
  afterAll(() => removeTempDir(root), CLEANUP_TIMEOUT);
  beforeEach(() => {
    seen = [];
  });

  for (const kind of Object.keys(SUB_URLS) as Kind[]) {
    it(`fetch --recurse-submodules: a submodule on ${kind} origin`, async () => {
      const g = await ours(fixture(kind));
      await g
        .fetch()
        .setRemote("origin")
        .setCredentials(CREDENTIALS)
        .setHeaders(HEADERS)
        .setRecurseSubmodules(true)
        .call();
      expectGuarded(kind);
    });

    it(`pull --recurse-submodules (the update's fetch): a submodule on ${kind} origin`, async () => {
      const caseDir = fixture(kind);
      sh(
        join(root, caseDir, "down"),
        "git config submodule.recurse true; git config fetch.recurseSubmodules false",
      );
      const g = await ours(caseDir);
      const result = await g
        .pull()
        .setRebase(false)
        .setCredentials(CREDENTIALS)
        .setHeaders(HEADERS)
        .call();
      expect(result.submodules?.exitCode, result.submodules?.stderr).toBe(0);
      expectGuarded(kind);
    });

    it(`push --recurse-submodules=on-demand: a submodule on ${kind} origin`, async () => {
      const caseDir = fixture(kind);
      sh(
        join(root, caseDir, "down"),
        `git pull -q --no-rebase --no-recurse-submodules ${join(root, caseDir, "super.git")} main
(cd sub; git fetch -q ${join(root, caseDir, "sub.git")} main; git checkout -q -B main FETCH_HEAD
  git update-ref refs/remotes/origin/main FETCH_HEAD; echo c > c; git add c; git commit -qm c)
git add sub; git commit -qm "move sub"
git update-ref refs/remotes/origin/main $(git ls-remote ${join(root, caseDir, "super.git")} main | cut -f1)`,
      );
      const g = await ours(caseDir);
      const result = await g
        .push()
        .setRemote("origin")
        .setRefSpecs("main")
        .setCredentials(CREDENTIALS)
        .setHeaders(HEADERS)
        .setRecurseSubmodules("on-demand")
        .call();
      expect(result.submoduleOutput).toContain("Pushing submodule 'sub'");
      expectGuarded(kind);
    });

    it(`clone --recurse-submodules: a submodule on ${kind} origin`, async () => {
      const caseDir = fixture(kind);
      sh(join(root, caseDir), "git init -q -b main cl");
      const g = await ours(caseDir, "cl");
      const result = await g
        .clone()
        .setURI(SUPER)
        .setCredentials(CREDENTIALS)
        .setHeaders(HEADERS)
        .setRecurseSubmodules(true)
        .call();
      expect(result.submodules?.exitCode, result.submodules?.stderr).toBe(0);
      expectGuarded(kind);
    });
  }
});
