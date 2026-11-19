import { FileMode, type ObjectId, type TreeEntry } from "@statewalker/vcs-core";
import {
  compareWithWorktree,
  type IndexEntry,
  type Worktree,
  withWorktreeEntries,
} from "@statewalker/vcs-working-tree";

import { NoFilepatternError, RmFailedError } from "../errors/index.js";
import { GitCommand } from "../git-command.js";
import { worktreeModeTrust } from "./core-config.js";
import { configBool } from "./merge-config.js";
import {
  DO_MATCH_DIRECTORY,
  MATCHED_RECURSIVELY,
  matchPathspecSeen,
  parsePathspec,
} from "./pathspec.js";
import { sparsePathAdvice } from "./sparse-checkout-support.js";
import { pruneEmptyParents, removeDirectoryIfEmpty } from "./worktree-overwrite-checks.js";

/**
 * Result of RmCommand execution.
 */
export interface RmResult {
  /** Paths that were removed from the index */
  removedPaths: string[];
}

/**
 * Remove files from the index (and optionally from working tree).
 *
 * Equivalent to `git rm`.
 *
 * Based on JGit's RmCommand.
 *
 * @example
 * ```typescript
 * // Remove file from index and working tree
 * await git.rm()
 *   .addFilepattern("file.txt")
 *   .call();
 *
 * // Remove from index only (keep in working tree)
 * await git.rm()
 *   .addFilepattern("file.txt")
 *   .setCached(true)
 *   .call();
 *
 * // Remove directory recursively (`git rm -r`)
 * await git.rm()
 *   .addFilepattern("src/old/")
 *   .setRecursive(true)
 *   .call();
 * ```
 */
export class RmCommand extends GitCommand<RmResult> {
  private filepatterns: string[] = [];
  private cached = false;
  private sparse = false;
  private recursive = false;
  private ignoreUnmatch = false;
  private force = false;
  private compatibility: "2.43" | "2.56" = "2.56";

  /**
   * `--sparse`: entries outside the sparse checkout (skip-worktree, or out of the patterns)
   * are removed too. Without it a pattern that matches only such entries is refused with
   * git's advice ({@link RmFailedError}), the other patterns removed all the same.
   */
  setSparse(sparse: boolean): this {
    this.checkCallable();
    this.sparse = sparse;
    return this;
  }

  /**
   * `-r`: a pattern may name a directory (or `.`), removing every entry beneath. Without it
   * such a pattern is refused before anything changes ("not removing 'd' recursively
   * without -r"), as git does.
   */
  setRecursive(recursive: boolean): this {
    this.checkCallable();
    this.recursive = recursive;
    return this;
  }

  /**
   * `--ignore-unmatch`: a pattern that matches no entry is passed over. Without it git dies
   * before anything changes ("pathspec 'x' did not match any files").
   */
  setIgnoreUnmatch(ignoreUnmatch: boolean): this {
    this.checkCallable();
    this.ignoreUnmatch = ignoreUnmatch;
    return this;
  }

  /**
   * `-f`: remove entries whatever they hold. Without it git's `check_local_mod` refuses,
   * before anything changes ({@link RmFailedError}), an entry whose staged content differs
   * from both its file and HEAD (with `--cached` too, unless it is intent-to-add), and,
   * without `--cached`, one whose staged content differs from HEAD or whose file differs
   * from the index.
   */
  setForce(force: boolean): this {
    this.checkCallable();
    this.force = force;
    return this;
  }

  /**
   * The git version whose behaviour is reproduced where versions differ (default 2.56): the
   * advice's last hint, as `AddCommand.setCompatibility`, and 2.43's pathspec matching, where
   * an element that named an entry exactly matches no later entry (`rm 'b*'` with an entry
   * `b*` removes only that one).
   */
  setCompatibility(version: "2.43" | "2.56"): this {
    this.checkCallable();
    this.compatibility = version;
    return this;
  }

  /**
   * Add a file pattern to remove.
   *
   * @param filepattern Path pattern to remove (with `/` as separator)
   */
  addFilepattern(filepattern: string): this {
    this.checkCallable();
    this.filepatterns.push(filepattern);
    return this;
  }

  /**
   * Set whether to only remove from index (keep in working tree).
   *
   * When true, files are only removed from the staging area
   * but remain in the working directory (like `git rm --cached`). Otherwise the files of
   * the removed entries are deleted too and the directories they leave empty pruned (git's
   * `remove_path`); a populated submodule's directory is left as it is.
   *
   * @param cached true to only remove from index
   */
  setCached(cached: boolean): this {
    this.checkCallable();
    this.cached = cached;
    return this;
  }

  /**
   * Get whether cached mode is enabled.
   */
  getCached(): boolean {
    return this.cached;
  }

  /**
   * Execute the rm command.
   *
   * @returns Result with list of removed paths
   */
  async call(): Promise<RmResult> {
    this.checkCallable();
    this.setCallable(false);
    // the index as it is now, before the worktree or a ref is touched: one another writer
    // replaced is read again (git reads the index at its start), unless this instance holds
    // unwritten edits (refused)
    await this.readCurrentIndex();

    if (this.filepatterns.length === 0) {
      throw new NoFilepatternError("At least one file pattern is required");
    }

    const removedPaths: string[] = [];
    const removedEntries: IndexEntry[] = [];
    // (the index as readCurrentIndex left it: reading it again would bring back the
    // skip-worktree flags cleared for files present in a sparse checkout)

    // the kept entries go on as they are: flags (intent-to-add, skip-worktree,
    // assume-unchanged) and stat data included (git's remove_file_from_index)
    const entriesToKeep: IndexEntry[] = [];

    // cmd_rm: entries outside the sparse checkout are passed over unless --sparse; a pattern
    // that matched only those is advised on (matches_skip_worktree)
    const patterns = this.sparse ? undefined : await this.sparseCheckoutPatterns();
    // git's pathspec (parse_pathspec, then ce_path_match): `.` and `./d` name everything
    // beneath, a directory its files, a glob's `*` crosses slashes; `seen` tells which
    // elements matched (git's ps_matched)
    const items = parsePathspec(this.filepatterns);
    const seen = items.map(() => 0);
    const seenOutside = items.map(() => 0);
    const exactStopsGlobs = this.compatibility === "2.43";
    for await (const entry of this.staging.entries()) {
      // ce_path_match: a submodule matches `sub/` as a directory would
      const flags = entry.mode === FileMode.GITLINK ? DO_MATCH_DIRECTORY : 0;
      const outside =
        patterns !== undefined && (entry.skipWorktree || !patterns.includes(entry.path));
      if (outside) {
        matchPathspecSeen(items, entry.path, flags, seenOutside, exactStopsGlobs);
        entriesToKeep.push(entry);
        continue;
      }
      if (matchPathspecSeen(items, entry.path, flags, seen, exactStopsGlobs)) {
        removedPaths.push(entry.path);
        removedEntries.push(entry);
      } else {
        entriesToKeep.push(entry);
      }
    }
    // cmd_rm's check of each element, in order, before anything is written: one that matched
    // nothing dies (unless --ignore-unmatch, or it matched only entries outside the sparse
    // checkout), one that named a directory needs -r (an implicit `.` is shown as `.`)
    const sparsePaths: string[] = [];
    let seenAny = false;
    for (let i = 0; i < items.length; i++) {
      const original = this.filepatterns[i] ?? "";
      if (seen[i]) seenAny = true;
      else if (this.ignoreUnmatch) continue;
      else if (seenOutside[i]) sparsePaths.push(original);
      else {
        throw new RmFailedError(`fatal: pathspec '${original}' did not match any files`, [], {
          removedPaths: [],
        });
      }
      if (!this.recursive && seen[i] === MATCHED_RECURSIVELY) {
        throw new RmFailedError(
          `fatal: not removing '${original || "."}' recursively without -r`,
          [],
          { removedPaths: [] },
        );
      }
    }
    const matched = seenAny;
    const advise = () =>
      new RmFailedError(
        sparsePathAdvice(
          sparsePaths,
          configBool(this.workingCopy, "advice.updateSparsePath", true),
          this.compatibility,
        ).join("\n"),
        sparsePaths,
        { removedPaths },
      );
    // nothing else matched: git exits before writing anything
    if (sparsePaths.length > 0 && !matched) throw advise();
    // nothing matched at all (every element passed over by --ignore-unmatch)
    if (!matched) return { removedPaths: [] };

    // check_local_mod: unless forced, nothing is removed that the index alone holds
    const worktree = this.worktreeAccess;
    if (!this.force) {
      const refusal = await this.checkLocalMod(removedEntries, worktree);
      if (refusal) throw new RmFailedError(refusal, [], { removedPaths: [] });
    }

    // the files first (git commits the index only once they are gone): the first that cannot
    // be removed dies before anything changes, a later one is passed over
    if (!this.cached && worktree) {
      let removed = false;
      const done = new Set<string>();
      for (const entry of removedEntries) {
        if (done.has(entry.path)) continue;
        done.add(entry.path);
        const ok = await removeWorktreePath(worktree, entry);
        if (ok) removed = true;
        else if (!removed) {
          throw new RmFailedError(`fatal: git rm: '${entry.path}': Is a directory`, [], {
            removedPaths: [],
          });
        }
      }
    }

    // Rebuild staging with entries that weren't removed
    const builder = this.staging.createBuilder();
    for (const entry of entriesToKeep) {
      builder.add(entry);
    }
    await builder.finish();
    await this.staging.write();

    if (sparsePaths.length > 0) throw advise();
    return { removedPaths };
  }

  /**
   * git's `check_local_mod`: the entries whose removal would lose content, as git's error
   * lines (singular or plural, each list with its hint unless `advice.rmHints` is off), or
   * undefined. An unmerged entry, a file gone from the worktree or a directory standing at
   * a file is passed over; a submodule is checked against its index entry only.
   */
  private async checkLocalMod(
    entries: readonly IndexEntry[],
    worktree: Worktree | undefined,
  ): Promise<string | undefined> {
    const headTree = await this.headTree();
    const staged: string[] = [];
    const cached: string[] = [];
    const local: string[] = [];
    // an unmerged path is passed over (its submodule's history is not looked at)
    const candidates = entries.filter((e) => e.stage === 0);
    const trust = worktree ? worktreeModeTrust(this.workingCopy, worktree) : undefined;
    const indexTime = this.staging.getUpdateTime();
    const lookup = treeLookup(this.trees);
    const stated = worktree
      ? withWorktreeEntries(worktree, candidates)
      : candidates.map((item) => ({ item, current: null }));
    for await (const { item: entry, current } of stated) {
      // it already vanished from the working tree (or a directory is there instead)
      if (!worktree || !current) continue;
      if (current.isDirectory && entry.mode !== FileMode.GITLINK) continue;
      // ie_match_stat: skip-worktree and assume-unchanged entries match by definition, an
      // intent-to-add one never does
      let localChanges = false;
      if (entry.intentToAdd) localChanges = true;
      else if (!entry.skipWorktree && !entry.assumeValid) {
        const compared = await compareWithWorktree(worktree, entry, { trust, indexTime }, current);
        localChanges = compared.kind !== undefined;
      }
      const inHead = headTree ? await lookup(headTree, entry.path) : undefined;
      const stagedChanges = !inHead || inHead.mode !== entry.mode || inHead.id !== entry.objectId;
      if (localChanges && stagedChanges) {
        if (!this.cached || !entry.intentToAdd) staged.push(entry.path);
      } else if (!this.cached) {
        if (stagedChanges) cached.push(entry.path);
        if (localChanges) local.push(entry.path);
      }
    }
    const hints = configBool(this.workingCopy, "advice.rmHints", true);
    const lines: string[] = [];
    const report = (files: string[], one: string, many: string, hint: string) => {
      if (files.length === 0) return;
      let message = `error: ${files.length === 1 ? one : many}`;
      for (const file of files) message += `\n    ${file}`;
      if (hints) message += `\n${hint}`;
      lines.push(message);
    };
    report(
      staged,
      "the following file has staged content different from both the\nfile and the HEAD:",
      "the following files have staged content different from both the\nfile and the HEAD:",
      "(use -f to force removal)",
    );
    const keep = "(use --cached to keep the file, or -f to force removal)";
    report(
      cached,
      "the following file has changes staged in the index:",
      "the following files have changes staged in the index:",
      keep,
    );
    report(
      local,
      "the following file has local modifications:",
      "the following files have local modifications:",
      keep,
    );
    return lines.length > 0 ? lines.join("\n") : undefined;
  }

  /** HEAD's tree; undefined before the first commit (everything staged counts as changed). */
  private async headTree(): Promise<ObjectId | undefined> {
    const head = await this.refsStore.resolve("HEAD");
    if (!head?.objectId) return undefined;
    return this.commits.getTree(head.objectId);
  }
}

/**
 * The entry at `path` in a tree (git's `get_tree_entry`), each directory read once.
 */
function treeLookup(trees: {
  getEntry(treeId: ObjectId, name: string): Promise<TreeEntry | undefined>;
}): (treeId: ObjectId, path: string) => Promise<TreeEntry | undefined> {
  const dirs = new Map<string, Promise<TreeEntry | undefined>>();
  const at = (treeId: ObjectId, dir: string, name: string) => {
    const key = `${treeId}\0${dir}\0${name}`;
    let found = dirs.get(key);
    if (!found) {
      found = trees.getEntry(treeId, name);
      dirs.set(key, found);
    }
    return found;
  };
  return async (treeId, path) => {
    const parts = path.split("/");
    let id = treeId;
    let entry: TreeEntry | undefined;
    for (let k = 0; k < parts.length; k++) {
      entry = await at(id, parts.slice(0, k).join("/"), parts[k] ?? "");
      if (!entry) return undefined;
      if (k < parts.length - 1) {
        if (entry.mode !== FileMode.TREE) return undefined;
        id = entry.id;
      }
    }
    return entry;
  };
}

/**
 * git's `remove_path` for a removed entry: its file unlinked (one already gone is no error),
 * then each parent directory left empty removed, bottom-up. A directory standing at a file
 * cannot be unlinked (false: git's EISDIR). A submodule's directory goes only when empty
 * (git's `remove_dir_recursively` of a populated one is not reproduced: it stays).
 */
async function removeWorktreePath(worktree: Worktree, entry: IndexEntry): Promise<boolean> {
  const current = await worktree.getEntry(entry.path);
  if (current?.isDirectory) {
    if (entry.mode !== FileMode.GITLINK) return false;
    if (!(await removeDirectoryIfEmpty(worktree, entry.path))) return true;
  } else if (current) {
    await worktree.remove(entry.path);
  }
  await pruneEmptyParents(worktree, entry.path);
  return true;
}
