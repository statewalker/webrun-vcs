import type { ObjectId } from "@statewalker/vcs-core";
import { compareGitPaths } from "@statewalker/vcs-utils/encoding";
import type { StageStateValue } from "@statewalker/vcs-working-tree";
import { quoteCStyleBody } from "./quote-path.js";

/**
 * One column of `git status --porcelain`: `X` (the index against HEAD) or `Y` (the
 * worktree against the index). `" "` unchanged, `M` modified, `T` type changed, `A` added,
 * `D` deleted, `R` renamed, `U` unmerged, `?` untracked, `!` ignored.
 */
export type StatusCode = " " | "M" | "T" | "A" | "D" | "R" | "U" | "?" | "!";

/** A side of a path: its mode and object id. */
export interface StatusSide {
  mode: number;
  id: ObjectId;
}

/**
 * The status of one path, as a line of `git status --porcelain` describes it.
 *
 * @example
 * ```typescript
 * const entry = status.files.find((f) => f.path === "a.txt");
 * // { path: "a.txt", index: "M", worktree: " ", head: {...}, staged: {...} }
 * ```
 */
export interface StatusFileEntry {
  path: string;
  /** `X`: the index against HEAD (`U` for an unmerged path, `?`/`!` for untracked/ignored) */
  index: StatusCode;
  /** `Y`: the worktree against the index */
  worktree: StatusCode;
  /** The HEAD entry, if HEAD has the path */
  head?: StatusSide;
  /** The index entry (stage 0), if the index has the path */
  staged?: StatusSide;
  /** The mode git would stage for the worktree file, if there is one */
  worktreeMode?: number;
  /** A submodule whose checked-out commit differs from the index's (porcelain v2 `SC..`) */
  submoduleCommitChanged?: boolean;
  /** A submodule with tracked changes inside it (porcelain v2 `S.M.`) */
  submoduleModified?: boolean;
  /** A submodule with untracked files inside it (porcelain v2 `S..U`) */
  submoduleUntracked?: boolean;
  /**
   * A renamed path's old path (`R  old -> new`): `index` `R` for a rename in the index
   * (`head` is then the old path's HEAD entry), `worktree` `R` for a worktree file renamed
   * to an intent-to-add path (`head` and `staged` are the old path's index entry)
   */
  renamedFrom?: string;
  /** The rename's similarity, in percent (git's `R<score>`) */
  renameScore?: number;
  /** An intent-to-add entry (`git add -N`) */
  intentToAdd?: boolean;
  /** An unmerged path's stages 1-3 (base, ours, theirs) */
  stages?: [StatusSide | undefined, StatusSide | undefined, StatusSide | undefined];
}

/**
 * Status of the repository: the index against HEAD, and the worktree against the index, as
 * `git status` reports them.
 *
 * Based on JGit's Status.
 */
export interface Status {
  /** Files added to the index (not in HEAD). */
  readonly added: Set<string>;
  /** Files changed in the index (content, mode or type differs from HEAD). */
  readonly changed: Set<string>;
  /** Files removed from the index (in HEAD, not in the index). */
  readonly removed: Set<string>;
  /**
   * Renamed paths, new path to old path: in the index (a removed path paired with an added
   * one, `R `) or in the worktree (a deleted file paired with an intent-to-add one, ` R`).
   * Both paths stay in `added`/`removed` (or `missing`) too.
   */
  readonly renamed: Map<string, string>;
  /**
   * git's warnings about this status, as git's diff prints them: when inexact rename
   * detection was skipped for too many candidates ("exhaustive rename detection was skipped
   * due to too many files.", with the rename limit that would be needed; `git status`
   * itself prints none of these), then those of the untracked-file scan, which `git status`
   * prints: "warning: could not open directory 'u/': Permission denied" for each directory it
   * could not list.
   */
  readonly warnings: string[];
  /** Files with merge conflicts (unmerged index entries). */
  readonly conflicting: Set<string>;
  /** The kind of each conflict (both modified, deleted by them, ...). */
  readonly conflictingStageState: Map<string, StageStateValue>;
  /** Tracked files whose worktree content, mode or type differs from the index. */
  readonly modified: Set<string>;
  /** Tracked files missing from the worktree. */
  readonly missing: Set<string>;
  /** Files the index does not track (a nested repository as `sub/`). */
  readonly untracked: Set<string>;
  /** Untracked files the ignore rules exclude (only with `setIgnored(true)`). */
  readonly ignored: Set<string>;
  /**
   * Every path with a status, as the lines of `git status --porcelain`: a path HEAD has,
   * the index removed and the worktree still holds appears twice (`D ` and `??`).
   */
  readonly files: StatusFileEntry[];

  /**
   * Whether there is nothing to report: no staged or unstaged change, no conflict and no
   * untracked file (`git status`: "nothing to commit, working tree clean").
   */
  isClean(): boolean;

  /**
   * Whether there are uncommitted changes to tracked files: staged, unstaged or conflicting
   * (untracked files are not changes).
   */
  hasUncommittedChanges(): boolean;
}

/**
 * Implementation of the Status interface.
 */
export class StatusImpl implements Status {
  readonly modified: Set<string>;
  readonly missing: Set<string>;
  readonly untracked: Set<string>;
  readonly ignored: Set<string>;
  readonly conflictingStageState: Map<string, StageStateValue>;
  readonly files: StatusFileEntry[];
  readonly renamed: Map<string, string>;
  readonly warnings: string[];

  constructor(
    public readonly added: Set<string>,
    public readonly changed: Set<string>,
    public readonly removed: Set<string>,
    public readonly conflicting: Set<string>,
    worktree: {
      modified?: Set<string>;
      missing?: Set<string>;
      untracked?: Set<string>;
      ignored?: Set<string>;
      conflictingStageState?: Map<string, StageStateValue>;
      files?: StatusFileEntry[];
      renamed?: Map<string, string>;
      warnings?: string[];
    } = {},
  ) {
    this.modified = worktree.modified ?? new Set();
    this.missing = worktree.missing ?? new Set();
    this.untracked = worktree.untracked ?? new Set();
    this.ignored = worktree.ignored ?? new Set();
    this.conflictingStageState = worktree.conflictingStageState ?? new Map();
    this.files = worktree.files ?? [];
    this.renamed = worktree.renamed ?? new Map();
    this.warnings = worktree.warnings ?? [];
  }

  isClean(): boolean {
    return !this.hasUncommittedChanges() && this.untracked.size === 0;
  }

  hasUncommittedChanges(): boolean {
    return (
      this.added.size > 0 ||
      this.changed.size > 0 ||
      this.removed.size > 0 ||
      this.conflicting.size > 0 ||
      this.modified.size > 0 ||
      this.missing.size > 0
    );
  }
}

/** git's byte order of paths (their bytes, as `strcmp`). */
function comparePaths(a: string, b: string): number {
  return compareGitPaths(a, b);
}

const ZERO_ID = "0".repeat(40);

/**
 * The submodule field of a porcelain v2 line: `N...` for a path that is no submodule, else
 * `S` and whether its commit changed (`C`), it has tracked changes (`M`) and untracked files
 * (`U`) inside, as `SC.U`.
 */
export function submoduleToken(e: StatusFileEntry): string {
  const gitlink = 0o160000;
  const isSubmodule =
    e.staged?.mode === gitlink || e.head?.mode === gitlink || e.worktreeMode === gitlink;
  if (!isSubmodule) return "N...";
  return `S${e.submoduleCommitChanged ? "C" : "."}${e.submoduleModified ? "M" : "."}${
    e.submoduleUntracked ? "U" : "."
  }`;
}
const octal = (mode: number | undefined) => (mode ?? 0).toString(8).padStart(6, "0");

/**
 * git's quoting of a path in status output (`quote_path`): C-quoted when it needs it, bytes
 * above 0x7f escaped only with `core.quotePath` (on by default); porcelain v1 puts a path
 * with a space in quotes too (`QUOTE_PATH_QUOTE_SP`), v2 does not.
 */
function quoteStatusPath(path: string, quoteSpace: boolean, quotePathFully: boolean): string {
  const body = quoteCStyleBody(path, quotePathFully);
  if (body !== undefined) return `"${body}"`;
  return quoteSpace && path.includes(" ") ? `"${path}"` : path;
}

/** Options of {@link formatStatusPorcelain}. */
export interface StatusPorcelainOptions {
  /**
   * `core.quotePath` (default true). Off, bytes above 0x7f are printed as they are: a path
   * that is no UTF-8 keeps its escaped bytes (`decodeGitPath`), so `encodeGitPath` of the
   * text gives git's output bytes.
   */
  quotePath?: boolean;
}

/**
 * The status as `git status --porcelain` (v1) or `--porcelain=v2` prints it, with
 * `--untracked-files=all` (and the ignored files when the status has them): the changed
 * tracked paths first, then the untracked, then the ignored ones, each in git's path order.
 * A rename is one line at its new path: `R  old -> new` (v1), `2 R. ... R<score> new<TAB>old`
 * (v2).
 *
 * @example
 * ```typescript
 * formatStatusPorcelain(await git.status().call());
 * // " M a.txt\nA  b.txt\n?? new.txt\n"
 * ```
 */
export function formatStatusPorcelain(
  status: Status,
  version: 1 | 2 = 1,
  options: StatusPorcelainOptions = {},
): string {
  const fully = options.quotePath ?? true;
  const quotePath = (path: string) => quoteStatusPath(path, version === 1, fully);
  const entries = status.files;
  // v2 prints the changed entries, then the unmerged ones (wt_porcelain_v2_print's two
  // passes); v1 prints them in one list by path
  const tracked = entries
    .filter((e) => e.index !== "?" && e.index !== "!")
    .sort(
      (a, b) =>
        (version === 2 ? (a.stages ? 1 : 0) - (b.stages ? 1 : 0) : 0) ||
        comparePaths(a.path, b.path),
    );
  const untracked = entries
    .filter((e) => e.index === "?")
    .sort((a, b) => comparePaths(a.path, b.path));
  const ignored = entries
    .filter((e) => e.index === "!")
    .sort((a, b) => comparePaths(a.path, b.path));
  const lines: string[] = [];
  for (const e of tracked) {
    const path = quotePath(e.path);
    const from = e.renamedFrom !== undefined ? quotePath(e.renamedFrom) : undefined;
    if (version === 1) {
      lines.push(`${e.index}${e.worktree} ${from !== undefined ? `${from} -> ` : ""}${path}`);
      continue;
    }
    const xy = `${e.index === " " ? "." : e.index}${e.worktree === " " ? "." : e.worktree}`;
    const sub = submoduleToken(e);
    if (from !== undefined) {
      lines.push(
        [
          "2",
          xy,
          sub,
          octal(e.head?.mode),
          octal(e.staged?.mode),
          octal(e.worktreeMode),
          e.head?.id ?? ZERO_ID,
          e.staged?.id ?? ZERO_ID,
          `R${e.renameScore ?? 100}`,
          `${path}\t${from}`,
        ].join(" "),
      );
      continue;
    }
    if (e.stages) {
      const [s1, s2, s3] = e.stages;
      lines.push(
        [
          "u",
          xy,
          sub,
          octal(s1?.mode),
          octal(s2?.mode),
          octal(s3?.mode),
          octal(e.worktreeMode),
          s1?.id ?? ZERO_ID,
          s2?.id ?? ZERO_ID,
          s3?.id ?? ZERO_ID,
          path,
        ].join(" "),
      );
      continue;
    }
    lines.push(
      [
        "1",
        xy,
        sub,
        octal(e.head?.mode),
        octal(e.staged?.mode),
        octal(e.worktreeMode),
        e.head?.id ?? ZERO_ID,
        e.staged?.id ?? ZERO_ID,
        path,
      ].join(" "),
    );
  }
  const mark = version === 1 ? ["??", "!!"] : ["?", "!"];
  for (const e of untracked) lines.push(`${mark[0]} ${quotePath(e.path)}`);
  for (const e of ignored) lines.push(`${mark[1]} ${quotePath(e.path)}`);
  return lines.map((l) => `${l}\n`).join("");
}
