/**
 * git's attributes (`attr.c`) and content conversion (`convert.c`), portable parts: the
 * values here are what native git gives for the same input (checked with `git check-attr`,
 * `git hash-object --path` and `git ls-files --eol` when written); the native-git twins in
 * `@statewalker/vcs-commands` compare them end to end.
 */
import type { Blobs, Trees } from "@statewalker/vcs-core";
import { describe, expect, it } from "vitest";
import {
  AttributesResolver,
  attributePatternMatches,
  parseAttributePattern,
  parseAttributes,
} from "../../src/attributes/index.js";
import {
  countIdent,
  crlfToGit,
  crlfToWorktree,
  DEFAULT_EOL_SETTINGS,
  eolStatsAscii,
  GitContentFilter,
  identToGit,
  identToWorktree,
  isBinaryContent,
  reencode,
  SafeCrlfError,
  validateEncoding,
} from "../../src/convert/index.js";
import { createMemoryWorktree } from "../../src/worktree/index.js";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

function resolver(files: Record<string, string>, extra: { info?: string; global?: string } = {}) {
  return new AttributesResolver({
    inTree: async (dir) => files[dir],
    ...(extra.info !== undefined ? { info: async () => extra.info } : {}),
    ...(extra.global !== undefined ? { global: async () => extra.global } : {}),
  });
}

describe("attributes: parsing", () => {
  it("reads states, quoted patterns, macros, and drops what git drops (with its warnings)", () => {
    const warnings: string[] = [];
    const rules = parseAttributes(
      [
        "# comment",
        "*.txt text -diff !merge eol=crlf",
        '"a b.txt" binary',
        "[attr]mine text eol=lf",
        "!neg text",
        "x -bad=1 9ok",
        "y in valid!",
      ].join("\n"),
      { source: ".gitattributes", macrosAllowed: false, onWarning: (m) => warnings.push(m) },
    );
    expect(rules).toHaveLength(3);
    expect(rules[0]).toMatchObject({
      kind: "pattern",
      states: [
        { name: "text", setting: true },
        { name: "diff", setting: false },
        { name: "merge", setting: null },
        { name: "eol", setting: "crlf" },
      ],
    });
    expect(rules[1]).toMatchObject({ kind: "pattern", pattern: { pattern: "a b.txt" } });
    expect(warnings).toEqual([
      "[attr]mine text eol=lf not allowed: .gitattributes:4",
      "Negative patterns are ignored in git attributes\nUse '\\!' for literal leading exclamation.",
      "valid! is not a valid attribute name: .gitattributes:7",
    ]);
  });

  it("matches patterns as git's path_matches: basename, anchored, relative to the file's directory", () => {
    const m = (p: string, path: string, base = "") =>
      attributePatternMatches(parseAttributePattern(p), path, base);
    expect(m("*.txt", "a/b/c.txt")).toBe(true);
    expect(m("/c.txt", "a/c.txt")).toBe(false);
    expect(m("c.txt", "a/c.txt", "a")).toBe(true);
    expect(m("b/*.txt", "a/b/c.txt", "a")).toBe(true);
    expect(m("b/*.txt", "a/b/c.txt")).toBe(false);
    expect(m("a/**", "a/b/c.txt")).toBe(true);
    expect(m("dir/", "dir")).toBe(false);
    expect(
      attributePatternMatches(parseAttributePattern("*.TXT"), "x.txt", "", { ignoreCase: true }),
    ).toBe(true);
  });
});

describe("attributes: resolution", () => {
  it("deeper files and info/attributes win; later lines and states win; macros expand when set", async () => {
    const r = resolver(
      {
        "": "[attr]mine text eol=crlf\n*.txt text eol=lf\n*.txt eol=crlf\n*.bin binary\n",
        sub: "*.txt -text mine\n*.dat mine\n*.raw -mine\n",
      },
      { info: "info.txt !text\n" },
    );
    expect(Object.fromEntries(await r.get("a.txt"))).toEqual({ text: true, eol: "crlf" });
    // the macro set later on the same line wins over -text
    expect(Object.fromEntries(await r.get("sub/a.txt"))).toEqual({
      text: true,
      eol: "crlf",
      mine: true,
    });
    expect(Object.fromEntries(await r.get("sub/x.raw"))).toEqual({ mine: false });
    expect(Object.fromEntries(await r.get("x.bin"))).toEqual({
      binary: true,
      diff: false,
      merge: false,
      text: false,
    });
    expect((await r.get("info.txt", ["text", "eol"])).get("text")).toBeUndefined();
    expect((await r.get("info.txt", ["text", "eol"])).get("eol")).toBe("crlf");
  });
});

describe("line endings", () => {
  const settings = DEFAULT_EOL_SETTINGS;
  it("classifies content as git's ls-files --eol does", () => {
    expect(eolStatsAscii(enc("a\nb\n"))).toBe("lf");
    expect(eolStatsAscii(enc("a\r\nb\r\n"))).toBe("crlf");
    expect(eolStatsAscii(enc("a\r\nb\n"))).toBe("mixed");
    expect(eolStatsAscii(enc("a\rb\n"))).toBe("-text");
    expect(eolStatsAscii(enc("a\0b"))).toBe("-text");
    expect(eolStatsAscii(enc("abc"))).toBe("none");
    expect(eolStatsAscii(new Uint8Array())).toBe("none");
    expect(isBinaryContent(enc(`${"x".repeat(128)}\x01`))).toBe(false);
    expect(isBinaryContent(enc(`${"x".repeat(128)}\x01\x02`))).toBe(true);
  });

  it("cleans and smudges as convert.c (auto skips binary and lone CR; text keeps lone CR)", async () => {
    expect(dec(await crlfToGit("a", enc("a\r\nb\r\n"), "text-input", settings))).toBe("a\nb\n");
    expect(dec(await crlfToGit("a", enc("a\r\rb\r\n"), "text-input", settings))).toBe("a\r\rb\n");
    expect(dec(await crlfToGit("a", enc("a\rb\r\n"), "auto", settings))).toBe("a\rb\r\n");
    expect(
      dec(
        await crlfToGit("a", enc("a\r\n"), "auto", settings, { hasCrlfInIndex: async () => true }),
      ),
    ).toBe("a\r\n");
    expect(dec(crlfToWorktree(enc("a\nb\r\nc\n"), "text-crlf", settings))).toBe("a\r\nb\r\nc\r\n");
    // auto does not touch a file with CRLF in it
    expect(dec(crlfToWorktree(enc("a\nb\r\n"), "auto-crlf", settings))).toBe("a\nb\r\n");
  });

  it("core.safecrlf: warns or refuses as git", async () => {
    const warnings: string[] = [];
    await crlfToGit("x.txt", enc("a\nb\n"), "text-crlf", settings, {
      roundTrip: "warn",
      onWarning: (m) => warnings.push(m),
    });
    expect(warnings).toEqual([
      "in the working copy of 'x.txt', LF will be replaced by CRLF the next time Git touches it",
    ]);
    await expect(
      crlfToGit("x.txt", enc("a\r\nb\n"), "text-input", settings, { roundTrip: "die" }),
    ).rejects.toThrow(new SafeCrlfError("CRLF would be replaced by LF in x.txt"));
  });
});

describe("ident and working-tree-encoding", () => {
  it("expands and collapses $Id$ as git", () => {
    const id = "d670460b4b4aece5915caf5c68d12f560a9fe3e4";
    const src = enc("$Id$ $Id: x $ $Id: a b $ $Id\n");
    expect(countIdent(src)).toBe(3);
    expect(dec(identToWorktree(src, id))).toBe(`$Id: ${id} $ $Id: ${id} $ $Id: a b $ $Id\n`);
    expect(dec(identToGit(enc(`$Id: ${id} $ $Id: a b $`)))).toBe("$Id$ $Id$");
  });

  it("re-encodes UTF-16 with git's BOM rules", () => {
    const utf8 = enc("hé\n");
    const u16 = reencode(utf8, "UTF-16", "UTF-8");
    expect(Array.from(u16 ?? [])).toEqual([0xff, 0xfe, 0x68, 0, 0xe9, 0, 0x0a, 0]);
    expect(dec(reencode(u16 ?? new Uint8Array(), "UTF-8", "UTF-16") ?? new Uint8Array())).toBe(
      "hé\n",
    );
    expect(Array.from(reencode(utf8, "UTF-16BE", "UTF-8") ?? [])).toEqual([
      0, 0x68, 0, 0xe9, 0, 0x0a,
    ]);
    expect(validateEncoding("a", "UTF-16", new Uint8Array([0x68, 0]))?.error).toBe(
      "BOM is required in 'a' if encoded as UTF-16",
    );
    expect(validateEncoding("a", "utf-16le", new Uint8Array([0xff, 0xfe]))?.error).toBe(
      "BOM is prohibited in 'a' if encoded as utf-16le",
    );
    expect(reencode(utf8, "SHIFT-JIS", "UTF-8")).toBeUndefined();
  });
});

describe("GitContentFilter on a memory worktree", () => {
  const stores = { blobs: {} as Blobs, trees: {} as Trees };
  it("hashes and writes through the filter (core.autocrlf=true) and leaves links alone", async () => {
    const worktree = createMemoryWorktree(stores);
    const config = { "core.autocrlf": "true" } as Record<string, unknown>;
    worktree.setContentFilter?.(new GitContentFilter({ worktree, config }));
    await worktree.writeContent("a.txt", enc("one\ntwo\n"));
    let content: Uint8Array = new Uint8Array();
    for await (const chunk of worktree.readContent("a.txt")) content = chunk;
    expect(dec(content)).toBe("one\r\ntwo\r\n");
    // the blob of "one\ntwo\n"
    expect(await worktree.computeHash("a.txt")).toBe("814f4a422927b82f5f8a43f8fab6d3839e3983f2");
    await worktree.writeContent("raw.txt", enc("x\n"), { raw: true });
    for await (const chunk of worktree.readContent("raw.txt")) content = chunk;
    expect(dec(content)).toBe("x\n");
    await worktree.writeContent("link", enc("target\n"), { mode: 0o120000 });
    for await (const chunk of worktree.readContent("link")) content = chunk;
    expect(dec(content)).toBe("target\n");
  });
});
