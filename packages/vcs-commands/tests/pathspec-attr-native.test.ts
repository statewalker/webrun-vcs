/**
 * `:(attr:...)` pathspec magic against native git (pathspec.c `parse_pathspec_attr_match`,
 * dir.c `match_pathspec_attrs`): `attr:name`, `-name`, `!name`, `name=value` and several
 * attributes per element, from `.gitattributes`, `info/attributes`, `core.attributesFile`
 * and the index of a skip-worktree `.gitattributes`, in status (tracked and untracked), add,
 * rm, commit `--only` / `-i`, diff and stash push; each case runs native git in one copy of a
 * repository and ours in another, and compares output, exit status and the resulting index.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { nativeGitAvailable } from "./native-git-http-backend.js";
import { gitOut, gitRun, openRepo, putFile } from "./status-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

/** git 2.43's `git add` refuses attr magic (its parse_pathspec masks PATHSPEC_ATTR); 2.5x allows it. */
const is25x = (() => {
  if (!nativeGitAvailable()) return false;
  const m = /git version (\d+)\.(\d+)/.exec(execFileSync("git", ["--version"]).toString());
  return !!m && (Number(m[1]) > 2 || Number(m[2]) >= 50);
})();

let root: string;
const git = (cwd: string, args: string[], extra?: Record<string, string>) =>
  gitOut(root, cwd, args, extra);

/**
 * A repository whose files carry attributes from the root `.gitattributes`, a nested one,
 * `info/attributes` and `core.attributesFile`, with tracked changes and untracked files.
 */
function base(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  putFile(dir, ".gitattributes", "*.c foo\n*.h -foo\n*.txt foo=bar\nsub/** baz\nd foo\n");
  putFile(dir, "sub/.gitattributes", "*.md foo=md\n");
  putFile(dir, "a.c", "a\n");
  putFile(dir, "b.h", "b\n");
  putFile(dir, "t.txt", "t\n");
  putFile(dir, "plain", "p\n");
  putFile(dir, "sub/x.c", "x\n");
  putFile(dir, "sub/r.md", "r\n");
  putFile(dir, "sub/q.info", "q\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "base"]);
  writeFileSync(join(dir, ".git/info/attributes"), "*.info info\n");
  writeFileSync(join(root, "global-attributes"), "plain foo=global\n");
  git(dir, ["config", "core.attributesFile", join(root, "global-attributes")]);
  for (const f of ["a.c", "b.h", "t.txt", "plain", "sub/x.c", "sub/r.md", "sub/q.info"]) {
    putFile(dir, f, `${readFileSync(join(dir, f), "latin1")}more\n`);
  }
  putFile(dir, "new.c", "n\n");
  putFile(dir, "new.h", "n\n");
  putFile(dir, "d/u.c", "u\n");
  putFile(dir, "sub/n.md", "n\n");
}

const SPECS = [
  [":(attr:foo)"],
  [":(attr:-foo)"],
  [":(attr:!foo)"],
  [":(attr:foo=bar)"],
  [":(attr:foo=md)"],
  [":(attr:foo=global)"],
  [":(attr:info)"],
  [":(attr:baz foo)"],
  [":(attr:baz !foo)"],
  [":(attr:foo)sub/"],
  [":(exclude,attr:foo)", "."],
  [":(attr:foo)", ":(attr:info)"],
  [":(attr:foo)*.c"],
];

/** Two copies of `dir`: native git works in one, ours in the other. */
function twins(dir: string): [string, string] {
  const out: [string, string] = [`${dir}-native`, `${dir}-ours`];
  for (const copy of out) {
    rmSync(copy, { recursive: true, force: true });
    execFileSync("cp", ["-a", dir, copy]);
    gitRun(root, copy, ["update-index", "-q", "--refresh"]);
  }
  return out;
}

const indexOf = (dir: string) => git(dir, ["ls-files", "-s", "--debug"]).replace(/ctime.*\n/g, "");
const stagedOf = (dir: string) => git(dir, ["ls-files", "-s"]);

describeGit(":(attr:...) pathspecs: as native git", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pathspec-attr-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("status: tracked changes and the untracked scan, normal and -uall", async () => {
    const dir = join(root, "r");
    base(dir);
    const repo = await openRepo(root, dir);
    const seen = new Set<string>();
    for (const spec of SPECS) {
      for (const mode of ["normal", "all"] as const) {
        const native = git(dir, ["status", "--porcelain", `-u${mode}`, "--", ...spec]);
        seen.add(native);
        const command = repo.status().setUntrackedFiles(mode);
        for (const p of spec) command.addPath(p);
        const { text } = await command.callText({ format: "porcelain" });
        expect(text, `${spec.join(" ")} -u${mode}`).toBe(native);
      }
    }
    // the elements select different paths
    expect(seen.size).toBeGreaterThan(8);
  }, 120_000);

  it("status: a skip-worktree .gitattributes is read from the index", async () => {
    const dir = join(root, "r");
    base(dir);
    git(dir, ["update-index", "--skip-worktree", "sub/.gitattributes"]);
    rmSync(join(dir, "sub/.gitattributes"));
    const repo = await openRepo(root, dir);
    for (const spec of [[":(attr:foo=md)"], [":(attr:!foo)sub/"]]) {
      const native = git(dir, ["status", "--porcelain", "-uall", "--", ...spec]);
      const command = repo.status().setUntrackedFiles("all");
      for (const p of spec) command.addPath(p);
      const { text } = await command.callText({ format: "porcelain" });
      expect(text, spec.join(" ")).toBe(native);
    }
  }, 60_000);

  /** Runs `native` in one copy and `ours` in the other, then compares `compare` of both. */
  async function expectTwins(
    dir: string,
    label: string,
    native: string[],
    ours: (repo: Awaited<ReturnType<typeof openRepo>>) => Promise<unknown>,
    compare: (d: string) => string = (d) =>
      `${stagedOf(d)}${git(d, ["status", "--porcelain", "-uall"])}`,
  ) {
    const [theirs, mine] = twins(dir);
    const result = gitRun(root, theirs, native);
    let error: Error | undefined;
    try {
      await ours(await openRepo(root, mine));
    } catch (e) {
      error = e as Error;
    }
    expect(error === undefined, `${label}: ${String(error)} / ${result.stderr}`).toBe(
      result.status === 0,
    );
    if (error) expect(`${error.message}\n`, `${label}: message`).toBe(result.stderr);
    expect(compare(mine), label).toBe(compare(theirs));
  }

  it("add, rm, commit --only / -i, clean and stash push", async () => {
    const dir = join(root, "r");
    base(dir);
    for (const spec of [
      [":(attr:foo)"],
      [":(attr:-foo)"],
      [":(attr:foo=md)"],
      [":(attr:!foo)sub"],
    ]) {
      const label = spec.join(" ");
      if (is25x) {
        await expectTwins(dir, `add ${label}`, ["add", "--", ...spec], (r) => {
          const c = r.add();
          for (const p of spec) c.addFilepattern(p);
          return c.call();
        });
        await expectTwins(dir, `add -u ${label}`, ["add", "-u", "--", ...spec], (r) => {
          const c = r.add().setUpdate(true);
          for (const p of spec) c.addFilepattern(p);
          return c.call();
        });
      } else {
        // 2.43: "fatal: <elem>: pathspec magic not supported by this command: 'attr'"
        expect(gitRun(root, dir, ["add", "-n", "--", ...spec]).status).toBe(128);
      }
      await expectTwins(
        dir,
        `rm --cached ${label}`,
        ["rm", "-q", "--cached", "-r", "--", ...spec],
        (r) => {
          const c = r.rm().setCached(true).setRecursive(true);
          for (const p of spec) c.addFilepattern(p);
          return c.call();
        },
      );
      const head = (d: string) =>
        `${git(d, ["show", "--name-status", "--format=%T", "HEAD"])}${stagedOf(d)}`;
      await expectTwins(
        dir,
        `commit --only ${label}`,
        ["commit", "-q", "-m", "only", "--", ...spec],
        (r) =>
          r
            .commit()
            .setOnly(...spec)
            .setMessage("only")
            .call(),
        head,
      );
      await expectTwins(
        dir,
        `commit -i ${label}`,
        ["commit", "-q", "-m", "include", "-i", "--", ...spec],
        (r) =>
          r
            .commit()
            .setInclude(...spec)
            .setMessage("include")
            .call(),
        head,
      );
      await expectTwins(dir, `clean ${label}`, ["clean", "-q", "-f", "-d", "--", ...spec], (r) =>
        r.clean().setPaths(new Set(spec)).setCleanDirectories(true).setDryRun(false).call(),
      );
      // git 2.43's stash push runs `git add` and `git checkout` with the elements (prefix
      // magic added), and 2.43's add refuses attr magic
      if (!is25x) continue;
      const stashed = (d: string) =>
        `${git(d, ["status", "--porcelain", "-uall"])}${gitRun(root, d, ["ls-tree", "-r", "--name-only", "stash@{0}"]).stdout}${gitRun(root, d, ["ls-tree", "-r", "--name-only", "stash@{0}^3"]).stdout}`;
      await expectTwins(
        dir,
        `stash push ${label}`,
        ["stash", "push", "-q", "--", ...spec],
        (r) => {
          const c = r.stashCreate().setRef("refs/stash");
          for (const p of spec) c.addPath(p);
          return c.call();
        },
        stashed,
      );
      await expectTwins(
        dir,
        `stash push -u ${label}`,
        ["stash", "push", "-q", "-u", "--", ...spec],
        (r) => {
          const c = r.stashCreate().setRef("refs/stash").setIncludeUntracked(true);
          for (const p of spec) c.addPath(p);
          return c.call();
        },
        stashed,
      );
    }
  }, 300_000);

  it("diff: worktree, --cached and two trees", async () => {
    const dir = join(root, "r");
    base(dir);
    git(dir, ["add", "-u"]);
    git(dir, ["commit", "-qm", "second"]);
    for (const f of ["a.c", "b.h", "t.txt", "sub/r.md"]) putFile(dir, f, "changed\n");
    git(dir, ["add", "b.h"]);
    const repo = await openRepo(root, dir);
    for (const spec of SPECS) {
      const label = spec.join(" ");
      expect(await repo.diff().setPathspec(spec).callText("numstat"), label).toBe(
        git(dir, ["diff", "--numstat", "--", ...spec]),
      );
      expect(
        await repo.diff().setCached(true).setPathspec(spec).callText("numstat"),
        `--cached ${label}`,
      ).toBe(git(dir, ["diff", "--cached", "--numstat", "--", ...spec]));
      expect(
        await repo
          .diff()
          .setOldTree("HEAD~1")
          .setNewTree("HEAD")
          .setPathspec(spec)
          .callText("numstat"),
        `HEAD~1 HEAD ${label}`,
      ).toBe(git(dir, ["diff", "--numstat", "HEAD~1", "HEAD", "--", ...spec]));
    }
  }, 120_000);
});

export { indexOf, twins };
