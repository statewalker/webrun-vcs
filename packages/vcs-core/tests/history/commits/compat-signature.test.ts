/**
 * A commit or tag signed in a repository with a compatibility object format carries both
 * formats' signatures (git's `commit_tree_extended`, builtin/tag.c `do_sign`): the commit
 * model's `compatSignature` is written under the other format's header, `gpgsig` (SHA-1)
 * before `gpgsig-sha256` whichever the storage format is; a tag's in its header.
 */
import { describe, expect, it } from "vitest";
import {
  commitToEntries,
  encodeCommitEntries,
  entriesToCommit,
} from "../../../src/history/commits/commit-format.js";
import type { Commit } from "../../../src/history/commits/commits.js";
import { encodeTagEntries, tagToEntries } from "../../../src/history/tags/tag-format.js";

const ident = { name: "A", email: "a@example.com", timestamp: 1700000000, tzOffset: "+0000" };
const text = async (chunks: AsyncIterable<Uint8Array>) => {
  let out = "";
  for await (const c of chunks) out += new TextDecoder().decode(c);
  return out;
};

describe("compatibility signatures", () => {
  const base: Commit = {
    tree: "a".repeat(64),
    parents: [],
    author: ident,
    committer: ident,
    message: "one\n",
    gpgSignature: "STORAGE\n\nsig",
  };

  it("SHA-256 storage: the SHA-1 view's gpgsig first, then gpgsig-sha256", async () => {
    const commit: Commit = { ...base, compatSignature: { header: "gpgsig", value: "COMPAT" } };
    const bytes = await text(encodeCommitEntries(commitToEntries(commit), "gpgsig-sha256"));
    expect(bytes).toBe(
      `tree ${"a".repeat(64)}\nauthor A <a@example.com> 1700000000 +0000\n` +
        "committer A <a@example.com> 1700000000 +0000\n" +
        "gpgsig COMPAT\ngpgsig-sha256 STORAGE\n \n sig\n\none\n",
    );
    // entries back into the model keep both apart
    expect(await entriesToCommit(commitToEntries(commit))).toEqual(commit);
  });

  it("SHA-1 storage: gpgsig first, then the SHA-256 view's gpgsig-sha256", async () => {
    const commit: Commit = {
      ...base,
      tree: "a".repeat(40),
      compatSignature: { header: "gpgsig-sha256", value: "COMPAT" },
    };
    const bytes = await text(encodeCommitEntries(commitToEntries(commit), "gpgsig"));
    expect(bytes).toContain("\ngpgsig STORAGE\n \n sig\ngpgsig-sha256 COMPAT\n\none\n");
  });

  it("a tag carries the compatibility signature as a header", async () => {
    const bytes = await text(
      encodeTagEntries(
        tagToEntries({
          object: "b".repeat(64),
          objectType: 1,
          tag: "v1",
          tagger: ident,
          message: "release\nSTORAGE SIG\n",
          compatSignature: { header: "gpgsig", value: "C1\n\nC2" },
        }),
      ),
    );
    expect(bytes).toBe(
      `object ${"b".repeat(64)}\ntype commit\ntag v1\n` +
        "tagger A <a@example.com> 1700000000 +0000\ngpgsig C1\n \n C2\n\nrelease\nSTORAGE SIG\n",
    );
  });
});
