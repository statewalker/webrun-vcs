/**
 * `git mv` (builtin/mv.c): move or rename files, directories and submodules in the worktree
 * and the index together.
 */

import { FileMode, type ObjectId } from "@statewalker/vcs-core";
import { compareGitPaths } from "@statewalker/vcs-utils/encoding";
import {
  attributesIndexOf,
  compareWithWorktree,
  entryStatOf,
  type IndexEntry,
  type Worktree,
  type WorktreeModeTrust,
} from "@statewalker/vcs-working-tree";
import { MvFailedError } from "../errors/index.js";
import { GitCommand } from "../git-command.js";
import { worktreeModeTrust } from "./core-config.js";
import { IndexAdder } from "./index-adder.js";
import { configBool } from "./merge-config.js";
import { sparseCheckoutConfig, sparsePathAdvice } from "./sparse-checkout-support.js";
import { strerror } from "./strerror.js";
import { parseGitmodules } from "./submodule-config.js";
import { planFlatRestore, writeTreeRestorePlan } from "./tree-restore.js";
import {
  removeDirectoryIfEmpty,
  statFollowingLinks,
  statThroughLeadingLinks,
} from "./worktree-overwrite-checks.js";
import { worktreePathRules } from "./worktree-path-rules.js";

/** One move `git mv` made (or, with `-n`, would make). */
export interface MvRename {
  source: string;
  destination: string;
}

/** Result of {@link MvCommand}. */
export interface MvResult {
  /** The moves made, in git's order (a directory's entries after the directory) */
  renamed: MvRename[];
  /** What git prints on stdout: `Checking rename of ...` (`-n`), `Renaming ...` (`-n`, `-v`) */
  output: string[];
  /**
   * What git prints on stderr without failing: `warning: overwriting '<dst>'` (`-f -v`), the
   * sparse advice with `-k`, the advice on paths moved out of the cone while dirty, the
   * `.gitmodules` warnings
   */
  warnings: string[];
}

// builtin/mv.c's `enum update_mode`
const WORKING_DIRECTORY = 1 << 1;
const INDEX = 1 << 2;
const SPARSE = 1 << 3;
const SKIP_WORKTREE_DIR = 1 << 4;
const MOVE_VIA_PARENT_DIR = 1 << 5;

/** `submodule_gitfile_path`'s marker for a submodule holding its own `.git` directory. */
const SUBMODULE_WITH_GITDIR = Symbol("SUBMODULE_WITH_GITDIR");
type SubmoduleGitfile = string | typeof SUBMODULE_WITH_GITDIR | undefined;

/** `needs_worktree_rename`: whether the move renames anything in the worktree. */
function needsWorktreeRename(mode: number, dstMode: number): boolean {
  return (
    (mode & (INDEX | SPARSE | SKIP_WORKTREE_DIR)) === 0 &&
    (dstMode & (SKIP_WORKTREE_DIR | SPARSE)) === 0
  );
}

/** `add_slash`: `path` with a trailing `/` (the empty path stays empty). */
function addSlash(path: string): string {
  return path.length > 0 && !path.endsWith("/") ? `${path}/` : path;
}

/** POSIX `basename` of a path without trailing slashes. */
function basename(path: string): string {
  if (path === "") return ".";
  const at = path.lastIndexOf("/");
  return at < 0 ? path : path.slice(at + 1);
}

/**
 * git's `prefix_path` with the worktree root as prefix (`normalize_path_copy`): `.` and
 * empty components dropped, `..` climbing one, a trailing `/` kept; undefined when the
 * path leaves the worktree.
 */
function normalizePath(path: string): string | undefined {
  const trailing = path.endsWith("/") && path.replace(/\/+$/, "") !== "";
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return undefined;
      out.pop();
      continue;
    }
    out.push(part);
  }
  const joined = out.join("/");
  return trailing && joined ? `${joined}/` : joined;
}

/**
 * Move or rename files, directories and submodules (`git mv`).
 *
 * ```typescript
 * // rename one file
 * await git.mv().addSource("old.txt").setDestination("new.txt").call();
 *
 * // move several paths into a directory, skipping the ones that cannot move
 * await git.mv().addSource("a").addSource("b").setDestination("dir").setSkipErrors(true).call();
 * ```
 *
 * Every check runs first (builtin/mv.c's "Checking" loop): one failing dies with git's
 * `fatal: <reason>, source=<src>, destination=<dst>` before anything moves, unless `-k`
 * passes over it. Then each worktree path is renamed through the worktree (a symbolic link
 * as the link, a directory with everything in it) and its index entries renamed with
 * `rename_index_entry_at`: flags kept, the stat data refreshed only where the file still
 * matches, the cache-tree invalidated at both paths. A submodule's gitfile, `core.worktree`
 * and `.gitmodules` path follow it, `.gitmodules` staged again.
 */
export class MvCommand extends GitCommand<MvResult> {
  private sources: string[] = [];
  private destination: string | undefined;
  private force = false;
  private skipErrors = false;
  private dryRun = false;
  private verbose = false;
  private sparse = false;
  private compatibility: "2.43" | "2.56" = "2.56";

  /** A `<source>` (relative to the worktree root, `/` separated). */
  addSource(source: string): this {
    this.checkCallable();
    this.sources.push(source);
    return this;
  }

  /** The `<destination>`: a new name for one source, or a directory for several. */
  setDestination(destination: string): this {
    this.checkCallable();
    this.destination = destination;
    return this;
  }

  /** `-f`: a file or link at the destination is overwritten (`warning: overwriting` with `-v`). */
  setForce(force: boolean): this {
    this.checkCallable();
    this.force = force;
    return this;
  }

  /** `-k`: a source whose move would fail is passed over instead of dying. */
  setSkipErrors(skip: boolean): this {
    this.checkCallable();
    this.skipErrors = skip;
    return this;
  }

  /** `-n`: tell what would be moved (`Checking rename of`, `Renaming`), change nothing. */
  setDryRun(dryRun: boolean): this {
    this.checkCallable();
    this.dryRun = dryRun;
    return this;
  }

  /** `-v`: tell each move (`Renaming <src> to <dst>`), and each file overwritten with `-f`. */
  setVerbose(verbose: boolean): this {
    this.checkCallable();
    this.verbose = verbose;
    return this;
  }

  /**
   * `--sparse`: entries outside the sparse checkout (skip-worktree, or paths out of the
   * patterns) may be moved; in cone mode an entry moved into the cone is checked out and
   * one moved out of it leaves the worktree (kept there, with git's advice, when dirty).
   */
  setSparse(sparse: boolean): this {
    this.checkCallable();
    this.sparse = sparse;
    return this;
  }

  /**
   * The git version whose behaviour is reproduced where versions differ (default 2.56):
   * 2.43 has no check of the destination's leading directory (the rename fails instead,
   * `renaming '<src>' failed: <reason>`) and gives the advice's older last hint.
   */
  setCompatibility(version: "2.43" | "2.56"): this {
    this.checkCallable();
    this.compatibility = version;
    return this;
  }

  async call(): Promise<MvResult> {
    this.checkCallable();
    this.setCallable(false);
    if (this.sources.length === 0 || this.destination === undefined) {
      throw new MvFailedError(
        "usage: git mv [-v] [-f] [-n] [-k] <source> <destination>\n" +
          "   or: git mv [-v] [-f] [-n] [-k] <source>... <destination-directory>",
      );
    }
    await this.readCurrentIndex();
    const worktree = this.worktreeAccess;
    if (!worktree) throw new MvFailedError("fatal: this operation must be run in a work tree");

    const result: MvResult = { renamed: [], output: [], warnings: [] };
    const die = (message: string): never => {
      throw new MvFailedError([...result.warnings, `fatal: ${message}`].join("\n"), result);
    };
    // git names the worktree's top as the host does (an absolute path)
    const top =
      (worktree as { hostPath?: string }).hostPath?.replace(/(.)\/+$/, "$1") ?? worktree.getRoot();
    const normalized = (path: string) =>
      normalizePath(path) ?? die(`'${path}' is outside repository at '${top}'`);
    const lstat = (path: string) => worktree.getEntry(path).catch(() => undefined);
    // lstat(2) of a path with a trailing slash, or of one beneath a symbolic link, follows
    // the links (`ld/` names the directory `ld` points to)
    const lstatFollowing = async (path: string) => {
      const bare = path.replace(/\/+$/, "");
      if (bare !== path) return statFollowingLinks(worktree, bare);
      const found = await lstat(path);
      if (found) return found;
      const through = await statThroughLeadingLinks(worktree, path);
      return through?.entry;
    };
    // is_directory: stat(2), following links
    const isDirectory = async (path: string) =>
      (await statFollowingLinks(worktree, path.replace(/\/+$/, "")))?.isDirectory === true;

    const cache = await this.indexEntries();
    const namePos = (name: string) => indexNamePos(cache, name);
    const patterns = await this.sparseCheckoutPatterns();
    const inSparse = (path: string) => !path || !patterns || patterns.includes(path);
    const inCone = (path: string) => !path || !patterns?.cone || inSparse(path);
    const ignoreCase = configBool(this.workingCopy, "core.ignoreCase", false);
    const fold = (p: string) => (ignoreCase ? p.toLowerCase() : p);
    const emptyDirHasSparseContents = (name: string) => {
      const withSlash = addSlash(name);
      let pos = namePos(withSlash);
      if (pos >= 0) return false;
      pos = -pos - 1;
      const ce = cache[pos];
      return ce?.path.startsWith(withSlash) === true && ce.skipWorktree === true;
    };
    const indexRangeOfSameDir = (src: string): [number, number] => {
      const withSlash = addSlash(src);
      let first = namePos(withSlash);
      if (first >= 0) die(`${withSlash} is in index`);
      first = -1 - first;
      let last = first;
      while (last < cache.length && (cache[last] as IndexEntry).path.startsWith(withSlash)) last++;
      return [first, last];
    };

    // internal_prefix_pathspec: sources without trailing slashes; the destination keeps its
    // own unless one directory moves to a name that is no directory
    const argv = this.sources;
    let argc = argv.length;
    const sources = argv.map((a) => normalized(a.replace(/\/+$/, "")));
    const keepSlash = !(
      argc === 1 &&
      (await isDirectory(sources[0] as string)) &&
      !(await isDirectory(normalized(this.destination)))
    );
    const destPath = normalized(
      keepSlash ? this.destination : this.destination.replace(/\/+$/, ""),
    );
    const dstWithSlash = addSlash(destPath);
    const intoDir = (prefix: string) =>
      argv.map((a) => normalized(`${prefix}${basename(a.replace(/\/+$/, ""))}`));
    let destinations: string[];
    let dstMode = 0;
    // git's `struct stat st`, shared by several lstat calls: a failing one leaves it as the
    // last successful one left it (a skip-worktree directory as source relies on it)
    let lastStat: { isDirectory: boolean } | undefined;
    const lstatSt = async (path: string) => {
      const found = await lstatFollowing(path);
      if (found) lastStat = found;
      return found;
    };
    if (destPath === "") destinations = intoDir("");
    else if ((await lstatSt(destPath))?.isDirectory) destinations = intoDir(dstWithSlash);
    else if (!inSparse(dstWithSlash) && emptyDirHasSparseContents(dstWithSlash)) {
      destinations = intoDir(dstWithSlash);
      dstMode = SKIP_WORKTREE_DIR;
    } else if (argc !== 1) {
      return die(`destination '${destPath}' is not a directory`);
    } else {
      destinations = [destPath];
      if (!inCone(destPath)) dstMode = SPARSE;
    }

    const modes: number[] = argv.map(() => 0);
    const gitfiles: SubmoduleGitfile[] = argv.map(() => undefined);
    const srcForDst = new Set<string>();
    const onlyMatchSkipWorktree: string[] = [];
    const movedDirs = new Set<string>();
    const srcDirs: string[] = [];
    /** The repository of each submodule with a gitfile, found before anything moves */
    const gitDirs = new Map<string, string>();
    const trust = worktreeModeTrust(this.workingCopy, worktree);
    const indexTime = this.staging.getUpdateTime();

    for (let i = 0; i < argc; i++) {
      const src = sources[i] as string;
      const dst = destinations[i] as string;
      let bad: string | undefined;
      let skipSparse = false;
      let removeEntry = false;
      if (this.dryRun) result.output.push(`Checking rename of '${src}' to '${dst}'`);
      const st = await lstatSt(src);
      const check = async (): Promise<void> => {
        let srcIsDir = st?.isDirectory === true;
        if (!st) {
          const pos = namePos(src);
          if (pos < 0) {
            if (!inSparse(addSlash(src)) && emptyDirHasSparseContents(src)) {
              modes[i] = (modes[i] as number) | SKIP_WORKTREE_DIR;
              // S_ISDIR(st.st_mode) of whatever lstat filled in last; where none did, git
              // reads a stat nothing filled in, almost always no directory ("not under
              // version control" on 2.43 and 2.5x alike; rarely a directory, moving it)
              srcIsDir = lastStat ? lastStat.isDirectory : false;
              return dirCheck(srcIsDir);
            }
            if (!((modes[i] as number) & SPARSE)) bad = "bad source";
            return;
          }
          const ce = cache[pos] as IndexEntry;
          if (!ce.skipWorktree) {
            bad = "bad source";
            return;
          }
          if (!this.sparse) {
            onlyMatchSkipWorktree.push(src);
            return;
          }
          if (namePos(dst) < 0) {
            modes[i] = (modes[i] as number) | SPARSE;
            return;
          }
          if (!this.force) {
            bad = "destination exists";
            return;
          }
          modes[i] = (modes[i] as number) | SPARSE;
          return;
        }
        if (dst.startsWith(src) && (dst.length === src.length || dst[src.length] === "/")) {
          bad = "can not move directory into itself";
          return;
        }
        if (st.isDirectory && (await lstatFollowing(dst))) {
          bad = "destination already exists";
          return;
        }
        return dirCheck(srcIsDir);
      };
      const dirCheck = async (srcIsDir: boolean): Promise<void> => {
        if (srcIsDir) {
          const first = namePos(src);
          if (first >= 0) {
            const gitfile = await this.submoduleGitfilePath(
              worktree,
              src,
              cache[first] as IndexEntry,
            );
            gitfiles[i] = gitfile;
            if (gitfile && gitfile !== SUBMODULE_WITH_GITDIR && worktree.gitlinkRepository) {
              // connect_work_tree_and_git_dir rewrites the gitfile and the repository's
              // core.worktree after the move: refused now when that repository cannot be
              // reached, rather than leave the submodule broken
              const gitDir = await worktree.gitlinkRepository(src);
              if (gitDir === null) {
                die(
                  `cannot update the repository of submodule '${src}' ('${gitfile}'): it lies outside the files this worktree reaches`,
                );
              }
              if (gitDir) gitDirs.set(src, gitDir);
            }
            return;
          }
          const [from, to] = indexRangeOfSameDir(src);
          if (to - from < 1) {
            bad = "source directory is empty";
            return;
          }
          movedDirs.add(fold(src));
          modes[i] = (modes[i] as number) | WORKING_DIRECTORY;
          srcDirs.push(src);
          const dstSlash = addSlash(dst);
          for (let j = from; j < to; j++) {
            const ce = cache[j] as IndexEntry;
            sources.push(ce.path);
            destinations.push(normalized(`${dstSlash}${ce.path.slice(src.length + 1)}`));
            modes.push(MOVE_VIA_PARENT_DIR | (ce.skipWorktree ? SPARSE : INDEX));
            gitfiles.push(undefined);
          }
          argc += to - from;
          return;
        }
        const anyStage = cache.find((e) => e.path === src);
        if (!anyStage) {
          bad = "not under version control";
          return;
        }
        if (anyStage.stage !== 0 && !cache.some((e) => e.path === src && e.stage === 0)) {
          bad = "conflicted";
          return;
        }
        const dstStat = await lstatSt(dst);
        if (dstStat && (!ignoreCase || src.toLowerCase() !== dst.toLowerCase())) {
          bad = "destination exists";
          if (this.force) {
            // only files can overwrite each other
            if (!dstStat.isDirectory) {
              if (this.verbose) result.warnings.push(`warning: overwriting '${dst}'`);
              bad = undefined;
            } else bad = "Cannot overwrite";
          }
          return;
        }
        if (srcForDst.has(dst)) {
          bad = "multiple sources for the same target";
          return;
        }
        if (dst.endsWith("/")) {
          bad = "destination directory does not exist";
          return;
        }
        if (this.compatibility !== "2.43" && (await hasSymlinkLeadingPath(worktree, dst))) {
          bad = "destination is beyond a symbolic link";
          return;
        }
        if (this.compatibility !== "2.43" && needsWorktreeRename(modes[i] as number, dstMode)) {
          const slash = dst.lastIndexOf("/");
          if (slash >= 0) {
            const dir = dst.slice(0, slash);
            const dirStat = await lstat(dir);
            if (!dirStat) {
              // ENOENT or ENOTDIR (a file among the leading components)
              bad = "destination directory does not exist";
            } else if (!dirStat.isDirectory) bad = "destination is not a directory";
            if (bad) return;
          }
        }
        if (
          this.sparse &&
          dstMode & (SKIP_WORKTREE_DIR | SPARSE) &&
          cache.some((e) => e.path === dst)
        ) {
          bad = "destination exists in the index";
          if (!this.force) return;
          if (this.verbose) result.warnings.push(`warning: overwriting '${dst}'`);
          bad = undefined;
        }
        // the sparse checks last, so the advice can point at --sparse
        if (!this.sparse && !inSparse(src)) {
          onlyMatchSkipWorktree.push(src);
          skipSparse = true;
        }
        if (!this.sparse && !inSparse(dst)) {
          onlyMatchSkipWorktree.push(dst);
          skipSparse = true;
        }
        if (skipSparse) {
          removeEntry = true;
          return;
        }
        srcForDst.add(dst);
      };
      await check();
      if (!removeEntry) {
        if (!bad) continue;
        if (!this.skipErrors) die(`${bad}, source=${src}, destination=${dst}`);
      }
      // remove_entry
      if (--argc > 0) {
        sources.splice(i, 1);
        destinations.splice(i, 1);
        modes.splice(i, 1);
        gitfiles.splice(i, 1);
        i--;
      }
    }

    // a path moved together with one of its parent directories (2.5x; 2.43 moves the
    // directory, then fails renaming the path, or aborts on an assertion)
    for (let i = 0; i < argc && this.compatibility !== "2.43"; i++) {
      if ((modes[i] as number) & MOVE_VIA_PARENT_DIR) continue;
      const src = sources[i] as string;
      for (let at = src.lastIndexOf("/"); at > 0; at = src.lastIndexOf("/", at - 1)) {
        const parent = src.slice(0, at);
        if (movedDirs.has(fold(parent))) {
          die(`cannot move both '${src}' and its parent directory '${parent}'`);
        }
      }
    }

    if (onlyMatchSkipWorktree.length > 0) {
      const advice = sparsePathAdvice(
        onlyMatchSkipWorktree,
        configBool(this.workingCopy, "advice.updateSparsePath", true),
        this.compatibility,
      );
      result.warnings.push(...advice);
      if (!this.skipErrors) throw new MvFailedError(result.warnings.join("\n"), result);
    }

    // the moves
    const sparseConfig = sparseCheckoutConfig(this.workingCopy);
    const adder = await IndexAdder.open(this.staging, this.blobs, trust, {
      pathRules: worktreePathRules(this.workingCopy),
    });
    const current = new Map<string, IndexEntry>();
    for (const e of cache) if (e.stage === 0) current.set(e.path, e);
    const dirtyPaths: string[] = [];
    let gitmodulesModified = false;
    let changed = false;
    for (let i = 0; i < argc; i++) {
      const src = sources[i] as string;
      const dst = destinations[i] as string;
      const mode = modes[i] as number;
      if (this.dryRun || this.verbose) result.output.push(`Renaming ${src} to ${dst}`);
      if (this.dryRun) continue;
      const gitfile = gitfiles[i];
      const gitDir = gitfile && gitfile !== SUBMODULE_WITH_GITDIR ? gitDirs.get(src) : undefined;
      if (needsWorktreeRename(mode, dstMode)) {
        try {
          await renamePath(worktree, src, dst);
        } catch (error) {
          if (this.skipErrors) continue;
          // die_errno: the index lock is rolled back, the moves made so far stay unrecorded
          die(
            this.compatibility === "2.43"
              ? `renaming '${src}' failed: ${strerror(error)}`
              : `renaming '${src}' to '${dst}' failed: ${strerror(error)}`,
          );
        }
      }
      result.renamed.push({ source: src, destination: dst });
      if (gitfile) {
        if (await this.updatePathInGitmodules(worktree, src, dst, result.warnings)) {
          gitmodulesModified = true;
        }
        if (gitDir !== undefined) await worktree.connectGitlink?.(dst, gitDir);
      }
      if (mode & (WORKING_DIRECTORY | SKIP_WORKTREE_DIR)) continue;

      const old = current.get(src);
      if (!old) die(`BUG: could not find source in index: '${src}'`);
      const entry = old as IndexEntry;
      let sparseAndDirty = false;
      if (!(mode & SPARSE)) {
        const at = await lstat(src);
        if (at) sparseAndDirty = await entryModified(worktree, entry, trust, indexTime);
      }
      // rename_index_entry_at: flags kept; refresh_cache_entry takes the new file's stat
      // only while the content still matches (a gitlink's never: ie_match_stat compares its
      // type and HEAD alone, so its stat data stays as it was)
      let moved: IndexEntry = { ...entry, path: dst };
      if (
        !entry.skipWorktree &&
        !entry.assumeValid &&
        !entry.intentToAdd &&
        entry.mode !== FileMode.GITLINK
      ) {
        const file = await lstat(dst);
        if (file && !(await entryModified(worktree, moved, trust, indexTime, true))) {
          moved = { ...moved, ...entryStatOf(file) };
        }
      }
      let checkout = false;
      if (this.sparse && sparseConfig.enabled && sparseConfig.cone) {
        if (mode & SPARSE && inSparse(dst)) {
          // from out-of-cone to in-cone: checked out (checkout_entry, forced only with -f:
          // without it a file already there stops the move before the index is written)
          moved = { ...moved, skipWorktree: false };
          if (!this.force && (await lstat(dst))) {
            result.warnings.push(`${dst} already exists, no checkout`);
            die(`cannot checkout ${dst}`);
          }
          checkout = true;
        } else if (dstMode & (SKIP_WORKTREE_DIR | SPARSE) && !(mode & SPARSE) && !inSparse(dst)) {
          // from in-cone to out-of-cone
          if (!sparseAndDirty) {
            moved = { ...moved, skipWorktree: true };
            await worktree.remove(src).catch((error) => {
              result.warnings.push(`warning: unable to unlink '${src}': ${strerror(error)}`);
            });
          } else {
            dirtyPaths.push(dst);
            const slash = dst.lastIndexOf("/");
            if (slash > 0) await worktree.mkdir(dst.slice(0, slash), { recursive: true });
            await renamePath(worktree, src, dst).catch(() => undefined);
          }
        }
      }
      if (moved.skipWorktree === false) {
        const { skipWorktree: _drop, ...rest } = moved;
        moved = rest;
      }
      current.delete(src);
      current.set(dst, moved);
      adder.remove(src);
      adder.put(moved);
      changed = true;
      if (checkout) await this.checkoutEntries(worktree, [moved], current, trust);
    }

    // remove_empty_src_dirs
    if (!this.dryRun) {
      for (const dir of srcDirs) {
        const prefix = `${dir}/`;
        let has = false;
        for (const p of current.keys()) {
          if (p.startsWith(prefix)) {
            has = true;
            break;
          }
        }
        if (!has && (await lstat(dir))) await worktree.remove(dir, { recursive: true });
      }
    }

    if (dirtyPaths.length > 0) {
      result.warnings.push(
        "The following paths have been moved outside the",
        "sparse-checkout definition but are not sparse due to local",
        "modifications.",
        ...dirtyPaths,
      );
      if (configBool(this.workingCopy, "advice.updateSparsePath", true)) {
        result.warnings.push(
          "hint: To correct the sparsity of these paths, do the following:",
          'hint: * Use "git add --sparse <paths>" to update the index',
          'hint: * Use "git sparse-checkout reapply" to apply the sparsity rules',
          `hint: Disable this message with "${this.compatibility === "2.43" ? "git config" : "git config set"} advice.updateSparsePath false"`,
        );
      }
    }
    if (changed || gitmodulesModified) {
      await this.writeMoves(adder, worktree, gitmodulesModified);
    }
    return result;
  }

  /** The index's entries in its order. */
  private async indexEntries(): Promise<IndexEntry[]> {
    const list = this.staging.entryList?.();
    if (list) return [...list];
    const out: IndexEntry[] = [];
    for await (const e of this.staging.entries()) out.push(e);
    return out;
  }

  /** `stage_updated_gitmodules` when needed, then the index written. */
  private async writeMoves(
    adder: IndexAdder,
    worktree: Worktree,
    gitmodulesModified: boolean,
  ): Promise<void> {
    if (gitmodulesModified) {
      const entry = await worktree.getEntry(".gitmodules");
      if (entry && !entry.isDirectory) await adder.add(worktree, ".gitmodules", entry);
    }
    await adder.finish();
    await this.staging.write();
  }

  /** `checkout_entry` (forced) of the entries moved into the sparse cone. */
  private async checkoutEntries(
    worktree: Worktree,
    entries: IndexEntry[],
    index: Map<string, IndexEntry>,
    trust: WorktreeModeTrust,
  ): Promise<void> {
    const target = new Map<string, { objectId: ObjectId; mode: number }>();
    for (const e of entries) target.set(e.path, e);
    const plan = await planFlatRestore(this.blobs, target, new Set(target.keys()), "mv", {
      symlinks: true,
      ...worktreePathRules(this.workingCopy, worktree),
      reservedNames: worktree.capabilities?.reservedNames,
    });
    const attributes = new Map<string, ObjectId>();
    for (const [path, e] of index)
      if (path.endsWith(".gitattributes")) attributes.set(path, e.objectId);
    await writeTreeRestorePlan(worktree, this.blobs, plan, "mv", {
      symlinks: trust.symlinks,
      gitlinks: true,
      replaceInTheWay: true,
      discardUntracked: true,
      attributes: { direction: "checkout", index: attributesIndexOf(attributes) },
    });
  }

  /**
   * `submodule_gitfile_path`: the repository of the submodule at `src` (its gitfile's
   * target, relative to the worktree root), or {@link SUBMODULE_WITH_GITDIR}; dies on a
   * directory the index holds as no submodule, and on unstaged `.gitmodules` changes.
   */
  private async submoduleGitfilePath(
    worktree: Worktree,
    src: string,
    entry: IndexEntry,
  ): Promise<SubmoduleGitfile> {
    if (entry.mode !== FileMode.GITLINK) {
      throw new MvFailedError(`fatal: Directory ${src} is in index and no submodule?`);
    }
    if (!(await this.stagingGitmodulesOk(worktree))) {
      throw new MvFailedError(
        "fatal: Please stage your changes to .gitmodules or stash them to proceed",
      );
    }
    const dotGit = await worktree.getEntry(`${src}/.git`).catch(() => undefined);
    if (!dotGit || dotGit.isDirectory) return SUBMODULE_WITH_GITDIR;
    const text = await readText(worktree, `${src}/.git`);
    const m = /^gitdir: (.*?)\s*$/m.exec(text);
    if (!m?.[1]) return SUBMODULE_WITH_GITDIR;
    const target = m[1];
    if (target.startsWith("/")) return target;
    // relative to the submodule: as a path from the worktree's top (it may climb out)
    const out: string[] = [];
    for (const part of `${src}/${target}`.split("/")) {
      if (part === "" || part === ".") continue;
      if (part === ".." && out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else out.push(part);
    }
    return out.join("/") || ".";
  }

  /** `is_staging_gitmodules_ok`: `.gitmodules` holds no change the index does not. */
  private async stagingGitmodulesOk(worktree: Worktree): Promise<boolean> {
    const entry = await this.staging.getEntry(".gitmodules");
    if (!entry) return true;
    const file = await worktree.getEntry(".gitmodules").catch(() => undefined);
    if (!file || file.isDirectory) return true;
    const compared = await compareWithWorktree(worktree, entry, {
      trust: worktreeModeTrust(this.workingCopy, worktree),
      indexTime: this.staging.getUpdateTime(),
    }).catch(() => undefined);
    if (compared?.kind !== "modified") return true;
    const id = compared.hashedId ?? (await worktree.computeHash(".gitmodules"));
    return id === entry.objectId;
  }

  /**
   * `update_path_in_gitmodules`: the `path` of the `.gitmodules` section naming `oldPath`
   * set to `newPath` (the line rewritten as `git config` writes it). Returns whether the
   * file changed; nothing without a `.gitmodules`, git's warning without a section.
   */
  private async updatePathInGitmodules(
    worktree: Worktree,
    oldPath: string,
    newPath: string,
    warnings: string[],
  ): Promise<boolean> {
    const file = await worktree.getEntry(".gitmodules").catch(() => undefined);
    if (!file || file.isDirectory) return false;
    for await (const e of this.staging.entries()) {
      if (e.path === ".gitmodules" && e.stage !== 0) {
        throw new MvFailedError(
          "fatal: Cannot change unmerged .gitmodules, resolve merge conflicts first",
        );
      }
    }
    const text = await readText(worktree, ".gitmodules");
    const declared = parseGitmodules(text).filter((s) => s.path === oldPath);
    const submodule = declared[declared.length - 1];
    if (!submodule) {
      warnings.push(`warning: Could not find section in .gitmodules where path=${oldPath}`);
      return false;
    }
    const updated = setGitmodulesPath(text, submodule.name, newPath);
    if (updated === undefined) return false;
    await worktree.writeContent(".gitmodules", new TextEncoder().encode(updated), { raw: true });
    return true;
  }
}

/** `index_name_pos`: the position of `name` at stage 0, or `-(insertion point) - 1`. */
function indexNamePos(cache: readonly IndexEntry[], name: string): number {
  let lo = 0;
  let hi = cache.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const e = cache[mid] as IndexEntry;
    const c = compareGitPaths(e.path, name) || e.stage;
    if (c === 0) return mid;
    if (c < 0) lo = mid + 1;
    else hi = mid;
  }
  return -lo - 1;
}

/**
 * `ie_modified` of an index entry against its file: the content (or mode) differs. An
 * intent-to-add entry always differs (`ie_match_stat`), unless `refresh` asks as
 * `refresh_cache_entry` does for an entry it may take a new stat for.
 */
async function entryModified(
  worktree: Worktree,
  entry: IndexEntry,
  trust: WorktreeModeTrust,
  indexTime: number,
  refresh = false,
): Promise<boolean> {
  if (entry.intentToAdd && !refresh) return true;
  const compared = await compareWithWorktree(worktree, entry, { trust, indexTime }).catch(
    () => undefined,
  );
  return compared === undefined || compared.kind !== undefined;
}

/** `has_symlink_leading_path`: a leading directory of `path` is a symbolic link. */
async function hasSymlinkLeadingPath(worktree: Worktree, path: string): Promise<boolean> {
  const parts = path.split("/");
  for (let k = 1; k < parts.length; k++) {
    const entry = await worktree.getEntry(parts.slice(0, k).join("/")).catch(() => undefined);
    if (!entry) return (await statThroughLeadingLinks(worktree, path)) !== undefined;
    if (entry.mode === FileMode.SYMLINK) return true;
    if (!entry.isDirectory) return false;
  }
  return false;
}

/**
 * `rename(2)` through the worktree: a link moves as the link, a directory with everything
 * in it. A worktree without rename copies the file and removes the original. A destination
 * that is the source itself (a case-only rename where the filesystem folds case, or the
 * same file under another name) is never removed first: the entry is renamed directly, as
 * git's `rename` does; a directory moved beneath itself fails (`EINVAL`): one of the
 * destination's leading directories is the source (the same path, the same inode where the
 * worktree reports one, or a case variant the filesystem folds onto it: `core.ignoreCase`
 * alone folds nothing, as on a case-sensitive filesystem `D` and `d` are two). A file at the
 * destination is replaced by the rename itself, atomically as `rename(2)` does, so a move
 * that fails leaves it in place; only a worktree without rename removes it first. An empty
 * directory at the destination is removed first (never one holding anything: `ENOTEMPTY`).
 */
async function renamePath(worktree: Worktree, src: string, dst: string): Promise<void> {
  const fail = (code: string): never => {
    throw Object.assign(new Error(code), { code });
  };
  const source = await worktree.getEntry(src).catch(() => undefined);
  if (!source) fail("ENOENT");
  const sameInode = (other: { ino?: number; dev?: number } | undefined) =>
    other !== undefined &&
    source?.ino !== undefined &&
    source.ino !== 0 &&
    source.ino === other.ino &&
    source.dev === other.dev;
  if (source?.isDirectory) {
    for (let at = dst.lastIndexOf("/"); at > 0; at = dst.lastIndexOf("/", at - 1)) {
      const ancestor = dst.slice(0, at);
      if (ancestor === src || (await sameEntryByCase(worktree, ancestor, src))) fail("EINVAL");
      if (sameInode(await worktree.getEntry(ancestor).catch(() => undefined))) fail("EINVAL");
    }
  }
  // rename(2) creates no leading directory: ENOENT for a missing one, ENOTDIR for a file
  // (a link included) among them
  const slash = dst.lastIndexOf("/");
  if (slash > 0) {
    const parent = await worktree.getEntry(dst.slice(0, slash)).catch(() => undefined);
    if (!parent) {
      const through = await statThroughLeadingLinks(worktree, `${dst.slice(0, slash)}/x`);
      fail(through === undefined ? "ENOENT" : "ENOTDIR");
    } else if (!parent.isDirectory) fail("ENOTDIR");
  }
  const target = await worktree.getEntry(dst).catch(() => undefined);
  const sameEntry =
    target !== undefined &&
    (src === dst || sameInode(target) || (await sameEntryByCase(worktree, src, dst)));
  const canRename = typeof worktree.rename === "function";
  if (target && !sameEntry) {
    if (target.isDirectory) {
      // rename(2) of a directory over an empty one replaces it; anything else fails
      if (!source?.isDirectory) fail("EISDIR");
      if (!(await removeDirectoryIfEmpty(worktree, dst).catch(() => false))) fail("ENOTEMPTY");
    } else if (source?.isDirectory) {
      fail("ENOTDIR");
    } else if (!canRename) {
      await worktree.remove(dst);
    }
  }
  if (canRename) {
    await worktree.rename(src, dst);
    return;
  }
  if (sameEntry) fail("EINVAL");
  const chunks: Uint8Array[] = [];
  for await (const chunk of worktree.readContent(src)) chunks.push(chunk);
  await worktree.writeContent(dst, concat(chunks), { raw: true });
  await worktree.remove(src);
}

/**
 * Whether `a` and `b`, two spellings of one path that differ in case only, name one entry
 * (the filesystem folds case): each differing component's directory lists only one of the
 * two names. A directory never lists one entry twice, so where both are listed (a
 * case-sensitive filesystem holding `D` and `d`) they are two.
 */
async function sameEntryByCase(worktree: Worktree, a: string, b: string): Promise<boolean> {
  const pa = a.split("/");
  const pb = b.split("/");
  if (a === b || pa.length !== pb.length || a.toLowerCase() !== b.toLowerCase()) return false;
  for (let k = 0; k < pa.length; k++) {
    const na = pa[k] as string;
    const nb = pb[k] as string;
    if (na === nb) continue;
    const parent = pa.slice(0, k).join("/");
    const listed = new Set<string>();
    const inside = worktree.walk({
      ...(parent ? { pathPrefix: parent } : {}),
      includeIgnored: true,
      includeDirectories: true,
      maxDepth: 0,
    });
    try {
      for await (const entry of inside) {
        const name = parent ? entry.path.slice(parent.length + 1) : entry.path;
        if (!name.includes("/")) listed.add(name);
      }
    } catch {
      return false;
    }
    if (listed.has(na) && listed.has(nb)) return false;
  }
  return true;
}

/**
 * `git config -f .gitmodules submodule.<name>.path <value>`: the `path` line of the last
 * section of that name replaced by `\tpath = <value>` (quoted and escaped as git writes it).
 */
function setGitmodulesPath(text: string, name: string, value: string): string | undefined {
  const lines = text.split(/(?<=\n)/);
  let inSection = false;
  let at = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const trimmed = line.trimStart();
    if (trimmed.startsWith("[")) {
      const m = /^\[\s*submodule\s+"((?:[^"\\]|\\.)*)"\s*\]/i.exec(trimmed);
      inSection = m !== null && m[1]?.replace(/\\(.)/g, "$1") === name;
      continue;
    }
    if (inSection && /^\s*path\s*(=|$)/i.test(line)) at = i;
  }
  if (at < 0) return undefined;
  const quote = /^\s|\s$|[;#]/.test(value) ? '"' : "";
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
  lines[at] = `\tpath = ${quote}${escaped}${quote}\n`;
  return lines.join("");
}

async function readText(worktree: Worktree, path: string): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of worktree.readContent(path)) chunks.push(chunk);
  return new TextDecoder().decode(concat(chunks));
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let size = 0;
  for (const c of chunks) size += c.length;
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
