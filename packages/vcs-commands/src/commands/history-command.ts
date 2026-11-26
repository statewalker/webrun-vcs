/**
 * `git history reword` and `git history split` (git 2.54+, builtin/history.c): a commit is
 * rewritten (its message edited, or its changes split into two commits), the commits that
 * descend from it are replayed on top of the result (replay.c's `replay_revisions`), and the
 * branches (or HEAD alone) that pointed at them are moved in one ref transaction. No index,
 * worktree or hook is touched, so both work in a bare repository.
 *
 * @example
 * ```typescript
 * const result = await git.historyReword().addArgument("HEAD~2")
 *   .setEditor(async (_path, text) => `New subject\n${text}`).call();
 * // result.exitCode 0; result.updates: the refs moved
 *
 * const split = await git.historySplit().addArgument("HEAD").addArgument("src/")
 *   .setPatchSelector((request) => (request.type === "hunk" ? "y" : undefined))
 *   .setEditor(async () => "first part\n").call();
 * ```
 *
 * Commands report as git's process does: {@link HistoryResult} holds the exit status (255
 * after git's `error:` lines), stdout (the ref updates of `--dry-run`, split's hunk
 * selection) and stderr. git's other subcommands (`fixup`, `drop`, `squash`) are not here
 * yet.
 */

import type { Commit, ObjectId } from "@statewalker/vcs-core";
import { EMPTY_TREE_ID, FileMode } from "@statewalker/vcs-core";
import { decodeGitPath, encodeGitPath } from "@statewalker/vcs-utils/encoding";
import { tryReadFile } from "@statewalker/vcs-utils/files";
import type { WorktreeAdmin } from "@statewalker/vcs-working-tree";

import { GitCommand } from "../git-command.js";
import { ChangeType } from "../results/diff-entry.js";
import type { Status, StatusFileEntry } from "../results/status-result.js";
import {
  PATCH_MODES,
  type PatchResult,
  type PatchSelector,
  runPatchSelection,
  type TemporaryIndex,
} from "./add-patch/index.js";
import type { CommitEditor } from "./commit-command.js";
import { DiffCommand } from "./diff-command.js";
import type { LogResult } from "./log-command.js";
import { flatTree, OperationState, storeFlatTree } from "./merge-support.js";
import { commentPrefixOf, stripspace } from "./message-cleanup.js";
import { RevListCommand } from "./rev-list-command.js";
import { SigningFailedError, signRequestOf } from "./signing.js";
import { formatStatusText } from "./status-format.js";

/** One ref the command moves (or, with `--dry-run`, would move). */
export interface HistoryRefUpdate {
  ref: string;
  oldId: ObjectId;
  newId: ObjectId;
}

/** What a `git history` subcommand did, as git's process reports it. */
export interface HistoryResult {
  /** 0, or 255 after git's `error:` lines */
  exitCode: number;
  /** `--dry-run`'s `update <ref> <new> <old>` lines, split's hunk selection */
  stdout: string;
  stderr: string;
  /** The ref updates made (or printed by `--dry-run`), in git's order */
  updates: HistoryRefUpdate[];
}

/** Which refs move: every descendant branch (git's default), or HEAD alone. */
export type HistoryUpdateRefs = "branches" | "head";

/** One of git's `error()` returns: the command stops with its lines. */
class HistoryFailure extends Error {
  constructor(readonly lines: string[]) {
    super(lines.join("\n"));
    this.name = "HistoryFailure";
  }
}

const fail = (...lines: string[]): never => {
  throw new HistoryFailure(lines);
};

/** A ref decorating a commit (log-tree.c's name decorations: local branches and HEAD). */
interface Decoration {
  name: string;
  head: boolean;
}

/** builtin/history.c's shared machinery: options, the revision walk, replay, ref updates. */
export abstract class HistoryCommandBase extends GitCommand<HistoryResult> {
  protected readonly args: string[] = [];
  private dryRun = false;
  private updateRefs: HistoryUpdateRefs = "branches";
  private sign: boolean | string | undefined;
  private editor?: CommitEditor;
  protected stdout = "";
  protected stderr = "";

  /**
   * An argument as git takes it: the commit (`<commit>`), then, for split, the pathspec.
   */
  addArgument(arg: string): this {
    this.checkCallable();
    this.args.push(arg);
    return this;
  }

  /** `--dry-run`: print the ref updates (`update <ref> <new> <old>`) instead of making them. */
  setDryRun(dryRun = true): this {
    this.checkCallable();
    this.dryRun = dryRun;
    return this;
  }

  /** `--update-refs=(branches|head)` (default `branches`). */
  setUpdateRefs(mode: HistoryUpdateRefs): this {
    this.checkCallable();
    this.updateRefs = mode;
    return this;
  }

  /**
   * `--gpg-sign` (true) / `--no-gpg-sign` (false); undefined leaves it to `commit.gpgSign`.
   * Signatures are made through the host's signer (`GitHostEnvironment.signer`).
   */
  setSign(sign: boolean | undefined): this {
    this.checkCallable();
    this.sign = sign;
    return this;
  }

  /** `--gpg-sign=<key-id>`. */
  setSigningKey(keyId: string): this {
    this.checkCallable();
    this.sign = keyId;
    return this;
  }

  /**
   * The editor of the commit messages (`COMMIT_EDITMSG`, written before each launch): it
   * returns the edited text, or anything else when it edited the file in place. Without
   * one, the template is taken as it is (`GIT_EDITOR=:`). An editor that throws is git's
   * failed launch: its message (git's `error: there was a problem with the editor ...`)
   * goes to stderr.
   */
  setEditor(editor: CommitEditor): this {
    this.checkCallable();
    this.editor = editor;
    return this;
  }

  /** The subcommand's work, after its arguments are checked. */
  protected abstract run(): Promise<HistoryRefUpdate[]>;

  async call(): Promise<HistoryResult> {
    this.checkCallable();
    this.setCallable(false);
    let updates: HistoryRefUpdate[] = [];
    let exitCode = 0;
    try {
      updates = await this.run();
    } catch (error) {
      if (!(error instanceof HistoryFailure)) throw error;
      for (const line of error.lines) this.stderr += `${line}\n`;
      exitCode = 255;
    }
    return { exitCode, stdout: this.stdout, stderr: this.stderr, updates };
  }

  /** `lookup_commit_reference_by_name`: the commit a name peels to, else undefined. */
  protected async commitNamed(name: string): Promise<ObjectId | undefined> {
    const resolver = this.revisionResolver();
    let id: ObjectId | undefined;
    try {
      id = await resolver.resolve(name);
    } catch {
      return undefined;
    } finally {
      for (const warning of resolver.warnings) this.stderr += `${warning}\n`;
    }
    if (!id) return undefined;
    try {
      return await resolver.commitReference(id);
    } catch {
      return undefined;
    }
  }

  protected async loadCommit(id: ObjectId): Promise<Commit> {
    const commit = await this.commits.load(id);
    if (!commit) fail(`error: unable to parse commit ${id}`);
    return commit as Commit;
  }

  /** first_parent_tree_oid */
  protected async firstParentTree(commit: Commit): Promise<ObjectId> {
    const parent = commit.parents[0];
    if (!parent) return this.objectFormat.emptyTreeId ?? EMPTY_TREE_ID;
    return (await this.loadCommit(parent)).tree;
  }

  /**
   * setup_revwalk: the descendants of `original` the rewrite replays, in the order git
   * replays them (`--reverse --topo-order --full-history --ancestry-path=<original>
   * ^<original>`, from the branches and HEAD, or HEAD alone), refusing merges among them.
   */
  protected async descendants(original: ObjectId): Promise<LogResult[]> {
    const revs = new RevListCommand(this.workingCopy)
      .setReverse(true)
      .setOrder("topo")
      .setFullHistory(true)
      .addAncestryPath(original)
      .addRevision(`^${original}`);
    if (this.updateRefs === "head") {
      const head = await this.commitNamed("HEAD");
      if (!head) fail("error: cannot look up HEAD");
      if (head !== original && !(await this.commits.isAncestor(original, head as ObjectId))) {
        fail("error: rewritten commit must be an ancestor of HEAD when using --update-refs=head");
      }
      revs.addRevision("HEAD");
    } else {
      revs.addBranches();
      revs.addRevision("HEAD");
    }
    const walked: LogResult[] = [];
    for await (const commit of await revs.call()) walked.push(commit);
    // revwalk_contains_merges
    if (walked.some((c) => c.parents.length > 1)) {
      fail("error: replaying merge commits is not supported yet!");
    }
    return walked;
  }

  /** The key the rewritten commits are signed with (`-S`, `commit.gpgSign`). */
  private signRequest() {
    return signRequestOf(this.workingCopy, this.sign);
  }

  /**
   * commit_tree_ext: a commit of `tree` over `parents` with `original`'s author and the
   * message given (default: `original`'s), edited first when `edit` names the action;
   * undefined when the editor failed or the message came back empty (git's lines are in
   * stderr).
   */
  protected async rewriteCommit(
    original: Commit,
    parents: ObjectId[],
    oldTree: ObjectId,
    tree: ObjectId,
    action: string,
  ): Promise<ObjectId | undefined> {
    const body = original.message.replace(/^(?:[ \t\r]*\n)+/, "");
    const message = await this.editMessage(body, oldTree, tree, action);
    if (message === undefined) return undefined;
    return this.writeCommit({
      tree,
      parents,
      author: original.author,
      committer: this.resolveCommitter(),
      message,
    });
  }

  /** commit_tree_extended's signing and storing; undefined when signing failed. */
  private async writeCommit(commit: Commit): Promise<ObjectId | undefined> {
    let signed: Commit;
    try {
      signed = await this.signedCommit(this.signRequest(), commit, []);
    } catch (error) {
      if (!(error instanceof SigningFailedError)) throw error;
      if (error.message) this.stderr += `${error.message}\n`;
      return undefined;
    }
    return this.commits.store(signed);
  }

  /**
   * fill_commit_message: COMMIT_EDITMSG gets the message, git's hint and the changes from
   * `oldTree` to `tree` as `git commit` lists them; the editor's result, cleaned up.
   */
  private async editMessage(
    message: string,
    oldTree: ObjectId,
    tree: ObjectId,
    action: string,
  ): Promise<string | undefined> {
    const comment = commentPrefixOf(this.workingCopy);
    const hint =
      `Please enter the commit message for the ${action} changes. Lines starting\n` +
      `with '${comment}' will be ignored, and an empty message aborts the commit.\n`;
    let template = `${message}\n`;
    for (const line of hint.split("\n").slice(0, -1)) {
      template += line ? `${comment} ${line}\n` : `${comment}\n`;
    }
    template += await this.changesText(oldTree, tree, comment);
    const path = "COMMIT_EDITMSG";
    const state = this.gitDirFiles();
    await state.write(path, template);
    let edited = template;
    if (this.editor) {
      let answer: unknown;
      try {
        answer = await this.editor(path, template);
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        if (text) this.stderr += `${text}\n`;
        this.stderr += "Aborting commit as launching the editor failed.\n";
        return undefined;
      }
      if (typeof answer === "string") {
        edited = answer;
        await state.write(path, edited);
      } else edited = (await state.read(path)) ?? "";
    }
    const cleaned = stripspace(stripspace(edited, comment), comment);
    if (!cleaned) {
      this.stderr += "Aborting commit due to empty commit message.\n";
      return undefined;
    }
    return cleaned;
  }

  /**
   * The git directory's files (`COMMIT_EDITMSG`): the checkout's state files, or a bare
   * repository's directory.
   */
  private gitDirFiles(): {
    read(path: string): Promise<string | undefined>;
    write(path: string, text: string): Promise<void>;
  } {
    const bare = (this.workingCopy as { bareRepository?: WorktreeAdmin["bareRepository"] })
      .bareRepository;
    const files = bare?.getFiles?.();
    if (!bare || !files) return new OperationState(this.workingCopy.checkout, this.refsStore);
    const at = (path: string) => `${bare.getGitDir?.() ?? bare.getRoot()}/${path}`;
    return {
      read: async (path) => {
        const bytes = await tryReadFile(files, at(path));
        return bytes ? decodeGitPath(bytes) : undefined;
      },
      write: (path, text) => files.write(at(path), [encodeGitPath(text)]),
    };
  }

  /** wt_status_print of wt_status_collect_changes_trees: the template's change list. */
  private async changesText(oldTree: ObjectId, tree: ObjectId, comment: string): Promise<string> {
    const entries = await new DiffCommand(this.workingCopy)
      .setOldTree(oldTree)
      .setNewTree(tree)
      .setRenames(true)
      .call();
    const files: StatusFileEntry[] = entries.map((e) => {
      const path = (e.changeType === ChangeType.DELETE ? e.oldPath : e.newPath) as string;
      let index: StatusFileEntry["index"];
      switch (e.changeType) {
        case ChangeType.ADD:
          index = "A";
          break;
        case ChangeType.DELETE:
          index = "D";
          break;
        case ChangeType.RENAME:
          index = "R";
          break;
        case ChangeType.COPY:
          index = "C";
          break;
        default:
          index = typeOf(e.oldMode) !== typeOf(e.newMode) ? "T" : "M";
      }
      return {
        path,
        index,
        worktree: " ",
        ...(index === "R" || index === "C" ? { renamedFrom: e.oldPath as string } : {}),
      } as StatusFileEntry;
    });
    return formatStatusText(
      { files } as unknown as Status,
      { isInitial: false, state: {} },
      {
        format: "long",
        commentPrefix: comment,
        commitTemplate: true,
        hints: false,
        nowarn: true,
      },
    ).text;
  }

  /**
   * handle_reference_updates: the descendants replayed onto `rewritten`, the refs on them
   * (and on `original`) moved in one transaction, or printed with `--dry-run`.
   */
  protected async updateReferences(
    original: ObjectId,
    rewritten: ObjectId,
    descendants: LogResult[],
    reflogMessage: string,
  ): Promise<HistoryRefUpdate[]> {
    const headRef = await this.refsStore.get("HEAD");
    const detached = !headRef || !("target" in headRef);
    const decorations = await this.decorations();
    // replay_revisions' update set: the branches (or HEAD's branch), HEAD when detached
    const headBranch = detached ? "HEAD" : (headRef as { target: string }).target;
    const updateSet = (name: string) =>
      this.updateRefs === "head"
        ? name === headBranch
        : name.startsWith("refs/heads/") || name === headBranch;
    const updates: HistoryRefUpdate[] = [];
    const mapped = new Map<ObjectId, ObjectId>();
    for (const commit of descendants) {
      const parent = commit.parents[0];
      const base = (parent && mapped.get(parent)) ?? rewritten;
      const replayed = await this.replay(commit, base);
      mapped.set(commit.id, replayed);
      for (const d of decorations.get(commit.id) ?? []) {
        if (d.head && !detached) continue;
        if (!updateSet(d.name)) continue;
        updates.push({ ref: d.name, oldId: commit.id, newId: replayed });
      }
    }
    // compute_pending_ref_updates: the refs at the rewritten commit itself
    for (const d of decorations.get(original) ?? []) {
      if (this.updateRefs === "head" && !d.head) continue;
      if (this.updateRefs === "branches" && d.head && !detached) continue;
      updates.push({ ref: d.name, oldId: original, newId: rewritten });
    }
    if (this.dryRun) {
      for (const u of updates) this.stdout += `update ${u.ref} ${u.newId} ${u.oldId}\n`;
      return updates;
    }
    await this.applyUpdates(updates, reflogMessage);
    return updates;
  }

  /**
   * One transaction (ours: the refs under `refs/`, then a detached HEAD, which our stores
   * do not batch with other refs).
   */
  private async applyUpdates(updates: HistoryRefUpdate[], message: string): Promise<void> {
    const log = this.reflogLine(message);
    const refs = updates.filter((u) => u.ref !== "HEAD");
    const head = updates.filter((u) => u.ref === "HEAD");
    for (const group of [refs, head]) {
      if (group.length === 0) continue;
      const result = await this.refsStore.batch(
        group.map((u) => ({ name: u.ref, old: u.oldId, new: u.newId })),
        log,
      );
      if (!result.ok) {
        const rejected = result.rejected[0];
        fail(
          `error: failed to commit ref transaction: cannot lock ref '${rejected?.name ?? ""}'`,
          "error: failed replaying descendants",
        );
      }
    }
  }

  /**
   * load_ref_decorations: for each commit, HEAD (added last, listed first) and the local
   * branches at it in reverse name order.
   */
  private async decorations(): Promise<Map<ObjectId, Decoration[]>> {
    const out = new Map<ObjectId, Decoration[]>();
    const add = (id: ObjectId, d: Decoration) => {
      const list = out.get(id);
      if (list) list.unshift(d);
      else out.set(id, [d]);
    };
    const branches: { name: string; id: ObjectId }[] = [];
    for await (const ref of this.refsStore.list("refs/heads/")) {
      const resolved = await this.refsStore.resolve(ref.name);
      if (resolved?.objectId) branches.push({ name: ref.name, id: resolved.objectId });
    }
    branches.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const b of branches) add(b.id, { name: b.name, head: false });
    const head = await this.refsStore.resolve("HEAD");
    if (head?.objectId) add(head.objectId, { name: "HEAD", head: true });
    return out;
  }

  /**
   * pick_regular_commit onto `base`, whose tree is the picked commit's parent's (the
   * rewrite keeps the trees), so the merge's result is the picked commit's tree: a commit
   * with its author and message, a new committer, its extra headers but its signature.
   */
  private async replay(commit: Commit, base: ObjectId): Promise<ObjectId> {
    const id = await this.writeCommit({
      tree: commit.tree,
      parents: [base],
      author: commit.author,
      committer: this.resolveCommitter(),
      message: commit.message.replace(/^(?:[ \t\r]*\n)+/, ""),
      ...(commit.encoding ? { encoding: commit.encoding } : {}),
    });
    if (!id) fail("error: failed to write commit object", "error: failed replaying descendants");
    return id as ObjectId;
  }
}

const typeOf = (mode: number | undefined) =>
  mode === undefined
    ? undefined
    : mode === FileMode.SYMLINK
      ? "link"
      : mode === FileMode.GITLINK
        ? "gitlink"
        : mode === FileMode.TREE
          ? "tree"
          : "file";

/** `git history reword <commit>`: the commit's message edited, its descendants replayed. */
export class HistoryRewordCommand extends HistoryCommandBase {
  protected async run(): Promise<HistoryRefUpdate[]> {
    if (this.args.length !== 1) fail("error: command expects a single revision");
    const name = this.args[0] as string;
    const originalId = await this.commitNamed(name);
    if (!originalId) fail(`error: commit cannot be found: ${name}`);
    const id = originalId as ObjectId;
    const descendants = await this.descendants(id);
    const original = await this.loadCommit(id);
    const parentTree = await this.firstParentTree(original);
    const rewritten = await this.rewriteCommit(
      original,
      original.parents,
      parentTree,
      original.tree,
      "reworded",
    );
    if (!rewritten) fail("error: failed writing reworded commit");
    return this.updateReferences(
      id,
      rewritten as ObjectId,
      descendants,
      `reword: updating ${name}`,
    );
  }
}

/**
 * `git history split <commit> [<pathspec>...]`: the hunks chosen (as `git add -p` asks,
 * through {@link setPatchSelector}) become a new commit under the original one, whose own
 * changes are what remains.
 */
export class HistorySplitCommand extends HistoryCommandBase {
  private selector?: PatchSelector;
  private patchResult?: PatchResult;

  /** Answers the hunk prompts as a user would answer git on stdin (see `PatchSelector`). */
  setPatchSelector(selector: PatchSelector): this {
    this.checkCallable();
    this.selector = selector;
    return this;
  }

  /** What the hunk selection printed and did; read after {@link call}. */
  getPatchResult(): PatchResult | undefined {
    return this.patchResult;
  }

  protected async run(): Promise<HistoryRefUpdate[]> {
    if (this.args.length < 1) fail("error: command expects a committish");
    const [name, ...paths] = this.args as [string, ...string[]];
    const originalId = await this.commitNamed(name);
    if (!originalId) fail(`error: commit cannot be found: ${name}`);
    const id = originalId as ObjectId;
    const descendants = await this.descendants(id);
    const original = await this.loadCommit(id);
    if (original.parents.length > 1) fail("error: cannot split up merge commit");
    const parentTree = await this.firstParentTree(original);
    // the selection over a temporary index of the parent's tree (history-split.index)
    const temporary: TemporaryIndex = new Map(
      [...(await flatTree(this.trees, parentTree))].map(([p, e]) => [
        p,
        { mode: e.mode, objectId: e.objectId },
      ]),
    );
    const selector: PatchSelector = this.selector ?? (() => undefined);
    this.patchResult = await runPatchSelection(this.workingCopy, {
      hookSource: this,
      mode: PATCH_MODES.index,
      selector,
      diffRevision: parentTree,
      newDiffRevision: id,
      paths,
      temporaryIndex: temporary,
      disallowEdit: true,
    });
    this.stdout += this.patchResult.output;
    this.stderr += this.patchResult.errors;
    const splitTree = await storeFlatTree(
      this.trees,
      new Map([...temporary].map(([p, e]) => [p, { mode: e.mode, objectId: e.objectId }])),
    );
    if (splitTree === parentTree) fail("error: split commit is empty");
    if (splitTree === original.tree) fail("error: split commit tree matches original commit");
    const first = await this.rewriteCommit(
      original,
      original.parents,
      parentTree,
      splitTree,
      "split-out",
    );
    if (!first) fail("error: failed writing first commit");
    const second = await this.rewriteCommit(
      original,
      [first as ObjectId],
      splitTree,
      original.tree,
      "split-out",
    );
    if (!second) fail("error: failed writing second commit");
    return this.updateReferences(id, second as ObjectId, descendants, `split: updating ${name}`);
  }
}
