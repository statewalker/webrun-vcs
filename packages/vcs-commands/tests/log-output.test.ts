import { describe, expect, it } from "vitest";

import { DateModeError, Mailmap, parseDateMode, showDate } from "../src/index.js";

describe("date modes", () => {
  const t = 1112911993; // Thu Apr 7 22:13:13 2005 UTC
  it("shows each mode as git's show_date", () => {
    const show = (spec: string, tz = "+0200") =>
      showDate(t, tz, parseDateMode(spec), { now: t + 3600 * 5, localTzOffset: () => 0 });
    expect(show("default")).toBe("Fri Apr 8 00:13:13 2005 +0200");
    expect(show("local")).toBe("Thu Apr 7 22:13:13 2005");
    expect(show("iso")).toBe("2005-04-08 00:13:13 +0200");
    expect(show("iso-strict")).toBe("2005-04-08T00:13:13+02:00");
    expect(show("iso-strict", "+0000")).toBe("2005-04-07T22:13:13Z");
    expect(show("rfc")).toBe("Fri, 8 Apr 2005 00:13:13 +0200");
    expect(show("short")).toBe("2005-04-08");
    expect(show("raw", "-0130")).toBe("1112911993 -0130");
    expect(show("unix")).toBe("1112911993");
    expect(show("relative")).toBe("5 hours ago");
    expect(show("human")).toBe("5 hours ago");
    expect(show("format:%Y-%m-%d %H:%M:%S %z %a %B %j %e")).toBe(
      "2005-04-08 00:13:13 +0200 Fri April 098  8",
    );
  });

  it("refuses modes git does not know", () => {
    expect(() => parseDateMode("weird")).toThrow(DateModeError);
    expect(() => parseDateMode("iso-locale")).toThrow(DateModeError);
    expect(() => parseDateMode("format")).toThrow(DateModeError);
  });
});

describe("mailmap", () => {
  it("maps by email, then by name, case-insensitively", () => {
    const map = new Mailmap().read(
      [
        "# comment",
        "Proper Name <proper@example.com>",
        "<new@example.com> <OLD@example.com>",
        "Other <other@example.com> Commit Name <commit@example.com>",
        "",
      ].join("\n"),
    );
    expect(map.map("x", "PROPER@example.com")).toEqual({
      name: "Proper Name",
      email: "PROPER@example.com",
    });
    expect(map.map("y", "old@EXAMPLE.com")).toEqual({ name: "y", email: "new@example.com" });
    expect(map.map("commit name", "commit@example.com")).toEqual({
      name: "Other",
      email: "other@example.com",
    });
    expect(map.map("someone", "commit@example.com")).toEqual({
      name: "someone",
      email: "commit@example.com",
    });
    expect(map.map("z", "none@example.com")).toEqual({ name: "z", email: "none@example.com" });
  });
});
