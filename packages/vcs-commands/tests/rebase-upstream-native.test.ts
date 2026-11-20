/**
 * `rebase().setUpstream(<revision>)` against native `git rebase <revision>`: the upstream is
 * a name resolved when the rebase starts (it was once written into `.git/HEAD` as given),
 * the reflog keeps the name (`checkout main`), and a name that resolves to nothing fails
 * with git's `fatal: invalid upstream '<x>'` with nothing written.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GitApiError, RebaseStatus } from "../src/index.js";
import { git, INTEROP_IDENT, normalizeState, openOurs, snapshot } from "./merge-native-helpers.js";
import { buildHistory, type History, text } from "./merge-native-scenarios.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root: string;
let counter = 0;

const history: History = {
  base: { "a.txt": text() },
  main: { "a.txt": text({ 1: "main" }) },
  side: { "a.txt": text({ 9: "side" }), "n.txt": "n\n" },
  sideMore: [{ "o.txt": "o\n" }],
};

/** The history built twice, both twins on `side`. */
function twins(): { native: string; ours: string } {
  const n = counter++;
  const native = join(root, `native-${n}`);
  const ours = join(root, `ours-${n}`);
  for (const dir of [native, ours]) {
    buildHistory(root, dir, history);
    git(root, dir, "checkout", "-q", "side");
  }
  return { native, ours };
}

const reflog = (dir: string) => git(root, dir, "reflog", "--format=%H %gs", "HEAD").stdout;

describeGit("rebase: an upstream given by name", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "rebase-upstream-"));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  for (const upstream of ["main", "main~0", "refs/heads/main"]) {
    it(`setUpstream("${upstream}") rebases as git rebase ${upstream}`, async () => {
      const { native, ours } = twins();
      expect(git(root, native, "rebase", upstream).status).toBe(0);
      const result = await (await openOurs(ours))
        .rebase()
        .setCommitter(INTEROP_IDENT)
        .setUpstream(upstream)
        .call();
      expect(result.status).toBe(RebaseStatus.OK);
      expect(readFileSync(join(ours, ".git/HEAD"), "utf8")).toBe("ref: refs/heads/side\n");
      expect(snapshot(root, ours, normalizeState)).toEqual(snapshot(root, native, normalizeState));
      // "rebase (start): checkout main", the name as given
      expect(reflog(ours)).toBe(reflog(native));
    });
  }

  it("an upstream naming nothing fails with git's message, nothing written", async () => {
    const { native, ours } = twins();
    const expected = git(root, native, "rebase", "nope");
    expect(expected.status).toBe(128);
    const before = snapshot(root, ours, normalizeState);
    let error: unknown;
    try {
      await (await openOurs(ours)).rebase().setCommitter(INTEROP_IDENT).setUpstream("nope").call();
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(GitApiError);
    expect((error as GitApiError).message).toBe(expected.stderr.trim());
    expect((error as GitApiError).exitCode).toBe(expected.status);
    expect(readFileSync(join(ours, ".git/HEAD"), "utf8")).toBe("ref: refs/heads/side\n");
    expect(snapshot(root, ours, normalizeState)).toEqual(before);
    expect(snapshot(root, ours, normalizeState)).toEqual(snapshot(root, native, normalizeState));
  });

  it("an upstream naming a tree fails with git's lines", async () => {
    const { native, ours } = twins();
    const expected = git(root, native, "rebase", "main^{tree}");
    let error: unknown;
    try {
      await (await openOurs(ours))
        .rebase()
        .setCommitter(INTEROP_IDENT)
        .setUpstream("main^{tree}")
        .call();
    } catch (e) {
      error = e;
    }
    expect((error as GitApiError).message).toBe(expected.stderr.trim());
    expect((error as GitApiError).exitCode).toBe(expected.status);
    expect(readFileSync(join(ours, ".git/HEAD"), "utf8")).toBe("ref: refs/heads/side\n");
  });
});
