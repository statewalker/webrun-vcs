/**
 * What git's submodule.c shows of a submodule's own history: the header of a submodule's
 * change (`Submodule <path> <a>..<b>:`, `show_submodule_header`), the commits between its
 * two sides as `git diff --submodule=log` lists them (`show_submodule_diff_summary`), and
 * the first-parent, left/right revision walk inside the submodule's repository that both
 * that and `git submodule summary` (builtin/submodule--helper.c) print from.
 */
import type { ObjectId } from "@statewalker/vcs-core";
import { collectChunks, type WorkingCopy } from "@statewalker/vcs-working-tree";

import { InvalidConfigError } from "../errors/index.js";
import { GitCommand } from "../git-command.js";
import { RemoteConfigStore } from "../remote-config/index.js";
import { createIdAbbreviator, type IdAbbreviator } from "./core-config.js";
import { commitsBaseSource, MergeBaseGraph } from "./merge-bases.js";
import { formatCommitPretty } from "./pretty-format.js";
import type { SubmoduleDirt } from "./status-command.js";
import { type GitmodulesEntry, parseGitmodules } from "./submodule-config.js";

/** `--submodule=<format>` / `diff.submodule`: how a submodule's change is shown. */
export type SubmoduleDiffFormat = "short" | "log" | "diff";

/** A value of `--submodule` or `diff.submodule` (diff.c `parse_submodule_params`). */
export function parseSubmoduleDiffFormat(
  value: string | undefined,
): SubmoduleDiffFormat | undefined {
  return value === "short" || value === "log" || value === "diff" ? value : undefined;
}

/** `diff.submodule` as git's `git_diff_ui_config` reads it. */
export interface DiffSubmoduleConfig {
  /** The last value git knows, undefined when none */
  format?: SubmoduleDiffFormat;
  /** `warning: Unknown value for 'diff.submodule' config variable: '<value>'`, per value */
  warnings: string[];
}

/**
 * `diff.submodule` as git reads it before any diff (`git_diff_ui_config`, whatever
 * `--submodule` says): every value in the configuration's order, the last one it knows
 * winning; each other value warns (`parse_submodule_params` fails, the warning of
 * `git_diff_ui_config`). A variable without `=` fails as git 2.5x fails (`error: missing
 * value for 'diff.submodule'`, then where it was read; git 2.43 crashes there).
 *
 * @throws InvalidConfigError for a variable without a value
 *
 * @example
 * ```typescript
 * const { format, warnings } = readDiffSubmoduleConfig(workingCopy);
 * ```
 */
export function readDiffSubmoduleConfig(workingCopy: WorkingCopy): DiffSubmoduleConfig {
  const key = "diff.submodule";
  const out: DiffSubmoduleConfig = { warnings: [] };
  if (!workingCopy.config) return out;
  for (const { text, file, line } of RemoteConfigStore.from(workingCopy).valuesWithOrigin(key)) {
    if (text === undefined) {
      const where =
        file !== undefined && line !== undefined
          ? `fatal: bad config variable '${key}' in file '${file}' at line ${line}`
          : `fatal: unable to parse '${key}' from command-line config`;
      throw new InvalidConfigError(key, `error: missing value for '${key}'\n${where}`);
    }
    const format = parseSubmoduleDiffFormat(text);
    if (format) out.format = format;
    else out.warnings.push(`warning: Unknown value for '${key}' config variable: '${text}'`);
  }
  return out;
}

/** git's null object id: the side of a submodule that is not there. */
export const NULL_OBJECT_ID = "0".repeat(40);

const isNull = (id: ObjectId) => /^0+$/.test(id);

/** One commit of the walk, and whether it was reached from the left side (`%m` is `<`). */
export interface SubmoduleWalkCommit {
  id: ObjectId;
  left: boolean;
}

/** Where a walk starts: a commit, marked left (`SYMMETRIC_LEFT`) or uninteresting. */
export interface SubmoduleWalkStart {
  id: ObjectId;
  left?: boolean;
  uninteresting?: boolean;
}

const SEEN = 1;
const UNINTERESTING = 2;
const LEFT = 4;
/** revision.c's SLOP: uninteresting commits looked at before the walk gives up */
const SLOP = 5;

/** The walk failed: a commit it had to read is missing ("revision walker failed"). */
export class SubmoduleWalkError extends Error {}

/**
 * The repository of a submodule as the summaries read it: its commits, refs and
 * abbreviations. Opened by {@link openSubmoduleRepository}.
 */
export class SubmoduleRepository extends GitCommand<never> {
  /** Never writes refs: runs in a repository whose ref store only reads. */
  protected override get writesRefs(): boolean {
    return false;
  }

  private abbreviations?: IdAbbreviator;
  /** Whether the repository is the one checked out at the path (not `modules/<name>`) */
  populated = false;

  /** Not a command: it reads for the submodule summaries. */
  async call(): Promise<never> {
    throw new Error("SubmoduleRepository is not callable");
  }

  /** The working copy of the submodule's repository. */
  get repository(): WorkingCopy {
    return this.workingCopy;
  }

  /** git's `lookup_commit_reference`: the commit `id` names (tags peeled), else undefined. */
  async commitReference(id: ObjectId): Promise<ObjectId | undefined> {
    if (isNull(id)) return undefined;
    return this.revisionResolver()
      .commitReference(id)
      .catch(() => undefined);
  }

  /** The commit HEAD points at, undefined when there is none. */
  async head(): Promise<ObjectId | undefined> {
    return (await this.refsStore.resolve("HEAD").catch(() => undefined))?.objectId;
  }

  /**
   * git's `repo_get_merge_bases` of two commits, in git's order.
   *
   * @throws SubmoduleWalkError when a commit the walk reaches is missing (git 2.45 and later:
   * `paint_down_to_common` fails, and the header says "(corrupt repository)")
   */
  async mergeBases(one: ObjectId, two: ObjectId): Promise<ObjectId[]> {
    const source = commitsBaseSource(this.walkCommits, async () => new Map());
    const load = source.load;
    source.load = async (id) => {
      const found = await load(id);
      if (!found) throw new SubmoduleWalkError(`could not parse commit ${id}`);
      return found;
    };
    const graph = new MergeBaseGraph(source);
    const bases = await graph.mergeBases(graph.commit(one), graph.commit(two));
    return bases.map((n) => n.id).filter((id): id is ObjectId => id !== undefined);
  }

  /** `id` abbreviated as this repository abbreviates it (`rev-parse --short`). */
  abbreviate(id: ObjectId): Promise<string> {
    this.abbreviations ??= createIdAbbreviator(this.workingCopy);
    return this.abbreviations.abbreviate(id);
  }

  /**
   * The commits of `git log --first-parent` from `starts` (git's `limit_list` with
   * `first_parent_only`): newest commit date first, ties in the order queued, the commits
   * reachable from an uninteresting start left out. Left marks run down the first parents.
   *
   * @throws SubmoduleWalkError when an interesting commit or its first parent is missing
   */
  async walkFirstParent(starts: SubmoduleWalkStart[]): Promise<SubmoduleWalkCommit[]> {
    const commits = this.walkCommits;
    const flags = new Map<ObjectId, number>();
    const parentsOf = new Map<ObjectId, ObjectId[]>();
    const dates = new Map<ObjectId, number>();
    const flag = (id: ObjectId) => flags.get(id) ?? 0;
    const set = (id: ObjectId, f: number) => flags.set(id, flag(id) | f);
    const parse = async (id: ObjectId): Promise<boolean> => {
      if (parentsOf.has(id)) return true;
      const commit = await commits.load(id).catch(() => undefined);
      if (!commit) return false;
      parentsOf.set(id, commit.parents);
      dates.set(id, commit.committer.timestamp);
      return true;
    };
    // mark_parents_uninteresting: through the commits already parsed
    const markParentsUninteresting = (id: ObjectId) => {
      const pending = [...(parentsOf.get(id) ?? [])];
      while (pending.length > 0) {
        const p = pending.pop() as ObjectId;
        if (flag(p) & UNINTERESTING) continue;
        set(p, UNINTERESTING);
        pending.push(...(parentsOf.get(p) ?? []));
      }
    };
    // the queue: newest first, ties in insertion order (prio_queue's counter)
    let counter = 0;
    const queue: { id: ObjectId; date: number; ctr: number }[] = [];
    const put = (id: ObjectId) => {
      const entry = { id, date: dates.get(id) ?? 0, ctr: counter++ };
      let at = queue.length;
      while (
        at > 0 &&
        (queue[at - 1].date < entry.date ||
          (queue[at - 1].date === entry.date && queue[at - 1].ctr > entry.ctr))
      ) {
        at--;
      }
      queue.splice(at, 0, entry);
    };
    for (const s of starts) set(s.id, (s.left ? LEFT : 0) | (s.uninteresting ? UNINTERESTING : 0));
    // prepare_revision_walk: each start once, sorted by date (stable)
    const initial: ObjectId[] = [];
    for (const s of starts) {
      if (!(await parse(s.id))) throw new SubmoduleWalkError(`bad object ${s.id}`);
      if (flag(s.id) & UNINTERESTING) markParentsUninteresting(s.id);
      if (flag(s.id) & SEEN) continue;
      set(s.id, SEEN);
      initial.push(s.id);
    }
    const sorted = initial
      .map((id, i) => ({ id, i, date: dates.get(id) ?? 0 }))
      .sort((a, b) => b.date - a.date || a.i - b.i);
    for (const e of sorted) put(e.id);
    const everybodyUninteresting = () => queue.every((e) => flag(e.id) & UNINTERESTING);
    const out: ObjectId[] = [];
    let slop = SLOP;
    let date = Number.POSITIVE_INFINITY;
    while (queue.length > 0) {
      const { id } = queue.shift() as { id: ObjectId };
      // process_parents
      const parents = parentsOf.get(id) ?? [];
      if (flag(id) & UNINTERESTING) {
        for (const p of parents) {
          set(p, UNINTERESTING);
          if (!(await parse(p))) continue;
          markParentsUninteresting(p);
          if (flag(p) & SEEN) continue;
          set(p, SEEN);
          put(p);
        }
        markParentsUninteresting(id);
        // still_interesting
        const next = queue[0];
        if (!next) break;
        if (date <= next.date || !everybodyUninteresting()) slop = SLOP;
        else slop--;
        if (slop) continue;
        break;
      }
      const first = parents[0];
      if (first !== undefined) {
        if (!(await parse(first))) throw new SubmoduleWalkError(`bad object ${first}`);
        set(first, flag(id) & LEFT);
        if (!(flag(first) & SEEN)) {
          set(first, SEEN);
          put(first);
        }
      }
      date = dates.get(id) ?? 0;
      out.push(id);
    }
    return out
      .filter((id) => !(flag(id) & UNINTERESTING))
      .map((id) => ({ id, left: (flag(id) & LEFT) !== 0 }));
  }

  /**
   * The commits of `git log --first-parent <a>...<b>` (and `rev-list --count` of it): the
   * merge bases excluded, `a`'s side marked left.
   */
  async symmetricWalk(a: ObjectId, b: ObjectId): Promise<SubmoduleWalkCommit[]> {
    const bases = await this.mergeBases(a, b);
    return this.walkFirstParent([
      ...bases.map((id) => ({ id, uninteresting: true })),
      { id: a, left: true },
      { id: b },
    ]);
  }

  /** One line of `--pretty=<format>` for a commit (`%m` its mark). */
  async formatLine(format: string, c: SubmoduleWalkCommit): Promise<string> {
    const commit = await this.walkCommits.load(c.id);
    if (!commit) return "";
    return `${await formatCommitPretty(format, commit, c.id, { mark: c.left ? "<" : ">" })}\n`;
  }
}

/**
 * The text of the superproject's `.gitmodules` as git's `config_from_gitmodules` reads it:
 * the worktree's file, else the index's blob, else HEAD's; undefined without one.
 */
export async function readGitmodulesEntries(
  workingCopy: WorkingCopy,
): Promise<GitmodulesEntry[] | undefined> {
  const reader = new GitmodulesReader(workingCopy);
  const text = await reader.call();
  return text === undefined ? undefined : parseGitmodules(text);
}

class GitmodulesReader extends GitCommand<string | undefined> {
  async call(): Promise<string | undefined> {
    const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
    const worktree = this.worktreeAccess;
    try {
      if (worktree && (await worktree.getEntry(".gitmodules"))) {
        return decode(await collectChunks(worktree.readContent(".gitmodules")));
      }
    } catch {
      // not readable: the index's
    }
    const blob = async (id: ObjectId) =>
      decode(await collectChunks((await this.blobs.load(id)) ?? []));
    const staged = await this.staging.getEntry(".gitmodules").catch(() => undefined);
    if (staged) return blob(staged.objectId);
    try {
      return await blob(await this.resolveRevision("HEAD:.gitmodules"));
    } catch {
      return undefined;
    }
  }
}

/**
 * git's `open_submodule`: the repository of the submodule at `path` (its `.git`, else the
 * one kept under `<gitdir>/modules/<name>` for the name `.gitmodules` gives the path);
 * undefined when there is none.
 *
 * Known gaps:
 * - A gitfile naming a repository beyond the FilesApi's root cannot be followed here, so
 *   the submodule reads as holding none and the `modules/<name>` fallback is taken, where
 *   git reads the repository the gitfile names.
 * - When `.gitmodules` gives one path to several names, the first name is taken; git's
 *   submodule-config cache keeps the last one read (`cache_put_path` replaces the entry).
 */
export async function openSubmoduleRepository(
  workingCopy: WorkingCopy,
  path: string,
): Promise<SubmoduleRepository | undefined> {
  const worktree = workingCopy.worktree;
  if (!worktree?.openGitlink) return undefined;
  let inner = await worktree.openGitlink(path).catch(() => undefined);
  const populated = inner !== undefined;
  if (!inner) {
    const name = (await readGitmodulesEntries(workingCopy).catch(() => undefined))?.find(
      (e) => e.path === path,
    )?.name;
    if (name !== undefined)
      inner = await worktree.openGitlink(path, { name }).catch(() => undefined);
  }
  if (!inner) return undefined;
  const sub = new SubmoduleRepository(inner);
  sub.populated = populated;
  return sub;
}

/** What {@link submoduleHeader} found: the commits of both sides and their merge bases. */
export interface SubmoduleHeader {
  text: string;
  left?: ObjectId;
  right?: ObjectId;
  bases: ObjectId[];
}

/**
 * submodule.c's `show_submodule_header`: the "contains untracked / modified content" lines
 * of a dirty submodule, then `Submodule <path> <a>..<b>:` (`...` unless one side is an
 * ancestor of the other, ` (rewind)` when the new side is the older), or the header with
 * "(new submodule)", "(submodule deleted)", "(commits not present)" or "(corrupt
 * repository)"; no header when both sides are the same commit. The ids are abbreviated as
 * the superproject abbreviates them (`abbreviate`).
 */
export async function submoduleHeader(o: {
  path: string;
  one: ObjectId;
  two: ObjectId;
  dirt?: SubmoduleDirt;
  sub: SubmoduleRepository | undefined;
  abbreviate: (id: ObjectId) => Promise<string>;
}): Promise<SubmoduleHeader> {
  const { path, one, two, sub } = o;
  let text = "";
  if (o.dirt?.untracked) text += `Submodule ${path} contains untracked content\n`;
  if (o.dirt?.modified) text += `Submodule ${path} contains modified content\n`;
  let message: string | undefined;
  if (isNull(one)) message = "(new submodule)";
  else if (isNull(two)) message = "(submodule deleted)";
  let left: ObjectId | undefined;
  let right: ObjectId | undefined;
  let bases: ObjectId[] = [];
  let fastForward = false;
  let fastBackward = false;
  const header = async () => {
    let line = `Submodule ${path} ${await o.abbreviate(one)}`;
    line += fastBackward || fastForward ? ".." : "...";
    line += await o.abbreviate(two);
    line += message ? ` ${message}\n` : `${fastBackward ? " (rewind)" : ""}:\n`;
    return line;
  };
  if (!sub) {
    message ??= "(commits not present)";
    return { text: text + (await header()), bases };
  }
  left = await sub.commitReference(one);
  right = await sub.commitReference(two);
  if ((!isNull(one) && !left) || (!isNull(two) && !right)) message = "(commits not present)";
  // repo_get_merge_bases: one side missing has none; the same commit (or none on both
  // sides) is its own
  try {
    if (left === right) bases = left !== undefined ? [left] : [];
    else if (left !== undefined && right !== undefined) bases = await sub.mergeBases(left, right);
  } catch {
    message = "(corrupt repository)";
    return { text: text + (await header()), left, right, bases: [] };
  }
  if (left === right) fastForward = true;
  else if (bases.length > 0) {
    if (bases[0] === left) fastForward = true;
    else if (bases[0] === right) fastBackward = true;
  }
  if (one === two) return { text, left, right, bases };
  return { text: text + (await header()), left, right, bases };
}

/**
 * submodule.c's `show_submodule_diff_summary` (`git diff --submodule=log`): the header,
 * then the commits between the two sides, `  < subject` for those only the old side has
 * and `  > subject` for the new side's, as a `--left-right --first-parent` walk lists them.
 */
export async function showSubmoduleDiffSummary(o: {
  workingCopy: WorkingCopy;
  path: string;
  one: ObjectId;
  two: ObjectId;
  dirt?: SubmoduleDirt;
  abbreviate: (id: ObjectId) => Promise<string>;
}): Promise<string> {
  const sub = await openSubmoduleRepository(o.workingCopy, o.path);
  const header = await submoduleHeader({ ...o, sub });
  let out = header.text;
  const { left, right } = header;
  if (!left || !right || !sub) return out;
  let walked: SubmoduleWalkCommit[];
  try {
    walked = await sub.walkFirstParent([
      { id: left, left: true },
      { id: right },
      ...header.bases.map((id) => ({ id, uninteresting: true })),
    ]);
  } catch {
    return `${out}(revision walker failed)\n`;
  }
  for (const c of walked) out += await sub.formatLine("  %m %s", c);
  return out;
}
