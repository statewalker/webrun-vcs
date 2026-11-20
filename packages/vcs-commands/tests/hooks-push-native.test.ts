/**
 * The push hooks against native git: pre-push on the pushing side (transport.c
 * `run_pre_push_hook`: the remote's name and URL, a line per ref to push on stdin, its stdout
 * kept on git's stdout; a refusal stops the push before anything is sent, `--no-verify` skips
 * it), and the receive side of a local push (builtin/receive-pack.c): pre-receive, update,
 * post-receive and post-update run in the remote's git directory with `GIT_DIR=.`, their
 * output relayed as "remote: " lines, a refusing pre-receive or update declining the refs.
 * Each case runs native git in one copy of a pusher and its bare remote and ours (with the
 * Node hook runner) in the other.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createNodeGitHostEnvironment,
  createNodeHookRunner,
} from "@statewalker/vcs-utils-node/files";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HookFailedError, type PushCommand, PushStatus } from "../src/index.js";
import {
  type HookTwin,
  hookExit,
  hookLines,
  hookLog,
  hookTwins,
  installHooks,
  nativeIs25x,
} from "./hooks-native-support.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { gitOut, gitRun, putFile } from "./status-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

const RECEIVE_HOOKS = ["pre-receive", "update", "post-receive", "post-update"];

let root: string;
const git = (cwd: string, args: string[]) => gitOut(root, cwd, args);

/** `<dir>/src` (main, other) with a pre-push hook, `<dir>/bare.git` with receive hooks. */
function base(dir: string): void {
  const src = join(dir, "src");
  mkdirSync(src, { recursive: true });
  git(src, ["init", "-q", "-b", "main"]);
  putFile(src, "a.txt", "a\n");
  git(src, ["add", "-A"]);
  git(src, ["commit", "-qm", "a"]);
  git(src, ["branch", "other"]);
  git(dir, ["init", "-q", "--bare", "bare.git"]);
  installHooks(join(src, ".git/hooks"), ["pre-push"]);
  installHooks(join(dir, "bare.git/hooks"), RECEIVE_HOOKS);
}

/** git's "remote: " lines, the padding git adds trimmed. */
const remoteLines = (text: string) =>
  text
    .split("\n")
    .filter((l) => l.startsWith("remote: "))
    .map((l) => l.slice("remote: ".length).trimEnd())
    .filter((l) => /^hook /.test(l));

/** The hook log with the quarantine path git gives pre-receive and update left out. */
const logOf = (twin: HookTwin) =>
  hookLog(twin)
    .split("\n")
    .filter((l) => !l.startsWith("GIT_QUARANTINE_PATH="))
    .join("\n");

async function expectPush(
  dir: string,
  args: string[],
  setup: (p: PushCommand) => void,
  label: string,
  prepare?: (twin: HookTwin) => void,
): Promise<void> {
  const [theirs, mine] = hookTwins(root, dir);
  prepare?.(theirs);
  prepare?.(mine);
  const native = gitRun(root, join(theirs.dir, "src"), ["push", ...args], theirs.env);
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
  const command = ours.push();
  setup(command);
  let error: Error | undefined;
  let messages: string[] = [];
  let rejected = false;
  try {
    const result = await command.call();
    messages = result.messages;
    rejected = result.remoteUpdates.some(
      (u) => u.status !== PushStatus.OK && u.status !== PushStatus.UP_TO_DATE,
    );
  } catch (e) {
    error = e as Error;
  }
  expect(logOf(mine), `${label}: log`).toBe(logOf(theirs));
  expect(error !== undefined || rejected, `${label}: failed (${String(error)})`).toBe(
    native.status !== 0,
  );
  if (error) {
    expect(error).toBeInstanceOf(HookFailedError);
    expect(native.stderr, label).toContain(error.message);
  }
  // the pre-push hook's output: its stderr on git's stderr, its stdout on git's stdout
  const output = error instanceof HookFailedError ? error.output : command.getHookOutput();
  expect(hookLines(output), `${label}: pre-push stderr`).toBe(hookLines(native.stderr));
  expect(hookLines(command.getHookStdout()), `${label}: pre-push stdout`).toBe(
    hookLines(native.stdout),
  );
  // the receive side's output, relayed
  expect(
    remoteLines(messages.join("").replace(/\r/g, "\n").replace(/^/gm, "remote: ")),
    `${label}: remote`,
  ).toEqual(remoteLines(native.stderr));
  expect(git(join(mine.dir, "bare.git"), ["for-each-ref"]), `${label}: refs`).toBe(
    git(join(theirs.dir, "bare.git"), ["for-each-ref"]),
  );
}

describeGit("push hooks: as native git", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hooks-push-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("pre-push, then pre-receive, update, post-receive and post-update on the remote", async () => {
    const dir = join(root, "r");
    base(dir);
    await expectPush(
      dir,
      ["../bare.git", "main", "other"],
      (p) => p.setRemote("../bare.git").add("main").add("other"),
      "push",
    );
  });

  it("a refusing pre-push stops the push; --no-verify skips it", async () => {
    const dir = join(root, "r");
    base(dir);
    await expectPush(
      dir,
      ["../bare.git", "main"],
      (p) => p.setRemote("../bare.git").add("main"),
      "pre-push exit 1",
      (t) => hookExit(t, "pre-push", 1),
    );
    await expectPush(
      dir,
      ["--no-verify", "../bare.git", "main"],
      (p) => p.setRemote("../bare.git").add("main").setNoVerify(true),
      "--no-verify",
      (t) => hookExit(t, "pre-push", 1),
    );
  });

  it("a refusing pre-receive or update declines the refs", async () => {
    const dir = join(root, "r");
    base(dir);
    await expectPush(
      dir,
      ["../bare.git", "main", "other"],
      (p) => p.setRemote("../bare.git").add("main").add("other"),
      "pre-receive exit 1",
      (t) => hookExit(t, "pre-receive", 1),
    );
    await expectPush(
      dir,
      ["../bare.git", "main"],
      (p) => p.setRemote("../bare.git").add("main"),
      "update exit 1",
      (t) => hookExit(t, "update", 1),
    );
  });

  it("push-to-checkout runs in place of push-to-deploy for updateInstead", async () => {
    const dir = join(root, "r");
    base(dir);
    const dst = join(dir, "dst");
    mkdirSync(dst);
    git(dst, ["init", "-q", "-b", "main"]);
    putFile(dst, "d.txt", "d\n");
    git(dst, ["add", "-A"]);
    git(dst, ["commit", "-qm", "d"]);
    git(dst, ["config", "receive.denyCurrentBranch", "updateInstead"]);
    installHooks(join(dst, ".git/hooks"), ["push-to-checkout"]);
    for (const refuse of [false, true]) {
      const [theirs, mine] = hookTwins(root, dir);
      if (refuse) {
        hookExit(theirs, "push-to-checkout", 1);
        hookExit(mine, "push-to-checkout", 1);
      }
      const native = gitRun(
        root,
        join(theirs.dir, "src"),
        ["push", "-f", "../dst", "main"],
        theirs.env,
      );
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
      const result = await ours.push().setRemote("../dst").add("+main").call();
      expect(logOf(mine), `refuse ${refuse}: log`).toBe(logOf(theirs));
      expect(result.remoteUpdates[0]?.status === PushStatus.OK, `refuse ${refuse}`).toBe(
        native.status === 0,
      );
      if (refuse) expect(result.remoteUpdates[0]?.message).toBe("push-to-checkout hook declined");
      expect(git(join(mine.dir, "dst"), ["for-each-ref"])).toBe(
        git(join(theirs.dir, "dst"), ["for-each-ref"]),
      );
    }
  });
});
