/**
 * `strerror(3)` of the errno codes file operations fail with, for messages that quote it
 * (git's `error_errno`, `warning_errno`).
 */

const ERRNO_TEXT: Record<string, string> = {
  ENOENT: "No such file or directory",
  ENOTDIR: "Not a directory",
  EEXIST: "File exists",
  EISDIR: "Is a directory",
  EACCES: "Permission denied",
  EPERM: "Operation not permitted",
  ENOSPC: "No space left on device",
  EROFS: "Read-only file system",
  ELOOP: "Too many levels of symbolic links",
  ENAMETOOLONG: "File name too long",
  ENOTEMPTY: "Directory not empty",
  EINVAL: "Invalid argument",
  EIO: "Input/output error",
};

/** `strerror(errno)` of a failed file operation (its `code`), else its message. */
export function strerror(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  if (typeof code === "string" && ERRNO_TEXT[code]) return ERRNO_TEXT[code] as string;
  const message = (error as Error)?.message ?? String(error);
  const m = /^(E[A-Z]+)\b/.exec(message);
  return (m && ERRNO_TEXT[m[1] as string]) || message;
}
