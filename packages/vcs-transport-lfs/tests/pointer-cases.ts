/**
 * Pointer cases with git-lfs 3.4's verdicts: the first table from `git lfs
 * smudge` (a pointer is replaced by its content, anything else passes
 * through), the second from `git lfs pointer --check`.
 */
export const V = "version https://git-lfs.github.com/spec/v1";

/** `git lfs smudge` verdicts, for the oid of "CONTENT\n" (8 bytes). */
export function smudgeCases(oid: string): [string, boolean][] {
  return [
    [`${V}\noid sha256:${oid}\nsize 8\n`, true],
    [`${V}\noid sha256:${oid}\nsize 8`, true],
    [`${V}\noid sha256:${oid}\nsize 8\n\n`, true],
    [`${V}\r\noid sha256:${oid}\r\nsize 8\r\n`, true],
    [`${V}\nsize 8\noid sha256:${oid}\n`, false],
    [`oid sha256:${oid}\n${V}\nsize 8\n`, false],
    [`${V}\noid sha256:${oid.toUpperCase()}\nsize 8\n`, false],
    [`${V}\noid sha256:${oid.slice(1)}\nsize 8\n`, false],
    [`${V}\noid sha256:${oid}\nsize -8\n`, false],
    [`${V}\noid sha256:${oid}\nsize +8\n`, true],
    [`${V}\noid sha256:${oid}\nsize 08\n`, true],
    [`${V}\noid sha256:${oid}\nsize 8 \n`, true],
    [`${V}\noid sha256:${oid}\nsize 8\nzzz extra\n`, false],
    [`${V}\noid sha256:${oid}\nsize 8\n${"x".repeat(1100)}\n`, false],
    [`version https://hawser.github.com/spec/v1\noid sha256:${oid}\nsize 8\n`, true],
    [`version https://git-lfs.github.com/spec/v2\noid sha256:${oid}\nsize 8\n`, false],
    [`${V}\noid sha256:${oid}\nsize 8\n${" ".repeat(1100)}\ngarbage after the cutoff\n`, true],
    [` ${V}\noid sha256:${oid}\nsize 8\n`, true],
    [`${V}\noid md5:${oid}\nsize 8\n`, false],
    [`${V}\noid  sha256:${oid}\nsize 8\n`, false],
    [`${V}\noid sha256:${oid}\n`, false],
    ["", false],
    ["plain text\n", false],
  ];
}

/** `git lfs pointer --check` verdicts. */
export function checkCases(): [string, boolean][] {
  const a = "a".repeat(64);
  const e1 = "1".repeat(64);
  const e2 = "2".repeat(64);
  return [
    [`${V}\noid sha256:${a}\nsize 8\n`, true],
    [`version http://git-media.io/v/2\noid sha256:${a}\nsize 8\n`, true],
    [`﻿${V}\noid sha256:${a}\nsize 8\n`, false],
    [`${V}\next-0-foo sha256:${e1}\next-0-bar sha256:${e2}\noid sha256:${a}\nsize 8\n`, false],
    [`${V}\next-0-foo-bar sha256:${e1}\noid sha256:${a}\nsize 8\n`, true],
    [`${V}\next-10-foo sha256:${e1}\noid sha256:${a}\nsize 8\n`, false],
    [`${V}\next-0-foo sha256:xyz\noid sha256:${a}\nsize 8\n`, false],
    [`ext-0-foo sha256:${e1}\n${V}\noid sha256:${a}\nsize 8\n`, true],
    [`${V}\next-0-foo sha256:${e1}\next-0-foo sha256:${e2}\noid sha256:${a}\nsize 8\n`, true],
    [`${V}\noid sha256:${a}\nsize -0\n`, true],
    [`${V}\noid\tsha256:${a}\nsize 8\n`, false],
    [`\t${V}\noid sha256:${a}\nsize 8\n`, true],
    [`\u0085${V}\noid sha256:${a}\nsize 8\n`, true],
    [` ${V}\noid sha256:${a}\nsize 8\n`, true],
    [`${V}\noid sha256:${a}\nsize 8\v`, true],
    [`${V}\roid sha256:${a}\rsize 8\r`, false],
    [`${V}\r\r\noid sha256:${a}\nsize 8\n`, false],
    [`${V}\noid sha256:${a}\nsize 1_0\n`, false],
    [`${V}\noid sha256:${a}\nsize 0x8\n`, false],
    [`${V}\noid sha256:${a}\nsize 0\n`, true],
    [`${V}\noid sha256:${a}\nsize \n`, false],
    [`version \noid sha256:${a}\nsize 8\n`, false],
    [`${V}\noid\nsize 8\n`, false],
    [`${V}\noid sha256:${a}\nsize 8 `, true],
    [`${V}\noid sha256:${"z".repeat(64)}\nsize 8\n`, false],
  ];
}
