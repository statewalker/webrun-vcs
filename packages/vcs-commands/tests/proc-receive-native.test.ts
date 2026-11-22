/**
 * git's proc-receive hook (builtin/receive-pack.c `run_proc_receive_hook`,
 * `read_proc_receive_report`, `receive.procReceiveRefs`) and report-status-v2 against native
 * git, scenarios ported from t5411:
 *
 * - a native client pushing over smart HTTP to native `git http-backend` in one twin and to
 *   our served handler in the other (our receive side, its hooks run by the Node runner);
 * - a local push, native in one twin, ours (our client and our receive-pack in process) in
 *   the other, human and porcelain output;
 * - our client pushing to native `git http-backend` in one twin, native git in the other
 *   (send-pack's `print_ref_status` of the server's rewrites, remote-tracking refs).
 *
 * Each compares the client's lines, the hook logs (every receive hook's arguments, stdin and
 * variables; what proc-receive read: the version line, commands, push options) and the refs.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBasePathResolver, createServedFetchHandler } from "@statewalker/vcs-transport";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
  createNodeHookRunner,
} from "@statewalker/vcs-utils-node/files";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openLocalRemote, remoteHookSession } from "../src/commands/local-transport.js";
import { type PushCommand, type PushResult, PushStatus, servedRepositoryOf } from "../src/index.js";
import {
  type HookTwin,
  hookLog,
  hookTwins,
  installHooks,
  nativeIs25x,
} from "./hooks-native-support.js";
import { type LoopbackServer, serveOnLoopback } from "./http-loopback-support.js";
import { openOurs } from "./merge-native-helpers.js";
import { gitAsync } from "./native-connect-support.js";
import {
  nativeGitAvailable,
  nativeGitHttpBackend,
  noMaintenance,
} from "./native-git-http-backend.js";
import { installProcReceive, writeProcReceiveTool } from "./proc-receive-native-support.js";
import { gitOut, gitRun, putFile } from "./status-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

const RECEIVE_HOOKS = ["pre-receive", "update", "post-receive", "post-update"];
const ZERO = "0".repeat(40);

let root: string;
let A: string;
let B: string;
const git = (cwd: string, args: string[]) => gitOut(root, cwd, args);

/** One t5411 case: the server's settings, the hook, the push. */
interface Scenario {
  label: string;
  /** receive.procReceiveRefs values */
  refs: string[];
  /** The tool's options; undefined: no proc-receive hook */
  hook?: () => string[];
  /** The refspecs pushed */
  push: string[];
  atomic?: boolean;
  pushOptions?: string[];
  force?: boolean;
  /** Lines native git's stderr has (the case is what it says) */
  shows?: string[];
  /** Prepares the bare repository from the pusher (refs it must have), before its hooks */
  prepare?: (src: string) => void;
}

const SCENARIOS: Scenario[] = [
  {
    label: "no hook",
    refs: ["refs/for", "refs/review/"],
    push: ["HEAD:refs/heads/next", "HEAD:refs/for/main/topic"],
  },
  {
    // run_proc_receive_hook finds the hook with find_hook alone: a configured hook
    // (hook.<name>.event, git 2.5x) is not one
    label: "a configured hook is no proc-receive hook",
    refs: ["refs/for"],
    push: ["HEAD:refs/for/main/topic"],
    prepare: (src) => {
      const bare = join(src, "../bare.git");
      git(bare, ["config", "hook.p.event", "proc-receive"]);
      git(bare, ["config", "hook.p.command", "echo version=1"]);
    },
    shows: ["remote: error: cannot find hook 'proc-receive'"],
  },
  {
    label: "no hook, atomic",
    refs: ["refs/for"],
    push: ["b:refs/heads/main", "HEAD:refs/heads/next", "HEAD:refs/for/main/topic"],
    atomic: true,
  },
  {
    label: "unknown version",
    refs: ["refs/for"],
    hook: () => ["-v", "--version", "2"],
    push: ["HEAD:refs/for/main/topic"],
    shows: ["remote: error: proc-receive version '2' is not supported"],
  },
  {
    label: "hook dies reading commands",
    refs: ["refs/for"],
    hook: () => ["-v", "--die-read-commands"],
    push: ["HEAD:refs/for/main/topic"],
  },
  {
    label: "hook dies writing its report",
    refs: ["refs/for"],
    hook: () => ["-v", "--die-write-report"],
    push: ["HEAD:refs/for/main/topic"],
  },
  {
    label: "no report",
    refs: ["refs/for"],
    hook: () => ["-v"],
    push: ["HEAD:refs/heads/next", "HEAD:refs/for/main/topic"],
  },
  {
    label: "incomplete status line",
    refs: ["refs/for"],
    hook: () => ["-v", "-r", "ok"],
    push: ["HEAD:refs/for/main/topic"],
  },
  {
    label: "status on an unknown ref",
    refs: ["refs/for"],
    hook: () => ["-v", "-r", "ok refs/for/main/topic", "-r", "ok refs/for/a/b/c/my/topic"],
    push: ["HEAD:refs/for/main/topic"],
  },
  {
    label: "status on an unexpected ref",
    refs: ["refs/for"],
    hook: () => ["-v", "-r", "ok refs/heads/main", "-r", "ok refs/for/main/topic"],
    push: ["b:refs/heads/main", "HEAD:refs/for/main/topic"],
  },
  {
    label: "option without ok",
    refs: ["refs/for"],
    hook: () => ["-v", "-r", "option refname refs/pull/1/head", "-r", "ok refs/for/main/topic"],
    push: ["HEAD:refs/for/main/topic"],
  },
  {
    label: "bad status",
    refs: ["refs/for"],
    hook: () => ["-v", "-r", "xx refs/for/main/topic"],
    push: ["HEAD:refs/for/main/topic"],
  },
  {
    label: "ng without a message",
    refs: ["refs/for"],
    hook: () => ["-v", "-r", "ng refs/for/main/topic"],
    push: ["HEAD:refs/for/main/topic"],
  },
  {
    label: "ng with a message",
    refs: ["refs/for"],
    hook: () => ["-v", "-r", "ng refs/for/main/topic error msg"],
    push: ["HEAD:refs/for/main/topic"],
  },
  {
    label: "ok",
    refs: ["refs/for"],
    hook: () => ["-v", "-r", "ok refs/for/main/topic"],
    push: ["HEAD:refs/heads/next", "HEAD:refs/for/main/topic"],
  },
  {
    label: "ok with options",
    refs: ["refs/for"],
    hook: () => [
      "-v",
      "-r",
      "ok refs/for/main/topic",
      "-r",
      "option refname refs/pull/123/head",
      "-r",
      `option old-oid ${A}`,
      "-r",
      `option new-oid ${B}`,
    ],
    push: ["HEAD:refs/for/main/topic"],
    shows: ["HEAD -> refs/pull/123/head"],
  },
  {
    label: "forced update",
    refs: ["refs/for"],
    hook: () => [
      "-v",
      "-r",
      "ok refs/for/main/topic",
      "-r",
      "option refname refs/pull/123/head",
      "-r",
      `option old-oid ${B}`,
      "-r",
      `option new-oid ${A}`,
      "-r",
      "option forced-update",
    ],
    push: ["HEAD:refs/for/main/topic"],
  },
  {
    label: "new reference by refname only",
    refs: ["refs/for"],
    hook: () => ["-v", "-r", "ok refs/for/main/topic", "-r", "option refname refs/heads/main"],
    push: ["HEAD:refs/for/main/topic"],
  },
  {
    label: "multiple rewrites of one ref",
    refs: ["refs/for"],
    hook: () => [
      "-v",
      "-r",
      "ok refs/for/main/topic",
      "-r",
      `option old-oid ${A}`,
      "-r",
      `option new-oid ${B}`,
      "-r",
      "ok refs/for/main/topic",
      "-r",
      "option refname refs/changes/24/124/1",
      "-r",
      `option old-oid ${ZERO}`,
      "-r",
      `option new-oid ${A}`,
      "-r",
      "ok refs/for/main/topic",
      "-r",
      "option refname refs/changes/25/125/1",
      "-r",
      `option old-oid ${B}`,
      "-r",
      `option new-oid ${A}`,
      "-r",
      "option forced-update",
    ],
    push: ["HEAD:refs/for/main/topic"],
    shows: [" * [new reference]   HEAD -> refs/changes/24/124/1", "(forced update)"],
  },
  {
    label: "fall-through and mixed refs",
    refs: ["refs/for"],
    hook: () => [
      "-v",
      "-r",
      "ok refs/for/main/topic1",
      "-r",
      "option fall-through",
      "-r",
      "ok refs/for/main/topic2",
      "-r",
      "option refname refs/for/changes/23/123/1",
      "-r",
      `option new-oid ${A}`,
      "-r",
      "ok refs/for/main/topic2",
      "-r",
      "option refname refs/for/changes/24/124/2",
      "-r",
      `option old-oid ${B}`,
      "-r",
      `option new-oid ${A}`,
      "-r",
      "option forced-update",
      "-r",
      "ng refs/for/next/topic target branch not exist",
    ],
    push: [
      "b:refs/heads/main",
      "HEAD:refs/for/main/topic1",
      "HEAD:refs/heads/foo",
      "HEAD:refs/for/next/topic",
      "HEAD:refs/for/main/topic2",
    ],
  },
  {
    label: "every ref, fall-through for the branches",
    refs: ["refs"],
    hook: () => [
      "-v",
      "-r",
      "ok refs/heads/main",
      "-r",
      "option fall-through",
      "-r",
      "ok refs/heads/foo",
      "-r",
      "option fall-through",
      "-r",
      "ok refs/for/main/topic",
      "-r",
      "option refname refs/pull/123/head",
      "-r",
      `option old-oid ${A}`,
      "-r",
      `option new-oid ${B}`,
    ],
    push: ["b:refs/heads/main", ":refs/heads/foo", "HEAD:refs/for/main/topic"],
    force: true,
    prepare: (src) => git(src, ["push", "-q", "../bare.git", "main:refs/heads/foo"]),
  },
  {
    label: "atomic, every proc-receive ref ok",
    refs: ["refs/for"],
    hook: () => ["-v", "-r", "ok refs/for/main/topic"],
    push: ["b:refs/heads/main", "HEAD:refs/for/main/topic"],
    atomic: true,
  },
  {
    label: "atomic, only proc-receive refs",
    refs: ["refs/for"],
    hook: () => ["-v", "-r", "ok refs/for/main/topic", "-r", "option refname refs/pull/7/head"],
    push: ["HEAD:refs/for/main/topic"],
    atomic: true,
  },
  {
    label: "atomic, a proc-receive ref refused",
    refs: ["refs/for"],
    hook: () => ["-v", "-r", "ok refs/for/main/topic", "-r", "ng refs/for/next/topic no"],
    push: ["b:refs/heads/main", "HEAD:refs/for/main/topic", "HEAD:refs/for/next/topic"],
    atomic: true,
  },
  {
    label: "atomic, the transaction refused",
    refs: ["refs/for"],
    hook: () => ["-v", "-r", "ok refs/for/main/topic"],
    push: ["+main:refs/heads/next", "HEAD:refs/for/main/topic"],
    atomic: true,
    // a forced update the server refuses (receive.denyNonFastForwards) inside the transaction
    prepare: (src) => {
      git(src, ["push", "-q", "../bare.git", "b:refs/heads/next"]);
      git(join(src, "../bare.git"), ["config", "receive.denyNonFastForwards", "true"]);
    },
  },
  {
    label: "push options",
    refs: ["refs/for"],
    hook: () => ["-v", "-r", "ok refs/for/main/topic"],
    push: ["HEAD:refs/heads/next", "HEAD:refs/for/main/topic"],
    pushOptions: ["issue=123", "reviewer=user1"],
  },
  {
    label: "push options the hook does not take",
    refs: ["refs/for"],
    hook: () => ["-v", "--no-push-options", "-r", "ok refs/for/main/topic"],
    push: ["HEAD:refs/for/main/topic"],
    pushOptions: ["issue=123"],
  },
  {
    label: "modifiers and negation",
    refs: ["m:refs/heads/main", "ad:refs/heads", "a!:refs/heads"],
    hook: () => [
      "-v",
      "-r",
      "ok refs/heads/main",
      "-r",
      "option refname refs/pull/123/head",
      "-r",
      `option old-oid ${A}`,
      "-r",
      `option new-oid ${B}`,
      "-r",
      "ok refs/tags/v123 ",
      "-r",
      "option refname refs/pull/124/head",
    ],
    push: ["b:refs/heads/main", "v123"],
    shows: [" * [new reference]   v123 -> refs/pull/124/head"],
  },
  {
    label: "modifiers: create and delete",
    refs: ["m:refs/heads/main", "ad:refs/heads", "a!:refs/heads"],
    hook: () => [
      "-v",
      "-r",
      "ok refs/heads/main",
      "-r",
      "option refname refs/pull/123/head",
      "-r",
      `option old-oid ${A}`,
      "-r",
      `option new-oid ${ZERO}`,
      "-r",
      "ok refs/heads/next",
      "-r",
      "option refname refs/pull/124/head",
      "-r",
      `option new-oid ${A}`,
    ],
    push: [":refs/heads/main", "b:refs/heads/topic", "HEAD:refs/heads/next", ":refs/tags/v123"],
    prepare: (src) => git(src, ["push", "-q", "../bare.git", "main:refs/heads/topic", "v123"]),
  },
];

/** `<dir>/src` (main at A, b at B, tag v123 on A), `<dir>/bare.git` (main at A, hooks). */
function base(dir: string, tool: string, scenario: Scenario): void {
  const src = join(dir, "src");
  mkdirSync(src, { recursive: true });
  git(src, ["init", "-q", "-b", "main"]);
  putFile(src, "a.txt", "a\n");
  git(src, ["add", "-A"]);
  git(src, ["commit", "-qm", "A"]);
  putFile(src, "a.txt", "b\n");
  git(src, ["commit", "-qam", "B"]);
  git(src, ["branch", "b"]);
  git(src, ["reset", "-q", "--hard", "HEAD~1"]);
  git(src, ["tag", "-m", "v123", "v123"]);
  git(src, ["config", "core.abbrev", "7"]);
  A = git(src, ["rev-parse", "main"]).trim();
  B = git(src, ["rev-parse", "b"]).trim();
  const bare = join(dir, "bare.git");
  git(dir, ["init", "-q", "--bare", "-b", "main", "bare.git"]);
  noMaintenance(bare);
  git(bare, ["config", "http.receivepack", "true"]);
  git(bare, ["config", "receive.advertisePushOptions", "true"]);
  git(src, ["push", "-q", "../bare.git", "main"]);
  git(src, ["remote", "add", "origin", "../bare.git"]);
  git(src, ["config", "--add", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
  // remote-tracking refs of the special refs (t5411's "remote-tracking of special refs")
  git(src, ["config", "--add", "remote.origin.fetch", "+refs/for/*:refs/t/for/*"]);
  git(src, ["config", "--add", "remote.origin.fetch", "+refs/pull/*:refs/t/pull/*"]);
  git(src, ["config", "--add", "remote.origin.fetch", "+refs/changes/*:refs/t/changes/*"]);
  scenario.prepare?.(src);
  for (const value of scenario.refs)
    git(bare, ["config", "--add", "receive.procReceiveRefs", value]);
  installHooks(join(bare, "hooks"), [...RECEIVE_HOOKS, "reference-transaction"]);
  if (scenario.hook) installProcReceive(join(bare, "hooks"), tool, scenario.hook());
}

/** The native `git push` arguments of a scenario, after the options and before the remote. */
function nativeOptions(s: Scenario, porcelain = false): string[] {
  return [
    ...(porcelain ? ["--porcelain"] : []),
    ...(s.atomic ? ["--atomic"] : []),
    ...(s.force ? ["-f"] : []),
    ...(s.pushOptions ?? []).flatMap((o) => ["-o", o]),
  ];
}

function setupOurs(p: PushCommand, s: Scenario, remote: string): void {
  p.setRemote(remote);
  for (const spec of s.push) p.add(spec);
  if (s.atomic) p.setAtomic(true);
  if (s.force) p.setForce(true);
  if (s.pushOptions) p.setPushOptions(s.pushOptions);
}

/** The hook logs, quarantine directories named alike. */
const logOf = (twin: HookTwin) =>
  hookLog(twin).replace(/tmp_objdir-incoming-[^/\s:"]+/g, "tmp_objdir-incoming-<id>");

/** The client's lines both servers decide (the URL written `<url>`, padding trimmed). */
function clientLines(stderr: string, url: string): string[] {
  return stderr
    .replaceAll(url, "<url>")
    .split("\n")
    .map((l) => l.trimEnd())
    .filter(
      (l) =>
        l.length > 0 &&
        // the connection's death after a receive-pack that died differs by transport
        !/hung up|unexpected disconnect|^fatal: the remote end/.test(l),
    );
}

/** The ref lines of a push's report (`To`, ` * `, ` ! `, ...). */
const refLines = (lines: string[]) =>
  lines.filter((l) => l.startsWith("To ") || /^ [ *!=+-] /.test(l)).map((l) => l.trimEnd());

/** The refs of a repository (`for-each-ref`). */
const refsOf = (dir: string) => git(dir, ["for-each-ref"]);

/** The remote-tracking refs of the pusher (t5411's `refs/t/...` included). */
const trackingOf = (src: string) => git(src, ["for-each-ref", "refs/t", "refs/remotes"]);

/** Our working copy over a twin's `src`, hooks run by the Node runner. */
function oursAt(twin: HookTwin) {
  const env = twin.env;
  return openOurs(
    twin.dir,
    createNodeGitHostEnvironment({
      env,
      hookRunner: createNodeHookRunner({ env, compatibility: nativeIs25x ? "2.56" : "2.43" }),
    }),
    undefined,
    "src",
  );
}

/** Native `git http-backend` over a twin, on a loopback port. */
async function nativeServer(twin: HookTwin): Promise<LoopbackServer & { stop(): Promise<void> }> {
  const backend = nativeGitHttpBackend(twin.dir, root, { HOOK_LOG: twin.log, HOOK_CTL: twin.ctl });
  const server = await serveOnLoopback((request) => backend.fetch(request));
  return Object.assign(server, {
    stop: async () => {
      await server.close();
      backend.close();
    },
  });
}

/** Our served handler over a twin (its hooks run by the Node runner), on a loopback port. */
async function ourServer(twin: HookTwin): Promise<LoopbackServer & { stop(): Promise<void> }> {
  const host = await oursAt(twin);
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
  });
  const server = await serveOnLoopback(handler);
  return Object.assign(server, { stop: () => server.close() });
}

/** Our push in a twin: its result, or the error it threw. */
async function oursPush(
  twin: HookTwin,
  s: Scenario,
  remote: string,
): Promise<{ result?: PushResult; error?: Error }> {
  const ours = await oursAt(twin);
  const command = ours.push();
  setupOurs(command, s, remote);
  try {
    return { result: await command.call() };
  } catch (error) {
    return { error: error as Error };
  }
}

/** Whether a push result refused a ref (git exits 1 then). */
const refused = (r: { result?: PushResult; error?: Error }) =>
  !!r.error ||
  !!r.result?.remoteUpdates.some(
    (u) => u.status !== PushStatus.OK && u.status !== PushStatus.UP_TO_DATE,
  );

/** git's "remote: " lines of our result's server messages. */
const remoteLinesOf = (messages: string[]) =>
  messages
    .join("")
    .replace(/\r/g, "\n")
    .split("\n")
    // progress a client shows only on a terminal
    .filter((l) => l.length > 0 && !l.startsWith("Checking connectivity"))
    .map((l) => `remote: ${l}`.trimEnd());

const remoteOnly = (lines: string[]) =>
  lines.filter((l) => l.startsWith("remote: ")).map((l) => l.trimEnd());

describeGit("proc-receive: a native client pushing to our served receive-pack", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "proc-receive-served-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  for (const s of SCENARIOS) {
    for (const porcelain of [false, true]) {
      it(`${s.label}${porcelain ? " (porcelain)" : ""}`, async () => {
        const dir = join(root, "r");
        base(dir, writeProcReceiveTool(root), s);
        const [theirs, mine] = hookTwins(root, dir);
        const run = async (twin: HookTwin, server: LoopbackServer & { stop(): Promise<void> }) => {
          try {
            const url = server.baseUrl;
            const r = await gitAsync(
              root,
              join(twin.dir, "src"),
              ["push", ...nativeOptions(s, porcelain), `${url}/bare.git`, ...s.push],
              twin.env,
            );
            return {
              status: r.status,
              stdout: clientLines(r.stdout, url),
              stderr: clientLines(r.stderr, url),
            };
          } finally {
            await server.stop();
          }
        };
        const native = await run(theirs, await nativeServer(theirs));
        const ours = await run(mine, await ourServer(mine));
        expect(ours.stderr, `${s.label}: stderr`).toEqual(native.stderr);
        expect(ours.stdout, `${s.label}: stdout`).toEqual(native.stdout);
        expect(ours.status, `${s.label}: status`).toBe(native.status);
        expect(logOf(mine), `${s.label}: hook log`).toBe(logOf(theirs));
        expect(refsOf(join(mine.dir, "bare.git")), `${s.label}: refs`).toBe(
          refsOf(join(theirs.dir, "bare.git")),
        );
      }, 60_000);
    }
  }
});

describeGit("proc-receive: a local push, native and ours", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "proc-receive-local-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  for (const s of SCENARIOS) {
    it(s.label, async () => {
      const dir = join(root, "r");
      base(dir, writeProcReceiveTool(root), s);
      for (const porcelain of [false, true]) {
        const [theirs, mine] = hookTwins(root, dir);
        const native = gitRun(
          root,
          join(theirs.dir, "src"),
          ["push", ...nativeOptions(s, porcelain), "origin", ...s.push],
          theirs.env,
        );
        const ours = await oursPush(mine, s, "origin");
        const label = `${s.label}${porcelain ? " (porcelain)" : ""}`;
        if (!porcelain) for (const line of s.shows ?? []) expect(native.stderr).toContain(line);
        // what proc-receive read is in the logs compared
        if (s.hook) expect(logOf(theirs)).toContain("== proc-receive");
        expect(logOf(mine), `${label}: hook log`).toBe(logOf(theirs));
        expect(refsOf(join(mine.dir, "bare.git")), `${label}: refs`).toBe(
          refsOf(join(theirs.dir, "bare.git")),
        );
        expect(refused(ours), `${label}: failed (${String(ours.error)})`).toBe(native.status !== 0);
        const nativeStderr = clientLines(native.stderr, "\0");
        if (ours.result) {
          expect(remoteLinesOf(ours.result.messages), `${label}: remote`).toEqual(
            remoteOnly(nativeStderr),
          );
          if (porcelain) {
            expect(ours.result.porcelain, `${label}: porcelain`).toEqual(
              clientLines(native.stdout, "\0"),
            );
          } else {
            expect(ours.result.display, `${label}: display`).toEqual(refLines(nativeStderr));
          }
        }
        expect(trackingOf(join(mine.dir, "src")), `${label}: tracking`).toBe(
          trackingOf(join(theirs.dir, "src")),
        );
      }
    }, 60_000);
  }
});

describeGit("proc-receive: our client pushing to native receive-pack", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "proc-receive-client-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  for (const s of SCENARIOS) {
    it(s.label, async () => {
      const dir = join(root, "r");
      base(dir, writeProcReceiveTool(root), s);
      for (const porcelain of [false, true]) {
        const [theirs, mine] = hookTwins(root, dir);
        const label = `${s.label}${porcelain ? " (porcelain)" : ""}`;
        const theirServer = await nativeServer(theirs);
        let native: { status: number | null; stdout: string; stderr: string };
        try {
          native = await gitAsync(
            root,
            join(theirs.dir, "src"),
            ["push", ...nativeOptions(s, porcelain), `${theirServer.baseUrl}/bare.git`, ...s.push],
            theirs.env,
          );
          native.stdout = native.stdout.replaceAll(theirServer.baseUrl, "<url>");
          native.stderr = native.stderr.replaceAll(theirServer.baseUrl, "<url>");
        } finally {
          await theirServer.stop();
        }
        const myServer = await nativeServer(mine);
        let ours: { result?: PushResult; error?: Error };
        try {
          // through the configured remote's refspecs, so the tracking refs follow
          git(join(mine.dir, "src"), [
            "remote",
            "set-url",
            "origin",
            `${myServer.baseUrl}/bare.git`,
          ]);
          ours = await oursPush(mine, s, "origin");
          for (const key of ["display", "porcelain"] as const) {
            const lines = ours.result?.[key];
            if (lines && ours.result) {
              ours.result[key] = lines.map((l) => l.replaceAll(myServer.baseUrl, "<url>"));
            }
          }
        } finally {
          await myServer.stop();
        }
        expect(logOf(mine), `${label}: hook log`).toBe(logOf(theirs));
        expect(refsOf(join(mine.dir, "bare.git")), `${label}: refs`).toBe(
          refsOf(join(theirs.dir, "bare.git")),
        );
        expect(refused(ours), `${label}: failed (${String(ours.error)})`).toBe(native.status !== 0);
        if (ours.result) {
          const nativeStderr = clientLines(native.stderr, "<url>");
          expect(remoteLinesOf(ours.result.messages), `${label}: remote`).toEqual(
            remoteOnly(nativeStderr),
          );
          if (porcelain) {
            expect(ours.result.porcelain, `${label}: porcelain`).toEqual(
              clientLines(native.stdout, "<url>"),
            );
          } else {
            expect(ours.result.display, `${label}: display`).toEqual(refLines(nativeStderr));
          }
        }
      }
    }, 60_000);
  }
});
