/**
 * Copy detection (`-C`, `-C -C`, `--find-copies-harder`, `-C<n>`), rename thresholds
 * (`-M<n>`) and break-rewrites (`-B[<n>][/<m>]`) against native git (statewalker-root#342).
 * Each test names the git t/ script (or JGit class) whose scenario it replays; native git and
 * our DiffCommand run on the same repository and their outputs are compared byte for byte.
 */
import { afterAll, describe, expect, it } from "vitest";
import { repo, Scratch, sh, twinFormats } from "./diff-native-support.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

const scratch = new Scratch("diff-copies-");
afterAll(() => scratch.cleanup());

/** t4008's setup: file0 and file1, very different, registered in a tree tagged `reference` */
const T4008_SETUP = `
  echo some dissimilar content >file0
  COPYING_test_data >file1
  git update-index --add file0 file1
  git tag reference $(git write-tree)
`;

describeGit("diff -B (break rewrites)", () => {
  it('t4008-diff-break-rewrite.sh: "run diff with -B (#1)", "run diff with -B and -M (#2)"', async () => {
    const dir = repo(
      scratch,
      `${T4008_SETUP}
      sed -e "s/git/GIT/" file0 >file1
      rm -f file0
      git update-index --remove file0 file1
    `,
    );
    const out: string[] = [];
    await twinFormats(
      scratch,
      out,
      dir,
      ["diff", "--cached", "-B", "--no-renames", "reference"],
      (d) =>
        d
          .setCached(true)
          .setOldTree("reference")
          .setRenames(false)
          .setOptions({ breakRewrites: true }),
    );
    await twinFormats(scratch, out, dir, ["diff", "-B", "-M", "reference"], (d) =>
      d.setOldTree("reference").setOptions({ breakRewrites: true, findRenames: true }),
    );
    expect(out).toEqual([]);
  });

  it('t4008-diff-break-rewrite.sh: "run diff with -B (#3)", "run diff with -B and -M (#4)"', async () => {
    const dir = repo(
      scratch,
      `${T4008_SETUP}
      mv file0 tmp && mv file1 file0 && mv tmp file1
      git update-index file0 file1
    `,
    );
    const out: string[] = [];
    await twinFormats(scratch, out, dir, ["diff", "-B", "--no-renames", "reference"], (d) =>
      d.setOldTree("reference").setRenames(false).setOptions({ breakRewrites: true }),
    );
    await twinFormats(scratch, out, dir, ["diff", "-B", "-M", "reference"], (d) =>
      d.setOldTree("reference").setOptions({ breakRewrites: true, findRenames: true }),
    );
    expect(out).toEqual([]);
  });

  it('t4008-diff-break-rewrite.sh: "run diff with -B (#5)", "run diff with -B -M (#6)", "run diff with -M (#7)"', async () => {
    const dir = repo(
      scratch,
      `${T4008_SETUP}
      mv file0 tmp && mv file1 file0 && mv tmp file1
      git update-index file0 file1
      rm -f file0
      ln -s frotz file0
      git update-index --add file0
      git update-index file1
    `,
    );
    const out: string[] = [];
    await twinFormats(scratch, out, dir, ["diff", "-B", "--no-renames", "reference"], (d) =>
      d.setOldTree("reference").setRenames(false).setOptions({ breakRewrites: true }),
    );
    await twinFormats(scratch, out, dir, ["diff", "-B", "-M", "reference"], (d) =>
      d.setOldTree("reference").setOptions({ breakRewrites: true, findRenames: true }),
    );
    await twinFormats(scratch, out, dir, ["diff", "-M", "reference"], (d) =>
      d.setOldTree("reference").setOptions({ findRenames: true }),
    );
    expect(out).toEqual([]);
  });

  it('t4008-diff-break-rewrite.sh: "run diff with -B (#8)", "run diff with -B -C (#9)"', async () => {
    const dir = repo(
      scratch,
      `${T4008_SETUP}
      sed -e "s/git/GIT/" file0 >file1
      sed -e "s/git/GET/" file0 >file2
      rm -f file0
      git update-index --add --remove file0 file1 file2
    `,
    );
    const out: string[] = [];
    await twinFormats(scratch, out, dir, ["diff", "-B", "--no-renames", "reference"], (d) =>
      d.setOldTree("reference").setRenames(false).setOptions({ breakRewrites: true }),
    );
    await twinFormats(scratch, out, dir, ["diff", "-B", "-C", "reference"], (d) =>
      d.setOldTree("reference").setOptions({ breakRewrites: true, findCopies: true }),
    );
    expect(out).toEqual([]);
  });

  it("t4008-diff-break-rewrite.sh: -B<n>/<m> thresholds, a broken pair merged back or left as a rewrite", async () => {
    const dir = repo(
      scratch,
      `
      for i in $(seq 1 60); do echo "line $i of the original text"; done >a
      for i in $(seq 1 60); do echo "line $i of another text"; done >b
      git add a b && commit -m one
      for i in $(seq 1 20); do echo "line $i of the original text"; done >a
      for i in $(seq 1 50); do echo "new line $i"; done >>a
      for i in $(seq 1 60); do echo "line $i of the original text"; done >b
    `,
    );
    const out: string[] = [];
    for (const spec of ["", "10%", "90%", "50%/10%", "/90%", "20%/70%", "5"]) {
      const flag = spec === "" ? "-B" : `-B${spec}`;
      for (const renames of [false, true]) {
        await twinFormats(
          scratch,
          out,
          dir,
          ["diff", flag, renames ? "-M" : "--no-renames"],
          (d) =>
            d.setRenames(false).setOptions({
              breakRewrites: spec === "" ? true : spec,
              ...(renames ? { findRenames: true } : {}),
            }),
          ["patch", "stat", "numstat", "name-status", "summary"],
        );
      }
    }
    for (const filter of ["B", "M", "b"]) {
      await twinFormats(
        scratch,
        out,
        dir,
        ["diff", "-B/10%", "--no-renames", `--diff-filter=${filter}`],
        (d) => d.setRenames(false).setOptions({ breakRewrites: "/10%", diffFilter: filter }),
        ["name-status"],
      );
    }
    expect(out).toEqual([]);
  });

  it("t4008-diff-break-rewrite.sh: -B with an invalid argument", async () => {
    const dir = repo(scratch, "echo a >a && git add a && commit -m one && echo b >a");
    const out: string[] = [];
    await twinFormats(
      scratch,
      out,
      dir,
      ["diff", "-B50%x"],
      (d) => d.setOptions({ breakRewrites: "50%x" }),
      ["name-status"],
    );
    expect(out).toEqual([]);
  });
});

describeGit("diff -C (copies)", () => {
  const prepare = `
    COPYING_test_data >COPYING
    echo frotz >rezrov
    git update-index --add COPYING rezrov
    git tag tree $(git write-tree)
    sed -e 's/HOWEVER/However/' <COPYING >COPYING.1
    sed -e 's/GPL/G.P.L/g' <COPYING >COPYING.2
    rm -f COPYING
    git update-index --add --remove COPYING COPYING.1 COPYING.2
  `;

  it('t4009-diff-rename-4.sh: "validate output from rename/copy detection (#1)"', async () => {
    const dir = repo(scratch, prepare);
    const out: string[] = [];
    await twinFormats(scratch, out, dir, ["diff", "-C", "tree"], (d) =>
      d.setOldTree("tree").setOptions({ findCopies: true }),
    );
    await twinFormats(scratch, out, dir, ["diff", "--cached", "-C", "tree"], (d) =>
      d.setCached(true).setOldTree("tree").setOptions({ findCopies: true }),
    );
    expect(out).toEqual([]);
  });

  it('t4009-diff-rename-4.sh: "validate output from rename/copy detection (#2)"', async () => {
    const dir = repo(
      scratch,
      `${prepare}
      mv COPYING.2 COPYING
      git update-index --add --remove COPYING COPYING.1 COPYING.2
    `,
    );
    const out: string[] = [];
    await twinFormats(scratch, out, dir, ["diff", "-C", "tree"], (d) =>
      d.setOldTree("tree").setOptions({ findCopies: true }),
    );
    expect(out).toEqual([]);
  });

  it('t4009-diff-rename-4.sh: "validate output from rename/copy detection (#3)"', async () => {
    const dir = repo(
      scratch,
      `${prepare}
      mv COPYING.2 COPYING
      git update-index --add --remove COPYING COPYING.1 COPYING.2
      COPYING_test_data >COPYING
      git update-index --add --remove COPYING COPYING.1
    `,
    );
    const out: string[] = [];
    // without harder, an unchanged COPYING is no source
    await twinFormats(scratch, out, dir, ["diff", "-C", "tree"], (d) =>
      d.setOldTree("tree").setOptions({ findCopies: true }),
    );
    await twinFormats(scratch, out, dir, ["diff", "-C", "--find-copies-harder", "tree"], (d) =>
      d.setOldTree("tree").setOptions({ findCopies: true, findCopiesHarder: true }),
    );
    await twinFormats(scratch, out, dir, ["diff", "-C", "-C", "--cached", "tree"], (d) =>
      d.setCached(true).setOldTree("tree").setOptions({ findCopies: true, findCopiesHarder: true }),
    );
    // the worktree against the index, and two trees
    sh(scratch, dir, "git commit -q -m two && cp COPYING COPYING.3 && git add -N COPYING.3");
    await twinFormats(scratch, out, dir, ["diff", "-C", "-C"], (d) =>
      d.setOptions({ findCopies: true, findCopiesHarder: true }),
    );
    sh(scratch, dir, "git add COPYING.3 && git commit -q -m three");
    await twinFormats(scratch, out, dir, ["diff", "-C", "-C", "HEAD^", "HEAD"], (d) =>
      d
        .setOldTree("HEAD^")
        .setNewTree("HEAD")
        .setOptions({ findCopies: true, findCopiesHarder: true }),
    );
    await twinFormats(scratch, out, dir, ["diff", "-C", "HEAD^", "HEAD"], (d) =>
      d.setOldTree("HEAD^").setNewTree("HEAD").setOptions({ findCopies: true }),
    );
    expect(out).toEqual([]);
  });

  it("t4009-diff-rename-4.sh: -C<n> and -M<n> thresholds", async () => {
    const dir = repo(scratch, prepare);
    const out: string[] = [];
    for (const score of ["", "99%", "90", ".99", "100%", "1%", "50%"]) {
      await twinFormats(
        scratch,
        out,
        dir,
        ["diff", `-C${score}`, "tree"],
        (d) => d.setOldTree("tree").setOptions({ findCopies: score === "" ? true : score }),
        ["name-status", "summary"],
      );
      await twinFormats(
        scratch,
        out,
        dir,
        ["diff", `-M${score}`, "tree"],
        (d) => d.setOldTree("tree").setOptions({ findRenames: score === "" ? true : score }),
        ["name-status", "summary"],
      );
    }
    await twinFormats(
      scratch,
      out,
      dir,
      ["diff", "-M50x", "tree"],
      (d) => d.setOldTree("tree").setOptions({ findRenames: "50x" }),
      ["name-status"],
    );
    await twinFormats(
      scratch,
      out,
      dir,
      ["diff", "-C50x", "tree"],
      (d) => d.setOldTree("tree").setOptions({ findCopies: "50x" }),
      ["name-status"],
    );
    expect(out).toEqual([]);
  });

  it("t4009-diff-rename-4.sh: -C with diff.renames=copies finds copies harder, the rename limit", async () => {
    const dir = repo(
      scratch,
      `${prepare}
      mv COPYING.2 COPYING
      git update-index --add --remove COPYING COPYING.1 COPYING.2
      COPYING_test_data >COPYING
      git update-index --add --remove COPYING COPYING.1
      git config diff.renames copies
    `,
    );
    const out: string[] = [];
    await twinFormats(scratch, out, dir, ["diff", "-C", "tree"], (d) =>
      d.setOldTree("tree").setOptions({ findCopies: true }),
    );
    await twinFormats(scratch, out, dir, ["diff", "tree"], (d) => d.setOldTree("tree"));
    // -C -C over the limit: copies found only from modified paths
    sh(
      scratch,
      dir,
      `git config diff.renames true
       sed -e 's/Linus/L/' <COPYING >COPYING.1
       git add COPYING.1 && echo x >>rezrov && git add rezrov`,
    );
    await twinFormats(
      scratch,
      out,
      dir,
      ["diff", "-C", "-C", "-l1", "--cached", "tree"],
      (d) =>
        d
          .setCached(true)
          .setOldTree("tree")
          .setRenameLimit(1)
          .setOptions({ findCopies: true, findCopiesHarder: true }),
      ["name-status"],
    );
    expect(out).toEqual([]);
  });
});

describeGit("RenameDetectorTest copy inputs", () => {
  it("RenameDetectorTest: testExactRename_OneDeleteManyAdds", async () => {
    const dir = repo(
      scratch,
      `
      echo foo >d.txt && git add d.txt && commit -m one
      mkdir -p src/com/foo
      echo foo >src/com/foo/a.java && echo foo >src/com/foo/b.java && echo foo >c.txt
      git rm -q d.txt && git add .
    `,
    );
    const out: string[] = [];
    for (const [flags, options] of [
      [["-M"], { findRenames: true }],
      [["-C"], { findCopies: true }],
      [["-C", "-C"], { findCopies: true, findCopiesHarder: true }],
    ] as const) {
      await twinFormats(scratch, out, dir, ["diff", "--cached", ...flags], (d) =>
        d.setCached(true).setOptions(options),
      );
    }
    expect(out).toEqual([]);
  });

  it("RenameDetectorTest: testExactRename_PathBreaksTie", async () => {
    const dir = repo(
      scratch,
      `
      mkdir -p src/com/foo
      echo foo >src/com/foo/b.java && echo foo >d.txt && echo bar >keep.txt
      git add . && commit -m one
      git rm -q src/com/foo/b.java d.txt
      echo foo >src/com/foo/a.java && echo foo >c.txt && echo foo >the_e_file.txt
      git add .
    `,
    );
    const out: string[] = [];
    for (const [flags, options] of [
      [["-M"], { findRenames: true }],
      [["-C"], { findCopies: true }],
      [["-C", "-C"], { findCopies: true, findCopiesHarder: true }],
    ] as const) {
      await twinFormats(scratch, out, dir, ["diff", "--cached", ...flags], (d) =>
        d.setCached(true).setOptions(options),
      );
    }
    expect(out).toEqual([]);
  });

  it("RenameDetectorTest: testBreakModify_BreakAll, testBreakModify_RejoinIfUnpaired, testBreakModify_DontBreakAboveScore", async () => {
    const big = (word: string) => `for i in $(seq 1 40); do echo "${word} $i ${word}"; done`;
    const dir = repo(
      scratch,
      `
      ${big("foo")} >a && ${big("keep")} >c && git add . && commit -m one
      ${big("bar")} >a && ${big("foo")} >b && ${big("keep")} >c && echo more >>c
      git add .
    `,
    );
    const out: string[] = [];
    for (const [flags, options] of [
      [["-B", "-M"], { breakRewrites: true, findRenames: true }],
      [["-B", "--no-renames"], { breakRewrites: true }],
      [["-B20%", "-M"], { breakRewrites: "20%", findRenames: true }],
      [["-B", "-C"], { breakRewrites: true, findCopies: true }],
      [["-B", "-C", "-C"], { breakRewrites: true, findCopies: true, findCopiesHarder: true }],
    ] as const) {
      await twinFormats(scratch, out, dir, ["diff", "--cached", ...flags], (d) =>
        d.setCached(true).setRenames(false).setOptions(options),
      );
    }
    expect(out).toEqual([]);
  });
});
