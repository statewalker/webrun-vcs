/**
 * An in-process ssh verifier: what git's `verify_ssh_signed_buffer` gets from `ssh-keygen -Y
 * find-principals`, `-Y verify` and `-Y check-novalidate` for Ed25519 signatures, checked
 * with Web Crypto, for hosts that cannot run ssh-keygen (a browser, a worker). It reads
 * `gpg.ssh.allowedSignersFile` (principals with `*`/`?` patterns, `namespaces=`,
 * `valid-after=`, `valid-before=`; `cert-authority` lines are skipped) and
 * `gpg.ssh.revocationFile` (public keys, one per line) through the host callback given, and
 * answers with ssh-keygen's lines, so the commands parse its output as they parse
 * ssh-keygen's.
 *
 * Not supported: keys other than Ed25519 (checked as bad signatures), certificates, and
 * binary KRL revocation files (every key counts as revoked then, the safe answer).
 *
 * @example
 * ```typescript
 * const verifier = createSshVerifier({ readFile: (path) => readText(files, path) });
 * const environment = { ...hostEnvironment, verifier };
 * ```
 */
import type {
  VerificationOutcome,
  VerificationRequest,
  Verifier,
} from "@statewalker/vcs-working-tree";

/** Where the verifier reads the allowed signers and revocation files. */
export interface SshVerifierOptions {
  /** A host file's text (a path as the configuration gives it), undefined when missing */
  readFile(path: string): Promise<string | undefined>;
  /**
   * The local time zone's offset east of UTC, in minutes, at a time in seconds: validity
   * dates without `Z` and verify times are local (default: the host's)
   */
  localTzOffset?: (time: number) => number;
  /** The git version whose rules the commands follow (see `Verifier`) */
  compatibility?: "2.43" | "2.56";
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAGIC = "SSHSIG";

class Reader {
  at = 0;
  constructor(readonly bytes: Uint8Array) {}
  uint32(): number {
    if (this.at + 4 > this.bytes.length) throw new Error("truncated");
    const v = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.at, 4).getUint32(0);
    this.at += 4;
    return v;
  }
  string(): Uint8Array {
    const n = this.uint32();
    if (this.at + n > this.bytes.length) throw new Error("truncated");
    const v = this.bytes.subarray(this.at, this.at + n);
    this.at += n;
    return v;
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function sshString(value: Uint8Array | string): Uint8Array {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length);
  out.set(bytes, 4);
  return out;
}

function fromBase64(text: string): Uint8Array | undefined {
  try {
    const binary = atob(text.replace(/\s+/g, ""));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return undefined;
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

const buffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

interface ParsedSignature {
  publicBlob: Uint8Array;
  namespace: string;
  hashAlgorithm: string;
  keyType: string;
  raw: Uint8Array;
}

/** sshsig.c's `sshsig_dearmor` and `sshsig_parse_preamble`/`sshsig_get_pubkey`. */
function parseSignature(armored: Uint8Array): ParsedSignature | undefined {
  const text = decoder.decode(armored);
  const m = /-----BEGIN SSH SIGNATURE-----\r?\n([\s\S]*?)-----END SSH SIGNATURE-----/.exec(text);
  const blob = m && fromBase64(m[1] as string);
  if (!blob || blob.length < 10 || decoder.decode(blob.subarray(0, 6)) !== MAGIC) return undefined;
  try {
    const r = new Reader(blob.subarray(6));
    if (r.uint32() !== 1) return undefined;
    const publicBlob = r.string();
    const namespace = decoder.decode(r.string());
    r.string(); // reserved
    const hashAlgorithm = decoder.decode(r.string());
    const sig = new Reader(r.string());
    const keyType = decoder.decode(sig.string());
    const raw = sig.string();
    return { publicBlob, namespace, hashAlgorithm, keyType, raw };
  } catch {
    return undefined;
  }
}

/** `SHA256:<base64>` of a key blob, as ssh-keygen prints fingerprints. */
async function fingerprint(blob: Uint8Array): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", buffer(blob)));
  return `SHA256:${toBase64(hash).replace(/=+$/, "")}`;
}

/** The key type a blob names. */
function keyTypeOf(blob: Uint8Array): string {
  try {
    return decoder.decode(new Reader(blob).string());
  } catch {
    return "";
  }
}

/** ssh-keygen's name of a key type in its messages (`sshkey_type`). */
function keyTypeName(type: string): string {
  const names: Record<string, string> = {
    "ssh-ed25519": "ED25519",
    "ssh-rsa": "RSA",
    "ecdsa-sha2-nistp256": "ECDSA",
    "ecdsa-sha2-nistp384": "ECDSA",
    "ecdsa-sha2-nistp521": "ECDSA",
    "sk-ssh-ed25519@openssh.com": "ED25519-SK",
    "sk-ecdsa-sha2-nistp256@openssh.com": "ECDSA-SK",
  };
  return names[type] ?? type;
}

/** The SSHSIG checked over `payload` (Ed25519 only). */
async function signatureHolds(sig: ParsedSignature, payload: Uint8Array): Promise<boolean> {
  if (sig.keyType !== "ssh-ed25519" || keyTypeOf(sig.publicBlob) !== "ssh-ed25519") return false;
  if (sig.hashAlgorithm !== "sha512" && sig.hashAlgorithm !== "sha256") return false;
  const r = new Reader(sig.publicBlob);
  r.string();
  const publicKey = r.string();
  if (publicKey.length !== 32 || sig.raw.length !== 64) return false;
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      sig.hashAlgorithm === "sha512" ? "SHA-512" : "SHA-256",
      buffer(payload),
    ),
  );
  const signed = concat([
    encoder.encode(MAGIC),
    sshString(sig.namespace),
    sshString(""),
    sshString(sig.hashAlgorithm),
    sshString(digest),
  ]);
  try {
    const key = await crypto.subtle.importKey("raw", buffer(publicKey), "Ed25519", false, [
      "verify",
    ]);
    return await crypto.subtle.verify("Ed25519", key, buffer(sig.raw), buffer(signed));
  } catch {
    return false;
  }
}

/** OpenSSH's `match_pattern`: `*` and `?` wildcards. */
function matchPattern(text: string, pattern: string): boolean {
  let re = "^";
  for (const c of pattern) {
    if (c === "*") re += ".*";
    else if (c === "?") re += ".";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${re}$`, "s").test(text);
}

/** OpenSSH's `match_pattern_list`: comma-separated patterns, `!` negating. */
function matchPatternList(text: string, list: string): boolean {
  let matched = false;
  for (const raw of list.split(",")) {
    const negated = raw.startsWith("!");
    const pattern = negated ? raw.slice(1) : raw;
    if (matchPattern(text, pattern)) {
      if (negated) return false;
      matched = true;
    }
  }
  return matched;
}

interface AllowedLine {
  line: number;
  principals: string;
  options: Map<string, string | true>;
  blob: Uint8Array | undefined;
}

/** Splits `text` at the first unquoted whitespace (OpenSSH's option scanning). */
function takeField(text: string): [string, string] {
  let quoted = false;
  let i = 0;
  for (; i < text.length; i++) {
    const c = text[i] as string;
    if (c === '"') quoted = !quoted;
    else if (c === "\\" && quoted) i++;
    else if (!quoted && (c === " " || c === "\t")) break;
  }
  return [text.slice(0, i), text.slice(i).replace(/^[ \t]+/, "")];
}

/** sshsig.c's allowed signers lines (`parse_principals_key_and_options`). */
function parseAllowedSigners(text: string): AllowedLine[] {
  const out: AllowedLine[] = [];
  const lines = text.split("\n");
  for (let n = 0; n < lines.length; n++) {
    const line = (lines[n] as string).replace(/\r$/, "").replace(/^[ \t]+/, "");
    if (line === "" || line.startsWith("#")) continue;
    const [principals, rest] = takeField(line);
    let remaining = rest;
    const options = new Map<string, string | true>();
    // options come before the key type when the next word is not one
    if (!/^(ssh-|ecdsa-|sk-)/.test(remaining)) {
      const [opts, after] = takeField(remaining);
      remaining = after;
      for (const opt of opts.match(/(?:[^,"]|"[^"]*")+/g) ?? []) {
        const eq = opt.indexOf("=");
        if (eq < 0) options.set(opt.toLowerCase(), true);
        else options.set(opt.slice(0, eq).toLowerCase(), opt.slice(eq + 1).replace(/^"|"$/g, ""));
      }
    }
    const [, base64] = remaining.split(/[ \t]+/);
    out.push({ line: n + 1, principals, options, blob: base64 ? fromBase64(base64) : undefined });
  }
  return out;
}

/** OpenSSH's `parse_absolute_time`: YYYYMMDD[HHMM[SS]][Z], local unless Z. */
function parseValidity(value: string, tz: (t: number) => number): number | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2})?)?(Z?)$/.exec(value);
  if (!m) return undefined;
  const utc =
    Date.UTC(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4] ?? 0),
      Number(m[5] ?? 0),
      Number(m[6] ?? 0),
    ) / 1000;
  if (m[7] === "Z") return utc;
  return utc - tz(utc) * 60;
}

/** OpenSSH's `format_absolute_time`: local `%Y-%m-%dT%H:%M:%S`. */
function formatTime(seconds: number, tz: (t: number) => number): string {
  const d = new Date((seconds + tz(seconds) * 60) * 1000);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}T${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}`;
}

/** git's `strbuf_stripspace`. */
function stripSpace(text: string): string {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  let out = "";
  let empties = 0;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (line === "") {
      empties++;
      continue;
    }
    if (out !== "" && empties > 0) out += "\n";
    empties = 0;
    out += `${line}\n`;
  }
  return out;
}

/**
 * A verifier for ssh signatures (`gpg.format=ssh`) without ssh-keygen: Ed25519 signatures
 * checked with Web Crypto against `gpg.ssh.allowedSignersFile` and
 * `gpg.ssh.revocationFile`, its output ssh-keygen's. openpgp and x509 signatures go as when
 * gpg cannot be run.
 */
export function createSshVerifier(options: SshVerifierOptions): Verifier {
  const tz = options.localTzOffset ?? ((t: number) => -new Date(t * 1000).getTimezoneOffset());
  const verifier: Verifier = async (request: VerificationRequest): Promise<VerificationOutcome> => {
    if (request.format !== "ssh") {
      return {
        failed: true,
        output: "",
        status: "",
        messages: [`error: cannot run ${request.program}: No such file or directory`],
      };
    }
    const messages: string[] = [];
    const allowedPath = request.allowedSignersFile ?? "";
    const sig = parseSignature(request.signature);
    const time = request.verifyTime;
    // find-principals
    let principalsOut = "";
    let principalsErr = "";
    const allowedText = await options.readFile(allowedPath);
    const allowed = allowedText === undefined ? [] : parseAllowedSigners(allowedText);
    if (allowedText === undefined) {
      principalsErr += `${allowedPath}: No such file or directory\n`;
    }
    const validAt = (entry: AllowedLine, label: string): boolean => {
      if (time === undefined) return true;
      const after = entry.options.get("valid-after");
      const before = entry.options.get("valid-before");
      if (typeof after === "string") {
        const t = parseValidity(after, tz);
        if (t !== undefined && time < t) {
          principalsErr += `${label}:${entry.line}: key is not yet valid: verify time ${formatTime(time, tz)} < valid-after ${formatTime(t, tz)}\r\n`;
          return false;
        }
      }
      if (typeof before === "string") {
        const t = parseValidity(before, tz);
        if (t !== undefined && time > t) {
          principalsErr += `${label}:${entry.line}: key has expired: verify time ${formatTime(time, tz)} > valid-before ${formatTime(t, tz)}\r\n`;
          return false;
        }
      }
      return true;
    };
    const matches = sig
      ? allowed.filter(
          (e) =>
            !e.options.has("cert-authority") &&
            e.blob !== undefined &&
            sameBytes(e.blob, sig.publicBlob) &&
            validAt(e, allowedPath),
        )
      : [];
    if (matches.length > 0) principalsOut = matches.map((e) => `${e.principals}\n`).join("");
    else if (sig) principalsErr += "No principal matched.\n";
    else principalsErr += "Couldn't parse signature: invalid format\n";

    let out = "";
    let err = "";
    let failed = true;
    const keyLine = async (blob: Uint8Array) =>
      `${keyTypeName(keyTypeOf(blob))} key ${await fingerprint(blob)}`;
    if (principalsOut === "") {
      // check-novalidate
      if (sig && sig.namespace === "git" && (await signatureHolds(sig, request.payload))) {
        out = `Good "git" signature with ${await keyLine(sig.publicBlob)}\n`;
      } else if (sig) {
        out = "Could not verify signature.\n";
        err = "Signature verification failed: incorrect signature\n";
      } else {
        err = "Couldn't parse signature: invalid format\n";
      }
    } else if (sig) {
      failed = false;
      for (const principal of principalsOut.split("\n")) {
        if (principal === "") continue;
        out = "";
        err = "";
        let revoked = false;
        if (request.revocationFile !== undefined) {
          const text = await options.readFile(request.revocationFile);
          if (text === undefined) {
            messages.push(
              `warning: ssh signing revocation file configured but not found: ${request.revocationFile}`,
            );
          } else if (text.startsWith("SSHKRL\n")) revoked = true;
          else {
            for (const entry of parseAllowedSigners(`x ${text.split("\n").join("\nx ")}`)) {
              if (entry.blob && sameBytes(entry.blob, sig.publicBlob)) revoked = true;
            }
          }
        }
        const entry = matches.find((e) => e.principals === principal);
        const namespaces = entry?.options.get("namespaces");
        const nsOk = typeof namespaces !== "string" || matchPatternList("git", namespaces);
        if (revoked || !entry || !nsOk || sig.namespace !== "git") {
          out = "Could not verify signature.\n";
        } else if (!(await signatureHolds(sig, request.payload))) {
          out = "Could not verify signature.\n";
          err = "Signature verification failed: incorrect signature\n";
        } else {
          // the principal asked for is one of the line's patterns: reported as asked
          out = `Good "git" signature for ${principal} with ${await keyLine(sig.publicBlob)}\n`;
        }
        failed = !out.startsWith("Good");
        if (!failed) break;
      }
    }
    const output = stripSpace(out) + principalsErr + stripSpace(err);
    return { failed, output, status: output, ...(messages.length ? { messages } : {}) };
  };
  if (options.compatibility) verifier.compatibility = options.compatibility;
  return verifier;
}
