/**
 * Signature checks as git's gpg-interface.c makes them (statewalker/statewalker-root#318):
 * `check_signature` over a commit's `gpgsig` header (`verify_commit_buffer`) or a tag's
 * appended signature (`parse_signature`), through the host's {@link Verifier}
 * (`GitHostEnvironment.verifier`), its output parsed as `parse_gpg_output` and
 * `parse_ssh_output` parse it. `verify-commit`, `verify-tag`, the `%G` placeholders, `log
 * --show-signature` and `merge`/`pull --verify-signatures` read their answers from here.
 *
 * Without a verifier a check goes as git's goes when its program cannot be run: `error:
 * cannot run gpg: No such file or directory` and an empty output (`%G?` is `N` for openpgp
 * and x509, `B` for ssh, whose empty output parses as a bad signature).
 *
 * @example
 * ```typescript
 * const check = await verifyCommitBytes(workingCopy, rawCommit, { cwd });
 * check.result; // "G", "B", "E", "X", "Y", "R" or "N"
 * check.output; // what `git verify-commit` prints on stderr
 * ```
 *
 * @module
 */
import { type ObjectFormat, SHA1_OBJECT_FORMAT } from "@statewalker/vcs-utils";
import type {
  SigningFormat,
  VerificationOutcome,
  WorkingCopy,
} from "@statewalker/vcs-working-tree";

import { GitApiError } from "../errors/index.js";
import { hostEnvironmentOf } from "./git-ident.js";
import { signingConfigOf } from "./signing.js";

/**
 * git's `sigc->result`: `G` good, `B` bad, `E` cannot be checked (missing key, several
 * signatures), `X` good but expired, `Y` good by an expired key, `R` good by a revoked key,
 * `N` none (or not checked further).
 */
export type SignatureResult = "G" | "B" | "E" | "X" | "Y" | "R" | "N";

/** git's `enum signature_trust_level`, as `%GT` shows it. */
export type SignatureTrustLevel = "undefined" | "never" | "marginal" | "fully" | "ultimate";

const TRUST_ORDER: readonly SignatureTrustLevel[] = [
  "undefined",
  "never",
  "marginal",
  "fully",
  "ultimate",
];

/** The rank of a trust level (git's enum value). */
export function trustRank(level: SignatureTrustLevel): number {
  return TRUST_ORDER.indexOf(level);
}

/** What git's `struct signature_check` holds after a check. */
export interface SignatureCheck {
  /** `%G?` before trust is applied (see {@link SignatureResult}) */
  result: SignatureResult;
  /** `%GT` */
  trustLevel: SignatureTrustLevel;
  /** `%GS`: the signer */
  signer?: string;
  /** `%GK`: the key */
  key?: string;
  /** `%GF`: the key's fingerprint */
  fingerprint?: string;
  /** `%GP`: the primary key's fingerprint */
  primaryKeyFingerprint?: string;
  /** `%GG`, what `verify-commit` prints on stderr (absent: nothing to show) */
  output?: string;
  /** What `verify-commit --raw` prints on stderr */
  status?: string;
  /** The payload checked (what `verify-commit -v` prints), when there was a signature */
  payload?: Uint8Array;
  /** git's non-zero `check_signature`: the signature is not good enough (or absent) */
  failed: boolean;
  /** What git printed on stderr while checking (`error: ...`, `warning: ...`) */
  messages: string[];
}

/** What is signed: the ident whose date ssh checks keys against. */
export type SignaturePayloadType = "commit" | "tag" | "other";

/** The armor lines that start a signature of each format (gpg-interface.c's `sigs`). */
const SIGNATURE_STARTS: readonly [SigningFormat, string][] = [
  ["openpgp", "-----BEGIN PGP SIGNATURE-----"],
  ["openpgp", "-----BEGIN PGP MESSAGE-----"],
  ["x509", "-----BEGIN SIGNED MESSAGE-----"],
  ["ssh", "-----BEGIN SSH SIGNATURE-----"],
];

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function startsWithBytes(bytes: Uint8Array, at: number, prefix: string): boolean {
  if (at + prefix.length > bytes.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (bytes[at + i] !== prefix.charCodeAt(i)) return false;
  }
  return true;
}

/** git's `get_format_by_sig`: the format whose armor `signature` starts with. */
export function signatureFormatAt(bytes: Uint8Array, at = 0): SigningFormat | undefined {
  for (const [format, start] of SIGNATURE_STARTS) {
    if (startsWithBytes(bytes, at, start)) return format;
  }
  return undefined;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let size = 0;
  for (const p of parts) size += p.length;
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function lineEnd(bytes: Uint8Array, at: number): number {
  const nl = bytes.indexOf(10, at);
  return nl < 0 ? bytes.length : nl + 1;
}

/**
 * git's `parse_signed_buffer`: where the last line starting a signature begins (the end of
 * `bytes` when none does).
 */
export function parseSignedBuffer(bytes: Uint8Array): number {
  let match = bytes.length;
  let at = 0;
  while (at < bytes.length) {
    if (signatureFormatAt(bytes, at)) match = at;
    at = lineEnd(bytes, at);
  }
  return match;
}

const SIGNATURE_HEADERS = ["gpgsig", "gpgsig-sha256"];

/** git's `remove_signature`: the bytes without their `gpgsig`/`gpgsig-sha256` headers. */
export function removeSignatureHeaders(bytes: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  let inSignature = false;
  let at = 0;
  while (at < bytes.length) {
    let next = lineEnd(bytes, at);
    if (inSignature && bytes[at] === 32) {
      // still inside a signature
    } else if (startsWithBytes(bytes, at, "gpgsig")) {
      for (const header of SIGNATURE_HEADERS) {
        if (startsWithBytes(bytes, at, `${header} `)) inSignature = true;
      }
    } else {
      // the message: dumped whole
      if (bytes[at] === 10) next = bytes.length;
      inSignature = false;
      parts.push(bytes.subarray(at, next));
    }
    at = next;
  }
  return concat(parts);
}

/**
 * git's `parse_signature` (a tag, a mergetag, a push certificate): the payload before the
 * signature (its own `gpgsig` headers removed) and the signature, or undefined when it has
 * none.
 */
export function parseSignature(
  bytes: Uint8Array,
): { payload: Uint8Array; signature: Uint8Array } | undefined {
  const match = parseSignedBuffer(bytes);
  if (match === bytes.length) return undefined;
  return {
    payload: removeSignatureHeaders(bytes.subarray(0, match)),
    signature: bytes.subarray(match),
  };
}

/**
 * git's `parse_buffer_signed_by_header`: a commit's payload (the commit without the
 * signature headers of every format) and the signature in `header` (`gpgsig`, or
 * `gpgsig-sha256` in a SHA-256 repository), undefined when that header is absent.
 */
export function parseBufferSignedByHeader(
  bytes: Uint8Array,
  header: string,
): { payload: Uint8Array; signature: Uint8Array } | undefined {
  const payload: Uint8Array[] = [];
  const signature: Uint8Array[] = [];
  let inSignature = false;
  let sawSignature = false;
  let otherSignature = false;
  let at = 0;
  while (at < bytes.length) {
    let next = lineEnd(bytes, at);
    let sig = -1;
    if (inSignature && bytes[at] === 32) sig = at + 1;
    else if (startsWithBytes(bytes, at, header) && bytes[at + header.length] === 32) {
      sig = at + header.length + 1;
      otherSignature = false;
    } else if (startsWithBytes(bytes, at, "gpgsig")) otherSignature = true;
    else if (otherSignature && bytes[at] !== 32) otherSignature = false;
    if (sig >= 0) {
      signature.push(bytes.subarray(sig, next));
      sawSignature = true;
      inSignature = true;
    } else {
      if (bytes[at] === 10) next = bytes.length;
      if (!otherSignature) payload.push(bytes.subarray(at, next));
      inSignature = false;
    }
    at = next;
  }
  return sawSignature ? { payload: concat(payload), signature: concat(signature) } : undefined;
}

/** git's `find_commit_header`: the value of the header `name`, before the message. */
function findHeader(bytes: Uint8Array, name: string): Uint8Array | undefined {
  let at = 0;
  while (at < bytes.length) {
    const nl = bytes.indexOf(10, at);
    const eol = nl < 0 ? bytes.length : nl;
    if (eol === at) return undefined;
    if (startsWithBytes(bytes, at, name) && bytes[at + name.length] === 32) {
      return bytes.subarray(at + name.length + 1, eol);
    }
    at = eol + 1;
  }
  return undefined;
}

/**
 * gpg-interface.c's `parse_payload_metadata`: the date of the committer (tagger) ident, 0
 * without one; undefined when the payload has no such ident (git's check then fails without
 * running anything).
 */
function payloadTimestamp(payload: Uint8Array, type: SignaturePayloadType): number | undefined {
  if (type === "other") return 0;
  const ident = findHeader(payload, type === "commit" ? "committer" : "tagger");
  if (!ident || ident.length === 0) return undefined;
  // split_ident_line: a mail between the last '<' ... '>' pair; the date after it
  const text = decoder.decode(ident);
  const lt = text.indexOf("<");
  if (lt < 0) return undefined;
  const gt = text.lastIndexOf(">");
  if (gt < lt) return undefined;
  const m = /^ *(\d+)/.exec(text.slice(gt + 1));
  return m ? Number(m[1]) : 0;
}

const STATUS_STARTS: readonly {
  result?: SignatureResult;
  check: string;
  exclusive?: boolean;
  keyId?: boolean;
  uid?: boolean;
  fingerprint?: boolean;
  trust?: boolean;
}[] = [
  { result: "G", check: "GOODSIG ", exclusive: true, keyId: true, uid: true },
  { result: "B", check: "BADSIG ", exclusive: true, keyId: true, uid: true },
  { result: "E", check: "ERRSIG ", exclusive: true, keyId: true },
  { result: "X", check: "EXPSIG ", exclusive: true, keyId: true, uid: true },
  { result: "Y", check: "EXPKEYSIG ", exclusive: true, keyId: true, uid: true },
  { result: "R", check: "REVKEYSIG ", exclusive: true, keyId: true, uid: true },
  { check: "VALIDSIG ", fingerprint: true },
  { check: "TRUST_", trust: true },
];

type ParsedFields = Pick<
  SignatureCheck,
  "result" | "trustLevel" | "signer" | "key" | "fingerprint" | "primaryKeyFingerprint"
>;

/** gpg-interface.c's `parse_gpg_output` over gpg's status lines. */
export function parseGpgOutput(status: string, check: ParsedFields): void {
  const buf = status;
  const end = buf.length;
  // strchrnul over the buffer
  const chrnul = (from: number, ch: string) => {
    const i = buf.indexOf(ch, from);
    return i < 0 ? end : i;
  };
  let seenExclusive = 0;
  let line = 0;
  const fail = () => {
    check.result = "E";
    delete check.primaryKeyFingerprint;
    delete check.fingerprint;
    delete check.signer;
    delete check.key;
  };
  while (line < end) {
    while (buf[line] === "\n") line++;
    if (line >= end) break;
    if (buf.startsWith("[GNUPG:] ", line)) {
      line += 9;
      for (const s of STATUS_STARTS) {
        if (!buf.startsWith(s.check, line)) continue;
        line += s.check.length;
        if (s.exclusive && seenExclusive++) {
          fail();
          return;
        }
        if (s.result) check.result = s.result;
        if (s.keyId) {
          let next = chrnul(line, " ");
          check.key = buf.slice(line, next);
          if (next < end && s.uid) {
            line = next + 1;
            next = chrnul(line, "\n");
            check.signer = buf.slice(line, next);
          }
        }
        if (s.trust) {
          let size = 0;
          while (line + size < end && buf[line + size] !== " " && buf[line + size] !== "\n") size++;
          const trust = buf.slice(line, line + size).toLowerCase() as SignatureTrustLevel;
          if (
            buf.slice(line, line + size) !== trust.toUpperCase() ||
            !TRUST_ORDER.includes(trust)
          ) {
            fail();
            return;
          }
          check.trustLevel = trust;
        }
        if (s.fingerprint) {
          let next = chrnul(line, " ");
          check.fingerprint = buf.slice(line, next);
          const limit = chrnul(line, "\n");
          let j = 9;
          for (; j > 0; j--) {
            if (next >= end || limit <= next) break;
            line = next + 1;
            next = chrnul(line, " ");
          }
          if (!j) {
            next = chrnul(line, "\n");
            check.primaryKeyFingerprint = buf.slice(line, next);
          } else delete check.primaryKeyFingerprint;
        }
        break;
      }
    }
    // the next line: strchrnul(line + 1, '\n')
    line = line + 1 > end ? end : chrnul(line + 1, "\n");
  }
}

/** gpg-interface.c's `parse_ssh_output` over the first line of ssh-keygen's output. */
export function parseSshOutput(output: string, check: ParsedFields): void {
  check.result = "B";
  check.trustLevel = "never";
  const nl = output.indexOf("\n");
  let line = nl < 0 ? output : output.slice(0, nl);
  const forPrefix = 'Good "git" signature for ';
  const withPrefix = 'Good "git" signature with ';
  if (line.startsWith(forPrefix)) {
    line = line.slice(forPrefix.length);
    const principal = line;
    let at = 0;
    for (;;) {
      const search = line.indexOf(" with ", at);
      if (search < 0) break;
      at = search + 1;
    }
    if (at === 0) return;
    check.result = "G";
    check.trustLevel = "fully";
    check.signer = principal.slice(0, at - 1);
    line = line.slice(at);
  } else if (line.startsWith(withPrefix)) {
    check.result = "G";
    check.trustLevel = "undefined";
    line = line.slice(withPrefix.length);
  } else return;
  const key = line.indexOf("key ");
  if (key >= 0) {
    check.fingerprint = line.slice(key + 4);
    check.key = check.fingerprint;
  } else check.result = "B";
}

/** Where a check runs and what it is of. */
export interface CheckSignatureOptions {
  /** What is signed (default `other`: no ident, no time for ssh) */
  payloadType?: SignaturePayloadType;
  /** The host directory the program runs in (the worktree top) */
  cwd?: string;
}

/** git's `start_command` failure of a program it cannot find. */
function cannotRun(program: string): string {
  return program.includes("/")
    ? `error: cannot exec '${program}': No such file or directory`
    : `error: cannot run ${program}: No such file or directory`;
}

/** What git's verification does when its program cannot be run (no verifier). */
function withoutVerifier(format: SigningFormat, program: string): VerificationOutcome {
  if (format !== "ssh") {
    return { failed: true, output: "", status: "", messages: [cannotRun(program)] };
  }
  // find-principals cannot run, nor can check-novalidate
  return {
    failed: true,
    output: "",
    status: "",
    messages: [cannotRun(program), cannotRun(program)],
  };
}

/**
 * git's `check_signature`: `signature` over `payload` checked through the host's verifier
 * with the configuration's program, its output parsed, the result held to
 * `gpg.minTrustLevel`.
 *
 * @throws GitApiError `fatal: bad/incompatible signature '<signature>'` (exit 128) for a
 *   signature of no known format, as git dies
 * @throws InvalidConfigError for a bad signing variable
 */
export async function checkSignature(
  workingCopy: WorkingCopy,
  payload: Uint8Array,
  signature: Uint8Array,
  options: CheckSignatureOptions = {},
): Promise<SignatureCheck> {
  const check: SignatureCheck = {
    result: "N",
    trustLevel: "undefined",
    payload,
    failed: true,
    messages: [],
  };
  const format = signatureFormatAt(signature);
  if (!format) {
    const text = decoder.decode(signature);
    const nul = text.indexOf("\0");
    throw new GitApiError(
      `fatal: bad/incompatible signature '${nul < 0 ? text : text.slice(0, nul)}'`,
      { exitCode: 128 },
    );
  }
  const time = payloadTimestamp(payload, options.payloadType ?? "other");
  if (time === undefined) return check;
  const config = signingConfigOf(workingCopy);
  const program = config.programs[format];
  let outcome: VerificationOutcome;
  if (format === "ssh" && config.allowedSignersFile === undefined) {
    check.messages.push(
      "error: gpg.ssh.allowedSignersFile needs to be configured and exist for ssh signature verification",
    );
    return check;
  }
  const verifier = hostEnvironmentOf(workingCopy)?.verifier;
  if (verifier) {
    outcome = await verifier({
      format,
      payload,
      signature,
      program,
      ...(config.allowedSignersFile !== undefined
        ? { allowedSignersFile: config.allowedSignersFile }
        : {}),
      ...(config.revocationFile !== undefined ? { revocationFile: config.revocationFile } : {}),
      ...(time ? { verifyTime: time } : {}),
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    });
  } else outcome = withoutVerifier(format, program);
  if (outcome.messages) check.messages.push(...outcome.messages);
  if (outcome.output !== undefined) {
    check.output = outcome.output;
    check.status = outcome.status ?? outcome.output;
    if (format === "ssh") parseSshOutput(outcome.output, check);
    else parseGpgOutput(check.status, check);
  }
  let failed = outcome.failed;
  if (failed && check.output === undefined) {
    check.failed = true;
    return check;
  }
  // git 2.43 takes only G for good; 2.5x a good signature by an expired key too
  const legacy = verifier?.compatibility === "2.43";
  failed ||= check.result !== "G" && (legacy || check.result !== "Y");
  if (config.minTrustLevel !== undefined) {
    failed ||= trustRank(check.trustLevel) < trustRank(config.minTrustLevel as SignatureTrustLevel);
  }
  check.failed = failed;
  return check;
}

/**
 * git's `verify_commit_buffer`: the signature in the commit's `gpgsig` header
 * (`gpgsig-sha256` in a SHA-256 repository) checked over the rest; result `N` and a failure
 * when it has none.
 */
export async function verifyCommitBytes(
  workingCopy: WorkingCopy,
  bytes: Uint8Array,
  options: { objectFormat?: ObjectFormat; cwd?: string } = {},
): Promise<SignatureCheck> {
  const header = (options.objectFormat ?? SHA1_OBJECT_FORMAT).signatureHeader;
  const parsed = parseBufferSignedByHeader(bytes, header);
  if (!parsed) return { result: "N", trustLevel: "undefined", failed: true, messages: [] };
  return checkSignature(workingCopy, parsed.payload, parsed.signature, {
    payloadType: "commit",
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
  });
}

/**
 * tag.c's `run_gpg_verify`: the signature appended to a tag checked over the tag before it;
 * undefined when the tag has none.
 */
export async function verifyTagBytes(
  workingCopy: WorkingCopy,
  bytes: Uint8Array,
  options: { cwd?: string } = {},
): Promise<SignatureCheck | undefined> {
  const parsed = parseSignature(bytes);
  if (!parsed) return undefined;
  return checkSignature(workingCopy, parsed.payload, parsed.signature, {
    payloadType: "tag",
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
  });
}

/** pretty.c's `%G?`: `U` for a good signature of undefined or never trust. */
export function signatureLetter(check: SignatureCheck): string {
  if (check.result === "G") {
    return check.trustLevel === "undefined" || check.trustLevel === "never" ? "U" : "G";
  }
  return check.result;
}

/** The `mergetag` headers of a commit, each tag object's bytes. */
export function mergetagsOf(bytes: Uint8Array): Uint8Array[] {
  const tags: Uint8Array[] = [];
  let current: Uint8Array[] | undefined;
  let at = 0;
  while (at < bytes.length) {
    const next = lineEnd(bytes, at);
    if (bytes[at] === 10) break;
    if (current && bytes[at] === 32) current.push(bytes.subarray(at + 1, next));
    else {
      if (current) tags.push(concat(current));
      current = undefined;
      if (startsWithBytes(bytes, at, "mergetag ")) current = [bytes.subarray(at + 9, next)];
    }
    at = next;
  }
  if (current) tags.push(concat(current));
  // the header's value has no final newline of its own: read_commit_extra_header_lines keeps
  // each continuation's, so the tag ends with its last line's newline
  return tags;
}

/** `text` as bytes. */
export function bytesOf(text: string): Uint8Array {
  return encoder.encode(text);
}

/**
 * `merge --verify-signatures` refusing a commit (commit.c's `verify_merge_signature`): git's
 * lines (what the check printed, then `fatal: Commit <id> ...`), exit 128.
 */
export class SignatureVerificationError extends GitApiError {
  /** The commit refused */
  readonly commitId: string;
  /** Its check */
  readonly check: SignatureCheck;

  constructor(message: string, commitId: string, check: SignatureCheck) {
    super(message, { exitCode: 128 });
    this.name = "SignatureVerificationError";
    this.commitId = commitId;
    this.check = check;
  }
}

/**
 * commit.c's `verify_merge_signature`: the commit's signature must be good (and, with
 * `checkTrust`, of at least marginal trust; `gpg.minTrustLevel` set turns that off and
 * `check_signature` holds the result to it instead). Returns git's stdout line for a good
 * one, `Commit <abbrev> has a good GPG signature by <signer>`.
 *
 * @throws SignatureVerificationError with git's death: `Commit <abbrev> has an untrusted GPG
 *   signature, allegedly by <signer>.`, `... has a bad GPG signature allegedly by <signer>.`,
 *   `... does not have a GPG signature.`
 */
export async function verifyMergeSignature(
  workingCopy: WorkingCopy,
  bytes: Uint8Array | undefined,
  options: {
    commitId: string;
    abbreviated: string;
    objectFormat?: ObjectFormat;
    cwd?: string;
    checkTrust: boolean;
  },
): Promise<string> {
  const check: SignatureCheck = bytes
    ? await verifyCommitBytes(workingCopy, bytes, {
        ...(options.objectFormat ? { objectFormat: options.objectFormat } : {}),
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      })
    : { result: "N", trustLevel: "undefined", failed: true, messages: [] };
  const hex = options.abbreviated;
  const signer = check.signer ?? "(null)";
  const die = (line: string): never => {
    throw new SignatureVerificationError(
      [...check.messages, `fatal: ${line}`].join("\n"),
      options.commitId,
      check,
    );
  };
  switch (check.result) {
    case "G":
      if (
        check.failed ||
        (options.checkTrust && trustRank(check.trustLevel) < trustRank("marginal"))
      )
        die(`Commit ${hex} has an untrusted GPG signature, allegedly by ${signer}.`);
      break;
    case "B":
      die(`Commit ${hex} has a bad GPG signature allegedly by ${signer}.`);
      break;
    default:
      die(`Commit ${hex} does not have a GPG signature.`);
  }
  return `Commit ${hex} has a good GPG signature by ${signer}`;
}

/** An object's bytes as stored (undefined when absent or unreadable). */
export async function readStoredObjectBytes(
  workingCopy: WorkingCopy,
  id: string,
): Promise<Uint8Array | undefined> {
  const objects = workingCopy.history?.objects;
  if (!objects) return undefined;
  try {
    const obj = await objects.get(id);
    if (!obj) return undefined;
    const chunks: Uint8Array[] = [];
    for await (const c of obj.content) chunks.push(c);
    return concat(chunks);
  } catch {
    return undefined;
  }
}
