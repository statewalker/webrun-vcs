/**
 * Push options against native git: `-o` / `--push-option`, `push.pushOption` (in config
 * order, an empty value clearing the list, the command line's options replacing them, a
 * value-less one fatal), and the server's `receive.advertisePushOptions` (off by default: a
 * push with options to such a server dies before anything is sent). The receiving
 * repository's pre-receive and post-receive hooks log `GIT_PUSH_OPTION_COUNT` and
 * `GIT_PUSH_OPTION_<n>`. The scenarios are t5545-push-options.sh's, each run as one sequence
 * of steps on two identical directories: native `git push` in one, ours in the other (see
 * `push-modes-native-support.ts`), comparing the exit status, stderr, the refs of both
 * repositories and the hook logs.
 */
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { installHooks } from "./hooks-native-support.js";
import { nativeGitAvailable, noMaintenance } from "./native-git-http-backend.js";
import {
  both,
  pushBoth,
  RECEIVE_HOOKS,
  type Twins,
  testCommit,
  twins,
} from "./push-modes-native-support.js";
import { gitOut } from "./status-native-support.js";
import { CLEANUP_TIMEOUT, removeTempDir } from "./temp-dir-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root: string;

/**
 * t5545's mk_repo_pair: `upstream` (denyCurrentBranch warn, the logging receive hooks,
 * `receive.advertisePushOptions` as given) and `workbench` with remote `up`; then
 * `test_commit one`, `git push --mirror up` (compared too) and `test_commit two`.
 */
async function mkRepoPair(advertise: string | undefined): Promise<Twins> {
  const t = twins(root, (dir) => {
    gitOut(root, dir, ["init", "-q", "-b", "main", "upstream"]);
    const upstream = join(dir, "upstream");
    noMaintenance(upstream);
    gitOut(root, upstream, ["config", "receive.denyCurrentBranch", "warn"]);
    if (advertise !== undefined) {
      gitOut(root, upstream, ["config", "receive.advertisePushOptions", advertise]);
    }
    installHooks(join(upstream, ".git/hooks"), RECEIVE_HOOKS);
    gitOut(root, dir, ["init", "-q", "-b", "main", "workbench"]);
    gitOut(root, join(dir, "workbench"), ["remote", "add", "up", "../upstream"]);
  });
  testCommit(t, "workbench", "one");
  await push(t, "push", "--mirror", "up");
  testCommit(t, "workbench", "two");
  return t;
}

const push = (t: Twins, ...argv: string[]) => pushBoth(t, "workbench", argv, ["upstream"]);

describeGit("push options (t5545-push-options.sh)", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "push-options-"));
  });
  afterAll(async () => {
    await removeTempDir(root);
  }, CLEANUP_TIMEOUT);

  // t5545-push-options.sh: "one push option works for a single branch"
  it("one push option reaches pre-receive and post-receive", async () => {
    const t = await mkRepoPair("true");
    await push(t, "push", "--push-option=asdf", "up", "main");
    const log = readFileSync(`${t.n}.hooklog`, "latin1");
    expect(log).toContain("== pre-receive\nGIT_DIR=.\nGIT_PUSH_OPTION_COUNT=1\n");
    expect(log).toContain("GIT_PUSH_OPTION_0=asdf\n");
    expect(log.match(/GIT_PUSH_OPTION_0=asdf/g)).toHaveLength(2);
  });

  // t5545-push-options.sh: "push option denied by remote"
  it("a server that does not advertise them refuses the push", async () => {
    const t = await mkRepoPair("false");
    await push(t, "push", "--push-option=asdf", "up", "main");
    // ... by default too (receive.advertisePushOptions unset), short form
    const u = await mkRepoPair(undefined);
    await push(u, "push", "-o", "asdf", "up", "main");
    // ... while a push without options goes through, the hooks told none
    await push(u, "push", "up", "main");
  });

  // t5545-push-options.sh: "two push options work"
  it("two push options, in order", async () => {
    const t = await mkRepoPair("true");
    await push(t, "push", "--push-option=asdf", "--push-option=more structured text", "up", "main");
  });

  it("push.pushOption: one, two, overridden by -o, cleared by an empty value", async () => {
    const t = await mkRepoPair("true");
    // t5545-push-options.sh: "default push option"
    await push(t, "-c", "push.pushOption=default", "push", "up", "main");
    // t5545-push-options.sh: "two default push options"
    testCommit(t, "workbench", "three");
    await push(
      t,
      "-c",
      "push.pushOption=default1",
      "-c",
      "push.pushOption=default2",
      "push",
      "up",
      "main",
    );
    // t5545-push-options.sh: "push option from command line overrides from-config push option"
    testCommit(t, "workbench", "four");
    await push(t, "-c", "push.pushOption=default", "push", "--push-option=manual", "up", "main");
    // t5545-push-options.sh: "empty value of push.pushOption in config clears the list"
    testCommit(t, "workbench", "five");
    await push(
      t,
      ...[
        "-c",
        "push.pushOption=default1",
        "-c",
        "push.pushOption=",
        "-c",
        "push.pushOption=default2",
      ],
      ...["push", "up", "main"],
    );
    // the repository's own config, then the command line's after it
    both(t, "workbench", "config", "--add", "push.pushOption", "file1");
    both(t, "workbench", "config", "--add", "push.pushOption", "file2");
    testCommit(t, "workbench", "six");
    await push(t, "-c", "push.pushOption=cmd", "push", "up", "main");
    testCommit(t, "workbench", "seven");
    await push(t, "-c", "push.pushOption=", "push", "up", "main");
  });

  it("refusals: a value-less push.pushOption, a new line in an option", async () => {
    const t = await mkRepoPair("true");
    // t5545-push-options.sh: "invalid push option in config"
    await push(t, "-c", "push.pushOption", "push", "up", "main");
    // ... in the repository's config (git names the file and line)
    for (const d of [t.n, t.o])
      appendFileSync(join(d, "workbench/.git/config"), "[push]\n\tpushOption\n");
    await push(t, "push", "up", "main");
    await push(t, "push", "-o", "given", "up", "main");
    for (const d of [t.n, t.o])
      gitOut(root, join(d, "workbench"), ["config", "--unset-all", "push.pushOption"]);
    // builtin/push.c: "push options must not have new line characters"
    await push(t, "push", "-o", "two\nlines", "up", "main");
    // --atomic with an option
    await push(t, "push", "--atomic", "-o", "x", "up", "main");
  });

  // t5545-push-options.sh: "push options keep quoted characters intact (direct)"
  it("options keep quoted characters intact", async () => {
    const t = await mkRepoPair("true");
    await push(t, "push", '--push-option="embedded quotes"', "up", "main");
  });

  it("options with --mirror and --delete", async () => {
    const t = await mkRepoPair("true");
    both(t, "workbench", "branch", "topic");
    await push(t, "push", "-o", "m", "--mirror", "up");
    await push(t, "push", "-o", "d", "--delete", "up", "topic");
  });
});
