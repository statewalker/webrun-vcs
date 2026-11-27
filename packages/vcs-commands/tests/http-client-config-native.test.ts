/**
 * git's `http.*` client configuration against native git (2.43 and 2.5x): the requests a
 * recording server in front of native `git http-backend` sees from native git and from ours
 * for the same configuration, the credential helper's conversation, and the outcome.
 *
 * - t5551-http-fetch-smart.sh: `http.extraHeader` ("custom http headers"), redirects ("follow
 *   redirects (301)", "follow redirects (302)", "redirects re-root further requests",
 *   "re-rooting dies on insane schemes"), credentials ("http auth remembers successful
 *   credentials", "http auth forgets bogus credentials")
 * - t5563-simple-http-auth.sh: "access using basic auth", "access using basic auth invalid
 *   credentials", "access using bearer auth" (2.46+: `authtype`), "access using basic proactive
 *   auth", "access using auto proactive auth with basic default", "access using auto proactive
 *   auth with authtype from credential helper" (2.46+: `http.proactiveAuth`, ignored by 2.43)
 * - t5551-http-fetch-smart.sh "clone from auth-only-for-objects repository" and
 *   t5541-http-push-smart.sh "push to auth-only-for-push repo": a POST answering 401 after an
 *   open `info/refs` (remote-curl's `post_rpc` asks the helper and sends it again)
 * - Digest (no git test has one): the router answers with its own challenge and checks the
 *   answer; native curl reuses the first 401's nonce, counts `nc` across requests and answers a
 *   refused Digest once more
 * - t5584-http-429-retry.sh (2.52+; 2.43 fails on the first 429)
 * - t5581-http-curl-verbose.sh: "failure in git-upload-pack is shown"
 * - JGit HttpConfigTest, HttpConfigUriPathTest: `http.<url>.*` matching, with `git config
 *   --get-urlmatch` as the oracle
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CredentialRequest, Credentials } from "@statewalker/vcs-transport";
import {
  createNodeGitHostEnvironment,
  createNodeHookRunner,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { httpClientSettingsOf } from "../src/index.js";
import { RemoteConfigStore } from "../src/remote-config/index.js";
import { type LoopbackServer, serveOnLoopback } from "./http-loopback-support.js";
import { openOurs } from "./merge-native-helpers.js";
import { gitAsync } from "./native-connect-support.js";
import { nativeGitAvailable, nativeGitHttpBackend } from "./native-git-http-backend.js";
import { gitOut, testEnv } from "./status-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

const nativeMinor = (() => {
  if (!nativeGitAvailable()) return 56;
  const m = /git version (\d+)\.(\d+)/.exec(execFileSync("git", ["--version"]).toString());
  return m && Number(m[1]) === 2 ? Number(m[2]) : 99;
})();
const compatibility = nativeMinor < 45 ? ("2.43" as const) : ("2.56" as const);
/** git 2.52 retries a 429 (`http.maxRetries`) */
const itRetries = nativeMinor >= 52 ? it : it.skip;
/** git 2.46 hands credential helpers `authtype` and `credential` */
const itAuthtype = nativeMinor >= 46 ? it : it.skip;
/** git 2.46 reads http.proactiveAuth (2.43 ignores it) */
const proactive = nativeMinor >= 46;

const USER = "alice";
const PASS = "secret-passwd";
const BASIC = `Basic ${Buffer.from(`${USER}:${PASS}`).toString("base64")}`;
const TOKEN = "a-bearer-token";
/** The router's Digest challenge (RFC 7616 3.3, as Apache's mod_auth_digest words it) */
const DIGEST_REALM = "git-auth";
const DIGEST_NONCE = "dcd98b7102dd2f0e8b11d0f600bfb0c093";
const DIGEST_OPAQUE = "5ccc069c403ebaf9f0171e9517f40e41";
const DIGEST_CHALLENGE = `Digest realm="${DIGEST_REALM}", nonce="${DIGEST_NONCE}", opaque="${DIGEST_OPAQUE}", algorithm=MD5, qop="auth"`;

const md5hex = (text: string) => createHash("md5").update(text).digest("hex");

/** The auth-params of an `Authorization: Digest ...` value. */
function digestParams(value: string): Map<string, string> {
  const params = new Map<string, string>();
  const re = /([A-Za-z0-9_-]+)=(?:"((?:[^"\\]|\\.)*)"|([^,\s]*))/g;
  for (const m of value.slice("Digest ".length).matchAll(re)) {
    params.set((m[1] as string).toLowerCase(), m[2] ?? m[3] ?? "");
  }
  return params;
}

/** Whether a Digest answer is right for USER/PASS (RFC 7616 3.4.1, qop=auth). */
function validDigest(request: Request, value: string | null): boolean {
  if (!value?.startsWith("Digest ")) return false;
  const p = digestParams(value);
  if (p.get("username") !== USER || p.get("realm") !== DIGEST_REALM) return false;
  if (p.get("nonce") !== DIGEST_NONCE || p.get("opaque") !== DIGEST_OPAQUE) return false;
  if (p.get("qop") !== "auth") return false;
  const url = new URL(request.url);
  if (p.get("uri") !== `${url.pathname}${url.search}`) return false;
  const ha1 = md5hex(`${USER}:${DIGEST_REALM}:${PASS}`);
  const ha2 = md5hex(`${request.method}:${p.get("uri")}`);
  const expected = md5hex(`${ha1}:${DIGEST_NONCE}:${p.get("nc")}:${p.get("cnonce")}:auth:${ha2}`);
  return p.get("response") === expected;
}

/** A Digest answer as recorded: its client nonce and response vary by run. */
const recordedAuthorization = (value: string) =>
  value.startsWith("Digest ")
    ? value
        .replace(/cnonce="[^"]*"/, 'cnonce="<cnonce>"')
        .replace(/response="[^"]*"/, 'response="<response>"')
    : value;

/** One request as the recording server saw it. */
interface Seen {
  method: string;
  path: string;
  status: number;
  /** The headers a test looks at (lower-case names): user agent, authorization, x-magic-* */
  headers: Record<string, string>;
}

let root: string;
let srv: string;
let server: LoopbackServer;
let seen: Seen[] = [];
/** Requests answered per 429 context (`/http_429/<context>/...`) */
const rateContexts = new Map<string, number>();
let counter = 0;

const KEPT_HEADERS = /^(user-agent|authorization|x-magic-.*)$/;

/** The recording router in front of native http-backend (lib-httpd's apache.conf routes). */
async function route(
  request: Request,
  backend: (r: Request) => Promise<Response>,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const query = url.search;
  const serve = (to: string) =>
    backend(
      new Request(`${url.origin}${to}${query}`, {
        method: request.method,
        headers: request.headers,
        ...(request.method === "POST" ? { body: request.body, duplex: "half" } : {}),
      } as RequestInit),
    );
  const redirect = (status: number, to: string) =>
    new Response(null, { status, headers: { Location: `${url.origin}${to}${query}` } });
  let m: RegExpExecArray | null;
  m = /^\/smart\/(.*)$/.exec(path);
  if (m) return serve(`/${m[1]}`);
  m = /^\/smart-redir-perm\/(.*)$/.exec(path);
  if (m) return redirect(301, `/smart/${m[1]}`);
  m = /^\/smart-redir-temp\/(.*)$/.exec(path);
  if (m) return redirect(302, `/smart/${m[1]}`);
  m = /^\/smart-redir-limited\/(.*)\/info\/refs$/.exec(path);
  if (m) {
    return redirect(301, `/smart/${m[1]}/info/refs`);
  }
  m = /^\/insane-redir\/(.*)$/.exec(path);
  if (m) return redirect(301, `/intern-redir/${m[1]}/foo`);
  m = /^\/intern-redir\/(.*)\/foo$/.exec(path);
  if (m) return serve(`/${m[1]}`);
  m = /^\/smart_headers\/(.*)$/.exec(path);
  if (m) {
    if (
      request.headers.get("x-magic-one") !== "abra" ||
      request.headers.get("x-magic-two") !== "cadabra"
    ) {
      return new Response("missing magic\n", {
        status: 403,
        headers: { "Content-Type": "text/plain" },
      });
    }
    return serve(`/${m[1]}`);
  }
  // lib-httpd's auth-fetch and auth-push: only the POST asks for credentials
  m = /^\/(auth-fetch|auth-push)\/smart\/(.*)$/.exec(path);
  if (m) {
    const guarded = m[1] === "auth-fetch" ? "/git-upload-pack" : "/git-receive-pack";
    if (path.endsWith(guarded) && request.headers.get("authorization") !== BASIC) {
      await request.body?.cancel().catch(() => undefined);
      return new Response("no\n", {
        status: 401,
        headers: { "WWW-Authenticate": 'Basic realm="git-auth"' },
      });
    }
    return serve(`/${m[2]}`);
  }
  m = /^\/digest\/smart\/(.*)$/.exec(path);
  if (m) {
    if (!validDigest(request, request.headers.get("authorization"))) {
      await request.body?.cancel().catch(() => undefined);
      return new Response("no\n", {
        status: 401,
        headers: { "WWW-Authenticate": DIGEST_CHALLENGE },
      });
    }
    return serve(`/${m[1]}`);
  }
  // t5563's custom_auth with `id=default status=403`: no challenge, a refusal without credentials
  m = /^\/custom_auth\/(.*)$/.exec(path);
  if (m) {
    const auth = request.headers.get("authorization");
    if (auth !== BASIC && auth !== `Bearer ${TOKEN}`) {
      return new Response("forbidden\n", { status: 403 });
    }
    return serve(`/${m[1]}`);
  }
  m = /^\/(auth|auth-empty|auth-bearer)\/smart\/(.*)$/.exec(path);
  if (m) {
    const auth = request.headers.get("authorization");
    const valid =
      m[1] === "auth-bearer"
        ? [`Bearer ${TOKEN}`]
        : m[1] === "auth-empty"
          ? [BASIC, "Basic Og=="]
          : [BASIC];
    if (auth === null || !valid.includes(auth)) {
      return new Response("no\n", {
        status: 401,
        headers: {
          "WWW-Authenticate":
            m[1] === "auth-bearer"
              ? 'Bearer authorize_uri="id.example.com"'
              : 'Basic realm="example.com"',
        },
      });
    }
    return serve(`/${m[2]}`);
  }
  m = /^\/http_429\/([^/]+)\/([^/]+)\/(.*)$/.exec(path);
  if (m) {
    const context = m[1] as string;
    const retryAfter = m[2] as string;
    const count = rateContexts.get(context) ?? 0;
    rateContexts.set(context, count + 1);
    if (retryAfter === "permanent" || count === 0) {
      return new Response("slow down\n", {
        status: 429,
        headers: {
          "Content-Type": "text/plain",
          ...(retryAfter === "none" || retryAfter === "permanent"
            ? {}
            : { "Retry-After": decodeURIComponent(retryAfter) }),
        },
      });
    }
    return serve(`/${m[3]}`);
  }
  m = /^\/error_git_upload_pack\/smart\/(.*)$/.exec(path);
  if (m) {
    if (path.endsWith("/git-upload-pack")) {
      return new Response("Intentional Breakage\n", { status: 500 });
    }
    return serve(`/${m[1]}`);
  }
  return new Response("not found\n", { status: 404, headers: { "Content-Type": "text/plain" } });
}

/** A client repository of each side, configured alike (`git config` lines). */
async function clients(config: string[][] = []): Promise<{ native: string; ours: string }> {
  const n = counter++;
  const native = join(root, `native-${n}`);
  const ours = join(root, `ours-${n}`);
  for (const dir of [native, ours]) {
    gitOut(root, root, ["init", "-q", "-b", "main", dir]);
    for (const [key, value] of config) gitOut(root, dir, ["config", "--add", key, value]);
  }
  return { native, ours };
}

async function openAt(dir: string, extra: Record<string, string> = {}) {
  return openOurs(
    root,
    // the runner tells the commands which git they follow (http.proactiveAuth is 2.46+)
    createNodeGitHostEnvironment({
      env: testEnv(root, extra),
      hookRunner: createNodeHookRunner({ compatibility }),
    }),
    undefined,
    dir.slice(root.length + 1),
  );
}

/** The requests seen while `run` ran. */
async function recording<T>(run: () => Promise<T>): Promise<{ result: T; requests: Seen[] }> {
  seen = [];
  rateContexts.clear();
  const result = await run();
  if (process.env.DEBUG_HTTP) {
    console.log(
      `REQ ${JSON.stringify(seen.map((r) => [r.method, r.path, r.status, r.headers.authorization ?? ""]))}`,
    );
  }
  return { result, requests: seen };
}

/** Requests without the host's own user agent (native's `git/<version>`, ours the host's). */
const withoutAgent = (requests: Seen[]) =>
  requests.map(({ headers: { "user-agent": _ua, ...headers }, ...rest }) => ({
    ...rest,
    headers,
  }));

/** A credential helper script logging what git asks, answering `get` from a reply file. */
function nativeHelper(reply: string): { config: string[][]; log: () => string[][] } {
  const dir = join(root, `helper-${counter++}`);
  mkdirSync(dir);
  const logFile = join(dir, "log");
  const replyFile = join(dir, "reply");
  writeFileSync(replyFile, reply);
  const script = join(dir, "helper.sh");
  writeFileSync(
    script,
    `#!/bin/sh\n{ echo "action=$1"; sed -n -e '/^$/q' -e p; echo; } >>"${logFile}"\nif test "$1" = get; then cat "${replyFile}"; fi\n`,
  );
  chmodSync(script, 0o755);
  return {
    config: [["credential.helper", script]],
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
            .filter((line) =>
              /^(action|protocol|host|username|password|authtype|credential|wwwauth\[\])=/.test(
                line,
              ),
            ),
        );
    },
  };
}

/** Ours: the same conversation, as the helper script logs it. */
function ourHelper(reply: Credentials | undefined) {
  const log: string[][] = [];
  const lines = (action: string, request: CredentialRequest, credentials?: Credentials) => [
    `action=${action}`,
    ...(credentials?.authtype ? [`authtype=${credentials.authtype}`] : []),
    ...(credentials?.credential ? [`credential=${credentials.credential}`] : []),
    `protocol=${request.protocol}`,
    `host=${request.host}`,
    ...(credentials?.username !== undefined ? [`username=${credentials.username}`] : []),
    ...(credentials?.password !== undefined ? [`password=${credentials.password}`] : []),
    ...request.wwwAuthenticate.map((c) => `wwwauth[]=${c}`),
  ];
  return {
    log,
    helper: {
      fill(request: CredentialRequest) {
        log.push(lines("get", request));
        return reply;
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

/** git's helper log in our order of keys: action, authtype, credential, protocol, host, ... */
function sortedLog(log: string[][]): string[][] {
  const order = [
    "action",
    "authtype",
    "credential",
    "protocol",
    "host",
    "username",
    "password",
    "wwwauth[]",
  ];
  return log.map((lines) =>
    [...lines].sort(
      (a, b) =>
        order.indexOf(a.slice(0, a.indexOf("="))) - order.indexOf(b.slice(0, b.indexOf("="))),
    ),
  );
}

/** `fatal:`/`error:`/`warning:`/`remote:` lines of native stderr. */
const gitLines = (stderr: string) =>
  stderr
    .split("\n")
    .filter((l) => /^(fatal|error|warning|remote): /.test(l) || /^ {2,3}\S/.test(l));

describeGit("http.* client configuration, as native git", () => {
  let backend: ReturnType<typeof nativeGitHttpBackend>;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "http-client-config-"));
    srv = join(root, "srv");
    mkdirSync(srv);
    const work = join(root, "work");
    gitOut(root, root, ["init", "-q", "-b", "main", work]);
    writeFileSync(join(work, "a.txt"), "one\n");
    gitOut(root, work, ["add", "a.txt"]);
    gitOut(root, work, ["commit", "-q", "-m", "one"]);
    gitOut(root, root, ["clone", "-q", "--bare", work, join(srv, "repo.git")]);
    gitOut(root, join(srv, "repo.git"), ["config", "http.receivepack", "true"]);
    backend = nativeGitHttpBackend(srv, root);
    server = await serveOnLoopback(async (request) => {
      const url = new URL(request.url);
      const headers: Record<string, string> = {};
      request.headers.forEach((value, key) => {
        if (KEPT_HEADERS.test(key)) {
          headers[key] = key === "authorization" ? recordedAuthorization(value) : value;
        }
      });
      const response = await route(request, backend.fetch);
      seen.push({
        method: request.method,
        path: `${url.pathname}${url.search}`,
        status: response.status,
        headers,
      });
      return response;
    });
  });

  afterAll(async () => {
    await server?.close();
    backend?.close();
    rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    seen = [];
  });

  /** `git ls-remote <url>` on each side; ours with `configure` applied to the command. */
  async function lsRemoteTwins(
    path: string,
    config: string[][] = [],
    options: {
      env?: Record<string, string>;
      helperReply?: { native: string; ours: Credentials | undefined };
    } = {},
  ) {
    const helper = options.helperReply ? nativeHelper(options.helperReply.native) : undefined;
    const { native, ours } = await clients([...config, ...(helper?.config ?? [])]);
    const url = `${server.baseUrl}${path}`;
    const nativeRun = await recording(() =>
      gitAsync(root, native, ["ls-remote", url], options.env ?? {}),
    );
    const theirs = ourHelper(options.helperReply?.ours);
    const warnings: string[] = [];
    const git = await openAt(ours, options.env);
    const ourRun = await recording(async () => {
      try {
        const command = git
          .lsRemote()
          .setRemote(url)
          .setWarningCallback((l) => warnings.push(l));
        if (options.helperReply) command.setCredentialHelper(theirs.helper);
        const result = await command.call();
        return { refs: result.refs.map((r) => `${r.objectId}\t${r.name}`), error: undefined };
      } catch (error) {
        return { refs: [] as string[], error: error as Error };
      }
    });
    if (process.env.DEBUG_HTTP) {
      console.log(JSON.stringify({ native: nativeRun.requests, ours: ourRun.requests }, null, 1));
    }
    return {
      native: {
        ...nativeRun,
        helperLog: helper ? sortedLog(helper.log()) : [],
      },
      ours: { ...ourRun, helperLog: theirs.log, warnings },
    };
  }

  it('t5551-http-fetch-smart.sh: "custom http headers": http.extraHeader on every request', async () => {
    const config = [
      ["http.extraHeader", "x-magic-zero: gone"],
      ["http.extraHeader", ""],
      ["http.extraHeader", "x-magic-one: abra"],
      ["http.extraHeader", "x-magic-two: cadabra"],
    ];
    const twins = await lsRemoteTwins("/smart_headers/repo.git", config);
    expect(twins.native.result.status).toBe(0);
    expect(twins.ours.result.error).toBeUndefined();
    expect(twins.ours.result.refs.join("\n")).toBe(
      twins.native.result.stdout
        .trim()
        .split("\n")
        .filter((l) => l.includes("\trefs/"))
        .join("\n"),
    );
    expect(withoutAgent(twins.ours.requests)).toEqual(withoutAgent(twins.native.requests));
    expect(twins.ours.requests[0]?.headers["x-magic-one"]).toBe("abra");
    expect(twins.ours.requests[0]?.headers["x-magic-zero"]).toBeUndefined();
  });

  it('t5551-http-fetch-smart.sh: "custom http headers": a missing header fails as git', async () => {
    const twins = await lsRemoteTwins("/smart_headers/repo.git", [
      ["http.extraHeader", "x-magic-two: cadabra"],
    ]);
    expect(twins.native.result.status).toBe(128);
    expect(twins.ours.result.error?.message.split("\n")).toEqual(
      gitLines(twins.native.result.stderr),
    );
    expect(withoutAgent(twins.ours.requests)).toEqual(withoutAgent(twins.native.requests));
  });

  it("http.<url>.extraHeader applies by URL (urlmatch), the best match last", async () => {
    const twins = await lsRemoteTwins("/smart_headers/repo.git", [
      ["http.extraHeader", "x-magic-one: abra"],
      [`http.${server.baseUrl}/smart_headers.extraHeader`, "x-magic-two: cadabra"],
      ["http.http://elsewhere.example.com.extraHeader", "x-magic-three: no"],
    ]);
    expect(twins.native.result.status).toBe(0);
    expect(twins.ours.result.error).toBeUndefined();
    expect(withoutAgent(twins.ours.requests)).toEqual(withoutAgent(twins.native.requests));
  });

  it("http.userAgent and GIT_HTTP_USER_AGENT name the user agent", async () => {
    const config = [
      ["http.userAgent", "Mozilla/4.0 (from config)"],
      [`http.${server.baseUrl}/smart/.userAgent`, "TestAgent/1.0"],
    ];
    const twins = await lsRemoteTwins("/smart/repo.git", config);
    expect(new Set(twins.native.requests.map((r) => r.headers["user-agent"]))).toEqual(
      new Set(["TestAgent/1.0"]),
    );
    expect(twins.ours.requests).toEqual(twins.native.requests);
    const env = { GIT_HTTP_USER_AGENT: "FromEnv/2.0" };
    const viaEnv = await lsRemoteTwins("/smart/repo.git", config, { env });
    expect(new Set(viaEnv.native.requests.map((r) => r.headers["user-agent"]))).toEqual(
      new Set(["FromEnv/2.0"]),
    );
    expect(viaEnv.ours.requests).toEqual(viaEnv.native.requests);
  });

  /** `git fetch <url> main` on each side: the requests and the fetched commit. */
  async function fetchTwins(
    path: string,
    config: string[][] = [],
    options: { helperReply?: { native: string; ours: Credentials | undefined } } = {},
  ) {
    const helper = options.helperReply ? nativeHelper(options.helperReply.native) : undefined;
    const { native, ours } = await clients([...config, ...(helper?.config ?? [])]);
    const url = `${server.baseUrl}${path}`;
    const nativeRun = await recording(() => gitAsync(root, native, ["fetch", "-q", url, "main"]));
    const theirs = ourHelper(options.helperReply?.ours);
    const git = await openAt(ours);
    const ourRun = await recording(async () => {
      try {
        const command = git
          .fetch()
          .setRemote(url)
          .setRefSpecs("main")
          .setCompatibility(compatibility);
        if (options.helperReply) command.setCredentialHelper(theirs.helper);
        await command.call();
        return undefined;
      } catch (error) {
        return error as Error;
      }
    });
    const fetched = (dir: string) => {
      try {
        return gitOut(root, dir, ["rev-parse", "FETCH_HEAD"]).trim();
      } catch {
        return undefined;
      }
    };
    return {
      native: {
        ...nativeRun,
        fetched: fetched(native),
        helperLog: helper ? sortedLog(helper.log()) : [],
      },
      ours: {
        error: ourRun.result,
        requests: ourRun.requests,
        fetched: fetched(ours),
        helperLog: theirs.log,
      },
    };
  }

  /** Method, path and status of each request. */
  const shape = (requests: Seen[]) => requests.map((r) => `${r.method} ${r.path} ${r.status}`);

  it('t5551-http-fetch-smart.sh: "follow redirects (301)"', async () => {
    const twins = await fetchTwins("/smart-redir-perm/repo.git");
    expect(twins.native.result.status).toBe(0);
    expect(twins.ours.error).toBeUndefined();
    expect(twins.ours.fetched).toBe(twins.native.fetched);
    expect(shape(twins.ours.requests)).toEqual(shape(twins.native.requests));
  });

  it('t5551-http-fetch-smart.sh: "follow redirects (302)"', async () => {
    const twins = await fetchTwins("/smart-redir-temp/repo.git");
    expect(twins.native.result.status).toBe(0);
    expect(twins.ours.error).toBeUndefined();
    expect(shape(twins.ours.requests)).toEqual(shape(twins.native.requests));
  });

  it('t5551-http-fetch-smart.sh: "redirects re-root further requests"', async () => {
    const twins = await fetchTwins("/smart-redir-limited/repo.git");
    expect(twins.native.result.status).toBe(0);
    expect(twins.ours.error).toBeUndefined();
    expect(twins.ours.fetched).toBe(twins.native.fetched);
    expect(shape(twins.ours.requests)).toEqual(shape(twins.native.requests));
  });

  it('t5551-http-fetch-smart.sh: "re-rooting dies on insane schemes"', async () => {
    const twins = await fetchTwins("/insane-redir/repo.git");
    expect(twins.native.result.status).toBe(128);
    expect(twins.ours.error?.message.split("\n")).toEqual(gitLines(twins.native.result.stderr));
    expect(shape(twins.ours.requests)).toEqual(shape(twins.native.requests));
  });

  it("http.followRedirects=false takes the redirect for an error", async () => {
    const twins = await fetchTwins("/smart-redir-perm/repo.git", [
      ["http.followRedirects", "false"],
    ]);
    expect(twins.native.result.status).toBe(128);
    expect(twins.ours.error?.message.split("\n")).toEqual(gitLines(twins.native.result.stderr));
    expect(shape(twins.ours.requests)).toEqual(shape(twins.native.requests));
  });

  it("http.followRedirects=true follows the redirect of every request", async () => {
    const twins = await fetchTwins("/smart-redir-temp/repo.git", [
      ["http.followRedirects", "true"],
    ]);
    expect(twins.ours.error === undefined).toBe(twins.native.result.status === 0);
    expect(shape(twins.ours.requests)).toEqual(shape(twins.native.requests));
  });

  it('t5563-simple-http-auth.sh: "access using basic auth"', async () => {
    const twins = await lsRemoteTwins("/auth/smart/repo.git", [], {
      helperReply: {
        native: `username=${USER}\npassword=${PASS}\n`,
        ours: { username: USER, password: PASS },
      },
    });
    expect(twins.native.result.status).toBe(0);
    expect(twins.ours.result.error).toBeUndefined();
    expect(twins.ours.helperLog).toEqual(twins.native.helperLog);
    expect(withoutAgent(twins.ours.requests)).toEqual(withoutAgent(twins.native.requests));
  });

  it('t5563-simple-http-auth.sh: "access using basic auth invalid credentials"', async () => {
    const twins = await lsRemoteTwins("/auth/smart/repo.git", [], {
      helperReply: {
        native: "username=baduser\npassword=wrong-passwd\n",
        ours: { username: "baduser", password: "wrong-passwd" },
      },
    });
    expect(twins.native.result.status).toBe(128);
    expect(twins.ours.result.error?.message.split("\n")).toEqual(
      gitLines(twins.native.result.stderr),
    );
    expect(twins.ours.helperLog).toEqual(twins.native.helperLog);
    expect(withoutAgent(twins.ours.requests)).toEqual(withoutAgent(twins.native.requests));
  });

  itAuthtype('t5563-simple-http-auth.sh: "access using bearer auth"', async () => {
    const twins = await lsRemoteTwins("/auth-bearer/smart/repo.git", [], {
      helperReply: {
        native: `capability[]=authtype\nauthtype=Bearer\ncredential=${TOKEN}\n`,
        ours: { authtype: "Bearer", credential: TOKEN },
      },
    });
    expect(twins.native.result.status).toBe(0);
    expect(twins.ours.result.error).toBeUndefined();
    expect(twins.ours.helperLog).toEqual(twins.native.helperLog);
    expect(withoutAgent(twins.ours.requests)).toEqual(withoutAgent(twins.native.requests));
  });

  it("Digest: the helper's credentials answer the server's challenge (RFC 7616, qop=auth)", async () => {
    const twins = await lsRemoteTwins("/digest/smart/repo.git", [], {
      helperReply: {
        native: `username=${USER}\npassword=${PASS}\n`,
        ours: { username: USER, password: PASS },
      },
    });
    expect(twins.native.result.status).toBe(0);
    expect(twins.ours.result.error).toBeUndefined();
    expect(twins.ours.result.refs.join("\n")).toBe(
      twins.native.result.stdout
        .trim()
        .split("\n")
        .filter((l) => !l.endsWith("\tHEAD"))
        .join("\n"),
    );
    expect(twins.ours.helperLog).toEqual(twins.native.helperLog);
    expect(withoutAgent(twins.ours.requests)).toEqual(withoutAgent(twins.native.requests));
  });

  it("Digest: a fetch answers each request's challenge, the POSTs too", async () => {
    const twins = await fetchTwins("/digest/smart/repo.git", [], {
      helperReply: {
        native: `username=${USER}\npassword=${PASS}\n`,
        ours: { username: USER, password: PASS },
      },
    });
    expect(twins.native.result.status).toBe(0);
    expect(twins.ours.error).toBeUndefined();
    expect(twins.ours.fetched).toBe(twins.native.fetched);
    expect(twins.ours.helperLog).toEqual(twins.native.helperLog);
    expect(withoutAgent(twins.ours.requests)).toEqual(withoutAgent(twins.native.requests));
  });

  it("Digest: wrong credentials are refused and erased, as Basic ones", async () => {
    const twins = await lsRemoteTwins("/digest/smart/repo.git", [], {
      helperReply: {
        native: "username=baduser\npassword=wrong-passwd\n",
        ours: { username: "baduser", password: "wrong-passwd" },
      },
    });
    expect(twins.native.result.status).toBe(128);
    expect(twins.ours.result.error?.message.split("\n")).toEqual(
      gitLines(twins.native.result.stderr),
    );
    expect(twins.ours.helperLog).toEqual(twins.native.helperLog);
    expect(withoutAgent(twins.ours.requests)).toEqual(withoutAgent(twins.native.requests));
  });

  it('t5563-simple-http-auth.sh: "access using basic proactive auth"', async () => {
    const twins = await lsRemoteTwins("/custom_auth/repo.git", [["http.proactiveAuth", "basic"]], {
      helperReply: {
        native: `username=${USER}\npassword=${PASS}\n`,
        ours: { username: USER, password: PASS },
      },
    });
    // git 2.43 ignores the key: the server's 403 refuses it
    expect(twins.native.result.status).toBe(proactive ? 0 : 128);
    if (proactive) expect(twins.ours.result.error).toBeUndefined();
    else {
      expect(twins.ours.result.error?.message.split("\n")).toEqual(
        gitLines(twins.native.result.stderr),
      );
    }
    expect(twins.ours.helperLog).toEqual(twins.native.helperLog);
    expect(withoutAgent(twins.ours.requests)).toEqual(withoutAgent(twins.native.requests));
  });

  it('t5563-simple-http-auth.sh: "access using auto proactive auth with basic default"', async () => {
    const twins = await lsRemoteTwins("/custom_auth/repo.git", [["http.proactiveAuth", "auto"]], {
      helperReply: {
        native: `username=${USER}\npassword=${PASS}\n`,
        ours: { username: USER, password: PASS },
      },
    });
    expect(twins.native.result.status).toBe(proactive ? 0 : 128);
    expect(twins.ours.result.error === undefined).toBe(proactive);
    expect(twins.ours.helperLog).toEqual(twins.native.helperLog);
    expect(withoutAgent(twins.ours.requests)).toEqual(withoutAgent(twins.native.requests));
  });

  itAuthtype(
    't5563-simple-http-auth.sh: "access using auto proactive auth with authtype from credential helper"',
    async () => {
      const twins = await lsRemoteTwins("/custom_auth/repo.git", [["http.proactiveAuth", "auto"]], {
        helperReply: {
          native: `capability[]=authtype\nauthtype=Bearer\ncredential=${TOKEN}\n`,
          ours: { authtype: "Bearer", credential: TOKEN },
        },
      });
      expect(twins.native.result.status).toBe(0);
      expect(twins.ours.result.error).toBeUndefined();
      expect(twins.ours.helperLog).toEqual(twins.native.helperLog);
      expect(withoutAgent(twins.ours.requests)).toEqual(withoutAgent(twins.native.requests));
    },
  );

  it("http.proactiveAuth=none and an unknown value ask nothing before a challenge", async () => {
    for (const value of ["none", "bogus"]) {
      const twins = await lsRemoteTwins("/auth/smart/repo.git", [["http.proactiveAuth", value]], {
        helperReply: {
          native: `username=${USER}\npassword=${PASS}\n`,
          ours: { username: USER, password: PASS },
        },
      });
      expect(twins.native.result.status).toBe(0);
      expect(twins.ours.result.error).toBeUndefined();
      expect(twins.ours.warnings).toEqual(gitLines(twins.native.result.stderr));
      expect(twins.ours.helperLog).toEqual(twins.native.helperLog);
      expect(withoutAgent(twins.ours.requests)).toEqual(withoutAgent(twins.native.requests));
    }
  });

  it("http.emptyAuth=true tries empty credentials before the helper", async () => {
    const twins = await lsRemoteTwins("/auth/smart/repo.git", [["http.emptyAuth", "true"]], {
      helperReply: {
        native: `username=${USER}\npassword=${PASS}\n`,
        ours: { username: USER, password: PASS },
      },
    });
    expect(twins.native.result.status).toBe(0);
    expect(twins.ours.result.error).toBeUndefined();
    expect(twins.ours.helperLog).toEqual(twins.native.helperLog);
    expect(withoutAgent(twins.ours.requests)).toEqual(withoutAgent(twins.native.requests));
    const accepted = await lsRemoteTwins("/auth-empty/smart/repo.git", [
      ["http.emptyAuth", "true"],
    ]);
    expect(accepted.native.result.status).toBe(0);
    expect(accepted.ours.result.error).toBeUndefined();
    expect(withoutAgent(accepted.ours.requests)).toEqual(withoutAgent(accepted.native.requests));
  });

  it("a push carries http.extraHeader and the helper's credentials to receive-pack", async () => {
    const helper = nativeHelper(`username=${USER}\npassword=${PASS}\n`);
    const config = [["http.extraHeader", "x-magic-push: yes"], ...helper.config];
    const { native, ours } = await clients(config);
    for (const [dir, name] of [
      [native, "native"],
      [ours, "ours"],
    ] as const) {
      writeFileSync(join(dir, "f.txt"), `${name}\n`);
      gitOut(root, dir, ["add", "f.txt"]);
      gitOut(root, dir, ["commit", "-q", "-m", name]);
    }
    const url = `${server.baseUrl}/auth/smart/repo.git`;
    const nativeRun = await recording(() =>
      gitAsync(root, native, ["push", "-q", url, "main:refs/heads/pushed-native"]),
    );
    const theirs = ourHelper({ username: USER, password: PASS });
    const git = await openAt(ours);
    const ourRun = await recording(async () => {
      try {
        await git
          .push()
          .setRemote(url)
          .setRefSpecs("main:refs/heads/pushed-ours")
          .setCredentialHelper(theirs.helper)
          .call();
        return undefined;
      } catch (error) {
        return error as Error;
      }
    });
    expect(nativeRun.result.status).toBe(0);
    expect(ourRun.result).toBeUndefined();
    expect(theirs.log).toEqual(sortedLog(helper.log()));
    const normalized = (requests: Seen[]) =>
      withoutAgent(requests).map((r) => ({ ...r, path: r.path.replace(/pushed-\w+/, "x") }));
    expect(normalized(ourRun.requests)).toEqual(normalized(nativeRun.requests));
    expect(ourRun.requests.every((r) => r.headers["x-magic-push"] === "yes")).toBe(true);
  });

  it('t5551-http-fetch-smart.sh: "clone from auth-only-for-objects repository"', async () => {
    // info/refs is open, the POST answers 401: remote-curl's post_rpc asks the helper and
    // sends the request again
    const twins = await fetchTwins("/auth-fetch/smart/repo.git", [], {
      helperReply: {
        native: `username=${USER}\npassword=${PASS}\n`,
        ours: { username: USER, password: PASS },
      },
    });
    expect(twins.native.result.status).toBe(0);
    expect(twins.ours.error).toBeUndefined();
    expect(twins.ours.fetched).toBe(twins.native.fetched);
    expect(twins.ours.helperLog).toEqual(twins.native.helperLog);
    expect(withoutAgent(twins.ours.requests)).toEqual(withoutAgent(twins.native.requests));
  });

  it('t5551-http-fetch-smart.sh: "clone from auth-only-for-objects repository": wrong credentials', async () => {
    const twins = await fetchTwins("/auth-fetch/smart/repo.git", [], {
      helperReply: {
        native: "username=baduser\npassword=wrong-passwd\n",
        ours: { username: "baduser", password: "wrong-passwd" },
      },
    });
    expect(twins.native.result.status).not.toBe(0);
    expect(twins.ours.error).toBeDefined();
    if (process.env.DEBUG_HTTP) console.log(twins.native.result.stderr, twins.ours.error);
    expect(twins.ours.helperLog).toEqual(twins.native.helperLog);
    expect(withoutAgent(twins.ours.requests)).toEqual(withoutAgent(twins.native.requests));
  });

  it('t5541-http-push-smart.sh: "push to auth-only-for-push repo"', async () => {
    const helper = nativeHelper(`username=${USER}\npassword=${PASS}\n`);
    const { native, ours } = await clients(helper.config);
    for (const [dir, name] of [
      [native, "native"],
      [ours, "ours"],
    ] as const) {
      writeFileSync(join(dir, "f.txt"), `${name}\n`);
      gitOut(root, dir, ["add", "f.txt"]);
      gitOut(root, dir, ["commit", "-q", "-m", name]);
    }
    const url = `${server.baseUrl}/auth-push/smart/repo.git`;
    const nativeRun = await recording(() =>
      gitAsync(root, native, ["push", "-q", url, "main:refs/heads/half-native"]),
    );
    const theirs = ourHelper({ username: USER, password: PASS });
    const git = await openAt(ours);
    const ourRun = await recording(async () => {
      try {
        await git
          .push()
          .setRemote(url)
          .setRefSpecs("main:refs/heads/half-ours")
          .setCredentialHelper(theirs.helper)
          .call();
        return undefined;
      } catch (error) {
        return error as Error;
      }
    });
    expect(nativeRun.result.status).toBe(0);
    expect(ourRun.result).toBeUndefined();
    expect(theirs.log).toEqual(sortedLog(helper.log()));
    const normalized = (requests: Seen[]) =>
      withoutAgent(requests).map((r) => ({ ...r, path: r.path.replace(/half-\w+/, "x") }));
    expect(normalized(ourRun.requests)).toEqual(normalized(nativeRun.requests));
  });

  it('t5581-http-curl-verbose.sh: "failure in git-upload-pack is shown"', async () => {
    const twins = await fetchTwins("/error_git_upload_pack/smart/repo.git");
    expect(twins.native.result.status).not.toBe(0);
    expect(twins.ours.error).toBeDefined();
    expect(shape(twins.ours.requests)).toEqual(shape(twins.native.requests));
  });

  it("t5584-http-429-retry.sh: a 429 without retries (git 2.43: no retries at all)", async () => {
    const twins = await lsRemoteTwins("/http_429/retries-disabled/1/repo.git", [
      ["http.maxRetries", "0"],
      ["http.retryAfter", "1"],
    ]);
    expect(twins.native.result.status).toBe(128);
    expect(twins.ours.result.error?.message.split("\n")).toEqual(
      gitLines(twins.native.result.stderr),
    );
    expect(shape(twins.ours.requests)).toEqual(shape(twins.native.requests));
  });

  itRetries(
    't5584-http-429-retry.sh: "HTTP 429 permanent should fail after max retries"',
    async () => {
      const twins = await lsRemoteTwins("/http_429/permanent-fail/permanent/repo.git", [
        ["http.maxRetries", "2"],
      ]);
      expect(twins.native.result.status).toBe(128);
      expect(twins.ours.result.error?.message.split("\n")).toEqual(
        gitLines(twins.native.result.stderr),
      );
      expect(shape(twins.ours.requests)).toEqual(shape(twins.native.requests));
    },
  );

  itRetries(
    't5584-http-429-retry.sh: "HTTP 429 with Retry-After is retried and succeeds"',
    async () => {
      const twins = await lsRemoteTwins("/http_429/retry-succeeds/1/repo.git", [
        ["http.maxRetries", "3"],
      ]);
      expect(twins.native.result.status).toBe(0);
      expect(twins.ours.result.error).toBeUndefined();
      expect(twins.ours.warnings).toEqual(gitLines(twins.native.result.stderr));
      expect(shape(twins.ours.requests)).toEqual(shape(twins.native.requests));
    },
  );

  itRetries(
    't5584-http-429-retry.sh: "HTTP 429 without Retry-After uses configured default"',
    async () => {
      const twins = await lsRemoteTwins("/http_429/no-retry-after-header/none/repo.git", [
        ["http.maxRetries", "3"],
        ["http.retryAfter", "1"],
      ]);
      expect(twins.native.result.status).toBe(0);
      expect(twins.ours.result.error).toBeUndefined();
      expect(twins.ours.warnings).toEqual(gitLines(twins.native.result.stderr));
      expect(shape(twins.ours.requests)).toEqual(shape(twins.native.requests));
    },
  );

  itRetries(
    't5584-http-429-retry.sh: "HTTP 429 fails immediately if Retry-After exceeds http.maxRetryTime"',
    async () => {
      const twins = await lsRemoteTwins("/http_429/retry-after-exceeds-max-time/100/repo.git", [
        ["http.maxRetries", "3"],
        ["http.maxRetryTime", "3"],
      ]);
      expect(twins.native.result.status).toBe(128);
      expect(twins.ours.result.error?.message.split("\n")).toEqual(
        gitLines(twins.native.result.stderr),
      );
      expect(shape(twins.ours.requests)).toEqual(shape(twins.native.requests));
    },
  );

  itRetries(
    't5584-http-429-retry.sh: "HTTP 429 fails if configured http.retryAfter exceeds http.maxRetryTime"',
    async () => {
      const twins = await lsRemoteTwins(
        "/http_429/config-retry-after-exceeds-max-time/none/repo.git",
        [
          ["http.maxRetries", "3"],
          ["http.retryAfter", "100"],
          ["http.maxRetryTime", "5"],
        ],
      );
      expect(twins.native.result.status).toBe(128);
      expect(twins.ours.result.error?.message.split("\n")).toEqual(
        gitLines(twins.native.result.stderr),
      );
    },
  );

  itRetries(
    't5584-http-429-retry.sh: "GIT_HTTP_MAX_RETRIES overrides http.maxRetries config"',
    async () => {
      const twins = await lsRemoteTwins(
        "/http_429/env-retries-override/permanent/repo.git",
        [["http.maxRetries", "0"]],
        { env: { GIT_HTTP_MAX_RETRIES: "2" } },
      );
      expect(twins.native.result.status).toBe(128);
      expect(twins.ours.result.error?.message.split("\n")).toEqual(
        gitLines(twins.native.result.stderr),
      );
      expect(shape(twins.ours.requests)).toEqual(shape(twins.native.requests));
    },
  );
});

/**
 * JGit HttpConfigTest and HttpConfigUriPathTest inputs: `http.<url>.*` sections matched
 * against URLs, `git config --get-urlmatch` deciding which value applies.
 */
describeGit("http.<url>.* matching, with git config --get-urlmatch as the oracle", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "http-urlmatch-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const DEFAULT = "[http]\n\tmaxRetries = 1\n\tuserAgent = Test/0.1\n\n";
  const cases: Array<{ name: string; config: string; urls: string[] }> = [
    {
      name: "HttpConfigTest testMatchSuccess",
      config: `${DEFAULT}[http "http://example.com"]\n\tmaxRetries = 1024\n`,
      urls: [
        "http://example.com/path/repo.git",
        "http://example.org/path/repo.git",
        "http://example.com:80/path/repo.git",
        "http://example.com:8080/path/repo.git",
        "https://example.com/path/repo.git",
        "http://eXample.com/path/repo.git",
        "http://user@example.com/path/repo.git",
      ],
    },
    {
      name: "HttpConfigTest testMatchWithOnlySchemeInConfig",
      config: `${DEFAULT}[http "http://"]\n\tmaxRetries = 1024\n`,
      urls: ["http://example.com/path/repo.git"],
    },
    {
      name: "HttpConfigTest testMatchWithPrefixUriInConfig",
      config: `${DEFAULT}[http "http://example"]\n\tmaxRetries = 1024\n`,
      urls: ["http://example.com/path/repo.git"],
    },
    {
      name: "HttpConfigTest testMatchCaseSensitivity",
      config: `${DEFAULT}[http "http://exAMPle.com"]\n\tmaxRetries = 1024\n`,
      urls: ["http://example.com/path/repo.git"],
    },
    {
      name: "HttpConfigTest testMatchWithInvalidAndValidUriInConfig",
      config: `${DEFAULT}[http "///"]\n\tmaxRetries = 1024\n[http "http://example.com"]\n\tmaxRetries = 2048\n`,
      urls: ["http://example.com/path/repo.git"],
    },
    {
      name: "HttpConfigTest testMatchWithHostEndingInSlash",
      config: `${DEFAULT}[http "http://example.com/"]\n\tmaxRetries = 1024\n`,
      urls: ["http://example.com/path/repo.git"],
    },
    {
      name: "HttpConfigTest testMatchWithUser",
      config: `${DEFAULT}[http "http://example.com/path"]\n\tmaxRetries = 1024\n[http "http://example.com/path/repo"]\n\tmaxRetries = 2048\n[http "http://user@example.com/path"]\n\tmaxRetries = 4096\n`,
      urls: [
        "http://example.com/path/repo.git",
        "http://user@example.com/path/repo.git",
        "http://user@example.com/path/repo/foo.git",
        "http://user@example.com/path/foo.git",
        "http://example.com/path/foo.git",
        "http://User@example.com/path/foo.git",
        "http://sameuser@example.com/path/foo.git",
        "http://user:pass@example.com/path/foo.git",
      ],
    },
    {
      name: "HttpConfigTest testMatchLonger",
      config: `${DEFAULT}[http "http://example.com/path"]\n\tmaxRetries = 1024\n[http "http://example.com/path/repo"]\n\tmaxRetries = 2048\n`,
      urls: [
        "http://example.com/path/repo/.git",
        "http://example.com/path/repo.git",
        "http://example.com/path/repo/",
        "http://example.com/path/other",
        "http://example.com/path/repository",
      ],
    },
    {
      name: "HttpConfigTest testWildcardHost",
      config: `${DEFAULT}[http "http://*.example.com"]\n\tmaxRetries = 1024\n[http "http://*.*.example.com"]\n\tmaxRetries = 2048\n`,
      urls: [
        "http://a.example.com/repo.git",
        "http://a.b.example.com/repo.git",
        "http://example.com/repo.git",
        "http://aexample.com/repo.git",
      ],
    },
    {
      name: "HttpConfigUriPathTest segmentCompare",
      config: `${DEFAULT}[http "http://example.com/foo/bar"]\n\tmaxRetries = 1024\n[http "http://example.com/foo/bar/"]\n\tmaxRetries = 2048\n[http "http://example.com/foo%20bar"]\n\tmaxRetries = 4096\n`,
      urls: [
        "http://example.com/foo/bar",
        "http://example.com/foo/bar/",
        "http://example.com/foo/bar/baz",
        "http://example.com/foo/barbaz",
        "http://example.com/foo/./bar/baz",
        "http://example.com/foo/x/../bar/baz",
        "http://example.com/foo//bar/baz",
        "http://example.com/foo%2Fbar",
        "http://example.com/foo bar/x",
        "http://example.com/foo%20bar/x",
        "http://example.com/FOO/bar",
      ],
    },
  ];

  for (const { name, config, urls } of cases) {
    it(`${name}: the value git config --get-urlmatch picks`, async () => {
      const repo = join(dir, `r-${counter++}`);
      execFileSync("git", ["init", "-q", repo], { env: testEnv(dir) });
      writeFileSync(join(repo, ".git", "config"), config);
      const ours = await openOurs(repo, createNodeGitHostEnvironment({ env: testEnv(dir) }));
      const store = RemoteConfigStore.from(ours.workingCopy);
      for (const url of urls) {
        let expected: number | undefined;
        try {
          const out = execFileSync("git", ["config", "--get-urlmatch", "http.maxretries", url], {
            cwd: repo,
            env: testEnv(dir),
            stdio: ["ignore", "pipe", "pipe"],
          })
            .toString()
            .trim();
          expected = Number(out);
        } catch {
          expected = undefined;
        }
        const actual = httpClientSettingsOf(store, url).maxRetries;
        expect({ url, value: actual }).toEqual({ url, value: expected });
      }
    });
  }
});
