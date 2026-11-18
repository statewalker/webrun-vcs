import { describe, expect, it } from "vitest";

import { formatCommitPretty, relativeDate, sanitizedSubject } from "../src/index.js";

const ident = (timestamp: number, tzOffset: string) => ({
  name: "A U Thor",
  email: "author@example.com",
  timestamp,
  tzOffset,
});
const commit = {
  tree: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
  parents: ["1111111111111111111111111111111111111111", "2222222222222222222222222222222222222222"],
  author: ident(1112911993, "+0200"),
  committer: ident(1112911993, "+0000"),
  message: "\nFix the  parser...\nsecond line  \n\nThe body.\n",
};
const id = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";

describe("formatCommitPretty (git's user format)", () => {
  it("expands ids, idents, dates and the message parts", async () => {
    const abbreviate = async (oid: string) => oid.slice(0, 7);
    expect(await formatCommitPretty("%h %t %p|%H", commit, id, { abbreviate })).toBe(
      `abcdefa 4b825dc 1111111 2222222|${id}`,
    );
    expect(await formatCommitPretty("%an <%ae> %al", commit, id)).toBe(
      "A U Thor <author@example.com> author",
    );
    expect(await formatCommitPretty("%ad|%ai|%aI|%as|%at", commit, id)).toBe(
      "Fri Apr 8 00:13:13 2005 +0200|2005-04-08 00:13:13 +0200|2005-04-08T00:13:13+02:00|2005-04-08|1112911993",
    );
    expect(await formatCommitPretty("%cI|%cD", commit, id)).toBe(
      "2005-04-07T22:13:13Z|Thu, 7 Apr 2005 22:13:13 +0000",
    );
    expect(await formatCommitPretty("[%s] [%f] [%b]", commit, id)).toBe(
      "[Fix the  parser... second line] [Fix-the-parser] [The body.\n]",
    );
  });

  it("keeps unknown placeholders, drops colors, applies the magic", async () => {
    expect(await formatCommitPretty("%q %w %Cred%s%Creset%C(bold)%%%x41", commit, id)).toBe(
      "%q %w Fix the  parser... second line%A",
    );
    expect(await formatCommitPretty("a\n%-e|% s|%+e|%+s", commit, id)).toBe(
      "a| Fix the  parser... second line||\nFix the  parser... second line",
    );
  });

  it("relative dates and sanitized subjects as git's", () => {
    expect(relativeDate(100, 150)).toBe("50 seconds ago");
    expect(relativeDate(0, 3600 * 5)).toBe("5 hours ago");
    expect(relativeDate(0, 86400 * 400)).toBe("1 year, 1 month ago");
    expect(relativeDate(10, 5)).toBe("in the future");
    expect(sanitizedSubject("  [PATCH] a/b: fix...it!  ")).toBe("PATCH-a-b-fix.it");
  });
});

describe("formatCommitPretty: git's bytes and spaces", () => {
  it("keeps a no-break space (git's isspace is ASCII only) and writes %x80-%xff raw", async () => {
    const nbsp = { ...commit, message: "Subject\u00a0\n\u00a0\nbody\u00a0\n" };
    // the no-break space line is no blank line: the subject paragraph goes on
    expect(await formatCommitPretty("[%s][%b]", nbsp, id)).toBe(
      "[Subject\u00a0 \u00a0 body\u00a0][]",
    );
    // a byte above 0x7f is a lone surrogate that encodeGitPath writes back as that byte
    expect(await formatCommitPretty("%x41%x80%xff", commit, id)).toBe("A\udc80\udcff");
  });

  it("magic before an unknown placeholder consumes the magic only, as git", async () => {
    expect(await formatCommitPretty("a%n%-q|% q|%+q", commit, id)).toBe("aq|q|q");
  });

  it("pads, truncates and wraps", async () => {
    expect(await formatCommitPretty("%<(6)%an|%>(6,trunc)%an|", commit, id)).toBe(
      "A U Thor|A U ..|",
    );
    expect(await formatCommitPretty("%w(10,1,2)%b", commit, id)).toBe(" The body.\n");
  });
});
