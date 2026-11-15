import type { ObjectId } from "@statewalker/vcs-core";
import type { StageStateValue } from "@statewalker/vcs-working-tree";

/**
 * One column of `git status --porcelain`: `X` (the index against HEAD) or `Y` (the
 * worktree against the index). `" "` unchanged, `M` modified, `T` type changed, `A` added,
 * `D` deleted, `U` unmerged, `?` untracked, `!` ignored.
 */
export type StatusCode = " " | "M" | "T" | "A" | "D" | "U" | "?" | "!";

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
    } = {},
  ) {
    this.modified = worktree.modified ?? new Set();
    this.missing = worktree.missing ?? new Set();
    this.untracked = worktree.untracked ?? new Set();
    this.ignored = worktree.ignored ?? new Set();
    this.conflictingStageState = worktree.conflictingStageState ?? new Map();
    this.files = worktree.files ?? [];
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

/** git's byte order of paths (UTF-8 code units, as `strcmp`). */
function comparePaths(a: string, b: string): number {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  const n = Math.min(ea.length, eb.length);
  for (let i = 0; i < n; i++) if (ea[i] !== eb[i]) return ea[i] - eb[i];
  return ea.length - eb.length;
}

const ZERO_ID = "0".repeat(40);
const octal = (mode: number | undefined) => (mode ?? 0).toString(8).padStart(6, "0");

/** git's quoting of a path in status output (`core.quotePath`, on by default). */
function quotePath(path: string): string {
  const bytes = new TextEncoder().encode(path);
  let needs = false;
  let out = "";
  for (const b of bytes) {
    if (b === 0x22 || b === 0x5c) {
      needs = true;
      out += `\\${String.fromCharCode(b)}`;
    } else if (b === 0x09) {
      needs = true;
      out += "\\t";
    } else if (b === 0x0a) {
      needs = true;
      out += "\\n";
    } else if (b < 0x20 || b >= 0x7f) {
      needs = true;
      out += `\\${b.toString(8).padStart(3, "0")}`;
    } else out += String.fromCharCode(b);
  }
  return needs ? `"${out}"` : path;
}

/**
 * The status as `git status --porcelain` (v1) or `--porcelain=v2` prints it, with
 * `--untracked-files=all` (and the ignored files when the status has them): the changed
 * tracked paths first, then the untracked, then the ignored ones, each in git's path order.
 * Renames are not detected (as `-c status.renames=false`).
 *
 * @example
 * ```typescript
 * formatStatusPorcelain(await git.status().call());
 * // " M a.txt\nA  b.txt\n?? new.txt\n"
 * ```
 */
export function formatStatusPorcelain(status: Status, version: 1 | 2 = 1): string {
  const entries = status.files;
  const tracked = entries
    .filter((e) => e.index !== "?" && e.index !== "!")
    .sort((a, b) => comparePaths(a.path, b.path));
  const untracked = entries
    .filter((e) => e.index === "?")
    .sort((a, b) => comparePaths(a.path, b.path));
  const ignored = entries
    .filter((e) => e.index === "!")
    .sort((a, b) => comparePaths(a.path, b.path));
  const lines: string[] = [];
  for (const e of tracked) {
    const path = quotePath(e.path);
    if (version === 1) {
      lines.push(`${e.index}${e.worktree} ${path}`);
      continue;
    }
    const xy = `${e.index === " " ? "." : e.index}${e.worktree === " " ? "." : e.worktree}`;
    const sub = e.staged?.mode === 0o160000 || e.head?.mode === 0o160000 ? "S..." : "N...";
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
