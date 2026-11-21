/**
 * Filter specs as git's list-objects-filter-options.c parses them: each choice, `combine:`
 * with percent-encoded sub-specs, git_parse_ulong's numbers, and the messages git dies with
 * (2.43's where they differ), plus the filtered walk's order-dependent answers.
 */
import { describe, expect, it } from "vitest";
import {
  canFilterBitmap,
  listObjects,
  ObjectFilterError,
  parseGitUlong,
  parseObjectFilter,
  resolveObjectFilter,
} from "../../src/pack/index.js";
import { blob, commit, memObjects, tree } from "./history-builder.js";

const refusal = (spec: string, compatibility?: "2.43") => {
  try {
    parseObjectFilter(spec, compatibility ? { compatibility } : {});
  } catch (e) {
    expect(e).toBeInstanceOf(ObjectFilterError);
    return (e as Error).message;
  }
  return undefined;
};

describe("parseObjectFilter", () => {
  it("parses each choice", () => {
    expect(parseObjectFilter("blob:none")).toEqual({ choice: "blob:none" });
    expect(parseObjectFilter("blob:limit=1k")).toEqual({ choice: "blob:limit", limit: 1024 });
    expect(parseObjectFilter("blob:limit=0x10")).toEqual({ choice: "blob:limit", limit: 16 });
    expect(parseObjectFilter("tree:010")).toEqual({ choice: "tree", depth: 8 });
    expect(parseObjectFilter("sparse:oid=main:spec")).toEqual({
      choice: "sparse:oid",
      name: "main:spec",
    });
    expect(parseObjectFilter("object:type=tag")).toEqual({ choice: "object:type", type: "tag" });
    expect(parseObjectFilter("combine:blob%3Anone+tree%3A1")).toEqual({
      choice: "combine",
      filters: [{ choice: "blob:none" }, { choice: "tree", depth: 1 }],
    });
  });

  it("refuses with git's messages", () => {
    expect(refusal("auto")).toBe("'auto' filter not supported by this command");
    expect(refusal("auto", "2.43")).toBe("invalid filter-spec 'auto'");
    expect(refusal("bogus")).toBe("invalid filter-spec 'bogus'");
    expect(refusal("blob:limit=")).toBe("invalid filter-spec 'blob:limit='");
    expect(refusal("blob:limit=1x")).toBe("invalid filter-spec 'blob:limit=1x'");
    expect(refusal("blob:limit=-1")).toBe("invalid filter-spec 'blob:limit=-1'");
    expect(refusal("tree:")).toBe("expected 'tree:<depth>'");
    expect(refusal("tree:-1")).toBe("expected 'tree:<depth>'");
    expect(refusal("sparse:path=x")).toBe("sparse:path filters support has been dropped");
    expect(refusal("object:type=TAG")).toBe(
      "'TAG' for 'object:type=<type>' is not a valid object type",
    );
    expect(refusal("object:type=")).toBe("'' for 'object:type=<type>' is not a valid object type");
    expect(refusal("combine:")).toBe("expected something after combine:");
    expect(refusal("combine:blob:none+a b")).toBe("must escape char in sub-filter-spec: ' '");
    expect(refusal("combine:a~b")).toBe("must escape char in sub-filter-spec: '~'");
    expect(refusal("combine:%41")).toBe("invalid filter-spec 'A'");
    expect(refusal("combine:blob:none+tree:x")).toBe("expected 'tree:<depth>'");
    // 2.5x skips empty sub-specs, 2.43 refuses them
    expect(refusal("combine:blob:none++tree:1")).toBeUndefined();
    expect(refusal("combine:+blob:none", "2.43")).toBe("invalid filter-spec ''");
  });

  it("reads numbers as git_parse_ulong", () => {
    expect(parseGitUlong(" 5")).toBe(5);
    expect(parseGitUlong("+5")).toBe(5);
    expect(parseGitUlong("2G")).toBe(2 * 1024 ** 3);
    expect(parseGitUlong("0x")).toBeUndefined();
    expect(parseGitUlong("08")).toBeUndefined();
    expect(parseGitUlong("18446744073709551616")).toBeUndefined();
    expect(parseGitUlong("")).toBeUndefined();
  });

  it("says which filters bitmaps apply", () => {
    expect(canFilterBitmap(parseObjectFilter("combine:blob:limit=1+tree:0"))).toBe(true);
    expect(canFilterBitmap(parseObjectFilter("tree:1"))).toBe(false);
    expect(canFilterBitmap(parseObjectFilter("sparse:oid=x"))).toBe(false);
  });
});

describe("listObjects with a filter", () => {
  it("re-walks a tree met again nearer the root (tree:<depth>), and combines in git's order", async () => {
    const objects = memObjects();
    const leaf = await blob(objects, "leaf\n");
    const lib = await tree(objects, [["100644", "l.txt", leaf]]);
    const deep = await tree(objects, [["40000", "lib", lib]]);
    // `a/lib` (depth 2) is walked before `lib` (depth 1)
    const root = await tree(objects, [
      ["40000", "a", deep],
      ["40000", "lib", lib],
    ]);
    const c = await commit(objects, root, [], 1000, "c");
    const list = async (spec: string) => {
      const filter = await resolveObjectFilter(parseObjectFilter(spec), async () => () => true);
      const out: string[] = [];
      for await (const o of listObjects(objects, { wants: [c], filter })) out.push(o.id);
      return out.sort();
    };
    expect(await list("tree:2")).toEqual([c, root, deep, lib].sort());
    expect(await list("tree:3")).toEqual([c, root, deep, lib, leaf].sort());
    // blob:none marks lib seen under a/ (depth 2, where tree:2 omits it): never shown after
    expect(await list("combine:blob:none+tree:2")).toEqual([c, root, deep].sort());
  });
});
