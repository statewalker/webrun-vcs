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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createNodeGitHostEnvironment,
  createNodeHookRunner,
} from "@statewalker/vcs-utils-node/files";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HookFailedError, type PushCommand, PushStatus, TransportError } from "../src/index.js";
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

/** The hook log, the quarantine directory git names to pre-receive written alike. */
const logOf = (twin: HookTwin) =>
  hookLog(twin).replace(/tmp_objdir-incoming-[^/\s]+/g, "tmp_objdir-incoming-<id>");

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

describeGit("push hooks: reference-transaction on the receive side (as native git)", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hooks-push-reftx-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** `<dir>/src` (main, other, gone) cloned bare to `<dir>/bare.git` (refs packed), then moved on. */
  function reftxBase(dir: string): void {
    const src = join(dir, "src");
    mkdirSync(src, { recursive: true });
    git(src, ["init", "-q", "-b", "main"]);
    putFile(src, "a.txt", "a\n");
    git(src, ["add", "-A"]);
    git(src, ["commit", "-qm", "a"]);
    git(src, ["branch", "other"]);
    git(src, ["branch", "gone"]);
    git(dir, ["clone", "-q", "--bare", "src", "bare.git"]);
    putFile(src, "a.txt", "a2\n");
    git(src, ["commit", "-qam", "a2"]);
    git(src, ["checkout", "-q", "other"]);
    putFile(src, "c.txt", "c\n");
    git(src, ["add", "c.txt"]);
    git(src, ["commit", "-qm", "c"]);
    git(src, ["checkout", "-q", "main"]);
    installHooks(join(dir, "bare.git/hooks"), ["reference-transaction"]);
  }

  /**
   * Native `git push <args>` in one twin, ours in the other: the same hook log and refs of
   * the bare repository, both failing or neither.
   */
  async function expectReftxPush(
    dir: string,
    args: string[],
    setup: (p: PushCommand) => void,
    label: string,
    prepare?: (twin: HookTwin) => void,
  ): Promise<{ native: { status: number | null; stderr: string }; error?: Error; output: string }> {
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
    let rejected = false;
    try {
      const result = await command.call();
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
    expect(git(join(mine.dir, "bare.git"), ["for-each-ref"]), `${label}: refs`).toBe(
      git(join(theirs.dir, "bare.git"), ["for-each-ref"]),
    );
    const output = error instanceof HookFailedError ? error.output : command.getHookOutput();
    expect(hookLines(output), `${label}: hook output`).toBe(hookLines(native.stderr));
    return { native, error, output };
  }

  it("an update, a forced update and a deletion: the remote's ref transactions", async () => {
    const dir = join(root, "r");
    reftxBase(dir);
    await expectReftxPush(
      dir,
      ["--atomic", "-f", "../bare.git", "main", "+other", ":gone"],
      (p) =>
        p
          .setRemote("../bare.git")
          .setAtomic(true)
          .setForce(true)
          .add("main")
          .add("+other")
          .add(":gone"),
      "atomic push",
    );
    await expectReftxPush(
      dir,
      ["-f", "../bare.git", "main", "+other", ":gone"],
      (p) => p.setRemote("../bare.git").setForce(true).add("main").add("+other").add(":gone"),
      "push",
    );
  });

  it("deleting a ref that does not exist: queued in the remote's transaction, not told to post-receive", async () => {
    const dir = join(root, "r");
    reftxBase(dir);
    installHooks(join(dir, "bare.git/hooks"), RECEIVE_HOOKS);
    for (const atomic of [false, true]) {
      const { native } = await expectReftxPush(
        dir,
        [...(atomic ? ["--atomic"] : []), "../bare.git", ":refs/heads/nope", "main"],
        (p) => {
          p.setRemote("../bare.git").add(":refs/heads/nope").add("main");
          if (atomic) p.setAtomic(true);
        },
        `missing delete (atomic ${atomic})`,
      );
      expect(native.stderr).toContain("deleting a non-existent ref");
    }
  });

  it("commands go in git's order (the remote's refs as advertised, then new ones): pre-push, pre-receive and update see it", async () => {
    const dir = join(root, "r");
    reftxBase(dir);
    installHooks(join(dir, "src/.git/hooks"), ["pre-push"]);
    installHooks(join(dir, "bare.git/hooks"), RECEIVE_HOOKS);
    await expectPush(
      dir,
      ["-f", "../bare.git", "main:refs/heads/znew", "other", "main:refs/heads/anew", "main"],
      (p) =>
        p
          .setRemote("../bare.git")
          .setForce(true)
          .add("main:refs/heads/znew")
          .add("other")
          .add("main:refs/heads/anew")
          .add("main"),
      "order",
    );
  });

  it("an update hook refusing an atomic push: no ref moves, the objects stay (migrated after pre-receive)", async () => {
    const dir = join(root, "r");
    reftxBase(dir);
    installHooks(join(dir, "bare.git/hooks"), RECEIVE_HOOKS);
    const objects = (t: HookTwin) =>
      git(join(t.dir, "bare.git"), [
        "cat-file",
        "--batch-all-objects",
        "--batch-check=%(objectname) %(objecttype)",
      ]);
    for (const atomic of [true, false]) {
      const [theirs, mine] = hookTwins(root, dir);
      for (const t of [theirs, mine]) hookExit(t, "update", 1);
      const args = [...(atomic ? ["--atomic"] : []), "-f", "../bare.git", "main", "+other"];
      const native = gitRun(root, join(theirs.dir, "src"), ["push", ...args], theirs.env);
      expect(native.status).not.toBe(0);
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
      const command = ours.push().setRemote("../bare.git").setForce(true).add("main").add("+other");
      if (atomic) command.setAtomic(true);
      const result = await command.call();
      expect(result.remoteUpdates.every((u) => u.status !== PushStatus.OK)).toBe(true);
      expect(logOf(mine), `atomic ${atomic}: log`).toBe(logOf(theirs));
      expect(objects(mine), `atomic ${atomic}: objects`).toBe(objects(theirs));
      expect(git(join(mine.dir, "bare.git"), ["for-each-ref"])).toBe(
        git(join(theirs.dir, "bare.git"), ["for-each-ref"]),
      );
    }
  });

  // git 2.5x's execute_commands_non_atomic: update() and the transaction of the deletions,
  // then update() and the transaction of the rest
  (nativeIs25x ? it : it.skip)(
    "2.5x: the update hook runs per phase, the deletions' transaction before the rest's update hooks",
    async () => {
      const dir = join(root, "r");
      const src = join(dir, "src");
      mkdirSync(src, { recursive: true });
      git(src, ["init", "-q", "-b", "main"]);
      putFile(src, "a.txt", "a\n");
      git(src, ["add", "-A"]);
      git(src, ["commit", "-qm", "a"]);
      for (const b of ["b", "d", "x"]) git(src, ["branch", b]);
      git(dir, ["clone", "-q", "--bare", "src", "bare.git"]);
      putFile(src, "a.txt", "a2\n");
      git(src, ["commit", "-qam", "a2"]);
      for (const b of ["e", "c"]) git(src, ["branch", b]);
      git(src, ["branch", "-f", "d"]);
      installHooks(join(dir, "bare.git/hooks"), ["pre-receive", "update", "reference-transaction"]);
      const refspecs = [
        "refs/heads/e",
        "refs/heads/d",
        ":refs/heads/b",
        "refs/heads/c",
        "refs/heads/main:refs/heads/x",
      ];
      const setup = (p: PushCommand) => {
        p.setRemote("../bare.git");
        for (const r of refspecs) p.add(r);
      };
      await expectReftxPush(dir, ["../bare.git", ...refspecs], setup, "phases");
      const { native } = await expectReftxPush(
        dir,
        ["../bare.git", ...refspecs],
        setup,
        "refused in the deletion phase",
        (t) => hookExit(t, "reference-transaction", 1),
      );
      expect(native.status).toBe(128);
    },
  );

  it("updateInstead: the remote's reference-transaction hook sees the update of its checked-out branch", async () => {
    const dir = join(root, "r");
    reftxBase(dir);
    const dst = join(dir, "dst");
    mkdirSync(dst);
    git(dst, ["init", "-q", "-b", "main"]);
    putFile(dst, "d.txt", "d\n");
    git(dst, ["add", "-A"]);
    git(dst, ["commit", "-qm", "d"]);
    git(dst, ["config", "receive.denyCurrentBranch", "updateInstead"]);
    installHooks(join(dst, ".git/hooks"), ["reference-transaction"]);
    const [theirs, mine] = hookTwins(root, dir);
    const native = gitRun(
      root,
      join(theirs.dir, "src"),
      ["push", "-f", "../dst", "main"],
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
    const command = ours.push().setRemote("../dst").add("+main");
    const result = await command.call();
    expect(result.remoteUpdates[0]?.status).toBe(PushStatus.OK);
    expect(logOf(theirs)).toContain("== reference-transaction [committed]");
    expect(logOf(mine)).toBe(logOf(theirs));
    expect(hookLines(command.getHookOutput())).toBe(hookLines(native.stderr));
    expect(git(join(mine.dir, "dst"), ["for-each-ref"])).toBe(
      git(join(theirs.dir, "dst"), ["for-each-ref"]),
    );
    expect(git(join(mine.dir, "dst"), ["status", "--porcelain"])).toBe(
      git(join(theirs.dir, "dst"), ["status", "--porcelain"]),
    );
  });

  it("a refusal in prepared: receive-pack dies, no ref moves", async () => {
    const dir = join(root, "r");
    reftxBase(dir);
    const { native, error } = await expectReftxPush(
      dir,
      ["--atomic", "-f", "../bare.git", "main", "+other", ":gone"],
      (p) =>
        p
          .setRemote("../bare.git")
          .setAtomic(true)
          .setForce(true)
          .add("main")
          .add("+other")
          .add(":gone"),
      "refused atomic push",
      (t) => hookExit(t, "reference-transaction", 1),
    );
    expect(native.status).toBe(128);
    const fatal = /^fatal: .*abort.*$/m.exec(native.stderr)?.[0] ?? "";
    expect(fatal).not.toBe("");
    expect(String(error?.message)).toContain(fatal);
  });
});

/**
 * git 2.5x's configured hooks (`hook.<name>.*` of the receiving repository) on the receive
 * side: receive-pack runs pre-receive, update, post-receive, post-update, push-to-checkout
 * and reference-transaction through the hook API (only proc-receive through `find_hook`), so
 * each configured one runs before the hooks directory's script, with the same arguments,
 * stdin and variables, its output relayed alike. git 2.43 ignores them.
 */
describeGit("push hooks: configured hooks of the receiving repository (as native git)", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hooks-push-config-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /**
   * A configured hook's command: logs its name, arguments, `GIT_DIR`, directory and stdin to
   * `$HOOK_LOG`, says `hook cfg-<name> out` / `err`, then exits with `code`.
   */
  const logCommand = (name: string, code = 0) =>
    `f() { { printf '== cfg-${name}'; printf ' [%s]' "$@"; printf ' GIT_DIR=%s pwd=%s\\n' "$GIT_DIR" "$(pwd)"; input=$(cat); if [ -n "$input" ]; then printf 'stdin:\\n%s\\n' "$input"; fi; } >> "$HOOK_LOG"; echo hook cfg-${name} out; echo hook cfg-${name} err >&2; return ${code}; }; f`;

  function configure(dir: string, refuse?: string): void {
    const bare = join(dir, "bare.git");
    const events = [...RECEIVE_HOOKS, "reference-transaction"];
    for (const event of events) {
      const name = `c-${event}`;
      git(bare, ["config", `hook.${name}.event`, event]);
      git(bare, ["config", `hook.${name}.command`, logCommand(event, event === refuse ? 1 : 0)]);
    }
    // a disabled one runs nowhere
    git(bare, ["config", "hook.off.event", "pre-receive"]);
    git(bare, ["config", "hook.off.command", logCommand("off")]);
    git(bare, ["config", "hook.off.enabled", "false"]);
  }

  it("each configured receive hook runs before the script", async () => {
    const dir = join(root, "r");
    base(dir);
    configure(dir);
    await expectPush(
      dir,
      ["../bare.git", "main", "other"],
      (p) => p.setRemote("../bare.git").add("main").add("other"),
      "push",
    );
  });

  it("a refusing configured pre-receive or update declines the refs", async () => {
    for (const refuse of ["pre-receive", "update"]) {
      const dir = join(root, `r-${refuse}`);
      base(dir);
      configure(dir, refuse);
      await expectPush(
        dir,
        ["../bare.git", "main"],
        (p) => p.setRemote("../bare.git").add("main"),
        `${refuse} refused`,
      );
    }
  });

  it("a configured push-to-checkout runs in place of push-to-deploy", async () => {
    const dir = join(root, "r");
    base(dir);
    const dst = join(dir, "dst");
    mkdirSync(dst);
    git(dst, ["init", "-q", "-b", "main"]);
    putFile(dst, "d.txt", "d\n");
    git(dst, ["add", "-A"]);
    git(dst, ["commit", "-qm", "d"]);
    git(dst, ["config", "receive.denyCurrentBranch", "updateInstead"]);
    git(dst, ["config", "hook.deploy.event", "push-to-checkout"]);
    for (const refuse of [false, true]) {
      git(dst, ["config", "hook.deploy.command", logCommand("push-to-checkout", refuse ? 1 : 0)]);
      const [theirs, mine] = hookTwins(root, dir);
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
      if (nativeIs25x) expect(logOf(mine)).toContain("cfg-push-to-checkout");
      expect(result.remoteUpdates[0]?.status === PushStatus.OK, `refuse ${refuse}`).toBe(
        native.status === 0,
      );
      expect(git(join(mine.dir, "dst"), ["for-each-ref"])).toBe(
        git(join(theirs.dir, "dst"), ["for-each-ref"]),
      );
      expect(git(join(mine.dir, "dst"), ["status", "--porcelain"])).toBe(
        git(join(theirs.dir, "dst"), ["status", "--porcelain"]),
      );
    }
  });
});

/**
 * A broken `hook.<name>.*` configuration of the receiving repository (git 2.5x): receive-pack
 * dies on its first hook lookup (pre-receive), whatever event the broken hook names, so the
 * push fails with its fatal line and send-pack's "the remote end hung up unexpectedly", no
 * ref moved; git 2.43 ignores the configuration.
 */
describeGit("push hooks: a broken hook configuration of the receiving repository", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hooks-push-broken-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  async function pushTwins(dir: string, label: string) {
    const [theirs, mine] = hookTwins(root, dir);
    const native = gitRun(
      root,
      join(theirs.dir, "src"),
      ["push", "../bare.git", "main"],
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
    let error: Error | undefined;
    try {
      await ours.push().setRemote("../bare.git").add("main").call();
    } catch (e) {
      error = e as Error;
    }
    expect(logOf(mine), `${label}: log`).toBe(logOf(theirs));
    expect(error !== undefined, `${label}: failed (${String(error)} / ${native.stderr})`).toBe(
      native.status !== 0,
    );
    expect(git(join(mine.dir, "bare.git"), ["for-each-ref"]), `${label}: refs`).toBe(
      git(join(theirs.dir, "bare.git"), ["for-each-ref"]),
    );
    return { native, error };
  }

  for (const event of ["pre-receive", "post-receive"]) {
    it(`hook.x.event=${event} without a command: receive-pack dies`, async () => {
      const dir = join(root, "r");
      base(dir);
      git(join(dir, "bare.git"), ["config", "hook.x.event", event]);
      const { native, error } = await pushTwins(dir, event);
      if (!nativeIs25x) return;
      expect(native.status).toBe(128);
      const fatal =
        "fatal: 'hook.x.command' must be configured or 'hook.x.event' must be removed; aborting.";
      expect(native.stderr).toContain(fatal);
      expect(native.stderr).toContain("fatal: the remote end hung up unexpectedly");
      expect(error).toBeInstanceOf(TransportError);
      expect(String(error?.message)).toContain(fatal);
      expect(String(error?.message)).toContain("fatal: the remote end hung up unexpectedly");
    });
  }
});

/**
 * The receiving repository's config reaches its hooks through its include directives: a
 * configured pre-receive (git 2.5x) defined in `include.path=../inc`, beside the bare
 * repository.
 */
describeGit(
  "push hooks: configured hooks from an included file of the receiving repository",
  () => {
    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), "hooks-push-include-"));
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    it("include.path=../inc: its configured pre-receive runs", async () => {
      const dir = join(root, "r");
      base(dir);
      writeFileSync(
        join(dir, "inc"),
        '[hook "inc"]\n\tevent = pre-receive\n\tcommand = "echo == inc-pre-receive >> \\"$HOOK_LOG\\"; echo hook inc out"\n',
      );
      git(join(dir, "bare.git"), ["config", "include.path", "../inc"]);
      await expectPush(
        dir,
        ["../bare.git", "main"],
        (p) => p.setRemote("../bare.git").add("main"),
        "include",
      );
      if (nativeIs25x) {
        const [theirs] = hookTwins(root, dir);
        gitRun(root, join(theirs.dir, "src"), ["push", "../bare.git", "main"], theirs.env);
        expect(logOf(theirs)).toContain("== inc-pre-receive");
      }
    });
  },
);
