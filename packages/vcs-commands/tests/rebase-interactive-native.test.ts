/**
 * Interactive rebase against native git: the todo list as the sequence editor sees it, an
 * edited list run (`edit`, `reword`, `squash`, `fixup [-C|-c]`, `drop`, `exec`, `break`,
 * `update-ref`), the stops (state files, messages), `--continue` and `--skip` after them,
 * picks that become empty (`--empty`), `--autosquash`, `--exec`, `--update-refs`,
 * rebase.abbreviateCommands and rebase.missingCommitsCheck. Native twins: each history built
 * twice (pinned identities and dates), native git rebased with a sequence editor that
 * writes the list given and a message editor that writes the message given, ours with the
 * interactive handler doing the same; snapshots, refs, reflogs and histories compared.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type RebaseCommand,
  type RebaseEmptyMode,
  RebaseOperation,
  type RebaseResult,
  RebaseStatus,
} from "../src/index.js";
import {
  gitOk,
  INTEROP_AUTHOR_ENV,
  INTEROP_IDENT,
  normalizeState,
  openOurs,
  put,
  snapshot,
} from "./merge-native-helpers.js";
import { buildGraph, type GraphStep } from "./merge-native-scenarios.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root: string;
let counter = 0;

/** git 2.5x: the todo lines with `# ` before the subject, as ours writes them. */
function modern(): boolean {
  const version = gitOk(root, root, "--version").match(/(\d+)\.(\d+)/);
  return !!version && (Number(version[1]) > 2 || Number(version[2]) >= 50);
}

/** normalizeState, and 2.43's message without the `# ` subjects of 2.5x. */
function normalize(name: string, text: string): string {
  if (name === "rebase-merge/message") return normalizeState(name, text).replace(/\n\n$/, "\n");
  return normalizeState(name, text);
}

/** topic: one (b), two (c), three (b again); main moved on (m). */
const linear: GraphStep[] = [
  { branch: "topic", from: "main", files: { "b.txt": "1\n" }, message: "one" },
  { branch: "topic", files: { "c.txt": "2\n" }, message: "two\n\nthe body" },
  { branch: "topic", files: { "b.txt": "1\n3\n" }, message: "three" },
  { branch: "main", files: { "m.txt": "m\n" }, message: "main moved" },
];

/** Both twins of a history, topic checked out. */
function twins(steps: GraphStep[], config: Record<string, string> = {}) {
  const n = counter++;
  const native = join(root, `native-${n}`);
  const ours = join(root, `ours-${n}`);
  for (const dir of [native, ours]) {
    buildGraph(root, dir, { base: { "a.txt": "base\n" }, steps, checkout: "topic", config });
  }
  return { native, ours };
}

/** The abbreviated id of a commit of the twin. */
const short = (dir: string, rev: string) => gitOk(root, dir, "rev-parse", "--short", rev).trim();

interface NativeRun {
  status: number;
  stdout: string;
  stderr: string;
  /** What the sequence editor was given */
  seen: string;
}

/** Native git with the editors: the list `todo` (else kept), the message `message` (else kept). */
function nativeGit(
  dir: string,
  args: string[],
  options: { todo?: string; message?: string; env?: Record<string, string> } = {},
): NativeRun {
  const seen = join(root, `seen-${counter++}`);
  const env: Record<string, string> = {
    ...nativeGitEnv(root),
    GIT_SEQUENCE_EDITOR: join(root, "seq-editor.sh"),
    GIT_EDITOR: join(root, "msg-editor.sh"),
    SEEN_TODO: seen,
  };
  if (options.todo !== undefined) {
    const file = join(root, `todo-${counter++}`);
    writeFileSync(file, options.todo);
    env.NEW_TODO = file;
  }
  if (options.message !== undefined) {
    const file = join(root, `msg-${counter++}`);
    writeFileSync(file, options.message);
    env.NEW_MSG = file;
  }
  Object.assign(env, options.env);
  const r = spawnSync("git", args, { cwd: dir, env, encoding: "utf8" });
  let seenText = "";
  try {
    seenText = readFileSync(seen, "utf8");
  } catch {
    // no editor run
  }
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "", seen: seenText };
}

/** An exec handler running the command with the shell in the twin, as git does. */
function shellExec(dir: string) {
  return (command: string) => {
    const r = spawnSync("sh", ["-c", command], {
      cwd: dir,
      env: nativeGitEnv(root),
      encoding: "utf8",
    });
    return { exitCode: r.status ?? 1 };
  };
}

interface OursOptions {
  todo?: string;
  message?: string;
  interactive?: boolean;
  configure?: (command: RebaseCommand) => void;
}

/** Our rebase of the twin: the handler plays the editors; what the sequence editor got. */
async function ours(
  dir: string,
  operation: RebaseOperation = RebaseOperation.BEGIN,
  options: OursOptions = {},
): Promise<{ result: RebaseResult; seen: string }> {
  const command = (await openOurs(dir, INTEROP_AUTHOR_ENV)).rebase().setCommitter(INTEROP_IDENT);
  let seen = "";
  if (options.interactive !== false) {
    command.runInteractively({
      editTodo: (text) => {
        seen = text;
        return options.todo ?? text;
      },
      modifyCommitMessage: (text) => options.message ?? text,
    });
  }
  command.setExecHandler(shellExec(dir));
  options.configure?.(command);
  if (operation !== RebaseOperation.BEGIN) {
    return { result: await command.setOperation(operation).call(), seen };
  }
  await command.setUpstreamBranch("main");
  return { result: await command.call(), seen };
}

const refs = (dir: string) => gitOk(root, dir, "for-each-ref", "--format=%(refname) %(objectname)");
const reflog = (dir: string) => gitOk(root, dir, "reflog", "--format=%H %gs", "HEAD");
const history = (dir: string) => gitOk(root, dir, "log", "--format=%H %P %an %s%n%b", "HEAD");

function expectSame(native: string, mine: string, label: string) {
  expect(snapshot(root, mine, normalize), label).toEqual(snapshot(root, native, normalize));
  expect(refs(mine), `${label}: refs`).toBe(refs(native));
  // git 2.43 logs a recreated merge with the action of the line before (a static buffer
  // reused), 2.5x as `rebase (merge): <subject>`
  const even = (text: string) =>
    modern() ? text : text.replace(/ rebase( \(\w+\))?: Merge /g, " rebase: Merge ");
  expect(even(reflog(mine)), `${label}: reflog`).toBe(even(reflog(native)));
  expect(history(mine), `${label}: history`).toBe(history(native));
}

/** Our stop message's lines are among native git's stderr lines (2.5x: same todo format). */
function expectMessage(result: RebaseResult, run: NativeRun) {
  if (!modern()) return;
  const lines = run.stderr.split(/[\r\n]+/).map((l) => l.replace(/^.*Rebasing \(\d+\/\d+\)/, ""));
  for (const line of (result.message ?? "").split("\n")) {
    if (line.trim() === "") continue;
    expect(lines, `${line}\n--- native stderr:\n${run.stderr}`).toContain(line);
  }
}

describeGit("interactive rebase, native twins", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "rebase-interactive-"));
    writeFileSync(
      join(root, "seq-editor.sh"),
      '#!/bin/sh\ncp "$1" "$SEEN_TODO"\nif [ -n "$NEW_TODO" ]; then cp "$NEW_TODO" "$1"; fi\nexit 0\n',
    );
    writeFileSync(
      join(root, "msg-editor.sh"),
      '#!/bin/sh\nif [ -n "$NEW_MSG" ]; then cp "$NEW_MSG" "$1"; fi\nexit 0\n',
    );
    chmodSync(join(root, "seq-editor.sh"), 0o755);
    chmodSync(join(root, "msg-editor.sh"), 0o755);
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("the list the sequence editor gets, unchanged: the same history", async () => {
    const { native, ours: mine } = twins(linear);
    const run = nativeGit(native, ["rebase", "-i", "main"]);
    expect(run.status, run.stderr).toBe(0);
    const { result, seen } = await ours(mine);
    expect(result.status, result.message).toBe(RebaseStatus.OK);
    if (modern()) expect(seen).toBe(run.seen);
    expectSame(native, mine, "done");
  });

  it("edit: the stop as git's, an amend, then --continue", async () => {
    const { native, ours: mine } = twins(linear);
    const todo = `pick ${short(native, "topic~2")} one\nedit ${short(native, "topic~1")} two\npick ${short(native, "topic")} three\n`;
    const run = nativeGit(native, ["rebase", "-i", "main"], { todo });
    expect(run.status, run.stderr).toBe(0);
    const { result } = await ours(mine, RebaseOperation.BEGIN, { todo });
    expect(result.status, result.message).toBe(RebaseStatus.EDIT);
    expectMessage(result, run);
    expectSame(native, mine, "stopped");
    for (const dir of [native, mine]) {
      put(dir, "c.txt", "2 amended\n");
      gitOk(root, dir, "commit", "-q", "-a", "--amend", "--no-edit");
    }
    expect(nativeGit(native, ["rebase", "--continue"]).status).toBe(0);
    const continued = await ours(mine, RebaseOperation.CONTINUE);
    expect(continued.result.status, continued.result.message).toBe(RebaseStatus.OK);
    expectSame(native, mine, "continued");
  });

  it("edit: changes staged, not committed, amend the commit on --continue", async () => {
    const { native, ours: mine } = twins(linear);
    const todo = `edit ${short(native, "topic~2")} one\npick ${short(native, "topic~1")} two\npick ${short(native, "topic")} three\n`;
    expect(nativeGit(native, ["rebase", "-i", "main"], { todo }).status).toBe(0);
    expect((await ours(mine, RebaseOperation.BEGIN, { todo })).result.status).toBe(
      RebaseStatus.EDIT,
    );
    expectSame(native, mine, "stopped");
    for (const dir of [native, mine]) {
      put(dir, "e.txt", "edited\n");
      gitOk(root, dir, "add", "e.txt");
    }
    expect(nativeGit(native, ["rebase", "--continue"]).status).toBe(0);
    expect((await ours(mine, RebaseOperation.CONTINUE)).result.status).toBe(RebaseStatus.OK);
    expectSame(native, mine, "continued");
  });

  it("edit of a commit kept in place (fast-forward), then --continue untouched", async () => {
    const steps = linear.slice(0, 3);
    const { native, ours: mine } = twins(steps);
    const todo = `pick ${short(native, "topic~2")} one\nedit ${short(native, "topic~1")} two\npick ${short(native, "topic")} three\n`;
    const run = nativeGit(native, ["rebase", "-i", "main"], { todo });
    const { result } = await ours(mine, RebaseOperation.BEGIN, { todo });
    expect(result.status, result.message).toBe(RebaseStatus.EDIT);
    expectMessage(result, run);
    expectSame(native, mine, "stopped");
    expect(nativeGit(native, ["rebase", "--continue"]).status).toBe(0);
    expect((await ours(mine, RebaseOperation.CONTINUE)).result.status).toBe(RebaseStatus.OK);
    expectSame(native, mine, "continued");
  });

  it("reword: the message editor's message, amended after the pick", async () => {
    const { native, ours: mine } = twins(linear);
    const todo = `pick ${short(native, "topic~2")} one\nreword ${short(native, "topic~1")} two\npick ${short(native, "topic")} three\n`;
    const message = "two, reworded\n\n# a comment line\nnew body\n";
    expect(nativeGit(native, ["rebase", "-i", "main"], { todo, message }).status).toBe(0);
    const { result } = await ours(mine, RebaseOperation.BEGIN, { todo, message });
    expect(result.status, result.message).toBe(RebaseStatus.OK);
    expectSame(native, mine, "done");
  });

  for (const [label, commands] of [
    ["fixup, squash", ["pick", "fixup", "squash"]],
    ["squash, fixup", ["pick", "squash", "fixup"]],
    ["fixup, fixup", ["pick", "fixup", "fixup"]],
    ["fixup -C, fixup", ["pick", "fixup -C", "fixup"]],
    ["fixup, fixup -C", ["pick", "fixup", "fixup -C"]],
    ["fixup -c", ["pick", "fixup -c", "pick"]],
    ["squash, fixup -C", ["pick", "squash", "fixup -C"]],
  ] as const) {
    it(`a chain of ${label}: the messages as git assembles them`, async () => {
      const { native, ours: mine } = twins(linear);
      const revs = ["topic~2", "topic~1", "topic"];
      const todo = commands.map((c, k) => `${c} ${short(native, revs[k] as string)}\n`).join("");
      const run = nativeGit(native, ["rebase", "-i", "main"], { todo });
      expect(run.status, run.stderr).toBe(0);
      const { result } = await ours(mine, RebaseOperation.BEGIN, { todo });
      expect(result.status, result.message).toBe(RebaseStatus.OK);
      expectSame(native, mine, "done");
    });
  }

  it("a squash whose message is edited", async () => {
    const { native, ours: mine } = twins(linear);
    const todo = `pick ${short(native, "topic~2")}\nsquash ${short(native, "topic~1")}\npick ${short(native, "topic")}\n`;
    const message = "one and two\n";
    expect(nativeGit(native, ["rebase", "-i", "main"], { todo, message }).status).toBe(0);
    expect((await ours(mine, RebaseOperation.BEGIN, { todo, message })).result.status).toBe(
      RebaseStatus.OK,
    );
    expectSame(native, mine, "done");
  });

  it("a fixup that conflicts: the stop, then --continue amends", async () => {
    const steps: GraphStep[] = [
      { branch: "topic", from: "main", files: { "b.txt": "1\n" }, message: "one" },
      { branch: "topic", files: { "a.txt": "topic\n" }, message: "two" },
      { branch: "topic", files: { "c.txt": "3\n" }, message: "three" },
      { branch: "main", files: { "a.txt": "main\n" }, message: "main moved" },
    ];
    const { native, ours: mine } = twins(steps);
    const todo = `pick ${short(native, "topic~2")}\nfixup ${short(native, "topic~1")}\nfixup ${short(native, "topic")}\n`;
    const run = nativeGit(native, ["rebase", "-i", "main"], { todo });
    expect(run.status).toBe(1);
    const { result } = await ours(mine, RebaseOperation.BEGIN, { todo });
    expect(result.status, result.message).toBe(RebaseStatus.STOPPED);
    expectMessage(result, run);
    expectSame(native, mine, "stopped");
    for (const dir of [native, mine]) {
      put(dir, "a.txt", "resolved\n");
      gitOk(root, dir, "add", "a.txt");
    }
    expect(nativeGit(native, ["rebase", "--continue"]).status).toBe(0);
    const continued = await ours(mine, RebaseOperation.CONTINUE);
    expect(continued.result.status, continued.result.message).toBe(RebaseStatus.OK);
    expectSame(native, mine, "continued");
  });

  it("a fixup that conflicts, skipped: the chain goes on without it", async () => {
    const steps: GraphStep[] = [
      { branch: "topic", from: "main", files: { "b.txt": "1\n" }, message: "one" },
      { branch: "topic", files: { "c.txt": "2\n" }, message: "two" },
      { branch: "topic", files: { "a.txt": "topic\n" }, message: "three" },
      { branch: "main", files: { "a.txt": "main\n" }, message: "main moved" },
    ];
    const { native, ours: mine } = twins(steps);
    const todo = `pick ${short(native, "topic~2")}\nsquash ${short(native, "topic~1")}\nfixup ${short(native, "topic")}\n`;
    expect(nativeGit(native, ["rebase", "-i", "main"], { todo }).status).toBe(1);
    expect((await ours(mine, RebaseOperation.BEGIN, { todo })).result.status).toBe(
      RebaseStatus.STOPPED,
    );
    expectSame(native, mine, "stopped");
    expect(nativeGit(native, ["rebase", "--skip"]).status).toBe(0);
    const skipped = await ours(mine, RebaseOperation.SKIP);
    expect(skipped.result.status, skipped.result.message).toBe(RebaseStatus.OK);
    expectSame(native, mine, "skipped");
  });

  it("drop and a removed line, rebase.missingCommitsCheck=warn", async () => {
    const { native, ours: mine } = twins(linear, { "rebase.missingCommitsCheck": "warn" });
    const todo = `pick ${short(native, "topic~2")} one\ndrop ${short(native, "topic~1")} two\n`;
    const run = nativeGit(native, ["rebase", "-i", "main"], { todo });
    expect(run.status, run.stderr).toBe(0);
    const { result, seen } = await ours(mine, RebaseOperation.BEGIN, { todo });
    expect(result.status, result.message).toBe(RebaseStatus.OK);
    if (modern()) {
      expect(seen).toBe(run.seen);
      for (const line of result.output ?? []) {
        if (line.startsWith(" - ") || line.startsWith("Warning"))
          expect(run.stderr).toContain(line);
      }
    }
    expectSame(native, mine, "done");
  });

  it("rebase.missingCommitsCheck=error: refused, the list fixed by --edit-todo", async () => {
    const { native, ours: mine } = twins(linear, { "rebase.missingCommitsCheck": "error" });
    const todo = `pick ${short(native, "topic~2")} one\npick ${short(native, "topic")} three\n`;
    const run = nativeGit(native, ["rebase", "-i", "main"], { todo });
    expect(run.status).toBe(1);
    const { result, seen } = await ours(mine, RebaseOperation.BEGIN, { todo });
    expect(result.status).toBe(RebaseStatus.FAILED);
    if (modern()) expect(seen).toBe(run.seen);
    expectMessage(result, run);
    expectSame(native, mine, "refused");
    const fixed = `pick ${short(native, "topic~2")} one\ndrop ${short(native, "topic~1")} two\npick ${short(native, "topic")} three\n`;
    expect(nativeGit(native, ["rebase", "--edit-todo"], { todo: fixed }).status).toBe(0);
    const edited = await ours(mine, RebaseOperation.EDIT_TODO, { todo: fixed });
    expect(edited.result.status, edited.result.message).toBe(RebaseStatus.OK);
    expectSame(native, mine, "edited");
    expect(nativeGit(native, ["rebase", "--continue"]).status).toBe(0);
    expect((await ours(mine, RebaseOperation.CONTINUE)).result.status).toBe(RebaseStatus.OK);
    expectSame(native, mine, "continued");
  });

  it("rebase.abbreviateCommands: the lists written with the letters", async () => {
    const { native, ours: mine } = twins(linear, { "rebase.abbreviateCommands": "true" });
    const todo = `p ${short(native, "topic~2")} one\ne ${short(native, "topic~1")} two\np ${short(native, "topic")} three\n`;
    const run = nativeGit(native, ["rebase", "-i", "main"], { todo });
    const { result, seen } = await ours(mine, RebaseOperation.BEGIN, { todo });
    expect(result.status, result.message).toBe(RebaseStatus.EDIT);
    if (modern()) expect(seen).toBe(run.seen);
    expectSame(native, mine, "stopped");
  });

  it("an invalid list: the errors, HEAD at upstream, then --edit-todo and --continue", async () => {
    const { native, ours: mine } = twins(linear);
    const todo = `pick ${short(native, "topic~2")} one\nfrobnicate x\npick 0000000 nothing\n`;
    const run = nativeGit(native, ["rebase", "-i", "main"], { todo });
    expect(run.status).toBe(1);
    const { result } = await ours(mine, RebaseOperation.BEGIN, { todo });
    expect(result.status).toBe(RebaseStatus.FAILED);
    expectMessage(result, run);
    expectSame(native, mine, "refused");
    const fixed = `pick ${short(native, "topic~2")} one\npick ${short(native, "topic")} three\n`;
    expect(nativeGit(native, ["rebase", "--edit-todo"], { todo: fixed }).status).toBe(0);
    expect((await ours(mine, RebaseOperation.EDIT_TODO, { todo: fixed })).result.status).toBe(
      RebaseStatus.OK,
    );
    expectSame(native, mine, "edited");
    expect(nativeGit(native, ["rebase", "--continue"]).status).toBe(0);
    expect((await ours(mine, RebaseOperation.CONTINUE)).result.status).toBe(RebaseStatus.OK);
    expectSame(native, mine, "continued");
  });

  /** topic's two makes a change main already has in another way: it becomes empty. */
  const becomesEmpty: GraphStep[] = [
    { branch: "topic", from: "main", files: { "b.txt": "1\n" }, message: "one" },
    { branch: "topic", files: { "m.txt": "m\n", "x.txt": "x\n" }, message: "two" },
    { branch: "topic", files: { "c.txt": "3\n" }, message: "three" },
    { branch: "main", files: { "m.txt": "m\n" }, message: "main moved" },
    { branch: "main", files: { "x.txt": "x\n" }, message: "main again" },
  ];

  it("a pick that becomes empty stops an interactive rebase; --continue drops it", async () => {
    const { native, ours: mine } = twins(becomesEmpty);
    const run = nativeGit(native, ["rebase", "-i", "--reapply-cherry-picks", "main"]);
    expect(run.status).toBe(1);
    const { result } = await ours(mine, RebaseOperation.BEGIN, {
      configure: (c) => c.setReapplyCherryPicks(true),
    });
    expect(result.status, result.message).toBe(RebaseStatus.STOPPED);
    expectMessage(result, run);
    expectSame(native, mine, "stopped");
    expect(nativeGit(native, ["rebase", "--continue"]).status).toBe(0);
    const continued = await ours(mine, RebaseOperation.CONTINUE);
    expect(continued.result.status, continued.result.message).toBe(RebaseStatus.OK);
    expectSame(native, mine, "continued");
  });

  for (const mode of ["keep", "drop", "stop"] as RebaseEmptyMode[]) {
    it(`--empty=${mode} without -i`, async () => {
      // git 2.43 knows `ask`, not `stop`
      if (mode === "stop" && !modern()) return;
      const { native, ours: mine } = twins(becomesEmpty);
      const run = nativeGit(native, [
        "rebase",
        `--empty=${mode}`,
        "--reapply-cherry-picks",
        "main",
      ]);
      const { result } = await ours(mine, RebaseOperation.BEGIN, {
        interactive: false,
        configure: (c) => c.setReapplyCherryPicks(true).setEmpty(mode),
      });
      expect(result.status === RebaseStatus.OK, result.message).toBe(run.status === 0);
      expectSame(native, mine, "after");
    });
  }

  it("--no-keep-empty leaves out a commit empty from the start; --keep-empty keeps it", async () => {
    const steps: GraphStep[] = [
      { branch: "topic", from: "main", files: { "b.txt": "1\n" }, message: "one" },
      { branch: "topic", files: {}, message: "empty" },
      { branch: "topic", files: { "c.txt": "3\n" }, message: "three" },
      { branch: "main", files: { "m.txt": "m\n" }, message: "main moved" },
    ];
    for (const keep of [false, true]) {
      const { native, ours: mine } = twins(steps);
      const run = nativeGit(native, [
        "rebase",
        "-i",
        keep ? "--keep-empty" : "--no-keep-empty",
        "main",
      ]);
      expect(run.status, run.stderr).toBe(0);
      const { result, seen } = await ours(mine, RebaseOperation.BEGIN, {
        configure: (c) => c.setKeepEmpty(keep),
      });
      expect(result.status, result.message).toBe(RebaseStatus.OK);
      if (modern()) expect(seen).toBe(run.seen);
      expectSame(native, mine, `keep ${keep}`);
    }
  });

  it("--exec after each pick (and the fixup chain), keep for empty picks", async () => {
    const { native, ours: mine } = twins(linear);
    const run = nativeGit(native, ["rebase", "-x", "echo run >> ../exec-log-native", "main"]);
    expect(run.status, run.stderr).toBe(0);
    const { result } = await ours(mine, RebaseOperation.BEGIN, {
      interactive: false,
      configure: (c) => c.setExec(["echo run >> ../exec-log-ours"]),
    });
    expect(result.status, result.message).toBe(RebaseStatus.OK);
    expect(readFileSync(join(root, "exec-log-ours"), "utf8")).toBe(
      readFileSync(join(root, "exec-log-native"), "utf8"),
    );
    expectSame(native, mine, "done");
  });

  it("an exec that fails stops; --continue goes on after it", async () => {
    const { native, ours: mine } = twins(linear);
    const todo = `pick ${short(native, "topic~2")} one\nexec false\npick ${short(native, "topic~1")} two\nbreak\npick ${short(native, "topic")} three\n`;
    const run = nativeGit(native, ["rebase", "-i", "main"], { todo });
    expect(run.status).toBe(1);
    const { result } = await ours(mine, RebaseOperation.BEGIN, { todo });
    expect(result.status).toBe(RebaseStatus.STOPPED);
    expectMessage(result, run);
    expectSame(native, mine, "exec failed");
    const run2 = nativeGit(native, ["rebase", "--continue"]);
    expect(run2.status).toBe(0);
    const brk = await ours(mine, RebaseOperation.CONTINUE);
    expect(brk.result.status, brk.result.message).toBe(RebaseStatus.STOPPED);
    expectMessage(brk.result, run2);
    expectSame(native, mine, "break");
    expect(nativeGit(native, ["rebase", "--continue"]).status).toBe(0);
    expect((await ours(mine, RebaseOperation.CONTINUE)).result.status).toBe(RebaseStatus.OK);
    expectSame(native, mine, "continued");
  });

  it("--reschedule-failed-exec: the failed exec back in the list; changes it left refused", async () => {
    const { native, ours: mine } = twins(linear);
    const todo = `pick ${short(native, "topic~2")} one\nexec echo dirty > b.txt\npick ${short(native, "topic")} three\n`;
    const run = nativeGit(native, ["rebase", "-i", "--reschedule-failed-exec", "main"], { todo });
    expect(run.status).toBe(1);
    const { result } = await ours(mine, RebaseOperation.BEGIN, {
      todo,
      configure: (c) => c.setRescheduleFailedExec(true),
    });
    expect(result.status).toBe(RebaseStatus.STOPPED);
    expectMessage(result, run);
    expectSame(native, mine, "rescheduled");
  });

  it("--autosquash: fixup!, amend! and squash! moved after their commits", async () => {
    const steps: GraphStep[] = [
      { branch: "topic", from: "main", files: { "b.txt": "1\n" }, message: "one" },
      { branch: "topic", files: { "c.txt": "2\n" }, message: "two" },
      { branch: "topic", files: { "b.txt": "1b\n" }, message: "fixup! one" },
      { branch: "topic", files: { "c.txt": "2b\n" }, message: "amend! two\n\ntwo, amended" },
      { branch: "topic", files: { "d.txt": "d\n" }, message: "squash! fixup! one" },
      { branch: "main", files: { "m.txt": "m\n" }, message: "main moved" },
    ];
    for (const interactive of [true, false]) {
      // git 2.43 autosquashes an interactive rebase only
      if (!interactive && !modern()) continue;
      const { native, ours: mine } = twins(steps);
      const run = nativeGit(native, [
        "rebase",
        ...(interactive ? ["-i"] : []),
        "--autosquash",
        "main",
      ]);
      expect(run.status, run.stderr).toBe(0);
      const { result, seen } = await ours(mine, RebaseOperation.BEGIN, {
        interactive,
        configure: (c) => c.setAutosquash(true),
      });
      expect(result.status, result.message).toBe(RebaseStatus.OK);
      if (modern() && interactive) expect(seen).toBe(run.seen);
      expectSame(native, mine, `interactive ${interactive}`);
    }
  });

  it("rebase.autoSquash applies to an interactive rebase only", async () => {
    const steps: GraphStep[] = [
      { branch: "topic", from: "main", files: { "b.txt": "1\n" }, message: "one" },
      { branch: "topic", files: { "c.txt": "2\n" }, message: "two" },
      { branch: "topic", files: { "b.txt": "1b\n" }, message: "fixup! one" },
      { branch: "main", files: { "m.txt": "m\n" }, message: "main moved" },
    ];
    for (const interactive of [true, false]) {
      const { native, ours: mine } = twins(steps, { "rebase.autoSquash": "true" });
      nativeGit(native, ["rebase", ...(interactive ? ["-i"] : []), "main"]);
      await ours(mine, RebaseOperation.BEGIN, { interactive });
      expectSame(native, mine, `interactive ${interactive}`);
    }
  });

  it("--update-refs: the branches on rebased commits moved at the end", async () => {
    const { native, ours: mine } = twins(linear);
    for (const dir of [native, mine]) {
      gitOk(root, dir, "branch", "part1", "topic~2");
      gitOk(root, dir, "branch", "part2", "topic~1");
      gitOk(root, dir, "branch", "part3", "topic~1");
    }
    const first = nativeGit(native, ["rebase", "-i", "--update-refs", "main"]);
    expect(first.status, first.stderr).toBe(0);
    const { result, seen } = await ours(mine, RebaseOperation.BEGIN, {
      configure: (c) => c.setUpdateRefs(true),
    });
    expect(result.status, result.message).toBe(RebaseStatus.OK);
    if (modern()) expect(seen).toBe(first.seen);
    expectSame(native, mine, "done");
    for (const line of (result.output ?? []).filter((l) => l.includes("refs/heads/part"))) {
      expect(first.stderr).toContain(line);
    }
  });

  it("--update-refs with a stop: the update-refs state file", async () => {
    const { native, ours: mine } = twins(linear);
    for (const dir of [native, mine]) gitOk(root, dir, "branch", "part", "topic~1");
    const todo = `pick ${short(native, "topic~2")} one\npick ${short(native, "topic~1")} two\nupdate-ref refs/heads/part\nbreak\npick ${short(native, "topic")} three\n`;
    expect(nativeGit(native, ["rebase", "-i", "--update-refs", "main"], { todo }).status).toBe(0);
    const { result } = await ours(mine, RebaseOperation.BEGIN, {
      todo,
      configure: (c) => c.setUpdateRefs(true),
    });
    expect(result.status, result.message).toBe(RebaseStatus.STOPPED);
    expectSame(native, mine, "stopped");
    expect(nativeGit(native, ["rebase", "--continue"]).status).toBe(0);
    expect((await ours(mine, RebaseOperation.CONTINUE)).result.status).toBe(RebaseStatus.OK);
    expectSame(native, mine, "continued");
  });

  it("a fixup after picks kept in place: the base recorded as rewritten", async () => {
    const steps = linear.slice(0, 3);
    const { native, ours: mine } = twins(steps);
    const todo = `pick ${short(native, "topic~2")} one\nfixup ${short(native, "topic")} three\npick ${short(native, "topic~1")} two\nbreak\n`;
    expect(nativeGit(native, ["rebase", "-i", "main"], { todo }).status).toBe(0);
    expect((await ours(mine, RebaseOperation.BEGIN, { todo })).result.status).toBe(
      RebaseStatus.STOPPED,
    );
    expectSame(native, mine, "stopped");
    expect(nativeGit(native, ["rebase", "--continue"]).status).toBe(0);
    expect((await ours(mine, RebaseOperation.CONTINUE)).result.status).toBe(RebaseStatus.OK);
    expectSame(native, mine, "continued");
  });

  it("--rebase-merges with the handler: an edit inside the merges' list", async () => {
    const { native, ours: mine } = twins([
      { branch: "side", from: "main", files: { "s.txt": "s\n" }, message: "side" },
      { branch: "topic", from: "main", files: { "t.txt": "t\n" }, message: "topic one" },
      { branch: "topic", merge: "side", message: "Merge branch 'side' into topic" },
      { branch: "topic", files: { "t2.txt": "t2\n" }, message: "topic two" },
      { branch: "main", files: { "m.txt": "m\n" }, message: "main moved" },
    ]);
    const editFirst = (text: string) =>
      text.replace(/^pick (\w+) (# )?topic one$/m, "edit $1 $2topic one");
    const probe = nativeGit(native, ["rebase", "-i", "-r", "main"], { todo: "" });
    // an empty list aborts: nothing changed; then the real run with the edit
    expect(probe.status).toBe(1);
    const todo = editFirst(probe.seen);
    const run = nativeGit(native, ["rebase", "-i", "-r", "main"], { todo });
    expect(run.status, run.stderr).toBe(0);
    const { result, seen } = await ours(mine, RebaseOperation.BEGIN, {
      todo,
      configure: (c) => c.setRebaseMerges(true),
    });
    expect(result.status, result.message).toBe(RebaseStatus.EDIT);
    if (modern()) expect(seen).toBe(probe.seen);
    expectSame(native, mine, "stopped");
    expect(nativeGit(native, ["rebase", "--continue"]).status).toBe(0);
    expect((await ours(mine, RebaseOperation.CONTINUE)).result.status).toBe(RebaseStatus.OK);
    expectSame(native, mine, "continued");
  });

  it("--root, the list unchanged: the history kept (the root fast-forwarded)", async () => {
    const { native, ours: mine } = twins(linear);
    const run = nativeGit(native, ["rebase", "-i", "--root"]);
    expect(run.status, run.stderr).toBe(0);
    const command = (await openOurs(mine, INTEROP_AUTHOR_ENV)).rebase().setCommitter(INTEROP_IDENT);
    let seen = "";
    const result = await command
      .runInteractively({
        editTodo: (t) => {
          seen = t;
          return t;
        },
      })
      .setRoot(true)
      .call();
    expect(result.status, result.message).toBe(RebaseStatus.OK);
    if (modern()) expect(seen).toBe(run.seen);
    expectSame(native, mine, "done");
  });

  it("--root: the root reworded, an edit stop on top of the new root", async () => {
    const { native, ours: mine } = twins(linear);
    const todo = `reword ${short(native, "topic~3")}\nedit ${short(native, "topic~2")}\npick ${short(native, "topic~1")}\npick ${short(native, "topic")}\n`;
    const message = "the new root\n";
    expect(nativeGit(native, ["rebase", "-i", "--root"], { todo, message }).status).toBe(0);
    const command = (await openOurs(mine, INTEROP_AUTHOR_ENV)).rebase().setCommitter(INTEROP_IDENT);
    const result = await command
      .runInteractively({ editTodo: () => todo, modifyCommitMessage: () => message })
      .setRoot(true)
      .call();
    expect(result.status, result.message).toBe(RebaseStatus.EDIT);
    expectSame(native, mine, "stopped");
    expect(nativeGit(native, ["rebase", "--continue"]).status).toBe(0);
    expect((await ours(mine, RebaseOperation.CONTINUE)).result.status).toBe(RebaseStatus.OK);
    expectSame(native, mine, "continued");
  });

  it("--root --onto main and --root --rebase-merges", async () => {
    for (const args of [
      ["--root", "--onto", "main"],
      ["-r", "--root"],
    ]) {
      const { native, ours: mine } = twins(linear);
      const run = nativeGit(native, ["rebase", ...args]);
      const command = (await openOurs(mine, INTEROP_AUTHOR_ENV))
        .rebase()
        .setCommitter(INTEROP_IDENT);
      command.setRoot(true);
      if (args.includes("--onto")) await command.setUpstreamBranch("main");
      else command.setRebaseMerges(true);
      const result = await command.call();
      expect(result.status === RebaseStatus.OK, `${result.message}\n${run.stderr}`).toBe(
        run.status === 0,
      );
      expectSame(native, mine, args.join(" "));
    }
  });

  it("--exec with --rebase-merges: after each pick and each merge", async () => {
    const { native, ours: mine } = twins([
      { branch: "side", from: "main", files: { "s.txt": "s\n" }, message: "side" },
      { branch: "topic", from: "main", files: { "t.txt": "t\n" }, message: "topic one" },
      { branch: "topic", merge: "side", message: "Merge branch 'side' into topic" },
      { branch: "topic", files: { "t2.txt": "t2\n" }, message: "topic two" },
      { branch: "main", files: { "m.txt": "m\n" }, message: "main moved" },
    ]);
    const run = nativeGit(native, [
      "rebase",
      "-r",
      "-x",
      "git log -1 --format=%s >> ../x-native",
      "main",
    ]);
    expect(run.status, run.stderr).toBe(0);
    const { result } = await ours(mine, RebaseOperation.BEGIN, {
      interactive: false,
      configure: (c) => c.setRebaseMerges(true).setExec(["git log -1 --format=%s >> ../x-ours"]),
    });
    expect(result.status, result.message).toBe(RebaseStatus.OK);
    expect(readFileSync(join(root, "x-ours"), "utf8")).toBe(
      readFileSync(join(root, "x-native"), "utf8"),
    );
    expectSame(native, mine, "done");
  });

  it("--autosquash: a fixup or squash that becomes empty and is dropped still ends its chain", async () => {
    // a dropped squash leaves SQUASH_MSG, which the next chain's fixup (try_to_commit) keeps
    for (const [kind, interactive] of [
      ["fixup", true],
      ["fixup", false],
      ["squash", true],
      ["squash", false],
    ] as const) {
      const steps: GraphStep[] = [
        { branch: "topic", from: "main", files: { "b.txt": "1\n" }, message: "A" },
        { branch: "topic", files: { "m.txt": "m\n" }, message: `${kind}! A` },
        { branch: "topic", files: { "c.txt": "1\n" }, message: "B" },
        { branch: "topic", files: { "c.txt": "2\n" }, message: "fixup! B" },
        { branch: "main", files: { "m.txt": "m\n", "n.txt": "n\n" }, message: "main moved" },
      ];
      // git 2.43 autosquashes an interactive rebase only
      if (!interactive && !modern()) continue;
      const { native, ours: mine } = twins(steps);
      const run = nativeGit(native, [
        "rebase",
        ...(interactive ? ["-i", "--empty=drop"] : []),
        "--autosquash",
        "main",
      ]);
      expect(run.status, run.stderr).toBe(0);
      const { result } = await ours(mine, RebaseOperation.BEGIN, {
        interactive,
        configure: (c) => {
          c.setAutosquash(true);
          if (interactive) c.setEmpty("drop");
        },
      });
      expect(result.status, result.message).toBe(RebaseStatus.OK);
      expectSame(native, mine, `${kind}, interactive ${interactive}`);
    }
  });

  it("--root: a reword onto the new root that conflicts amends it on --continue", async () => {
    const { native, ours: mine } = twins(linear);
    const todo = `reword ${short(native, "topic")}\npick ${short(native, "topic~3")}\npick ${short(native, "topic~1")}\n`;
    const message = "three, the new root\n";
    const run = nativeGit(native, ["rebase", "-i", "--root"], { todo, message });
    expect(run.status).toBe(1);
    const command = (await openOurs(mine, INTEROP_AUTHOR_ENV)).rebase().setCommitter(INTEROP_IDENT);
    const result = await command
      .runInteractively({ editTodo: () => todo, modifyCommitMessage: () => message })
      .setRoot(true)
      .call();
    expect(result.status, result.message).toBe(RebaseStatus.STOPPED);
    expectMessage(result, run);
    expectSame(native, mine, "stopped");
    for (const dir of [native, mine]) {
      put(dir, "b.txt", "resolved\n");
      gitOk(root, dir, "add", "b.txt");
    }
    expect(nativeGit(native, ["rebase", "--continue"], { message }).status).toBe(0);
    const continued = await ours(mine, RebaseOperation.CONTINUE, { message });
    expect(continued.result.status, continued.result.message).toBe(RebaseStatus.OK);
    expectSame(native, mine, "continued");
  });

  /** topic: b added, changed, changed back; main moved on. */
  const addChangeRevert: GraphStep[] = [
    { branch: "topic", from: "main", files: { "b.txt": "1\n" }, message: "add" },
    { branch: "topic", files: { "b.txt": "2\n" }, message: "change" },
    { branch: "topic", files: { "b.txt": "1\n" }, message: "revert" },
    { branch: "main", files: { "m.txt": "m\n" }, message: "main moved" },
  ];

  for (const last of ["squash", "fixup"]) {
    it(`a ${last} whose amend would be empty stops as git commit refuses it`, async () => {
      const { native, ours: mine } = twins(addChangeRevert);
      const todo = `pick ${short(native, "topic~2")}\npick ${short(native, "topic~1")}\n${last} ${short(native, "topic")}\n`;
      const run = nativeGit(native, ["rebase", "-i", "--empty=keep", "main"], { todo });
      expect(run.status).toBe(1);
      const { result } = await ours(mine, RebaseOperation.BEGIN, {
        todo,
        configure: (c) => c.setEmpty("keep"),
      });
      expect(result.status, result.message).toBe(RebaseStatus.STOPPED);
      expectMessage(result, run);
      expectSame(native, mine, "stopped");
      expect(nativeGit(native, ["rebase", "--continue"]).status).toBe(0);
      const continued = await ours(mine, RebaseOperation.CONTINUE);
      expect(continued.result.status, continued.result.message).toBe(RebaseStatus.OK);
      expectSame(native, mine, "continued");
    });
  }

  it("a final squash that conflicts: --continue commits it and removes SQUASH_MSG", async () => {
    const steps: GraphStep[] = [
      { branch: "topic", from: "main", files: { "b.txt": "1\n" }, message: "one" },
      { branch: "topic", files: { "c.txt": "2\n" }, message: "two" },
      { branch: "topic", files: { "a.txt": "topic\n" }, message: "three" },
      { branch: "main", files: { "a.txt": "main\n" }, message: "main moved" },
    ];
    const { native, ours: mine } = twins(steps);
    const todo = `pick ${short(native, "topic~2")}\nsquash ${short(native, "topic~1")}\nsquash ${short(native, "topic")}\n`;
    expect(nativeGit(native, ["rebase", "-i", "main"], { todo }).status).toBe(1);
    const { result } = await ours(mine, RebaseOperation.BEGIN, { todo });
    expect(result.status, result.message).toBe(RebaseStatus.STOPPED);
    expectSame(native, mine, "stopped");
    for (const dir of [native, mine]) {
      put(dir, "a.txt", "resolved\n");
      gitOk(root, dir, "add", "a.txt");
    }
    expect(nativeGit(native, ["rebase", "--continue"]).status).toBe(0);
    const continued = await ours(mine, RebaseOperation.CONTINUE);
    expect(continued.result.status, continued.result.message).toBe(RebaseStatus.OK);
    expectSame(native, mine, "continued");
  });

  for (const flag of ["-C", "-c"]) {
    it(`--signoff with fixup ${flag}: the message that replaces the first signed off`, async () => {
      const { native, ours: mine } = twins(linear);
      const todo = `pick ${short(native, "topic~2")}\nfixup ${flag} ${short(native, "topic~1")}\npick ${short(native, "topic")}\n`;
      const run = nativeGit(native, ["rebase", "-i", "--signoff", "main"], { todo });
      expect(run.status, run.stderr).toBe(0);
      const { result } = await ours(mine, RebaseOperation.BEGIN, {
        todo,
        configure: (c) => c.setSignoff(true),
      });
      expect(result.status, result.message).toBe(RebaseStatus.OK);
      expectSame(native, mine, "done");
    });
  }

  it("a sequence editor that fails: the state removed, the autostash applied", async () => {
    const { native, ours: mine } = twins(linear);
    for (const dir of [native, mine]) put(dir, "a.txt", "dirty\n");
    const run = nativeGit(native, ["rebase", "-i", "--autostash", "main"], {
      env: { GIT_SEQUENCE_EDITOR: "false" },
    });
    expect(run.status).not.toBe(0);
    const { result } = await ours(mine, RebaseOperation.BEGIN, {
      configure: (c) =>
        c.setAutoStash(true).runInteractively({
          editTodo: () => {
            throw new Error("the editor failed");
          },
        }),
    });
    expect(result.status).toBe(RebaseStatus.FAILED);
    expectSame(native, mine, "failed");
  });

  for (const [label, command] of [
    ["a reword", "reword"],
    ["the end of a squash chain", "squash"],
  ] as const) {
    it(`a message editor that fails at ${label}: the stop git commit's failure leaves`, async () => {
      const { native, ours: mine } = twins(linear);
      const todo = `pick ${short(native, "topic~2")}\n${command} ${short(native, "topic~1")}\npick ${short(native, "topic")}\n`;
      const run = nativeGit(native, ["rebase", "-i", "main"], {
        todo,
        env: { GIT_EDITOR: "false" },
      });
      expect(run.status).toBe(1);
      const { result } = await ours(mine, RebaseOperation.BEGIN, {
        configure: (c) =>
          c.runInteractively({
            editTodo: () => todo,
            modifyCommitMessage: () => {
              throw new Error("the editor failed");
            },
          }),
      });
      expect(result.status, result.message).toBe(RebaseStatus.STOPPED);
      expectSame(native, mine, "stopped");
      expect(nativeGit(native, ["rebase", "--continue"]).status).toBe(0);
      const continued = await ours(mine, RebaseOperation.CONTINUE);
      expect(continued.result.status, continued.result.message).toBe(RebaseStatus.OK);
      expectSame(native, mine, "continued");
    });
  }

  it("--continue refused (staged changes, no message): `end` already counted from the list", async () => {
    const { native, ours: mine } = twins(linear);
    const todo = `pick ${short(native, "topic~2")}\nbreak\npick ${short(native, "topic~1")}\npick ${short(native, "topic")}\n`;
    expect(nativeGit(native, ["rebase", "-i", "main"], { todo }).status).toBe(0);
    expect((await ours(mine, RebaseOperation.BEGIN, { todo })).result.status).toBe(
      RebaseStatus.STOPPED,
    );
    for (const dir of [native, mine]) {
      appendFileSync(join(dir, ".git", "rebase-merge", "git-rebase-todo"), "break\n");
      put(dir, "e.txt", "staged\n");
      gitOk(root, dir, "add", "e.txt");
    }
    expect(nativeGit(native, ["rebase", "--continue"]).status).not.toBe(0);
    const refused = await ours(mine, RebaseOperation.CONTINUE);
    expect(refused.result.status).toBe(RebaseStatus.FAILED);
    expectSame(native, mine, "refused");
    // unstaged changes are refused before the list is read (builtin/rebase.c)
    for (const dir of [native, mine]) put(dir, "b.txt", "unstaged\n");
    const run = nativeGit(native, ["rebase", "--continue"]);
    expect(run.status).not.toBe(0);
    const unstaged = await ours(mine, RebaseOperation.CONTINUE);
    expect(unstaged.result.status).toBe(RebaseStatus.FAILED);
    expect(run.stdout).toContain(unstaged.result.message ?? "?");
    expectSame(native, mine, "unstaged");
  });

  it("--edit-todo of a list that does not parse keeps `dropped` until --continue", async () => {
    const { native, ours: mine } = twins(linear, { "rebase.missingCommitsCheck": "error" });
    const todo = `pick ${short(native, "topic~2")} one\npick ${short(native, "topic")} three\n`;
    expect(nativeGit(native, ["rebase", "-i", "main"], { todo }).status).toBe(1);
    expect((await ours(mine, RebaseOperation.BEGIN, { todo })).result.status).toBe(
      RebaseStatus.FAILED,
    );
    for (const dir of [native, mine]) {
      appendFileSync(join(dir, ".git", "rebase-merge", "git-rebase-todo"), "frobnicate x\n");
    }
    const fixed = `pick ${short(native, "topic~2")} one\npick ${short(native, "topic~1")} two\npick ${short(native, "topic")} three\n`;
    expect(nativeGit(native, ["rebase", "--edit-todo"], { todo: fixed }).status).toBe(0);
    const edited = await ours(mine, RebaseOperation.EDIT_TODO, { todo: fixed });
    expect(edited.result.status, edited.result.message).toBe(RebaseStatus.OK);
    expectSame(native, mine, "edited");
    expect(nativeGit(native, ["rebase", "--continue"]).status).toBe(0);
    expect((await ours(mine, RebaseOperation.CONTINUE)).result.status).toBe(RebaseStatus.OK);
    expectSame(native, mine, "continued");
  });

  it("a fixup after a line that does not parse has no previous commit", async () => {
    const { native, ours: mine } = twins(linear);
    const todo = `pick 0000000 nothing\nfixup ${short(native, "topic~1")} two\npick ${short(native, "topic")} three\n`;
    const run = nativeGit(native, ["rebase", "-i", "main"], { todo });
    expect(run.status).toBe(1);
    const { result } = await ours(mine, RebaseOperation.BEGIN, { todo });
    expect(result.status).toBe(RebaseStatus.FAILED);
    const line = "error: cannot 'fixup' without a previous commit";
    expect(run.stderr).toContain(line);
    expect(result.message).toContain(line);
    expectMessage(result, run);
    expectSame(native, mine, "refused");
  });

  it("an abbreviation that a blob shares with a commit of the list: refused as ambiguous", async () => {
    const { native, ours: mine } = twins(linear);
    const target = gitOk(root, native, "rev-parse", "topic~1").trim();
    const prefix = target.slice(0, 4);
    // a blob whose id starts as the commit's
    let content = "";
    for (let n = 0; ; n++) {
      content = `blob ${n}\n`;
      const id = createHash("sha1")
        .update(`blob ${Buffer.byteLength(content)}\0${content}`)
        .digest("hex");
      if (id.startsWith(prefix)) break;
    }
    for (const dir of [native, mine]) {
      const r = spawnSync("git", ["hash-object", "-w", "--stdin"], {
        cwd: dir,
        env: nativeGitEnv(root),
        input: content,
        encoding: "utf8",
      });
      expect(r.stdout.startsWith(prefix), r.stderr).toBe(true);
    }
    const todo = `pick ${short(native, "topic~2")} one\npick ${prefix} two\npick ${short(native, "topic")} three\n`;
    const run = nativeGit(native, ["rebase", "-i", "main"], { todo });
    expect(run.status).toBe(1);
    const { result } = await ours(mine, RebaseOperation.BEGIN, { todo });
    expect(result.status, result.message).toBe(RebaseStatus.FAILED);
    expect(result.message).toContain(`error: could not parse '${prefix}'`);
    expectMessage(result, run);
    expectSame(native, mine, "refused");
  });

  it("a drop before the picks kept in place goes to `done` with them", async () => {
    const steps: GraphStep[] = [
      { branch: "topic", from: "main", files: { "b.txt": "1\n" }, message: "one" },
      { branch: "topic", files: { "c.txt": "2\n" }, message: "two" },
      { branch: "topic", files: { "d.txt": "3\n" }, message: "three" },
    ];
    const { native, ours: mine } = twins(steps);
    const todo = `drop ${short(native, "topic~2")} one\npick ${short(native, "topic~1")} two\nbreak\npick ${short(native, "topic")} three\n`;
    expect(nativeGit(native, ["rebase", "-i", "main"], { todo }).status).toBe(0);
    const { result } = await ours(mine, RebaseOperation.BEGIN, { todo });
    expect(result.status, result.message).toBe(RebaseStatus.STOPPED);
    expectSame(native, mine, "stopped");
    expect(nativeGit(native, ["rebase", "--continue"]).status).toBe(0);
    expect((await ours(mine, RebaseOperation.CONTINUE)).result.status).toBe(RebaseStatus.OK);
    expectSame(native, mine, "continued");
  });

  /** A blob whose id starts with `prefix`, written to each twin. */
  function writeBlobWithPrefix(dirs: string[], prefix: string): string {
    let content = "";
    let blob = "";
    for (let n = 0; ; n++) {
      content = `blob ${n}\n`;
      blob = createHash("sha1")
        .update(`blob ${Buffer.byteLength(content)}\0${content}`)
        .digest("hex");
      if (blob.startsWith(prefix)) break;
    }
    for (const dir of dirs) {
      const r = spawnSync("git", ["hash-object", "-w", "--stdin"], {
        cwd: dir,
        env: nativeGitEnv(root),
        input: content,
        encoding: "utf8",
      });
      expect(r.stdout.trim(), r.stderr).toBe(blob);
    }
    return blob;
  }

  /** expectSame, but for git 2.43's rewritten-list line of a dropped pick (2.5x has none). */
  function expectSameDropped(native: string, mine: string, label: string) {
    if (modern()) return expectSame(native, mine, label);
    const even = (name: string, text: string) =>
      name === "rebase-merge/rewritten-list" ? "<rewritten>" : normalize(name, text);
    expect(snapshot(root, mine, even), label).toEqual(snapshot(root, native, even));
    expect(refs(mine), `${label}: refs`).toBe(refs(native));
    expect(history(mine), `${label}: history`).toBe(history(native));
  }

  it("--autosquash: a one-word hex target a blob shares is read as a committish", async () => {
    const { native, ours: mine } = twins([
      { branch: "topic", from: "main", files: { "b.txt": "1\n" }, message: "A" },
      { branch: "topic", files: { "c.txt": "1\n" }, message: "B" },
      { branch: "main", files: { "m.txt": "m\n" }, message: "main moved" },
    ]);
    const prefix = gitOk(root, native, "rev-parse", "topic~1").trim().slice(0, 4);
    for (const dir of [native, mine]) {
      put(dir, "b.txt", "1\n2\n");
      gitOk(root, dir, "commit", "-q", "-a", "-m", `fixup! ${prefix}`);
    }
    writeBlobWithPrefix([native, mine], prefix);
    const run = nativeGit(native, ["rebase", "-i", "--autosquash", "main"]);
    expect(run.status, run.stderr).toBe(0);
    expect(run.seen).toMatch(/^pick \w+ (# )?A\nfixup \w+ (# )?fixup! /);
    const { result, seen } = await ours(mine, RebaseOperation.BEGIN, {
      configure: (c) => c.setAutosquash(true),
    });
    expect(result.status, result.message).toBe(RebaseStatus.OK);
    if (modern()) expect(seen).toBe(run.seen);
    expectSame(native, mine, "done");
  });

  it("a reword after a dropped squash removes SQUASH_MSG (git commit --amend)", async () => {
    const steps: GraphStep[] = [
      { branch: "topic", from: "main", files: { "b.txt": "1\n" }, message: "A" },
      { branch: "topic", files: { "m.txt": "m\n" }, message: "S" },
      { branch: "topic", files: { "c.txt": "1\n" }, message: "B" },
      { branch: "topic", files: { "d.txt": "1\n" }, message: "C" },
      { branch: "main", files: { "m.txt": "m\n", "n.txt": "n\n" }, message: "main moved" },
    ];
    const { native, ours: mine } = twins(steps);
    const todo = `pick ${short(native, "topic~3")}\nsquash ${short(native, "topic~2")}\nreword ${short(native, "topic~1")}\nbreak\npick ${short(native, "topic")}\n`;
    const message = "B reworded\n";
    const run = nativeGit(native, ["rebase", "-i", "--empty=drop", "main"], { todo, message });
    expect(run.status, run.stderr).toBe(0);
    const { result } = await ours(mine, RebaseOperation.BEGIN, {
      todo,
      message,
      configure: (c) => c.setEmpty("drop"),
    });
    expect(result.status, result.message).toBe(RebaseStatus.STOPPED);
    expectSameDropped(native, mine, "stopped");
    expect(nativeGit(native, ["rebase", "--continue"]).status).toBe(0);
    expect((await ours(mine, RebaseOperation.CONTINUE)).result.status).toBe(RebaseStatus.OK);
    expectSameDropped(native, mine, "continued");
  });

  it("--rebase-merges: a merge after a dropped squash removes SQUASH_MSG (git commit)", async () => {
    const { native, ours: mine } = twins([
      { branch: "side", from: "main", files: { "s.txt": "s\n" }, message: "side" },
      { branch: "topic", from: "main", files: { "t.txt": "t\n" }, message: "topic one" },
      { branch: "topic", files: { "m.txt": "m\n" }, message: "S" },
      { branch: "topic", merge: "side", message: "Merge branch 'side' into topic" },
      { branch: "main", files: { "m.txt": "m\n", "n.txt": "n\n" }, message: "main moved" },
    ]);
    const todo = [
      "label onto",
      "reset onto",
      `pick ${short(native, "side")} side`,
      "label side",
      "reset onto",
      `pick ${short(native, "topic~2")} topic one`,
      `squash ${short(native, "topic~1")} S`,
      `merge -C ${short(native, "topic")} side`,
      "break",
      "",
    ].join("\n");
    const run = nativeGit(native, ["rebase", "-i", "-r", "--empty=drop", "main"], { todo });
    expect(run.status, run.stderr).toBe(0);
    const { result } = await ours(mine, RebaseOperation.BEGIN, {
      todo,
      configure: (c) => c.setRebaseMerges(true).setEmpty("drop"),
    });
    expect(result.status, result.message).toBe(RebaseStatus.STOPPED);
    expectSameDropped(native, mine, "stopped");
    expect(nativeGit(native, ["rebase", "--continue"]).status).toBe(0);
    expect((await ours(mine, RebaseOperation.CONTINUE)).result.status).toBe(RebaseStatus.OK);
    expectSameDropped(native, mine, "continued");
  });

  it("a message editor that fails: git's `there was a problem with the editor` line", async () => {
    const { native, ours: mine } = twins(linear);
    const todo = `pick ${short(native, "topic~2")}\nreword ${short(native, "topic~1")}\npick ${short(native, "topic")}\n`;
    const run = nativeGit(native, ["rebase", "-i", "main"], { todo, env: { GIT_EDITOR: "false" } });
    expect(run.status).toBe(1);
    // git 2.43's git commit: `There was a problem with the editor 'false'.`
    if (modern()) {
      expect(run.stderr).toContain(
        "error: there was a problem with the editor 'false'\nPlease supply the message using either -m or -F option.",
      );
    }
    const { result } = await ours(mine, RebaseOperation.BEGIN, {
      configure: (c) =>
        c.runInteractively({
          editTodo: () => todo,
          modifyCommitMessage: () => {
            throw new Error("the editor failed");
          },
        }),
    });
    expect(result.status, result.message).toBe(RebaseStatus.STOPPED);
    expect(result.message).toContain(
      "error: there was a problem with the editor 'modifyCommitMessage': the editor failed\nPlease supply the message using either -m or -F option.",
    );
    expectSame(native, mine, "stopped");
  });

  it("--signoff: the message of an edit stop has the sign-off (git 2.5x)", async () => {
    // git 2.43 writes the commit's own message there
    if (!modern()) return;
    const { native, ours: mine } = twins(linear);
    const todo = `edit ${short(native, "topic~2")}\npick ${short(native, "topic~1")}\npick ${short(native, "topic")}\n`;
    const run = nativeGit(native, ["rebase", "-i", "--signoff", "main"], { todo });
    expect(run.status, run.stderr).toBe(0);
    const { result } = await ours(mine, RebaseOperation.BEGIN, {
      todo,
      configure: (c) => c.setSignoff(true),
    });
    expect(result.status, result.message).toBe(RebaseStatus.EDIT);
    expect(readFileSync(join(mine, ".git", "rebase-merge", "message"), "utf8")).toContain(
      "Signed-off-by: ",
    );
    expectSame(native, mine, "stopped");
    expect(nativeGit(native, ["rebase", "--continue"]).status).toBe(0);
    expect((await ours(mine, RebaseOperation.CONTINUE)).result.status).toBe(RebaseStatus.OK);
    expectSame(native, mine, "continued");
  });

  it("a todo line naming a blob: `object <id> is a blob, not a commit`", async () => {
    const { native, ours: mine } = twins(linear);
    const blob = writeBlobWithPrefix([native, mine], "");
    const todo = `pick ${short(native, "topic~2")} one\npick ${blob.slice(0, 12)} two\npick ${short(native, "topic")} three\n`;
    const run = nativeGit(native, ["rebase", "-i", "main"], { todo });
    expect(run.status).toBe(1);
    const line = `error: object ${blob} is a blob, not a commit`;
    expect(run.stderr).toContain(line);
    const { result } = await ours(mine, RebaseOperation.BEGIN, { todo });
    expect(result.status, result.message).toBe(RebaseStatus.FAILED);
    expect(result.message).toContain(line);
    expect(result.message).not.toContain("could not parse");
    expectMessage(result, run);
    expectSame(native, mine, "refused");
  });

  it("--continue with unmerged files: `<path>: needs merge`, then git's refusal", async () => {
    const steps: GraphStep[] = [
      {
        branch: "topic",
        from: "main",
        files: { "a.txt": "topic\n", "b.txt": "1\n" },
        message: "one",
      },
      { branch: "main", files: { "a.txt": "main\n" }, message: "main moved" },
    ];
    const { native, ours: mine } = twins(steps);
    expect(nativeGit(native, ["rebase", "-i", "main"]).status).toBe(1);
    expect((await ours(mine)).result.status).toBe(RebaseStatus.STOPPED);
    const run = nativeGit(native, ["rebase", "--continue"]);
    expect(run.status).toBe(1);
    const { result } = await ours(mine, RebaseOperation.CONTINUE);
    expect(result.status).toBe(RebaseStatus.STOPPED);
    expect(result.message).toBe(
      "a.txt: needs merge\nYou must edit all merge conflicts and then\nmark them as resolved using git add",
    );
    expect(run.stdout).toBe(`${result.message}\n`);
    expectSame(native, mine, "refused");
  });

  it("a todo name that is a ref and an abbreviation: the ref, with git's warning", async () => {
    const { native, ours: mine } = twins(linear);
    const name = short(native, "topic");
    // a branch named as the last commit's abbreviation, at the commit before it
    for (const dir of [native, mine]) gitOk(root, dir, "branch", name, "topic~1");
    const todo = `pick ${short(native, "topic~2")} one\npick ${name} three\n`;
    const run = nativeGit(native, ["rebase", "-i", "main"], { todo });
    expect(run.status, run.stderr).toBe(0);
    const warning = `warning: refname '${name}' is ambiguous.`;
    expect(run.stderr).toContain(warning);
    const { result } = await ours(mine, RebaseOperation.BEGIN, { todo });
    expect(result.status, result.message).toBe(RebaseStatus.OK);
    expect(result.output).toContain(warning);
    expectSame(native, mine, "done");
  });
});

describeGit("interactive rebase, native twins: a branch made at a stop", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "rebase-i-branch-"));
    writeFileSync(
      join(root, "seq-editor.sh"),
      '#!/bin/sh\ncp "$1" "$SEEN_TODO"\nif [ -n "$NEW_TODO" ]; then cp "$NEW_TODO" "$1"; fi\nexit 0\n',
    );
    writeFileSync(
      join(root, "msg-editor.sh"),
      '#!/bin/sh\nif [ -n "$NEW_MSG" ]; then cp "$NEW_MSG" "$1"; fi\nexit 0\n',
    );
    chmodSync(join(root, "seq-editor.sh"), 0o755);
    chmodSync(join(root, "msg-editor.sh"), 0o755);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("checkout -b at an edit stop: --continue moves the new branch, as git's update_head_with_reflog", async () => {
    const { native, ours: mine } = twins(linear);
    const todo = `edit ${short(native, "topic~2")} one\npick ${short(native, "topic~1")} two\npick ${short(native, "topic")} three\n`;
    expect(nativeGit(native, ["rebase", "-i", "main"], { todo }).status).toBe(0);
    expect((await ours(mine, RebaseOperation.BEGIN, { todo })).result.status).toBe(
      RebaseStatus.EDIT,
    );
    for (const dir of [native, mine]) gitOk(root, dir, "checkout", "-q", "-b", "other");
    expect(nativeGit(native, ["rebase", "--continue"]).status).toBe(0);
    expect((await ours(mine, RebaseOperation.CONTINUE)).result.status).toBe(RebaseStatus.OK);
    expectSame(native, mine, "continued");
  });
});
