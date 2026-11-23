/**
 * Worktree path verification, after git's `verify_path` (CVE-2014-9390, CVE-2019-1354), with
 * `core.protectHFS` and `core.protectNTFS` on unless the caller turns them off
 * ({@link WorktreePathOptions}; git's defaults: NTFS on, HFS on macOS only, here also where
 * the system is unknown: {@link protectHFSDefault}).
 *
 * Paths in trees and in the index come from other people's repositories. Checkout turns them
 * into files under the worktree, which also holds the repository's own `.git`. A path is
 * refused when a component is empty, `.` or `..`, or names `.git` in any letter case (always),
 * or names `.git` under a spelling NTFS or HFS+ folds to it (as the protections say):
 * - any letter case (`.GIT`, `.Git`: case-insensitive filesystems);
 * - NTFS: trailing dots and spaces dropped (`.git. .`), the 8.3 short name `git~1`, an
 *   alternate data stream (`.git::$INDEX_ALLOCATION`), and `\` ending the name (`.git\x`);
 * - HFS+: code points it ignores when comparing names (`‌.git`).
 *
 * With `{ windows: true }` — for a worktree on Windows, where `\` is a separator — git's
 * Windows rules apply too (CVE-2019-1354, `is_valid_win32_path`): a `\` anywhere, a drive
 * prefix (`C:`), control characters and `<>:"|?*`, a component ending in a space or a dot,
 * and the reserved device names (`CON`, `NUL`, `COM1`, `LPT1`, `CONIN$`..., with or without
 * an extension). Elsewhere `a\b.txt` is an ordinary file name, as in git.
 *
 * Given the entry's mode, a symbolic link named `.gitmodules` (under the same foldings, plus
 * the NTFS short names `gitmod~1` and `gi7eba~1`) is refused too, as git's `verify_path`
 * refuses it (CVE-2018-11235): git reads that file from the worktree and must not be led
 * elsewhere.
 */

import { foldAsciiCase } from "@statewalker/vcs-utils/encoding";

/** Code points HFS+ ignores when comparing names (git's `next_hfs_char`). */
const HFS_IGNORABLE = /[‌-‏‪-‮⁪-⁯﻿]/g;

/** A component NTFS resolves to `.git`: `.git` or `git~1`, then only dots and spaces, or a stream. */
const NTFS_DOTGIT = /^(?:\.git|git~1)[. ]*(?::.*)?$/i;

/** The mode of a symbolic link in a tree or the index. */
const SYMLINK_MODE = 0o120000;

/** The files git reads from the worktree, with the prefix of their NTFS fallback short name. */
const GIT_FILES = {
  gitmodules: "gi7eba",
  gitattributes: "gi7d29",
  gitignore: "gi250a",
  mailmap: "maba30",
} as const;

/** A file git reads from the worktree: `.gitmodules`, `.gitattributes`, `.gitignore`, `.mailmap`. */
export type GitWorktreeFile = keyof typeof GIT_FILES;

/** Only dots and spaces from `i` to the end, or up to an NTFS stream (`:`). */
function onlySpacesAndPeriods(name: string, i: number): boolean {
  for (; i < name.length; i++) {
    const c = name[i];
    if (c === ":") return true;
    if (c !== " " && c !== ".") return false;
  }
  return true;
}

/**
 * git's `is_ntfs_dot_generic`: whether NTFS resolves `name` to `.<dotName>` — the name in any
 * case with trailing dots and spaces, its 8.3 short name (6 characters, `~1` to `~4`), or the
 * fallback short name NTFS makes from a hash (`<prefix>~1` to `~9`).
 */
function isNtfsDotGeneric(name: string, dotName: string, shortPrefix: string): boolean {
  const lower = foldAsciiCase(name); // strncasecmp: ASCII letters only
  if (lower.startsWith(`.${dotName}`)) return onlySpacesAndPeriods(name, dotName.length + 1);
  if (lower.startsWith(dotName.slice(0, 6)) && name[6] === "~" && /^[1-4]$/.test(name[7] ?? "")) {
    return onlySpacesAndPeriods(name, 8);
  }
  let sawTilde = false;
  for (let i = 0; i < 8; i++) {
    const c = name[i];
    if (c === undefined) return false;
    if (sawTilde) {
      if (c < "0" || c > "9") return false;
    } else if (c === "~") {
      i++;
      const d = name[i];
      if (d === undefined || d < "1" || d > "9") return false;
      sawTilde = true;
    } else if (i >= 6) {
      return false;
    } else if (c.charCodeAt(0) & 0x80) {
      return false;
    } else if (foldAsciiCase(c) !== shortPrefix[i]) {
      return false;
    }
  }
  return onlySpacesAndPeriods(name, 8);
}

/**
 * Whether a path component names one of the files git reads from the worktree under any
 * spelling HFS+ or NTFS folds to it (git's `is_hfs_dot*` / `is_ntfs_dot*`).
 *
 * @example
 * ```typescript
 * isGitWorktreeFile("GITMOD~1", "gitmodules"); // true
 * isGitWorktreeFile("gi250a~3", "gitignore"); // true
 * ```
 */
export function isGitWorktreeFile(component: string, file: GitWorktreeFile): boolean {
  // is_hfs_dot_generic folds ASCII only (any other code point ends the match)
  if (foldAsciiCase(component.replace(HFS_IGNORABLE, "")) === `.${file}`) return true;
  return isNtfsDotGeneric(component, file, GIT_FILES[file]);
}

/**
 * Whether a path component names one of the files git reads from the worktree under a
 * spelling NTFS folds to it, ignoring HFS+ (git's `is_ntfs_dot*`, as fsck checks the parts of a
 * name after a backslash).
 *
 * @example
 * ```typescript
 * isNtfsGitWorktreeFile("GITMOD~1", "gitmodules"); // true
 * isNtfsGitWorktreeFile(".gitmodules ", "gitmodules"); // true
 * ```
 */
export function isNtfsGitWorktreeFile(component: string, file: GitWorktreeFile): boolean {
  return isNtfsDotGeneric(component, file, GIT_FILES[file]);
}

/**
 * Whether a path component names `.git` under any spelling HFS+ or NTFS folds to it (git's
 * `is_hfs_dotgit` / `is_ntfs_dotgit`, a `\\` ending an NTFS name).
 *
 * @example
 * ```typescript
 * isDotGitComponent(".GIT. "); // true
 * isDotGitComponent("git~1"); // true
 * ```
 */
export function isDotGitComponent(component: string): boolean {
  if (foldAsciiCase(component.replace(HFS_IGNORABLE, "")) === ".git") return true;
  // git's is_ntfs_dotgit ends a name at a backslash on every platform
  return component.split("\\").some((part) => NTFS_DOTGIT.test(part));
}

/** Options of {@link isValidWorktreePath}. */
export interface WorktreePathOptions {
  /** The worktree is on Windows: git's Windows path rules apply too (`\` a separator). */
  windows?: boolean;
  /**
   * `core.protectNTFS` (default true here and in git): refuse the names NTFS folds to `.git`
   * (`.git.`, `.git `, `git~1`, `.git::$INDEX_ALLOCATION`, after a `\` too) and, for a
   * symbolic link, to `.gitmodules` (`gitmod~1`, `gi7eba~1`).
   */
  protectNTFS?: boolean;
  /**
   * `core.protectHFS`: refuse the names HFS+ folds to `.git` (code points it ignores, `‌.git`)
   * and, for a symbolic link, to `.gitmodules`. Default true here; git's default is true on
   * macOS only (`protectHFSDefault`).
   */
  protectHFS?: boolean;
}

/** git's `is_hfs_dot_generic`: whether HFS+ resolves `component` to `.<name>`. */
function isHfsDot(component: string, name: string): boolean {
  return foldAsciiCase(component.replace(HFS_IGNORABLE, "")) === `.${name}`;
}

/**
 * The `core.protectHFS` default for a system: git's (`PROTECT_HFS_DEFAULT`) on for macOS
 * (`uname` `Darwin`) and off on a system known to be another, and on where the system is
 * unknown (no environment, a browser): the storage may be an HFS+ volume, and a name HFS+
 * folds into `.git` would reach the repository (CVE-2014-9390).
 *
 * @example
 * ```typescript
 * protectHFSDefault("Darwin"); // true
 * protectHFSDefault("Linux"); // false
 * protectHFSDefault(undefined); // true
 * ```
 */
export function protectHFSDefault(systemName: string | undefined): boolean {
  return systemName === undefined || systemName === "Darwin";
}

/** Device names Windows reserves in every directory (git's `is_valid_win32_path`). */
const WIN32_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9]|conin\$|conout\$)(?:\.|$)/i;

/** git's `is_valid_win32_path` (and the `\` refusal of `verify_path` on Windows). */
function isValidWin32Path(path: string): boolean {
  if (/^[a-zA-Z]:/.test(path)) return false;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are refused
  if (/[\\\x00-\x1f<>:"|?*]/.test(path)) return false;
  for (const component of path.split("/")) {
    if (/[ .]$/.test(component) && component !== "." && component !== "..") return false;
    if (WIN32_RESERVED.test(component.replace(/ +(?=\.|$)/, ""))) return false;
  }
  return true;
}

/**
 * Whether `path` (relative, `/`-separated, as stored in trees and the index) is safe to check
 * out; with `mode`, also whether an entry of that mode may sit there (no symlinked
 * `.gitmodules`). git's `verify_path`: an empty, `.` or `..` component, and `.git` in any
 * case (a symbolic link `.gitmodules` in any case) are always refused; the HFS+ and NTFS
 * spellings of those names as `protectHFS` / `protectNTFS` say (both on unless turned off).
 *
 * @example
 * ```typescript
 * isValidWorktreePath("git~1/config"); // false
 * isValidWorktreePath("git~1/config", undefined, { protectNTFS: false }); // true
 * isValidWorktreePath(".GIT/config", undefined, { protectNTFS: false }); // false
 * ```
 */
export function isValidWorktreePath(
  path: string,
  mode?: number,
  options: WorktreePathOptions = {},
): boolean {
  if (path === "" || path.includes("\0")) return false;
  if (options.windows && !isValidWin32Path(path)) return false;
  const ntfs = options.protectNTFS !== false;
  const hfs = options.protectHFS !== false;
  const link = mode === SYMLINK_MODE;
  for (const component of path.split("/")) {
    if (component === "" || component === "." || component === "..") return false;
    // verify_dotfile: `.git` (and a link `.gitmodules`) in any ASCII case, on every platform
    const folded = foldAsciiCase(component);
    if (folded === ".git" || (link && folded === ".gitmodules")) return false;
    if (hfs && (isHfsDot(component, "git") || (link && isHfsDot(component, "gitmodules")))) {
      return false;
    }
    if (ntfs) {
      // is_ntfs_dotgit runs at each component and after each `\` (a name ends at either)
      for (const part of component.split("\\")) {
        if (NTFS_DOTGIT.test(part)) return false;
        if (link && isNtfsDotGeneric(part, "gitmodules", GIT_FILES.gitmodules)) return false;
      }
    }
  }
  return true;
}

/** Throws unless {@link isValidWorktreePath} accepts `path` (and `mode`). */
export function assertValidWorktreePath(
  path: string,
  mode?: number,
  options: WorktreePathOptions = {},
): void {
  if (!isValidWorktreePath(path, mode, options)) {
    throw new Error(`Invalid worktree path: ${JSON.stringify(path)}`);
  }
}
