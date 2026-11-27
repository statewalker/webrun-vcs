/**
 * The credential helper on a partial clone's lazy fetch (statewalker/webrun-vcs#401): git's
 * promisor fetch is a child `git fetch <remote> --filter=blob:none --stdin` that reads
 * `credential.helper` (here from `git -c`, which reaches it through `GIT_CONFIG_PARAMETERS`),
 * so the blobs a `clone --filter=blob:none` checkout needs come through the helper's answer
 * as the clone's own pack did. Ours hands `setCredentialHelper` to the fetcher a transport
 * command installs for its call, and `installPromisorFetcher` takes one for later commands.
 *
 * A loopback server in front of native `git http-backend` serves `/auth/*` only with Basic
 * credentials. Native git decides the helper's conversation and the requests' outcomes.
 */

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CredentialRequest, Credentials } from "@statewalker/vcs-transport";
import { createNodeGitHostEnvironment } from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installPromisorFetcher } from "../src/commands/promisor-remote.js";
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
let backend: ReturnType<typeof nativeGitHttpBackend>;
let server: LoopbackServer;
/** `<method> <auth|-> <status>` of every request the server saw */
let seen: string[] = [];
let counter = 0;

const git = (cwd: string, ...args: string[]) => gitOut(root, cwd, args);

function route(): (request: Request) => Promise<Response> {
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
    seen.push(`${request.method} ${auth ? "auth" : "-"} ${response.status}`);
    return response;
  };
}

/** The kinds of request seen: sorted, without repeats. */
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
  const order = ["action", "protocol", "host", "username"];
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
          block
            .split("\n")
            .filter((line) => /^(action|protocol|host|username)=/.test(line))
            .sort(
              (a, b) =>
                order.indexOf(a.slice(0, a.indexOf("="))) -
                order.indexOf(b.slice(0, b.indexOf("="))),
            ),
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

describeGit("a partial clone's lazy fetch asks the credential helper, as native git", () => {
  let url: string;
  const files = { "a.txt": "alpha\n", "dir/b.txt": "beta\n" };

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "promisor-helper-"));
    srv = join(root, "srv");
    mkdirSync(srv);
    backend = nativeGitHttpBackend(srv, root);
    server = await serveOnLoopback(route());
    const work = join(root, "work");
    git(root, "init", "-q", "-b", "main", work);
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(work, path, ".."), { recursive: true });
      writeFileSync(join(work, path), content);
    }
    git(work, "add", ".");
    git(work, "commit", "-qm", "files");
    const bare = join(srv, "repo.git");
    git(root, "clone", "-q", "--bare", work, bare);
    git(bare, "config", "uploadpack.allowFilter", "true");
    git(bare, "config", "uploadpack.allowAnySHA1InWant", "true");
    url = `${server.baseUrl}/auth/repo.git`;
  });

  afterAll(async () => {
    await server?.close();
    backend?.close();
    rmSync(root, { recursive: true, force: true });
  });

  /** Whether `dir` holds the files of the served commit. */
  const checkedOut = (dir: string) =>
    Object.fromEntries(
      Object.keys(files).map((path) => [path, readFileSync(join(dir, path), "utf8")]),
    );

  it("clone --filter=blob:none: the checkout's lazy fetch asks the helper", async () => {
    // native: the clone and its promisor child fetch, each a process asking the helper
    const native = join(fresh("native"), "dest");
    const helper = nativeHelper();
    seen = [];
    const nativeRun = await gitAsync(root, root, [
      ...helper.config,
      "clone",
      "-q",
      "--filter=blob:none",
      url,
      native,
    ]);
    expect(nativeRun.status, nativeRun.stderr).toBe(0);
    const nativeSeen = shape(seen);
    const nativeLog = helper.log();
    expect(nativeLog.filter((l) => l[0] === "action=get").length).toBeGreaterThan(1);

    const mine = join(fresh("ours"), "dest");
    git(root, "init", "-q", "-b", "main", mine);
    const g = await ours(mine);
    const conversation = ourHelper();
    seen = [];
    await g
      .clone()
      .setURI(url)
      .setFilter("blob:none")
      .setCredentialHelper(conversation.helper)
      .call();
    expect(conversation.log).toEqual(nativeLog);
    expect(shape(seen)).toEqual(nativeSeen);
    expect(checkedOut(mine)).toEqual(checkedOut(native));
    expect(checkedOut(mine)).toEqual(files);
  });

  it("a later checkout's lazy fetch asks the helper installPromisorFetcher was given", async () => {
    const dirs = { native: join(fresh("native"), "dest"), ours: join(fresh("ours"), "dest") };
    for (const dir of Object.values(dirs)) {
      const run = await gitAsync(root, root, [
        ...nativeHelper().config,
        "clone",
        "-q",
        "--no-checkout",
        "--filter=blob:none",
        url,
        dir,
      ]);
      expect(run.status, run.stderr).toBe(0);
    }
    const helper = nativeHelper();
    seen = [];
    const nativeRun = await gitAsync(root, dirs.native, [
      ...helper.config,
      "checkout",
      "-q",
      "main",
    ]);
    expect(nativeRun.status, nativeRun.stderr).toBe(0);
    const nativeSeen = shape(seen);

    const g = await ours(dirs.ours);
    const conversation = ourHelper();
    installPromisorFetcher(g.workingCopy, { credentialHelper: conversation.helper });
    seen = [];
    await g.checkout().setName("main").call();
    expect(conversation.log).toEqual(helper.log());
    expect(shape(seen)).toEqual(nativeSeen);
    expect(checkedOut(dirs.ours)).toEqual(files);
  });
});
