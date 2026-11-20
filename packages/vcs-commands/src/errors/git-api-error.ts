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
   * git's exit status for this failure: the one given (by the class where its condition
   * always ends so, or by the caller), else the one the message's prefixes say (see
   * {@link exitCodeOfMessage}), else the class's default (128 unless a subclass says
   * otherwise).
   */
  exitCode: number;

  /**
   * Every refusal of a command that reports one and goes on with the next item (git's
   * `error()` and `continue`, as `branch -d` and `tag -d`), this error first: it is thrown
   * once the command is done, carrying the others here.
   */
  refusals?: GitApiError[];

  /**
   * git's stderr for {@link refusals}, one entry per refusal in order (its `error:` line with
   * the lines git prints after it, joined by newlines), so all of them can be shown.
   */
  messages?: string[];

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

  /**
   * The error a command that went on past refusals throws: the first refusal, carrying all
   * of them ({@link refusals}) and their stderr texts ({@link messages}).
   */
  static ofRefusals(refusals: { error: GitApiError; text: string }[]): GitApiError {
    const [first] = refusals;
    first.error.refusals = refusals.map((r) => r.error);
    first.error.messages = refusals.map((r) => r.text);
    return first.error;
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
 * The exit status git's message lines imply, read only where git's own prefixes stand (a
 * path a message lists, `fatal: x.log`, is no prefix): a first line `usage:` (or `usage:`
 * right after a first `error:` line, parse-options' error and usage) is
 * `usage_with_options` (129); a `fatal:` line that is the last line, or the first (a die
 * message with its own continuation or hint lines), is `die()` (128); a first line
 * `error:` (dying nowhere) an `error()` return (1); undefined for a message without these
 * prefixes there. A class whose condition always ends with one status says so explicitly,
 * which this never overrides.
 *
 * @example
 * ```typescript
 * exitCodeOfMessage("error: tag 'x' not found."); // 1
 * exitCodeOfMessage("error: no cherry-pick or revert in progress\nfatal: cherry-pick failed"); // 128
 * exitCodeOfMessage("The following paths are ignored:\nusage: y.log"); // undefined
 * ```
 */
export function exitCodeOfMessage(message: string): number | undefined {
  const lines = message.replace(/\n+$/, "").split("\n");
  const first = lines[0] ?? "";
  const last = lines[lines.length - 1] ?? "";
  if (first.startsWith("usage: ")) return 129;
  if (first.startsWith("error: ") && (lines[1] ?? "").startsWith("usage: ")) return 129;
  if (last.startsWith("fatal: ") || first.startsWith("fatal: ")) return 128;
  if (first.startsWith("error: ")) return 1;
  return undefined;
}
