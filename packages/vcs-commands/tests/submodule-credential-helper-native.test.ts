/**
 * The credential helper on the submodule paths (statewalker/webrun-vcs#367): git runs its
 * submodule clones and fetches as child processes that read `credential.helper` (here from
 * `git -c`, which reaches them through `GIT_CONFIG_PARAMETERS`), so a submodule host
 * answering 401 asks the helper for that host. Ours hands `setCredentialHelper` to the
 * commands it builds for them: `clone --recurse-submodules`, `submodule update`,
 * `fetch --recurse-submodules` and `pull` updating submodules.
 *
 * Two loopback servers in front of native `git http-backend`, one origin each (the port
 * tells them apart, and the helper is asked with `host=127.0.0.1:<port>`), serve `/open/*`
 * to anyone and `/auth/*` only with Basic credentials. Native git decides the helper's
 * conversation and which origin received an `Authorization`: a helper's answer for one host
 * never goes to a submodule on another.
 */

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CredentialRequest, Credentials } from "@statewalker/vcs-transport";
import { createNodeGitHostEnvironment } from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Git } from "../src/index.js";
import { type LoopbackServer, serveOnLoopback } from "./http-loopback-support.js";
import { openOurs } from "./merge-native-helpers.js";
import { gitAsync } from "./native-connect-support.js";
import { nativeGitAvailable, nativeGitHttpBackend } from "./native-git-http-backend.js";
import { gitOut, testEnv } from "./status-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

const USER = "alice";
const PASS = "secret-passwd";
const BASIC = `Basic ${Buffer.from(`${USER}:${PASS}`).toString("base64")}`;

let root: string;
let srv: string;
let work: string;
let backend: ReturnType<typeof nativeGitHttpBackend>;
/** The superproject's server and the submodule's: two origins */
let serverA: LoopbackServer;
let serverB: LoopbackServer;
/** `<host> <auth|-> <status>` of every request, as each server saw it */
let seen: string[] = [];
let counter = 0;

const git = (cwd: string, ...args: string[]) => gitOut(root, cwd, args);
const hostOf = (s: LoopbackServer) => new URL(s.baseUrl).host;

function routeFor(): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    const auth = request.headers.get("authorization");
    const m = /^\/(open|auth)(\/.*)$/.exec(url.pathname);
    let response: Response;
    if (!m) response = new Response("not found\n", { status: 404 });
    else if (m[1] === "auth" && auth !== BASIC) {
      response = new Response("no\n", {
        status: 401,
        headers: { "WWW-Authenticate": 'Basic realm="example.com"' },
      });
    } else {
      response = await backend.fetch(
        new Request(`${url.origin}${m[2]}${url.search}`, {
          method: request.method,
          headers: request.headers,
          ...(request.method === "POST" ? { body: request.body, duplex: "half" } : {}),
        } as RequestInit),
      );
    }
    seen.push(`${url.host} ${auth ? "auth" : "-"} ${response.status}`);
    return response;
  };
}

/** The origins that received each kind of request: sorted, without repeats. */
const shape = (lines: string[]) => [...new Set(lines)].sort();

/** A credential helper script logging what git asks, answering `get` with alice's password. */
function nativeHelper(): { config: string[]; log: () => string[][] } {
  const dir = join(root, `helper-${counter++}`);
  mkdirSync(dir);
  const logFile = join(dir, "log");
  const script = join(dir, "helper.sh");
  writeFileSync(
    script,
    `#!/bin/sh\n{ echo "action=$1"; sed -n -e '/^$/q' -e p; echo; } >>"${logFile}"\nif test "$1" = get; then printf 'username=${USER}\\npassword=${PASS}\\n'; fi\n`,
  );
  chmodSync(script, 0o755);
  return {
    config: ["-c", `credential.helper=${script}`],
    log: () => {
      let text = "";
      try {
        text = readFileSync(logFile, "utf8");
      } catch {
        return [];
      }
      return text
        .split("\n\n")
        .filter((block) => block.trim() !== "")
        .map((block) =>
          block.split("\n").filter((line) => /^(action|protocol|host|username)=/.test(line)),
        );
    },
  };
}

/** Ours: the same conversation, as the helper script logs it. */
function ourHelper() {
  const log: string[][] = [];
  const lines = (action: string, request: CredentialRequest, credentials?: Credentials) => [
    `action=${action}`,
    `protocol=${request.protocol}`,
    `host=${request.host}`,
    ...(credentials?.username !== undefined ? [`username=${credentials.username}`] : []),
  ];
  return {
    log,
    helper: {
      fill(request: CredentialRequest) {
        log.push(lines("get", request));
        return { username: USER, password: PASS };
      },
      approve(credentials: Credentials, request: CredentialRequest) {
        log.push(lines("store", request, credentials));
      },
      reject(credentials: Credentials, request: CredentialRequest) {
        log.push(lines("erase", request, credentials));
      },
    },
  };
}

/** git's helper log in our order of keys. */
function sortedLog(log: string[][]): string[][] {
  const order = ["action", "protocol", "host", "username"];
  return log.map((lines) =>
    [...lines].sort(
      (a, b) =>
        order.indexOf(a.slice(0, a.indexOf("="))) - order.indexOf(b.slice(0, b.indexOf("="))),
    ),
  );
}

async function ours(dir: string): Promise<Git> {
  return openOurs(
    root,
    createNodeGitHostEnvironment({ env: testEnv(root) }),
    undefined,
    dir.slice(root.length + 1),
  );
}

/** A fresh empty directory under the root, its path. */
function fresh(prefix: string): string {
  const dir = join(root, `${prefix}-${counter++}`);
  mkdirSync(dir);
  return dir;
}

/** A native clone from the in-process servers: never `spawnSync`, which blocks them. */
async function cloned(args: string[]): Promise<void> {
  const run = await gitAsync(root, root, args);
  if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
}

const head = (dir: string) => git(dir, "rev-parse", "HEAD").trim();

describeGit("the credential helper on the submodule paths, as native git", () => {
  /** super-locked-sub.git: its submodule on B's `/auth/`; super-open-sub.git: on B's `/open/` */
  let subCommit: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "submodule-helper-"));
    srv = join(root, "srv");
    mkdirSync(srv);
    backend = nativeGitHttpBackend(srv, root);
    serverA = await serveOnLoopback(routeFor());
    serverB = await serveOnLoopback(routeFor());
    work = join(root, "work");
    mkdirSync(work);
    git(work, "init", "-q", "-b", "main", "sub");
    writeFileSync(join(work, "sub", "a"), "a\n");
    git(join(work, "sub"), "add", "a");
    git(join(work, "sub"), "commit", "-qm", "a");
    git(work, "clone", "-q", "--bare", "sub", join(srv, "sub.git"));
    subCommit = head(join(work, "sub"));
    for (const [name, kind] of [
      ["super-locked-sub", "auth"],
      ["super-open-sub", "open"],
    ] as const) {
      const dir = join(work, name);
      git(work, "init", "-q", "-b", "main", name);
      writeFileSync(
        join(dir, ".gitmodules"),
        `[submodule "sub"]\n\tpath = sub\n\turl = ${serverB.baseUrl}/${kind}/sub.git\n`,
      );
      git(dir, "add", ".gitmodules");
      git(dir, "update-index", "--add", "--cacheinfo", `160000,${subCommit},sub`);
      git(dir, "commit", "-qm", "super");
      git(work, "clone", "-q", "--bare", name, join(srv, `${name}.git`));
    }
  });

  afterAll(async () => {
    await serverA?.close();
    await serverB?.close();
    backend?.close();
    rmSync(root, { recursive: true, force: true });
  });

  /** `git clone --recurse-submodules <url>` on each side, the helper given to both. */
  async function cloneTwins(url: string) {
    const native = fresh("native");
    const helper = nativeHelper();
    seen = [];
    const nativeRun = await gitAsync(root, native, [
      ...helper.config,
      "clone",
      "-q",
      "--recurse-submodules",
      url,
      "dest",
    ]);
    const nativeSeen = seen;
    const ourDir = join(fresh("ours"), "dest");
    git(root, "init", "-q", "-b", "main", ourDir);
    const g = await ours(ourDir);
    const mine = ourHelper();
    seen = [];
    const result = await g
      .clone()
      .setURI(url)
      .setRecurseSubmodules(true)
      .setCredentialHelper(mine.helper)
      .call();
    return {
      native: {
        status: nativeRun.status,
        stderr: nativeRun.stderr,
        log: sortedLog(helper.log()),
        seen: shape(nativeSeen),
        sub: head(join(native, "dest", "sub")),
      },
      ours: {
        submodules: result.submodules,
        log: mine.log,
        seen: shape(seen),
        sub: head(join(ourDir, "sub")),
      },
    };
  }

  it("clone --recurse-submodules: the helper answers the submodule host's 401", async () => {
    const twins = await cloneTwins(`${serverA.baseUrl}/open/super-locked-sub.git`);
    expect(twins.native.status, twins.native.stderr).toBe(0);
    expect(twins.native.log.map((l) => l.find((x) => x.startsWith("host=")))).toContain(
      `host=${hostOf(serverB)}`,
    );
    expect(twins.ours.submodules?.exitCode, twins.ours.submodules?.stderr).toBe(0);
    expect(twins.ours.log).toEqual(twins.native.log);
    expect(twins.ours.seen).toEqual(twins.native.seen);
    expect(twins.ours.sub).toBe(subCommit);
    expect(twins.ours.sub).toBe(twins.native.sub);
  });

  it("clone --recurse-submodules: the superproject host's answer never reaches the submodule's host", async () => {
    const twins = await cloneTwins(`${serverA.baseUrl}/auth/super-open-sub.git`);
    expect(twins.native.status, twins.native.stderr).toBe(0);
    expect(twins.native.seen.filter((l) => l.startsWith(`${hostOf(serverB)} `))).toEqual([
      `${hostOf(serverB)} - 200`,
    ]);
    expect(twins.ours.submodules?.exitCode, twins.ours.submodules?.stderr).toBe(0);
    expect(twins.ours.log).toEqual(twins.native.log);
    expect(twins.ours.seen).toEqual(twins.native.seen);
    expect(twins.ours.sub).toBe(twins.native.sub);
  });

  /** A clone of super-locked-sub (submodule not populated) on each side, by native git. */
  async function unpopulatedTwins(): Promise<{ native: string; ours: string }> {
    const url = `${serverA.baseUrl}/open/super-locked-sub.git`;
    const native = join(fresh("native"), "dest");
    const mine = join(fresh("ours"), "dest");
    for (const dir of [native, mine]) await cloned(["clone", "-q", url, dir]);
    return { native, ours: mine };
  }

  it("submodule update --init: the helper answers the submodule host's 401", async () => {
    const dirs = await unpopulatedTwins();
    const helper = nativeHelper();
    seen = [];
    const nativeRun = await gitAsync(root, dirs.native, [
      ...helper.config,
      "submodule",
      "update",
      "--init",
    ]);
    const nativeSeen = shape(seen);
    expect(nativeRun.status, nativeRun.stderr).toBe(0);

    const g = await ours(dirs.ours);
    const mine = ourHelper();
    seen = [];
    const result = await g.submoduleUpdate().setInit(true).setCredentialHelper(mine.helper).call();
    expect(result.exitCode, result.stderr).toBe(0);
    expect(mine.log).toEqual(sortedLog(helper.log()));
    expect(shape(seen)).toEqual(nativeSeen);
    expect(head(join(dirs.ours, "sub"))).toBe(head(join(dirs.native, "sub")));
  });

  it("submodule update (fetch of a commit the submodule lacks) and fetch --recurse-submodules: the helper answers", async () => {
    // both sides populated by native git with the helper, then sub and super move on
    const url = `${serverA.baseUrl}/open/super-locked-sub.git`;
    const native = join(fresh("native"), "dest");
    const mine = join(fresh("ours"), "dest");
    for (const dir of [native, mine]) {
      await cloned([...nativeHelper().config, "clone", "-q", "--recurse-submodules", url, dir]);
    }
    const n = counter++;
    writeFileSync(join(work, "sub", `b${n}`), "b\n");
    git(join(work, "sub"), "add", ".");
    git(join(work, "sub"), "commit", "-qm", `b${n}`);
    git(join(work, "sub"), "push", "-q", join(srv, "sub.git"), "main");
    const moved = head(join(work, "sub"));
    const superDir = join(work, "super-locked-sub");
    git(superDir, "update-index", "--cacheinfo", `160000,${moved},sub`);
    git(superDir, "commit", "-qm", `moved ${n}`);
    git(superDir, "push", "-q", join(srv, "super-locked-sub.git"), "main");

    // fetch --recurse-submodules: the submodule's child fetch
    const helper = nativeHelper();
    seen = [];
    const nativeFetch = await gitAsync(root, native, [
      ...helper.config,
      "fetch",
      "-q",
      "--recurse-submodules=yes",
    ]);
    expect(nativeFetch.status, nativeFetch.stderr).toBe(0);
    const nativeSeen = shape(seen);
    const g = await ours(mine);
    const fetchHelper = ourHelper();
    seen = [];
    await g
      .fetch()
      .setRemote("origin")
      .setRecurseSubmodules(true)
      .setCredentialHelper(fetchHelper.helper)
      .call();
    expect(fetchHelper.log).toEqual(sortedLog(helper.log()));
    expect(shape(seen)).toEqual(nativeSeen);
    expect(git(join(mine, "sub"), "rev-parse", "origin/main").trim()).toBe(moved);
  });

  it("pull updating submodules: the update's fetch asks the helper", async () => {
    const url = `${serverA.baseUrl}/open/super-locked-sub.git`;
    const mine = join(fresh("ours"), "dest");
    await cloned([...nativeHelper().config, "clone", "-q", "--recurse-submodules", url, mine]);
    const n = counter++;
    writeFileSync(join(work, "sub", `c${n}`), "c\n");
    git(join(work, "sub"), "add", ".");
    git(join(work, "sub"), "commit", "-qm", `c${n}`);
    git(join(work, "sub"), "push", "-q", join(srv, "sub.git"), "main");
    const moved = head(join(work, "sub"));
    const superDir = join(work, "super-locked-sub");
    git(superDir, "update-index", "--cacheinfo", `160000,${moved},sub`);
    git(superDir, "commit", "-qm", `moved ${n}`);
    git(superDir, "push", "-q", join(srv, "super-locked-sub.git"), "main");
    // the update fetches in the submodule (git's `fetch_in_submodule`), not the fetch's recursion
    git(mine, "config", "submodule.recurse", "true");
    git(mine, "config", "fetch.recurseSubmodules", "false");

    const g = await ours(mine);
    const helper = ourHelper();
    seen = [];
    const result = await g.pull().setRebase(false).setCredentialHelper(helper.helper).call();
    expect(result.submodules?.exitCode, result.submodules?.stderr).toBe(0);
    expect(helper.log.some((l) => l.includes(`host=${hostOf(serverB)}`))).toBe(true);
    expect(head(join(mine, "sub"))).toBe(moved);
  });
});
