/**
 * `git branch --show-current` and `git branch --edit-description` (builtin/branch.c
 * `print_current_branch_name`, `edit_branch_description`).
 */

import { isSymbolicRef } from "@statewalker/vcs-core";

import { GitApiError, RefNotFoundError } from "../errors/index.js";
import { GitCommand } from "../git-command.js";
import { RemoteConfigStore } from "../remote-config/index.js";
import type { CommitEditor } from "./commit-command.js";
import { OperationState } from "./merge-support.js";
import { commentPrefixOf, stripspace } from "./message-cleanup.js";
import { worktreeUsingBranch } from "./worktree-support.js";

/**
 * The branch checked out.
 *
 * Equivalent to `git branch --show-current`: the branch HEAD names, an unborn one too, and
 * undefined on a detached HEAD (git prints nothing). A HEAD naming a ref outside
 * `refs/heads/` is refused as `git branch` refuses it (`fatal: HEAD not found below refs/heads!`).
 *
 * @example
 * ```typescript
 * const name = await git.branchShowCurrent().call(); // "main", or undefined when detached
 * ```
 */
export class ShowCurrentBranchCommand extends GitCommand<string | undefined> {
  async call(): Promise<string | undefined> {
    this.checkCallable();
    this.setCallable(false);
    const head = await this.refsStore.get("HEAD").catch(() => undefined);
    if (!head) throw new GitApiError("fatal: could not resolve HEAD");
    if (!isSymbolicRef(head)) return undefined;
    // refs_resolve_ref_unsafe without RESOLVE_REF_READING: the end of the chain, existing or not
    let name = head.target;
    for (let depth = 0; depth < 5; depth++) {
      const ref = await this.refsStore.get(name).catch(() => undefined);
      if (!ref || !isSymbolicRef(ref)) break;
      name = ref.target;
    }
    // cmd_branch dies before any mode runs: "HEAD not found below refs/heads!"
    if (!name.startsWith("refs/heads/")) {
      throw new GitApiError("fatal: HEAD not found below refs/heads!");
    }
    return name.slice("refs/heads/".length);
  }
}

/**
 * Edit a branch's description (`branch.<name>.description`).
 *
 * Equivalent to `git branch --edit-description [<branch>]`: the description so far, then
 * git's commented help, is written to `EDIT_DESCRIPTION` in the git directory and given to
 * the editor (a library cannot launch `core.editor`; the callback has the shape of
 * `CommitCommand.setEditor`'s and returns the edited text, or nothing once it changed the
 * file). The result is cleaned up as git's `stripspace` with comments stripped; an empty
 * one removes the description.
 *
 * @example
 * ```typescript
 * await git.branchEditDescription().setEditor(async () => "Work on the parser\n").call();
 * ```
 */
export class EditBranchDescriptionCommand extends GitCommand<string | undefined> {
  private branch?: string;
  private editor?: CommitEditor;

  /** The branch to describe (default: the one checked out). */
  setBranch(branch: string): this {
    this.checkCallable();
    this.branch = branch;
    return this;
  }

  /**
   * The editor: called with `EDIT_DESCRIPTION` and the text written there. Without one the
   * text is taken as written (the description kept, cleaned up).
   */
  setEditor(editor: CommitEditor): this {
    this.checkCallable();
    this.editor = editor;
    return this;
  }

  /**
   * @returns the new description, undefined when there is none
   * @throws GitApiError on a detached HEAD (`fatal: cannot give description to detached
   *   HEAD`), for a branch that does not exist (`error: no branch named '<b>'`, or `no commit
   *   on branch '<b>' yet` for one checked out; exit status 1)
   */
  async call(): Promise<string | undefined> {
    this.checkCallable();
    let name: string;
    if (this.branch === undefined) {
      const current = await this.getCurrentBranch();
      if (!current?.startsWith("refs/heads/")) {
        throw new GitApiError("fatal: cannot give description to detached HEAD");
      }
      name = current.slice("refs/heads/".length);
    } else {
      name = await this.interpretLocalBranch(await this.expandPriorCheckout(this.branch));
    }
    const refName = `refs/heads/${name}`;
    if (!(await this.refsStore.has(refName))) {
      const checkedOut =
        this.branch === undefined ||
        (this.workingCopy.worktrees
          ? (await worktreeUsingBranch(this.workingCopy.worktrees, refName)) !== undefined
          : (await this.getCurrentBranch()) === refName);
      throw new RefNotFoundError(
        refName,
        checkedOut
          ? `error: no commit on branch '${name}' yet`
          : `error: no branch named '${name}'`,
      ).withExitCode(1);
    }

    const config = RemoteConfigStore.from(this.workingCopy);
    const key = `branch.${name}.description`;
    const existing = config.value(key);
    const comment = commentPrefixOf(this.workingCopy);
    let text = existing ?? "";
    if (!text.endsWith("\n")) text += "\n";
    // strbuf_commented_addf: each line after the comment string and a space
    const help = [
      "Please edit the description for the branch",
      `  ${name}`,
      `Lines starting with '${comment}' will be stripped.`,
    ];
    text += help.map((line) => `${comment} ${line}\n`).join("");

    const state = new OperationState(this.workingCopy.checkout, this.refsStore);
    await state.write("EDIT_DESCRIPTION", text);
    let edited: string = text;
    if (this.editor) {
      const result = await this.editor("EDIT_DESCRIPTION", text);
      edited = typeof result === "string" ? result : ((await state.read("EDIT_DESCRIPTION")) ?? "");
      if (typeof result === "string") await state.write("EDIT_DESCRIPTION", result);
    }
    const description = stripspace(edited, comment);
    this.setCallable(false);
    if (description || existing !== undefined) {
      if (description) config.setValue(key, description);
      else config.unset(key);
      await config.save();
    }
    return description || undefined;
  }
}
