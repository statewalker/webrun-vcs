import { MemoryStagingStore } from "@statewalker/vcs-store-mem";
import { compareGitPaths, decodeGitPath } from "@statewalker/vcs-utils/encoding";

import { GitApiError } from "../errors/index.js";
import { DiffCommand, type DiffOutputFormat, type DiffTextOptions } from "./diff-command.js";
import { configBool } from "./merge-config.js";
import { flatTree } from "./merge-support.js";
import { StashInfoCommand } from "./stash-info.js";

/** Which part of a stash `git stash show` shows. */
export type StashShowUntracked = "none" | "include" | "only";

/**
 * `git stash show [-u | --only-untracked] [<diff-options>] [<stash>]`: the change a stash
 * records, from the commit it was made on to its worktree state, printed as `git diff`.
 *
 * As git's show_stash: with no diff option given, `stash.showStat` (default true) and
 * `stash.showPatch` (default false) choose `--stat`, the patch, both, or nothing; any diff
 * option ({@link setFormats}, {@link setOptions}) turns them off (the patch by default).
 * `-u` ({@link setUntracked} `include`, default `stash.showIncludeUntracked`) adds the
 * stashed untracked files (git's `diff_include_untracked`: the worktree and untracked trees
 * merged, a path in both refused with `worktree and untracked commit have duplicate
 * entries`), `--only-untracked` shows them alone (a root diff of the untracked tree).
 *
 * @example
 * ```typescript
 * const stat = await git.stashShow().call(); // git stash show
 * const patch = await git.stashShow().setStashRef("1").setFormats(["patch"]).call();
 * const all = await git.stashShow().setUntracked("include").setFormats(["stat", "patch"]).call();
 * ```
 */
export class StashShowCommand extends StashInfoCommand<string> {
  private stashRef?: string;
  private untracked?: StashShowUntracked;
  private formats?: DiffOutputFormat[];
  private diffOptions?: DiffTextOptions;

  /** The stash to show: `stash@{n}`, a number n, or any stash-like commit. */
  setStashRef(stashRef: string): this {
    this.checkCallable();
    this.stashRef = stashRef;
    return this;
  }

  /**
   * `-u`/`--include-untracked` (`include`), `--only-untracked` (`only`),
   * `--no-include-untracked` (`none`); the last given wins, as on git's command line.
   */
  setUntracked(untracked: StashShowUntracked): this {
    this.checkCallable();
    this.untracked = untracked;
    return this;
  }

  /** The diff formats (`--stat`, `-p`, `--numstat`...), in any order: git prints them in its own. */
  setFormats(formats: DiffOutputFormat[]): this {
    this.checkCallable();
    this.formats = [...formats];
    return this;
  }

  /** Other diff options (`--patience`, `--src-prefix`, `-R`...); they turn the configuration off. */
  setOptions(options: DiffTextOptions): this {
    this.checkCallable();
    this.diffOptions = { ...this.diffOptions, ...options };
    return this;
  }

  /** The output, as git prints it to a pipe. */
  async call(): Promise<string> {
    this.checkCallable();
    this.setCallable(false);
    const info = await this.getStashInfo(this.stashRef);
    const untracked =
      this.untracked ??
      (configBool(this.workingCopy, "stash.showIncludeUntracked", false) ? "include" : "none");

    let formats = this.formats;
    if (formats === undefined && this.diffOptions === undefined) {
      // the configuration applies only when no diff option is given
      formats = [];
      if (configBool(this.workingCopy, "stash.showStat", true)) formats.push("stat");
      if (configBool(this.workingCopy, "stash.showPatch", false)) formats.push("patch");
      if (formats.length === 0) return "";
    }
    if (!formats || formats.length === 0) formats = ["patch"];

    const diff = new DiffCommand(this.workingCopy).shareReadsOf(this);
    if (this.diffOptions) diff.setOptions(this.diffOptions);
    if (untracked === "only") {
      if (!info.uTree) return "";
      // diff_root_tree_oid: the untracked tree against the empty tree
      diff.setOldTree(this.objectFormat.emptyTreeId).setNewTree(info.uTree);
    } else if (untracked === "include" && info.uTree) {
      diff
        .setOldTree(info.bCommit)
        .setIndexAsTree(await this.untrackedIndex(info.wTree, info.uTree));
    } else {
      diff.setOldTree(info.bCommit).setNewTree(info.wCommit);
    }
    const { bytes } = await diff.callFormats(formats);
    return bytes ? decodeGitPath(bytes) : "";
  }

  /**
   * git's diff_include_untracked: the worktree and untracked trees unpacked into one index
   * (stash_worktree_untracked_merge), a name both trees hold, as a file in either, refused.
   */
  private async untrackedIndex(wTree: string, uTree: string): Promise<MemoryStagingStore> {
    const worktree = await flatTree(this.trees, wTree);
    const untracked = await flatTree(this.trees, uTree);
    const dirsOf = (paths: Iterable<string>) => {
      const dirs = new Set<string>();
      for (const p of paths) {
        for (let at = p.indexOf("/"); at > 0; at = p.indexOf("/", at + 1)) dirs.add(p.slice(0, at));
      }
      return dirs;
    };
    const wDirs = dirsOf(worktree.keys());
    const uDirs = dirsOf(untracked.keys());
    const duplicates: string[] = [];
    for (const path of untracked.keys()) {
      if (worktree.has(path) || wDirs.has(path)) duplicates.push(path);
    }
    for (const path of worktree.keys()) if (uDirs.has(path)) duplicates.push(path);
    if (duplicates.length > 0) {
      const [first] = duplicates.sort(compareGitPaths);
      throw new GitApiError(
        `error: worktree and untracked commit have duplicate entries: ${first}\nfatal: failed to unpack trees`,
      );
    }
    const index = new MemoryStagingStore();
    const builder = index.createBuilder();
    const entries = [...worktree, ...untracked].sort((a, b) => compareGitPaths(a[0], b[0]));
    for (const [path, entry] of entries) {
      builder.add({ path, mode: entry.mode, objectId: entry.objectId, size: 0, mtime: 0 });
    }
    await builder.finish();
    return index;
  }
}
