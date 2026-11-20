/**
 * The served smart-HTTP handler (`createServedFetchHandler` over `servedRepositoryOf`)
 * against native `git http-backend`: a native git client talks to each over a loopback
 * port, one twin of the repositories behind each. The receive hooks (pre-receive, update,
 * post-receive, post-update, reference-transaction) log the same arguments, stdin and
 * variables, `GIT_QUARANTINE_PATH` included (a pre-receive running `git cat-file` reads the
 * quarantined objects); http-backend's service rules (`http.receivepack` for authenticated
 * users only by default, `http.uploadpack`, `http.getanyfile`) refuse as it refuses; hidden
 * refs and refusals reach the client as native git reports them.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createBasePathResolver,
  createServedFetchHandler,
  type ServedHttpHandlerOptions,
} from "@statewalker/vcs-transport";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
  createNodeHookRunner,
} from "@statewalker/vcs-utils-node/files";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openLocalRemote, remoteHookSession } from "../src/commands/local-transport.js";
import { servedRepositoryOf } from "../src/index.js";
import {
  type HookTwin,
  hookExit,
  hookLog,
  hookTwins,
  installHooks,
  nativeIs25x,
} from "./hooks-native-support.js";
import { type LoopbackServer, serveOnLoopback } from "./http-loopback-support.js";
import { openOurs } from "./merge-native-helpers.js";
import { gitAsync } from "./native-connect-support.js";
import { nativeGitAvailable, nativeGitHttpBackend } from "./native-git-http-backend.js";
import { gitOut, putFile } from "./status-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

const RECEIVE_HOOKS = ["pre-receive", "update", "post-receive", "post-update"];

let root: string;
const git = (cwd: string, args: string[]) => gitOut(root, cwd, args);

/** A pre-receive that asks native git for the type of every pushed object. */
const CAT_FILE_HOOK = `#!/bin/sh
while read old new ref; do
  printf 'cat-file %s %s\\n' "$ref" "$(git cat-file -t "$new" 2>&1)" >> "$HOOK_LOG"
done
printf 'objdir=%s\\nalternates=%s\\n' "$GIT_OBJECT_DIRECTORY" "$GIT_ALTERNATE_OBJECT_DIRECTORIES" >> "$HOOK_LOG"
`;

/** `<dir>/src` (main, other) and `<dir>/bare.git` (receive hooks, receive-pack enabled). */
function base(dir: string, config: Record<string, string> = { "http.receivepack": "true" }): void {
  const src = join(dir, "src");
  mkdirSync(src, { recursive: true });
  git(src, ["init", "-q", "-b", "main"]);
  putFile(src, "a.txt", "a\n");
  git(src, ["add", "-A"]);
  git(src, ["commit", "-qm", "a"]);
  git(src, ["branch", "other"]);
  git(dir, ["init", "-q", "--bare", "-b", "main", "bare.git"]);
  for (const [key, value] of Object.entries(config)) {
    git(join(dir, "bare.git"), ["config", key, value]);
  }
  installHooks(join(dir, "bare.git/hooks"), [...RECEIVE_HOOKS, "reference-transaction"]);
}

/** Native `git http-backend` over the twin's repositories, on a loopback port. */
async function nativeServer(
  twin: HookTwin,
  extra: Record<string, string> = {},
): Promise<{ server: LoopbackServer; close(): Promise<void> }> {
  const backend = nativeGitHttpBackend(twin.dir, root, {
    HOOK_LOG: twin.log,
    HOOK_CTL: twin.ctl,
    ...extra,
  });
  const server = await serveOnLoopback((request) => backend.fetch(request));
  return {
    server,
    close: async () => {
      await server.close();
      backend.close();
    },
  };
}

/** Our served handler over the twin's repositories (its hooks run by the Node runner). */
async function ourServer(
  twin: HookTwin,
  options: Partial<ServedHttpHandlerOptions> = {},
): Promise<{ server: LoopbackServer; close(): Promise<void> }> {
  const env = twin.env;
  const host = await openOurs(
    twin.dir,
    createNodeGitHostEnvironment({
      env,
      hookRunner: createNodeHookRunner({ env, compatibility: nativeIs25x ? "2.56" : "2.43" }),
    }),
    undefined,
    "src",
  );
  const handler = createServedFetchHandler({
    resolveRepository: createBasePathResolver({
      files: createNodeFilesApi({ rootDir: twin.dir }),
      exportAll: true,
      openRepository: async (gitDir) => {
        const opened = await openLocalRemote(host.workingCopy, `..${gitDir}`).catch(
          () => undefined,
        );
        if (!opened) return undefined;
        const hooks = remoteHookSession(host.workingCopy, opened);
        return servedRepositoryOf(opened, hooks ? { hooks } : {});
      },
    }),
    ...options,
  });
  const server = await serveOnLoopback(handler);
  return { server, close: () => server.close() };
}

/** The hook log, quarantine directories named alike. */
const logOf = (twin: HookTwin) =>
  hookLog(twin).replace(/tmp_objdir-incoming-[^/\s:"]+/g, "tmp_objdir-incoming-<id>");

/** What a native client prints that both servers decide: refusals, statuses, hooks' lines. */
function clientLines(stderr: string, baseUrl: string): string[] {
  return stderr
    .replaceAll(baseUrl, "<url>")
    .split("\n")
    .map((l) => l.trimEnd())
    .filter(
      (l) =>
        l.startsWith("fatal:") ||
        l.startsWith("error:") ||
        l.startsWith(" ! ") ||
        l.startsWith(" * ") ||
        l.startsWith("   ") ||
        /^remote: hook /.test(l),
    );
}

interface TwinRun {
  status: number | null;
  stdout: string;
  lines: string[];
}

/**
 * Runs native `git <args>` from each twin's `src` against its server (`<url>` in the
 * arguments is the server's base URL): the same exit status, client lines and hook logs.
 */
async function expectTwins(
  dir: string,
  args: string[],
  label: string,
  setup: {
    prepare?: (twin: HookTwin) => void;
    native?: Record<string, string>;
    ours?: Partial<ServedHttpHandlerOptions>;
  } = {},
): Promise<{ theirs: HookTwin; mine: HookTwin; native: TwinRun; ours: TwinRun }> {
  const [theirs, mine] = hookTwins(root, dir);
  setup.prepare?.(theirs);
  setup.prepare?.(mine);
  const run = async (
    twin: HookTwin,
    server: { server: LoopbackServer; close(): Promise<void> },
  ) => {
    try {
      const url = server.server.baseUrl;
      const r = await gitAsync(
        root,
        join(twin.dir, "src"),
        args.map((a) => a.replace("<url>", url)),
        twin.env,
      );
      return {
        status: r.status,
        stdout: r.stdout.replaceAll(url, "<url>"),
        lines: clientLines(r.stderr, url),
      };
    } finally {
      await server.close();
    }
  };
  const native = await run(theirs, await nativeServer(theirs, setup.native));
  const ours = await run(mine, await ourServer(mine, setup.ours));
  expect(ours.status, `${label}: status`).toBe(native.status);
  expect(ours.lines, `${label}: client`).toEqual(native.lines);
  expect(logOf(mine), `${label}: hook log`).toBe(logOf(theirs));
  expect(git(join(mine.dir, "bare.git"), ["for-each-ref"]), `${label}: refs`).toBe(
    git(join(theirs.dir, "bare.git"), ["for-each-ref"]),
  );
  return { theirs, mine, native, ours };
}

describeGit("served smart HTTP: receive hooks as git http-backend runs them", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "http-served-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("pre-receive, update, post-receive, post-update and reference-transaction", async () => {
    const dir = join(root, "r");
    base(dir);
    const { theirs } = await expectTwins(dir, ["push", "<url>/bare.git", "main", "other"], "push");
    // the quarantine as git names it to pre-receive: absolute, below the objects
    expect(logOf(theirs)).toContain(
      "GIT_QUARANTINE_PATH=<twin>/bare.git/./objects/tmp_objdir-incoming-<id>",
    );
    await expectTwins(dir, ["push", "<url>/bare.git", ":other"], "delete", {
      prepare: (t) => git(join(t.dir, "src"), ["push", "-q", "../bare.git", "other"]),
    });
  });

  it("a refusing pre-receive or update declines the refs", async () => {
    const dir = join(root, "r");
    base(dir);
    await expectTwins(dir, ["push", "<url>/bare.git", "main", "other"], "pre-receive exit 1", {
      prepare: (t) => hookExit(t, "pre-receive", 1),
    });
    await expectTwins(dir, ["push", "<url>/bare.git", "main"], "update exit 1", {
      prepare: (t) => hookExit(t, "update", 1),
    });
  });

  it("a pre-receive running native git reads the quarantined objects", async () => {
    const dir = join(root, "r");
    base(dir);
    const hook = join(dir, "bare.git/hooks/pre-receive");
    writeFileSync(hook, CAT_FILE_HOOK);
    chmodSync(hook, 0o755);
    const { mine } = await expectTwins(dir, ["push", "<url>/bare.git", "main"], "cat-file");
    expect(logOf(mine)).toContain("cat-file refs/heads/main commit");
    expect(logOf(mine)).toContain("objdir=<twin>/bare.git/./objects/tmp_objdir-incoming-<id>");
    expect(logOf(mine)).toContain("alternates=<twin>/bare.git/./objects");
  });

  it("receive.hideRefs refuses a hidden ref; transfer.hideRefs hides it from ls-remote", async () => {
    const dir = join(root, "r");
    base(dir, {
      "http.receivepack": "true",
      "receive.hideRefs": "refs/hidden",
      "transfer.hideRefs": "refs/secret",
    });
    git(join(dir, "src"), ["push", "-q", "../bare.git", "main"]);
    git(join(dir, "bare.git"), ["update-ref", "refs/secret/x", "main"]);
    await expectTwins(dir, ["push", "<url>/bare.git", "other:refs/hidden/x"], "hidden push");
    const { native, ours } = await expectTwins(dir, ["ls-remote", "<url>/bare.git"], "ls-remote");
    expect(ours.stdout).toBe(native.stdout);
    expect(ours.stdout).not.toContain("refs/secret");
  });
});

describeGit("served smart HTTP: http-backend's service rules", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "http-served-rules-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("receive-pack: refused to anonymous users unless http.receivepack, served with REMOTE_USER", async () => {
    const dir = join(root, "r");
    base(dir, {});
    const anonymous = await expectTwins(dir, ["push", "<url>/bare.git", "main"], "anonymous");
    expect(anonymous.native.status).not.toBe(0);
    expect(anonymous.native.lines.join("\n")).toContain("403");
    const user = await expectTwins(dir, ["push", "<url>/bare.git", "main"], "REMOTE_USER", {
      native: { REMOTE_USER: "alice" },
      ours: { remoteUser: () => "alice" },
    });
    expect(user.native.status).toBe(0);
    await expectTwins(dir, ["push", "<url>/bare.git", "main"], "http.receivepack=false", {
      prepare: (t) => git(join(t.dir, "bare.git"), ["config", "http.receivepack", "false"]),
      native: { REMOTE_USER: "alice" },
      ours: { remoteUser: () => "alice" },
    });
  });

  it("upload-pack: http.uploadpack=false refuses fetches", async () => {
    const dir = join(root, "r");
    base(dir);
    git(join(dir, "src"), ["push", "-q", "../bare.git", "main"]);
    await expectTwins(dir, ["ls-remote", "<url>/bare.git"], "uploadpack on");
    const off = await expectTwins(dir, ["ls-remote", "<url>/bare.git"], "uploadpack off", {
      prepare: (t) => git(join(t.dir, "bare.git"), ["config", "http.uploadpack", "false"]),
    });
    expect(off.native.status).not.toBe(0);
  });

  it("the dumb protocol's HEAD and info/refs, refused by http.getanyfile=false", async () => {
    const dir = join(root, "r");
    base(dir);
    git(join(dir, "src"), ["tag", "-a", "-m", "t", "v1"]);
    git(join(dir, "src"), ["push", "-q", "../bare.git", "main", "other", "v1"]);
    const [theirs, mine] = hookTwins(root, dir);
    const backend = nativeGitHttpBackend(theirs.dir, root);
    const ours = await ourServer(mine);
    try {
      const answer = async (
        fetcher: (r: Request) => Promise<Response>,
        base: string,
        path: string,
      ) => {
        const response = await fetcher(new Request(`${base}${path}`));
        return { status: response.status, body: await response.text() };
      };
      const ourFetch = (r: Request) => fetch(r);
      for (const off of [false, true]) {
        if (off) {
          for (const t of [theirs, mine])
            git(join(t.dir, "bare.git"), ["config", "http.getanyfile", "false"]);
        }
        for (const path of [
          "/bare.git/HEAD",
          "/bare.git/info/refs",
          "/bare.git/objects/info/packs",
          "/nope.git/HEAD",
          "/bare.git/nothing",
        ]) {
          const expected = await answer(backend.fetch, "http://localhost", path);
          const got = await answer(ourFetch, ours.server.baseUrl, path);
          // files are not served by ours: only the refusal (getanyfile off) must agree there
          if (path.includes("/objects/") && !off) {
            expect(expected.status, path).toBe(200);
            expect(got.status, path).toBe(404);
            continue;
          }
          expect(got, `${path} (getanyfile ${off ? "off" : "on"})`).toEqual(expected);
        }
      }
    } finally {
      await ours.close();
      backend.close();
    }
  });
});

describeGit("local push: the quarantine path given to pre-receive (as native git)", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "quarantine-local-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("a pre-receive running native git reads the quarantined objects of a local push", async () => {
    const dir = join(root, "r");
    base(dir);
    const hook = join(dir, "bare.git/hooks/pre-receive");
    writeFileSync(hook, CAT_FILE_HOOK);
    chmodSync(hook, 0o755);
    const [theirs, mine] = hookTwins(root, dir);
    const native = await gitAsync(
      root,
      join(theirs.dir, "src"),
      ["push", "../bare.git", "main"],
      theirs.env,
    );
    expect(native.status).toBe(0);
    const env = mine.env;
    const ours = await openOurs(
      mine.dir,
      createNodeGitHostEnvironment({
        env,
        hookRunner: createNodeHookRunner({ env, compatibility: nativeIs25x ? "2.56" : "2.43" }),
      }),
      undefined,
      "src",
    );
    await ours.push().setRemote("../bare.git").add("main").call();
    expect(logOf(mine)).toBe(logOf(theirs));
    expect(logOf(mine)).toContain("cat-file refs/heads/main commit");
  });
});
