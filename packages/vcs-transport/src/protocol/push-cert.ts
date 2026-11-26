/**
 * Push certificates (`git push --signed`, receive-pack's `push-cert`): what both ends of
 * git's send-pack.c and builtin/receive-pack.c compute over a certificate's text.
 *
 * A certificate is the text send-pack signs and sends in place of its commands:
 *
 * ```text
 * certificate version 0.1
 * pusher C O Mitter <committer@example.com> 1112912653 -0700
 * pushee ../dst
 * nonce 1112912653-1f3a...
 * push-option asdf
 *
 * <old> <new> refs/heads/main
 * -----BEGIN PGP SIGNATURE-----
 * ...
 * ```
 *
 * receive-pack advertises `push-cert=<nonce>` when `receive.certNonceSeed` is set
 * ({@link pushCertNonce}), reads the commands from the certificate
 * ({@link pushCertCommandLines}) and tells its hooks how the nonce compares
 * ({@link checkPushCertNonce}).
 */
import { type ObjectFormat, SHA1_OBJECT_FORMAT } from "@statewalker/vcs-utils";

/** git's `nonce_status` values (`GIT_PUSH_CERT_NONCE_STATUS`). */
export type PushCertNonceStatus = "UNSOLICITED" | "MISSING" | "BAD" | "OK" | "SLOP";

/** The lines that start a signature (gpg-interface.c's `gpg_format[].sigs`). */
const SIGNATURE_STARTS = [
  "-----BEGIN PGP SIGNATURE-----",
  "-----BEGIN PGP MESSAGE-----",
  "-----BEGIN SIGNED MESSAGE-----",
  "-----BEGIN SSH SIGNATURE-----",
];

/** git's `GIT_MAX_BLKSZ`: the block size of SHA-1 and SHA-256 */
const BLOCK_SIZE = 64;

const encoder = new TextEncoder();

/**
 * git's `hmac_hash` (receive-pack.c, RFC 2104 over the repository's hash) with its arguments
 * as `prepare_push_cert_nonce` passes them: `key` first, `text` second.
 */
function hmacHash(format: ObjectFormat, key: Uint8Array, text: Uint8Array): Uint8Array {
  const block = new Uint8Array(BLOCK_SIZE);
  if (key.length > BLOCK_SIZE) block.set(format.createUnsafeHasher().update(key).digest());
  else block.set(key);
  const ipad = block.map((b) => b ^ 0x36);
  const opad = block.map((b) => b ^ 0x5c);
  const inner = format.createUnsafeHasher().update(ipad).update(text).digest();
  return format.createUnsafeHasher().update(opad).update(inner).digest();
}

/**
 * git's `prepare_push_cert_nonce`: `<stamp>-<hmac>`, the HMAC keyed by `<dir>:<stamp>` over
 * the seed (git passes them in this order), in the repository's hash (`hexsz` digits).
 * `dir` is the directory receive-pack was started on (its argument: `.` under http-backend).
 *
 * @example
 * ```ts
 * pushCertNonce("sekrit", ".", 1700000000); // "1700000000-<40 hex digits>"
 * ```
 */
export function pushCertNonce(
  seed: string,
  dir: string,
  stamp: number,
  format: ObjectFormat = SHA1_OBJECT_FORMAT,
): string {
  const hash = hmacHash(format, encoder.encode(`${dir}:${stamp}`), encoder.encode(seed));
  const hex = Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${stamp}-${hex.slice(0, format.hexLength)}`;
}

/**
 * git's `parse_signed_buffer`: where the last line starting a signature begins (the length
 * of `text` when none does).
 */
export function signedTextEnd(text: string): number {
  let match = text.length;
  let at = 0;
  while (at < text.length) {
    if (SIGNATURE_STARTS.some((start) => text.startsWith(start, at))) match = at;
    const nl = text.indexOf("\n", at);
    at = nl < 0 ? text.length : nl + 1;
  }
  return match;
}

/**
 * git's `find_header_mem`: the value of the first header line `<key> <value>` before the first
 * empty line of `text` from `from` on, with where the line after it starts; undefined when
 * there is none.
 */
export function pushCertHeader(
  text: string,
  key: string,
  from = 0,
): { value: string; next: number } | undefined {
  let line = from;
  while (line < text.length) {
    let eol = text.indexOf("\n", line);
    if (eol < 0) eol = text.length;
    if (eol === line) return undefined;
    if (eol - line > key.length && text.startsWith(key, line) && text[line + key.length] === " ") {
      return {
        value: text.slice(line + key.length + 1, eol),
        next: Math.min(eol + 1, text.length),
      };
    }
    line = eol + 1;
  }
  return undefined;
}

/**
 * The command lines of a certificate (receive-pack's `queue_commands_from_cert`): the lines
 * after its first empty line, up to its signature; undefined for a certificate without an
 * empty line (git dies: `malformed push certificate <first 100 bytes>`).
 */
export function pushCertCommandLines(certificate: string): string[] | undefined {
  const blank = certificate.indexOf("\n\n");
  if (blank < 0) return undefined;
  const end = signedTextEnd(certificate);
  const lines: string[] = [];
  let at = blank + 2;
  while (at < end) {
    const nl = certificate.indexOf("\n", at);
    const eol = nl < 0 || nl > end ? end : nl;
    lines.push(certificate.slice(at, eol));
    at = eol === end ? end : eol + 1;
  }
  return lines;
}

/**
 * receive-pack's `check_cert_push_options`: whether the certificate's `push-option` headers
 * are exactly the push options sent (a push without a certificate always passes).
 */
export function pushCertOptionsMatch(
  certificate: string | undefined,
  pushOptions: readonly string[],
): boolean {
  if (!certificate) return true;
  let seen = 0;
  let from = 0;
  for (
    let header = pushCertHeader(certificate, "push-option", from);
    header;
    header = pushCertHeader(certificate, "push-option", from)
  ) {
    from = header.next;
    seen++;
    if (seen > pushOptions.length || header.value !== pushOptions[seen - 1]) return false;
  }
  return seen === pushOptions.length;
}

/** What receive-pack's `check_nonce` decides. */
export interface PushCertNonceCheck {
  status: PushCertNonceStatus;
  /**
   * The nonce the hooks are told (`GIT_PUSH_CERT_NONCE`): the one advertised, or the received
   * one when it is accepted within the slop; undefined when none was advertised
   */
  nonce?: string;
  /** `GIT_PUSH_CERT_NONCE_SLOP`: the seconds between the two nonces (status `SLOP` only) */
  slop?: number;
}

/** What {@link checkPushCertNonce} compares. */
export interface CheckPushCertNonceOptions {
  /** The signed part of the certificate (before its signature) */
  payload: string;
  /** The nonce this receive-pack advertised (undefined: no `receive.certNonceSeed`) */
  advertised?: string;
  /** `receive.certNonceSeed` */
  seed?: string;
  /** The directory receive-pack runs on, as in {@link pushCertNonce} */
  dir: string;
  /** Over smart HTTP (another receive-pack may have advertised the nonce) */
  stateless: boolean;
  /** `receive.certNonceSlop` in seconds (0: none) */
  slopLimit?: number;
  /** The repository's object format (the HMAC's hash) */
  format?: ObjectFormat;
}

/** strtoumax's prefix of digits (undefined: none), as git's `parse_timestamp`. */
function leadingNumber(text: string): { value: number; end: number } | undefined {
  const m = /^\d+/.exec(text);
  return m ? { value: Number(m[0]), end: m[0].length } : undefined;
}

/**
 * receive-pack's `check_nonce`: the certificate's `nonce` header against the nonce advertised.
 * Stateless (smart HTTP), a nonce another receive-pack of the same repository and seed issued
 * is recomputed from its stamp: `OK` within `receive.certNonceSlop` seconds (the hooks are then
 * told that nonce), `SLOP` beyond it.
 *
 * @example
 * ```ts
 * checkPushCertNonce({ payload, advertised, seed, dir: ".", stateless: false }).status; // "OK"
 * ```
 */
export function checkPushCertNonce(options: CheckPushCertNonceOptions): PushCertNonceCheck {
  const { advertised } = options;
  const result = (status: PushCertNonceStatus, nonce = advertised): PushCertNonceCheck =>
    nonce === undefined ? { status } : { status, nonce };
  const header = pushCertHeader(options.payload, "nonce");
  if (!header) return result("MISSING");
  const nonce = header.value;
  if (advertised === undefined || options.seed === undefined) return result("UNSOLICITED");
  if (nonce === advertised) return result("OK");
  if (!options.stateless) return result("BAD");
  // nonce is concat(<seconds-since-epoch>, "-", <hmac>)
  if (!/^[1-9]/.test(nonce)) return result("BAD");
  const stamp = leadingNumber(nonce);
  if (!stamp || nonce[stamp.end] !== "-") return result("BAD");
  if (pushCertNonce(options.seed, options.dir, stamp.value, options.format) !== nonce) {
    return result("BAD");
  }
  const ours = leadingNumber(advertised)?.value ?? 0;
  const slop = ours - stamp.value;
  if (options.slopLimit && Math.abs(slop) <= options.slopLimit) return result("OK", nonce);
  return { ...result("SLOP"), slop };
}

/** send-pack's `NONCE_LEN_LIMIT` */
const NONCE_LEN_LIMIT = 256;

/**
 * send-pack's `reject_invalid_nonce`: whether a server's nonce may be signed (shorter than 256
 * bytes, only `[A-Za-z0-9-./+=_]`); git dies on another one: `the receiving end asked to sign
 * an invalid nonce <nonce>`.
 */
export function isValidPushCertNonce(nonce: string): boolean {
  return nonce.length < NONCE_LEN_LIMIT && /^[A-Za-z0-9\-./+=_]*$/.test(nonce);
}

/** What send-pack's `generate_push_cert` writes before signing. */
export interface PushCertificateFields {
  /** `get_signing_key_id()`: the key id, else the committer as `Name <email>` */
  pusher: string;
  /** The pusher's date: seconds since the epoch */
  timestamp: number;
  /** Its zone as git writes it (`-0700`) */
  tzOffset: string;
  /** The remote's URL, its credentials left out (none: no `pushee` line) */
  pushee?: string;
  /** The nonce the server advertised */
  nonce: string;
  /** The push options (`push-option` lines) */
  pushOptions?: readonly string[];
  /** `<old> <new> <ref>` of every command sent */
  updates: readonly { oldOid: string; newOid: string; remoteRef: string }[];
}

/** send-pack's `generate_push_cert`: the certificate's text before its signature. */
export function buildPushCertificate(fields: PushCertificateFields): string {
  let cert = "certificate version 0.1\n";
  cert += `pusher ${fields.pusher} ${fields.timestamp} ${fields.tzOffset}\n`;
  if (fields.pushee) cert += `pushee ${fields.pushee}\n`;
  // a bare `push-cert` (no nonce) writes no nonce line
  if (fields.nonce) cert += `nonce ${fields.nonce}\n`;
  for (const option of fields.pushOptions ?? []) cert += `push-option ${option}\n`;
  cert += "\n";
  for (const u of fields.updates) cert += `${u.oldOid} ${u.newOid} ${u.remoteRef}\n`;
  return cert;
}
