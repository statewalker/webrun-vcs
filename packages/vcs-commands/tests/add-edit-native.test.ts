/**
 * `git add -e` against native git (builtin/add.c's `edit_patch`): the worktree's diff (seven
 * lines of context) written to `.git/ADD_EDIT.patch`, the editor run over it, the result
 * applied to the index with `apply --cached --recount`. Both twins get the same scripted
 * editor; the text it was given, stderr, the index and the worktree are compared, and
 * `ADD_EDIT.patch` is left behind where git dies. Inputs from git's t/t3702-add-edit.sh.
 */

import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GitApiError } from "../src/index.js";
import {
  type Editor,
  editorOf,
  FAIL,
  gitOk,
  KEEP,
  native,
  openOurs,
  put,
  sed,
  view,
} from "./interactive-extras-native-support.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { CLEANUP_TIMEOUT, removeTempDir } from "./temp-dir-support.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root = "";
let counter = 0;

function twins(build: (dir: string) => void): { native: string; ours: string } {
  const n = counter++;
  const dirs = { native: join(root, `n${n}`), ours: join(root, `o${n}`) };
  for (const dir of [dirs.native, dirs.ours]) {
    gitOk(root, root, ["init", "-q", "-b", "main", dir]);
    build(dir);
  }
  return dirs;
}

const FILE = `LO, praise of the prowess of people-kings
of spear-armed Danes, in days long sped,
we have heard, and what honor the athelings won!
Oft Scyld the Scefing from squadroned foes,
from many a tribe, the mead-bench tore,
awing the earls. Since erst he lay
friendless, a foundling, fate repaid him:
for he waxed under welkin, in wealth he throve,
till before him the folk, both far and near,
who house by the whale-path, heard his mandate,
gave him gifts:  a good king he!
`;

const SECOND_PART = `To him an heir was afterward born,
a son in his halls, whom heaven sent
to favor the folk, feeling their woe
that erst they had lacked an earl for leader
so long a while; the Lord endowed him,
the Wielder of Wonder, with world's renown.
`;

/** t3702's `patch`: hunks with wrong counts that only `--recount` applies. */
const PATCH = `diff --git a/file b/file
index b9834b5..ef6e94c 100644
--- a/file
+++ b/file
@@ -3,1 +3,333 @@ of spear-armed Danes, in days long sped,
 we have heard, and what honor the athelings won!
+
 Oft Scyld the Scefing from squadroned foes,
@@ -2,7 +1,5 @@ awing the earls. Since erst he lay
 friendless, a foundling, fate repaid him:
+
 for he waxed under welkin, in wealth he throve,
`;

/** t3702's setup: `file` committed. */
function setup(dir: string): void {
  put(dir, "file", FILE);
  gitOk(root, dir, ["add", "file"]);
  gitOk(root, dir, ["commit", "-qm", "initial", "file"]);
}

/** An editor writing t3702's `patch` over the file (its fake-editor.sh). */
const REPLACE: Editor = {
  sh: `cat > "$1" <<'EOF'\n${PATCH}EOF`,
  js: () => PATCH,
};

async function compare(
  dirs: { native: string; ours: string },
  editors: Editor[],
  paths: string[] = [],
) {
  const n = native(
    root,
    dirs.native,
    ["add", "-e", ...(paths.length ? ["--", ...paths] : [])],
    [],
    editors,
  );
  const git = await openOurs(root, dirs.ours);
  const buffers: string[] = [];
  const cmd = git.add().setEdit(true).setEditor(editorOf(editors, buffers));
  for (const p of paths) cmd.addFilepattern(p);
  let errors = "";
  let status = 0;
  try {
    const result = await cmd.call();
    errors = result.edit?.errors ?? "";
  } catch (error) {
    expect(error).toBeInstanceOf(GitApiError);
    status = (error as GitApiError).exitCode;
    errors = `${(error as Error).message}\n`;
  }
  expect(status).toBe(n.status);
  // an editor's failure is the host's to report: git's own line about it is left out
  expect(errors).toBe(n.stderr.replace(/^error: there was a problem with the editor .*\n/im, ""));
  expect(buffers).toEqual(n.buffers);
  expect(view(root, dirs.ours)).toEqual(view(root, dirs.native));
  // left behind where git dies, removed after a patch applied
  const left = (dir: string) => existsSync(join(dir, ".git", "ADD_EDIT.patch"));
  expect(left(dirs.ours)).toBe(left(dirs.native));
  return n;
}

describeGit("add -e as native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "add-edit-native-"));
  });
  afterAll(() => removeTempDir(root), CLEANUP_TIMEOUT);

  it('t3702-add-edit.sh: "add -e"', async () => {
    await compare(
      twins((dir) => {
        setup(dir);
        put(dir, "file", SECOND_PART);
      }),
      [REPLACE],
    );
  });

  it('t3702-add-edit.sh: "add -e notices editor failure"', async () => {
    const n = await compare(
      twins((dir) => {
        setup(dir);
        put(dir, "file", `${FILE}change\n`);
      }),
      [FAIL],
    );
    expect(n.status).toBe(128);
  });

  it("takes a pathspec, the diff as it is, an emptied patch and one that does not apply", async () => {
    const build = (dir: string) => {
      put(dir, "f", Array.from({ length: 30 }, (_, i) => `${i + 1}\n`).join(""));
      put(dir, "g", "a\n");
      gitOk(root, dir, ["add", "."]);
      gitOk(root, dir, ["commit", "-qm", "one"]);
      put(
        dir,
        "f",
        Array.from({ length: 30 }, (_, i) => `${i === 4 ? "five" : i === 24 ? "X" : i + 1}\n`).join(
          "",
        ),
      );
      put(dir, "g", "b\n");
      put(dir, "n", "new\n");
      gitOk(root, dir, ["add", "-N", "n"]);
    };
    await compare(twins(build), [KEEP]);
    await compare(twins(build), [KEEP], ["g"]);
    const dropX = sed("/^[-+]25$/d;/^+X$/d", (t) =>
      t.replace(/^-25\n/m, "").replace(/^\+X\n/m, ""),
    );
    await compare(twins(build), [dropX], ["f"]);
    await compare(twins(build), [sed("d", () => "")]);
    await compare(twins(build), [sed("s/^ 3$/ Z/", (t) => t.replace(/^ 3$/m, " Z"))]);
  });
});
