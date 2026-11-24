/**
 * git's sequencer for `cherry-pick` and `revert`: each commit's change merged into HEAD by
 * merge-ort and written to the index and the worktree, committed or stopped at a conflict
 * with git's state (`CHERRY_PICK_HEAD` / `REVERT_HEAD`, `MERGE_MSG`, `AUTO_MERGE`, and for
 * several commits `sequencer/` with `head`, `todo` and `abort-safety`), so native git can
 * `--continue`, `--skip` or `--abort` what we started and the other way round.
 */

import {
  type Commit,
  type ObjectId,
  objectFormatOf,
  type PersonIdent,
} from "@statewalker/vcs-core";
import { compareGitPaths, parseGitBool } from "@statewalker/vcs-utils/encoding";
import type { Worktree } from "@statewalker/vcs-working-tree";
import { GitApiError } from "../errors/git-api-error.js";
import {
  InvalidMainlineParentError,
  MultipleParentsNotAllowedError,
} from "../errors/merge-errors.js";
import { NotACommitError, RefNotFoundError } from "../errors/ref-errors.js";
import type { CommandCommits, CommandRefs, CommandTrees } from "../git-command.js";
import { RemoteConfigStore } from "../remote-config/index.js";
import { coreBool, createIdAbbreviator, type IdAbbreviator } from "./core-config.js";
import { type HookSession, sequencerPostCommit, sequencerPrepareMessage } from "./git-hooks.js";
import { authorIdentOf, committerIdentOf } from "./git-ident.js";
import { UNMERGED_FILES_MESSAGE } from "./merge-command.js";
import { conflictStyleOf } from "./merge-config.js";
import { ortConfigOptions } from "./merge-drivers.js";
import { parseStrategyOptions, strategyOrtOptions } from "./merge-strategy-options.js";
import {
  conflictsComment,
  FlatTreeCache,
  flatTree,
  indexChanges,
  indexChangesFromTree,
  type MergeWriteContext,
  type OperationState,
  readIndex,
  storeFlatTree,
  storeFlatTreeOver,
  subjectOf,
  switchTrees,
  treeDelta,
  writeIndexAsTree,
} from "./merge-support.js";
import { stripspace } from "./message-cleanup.js";
import { octopusMerge } from "./octopus-merge.js";
import { type OrtConflict, ortResultEntries } from "./ort-merge.js";
import { mergeStoredTrees, storedBase } from "./ort-recursive.js";
import { reflogLine, reflogMessages, updateHead } from "./reflog-messages.js";
import {
  cleanupMessage,
  moveHeadAsReset,
  removeBranchState,
  resetMerge,
} from "./sequencer-support.js";
import { SigningFailedError, type SignRequest, signCommit, signRequestOf } from "./signing.js";
import { appendSignoff, signoffLine, trailerConfigOf, trailerLinesOf } from "./trailers.js";
import type { CheckedEntry } from "./worktree-overwrite-checks.js";

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
  /** The hooks of the command (prepare-commit-msg and post-commit around each commit) */
  hooks?: HookSession;
  /**
   * A `git commit` run by the sequencer; the commit made, or the error that stopped it (its
   * editor, an empty message, a hook). `pick`: `git commit -n -e` as git's run_git_commit
   * runs it for a pick with `--edit` (EDIT_MSG without VERIFY_MSG): MERGE_MSG as the
   * template of the editor, `reflogAction` as its GIT_REFLOG_ACTION. `continue`:
   * continue_single_pick's `git commit` for a resolved conflict, `--no-edit --cleanup=strip`
   * unless `edit` (its editor): every hook (pre-commit and commit-msg too), its own reflog
   * message, no GIT_REFLOG_ACTION. Needed for {@link PickOptions.edit}; without it a
   * resolved conflict is committed in process.
   */
  gitCommit?: (mode: PickCommitMode) => Promise<ObjectId>;
}

/** The `git commit` the sequencer runs (see {@link SequencerDeps.gitCommit}). */
export type PickCommitMode =
  | { kind: "pick"; reflogAction: string; allowEmpty?: boolean }
  | { kind: "continue"; edit: boolean };

/** Options of one sequencer run. */
export interface PickOptions {
  action: PickAction;
  noCommit?: boolean;
  mainline?: number;
  favor?: "ours" | "theirs" | "union";
  /**
   * `-s <strategy>` (git's opts->strategy): `ort`/`recursive` (merge-ort, as without one),
   * `resolve` (git-merge-resolve) or `subtree` (git merge-subtree); a revert always runs
   * merge-ort. Saved in `sequencer/opts` (`options.strategy`).
   */
  strategy?: string;
  /** `-X <option>`s (saved in `sequencer/opts` as `options.strategy-option`) */
  strategyOptions?: string[];
  /** The git version to follow where they differ (default: the hook runner's) */
  compatibility?: "2.43" | "2.56";
  /** The label of HEAD in conflict markers (default `HEAD`) */
  oursLabel?: string;
  /**
   * The committer (default: resolved as git resolves it, `GIT_COMMITTER_*`, `committer.*`,
   * `user.*`); also a revert's author when nobody is configured
   */
  committer?: PersonIdent;
  /** The action of the picks' reflog lines (default `cherry-pick` / `revert`) */
  reflogAction?: string;
  /**
   * `--edit`: each pick that merges cleanly is committed by `git commit -n -e` (see
   * {@link SequencerDeps.gitCommit}), its message edited, with git commit's hooks; a
   * conflict resolved and continued is committed by `git commit` with its editor. `false`
   * is `--no-edit` given; both are saved in `sequencer/opts` for `--continue` and `--skip`
   * (git's `options.edit`), left out when neither was given.
   */
  edit?: boolean;
  /**
   * `-S[<keyid>]` (true or the key) / `--no-gpg-sign` (false); undefined: `commit.gpgSign`.
   * Saved in `sequencer/opts` (`options.gpg-sign`) for a run of several commits.
   */
  sign?: boolean | string;
  /** `-x`: `(cherry picked from commit <id>)` appended to a pick's message (record_origin) */
  recordOrigin?: boolean;
  /** `-s` / `--signoff`: the committer's `Signed-off-by:` appended (append_signoff) */
  signoff?: boolean;
  /** `--allow-empty`: a commit empty in itself (its tree its first parent's) is committed */
  allowEmpty?: boolean;
  /** `--allow-empty-message` (saved in `sequencer/opts`; the sequencer commits any message) */
  allowEmptyMessage?: boolean;
  /**
   * `--keep-redundant-commits` / `--empty=keep`: a commit that becomes empty is committed
   * (implies {@link allowEmpty})
   */
  keepRedundant?: boolean;
  /** `--empty=drop`: a commit that becomes empty is dropped, git's `dropping ...` line printed */
  dropRedundant?: boolean;
  /** `--ff`: a commit whose parent is HEAD is fast-forwarded to, not picked */
  allowFf?: boolean;
  /**
   * `revert --reference` (or `revert.reference`): the reverted commit named as
   * `<abbrev> (<subject>, <date>)` under a `*** SAY WHY ...` comment for the title
   */
  reference?: boolean;
}

/** The flags of a run, read back from `sequencer/opts` (git's replay_opts). */
interface PickFlags {
  noCommit: boolean;
  mainline?: number;
  recordOrigin: boolean;
  signoff: boolean;
  allowEmpty: boolean;
  allowEmptyMessage: boolean;
  keepRedundant: boolean;
  dropRedundant: boolean;
  allowFf: boolean;
}

/** commit.cleanup as the sequencer reads it (git_sequencer_config). */
type SequencerCleanup = "whitespace" | "verbatim" | "scissors" | "strip";

/**
 * builtin/revert.c's verify_opt_compatible: the `fatal:` line refusing an option that cannot
 * go with `--continue`/`--skip`/`--abort`/`--quit` or with `--ff`, as git checks them; undefined
 * when the options go together.
 */
export function pickOptionsConflict(
  action: PickAction,
  operation: SequencerOperation,
  options: PickOptions & { emptyGiven?: boolean },
  /** git 2.43 lets `--keep-redundant-commits` and `--empty` go with the operations */
  compatibility?: "2.43" | "2.56",
): string | undefined {
  const me = ACTION_NAME[action];
  const keep = !!options.keepRedundant;
  if (operation !== SequencerOperation.START) {
    const op = `--${operation}`;
    const given: [string, boolean][] = [
      ["--no-commit", !!options.noCommit],
      ["--signoff", !!options.signoff],
      ["--mainline", !!options.mainline],
      ["-x", !!options.recordOrigin],
      ["--ff", !!options.allowFf],
      ["--keep-redundant-commits", keep && compatibility !== "2.43"],
      ["--empty", !!options.emptyGiven && compatibility !== "2.43"],
    ];
    const first = given.find(([, on]) => on);
    if (first) return `fatal: ${me}: ${first[0]} cannot be used with ${op}`;
  }
  if (options.allowFf) {
    const given: [string, boolean][] = [
      ["--signoff", !!options.signoff],
      ["--no-commit", !!options.noCommit],
      ["-x", !!options.recordOrigin],
      ["--edit", options.edit === true],
    ];
    const first = given.find(([, on]) => on);
    if (first) return `fatal: ${me}: ${first[0]} cannot be used with --ff`;
  }
  return undefined;
}

/** The boolean options of `sequencer/opts` (populate_opts_cb). */
const SAVED_FLAGS: Record<string, keyof Omit<PickFlags, "mainline"> | undefined> = {
  "no-commit": "noCommit",
  "allow-empty": "allowEmpty",
  "allow-empty-message": "allowEmptyMessage",
  "drop-redundant-commits": "dropRedundant",
  "keep-redundant-commits": "keepRedundant",
  signoff: "signoff",
  "record-origin": "recordOrigin",
  "allow-ff": "allowFf",
};

/** git_sequencer_config's commit.cleanup (get_cleanup_mode for a saved one). */
function cleanupOf(value: string | undefined): SequencerCleanup | undefined {
  switch (value) {
    case "verbatim":
    case "whitespace":
    case "strip":
    case "scissors":
      return value;
    default:
      return undefined;
  }
}

function configuredCleanup(
  workingCopy: SequencerDeps["workingCopy"],
): SequencerCleanup | undefined {
  return cleanupOf(RemoteConfigStore.from(workingCopy).value("commit.cleanup"));
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
  /** The clock of this run's identities and reflog lines, read again for each commit */
  private clock?: number;
  /** git's find_unique_abbrev (`core.abbrev`) for labels, messages and the todo */
  private readonly abbreviator: IdAbbreviator;
  /** `--edit` / `--no-edit` (git's opts->edit, unset: undefined), read back from the opts */
  private edit: boolean | undefined;
  /** What the commits are signed with (git's opts->gpg_sign), read back from the opts */
  private sign: SignRequest;
  /** The flags of the run (given, or read back from `sequencer/opts`) */
  private readonly flags: PickFlags;
  /** commit.cleanup (git's default_msg_cleanup with explicit_cleanup), or saved in the opts */
  private cleanup: SequencerCleanup | undefined;
  /** `-s` (git's opts->strategy), or saved in the opts */
  private strategy: string | undefined;
  /** `-X` options (git's opts->xopts), or saved in the opts */
  private xopts: string[];

  constructor(
    private readonly deps: SequencerDeps,
    private readonly options: PickOptions,
  ) {
    this.flats = new FlatTreeCache(deps.trees);
    this.abbreviator = createIdAbbreviator(deps.workingCopy);
    this.edit = options.edit;
    this.sign = signRequestOf(deps.workingCopy, options.sign);
    const keepRedundant = !!options.keepRedundant;
    this.flags = {
      noCommit: !!options.noCommit,
      mainline: options.mainline,
      recordOrigin: !!options.recordOrigin,
      signoff: !!options.signoff,
      // --keep-redundant-commits implies --allow-empty (run_sequencer)
      allowEmpty: !!options.allowEmpty || keepRedundant,
      allowEmptyMessage: !!options.allowEmptyMessage,
      keepRedundant,
      dropRedundant: !!options.dropRedundant,
      allowFf: !!options.allowFf,
    };
    this.cleanup = configuredCleanup(deps.workingCopy);
    this.strategy = options.strategy;
    this.xopts = [...(options.strategyOptions ?? [])];
  }

  /** The git version to follow where they differ */
  private get compatibility(): "2.43" | "2.56" {
    return this.options.compatibility ?? this.deps.hooks?.compatibility ?? "2.56";
  }

  private config(key: string): string | undefined {
    return RemoteConfigStore.from(this.deps.workingCopy).value(key);
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
    if (unmerged.length > 0 && this.flags.noCommit) {
      // do_pick_commit's write_index_as_tree fails first
      return this.fail(`error: your index file is unmerged.\nfatal: ${this.name} failed`);
    }
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
    let lastNamed = "";
    for (const name of names) {
      const id = await this.resolvePick(name);
      lastNamed = id;
      // the revision walk lists each commit once (its SEEN flag), first naming first
      if (!ids.includes(id)) ids.push(id);
    }
    const todo = ids.map((id) => ({ action: this.options.action, id }));
    if (todo.length > 1) {
      // sequencer_pick_revisions on an unborn HEAD refuses only a revert; a pick saves as
      // sequencer/head what its failed repo_get_oid("HEAD") left in `oid`, which in git 2.43
      // and 2.56 builds alike is the id of the last commit named (the loop over the pending
      // revisions shares its stack slot), and an empty abort-safety
      const headId = await this.headIfBorn();
      if (!headId && this.options.action === "revert") {
        return this.fail(`error: can't revert as initial commit\nfatal: ${this.name} failed`);
      }
      await state.write("sequencer/head", `${headId ?? lastNamed}\n`);
      await this.writeTodo(todo);
      await state.write("sequencer/abort-safety", `${headId ?? ""}\n`);
      // save_opts, in its order (git config's format)
      const f = this.flags;
      const opts: string[] = [];
      const flag = (name: string, on: boolean) => on && opts.push(`\t${name} = true\n`);
      flag("no-commit", f.noCommit);
      if (this.edit !== undefined) opts.push(`\tedit = ${this.edit}\n`);
      flag("allow-empty", f.allowEmpty);
      flag("allow-empty-message", f.allowEmptyMessage);
      flag("drop-redundant-commits", f.dropRedundant);
      flag("keep-redundant-commits", f.keepRedundant);
      flag("signoff", f.signoff);
      flag("record-origin", f.recordOrigin);
      flag("allow-ff", f.allowFf);
      if (f.mainline) opts.push(`\tmainline = ${f.mainline}\n`);
      if (this.strategy) opts.push(`\tstrategy = ${configValueText(this.strategy)}\n`);
      if (this.sign !== undefined) {
        opts.push(`\tgpg-sign = ${configValueText(String(this.sign))}\n`);
      }
      for (const x of this.xopts) opts.push(`\tstrategy-option = ${configValueText(x)}\n`);
      if (this.cleanup) opts.push(`\tdefault-msg-cleanup = ${this.cleanup}\n`);
      if (opts.length > 0) await state.write("sequencer/opts", `[options]\n${opts.join("")}`);
    }
    return this.run(todo, todo.length > 1);
  }

  /**
   * The commit a name to pick or revert names; a tree or a blob is git's `error: <name>:
   * can't cherry-pick a tree` (revision walk), a missing object `fatal: bad object <id>`.
   */
  private async resolvePick(name: string): Promise<ObjectId> {
    try {
      return await this.deps.resolve(name);
    } catch (error) {
      if (!(error instanceof NotACommitError)) throw error;
      const message = error.objectType
        ? `error: ${name}: can't cherry-pick a ${error.objectType}\nfatal: ${this.name} failed`
        : `fatal: bad object ${name}`;
      throw new NotACommitError(name, error.objectId, error.objectType, message);
    }
  }

  /** Picks `todo` in order; `sequenced`: a `sequencer/` directory tracks the progress. */
  private async run(todo: TodoItem[], sequenced: boolean): Promise<PickOutcome> {
    const output: string[] = [];
    const picked: ObjectId[] = [];
    let newHead = await this.headIfBorn();
    for (let k = 0; k < todo.length; k++) {
      const item = todo[k];
      const outcome = await this.pickOne(item, output);
      if (outcome.status !== "ok") {
        if (sequenced) {
          await this.writeTodo(todo.slice(k));
          await this.deps.state.write(
            "sequencer/abort-safety",
            `${(await this.headIfBorn()) ?? ""}\n`,
          );
        }
        return { ...outcome, picked, output };
      }
      picked.push(item.id);
      newHead = outcome.newHead ?? newHead;
      if (sequenced) {
        await this.writeTodo(todo.slice(k + 1));
        await this.deps.state.write("sequencer/abort-safety", `${newHead ?? ""}\n`);
      }
    }
    if (sequenced) await this.deps.state.remove("sequencer");
    return { status: "ok", newHead, picked, output };
  }

  /** The merge of a pick: {@link mergePickChange} with this run's strategy and options. */
  private mergePick(p: Omit<PickMergeArgs, "strategy" | "xopts" | "oursLabel" | "favor">) {
    return mergePickChange(
      { ...this.deps, flats: this.flats, abbreviate: (id) => this.abbreviator.abbreviate(id) },
      {
        ...p,
        strategy: this.strategy,
        xopts: this.xopts,
        oursLabel: this.options.oursLabel ?? "HEAD",
        favor: this.options.favor,
        compatibility: this.compatibility,
      },
    );
  }

  /** One commit's change merged into HEAD (do_pick_commit). */
  private async pickOne(item: TodoItem, output: string[]): Promise<PickOutcome> {
    const { deps, flags } = this;
    const action = item.action;
    const name = ACTION_NAME[action];
    const format = objectFormatOf(deps.workingCopy.history);
    const commit = await deps.commits.load(item.id);
    if (!commit) throw new RefNotFoundError(item.id, `Cannot find commit: ${item.id}`);
    // an unborn HEAD picks onto the empty tree (repo_get_oid fails: `unborn`)
    const headId = await this.headIfBorn();
    const headCommit = headId ? await deps.commits.load(headId) : undefined;
    if (headId && !headCommit) throw new RefNotFoundError(headId, "HEAD commit not found");
    const headTree = headCommit?.tree ?? format.emptyTreeId;
    // with --no-commit the change is merged into the index as it is (git's
    // write_index_as_tree): each commit's change on top of the previous one's
    const headTreeId = flags.noCommit
      ? await writeIndexAsTree(deps.staging, deps.trees, format)
      : headTree;
    // a commit is never made on top of staged changes (error_dirty_index)
    const { index } = await readIndex(deps.staging);
    if (!flags.noCommit && (await indexChangesFromTree(index, deps.trees, headTreeId)).length > 0) {
      return this.fail(
        `error: your local changes would be overwritten by ${name}.\nhint: commit your changes or stash them to proceed.\nfatal: ${name} failed`,
      );
    }

    // the parent the change is taken against (`-m`: a merge's parent, at most 1 otherwise)
    let parentId: ObjectId | undefined;
    const mainline = flags.mainline;
    const noParent = (n: number) =>
      new InvalidMainlineParentError(
        n,
        commit.parents.length,
        `error: commit ${item.id} does not have parent ${n}\nfatal: ${name} failed`,
      );
    if (commit.parents.length > 1) {
      if (!mainline) {
        throw new MultipleParentsNotAllowedError(
          `error: commit ${item.id} is a merge but no -m option was given.\nfatal: ${name} failed`,
        );
      }
      if (mainline > commit.parents.length) throw noParent(mainline);
      parentId = commit.parents[mainline - 1];
    } else if (mainline !== undefined && mainline > 1) {
      throw noParent(mainline);
    } else {
      parentId = commit.parents[0];
    }

    // --ff: a commit on HEAD (a root commit on an unborn branch) is fast-forwarded to
    if (flags.allowFf && ((parentId && parentId === headId) || (!parentId && !headId))) {
      return this.fastForward(item.id, headId, headTree, commit.tree, output);
    }

    const parentTreeId = parentId ? await deps.commits.getTree(parentId) : undefined;
    const subject = subjectOf(commit.message);
    // get_message: short_commit_name, repo_find_unique_abbrev with DEFAULT_ABBREV
    const short = await this.abbreviator.abbreviate(item.id);
    const label = `${short} (${subject})`;
    const parentLabel = parentId ? `parent of ${label}` : "(empty tree)";
    const [base, theirs, baseLabel, theirsLabel] =
      action === "pick"
        ? [parentTreeId, commit.tree, parentLabel, label]
        : [commit.tree, parentTreeId, label, parentLabel];
    const merged = await this.mergePick({
      action,
      headId,
      headTreeId,
      base,
      theirs,
      baseLabel,
      theirsLabel,
      pickId: item.id,
      parentId,
    });
    if ("failed" in merged) {
      if (!merged.strategyFailed) return this.fail(merged.failed, merged.output ?? []);
      // do_pick_commit wrote MERGE_MSG before running the strategy; no CHERRY_PICK_HEAD
      await deps.state.write("MERGE_MSG", await this.messageFor(action, item.id, commit, parentId));
      const short = await this.abbreviator.abbreviate(item.id);
      const verb = action === "pick" ? "apply" : "revert";
      const lines = [
        ...(merged.failed ? [merged.failed] : []),
        `error: could not ${verb} ${short}... ${subjectOf(commit.message)}`,
        // git 2.43's sequencer returns the error without dying
        ...(this.compatibility === "2.43" ? [] : [`fatal: ${name} failed`]),
      ];
      return this.fail(lines.join("\n"), merged.output ?? []);
    }
    const { treeId, conflicts, clean } = merged;
    // only the paths HEAD and the result differ on are switched
    const delta = merged.delta ?? (await treeDelta(deps.trees, headTreeId, treeId));
    const refused = await switchTrees(deps, delta.from, delta.to, {
      action: "merge",
      operation: name,
      conflicts,
      ...(merged.delta ? {} : { targetTree: treeId }),
    });
    if (refused) {
      return this.fail(`${refused.message}\nfatal: ${name} failed`, merged.refusedOutput ?? []);
    }
    output.push(...merged.messages);
    // merge-ort records its result tree (git-merge-resolve does not)
    if (merged.autoMerge) await deps.state.setRef("AUTO_MERGE", treeId);
    const ort = !merged.external;
    const message = await this.messageFor(action, item.id, commit, parentId);

    if (conflicts.length > 0 || !clean) {
      const paths = [...new Set(conflicts.map((c) => c.stagePath))].sort(compareGitPaths);
      // git records REVERT_HEAD for a revert -n too (do_pick_commit), never CHERRY_PICK_HEAD
      if (!flags.noCommit || action === "revert") {
        await deps.state.setRef(HEAD_REF[action], item.id);
      }
      // do_recursive_merge adds the conflicts hint; another strategy's MERGE_MSG has none
      await deps.state.write(
        "MERGE_MSG",
        ort ? `${message}${conflictsComment(paths, true)}` : message,
      );
      const advice = flags.noCommit
        ? [
            "hint: after resolving the conflicts, mark the corrected paths",
            "hint: with 'git add <paths>' or 'git rm <paths>'",
          ]
        : [
            "hint: After resolving the conflicts, mark them with",
            'hint: "git add/rm <pathspec>", then run',
            `hint: "git ${name} --continue".`,
            `hint: You can instead skip this commit with "git ${name} --skip".`,
            `hint: To abort and get back to the state before "git ${name}",`,
            `hint: run "git ${name} --abort".`,
          ];
      return {
        status: "conflicting",
        conflicts: paths,
        picked: [],
        output,
        message: [
          // git-merge-one-file's stderr (`ERROR: content conflict in f`, ...)
          ...(merged.errors ?? []),
          `error: could not ${action === "pick" ? "apply" : "revert"} ${short}... ${subject}`,
          ...advice,
        ].join("\n"),
      };
    }
    // a clean merge: CHERRY_PICK_HEAD (not with --no-commit), MERGE_MSG, REVERT_HEAD for a
    // revert -n, before allow_empty and do_commit (a commit that fails leaves them)
    if (action === "pick" && !flags.noCommit) await deps.state.setRef(HEAD_REF[action], item.id);
    await deps.state.write("MERGE_MSG", message);
    if (action === "revert" && flags.noCommit) await deps.state.setRef(HEAD_REF[action], item.id);

    // allow_empty: a result equal to HEAD's tree is committed (1), dropped (2) or stops (0)
    let allow: 0 | 1 | 2 = 0;
    if (treeId === headTree) {
      const firstParentTree = commit.parents[0]
        ? await deps.commits.getTree(commit.parents[0])
        : format.emptyTreeId;
      const originallyEmpty = firstParentTree === commit.tree;
      allow = originallyEmpty
        ? flags.allowEmpty
          ? 1
          : 0
        : flags.keepRedundant
          ? 1
          : flags.dropRedundant
            ? 2
            : 0;
    }
    if (allow === 2) {
      await deps.state.deleteRef("CHERRY_PICK_HEAD");
      await deps.state.remove("MERGE_MSG");
      await deps.state.deleteRef("AUTO_MERGE");
      output.push(`dropping ${item.id} ${subject} -- patch contents already upstream`);
      return { status: "ok", newHead: headId, picked: [item.id], output };
    }
    if (flags.noCommit) {
      return { status: "ok", newHead: headId, picked: [item.id], output };
    }
    if (treeId === headTree && allow === 0) {
      // nothing to commit: try_to_commit leaves it to `git commit`, which stops, the pick in
      // progress, for `git commit --allow-empty` or --skip (CHERRY_PICK_HEAD only: git
      // records REVERT_HEAD for a revert that conflicts)
      return {
        status: "conflicting",
        conflicts: [],
        picked: [],
        output,
        message: [
          `The previous ${name} is now empty, possibly due to conflict resolution.`,
          "If you wish to commit it anyway, use:",
          "",
          "    git commit --allow-empty",
          "",
          `Otherwise, please use 'git ${name} --skip'`,
        ].join("\n"),
      };
    }
    if (this.edit && deps.gitCommit) {
      // do_pick_commit with EDIT_MSG: the message in MERGE_MSG, CHERRY_PICK_HEAD for a pick
      // (git commit then takes its author and says it concludes a cherry-pick), then
      // run_git_commit; git commit cleans up after itself (CHERRY_PICK_HEAD, MERGE_MSG)
      let newHead: ObjectId;
      try {
        newHead = await deps.gitCommit({
          kind: "pick",
          reflogAction: this.options.reflogAction ?? name,
          allowEmpty: allow === 1,
        });
      } catch (error) {
        if (!(error instanceof GitApiError)) throw error;
        // the commit failed (an empty message, its editor): the pick stays in progress
        return { status: "failed", message: error.message, output, picked: [] };
      }
      return { status: "ok", newHead, picked: [item.id], output };
    }
    const committer = this.committer();
    const newHead = await this.commit(
      treeId,
      headId ? [headId] : [],
      action === "pick" ? commit.author : this.revertAuthor(committer),
      committer,
      message,
      // the sequencer's update_head_with_reflog: "cherry-pick: <subject>", "revert: ..."
      (text) => reflogMessages.pick(this.options.reflogAction ?? name, text),
    );
    // do_commit after try_to_commit: CHERRY_PICK_HEAD (deleted whether there or not) and
    // MERGE_MSG go, a stopped empty pick's left over included (REVERT_HEAD and AUTO_MERGE stay)
    await deps.state.deleteRef("CHERRY_PICK_HEAD");
    await deps.state.remove("MERGE_MSG");
    return { status: "ok", newHead, picked: [item.id], output };
  }

  /**
   * fast_forward_to: the index and worktree switched from HEAD's tree to the commit's
   * (checkout_fast_forward, a two-way switch refusing over local changes), then HEAD moved
   * there with the reflog line `<action>: fast-forward`.
   */
  private async fastForward(
    id: ObjectId,
    headId: ObjectId | undefined,
    headTree: ObjectId,
    targetTree: ObjectId,
    output: string[],
  ): Promise<PickOutcome> {
    const delta = await treeDelta(this.deps.trees, headTree, targetTree);
    const refused = await switchTrees(this.deps, delta.from, delta.to, {
      action: "merge",
      operation: this.name,
      targetTree,
    });
    if (refused) return this.fail(`${refused.message}\nfatal: ${this.name} failed`);
    await this.moveHead(id, `${this.name}: fast-forward`, headId ?? null);
    return { status: "ok", newHead: id, picked: [id], output };
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
    await this.readSavedOptions();
    let todo = sequenced ? await this.readTodo() : [];
    let newHead = await this.headId();
    if (stopped) {
      const action: PickAction = pickHead ? "pick" : "revert";
      const commit = await this.deps.commits.load(stopped);
      if (!commit) throw new RefNotFoundError(stopped, "Commit being picked not found");
      const treeId = await this.deps.staging.writeTree(this.deps.trees);
      const headCommit = await this.deps.commits.load(newHead);
      const fallback = await this.messageFor(action, stopped, commit, commit.parents[0]);
      const prepared = (await state.read("MERGE_MSG")) ?? fallback;
      // continue_single_pick runs `git commit --no-edit --cleanup=strip` (plain `git commit`
      // under --edit): without the editor its prepare_to_commit writes MERGE_MSG with its
      // whitespace cleaned up (comments kept) to COMMIT_EDITMSG, before a commit with nothing
      // to commit is refused
      if (!this.edit) await state.write("COMMIT_EDITMSG", stripspace(prepared));
      if (headCommit?.tree === treeId) {
        return this.fail(
          `The previous ${ACTION_NAME[action]} is now empty, possibly due to conflict resolution.`,
        );
      }
      if (this.deps.gitCommit) {
        // git commit itself: its hooks (pre-commit and commit-msg too), its reflog message,
        // and it ends the stopped pick (CHERRY_PICK_HEAD, REVERT_HEAD, MERGE_MSG, AUTO_MERGE)
        try {
          newHead = await this.deps.gitCommit({ kind: "continue", edit: this.edit === true });
        } catch (error) {
          if (!(error instanceof GitApiError)) throw error;
          return this.fail(error.message);
        }
        if (todo[0]?.id === stopped) todo = todo.slice(1);
        if (!sequenced) return { status: "ok", newHead, picked: [stopped], output: [] };
        await this.writeTodo(todo);
        await state.write("sequencer/abort-safety", `${newHead}\n`);
        const outcome = await this.run(todo, true);
        return { ...outcome, picked: [stopped, ...outcome.picked] };
      }
      const committer = this.committer();
      const message = cleanupMessage(prepared);
      newHead = await this.commit(
        treeId,
        [newHead],
        action === "pick" ? commit.author : this.revertAuthor(committer),
        committer,
        message,
        // `--continue` commits as `git commit` does: "commit (cherry-pick): <subject>" (a
        // revert is no whence of git commit: "commit: <subject>")
        (text) => reflogMessages.commit(action === "pick" ? "cherry-pick" : undefined, text),
        "verbatim",
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
      // sequencer_skip: neither this action's head nor a sequence of it to go on with
      return this.fail(`error: no ${this.name} in progress\nfatal: ${this.name} failed`);
    }
    await this.readSavedOptions();
    const headId = await this.headId();
    const refused = await resetMerge(this.deps, headId, "HEAD");
    if (refused) return this.fail(refused.message);
    // git reset --merge <HEAD's id> records ORIG_HEAD, and HEAD's reflog line
    const errors = await this.resetRefs(headId, headId);
    await state.remove("MERGE_MSG");
    if (!(await this.sequenced())) {
      return { status: "ok", newHead: headId, picked: [], output: errors };
    }
    const outcome = await this.run((await this.readTodo()).slice(1), true);
    return { ...outcome, output: [...errors, ...outcome.output] };
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
      // git's rollback_single_pick: `reset --merge <HEAD's id>`
      const errors = await this.resetRefs(headId, headId);
      await this.removeState();
      return { status: "ok", newHead: headId, picked: [], output: errors };
    }
    const origHead = (await state.read("sequencer/head"))?.trim();
    const safety = (await state.read("sequencer/abort-safety"))?.trim();
    if (!origHead) {
      await state.remove("sequencer");
      return this.fail(`error: could not read 'sequencer/head'\nfatal: ${this.name} failed`);
    }
    if (/^0+$/.test(origHead)) {
      // sequencer_rollback: a run started on an unborn branch is not rewound (state kept)
      return this.fail(
        `error: cannot abort from a branch yet to be born\nfatal: ${this.name} failed`,
      );
    }
    if (safety && safety !== headId) {
      await state.remove("sequencer");
      return this.fail(
        `warning: You seem to have moved HEAD. Not rewinding, check your HEAD!\nfatal: ${this.name} failed`,
      );
    }
    const refused = await resetMerge(this.deps, origHead, origHead);
    if (refused) return this.fail(refused.message);
    // git's reset_merge(<sequencer/head>): `reset --merge <id>`
    const errors = await this.resetRefs(headId, origHead);
    await this.removeState();
    return { status: "ok", newHead: origHead, picked: [], output: errors };
  }

  /**
   * `--quit` (builtin/revert.c): sequencer_remove_state (`sequencer/` removed), then
   * remove_branch_state (CHERRY_PICK_HEAD, REVERT_HEAD, AUTO_MERGE, SQUASH_MSG, MERGE_MSG,
   * MERGE_HEAD, MERGE_MODE, MERGE_RR go, a MERGE_AUTOSTASH is kept on `refs/stash`); the
   * index, the worktree, HEAD and ORIG_HEAD are kept. Nothing in progress is no error.
   */
  async quit(): Promise<PickOutcome> {
    await this.deps.state.remove("sequencer");
    const output = await removeBranchState(this.deps, this.deps.state);
    // an unborn HEAD is no error here
    const head = (await this.deps.refs.resolve("HEAD").catch(() => undefined))?.objectId;
    return { status: "ok", ...(head ? { newHead: head } : {}), picked: [], output };
  }

  /**
   * The refs of the `git reset --merge <target>` git runs (its index and worktree reset
   * already): ORIG_HEAD and HEAD (update_refs), then remove_branch_state (CHERRY_PICK_HEAD,
   * REVERT_HEAD, AUTO_MERGE and the merge state). Returns its `error:` lines for an ORIG_HEAD
   * it could not write (HEAD moved all the same).
   */
  private async resetRefs(headId: ObjectId, target: ObjectId): Promise<string[]> {
    this.clock ??= Math.floor(Date.now() / 1000);
    const log = reflogLine(
      this.deps.workingCopy,
      reflogMessages.reset(target),
      this.options.committer,
      this.clock,
    );
    const errors = await moveHeadAsReset(this.deps.refs, this.deps.state, headId, target, log);
    await removeBranchState(this.deps, this.deps.state);
    return errors;
  }

  /**
   * read_populate_opts: `options.edit` and `options.gpg-sign` of `sequencer/opts` (git
   * config's syntax, the last value wins), the `--edit` / `--no-edit` and `-S` the run
   * started with.
   */
  private async readSavedOptions(): Promise<void> {
    const text = await this.deps.state.read("sequencer/opts");
    if (text === undefined) return;
    let section = "";
    let xoptsRead = false;
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      const header = /^\[\s*([^\]\s]+)\s*\]/.exec(line);
      if (header) {
        section = header[1].toLowerCase();
        continue;
      }
      const entry = /^([A-Za-z][A-Za-z0-9-]*)\s*=\s*(.*)$/.exec(line);
      if (section !== "options" || !entry) continue;
      const name = entry[1].toLowerCase();
      const text = parseConfigValueText(entry[2]);
      if (text === undefined) continue;
      if (name === "gpg-sign") {
        this.sign = text;
        continue;
      }
      if (name === "mainline") {
        const value = Number.parseInt(text, 10);
        if (Number.isFinite(value)) this.flags.mainline = value;
        continue;
      }
      if (name === "default-msg-cleanup") {
        this.cleanup = cleanupOf(text) ?? this.cleanup;
        continue;
      }
      if (name === "strategy") {
        this.strategy = text;
        continue;
      }
      if (name === "strategy-option") {
        if (!xoptsRead) this.xopts = [];
        xoptsRead = true;
        this.xopts.push(text);
        continue;
      }
      const value = parseGitBool(text);
      if (value === undefined) continue;
      if (name === "edit") this.edit = value;
      const key = SAVED_FLAGS[name];
      if (key) this.flags[key] = value;
    }
  }

  private async removeState(): Promise<void> {
    await this.deps.state.removeRef("CHERRY_PICK_HEAD", "REVERT_HEAD", "AUTO_MERGE");
    await this.deps.state.remove("MERGE_MSG", "sequencer");
  }

  /**
   * git's message for the commit a pick or revert makes (do_pick_commit's ctx->message): a
   * pick's message from its subject on, with `-x`'s `(cherry picked from commit <id>)` (after a
   * blank line unless the message ends with a trailer block); a revert's `Revert "<subject>"`
   * (`Reapply "..."` for a revert of a revert, `--reference`'s comment and `<abbrev> (<subject>,
   * <date>)`); then `-s`'s sign-off (append_signoff).
   */
  private async messageFor(
    action: PickAction,
    id: ObjectId,
    commit: Commit,
    parentId: ObjectId | undefined,
  ): Promise<string> {
    let message: string;
    if (action === "pick") {
      // find_commit_subject: the message from its first non-blank line
      message = commit.message.replace(/^(?:[ \t]*\n)+/, "");
      if (this.flags.recordOrigin) {
        if (message.length > 0 && !message.endsWith("\n")) message += "\n";
        if (trailerLinesOf(message, trailerConfigOf(this.deps.workingCopy)).length === 0) {
          message += "\n";
        }
        message += `(cherry picked from commit ${id})\n`;
      }
    } else {
      message = await this.revertMessage(id, commit, parentId);
    }
    if (this.flags.signoff) {
      const committer = this.options.committer ?? committerIdentOf(this.deps.workingCopy);
      message = appendSignoff(
        message,
        signoffLine(committer),
        trailerConfigOf(this.deps.workingCopy),
      );
    }
    return message;
  }

  /** sequencer_format_revert_message. */
  private async revertMessage(
    id: ObjectId,
    commit: Commit,
    parentId: ObjectId | undefined,
  ): Promise<string> {
    const subject = subjectOf(commit.message);
    const reference = this.options.reference ?? revertReferenceOf(this.deps.workingCopy);
    let out: string;
    if (reference) {
      // git 2.43 wrote `#` whatever core.commentChar said (2.45 follows it)
      const comment =
        this.deps.hooks?.compatibility === "2.43" ? "#" : commentStringOf(this.deps.workingCopy);
      out = `${comment} *** SAY WHY WE ARE REVERTING ON THE TITLE LINE ***\n`;
    } else if (subject.startsWith('Revert "') && !subject.slice(8).startsWith('Revert "')) {
      out = `Reapply "${subject.slice(8)}\n`;
    } else {
      out = `Revert "${subject}"\n`;
    }
    const refer = async (target: ObjectId) => {
      if (!reference) return target;
      const referred = await this.deps.commits.load(target);
      const short = await this.abbreviator.abbreviate(target);
      return `${short} (${subjectOf(referred?.message ?? "")}, ${shortDate(referred?.author)})`;
    };
    out += `\nThis reverts commit ${await refer(id)}`;
    if (commit.parents.length > 1 && parentId) {
      out += `, reversing\nchanges made to ${await refer(parentId)}`;
    }
    return `${out}.\n`;
  }

  /**
   * The committer of the commit a pick is about to make: the one given, else resolved as
   * git's `git_committer_info`. The clock is read again first, as git's `try_to_commit`
   * calls `reset_ident_date()` before each commit; the pick's reflog line keeps that time.
   */
  private committer(): PersonIdent {
    this.clock = Math.floor(Date.now() / 1000);
    return this.options.committer ?? committerIdentOf(this.deps.workingCopy, { now: this.clock });
  }

  /**
   * A revert's author: resolved as git's `git_author_info` (`GIT_AUTHOR_*`, `author.*`,
   * `user.*`), the committer's name when nobody is configured. (A pick keeps its author.)
   */
  private revertAuthor(committer: PersonIdent): PersonIdent {
    this.clock ??= Math.floor(Date.now() / 1000);
    return authorIdentOf(this.deps.workingCopy, { now: this.clock, fallback: committer });
  }

  private async commit(
    tree: ObjectId,
    parents: ObjectId[],
    author: PersonIdent,
    committer: PersonIdent,
    message: string,
    reflogMessage: (text: string) => string,
    /** a cleanup of the message after the hook (default: the sequencer's, see cleanupMode) */
    cleanup: SequencerCleanup = this.commitCleanup(),
  ): Promise<ObjectId> {
    // try_to_commit: prepare-commit-msg may rewrite the message; post-commit after
    const hooks = this.deps.hooks;
    let text = hooks ? await sequencerPrepareMessage(hooks, this.deps.state, message) : message;
    if (cleanup !== "verbatim") {
      text = stripspace(
        text,
        cleanup === "strip" ? commentStringOf(this.deps.workingCopy) : undefined,
      );
    }
    const id = await this.deps.commits.store(
      await this.signed({ tree, parents, author, committer, message: text }),
    );
    await this.moveHead(id, reflogMessage(text));
    if (hooks) await sequencerPostCommit(hooks);
    return id;
  }

  /**
   * try_to_commit's cleanup: whitespace for `-s`/`-x` unless commit.cleanup is set, else
   * commit.cleanup's (`scissors` is whitespace without an editor), else none.
   */
  private commitCleanup(): SequencerCleanup {
    if ((this.flags.signoff || this.flags.recordOrigin) && !this.cleanup) return "whitespace";
    if (this.cleanup === "scissors") return "whitespace";
    return this.cleanup ?? "verbatim";
  }

  /**
   * try_to_commit's commit_tree signing `commit` for the run's key (git's opts->gpg_sign),
   * the signing program in the worktree top. When it cannot be signed: gpg's error and
   * `error: failed to write commit object`, then in git 2.43 `fatal: <action> failed` (exit
   * 128); 2.5x returns after the error (exit 1). The pick stays in progress
   * (CHERRY_PICK_HEAD, MERGE_MSG), as git leaves it.
   */
  private async signed(commit: Commit): Promise<Commit> {
    const sign = this.sign;
    if (sign === undefined) return commit;
    const legacy = this.deps.hooks?.compatibility === "2.43";
    const cwd = await this.deps.hooks?.hostWorkingDirectory().catch(() => undefined);
    try {
      return await signCommit(this.deps.workingCopy, sign, commit, {
        tail: [],
        ...(cwd !== undefined ? { cwd } : {}),
      });
    } catch (error) {
      if (!(error instanceof SigningFailedError)) throw error;
      // the signing died itself (ssh without a key): git dies there
      if (/(^|\n)fatal: [^\n]*$/.test(error.message)) throw error;
      throw new SigningFailedError(
        [
          error.message,
          "error: failed to write commit object",
          ...(legacy ? [`fatal: ${this.name} failed`] : []),
        ].join("\n"),
        sign,
        legacy ? 128 : 1,
        {
          ...(error.signerMessages ? { signerMessages: error.signerMessages } : {}),
          ...(error.programExitCode !== undefined
            ? { programExitCode: error.programExitCode }
            : {}),
        },
      );
    }
  }

  /** HEAD (its branch, when attached) moved to `id`, with `message` in the reflogs. */
  private async moveHead(
    id: ObjectId,
    message: string,
    /** the old value the transaction expects (default HEAD's, null for an unborn HEAD) */
    expected?: ObjectId | null,
  ): Promise<void> {
    this.clock ??= Math.floor(Date.now() / 1000);
    const log = reflogLine(this.deps.workingCopy, message, this.options.committer, this.clock);
    // update_head_with_reflog: one transaction on HEAD expecting the commit's parent, as the
    // reference-transaction hook sees it
    const current = expected !== undefined ? expected : await this.headIfBorn();
    const result = await this.deps.refs.batch(
      [{ name: "HEAD", old: current ?? null, new: id }],
      log,
    );
    if (result.ok) return;
    // HEAD moved meanwhile: git's transaction fails on the old value it expects
    if (result.rejected.some((r) => r.reason === "mismatch")) {
      throw new GitApiError(`fatal: cannot lock ref 'HEAD': is at another value`);
    }
    if (result.rejected.some((r) => r.reason === "locked")) throw await this.headLockedError();
    // a store whose batches cannot take HEAD (no transactions there): HEAD set as that store
    // sets it, without the old value checked (git has no such path)
    await updateHead(this.deps.refs, id, log);
  }

  /**
   * git's failure of a commit whose ref lock another process holds: try_to_commit's
   * `error: cannot lock ref 'HEAD'` with lockfile.c's hint (2.43's longer wording), then in
   * git 2.43 `fatal: <action> failed` (exit 128); 2.5x returns after the error (exit 1).
   */
  private async headLockedError(): Promise<GitApiError> {
    let name = "HEAD";
    for (let i = 0; i < 5; i++) {
      const ref = await this.deps.refs.get(name).catch(() => undefined);
      if (!ref || !("target" in ref)) break;
      name = ref.target;
    }
    // lockfile.c names the lock by its absolute path: git runs from the top, where
    // absolute_path keeps the logical $PWD (symbolic links not followed)
    const gitDir =
      (await this.deps.hooks?.hostGitDir({ real: false }).catch(() => undefined)) ??
      (this.deps.workingCopy as { config?: { hostGitDir?: string } }).config?.hostGitDir;
    const lockPath = `${gitDir ? gitDir.replace(/\/+$/, "") : ".git"}/${name}.lock`;
    const legacy = this.deps.hooks?.compatibility === "2.43";
    const hint = legacy
      ? [
          "Another git process seems to be running in this repository, e.g.",
          "an editor opened by 'git commit'. Please make sure all processes",
          "are terminated then try again. If it still fails, a git process",
          "may have crashed in this repository earlier:",
          "remove the file manually to continue.",
        ]
      : [
          "Another git process seems to be running in this repository, or the lock file may be stale",
        ];
    return new GitApiError(
      [
        `error: cannot lock ref 'HEAD': Unable to create '${lockPath}': File exists.`,
        "",
        ...hint,
        ...(legacy ? [`fatal: ${this.name} failed`] : []),
      ].join("\n"),
    );
  }

  /** HEAD's commit, undefined while HEAD's branch is unborn. */
  private async headIfBorn(): Promise<ObjectId | undefined> {
    const resolved = await this.deps.refs.resolve("HEAD").catch(() => undefined);
    return resolved?.objectId || undefined;
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
      const short = await this.abbreviator.abbreviate(item.id);
      lines.push(`${item.action} ${short} ${subjectOf(commit?.message ?? "")}\n`);
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

/** `revert.reference` (git_sequencer_config, revert only). */
function revertReferenceOf(workingCopy: SequencerDeps["workingCopy"]): boolean {
  const value = RemoteConfigStore.from(workingCopy).value("revert.reference");
  return value === undefined ? false : (parseGitBool(value) ?? false);
}

/** comment_line_str: `core.commentString`, else `core.commentChar` (`auto`: `#`). */
function commentStringOf(workingCopy: SequencerDeps["workingCopy"]): string {
  const config = RemoteConfigStore.from(workingCopy);
  const value = config.value("core.commentString") ?? config.value("core.commentChar");
  return value && value !== "auto" ? value : "#";
}

/** DATE_SHORT of an ident: `YYYY-MM-DD` in its own zone. */
function shortDate(ident: PersonIdent | undefined): string {
  if (!ident) return "";
  const tz = ident.tzOffset || "+0000";
  const sign = tz.startsWith("-") ? -1 : 1;
  const minutes = sign * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(3, 5)));
  const d = new Date((ident.timestamp + minutes * 60) * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** What {@link mergePickChange} reads and writes with. */
export interface PickMergeContext {
  workingCopy: SequencerDeps["workingCopy"];
  worktree?: Worktree;
  staging: SequencerDeps["staging"];
  blobs: SequencerDeps["blobs"];
  trees: CommandTrees;
  commits: CommandCommits;
  flats: FlatTreeCache;
  abbreviate: (id: ObjectId) => Promise<string>;
}

/** The pick {@link mergePickChange} merges. */
export interface PickMergeArgs {
  action: PickAction;
  headId: ObjectId | undefined;
  /** HEAD's tree (undefined: the empty tree of an unborn branch) */
  headTreeId: ObjectId | undefined;
  base: ObjectId | undefined;
  theirs: ObjectId | undefined;
  baseLabel: string;
  theirsLabel: string;
  pickId: ObjectId;
  parentId: ObjectId | undefined;
  /** `-s` (undefined: merge-ort) */
  strategy: string | undefined;
  /** `-X` options */
  xopts: readonly string[];
  /** HEAD's label in merge-ort's markers */
  oursLabel: string;
  /** `-X ours` / `-X theirs` / union given apart from the options */
  favor?: "ours" | "theirs" | "union";
  /** The git version whose behaviour to follow where they differ (default 2.56) */
  compatibility?: "2.43" | "2.56";
}

/** What {@link mergePickChange} found: the result to switch to, or git's failure. */
export type PickMergeResult =
  | {
      treeId: ObjectId;
      conflicts: OrtConflict[];
      /** The paths the conflicts are about (merge-ort's keys; a file moved aside's own path) */
      conflictPaths: string[];
      clean: boolean;
      /** What the strategy printed (merge-ort's messages, git-merge-resolve's stdout) */
      messages: string[];
      /** Whether to record AUTO_MERGE (merge-ort's result tree) */
      autoMerge: boolean;
      /** Whether the strategy ran as git's child command (resolve, subtree) */
      external: boolean;
      /** What git-merge-one-file printed on stderr */
      errors?: string[];
      /** The switch to make, when it is not HEAD's tree to `treeId` */
      delta?: { from: Map<string, CheckedEntry>; to: Map<string, CheckedEntry> };
      /** What was printed before a refused switch */
      refusedOutput?: string[];
    }
  | {
      failed: string;
      /** The strategy gave up (exit 2): the pick fails as do_pick_commit's res -1 */
      strategyFailed?: boolean;
      output?: string[];
    };

/**
 * The merge of a pick (do_pick_commit): merge-ort (do_recursive_merge, with the `-X`
 * options) unless `-s` names another strategy; `subtree` is git merge-subtree (merge-ort
 * with the shift, the commits' full ids as labels), `resolve` git-merge-resolve
 * (`read-tree -m --aggressive` and git-merge-one-file). Nothing is written but blobs and
 * trees: the caller switches to the result.
 */
export async function mergePickChange(
  ctx: PickMergeContext,
  p: PickMergeArgs,
): Promise<PickMergeResult> {
  const strategy = p.strategy;
  const ort =
    strategy === undefined ||
    strategy === "recursive" ||
    strategy === "ort" ||
    p.action === "revert";
  if (!ort && strategy === "resolve" && p.headId) {
    // git-merge-resolve refuses an index that differs from HEAD's commit (`git diff-index
    // --cached HEAD`), whatever tree the sequencer merges onto (`--no-commit`: the index's)
    const headFlat = await flatTree(ctx.trees, p.headTreeId);
    const headCommitFlat = await flatTree(ctx.trees, await ctx.commits.getTree(p.headId));
    const { index } = await readIndex(ctx.staging);
    const outcome = await octopusMerge(
      {
        commits: ctx.commits,
        trees: ctx.trees,
        blobs: ctx.blobs,
        style: conflictStyleOf(ctx.workingCopy),
      },
      p.headId,
      [{ id: p.pickId, name: p.pickId }],
      indexChanges(index, headCommitFlat),
      { resolve: true, bases: p.parentId ? [p.parentId] : [] },
    );
    if (outcome.status === 2) {
      // the strategy did not handle the merge: do_pick_commit's "could not apply" (no hints)
      return { failed: outcome.errors.join("\n"), strategyFailed: true, output: outcome.output };
    }
    const target = new Map(outcome.index);
    for (const [path, entry] of outcome.worktree) target.set(path, entry);
    const treeId = await storeFlatTree(ctx.trees, outcome.index);
    return {
      treeId,
      conflicts: outcome.conflicts,
      conflictPaths: outcome.conflicts.map((c) => c.stagePath),
      clean: outcome.status === 0,
      messages: outcome.output,
      errors: outcome.errors,
      autoMerge: false,
      external: true,
      delta: { from: headFlat, to: target },
      refusedOutput: outcome.output.slice(0, outcome.steps[0]?.output ?? 0),
    };
  }
  if (!ort && strategy !== "subtree") {
    return { failed: `fatal: merge strategy '${strategy}' is not supported here` };
  }
  // do_recursive_merge reads the options without checking them (merge-subtree dies on an
  // unknown one, before merging)
  const xopts = parseStrategyOptions(p.xopts, ort);
  const subtree = !ort;
  const flats = ctx.flats;
  const labels = subtree
    ? {
        oursLabel: p.headId ?? "HEAD",
        theirsLabel: p.pickId,
        baseLabel: p.parentId ? await ctx.abbreviate(p.parentId) : "empty tree",
      }
    : {
        oursLabel: p.oursLabel,
        theirsLabel: p.theirsLabel,
        baseLabel: p.baseLabel,
      };
  const subtreeShift = xopts.subtreeShift ?? (subtree ? "" : undefined);
  const merge = await mergeStoredTrees(
    ctx,
    storedBase(p.base, labels.baseLabel, () => flats.get(p.base)),
    p.headTreeId,
    p.theirs,
    {
      ...labels,
      style: conflictStyleOf(ctx.workingCopy),
      favor: p.favor ?? xopts.favor,
      ignoreCase: coreBool(ctx.workingCopy, "ignorecase", false),
      ...ortConfigOptions(ctx.workingCopy, ctx.worktree, {
        ...(xopts.renormalize !== undefined ? { renormalize: xopts.renormalize } : {}),
      }),
      // merge-subtree runs with init_basic_merge_options (no diff.algorithm)
      ...strategyOrtOptions(subtree ? undefined : ctx.workingCopy, xopts),
      ...(subtreeShift !== undefined ? { subtreeShift } : {}),
    },
    (id) => flats.get(id),
  );
  const target = await ortResultEntries(ctx.blobs, merge);
  // only the directories the pick changes are stored again
  const treeId = await storeFlatTreeOver(ctx.trees, p.headTreeId, merge.ours, target);
  return {
    treeId,
    conflicts: [...merge.conflicts.values()],
    conflictPaths: [...merge.conflicts.keys()],
    clean: merge.clean,
    messages: merge.messages,
    // merge-subtree runs as a child: git 2.5x's (merge-ort's merge_switch_to_result) records
    // AUTO_MERGE, 2.43's (merge-recursive) never
    autoMerge: ort || p.compatibility !== "2.43",
    external: !ort,
  };
}

/**
 * config.c's write_pair: a value as `git config` writes it (quoted when it starts or ends
 * with a space or holds `;`, `#` or CR; `\n`, `\t`, `"` and `\` escaped).
 */
export function configValueText(value: string): string {
  const quote = value.startsWith(" ") || value.endsWith(" ") || /[;#\r]/.test(value) ? '"' : "";
  const body = value.replace(/[\n\t"\\]/g, (c) =>
    c === "\n" ? "\\n" : c === "\t" ? "\\t" : `\\${c}`,
  );
  return `${quote}${body}${quote}`;
}

/**
 * config.c's parse_value of the text after a variable's `=` on one line: blanks around it
 * dropped, `"..."` keeping them, escapes undone, an unquoted `;` or `#` starting a comment;
 * undefined where git refuses the line.
 */
export function parseConfigValueText(text: string): string | undefined {
  let quote = false;
  let value = "";
  let trimLength = 0;
  for (let i = 0; i < text.length; i++) {
    let c = text[i];
    if ((c === " " || c === "\t") && !quote) {
      if (!trimLength) trimLength = value.length;
      if (value.length) value += c;
      continue;
    }
    if (!quote && (c === ";" || c === "#")) break;
    trimLength = 0;
    if (c === "\\") {
      c = text[++i] ?? "";
      if (c === "t") c = "\t";
      else if (c === "b") c = "\b";
      else if (c === "n") c = "\n";
      else if (c !== "\\" && c !== '"') return undefined;
      value += c;
      continue;
    }
    if (c === '"') {
      quote = !quote;
      continue;
    }
    value += c;
  }
  if (quote) return undefined;
  return trimLength ? value.slice(0, trimLength) : value;
}
