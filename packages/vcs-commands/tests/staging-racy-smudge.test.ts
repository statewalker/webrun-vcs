/**
 * Racy git on every staging store: a write of the staging area smudges (size 0) an entry
 * that is racily clean (its mtime second not older than the store's last write) and whose
 * file changed behind a matching stat, as git's `ce_smudge_racily_clean_entry` does for the
 * index file. Without it, a same-size edit made in the second of an add is lost once the
 * store is written again later: its stat still matches and is no longer racy.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { Git } from "../src/index.js";
import {
  kvFactory,
  memoryFactory,
  sqlFactory,
  type WorkingCopyFactory,
} from "./backend-factories.js";

const stores: Array<{ name: string; factory: WorkingCopyFactory }> = [
  { name: "Memory", factory: memoryFactory },
  { name: "SQL", factory: sqlFactory },
  { name: "KV", factory: kvFactory },
];

const encode = (s: string) => new TextEncoder().encode(s);

describe.each(stores)("racy smudging on the $name staging store", ({ factory }) => {
  let now = 0;
  afterEach(() => vi.restoreAllMocks());

  /** A clock the worktree's mtimes and the store's write times both follow. */
  const clock = (start: number) => {
    now = start;
    vi.spyOn(Date, "now").mockImplementation(() => now);
  };

  async function setup() {
    const ctx = await factory();
    const git = Git.fromWorkingCopy(ctx.workingCopy);
    const worktree = ctx.workingCopy.worktree;
    const staging = ctx.workingCopy.checkout.staging;
    return { ctx, git, worktree, staging };
  }

  it("a same-size edit in the second of the add is smudged by the next write", async () => {
    // the middle of a second: the add, the edit and the next write all share it
    clock(1_700_000_000_400);
    const { ctx, git, worktree, staging } = await setup();
    await worktree.writeContent("a.txt", encode("1\n"));
    await git.add().addFilepattern("a.txt").call();
    expect((await staging.getEntry("a.txt"))?.size).toBe(2);

    now += 100;
    await worktree.writeContent("a.txt", encode("2\n"));
    // the edit keeps the stat the entry recorded (same size, same second)
    const entry = await staging.getEntry("a.txt");
    const file = await worktree.getEntry("a.txt");
    expect(Math.floor((file?.mtime ?? 0) / 1000)).toBe(Math.floor((entry?.mtime ?? 0) / 1000));

    now += 100;
    await worktree.writeContent("b.txt", encode("b\n"));
    await git.add().addFilepattern("b.txt").call();
    expect((await staging.getEntry("a.txt"))?.size).toBe(0);
    expect((await staging.getEntry("b.txt"))?.size).toBe(2);

    // seconds later, after another write, the edit is still seen
    now += 10_000;
    await worktree.writeContent("c.txt", encode("c\n"));
    await git.add().addFilepattern("c.txt").call();
    const status = await git.status().call();
    expect(status.modified).toEqual(new Set(["a.txt"]));
    await ctx.cleanup?.();
  });

  it("a write in a later second smudges nothing that did not change", async () => {
    clock(1_700_000_000_400);
    const { ctx, git, worktree, staging } = await setup();
    await worktree.writeContent("a.txt", encode("1\n"));
    await worktree.writeContent("old.txt", encode("o\n"));
    await git.add().addFilepattern("a.txt").addFilepattern("old.txt").call();

    // a write in the next second: nothing changed, nothing is smudged
    now += 1000;
    await worktree.writeContent("b.txt", encode("b\n"));
    await git.add().addFilepattern("b.txt").call();
    expect((await staging.getEntry("a.txt"))?.size).toBe(2);
    expect((await staging.getEntry("old.txt"))?.size).toBe(2);
    const status = await git.status().call();
    expect(status.modified.size + status.missing.size).toBe(0);
    await ctx.cleanup?.();
  });

  it("an explicit write() smudges too, against the time of the last write", async () => {
    clock(1_700_000_000_400);
    const { ctx, git, worktree, staging } = await setup();
    await worktree.writeContent("a.txt", encode("1\n"));
    await git.add().addFilepattern("a.txt").call();
    now += 100;
    await worktree.writeContent("a.txt", encode("2\n"));
    // any command installs the check; a status reads (and keeps) the racy entry
    expect((await git.status().call()).modified).toEqual(new Set(["a.txt"]));
    await staging.write();
    expect((await staging.getEntry("a.txt"))?.size).toBe(0);
    await ctx.cleanup?.();
  });
});

describe("the KV and SQL stores keep their index time with the entries", () => {
  afterEach(() => vi.restoreAllMocks());

  it("KV: read() restores the time of the last write", async () => {
    let now = 1_700_000_000_400;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const ctx = await kvFactory();
    const staging = ctx.workingCopy.checkout.staging;
    await staging.setEntry({ path: "a.txt", mode: 0o100644, objectId: "a".repeat(40), size: 1 });
    now += 60_000;
    await staging.read();
    expect(staging.getUpdateTime()).toBe(1_700_000_000_400);
  });

  it("SQL: read() restores the time of the last write", async () => {
    let now = 1_700_000_000_400;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const ctx = await sqlFactory();
    const staging = ctx.workingCopy.checkout.staging;
    await staging.setEntry({ path: "a.txt", mode: 0o100644, objectId: "a".repeat(40), size: 1 });
    now += 60_000;
    await staging.read();
    expect(staging.getUpdateTime()).toBe(1_700_000_000_400);
    await ctx.cleanup?.();
  });
});
