import { IncompatibleOptionsError, InvalidArgumentError } from "../errors/index.js";
import { parsePathspecFile } from "./pathspec.js";

/**
 * A command's `--pathspec-from-file` (`--pathspec-file-nul` with `nul`), as the builtins
 * of add, rm, commit, stash push, checkout, restore and reset take it: the file's elements
 * replace the pathspec arguments, which may not be given beside it, and the options git
 * refuses with it are refused with its message.
 *
 * @example
 * ```typescript
 * const file = new PathspecFile();
 * file.read('a.txt\n"caf\\303\\251"\n');
 * file.refuse("--patch", patch); // "options '--pathspec-from-file' and '--patch' ..."
 * const paths = file.pathspec(args); // ["a.txt", "café"], or args without a file
 * ```
 */
export class PathspecFile {
  /** Whether `--pathspec-from-file` was given (an empty file included) */
  given = false;
  /** The elements the file holds */
  elements: string[] = [];

  /**
   * Reads the file's content (parse_pathspec_file).
   *
   * @throws InvalidArgumentError "fatal: line is badly quoted: <line>", as git dies
   */
  read(content: string | Uint8Array, nul = false): void {
    this.given = true;
    try {
      this.elements = parsePathspecFile(content, nul);
    } catch (error) {
      throw new InvalidArgumentError(
        "pathspecFromFile",
        content,
        `fatal: ${(error as Error).message}`,
      );
    }
  }

  /**
   * git's "options '--pathspec-from-file' and '<option>' cannot be used together" when the
   * file was given and `set` holds.
   */
  refuse(option: string, set: boolean): void {
    if (!this.given || !set) return;
    throw new IncompatibleOptionsError(
      ["--pathspec-from-file", option],
      `fatal: options '--pathspec-from-file' and '${option}' cannot be used together`,
    );
  }

  /**
   * git's "'--pathspec-from-file' and pathspec arguments cannot be used together" when the
   * file was given beside pathspec arguments (whatever the file holds).
   */
  refuseArguments(args: readonly string[]): void {
    if (!this.given || args.length === 0) return;
    throw new InvalidArgumentError(
      "pathspecFromFile",
      this.elements,
      "fatal: '--pathspec-from-file' and pathspec arguments cannot be used together",
    );
  }

  /** The pathspec: the file's elements when it was given (refusing `args` beside it), else `args`. */
  pathspec(args: readonly string[]): string[] {
    this.refuseArguments(args);
    return this.given ? [...this.elements] : [...args];
  }
}
