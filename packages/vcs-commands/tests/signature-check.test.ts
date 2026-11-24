/**
 * gpg-interface.c's parsers (statewalker/statewalker-root#318): `parse_gpg_output` over gpg's
 * status lines, `parse_ssh_output` over ssh-keygen's first line, and the signature's place in
 * a commit (`parse_buffer_signed_by_header`) and a tag (`parse_signature`).
 */
import { describe, expect, it } from "vitest";

import {
  parseBufferSignedByHeader,
  parseGpgOutput,
  parseSignature,
  parseSshOutput,
  type SignatureCheck,
} from "../src/index.js";

const fresh = (): SignatureCheck => ({
  result: "N",
  trustLevel: "undefined",
  failed: true,
  messages: [],
});
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe("parse_gpg_output", () => {
  it('t7510-signed-commit.sh: "show good signature with custom format": GOODSIG, VALIDSIG and TRUST_ lines', () => {
    const check = fresh();
    parseGpgOutput(
      [
        "[GNUPG:] NEWSIG",
        "[GNUPG:] GOODSIG 13B6F51ECDDE430D C O Mitter <committer@example.com>",
        "[GNUPG:] VALIDSIG 73D758744BE721698EC54E8713B6F51ECDDE430D 2019-03-11 1552322733 0 4 0 17 8 00 73D758744BE721698EC54E8713B6F51ECDDE430D",
        "[GNUPG:] TRUST_ULTIMATE 0 pgp",
        "",
      ].join("\n"),
      check,
    );
    expect(check).toMatchObject({
      result: "G",
      trustLevel: "ultimate",
      key: "13B6F51ECDDE430D",
      signer: "C O Mitter <committer@example.com>",
      fingerprint: "73D758744BE721698EC54E8713B6F51ECDDE430D",
      primaryKeyFingerprint: "73D758744BE721698EC54E8713B6F51ECDDE430D",
    });
  });

  it('t7510-signed-commit.sh: "show double signature with custom format": two exclusive statuses are an error, fields cleared', () => {
    const check = fresh();
    parseGpgOutput(
      [
        "[GNUPG:] GOODSIG 13B6F51ECDDE430D C O Mitter <committer@example.com>",
        "[GNUPG:] BADSIG 61092E85B7227189 Eris Discordia <discord@example.net>",
        "",
      ].join("\n"),
      check,
    );
    expect(check.result).toBe("E");
    expect(check.key).toBeUndefined();
    expect(check.signer).toBeUndefined();
  });

  it('t7510-signed-commit.sh: "show unknown signature with custom format": ERRSIG has a key but no signer', () => {
    const check = fresh();
    parseGpgOutput("[GNUPG:] ERRSIG 61092E85B7227189 17 8 00 1552322733 9 -\n", check);
    expect(check).toMatchObject({ result: "E", key: "61092E85B7227189" });
    expect(check.signer).toBeUndefined();
  });
});

describe("parse_ssh_output", () => {
  it('t7528-signed-commit-ssh.sh: "show good signature with custom format": the principal up to the last " with "', () => {
    const check = fresh();
    parseSshOutput('Good "git" signature for a with b with ED25519 key SHA256:abc\n', check);
    expect(check).toMatchObject({
      result: "G",
      trustLevel: "fully",
      signer: "a with b",
      key: "SHA256:abc",
      fingerprint: "SHA256:abc",
    });
  });

  it('t7528-signed-commit-ssh.sh: "show untrusted signature with custom format": a good signature of an unknown key', () => {
    const check = fresh();
    parseSshOutput(
      'Good "git" signature with ED25519 key SHA256:xyz\nNo principal matched.\n',
      check,
    );
    expect(check).toMatchObject({ result: "G", trustLevel: "undefined", key: "SHA256:xyz" });
  });

  it('t7528-signed-commit-ssh.sh: "show bad signature with custom format": anything else is bad', () => {
    const check = fresh();
    parseSshOutput("Could not verify signature.\n", check);
    expect(check).toMatchObject({ result: "B", trustLevel: "never" });
  });
});

describe("where signatures are", () => {
  it('t7510-signed-commit.sh: "verify-commit verifies multiply signed commits": the hash\'s header is the signature, the other one leaves the payload', () => {
    const commit = enc(
      [
        "tree 0000000000000000000000000000000000000000",
        "gpgsig -----BEGIN PGP SIGNATURE-----",
        " one",
        " -----END PGP SIGNATURE-----",
        "gpgsig-sha256 -----BEGIN PGP SIGNATURE-----",
        " two",
        " -----END PGP SIGNATURE-----",
        "",
        "msg",
        "",
      ].join("\n"),
    );
    const sha1 = parseBufferSignedByHeader(commit, "gpgsig");
    expect(dec(sha1?.signature as Uint8Array)).toBe(
      "-----BEGIN PGP SIGNATURE-----\none\n-----END PGP SIGNATURE-----\n",
    );
    expect(dec(sha1?.payload as Uint8Array)).toBe(
      "tree 0000000000000000000000000000000000000000\n\nmsg\n",
    );
    expect(parseBufferSignedByHeader(enc("tree x\n\nmsg\n"), "gpgsig")).toBeUndefined();
  });

  it('t7030-verify-tag.sh: "detect fudged signature": a tag\'s signature starts at its last armor line', () => {
    const tag = enc(
      "object x\ntype commit\ntag t\n\nmsg\n-----BEGIN PGP SIGNATURE-----\nabc\n-----END PGP SIGNATURE-----\n",
    );
    const parsed = parseSignature(tag);
    expect(dec(parsed?.payload as Uint8Array)).toBe("object x\ntype commit\ntag t\n\nmsg\n");
    expect(dec(parsed?.signature as Uint8Array)).toMatch(/^-----BEGIN PGP SIGNATURE-----\n/);
    expect(parseSignature(enc("object x\n\nmsg\n"))).toBeUndefined();
  });
});
