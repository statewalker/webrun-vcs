/**
 * The word regexes of diff drivers (userdiff.c's `word_regex`): `diff.<name>.wordRegex` over
 * the builtin one, the builtin ones ending in `|[^[:space:]]|[\xc0-\xff][\x80-\xbf]+` (a
 * UTF-8 sequence is one word), and every builtin regex of both tables compiling as an
 * extended POSIX expression.
 */
import { describe, expect, it } from "vitest";
import {
  BUILTIN_WORD_REGEXES,
  BUILTIN_WORD_REGEXES_2_43,
  compilePosixRegex,
  userdiffWordRegex,
} from "../../../src/index.js";

const text = (s: string) => new TextEncoder().encode(s);

describe("userdiffWordRegex", () => {
  it("prefers diff.<name>.wordRegex, then the builtin driver's, else nothing", () => {
    const config = (key: string) => (key === "diff.cpp.wordRegex" ? "[a-z]+" : undefined);
    expect(userdiffWordRegex("cpp", config)).toEqual(text("[a-z]+"));
    expect(userdiffWordRegex("mine", config)).toBeUndefined();
    const builtin = userdiffWordRegex("cpp") as Uint8Array;
    expect(builtin.subarray(0, BUILTIN_WORD_REGEXES.cpp?.length)).toEqual(
      text(BUILTIN_WORD_REGEXES.cpp as string),
    );
  });

  it("makes a UTF-8 sequence one word and any other non-space byte one", () => {
    const re = compilePosixRegex(userdiffWordRegex("html") as Uint8Array, {
      extended: true,
      newline: true,
    });
    const s = text("<é>");
    expect(re.exec(s, s.length, 1)).toMatchObject({ start: 0, end: 1 });
    expect(re.exec(s.subarray(1), s.length - 1, 1)).toMatchObject({ start: 0, end: 2 });
  });

  it("takes 2.43's table: no ini, r or swift, the older bash", () => {
    expect(userdiffWordRegex("swift", undefined, BUILTIN_WORD_REGEXES_2_43)).toBeUndefined();
    expect(BUILTIN_WORD_REGEXES_2_43.bash).toBe("[^ \t]+");
  });

  it("compiles every builtin regex of both tables", () => {
    for (const table of [BUILTIN_WORD_REGEXES, BUILTIN_WORD_REGEXES_2_43]) {
      for (const name of Object.keys(table)) {
        const pattern = userdiffWordRegex(name, undefined, table) as Uint8Array;
        expect(() => compilePosixRegex(pattern, { extended: true, newline: true })).not.toThrow();
      }
    }
  });
});
