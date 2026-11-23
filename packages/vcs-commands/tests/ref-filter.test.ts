/**
 * The ref-filter module on every storage backend (memory, SQL: no object kernel, so objects
 * are re-encoded from the typed stores), and its pure helpers (git's versioncmp.c, quote.c,
 * the refname strips). The byte-for-byte checks against native git are in
 * for-each-ref-native.test.ts.
 */

import { afterEach, describe, expect, it } from "vitest";

import {
  lstripRef,
  quoteRefValue,
  RefFilterError,
  rstripRef,
  versionCompare,
} from "../src/index.js";
import { backends, createInitializedGitFromFactory } from "./test-helper.js";

describe("versionCompare (versioncmp.c)", () => {
  it("orders digits as numbers", () => {
    const names = ["foo1.10", "foo1.3", "foo1.6", "foo1.10.1", "foo01.2"];
    expect([...names].sort((a, b) => versionCompare(a, b))).toEqual([
      "foo01.2",
      "foo1.3",
      "foo1.6",
      "foo1.10",
      "foo1.10.1",
    ]);
  });

  it("puts pre-release suffixes before their release, in configuration order", () => {
    const names = ["v1.0", "v1.0-rc1", "v1.0-beta", "v1.0-rc2", "v2.0"];
    expect([...names].sort((a, b) => versionCompare(a, b, ["-beta", "-rc"]))).toEqual([
      "v1.0-beta",
      "v1.0-rc1",
      "v1.0-rc2",
      "v1.0",
      "v2.0",
    ]);
  });
});

describe("ref-filter helpers", () => {
  it("strips ref name components as git does", () => {
    expect(lstripRef("refs/heads/main", 1)).toBe("heads/main");
    expect(lstripRef("refs/heads/main", -1)).toBe("main");
    expect(lstripRef("refs/heads/main", 5)).toBe("");
    expect(rstripRef("refs/heads/main", 1)).toBe("refs/heads");
    expect(rstripRef("refs/heads/main", -2)).toBe("refs/heads");
    expect(rstripRef("refs/heads/main", 5)).toBe("");
  });

  it("quotes values for each language", () => {
    expect(quoteRefValue("it's!", "shell")).toBe("'it'\\''s'\\!''");
    expect(quoteRefValue("a'b\\c", "perl")).toBe("'a\\'b\\\\c'");
    expect(quoteRefValue("a\nb'", "python")).toBe("'a\\nb\\''");
    expect(quoteRefValue('[$x]\t"', "tcl")).toBe('"\\[\\$x\\]\\t\\""');
    expect(quoteRefValue("a\0b", "shell")).toBe("'a'");
    expect(quoteRefValue("a\0b", "perl", true)).toBe("'a\0b'");
  });
});

describe.each(backends)("forEachRef ($name backend)", ({ factory }) => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  async function setup() {
    const result = await createInitializedGitFromFactory(factory);
    cleanup = result.cleanup;
    const { git } = result;
    await git.branchCreate().setName("feature").call();
    await git.tag().setName("v1.10").call();
    await git.tag().setName("v1.9").setAnnotated(true).setMessage("Release 1.9\n\nNotes.").call();
    return result;
  }

  it("lists refs in name order with git's default format", async () => {
    const { git, initialCommitId } = await setup();
    const { output, refs } = await git.forEachRef().setPatterns("refs/heads/").call();
    expect(refs.map((r) => r.refname)).toEqual(["refs/heads/feature", "refs/heads/main"]);
    expect(output).toBe(
      `${initialCommitId} commit\trefs/heads/feature\n${initialCommitId} commit\trefs/heads/main\n`,
    );
  });

  it("formats tags through what they peel to, sorted as versions", async () => {
    const { git } = await setup();
    const { lines } = await git
      .forEachRef()
      .setFormat(
        "%(refname:short) %(objecttype) %(*objecttype) %(subject)%(if)%(body)%(then) [%(body)]%(end)",
      )
      .setSort("-version:refname")
      .setPatterns("refs/tags")
      .call();
    expect(lines).toEqual([
      "v1.10 commit  Initial commit",
      "v1.9 tag commit Release 1.9 [Notes.\n]",
    ]);
  });

  it("filters by reachability and counts", async () => {
    const { git } = await setup();
    const { lines } = await git
      .forEachRef()
      .setFormat("%(refname)")
      .setMerged("main")
      .setCount(2)
      .call();
    expect(lines).toEqual(["refs/heads/feature", "refs/heads/main"]);
  });

  it("refuses an unknown atom with git's message", async () => {
    const { git } = await setup();
    await expect(git.forEachRef().setFormat("%(bogus)").call()).rejects.toThrow(RefFilterError);
    await expect(git.forEachRef().setFormat("%(bogus)").call()).rejects.toThrow(
      "fatal: unknown field name: bogus",
    );
  });
});
