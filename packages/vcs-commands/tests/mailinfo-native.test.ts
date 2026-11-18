/**
 * `mailsplit` and `mailinfo` against native `git mailsplit` / `git mailinfo`: crafted mails
 * (RFC 2047 headers in B and Q encodings, ISO-8859-1 bodies, quoted-printable and base64
 * bodies, multipart messages, in-body From/Subject/Date headers, scissors lines, `[PATCH]`
 * and `Re:` prefixes, Message-IDs, folded headers) give the same info, message and patch.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bytesToLatin1, latin1ToBytes } from "../src/commands/apply/latin1.js";
import { mailinfo, mailsplit } from "../src/index.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root = "";

const PATCH =
  "---\n a | 1 +\n\ndiff --git a/a b/a\nindex 1..2 100644\n--- a/a\n+++ b/a\n@@ -1 +1,2 @@\n a\n+b\n";

const MAILS: Buffer[] = [
  Buffer.from(
    `From 1234567890123456789012345678901234567890 Mon Sep 17 00:00:00 2001\nFrom: =?UTF-8?q?Jos=C3=A9=20N=C3=BA=C3=B1ez?= <jose@example.com>\nDate: Tue, 14 Nov 2023 23:30:00 +0100\nSubject: [PATCH 2/3] Re: [core] =?UTF-8?B?Q2Fmw6k=?= support\n Folded part\nMessage-ID: <abc@x>\n\nBody line.\n\nSigned-off-by: J <j@x>\n${PATCH}`,
  ),
  Buffer.concat([
    Buffer.from(
      'From: "O\'Brien, Pat" <pat@example.com>\nSubject: Latin body\nContent-Type: text/plain; charset=ISO-8859-1\nContent-Transfer-Encoding: quoted-printable\n\nCaf=E9 au lait =\nsoft break\n',
    ),
    Buffer.from(PATCH),
  ]),
  Buffer.from(
    `From: Outer <outer@x>\nSubject: outer subject\n\nFrom: Inner Person <inner@x>\nSubject: inner subject\nDate: Wed, 15 Nov 2023 10:00:00 +0000\n\nThe real body.\n${PATCH}`,
  ),
  Buffer.from(
    `From: A <a@x>\nSubject: scissors\n\nignored text\n-- >8 --\nSubject: after scissors\n\nkept body\n${PATCH}`,
  ),
  Buffer.from(
    `From: A <a@x>\nSubject: b64\nContent-Transfer-Encoding: base64\n\n${Buffer.from(
      `Base64 body\n${PATCH}`,
    )
      .toString("base64")
      .replace(/(.{76})/g, "$1\n")}\n`,
  ),
  Buffer.from(
    `From: A <a@x>\nSubject: multipart\nMIME-Version: 1.0\nContent-Type: multipart/mixed; boundary="XYZ"\n\nThis is a multi-part message.\n--XYZ\nContent-Type: text/plain; charset=UTF-8\n\nPart body\n--XYZ\nContent-Type: text/x-patch\n\n${PATCH}--XYZ--\n`,
  ),
  Buffer.from(
    `From: a@x (Comment Name)\nSubject: [RFC PATCH v2] [keep] brackets\n\nbody\n${PATCH}`,
  ),
];

function nativeMailinfo(mail: Buffer, args: string[]) {
  const dir = mkdtempSync(join(root, "mi-"));
  const r = spawnSync("git", ["mailinfo", ...args, join(dir, "msg"), join(dir, "patch")], {
    input: mail,
    env: nativeGitEnv(root),
    cwd: root,
  });
  return {
    info: bytesToLatin1(r.stdout),
    msg: bytesToLatin1(readFileSync(join(dir, "msg"))),
    patch: bytesToLatin1(readFileSync(join(dir, "patch"))),
  };
}

describeGit("mailinfo and mailsplit as native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "mailinfo-native-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("extracts what git mailinfo extracts", () => {
    const variants: [string[], Parameters<typeof mailinfo>[1]][] = [
      [[], {}],
      [["-k"], { keepSubject: true }],
      [["-b"], { keepNonPatchBrackets: true }],
      [["-m"], { addMessageId: true }],
      [["--scissors"], { useScissors: true }],
      [["-n"], { utf8: false }],
    ];
    for (const [i, mail] of MAILS.entries()) {
      for (const [args, options] of variants) {
        const native = nativeMailinfo(mail, args);
        const ours = mailinfo(bytesToLatin1(mail), options);
        expect({ i, args, info: ours.info, msg: ours.msg, patch: ours.patch }).toEqual({
          i,
          args,
          ...native,
        });
      }
    }
  });

  it("splits mailboxes as git mailsplit does", () => {
    const mbox = Buffer.concat([
      MAILS[0] as Buffer,
      Buffer.from("\n"),
      Buffer.from(
        "From 1234567890123456789012345678901234567890 Mon Sep 17 00:00:00 2001\r\nFrom: B <b@x>\r\nSubject: crlf\r\n\r\n>From here\r\n",
      ),
      Buffer.from(PATCH),
    ]);
    for (const [args, options] of [
      [[], {}],
      [["--keep-cr"], { keepCr: true }],
      [["--mboxrd"], { mboxrd: true }],
    ] as [string[], { keepCr?: boolean; mboxrd?: boolean }][]) {
      const dir = mkdtempSync(join(root, "ms-"));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "in.mbox"), mbox);
      spawnSync("git", ["mailsplit", "-b", `-o${dir}`, ...args, join(dir, "in.mbox")], {
        env: nativeGitEnv(root),
      });
      const native = readdirSync(dir)
        .filter((f) => /^\d+$/.test(f))
        .sort()
        .map((f) => bytesToLatin1(readFileSync(join(dir, f))));
      const ours = mailsplit(bytesToLatin1(mbox), options);
      expect({ args, ours }).toEqual({ args, ours: native });
      void latin1ToBytes;
    }
  });
});
