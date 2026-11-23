/**
 * An in-process ssh signer: what `ssh-keygen -Y sign -n git -f <key>` writes for an Ed25519
 * key, made with Web Crypto, for hosts that cannot run ssh-keygen (a browser, a worker).
 * Ed25519 signatures are deterministic, so its signatures are byte for byte ssh-keygen's.
 */
import type { Signer, SigningOutcome, SigningRequest } from "@statewalker/vcs-working-tree";

/** The key the signer signs with. */
export interface SshSignerOptions {
  /**
   * An unencrypted OpenSSH Ed25519 private key, as `ssh-keygen -t ed25519 -N ""` writes it
   * (`-----BEGIN OPENSSH PRIVATE KEY-----`)
   */
  privateKey: string;
}

const encoder = new TextEncoder();
const MAGIC = encoder.encode("SSHSIG");

class Reader {
  private at = 0;
  constructor(private readonly bytes: Uint8Array) {}
  uint32(): number {
    if (this.at + 4 > this.bytes.length) throw new Error("ssh key: truncated");
    const b = this.bytes;
    const value =
      ((b[this.at] as number) * 0x1000000 +
        (((b[this.at + 1] as number) << 16) |
          ((b[this.at + 2] as number) << 8) |
          (b[this.at + 3] as number))) >>>
      0;
    this.at += 4;
    return value;
  }
  string(): Uint8Array {
    const length = this.uint32();
    if (this.at + length > this.bytes.length) throw new Error("ssh key: truncated");
    const value = this.bytes.subarray(this.at, this.at + length);
    this.at += length;
    return value;
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** An ssh `string`: its length (uint32, big endian) and bytes. */
function sshString(value: Uint8Array | string): Uint8Array {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length);
  out.set(bytes, 4);
  return out;
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text.replace(/\s+/g, ""));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((byte, i) => byte === b[i]);

interface Ed25519Key {
  /** The public key blob (`string "ssh-ed25519"`, `string <32 bytes>`) */
  publicBlob: Uint8Array;
  /** The 32-byte seed */
  seed: Uint8Array;
}

/** An unencrypted `openssh-key-v1` Ed25519 private key (OpenSSH's PROTOCOL.key). */
function parseOpenSshEd25519(text: string): Ed25519Key {
  const m = /-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]*?)-----END OPENSSH PRIVATE KEY-----/.exec(
    text,
  );
  if (!m) throw new Error("ssh key: not an OpenSSH private key");
  const bytes = fromBase64(m[1] as string);
  const auth = encoder.encode("openssh-key-v1\0");
  if (!sameBytes(bytes.subarray(0, auth.length), auth)) {
    throw new Error("ssh key: not an openssh-key-v1 key");
  }
  const reader = new Reader(bytes.subarray(auth.length));
  const cipher = new TextDecoder().decode(reader.string());
  reader.string(); // kdf name
  reader.string(); // kdf options
  if (cipher !== "none") throw new Error("ssh key: encrypted keys are not supported");
  if (reader.uint32() !== 1) throw new Error("ssh key: one key expected");
  const publicBlob = reader.string();
  const secret = new Reader(reader.string());
  const check = secret.uint32();
  if (check !== secret.uint32()) throw new Error("ssh key: check bytes differ");
  const type = new TextDecoder().decode(secret.string());
  if (type !== "ssh-ed25519") throw new Error(`ssh key: ${type} keys are not supported`);
  const publicKey = secret.string();
  const privateKey = secret.string();
  if (publicKey.length !== 32 || privateKey.length !== 64) {
    throw new Error("ssh key: bad Ed25519 key");
  }
  return { publicBlob, seed: privateKey.slice(0, 32) };
}

/** The public key blob of a literal key (`key::ssh-ed25519 AAAA...` or `ssh-ed25519 AAAA...`). */
function literalKeyBlob(key: string): Uint8Array | undefined {
  const literal = key.startsWith("key::") ? key.slice(5) : key.startsWith("ssh-") ? key : "";
  const base64 = literal.split(/\s+/)[1];
  if (!base64) return undefined;
  try {
    return fromBase64(base64);
  } catch {
    return undefined;
  }
}

/** The PKCS #8 wrapping of an Ed25519 seed (RFC 8410), as Web Crypto imports it. */
function pkcs8Of(seed: Uint8Array): Uint8Array {
  const prefix = [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70];
  return concat([new Uint8Array([...prefix, 0x04, 0x22, 0x04, 0x20]), seed]);
}

/** ssh-keygen's armor (sshsig.c `sshsig_armor`): base64 lines of 70 columns. */
function armor(blob: Uint8Array): string {
  const base64 = toBase64(blob);
  const lines: string[] = [];
  for (let i = 0; i < base64.length; i += 70) lines.push(base64.slice(i, i + 70));
  return `-----BEGIN SSH SIGNATURE-----\n${lines.join("\n")}\n-----END SSH SIGNATURE-----\n`;
}

const buffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

/**
 * A signer for `gpg.format=ssh` with one Ed25519 key, signing as `ssh-keygen -Y sign -n git`
 * (an SSHSIG over the payload's SHA-512). It signs when the request names this key (its
 * public key, `key::<public key>`, or a file: whichever file the configuration names, the
 * key given here signs) or asks for the default key; other formats, and a literal key that
 * is another one, fail as git's signing programs fail.
 *
 * @example
 * ```typescript
 * const signer = createSshSigner({ privateKey: await readText(files, "id_ed25519") });
 * const environment = { ...hostEnvironment, signer };
 * ```
 */
export function createSshSigner(options: SshSignerOptions): Signer {
  const key = parseOpenSshEd25519(options.privateKey);
  let imported: Promise<CryptoKey> | undefined;
  return async (request: SigningRequest): Promise<SigningOutcome> => {
    if (request.format !== "ssh") {
      return { messages: ["error: gpg failed to sign the data:\n(no gpg output)"] };
    }
    const wanted = request.key === undefined ? undefined : literalKeyBlob(request.key);
    if (wanted && !sameBytes(wanted, key.publicBlob)) {
      return { messages: ["error: Couldn't find key in agent\n"] };
    }
    imported ??= crypto.subtle.importKey("pkcs8", buffer(pkcs8Of(key.seed)), "Ed25519", false, [
      "sign",
    ]);
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-512", buffer(request.payload)));
    const signed = concat([
      MAGIC,
      sshString("git"),
      sshString(""),
      sshString("sha512"),
      sshString(hash),
    ]);
    const raw = new Uint8Array(await crypto.subtle.sign("Ed25519", await imported, buffer(signed)));
    const version = new Uint8Array(4);
    new DataView(version.buffer).setUint32(0, 1);
    const blob = concat([
      MAGIC,
      version,
      sshString(key.publicBlob),
      sshString("git"),
      sshString(""),
      sshString("sha512"),
      sshString(concat([sshString("ssh-ed25519"), sshString(raw)])),
    ]);
    return { signature: encoder.encode(armor(blob)) };
  };
}
