/**
 * RestoreCommand - `git restore`: restore worktree files, or the index, from the index or a
 * tree-ish (builtin/checkout.c `cmd_restore`, which runs `checkout_paths` with restore's
 * defaults: no overlay, the worktree only unless `--staged`, `--source=HEAD` with
 * `--staged`).
 *
 * @example
 * ```typescript
 * // discard the worktree changes of every .txt file
 * await git.restore().addPath("*.txt").call();
 *
 * // unstage src/ (the index's entries from HEAD), keeping the worktree
 * await git.restore().setStaged(true).addPath("src").call();
 *
 * // both from an older commit; files the commit lacks are removed
 * await git.restore().setSource("HEAD~2").setStaged(true).setWorktree(true).addPath("d").call();
 * ```
 */

import type { ObjectId } from "@statewalker/vcs-core";
import type { ConflictStyle } from "@statewalker/vcs-utils";

import { InvalidArgumentError } from "../errors/index.js";
import { GitCommand } from "../git-command.js";
import {
  type PatchCompatibility,
  type PatchOptions,
  type PatchSelector,
  patchRevisionOf,
  pathPatchMode,
  runPatchSelection,
} from "./add-patch/index.js";
import {
  type CheckoutResult,
  type CheckoutStage,
  CheckoutStatus,
  pathCheckoutResult,
} from "./checkout-command.js";
import { runPathCheckout } from "./checkout-paths.js";
import { runPostCheckoutHook } from "./git-hooks.js";
import { hostEnvironmentOf } from "./git-ident.js";
import { globalPathspecMagic, parsePathspecFile } from "./pathspec.js";

/**
 * `git restore [--source=<tree>] [--staged] [--worktree] [--overlay] [--ours|--theirs|-m]
 * [--ignore-unmerged] [--ignore-skip-worktree-bits] [--] <pathspec>...`.
 *
 * The result is a {@link CheckoutResult}: `OK`, or `CONFLICTS` where git reports an error
 * and exits 1 (an element that matched nothing, an unmerged path), nothing changed then,
 * git's lines in `message`. Where git dies (option conflicts, an unknown source) it throws.
 * git's restore has no `--ignore-unmatch`: an element matching nothing is always an error.
 */
export class RestoreCommand extends GitCommand<CheckoutResult> {
  private readonly paths: string[] = [];
  private pathspecFromFile: string[] = [];
  private source?: string;
  private staged?: boolean;
  private worktree?: boolean;
  private overlay = false;
  private ignoreSkipWorktreeBits = false;
  private stage?: CheckoutStage;
  private merge = false;
  private conflictStyle?: ConflictStyle;
  private ignoreUnmerged = false;
  private quiet = false;
  private patch = false;
  private patchSelector?: PatchSelector;
  private patchOptions: PatchOptions = {};
  private patchCompatibility: PatchCompatibility = "2.56";

  /**
   * `git restore -p`: the differences between the source and the worktree (with
   * `--staged`: the index; with both: index and worktree) are offered hunk by hunk, as
   * git's add-patch.c does, and the selected hunks restored. Without a source the worktree
   * is compared with the index ("Discard this hunk from worktree"); `--staged` alone takes
   * HEAD ("Unstage this hunk"). The prompts are answered by {@link setPatchSelector}; the
   * result's `patch` carries git's transcript. No post-checkout hook runs.
   *
   * @example
   * ```typescript
   * const answers = ["y", "n"];
   * const { patch } = await git.restore().setStaged(true).setPatch(true)
   *   .setPatchSelector(() => answers.shift()).call();
   * ```
   */
  setPatch(patch: boolean): this {
    this.checkCallable();
    this.patch = patch;
    return this;
  }

  /** Answers the prompts of {@link setPatch}. */
  setPatchSelector(selector: PatchSelector): this {
    this.checkCallable();
    this.patchSelector = selector;
    return this;
  }

  /** `-U<n>`, `--inter-hunk-context=<n>` and `--no-auto-advance` of {@link setPatch}. */
  setPatchOptions(options: PatchOptions): this {
    this.checkCallable();
    this.patchOptions = { ...options };
    return this;
  }

  /** The git version whose prompts {@link setPatch} reproduces (default 2.56). */
  setCompatibility(version: PatchCompatibility): this {
    this.checkCallable();
    this.patchCompatibility = version;
    return this;
  }

  /** `git restore -p`: run_add_p with the mode of what is restored. */
  private async callPatch(): Promise<CheckoutResult> {
    if (this.overlay) {
      throw new InvalidArgumentError(
        "overlay",
        true,
        "fatal: options '-p' and '--overlay' cannot be used together",
      );
    }
    // checkout_main: --staged and --worktree default to "worktree only"; --staged implies
    // --source=HEAD
    const index = this.staged === true;
    const worktree = this.worktree ?? !index;
    if (!index && !worktree) {
      throw new InvalidArgumentError(
        "worktree",
        false,
        "fatal: you must specify path(s) to restore",
      );
    }
    const source = this.source ?? (index ? "HEAD" : undefined);
    const { revision, diffRevision } = await patchRevisionOf(source, {
      headId: async () => (await this.refsStore.resolve("HEAD"))?.objectId,
      resolve: (name) => this.resolveRevision(name),
      peelCommit: (id) => this.revisionResolver().peelToType(id, "commit"),
    });
    const patch = await runPatchSelection(this.workingCopy, {
      ...this.patchOptions,
      mode: pathPatchMode(index, worktree, revision),
      selector: this.patchSelector,
      ...(diffRevision !== undefined ? { diffRevision } : {}),
      paths: [...this.pathspecFromFile, ...this.paths],
      compatibility: this.patchCompatibility,
    });
    return {
      status: CheckoutStatus.OK,
      updated: patch.applied,
      removed: [],
      conflicts: [],
      ref: null,
      patch,
    };
  }

  /** Adds a pathspec element (wildcards and magic as git reads them). */
  addPath(path: string): this {
    this.checkCallable();
    this.paths.push(path);
    return this;
  }

  /** `--pathspec-from-file` (and `--pathspec-file-nul` with `nul`): the elements of `content`. */
  setPathspecFromFile(content: string | Uint8Array, nul = false): this {
    this.checkCallable();
    try {
      this.pathspecFromFile = parsePathspecFile(content, nul);
    } catch (error) {
      throw new InvalidArgumentError(
        "pathspecFromFile",
        content,
        `fatal: ${(error as Error).message}`,
      );
    }
    return this;
  }

  /** `--source=<tree-ish>`: restore from it (default: the index, or HEAD with `--staged`). */
  setSource(source: string): this {
    this.checkCallable();
    this.source = source;
    return this;
  }

  /** `--staged`: restore the index. */
  setStaged(staged: boolean): this {
    this.checkCallable();
    this.staged = staged;
    return this;
  }

  /** `--worktree`: restore the worktree (the default unless `--staged` is given). */
  setWorktree(worktree: boolean): this {
    this.checkCallable();
    this.worktree = worktree;
    return this;
  }

  /** `--overlay`: never remove what the source lacks (restore's default is no overlay). */
  setOverlay(overlay: boolean): this {
    this.checkCallable();
    this.overlay = overlay;
    return this;
  }

  /** `--ignore-skip-worktree-bits`: restore skip-worktree entries too. */
  setIgnoreSkipWorktreeBits(ignore: boolean): this {
    this.checkCallable();
    this.ignoreSkipWorktreeBits = ignore;
    return this;
  }

  /** `--ours` / `--theirs`: unmerged paths take that stage's content in the worktree. */
  setStage(stage: CheckoutStage): this {
    this.checkCallable();
    this.stage = stage;
    return this;
  }

  /** `-m` / `--merge`: unmerged paths are merged again, with conflict markers. */
  setMerge(merge: boolean): this {
    this.checkCallable();
    this.merge = merge;
    return this;
  }

  /** `--conflict=<style>`: as {@link setMerge}, with this conflict style. */
  setConflictStyle(style: ConflictStyle): this {
    this.checkCallable();
    this.conflictStyle = style;
    return this;
  }

  /** `--ignore-unmerged`: unmerged paths are passed over with a warning. */
  setIgnoreUnmerged(ignore: boolean): this {
    this.checkCallable();
    this.ignoreUnmerged = ignore;
    return this;
  }

  /** `-q`: no "path is unmerged" warnings. */
  setQuiet(quiet: boolean): this {
    this.checkCallable();
    this.quiet = quiet;
    return this;
  }

  async call(): Promise<CheckoutResult> {
    this.checkCallable();
    this.setCallable(false);
    await this.readCurrentIndex();
    if (this.patch) return this.callPatch();
    if (this.paths.length > 0 && this.pathspecFromFile.length > 0) {
      throw new InvalidArgumentError(
        "pathspecFromFile",
        this.pathspecFromFile,
        "fatal: '--pathspec-from-file' and pathspec arguments cannot be used together",
      );
    }
    let globalMagic: ReturnType<typeof globalPathspecMagic>;
    try {
      globalMagic = globalPathspecMagic(hostEnvironmentOf(this.workingCopy)?.pathspecs);
    } catch (error) {
      throw new InvalidArgumentError("path", this.paths, `fatal: ${(error as Error).message}`);
    }
    const run = async () =>
      pathCheckoutResult(
        await runPathCheckout(
          {
            workingCopy: this.workingCopy,
            staging: this.staging,
            trees: this.trees,
            blobs: this.blobs,
            worktree: this.worktreeAccess,
            abbreviate: (id: ObjectId) => this.abbreviateObjectId(id),
            resolveTree: async (rev: string) => {
              const id = await this.resolveRevision(rev === "-" ? "@{-1}" : rev);
              return { id, tree: await this.revisionResolver().peelToType(id, "tree") };
            },
          },
          {
            command: "restore",
            paths: [...this.pathspecFromFile, ...this.paths],
            ...(this.source !== undefined ? { source: this.source } : {}),
            ...(this.staged !== undefined ? { staged: this.staged } : {}),
            ...(this.worktree !== undefined ? { worktree: this.worktree } : {}),
            overlay: this.overlay,
            ignoreSkipWorktree: this.ignoreSkipWorktreeBits,
            ...(this.stage !== undefined ? { stage: this.stage } : {}),
            merge: this.merge,
            ...(this.conflictStyle ? { conflictStyle: this.conflictStyle } : {}),
            ignoreUnmerged: this.ignoreUnmerged,
            quiet: this.quiet,
            globalMagic,
          },
        ),
      );
    const worktree = this.worktreeAccess;
    const result = await (worktree?.batch ? worktree.batch(run) : run());
    // checkout_paths' post-checkout hook (`<HEAD> <HEAD> 0`), as for `git checkout -- <paths>`
    if (!this.hooks.enabled) return result;
    if (result.status !== CheckoutStatus.OK && result.exitCode === undefined) return result;
    const head = (await this.refsStore.resolve("HEAD"))?.objectId;
    const code = await runPostCheckoutHook(this.hooks, head, head, false);
    return code !== 0 && result.exitCode === undefined ? { ...result, exitCode: code } : result;
  }
}
