/**
 * `git fetch --recurse-submodules` (submodule.c `fetch_submodules`,
 * `calculate_changed_submodule_paths`, `collect_changed_submodules`, `get_next_submodule`,
 * `fetch_finish`): after the superproject's fetch, which submodules are fetched, in git's
 * order, with git's lines. The fetches themselves are the caller's (a `FetchCommand` in the
 * submodule, given by {@link SubmoduleFetchOptions.runFetch}), so this module knows nothing
 * of transports or credentials.
 *
 * Submodules are fetched one after another: git's `submodule.fetchJobs` / `-j` only change
 * how many run at once, and with one job git's output is this order.
 */
import { FileMode, type ObjectId } from "@statewalker/vcs-core";
import { parseGitBool } from "@statewalker/vcs-utils";
import type { WorkingCopy } from "@statewalker/vcs-working-tree";

import { GitApiError } from "../errors/index.js";
import { GitCommand } from "../git-command.js";
import { RemoteConfigStore } from "../remote-config/index.js";
import type { FetchResult } from "../results/fetch-result.js";
import {
  defaultRemoteOf,
  isRelativeSubmoduleUrl,
  joinFilesPath,
  remoteFromUrl,
  resolveRelativeUrl,
  SubmoduleModel,
  type SubmoduleSettings,
  validateSubmodulePath,
} from "./submodule-model.js";

/**
 * How far a fetch recurses into submodules (git's `RECURSE_SUBMODULES_ON`, `_ON_DEMAND`,
 * `_OFF`): every populated submodule, only those whose recorded commits the fetch brought
 * changes to, or none.
 */
export type FetchRecurseSubmodules = "yes" | "on-demand" | "no";

/**
 * git's `parse_fetch_recurse_submodules_arg`: a boolean, or `on-demand`; anything else dies
 * `bad <key> argument: <value>`. A variable without a value is true.
 */
export function parseFetchRecurseSubmodules(
  key: string,
  value: string | undefined,
): FetchRecurseSubmodules {
  if (value === undefined) return "yes";
  const bool = parseGitBool(value);
  if (bool !== undefined) return bool ? "yes" : "no";
  if (value === "on-demand") return "on-demand";
  throw new GitApiError(`fatal: bad ${key} argument: ${value}`, { exitCode: 128 });
}

/** One fetch {@link fetchSubmodules} asks for (git's child `git fetch`). */
export interface SubmoduleFetchTask {
  /** The submodule's repository */
  workingCopy: WorkingCopy;
  /** `--recurse-submodules-default`: the child's own default */
  defaultMode: "yes" | "on-demand";
  /** `--submodule-prefix` of the child: the path its nested submodules are shown under */
  prefix: string;
  /** For the fetch of missing commits: the remote and the commits named on its command line */
  remote?: string;
  commits?: ObjectId[];
}

/** What a submodule's fetch did: git's stderr text and whether it exited 0. */
export interface SubmoduleFetchRun {
  text: string;
  ok: boolean;
  result?: FetchResult;
}

/** What {@link fetchSubmodules} needs from the superproject's fetch. */
export interface SubmoduleFetchOptions {
  /** `config.recurse_submodules` (the command line, else the configuration); undefined: none */
  commandLine?: FetchRecurseSubmodules;
  /** `--recurse-submodules-default` (on-demand for a fetch run by hand) */
  defaultMode: "yes" | "on-demand";
  /** `--submodule-prefix` */
  prefix: string;
  /** `-q`: no `Fetching submodule` lines */
  quiet: boolean;
  /** Every ref's value before the fetch stored its refs (`ref_tips_before_fetch`) */
  tipsBefore: readonly ObjectId[];
  /** The ref map's new values (`ref_tips_after_fetch`) */
  tipsAfter: readonly ObjectId[];
  compatibility: "2.43" | "2.56";
  /** Runs one child fetch */
  runFetch(task: SubmoduleFetchTask): Promise<SubmoduleFetchRun>;
}

/** What the recursion printed (git's stderr), whether it failed, and each child's result. */
export interface SubmoduleFetchOutcome {
  output: string;
  failed: boolean;
  /** The results by submodule path (the first fetch of each) */
  results: Map<string, FetchResult>;
}

/** A submodule whose recorded commit changed in the fetched history (`changed_submodule_data`). */
interface ChangedSubmodule {
  name: string;
  /** The first superproject commit of the walk that records it */
  superOid: ObjectId;
  path: string;
  commits: ObjectId[];
}

/** A fetch to run (`struct fetch_task`). */
interface Task {
  sub: SubmoduleSettings & { path: string };
  workingCopy: WorkingCopy;
  defaultMode: "yes" | "on-demand";
  /** The changed-submodule data once the commits are still missing after the first fetch */
  commits?: ObjectId[];
}

const GITLINK = FileMode.GITLINK as number;
const TREE = FileMode.TREE as number;

/**
 * The repository questions the recursion asks, as git's `the_repository` and the submodule
 * repositories answer them.
 *
 * @internal
 */
export class SubmoduleFetchRepository extends GitCommand<never> {
  async call(): Promise<never> {
    throw new Error("not callable");
  }

  /** Every ref's value under `refs/` (`refs_for_each_ref`), symbolic refs resolved. */
  async refTips(): Promise<Map<string, ObjectId>> {
    const out = new Map<string, ObjectId>();
    for await (const ref of this.refsStore.list("refs/")) {
      const direct = ref as { objectId?: ObjectId; target?: string };
      const value =
        direct.objectId && direct.target === undefined
          ? direct.objectId
          : (await this.refsStore.resolve(ref.name).catch(() => undefined))?.objectId;
      if (value) out.set(ref.name, value);
    }
    return out;
  }

  /** HEAD's commit, if any. */
  async head(): Promise<ObjectId | undefined> {
    return (await this.refsStore.resolve("HEAD").catch(() => undefined))?.objectId;
  }

  /** The commit an id names through tags, undefined for anything else. */
  async peelToCommit(id: ObjectId): Promise<ObjectId | undefined> {
    let oid = id;
    const tags = this.tagsStore;
    for (let depth = 0; depth < 32; depth++) {
      if (await this.commits.has(oid).catch(() => false)) return oid;
      if (!tags || !(await tags.has(oid).catch(() => false))) return undefined;
      const target = await tags.getTarget(oid).catch(() => undefined);
      if (!target) return undefined;
      oid = target;
    }
    return undefined;
  }

  async hasCommit(id: ObjectId): Promise<boolean> {
    return this.commits.has(id).catch(() => false);
  }

  private async commit(id: ObjectId) {
    return this.commits.load(id).catch(() => undefined);
  }

  /**
   * The commits `include --not exclude` lists, in the order git's default (limited) revision
   * walk returns them: commits popped newest first by committer date, those an excluded
   * commit reaches dropped.
   */
  async walk(include: readonly ObjectId[], exclude: readonly ObjectId[]): Promise<ObjectId[]> {
    const uninteresting = new Set<ObjectId>();
    const seen = new Set<ObjectId>();
    const parentsOf = new Map<ObjectId, ObjectId[]>();
    const queue: { id: ObjectId; date: number; seq: number }[] = [];
    let seq = 0;
    const dateOf = async (id: ObjectId) => (await this.commit(id))?.committer.timestamp ?? 0;
    const push = async (id: ObjectId) => {
      const entry = { id, date: await dateOf(id), seq: seq++ };
      // commit_list_insert_by_date: after every entry of the same date
      let at = queue.length;
      while (at > 0 && (queue[at - 1] as { date: number }).date < entry.date) at--;
      queue.splice(at, 0, entry);
    };
    const markUninteresting = (id: ObjectId) => {
      const stack = [id];
      while (stack.length > 0) {
        const oid = stack.pop() as ObjectId;
        if (uninteresting.has(oid)) continue;
        uninteresting.add(oid);
        for (const p of parentsOf.get(oid) ?? []) stack.push(p);
      }
    };
    const tips = async (ids: readonly ObjectId[], bad: boolean) => {
      for (const id of [...new Set(ids)].sort()) {
        const commit = await this.peelToCommit(id);
        if (!commit) continue;
        if (bad) uninteresting.add(commit);
        if (seen.has(commit)) continue;
        seen.add(commit);
        await push(commit);
      }
    };
    await tips(exclude, true);
    await tips(include, false);
    const order: ObjectId[] = [];
    while (queue.length > 0) {
      if (queue.every((e) => uninteresting.has(e.id))) break;
      const { id } = queue.shift() as { id: ObjectId };
      const parents = (await this.commit(id))?.parents ?? [];
      parentsOf.set(id, parents);
      const bad = uninteresting.has(id);
      for (const p of parents) {
        if (bad) markUninteresting(p);
        if (seen.has(p)) continue;
        seen.add(p);
        await push(p);
      }
      if (!bad) order.push(id);
    }
    return order.filter((id) => !uninteresting.has(id));
  }

  /**
   * The gitlinks a commit's combined diff against its parents records (`diff_tree_combined`):
   * none for a root commit; for a merge, the paths that differ from every parent.
   */
  async changedGitlinks(id: ObjectId): Promise<Map<string, ObjectId>> {
    const commit = await this.commit(id);
    if (!commit || commit.parents.length === 0) return new Map();
    let result: Map<string, ObjectId> | undefined;
    for (const parent of commit.parents) {
      const tree = (await this.commit(parent))?.tree;
      const changed = new Map<string, ObjectId>();
      await this.diffGitlinks(commit.tree, tree, "", changed);
      if (result === undefined) result = changed;
      else for (const path of [...result.keys()]) if (!changed.has(path)) result.delete(path);
    }
    return result ?? new Map();
  }

  private async entries(tree: ObjectId | undefined) {
    const out = new Map<string, { mode: number; id: ObjectId }>();
    if (tree === undefined) return out;
    const entries = await this.trees.load(tree).catch(() => undefined);
    if (!entries) return out;
    for await (const e of entries) out.set(e.name, { mode: e.mode as number, id: e.id });
    return out;
  }

  private async diffGitlinks(
    next: ObjectId,
    previous: ObjectId | undefined,
    prefix: string,
    out: Map<string, ObjectId>,
  ): Promise<void> {
    if (next === previous) return;
    const nextEntries = await this.entries(next);
    const previousEntries = await this.entries(previous);
    for (const [name, entry] of nextEntries) {
      const old = previousEntries.get(name);
      if (entry.mode === TREE) {
        if (old?.mode === TREE && old.id === entry.id) continue;
        await this.diffGitlinks(
          entry.id,
          old?.mode === TREE ? old.id : undefined,
          `${prefix}${name}/`,
          out,
        );
      } else if (entry.mode === GITLINK) {
        if (old && old.mode === GITLINK && old.id === entry.id) continue;
        out.set(`${prefix}${name}`, entry.id);
      }
    }
  }

  /** Whether every commit exists here and a ref (or HEAD) reaches it (`rev-list --not --all`). */
  async reachesAll(commits: readonly ObjectId[]): Promise<boolean> {
    const wanted = new Set(commits);
    for (const id of wanted) if (!(await this.hasCommit(id))) return false;
    const tips = [...(await this.refTips()).values()];
    const head = await this.head();
    if (head) tips.push(head);
    const seen = new Set<ObjectId>();
    const stack: ObjectId[] = [];
    for (const tip of tips) {
      const commit = await this.peelToCommit(tip);
      if (commit) stack.push(commit);
    }
    while (stack.length > 0 && wanted.size > 0) {
      const oid = stack.pop() as ObjectId;
      if (seen.has(oid)) continue;
      seen.add(oid);
      wanted.delete(oid);
      for (const p of (await this.commit(oid))?.parents ?? []) if (!seen.has(p)) stack.push(p);
    }
    return wanted.size === 0;
  }

  /** git's DEFAULT_ABBREV abbreviation of an id of this repository. */
  abbreviate(id: ObjectId): Promise<string> {
    return this.abbreviateObjectId(id);
  }

  /** The gitlinks of the index, in index order (`cache_nr` loop). */
  async indexGitlinks(): Promise<string[]> {
    const out: string[] = [];
    for await (const entry of this.staging.entries()) {
      if (entry.mode === FileMode.GITLINK) out.push(entry.path);
    }
    return out;
  }

  /** `is_submodule_populated_gently`: `<path>/.git` names a repository. */
  async populated(path: string): Promise<boolean> {
    return (await this.worktreeAccess?.isRepository?.(path).catch(() => false)) ?? false;
  }

  /** `is_empty_dir(<worktree>/<path>/)`: a directory without entries (missing: not empty). */
  async emptyDirectory(path: string): Promise<boolean> {
    const worktree = this.worktreeAccess;
    const files = worktree?.getFiles?.();
    if (!worktree || !files) return false;
    const full = joinFilesPath(worktree.getRoot(), path);
    const stats = await files.stats(full).catch(() => undefined);
    if (stats?.kind !== "directory") return false;
    for await (const _ of files.list(full)) return false;
    return true;
  }

  /** Whether `<git dir>/modules/` exists and holds something (`repo_has_absorbed_submodules`). */
  async hasAbsorbedSubmodules(): Promise<boolean> {
    const worktree = this.worktreeAccess;
    const files = worktree?.getFiles?.();
    const gitDir = worktree?.getGitDir?.();
    if (!files || gitDir === undefined) return false;
    const modules = `${gitDir}/modules`;
    if ((await files.stats(modules).catch(() => undefined))?.kind !== "directory") return false;
    for await (const _ of files.list(modules)) return true;
    return false;
  }

  /** The submodule's repository (`repo_submodule_init`: `<path>/.git`, else `modules/<name>`). */
  async open(path: string, name: string | undefined): Promise<WorkingCopy | undefined> {
    return this.worktreeAccess
      ?.openGitlink?.(path, name !== undefined ? { name } : {})
      .catch(() => undefined);
  }

  hasWorktree(): boolean {
    return this.worktreeAccess !== undefined;
  }
}

/**
 * submodule.c's `fetch_submodules`: the submodules to fetch, each fetched (see the module's
 * notes), and git's lines: `Fetching submodule <prefix><path>` before each fetch of the
 * index's submodules, `... at commit <abbrev>` for one only the fetched history records,
 * `Could not access submodule ...`, a second fetch of the recorded commits still missing
 * (`<remote> <commit>...`), and `Errors during submodule fetch:` with each failed one.
 *
 * @throws GitApiError where git dies (a symlinked submodule path, a bad
 * `submodule.<name>.fetchRecurseSubmodules`)
 */
export async function fetchSubmodules(
  workingCopy: WorkingCopy,
  options: SubmoduleFetchOptions,
): Promise<SubmoduleFetchOutcome> {
  const repo = new SubmoduleFetchRepository(workingCopy);
  const outcome: SubmoduleFetchOutcome = { output: "", failed: false, results: new Map() };
  if (!repo.hasWorktree()) return outcome;
  const model = await SubmoduleModel.load(workingCopy);
  const modelsAt = new Map<ObjectId, Promise<SubmoduleModel>>();
  const modelAt = (commit: ObjectId) => {
    let found = modelsAt.get(commit);
    if (!found) {
      found = SubmoduleModel.load(workingCopy, { commit });
      modelsAt.set(commit, found);
    }
    return found;
  };

  const changed = await calculateChanged(repo, model, modelAt, options, outcome);
  const changedByName = new Map(changed.map((c) => [c.name, c]));
  const seen = new Set<string>();
  const failures: string[] = [];
  const pending: Task[] = [];

  /** `get_fetch_recurse_config` */
  const recurseOf = (
    sub: SubmoduleSettings,
    gitmodules: boolean,
  ): FetchRecurseSubmodules | "default" => {
    if (options.commandLine !== undefined) return options.commandLine;
    const key = `submodule.${sub.name}.fetchRecurseSubmodules`;
    const configured = model.configText(key);
    // a submodule .gitmodules does not name has fetch_recurse 0 (off), not "none"
    let value: FetchRecurseSubmodules | undefined = gitmodules
      ? recurseFromSettings(sub.fetchRecurseSubmodules)
      : "no";
    if (configured !== undefined) {
      value = parseFetchRecurseSubmodules(key, configured === null ? undefined : configured);
    }
    return value ?? options.defaultMode;
  };

  /** `fetch_task_create`: the task, or undefined when the submodule is not fetched. */
  const createTask = async (
    path: string,
    subModel: SubmoduleModel,
  ): Promise<{ task?: Task; noRepository?: boolean } | undefined> => {
    const refusal = await validateSubmodulePath(workingCopy, path);
    if (refusal !== undefined) throw new GitApiError(refusal, { exitCode: 128 });
    let sub = subModel.fromPath(path);
    let fromGitmodules = true;
    if (!sub) {
      if (!(await repo.populated(path))) return undefined;
      sub = { name: path, path };
      fromGitmodules = false;
    }
    if (seen.has(sub.name)) return undefined;
    let defaultMode: "yes" | "on-demand";
    switch (recurseOf(sub, fromGitmodules)) {
      case "no":
        return undefined;
      case "yes":
        defaultMode = "yes";
        break;
      default:
        if (!changedByName.has(sub.name)) return undefined;
        defaultMode = "on-demand";
    }
    const inner = await repo.open(path, sub.name);
    const subWithPath = { ...sub, path: sub.path ?? path };
    if (!inner) return { noRepository: true };
    return { task: { sub: subWithPath, workingCopy: inner, defaultMode } };
  };

  /**
   * The child runs in the submodule's git directory: without `--work-tree=.` (a task of the
   * index, a fetch by commit id) git first enters its `core.worktree`, and dies when that is
   * gone (a submodule whose worktree was removed while its repository stayed).
   */
  const runFetch = async (fetchTask: SubmoduleFetchTask, workTreeDot: boolean) => {
    if (!workTreeDot) {
      const failure = await chdirFailure(fetchTask.workingCopy);
      if (failure !== undefined) return { text: `${failure}\n`, ok: false };
    }
    return options.runFetch(fetchTask);
  };

  const run = async (task: Task, workTreeDot: boolean) => {
    seen.add(task.sub.name);
    const done: SubmoduleFetchRun = await runFetch(
      {
        workingCopy: task.workingCopy,
        defaultMode: task.defaultMode,
        prefix: `${options.prefix}${task.sub.path}/`,
      },
      workTreeDot,
    );
    outcome.output += done.text;
    if (done.result && !outcome.results.has(task.sub.path)) {
      outcome.results.set(task.sub.path, done.result);
    }
    await finish(task, done.ok);
  };

  /** `fetch_finish` */
  const finish = async (task: Task, ok: boolean) => {
    if (!ok) {
      outcome.failed = true;
      failures.push(task.sub.name);
    }
    if (task.commits) return;
    const data = changedByName.get(task.sub.name);
    if (!data) return;
    const inner = new SubmoduleFetchRepository(task.workingCopy);
    const missing: ObjectId[] = [];
    for (const id of data.commits) if (!(await inner.hasCommit(id))) missing.push(id);
    data.commits = missing;
    if (missing.length > 0) pending.push({ ...task, commits: missing });
  };

  // get_fetch_task_from_index
  for (const path of await repo.indexGitlinks()) {
    const created = await createTask(path, model);
    if (!created) continue;
    if (created.task) {
      if (!options.quiet) outcome.output += `Fetching submodule ${options.prefix}${path}\n`;
      await run(created.task, false);
    } else if (!(await repo.emptyDirectory(path))) {
      outcome.failed = true;
      outcome.output += `Could not access submodule '${path}'\n`;
    }
  }
  // get_fetch_task_from_changed
  for (const data of changed) {
    const subModel = await modelAt(data.superOid);
    if (!subModel.isActive(data.path)) continue;
    const created = await createTask(data.path, subModel);
    if (!created) continue;
    const abbrev = await repo.abbreviate(data.superOid);
    if (!created.task) {
      outcome.output += `Could not access submodule '${data.path}' at commit ${abbrev}\n`;
      continue;
    }
    if (!options.quiet) {
      outcome.output += `Fetching submodule ${options.prefix}${created.task.sub.path} at commit ${abbrev}\n`;
    }
    await run(created.task, true);
  }
  // the fetches by commit id, last scheduled first
  while (pending.length > 0) {
    const task = pending.pop() as Task;
    const remote = await remoteForCommits(workingCopy, model, task, options.compatibility);
    const done = await runFetch(
      {
        workingCopy: task.workingCopy,
        defaultMode: "on-demand",
        prefix: `${options.prefix}${task.sub.path}/`,
        remote,
        commits: [...new Set(task.commits)].sort(),
      },
      false,
    );
    outcome.output += done.text;
    await finish(task, done.ok);
  }
  if (failures.length > 0) {
    outcome.output += `Errors during submodule fetch:\n${failures.map((n) => `\t${n}\n`).join("")}`;
  }
  return outcome;
}

/** setup_work_tree's death when the repository's `core.worktree` names no directory. */
async function chdirFailure(inner: WorkingCopy): Promise<string | undefined> {
  const worktree = inner.worktree;
  const gitDir = worktree?.getGitDir?.();
  const files = worktree?.getFiles?.();
  if (!gitDir || !files) return undefined;
  const value = RemoteConfigStore.from(inner).value("core.worktree");
  if (value === undefined || value.startsWith("/")) return undefined;
  const kind = (await files.stats(joinFilesPath(gitDir, value)).catch(() => undefined))?.kind;
  if (kind === "directory") return undefined;
  const reason = kind === undefined ? "No such file or directory" : "Not a directory";
  return `fatal: cannot chdir to '${value}': ${reason}`;
}

function recurseFromSettings(
  value: SubmoduleSettings["fetchRecurseSubmodules"],
): FetchRecurseSubmodules | undefined {
  if (value === "on") return "yes";
  if (value === "off") return "no";
  return value;
}

/**
 * The remote the missing commits are fetched from: git 2.43 names `origin`; 2.5x asks
 * `submodule--helper get-default-remote` (the submodule's remote whose URL `.gitmodules`
 * gives, else its default remote).
 */
async function remoteForCommits(
  workingCopy: WorkingCopy,
  model: SubmoduleModel,
  task: Task,
  compatibility: "2.43" | "2.56",
): Promise<string> {
  if (compatibility === "2.43") return "origin";
  const sub = model.fromPath(task.sub.path) ?? task.sub;
  if (sub.url !== undefined) {
    const url = isRelativeSubmoduleUrl(sub.url)
      ? await resolveRelativeUrl(workingCopy, sub.url, undefined, { quiet: true })
      : sub.url;
    const found = remoteFromUrl(task.workingCopy, url);
    if (found !== undefined) return found;
  }
  return defaultRemoteOf(task.workingCopy);
}

/** `calculate_changed_submodule_paths`, the list sorted by name. */
async function calculateChanged(
  repo: SubmoduleFetchRepository,
  model: SubmoduleModel,
  modelAt: (commit: ObjectId) => Promise<SubmoduleModel>,
  options: SubmoduleFetchOptions,
  outcome: SubmoduleFetchOutcome,
): Promise<ChangedSubmodule[]> {
  if (model.gitmodules.list().length === 0 && !(await repo.hasAbsorbedSubmodules())) return [];
  const changed = new Map<string, ChangedSubmodule>();
  for (const commit of await repo.walk(options.tipsAfter, options.tipsBefore)) {
    const gitlinks = await repo.changedGitlinks(commit);
    if (gitlinks.size === 0) continue;
    const at = await modelAt(commit);
    for (const [path, id] of [...gitlinks].sort(([a], [b]) => compareBytes(a, b))) {
      let name = at.fromPath(path)?.name;
      if (name === undefined) {
        name = (await repo.populated(path)) ? path : undefined;
        if (name !== undefined && at.fromName(name)) {
          outcome.output += `warning: Submodule in commit ${commit} at path: '${path}' collides with a submodule named the same. Skipping it.\n`;
          name = undefined;
        }
      }
      if (name === undefined) continue;
      let data = changed.get(name);
      if (!data) {
        data = { name, superOid: commit, path, commits: [] };
        changed.set(name, data);
      }
      data.commits.push(id);
    }
  }
  const out: ChangedSubmodule[] = [];
  for (const data of changed.values()) {
    const sub = model.fromName(data.name);
    const path = sub?.path ?? ((await repo.populated(data.name)) ? data.name : undefined);
    if (path !== undefined && (await submoduleHasCommits(repo, path, sub?.name, data.commits))) {
      continue;
    }
    out.push(data);
  }
  return out.sort((a, b) => compareBytes(a.name, b.name));
}

/** `submodule_has_commits`: the submodule has every commit and a ref reaches each. */
async function submoduleHasCommits(
  repo: SubmoduleFetchRepository,
  path: string,
  name: string | undefined,
  commits: readonly ObjectId[],
): Promise<boolean> {
  const inner = await repo.open(path, name);
  if (!inner) return false;
  const sub = new SubmoduleFetchRepository(inner);
  for (const id of commits) if (!(await sub.hasCommit(id))) return false;
  // `rev-list -n 1 <commits> --not --all` runs in the submodule's directory: one not checked
  // out runs it in the superproject, which lacks them
  if (!(await repo.populated(path))) return false;
  return sub.reachesAll(commits);
}

function compareBytes(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
