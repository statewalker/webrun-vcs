import { describe, expect, it } from "vitest";
import { createCommits } from "../../../src/history/commits/commits.impl.js";
import {
  createReplacedCommits,
  loadObjectReplacements,
  parseGraftFile,
  ReplaceDepthError,
  replacementOf,
} from "../../../src/history/commits/object-replacements.js";
import { createGitObjects } from "../../../src/history/objects/index.js";
import { MemoryRefs } from "../../../src/history/refs/refs.impl.js";
import { rawStorageStaging } from "../../../src/storage/adapters/staging-blob-store.js";
import { MemoryRawStorage } from "../../../src/storage/raw/memory-raw-storage.js";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

describe("parseGraftFile (git's read_graft_line)", () => {
  it("reads commits and parents, skips comments and blank lines, reports bad lines", () => {
    const { grafts, messages } = parseGraftFile(
      `# comment\n\n${A} ${B} ${C}  \n${B}\n${C}\tnot-an-id\n${A} ${C}\n`,
    );
    expect([...grafts]).toEqual([
      [A, [B, C]],
      [B, []],
    ]);
    expect(messages).toEqual([
      `error: bad graft data: ${C}\tnot-an-id`,
      `error: duplicate graft data: ${A} ${C}`,
    ]);
  });
});

describe("replacementOf (git's lookup_replace_object)", () => {
  it("follows replacements, at most five deep", () => {
    expect(replacementOf(new Map([[A, B]]), A)).toBe(B);
    expect(
      replacementOf(
        new Map([
          [A, B],
          [B, C],
        ]),
        A,
      ),
    ).toBe(C);
    expect(replacementOf(new Map(), A)).toBe(A);
    const loop = new Map([
      [A, B],
      [B, A],
    ]);
    expect(() => replacementOf(loop, A)).toThrow(ReplaceDepthError);
  });
});

describe("createReplacedCommits", () => {
  it("reads replacements under the replaced id and grafted parents, walks with them", async () => {
    const commits = createCommits(createGitObjects(rawStorageStaging(new MemoryRawStorage())));
    const ident = (t: number) => ({ name: "A", email: "a@x", timestamp: t, tzOffset: "+0000" });
    const store = (message: string, parents: string[], t: number) =>
      commits.store({ tree: TREE, parents, author: ident(t), committer: ident(t), message });
    const one = await store("one\n", [], 1);
    const two = await store("two\n", [one], 2);
    const three = await store("three\n", [two], 3);
    const other = await store("other\n", [], 4);
    const refs = new MemoryRefs();
    await refs.set(`refs/replace/${two}`, other);
    const loaded = await loadObjectReplacements({ refs });
    expect([...loaded.replace]).toEqual([[two, other]]);
    const replaced = createReplacedCommits(commits, async () => ({
      replace: loaded.replace,
      grafts: new Map([[three, [one]]]),
    }));
    expect((await replaced.load(two))?.message).toBe("other\n");
    expect(await replaced.getParents(three)).toEqual([one]);
    expect(await replaced.isAncestor(two, three)).toBe(false);
    expect(await replaced.findMergeBase(three, two)).toEqual([]);
    const walked: string[] = [];
    for await (const id of replaced.walkAncestry(three)) walked.push(id);
    expect(walked).toEqual([three, one]);
    // without replacements, the store itself
    const plain = createReplacedCommits(commits, async () => undefined);
    expect(await plain.getParents(three)).toEqual([two]);
    expect((await loadObjectReplacements({ refs, useReplaceRefs: false })).replace.size).toBe(0);
  });
});
