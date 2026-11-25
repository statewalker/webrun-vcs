/**
 * `git ls-files` (builtin/ls-files.c), native twins: the scenarios of git's t3000-t3060
 * ls-files scripts, t0027's `--eol` columns and JGit's pgm LsFilesTest, each run by native
 * git and by ours on the same repository, with git as the oracle (stdout bytes, stderr and
 * the exit status compared).
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Git, LsFilesCommand } from "../src/index.js";
import { compatibilityOf, type Outcome, Shell } from "./describe-native-support.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root: string;
let shell: Shell;
let counter = 0;

/** `git ls-files <argv>` mapped onto our LsFilesCommand (`prefix`: the cwd below the top). */
export function lsFilesArgs(git: Git, argv: string[], prefix = ""): LsFilesCommand {
  const command = git.lsFiles();
  if (prefix) command.setPrefix(prefix);
  const paths: string[] = [];
  let dashdash = false;
  const value = (arg: string, i: number): [string, number] => {
    const eq = arg.indexOf("=");
    if (arg.startsWith("--") && eq > 0) return [arg.slice(eq + 1), i];
    if (!arg.startsWith("--") && arg.length > 2) return [arg.slice(2), i];
    return [argv[i + 1] as string, i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (dashdash || !arg.startsWith("-") || arg === "-") {
      paths.push(arg);
      continue;
    }
    const name = arg.startsWith("--") && arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    switch (name) {
      case "--":
        dashdash = true;
        break;
      case "-c":
      case "--cached":
        command.setCached(true);
        break;
      case "-d":
      case "--deleted":
        command.setDeleted(true);
        break;
      case "-m":
      case "--modified":
        command.setModified(true);
        break;
      case "-o":
      case "--others":
        command.setOthers(true);
        break;
      case "-i":
      case "--ignored":
        command.setIgnored(true);
        break;
      case "-s":
      case "--stage":
        command.setStage(true);
        break;
      case "-k":
      case "--killed":
        command.setKilled(true);
        break;
      case "-u":
      case "--unmerged":
        command.setUnmerged(true);
        break;
      case "-t":
        command.setShowTags(true);
        break;
      case "-v":
        command.setShowValidBit(true);
        break;
      case "-z":
        command.setNulTerminated(true);
        break;
      case "--directory":
        command.setDirectory(true);
        break;
      case "--no-empty-directory":
        command.setEmptyDirectory(false);
        break;
      case "--eol":
        command.setEol(true);
        break;
      case "--deduplicate":
        command.setDeduplicate(true);
        break;
      case "--full-name":
        command.setFullName(true);
        break;
      case "--error-unmatch":
        command.setErrorUnmatch(true);
        break;
      case "--resolve-undo":
        command.setResolveUndo(true);
        break;
      case "--exclude-standard":
        command.setExcludeStandard();
        break;
      case "--abbrev":
        command.setAbbrev(arg.includes("=") ? Number(arg.slice(arg.indexOf("=") + 1)) : true);
        break;
      case "-x":
      case "--exclude": {
        const [v, next] = value(arg, i);
        i = next;
        command.addExclude(v);
        break;
      }
      case "-X":
      case "--exclude-from": {
        const [v, next] = value(arg, i);
        i = next;
        command.addExcludeFrom(v);
        break;
      }
      case "--exclude-per-directory": {
        const [v, next] = value(arg, i);
        i = next;
        command.setExcludePerDirectory(v);
        break;
      }
      case "--with-tree": {
        const [v, next] = value(arg, i);
        i = next;
        command.setWithTree(v);
        break;
      }
      case "--format": {
        const [v, next] = value(arg, i);
        i = next;
        command.setFormat(v);
        break;
      }
      default:
        if (/^-x./.test(arg)) command.addExclude(arg.slice(2));
        else throw new Error(`unmapped option ${arg}`);
    }
  }
  return command.addPathspec(...paths);
}

/** `git ls-files <argv>` in `dir/prefix`, native and ours. */
async function twin(
  dir: string,
  argv: string[],
  prefix = "",
): Promise<{ native: Outcome; ours: Outcome }> {
  const native = shell.git(prefix ? join(dir, prefix) : dir, ["ls-files", ...argv]);
  const git = await openOurs(dir);
  const out = await lsFilesArgs(git, argv, prefix)
    .setCompatibility(compatibilityOf(shell))
    .callOutput();
  const ours = {
    status: out.exitCode,
    stdout: Buffer.from(out.stdout).toString("utf8"),
    stderr: out.stderr,
  };
  return { native, ours };
}

/** Both sides print the same; native git's outcome. */
async function check(dir: string, argv: string[], prefix = ""): Promise<Outcome> {
  const { native, ours } = await twin(dir, argv, prefix);
  expect(ours).toEqual(native);
  return native;
}

/** Both sides end with the same status (usage errors: their text is git's option list). */
async function checkStatus(dir: string, argv: string[]): Promise<number> {
  const { native, ours } = await twin(dir, argv);
  expect(ours.status).toBe(native.status);
  return native.status;
}

function repository(name: string): string {
  const dir = join(root, `${name}-${counter++}`);
  shell.ok(root, "init", "-q", "-b", "main", dir);
  return dir;
}

function put(dir: string, path: string, content = ""): void {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), content);
}

describeGit("git ls-files, native twins", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "ls-files-native-"));
    shell = new Shell(root);
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe("t3000-ls-files-others.sh", () => {
    let dir: string;
    beforeAll(() => {
      dir = repository("t3000");
      put(dir, "path0", "x\n");
      symlinkSync("xyzzy", join(dir, "path1"));
      for (const d of ["path2", "path3", "path4"]) mkdirSync(join(dir, d));
      put(dir, "path2/file2", "x\n");
      put(dir, "path2-junk", "x\n");
      put(dir, "path3/file3", "x\n");
      put(dir, "path3-junk", "x\n");
      shell.ok(dir, "update-index", "--add", "path3-junk", "path3/file3");
    });

    it('t3000-ls-files-others.sh: "ls-files --others"', async () => {
      await check(dir, ["--others"]);
      await check(dir, ["--others", "-t", "--eol"]);
      await check(dir, ["--others", "-v", "-c"]);
    });

    it('t3000-ls-files-others.sh: "ls-files --others --directory"', async () => {
      await check(dir, ["--others", "--directory"]);
    });

    it('t3000-ls-files-others.sh: "--no-empty-directory hides empty directory"', async () => {
      await check(dir, ["--others", "--directory", "--no-empty-directory"]);
    });

    it('t3000-ls-files-others.sh: "ls-files --others handles non-submodule .git"', async () => {
      put(dir, "not-a-submodule/.git", "foo\n");
      await check(dir, ["-o"]);
      await check(dir, ["-o", "--directory"]);
      rmSync(join(dir, "not-a-submodule"), { recursive: true });
    });

    describe("nested pathspec search", () => {
      let nested: string;
      beforeAll(() => {
        nested = repository("t3000-nested");
        put(nested, "partially_tracked/content");
        put(nested, "partially_tracked/untracked_dir/file");
        put(nested, "untracked/deep/path");
        put(nested, "untracked/deep/foo.c");
        shell.ok(nested, "add", "partially_tracked/content");
      });

      it('t3000-ls-files-others.sh: "ls-files -o --directory with single deep dir pathspec"', async () => {
        await check(nested, ["-o", "--directory", "untracked/deep/"]);
      });

      it('t3000-ls-files-others.sh: "ls-files -o --directory with multiple dir pathspecs"', async () => {
        await check(nested, ["-o", "--directory", "partially_tracked/", "untracked/"]);
      });

      it('t3000-ls-files-others.sh: "ls-files -o --directory with mix dir/file pathspecs"', async () => {
        await check(nested, ["-o", "--directory", "partially_tracked/", "untracked/deep/path"]);
      });

      it('t3000-ls-files-others.sh: "ls-files -o --directory with glob filetype match"', async () => {
        await check(nested, ["--others", "--directory", "partially_tracked", "untracked/*.c"]);
      });

      it('t3000-ls-files-others.sh: "ls-files -o --directory with mix of tracked states"', async () => {
        await check(nested, ["--others", "--directory", "partially_tracked/", "untracked/?*"]);
      });

      it('t3000-ls-files-others.sh: "ls-files -o --directory with glob filetype match only"', async () => {
        await check(nested, ["--others", "--directory", "untracked/*.c"]);
      });

      it('t3000-ls-files-others.sh: "ls-files -o --directory to get immediate paths under one dir only"', async () => {
        await check(nested, ["--others", "--directory", "untracked/?*"]);
      });

      it('t3000-ls-files-others.sh: "ls-files -o avoids listing untracked non-matching gitdir"', async () => {
        shell.ok(nested, "init", "-q", "untracked/deep/empty");
        await check(nested, ["--others", "untracked/*.c"]);
        await check(nested, ["--others"]);
        await check(nested, ["--others", "--directory"]);
        rmSync(join(nested, "untracked/deep/empty"), { recursive: true });
      });
    });
  });

  describe("t3001-ls-files-others-exclude.sh", () => {
    let dir: string;
    const ignores = ".gitignore one/.gitignore one/two/.gitignore".split(" ");
    const options = [
      "--others",
      "--exclude=*.6",
      "--exclude-per-directory=.gitignore",
      "--exclude-from=.git/ignore",
    ];
    beforeAll(() => {
      dir = repository("t3001");
      for (const d of [".", "one", "one/two", "three"]) {
        for (let i = 1; i <= 8; i++) put(dir, `${d}/a.${i}`);
      }
      for (const f of ["#ignore1", "#ignore2", "#hidden"]) put(dir, f);
      put(
        dir,
        ".git/ignore",
        ".gitignore\n\\#ignore1\n\\#ignore2*\n\\#hid*n\noutput\nexpect\n.gitignore\n*.7\n!*.8\n",
      );
      put(dir, ".gitignore", "*.1\n/*.3\n!*.6\n");
      put(dir, "one/.gitignore", "*.2\ntwo/*.4\n!*.7\n*.8\n");
      put(dir, "one/two/.gitignore", "!*.2\n!*.8\n");
    });

    it('t3001-ls-files-others-exclude.sh: "git ls-files --others with various exclude options."', async () => {
      await check(dir, options);
      await check(dir, [...options, "-i"]);
    });

    it('t3001-ls-files-others-exclude.sh: "git ls-files --others with \\r\\n line endings."', async () => {
      put(dir, ".gitignore", "*.1\r\n/*.3\r\n!*.6\r\n");
      await check(dir, options);
    });

    it('t3001-ls-files-others-exclude.sh: "setup skip-worktree gitignore"', async () => {
      shell.ok(dir, "add", ...ignores);
      shell.ok(dir, "update-index", "--skip-worktree", ...ignores);
      for (const f of ignores) unlinkSync(join(dir, f));
      await check(dir, options);
      shell.ok(dir, "checkout", "--ignore-skip-worktree-bits", ...ignores);
      rmSync(join(dir, ".git/index"));
    });

    it('t3001-ls-files-others-exclude.sh: "trailing slash in exclude allows directory match(1)"', async () => {
      await check(dir, ["--others", "--exclude=one/"]);
      await check(dir, ["--others", "--exclude=one/two/"]);
      put(dir, "two");
      await check(dir, ["--others", "--exclude=two/"]);
      await check(dir, ["--others", "--exclude=one/a.1/"]);
    });

    it('t3001-ls-files-others-exclude.sh: "negated exclude matches can override previous ones"', async () => {
      await check(dir, ["--others", "--exclude=a.*", "--exclude=!a.1"]);
    });

    it('t3001-ls-files-others-exclude.sh: "excluded directory overrides content patterns"', async () => {
      await check(dir, ["--others", "--exclude=one", "--exclude=!one/a.1"]);
      await check(dir, ["--others", "--exclude=!one", "--exclude=one/a.1"]);
    });

    it('t3001-ls-files-others-exclude.sh: "subdirectory ignore (toplevel)"', async () => {
      const top = join(dir, "top");
      mkdirSync(join(top, "l1/l2"), { recursive: true });
      shell.ok(top, "init", "-q");
      put(top, ".gitignore", "/.gitignore\nl1\n");
      put(top, "l1/.gitignore", "l2\n");
      put(top, "l1/l2/l1");
      await check(top, ["-o", "--exclude-standard"]);
      await check(top, ["-o", "--exclude-standard"], "l1/l2");
      await check(top, ["-o", "--exclude-standard"], "l1");
      // show/hide empty ignored directory
      rmSync(join(top, "l1/l2/l1"));
      rmSync(join(top, "l1/.gitignore"));
      await check(top, ["-o", "-i", "--exclude", "l1", "--directory"]);
      await check(top, ["-o", "-i", "--exclude", "l1", "--directory", "--no-empty-directory"]);
      put(top, "l1/tracked");
      shell.ok(top, "add", "-f", "l1/tracked");
      await check(top, ["-o", "-i", "--exclude", "l1", "--directory"]);
      await check(top, ["-o", "-i", "--exclude", "l1", "--directory", "--no-empty-directory"]);
      rmSync(top, { recursive: true });
    });

    it('t3001-ls-files-others-exclude.sh: "ls-files with "**" patterns"', async () => {
      await check(dir, ["-i", "-o", "--exclude", "/three/a.3[abc]"]);
      await check(dir, ["-o", "-i", "--exclude", "**/a.1"]);
      await check(dir, ["--directory", "-o", "-i", "--exclude", "**/a.1"]);
      await check(dir, ["-o", "-i", "--exclude", "one**a.1"]);
    });
  });

  describe("t3002-ls-files-dashpath.sh", () => {
    it('t3002-ls-files-dashpath.sh: "git ls-files with path restriction with -- --."', async () => {
      const dir = repository("t3002");
      for (const f of ["path0", "-foo", "--"]) put(dir, f, "frotz\n");
      await check(dir, ["--others"]);
      await check(dir, ["--others", "path0"]);
      await check(dir, ["--others", "--", "path0"]);
      await check(dir, ["--others", "--", "--"]);
      await check(dir, ["--others", "--"]);
    });
  });

  describe("t3003-ls-files-exclude.sh", () => {
    it('t3003-ls-files-exclude.sh: "ls-files -i -c lists only tracked-but-ignored files"', async () => {
      const dir = repository("t3003");
      put(dir, "file", "content\n");
      shell.ok(dir, "add", "file");
      shell.ok(dir, "commit", "-q", "-m", "file");
      put(dir, "file", "modification\n");
      await check(dir, ["--exclude-standard", "--cached"]);
      await check(dir, ["--exclude-standard", "--modified"]);
      put(dir, ".gitignore", "file\n");
      await check(dir, ["--exclude-standard", "--cached"]);
      await check(dir, ["--exclude-standard", "--modified"]);
      put(dir, "other-file", "content\n");
      shell.ok(dir, "add", "other-file");
      await check(dir, ["-i", "-c", "--exclude-standard"]);
      // the refusals of -i
      await check(dir, ["-i", "--exclude-standard"]);
      await check(dir, ["-i", "-c"]);
      await check(dir, ["-i", "-o", "--exclude-standard"]);
    });
  });

  describe("t3004-ls-files-basic.sh", () => {
    it('t3004-ls-files-basic.sh: "ls-files in empty repository"', async () => {
      const dir = repository("t3004");
      await check(dir, []);
      await check(dir, ["doesnotexist"]);
    });

    it('t3004-ls-files-basic.sh: "ls-files with nonexistent path"', async () => {
      const dir = repository("t3004b");
      put(dir, "a");
      shell.ok(dir, "add", "a");
      await check(dir, ["doesnotexist"]);
      await check(dir, ["--error-unmatch", "doesnotexist"]);
    });
  });

  describe("t3005-ls-files-relative.sh", () => {
    let dir: string;
    beforeAll(() => {
      dir = repository("t3005");
      put(dir, "never-mind-me");
      shell.ok(dir, "add", "never-mind-me");
      const names = ["x", "xa", "xbc", "xdef", "xghij", "xklmno"];
      for (const n of names) {
        put(dir, `top/${n}`);
        put(dir, `top/${n.replace(/x/g, "y")}`);
      }
      mkdirSync(join(dir, "top/sub"));
      shell.ok(join(dir, "top/sub"), "add", ...names.map((n) => `../${n}`));
    });

    it('t3005-ls-files-relative.sh: "ls-files with mixed levels"', async () => {
      await check(dir, ["../../never-mind-me", "../x"], "top/sub");
    });

    it('t3005-ls-files-relative.sh: "ls-files -c"', async () => {
      const all = ["x", "xa", "xbc", "xdef", "xghij", "xklmno"];
      const args = [...all.map((n) => `../${n}`), ...all.map((n) => `../${n.replace(/x/g, "y")}`)];
      await check(dir, ["-c", "--error-unmatch", ...args], "top/sub");
      await check(dir, ["-c", "--full-name"], "top");
      await check(dir, ["-c"], "top");
    });

    it('t3005-ls-files-relative.sh: "ls-files -o"', async () => {
      const all = ["x", "xa", "xbc", "xdef", "xghij", "xklmno"];
      const args = [...all.map((n) => `../${n}`), ...all.map((n) => `../${n.replace(/x/g, "y")}`)];
      await check(dir, ["-o", "--error-unmatch", ...args], "top/sub");
      await check(dir, ["-o"], "top");
      await check(dir, ["-o", ":/"], "top/sub");
    });
  });

  describe("t3010-ls-files-killed-modified.sh", () => {
    let dir: string;
    beforeAll(() => {
      dir = repository("t3010");
      put(dir, "path0", "date\n");
      symlinkSync("xyzzy", join(dir, "path1"));
      put(dir, "path2/file2", "date\n");
      put(dir, "path3/file3", "date\n");
      put(dir, "pathx/ju");
      put(dir, "path7");
      put(dir, "path8", "date\n");
      put(dir, "path9");
      put(dir, "path10", "date\n");
      shell.ok(
        dir,
        "update-index",
        "--add",
        "--",
        "path0",
        "path1",
        "path2/file2",
        "path3/file3",
        "pathx/ju",
        "path7",
        "path8",
        "path9",
        "path10",
      );
      for (const sub of ["submod1", "submod2"]) {
        shell.ok(dir, "init", "-q", sub);
        shell.ok(join(dir, sub), "commit", "-q", "--allow-empty", "-m", `empty ${sub}`);
      }
      shell.ok(dir, "update-index", "--add", "submod1", "submod2");
      shell.ok(join(dir, "submod1"), "commit", "-q", "--allow-empty", "-m", "updated");
      for (const p of ["path0", "path1", "path2", "path3", "path7", "path8", "path9"]) {
        rmSync(join(dir, p), { recursive: true, force: true });
      }
      put(dir, "path2", "date\n");
      symlinkSync("frotz", join(dir, "path3"));
      symlinkSync("nitfol", join(dir, "path5"));
      put(dir, "path0/file0", "date\n");
      put(dir, "path1/file1", "date\n");
      put(dir, "path6/file6", "date\n");
      put(dir, "path7", "date\n");
      put(dir, "path8");
      put(dir, "path9");
      rmSync(join(dir, "pathx/ju"));
      put(dir, "pathx/ju/nk");
    });

    it('t3010-ls-files-killed-modified.sh: "git ls-files -k output (w/o icase)"', async () => {
      await check(dir, ["-k"]);
      await check(dir, ["-k", "-t"]);
      await check(dir, ["-k", "-o", "--directory"]);
      await check(dir, ["-k", "path0"]);
    });

    it('t3010-ls-files-killed-modified.sh: "git ls-files -k output (w/ icase)"', async () => {
      shell.ok(dir, "config", "core.ignorecase", "true");
      try {
        await check(dir, ["-k"]);
        await check(dir, ["-o"]);
      } finally {
        shell.ok(dir, "config", "--unset", "core.ignorecase");
      }
    });

    it('t3010-ls-files-killed-modified.sh: "validate git ls-files -m output."', async () => {
      await check(dir, ["-m"]);
      await check(dir, ["-m", "-t"]);
      await check(dir, ["-d"]);
      await check(dir, ["-d", "-m", "-c", "-t"]);
    });
  });

  describe("t3012-ls-files-dedup.sh", () => {
    let dir: string;
    beforeAll(() => {
      dir = repository("t3012");
      for (const f of ["a.txt", "b.txt", "delete.txt"]) put(dir, f);
      shell.ok(dir, "add", "a.txt", "b.txt", "delete.txt");
      shell.tick();
      shell.ok(dir, "commit", "-q", "-m", "base");
      put(dir, "a.txt", "a\n");
      put(dir, "b.txt", "b\n");
      put(dir, "delete.txt", "delete\n");
      shell.ok(dir, "add", "a.txt", "b.txt", "delete.txt");
      shell.tick();
      shell.ok(dir, "commit", "-q", "-m", "tip");
      shell.ok(dir, "tag", "tip");
      shell.ok(dir, "reset", "-q", "--hard", "HEAD^");
      put(dir, "a.txt", "change\n");
      shell.tick();
      shell.ok(dir, "commit", "-q", "-a", "-m", "side");
      shell.ok(dir, "tag", "side");
    });

    it('t3012-ls-files-dedup.sh: "git ls-files --deduplicate to show unique unmerged path"', async () => {
      shell.git(dir, ["merge", "tip"]);
      await check(dir, ["--deduplicate"]);
      await check(dir, []);
      await check(dir, ["-s"]);
      await check(dir, ["-u"]);
      await check(dir, ["-u", "-t"]);
      shell.ok(dir, "merge", "--abort");
    });

    it('t3012-ls-files-dedup.sh: "git ls-files -d -m --deduplicate with different display options"', async () => {
      shell.ok(dir, "reset", "-q", "--hard", "side");
      shell.git(dir, ["merge", "tip"]);
      rmSync(join(dir, "delete.txt"));
      await check(dir, ["-d", "-m", "--deduplicate"]);
      await check(dir, ["-d", "-m", "-t", "--deduplicate"]);
      await check(dir, ["-d", "-m", "-c", "--deduplicate"]);
      shell.ok(dir, "merge", "--abort");
      await check(dir, ["--resolve-undo"]);
    });
  });

  describe("t3013-ls-files-format.sh", () => {
    let dir: string;
    beforeAll(() => {
      dir = repository("t3013");
      put(dir, "o1.txt", "LINEONE\nLINETWO\nLINETHREE\n");
      put(dir, "o2.txt", "LINEONE\r\nLINETWO\r\nLINETHREE\r\n");
      put(dir, "o3.txt", "LINEONE\r\nLINETWO\nLINETHREE\n");
      shell.ok(dir, "add", "o1.txt", "o2.txt", "o3.txt");
      const oid = shell.ok(dir, "hash-object", "o1.txt").trim();
      for (const [mode, name] of [
        ["120000", "o4.txt"],
        ["160000", "o5.txt"],
        ["100755", "o6.txt"],
      ] as const) {
        shell.ok(dir, "update-index", "--add", "--cacheinfo", `${mode},${oid},${name}`);
      }
      shell.ok(dir, "commit", "-q", "-m", "base");
    });

    it("t3013-ls-files-format.sh: usage: --format is incompatible with -s, -o, -k, -t, --resolve-undo, --deduplicate, --eol", async () => {
      for (const flag of ["-s", "-o", "-k", "-t", "--resolve-undo", "--deduplicate", "--eol"]) {
        expect(await checkStatus(dir, ["--format=%(objectname)", flag])).toBe(129);
      }
    });

    it('t3013-ls-files-format.sh: "git ls-files --format objectmode v.s. -s"', async () => {
      await check(dir, ["-s"]);
      await check(dir, ["--format=%(objectmode)"]);
      await check(dir, ["--format=%(objectname)"]);
      await check(dir, ["--format=%(objecttype)", "o1.txt", "o4.txt", "o6.txt"]);
    });

    it('t3013-ls-files-format.sh: "git ls-files --format objectsize"', async () => {
      await check(dir, ["--format=%(objectsize)"]);
      await check(dir, ["--format=%(objectsize:padded)"]);
    });

    it('t3013-ls-files-format.sh: "git ls-files --format v.s. --eol"', async () => {
      await check(dir, ["--eol"]);
      await check(dir, [
        "--format=i/%(eolinfo:index) w/%(eolinfo:worktree) attr/%(eolattr) %(path)",
      ]);
    });

    it('t3013-ls-files-format.sh: "git ls-files --format with relative path"', async () => {
      mkdirSync(join(dir, "sub"), { recursive: true });
      await check(dir, ["--format=%(path)", ":/"], "sub");
      await check(dir, ["--format=%(path)", "--full-name", ":/"], "sub");
    });

    it('t3013-ls-files-format.sh: "git ls-files --format with -m"', async () => {
      put(dir, "o1.txt", "change\n");
      await check(dir, ["--format=%(path)", "-m"]);
      put(dir, "o7.txt", "o7\n");
      shell.ok(dir, "add", "o7.txt");
      rmSync(join(dir, "o7.txt"));
      await check(dir, ["--format=%(path)", "-d"]);
      await check(dir, ["--format=%(objectmode) %(objectname) %(stage)%x09%(path)"]);
      await check(dir, ["--format=%%%x41%(stage)"]);
    });

    it("t3013-ls-files-format.sh: bad formats die as git", async () => {
      await check(dir, ["--format=%(unknown)"]);
      await check(dir, ["--format=%xyz"]);
      await check(dir, ["--format=%(path"]);
    });
  });

  describe("t3020-ls-files-error-unmatch.sh", () => {
    it('t3020-ls-files-error-unmatch.sh: "git ls-files --error-unmatch should fail with unmatched path."', async () => {
      const dir = repository("t3020");
      put(dir, "foo");
      put(dir, "bar");
      shell.ok(dir, "update-index", "--add", "foo", "bar");
      await check(dir, ["--error-unmatch", "foo", "bar-does-not-match"]);
      await check(dir, ["--error-unmatch", "foo", "bar"]);
      await check(dir, ["--error-unmatch", "foo", "foo", "nope", "nope"]);
    });
  });

  describe("t3060-ls-files-with-tree.sh", () => {
    let dir: string;
    beforeAll(() => {
      dir = repository("t3060");
      for (let n = 0; n <= 5; n++) {
        for (let m = 0; m <= 9; m++) put(dir, `sub/file-00${n}${m}`);
      }
      shell.ok(dir, "add", ".");
      shell.tick();
      shell.ok(dir, "commit", "-q", "-m", "add a bunch of files");
      rmSync(join(dir, "sub"), { recursive: true });
      shell.tick();
      shell.ok(dir, "commit", "-q", "-a", "-m", "remove them all");
      put(dir, "a_directory_that_sorts_before_sub/file");
      put(dir, "sub/file");
      shell.ok(dir, "add", ".");
    });

    it('t3060-ls-files-with-tree.sh: "usage"', async () => {
      await check(dir, ["--with-tree=HEAD", "-u"]);
      await check(dir, ["--with-tree=HEAD", "-s"]);
    });

    it('t3060-ls-files-with-tree.sh: "git ls-files --with-tree should succeed from subdir"', async () => {
      await check(dir, ["--with-tree=HEAD~1"], "sub");
      await check(dir, ["--with-tree=HEAD"]);
      await check(dir, ["--with-tree=HEAD~1", "-t"]);
      await check(dir, ["--with-tree=nope"]);
    });

    it('t3060-ls-files-with-tree.sh: "output in a conflict"', async () => {
      const conflict = repository("t3060-conflict");
      shell.commit(conflict, "BASE", "file");
      shell.commit(conflict, "A", "file", "foo");
      shell.ok(conflict, "reset", "-q", "--hard", "BASE");
      shell.commit(conflict, "B", "file", "bar");
      shell.git(conflict, ["merge", "A", "B"]);
      await check(conflict, ["--with-tree=HEAD"]);
      await check(conflict, ["--with-tree=HEAD", "-t"]);
      rmSync(join(conflict, ".git/index"));
      await check(conflict, ["--with-tree=HEAD"]);
    });
  });

  describe("t0027-auto-crlf.sh", () => {
    it("t0027-auto-crlf.sh: the i/ w/ attr/ columns of ls-files --eol", async () => {
      const dir = repository("t0027");
      shell.ok(dir, "config", "core.autocrlf", "false");
      put(dir, "LF", "line1\nline2\n");
      put(dir, "CRLF", "line1\r\nline2\r\n");
      put(dir, "CRLF_mix_LF", "line1\r\nline2\n");
      put(dir, "LF_nul", "line1\u0000\nline2\n");
      put(dir, "empty");
      put(dir, "noeol", "line");
      put(dir, "text/a", "x\n");
      put(dir, "auto/a", "x\r\n");
      put(dir, "crlf/a", "x\n");
      put(
        dir,
        ".gitattributes",
        "text/* text\nauto/* text=auto eol=lf\ncrlf/* text eol=crlf\nCRLF -text\nnoeol binary\n",
      );
      shell.ok(dir, "add", ".");
      symlinkSync("LF", join(dir, "link"));
      shell.ok(dir, "add", "link");
      put(dir, "LF", "line1\r\nline2\r\n");
      put(dir, "untracked", "x\r\n");
      await check(dir, ["--eol"]);
      await check(dir, ["--eol", "-o"]);
      await check(dir, ["--eol", "-s", "-z"]);
      await check(dir, ["--eol", "-d"]);
    });
  });

  describe("JGit pgm LsFilesTest", () => {
    it("LsFilesTest.testListFiles: files, a link, a gitlink and quoted names", async () => {
      const dir = repository("jgit");
      put(dir, "a", "a\n");
      put(dir, "b", "b\n");
      put(dir, "a.c", "c\n");
      put(dir, "c/d", "d\n");
      put(dir, "tab\there", "t\n");
      put(dir, "café", "e\n");
      put(dir, 'quote"d', "q\n");
      symlinkSync("a", join(dir, "link"));
      shell.ok(dir, "add", ".");
      shell.ok(dir, "init", "-q", "sub");
      shell.ok(join(dir, "sub"), "commit", "-q", "--allow-empty", "-m", "sub");
      shell.ok(dir, "add", "sub");
      shell.ok(dir, "update-index", "--assume-unchanged", "a");
      shell.ok(dir, "update-index", "--skip-worktree", "b");
      await check(dir, []);
      await check(dir, ["-z"]);
      await check(dir, ["-s"]);
      await check(dir, ["-s", "--abbrev"]);
      await check(dir, ["-s", "--abbrev=5"]);
      await check(dir, ["-t"]);
      await check(dir, ["-v"]);
      await check(dir, ["-v", "-t", "-d", "-m", "-c"]);
      await check(dir, ["c"]);
      await check(dir, ["c/"]);
      await check(dir, ["sub/"]);
      await check(dir, ["*.c"]);
      await check(dir, [":!a*"]);
      await check(dir, ["-c", "-o", "-t"]);
      await check(dir, [], "c");
      await check(dir, ["--full-name"], "c");
      await check(dir, [".."], "c");
      await check(dir, ["-o", ".."], "c");
    });
  });
});
