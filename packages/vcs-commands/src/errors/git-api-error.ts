/**
 * Base exception for all Git API errors.
 *
 * Based on JGit's GitAPIException hierarchy. Each error carries the exit status native git
 * ends with in the same situation ({@link GitApiError.exitCode}): 128 where git dies
 * (`die()`, a `fatal:` line), 129 for a usage error (`usage_with_options`, a `usage:` line),
 * 1 where a command returns after `error()`, and the few statuses of their own (`git remote`
 * exits 2 for a missing remote, 3 for one that exists already).
 */
export class GitApiError extends Error {
  /**
   * git's exit status for this failure: the one given, else the one the message's lines say
   * (a `usage:` line 129, a `fatal:` line 128, an `error:` first line 1), else the class's
   * default (128 unless a subclass says otherwise).
   */
  exitCode: number;

  constructor(message: string, options?: GitApiErrorOptions) {
    super(message, options);
    this.name = "GitApiError";
    this.exitCode =
      options?.exitCode ?? exitCodeOfMessage(message) ?? options?.defaultExitCode ?? 128;
  }

  /** Sets {@link exitCode} (a status the message and the class cannot tell); returns this. */
  withExitCode(exitCode: number): this {
    this.exitCode = exitCode;
    return this;
  }
}

/** The options of a {@link GitApiError}. */
export interface GitApiErrorOptions extends ErrorOptions {
  /** git's exit status, whatever the message says */
  exitCode?: number;
  /** The status when neither {@link exitCode} nor the message's prefixes say (default 128) */
  defaultExitCode?: number;
}

/**
 * The exit status git's message lines imply: a `usage:` line is `usage_with_options` (129),
 * a `fatal:` line `die()` (128), a message starting with `error:` (and dying nowhere) an
 * `error()` return (1); undefined for a message without these prefixes.
 *
 * @example
 * ```typescript
 * exitCodeOfMessage("error: tag 'x' not found."); // 1
 * exitCodeOfMessage("error: no cherry-pick or revert in progress\nfatal: cherry-pick failed"); // 128
 * ```
 */
export function exitCodeOfMessage(message: string): number | undefined {
  if (/^usage: /m.test(message)) return 129;
  if (/^fatal: /m.test(message)) return 128;
  if (message.startsWith("error: ")) return 1;
  return undefined;
}
