/**
 * Requests to sign (`commit -S`, `commit.gpgSign`, `tag -s`/`-u`, `tag.gpgSign`,
 * `push --signed`, `push.gpgSign`) and their refusal.
 *
 * Nothing signs objects yet: no signer exists (statewalker/statewalker-root#283; the signer
 * is a later ticket). Until it does, every request to sign fails as native git fails when
 * its signing program cannot sign (gpg-interface.c `sign_buffer_gpg`: `error: gpg failed to
 * sign the data:` with gpg's status output, `(no gpg output)` when there is none), followed
 * by what the command says then: `fatal: failed to write commit object` (commit, merge, am),
 * `error: unable to sign the tag` (tag), `fatal: failed to sign the push certificate`
 * (push). Nothing is written by the step that would have signed: no commit or tag object,
 * no ref.
 *
 * Decision (statewalker/statewalker-root#283): refuse as git does when signing is asked but
 * cannot be done, so callers never get unsigned objects where git would sign or die. The
 * alternative, warning and going on unsigned (friendlier to hosts that set `gpgSign`
 * globally), was not taken; switch only on the human's word.
 */
import { parseGitBool } from "@statewalker/vcs-utils";
import type { WorkingCopy } from "@statewalker/vcs-working-tree";

import { GitApiError } from "../errors/index.js";
import { RemoteConfigStore } from "../remote-config/index.js";

/**
 * A request to sign: the key to sign with (`""`: the default key, git's `-S` without a key
 * id), or undefined when nothing is to be signed.
 */
export type SignRequest = string | undefined;

/**
 * A command's `-S[<keyid>]` / `--no-gpg-sign` as set (undefined: neither given), resolved
 * against `<key>` in the configuration as git's commands read `commit.gpgSign` (a boolean:
 * `""` when true, nothing when false or unset). An option given wins over the
 * configuration.
 *
 * @example
 * ```typescript
 * signRequestOf(workingCopy, undefined); // "" with commit.gpgSign=true, else undefined
 * signRequestOf(workingCopy, false); // undefined (--no-gpg-sign)
 * signRequestOf(workingCopy, "ABC"); // "ABC" (-SABC)
 * ```
 */
export function signRequestOf(
  workingCopy: WorkingCopy,
  option: boolean | string | undefined,
  key = "commit.gpgSign",
): SignRequest {
  if (option === false) return undefined;
  if (option === true) return "";
  if (typeof option === "string") return option;
  if (!workingCopy.config) return undefined;
  const value = RemoteConfigStore.from(workingCopy).value(key);
  // git_config_bool: a key without `=` is true, an empty value false
  return value === undefined ? undefined : parseGitBool(value) ? "" : undefined;
}

/** git's lines when its signing program fails without output (`sign_buffer_gpg`). */
export const SIGNING_FAILED_LINES: readonly string[] = [
  "error: gpg failed to sign the data:",
  "(no gpg output)",
];

/**
 * A request to sign that cannot be done: no signer exists. Its message is git's stderr when
 * its signing program fails (see the module comment), its exit status git's.
 */
export class SigningFailedError extends GitApiError {
  /** The key that was asked for (`""`: the default key) */
  readonly signingKey: string;

  constructor(message: string, signingKey: string, exitCode?: number) {
    super(message, exitCode === undefined ? undefined : { exitCode });
    this.name = "SigningFailedError";
    this.signingKey = signingKey;
  }
}

/**
 * Throws git's failure to sign a commit (builtin/commit.c, builtin/merge.c, builtin/am.c:
 * `commit_tree` failing in `sign_commit`), when `sign` asks to sign: `error: gpg failed to
 * sign the data:`, `(no gpg output)`, then `tail` (default `fatal: failed to write commit
 * object`, exit 128).
 */
export function refuseCommitSigning(
  sign: SignRequest,
  tail: readonly string[] = ["fatal: failed to write commit object"],
): void {
  if (sign === undefined) return;
  throw new SigningFailedError([...SIGNING_FAILED_LINES, ...tail].join("\n"), sign);
}
