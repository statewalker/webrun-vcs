/**
 * `rebase --rebase-merges` against native git: the todo list (labels, resets, `merge -C`,
 * branch points, cousins), the commands run (labels as `refs/rewritten/` refs, resets,
 * merges recreated by merge-ort with the original message, fast-forwards of commits
 * already in place) and the history made, for a simple merge, nested merges, a merge of a
 * branch forked below the merge base (with and without `rebase-cousins`), a merge of an
 * upstream commit, and a merge that conflicts again (stop, continue, abort, skip). Native
 * twins: each history built twice, rebased by native git and by ours, compared at each
 * stop and at the end.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RebaseOperation, type RebaseResult, RebaseStatus } from "../src/index.js";
import {
  git,
  gitOk,
  INTEROP_IDENT,
  normalizeState,
  openOurs,
  put,
  snapshot,
} from "./merge-native-helpers.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root: string;
let counter = 0;

/**
 * git 2.5x writes the todo as ours: the oneline through the instruction format (`# %s`),
 * a merged branch's tip labeled by the branch that points at it (2.43 labels it from the
 * merge's message).
 */
function modernTodo(): boolean {
  const version = git(root, root, "--version").stdout.match(/(\d+)\.(\d+)/);
  return !!version && (Number(version[1]) > 2 || Number(version[2]) >= 50);
}

/**
 * The state files as both git versions write them: normalizeState, and git 2.43's blank
 * line after a stopped merge's conflict list in `rebase-merge/message`.
 */
function normalize(name: string, text: string): string {
  if (name === "rebase-merge/message") {
    return normalizeState(name, text.replace(/(#\t.*\n)\n$/, "$1"));
  }
  return normalizeState(name, text);
}

/** One step of a history: a commit on a branch, a merge, a tag or a branch. */
type Step =
  | { commit: string; files: Record<string, string>; message?: string }
  | { merge: string; into: string; message?: string; resolve?: Record<string, string> }
  | { branch: string; from: string };

/** Builds the steps on `main` (`base` first): the same repository every time. */
function build(dir: string, steps: Step[], checkout: string): void {
  const run = (...args: string[]) => gitOk(root, dir, ...args);
  gitOk(root, root, "init", "-q", "-b", "main", dir);
  put(dir, "a.txt", "base\n");
  run("add", "-A");
  run("commit", "-q", "-m", "base");
  for (const step of steps) {
    if ("branch" in step) {
      run("branch", step.branch, step.from);
    } else if ("commit" in step) {
      run("checkout", "-q", step.commit);
      for (const [path, content] of Object.entries(step.files)) put(dir, path, content);
      run("add", "-A");
      run(
        "commit",
        "-q",
        "-m",
        step.message ?? `${step.commit}: ${Object.keys(step.files).join(" ")}`,
      );
    } else {
      run("checkout", "-q", step.into);
      const message = step.message ?? `Merge branch '${step.merge}' into ${step.into}`;
      const r = git(root, dir, "merge", "-q", "--no-ff", "--no-edit", "-m", message, step.merge);
      if (r.status !== 0) {
        for (const [path, content] of Object.entries(step.resolve ?? {})) put(dir, path, content);
        run("add", "-A");
        run("commit", "-q", "--no-edit");
      }
    }
  }
  run("checkout", "-q", checkout);
}

/** Both twins of a history: native git's directory and ours. */
function twins(steps: Step[], checkout = "topic", config: Record<string, string> = {}) {
  const n = counter++;
  const native = join(root, `native-${n}`);
  const ours = join(root, `ours-${n}`);
  for (const dir of [native, ours]) {
    build(dir, steps, checkout);
    for (const [key, value] of Object.entries(config)) gitOk(root, dir, "config", key, value);
  }
  return { native, ours };
}

const rebaseMerge = (dir: string, name: string) =>
  readFileSync(join(dir, ".git", "rebase-merge", name), "utf8");

/** The todo list part of the backup (before git's `# Rebase ...` help). */
const backupTodo = (dir: string) =>
  rebaseMerge(dir, "git-rebase-todo.backup").split("\n# Rebase ")[0];

/** Every ref and what it points at (the rewritten labels must be gone at the end). */
const refs = (dir: string) => gitOk(root, dir, "for-each-ref", "--format=%(refname) %(objectname)");

async function ours(
  dir: string,
  operation: RebaseOperation = RebaseOperation.BEGIN,
  /** `config`: none given, rebase.rebaseMerges decides */
  mode: boolean | "rebase-cousins" | "no-rebase-cousins" | "config" = true,
): Promise<RebaseResult> {
  const command = (await openOurs(dir)).rebase().setCommitter(INTEROP_IDENT);
  if (operation !== RebaseOperation.BEGIN) return command.setOperation(operation).call();
  if (mode !== "config") command.setRebaseMerges(mode);
  await command.setUpstreamBranch("main");
  return command.call();
}

function expectSame(native: string, mine: string, label: string) {
  expect(snapshot(root, mine, normalize), label).toEqual(snapshot(root, native, normalize));
  expect(refs(mine), `${label}: refs`).toBe(refs(native));
}

/** A side branch merged into topic, main moved on: the plain case. */
const simple: Step[] = [
  { branch: "side", from: "main" },
  { branch: "topic", from: "main" },
  { commit: "side", files: { "s.txt": "s\n" } },
  { commit: "topic", files: { "t.txt": "t\n" } },
  { merge: "side", into: "topic" },
  { commit: "topic", files: { "t2.txt": "t2\n" } },
  { commit: "main", files: { "m.txt": "m\n" } },
];

/** Nested merges, a branch point with two children, a label from a pull request message. */
const nested: Step[] = [
  { branch: "topic", from: "main" },
  { commit: "topic", files: { "t1.txt": "t1\n" } },
  { branch: "side", from: "topic" },
  { commit: "side", files: { "s1.txt": "s1\n" } },
  { branch: "inner", from: "side" },
  { commit: "inner", files: { "i1.txt": "i1\n" } },
  { commit: "inner", files: { "i2.txt": "i2\n" } },
  { commit: "side", files: { "s2.txt": "s2\n" } },
  { merge: "inner", into: "side", message: "Merge pull request #12 from someone/inner-work" },
  { commit: "topic", files: { "t2.txt": "t2\n" } },
  { merge: "side", into: "topic", message: "Merge remote-tracking branch 'origin/side'" },
  { commit: "topic", files: { "t3.txt": "t3\n" } },
  { commit: "main", files: { "m.txt": "m\n" } },
];

/** A side branch forked from main below the merge base (a cousin), then main moved on. */
const cousins: Step[] = [
  { branch: "topic", from: "main" },
  { commit: "main", files: { "m1.txt": "m1\n" } },
  { branch: "side", from: "main" },
  { commit: "side", files: { "c.txt": "c\n" } },
  { commit: "topic", files: { "t.txt": "t\n" } },
  { merge: "side", into: "topic", message: "Merge side" },
  { commit: "main", files: { "m2.txt": "m2\n" } },
];

/** topic merges a commit of main's that main later builds on: the merge drops out. */
const upstreamMerge: Step[] = [
  { branch: "topic", from: "main" },
  { commit: "main", files: { "m1.txt": "m1\n" } },
  { commit: "topic", files: { "t.txt": "t\n" } },
  { merge: "main", into: "topic", message: "Merge main into topic" },
  { commit: "topic", files: { "t2.txt": "t2\n" } },
  { commit: "main", files: { "m2.txt": "m2\n" } },
];

/** side and topic change a.txt alike: the merge (resolved by hand) conflicts again. */
const conflicting: Step[] = [
  { branch: "side", from: "main" },
  { branch: "topic", from: "main" },
  { commit: "side", files: { "a.txt": "side\n" } },
  { commit: "topic", files: { "a.txt": "topic\n" } },
  { merge: "side", into: "topic", resolve: { "a.txt": "topic and side\n" } },
  { commit: "topic", files: { "t2.txt": "t2\n" } },
  { commit: "main", files: { "m.txt": "m\n" } },
];

/** `simple` with a last commit that conflicts with main: the rebase stops at its end. */
const simpleStop: Step[] = [
  ...simple.slice(0, -1),
  { commit: "topic", files: { "a.txt": "topic last\n" } },
  { commit: "main", files: { "m.txt": "m\n", "a.txt": "main\n" } },
];

describeGit("rebase --rebase-merges, native twins", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "rebase-merges-"));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  for (const [label, steps, mode, config] of [
    ["a simple merge", simple, true, {}],
    ["nested merges and a branch point", nested, true, {}],
    ["a cousin kept on its fork point", cousins, "no-rebase-cousins", {}],
    ["a cousin rebased (rebase-cousins)", cousins, "rebase-cousins", {}],
    [
      "a cousin rebased by rebase.rebaseMerges",
      cousins,
      "config",
      { "rebase.rebaseMerges": "rebase-cousins" },
    ],
    ["a merge of an upstream commit", upstreamMerge, true, {}],
  ] as const) {
    it(`${label}: the same history`, async () => {
      const { native, ours: mine } = twins([...steps], "topic", { ...config });
      const args = ["rebase"];
      if (mode === "rebase-cousins") args.push("--rebase-merges=rebase-cousins");
      else if (mode === "no-rebase-cousins") args.push("--rebase-merges=no-rebase-cousins");
      else if (mode === true) args.push("--rebase-merges");
      const expected = git(root, native, ...args, "main");
      expect(expected.status, expected.stderr).toBe(0);
      const result = await ours(mine, RebaseOperation.BEGIN, mode);
      expect(result.status, result.message).toBe(RebaseStatus.OK);
      expectSame(native, mine, label);
      expect(gitOk(root, mine, "log", "--format=%H %P %s", "topic")).toBe(
        gitOk(root, native, "log", "--format=%H %P %s", "topic"),
      );
    });
  }

  it("a stop at the last pick: the todo, done, backup and labels, then continue", async () => {
    const { native, ours: mine } = twins(simpleStop);
    expect(git(root, native, "rebase", "-r", "main").status).toBe(1);
    const result = await ours(mine);
    expect(result.status).toBe(RebaseStatus.STOPPED);
    expectSame(native, mine, "stopped");
    if (modernTodo()) {
      for (const name of ["git-rebase-todo", "done"]) {
        expect(rebaseMerge(mine, name), name).toBe(rebaseMerge(native, name));
      }
      expect(backupTodo(mine)).toBe(backupTodo(native));
    }
    for (const dir of [native, mine]) {
      writeFileSync(join(dir, "a.txt"), "resolved\n");
      gitOk(root, dir, "add", "a.txt");
    }
    expect(git(root, native, "rebase", "--continue").status).toBe(0);
    expect((await ours(mine, RebaseOperation.CONTINUE)).status).toBe(RebaseStatus.OK);
    expectSame(native, mine, "continued");
  });

  it("nested merges: the todo list as git writes it", async () => {
    if (!modernTodo()) return;
    const steps: Step[] = [
      ...nested.slice(0, -1),
      { commit: "topic", files: { "a.txt": "topic last\n" } },
      { commit: "main", files: { "m.txt": "m\n", "a.txt": "main\n" } },
    ];
    const { native, ours: mine } = twins(steps);
    expect(git(root, native, "rebase", "-r", "main").status).toBe(1);
    expect((await ours(mine)).status).toBe(RebaseStatus.STOPPED);
    expect(backupTodo(mine)).toBe(backupTodo(native));
    expect(rebaseMerge(mine, "done")).toBe(rebaseMerge(native, "done"));
    expectSame(native, mine, "stopped");
  });

  it("a merge that conflicts again: stop, continue", async () => {
    const { native, ours: mine } = twins(conflicting);
    const expected = git(root, native, "rebase", "-r", "main");
    expect(expected.status).toBe(1);
    const result = await ours(mine);
    expect(result.status).toBe(RebaseStatus.STOPPED);
    const stop = (s: string) => s.split(/[\r\n]/).filter((l) => l.startsWith("Could not apply"));
    expect(stop(result.message ?? "")).toEqual(stop(expected.stderr));
    expect(result.output).toEqual(
      expected.stdout.split("\n").filter((l) => /^(Auto-merging|CONFLICT)/.test(l)),
    );
    expectSame(native, mine, "stopped at the merge");
    for (const dir of [native, mine]) {
      writeFileSync(join(dir, "a.txt"), "resolved again\n");
      gitOk(root, dir, "add", "a.txt");
    }
    expect(git(root, native, "rebase", "--continue").status).toBe(0);
    const continued = await ours(mine, RebaseOperation.CONTINUE);
    expect(continued.status, continued.message).toBe(RebaseStatus.OK);
    expectSame(native, mine, "continued");
    expect(gitOk(root, mine, "log", "--format=%H %P %s", "topic")).toBe(
      gitOk(root, native, "log", "--format=%H %P %s", "topic"),
    );
  });

  it("a merge that conflicts again: abort and skip", async () => {
    for (const operation of [RebaseOperation.ABORT, RebaseOperation.SKIP]) {
      const { native, ours: mine } = twins(conflicting);
      expect(git(root, native, "rebase", "-r", "main").status).toBe(1);
      expect((await ours(mine)).status).toBe(RebaseStatus.STOPPED);
      const flag = operation === RebaseOperation.ABORT ? "--abort" : "--skip";
      expect(git(root, native, "rebase", flag).status).toBe(0);
      const result = await ours(mine, operation);
      expect(result.status, result.message).toBe(
        operation === RebaseOperation.ABORT ? RebaseStatus.ABORTED : RebaseStatus.OK,
      );
      expectSame(native, mine, flag);
    }
  });

  it("native git's stop continued by ours and ours by native git, `merge -c` edited in", async () => {
    // both stop at the conflicting pick before the merge; the todo's merge then says -c
    const steps: Step[] = [
      { branch: "side", from: "main" },
      { branch: "topic", from: "main" },
      { commit: "side", files: { "s.txt": "s\n" } },
      { commit: "topic", files: { "a.txt": "topic\n" } },
      {
        merge: "side",
        into: "topic",
        message: "Merge branch 'side'\n\nwith a body   \n\n\n# a comment line\n",
      },
      { commit: "main", files: { "a.txt": "main\n" } },
    ];
    for (const swap of [false, true]) {
      const { native, ours: mine } = twins(steps);
      expect(git(root, native, "rebase", "-r", "main").status).toBe(1);
      expect((await ours(mine)).status).toBe(RebaseStatus.STOPPED);
      expectSame(native, mine, "stopped");
      for (const dir of [native, mine]) {
        const todo = join(dir, ".git", "rebase-merge", "git-rebase-todo");
        writeFileSync(todo, readFileSync(todo, "utf8").replace("merge -C", "merge -c"));
        writeFileSync(join(dir, "a.txt"), "resolved\n");
        gitOk(root, dir, "add", "a.txt");
      }
      // swap: native git continues our stop and ours native git's
      const [byNative, byOurs] = swap ? [mine, native] : [native, mine];
      expect(git(root, byNative, "rebase", "--continue").status).toBe(0);
      const continued = await ours(byOurs, RebaseOperation.CONTINUE);
      expect(continued.status, continued.message).toBe(RebaseStatus.OK);
      expectSame(byNative, byOurs, `continued (swap ${swap})`);
    }
  });
});
