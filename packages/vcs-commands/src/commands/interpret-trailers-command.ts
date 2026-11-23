/**
 * `git interpret-trailers` (builtin/interpret-trailers.c) as a library command.
 *
 * ```typescript
 * const { stdout } = await git
 *   .interpretTrailers()
 *   .setInput("Fix the parser\n")
 *   .addTrailer("Reviewed-by: R <r@example.com>")
 *   .setWhere("start")
 *   .addTrailer("Bug: 42")
 *   .call();
 * // "Fix the parser\n\nBug: 42\nReviewed-by: R <r@example.com>\n"
 *
 * const parsed = await git.interpretTrailers().setInput(message).setParse(true).call();
 * parsed.stdout; // the trailers alone, unfolded
 * ```
 */

import { GitApiError } from "../errors/index.js";
import { GitCommand } from "../git-command.js";
import {
  type NewTrailer,
  processTrailers,
  type TrailerCommandRunner,
  type TrailerIfExists,
  type TrailerIfMissing,
  type TrailerWhere,
  trailerConfigOf,
} from "./trailers.js";

/** What {@link InterpretTrailersCommand} gave. */
export interface InterpretTrailersCommandResult {
  /** git's stdout: each input with its trailers (nothing for files edited in place) */
  stdout: string;
  /**
   * git's stderr: the configuration's warnings, `error:` lines (an empty trailer token, a
   * failed trailer command) and what the trailer commands wrote there
   */
  stderr: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Add or parse the trailers of messages, as `git interpret-trailers [--in-place]
 * [--trim-empty] [(--trailer <key>[(=|:)<value>])...] [--parse] [<file>...]`.
 *
 * The input is {@link setInput} (git's stdin) or the files added with {@link addFile} (paths
 * from the worktree top, through the repository's FilesApi), each completed with a line end.
 * The `trailer.*` configuration applies (`trailer.<key>.key`, `.where`, `.ifexists`,
 * `.ifmissing`, `.cmd`, `.command`, `trailer.separators`, the defaults); `--where`,
 * `--if-exists` and `--if-missing` apply to the trailers added after them, as on git's
 * command line ({@link setWhere} with undefined is `--no-where`). Trailer commands run through
 * the host environment's hook runner (`sh -c`, in the worktree top, without the variables
 * naming the repository); without a runner none runs: a trailer keeps the value given and
 * `trailer.<key>.command` adds no trailer of its own.
 */
export class InterpretTrailersCommand extends GitCommand<InterpretTrailersCommandResult> {
  private input = "";
  private files: string[] = [];
  private inPlace = false;
  private trimEmpty = false;
  private onlyTrailers = false;
  private onlyInput = false;
  private unfold = false;
  private noDivider = false;
  private where?: TrailerWhere;
  private ifExists?: TrailerIfExists;
  private ifMissing?: TrailerIfMissing;
  private trailers: NewTrailer[] = [];
  private compatibility?: "2.43" | "2.56";

  /** The message to read when no file is given (git's stdin). */
  setInput(input: string | Uint8Array): this {
    this.checkCallable();
    this.input = typeof input === "string" ? input : decoder.decode(input);
    return this;
  }

  /** A file to read (`<file>`), from the worktree top; several are output one after another. */
  addFile(path: string): this {
    this.checkCallable();
    this.files.push(path);
    return this;
  }

  /** `--in-place`: write each file back instead of the output. */
  setInPlace(inPlace: boolean): this {
    this.checkCallable();
    this.inPlace = inPlace;
    return this;
  }

  /** `--trim-empty`: leave out trailers whose value is empty. */
  setTrimEmpty(trim: boolean): this {
    this.checkCallable();
    this.trimEmpty = trim;
    return this;
  }

  /** `--only-trailers`: output only the trailers. */
  setOnlyTrailers(only: boolean): this {
    this.checkCallable();
    this.onlyTrailers = only;
    return this;
  }

  /** `--only-input`: apply no `trailer.<key>.command` trailers. */
  setOnlyInput(only: boolean): this {
    this.checkCallable();
    this.onlyInput = only;
    return this;
  }

  /** `--unfold`: join continuation lines into one. */
  setUnfold(unfold: boolean): this {
    this.checkCallable();
    this.unfold = unfold;
    return this;
  }

  /** `--parse`: `--only-trailers --only-input --unfold` (true sets the three). */
  setParse(parse: boolean): this {
    this.checkCallable();
    if (parse) {
      this.onlyTrailers = true;
      this.onlyInput = true;
      this.unfold = true;
    }
    return this;
  }

  /** `--no-divider`: a `---` line does not end the message. */
  setNoDivider(noDivider: boolean): this {
    this.checkCallable();
    this.noDivider = noDivider;
    return this;
  }

  /** `--where <placement>` for the trailers added next; undefined is `--no-where`. */
  setWhere(where: TrailerWhere | undefined): this {
    this.checkCallable();
    this.where = where;
    return this;
  }

  /** `--if-exists <action>` for the trailers added next; undefined is `--no-if-exists`. */
  setIfExists(action: TrailerIfExists | undefined): this {
    this.checkCallable();
    this.ifExists = action;
    return this;
  }

  /** `--if-missing <action>` for the trailers added next; undefined is `--no-if-missing`. */
  setIfMissing(action: TrailerIfMissing | undefined): this {
    this.checkCallable();
    this.ifMissing = action;
    return this;
  }

  /** `--trailer <key>[(=|:)<value>]`, with the placement and actions set so far. */
  addTrailer(text: string): this {
    this.checkCallable();
    this.trailers.push({
      text,
      ...(this.where ? { where: this.where } : {}),
      ...(this.ifExists ? { ifExists: this.ifExists } : {}),
      ...(this.ifMissing ? { ifMissing: this.ifMissing } : {}),
    });
    return this;
  }

  /** `--no-trailer`: forget the trailers added so far. */
  clearTrailers(): this {
    this.checkCallable();
    this.trailers = [];
    return this;
  }

  /** The git version to follow where versions differ (default: the hook runner's, else 2.56). */
  setCompatibility(version: "2.43" | "2.56"): this {
    this.checkCallable();
    this.compatibility = version;
    return this;
  }

  async call(): Promise<InterpretTrailersCommandResult> {
    this.checkCallable();
    this.setCallable(false);
    const hooks = this.hooks;
    const compatibility = this.compatibility ?? hooks.compatibility;
    const config = { ...trailerConfigOf(this.workingCopy), compatibility };
    let stderr = (config.warnings ?? []).map((w) => `${w}\n`).join("");
    if (this.onlyInput && this.trailers.length > 0) {
      throw new GitApiError("fatal: --trailer with --only-input does not make sense", {
        exitCode: 129,
      });
    }
    if (this.files.length === 0 && this.inPlace) {
      throw new GitApiError("fatal: no input file given for in-place editing", { exitCode: 128 });
    }
    const runCommand: TrailerCommandRunner | undefined = hooks.enabled
      ? (command) => hooks.runShellCommand("trailer", command.command, command.args)
      : undefined;
    const process = async (text: string) => {
      // read_input_file: strbuf_complete_line (2.44+; 2.43 reads the input as it is)
      const complete = compatibility !== "2.43" && text.length > 0 && !text.endsWith("\n");
      const input = complete ? `${text}\n` : text;
      const result = await processTrailers(
        input,
        {
          trailers: this.trailers,
          trimEmpty: this.trimEmpty,
          onlyTrailers: this.onlyTrailers,
          onlyInput: this.onlyInput,
          unfold: this.unfold,
          noDivider: this.noDivider,
          ...(runCommand ? { runCommand } : {}),
        },
        config,
      );
      stderr += result.errors;
      return result.output;
    };
    if (this.files.length === 0) return { stdout: await process(this.input), stderr };
    let stdout = "";
    for (const name of this.files) {
      const file = await hooks.fileAt(name);
      const stats = file ? await file.files.stats(file.path) : undefined;
      if (!file || stats?.kind !== "file") {
        const reason = stats ? "Is a directory" : "No such file or directory";
        throw new GitApiError(`fatal: could not read input file '${name}': ${reason}`, {
          exitCode: 128,
        });
      }
      const chunks: Uint8Array[] = [];
      for await (const chunk of file.files.read(file.path)) chunks.push(chunk);
      const output = await process(decoder.decode(concat(chunks)));
      if (this.inPlace) await file.files.write(file.path, [encoder.encode(output)]);
      else stdout += output;
    }
    return { stdout, stderr };
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0] as Uint8Array;
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
