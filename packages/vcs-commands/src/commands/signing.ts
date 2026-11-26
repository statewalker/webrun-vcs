/**
 * Requests to sign (`commit -S`, `commit.gpgSign`, `tag -s`/`-u`, `tag.gpgSign`,
 * `push --signed`, `push.gpgSign`), the signing itself, and its refusal.
 *
 * Signing goes through the host's {@link Signer} (`GitHostEnvironment.signer`,
 * statewalker/statewalker-root#288): {@link resolveSigning} reads what git's
 * gpg-interface.c reads (`gpg.format`, `gpg.program` / `gpg.<format>.program`,
 * `user.signingKey`, `gpg.ssh.defaultKeyCommand`), picks the key as `sign_buffer` does and
 * {@link signPayload} hands the payload to the signer; {@link signCommit} puts the signature
 * in the commit's `gpgsig` header (`gpgsig-sha256` in a SHA-256 repository), as
 * `commit_tree_extended` / `add_header_signature` do. `commit -S` and `tag -s`/`-u` sign (the
 * tag's signature appended to its message, builtin/tag.c's `do_sign`), and so do the
 * commands that write commits for the user: rebase, cherry-pick, revert, merge and am
 * (statewalker/statewalker-root#319, each through {@link signCommit}); push certificates
 * still refuse.
 *
 * Without a signer every request to sign fails as native git fails when its signing program
 * cannot sign (gpg-interface.c `sign_buffer_gpg`: `error: gpg failed to sign the data:` with
 * gpg's status output, `(no gpg output)` when there is none), followed by what the command
 * says then: `fatal: failed to write commit object` (commit, merge, am),
 * `error: unable to sign the tag` (tag), `fatal: failed to sign the push certificate`
 * (push). Nothing is written by the step that would have signed: no commit or tag object,
 * no ref.
 *
 * Decision (statewalker/statewalker-root#283): refuse as git does when signing is asked but
 * cannot be done, so callers never get unsigned objects where git would sign or die. The
 * alternative, warning and going on unsigned (friendlier to hosts that set `gpgSign`
 * globally), was not taken; switch only on the human's word.
 */
import {
  type AnnotatedTag,
  type Commit,
  collectCommitBytes,
  type PersonIdent,
} from "@statewalker/vcs-core";
import { createSha256, parseGitBool } from "@statewalker/vcs-utils";
import {
  expandUserPath,
  type GitHostEnvironment,
  type Signer,
  type SigningFormat,
  type SigningRequest,
  type WorkingCopy,
} from "@statewalker/vcs-working-tree";

import { GitApiError, InvalidConfigError } from "../errors/index.js";
import { type ConfigValueWhere, RemoteConfigStore } from "../remote-config/index.js";
import { hostEnvironmentOf } from "./git-ident.js";

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
 * A request to sign that cannot be done (no signer, a failing one, a command that does not
 * sign yet). Its message is git's stderr when its signing program fails (see the module
 * comment), its exit status git's.
 */
export class SigningFailedError extends GitApiError {
  /** The key that was asked for (`""`: the default key) */
  readonly signingKey: string;
  /** What the signer said, without the command's tail (absent: no signer ran) */
  readonly signerMessages?: readonly string[];
  /** The ssh signing program's exit status when it ran and failed (`SigningOutcome.exitCode`) */
  readonly programExitCode?: number;

  constructor(
    message: string,
    signingKey: string,
    exitCode?: number,
    details: { signerMessages?: readonly string[]; programExitCode?: number } = {},
  ) {
    super(message, exitCode === undefined ? undefined : { exitCode });
    this.name = "SigningFailedError";
    this.signingKey = signingKey;
    if (details.signerMessages !== undefined) this.signerMessages = details.signerMessages;
    if (details.programExitCode !== undefined) this.programExitCode = details.programExitCode;
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

/** git's default program of each format (gpg-interface.c `gpg_format[]`). */
const DEFAULT_PROGRAMS: Record<SigningFormat, string> = {
  openpgp: "gpg",
  x509: "gpgsm",
  ssh: "ssh-keygen",
};

/** The trust levels `gpg.minTrustLevel` takes (any case). */
const TRUST_LEVELS = ["UNDEFINED", "NEVER", "MARGINAL", "FULLY", "ULTIMATE"];

/** What git's `git_gpg_config` reads, the last value of each setting winning. */
export interface SigningConfig {
  /** `gpg.format` (default openpgp) */
  format: SigningFormat;
  /** The program of each format: `gpg.program` / `gpg.openpgp.program`, `gpg.x509.program`, `gpg.ssh.program` */
  programs: Record<SigningFormat, string>;
  /** `user.signingKey` */
  signingKey?: string;
  /** `gpg.ssh.defaultKeyCommand` */
  defaultKeyCommand?: string;
  /** `gpg.minTrustLevel`, lower case (`undefined`, `never`, `marginal`, `fully`, `ultimate`) */
  minTrustLevel?: string;
  /** `gpg.ssh.allowedSignersFile` (`~/` expanded) */
  allowedSignersFile?: string;
  /** `gpg.ssh.revocationFile` (`~/` expanded) */
  revocationFile?: string;
}

/**
 * The signing configuration as gpg-interface.c's `git_gpg_config` reads it, every variable
 * in the configuration's order (`gpg.program` and `gpg.openpgp.program` name one setting:
 * the later wins). Program paths are expanded as `git_config_pathname` does (`~/`).
 *
 * @throws InvalidConfigError as git dies on the first bad variable: `error: missing value
 *   for '<key>'` for a variable without `=` (`user.signingKey`, `gpg.format`,
 *   `gpg.minTrustLevel`, the programs, the ssh settings), `error: invalid value for
 *   'gpg.format': '<value>'` (or `gpg.minTrustLevel`), then `fatal: bad config variable
 *   '<key>' in file '<file>' at line <n>`
 */
export function signingConfigOf(workingCopy: WorkingCopy): SigningConfig {
  if (!workingCopy.config) return { format: "openpgp", programs: { ...DEFAULT_PROGRAMS } };
  const store = RemoteConfigStore.from(workingCopy);
  const keys = [...SIGNING_KEYS];
  const entries: (ConfigValueWhere & { key: string })[] =
    store.entriesWithOriginFor(keys) ??
    keys.flatMap((key) => {
      const text = store.value(key);
      return text === undefined ? [] : [{ key, text }];
    });
  return signingConfigFromEntries(entries, hostEnvironmentOf(workingCopy));
}

/** The variables {@link signingConfigOf} reads, lower case. */
export const SIGNING_KEYS: readonly string[] = [
  "user.signingkey",
  "gpg.format",
  "gpg.mintrustlevel",
  "gpg.ssh.defaultkeycommand",
  "gpg.ssh.allowedsignersfile",
  "gpg.ssh.revocationfile",
  "gpg.program",
  "gpg.openpgp.program",
  "gpg.x509.program",
  "gpg.ssh.program",
];

/**
 * {@link signingConfigOf} over config entries in git's order (keys lower case, only
 * {@link SIGNING_KEYS} are read), for a configuration that is no working copy's (a served
 * repository's).
 */
export function signingConfigFromEntries(
  entries: Iterable<ConfigValueWhere & { key: string }>,
  environment: GitHostEnvironment | undefined,
): SigningConfig {
  const config: SigningConfig = { format: "openpgp", programs: { ...DEFAULT_PROGRAMS } };
  for (const { key, text, file, line } of entries) {
    if (!SIGNING_KEYS.includes(key)) continue;
    const fail = (error: string): never => {
      const fatal =
        file !== undefined && line !== undefined
          ? `fatal: bad config variable '${key}' in file '${file}' at line ${line}`
          : `fatal: unable to parse '${key}' from command-line config`;
      throw new InvalidConfigError(key, `${error}\n${fatal}`);
    };
    // git's config_error_nonbool: every one of these needs a value
    if (text === undefined) fail(`error: missing value for '${key}'`);
    const value = text as string;
    switch (key) {
      case "user.signingkey":
        config.signingKey = value;
        break;
      case "gpg.format":
        if (value !== "openpgp" && value !== "x509" && value !== "ssh")
          fail(`error: invalid value for '${key}': '${value}'`);
        config.format = value as SigningFormat;
        break;
      case "gpg.mintrustlevel":
        if (!TRUST_LEVELS.includes(value.toUpperCase()))
          fail(`error: invalid value for '${key}': '${value}'`);
        config.minTrustLevel = value.toLowerCase();
        break;
      case "gpg.ssh.defaultkeycommand":
        config.defaultKeyCommand = value;
        break;
      case "gpg.ssh.allowedsignersfile":
        config.allowedSignersFile = expandUserPath(value, environment) ?? value;
        break;
      case "gpg.ssh.revocationfile":
        config.revocationFile = expandUserPath(value, environment) ?? value;
        break;
      case "gpg.program":
      case "gpg.openpgp.program":
      case "gpg.x509.program":
      case "gpg.ssh.program": {
        const format: SigningFormat =
          key === "gpg.x509.program" ? "x509" : key === "gpg.ssh.program" ? "ssh" : "openpgp";
        config.programs[format] = expandUserPath(value, environment) ?? value;
        break;
      }
    }
  }
  return config;
}

/**
 * What git's `sign_buffer(..., SIGN_BUFFER_USE_DEFAULT_KEY)` runs for `sign` (`""`: the
 * default key): the format and program from the configuration, the key `sign` names, else
 * `user.signingKey`, else for ssh `gpg.ssh.defaultKeyCommand`'s, else the committer as
 * `Name <email>`. The payload is left empty for the caller.
 *
 * @throws InvalidConfigError for a bad signing variable (see {@link signingConfigOf})
 * @throws SigningFailedError for ssh with neither a key nor `gpg.ssh.defaultKeyCommand`
 *   (git dies: `fatal: either user.signingkey or gpg.ssh.defaultKeyCommand needs to be
 *   configured`)
 */
export function resolveSigning(
  workingCopy: WorkingCopy,
  sign: string,
  committer: Pick<PersonIdent, "name" | "email">,
): Omit<SigningRequest, "payload"> {
  const config = signingConfigOf(workingCopy);
  const request: Omit<SigningRequest, "payload"> = {
    format: config.format,
    program: config.programs[config.format],
  };
  const key = sign !== "" ? sign : config.signingKey;
  if (key !== undefined) request.key = key;
  else if (config.format === "ssh") {
    if (config.defaultKeyCommand === undefined) {
      throw new SigningFailedError(
        "fatal: either user.signingkey or gpg.ssh.defaultKeyCommand needs to be configured",
        sign,
      );
    }
    request.defaultKeyCommand = config.defaultKeyCommand;
  } else request.key = `${committer.name} <${committer.email}>`;
  return request;
}

/** The host's signer of a working copy, if any. */
export function signerOf(workingCopy: WorkingCopy): Signer | undefined {
  return hostEnvironmentOf(workingCopy)?.signer;
}

/**
 * A message as git's `vfreportf` prints it: control characters other than tab and newline
 * as `?`, at most 4095 bytes (its buffer, the newline after).
 */
function reportedMessage(message: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: git replaces exactly these
  const sanitized = message.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "?");
  const bytes = new TextEncoder().encode(sanitized);
  return bytes.length <= 4095 ? sanitized : new TextDecoder().decode(bytes.subarray(0, 4095));
}

/** git's `strip_cr_before_lf`. */
function stripCrBeforeLf(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  let j = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 13 && bytes[i + 1] === 10) continue;
    out[j++] = bytes[i] as number;
  }
  return out.subarray(0, j);
}

/** Where a signature goes and what the command says when it cannot be made. */
export interface SignPayloadOptions {
  /** The committer (or tagger): the default openpgp/x509 key is its `Name <email>` */
  committer: Pick<PersonIdent, "name" | "email">;
  /** The host directory the signing program runs in (the worktree top) */
  cwd?: string;
  /** The command's lines after a failed signing (default `fatal: failed to write commit object`) */
  tail?: readonly string[];
}

/**
 * Signs `payload` for `sign` (`""`: the default key) through the host's signer, as git's
 * `sign_buffer`: the signature with a CR stripped before each LF. Without a signer, or when
 * the signer fails, throws git's lines and then `tail`.
 *
 * @throws SigningFailedError when the signature cannot be made
 * @throws InvalidConfigError for a bad signing variable
 *
 * @example
 * ```typescript
 * const signature = await signPayload(workingCopy, "", payload, { committer });
 * ```
 */
export async function signPayload(
  workingCopy: WorkingCopy,
  sign: string,
  payload: Uint8Array,
  options: SignPayloadOptions,
): Promise<Uint8Array> {
  const tail = options.tail ?? ["fatal: failed to write commit object"];
  const resolved = resolveSigning(workingCopy, sign, options.committer);
  const signer = signerOf(workingCopy);
  if (!signer) throw new SigningFailedError([...SIGNING_FAILED_LINES, ...tail].join("\n"), sign);
  const request: SigningRequest = { ...resolved, payload };
  if (options.cwd !== undefined) request.cwd = options.cwd;
  const outcome = await signer(request);
  if (!outcome.signature) {
    const messages = outcome.messages?.length
      ? outcome.messages.map(reportedMessage)
      : SIGNING_FAILED_LINES;
    throw new SigningFailedError(
      [...messages, ...(outcome.died ? [] : tail)].join("\n"),
      sign,
      undefined,
      {
        signerMessages: messages,
        ...(outcome.exitCode !== undefined && resolved.format === "ssh"
          ? { programExitCode: outcome.exitCode }
          : {}),
      },
    );
  }
  return stripCrBeforeLf(outcome.signature);
}

/**
 * `commit` signed for `sign` (`""`: the default key) as git's `commit_tree_extended` signs
 * it: the commit's bytes without a signature are signed and the signature becomes its
 * `gpgsig` header (`gpgsig-sha256` in a SHA-256 repository: the store writes the
 * repository's header), after every other header, each line of the signature after the
 * first starting with a space (`add_header_signature`). Undefined `sign`: `commit` as it is.
 *
 * @throws SigningFailedError when the signature cannot be made (see {@link signPayload})
 *
 * @example
 * ```typescript
 * const signed = await signCommit(workingCopy, "", commit);
 * await history.commits.store(signed);
 * ```
 */
export async function signCommit(
  workingCopy: WorkingCopy,
  sign: SignRequest,
  commit: Commit,
  options: Omit<SignPayloadOptions, "committer"> = {},
): Promise<Commit> {
  if (sign === undefined) return commit;
  const { gpgSignature: _dropped, compatSignature: _droppedCompat, ...unsigned } = commit;
  const payload = await collectCommitBytes(unsigned);
  const signOptions = { ...options, committer: commit.committer };
  const signature = new TextDecoder().decode(
    await signPayload(workingCopy, sign, payload, signOptions),
  );
  // add_header_signature: every line of the signature with its newline, the first after the
  // header's name and a space, the others after a space; the header ends with the
  // signature's last newline (the commit model holds the lines without it)
  const signed: Commit = { ...unsigned, gpgSignature: headerSignature(signature) };
  // commit_tree_extended in a repository with a compatibility object format: the commit as
  // that format sees it (its ids mapped) signed too, and both signatures in both objects, so
  // the compatibility id the store computes covers a signature in its own format
  const compat = workingCopy.history.objects?.compat;
  if (compat) {
    const compatPayload = await compat.convertToCompat("commit", payload);
    const compatSignature = new TextDecoder().decode(
      await signPayload(workingCopy, sign, compatPayload, signOptions),
    );
    signed.compatSignature = {
      header: compat.compat.signatureHeader,
      value: headerSignature(compatSignature),
    };
  }
  return signed;
}

/**
 * A signature as a header holds it: its lines without the last newline (add_header_signature
 * writes each line with its newline).
 */
function headerSignature(signature: string): string {
  return signature.endsWith("\n") ? signature.slice(0, -1) : signature;
}

/**
 * builtin/tag.c `do_sign` in a repository with a compatibility object format: the tag as
 * that format sees it signed too, its signature to go in the tag's header (the storage
 * signature ends the message), so the tag's compatibility id covers a signature in its own
 * format. Undefined without a compatibility format.
 */
export async function signTagCompat(
  workingCopy: WorkingCopy,
  sign: string,
  payload: Uint8Array,
  options: SignPayloadOptions,
): Promise<AnnotatedTag["compatSignature"]> {
  const compat = workingCopy.history.objects?.compat;
  if (!compat) return undefined;
  const compatPayload = await compat.convertToCompat("tag", payload);
  const signature = new TextDecoder().decode(
    await signPayload(workingCopy, sign, compatPayload, options),
  );
  return { header: compat.compat.signatureHeader, value: headerSignature(signature) };
}

/** A uint32 length-prefixed string of an ssh wire buffer at `at`. */
function sshString(bytes: Uint8Array, at: number): { value: Uint8Array; next: number } | undefined {
  if (at + 4 > bytes.length) return undefined;
  const length = new DataView(bytes.buffer, bytes.byteOffset + at, 4).getUint32(0);
  if (at + 4 + length > bytes.length) return undefined;
  return { value: bytes.subarray(at + 4, at + 4 + length), next: at + 4 + length };
}

function base64Bytes(text: string): Uint8Array | undefined {
  try {
    return Uint8Array.from(atob(text.replace(/\s+/g, "")), (c) => c.charCodeAt(0));
  } catch {
    return undefined;
  }
}

/**
 * The public key blob of an ssh key as `ssh-keygen -l` reads it: a public key line
 * (`<type> <base64> [comment]`) or an OpenSSH private key file (its public part, which is
 * never encrypted).
 */
function sshPublicKeyBlob(text: string): Uint8Array | undefined {
  const pem = /-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]*?)-----END OPENSSH PRIVATE KEY-----/.exec(
    text,
  );
  if (pem) {
    const bytes = base64Bytes(pem[1] as string);
    const magic = new TextEncoder().encode("openssh-key-v1\0");
    if (!bytes || bytes.length < magic.length || magic.some((b, i) => bytes[i] !== b)) {
      return undefined;
    }
    let at = magic.length;
    // ciphername, kdfname, kdfoptions, then the number of keys and the first public key
    for (let i = 0; i < 3; i++) {
      const s = sshString(bytes, at);
      if (!s) return undefined;
      at = s.next;
    }
    return sshString(bytes, at + 4)?.value;
  }
  const line = text.split("\n").find((l) => l.trim() !== "" && !l.startsWith("#"));
  const field = line?.trim().split(/\s+/)[1];
  return field ? base64Bytes(field) : undefined;
}

/**
 * gpg-interface.c's `get_signing_key_id()` for `sign` (`""`: the default key): the key of an
 * openpgp or x509 signature (`user.signingKey`, else the committer as `Name <email>`), the
 * SHA-256 fingerprint of an ssh key (`ssh-keygen -lf`'s `SHA256:...`, for a literal key, a
 * public key file or an OpenSSH private key file).
 *
 * @throws SigningFailedError as git dies when it cannot fingerprint an ssh key (`fatal: failed
 *   to get the ssh fingerprint for key '<key>'`), or has none
 */
export async function signingKeyIdOf(
  workingCopy: WorkingCopy,
  sign: string,
  committer: Pick<PersonIdent, "name" | "email">,
): Promise<string> {
  const config = signingConfigOf(workingCopy);
  const key = sign !== "" ? sign : config.signingKey;
  if (config.format !== "ssh") return key ?? `${committer.name} <${committer.email}>`;
  if (key === undefined) {
    throw new SigningFailedError(
      "fatal: either user.signingkey or gpg.ssh.defaultKeyCommand needs to be configured",
      sign,
      128,
    );
  }
  let text: string | undefined;
  if (key.startsWith("key::")) text = key.slice(5);
  else if (key.startsWith("ssh-")) text = key;
  else {
    const environment = hostEnvironmentOf(workingCopy);
    const path = expandUserPath(key, environment) ?? key;
    const bytes = await environment?.readFile(path).catch(() => undefined);
    text = bytes ? new TextDecoder().decode(bytes) : undefined;
  }
  const blob = text === undefined ? undefined : sshPublicKeyBlob(text);
  if (!blob) {
    throw new SigningFailedError(
      `fatal: failed to get the ssh fingerprint for key '${key}'`,
      sign,
      128,
    );
  }
  const digest = createSha256().update(blob).digest();
  return `SHA256:${btoa(String.fromCharCode(...digest)).replace(/=+$/, "")}`;
}
