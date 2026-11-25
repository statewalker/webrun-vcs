/**
 * `git check-ref-format` (builtin/check-ref-format.c): whether a name is a valid ref name,
 * refs.c's `check_refname_format`, and `--branch`'s branch name as `check_branch_ref` reads it.
 *
 * @example
 * ```typescript
 * // git check-ref-format --normalize refs///heads/foo
 * await git.checkRefFormat().setNormalize(true).setRefName("refs///heads/foo").call();
 * // { exitCode: 0, stdout: "refs/heads/foo\n", stderr: "" }
 * checkRefFormat("refs/heads/a..b"); // undefined: invalid
 * ```
 */

import { collapseRefNameSlashes, isValidRefName } from "@statewalker/vcs-core";

import { RevisionError } from "../errors/index.js";
import { GitCommand } from "../git-command.js";

/** What a plumbing command printed and its exit status, as git's process ends. */
export interface PlumbingOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** The options of `git check-ref-format` without `--branch`. */
export interface CheckRefFormatOptions {
  /** `--normalize` (`--print`): leading and repeated slashes dropped first */
  normalize?: boolean;
  /** `--allow-onelevel` */
  allowOneLevel?: boolean;
  /** `--refspec-pattern`: one `*` allowed */
  refspecPattern?: boolean;
}

/**
 * `git check-ref-format [--normalize] [--allow-onelevel] [--refspec-pattern] <refname>`
 * without a repository: the name as git checked it (normalized with `normalize`), or
 * undefined when it is invalid.
 */
export function checkRefFormat(
  name: string,
  options: CheckRefFormatOptions = {},
): string | undefined {
  const refName = options.normalize ? collapseRefNameSlashes(name) : name;
  const valid = isValidRefName(refName, {
    allowOneLevel: options.allowOneLevel === true,
    refspecPattern: options.refspecPattern === true,
  });
  return valid ? refName : undefined;
}

/**
 * `git check-ref-format`: {@link setRefName} with the options, exit status 0 for a valid
 * name (printed under `--normalize`), 1 for an invalid one; or {@link setBranch}
 * (`--branch <branchname-shorthand>`): `@{-N}` expanded to the branch (or commit) it stands
 * for, then checked as `refs/heads/<name>` and printed, or git's
 * `fatal: '<name>' is not a valid branch name` (exit 128).
 */
export class CheckRefFormatCommand extends GitCommand<PlumbingOutput> {
  private refName?: string;
  private branch?: string;
  private readonly options: CheckRefFormatOptions = {};

  /** The name to check. */
  setRefName(name: string): this {
    this.checkCallable();
    this.refName = name;
    return this;
  }

  /** `--branch <name>`: check a branch name shorthand instead. */
  setBranch(name: string): this {
    this.checkCallable();
    this.branch = name;
    return this;
  }

  /** `--normalize` / `--print`. */
  setNormalize(normalize: boolean): this {
    this.checkCallable();
    this.options.normalize = normalize;
    return this;
  }

  /** `--allow-onelevel` / `--no-allow-onelevel`. */
  setAllowOneLevel(allow: boolean): this {
    this.checkCallable();
    this.options.allowOneLevel = allow;
    return this;
  }

  /** `--refspec-pattern`. */
  setRefspecPattern(pattern: boolean): this {
    this.checkCallable();
    this.options.refspecPattern = pattern;
    return this;
  }

  async call(): Promise<PlumbingOutput> {
    this.checkCallable();
    this.setCallable(false);
    if (this.branch !== undefined) return this.checkBranch(this.branch);
    const checked = checkRefFormat(this.refName ?? "", this.options);
    if (checked === undefined) return { exitCode: 1, stdout: "", stderr: "" };
    return { exitCode: 0, stdout: this.options.normalize ? `${checked}\n` : "", stderr: "" };
  }

  /** check_branch_ref: copy_branchname (INTERPRET_BRANCH_LOCAL), then the rules. */
  private async checkBranch(arg: string): Promise<PlumbingOutput> {
    const refused = {
      exitCode: 128,
      stdout: "",
      stderr: `fatal: '${arg}' is not a valid branch name\n`,
    };
    let name: string;
    try {
      name = await this.expandPriorCheckout(arg);
      if (name === arg) name = await this.interpretLocalBranch(arg);
    } catch (error) {
      // git dies reading the name (`@{u}` without an upstream): its message
      if (!(error instanceof RevisionError)) throw error;
      return { exitCode: 128, stdout: "", stderr: `${error.message}\n` };
    }
    const ref = `refs/heads/${name}`;
    if (arg.startsWith("-") || ref === "refs/heads/HEAD" || !isValidRefName(ref)) return refused;
    return { exitCode: 0, stdout: `${name}\n`, stderr: "" };
  }
}
