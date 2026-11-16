/**
 * Blame output in git's formats on a small history: the porcelain record of each run of
 * lines (details once per commit, `boundary` for the root commit, `previous` for a commit
 * whose parent had the file), the default output's `^` column, `-L` ranges, `-w`, and
 * renames followed by default.
 */
import type { Commit } from "@statewalker/vcs-core";
import { afterEach, describe, expect, it } from "vitest";

import { formatBlame, formatBlamePorcelain } from "../src/index.js";
import { addFile, backends, createInitializedGitFromFactory, removeFile } from "./test-helper.js";

const dec = new TextDecoder();

function details(c: Commit, summary: string): string {
  return (
    `author ${c.author.name}\nauthor-mail <${c.author.email}>\nauthor-time ${c.author.timestamp}\n` +
    `author-tz ${c.author.tzOffset}\ncommitter ${c.committer.name}\n` +
    `committer-mail <${c.committer.email}>\ncommitter-time ${c.committer.timestamp}\n` +
    `committer-tz ${c.committer.tzOffset}\nsummary ${summary}\n`
  );
}

describe.each(backends)("blame output ($name backend)", ({ factory }) => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  async function history() {
    const result = await createInitializedGitFromFactory(factory);
    cleanup = result.cleanup;
    const { git, workingCopy, repository } = result;
    await addFile(workingCopy, "f.txt", "a\nb\nc\n");
    await git.commit().setMessage("one").call();
    const one = (await repository.refs.resolve("HEAD"))?.objectId ?? "";
    await addFile(workingCopy, "f.txt", "a\nB\nc\nd\n");
    await git.commit().setMessage("two").call();
    const two = (await repository.refs.resolve("HEAD"))?.objectId ?? "";
    const c1 = (await repository.commits.load(one)) as Commit;
    const c2 = (await repository.commits.load(two)) as Commit;
    return { git, workingCopy, repository, one, two, c1, c2 };
  }

  it("prints --porcelain as git does", async () => {
    const { git, one, two, c1, c2 } = await history();
    const result = await git.blame().setFilePath("f.txt").setShowRoot(false).call();
    // the initial commit of the test repository is the root: "one" has a parent
    expect(dec.decode(formatBlamePorcelain(result))).toBe(
      `${one} 1 1 1\n${details(c1, "one")}filename f.txt\n\ta\n` +
        `${two} 2 2 1\n${details(c2, "two")}previous ${one} f.txt\nfilename f.txt\n\tB\n` +
        `${one} 3 3 1\n\tc\n` +
        `${two} 4 4 1\n\td\n`,
    );
  });

  it("widens the id column for a boundary commit and marks it with ^", async () => {
    const result = await createInitializedGitFromFactory(factory);
    cleanup = result.cleanup;
    const { git, workingCopy, repository } = result;
    await addFile(workingCopy, "g.txt", "x\ny");
    await git.commit().setMessage("g").call();
    const id = (await repository.refs.resolve("HEAD"))?.objectId ?? "";
    const blame = await git.blame().setFilePath("g.txt").call();
    const root = (await repository.commits.load(id))?.parents.length === 0;
    const text = dec.decode(formatBlame(blame, { noAuthor: true }));
    expect(text).toBe(
      root
        ? `^${id.slice(0, 7)} 1) x\n^${id.slice(0, 7)} 2) y\n`
        : `${id.slice(0, 7)} 1) x\n${id.slice(0, 7)} 2) y\n`,
    );
  });

  it("blames only the -L ranges", async () => {
    const { git, two } = await history();
    const result = await git
      .blame()
      .setFilePath("f.txt")
      .setLineRanges([
        [2, 2],
        [4, 4],
      ])
      .call();
    expect(result.entries.map((e) => [e.commitId, e.resultStart, e.lineCount])).toEqual([
      [two, 2, 1],
      [two, 4, 1],
    ]);
  });

  it("passes whitespace-only changes to the parent with -w", async () => {
    const { git, workingCopy, one } = await history();
    await addFile(workingCopy, "f.txt", "a \nB\nc\nd\n");
    await git.commit().setMessage("three").call();
    const plain = await git.blame().setFilePath("f.txt").call();
    const ws = await git.blame().setFilePath("f.txt").setIgnoreWhitespace(true).call();
    expect(plain.getEntry(1)?.commitId).not.toBe(one);
    expect(ws.getEntry(1)?.commitId).toBe(one);
  });

  it("follows a whole-file rename by default", async () => {
    const { git, workingCopy, one } = await history();
    await removeFile(workingCopy, "f.txt");
    await addFile(workingCopy, "renamed.txt", "a\nB\nc\nd\n");
    await git.commit().setMessage("rename").call();
    const result = await git.blame().setFilePath("renamed.txt").call();
    expect(result.getEntry(1)?.commitId).toBe(one);
    expect(result.getEntry(1)?.sourcePath).toBe("f.txt");
    const noFollow = await git.blame().setFilePath("renamed.txt").setFollowRenames(false).call();
    expect(noFollow.getEntry(1)?.commitId).not.toBe(one);
  });
});
