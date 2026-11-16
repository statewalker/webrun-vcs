/**
 * DiffCommand's text output on a fixed scenario (a modification with a function line, a
 * deletion, a binary addition, a rename of a path with a space), each expected text taken
 * from native `git diff HEAD~1 HEAD` on the same contents.
 */
import { afterEach, describe, expect, it } from "vitest";

import { addFile, backends, createInitializedGitFromFactory, removeFile } from "./test-helper.js";

const lines = (n: number, tag: string) =>
  Array.from({ length: n }, (_, i) => `${tag} line ${i}\n`).join("");

describe.each(backends)("DiffCommand text output ($name backend)", ({ factory }) => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  async function scenario() {
    const result = await createInitializedGitFromFactory(factory);
    cleanup = result.cleanup;
    const { git, workingCopy, repository } = result;
    await addFile(
      workingCopy,
      "a.txt",
      "int main(void)\n{\n  one;\n  two;\n  three;\n  four;\n}\n",
    );
    await addFile(workingCopy, "gone.txt", "bye\n");
    await addFile(workingCopy, "src/old name.txt", lines(12, "r"));
    await git.commit().setMessage("one").call();
    const one = (await repository.refs.resolve("HEAD"))?.objectId ?? "";
    await addFile(
      workingCopy,
      "a.txt",
      "int main(void)\n{\n  one;\n  two;\n  THREE;\n  four;\n}\n",
    );
    await removeFile(workingCopy, "gone.txt");
    await removeFile(workingCopy, "src/old name.txt");
    await addFile(workingCopy, "src/new name.txt", `${lines(12, "r")}r line 12\n`);
    await addFile(workingCopy, "new.bin", "\u0001\u0000\u0002");
    await git.commit().setMessage("two").call();
    const two = (await repository.refs.resolve("HEAD"))?.objectId ?? "";
    return { git, one, two };
  }

  it("prints the patch as git diff does", async () => {
    const { git, one, two } = await scenario();
    expect(await git.diff().setOldTree(one).setNewTree(two).callText()).toBe(
      "diff --git a/a.txt b/a.txt\nindex 22a293c..68b7966 100644\n--- a/a.txt\n+++ b/a.txt\n" +
        "@@ -2,6 +2,6 @@ int main(void)\n {\n   one;\n   two;\n-  three;\n+  THREE;\n   four;\n }\n" +
        "diff --git a/gone.txt b/gone.txt\ndeleted file mode 100644\nindex b023018..0000000\n" +
        "--- a/gone.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n" +
        "diff --git a/new.bin b/new.bin\nnew file mode 100644\nindex 0000000..c3027df\n" +
        "Binary files /dev/null and b/new.bin differ\n" +
        "diff --git a/src/old name.txt b/src/new name.txt\nsimilarity index 91%\n" +
        "rename from src/old name.txt\nrename to src/new name.txt\nindex 51dade0..bad21ef 100644\n" +
        "--- a/src/old name.txt\t\n+++ b/src/new name.txt\t\n" +
        "@@ -10,3 +10,4 @@ r line 8\n r line 9\n r line 10\n r line 11\n+r line 12\n",
    );
  });

  it("prints --stat, --numstat, --shortstat and --name-status as git does", async () => {
    const { git, one, two } = await scenario();
    expect(await git.diff().setOldTree(one).setNewTree(two).callText("stat")).toBe(
      " a.txt                              |   2 +-\n gone.txt                           |   1 -\n" +
        " new.bin                            | Bin 0 -> 3 bytes\n" +
        " src/{old name.txt => new name.txt} |   1 +\n" +
        " 4 files changed, 2 insertions(+), 2 deletions(-)\n",
    );
    expect(await git.diff().setOldTree(one).setNewTree(two).callText("numstat")).toBe(
      "1\t1\ta.txt\n0\t1\tgone.txt\n-\t-\tnew.bin\n1\t0\tsrc/{old name.txt => new name.txt}\n",
    );
    expect(await git.diff().setOldTree(one).setNewTree(two).callText("shortstat")).toBe(
      " 4 files changed, 2 insertions(+), 2 deletions(-)\n",
    );
    expect(await git.diff().setOldTree(one).setNewTree(two).callText("name-status")).toBe(
      "M\ta.txt\nD\tgone.txt\nA\tnew.bin\nR091\tsrc/old name.txt\tsrc/new name.txt\n",
    );
  });

  it("keeps added and deleted paths apart in call() unless renames are asked for", async () => {
    const { git, one, two } = await scenario();
    const plain = await git.diff().setOldTree(one).setNewTree(two).call();
    expect(plain.map((e) => e.changeType)).toEqual(["MODIFY", "DELETE", "ADD", "ADD", "DELETE"]);
    const renamed = await git.diff().setOldTree(one).setNewTree(two).setRenames(true).call();
    expect(renamed.map((e) => `${e.changeType} ${e.newPath ?? e.oldPath}`)).toEqual([
      "MODIFY a.txt",
      "DELETE gone.txt",
      "ADD new.bin",
      "RENAME src/new name.txt",
    ]);
  });
});
