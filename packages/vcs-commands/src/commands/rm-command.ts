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
import { IndexAdder } from "./index-adder.js";
import { configBool } from "./merge-config.js";
import {
  DO_MATCH_DIRECTORY,
  MATCHED_RECURSIVELY,
  matchPathspecSeen,
  parsePathspec,
} from "./pathspec.js";
import { sparsePathAdvice } from "./sparse-checkout-support.js";
import { StatusCommand } from "./status-command.js";
import { parseGitmodules } from "./submodule-config.js";
import {
  pruneEmptyParents,
  removeDirectoryIfEmpty,
  statThroughLeadingLinks,
} from "./worktree-overwrite-checks.js";

/**
 * Result of RmCommand execution.
 */
export interface RmResult {
  /** Paths that were removed from the index (each once, whatever its stages) */
  removedPaths: string[];
  /**
   * What could not be done once the removal was under way, the index written all the same:
   * a file that could not be deleted after another one was (git passes over it silently),
   * a submodule `.gitmodules` names no section for (git's warning)
   */
  warnings?: string[];
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
   * from the index: a submodule whose own worktree holds changes (modified, staged or
   * untracked files, ignored ones aside) included, as a file reached through a symbolic link
   * among the leading directories. Even forced, nothing is removed through such a link.
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
   * `remove_path`); a submodule's directory goes with everything in it where its repository
   * lives in the superproject (a gitfile), its `.gitmodules` section is removed and the
   * file staged again. A submodule holding its own `.git` directory keeps its directory (git
   * absorbs the repository first, which is not reproduced).
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

    // cmd_rm: a skip-worktree entry, and with a sparse checkout an entry out of its
    // patterns, is passed over unless --sparse (whether or not core.sparseCheckout is set);
    // a pattern that matched only those is advised on (matches_skip_worktree)
    const patterns = this.sparse ? undefined : await this.sparseCheckoutPatterns();
    // git's pathspec (parse_pathspec, then ce_path_match): `.` and `./d` name everything
    // beneath, a directory its files, a glob's `*` crosses slashes; `seen` tells which
    // elements matched (git's ps_matched)
    const items = parsePathspec(this.filepatterns);
    const seen = items.map(() => 0);
    const seenOutside = items.map(() => 0);
    const exactStopsGlobs = this.compatibility === "2.43";
    const removedSet = new Set<string>();
    let gitmodulesEntry: IndexEntry | undefined;
    let removesSubmodule = false;
    for await (const entry of this.staging.entries()) {
      if (entry.path === ".gitmodules" && entry.stage === 0) gitmodulesEntry = entry;
      // ce_path_match: a submodule matches `sub/` as a directory would
      const flags = entry.mode === FileMode.GITLINK ? DO_MATCH_DIRECTORY : 0;
      const outside =
        !this.sparse &&
        (entry.skipWorktree || (patterns !== undefined && !patterns.includes(entry.path)));
      if (outside) {
        matchPathspecSeen(items, entry.path, flags, seenOutside, exactStopsGlobs);
        continue;
      }
      if (matchPathspecSeen(items, entry.path, flags, seen, exactStopsGlobs)) {
        if (!removedSet.has(entry.path)) removedPaths.push(entry.path);
        removedSet.add(entry.path);
        removedEntries.push(entry);
        if (entry.mode === FileMode.GITLINK) removesSubmodule = true;
      }
    }
    // is_staging_gitmodules_ok: a submodule is not removed while .gitmodules holds changes
    // the index does not
    const worktree = this.worktreeAccess;
    if (removesSubmodule && gitmodulesEntry && worktree) {
      const compared = await compareWithWorktree(worktree, gitmodulesEntry, {
        trust: worktreeModeTrust(this.workingCopy, worktree),
        indexTime: this.staging.getUpdateTime(),
      }).catch(() => undefined);
      if (
        compared?.kind === "modified" &&
        compared.worktreeEntry &&
        !compared.worktreeEntry.isDirectory
      ) {
        const staged = compared.hashedId ?? (await worktree.computeHash(".gitmodules"));
        if (staged !== gitmodulesEntry.objectId) {
          throw new RmFailedError(
            "fatal: please stage your changes to .gitmodules or stash them to proceed",
            [],
            { removedPaths: [] },
          );
        }
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
    const advise = (result: RmResult = { removedPaths }) =>
      new RmFailedError(
        sparsePathAdvice(
          sparsePaths,
          configBool(this.workingCopy, "advice.updateSparsePath", true),
          this.compatibility,
        ).join("\n"),
        sparsePaths,
        result,
      );
    // nothing else matched: git exits before writing anything
    if (sparsePaths.length > 0 && !matched) throw advise();
    // nothing matched at all (every element passed over by --ignore-unmatch)
    if (!matched) return { removedPaths: [] };

    // remove_path_from_gitmodules dies on an unmerged .gitmodules (checked before anything
    // changes here, where git has removed the files already)
    const editsGitmodules = removesSubmodule && !this.cached && worktree !== undefined;
    if (editsGitmodules && (await this.gitmodulesUnmerged())) {
      throw new RmFailedError(
        "fatal: Cannot change unmerged .gitmodules, resolve merge conflicts first",
        [],
        { removedPaths: [] },
      );
    }

    // check_local_mod: unless forced, nothing is removed that the index alone holds
    if (!this.force) {
      const refusal = await this.checkLocalMod(removedEntries, worktree);
      if (refusal) throw new RmFailedError(refusal, [], { removedPaths: [] });
    }

    // the files first (git commits the index only once they are gone): the first that cannot
    // be removed dies before anything changes, a later one is passed over (the index is
    // written all the same)
    const warnings: string[] = [];
    const removedSubmodules: string[] = [];
    if (!this.cached && worktree) {
      let removed = false;
      const done = new Set<string>();
      for (const entry of removedEntries) {
        if (done.has(entry.path)) continue;
        done.add(entry.path);
        let failure: string | undefined;
        try {
          if (!(await removeWorktreePath(worktree, entry))) failure = "Is a directory";
        } catch (error) {
          failure = errnoMessage(error);
        }
        if (failure === undefined) {
          removed = true;
          if (entry.mode === FileMode.GITLINK) removedSubmodules.push(entry.path);
        } else if (!removed) {
          throw new RmFailedError(`fatal: git rm: '${entry.path}': ${failure}`, [], {
            removedPaths: [],
          });
        } else {
          warnings.push(`warning: git rm: '${entry.path}': ${failure}`);
        }
      }
    }
    // remove_path_from_gitmodules of each submodule removed, then the file staged again
    // (stage_updated_gitmodules)
    let gitmodulesEdited = false;
    if (worktree && removedSubmodules.length > 0) {
      gitmodulesEdited = await this.removeFromGitmodules(worktree, removedSubmodules, warnings);
    }

    // git's remove_file_from_index: every stage of each path goes (conflicts kept as
    // resolve-undo); the kept entries go on as they are, flags and stat data included
    const trust = worktree
      ? worktreeModeTrust(this.workingCopy, worktree)
      : { executable: true, symlinks: true };
    const adder = await IndexAdder.open(this.staging, this.blobs, trust);
    for (const path of removedPaths) adder.remove(path);
    if (gitmodulesEdited && worktree) {
      const entry = await worktree.getEntry(".gitmodules");
      if (entry && !entry.isDirectory) await adder.add(worktree, ".gitmodules", entry);
    }
    await adder.finish();
    await this.staging.write();

    const result: RmResult = { removedPaths, ...(warnings.length > 0 ? { warnings } : {}) };
    if (sparsePaths.length > 0) throw advise(result);
    return result;
  }

  /** Whether `.gitmodules` has conflict stages in the index (git's `is_gitmodules_unmerged`). */
  private async gitmodulesUnmerged(): Promise<boolean> {
    for await (const entry of this.staging.entries()) {
      if (entry.path === ".gitmodules" && entry.stage !== 0) return true;
    }
    return false;
  }

  /**
   * git's `remove_path_from_gitmodules` for each removed submodule: the `.gitmodules`
   * section naming its path removed from the worktree's file (every line from its header to
   * the next header, as `git_config_rename_section_in_file` drops it). Returns whether the
   * file is to be staged again (git restages it once a section was looked for, even when
   * none matched); nothing without a `.gitmodules`.
   */
  private async removeFromGitmodules(
    worktree: Worktree,
    paths: readonly string[],
    warnings: string[],
  ): Promise<boolean> {
    let modified = false;
    for (const path of paths) {
      const file = await worktree.getEntry(".gitmodules");
      if (!file || file.isDirectory) return modified;
      const text = await readText(worktree, ".gitmodules");
      const declared = parseGitmodules(text).filter((s) => s.path === path);
      const submodule = declared[declared.length - 1];
      if (!submodule) {
        warnings.push(`warning: Could not find section in .gitmodules where path=${path}`);
        continue;
      }
      const section = `submodule.${submodule.name}`;
      const lines = text.split(/(?<=\n)/);
      let removing = false;
      const kept: string[] = [];
      for (const line of lines) {
        const at = line.search(/\S/);
        if (at >= 0 && line[at] === "[") removing = sectionNameMatch(line.slice(at), section);
        if (!removing) kept.push(line);
      }
      await worktree.writeContent(".gitmodules", new TextEncoder().encode(kept.join("")), {
        raw: true,
      });
      modified = true;
    }
    return modified;
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
    // an unmerged path is passed over, unless its stage 2 (ours) is a populated submodule,
    // which could lose history (get_ours_cache_pos)
    const candidates: IndexEntry[] = [];
    const stage0 = new Set(entries.filter((e) => e.stage === 0).map((e) => e.path));
    for (const entry of entries) {
      if (entry.stage === 0) candidates.push(entry);
      else if (entry.stage === 2 && entry.mode === FileMode.GITLINK && !stage0.has(entry.path)) {
        if (worktree && !(await isEmptyDirectory(worktree, entry.path))) candidates.push(entry);
      }
    }
    const trust = worktree ? worktreeModeTrust(this.workingCopy, worktree) : undefined;
    const indexTime = this.staging.getUpdateTime();
    const lookup = treeLookup(this.trees);
    const stated = worktree
      ? withWorktreeEntries(worktree, candidates)
      : candidates.map((item) => ({ item, current: null }));
    for await (const { item: entry, current } of stated) {
      if (!worktree) continue;
      let localChanges = false;
      if (!current) {
        // lstat follows a symbolic link among the leading directories (refresh_index passed
        // the path over): what stands there is a change, a directory as a vanished file
        // (the removal then fails on it); nothing there, the file already vanished
        const through = await statThroughLeadingLinks(worktree, entry.path);
        if (!through || (!through.unknown && !through.entry)) continue;
        if (through.entry?.isDirectory && entry.mode !== FileMode.GITLINK) continue;
        localChanges = true;
      } else {
        // a directory standing at a file: the same as a vanished file
        if (current.isDirectory && entry.mode !== FileMode.GITLINK) continue;
        // ie_match_stat: skip-worktree and assume-unchanged entries match by definition, an
        // intent-to-add one never does
        if (entry.intentToAdd) localChanges = true;
        else if (!entry.skipWorktree && !entry.assumeValid) {
          const compared = await compareWithWorktree(
            worktree,
            entry,
            { trust, indexTime },
            current,
          );
          localChanges = compared.kind !== undefined;
        }
        // a submodule whose own worktree holds changes (bad_to_remove_submodule)
        if (!localChanges && entry.mode === FileMode.GITLINK && current.isDirectory) {
          localChanges = await badToRemoveSubmodule(worktree, entry.path, this.cached);
        }
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
 * cannot be unlinked (false: git's EISDIR), nor one reached through a symbolic link among
 * the leading directories; a file reached that way is left alone (nothing is ever removed
 * through a link). A submodule's directory goes with everything in it (git's
 * `remove_dir_recursively`) where its repository lives elsewhere (a gitfile, nested
 * submodules alike); one holding its own `.git` directory stays (git absorbs it into the
 * superproject first, which is not reproduced).
 */
async function removeWorktreePath(worktree: Worktree, entry: IndexEntry): Promise<boolean> {
  const current = await worktree.getEntry(entry.path);
  if (current?.isDirectory) {
    if (entry.mode !== FileMode.GITLINK) return false;
    if (!(await removeDirectoryIfEmpty(worktree, entry.path))) {
      if (!(await usesGitfile(worktree, entry.path))) return true;
      await worktree.remove(entry.path, { recursive: true });
    }
  } else if (current) {
    await worktree.remove(entry.path);
  } else {
    const through = await statThroughLeadingLinks(worktree, entry.path);
    if (through?.entry?.isDirectory) return false;
    if (through) return true;
  }
  await pruneEmptyParents(worktree, entry.path);
  return true;
}

/** Whether the directory at `path` holds nothing (git's `is_empty_dir`: false when absent). */
async function isEmptyDirectory(worktree: Worktree, path: string): Promise<boolean> {
  const entry = await worktree.getEntry(path);
  if (!entry?.isDirectory) return false;
  if (await worktree.getEntry(`${path}/.git`)) return false;
  for await (const _ of worktree.walk({
    pathPrefix: path,
    includeIgnored: true,
    includeDirectories: true,
  })) {
    return false;
  }
  return true;
}

/**
 * git's `submodule_uses_gitfile`: the submodule at `path` has a `.git` file (its repository
 * lives elsewhere), and so does every populated submodule nested in it.
 */
async function usesGitfile(worktree: Worktree, path: string, depth = 0): Promise<boolean> {
  const dotGit = await worktree.getEntry(`${path}/.git`);
  if (!dotGit || dotGit.isDirectory) return false;
  if (depth > 32) return false;
  const inner = await worktree.openGitlink?.(path).catch(() => undefined);
  if (!inner) return false;
  for await (const entry of inner.checkout.staging.entries()) {
    if (entry.mode !== FileMode.GITLINK) continue;
    const nested = `${path}/${entry.path}`;
    if (!(await worktree.getEntry(`${nested}/.git`))) continue;
    if (!(await usesGitfile(worktree, nested, depth + 1))) return false;
  }
  return true;
}

/**
 * git's `bad_to_remove_submodule` with `SUBMODULE_REMOVAL_DIE_ON_ERROR |
 * SUBMODULE_REMOVAL_IGNORE_IGNORED_UNTRACKED`: a populated submodule whose
 * `git status --porcelain --ignore-submodules=none -uall` shows anything (a modified,
 * staged or untracked file, a nested submodule's changes; ignored files do not count). An
 * empty or absent directory is not. With `--cached` git has not absorbed the submodule's
 * repository first, so one without a gitfile counts; without it git has, and its status is
 * read here as it is. A submodule whose repository cannot be opened counts (git dies).
 */
async function badToRemoveSubmodule(
  worktree: Worktree,
  path: string,
  cached: boolean,
): Promise<boolean> {
  if (await isEmptyDirectory(worktree, path)) return false;
  const dotGit = await worktree.getEntry(`${path}/.git`);
  if (!dotGit) return true;
  if (cached && !(await usesGitfile(worktree, path))) return true;
  const inner = await worktree.openGitlink?.(path).catch(() => undefined);
  if (!inner) return true;
  try {
    const status = await new StatusCommand(inner)
      .setRenames(false)
      .setUntracked(true)
      .setIgnoreSubmodules("none")
      .call();
    return status.files.some((f) => f.index !== "!");
  } catch {
    return true;
  }
}

/** git's `strerror` for a failed removal, from the error's code where it has one. */
function errnoMessage(error: unknown): string {
  const code = (error as { code?: unknown } | undefined)?.code;
  const known: Record<string, string> = {
    EACCES: "Permission denied",
    EPERM: "Operation not permitted",
    EISDIR: "Is a directory",
    EBUSY: "Device or resource busy",
    EROFS: "Read-only file system",
    ENOTEMPTY: "Directory not empty",
    EIO: "Input/output error",
  };
  if (typeof code === "string" && known[code]) return known[code];
  return error instanceof Error ? error.message : String(error);
}

/** The worktree file at `path` as text (UTF-8). */
async function readText(worktree: Worktree, path: string): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of worktree.readContent(path)) chunks.push(chunk);
  let size = 0;
  for (const c of chunks) size += c.length;
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * git's `section_name_match`: whether the header beginning `line` (at its `[`) names
 * `name` (`submodule.<name>`), as `[submodule "<name>"]` with its escapes or the old
 * `[submodule.<name>]`; bytes compared as they are (case included).
 */
function sectionNameMatch(line: string, name: string): boolean {
  if (line[0] !== "[") return false;
  const space = (c: string | undefined) => c !== undefined && /\s/.test(c);
  let i = 1;
  let j = 0;
  let dot = false;
  for (; i < line.length && line[i] !== "]"; i++) {
    if (!dot && space(line[i])) {
      dot = true;
      if (name[j++] !== ".") break;
      for (i++; space(line[i]); i++);
      if (line[i] !== '"') break;
      continue;
    }
    if (line[i] === "\\" && dot) i++;
    else if (line[i] === '"' && dot) {
      for (i++; space(line[i]); i++);
      break;
    }
    if (line[i] !== name[j++]) break;
  }
  return line[i] === "]" && j === name.length;
}
