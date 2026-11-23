/**
 * The git 3.0 oracle: a native git built with `WITH_BREAKING_CHANGES=YesPlease`, named by
 * `$GIT3` (the path of its `git` binary). Twin tests of git 3.0 behaviour (ours with
 * `GitHostEnvironment.breakingChanges`) run against it and skip without it:
 *
 * ```typescript
 * const git3 = git3Binary();
 * describe.skipIf(!git3)("init under git 3.0", () => { ... });
 * ```
 *
 * Build it from git's sources (any commit; CI builds `master`):
 *
 * ```sh
 * make -j WITH_BREAKING_CHANGES=YesPlease NO_GETTEXT=YesPlease NO_TCLTK=YesPlease \
 *   NO_PERL=YesPlease NO_PYTHON=YesPlease NO_CURL=YesPlease prefix=$HOME/git3 install
 * export GIT3=$HOME/git3/bin/git
 * ```
 *
 * Such a build creates reftable repositories on `main` but, as of git `master` 2026-11, still
 * SHA-1 objects: `read_repository_format` gives a new repository `GIT_HASH_SHA1_LEGACY`.
 */
import { execFileSync } from "node:child_process";
import { nativeGitEnv } from "./native-git-http-backend.js";

let cached: string | null | undefined;

/**
 * The git 3.0 binary from `$GIT3`, or undefined when it is unset or is not a build with
 * `WITH_BREAKING_CHANGES` (its `--build-options` report `default-ref-storage-format:
 * reftable`). A `$GIT3` that is set but unusable throws, so a misconfigured CI fails loudly
 * instead of skipping the git 3.0 twins.
 */
export function git3Binary(): string | undefined {
  if (cached !== undefined) return cached ?? undefined;
  const path = process.env.GIT3;
  if (!path) {
    cached = null;
    return undefined;
  }
  const options = execFileSync(path, ["version", "--build-options"], { encoding: "utf8" });
  if (!/^default-ref-storage-format: reftable$/m.test(options)) {
    throw new Error(`$GIT3 (${path}) is not a git built with WITH_BREAKING_CHANGES:\n${options}`);
  }
  cached = path;
  return path;
}

/**
 * The environment for the git 3.0 binary: {@link nativeGitEnv} without `GIT_EXEC_PATH`
 * (the build finds its own helpers under its prefix; another version's would be wrong).
 */
export function nativeGit3Env(home: string): Record<string, string> {
  const { GIT_EXEC_PATH: _, ...env } = nativeGitEnv(home);
  return env;
}
