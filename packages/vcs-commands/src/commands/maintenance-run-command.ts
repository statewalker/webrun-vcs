import type { FilesApi, History, ObjectId } from "@statewalker/vcs-core";
import { objectFormatOf, writePack } from "@statewalker/vcs-core";
import {
  expireReflogs,
  FileRawStorage,
  geometricSplit,
  multiPackIndexExpire,
  multiPackIndexRepack,
  multiPackIndexWrite,
  packDeltaSearch,
  parseExpiryDate,
  prunePacked,
  readPackWriteSettings,
  readRepositoryFormat,
  rerereGc,
  rerereGcNeeded,
  writeCommitGraph,
} from "@statewalker/vcs-store-files";
import { parseGitBool } from "@statewalker/vcs-utils/encoding";
import { atomicFilesOver } from "@statewalker/vcs-utils/files";
import { GitApiError } from "../errors/index.js";
import { GuardedTransportCommand } from "../guarded-transport-command.js";
import { RemoteConfigStore } from "../remote-config/index.js";
import { FetchCommand, TagOption } from "./fetch-command.js";
import { GarbageCollectCommand } from "./gc-command.js";
import { hostEnvironmentOf } from "./git-ident.js";
import { objectsDirectoryDisplay } from "./object-store/objects-directory.js";
import { PlumbingError } from "./plumbing-command.js";
import { ReflogCommand } from "./reflog-command.js";
import { RepackCommand } from "./repack-command.js";
import { rerereGcLocation } from "./rerere.js";
import { WorktreePruneCommand } from "./worktree-prune-command.js";

/** git's maintenance tasks, in its task table's order (`tasks[]` of builtin/gc.c). */
export const MAINTENANCE_TASKS = [
  "prefetch",
  "loose-objects",
  "incremental-repack",
  "geometric-repack",
  "gc",
  "commit-graph",
  "pack-refs",
  "reflog-expire",
  "worktree-prune",
  "rerere-gc",
] as const;

export type MaintenanceTask = (typeof MAINTENANCE_TASKS)[number];

/** `--schedule=<frequency>` */
export type MaintenanceSchedule = "hourly" | "daily" | "weekly";

/** The tasks git 2.43 knows (the others are "not a valid task" there). */
const TASKS_243: readonly MaintenanceTask[] = [
  "prefetch",
  "loose-objects",
  "incremental-repack",
  "gc",
  "commit-graph",
  "pack-refs",
];

/** git's `enum schedule_priority`: none 0, weekly 1, daily 2, hourly 3. */
const PRIORITY: Record<MaintenanceSchedule, number> = { weekly: 1, daily: 2, hourly: 3 };

/** `MAINTENANCE_TYPE_SCHEDULED` and `MAINTENANCE_TYPE_MANUAL` */
const SCHEDULED = 1;
const MANUAL = 2;

type Strategy = Partial<Record<MaintenanceTask, { type: number; schedule: number }>>;

/** git 2.5x's maintenance strategies (`gc_strategy`, `incremental_strategy`, ...). */
const STRATEGIES: Record<string, Strategy> = {
  gc: { gc: { type: MANUAL | SCHEDULED, schedule: 2 } },
  incremental: {
    "commit-graph": { type: SCHEDULED, schedule: 3 },
    prefetch: { type: SCHEDULED, schedule: 3 },
    "incremental-repack": { type: SCHEDULED, schedule: 2 },
    "loose-objects": { type: SCHEDULED, schedule: 2 },
    "pack-refs": { type: SCHEDULED, schedule: 1 },
    gc: { type: MANUAL, schedule: 0 },
  },
  geometric: {
    "commit-graph": { type: SCHEDULED | MANUAL, schedule: 3 },
    "geometric-repack": { type: SCHEDULED | MANUAL, schedule: 2 },
    "pack-refs": { type: SCHEDULED | MANUAL, schedule: 2 },
    "rerere-gc": { type: SCHEDULED | MANUAL, schedule: 1 },
    "reflog-expire": { type: SCHEDULED | MANUAL, schedule: 1 },
    "worktree-prune": { type: SCHEDULED | MANUAL, schedule: 1 },
  },
};

/** The tasks git 2.5x runs before detaching (`foreground`), and after (`background`). */
const FOREGROUND = new Set<MaintenanceTask>(["gc", "pack-refs", "reflog-expire"]);
const BACKGROUND = new Set<MaintenanceTask>([
  "prefetch",
  "loose-objects",
  "incremental-repack",
  "geometric-repack",
  "gc",
  "commit-graph",
  "worktree-prune",
  "rerere-gc",
]);

/** How `git maintenance run` ended. */
export interface MaintenanceRunResult {
  /** git's exit status: 0, or 1 when a task failed */
  exitCode: number;
  /** git's stderr: warnings, the failing tasks' lines and `error: task '<t>' failed` */
  stderr: string;
  /**
   * The tasks run, in order, as git's trace2 names their regions: `<task>` (2.5x adds
   * `<task> foreground` for the part run before detaching: gc, pack-refs, reflog-expire)
   */
  tasks: string[];
  /** Whether another maintenance held `<objects>/maintenance.lock` (nothing was run) */
  locked?: boolean;
}

/** git's `git_config_int` over a value: k, m and g units; git dies on anything else. */
function configInt(store: RemoteConfigStore, key: string, fallback: number): number {
  const value = store.value(key);
  if (value === undefined) return fallback;
  const m = /^\s*([-+]?(?:0x[0-9a-f]+|\d+))\s*([kmg]?)\s*$/i.exec(value);
  if (!m) {
    throw new PlumbingError(
      `fatal: bad numeric config value '${value}' for '${key.toLowerCase()}': invalid unit`,
    );
  }
  const n = Number(m[1]);
  const unit = (m[2] ?? "").toLowerCase();
  return n * (unit === "k" ? 1024 : unit === "m" ? 1024 ** 2 : unit === "g" ? 1024 ** 3 : 1);
}

function configBool(store: RemoteConfigStore, key: string, fallback: boolean): boolean {
  const value = store.value(key);
  return value === undefined ? fallback : (parseGitBool(value) ?? fallback);
}

/**
 * `git maintenance run [--auto] [--task=<task>] [--schedule=<frequency>] [--[no-]quiet]`
 * (builtin/gc.c `maintenance_run`) over a files repository: the tasks selected (`--task`, in
 * the order given), else those the maintenance strategy and `maintenance.<task>.enabled` turn
 * on (`maintenance.strategy`, default `geometric` in git 2.5x and the gc task alone in 2.43;
 * with `--schedule` only the tasks whose `maintenance.<task>.schedule` is at least as frequent),
 * each under `<objects>/maintenance.lock`. With `--auto` a task runs only when its condition
 * holds (git's per-task thresholds: `maintenance.<task>.auto`, `gc.auto` for gc), and git 2.5x
 * asks the pre-auto-gc hook once first.
 *
 * The tasks: prefetch (`git fetch <remote> --prefetch --prune --no-tags
 * --no-write-fetch-head` for each remote), loose-objects (`prune-packed`, then the loose
 * objects into a `loose-<id>.pack`), incremental-repack (`multi-pack-index write`, `expire`,
 * `repack --batch-size`), geometric-repack (`repack --geometric` or an all-into-one repack with
 * a midx), gc (`git gc`), commit-graph (`commit-graph write --split --reachable`), pack-refs
 * (`pack-refs --all --prune`), reflog-expire (`reflog expire --all`), worktree-prune
 * (`worktree prune --expire <gc.worktreePruneExpire>`) and rerere-gc (`rerere gc`); the last
 * three and geometric-repack are git 2.5x's. git 2.43 (the hook runner's compatibility) runs
 * selected tasks in the reverse of the order given, as its `compare_tasks_by_selection` sorts.
 *
 * `--detach` and `register`/`start`/`stop` (which schedule runs with the operating system)
 * are left to the host: this command always runs in the foreground and quietly unless
 * {@link setQuiet} says otherwise (git is quiet when stderr is no terminal).
 *
 * @example
 * ```typescript
 * // git maintenance run --task=commit-graph --task=loose-objects
 * const { exitCode, tasks } = await git.maintenanceRun()
 *   .addTask("commit-graph").addTask("loose-objects").call();
 *
 * // git maintenance run --auto
 * await git.maintenanceRun().setAuto(true).call();
 * ```
 */
export class MaintenanceRunCommand extends GuardedTransportCommand<MaintenanceRunResult> {
  private selected: string[] = [];
  private auto = false;
  private schedule?: string;
  private quiet = true;
  private stderrLines: string[] = [];
  private ran: string[] = [];

  /** `--task=<task>`: run this task (repeatable; a task named twice is git's usage error). */
  addTask(task: MaintenanceTask | string): this {
    this.checkCallable();
    this.selected.push(task);
    return this;
  }

  /** `--auto`: run each task only when its condition says the repository needs it. */
  setAuto(auto: boolean): this {
    this.checkCallable();
    this.auto = auto;
    return this;
  }

  /** `--schedule=<frequency>`: the tasks scheduled at least this often. */
  setSchedule(schedule: MaintenanceSchedule | string): this {
    this.checkCallable();
    this.schedule = schedule;
    return this;
  }

  /** `--quiet` (default true, as git with stderr on no terminal) / `--no-quiet`. */
  setQuiet(quiet: boolean): this {
    this.checkCallable();
    this.quiet = quiet;
    return this;
  }

  private get v243(): boolean {
    return this.hooks.compatibility === "2.43";
  }

  private error(line: string): void {
    this.stderrLines.push(line);
  }

  /**
   * Runs the tasks.
   *
   * @throws PlumbingError for git's usage errors (an unknown or repeated task: 129; `--auto`
   *   or `--task` with `--schedule`, an unknown schedule or strategy: 128)
   */
  async call(): Promise<MaintenanceRunResult> {
    this.checkCallable();
    this.setCallable(false);
    const known = this.v243 ? TASKS_243 : MAINTENANCE_TASKS;
    const seen = new Set<string>();
    for (const task of this.selected) {
      const name = task.toLowerCase();
      if (!known.includes(name as MaintenanceTask))
        throw new PlumbingError(`error: '${task}' is not a valid task`, 129);
      if (seen.has(name))
        throw new PlumbingError(`error: task '${task}' cannot be selected multiple times`, 129);
      seen.add(name);
    }
    let schedule = 0;
    if (this.schedule !== undefined) {
      schedule = PRIORITY[this.schedule.toLowerCase() as MaintenanceSchedule] ?? 0;
      if (!schedule)
        throw new PlumbingError(`fatal: unrecognized --schedule argument '${this.schedule}'`);
    }
    if (this.auto && schedule) {
      throw new PlumbingError(
        this.v243
          ? "fatal: use at most one of --auto and --schedule=<frequency>"
          : "fatal: options '--auto' and '--schedule=' cannot be used together",
      );
    }
    if (!this.v243 && seen.size > 0 && schedule)
      throw new PlumbingError("fatal: options '--task=' and '--schedule=' cannot be used together");

    const store = RemoteConfigStore.from(this.workingCopy);
    const tasks = this.v243
      ? this.tasks243(store, [...seen] as MaintenanceTask[], schedule)
      : this.tasks256(store, [...seen] as MaintenanceTask[], schedule);

    const objects = await this.hooks.commonGitFile("objects");
    const history = this.workingCopy.history as History | undefined;
    if (!objects || !history?.objects || !history.packs)
      throw new GitApiError("git maintenance needs a files repository");
    const repo = {
      files: objects.files,
      objectsDir: objects.path,
      gitDir: objects.path.replace(/\/?objects$/, "") || ".",
      history: history as Repo["history"],
    };

    // maintenance_run_tasks: `<objects>/maintenance.lock`, held while the tasks run
    const atomic = atomicFilesOver(repo.files, repo.objectsDir);
    if (!(await atomic.createExclusive("maintenance.lock", new Uint8Array(0)))) {
      if (!this.auto && !this.quiet) {
        const display = await objectsDirectoryDisplay(this.hooks, this.workingCopy);
        this.error(`warning: lock file '${display}/maintenance' exists, skipping maintenance`);
      }
      return { exitCode: 0, stderr: this.stderrText(), tasks: [], locked: true };
    }
    let result = 0;
    try {
      // the pre-auto-gc hook: asked once, before the first task whose condition holds (2.5x)
      let hook: "undecided" | "run" | "skip" = "undecided";
      const runPhase = async (foreground: boolean | undefined) => {
        for (const task of tasks) {
          if (foreground === true && !FOREGROUND.has(task)) continue;
          if (foreground === false && !BACKGROUND.has(task)) continue;
          if (this.auto) {
            if (hook === "skip") continue;
            if (!(await this.autoCondition(task, store, repo))) continue;
            if (foreground !== undefined && hook === "undecided") {
              const r = await this.hooks.run("pre-auto-gc");
              hook = r && r.exitCode !== 0 ? "skip" : "run";
            }
            if (hook === "skip") continue;
          }
          this.ran.push(foreground ? `${task} foreground` : task);
          if (await this.runTask(task, foreground, store, repo)) {
            this.error(`error: task '${task}' failed`);
            result = 1;
          }
        }
      };
      if (this.v243) await runPhase(undefined);
      else {
        await runPhase(true);
        await runPhase(false);
      }
    } finally {
      await atomic.remove("maintenance.lock");
    }
    return { exitCode: result, stderr: this.stderrText(), tasks: this.ran };
  }

  private stderrText(): string {
    return this.stderrLines.map((l) => `${l}\n`).join("");
  }

  /** git 2.43's task list: selected (in reverse), else the enabled ones in table order. */
  private tasks243(
    store: RemoteConfigStore,
    selected: MaintenanceTask[],
    schedule: number,
  ): MaintenanceTask[] {
    const state = new Map<MaintenanceTask, { enabled: boolean; schedule: number }>();
    for (const t of TASKS_243) state.set(t, { enabled: t === "gc", schedule: 0 });
    if (schedule) {
      // initialize_maintenance_strategy: only "incremental" means anything to 2.43
      const strategy = store.value("maintenance.strategy");
      if (strategy?.toLowerCase() === "incremental") {
        for (const [t, s] of Object.entries(STRATEGIES.incremental as Strategy)) {
          const st = state.get(t as MaintenanceTask) as { enabled: boolean; schedule: number };
          if (t === "gc") st.schedule = 0;
          else {
            st.enabled = true;
            st.schedule = s.schedule;
          }
        }
      }
    }
    for (const t of TASKS_243) {
      const st = state.get(t) as { enabled: boolean; schedule: number };
      const enabled = store.value(`maintenance.${t}.enabled`);
      if (enabled !== undefined) st.enabled = parseGitBool(enabled) ?? st.enabled;
      const sched = store.value(`maintenance.${t}.schedule`);
      if (sched !== undefined)
        st.schedule = PRIORITY[sched.toLowerCase() as MaintenanceSchedule] ?? 0;
    }
    const list =
      selected.length > 0
        ? [...selected].reverse()
        : TASKS_243.filter((t) => state.get(t)?.enabled);
    return schedule ? list.filter((t) => (state.get(t)?.schedule ?? 0) >= schedule) : list;
  }

  /** git 2.5x's `initialize_task_config`. */
  private tasks256(
    store: RemoteConfigStore,
    selected: MaintenanceTask[],
    schedule: number,
  ): MaintenanceTask[] {
    if (selected.length > 0) return selected;
    const type = schedule ? SCHEDULED : MANUAL;
    let strategy: Strategy = schedule ? {} : (STRATEGIES.geometric as Strategy);
    const name = store.value("maintenance.strategy");
    if (name !== undefined) {
      const s = STRATEGIES[name.toLowerCase()];
      if (!s) throw new PlumbingError(`fatal: unknown maintenance strategy: '${name}'`);
      strategy = s;
    }
    const out: MaintenanceTask[] = [];
    for (const t of MAINTENANCE_TASKS) {
      let taskType = strategy[t]?.type ?? 0;
      let taskSchedule = strategy[t]?.schedule ?? 0;
      const enabled = store.value(`maintenance.${t}.enabled`);
      if (enabled !== undefined && parseGitBool(enabled) !== undefined)
        taskType = parseGitBool(enabled) ? type : 0;
      if (!(taskType & type)) continue;
      if (schedule) {
        const sched = store.value(`maintenance.${t}.schedule`);
        if (sched !== undefined)
          taskSchedule = PRIORITY[sched.toLowerCase() as MaintenanceSchedule] ?? 0;
        if (taskSchedule < schedule) continue;
      }
      out.push(t);
    }
    return out;
  }

  // ---------------------------------------------------------------- auto conditions

  private async autoCondition(
    task: MaintenanceTask,
    store: RemoteConfigStore,
    repo: Repo,
  ): Promise<boolean> {
    switch (task) {
      case "prefetch":
        return false;
      case "loose-objects": {
        const limit = configInt(store, "maintenance.loose-objects.auto", 100);
        if (!limit) return false;
        if (limit < 0) return true;
        return (await this.looseObjectIds(repo, limit)).length >= limit;
      }
      case "incremental-repack": {
        if (!configBool(store, "core.multiPackIndex", true)) return false;
        const limit = configInt(store, "maintenance.incremental-repack.auto", 10);
        if (!limit) return false;
        if (limit < 0) return true;
        const midx = await this.midxPackNames(repo);
        let count = 0;
        for (const p of await this.packFiles(repo)) if (!midx.has(p.name)) count++;
        return count >= limit;
      }
      case "geometric-repack": {
        const limit = configInt(store, "maintenance.geometric-repack.auto", 6700);
        if (!limit) return false;
        if (limit < 0) return true;
        const factor = configInt(store, "maintenance.geometric-repack.splitFactor", 2);
        if ((await this.geometry(repo, factor)).split > 0) return true;
        return this.tooManyLoose(repo, limit);
      }
      case "gc":
        return new GarbageCollectCommand(this.workingCopy).isAutoGcNeeded();
      case "commit-graph":
        return this.commitGraphNeeded(store, repo);
      case "pack-refs": {
        if (this.v243 || !this.refsStore.packRefs) return false;
        return (await this.refsStore.packRefs([], { all: true, auto: true, checkOnly: true })) > 0;
      }
      case "reflog-expire": {
        const limit = configInt(store, "maintenance.reflog-expire.auto", 100);
        if (!limit) return false;
        if (limit < 0) return true;
        const environment = hostEnvironmentOf(this.workingCopy);
        const r = await expireReflogs({
          files: repo.files,
          gitDir: repo.gitDir,
          refs: repo.history.refs,
          objects: repo.history.objects,
          names: ["HEAD"],
          dryRun: true,
          compatibility: this.hooks.compatibility,
          ...(environment ? { environment } : {}),
        });
        return r.pruned >= limit;
      }
      case "worktree-prune": {
        const limit = configInt(store, "maintenance.worktree-prune.auto", 1);
        if (limit <= 0) return limit < 0;
        const expire = store.value("gc.worktreePruneExpire") ?? "3.months.ago";
        try {
          parseExpiryDate(expire, Math.floor(Date.now() / 1000), "gc.worktreePruneExpire");
        } catch {
          return false;
        }
        if (!this.workingCopy.worktrees) return false;
        const { pruned } = await new WorktreePruneCommand(this.workingCopy)
          .setDryRun(true)
          .setExpire(expire)
          .call();
        return pruned.filter((p) => !/duplicate/.test(p.reason)).length >= limit;
      }
      case "rerere-gc": {
        const limit = configInt(store, "maintenance.rerere-gc.auto", 512);
        if (!limit) return false;
        if (limit < 0) return true;
        const location = await rerereGcLocation(this.workingCopy);
        if (!location) return false;
        const environment = hostEnvironmentOf(this.workingCopy);
        return rerereGcNeeded({ ...location, limit, ...(environment ? { environment } : {}) });
      }
    }
  }

  /** The loose object ids, in fan-out order, at most `limit` (git's for_each_loose_file). */
  private async looseObjectIds(repo: Repo, limit = Number.POSITIVE_INFINITY): Promise<ObjectId[]> {
    const storage = new FileRawStorage(repo.files, repo.objectsDir);
    const pattern = new RegExp(`^[0-9a-f]{${objectFormatOf(repo.history.objects).hexLength}}$`);
    const out: ObjectId[] = [];
    for await (const key of storage.keys()) {
      if (!pattern.test(key)) continue;
      out.push(key);
      if (out.length >= limit) break;
    }
    return out;
  }

  /** too_many_loose_objects: the `objects/17` estimate against the limit rounded up to 256. */
  private async tooManyLoose(repo: Repo, limit: number): Promise<boolean> {
    if (limit <= 0) return false;
    const loose = new RegExp(`^[0-9a-f]{${objectFormatOf(repo.history.objects).hexLength - 2}}$`);
    let n = 0;
    try {
      for await (const info of repo.files.list(`${repo.objectsDir}/17`))
        if (loose.test(info.name)) n++;
    } catch {
      // nothing to count
    }
    return n * 256 > Math.ceil(limit / 256) * 256;
  }

  /** The packs of `objects/pack` (an `.idx` with its `.pack`), with size, keep and cruft. */
  private async packFiles(repo: Repo): Promise<
    {
      name: string;
      size: number;
      mtime: number;
      keep: boolean;
      cruft: boolean;
      promisor: boolean;
    }[]
  > {
    const dir = `${repo.objectsDir}/pack`;
    const names = new Set<string>();
    try {
      for await (const info of repo.files.list(dir)) names.add(info.name);
    } catch {
      return [];
    }
    const out = [];
    for (const name of names) {
      if (!name.endsWith(".idx")) continue;
      const base = name.slice(0, -4);
      if (!names.has(`${base}.pack`)) continue;
      const st = await repo.files.stats(`${dir}/${base}.pack`);
      out.push({
        name: base,
        size: st?.size ?? 0,
        mtime: st?.lastModified ?? 0,
        keep: names.has(`${base}.keep`),
        cruft: names.has(`${base}.mtimes`),
        promisor: names.has(`${base}.promisor`),
      });
    }
    return out;
  }

  /** The base names of the packs the multi-pack-index covers (its PNAM chunk). */
  private async midxPackNames(repo: Repo): Promise<Set<string>> {
    const out = new Set<string>();
    const bytes = await readFileBytes(repo.files, `${repo.objectsDir}/pack/multi-pack-index`);
    if (bytes) for (const n of midxNames(bytes)) out.add(n.replace(/\.(idx|pack)$/, ""));
    return out;
  }

  /** pack_geometry_init and split: the packs that are neither kept, cruft nor promisor. */
  private async geometry(repo: Repo, factor: number): Promise<{ split: number; count: number }> {
    await repo.history.packs?.refresh();
    const packs = (await repo.history.packs?.packs()) ?? [];
    const files = await this.packFiles(repo);
    const byName = new Map(files.map((f) => [f.name, f]));
    const counts: number[] = [];
    for (const p of packs) {
      const f = byName.get((p as { name?: string }).name ?? `pack-${p.packId}`);
      if (!f || f.keep || f.cruft || f.promisor) continue;
      counts.push(p.count);
    }
    counts.sort((a, b) => a - b);
    return { split: geometricSplit(counts, factor), count: counts.length };
  }

  /** should_write_commit_graph: commits the refs reach outside the graph, up to the limit. */
  private async commitGraphNeeded(store: RemoteConfigStore, repo: Repo): Promise<boolean> {
    const limit = configInt(store, "maintenance.commit-graph.auto", 100);
    if (!limit) return false;
    if (limit < 0) return true;
    const graph = await repo.history.commitGraph?.get();
    const inGraph = (id: ObjectId) => graph?.has(id) ?? false;
    const resolver = this.revisionResolver();
    const seen = new Set<ObjectId>();
    let count = 0;
    for await (const ref of repo.history.refs.list("refs/")) {
      const resolved = await repo.history.refs.resolve(ref.name).catch(() => undefined);
      if (!resolved?.objectId) continue;
      const peeled = await resolver.peelTags(resolved.objectId).catch(() => undefined);
      if (peeled?.type !== "commit") continue;
      const tip = peeled.id;
      // 2.43 counts a ref's own commit even when seen already (measured against git 2.43.0:
      // a tip reached twice counts twice, and is then seen for the parent walks)
      if (seen.has(tip) && !this.v243) continue;
      seen.add(tip);
      if (inGraph(tip)) continue;
      if (++count >= limit) return true;
      const stack: ObjectId[] = [tip];
      while (stack.length > 0) {
        const id = stack.pop() as ObjectId;
        const parents = await repo.history.commits.getParents(id).catch(() => [] as ObjectId[]);
        for (const parent of parents) {
          if (inGraph(parent) || seen.has(parent)) continue;
          seen.add(parent);
          if (++count >= limit) return true;
          stack.push(parent);
        }
      }
    }
    return false;
  }

  // ---------------------------------------------------------------- tasks

  /** Runs one task (its part of `foreground` in 2.5x); true when it failed. */
  private async runTask(
    task: MaintenanceTask,
    foreground: boolean | undefined,
    store: RemoteConfigStore,
    repo: Repo,
  ): Promise<boolean> {
    switch (task) {
      case "prefetch":
        return this.prefetch(store);
      case "loose-objects":
        return this.looseObjects(store, repo);
      case "incremental-repack":
        return this.incrementalRepack(store, repo);
      case "geometric-repack":
        return this.geometricRepack(store, repo);
      case "gc":
        // 2.5x's foreground part is the gc's pack-refs and reflog expiry, which the gc run
        // in the background part does first as well (`gc --skip-foreground-tasks` after it)
        if (foreground) return false;
        return this.gc();
      case "commit-graph":
        return this.commitGraph(store, repo);
      case "pack-refs":
        return this.packRefs();
      case "reflog-expire":
        return this.reflogExpire();
      case "worktree-prune":
        return this.worktreePrune(store);
      case "rerere-gc":
        return this.rerereGc();
    }
  }

  /** maintenance_task_prefetch: `git fetch <remote> --prefetch ...` per remote, stopping at a failure. */
  private async prefetch(store: RemoteConfigStore): Promise<boolean> {
    // remote.c's skip_default_update: remote.<name>.skipDefaultUpdate / skipFetchAll, the last wins
    const names = store.configuredNames().filter((name) => {
      const value = store.lastValueOf([
        `remote.${name}.skipDefaultUpdate`,
        `remote.${name}.skipFetchAll`,
      ]);
      return !(value !== undefined && parseGitBool(value) === true);
    });
    this.resolveAuth(
      names.map((n) => store.remoteUrlOf(n)),
      store.urlFor(store.remoteForBranch(undefined)),
    );
    for (const name of names) {
      const fetch = this.configureChild(new FetchCommand(this._workingCopy));
      fetch
        .setRemote(name)
        .setPrefetch(true)
        .setRemoveDeletedRefs(true)
        .setTagOpt(TagOption.NO_TAGS)
        .setWriteFetchHead(false)
        .setRecurseSubmodules(false)
        .setWriteCommitGraph(false)
        .setReflogAction(
          `fetch ${name} --prefetch --prune --no-tags --no-write-fetch-head --recurse-submodules=no${this.quiet ? " --quiet" : ""}`,
        );
      if (this.quiet) fetch.setQuiet(true);
      try {
        const r = await fetch.call();
        if ((r.errors?.length ?? 0) > 0) {
          for (const line of r.errors ?? []) this.error(line);
          this.error("error: failed to prefetch remotes");
          return true;
        }
      } catch (e) {
        if (!(e instanceof Error)) throw e;
        for (const line of e.message.split("\n")) if (line) this.error(line);
        this.error("error: failed to prefetch remotes");
        return true;
      }
    }
    return false;
  }

  /** maintenance_task_loose_objects: prune-packed, then pack_loose. */
  private async looseObjects(store: RemoteConfigStore, repo: Repo): Promise<boolean> {
    const { history } = repo;
    const packs = history.packs as NonNullable<History["packs"]>;
    const storage = new FileRawStorage(repo.files, repo.objectsDir);
    const format = objectFormatOf(history.objects);
    const alternates = (await history.objects.alternates?.list()) ?? [];
    await packs.refresh();
    await prunePacked(storage, packs, format, alternates);
    // pack_loose: at most maintenance.loose-objects.batchSize (2.5x; 0 unlimited) objects
    let batch = 50000;
    if (!this.v243) {
      batch = configInt(store, "maintenance.loose-objects.batchSize", 50000);
      if (batch === 0) batch = Number.POSITIVE_INFINITY;
    }
    const ids = await this.looseObjectIds(repo, batch);
    if (ids.length === 0) return false;
    const environment = hostEnvironmentOf(this.workingCopy);
    const settings = await readPackWriteSettings(repo.files, repo.gitDir, {
      ...(environment ? { environment } : {}),
    });
    await packs.install(
      writePack(history.objects, ids, {
        packs,
        reuseObjects: true,
        reuseDeltas: true,
        deltaSearch: packDeltaSearch(settings, undefined),
        ...(settings.compression !== undefined ? { compression: settings.compression } : {}),
      }),
      { writeReverseIndex: settings.writeReverseIndex, namePrefix: "loose" },
    );
    await packs.refresh();
    return false;
  }

  /** maintenance_task_incremental_repack: midx write, expire, then repack in a batch. */
  private async incrementalRepack(store: RemoteConfigStore, repo: Repo): Promise<boolean> {
    if (!configBool(store, "core.multiPackIndex", true)) {
      this.error(
        "warning: skipping incremental-repack task because core.multiPackIndex is disabled",
      );
      return false;
    }
    const environment = hostEnvironmentOf(this.workingCopy);
    const common = {
      files: repo.files,
      gitDir: repo.gitDir,
      compatibility: this.hooks.compatibility,
      ...(environment ? { environment } : {}),
    };
    const step = async (
      run: () => Promise<{ exitCode: number; stderr: string[] }>,
      failure: string,
    ) => {
      const r = await run();
      for (const line of r.stderr) this.error(line);
      if (r.exitCode !== 0) {
        this.error(`error: ${failure}`);
        return true;
      }
      return false;
    };
    const refresh = async () => {
      await repo.history.packs?.refresh();
    };
    if (await step(() => multiPackIndexWrite(common), "failed to write multi-pack-index"))
      return true;
    await refresh();
    if (await step(() => multiPackIndexExpire(common), "'git multi-pack-index expire' failed"))
      return true;
    await refresh();
    // get_auto_pack_size: one more than the second largest pack, at most 2 GiB
    let max = 0;
    let second = 0;
    for (const p of await this.packFiles(repo)) {
      if (p.size > max) {
        second = max;
        max = p.size;
      } else if (p.size > second) second = p.size;
    }
    const batchSize = Math.min(second + 1, 2 ** 31 - 1);
    if (
      await step(
        () => multiPackIndexRepack({ ...common, batchSize }),
        "'git multi-pack-index repack' failed",
      )
    )
      return true;
    await refresh();
    return false;
  }

  /** maintenance_task_geometric_repack (odb_source_files_optimize, ODB_OPTIMIZE_GEOMETRIC). */
  private async geometricRepack(store: RemoteConfigStore, repo: Repo): Promise<boolean> {
    // odb_source_files_optimize: nothing in a precious-objects repository
    if ((await readRepositoryFormat(repo.files, repo.gitDir)).preciousObjects) return false;
    const factor = configInt(store, "maintenance.geometric-repack.splitFactor", 2);
    const { split, count } = await this.geometry(repo, factor);
    const repack = new RepackCommand(this.workingCopy).shareHooksOf(this);
    repack.setDeleteRedundant(true).setLocal(true).setQuiet(this.quiet);
    if (split < count) repack.setGeometric(factor);
    else this.repackAllOption(store, repack);
    if (configBool(store, "core.multiPackIndex", true)) repack.setWriteMidx(true);
    try {
      await repack.call();
    } catch (e) {
      if (!(e instanceof Error)) throw e;
      for (const line of e.message.split("\n")) if (line) this.error(line);
      this.error("error: failed to run repack");
      return true;
    }
    return false;
  }

  /** add_repack_all_option: `-a` for `gc.pruneExpire=now`, else `--cruft` or `-A`. */
  private repackAllOption(store: RemoteConfigStore, repack: RepackCommand): void {
    const prune = store.value("gc.pruneExpire") ?? "2.weeks.ago";
    const cruft = configBool(store, "gc.cruftPacks", true);
    if (prune === "now") repack.setAll(true);
    else if (cruft) {
      repack.setCruft(true).setCruftExpiration(prune);
      const max = store.value("gc.maxCruftSize");
      if (max !== undefined) repack.setMaxCruftSize(configInt(store, "gc.maxCruftSize", 0));
    } else repack.setLoosenUnreachable(true).setUnpackUnreachable(prune);
  }

  /** maintenance_task_gc: `git gc [--auto] --quiet`. */
  private async gc(): Promise<boolean> {
    const gc = new GarbageCollectCommand(this.workingCopy).shareHooksOf(this);
    gc.setAuto(this.auto).setQuiet(this.quiet);
    try {
      const r = await gc.call();
      for (const line of r.errors ?? []) this.error(line);
      for (const line of r.warnings ?? []) this.error(`warning: ${line.replace(/^warning: /, "")}`);
    } catch (e) {
      if (!(e instanceof Error)) throw e;
      for (const line of e.message.split("\n")) if (line) this.error(line);
      return true;
    }
    return false;
  }

  /** maintenance_task_commit_graph: `commit-graph write --split --reachable`. */
  private async commitGraph(store: RemoteConfigStore, repo: Repo): Promise<boolean> {
    if (!configBool(store, "core.commitGraph", true)) return false;
    const environment = hostEnvironmentOf(this.workingCopy);
    try {
      await writeCommitGraph({
        files: repo.files,
        gitDir: repo.gitDir,
        objects: repo.history.objects,
        refs: repo.history.refs,
        commitGraph: repo.history.commitGraph,
        split: true,
        ...(environment ? { environment } : {}),
      });
      repo.history.commitGraph?.invalidate();
    } catch (e) {
      if (!(e instanceof Error)) throw e;
      this.error(`error: ${e.message}`);
      this.error("error: failed to write commit-graph");
      return true;
    }
    return false;
  }

  /** maintenance_task_pack_refs: `pack-refs --all --prune [--auto]`. */
  private async packRefs(): Promise<boolean> {
    if (!this.refsStore.packRefs) return false;
    await this.refsStore.packRefs([], {
      all: true,
      deleteLoose: true,
      ...(this.auto ? { auto: true } : {}),
      onError: (line) => this.error(line),
    });
    return false;
  }

  /** maintenance_task_reflog_expire: `reflog expire --all`. */
  private async reflogExpire(): Promise<boolean> {
    const r = await new ReflogCommand(this.workingCopy).setAll(true).callExpire();
    for (const line of r.errors ?? []) this.error(line);
    return r.status !== 0;
  }

  /** maintenance_task_worktree_prune: `worktree prune --expire <gc.worktreePruneExpire>`. */
  private async worktreePrune(store: RemoteConfigStore): Promise<boolean> {
    if (!this.workingCopy.worktrees) return false;
    const expire = store.value("gc.worktreePruneExpire") ?? "3.months.ago";
    await new WorktreePruneCommand(this.workingCopy).setExpire(expire).call();
    return false;
  }

  /** maintenance_task_rerere_gc: `rerere gc`. */
  private async rerereGc(): Promise<boolean> {
    const location = await rerereGcLocation(this.workingCopy);
    if (!location) return false;
    const environment = hostEnvironmentOf(this.workingCopy);
    await rerereGc({ ...location, ...(environment ? { environment } : {}) });
    return false;
  }
}

interface Repo {
  files: FilesApi;
  objectsDir: string;
  gitDir: string;
  history: History & {
    objects: NonNullable<History["objects"]>;
    packs: NonNullable<History["packs"]>;
  };
}

async function readFileBytes(files: FilesApi, path: string): Promise<Uint8Array | undefined> {
  if ((await files.stats(path))?.kind !== "file") return undefined;
  const parts: Uint8Array[] = [];
  let n = 0;
  for await (const c of files.read(path)) {
    parts.push(c);
    n += c.length;
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** The pack names of a multi-pack-index's PNAM chunk. */
function midxNames(bytes: Uint8Array): string[] {
  if (bytes.length < 12) return [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks = bytes[6] as number;
  for (let i = 0; i < chunks; i++) {
    const at = 12 + i * 12;
    if (at + 24 > bytes.length) return [];
    const id = String.fromCharCode(...bytes.subarray(at, at + 4));
    if (id !== "PNAM") continue;
    const start = Number(view.getBigUint64(at + 4));
    const end = Number(view.getBigUint64(at + 16));
    if (start > end || end > bytes.length) return [];
    return new TextDecoder()
      .decode(bytes.subarray(start, end))
      .split("\0")
      .filter((n) => n.length > 0);
  }
  return [];
}
