/**
 * The error of an operation on a path beneath a symbolic link.
 */

/**
 * Thrown when a path has a symbolic link as a leading component (git's
 * `has_symlink_leading_path`): the path is neither present nor absent, it lies wherever
 * the link points, and an operation on it must not follow the link.
 *
 * @example
 * ```typescript
 * try {
 *   await files.lstat?.("/link/file");
 * } catch (error) {
 *   if (isBeyondSymlinkError(error)) console.log("beneath a link:", error.link);
 * }
 * ```
 */
export class BeyondSymlinkError extends Error {
  /** The path asked for */
  readonly path: string;
  /** Its leading component that is a symbolic link */
  readonly link: string;

  constructor(path: string, link: string) {
    super(`Path is beyond a symbolic link: ${path} (at ${link})`);
    this.name = "BeyondSymlinkError";
    this.path = path;
    this.link = link;
  }
}

/** Whether `error` is a {@link BeyondSymlinkError} (also across package copies). */
export function isBeyondSymlinkError(error: unknown): error is BeyondSymlinkError {
  return (error as Error | undefined)?.name === "BeyondSymlinkError";
}
