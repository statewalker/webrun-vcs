/**
 * The initial branch of a new repository, as git's `repo_default_branch_name` (refs.c) picks
 * it: `init.defaultBranch` from the configuration a new repository sees (system, global, the
 * command line), else `master`, or `main` in a git built with `WITH_BREAKING_CHANGES`
 * (`GitHostEnvironment.breakingChanges`, git 3.0). With no name configured, git explains the
 * default in an `advice.defaultBranchName` hint, which {@link DefaultBranch.hint} holds.
 *
 * ```typescript
 * const { name, hint } = await defaultInitialBranch(environment);
 * // name: "master"; hint: ["hint: Using 'master' as the name for the initial branch. ...", ...]
 * ```
 */
import { isValidRefName } from "@statewalker/vcs-core";
import { readProtectedConfig } from "@statewalker/vcs-store-files";
import { parseGitBool } from "@statewalker/vcs-utils";
import type { GitHostEnvironment } from "@statewalker/vcs-working-tree";

/** The initial branch git picks, and the hint it prints with it. */
export interface DefaultBranch {
  name: string;
  /** git's `advice.defaultBranchName` lines (stderr), when the name is the built-in default */
  hint?: string[];
}

/** `init.defaultBranch` names no valid branch: git dies (exit 128). */
export class InvalidDefaultBranchError extends Error {
  override name = "InvalidDefaultBranchError";
  readonly lines: string[];
  constructor(readonly value: string) {
    const line = `fatal: invalid branch name: init.defaultBranch = ${value}`;
    super(line);
    this.lines = [line];
  }
}

/**
 * `init.defaultBranch` without a value (`[init] defaultBranch`): git's config parser dies
 * (`missing value`, then the variable's location), exit 128.
 */
export class MissingDefaultBranchValueError extends Error {
  override name = "MissingDefaultBranchValueError";
  readonly lines: string[];
  constructor(file?: string, line?: number) {
    const fatal =
      file !== undefined && line !== undefined
        ? `fatal: bad config variable 'init.defaultbranch' in file '${file}' at line ${line}`
        : "fatal: unable to parse 'init.defaultbranch' from command-line config";
    const lines = ["error: missing value for 'init.defaultbranch'", fatal];
    super(lines.join("\n"));
    this.lines = lines;
  }
}

/** `--initial-branch` names no valid branch: git dies (exit 128). */
export class InvalidInitialBranchError extends Error {
  override name = "InvalidInitialBranchError";
  readonly lines: string[];
  constructor(readonly value: string) {
    const line = `fatal: invalid initial branch name: '${value}'`;
    super(line);
    this.lines = [line];
  }
}

/** Whether `name` is a valid branch name (`check_refname_format("refs/heads/<name>")`). */
export function isValidBranchName(name: string): boolean {
  return name !== "" && isValidRefName(`refs/heads/${name}`);
}

/**
 * The initial branch of a repository created now. Reads the protected configuration (the
 * repository's own does not exist yet); without an environment, nothing is configured.
 *
 * @throws InvalidDefaultBranchError when `init.defaultBranch` names no valid branch (empty too)
 * @throws MissingDefaultBranchValueError when `init.defaultBranch` has no value
 */
export async function defaultInitialBranch(
  environment: GitHostEnvironment | undefined,
): Promise<DefaultBranch> {
  const config = await readProtectedConfig(environment);
  const last = (key: string) => config.filter((e) => e.key === key).at(-1);
  const configured = last("init.defaultbranch");
  if (configured && configured.value === undefined) {
    throw new MissingDefaultBranchValueError(configured.file, configured.line);
  }
  if (configured?.value !== undefined) {
    // an empty value is no branch name either: git dies on it
    if (!isValidBranchName(configured.value)) {
      throw new InvalidDefaultBranchError(configured.value);
    }
    return { name: configured.value };
  }
  const name = environment?.breakingChanges ? "main" : "master";
  const advice = last("advice.defaultbranchname");
  const enabled = advice === undefined || parseGitBool(advice.value ?? "true") !== false;
  return enabled ? { name, hint: defaultBranchHint(name, environment?.breakingChanges) } : { name };
}

/** git's `default_branch_name_advice` (2.5x, or 3.0), as `advise_if_enabled` prints it. */
function defaultBranchHint(name: string, breakingChanges: boolean | undefined): string[] {
  const text = breakingChanges
    ? `Using '${name}' as the name for the initial branch since Git 3.0.\n` +
      "If you expected Git to create 'master', the just-created\n" +
      "branch can be renamed via this command:\n" +
      "\n" +
      "\tgit branch -m master\n"
    : `Using '${name}' as the name for the initial branch. This default branch name\n` +
      'will change to "main" in Git 3.0. To configure the initial branch name\n' +
      "to use in all of your new repositories, which will suppress this warning,\n" +
      "call:\n" +
      "\n" +
      "\tgit config --global init.defaultBranch <name>\n" +
      "\n" +
      "Names commonly chosen instead of 'master' are 'main', 'trunk' and\n" +
      "'development'. The just-created branch can be renamed via this command:\n" +
      "\n" +
      "\tgit branch -m <name>\n";
  // released 2.5x says `git config set advice...`; git master (the 3.0 build) adds `--global`
  const scope = breakingChanges ? "--global " : "";
  const withOff = `${text}\nDisable this message with "git config set ${scope}advice.defaultBranchName false"`;
  return withOff.split("\n").map((line) => (line === "" ? "hint:" : `hint: ${line}`));
}

/** A ref storage format git does not know: git dies (exit 128). */
export class UnknownRefFormatError extends Error {
  override name = "UnknownRefFormatError";
  readonly lines: string[];
  constructor(
    readonly value: string,
    source: "command line" | "GIT_DEFAULT_REF_FORMAT",
  ) {
    const line =
      source === "command line"
        ? `fatal: unknown ref storage format specified via command line: '${value}'`
        : `fatal: unknown ref storage format specified via GIT_DEFAULT_REF_FORMAT: '${value}'`;
    super(line);
    this.lines = [line];
  }
}

/** The ref storage format of a new repository, and git's warnings while choosing it. */
export interface DefaultRefFormat {
  format: "files" | "reftable";
  warnings: string[];
}

const refFormatOf = (value: string): "files" | "reftable" | undefined =>
  value === "files" || value === "reftable" ? value : undefined;

/**
 * The ref storage format git gives a new repository (setup.c `repository_format_configure`):
 * `requested` (`git init --ref-format`), else `$GIT_DEFAULT_REF_FORMAT`
 * (`GitHostEnvironment.defaultRefFormat`), else `init.defaultRefFormat` from the system,
 * global and command-line config (`feature.experimental` choosing reftable while that is
 * unset), else `files`, or `reftable` with `GitHostEnvironment.breakingChanges` (git 3.0).
 * An unknown name given or in the environment dies (`UnknownRefFormatError`); one in the
 * config warns and is passed over.
 *
 * @example
 * ```typescript
 * const { format } = await defaultRefFormat(environment); // "reftable" under git 3.0
 * ```
 */
export async function defaultRefFormat(
  environment: GitHostEnvironment | undefined,
  requested?: string,
): Promise<DefaultRefFormat> {
  const warnings: string[] = [];
  if (requested !== undefined) {
    const format = refFormatOf(requested);
    if (!format) throw new UnknownRefFormatError(requested, "command line");
    return { format, warnings };
  }
  const env = environment?.defaultRefFormat;
  if (env !== undefined) {
    const format = refFormatOf(env);
    if (!format) throw new UnknownRefFormatError(env, "GIT_DEFAULT_REF_FORMAT");
    return { format, warnings };
  }
  let configured: "files" | "reftable" | undefined;
  for (const e of await readProtectedConfig(environment)) {
    if (e.key === "init.defaultrefformat" || e.key === "init.defaultrefstorageformat") {
      const value = e.value ?? "";
      configured = refFormatOf(value);
      if (!configured) warnings.push(`warning: unknown ref storage format '${value}'`);
    } else if (
      e.key === "feature.experimental" &&
      configured === undefined &&
      parseGitBool(e.value ?? "true") === true
    ) {
      configured = "reftable";
    }
  }
  if (configured) return { format: configured, warnings };
  return { format: environment?.breakingChanges ? "reftable" : "files", warnings };
}
