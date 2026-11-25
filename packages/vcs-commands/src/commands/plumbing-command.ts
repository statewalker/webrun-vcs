/**
 * The common shape of git's listing plumbing (`cat-file`, `ls-files`, `ls-tree`, `show-ref`):
 * stdout is bytes written to a sink as git writes them (`setStdout`), stderr is git's text,
 * and the exit status is git's, so a CLI shim over the library can print what git prints.
 *
 * @example
 * ```typescript
 * // git show-ref --verify refs/heads/main
 * const { stdout, stderr, exitCode } = await git.showRef().setVerify(true).addPattern("refs/heads/main").callOutput();
 * ```
 */

import { GitApiError } from "../errors/index.js";
import { GitCommand } from "../git-command.js";

/** Where a plumbing command writes its stdout: each chunk is the caller's to keep. */
export type ByteSink = (chunk: Uint8Array) => void | Promise<void>;

/** How a plumbing command ended when it did not die. */
export interface PlumbingResult {
  /** git's exit status (0, or 1 where git reports a miss without dying) */
  exitCode: number;
  /** git's stderr (warnings and `error:` lines it printed and went on past) */
  stderr: string;
}

/** {@link PlumbingResult} with stdout collected, deaths included. */
export interface PlumbingOutput extends PlumbingResult {
  /** Everything written to stdout, also before a death */
  stdout: Uint8Array;
}

/**
 * A death of a plumbing command: git's stderr lines (`fatal: ...`, with the lines before it)
 * as the message, its exit status in `exitCode` (128 by default).
 */
export class PlumbingError extends GitApiError {
  constructor(message: string, exitCode = 128) {
    super(message, { exitCode });
    this.name = "PlumbingError";
  }
}

const encoder = new TextEncoder();

/**
 * The base of the listing plumbing commands: {@link run} writes through {@link write} and
 * {@link warn}; {@link call} gives the exit status and stderr, {@link callOutput} also
 * collects stdout and turns a death into its output.
 */
export abstract class PlumbingCommand extends GitCommand<PlumbingResult> {
  private sink?: ByteSink;
  private stderrText = "";

  /** Where stdout goes (default: discarded unless {@link callOutput} collects it). */
  setStdout(sink: ByteSink): this {
    this.checkCallable();
    this.sink = sink;
    return this;
  }

  /** The command's work: write stdout, add stderr, return the exit status. */
  protected abstract run(): Promise<number>;

  /** Writes bytes or text (UTF-8) to stdout. */
  protected async write(chunk: Uint8Array | string): Promise<void> {
    const bytes = typeof chunk === "string" ? encoder.encode(chunk) : chunk;
    if (bytes.length > 0) await this.sink?.(bytes);
  }

  /** Adds a line (its newline added) to stderr. */
  protected warn(line: string): void {
    this.stderrText += `${line}\n`;
  }

  /** What was written to stderr so far. */
  getStderr(): string {
    return this.stderrText;
  }

  /**
   * Runs the command.
   *
   * @throws PlumbingError (or another GitApiError) where git dies
   */
  async call(): Promise<PlumbingResult> {
    this.checkCallable();
    this.setCallable(false);
    const exitCode = await this.run();
    return { exitCode, stderr: this.stderrText };
  }

  /** Runs the command, collecting stdout; a death is returned as its stderr and status. */
  async callOutput(): Promise<PlumbingOutput> {
    const chunks: Uint8Array[] = [];
    const outer = this.sink;
    this.sink = async (chunk) => {
      chunks.push(chunk);
      await outer?.(chunk);
    };
    let exitCode: number;
    let stderr: string;
    try {
      ({ exitCode, stderr } = await this.call());
    } catch (e) {
      if (!(e instanceof GitApiError)) throw e;
      exitCode = e.exitCode;
      stderr = `${this.stderrText}${e.message}\n`;
    }
    let size = 0;
    for (const c of chunks) size += c.length;
    const stdout = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
      stdout.set(c, at);
      at += c.length;
    }
    return { exitCode, stderr, stdout };
  }
}
