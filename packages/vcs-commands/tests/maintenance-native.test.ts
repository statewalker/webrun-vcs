/**
 * `git.maintenanceRun()` against native `git maintenance run`: each scenario builds a
 * repository with native git, copies it (`cp -a`), runs native `git maintenance run <args>` in
 * one copy (its trace2 regions name the tasks run, as t7900's `test_maintenance_tasks` reads
 * them) and our `MaintenanceRunCommand` with the same options in the other, then compares the
 * exit status, the tasks run and the repositories (`gcSnapshot`: loose objects, packs by their
 * objects and base names, packed and loose refs, reflogs, worktrees, rr-cache, commit-graph,
 * multi-pack-index). Native `git fsck --strict` must accept ours. Scenarios come from git's
 * t7900-maintenance, each named by its title; those of tasks git 2.43 lacks (reflog-expire,
 * worktree-prune, rerere-gc, geometric-repack, the 2.5x default strategy) run against 2.5x only.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MaintenanceRunCommand } from "../src/commands/maintenance-run-command.js";
import { PlumbingError } from "../src/commands/plumbing-command.js";
import {
  bareEnv,
  copyTwin,
  DAY,
  fsck,
  type GcSnapshot,
  gcEnv,
  gcSnapshot,
  initRepo,
  type NativeRepo,
  NOW,
  nativeIs25x,
  newCase,
  openOursGc,
  REFLOG_EXPIRY_DEFAULTS,
} from "./gc-native-twins-support.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;
const it25x = nativeIs25x ? it : it.skip;

let root: string;

/**
 * `-c` settings for both twins, as `GIT_CONFIG_*` after `nativeGitEnv`'s two
 * (`maintenance.auto=false`, `gc.auto=0`): a later `gc.auto` wins, as git's last value does.
 */
function configEnv(config: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  const entries = Object.entries(config);
  env.GIT_CONFIG_COUNT = String(2 + entries.length);
  entries.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${2 + i}`] = k;
    env[`GIT_CONFIG_VALUE_${2 + i}`] = v;
  });
  return env;
}

/** t7900's `test_maintenance_tasks`: the labels (and phase suffix) of the maintenance regions. */
function traceTasks(path: string): string[] {
  if (!existsSync(path)) return [];
  const out: string[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /"region_enter".*"category":"maintenance([^"]*)".*"label":"([^"]+)"/.exec(line);
    if (m) out.push(`${m[2]}${m[1]}`);
  }
  return out;
}

/** The refs of a twin (`git for-each-ref`), compared besides the snapshot. */
function refsOf(dir: string): string {
  const r = spawnSync("git", ["for-each-ref", "--format=%(refname) %(objectname)"], {
    cwd: dir,
    env: gcEnv(root, bareEnv(dir)),
  });
  return r.stdout.toString();
}

/** Packs in a stable order (two packs may start with the same id). */
function sorted(s: GcSnapshot): GcSnapshot {
  return {
    ...s,
    packs: [...s.packs].sort((x, y) =>
      `${x.kind} ${x.prefix ?? ""} ${x.ids.join(",")}`.localeCompare(
        `${y.kind} ${y.prefix ?? ""} ${y.ids.join(",")}`,
      ),
    ),
  };
}

interface Twin {
  args: string[];
  ours: (c: MaintenanceRunCommand) => MaintenanceRunCommand;
  config?: Record<string, string>;
  /** git -c settings only native git gets (2.56.x's swapped reflog expiry defaults) */
  nativeOnly?: string[];
}

interface TwinOutcome {
  native: { status: number | null; stderr: string; tasks: string[]; snapshot: GcSnapshot };
  ours: { status: number; stderr: string; tasks: string[]; snapshot: GcSnapshot };
}

/** Runs native `git maintenance run` and ours on twins of `<caseDir>/src` (see the module). */
async function twins(caseDir: string, run: Twin, name = "run"): Promise<TwinOutcome> {
  const native = copyTwin(caseDir, `native-${name}`);
  const ours = copyTwin(caseDir, `ours-${name}`);
  const env = configEnv(run.config ?? {});
  const trace = join(caseDir, `trace-${name}.json`);
  const theirs = spawnSync("git", [...(run.nativeOnly ?? []), "maintenance", "run", ...run.args], {
    cwd: join(native, "repo"),
    env: gcEnv(root, { ...env, GIT_TRACE2_EVENT: trace }),
  });
  const git = await openOursGc(root, ours, "repo", env);
  let status = 0;
  let stderr = "";
  let tasks: string[] = [];
  try {
    const r = await run.ours(git.maintenanceRun()).call();
    status = r.exitCode;
    stderr = r.stderr;
    tasks = r.tasks;
  } catch (e) {
    if (!(e instanceof PlumbingError)) throw e;
    status = e.exitCode;
    stderr = `${e.message}\n`;
  }
  const outcome: TwinOutcome = {
    native: {
      status: theirs.status,
      stderr: theirs.stderr.toString(),
      tasks: traceTasks(trace),
      snapshot: sorted(gcSnapshot(join(native, "repo", ".git"), native)),
    },
    ours: { status, stderr, tasks, snapshot: sorted(gcSnapshot(join(ours, "repo", ".git"), ours)) },
  };
  expect(outcome.ours.status, outcome.native.stderr).toBe(outcome.native.status);
  expect(outcome.ours.tasks).toEqual(outcome.native.tasks);
  expect(outcome.ours.snapshot).toEqual(outcome.native.snapshot);
  expect(refsOf(join(ours, "repo"))).toEqual(refsOf(join(native, "repo")));
  const ok = fsck(root, join(ours, "repo"));
  expect(ok.status, ok.out).toBe(0);
  return outcome;
}

/** A repository with three commits on main, a tag and a branch, all loose. */
function history(name: string): { caseDir: string; r: NativeRepo } {
  const caseDir = newCase(root, name);
  const r = initRepo(root, caseDir);
  r.commit("one", { "a.txt": "a\n", "dir/b.txt": "b\n" });
  r.commit("two", { "a.txt": "a2\n" });
  r.git(["tag", "-a", "-m", "v1", "v1"]);
  r.git(["branch", "topic"]);
  r.commit("three", { "c.txt": "c\n" });
  return { caseDir, r };
}

describeGit("git maintenance run twins", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "maintenance-twins-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  describe("task selection", () => {
    it('t7900-maintenance.sh: "run --task=<task>"', async () => {
      const { caseDir } = history("task-select");
      await twins(
        caseDir,
        { args: ["--task=commit-graph"], ours: (c) => c.addTask("commit-graph") },
        "cg",
      );
      await twins(caseDir, { args: ["--task=gc"], ours: (c) => c.addTask("gc") }, "gc");
      await twins(
        caseDir,
        {
          args: ["--task=commit-graph", "--task=gc"],
          ours: (c) => c.addTask("commit-graph").addTask("gc"),
        },
        "both",
      );
    });

    it('t7900-maintenance.sh: "maintenance.<task>.enabled"', async () => {
      const { caseDir, r } = history("enabled");
      r.git(["config", "maintenance.gc.enabled", "false"]);
      r.git(["config", "maintenance.commit-graph.enabled", "true"]);
      await twins(caseDir, { args: [], ours: (c) => c });
    });

    it('t7900-maintenance.sh: "run [--auto|--quiet] with gc strategy"', async () => {
      const { caseDir, r } = history("gc-strategy");
      r.git(["config", "maintenance.strategy", "gc"]);
      await twins(
        caseDir,
        { args: [], ours: (c) => c, nativeOnly: REFLOG_EXPIRY_DEFAULTS },
        "plain",
      );
      await twins(caseDir, { args: ["--auto"], ours: (c) => c.setAuto(true) }, "auto");
    });

    it('t7900-maintenance.sh: "core.commitGraph=false prevents write process"', async () => {
      const { caseDir } = history("no-commit-graph");
      await twins(caseDir, {
        args: ["--task=commit-graph"],
        ours: (c) => c.addTask("commit-graph"),
        config: { "core.commitGraph": "false" },
      });
    });

    it('t7900-maintenance.sh: "run --task=bogus"', async () => {
      const { caseDir } = history("bogus");
      const o = await twins(caseDir, { args: ["--task=bogus"], ours: (c) => c.addTask("bogus") });
      expect(o.ours.stderr).toBe(o.native.stderr.split("\n")[0]?.concat("\n"));
    });

    it('t7900-maintenance.sh: "run --task duplicate"', async () => {
      const { caseDir } = history("duplicate");
      const o = await twins(caseDir, {
        args: ["--task=gc", "--task=gc"],
        ours: (c) => c.addTask("gc").addTask("gc"),
      });
      expect(o.ours.stderr).toBe(o.native.stderr.split("\n")[0]?.concat("\n"));
    });

    it('t7900-maintenance.sh: "--auto and --schedule incompatible"', async () => {
      const { caseDir } = history("auto-schedule");
      const o = await twins(caseDir, {
        args: ["--auto", "--schedule=daily"],
        ours: (c) => c.setAuto(true).setSchedule("daily"),
      });
      expect(o.ours.stderr).toBe(o.native.stderr);
    });

    it('t7900-maintenance.sh: "--task and --schedule incompatible"', async () => {
      const { caseDir } = history("task-schedule");
      const o = await twins(caseDir, {
        args: ["--task=prefetch", "--schedule=daily"],
        ours: (c) => c.addTask("prefetch").setSchedule("daily"),
      });
      expect(o.ours.stderr).toBe(o.native.stderr);
    });

    it('t7900-maintenance.sh: "invalid --schedule value"', async () => {
      const { caseDir } = history("bad-schedule");
      const o = await twins(caseDir, {
        args: ["--schedule=annually"],
        ours: (c) => c.setSchedule("annually"),
      });
      expect(o.ours.stderr).toBe(o.native.stderr);
    });

    it('t7900-maintenance.sh: "--schedule inheritance weekly -> daily -> hourly"', async () => {
      const { caseDir, r } = history("schedule-inheritance");
      for (const [task, schedule] of [
        ["loose-objects", "hourly"],
        ["commit-graph", "daily"],
        ["incremental-repack", "weekly"],
      ] as const) {
        r.git(["config", `maintenance.${task}.enabled`, "true"]);
        r.git(["config", `maintenance.${task}.schedule`, schedule]);
      }
      for (const schedule of ["hourly", "daily", "weekly"])
        await twins(
          caseDir,
          { args: [`--schedule=${schedule}`], ours: (c) => c.setSchedule(schedule) },
          schedule,
        );
    });

    it('t7900-maintenance.sh: "maintenance.strategy inheritance"', async () => {
      const { caseDir, r } = history("strategy-inheritance");
      r.git(["config", "maintenance.strategy", "incremental"]);
      r.git(["config", "maintenance.gc.enabled", "true"]);
      r.git(["config", "maintenance.gc.schedule", "daily"]);
      r.git(["config", "maintenance.commit-graph.schedule", "daily"]);
      r.git(["config", "maintenance.loose-objects.enabled", "false"]);
      for (const schedule of ["hourly", "daily", "weekly"])
        await twins(
          caseDir,
          {
            args: [`--schedule=${schedule}`],
            ours: (c) => c.setSchedule(schedule),
            nativeOnly: REFLOG_EXPIRY_DEFAULTS,
          },
          schedule,
        );
    });

    it('t7900-maintenance.sh: "maintenance aborts with existing lock file"', async () => {
      const { caseDir, r } = history("lock");
      writeFileSync(join(r.gitDir, "objects", "maintenance.lock"), "");
      await twins(caseDir, {
        args: ["--task=commit-graph"],
        ours: (c) => c.addTask("commit-graph"),
      });
    });

    it25x('t7900-maintenance.sh: "pre-auto-gc hook runs exactly once"', async () => {
      const { caseDir, r } = history("hook-once");
      const hook = join(r.gitDir, "hooks", "pre-auto-gc");
      mkdirSync(join(r.gitDir, "hooks"), { recursive: true });
      writeFileSync(hook, "#!/bin/sh\necho hook >>hook.log\n", { mode: 0o755 });
      r.git(["config", "maintenance.reflog-expire.auto", "-1"]);
      r.git(["config", "maintenance.geometric-repack.auto", "-1"]);
      r.git(["config", "maintenance.rerere-gc.auto", "-1"]);
      const o = await twins(caseDir, { args: ["--auto"], ours: (c) => c.setAuto(true) });
      expect(o.ours.tasks).toEqual(["reflog-expire foreground", "geometric-repack", "rerere-gc"]);
      const log = (twin: string) => readFileSync(join(caseDir, twin, "repo", "hook.log"), "utf8");
      expect(log("ours-run")).toBe(log("native-run"));
    });

    it25x('t7900-maintenance.sh: "pre-auto-gc hook can inhibit geometric strategy"', async () => {
      const { caseDir, r } = history("hook-inhibit");
      mkdirSync(join(r.gitDir, "hooks"), { recursive: true });
      writeFileSync(
        join(r.gitDir, "hooks", "pre-auto-gc"),
        "#!/bin/sh\necho hook >>hook.log\nexit 1\n",
        {
          mode: 0o755,
        },
      );
      r.git(["config", "maintenance.reflog-expire.auto", "-1"]);
      r.git(["config", "maintenance.geometric-repack.auto", "-1"]);
      r.git(["config", "maintenance.rerere-gc.auto", "-1"]);
      const o = await twins(caseDir, { args: ["--auto"], ours: (c) => c.setAuto(true) });
      expect(o.ours.tasks).toEqual([]);
    });

    it25x('t7900-maintenance.sh: "pre-auto-gc hook does not run without --auto"', async () => {
      // the 2.5x default (geometric) strategy, run whole
      const { caseDir } = history("default-strategy");
      await twins(caseDir, { args: [], ours: (c) => c, nativeOnly: REFLOG_EXPIRY_DEFAULTS });
    });
  });

  describe("commit-graph", () => {
    it('t7900-maintenance.sh: "commit-graph auto condition"', async () => {
      const { caseDir } = history("cg-auto");
      for (const limit of ["-1", "0", "1", "2", "3", "4", "5"])
        await twins(
          caseDir,
          {
            args: ["--task=commit-graph", "--auto", "--quiet"],
            ours: (c) => c.addTask("commit-graph").setAuto(true),
            config: { "maintenance.commit-graph.auto": limit },
          },
          `limit${limit}`,
        );
    });

    it('t7900-maintenance.sh: "commit-graph auto condition with merges"', async () => {
      const caseDir = newCase(root, "cg-merges");
      const r = initRepo(root, caseDir);
      r.commit("initial");
      r.git(["switch", "-q", "--create", "feature"]);
      r.commit("feature-1");
      r.commit("feature-2");
      r.git(["switch", "-q", "-"]);
      r.commit("main-1");
      r.commit("main-2");
      r.git(["merge", "-q", "--no-edit", "feature"]);
      for (const limit of ["6", "7"])
        await twins(
          caseDir,
          {
            args: ["--task=commit-graph", "--auto"],
            ours: (c) => c.addTask("commit-graph").setAuto(true),
            config: { "maintenance.commit-graph.auto": limit },
          },
          `limit${limit}`,
        );
    });
  });

  describe("prefetch", () => {
    it('t7900-maintenance.sh: "run --task=prefetch with no remotes"', async () => {
      const { caseDir } = history("prefetch-none");
      const o = await twins(caseDir, {
        args: ["--task=prefetch"],
        ours: (c) => c.addTask("prefetch"),
      });
      expect(o.ours.stderr).toBe("");
    });

    it('t7900-maintenance.sh: "prefetch multiple remotes"', async () => {
      const { caseDir, r } = history("prefetch-many");
      const src = join(caseDir, "src");
      for (const [clone, branch] of [
        ["clone1", "one"],
        ["clone2", "two"],
      ] as const) {
        r.git(["clone", "-q", "repo", clone], { cwd: src });
        r.git(["switch", "-q", "-c", branch], { cwd: join(src, clone) });
        r.commit(branch, { [`${branch}.t`]: `${branch}\n` }, undefined, join(src, clone));
        r.git(["remote", "add", `remote${clone.slice(-1)}`, `../${clone}`]);
      }
      // a fetch refspec of tags is dropped, a negative one kept
      r.git(["config", "--add", "remote.remote1.fetch", "+refs/tags/*:refs/tags/*"]);
      await twins(
        caseDir,
        { args: ["--task=prefetch"], ours: (c) => c.addTask("prefetch") },
        "all",
      );
      // fetch.pruneTags adds the tag refspec, which --prefetch drops: a local tag stays
      r.git(["config", "fetch.pruneTags", "true"]);
      r.git(["tag", "v-local"]);
      await twins(
        caseDir,
        { args: ["--task=prefetch"], ours: (c) => c.addTask("prefetch") },
        "prune-tags",
      );
      r.git(["config", "remote.remote1.skipFetchAll", "true"]);
      await twins(
        caseDir,
        { args: ["--task=prefetch"], ours: (c) => c.addTask("prefetch") },
        "skip",
      );
    });
  });

  describe("loose-objects", () => {
    it('t7900-maintenance.sh: "loose-objects task"', async () => {
      const { caseDir, r } = history("loose");
      r.git(["repack", "-adkq"]);
      r.commit("create-loose-object", { "loose.t": "loose\n" });
      const first = await twins(
        caseDir,
        { args: ["--task=loose-objects"], ours: (c) => c.addTask("loose-objects") },
        "first",
      );
      expect(first.ours.snapshot.packs.filter((p) => p.prefix === "loose")).toHaveLength(1);
      // the second run on the first one's result deletes the loose objects it packed
      rmSync(join(caseDir, "src"), { recursive: true });
      execCopy(join(caseDir, "native-first"), join(caseDir, "src"));
      const second = await twins(
        caseDir,
        { args: ["--task=loose-objects"], ours: (c) => c.addTask("loose-objects") },
        "second",
      );
      expect(second.ours.snapshot.loose).toEqual([]);
    });

    it('t7900-maintenance.sh: "maintenance.loose-objects.auto"', async () => {
      const { caseDir, r } = history("loose-auto");
      r.git(["repack", "-adkq"]);
      const run = (limit: string, name: string) =>
        twins(
          caseDir,
          {
            args: ["--auto", "--task=loose-objects"],
            ours: (c) => c.setAuto(true).addTask("loose-objects"),
            config: { "maintenance.loose-objects.auto": limit },
          },
          name,
        );
      await run("1", "none");
      r.blob("data-A");
      await run("2", "one");
      r.blob("data-B");
      await run("2", "two");
    });

    it25x('t7900-maintenance.sh: "maintenance.loose-objects.batchSize"', async () => {
      const { caseDir, r } = history("loose-batch");
      for (let i = 0; i < 8; i++) r.commit(`c${i}`, { [`${i}.t`]: `${i}\n` });
      r.git(["config", "maintenance.loose-objects.batchSize", "5"]);
      const o = await twins(caseDir, {
        args: ["--task=loose-objects"],
        ours: (c) => c.addTask("loose-objects"),
      });
      expect(o.ours.snapshot.packs.find((p) => p.prefix === "loose")?.ids).toHaveLength(5);
    });
  });

  describe("incremental-repack", () => {
    it('t7900-maintenance.sh: "incremental-repack task"', async () => {
      const caseDir = newCase(root, "incremental");
      const r = initRepo(root, caseDir);
      for (let i = 1; i <= 5; i++) r.commit(`${i}`, { [`${i}.t`]: `${i}\n`.repeat(200 * i) });
      const packDir = join(r.gitDir, "objects", "pack");
      mkdirSync(packDir, { recursive: true });
      r.git(["pack-objects", "-q", "--revs", join(packDir, "test-1")], { input: "HEAD~2\n" });
      r.git(["pack-objects", "-q", "--revs", join(packDir, "test-2")], {
        input: "HEAD~1\n^HEAD~2\n",
      });
      r.git(["pack-objects", "-q", "--revs", join(packDir, "test-3")], {
        input: "HEAD\n^HEAD~1\n",
      });
      r.git(["prune-packed"]);
      for (const [k, name] of ["test-1", "test-2", "test-3"].entries())
        for (const f of readdirSync(packDir))
          if (f.startsWith(name)) {
            const t = NOW - 10 * DAY + k * 3600;
            utimesSync(join(packDir, f), t, t);
          }
      const run = (name: string) =>
        twins(
          caseDir,
          { args: ["--task=incremental-repack"], ours: (c) => c.addTask("incremental-repack") },
          name,
        );
      const first = await run("first");
      expect(first.ours.snapshot.packs).toHaveLength(4);
      rmSync(join(caseDir, "src"), { recursive: true });
      execCopy(join(caseDir, "native-first"), join(caseDir, "src"));
      const second = await run("second");
      expect(second.ours.snapshot.packs).toHaveLength(2);
    });

    it('t7900-maintenance.sh: "maintenance.incremental-repack.auto"', async () => {
      const { caseDir, r } = history("incremental-auto");
      r.git(["repack", "-adq"]);
      stampNewPacks(r.gitDir, 0);
      r.git(["multi-pack-index", "write"]);
      for (let i = 0; i < 3; i++) {
        r.commit(`more${i}`, { [`m${i}.t`]: `${i}\n` });
        r.git(["repack", "-dq"]);
        stampNewPacks(r.gitDir, i + 1);
        for (const limit of ["1", "2", "3", "-1", "0"])
          await twins(
            caseDir,
            {
              args: ["--auto", "--task=incremental-repack"],
              ours: (c) => c.setAuto(true).addTask("incremental-repack"),
              config: { "maintenance.incremental-repack.auto": limit },
            },
            `${i}-${limit}`,
          );
      }
    });
  });

  describe("pack-refs and the 2.5x tasks", () => {
    it('t7900-maintenance.sh: "pack-refs task"', async () => {
      const { caseDir, r } = history("pack-refs");
      for (let n = 1; n <= 5; n++) r.git(["branch", "-f", `to-pack/${n}`, "HEAD"]);
      await twins(caseDir, { args: ["--task=pack-refs"], ours: (c) => c.addTask("pack-refs") });
    });

    it25x('t7900-maintenance.sh: "pack-refs task" with --auto', async () => {
      const { caseDir, r } = history("pack-refs-auto");
      for (const count of [5, 20]) {
        for (let n = 1; n <= count; n++) r.git(["branch", "-f", `to-pack/${count}-${n}`, "HEAD"]);
        await twins(
          caseDir,
          {
            args: ["--auto", "--task=pack-refs"],
            ours: (c) => c.setAuto(true).addTask("pack-refs"),
          },
          `n${count}`,
        );
      }
    });

    it25x(
      't7900-maintenance.sh: "reflog-expire task --auto only packs when exceeding limits"',
      async () => {
        const caseDir = newCase(root, "reflog-auto");
        const r = initRepo(root, caseDir);
        // dated as test_tick dates them (2005): older than every expiry
        r.commit("reflog-one", {}, 1112912053);
        r.commit("reflog-two", {}, 1112912113);
        for (const limit of ["3", "2"])
          await twins(
            caseDir,
            {
              args: ["--auto", "--task=reflog-expire"],
              ours: (c) => c.setAuto(true).addTask("reflog-expire"),
              config: { "maintenance.reflog-expire.auto": limit },
              nativeOnly: REFLOG_EXPIRY_DEFAULTS,
            },
            `limit${limit}`,
          );
      },
    );

    it25x(
      't7900-maintenance.sh: "worktree-prune task --auto only prunes with prunable worktree"',
      async () => {
        const { caseDir, r } = history("worktree-auto");
        await twins(
          caseDir,
          {
            args: ["--auto", "--task=worktree-prune"],
            ours: (c) => c.setAuto(true).addTask("worktree-prune"),
          },
          "none",
        );
        mkdirSync(join(r.gitDir, "worktrees"), { recursive: true });
        writeFileSync(join(r.gitDir, "worktrees", "abc"), "");
        await twins(
          caseDir,
          {
            args: ["--auto", "--task=worktree-prune"],
            ours: (c) => c.setAuto(true).addTask("worktree-prune"),
          },
          "one",
        );
      },
    );

    it25x('t7900-maintenance.sh: "worktree-prune task honors gc.worktreePruneExpire"', async () => {
      const { caseDir, r } = history("worktree-expire");
      r.git(["worktree", "add", "-q", "../worktree"]);
      rmSync(join(caseDir, "src", "worktree"), { recursive: true });
      for (const expire of ["1.week.ago", "now"])
        await twins(
          caseDir,
          {
            args: ["--auto", "--task=worktree-prune"],
            ours: (c) => c.setAuto(true).addTask("worktree-prune"),
            config: { "gc.worktreePruneExpire": expire },
          },
          expire,
        );
    });

    it25x(
      't7900-maintenance.sh: "rerere-gc task with --auto only prunes with stale entries"',
      async () => {
        const { caseDir, r } = history("rerere-auto");
        const zero = "0".repeat(37);
        const entries = ["171", "172", "173"].map((p) => join(r.gitDir, "rr-cache", `${p}${zero}`));
        for (const e of entries) {
          mkdirSync(e, { recursive: true });
          writeFileSync(join(e, "preimage"), "preimage\n");
        }
        const run = (name: string) =>
          twins(
            caseDir,
            {
              args: ["--auto", "--task=rerere-gc"],
              ours: (c) => c.setAuto(true).addTask("rerere-gc"),
            },
            name,
          );
        await run("fresh");
        const old = NOW - 16 * DAY;
        utimesSync(join(entries[0] as string, "preimage"), old, old);
        await run("one-stale");
        utimesSync(join(entries[1] as string, "preimage"), old, old);
        await run("two-stale");
      },
    );

    it25x(
      't7900-maintenance.sh: "geometric repacking task" in a precious-objects repository',
      async () => {
        const { caseDir, r } = history("geometric-precious");
        r.git(["repack", "-dq"]);
        r.commit("four", { "d.txt": "d\n".repeat(50) });
        r.git(["repack", "-dq"]);
        r.git(["config", "core.repositoryformatversion", "1"]);
        r.git(["config", "extensions.preciousObjects", "true"]);
        const o = await twins(caseDir, {
          args: ["--task=geometric-repack"],
          ours: (c) => c.addTask("geometric-repack"),
        });
        expect(o.ours.stderr).toBe("");
      },
    );

    it25x('t7900-maintenance.sh: "geometric repacking task"', async () => {
      const { caseDir, r } = history("geometric");
      r.git(["config", "maintenance.strategy", "geometric"]);
      r.git(["repack", "-dq"]);
      r.commit("four", { "d.txt": "d\n" });
      r.git(["repack", "-dq"]);
      r.commit("five", { "e.txt": "e\n" });
      await twins(caseDir, {
        args: ["--task=geometric-repack"],
        ours: (c) => c.addTask("geometric-repack"),
      });
    });
  });
});

/** `cp -a` of a twin into a new source directory (a second run starts from the first's result). */
function execCopy(from: string, to: string) {
  spawnSync("cp", ["-a", from, to]);
  for (const name of readdirSync(to)) if (name.endsWith(".json")) rmSync(join(to, name));
}

/**
 * Dates the pack files written since the last call (those younger than a day) `k` hours after
 * a fixed past time: packs written within one second would tie on mtime, and git orders packs
 * (and picks repack batches) by it.
 */
function stampNewPacks(gitDir: string, k: number) {
  const dir = join(gitDir, "objects", "pack");
  const t = NOW - 10 * DAY + k * 3600;
  for (const f of readdirSync(dir)) {
    const path = join(dir, f);
    if (statSync(path).mtimeMs / 1000 > NOW - DAY) utimesSync(path, t, t);
  }
}
