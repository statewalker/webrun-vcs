/**
 * compilePosixRegex on fixed cases, each expectation taken from glibc's regexec (C locale,
 * `REG_STARTEND`, two matches): `[start, end, group1 start, group1 end]`, "NO" for no match,
 * "ERR" for a pattern regcomp refuses.
 */
import { describe, expect, it } from "vitest";
import { compilePosixRegex, PosixRegexError } from "../../src/regex/index.js";

type Expected = [number, number, number, number] | "NO" | "ERR";

const CASES: Array<[string, string, string, Expected]> = [
  // flags (E extended, B basic, i icase), pattern, subject (latin1), glibc's result
  ["E", "^(a|ab)", "abc def", [0, 2, 0, 2]],
  ["E", "a**", "aa", [0, 2, -1, -1]],
  ["E", "*a", "*a", "ERR"],
  ["B", "*a", "*a", [0, 2, -1, -1]],
  ["E", "^(x?)(xy)?", "xy", [0, 2, 0, 0]],
  ["E", "(a|ab)(c|bcd)(d*)", "abcd", [0, 4, 0, 1]],
  ["E", "^(a*)*", "aaa", [0, 3, 0, 3]],
  ["E", "^(a*)+(b)", "aab", [0, 3, 0, 2]],
  ["E", "a{,2}", "aaa", [0, 2, -1, -1]],
  ["B", "a\\{,2\\}", "aaa", [0, 2, -1, -1]],
  ["E", "x(|a)", "xa", [0, 2, 1, 2]],
  ["E", "()", "x", [0, 0, 0, 0]],
  ["E", "(a|b)*", "abab", [0, 4, 3, 4]],
  ["E", "^(ab|a)(bc|c)?", "abc", [0, 3, 0, 2]],
  ["E", "+a", "+a", "ERR"],
  ["E", "a|*b", "b", "ERR"],
  ["E", "^\\s", "\xa0", "NO"],
  ["E", "a{1", "a{1", "ERR"],
  ["E", "{1}", "{1}", "ERR"],
  ["E", "[[:alpha:]-z]", "-", "ERR"],
  ["E", "\\w+", "ab_9", [0, 4, -1, -1]],
  ["E", "a\\", "a", "ERR"],
  ["E", "()*", "a", [0, 0, 0, 0]],
  ["E", "(a|)+b", "aab", [0, 3, 1, 2]],
  ["E", "(a)\\1", "aa", [0, 2, 0, 1]],
  ["E", "a{2,1}", "aa", "ERR"],
  ["E", "[]a]+", "]a", [0, 2, -1, -1]],
  ["E", "[^]a]+", "xy]", [0, 2, -1, -1]],
  ["E", "[a\\]+", "a\\", [0, 2, -1, -1]],
  ["E", "[[.space.]]", " ", "ERR"],
  ["E", "^*", "*", "ERR"],
  ["E", "a|", "b", [0, 0, -1, -1]],
  ["E", "a{0}b", "ab", [1, 2, -1, -1]],
  ["E", "x{256}", "x", "NO"],
  ["E", "a^b", "a^b", "NO"],
  ["B", "a^b", "a^b", [0, 3, -1, -1]],
  ["B", "a$b", "a$b", [0, 3, -1, -1]],
  ["B", "\\(^a\\)", "a", [0, 1, 0, 1]],
  ["B", "x\\(^a\\)", "xa", "NO"],
  ["Ei", "\xc9", "\xe9", "NO"],
  ["Ei", "[a-c]+", "ABC", [0, 3, -1, -1]],
  ["E", "\\bfoo\\b", " foo ", [1, 4, -1, -1]],
  ["E", "\\Bo", "foo", [1, 2, -1, -1]],
  ["E", "[\\w]", "w", [0, 1, -1, -1]],
  ["E", "a{1,2}{3}", "aaaaaa", [0, 6, -1, -1]],
  ["E", "(a){2}", "aa", [0, 2, 1, 2]],
  ["B", "\\(a\\|b\\)*", "ab", [0, 2, 1, 2]],
  ["B", "\\{1\\}", "{1}", "ERR"],
  ["E", "[[:foo:]]", "a", "ERR"],
  ["E", "[z-a]", "a", "ERR"],
  ["E", ")", ")", [0, 1, -1, -1]],
  ["B", "\\)", "x", "ERR"],
  ["E", "(*a)", "a", "ERR"],
  ["E", "( |\\<A*[^a]{,2}\\<){0,1}", "B_\t bBabB", [0, 0, -1, -1]],
  ["E", "^((a|ab)(c|bcd))(d*)$", "abcd", [0, 4, 0, 4]],
];

describe("compilePosixRegex as glibc", () => {
  it.each(CASES)("%s %j on %j", (flags, pattern, subject, expected) => {
    let actual: Expected;
    try {
      const re = compilePosixRegex(Buffer.from(pattern, "latin1"), {
        extended: flags.includes("E"),
        icase: flags.includes("i"),
      });
      const m = re.exec(Buffer.from(subject, "latin1"), undefined, 2);
      actual = m ? [m.start, m.end, m.groups[0]?.[0] ?? -1, m.groups[0]?.[1] ?? -1] : "NO";
    } catch (e) {
      if (!(e instanceof PosixRegexError)) throw e;
      actual = "ERR";
    }
    expect(actual).toEqual(expected);
  });

  it("takes time linear in the subject on nested quantifiers", () => {
    const re = compilePosixRegex(
      "^[ \t]*(([][[:alnum:]@_.](<[][[:alnum:]@_, \t<>]+>)?)+([ \t]+([][[:alnum:]@_.](<[][[:alnum:]@_, \t<>]+>)?)+)+[^;=:,()]*)$",
      { extended: true },
    );
    for (const n of [100, 1000]) {
      const t = performance.now();
      expect(re.exec(new TextEncoder().encode(`${"List<int> ".repeat(n)};`))).toBeUndefined();
      expect(performance.now() - t).toBeLessThan(1000);
    }
  });
});
