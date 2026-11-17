import { describe, expect, it } from "vitest";

import { Git, parseExpiry, WorktreesUnsupportedError } from "../src/index.js";

describe("worktree commands on a backend without linked worktrees", () => {
  it("every subcommand says it is unsupported", async () => {
    const { git } = await Git.init().call();
    const calls = [
      () => git.worktreeAdd().setPath("wt").call(),
      () => git.worktreeList().call(),
      () => git.worktreePrune().call(),
      () => git.worktreeLock().setWorktree("wt").call(),
      () => git.worktreeUnlock().setWorktree("wt").call(),
      () => git.worktreeRemove().setWorktree("wt").call(),
      () => git.worktreeMove().setWorktree("wt").setDestination("x").call(),
      () => git.worktreeRepair().call(),
    ];
    for (const call of calls)
      await expect(call()).rejects.toBeInstanceOf(WorktreesUnsupportedError);
  });
});

describe("parseExpiry, as git's parse_expiry_date", () => {
  const now = new Date("2026-05-31T12:00:00Z");
  const seconds = (d: string) => Math.floor(Date.parse(d) / 1000);
  it("reads git's words, relative dates, dates and seconds", () => {
    expect(parseExpiry("never", now)).toBe(0);
    expect(parseExpiry("false", now)).toBe(0);
    expect(parseExpiry("now", now)).toBe(Number.POSITIVE_INFINITY);
    expect(parseExpiry("all", now)).toBe(Number.POSITIVE_INFINITY);
    expect(parseExpiry("2.weeks.ago", now)).toBe(seconds("2026-05-17T12:00:00Z"));
    expect(parseExpiry("1.hour.ago", now)).toBe(seconds("2026-05-31T11:00:00Z"));
    expect(parseExpiry("3.months.ago", now)).toBe(seconds("2026-03-03T12:00:00Z"));
    expect(parseExpiry("2026-01-02T00:00:00Z", now)).toBe(seconds("2026-01-02T00:00:00Z"));
    expect(parseExpiry("12345", now)).toBe(12345);
    expect(parseExpiry(new Date(5000), now)).toBe(5);
    expect(() => parseExpiry("someday", now)).toThrow("malformed expiration date");
  });
});
