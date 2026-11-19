import { type Commits, countAheadBehind, FileMode, type ObjectId } from "@statewalker/vcs-core";
import { parseGitBool } from "@statewalker/vcs-utils";
import {
  type CacheTree,
  compareWithWorktree,
  compareWithWorktreeStat,
  DIR_HIDE_EMPTY_DIRECTORIES,
  DIR_SHOW_IGNORED_TOO,
  DIR_SHOW_IGNORED_TOO_MODE_MATCHING,
  DIR_SHOW_OTHER_DIRECTORIES,
  getStageState,
  getWorktreeEntries,
  IndexPathLookup,
  type IndexStatUpdate,
  isCleanByStat,
  modeFromWorktree,
  readConvertedContent,
  refreshIndexStats,
  type StageStateValue,
  type StagingEntry,
  scanUntracked,
  statUpdateOf,
  unreadableDirectoryWarning,
  type WorkingCopy,
  type Worktree,
  type WorktreeModeTrust,
  walkUntrackedScanHost,
} from "@statewalker/vcs-working-tree";

import {
  IncompatibleOptionsError,
  InvalidArgumentError,
  InvalidConfigError,
} from "../errors/index.js";
import { GitCommand } from "../git-command.js";
import { RemoteConfigStore } from "../remote-config/index.js";
import {
  DEFAULT_RENAME_LIMIT,
  detectRenames,
  type RenameCandidate,
  scorePercent,
} from "../rename/index.js";
import {
  type Status,
  type StatusCode,
  type StatusFileEntry,
  StatusImpl,
  type StatusSide,
  submoduleToken,
} from "../results/status-result.js";
import { worktreeModeTrust } from "./core-config.js";
import { DiffCommand } from "./diff-command.js";
import { hostEnvironmentOf } from "./git-ident.js";
import { OperationState } from "./merge-support.js";
import { commentPrefixOf } from "./message-cleanup.js";
import {
  DO_MATCH_DIRECTORY,
  globalPathspecMagic,
  matchPathspec,
  type PathspecItem,
  parsePathspec,
  untrackedScanPathspec,
} from "./pathspec.js";
import {
  type CommitWhence,
  formatStatusText,
  type StatusText,
  statusCommitInfo,
} from "./status-format.js";
import { readStatusHeader } from "./status-header.js";
import {
  type GitmodulesEntry,
  isSubmoduleIgnoreMode,
  parseGitmodules,
  type SubmoduleIgnoreFlags,
  type SubmoduleIgnoreMode,
  submoduleIgnoreFlags,
} from "./submodule-config.js";
import type { TrackingSource } from "./tracking-info.js";
import { openUntrackedCache } from "./untracked-cache-support.js";
import { shortenUnambiguousRef } from "./worktree-list-command.js";

export type { SubmoduleIgnoreMode } from "./submodule-config.js";

/** The porcelain `XY` of an unmerged path, by which of stages 1-3 it has. */
const UNMERGED_CODES: Record<number, [StatusCode, StatusCode]> = {
  1: ["D", "D"],
  2: ["A", "U"],
  3: ["U", "D"],
  4: ["U", "A"],
  5: ["D", "U"],
  6: ["A", "A"],
  7: ["U", "U"],
};

const S_IFMT = 0o170000;

/** HEAD's side of an entry in a directory the cache-tree shows unchanged: the entry's own. */
const SAME = Symbol("same-as-head");

/** How many files the stat pass asks the worktree for at once. */
const STAT_CHUNK = 4096;

/** A `.gitignore` path (the untracked cache records the ids of those files). */
const isIgnoreFilePath = (path: string) => path === ".gitignore" || path.endsWith("/.gitignore");
const typeOf = (mode: number) => mode & S_IFMT;
const isGitlink = (mode: number | undefined) => mode === FileMode.GITLINK;

/** A git boolean, `copies`/`copy` (rename detection on) or undefined when not one. */
function renamesValue(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const v = value.toLowerCase();
  if (v === "copies" || v === "copy") return true;
  return parseGitBool(value);
}

/**
 * Which untracked files status lists (`--untracked-files`, `status.showUntrackedFiles`):
 * none, untracked directories as `dir/` (git's default), or every file.
 */
export type UntrackedFilesMode = "no" | "normal" | "all";

/**
 * Which ignored files status lists (`--ignored`): none (the default), every ignored path
 * with an ignored directory as `dir/` (`traditional`, what `--ignored` alone means), or the
 * paths an exclude pattern matches (`matching`).
 */
export type IgnoredMode = "no" | "traditional" | "matching";

/**
 * A value of `--untracked-files` or `status.showUntrackedFiles` as git 2.5x reads it
 * (builtin/commit.c `parse_untracked_setting_name`): a boolean (`true`, `yes`, `on`, `1`, a
 * variable without `=`; `false`, `off`, `0`, an empty value) is `normal` or `no`, else
 * exactly `no`, `normal` or `all`. Undefined for anything else. git 2.43 took the three
 * names alone.
 *
 * @example
 * ```typescript
 * parseUntrackedFilesMode("false"); // "no"
 * parseUntrackedFilesMode("All"); // undefined (git: "Invalid untracked files mode 'All'")
 * ```
 */
export function parseUntrackedFilesMode(value: string | undefined): UntrackedFilesMode | undefined {
  const asBool = value === undefined ? true : parseGitBool(value);
  if (asBool === false) return "no";
  if (asBool === true) return "normal";
  return value === "no" || value === "normal" || value === "all" ? value : undefined;
}

/**
 * `status.showUntrackedFiles` as git's `git_status_config` reads it (`git status` and
 * `git commit` alike): its last value, undefined when it is not set. Every value is checked
 * in the configuration's order, and the first one git cannot read fails with git's message
 * (`error: Invalid untracked files mode '<value>'`, then where it was read).
 *
 * @example
 * ```typescript
 * const mode = readShowUntrackedFiles(workingCopy) ?? "normal";
 * ```
 */
export function readShowUntrackedFiles(workingCopy: WorkingCopy): UntrackedFilesMode | undefined {
  const key = "status.showuntrackedfiles";
  let configured: UntrackedFilesMode | undefined;
  const values = RemoteConfigStore.from(workingCopy).valuesWithOrigin("status.showUntrackedFiles");
  for (const { text, file, line } of values) {
    const mode = parseUntrackedFilesMode(text);
    if (mode === undefined) {
      const where =
        file !== undefined && line !== undefined
          ? `fatal: bad config variable '${key}' in file '${file}' at line ${line}`
          : `fatal: unable to parse '${key}' from command-line config`;
      throw new InvalidConfigError(
        "status.showUntrackedFiles",
        `error: Invalid untracked files mode '${text}'\n${where}`,
      );
    }
    configured = mode;
  }
  return configured;
}

/** A value of `--ignored` (builtin/commit.c `handle_ignored_arg`), else undefined. */
export function parseIgnoredMode(value: string): IgnoredMode | undefined {
  return value === "no" || value === "traditional" || value === "matching" ? value : undefined;
}

/** A git integer (`1000`, `2k`), or undefined when not one. */
function intValue(value: string | undefined): number | undefined {
  const m = value?.trim().match(/^(-?\d+)([kmg]?)$/i);
  if (!m) return undefined;
  const unit = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2].toLowerCase()] ?? 1;
  return Number(m[1]) * unit;
}

async function concat(chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>) {
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of chunks) {
    parts.push(chunk);
    size += chunk.length;
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** What a submodule's own worktree holds (git's `DIRTY_SUBMODULE_*`). */
export interface SubmoduleDirt {
  modified?: boolean;
  untracked?: boolean;
}

/**
 * The state of the submodule at `path` in its own index and worktree, as git's
 * `is_submodule_modified` reads it from `git status --porcelain=2` run inside it: an
 * untracked file there (or a nested submodule holding only untracked files, `S..U`) is
 * untracked content; any other change, a nested submodule's included, is modified content.
 * Nothing for a submodule that is not populated (or that the worktree cannot open). A
 * configuration the inner status cannot read fails with its messages and git's
 * `'git status --porcelain=2' failed in submodule <path>`.
 */
export async function readSubmoduleDirt(
  worktree: Worktree,
  path: string,
  ignoreUntracked: boolean,
): Promise<SubmoduleDirt> {
  const inner: WorkingCopy | undefined = await worktree.openGitlink?.(path);
  if (!inner) return {};
  // `git status --porcelain=2` there, with `-uno` when untracked content is ignored
  const command = new StatusCommand(inner).setRenames(false);
  if (ignoreUntracked) command.setUntrackedFiles("no");
  let status: Status;
  try {
    status = await command.call();
  } catch (error) {
    // the child dies on its configuration (its own messages), then the parent does
    if (error instanceof InvalidConfigError) {
      throw new InvalidConfigError(
        error.key,
        `${error.message}\nfatal: 'git status --porcelain=2' failed in submodule ${path}`,
      );
    }
    throw error;
  }
  const dirt: SubmoduleDirt = {};
  for (const f of status.files) {
    if (f.index === "!") continue;
    if (f.index === "?") {
      dirt.untracked = true;
      continue;
    }
    const token = submoduleToken(f);
    if (token[0] === "S" && token[3] === "U") dirt.untracked = true;
    if (f.stages || f.renamedFrom || token !== "S..U") dirt.modified = true;
  }
  return dirt;
}

/**
 * Shows the working tree status, as `git status`: the index against HEAD (staged changes),
 * the worktree against the index (unstaged changes: modified, deleted, type changed),
 * unmerged entries, untracked files and, on request, ignored ones.
 *
 * Worktree files are compared with the index through the stat it recorded: a file whose
 * size and modification time still match is not read, unless its entry is racily clean
 * (modified at or after the index was written), which is re-hashed as git does. Links are
 * compared as links (mode 120000), the executable bit only where `core.filemode` trusts it,
 * and the ignore rules are read afresh for each status.
 *
 * Untracked files are found by git's directory walk (dir.c `read_directory`) in the mode
 * {@link setUntrackedFiles} or `status.showUntrackedFiles` asks: `normal` (the default) shows
 * an untracked directory as `dir/` and hides one holding nothing untracked, `all` lists every
 * file, `no` none. {@link setIgnored} adds the ignored paths (`traditional`: an ignored
 * directory as `dir/`; `matching`: the paths an exclude pattern matches). A whole-tree scan
 * without ignored files goes through the index's untracked cache (`UNTR`) as git uses it:
 * directories whose stat and ignore rules are unchanged are not read again, and the cache is
 * written back as git writes it (`core.untrackedCache`: true writes it, false removes it,
 * unset keeps it), made for the mode `status.showUntrackedFiles` names.
 *
 * Renames are detected as git's default `status.renames=true` does: a path deleted from the
 * index paired with one added to it (`R  old -> new`), and a path deleted from the worktree
 * paired with an intent-to-add file (` R old -> new`); untracked files are never paired.
 * `status.renames` (else `diff.renames`), `status.renameLimit` (else `diff.renameLimit`) and
 * {@link setRenames} control it.
 *
 * A populated submodule's own state is read as git does: a commit other than the index's
 * (`SC..`), tracked changes inside it (`S.M.`) and untracked files inside it (`S..U`) all
 * show as ` M sub`; `diff.ignoreSubmodules`, `submodule.<name>.ignore` (config, then
 * `.gitmodules`) and {@link setIgnoreSubmodules} limit what is looked at.
 *
 * Without a worktree only the index is compared with HEAD.
 *
 * Based on JGit's StatusCommand.
 *
 * @example
 * ```typescript
 * const status = await git.status().call();
 * if (status.isClean()) console.log("nothing to commit, working tree clean");
 * console.log("Staged:", status.added, status.changed, status.removed, status.renamed);
 * console.log("Unstaged:", status.modified, status.missing);
 * console.log("Untracked:", status.untracked);
 * // the lines of `git status --porcelain`
 * console.log(formatStatusPorcelain(status));
 * ```
 */
export class StatusCommand extends GitCommand<Status> {
  private paths: string[] = [];
  /** The pathspec of the running status (git's `s->pathspec`), parsed from `paths` */
  private pathspec: PathspecItem[] = [];
  private ignoredMode: IgnoredMode = "no";
  private untrackedMode?: UntrackedFilesMode;
  /** The mode of the running status (the setter, else `status.showUntrackedFiles`) */
  private resolvedUntracked: UntrackedFilesMode = "normal";
  private renames?: boolean;
  private renameLimit?: number;
  private ignoreSubmodules?: SubmoduleIgnoreMode;
  private gitmodules?: Promise<GitmodulesEntry[]>;
  /** The commit the index is compared with: undefined is HEAD, null none (initial) */
  private reference?: ObjectId | null;
  /** Whether the refreshed stats (and the untracked cache) are written back */
  private writeIndex = true;

  /**
   * Add a pathspec element (from the top of the worktree), as `git status -- <pathspec>`
   * takes it (pathspec.c): a path or directory, a wildcard (`*.txt`, matched by `fnmatch`
   * without `WM_PATHNAME`, so `*` crosses `/`), or an element with magic: `:(glob)`,
   * `:(literal)`, `:(icase)`, `:(exclude)` (`:!`, `:^`; an element of excludes alone gets
   * an implicit `.`), `:/` and `:(prefix:N)`. `GIT_LITERAL_PATHSPECS`, `GIT_GLOB_PATHSPECS`,
   * `GIT_NOGLOB_PATHSPECS` and `GIT_ICASE_PATHSPECS` of the host environment apply.
   * `:(attr:...)` is refused (attributes are not matched here). Tracked paths are matched as
   * diff-files and diff-index match them (`ce_path_match`), untracked ones by dir.c's walk.
   *
   * @param path A pathspec element
   */
  addPath(path: string): this {
    this.checkCallable();
    this.paths.push(path);
    return this;
  }

  /**
   * Which ignored files the index does not track to report (`--ignored[=<mode>]`): `no`
   * (the default), `traditional` (`true`: what `--ignored` alone means) or `matching`. They
   * are looked for with the untracked files, so `--untracked-files=no` shows none, and
   * `matching` with it fails as git does ("Unsupported combination of ignored and
   * untracked-files arguments").
   */
  setIgnored(ignored: boolean | IgnoredMode): this {
    this.checkCallable();
    this.ignoredMode = ignored === true ? "traditional" : ignored === false ? "no" : ignored;
    return this;
  }

  /**
   * Which untracked files to report (`--untracked-files=<mode>`): `normal` shows an
   * untracked directory as `dir/` (hiding one with nothing untracked in it), `all` every
   * file in it, `no` none (untracked files inside submodules are not looked for either).
   * Unset, `status.showUntrackedFiles` decides, else `normal` (git's default).
   */
  setUntrackedFiles(mode: UntrackedFilesMode): this {
    this.checkCallable();
    this.untrackedMode = mode;
    return this;
  }

  /**
   * Whether to report untracked files: true is `--untracked-files=all` (every file listed),
   * false `--untracked-files=no`.
   *
   * @deprecated Use {@link setUntrackedFiles}.
   */
  setUntracked(untracked: boolean): this {
    return this.setUntrackedFiles(untracked ? "all" : "no");
  }

  /**
   * Whether to detect renames (`--renames` / `--no-renames`). Unset, `status.renames`
   * decides, else `diff.renames`, else on (git's default).
   */
  setRenames(renames: boolean): this {
    this.checkCallable();
    this.renames = renames;
    return this;
  }

  /**
   * The rename limit: inexact renames are looked for only while the unpaired deleted
   * times added paths stay within its square. Unset, `status.renameLimit` decides, else
   * `diff.renameLimit`, else 1000; 0 is no limit.
   */
  setRenameLimit(limit: number): this {
    this.checkCallable();
    this.renameLimit = limit;
    return this;
  }

  /**
   * `--ignore-submodules=<when>`: overrides `diff.ignoreSubmodules` and every
   * `submodule.<name>.ignore`. `all` hides submodule changes (staged ones too), `dirty`
   * only reports a submodule at another commit, `untracked` ignores untracked files inside
   * submodules, `none` reports everything.
   */
  setIgnoreSubmodules(mode: SubmoduleIgnoreMode): this {
    this.checkCallable();
    this.ignoreSubmodules = mode;
    return this;
  }

  /**
   * The commit the index is compared with instead of HEAD (`s->reference`: `git commit
   * --amend` compares with `HEAD^1`), null for none (every entry new, as before the first
   * commit).
   */
  setReferenceCommit(id: ObjectId | null): this {
    this.checkCallable();
    this.reference = id;
    return this;
  }

  /**
   * Whether the stats refreshed while comparing (and a changed untracked cache) are written
   * back to the index (default true, as `git status`). A caller holding the index with
   * edits of its own (a commit's prepared index) passes false.
   */
  setWriteIndex(write: boolean): this {
    this.checkCallable();
    this.writeIndex = write;
    return this;
  }

  /** The commit compared with: the one set, else HEAD's (undefined: none). */
  private async referenceCommit(): Promise<ObjectId | undefined> {
    if (this.reference !== undefined) return this.reference ?? undefined;
    const headRef = await this.refsStore.resolve("HEAD").catch(() => undefined);
    if (!headRef?.objectId) return undefined;
    // repo_get_oid("HEAD") names a commit only when it loads as one
    return (await this.commits.load(headRef.objectId).catch(() => undefined))
      ? headRef.objectId
      : undefined;
  }

  /**
   * The status as `git status` prints it (wt_status_print), in the format asked: the long
   * format (the default, or `status.short`), `short`, `porcelain` (v1) or `porcelain-v2`,
   * with `--branch`, `-z`, `--show-stash` and `-v`; the deferred configuration
   * (`status.short`, `status.branch`, `status.aheadBehind`, `status.showStash`) applies to
   * the human formats as in git. `committable` is wt_status's: something staged (or a
   * merge with every conflict resolved).
   *
   * @example
   * ```typescript
   * const { text } = await git.status().callText({ format: "short", branch: true });
   * // "## main...origin/main [ahead 1]\n M a.txt\n?? new.txt\n"
   * ```
   */
  async callText(options: StatusCallTextOptions = {}): Promise<StatusTextResult> {
    const z = options.z === true;
    let format = options.format;
    if (z && format === "long") {
      throw new IncompatibleOptionsError(
        ["--long", "-z"],
        "options '--long' and '-z' cannot be used together",
      );
    }
    if (z && format === undefined) format = "porcelain";
    const deferred = format !== "porcelain" && format !== "porcelain-v2" && !z;
    const config = this.config;
    if (deferred && format === undefined) {
      format = cfgBool(config, "status.short", false) ? "short" : "long";
    }
    const resolvedFormat = format ?? "long";
    const branch = options.branch ?? (deferred ? cfgBool(config, "status.branch", false) : false);
    const quick =
      options.aheadBehind !== undefined
        ? !options.aheadBehind
        : deferred
          ? !cfgBool(config, "status.aheadBehind", true)
          : false;
    const showStash = options.showStash ?? cfgBool(config, "status.showStash", false);
    const status = await this.call();
    const hints = options.hints ?? cfgBool(config, "advice.statusHints", true);
    const commentPrefix =
      options.commentPrefix ??
      (resolvedFormat === "long" && cfgBool(config, "status.displayCommentPrefix", false)
        ? commentLineString(this.workingCopy)
        : undefined);
    const referenceId = await this.referenceCommit();
    const header = await this.readHeader(status, referenceId, {
      long: resolvedFormat === "long",
      short: branch && resolvedFormat !== "long",
      quick,
      divergenceAdvice: options.commitTemplate !== true,
      hints,
      stash: showStash,
      amend: options.amend === true,
      nowarn: options.nowarn === true,
    });
    const info = statusCommitInfo(status, header);
    let verbose: string | undefined;
    if ((options.verbose ?? 0) > 0 && resolvedFormat === "long") {
      verbose = await this.verboseText(options.verbose ?? 0, {
        toFile: options.toFile === true,
        cutLineAdded: options.cutLineAdded === true,
        committable: info.committable,
        worktreeChanges: info.worktreeChanges,
        referenceId,
        commentPrefix,
      });
    }
    const out = formatStatusText(status, header, {
      format: resolvedFormat,
      branch,
      z,
      showStash,
      quotePath: cfgBool(config, "core.quotePath", true),
      hints,
      ...(commentPrefix !== undefined ? { commentPrefix } : {}),
      untracked: this.resolvedUntracked,
      ignored: this.ignoredMode,
      commitTemplate: options.commitTemplate === true,
      amend: options.amend === true,
      nowarn: options.nowarn === true,
      whence: options.whence ?? (await this.determineWhence()),
      reference: options.amend ? "HEAD^1" : "HEAD",
      aheadBehindQuick: quick,
      ...(verbose !== undefined ? { verbose } : {}),
    });
    return {
      ...out,
      status,
      warnings: [...status.warnings, ...header.warnings],
    };
  }

  /**
   * builtin/commit.c's determine_whence: a merge while MERGE_HEAD exists, a cherry-pick
   * while CHERRY_PICK_HEAD does (sequencer_determine_whence), else a plain commit.
   */
  private async determineWhence(): Promise<CommitWhence> {
    const state = new OperationState(this.workingCopy.checkout, this.refsStore);
    if ((await state.read("MERGE_HEAD")) !== undefined) return "merge";
    if (await state.ref("CHERRY_PICK_HEAD")) return "cherry-pick";
    return "commit";
  }

  /** The header of the text forms: branch, operations in progress, tracking, stash. */
  private async readHeader(
    status: Status,
    referenceId: ObjectId | undefined,
    want: {
      long: boolean;
      short: boolean;
      quick: boolean;
      divergenceAdvice: boolean;
      hints: boolean;
      stash: boolean;
      amend: boolean;
      nowarn: boolean;
    },
  ) {
    const refs = this.refsStore;
    const resolver = this.revisionResolver();
    const commits = this.walkCommits;
    const peel = async (id: ObjectId) => resolver.commitReference(id).catch(() => undefined);
    const tracking: TrackingSource = {
      config: (key) => this.config.value(key),
      upstreamOf: (branch) => resolver.upstreamOf(branch).catch(() => undefined),
      pushOf: (branch) => resolver.pushOf(branch).catch(() => undefined),
      pushRemoteOf: async (branch) => {
        try {
          return resolver.pushRemoteOf(branch);
        } catch {
          return undefined;
        }
      },
      refCommit: async (ref) => {
        const id = (await refs.resolve(ref).catch(() => undefined))?.objectId;
        return id ? peel(id) : undefined;
      },
      shortenRef: (ref) => shortenUnambiguousRef(refs, ref),
      aheadBehind: (ours, theirs) => aheadBehind(commits, ours, theirs),
    };
    const entries = this.staging.entryList?.() ?? (await collectEntries(this.staging.entries()));
    return readStatusHeader(
      {
        refs,
        state: new OperationState(this.workingCopy.checkout, refs),
        tracking,
        abbreviate: (id) => this.abbreviateObjectId(id),
        dwimRef: (name) => resolver.dwimRef(name).catch(() => []),
        commitOf: peel,
        objectExists: async (id) =>
          (await resolver.objectType(id).catch(() => undefined)) !== undefined,
        config: (key) => this.config.value(key),
        entries,
      },
      {
        ...(referenceId ? { referenceId } : {}),
        tracking: {
          ...(want.long
            ? {
                long: {
                  quick: want.quick,
                  divergenceAdvice: want.divergenceAdvice,
                  hints: want.hints,
                },
              }
            : {}),
          ...(want.short ? { short: { quick: want.quick } } : {}),
        },
        amend: want.amend,
        nowarn: want.nowarn,
        workdirDirty: statusCommitInfo(status, { isInitial: !referenceId, state: {} }).workdirDirty,
        stash: want.stash,
      },
    );
  }

  /**
   * wt_longstatus_print_verbose: the staged changes as a patch (and with `-vv` the unstaged
   * ones, under their own headers); in a file (the commit template) after the cut line.
   */
  private async verboseText(
    level: number,
    o: {
      toFile: boolean;
      cutLineAdded: boolean;
      committable: boolean;
      /** wt_status_check_worktree_changes: unmerged paths left out */
      worktreeChanges: boolean;
      referenceId: ObjectId | undefined;
      commentPrefix: string | undefined;
    },
  ): Promise<string> {
    const p = (text: string) =>
      o.commentPrefix !== undefined ? `${o.commentPrefix}${text ? ` ${text}` : ""}\n` : `${text}\n`;
    let out = "";
    if (o.toFile && !o.cutLineAdded) out += cutLine(o.commentPrefix ?? "#");
    const twoLevels = level > 1;
    let cachedPrefixes: { srcPrefix: string; dstPrefix: string } | undefined;
    if (twoLevels && o.committable) {
      if (o.toFile) out += p("");
      out += p("Changes to be committed:");
      cachedPrefixes = { srcPrefix: "c/", dstPrefix: "i/" };
    }
    const cached = new DiffCommand(this.workingCopy)
      .setCached(true)
      .setOldTree(o.referenceId ?? EMPTY_TREE)
      .setOptions({ ...(cachedPrefixes ?? {}) });
    if (this.renames !== undefined) cached.setRenames(this.renames);
    out += await cached.callText("patch");
    if (twoLevels && o.worktreeChanges) {
      out += p("--------------------------------------------------");
      out += p("Changes not staged for commit:");
      // run_diff_files without combine_merges (a conflicted path listed as unmerged and
      // diffed as its stage 2) nor dirty_submodules (git sets it after diff_setup_done)
      const files = new DiffCommand(this.workingCopy)
        .setCombineMerges(false)
        .setDirtySubmodules(false)
        .setOptions({ srcPrefix: "i/", dstPrefix: "w/" });
      if (this.renames !== undefined) files.setRenames(this.renames);
      out += await files.callText("patch");
    }
    return out;
  }

  async call(): Promise<Status> {
    this.checkCallable();
    this.setCallable(false);
    // git reads its configuration, then the options, before anything else
    this.resolvedUntracked = this.untrackedFilesMode();
    this.pathspec = this.parsePaths();
    if (this.ignoredMode === "matching" && this.resolvedUntracked === "no") {
      throw new IncompatibleOptionsError(
        ["--ignored=matching", "--untracked-files=no"],
        "Unsupported combination of ignored and untracked-files arguments",
      );
    }
    const worktree = this.worktreeAccess;
    // one operation: fresh ignore rules and one lstat cache for the whole status
    return worktree?.batch ? worktree.batch(() => this.compute(worktree)) : this.compute(worktree);
  }

  /** cmd_status's parse_pathspec (PATHSPEC_PREFER_FULL): none for no elements. */
  private parsePaths(): PathspecItem[] {
    if (this.paths.length === 0) return [];
    try {
      const global = globalPathspecMagic(hostEnvironmentOf(this.workingCopy)?.pathspecs);
      return parsePathspec(this.paths, { global, refuseAttrAsUnsupported: true });
    } catch (error) {
      throw new InvalidArgumentError("path", this.paths, `fatal: ${(error as Error).message}`);
    }
  }

  private get config(): RemoteConfigStore {
    return RemoteConfigStore.from(this.workingCopy);
  }

  /**
   * The untracked mode: the setter, else `status.showUntrackedFiles`, else `normal`. A bad
   * value of the variable fails whatever the setter says, as git reads its configuration
   * first.
   */
  private untrackedFilesMode(): UntrackedFilesMode {
    const configured = readShowUntrackedFiles(this.workingCopy);
    return this.untrackedMode ?? configured ?? "normal";
  }

  private async compute(worktree: Worktree | undefined): Promise<Status> {
    // git's repo_read_index: skip-worktree entries present in the worktree are checked out
    await this.clearPresentSkipWorktree();
    const head = new Map<string, StatusSide>();
    // directories where HEAD and the index agree (by the cache-tree): their entries are HEAD's
    const sameAsHead = new Set<string>();
    const referenceId = await this.referenceCommit();
    if (referenceId) {
      const headCommit = await this.commits.load(referenceId).catch(() => undefined);
      if (headCommit) {
        const cacheTree = this.staging.getCacheTree?.();
        await this.collectTreeEntries(headCommit.tree, "", head, cacheTree, sameAsHead);
      }
    }
    // (the entries come in path order: the last directory's answer serves its neighbours)
    let lastDir: string | undefined;
    let lastInSame = false;
    const headOf = (entry: StagingEntry): StatusSide | typeof SAME | undefined => {
      const path = entry.path;
      const found = head.get(path);
      if (found || sameAsHead.size === 0 || entry.intentToAdd) return found;
      const slash = path.lastIndexOf("/");
      const dir = slash < 0 ? "" : path.slice(0, slash);
      if (dir !== lastDir) {
        lastDir = dir;
        let inSame = sameAsHead.has("");
        for (let k = path.indexOf("/"); !inSame && k > 0; k = path.indexOf("/", k + 1)) {
          inSame = sameAsHead.has(path.slice(0, k));
        }
        lastInSame = inSame;
      }
      return lastInSame ? SAME : undefined;
    };

    const added = new Set<string>();
    const changed = new Set<string>();
    const removed = new Set<string>();
    const conflicting = new Set<string>();
    const conflictingStageState = new Map<string, StageStateValue>();
    const modified = new Set<string>();
    const missing = new Set<string>();
    const untracked = new Set<string>();
    const ignored = new Set<string>();
    const files: StatusFileEntry[] = [];

    const trust = worktree ? worktreeModeTrust(this.workingCopy, worktree) : undefined;
    const indexTime = this.staging.getUpdateTime();
    const gitlinks = new Set<string>();
    const refresh: IndexStatUpdate[] = [];
    const unmerged = new Map<string, [StatusSide?, StatusSide?, StatusSide?]>();
    // the `.gitignore` files whose entry is up to date (git's ce_uptodate after its refresh):
    // the untracked cache takes their ids from the index
    const upToDate = new Set<string>();

    // the stat pass: the files of the entries compared below, stat'ed a chunk at a time
    // (git's preload_index), each entry then compared synchronously where its stat settles
    // it, so only the few undecided ones (racy, changed, submodules) cost a promise
    const matchAll = this.paths.length === 0;
    const stated = (entry: StagingEntry) =>
      !!worktree &&
      entry.stage === 0 &&
      !entry.skipWorktree &&
      !entry.assumeValid &&
      !isGitlink(entry.mode) &&
      (matchAll || this.matchesTracked(entry.path, entry.mode));
    const all = this.staging.entryList?.() ?? (await collectEntries(this.staging.entries()));
    // the index's paths by binary search (git's index_name_pos), no set of every path built
    const index = new IndexPathLookup(all.map((e) => e.path));
    const tracked = { has: (path: string) => index.has(path) };
    const wanted: boolean[] = new Array(all.length);
    for (let start = 0; start < all.length; ) {
      let end = start;
      const paths: string[] = [];
      while (end < all.length && paths.length < STAT_CHUNK) {
        const entry = all[end] as StagingEntry;
        const want = stated(entry);
        wanted[end] = want;
        if (want) paths.push(entry.path);
        end++;
      }
      const found = worktree && paths.length > 0 ? await getWorktreeEntries(worktree, paths) : [];
      let k = 0;
      for (let i = start; i < end; i++) {
        const entry = all[i] as StagingEntry;
        const current = wanted[i] ? (found[k++] ?? null) : undefined;
        if (entry.mode === FileMode.GITLINK) gitlinks.add(entry.path);
        if (!matchAll && !this.matchesTracked(entry.path, entry.mode)) continue;
        if (entry.stage !== 0) {
          const stages = unmerged.get(entry.path) ?? [undefined, undefined, undefined];
          stages[entry.stage - 1] = { mode: entry.mode, id: entry.objectId };
          unmerged.set(entry.path, stages);
          continue;
        }
        // HEAD's side: SAME (a directory the cache-tree shows unchanged) is the entry itself
        const head = headOf(entry);
        let x: StatusCode = " ";
        if (head === SAME) {
          // HEAD and the index agree
        } else if (head && entry.intentToAdd) {
          // an intent-to-add entry is in no tree: against HEAD's path it is a deletion (git's
          // diff-index --cached), the file itself new on the worktree side
          x = "D";
          removed.add(entry.path);
        } else if (!head) {
          // an added submodule a `submodule.<name>.ignore=all` hides (git's diff_addremove)
          const hidden = isGitlink(entry.mode) && (await this.indexIgnoresAll(entry.path));
          if (!entry.intentToAdd && !hidden) {
            x = "A";
            added.add(entry.path);
          }
        } else if (head.id !== entry.objectId || head.mode !== entry.mode) {
          const hidden =
            isGitlink(head.mode) &&
            isGitlink(entry.mode) &&
            (await this.indexIgnoresAll(entry.path));
          if (!hidden) {
            x = typeOf(head.mode) === typeOf(entry.mode) ? "M" : "T";
            changed.add(entry.path);
          }
        }
        let y: StatusCode = " ";
        let worktreeMode: number | undefined = entry.mode;
        let commitChanged = false;
        let dirt: SubmoduleDirt = {};
        if (worktree && (entry.skipWorktree || entry.assumeValid)) {
          // git's refresh takes these as up to date (CE_SKIP_WORKTREE, CE_VALID)
          if (isIgnoreFilePath(entry.path)) upToDate.add(entry.path);
        } else if (
          current !== undefined &&
          isCleanByStat(entry, current, trust as WorktreeModeTrust, indexTime)
        ) {
          // clean by its stat: nothing to report, nothing to refresh
          if (isIgnoreFilePath(entry.path)) upToDate.add(entry.path);
        } else if (worktree) {
          const flags = isGitlink(entry.mode) ? await this.worktreeFlags(entry.path) : undefined;
          if (!flags?.all) {
            const result =
              (current !== undefined &&
                compareWithWorktreeStat(entry, current, trust as WorktreeModeTrust, indexTime)) ||
              (await compareWithWorktree(worktree, entry, { trust, indexTime }, current));
            worktreeMode = result.worktreeMode;
            // proved clean only by hashing: its fresh stat goes into the index (git's refresh);
            // changed behind a matching stat: smudged
            if (result.hashedId !== undefined || result.smudge) {
              const update = statUpdateOf(entry, result);
              if (update) refresh.push(update);
            }
            if (!result.kind && isIgnoreFilePath(entry.path)) upToDate.add(entry.path);
            if (flags && result.kind === "modified") commitChanged = true;
            // a populated submodule's own index and worktree (git's is_submodule_modified)
            if (flags && !flags.dirty && result.worktreeEntry?.isDirectory) {
              dirt = await readSubmoduleDirt(worktree, entry.path, flags.untracked);
            }
            if (result.kind === "deleted") {
              y = "D";
              missing.add(entry.path);
            } else if (result.kind || dirt.modified || dirt.untracked) {
              y = result.kind === "typechange" ? "T" : "M";
              modified.add(entry.path);
            } else if (entry.intentToAdd) {
              y = "A";
              added.add(entry.path);
            }
          }
        }
        if (x !== " " || y !== " ") {
          const staged = { mode: entry.mode, id: entry.objectId };
          const h = head === SAME ? staged : head;
          // git's v2 line of an intent-to-add entry: no index side while the file is there
          // (".A", "DA" over a path of HEAD), and the placeholder as the index side once it is
          // gone (".D" with the placeholder as the HEAD side too, "DD" with HEAD's)
          const ita = entry.intentToAdd;
          files.push({
            path: entry.path,
            index: x,
            worktree: y,
            head: ita && y === "D" ? (h ?? staged) : h,
            staged: ita && y === "A" ? undefined : staged,
            worktreeMode,
            ...(commitChanged ? { submoduleCommitChanged: true } : {}),
            ...(dirt.modified ? { submoduleModified: true } : {}),
            ...(dirt.untracked ? { submoduleUntracked: true } : {}),
            ...(ita ? { intentToAdd: true } : {}),
          });
        }
      }
      start = end;
    }

    for (const [path, stages] of unmerged) {
      conflicting.add(path);
      const [base, ours, theirs] = stages;
      conflictingStageState.set(path, getStageState(!!base, !!ours, !!theirs));
      const mask = (base ? 1 : 0) | (ours ? 2 : 0) | (theirs ? 4 : 0);
      const [x, y] = UNMERGED_CODES[mask];
      let worktreeMode: number | undefined;
      const current = worktree ? await worktree.getEntry(path) : undefined;
      if (current && !current.isDirectory && trust) {
        worktreeMode = modeFromWorktree(current.mode, (ours ?? theirs ?? base)?.mode, trust);
      }
      files.push({ path, index: x, worktree: y, worktreeMode, stages: [base, ours, theirs] });
    }

    for (const [path, h] of head) {
      if (tracked.has(path) || !this.matchesTracked(path, h.mode)) continue;
      if (isGitlink(h.mode) && (await this.indexIgnoresAll(path))) continue;
      removed.add(path);
      files.push({ path, index: "D", worktree: " ", head: h });
    }

    const renamed = new Map<string, string>();
    const warnings: string[] = [];
    if (this.detectsRenames()) await this.pairRenames(files, renamed, worktree, warnings);

    // the index's untracked cache, as core.untrackedCache has it (git's tweak_untracked_cache)
    const host = worktree ? await worktree.untrackedScanHost?.() : undefined;
    const untrackedCache = openUntrackedCache(
      this.staging,
      this.config,
      hostEnvironmentOf(this.workingCopy),
      host,
    );
    if (worktree && this.resolvedUntracked !== "no") {
      // git's wt_status_collect_untracked: the dir flags of the modes
      let flags =
        this.resolvedUntracked === "all"
          ? 0
          : DIR_SHOW_OTHER_DIRECTORIES | DIR_HIDE_EMPTY_DIRECTORIES;
      if (this.ignoredMode !== "no") {
        flags |= DIR_SHOW_IGNORED_TOO;
        if (this.ignoredMode === "matching") flags |= DIR_SHOW_IGNORED_TOO_MODE_MATCHING;
      }
      // read_directory, through the untracked cache for a whole-tree scan without ignored
      // files (validate_untracked_cache)
      const cache =
        host && matchAll && this.ignoredMode === "no"
          ? await untrackedCache.forScan(flags)
          : undefined;
      const ignoreFiles = this.indexIgnoreOids(all, upToDate);
      const result = await scanUntracked(host ?? (await walkUntrackedScanHost(worktree)), {
        isTracked: (p) => tracked.has(p),
        trackedIn: (dir) => index.trackedIn(dir),
        indexDirectory: (dir) =>
          gitlinks.has(dir) ? "gitlink" : index.hasEntriesBelow(dir) ? "directory" : undefined,
        indexIgnoreOid: (p) => ignoreFiles.upToDate.get(p),
        skipWorktreeIgnoreOid: (p) => ignoreFiles.skipWorktree.get(p),
        flags,
        ...(matchAll ? {} : { matcher: untrackedScanPathspec(this.pathspec) }),
        ...(cache ? { cache } : {}),
        indexSeconds: Math.floor(indexTime / 1000),
        ...(trust ? { stat: { ctime: trust.ctime, fullStat: trust.fullStat } } : {}),
        // git's "could not open directory" for each directory its scan cannot list
        onUnreadable: (path, error) => warnings.push(unreadableDirectoryWarning(path, error)),
      });
      for (const path of result.paths) {
        untracked.add(path);
        files.push({ path, index: "?", worktree: "?" });
      }
      for (const path of result.ignored) {
        ignored.add(path);
        files.push({ path, index: "!", worktree: "!" });
      }
    }

    // as git status: the refreshed stats written back when the index is free and unchanged,
    // with the untracked cache when it changed
    if (this.writeIndex) {
      await refreshIndexStats(
        this.staging,
        refresh,
        untrackedCache.changed() ? { untrackedCache: untrackedCache.cache ?? null } : undefined,
      );
    }

    return new StatusImpl(added, changed, removed, conflicting, {
      modified,
      missing,
      untracked,
      ignored,
      conflictingStageState,
      files,
      renamed,
      warnings,
    });
  }

  /**
   * The ids the untracked cache takes from the index for `.gitignore` files (git's
   * `add_patterns`): `upToDate`, the stage-0 entry's where the file is up to date with it
   * (assume-unchanged and skip-worktree count as up to date); `skipWorktree`, the stage-0
   * entry's where it is skip-worktree, for a file missing from the worktree (read from the
   * index then; an assume-unchanged one missing records the null id).
   */
  private indexIgnoreOids(
    entries: readonly StagingEntry[],
    upToDate: ReadonlySet<string>,
  ): { upToDate: Map<string, string>; skipWorktree: Map<string, string> } {
    const out = { upToDate: new Map<string, string>(), skipWorktree: new Map<string, string>() };
    if (upToDate.size === 0) return out;
    for (const entry of entries) {
      if (entry.stage !== 0 || !upToDate.has(entry.path)) continue;
      out.upToDate.set(entry.path, entry.objectId);
      if (entry.skipWorktree) out.skipWorktree.set(entry.path, entry.objectId);
    }
    return out;
  }

  /** Whether renames are detected: the setter, else `status.renames`, else `diff.renames`. */
  private detectsRenames(): boolean {
    if (this.renames !== undefined) return this.renames;
    return (
      renamesValue(this.config.value("status.renames")) ??
      renamesValue(this.config.value("diff.renames")) ??
      true
    );
  }

  /**
   * Pairs renames as git status does: on the index side (`diff-index --cached`) a path
   * removed from the index with one added to it; on the worktree side (`diff-files`) a
   * path deleted from the worktree with an intent-to-add file. The source's line goes (or
   * keeps only its other side); the destination's line becomes the rename. Unmerged paths
   * take part on the worktree side only, as diff-files queues them: a file there is a
   * destination, stage #2 of one gone a source; their own lines stay as they are.
   */
  private async pairRenames(
    files: StatusFileEntry[],
    renamed: Map<string, string>,
    worktree: Worktree | undefined,
    warnings: string[],
  ): Promise<void> {
    const limit =
      this.renameLimit ??
      intValue(this.config.value("status.renameLimit")) ??
      intValue(this.config.value("diff.renameLimit")) ??
      DEFAULT_RENAME_LIMIT;
    const byPath = new Map(files.map((f) => [f.path, f]));
    const blob = async (id: ObjectId) => concat((await this.blobs.load(id)) ?? []);
    const blobSize = async (id: ObjectId) => {
      try {
        return await this.blobs.size(id);
      } catch {
        return undefined;
      }
    };
    // git's diff warning when inexact renames were skipped (git status itself prints none)
    let needed = 0;
    const onRenameLimit = (n: number) => {
      needed = Math.max(needed, n);
    };
    const drop = new Set<StatusFileEntry>();

    // index side: HEAD's deletions against the index's additions
    const indexSources: RenameCandidate[] = [];
    const indexDestinations: RenameCandidate[] = [];
    for (const f of files) {
      if (f.stages) continue;
      if (f.index === "D" && f.head) indexSources.push({ path: f.path, ...side(f.head) });
      else if (f.index === "A" && f.staged) {
        indexDestinations.push({ path: f.path, ...side(f.staged) });
      }
    }
    if (indexSources.length > 0 && indexDestinations.length > 0) {
      const pairs = await detectRenames(indexSources, indexDestinations, {
        renameLimit: limit,
        onRenameLimit,
        size: (c) => blobSize(c.id),
        load: (c) => blob(c.id),
      });
      for (const pair of pairs) {
        const from = byPath.get(pair.from);
        const to = byPath.get(pair.to);
        if (!from || !to) continue;
        to.index = "R";
        to.head = from.head;
        // an intent-to-add source keeps its worktree side, without a HEAD side ("DA" to " A")
        if (from.intentToAdd && from.worktree !== " ") {
          from.index = " ";
          from.head = from.worktree === "D" ? from.staged : undefined;
        } else drop.add(from);
        to.renamedFrom = pair.from;
        to.renameScore = scorePercent(pair.score);
        renamed.set(pair.to, pair.from);
      }
    }

    // worktree side: deletions from the worktree against intent-to-add files; an unmerged
    // path takes part as git's diff-files queues it: its file, when there, is a destination
    // (diff_unmerge with the worktree mode), and its stage #2 a deletion (a source) when the
    // file is gone
    if (worktree) {
      const sources: RenameCandidate[] = [];
      const sourceSides = new Map<string, { mode: number; id: ObjectId }>();
      const destinations: Array<[RenameCandidate, StatusFileEntry]> = [];
      for (const f of files) {
        if (drop.has(f)) continue;
        if (f.stages) {
          const ours = f.stages[1];
          if (f.worktreeMode !== undefined) {
            destinations.push([{ path: f.path, mode: f.worktreeMode, id: "" }, f]);
          } else if (ours && !isGitlink(ours.mode)) {
            // no file (or a directory, which git's check_removed takes as gone)
            sources.push({ path: f.path, ...side(ours) });
            sourceSides.set(f.path, side(ours));
          }
          continue;
        }
        if (f.worktree === "D" && f.staged) {
          sources.push({ path: f.path, ...side(f.staged) });
          sourceSides.set(f.path, side(f.staged));
        } else if (f.worktree === "A" && f.worktreeMode !== undefined) {
          destinations.push([{ path: f.path, mode: f.worktreeMode, id: "" }, f]);
        }
      }
      if (sources.length > 0 && destinations.length > 0) {
        for (const [candidate] of destinations) {
          candidate.id = await worktree.computeHash(candidate.path);
        }
        // the worktree side as git's diff reads it: cleaned (convert_to_git) where a
        // conversion applies, read once for both its size and its content
        const cleaned = new Map<string, Promise<Uint8Array | undefined>>();
        const cleanedOf = (c: RenameCandidate) => {
          if (c.mode === 0o120000) return Promise.resolve(undefined);
          let found = cleaned.get(c.path);
          if (!found) {
            found = readConvertedContent(worktree, c.path);
            cleaned.set(c.path, found);
          }
          return found;
        };
        const pairs = await detectRenames(
          sources,
          destinations.map(([c]) => c),
          {
            renameLimit: limit,
            onRenameLimit,
            size: async (c, role) =>
              role === "source"
                ? blobSize(c.id)
                : ((await cleanedOf(c))?.length ?? (await worktree.getEntry(c.path))?.size),
            load: async (c, role) => {
              if (role === "source") return blob(c.id);
              const converted = await cleanedOf(c);
              cleaned.delete(c.path);
              return converted ?? concat(worktree.readContent(c.path));
            },
          },
        );
        for (const pair of pairs) {
          const from = byPath.get(pair.from);
          const to = byPath.get(pair.to);
          const source = sourceSides.get(pair.from);
          if (!from || !source || !to) continue;
          // the source keeps only its index side, if it has one; an unmerged source keeps
          // its line (its stage #2 deletion goes)
          if (from.stages) {
            // nothing shown changes
          } else if (from.index === " ") drop.add(from);
          else {
            from.worktree = " ";
            from.worktreeMode = source.mode;
          }
          // an unmerged destination stays as it is (wt_status shows its stages, no rename)
          if (to.stages) continue;
          to.worktree = "R";
          to.head = source;
          to.staged = source;
          to.renamedFrom = pair.from;
          to.renameScore = scorePercent(pair.score);
          renamed.set(pair.to, pair.from);
        }
      }
    }

    if (drop.size > 0) {
      const kept = files.filter((f) => !drop.has(f));
      files.splice(0, files.length, ...kept);
    }
    if (needed > 0) {
      warnings.push(
        "warning: exhaustive rename detection was skipped due to too many files.",
        `warning: you may want to set your status.renameLimit variable to at least ${needed} and retry the command.`,
      );
    }
  }

  /** The submodules `.gitmodules` names: the worktree's file, else the index's. */
  private submodules(): Promise<GitmodulesEntry[]> {
    this.gitmodules ??= (async () => {
      const worktree = this.worktreeAccess;
      let bytes: Uint8Array | undefined;
      try {
        const entry = worktree ? await worktree.getEntry(".gitmodules") : undefined;
        if (worktree && entry && !entry.isDirectory && entry.mode !== FileMode.SYMLINK) {
          bytes = await concat(worktree.readContent(".gitmodules"));
        }
      } catch {
        bytes = undefined;
      }
      if (!bytes) {
        const staged = await this.staging.getEntry(".gitmodules");
        if (staged && staged.mode !== FileMode.SYMLINK) {
          bytes = await concat((await this.blobs.load(staged.objectId)) ?? []);
        }
      }
      return bytes ? parseGitmodules(new TextDecoder().decode(bytes)) : [];
    })();
    return this.gitmodules;
  }

  /**
   * `submodule.<name>.ignore` for the submodule at `path`: the repository's config, else
   * `.gitmodules`; undefined when neither names a valid value (or no submodule is there).
   */
  private async submoduleIgnore(path: string): Promise<SubmoduleIgnoreMode | undefined> {
    const submodule = (await this.submodules()).find((s) => s.path === path);
    if (!submodule) return undefined;
    const configured = this.config.value(`submodule.${submodule.name}.ignore`)?.trim();
    if (configured !== undefined) return isSubmoduleIgnoreMode(configured) ? configured : undefined;
    const declared = submodule.ignore?.trim();
    return isSubmoduleIgnoreMode(declared) ? declared : undefined;
  }

  /**
   * What the worktree side ignores of the submodule at `path`, as git's status sets its
   * diff flags: `--ignore-submodules` overrides everything; else `submodule.<name>.ignore`
   * replaces `diff.ignoreSubmodules` (and `--untracked-files=no`) when set.
   */
  private async worktreeFlags(path: string): Promise<SubmoduleIgnoreFlags> {
    if (this.ignoreSubmodules) return submoduleIgnoreFlags(this.ignoreSubmodules);
    const own = await this.submoduleIgnore(path);
    if (own) return submoduleIgnoreFlags(own);
    const configured = this.config.value("diff.ignoreSubmodules")?.trim();
    const flags = submoduleIgnoreFlags(isSubmoduleIgnoreMode(configured) ? configured : "none");
    if (this.resolvedUntracked === "no") flags.untracked = true;
    return flags;
  }

  /**
   * Whether the index side hides submodules: only `--ignore-submodules=all` does (git
   * compares HEAD and index with `dirty` otherwise, whatever `diff.ignoreSubmodules` or
   * `submodule.<name>.ignore` say, so a staged submodule is always shown).
   */
  private async indexIgnoresAll(_path: string): Promise<boolean> {
    return this.ignoreSubmodules === "all";
  }

  /**
   * Whether the tracked path (an index or HEAD entry of `mode`) matches the path filters,
   * as git's `ce_path_match` / `tree_entry_interesting` match a literal pathspec: the path
   * itself or a directory above it. An element ending in `/` names a directory only, so
   * `f.txt/` does not match the file `f.txt` (a gitlink counts as a directory), and an
   * element below a file (`a/b`) does not match the file `a`.
   */
  private matchesTracked(path: string, mode: number): boolean {
    if (this.pathspec.length === 0) return true;
    // ce_path_match: a gitlink matches as a directory (`sub/` names it)
    return matchPathspec(this.pathspec, path, isGitlink(mode) ? DO_MATCH_DIRECTORY : 0) > 0;
  }

  /**
   * Collect all blob entries from a tree recursively.
   */
  /**
   * HEAD's blobs below `prefix`. A directory whose cache-tree node is valid and names the
   * same tree holds exactly the index's entries: it is not read, only noted in `same` (git's
   * unpack-trees skips such a directory too, `cache_tree_matches_traversal`).
   */
  private async collectTreeEntries(
    treeId: ObjectId,
    prefix: string,
    entries: Map<string, StatusSide>,
    node?: CacheTree,
    same?: Set<string>,
  ): Promise<void> {
    if (node && same && node.entryCount >= 0 && node.id === treeId) {
      same.add(prefix);
      return;
    }
    const subtrees =
      node && node.subtrees.length > 0
        ? new Map(node.subtrees.map((s) => [s.name, s.tree] as const))
        : undefined;
    for await (const entry of this.trees.loadTree(treeId)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.mode === FileMode.TREE) {
        await this.collectTreeEntries(entry.id, path, entries, subtrees?.get(entry.name), same);
      } else {
        entries.set(path, { mode: entry.mode, id: entry.id });
      }
    }
  }
}

/** A side's mode and id, as a rename candidate takes them. */
function side(s: StatusSide): { mode: number; id: ObjectId } {
  return { mode: s.mode, id: s.id };
}

/** The index entries of a staging without `entryList`, in order. */
async function collectEntries(entries: AsyncIterable<StagingEntry>): Promise<StagingEntry[]> {
  const out: StagingEntry[] = [];
  for await (const entry of entries) out.push(entry);
  return out;
}

/** The options of `StatusCommand.callText`. */
export interface StatusCallTextOptions {
  /** `--long`, `--short`, `--porcelain[=v1]`, `--porcelain=v2`; unset: `status.short`, else long */
  format?: "long" | "short" | "porcelain" | "porcelain-v2";
  /** `-b` / `--branch` (unset: `status.branch` for the human formats) */
  branch?: boolean;
  /** `-z` (porcelain unless another format is given; `--long` refuses it) */
  z?: boolean;
  /** `--show-stash` (unset: `status.showStash`) */
  showStash?: boolean;
  /** `--[no-]ahead-behind` (unset: `status.aheadBehind` for the human formats, else full) */
  aheadBehind?: boolean;
  /** `-v` (1) / `-vv` (2): the staged (and unstaged) changes as a patch, long format only */
  verbose?: number;
  /** `advice.statusHints` override (the commit template has none) */
  hints?: boolean;
  /** Comment every line with this string (the commit template); unset: `status.displayCommentPrefix` */
  commentPrefix?: string;
  /** The commit template: "Initial commit", no divergence advice */
  commitTemplate?: boolean;
  /** `git commit --amend` */
  amend?: boolean;
  /** `s->nowarn`: no closing line when nothing is committable (the commit template) */
  nowarn?: boolean;
  /** Where the commit comes from (the "to unstage" hints only show for a plain commit) */
  whence?: CommitWhence;
  /** The text goes to a file (the commit template): `-v` puts the cut line before its patch */
  toFile?: boolean;
  /** The cut line was written already (`s->added_cut_line`) */
  cutLineAdded?: boolean;
}

/** What `StatusCommand.callText` gives: the text, the status, and git's warnings. */
export interface StatusTextResult extends StatusText {
  status: Status;
  warnings: string[];
}

/** A git boolean of the configuration, `fallback` when unset or not a boolean. */
function cfgBool(config: RemoteConfigStore, key: string, fallback: boolean): boolean {
  const value = config.value(key);
  return value === undefined ? fallback : (parseGitBool(value) ?? fallback);
}

/** git's empty tree, the side compared with before the first commit. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** The comment-line string of status's commented lines. */
function commentLineString(workingCopy: WorkingCopy): string {
  return commentPrefixOf(workingCopy);
}

/**
 * wt_status_append_cut_line: the scissors line and its explanation, commented.
 *
 * @example
 * ```typescript
 * cutLine("#"); // "# ------------------------ >8 ------------------------\n# Do not modify ..."
 * ```
 */
export function cutLine(comment: string): string {
  return (
    `${comment} ------------------------ >8 ------------------------\n` +
    `${comment} Do not modify or remove the line above.\n` +
    `${comment} Everything below it will be ignored.\n`
  );
}

/**
 * `rev-list --left-right --count ours...theirs` (git's `stat_branch_pair`): the commits only
 * each side reaches, walked no further than the merge bases (the store's commit-graph
 * ordering the walk where it has one).
 */
async function aheadBehind(
  commits: Pick<Commits, "load" | "countAheadBehind">,
  ours: ObjectId,
  theirs: ObjectId,
): Promise<{ ahead: number; behind: number }> {
  if (commits.countAheadBehind) return commits.countAheadBehind(ours, theirs);
  return countAheadBehind(
    async (id) => {
      const c = await commits.load(id).catch(() => undefined);
      return c
        ? { parents: c.parents, date: c.committer.timestamp, generation: Number.POSITIVE_INFINITY }
        : undefined;
    },
    ours,
    theirs,
  );
}
