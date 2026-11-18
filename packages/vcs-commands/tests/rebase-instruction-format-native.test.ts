/**
 * `rebase.instructionFormat`: the todo lines carry each commit through git's pretty format
 * (`# ` added before a format that does not start with `#`, as git 2.5x does), and the
 * `Could not apply <id>... <rest>` line repeats the todo line's text. Native twins: the same
 * history rebased by native git and by ours, `git-rebase-todo`, `done` and the stop line
 * compared byte for byte.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RebaseOperation, RebaseStatus } from "../src/index.js";
import { git, INTEROP_IDENT, openOurs } from "./merge-native-helpers.js";
import { buildHistory, type History, text } from "./merge-native-scenarios.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root: string;
let counter = 0;

/** git 2.45+ puts `# ` before the format (2.43 writes the format as it is, default `%s`). */
function prefixesFormat(): boolean {
  const version = git(root, root, "--version").stdout.match(/(\d+)\.(\d+)/);
  return !!version && (Number(version[1]) > 2 || Number(version[2]) >= 45);
}

/** side: c.txt, then a.txt line 5 (conflicts with main), then d.txt. */
const conflicting: History = {
  base: { "a.txt": text(), "b.txt": "b\n" },
  main: { "a.txt": text({ 5: "main" }), "m.txt": "m\n" },
  side: { "c.txt": "c\n" },
  sideMore: [{ "a.txt": text({ 5: "side" }) }, { "d.txt": "d\n" }],
};

const read = (dir: string, name: string) =>
  readFileSync(join(dir, ".git", "rebase-merge", name), "utf8");

describeGit("rebase.instructionFormat, native twins", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "rebase-format-"));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  for (const format of [
    "%s",
    "# %s",
    "[%an <%ae>] %s",
    "%h %t %p %H %T %P",
    "%ad | %aD | %at | %ai | %as | %al | %cn %ce %cd",
    // single-line expansions only (no body): a line break in the todo is a BUG() in git
    "%f %%%x21 %Cred%s%Creset %C(yellow)%e%C(reset)",
    "%e%+e%-e% s %q %w unknown %",
    "",
  ]) {
    it(`rebase stops at a conflict with format ${JSON.stringify(format)}`, async () => {
      // ours writes as git 2.5x (2.43: no `# ` before the default format nor an added one)
      if (!prefixesFormat()) return;
      const n = counter++;
      const native = join(root, `native-${n}`);
      const ours = join(root, `ours-${n}`);
      for (const dir of [native, ours]) {
        buildHistory(root, dir, conflicting);
        git(root, dir, "checkout", "-q", "side");
        git(root, dir, "config", "rebase.instructionFormat", format);
      }
      const expected = git(root, native, "rebase", "main");
      const command = (await openOurs(ours)).rebase().setCommitter(INTEROP_IDENT);
      await command.setUpstreamBranch("main");
      const result = await command.call();
      expect(result.status).toBe(RebaseStatus.STOPPED);
      expect(read(ours, "git-rebase-todo")).toBe(read(native, "git-rebase-todo"));
      expect(read(ours, "done")).toBe(read(native, "done"));
      const stop = (s: string) => s.split("\n").filter((l) => l.startsWith("Could not apply"));
      expect(stop(result.message ?? "")).toEqual(stop(expected.stderr));

      // each continues past the conflict: the todo's text is kept as written
      for (const dir of [native, ours]) {
        git(root, dir, "checkout", "--theirs", "a.txt");
        git(root, dir, "add", "a.txt");
      }
      git(root, native, "rebase", "--continue");
      const continued = await (await openOurs(ours))
        .rebase()
        .setCommitter(INTEROP_IDENT)
        .setOperation(RebaseOperation.CONTINUE)
        .call();
      expect(continued.status).toBe(RebaseStatus.OK);
      expect(git(root, ours, "rev-parse", "HEAD").stdout).toBe(
        git(root, native, "rev-parse", "HEAD").stdout,
      );
    });
  }
});
