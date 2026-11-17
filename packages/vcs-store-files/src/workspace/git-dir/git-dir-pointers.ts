/**
 * The small files that tie a linked worktree to its repository, read as git reads them.
 *
 * @example
 * ```typescript
 * parseGitfile("gitdir: /repo/.git/worktrees/wt\n"); // "/repo/.git/worktrees/wt"
 * parseGitfile("gitdir:  spaced \r\n"); // " spaced ": only the line end goes
 * parseCommonDir("../..\n"); // "../.."
 * parseWorktreeGitdir("/srv/wt/.git \n"); // "/srv/wt/.git"
 * isAbsoluteGitPath("C:/repo/.git"); // true
 * ```
 *
 * A `.git` file (`read_gitfile_gently`) must start with `gitdir: ` (one space); git strips
 * only the trailing `\n` and `\r` characters, so a path with leading or trailing blanks keeps
 * them. `$GIT_DIR/commondir` (`get_common_dir_noenv`) is read the same way. The
 * `worktrees/<name>/gitdir` back-pointer is read by `get_linked_worktree` with
 * `strbuf_rtrim`, which drops every trailing whitespace character but nothing in front.
 *
 * @module
 */

/** `text` without its trailing `\n` and `\r` characters, as git strips a pointer file. */
export function stripLineEnds(text: string): string {
  let end = text.length;
  while (end > 0 && (text[end - 1] === "\n" || text[end - 1] === "\r")) end--;
  return text.slice(0, end);
}

/**
 * The directory a `.git` file names (`read_gitfile_gently`), as written: relative to the
 * file's directory unless absolute. Undefined when the file does not start with `gitdir: `
 * or names nothing.
 */
export function parseGitfile(text: string): string | undefined {
  if (!text.startsWith("gitdir: ")) return undefined;
  const value = stripLineEnds(text);
  return value.length < 9 ? undefined : value.slice(8);
}

/**
 * The repository directory `$GIT_DIR/commondir` names (`get_common_dir_noenv`), as written:
 * relative to `$GIT_DIR` unless absolute. Undefined for an empty file (git dies on it).
 */
export function parseCommonDir(text: string): string | undefined {
  const value = stripLineEnds(text);
  return value === "" ? undefined : value;
}

/**
 * The worktree's `.git` path a `worktrees/<name>/gitdir` back-pointer names
 * (`get_linked_worktree`: `strbuf_rtrim`, trailing whitespace only).
 */
export function parseWorktreeGitdir(text: string): string {
  return text.replace(/[ \t\n\v\f\r]+$/, "");
}

/**
 * Whether git takes `path` as absolute: it starts with `/`, or with a drive letter and a
 * slash or backslash (`C:/`, `C:\`), as Git for Windows writes them. Tested on every
 * platform, as `includeIf.gitdir:` patterns are, so a repository moved between hosts never
 * has such a path joined onto another.
 */
export function isAbsoluteGitPath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}
