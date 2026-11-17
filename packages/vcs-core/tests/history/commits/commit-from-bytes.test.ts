/**
 * `commitFromBytes` parses a whole commit without generators (the commit store's path for an
 * object read in one piece): it must give exactly what the streaming decoder gives, and fail
 * where it fails.
 */
import { describe, expect, it } from "vitest";
import {
  commitFromBytes,
  decodeCommitEntries,
  entriesToCommit,
} from "../../../src/history/commits/commit-format.js";

const enc = new TextEncoder();

const ident = "A U Thor <author@example.com> 1700000000 +0100";
const cases: [string, string | Uint8Array][] = [
  [
    "plain",
    `tree ${"a".repeat(40)}\nparent ${"b".repeat(40)}\nauthor ${ident}\ncommitter ${ident}\n\nsubject\n\nbody\n`,
  ],
  [
    "root, no message newline",
    `tree ${"a".repeat(40)}\nauthor ${ident}\ncommitter ${ident}\n\nno newline`,
  ],
  [
    "merge",
    `tree ${"a".repeat(40)}\nparent ${"b".repeat(40)}\nparent ${"c".repeat(40)}\nauthor ${ident}\ncommitter ${ident}\n\nmerge\n`,
  ],
  [
    "CRLF headers",
    `tree ${"a".repeat(40)}\r\nauthor ${ident}\r\ncommitter ${ident}\r\n\r\nmessage\r\n`,
  ],
  [
    "encoding and unknown headers",
    `tree ${"a".repeat(40)}\nauthor ${ident}\ncommitter ${ident}\nencoding ISO-8859-1\nmergetag object x\n type commit\nnoval\n\nmsg\n`,
  ],
  [
    "gpgsig",
    `tree ${"a".repeat(40)}\nauthor ${ident}\ncommitter ${ident}\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n iQEz\n -----END PGP SIGNATURE-----\n\nsigned\n`,
  ],
  [
    "gpgsig last, no message",
    `tree ${"a".repeat(40)}\nauthor ${ident}\ncommitter ${ident}\ngpgsig line1\n line2`,
  ],
  ["empty message", `tree ${"a".repeat(40)}\nauthor ${ident}\ncommitter ${ident}\n\n`],
  [
    "unicode",
    `tree ${"a".repeat(40)}\nauthor Jöhn Dœ <j@example.com> 1 +0000\ncommitter 名前 <n@example.com> 2 -0730\n\nüñíçødé ✓\n`,
  ],
  ["\\r\\r line", `tree ${"a".repeat(40)}\nauthor ${ident}\ncommitter ${ident}\n\r\r\n\nmsg\n`],
  ["missing tree", `author ${ident}\ncommitter ${ident}\n\nmsg\n`],
  ["missing committer", `tree ${"a".repeat(40)}\nauthor ${ident}\n\nmsg\n`],
  ["bad ident", `tree ${"a".repeat(40)}\nauthor nobody\ncommitter ${ident}\n\nmsg\n`],
  ["empty", ""],
  // a message ending inside a UTF-8 sequence (dropped, as the streaming decoder drops it)
  [
    "trailing partial UTF-8",
    Uint8Array.from([
      ...enc.encode(`tree ${"a".repeat(40)}\nauthor ${ident}\ncommitter ${ident}\n\nx`),
      0xe2,
      0x9c,
    ]),
  ],
  [
    "invalid UTF-8 inside",
    Uint8Array.from([
      ...enc.encode(`tree ${"a".repeat(40)}\nauthor ${ident}\ncommitter ${ident}\n\n`),
      0xff,
      0x41,
      0x0a,
    ]),
  ],
  [
    "BOM",
    Uint8Array.from([
      0xef,
      0xbb,
      0xbf,
      ...enc.encode(`tree ${"a".repeat(40)}\nauthor ${ident}\ncommitter ${ident}\n\nm\n`),
    ]),
  ],
];

async function viaStream(data: Uint8Array) {
  try {
    return await entriesToCommit(decodeCommitEntries([data]));
  } catch (e) {
    return { error: (e as Error).message };
  }
}
function viaBytes(data: Uint8Array) {
  try {
    return commitFromBytes(data);
  } catch (e) {
    return { error: (e as Error).message };
  }
}

describe("commitFromBytes", () => {
  for (const [name, input] of cases) {
    it(`gives what the streaming decoder gives: ${name}`, async () => {
      const data = typeof input === "string" ? enc.encode(input) : input;
      expect(viaBytes(data)).toEqual(await viaStream(data));
    });
  }
});
