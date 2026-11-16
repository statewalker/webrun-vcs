/**
 * git's sequencer for `cherry-pick` and `revert`: each commit's change merged into HEAD by
 * merge-ort and written to the index and the worktree, committed or stopped at a conflict
 * with git's state (`CHERRY_PICK_HEAD` / `REVERT_HEAD`, `MERGE_MSG`, `AUTO_MERGE`, and for
 * several commits `sequencer/` with `head`, `todo` and `abort-safety`), so native git can
 * `--continue`, `--skip` or `--abort` what we started and the other way round.
 */

import { type Commit, isSymbolicRef, type ObjectId, type PersonIdent } from "@statewalker/vcs-core";
import type { Worktree } from "@statewalker/vcs-working-tree";

import {
  InvalidMainlineParentError,
  MultipleParentsNotAllowedError,
} from "../errors/merge-errors.js";
import { RefNotFoundError } from "../errors/ref-errors.js";
import type { CommandCommits, CommandRefs, CommandTrees } from "../git-command.js";
import { coreBool } from "./core-config.js";
import { UNMERGED_FILES_MESSAGE } from "./merge-command.js";
import { conflictStyleOf } from "./merge-config.js";
import { ortConfigOptions } from "./merge-drivers.js";
import {
  abbrev,
  conflictsComment,
  defaultIdent,
  FlatTreeCache,
  indexChanges,
  type MergeWriteContext,
  type OperationState,
  readIndex,
  storeFlatTreeOver,
  subjectOf,
  switchTrees,
} from "./merge-support.js";
import { ortMerge, ortResultEntries } from "./ort-merge.js";
import { cleanupMessage, resetMerge } from "./sequencer-support.js";

/** What the sequencer does with each commit. */
export type PickAction = "pick" | "revert";

/** What a cherry-pick or revert is asked to do. */
export enum SequencerOperation {
  /** Start picking (reverting) the included commits */
  START = "start",
  /** `--continue`: commit the resolved conflict and pick the rest */
  CONTINUE = "continue",
  /** `--skip`: drop the commit that stopped and pick the rest */
  SKIP = "skip",
  /** `--abort`: back to where the operation started */
  ABORT = "abort",
  /** `--quit`: forget the operation, keep everything as it is */
  QUIT = "quit",
}

/** How one run of the sequencer ended. */
export interface PickOutcome {
  status: "ok" | "conflicting" | "failed";
  newHead?: ObjectId;
  picked: ObjectId[];
  conflicts?: string[];
  /** git's error (stderr) for a failure or a stop at a conflict */
  message?: string;
  /** merge-ort's lines (stdout) */
  output: string[];
}

/** What the sequencer works with. */
export interface SequencerDeps extends MergeWriteContext {
  commits: CommandCommits;
  refs: CommandRefs;
  trees: CommandTrees;
  worktree?: Worktree;
  state: OperationState;
  resolve: (name: string) => Promise<ObjectId>;
}

/** Options of one sequencer run. */
export interface PickOptions {
  action: PickAction;
  noCommit?: boolean;
  mainline?: number;
  favor?: "ours" | "theirs" | "union";
  /** The label of HEAD in conflict markers (default `HEAD`) */
  oursLabel?: string;
  /** The committer (and a revert's author); default `Unknown` now */
  committer?: PersonIdent;
}

const ACTION_NAME = { pick: "cherry-pick", revert: "revert" } as const;
const ACTION_ING = { pick: "Cherry-picking", revert: "Reverting" } as const;
const HEAD_REF = { pick: "CHERRY_PICK_HEAD", revert: "REVERT_HEAD" } as const;

interface TodoItem {
  action: PickAction;
  id: ObjectId;
}

/** git's sequencer for `cherry-pick` / `revert`. */
export class PickSequencer {
  /** The flat trees the picks read (each pick's result is the next one's HEAD) */
  private readonly flats: FlatTreeCache;

  constructor(
    private readonly deps: SequencerDeps,
    private readonly options: PickOptions,
  ) {
    this.flats = new FlatTreeCache(deps.trees);
  }

  private get name(): string {
    return ACTION_NAME[this.options.action];
  }

  private fail(message: string, output: string[] = [], picked: ObjectId[] = []): PickOutcome {
    return { status: "failed", message, output, picked };
  }

  /** `git cherry-pick <commits>` / `git revert <commits>`. */
  async start(names: string[]): Promise<PickOutcome> {
    const { state } = this.deps;
    const { unmerged } = await readIndex(this.deps.staging);
    if (unmerged.length > 0) {
      return this.fail(
        [
          `error: ${ACTION_ING[this.options.action]} is not possible because you have unmerged files.`,
          "hint: Fix them up in the work tree, and then use 'git add/rm <file>'",
          "hint: as appropriate to mark resolution and make a commit.",
          `fatal: ${this.name} failed`,
        ].join("\n"),
      );
    }
    if (await this.sequenced()) {
      return this.fail(
        `error: a cherry-pick or revert is already in progress\nhint: try "git cherry-pick (--continue | --skip | --abort | --quit)"\nfatal: ${this.name} failed`,
      );
    }
    const ids: ObjectId[] = [];
    for (const name of names) ids.push(await this.deps.resolve(name));
    const todo = ids.map((id) => ({ action: this.options.action, id }));
    const headId = await this.headId();
    if (todo.length > 1) {
      await state.write("sequencer/head", `${headId}\n`);
      await this.writeTodo(todo);
      await state.write("sequencer/abort-safety", `${headId}\n`);
      if (this.options.noCommit)
        await state.write("sequencer/opts", "[options]\n\tno-commit = true\n");
    }
    return this.run(todo, todo.length > 1);
  }

  /** Picks `todo` in order; `sequenced`: a `sequencer/` directory tracks the progress. */
  private async run(todo: TodoItem[], sequenced: boolean): Promise<PickOutcome> {
    const output: string[] = [];
    const picked: ObjectId[] = [];
    let newHead = await this.headId();
    for (let k = 0; k < todo.length; k++) {
      const item = todo[k];
      const outcome = await this.pickOne(item, output);
      if (outcome.status !== "ok") {
        if (sequenced) {
          await this.writeTodo(todo.slice(k));
          await this.deps.state.write("sequencer/abort-safety", `${await this.headId()}\n`);
        }
        return { ...outcome, picked, output };
      }
      picked.push(item.id);
      newHead = outcome.newHead ?? newHead;
      if (sequenced) {
        await this.writeTodo(todo.slice(k + 1));
        await this.deps.state.write("sequencer/abort-safety", `${newHead}\n`);
      }
    }
    if (sequenced) await this.deps.state.remove("sequencer");
    return { status: "ok", newHead, picked, output };
  }

  /** One commit's change merged into HEAD (do_pick_commit). */
  private async pickOne(item: TodoItem, output: string[]): Promise<PickOutcome> {
    const { deps } = this;
    const action = item.action;
    const commit = await deps.commits.load(item.id);
    if (!commit) throw new RefNotFoundError(item.id, `Cannot find commit: ${item.id}`);
    const headId = await this.headId();
    const headCommit = await deps.commits.load(headId);
    if (!headCommit) throw new RefNotFoundError(headId, "HEAD commit not found");
    // with --no-commit the change is merged into the index as it is (git's
    // write_index_as_tree): each commit's change on top of the previous one's
    const headTreeId = this.options.noCommit
      ? await deps.staging.writeTree(deps.trees)
      : headCommit.tree;
    const headTree = await this.flats.get(headTreeId);

    // a commit is never made on top of staged changes (error_dirty_index)
    const { index } = await readIndex(deps.staging);
    if (!this.options.noCommit && indexChanges(index, headTree).length > 0) {
      return this.fail(
        `error: your local changes would be overwritten by ${ACTION_NAME[action]}.\nhint: commit your changes or stash them to proceed.\nfatal: ${ACTION_NAME[action]} failed`,
      );
    }

    // the parent the change is taken against
    let parentId: ObjectId | undefined;
    if (commit.parents.length > 1) {
      if (this.options.mainline === undefined) {
        throw new MultipleParentsNotAllowedError(
          `error: commit ${item.id} is a merge but no -m option was given.\nfatal: ${ACTION_NAME[action]} failed`,
        );
      }
      if (this.options.mainline < 1 || this.options.mainline > commit.parents.length) {
        throw new InvalidMainlineParentError(this.options.mainline, commit.parents.length);
      }
      parentId = commit.parents[this.options.mainline - 1];
    } else {
      parentId = commit.parents[0];
    }
    const parentTree = await this.flats.get(
      parentId ? await deps.commits.getTree(parentId) : undefined,
    );
    const commitTree = await this.flats.get(commit.tree);
    const subject = subjectOf(commit.message);
    const label = `${abbrev(item.id)} (${subject})`;
    const parentLabel = parentId ? `parent of ${label}` : "(empty tree)";
    const [base, theirs, baseLabel, theirsLabel] =
      action === "pick"
        ? [parentTree, commitTree, parentLabel, label]
        : [commitTree, parentTree, label, parentLabel];
    const merge = await ortMerge(deps.blobs, base, headTree, theirs, {
      oursLabel: this.options.oursLabel ?? "HEAD",
      theirsLabel,
      baseLabel,
      style: conflictStyleOf(deps.workingCopy),
      favor: this.options.favor,
      ignoreCase: coreBool(deps.workingCopy, "ignorecase", false),
      ...ortConfigOptions(deps.workingCopy, deps.worktree),
    });
    const target = await ortResultEntries(deps.blobs, merge);
    const treeId = await storeFlatTreeOver(deps.trees, headTreeId, headTree, target);
    this.flats.put(treeId, target);
    const conflicts = [...merge.conflicts.values()];
    const refused = await switchTrees(deps, headTree, target, {
      action: "merge",
      operation: ACTION_NAME[action],
      conflicts,
      targetTree: treeId,
    });
    if (refused) {
      return this.fail(`${refused.message}\nfatal: ${ACTION_NAME[action]} failed`);
    }
    output.push(...merge.messages);
    await deps.state.setRef("AUTO_MERGE", treeId);
    const message = this.messageFor(action, item.id, commit, parentId);

    if (conflicts.length > 0 || !merge.clean) {
      const paths = [...new Set(conflicts.map((c) => c.stagePath))].sort();
      // git records REVERT_HEAD for a revert -n too (do_pick_commit), never CHERRY_PICK_HEAD
      if (!this.options.noCommit || action === "revert") {
        await deps.state.setRef(HEAD_REF[action], item.id);
      }
      await deps.state.write("MERGE_MSG", `${message}${conflictsComment(paths, true)}`);
      const advice = this.options.noCommit
        ? [
            "hint: after resolving the conflicts, mark the corrected paths",
            "hint: with 'git add <paths>' or 'git rm <paths>'",
          ]
        : [
            "hint: After resolving the conflicts, mark them with",
            'hint: "git add/rm <pathspec>", then run',
            `hint: "git ${ACTION_NAME[action]} --continue".`,
            `hint: You can instead skip this commit with "git ${ACTION_NAME[action]} --skip".`,
            `hint: To abort and get back to the state before "git ${ACTION_NAME[action]}",`,
            `hint: run "git ${ACTION_NAME[action]} --abort".`,
          ];
      return {
        status: "conflicting",
        conflicts: paths,
        picked: [],
        output,
        message: [
          `error: could not ${action === "pick" ? "apply" : "revert"} ${abbrev(item.id)}... ${subject}`,
          ...advice,
        ].join("\n"),
      };
    }
    if (this.options.noCommit) {
      await deps.state.write("MERGE_MSG", message);
      if (action === "revert") await deps.state.setRef(HEAD_REF[action], item.id);
      return { status: "ok", newHead: headId, picked: [item.id], output };
    }
    if (treeId === headCommit.tree) {
      // nothing to commit: git stops, the pick in progress, for --allow-empty or --skip
      // (CHERRY_PICK_HEAD only: git records REVERT_HEAD for a revert that conflicts)
      if (action === "pick") await deps.state.setRef(HEAD_REF[action], item.id);
      await deps.state.write("MERGE_MSG", message);
      return {
        status: "conflicting",
        conflicts: [],
        picked: [],
        output,
        message: [
          `The previous ${ACTION_NAME[action]} is now empty, possibly due to conflict resolution.`,
          "If you wish to commit it anyway, use:",
          "",
          "    git commit --allow-empty",
          "",
          `Otherwise, please use 'git ${ACTION_NAME[action]} --skip'`,
        ].join("\n"),
      };
    }
    const committer = this.options.committer ?? defaultIdent();
    const newHead = await this.commit(
      treeId,
      [headId],
      action === "pick" ? commit.author : committer,
      committer,
      action === "pick" ? commit.message : message,
    );
    return { status: "ok", newHead, picked: [item.id], output };
  }

  /** `--continue`: the resolved conflict committed, then the rest picked. */
  async continue(): Promise<PickOutcome> {
    const { state } = this.deps;
    const sequenced = await this.sequenced();
    const pickHead = await state.ref("CHERRY_PICK_HEAD");
    const revertHead = await state.ref("REVERT_HEAD");
    const stopped = pickHead ?? revertHead;
    if (!stopped && !sequenced) {
      return this.fail(`error: no cherry-pick or revert in progress\nfatal: ${this.name} failed`);
    }
    const { unmerged } = await readIndex(this.deps.staging);
    if (unmerged.length > 0) return this.fail(UNMERGED_FILES_MESSAGE("Committing"));
    let todo = sequenced ? await this.readTodo() : [];
    let newHead = await this.headId();
    if (stopped) {
      const action: PickAction = pickHead ? "pick" : "revert";
      const commit = await this.deps.commits.load(stopped);
      if (!commit) throw new RefNotFoundError(stopped, "Commit being picked not found");
      const treeId = await this.deps.staging.writeTree(this.deps.trees);
      const headCommit = await this.deps.commits.load(newHead);
      if (headCommit?.tree === treeId) {
        return this.fail(
          `The previous ${ACTION_NAME[action]} is now empty, possibly due to conflict resolution.`,
        );
      }
      const committer = this.options.committer ?? defaultIdent();
      const fallback = this.messageFor(action, stopped, commit, commit.parents[0]);
      const message = cleanupMessage((await state.read("MERGE_MSG")) ?? fallback);
      newHead = await this.commit(
        treeId,
        [newHead],
        action === "pick" ? commit.author : committer,
        committer,
        message,
      );
      // the commit ends the stopped pick (git commit's remove_merge_branch_state)
      await state.removeRef("CHERRY_PICK_HEAD", "REVERT_HEAD", "AUTO_MERGE");
      await state.remove("MERGE_MSG");
      if (todo[0]?.id === stopped) todo = todo.slice(1);
    }
    if (!sequenced) return { status: "ok", newHead, picked: stopped ? [stopped] : [], output: [] };
    await this.writeTodo(todo);
    await state.write("sequencer/abort-safety", `${newHead}\n`);
    const outcome = await this.run(todo, true);
    return { ...outcome, picked: [...(stopped ? [stopped] : []), ...outcome.picked] };
  }

  /** `--skip`: the stopped commit dropped (`reset --merge HEAD`), the rest picked. */
  async skip(): Promise<PickOutcome> {
    const { state } = this.deps;
    const stopped = (await state.ref("CHERRY_PICK_HEAD")) ?? (await state.ref("REVERT_HEAD"));
    if (!stopped) {
      return this.fail(`error: no cherry-pick or revert in progress\nfatal: ${this.name} failed`);
    }
    const headId = await this.headId();
    const refused = await resetMerge(this.deps, headId, "HEAD");
    if (refused) return this.fail(refused.message);
    // git reset --merge records ORIG_HEAD
    await state.setRef("ORIG_HEAD", headId);
    await state.removeRef("CHERRY_PICK_HEAD", "REVERT_HEAD");
    await state.remove("MERGE_MSG");
    if (!(await this.sequenced())) {
      return { status: "ok", newHead: headId, picked: [], output: [] };
    }
    return this.run((await this.readTodo()).slice(1), true);
  }

  /** `--abort`: `reset --merge` to where the operation started, its state removed. */
  async abort(): Promise<PickOutcome> {
    const { state } = this.deps;
    const sequenced = await this.sequenced();
    const stopped = (await state.ref("CHERRY_PICK_HEAD")) ?? (await state.ref("REVERT_HEAD"));
    const headId = await this.headId();
    if (!sequenced) {
      if (!stopped) {
        return this.fail(`error: no cherry-pick or revert in progress\nfatal: ${this.name} failed`);
      }
      const refused = await resetMerge(this.deps, headId, "HEAD");
      if (refused) return this.fail(refused.message);
      await state.setRef("ORIG_HEAD", headId);
      await this.removeState();
      return { status: "ok", newHead: headId, picked: [], output: [] };
    }
    const origHead = (await state.read("sequencer/head"))?.trim();
    const safety = (await state.read("sequencer/abort-safety"))?.trim();
    if (!origHead) {
      await state.remove("sequencer");
      return this.fail(`error: could not read 'sequencer/head'\nfatal: ${this.name} failed`);
    }
    if (safety && safety !== headId) {
      await state.remove("sequencer");
      return this.fail(
        `warning: You seem to have moved HEAD. Not rewinding, check your HEAD!\nfatal: ${this.name} failed`,
      );
    }
    const refused = await resetMerge(this.deps, origHead, origHead);
    if (refused) return this.fail(refused.message);
    await this.moveHead(origHead);
    await state.setRef("ORIG_HEAD", headId);
    await this.removeState();
    return { status: "ok", newHead: origHead, picked: [], output: [] };
  }

  /** `--quit`: the operation forgotten, index, worktree and HEAD kept. */
  async quit(): Promise<PickOutcome> {
    await this.deps.state.remove("sequencer");
    await this.deps.state.removeRef("CHERRY_PICK_HEAD", "REVERT_HEAD");
    return { status: "ok", newHead: await this.headId(), picked: [], output: [] };
  }

  private async removeState(): Promise<void> {
    await this.deps.state.removeRef("CHERRY_PICK_HEAD", "REVERT_HEAD", "AUTO_MERGE");
    await this.deps.state.remove("MERGE_MSG", "sequencer");
  }

  /** git's message for the commit a pick or revert makes. */
  private messageFor(
    action: PickAction,
    id: ObjectId,
    commit: Commit,
    parentId: ObjectId | undefined,
  ): string {
    if (action === "pick") {
      return commit.message.endsWith("\n") ? commit.message : `${commit.message}\n`;
    }
    const subject = subjectOf(commit.message);
    const reverting =
      commit.parents.length > 1 && parentId
        ? `This reverts commit ${id}, reversing\nchanges made to ${parentId}.`
        : `This reverts commit ${id}.`;
    return `Revert "${subject}"\n\n${reverting}\n`;
  }

  private async commit(
    tree: ObjectId,
    parents: ObjectId[],
    author: PersonIdent,
    committer: PersonIdent,
    message: string,
  ): Promise<ObjectId> {
    const id = await this.deps.commits.store({ tree, parents, author, committer, message });
    await this.moveHead(id);
    return id;
  }

  private async moveHead(id: ObjectId): Promise<void> {
    const head = await this.deps.refs.get("HEAD");
    if (head && isSymbolicRef(head)) await this.deps.refs.set(head.target, id);
    else await this.deps.refs.set("HEAD", id);
  }

  private async headId(): Promise<ObjectId> {
    const resolved = await this.deps.refs.resolve("HEAD");
    if (!resolved?.objectId) throw new RefNotFoundError("HEAD", "HEAD cannot be resolved");
    return resolved.objectId;
  }

  /** `sequencer/todo`: `pick <abbrev> <subject>` lines. */
  private async writeTodo(todo: TodoItem[]): Promise<void> {
    const lines: string[] = [];
    for (const item of todo) {
      const commit = await this.deps.commits.load(item.id);
      lines.push(`${item.action} ${abbrev(item.id)} ${subjectOf(commit?.message ?? "")}\n`);
    }
    await this.deps.state.write("sequencer/todo", lines.join(""));
  }

  /** The todo, abbreviated ids expanded. */
  private async readTodo(): Promise<TodoItem[]> {
    const text = (await this.deps.state.read("sequencer/todo")) ?? "";
    const lines: { action: "pick" | "revert"; id: string }[] = [];
    for (const line of text.split("\n")) {
      const match = /^(pick|p|revert)\s+([0-9a-f]+)/.exec(line.trim());
      if (!match) continue;
      lines.push({ action: match[1] === "revert" ? "revert" : "pick", id: match[2] });
    }
    const ids = await expandCommitIds(
      this.deps,
      lines.map((l) => l.id),
    );
    return lines.map((l, k) => ({ action: l.action, id: ids[k] }));
  }

  /** Whether a `sequencer/` directory tracks a run of several commits. */
  private async sequenced(): Promise<boolean> {
    const { state } = this.deps;
    return (
      (await state.read("sequencer/todo")) !== undefined ||
      (await state.read("sequencer/head")) !== undefined ||
      (await state.listDir("sequencer")).length > 0
    );
  }
}

/**
 * The full id of an abbreviated commit id (as git writes them in todo lists). See
 * {@link expandCommitIds}.
 */
export async function expandCommitId(
  deps: { commits: CommandCommits; refs: CommandRefs; state: OperationState },
  id: string,
): Promise<ObjectId> {
  return (await expandCommitIds(deps, [id]))[0];
}

/**
 * The full ids of abbreviated commit ids (as git writes them in todo lists): a full id the
 * store holds is taken as it is; the others are looked up by prefix in the object store
 * (one pass over its ids for all of them, as git's `get_oid` with commit disambiguation),
 * and only where that cannot tell (a store that cannot list its ids, an ambiguous prefix)
 * in the commits reachable from the refs, HEAD, ORIG_HEAD and the sequencer's heads.
 */
export async function expandCommitIds(
  deps: { commits: CommandCommits; refs: CommandRefs; state: OperationState },
  ids: string[],
): Promise<ObjectId[]> {
  const out: (ObjectId | undefined)[] = [];
  const pending = new Set<string>();
  for (const id of ids) {
    if (id.length >= 40 && (await deps.commits.has(id))) out.push(id);
    else {
      out.push(undefined);
      pending.add(id);
    }
  }
  if (pending.size === 0) return out as ObjectId[];

  const resolved = new Map<string, ObjectId>();
  // the object store's ids, every prefix matched in one pass
  const matches = new Map<string, ObjectId[]>();
  const lengths = [...new Set([...pending].map((p) => p.length))];
  try {
    for await (const key of deps.commits.keys()) {
      for (const length of lengths) {
        const prefix = key.slice(0, length);
        if (pending.has(prefix)) {
          const list = matches.get(prefix) ?? [];
          list.push(key);
          matches.set(prefix, list);
        }
      }
    }
  } catch {
    matches.clear();
  }
  for (const [prefix, list] of matches) {
    const commits: ObjectId[] = [];
    for (const key of new Set(list)) {
      if (await deps.commits.has(key).catch(() => false)) commits.push(key);
    }
    if (commits.length === 1) resolved.set(prefix, commits[0]);
  }

  const unresolved = [...pending].filter((p) => !resolved.has(p));
  if (unresolved.length > 0) {
    const starts = new Set<ObjectId>();
    for (const name of ["HEAD", "ORIG_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD"]) {
      const ref = await deps.refs.resolve(name).catch(() => undefined);
      if (ref?.objectId) starts.add(ref.objectId);
    }
    for (const file of ["sequencer/head", "rebase-merge/orig-head", "rebase-merge/onto"]) {
      const value = (await deps.state.read(file))?.trim();
      if (value && /^[0-9a-f]{40,64}$/.test(value)) starts.add(value);
    }
    for await (const entry of deps.refs.list()) {
      const ref = await deps.refs.resolve(entry.name).catch(() => undefined);
      if (ref?.objectId) starts.add(ref.objectId);
    }
    const left = new Set(unresolved);
    const seen = new Set<ObjectId>();
    const stack = [...starts];
    while (stack.length > 0 && left.size > 0) {
      const current = stack.pop() as ObjectId;
      if (seen.has(current)) continue;
      seen.add(current);
      for (const prefix of left) {
        if (current.startsWith(prefix)) {
          resolved.set(prefix, current);
          left.delete(prefix);
        }
      }
      const commit = await deps.commits.load(current).catch(() => undefined);
      if (commit) stack.push(...commit.parents);
    }
  }
  return ids.map((id, k) => {
    const found = out[k] ?? resolved.get(id);
    if (!found) throw new RefNotFoundError(id, `Cannot resolve commit ${id}`);
    return found;
  });
}
