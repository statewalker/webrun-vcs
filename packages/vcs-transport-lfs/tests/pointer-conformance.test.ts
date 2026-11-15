import { describe, expect, it } from "vitest";
import { formatLfsPointer, LFS_POINTER_MAX_SIZE, parseLfsPointer } from "../src/index.js";
import { checkCases, smudgeCases, V } from "./pointer-cases.js";

/**
 * `parseLfsPointer` against git-lfs 3.4's `DecodeFrom` (lfs/pointer.go). Each
 * case's expected verdict was taken from native git-lfs: the first table from
 * `git lfs smudge` (a pointer is replaced by its content, anything else passes
 * through), the second from `git lfs pointer --check`. `native-git-lfs.test.ts`
 * re-runs both tables against the installed binary when there is one.
 */
const enc = new TextEncoder();

const CONTENT_OID = "d61e5fa787e50330288923bd0c9866b44643925965144262288447cf52f9f9b7";

describe("parseLfsPointer agrees with git-lfs DecodeFrom", () => {
  it("over the 23 cases `git lfs smudge` decides", () => {
    const cases = smudgeCases(CONTENT_OID);
    expect(cases).toHaveLength(23);
    const wrong = cases
      .filter(([text, expected]) => (parseLfsPointer(text) !== undefined) !== expected)
      .map(([text]) => JSON.stringify(text.slice(0, 80)));
    expect(wrong).toEqual([]);
  });

  it("over the 25 cases `git lfs pointer --check` decides", () => {
    const cases = checkCases();
    expect(cases).toHaveLength(25);
    const wrong = cases
      .filter(([text, expected]) => (parseLfsPointer(text) !== undefined) !== expected)
      .map(([text]) => JSON.stringify(text.slice(0, 80)));
    expect(wrong).toEqual([]);
  });

  it("reads bytes as well as text, from the first 1024 bytes only", () => {
    expect(LFS_POINTER_MAX_SIZE).toBe(1024);
    const text = `${V}\noid sha256:${CONTENT_OID}\nsize 8\n`;
    expect(parseLfsPointer(enc.encode(text))).toEqual({ oid: CONTENT_OID, size: 8 });
    // trailing whitespace past the cutoff, then garbage: git-lfs never sees the garbage
    const padded = enc.encode(`${text}${" ".repeat(1100)}garbage`);
    expect(parseLfsPointer(padded)).toEqual({ oid: CONTENT_OID, size: 8 });
    // the same with no whitespace: the cut line after size is an extra line
    expect(parseLfsPointer(enc.encode(`${text}${"x".repeat(1100)}`))).toBeUndefined();
  });

  it("reads extensions in priority order; a repeated key keeps its last value", () => {
    const e1 = "1".repeat(64);
    const e2 = "2".repeat(64);
    expect(
      parseLfsPointer(
        `${V}\next-0-foo sha256:${e1}\next-1-bar sha256:${e2}\noid sha256:${CONTENT_OID}\nsize 8\n`,
      ),
    ).toEqual({
      oid: CONTENT_OID,
      size: 8,
      extensions: [
        { priority: 0, name: "foo", oid: e1 },
        { priority: 1, name: "bar", oid: e2 },
      ],
    });
    expect(
      parseLfsPointer(
        `${V}\next-0-foo sha256:${e1}\next-0-foo sha256:${e2}\noid sha256:${CONTENT_OID}\nsize 8\n`,
      )?.extensions,
    ).toEqual([{ priority: 0, name: "foo", oid: e2 }]);
    // nothing, an extension included, after size
    expect(
      parseLfsPointer(`${V}\noid sha256:${CONTENT_OID}\nsize 8\next-0-foo sha256:${e1}\n`),
    ).toBeUndefined();
  });

  it("formats as git-lfs encodes: extensions by priority, an empty object as an empty file", () => {
    const e1 = "1".repeat(64);
    const e2 = "2".repeat(64);
    expect(
      formatLfsPointer({
        oid: CONTENT_OID,
        size: 8,
        extensions: [
          { priority: 1, name: "bar", oid: e2 },
          { priority: 0, name: "foo", oid: e1 },
        ],
      }),
    ).toBe(
      `${V}\next-0-foo sha256:${e1}\next-1-bar sha256:${e2}\noid sha256:${CONTENT_OID}\nsize 8\n`,
    );
    expect(
      formatLfsPointer({
        oid: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        size: 0,
      }),
    ).toBe("");
  });
});
