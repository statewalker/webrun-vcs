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

import {
  type RebaseCommand,
  RebaseOperation,
  type RebaseResult,
  RebaseStatus,
} from "../src/index.js";
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
    // and the blank line 2.43 writes after the message, and the sign-off of --signoff
    // (2.43 writes the commit's own message, 2.5x the message picked, signed off)
    return normalizeState(name, text.replace(/(#\t.*\n)\n$/, "$1"))
      .replace(/\n\n$/, "\n")
      .replace(/\n\nSigned-off-by: .*\n$/, "\n");
  }
  return normalizeState(name, text);
}

/** One step of a history: a commit on a branch, a merge, a tag or a branch. */
type Step =
  | { commit: string; files: Record<string, string>; message?: string }
  | { merge: string; into: string; message?: string; resolve?: Record<string, string> }
  | { octopus: string[]; into: string; message?: string; resolve?: Record<string, string> }
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
        "--allow-empty",
        "-m",
        step.message ?? `${step.commit}: ${Object.keys(step.files).join(" ")}`,
      );
    } else if ("octopus" in step) {
      run("checkout", "-q", step.into);
      const message = step.message ?? `Merge ${step.octopus.join(" ")} into ${step.into}`;
      const r = git(
        root,
        dir,
        "merge",
        "-q",
        "--no-ff",
        "--no-edit",
        "-m",
        message,
        ...step.octopus,
      );
      if (r.status !== 0) {
        // an octopus that conflicts is made by hand: the heads' files, then the resolution
        run("reset", "-q", "--hard");
        for (const head of step.octopus) run("checkout", "-q", head, "--", ".");
        for (const [path, content] of Object.entries(step.resolve ?? {})) put(dir, path, content);
        run("add", "-A");
        const tree = run("write-tree").trim();
        const parents = ["HEAD", ...step.octopus].flatMap((p) => ["-p", p]);
        const id = run("commit-tree", tree, ...parents, "-m", message).trim();
        run("reset", "-q", "--hard", id);
      }
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

/**
 * expectSame for an octopus's conflict: git-merge-one-file's markers name temporary files
 * (`.merge_file_XXXXXX`), evened out.
 */
function expectSameOctopus(native: string, mine: string, label: string) {
  const even = (dir: string) => {
    const shot = snapshot(root, dir, normalize);
    for (const [k, v] of Object.entries(shot.files)) {
      shot.files[k] = v.replace(/\.merge_file_\w{6}/g, ".merge_file_X");
    }
    return shot;
  };
  expect(even(mine), label).toEqual(even(native));
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
  /**
   * Every HEAD reflog line's id and message (the octopus logs as git's merge); git 2.43 logs
   * a recreated merge `rebase (pick)`, 2.5x `rebase (merge)`.
   */
  const reflog = (dir: string) => {
    const text = gitOk(root, dir, "reflog", "--format=%H %gs", "HEAD");
    return modernTodo() ? text : text.replace(/ rebase \(merge\): /g, " rebase (pick): ");
  };

  /** Ours with the command set up by `configure` (the upstream is main). */
  async function oursWith(
    dir: string,
    configure: (command: RebaseCommand) => void,
  ): Promise<RebaseResult> {
    const command = (await openOurs(dir)).rebase().setCommitter(INTEROP_IDENT);
    configure(command);
    await command.setUpstreamBranch("main");
    return command.call();
  }

  /** Two side branches merged at once into topic (an octopus), main moved on. */
  const octopus = (resolve?: Record<string, string>, conflict?: "first" | "last"): Step[] => [
    { branch: "s1", from: "main" },
    { branch: "s2", from: "main" },
    { branch: "topic", from: "main" },
    {
      commit: "s1",
      files: { "s1.txt": "s1\n", ...(conflict === "first" ? { "a.txt": "s1\n" } : {}) },
    },
    {
      commit: "s2",
      files: { "s2.txt": "s2\n", ...(conflict === "last" ? { "a.txt": "s2\n" } : {}) },
    },
    { commit: "topic", files: { "t.txt": "t\n", ...(conflict ? { "a.txt": "t\n" } : {}) } },
    {
      octopus: ["s1", "s2"],
      into: "topic",
      message: "Merge s1 and s2",
      ...(resolve ? { resolve } : {}),
    },
    { commit: "topic", files: { "t2.txt": "t2\n" } },
    { commit: "main", files: { "m.txt": "m\n" } },
  ];

  /**
   * The octopus twins without the side branches: both git versions label the heads from the
   * merge's message then (2.5x by a branch that points at a head)
   */
  const octopusTwins = (steps: Step[]) => {
    const dirs = twins(steps);
    for (const dir of [dirs.native, dirs.ours]) gitOk(root, dir, "branch", "-D", "s1", "s2");
    return dirs;
  };

  /** What git's merge prints on stdout for an octopus (our `output`). */
  const octopusLines = (stdout: string) =>
    stdout
      .split(/[\r\n]/)
      .filter((l) =>
        /^(Trying|Simple merge|Auto-merging|Automated merge|Should not|Merge made|Automatic merge failed)/.test(
          l,
        ),
      );

  it("an octopus merge: recreated by git's octopus strategy, ORIG_HEAD and reflog as git's", async () => {
    const { native, ours: mine } = octopusTwins(octopus());
    const expected = git(root, native, "rebase", "-r", "main");
    expect(expected.status, expected.stderr).toBe(0);
    const result = await ours(mine);
    expect(result.status, result.message).toBe(RebaseStatus.OK);
    expectSame(native, mine, "octopus");
    expect(gitOk(root, mine, "log", "--format=%H %P %s", "topic")).toBe(
      gitOk(root, native, "log", "--format=%H %P %s", "topic"),
    );
    expect(reflog(mine)).toBe(reflog(native));
    expect(result.output).toEqual(octopusLines(expected.stdout));
  });

  it("an octopus whose last head conflicts: stop as git's merge leaves it, continue", async () => {
    const { native, ours: mine } = octopusTwins(octopus({ "a.txt": "all\n" }, "last"));
    const expected = git(root, native, "rebase", "-r", "main");
    expect(expected.status).toBe(1);
    const result = await ours(mine);
    expect(result.status, result.message).toBe(RebaseStatus.STOPPED);
    const stop = (s: string) =>
      s.split(/[\r\n]/).filter((l) => /^(Could not apply|ERROR|fatal)/.test(l));
    expect(stop(result.message ?? "")).toEqual(stop(expected.stderr));
    expect(result.output).toEqual(octopusLines(expected.stdout));
    expectSameOctopus(native, mine, "stopped at the octopus");
    for (const dir of [native, mine]) {
      writeFileSync(join(dir, "a.txt"), "resolved\n");
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

  it("an octopus that gives up (an earlier head conflicts): stop, then skip", async () => {
    const { native, ours: mine } = octopusTwins(octopus({ "a.txt": "all\n" }, "first"));
    const expected = git(root, native, "rebase", "-r", "main");
    expect(expected.status).toBe(1);
    const result = await ours(mine);
    expect(result.status, result.message).toBe(RebaseStatus.STOPPED);
    expect(result.output).toContain("Should not be doing an octopus.");
    const stop = (s: string) =>
      s.split(/[\r\n]/).filter((l) => /^(Could not apply|ERROR|fatal|Merge with)/.test(l));
    expect(stop(result.message ?? "")).toEqual(stop(expected.stderr));
    expect(result.output).toEqual(octopusLines(expected.stdout));
    expectSame(native, mine, "gave up");
    expect(git(root, native, "rebase", "--skip").status).toBe(0);
    const skipped = await ours(mine, RebaseOperation.SKIP);
    expect(skipped.status, skipped.message).toBe(RebaseStatus.OK);
    expectSame(native, mine, "skipped");
  });

  it("a branch on upstream with merges since: rebased (linearized, or rebuilt with -r)", async () => {
    const steps: Step[] = [
      { branch: "side", from: "main" },
      { branch: "topic", from: "main" },
      { commit: "side", files: { "s.txt": "s\n" } },
      { commit: "topic", files: { "t.txt": "t\n" } },
      { merge: "side", into: "topic" },
      { commit: "topic", files: { "t2.txt": "t2\n" } },
    ];
    for (const mode of [false, true]) {
      const { native, ours: mine } = twins(steps);
      const expected = git(root, native, "rebase", ...(mode ? ["-r"] : []), "main");
      expect(expected.status, expected.stderr).toBe(0);
      expect(expected.stdout).not.toContain("is up to date");
      const result = await ours(mine, RebaseOperation.BEGIN, mode);
      expect(result.status, result.message).toBe(RebaseStatus.OK);
      expectSame(native, mine, `merges since upstream (-r ${mode})`);
      expect(gitOk(root, mine, "log", "--format=%H %P %s", "topic")).toBe(
        gitOk(root, native, "log", "--format=%H %P %s", "topic"),
      );
      expect(reflog(mine)).toBe(reflog(native));
    }
  });

  it("a linear branch on upstream is up to date: the message, detached too", async () => {
    const steps: Step[] = [
      { branch: "topic", from: "main" },
      { commit: "topic", files: { "t.txt": "t\n" } },
    ];
    for (const detach of [false, true]) {
      const { native, ours: mine } = twins(steps);
      if (detach) for (const dir of [native, mine]) gitOk(root, dir, "checkout", "-q", "--detach");
      const expected = git(root, native, "rebase", "main");
      expect(expected.status, expected.stderr).toBe(0);
      const result = await ours(mine, RebaseOperation.BEGIN, false);
      expect(result.status).toBe(RebaseStatus.UP_TO_DATE);
      expect(result.output).toEqual([expected.stdout.trim()]);
      expectSame(native, mine, `up to date (detached ${detach})`);
    }
  });

  it("MERGE_MSG of a merge skipped (already in HEAD) goes with the next pick's commit", async () => {
    // rebase-cousins: the merge of main's commit finds it in HEAD already
    const base: Step[] = [
      { branch: "topic", from: "main" },
      { commit: "main", files: { "m1.txt": "m1\n" } },
      { commit: "topic", files: { "t.txt": "t\n" } },
      { merge: "main", into: "topic", message: "Merge main into topic" },
    ];
    for (const last of [true, false]) {
      const steps: Step[] = [
        ...base,
        ...(last ? [{ commit: "topic", files: { "t2.txt": "t2\n" } }] : []),
        { commit: "main", files: { "m2.txt": "m2\n" } },
      ];
      const { native, ours: mine } = twins(steps);
      const expected = git(root, native, "rebase", "--rebase-merges=rebase-cousins", "main");
      expect(expected.status, expected.stderr).toBe(0);
      const result = await ours(mine, RebaseOperation.BEGIN, "rebase-cousins");
      expect(result.status, result.message).toBe(RebaseStatus.OK);
      expectSame(native, mine, `skipped merge (a pick after it: ${last})`);
    }
  });

  it("--skip: the stopped commit maps to HEAD, REBASE_HEAD kept after the last command", async () => {
    // two picks that conflict with main: skip the first (stop at the second), skip that too
    const steps: Step[] = [
      { branch: "topic", from: "main" },
      { commit: "topic", files: { "a.txt": "t1\n" } },
      { commit: "topic", files: { "a.txt": "t2\n" } },
      { commit: "main", files: { "a.txt": "main\n" } },
    ];
    const { native, ours: mine } = twins(steps);
    expect(git(root, native, "rebase", "main").status).toBe(1);
    expect((await ours(mine, RebaseOperation.BEGIN, false)).status).toBe(RebaseStatus.STOPPED);
    expectSame(native, mine, "stopped");
    for (const label of ["skipped the first", "skipped the last"]) {
      git(root, native, "rebase", "--skip");
      await ours(mine, RebaseOperation.SKIP);
      expectSame(native, mine, label);
    }
  });

  it("--signoff: each pick signed off as git signs it, forced on a branch up to date", async () => {
    const messages = [
      "plain",
      "with trailers\n\nAcked-by: Someone <s@example.com>",
      "already signed\n\nSigned-off-by: Interop Tester <interop@example.com>",
      "signed earlier\n\nSigned-off-by: Interop Tester <interop@example.com>\nAcked-by: X <x@y>",
    ];
    const picks: Step[] = messages.map((message, k) => ({
      commit: "topic",
      files: { [`t${k}.txt`]: `${k}\n` },
      message,
    }));
    for (const moved of [true, false]) {
      const steps: Step[] = [
        { branch: "topic", from: "main" },
        ...picks,
        ...(moved ? [{ commit: "main", files: { "m.txt": "m\n" } }] : []),
      ];
      const { native, ours: mine } = twins(steps);
      const expected = git(root, native, "rebase", "--signoff", "main");
      expect(expected.status, expected.stderr).toBe(0);
      const result = await oursWith(mine, (c) => c.setSignoff(true));
      expect(result.status, result.message).toBe(RebaseStatus.OK);
      expectSame(native, mine, `signoff (main moved: ${moved})`);
      expect(gitOk(root, mine, "log", "--format=%H %B", "topic")).toBe(
        gitOk(root, native, "log", "--format=%H %B", "topic"),
      );
      if (!moved) {
        expect(result.output).toContain("Current branch topic is up to date, rebase forced.");
      }
    }
  });

  it("--signoff with --rebase-merges: picks signed off and never fast-forwarded, a stop", async () => {
    const { native, ours: mine } = twins(simpleStop);
    expect(git(root, native, "rebase", "-r", "--signoff", "main").status).toBe(1);
    const result = await oursWith(mine, (c) => c.setRebaseMerges(true).setSignoff(true));
    expect(result.status, result.message).toBe(RebaseStatus.STOPPED);
    expectSame(native, mine, "stopped");
    // git 2.43 commits the resolved pick with the commit's own message (no sign-off)
    if (!modernTodo()) return;
    for (const dir of [native, mine]) {
      writeFileSync(join(dir, "a.txt"), "resolved\n");
      gitOk(root, dir, "add", "a.txt");
    }
    expect(git(root, native, "rebase", "--continue").status).toBe(0);
    expect((await ours(mine, RebaseOperation.CONTINUE)).status).toBe(RebaseStatus.OK);
    expectSame(native, mine, "continued");
    expect(gitOk(root, mine, "log", "--format=%H %P %B", "topic")).toBe(
      gitOk(root, native, "log", "--format=%H %P %B", "topic"),
    );
  });

  it("--signoff with --rebase-merges on upstream already: nothing fast-forwarded", async () => {
    const steps: Step[] = [
      { branch: "side", from: "main" },
      { branch: "topic", from: "main" },
      { commit: "side", files: { "s.txt": "s\n" } },
      { commit: "topic", files: { "t.txt": "t\n" } },
      { merge: "side", into: "topic" },
    ];
    const { native, ours: mine } = twins(steps);
    const expected = git(root, native, "rebase", "-r", "--signoff", "main");
    expect(expected.status, expected.stderr).toBe(0);
    const result = await oursWith(mine, (c) => c.setRebaseMerges(true).setSignoff(true));
    expect(result.status, result.message).toBe(RebaseStatus.OK);
    expectSame(native, mine, "signed off");
    expect(gitOk(root, mine, "log", "--format=%H %P %B", "topic")).toBe(
      gitOk(root, native, "log", "--format=%H %P %B", "topic"),
    );
    expect(reflog(mine)).toBe(reflog(native));
  });

  it("an empty commit says so in the todo and done (` # empty`)", async () => {
    const steps: Step[] = [
      { branch: "topic", from: "main" },
      { commit: "topic", files: {}, message: "nothing" },
      { commit: "topic", files: { "a.txt": "topic\n" } },
      { commit: "main", files: { "a.txt": "main\n" } },
    ];
    const { native, ours: mine } = twins(steps);
    expect(git(root, native, "rebase", "main").status).toBe(1);
    expect((await ours(mine, RebaseOperation.BEGIN, false)).status).toBe(RebaseStatus.STOPPED);
    expectSame(native, mine, "stopped after the empty pick");
    expect(rebaseMerge(mine, "done")).toContain(" # empty\n");
  });

  it("rebase.rebaseMerges with an unknown mode dies as git does", async () => {
    const { native, ours: mine } = twins(simple, "topic", { "rebase.rebaseMerges": "bogus" });
    const expected = git(root, native, "rebase", "--rebase-merges", "main");
    expect(expected.status).toBe(128);
    const result = await ours(mine);
    expect(result.status).toBe(RebaseStatus.FAILED);
    expect(result.message).toBe(expected.stderr.trim());
    expect(result.message).toBe("fatal: Unknown rebase-merges mode: bogus");
    expectSame(native, mine, "refused");
  });
});
