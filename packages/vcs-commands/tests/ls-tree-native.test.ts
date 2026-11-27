/**
 * `git ls-tree` (builtin/ls-tree.c), native twins: the scenarios of t3100-ls-tree-restrict,
 * t3101-ls-tree-dirname, t3102-ls-tree-wildcards, t3103-ls-tree-misc, t3104-ls-tree-format and
 * t3105-ls-tree-output, each run by native git and by ours on the same repository with git as
 * the oracle (stdout bytes, stderr and exit status compared; a usage error's first line only,
 * as git prints its usage after it).
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Git, LsTreeCommand } from "../src/index.js";
import { compatibilityOf, Shell } from "./describe-native-support.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

interface Outcome {
  status: number;
  stdout: Buffer;
  stderr: string;
}

let root: string;
let shell: Shell;
let counter = 0;

/** `git ls-tree <argv>` mapped onto our LsTreeCommand. */
function lsTreeArgs(git: Git, argv: string[]): LsTreeCommand {
  const command = git.lsTree().setCompatibility(compatibilityOf(shell));
  let dashdash = false;
  let treeish: string | undefined;
  const paths: string[] = [];
  for (const arg of argv) {
    if (dashdash || !arg.startsWith("-") || arg === "-") {
      if (treeish === undefined) treeish = arg;
      else paths.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const [opt, value] = eq > 0 ? [arg.slice(0, eq), arg.slice(eq + 1)] : [arg, undefined];
    switch (opt) {
      case "--":
        dashdash = true;
        break;
      case "-d":
        command.setTreesOnly();
        break;
      case "-r":
        command.setRecursive();
        break;
      case "-t":
        command.setShowTrees();
        break;
      case "-z":
        command.setNullTerminated();
        break;
      case "-l":
      case "--long":
        command.setLong(opt);
        break;
      case "--name-only":
        command.setNameOnly();
        break;
      case "--name-status":
        command.setNameStatus();
        break;
      case "--object-only":
        command.setObjectOnly();
        break;
      case "--full-name":
        command.setFullName(true);
        break;
      case "--no-full-name":
        command.setFullName(false);
        break;
      case "--full-tree":
        command.setFullTree();
        break;
      case "--format":
        command.setFormat(value as string);
        break;
      case "--abbrev":
        command.setAbbrev(value === undefined ? undefined : Number(value));
        break;
      case "--no-abbrev":
        command.setAbbrev(0);
        break;
      default:
        throw new Error(`unmapped option ${arg}`);
    }
  }
  if (treeish !== undefined) command.setTreeish(treeish);
  command.addPaths(...paths);
  return command;
}

function nativeLsTree(dir: string, sub: string, argv: string[]): Outcome {
  const r = spawnSync("git", ["ls-tree", ...argv], {
    cwd: join(dir, sub),
    env: { ...nativeGitEnv(shell.home), ...shell.dates() },
  });
  return { status: r.status ?? 1, stdout: r.stdout, stderr: r.stderr.toString("utf8") };
}

async function oursLsTree(dir: string, sub: string, argv: string[]): Promise<Outcome> {
  const git = await openOurs(dir);
  const command = lsTreeArgs(git, argv);
  if (sub) command.setPrefix(sub);
  const r = await command.callOutput();
  return { status: r.exitCode, stdout: Buffer.from(r.stdout), stderr: r.stderr };
}

/** Both sides compared; `sub` is the directory git runs in. */
async function check(dir: string, argv: string[], sub = ""): Promise<Outcome> {
  const native = nativeLsTree(dir, sub, argv);
  const ours = await oursLsTree(dir, sub, argv);
  expect(ours.status).toBe(native.status);
  if (native.status === 129) {
    // git prints its usage after the first line
    expect(ours.stderr.split("\n")[0]).toBe(native.stderr.split("\n")[0]);
  } else {
    expect(ours.stderr).toBe(native.stderr);
  }
  expect(ours.stdout.toString("latin1")).toBe(native.stdout.toString("latin1"));
  return native;
}

function repository(name: string, ...initArgs: string[]): string {
  const dir = join(root, `${name}-${counter++}`);
  shell.ok(root, "init", "-q", "-b", "main", ...initArgs, dir);
  return dir;
}

function write(dir: string, path: string, content: string | Buffer): void {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), content);
}

/** test_ln_s_add */
function lnsAdd(dir: string, target: string, link: string): void {
  mkdirSync(join(dir, link, ".."), { recursive: true });
  symlinkSync(target, join(dir, link));
  shell.ok(dir, "add", "--", link);
}

describeGit("git ls-tree, native twins", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "ls-tree-native-"));
    shell = new Shell(root);
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe("t3100-ls-tree-restrict", () => {
    let dir: string;
    let tree: string;
    beforeAll(() => {
      dir = repository("t3100");
      write(dir, "path0", "Hi\n");
      lnsAdd(dir, "path0", "path1");
      lnsAdd(dir, "../path1", "path2/bazbo");
      write(dir, "path2/foo", "Lo\n");
      write(dir, "path2/baz/b", "Mi\n");
      shell.ok(dir, "add", "path0", "path2/foo", "path2/baz/b");
      tree = shell.ok(dir, "write-tree").trim();
    });

    it('t3100-ls-tree-restrict.sh: "ls-tree plain"', async () => {
      await check(dir, [tree]);
    });
    it('t3100-ls-tree-restrict.sh: "ls-tree recursive"', async () => {
      await check(dir, ["-r", tree]);
    });
    it('t3100-ls-tree-restrict.sh: "ls-tree recursive with -t"', async () => {
      await check(dir, ["-r", "-t", tree]);
    });
    it('t3100-ls-tree-restrict.sh: "ls-tree recursive with -d"', async () => {
      await check(dir, ["-r", "-d", tree]);
    });
    it('t3100-ls-tree-restrict.sh: "ls-tree filtered with path"', async () => {
      await check(dir, [tree, "path"]);
    });
    it('t3100-ls-tree-restrict.sh: "ls-tree filtered with path1 path0"', async () => {
      await check(dir, [tree, "path1", "path0"]);
    });
    it('t3100-ls-tree-restrict.sh: "ls-tree filtered with path0/"', async () => {
      await check(dir, [tree, "path0/"]);
    });
    it('t3100-ls-tree-restrict.sh: "ls-tree filtered with path2"', async () => {
      await check(dir, [tree, "path2"]);
    });
    it('t3100-ls-tree-restrict.sh: "ls-tree filtered with path2/"', async () => {
      await check(dir, [tree, "path2/"]);
    });
    it('t3100-ls-tree-restrict.sh: "ls-tree filtered with path2/baz"', async () => {
      await check(dir, [tree, "path2/baz"]);
    });
    it('t3100-ls-tree-restrict.sh: "ls-tree filtered with path2/bak"', async () => {
      await check(dir, [tree, "path2/bak"]);
    });
    it('t3100-ls-tree-restrict.sh: "ls-tree -t filtered with path2/bak"', async () => {
      await check(dir, ["-t", tree, "path2/bak"]);
    });
    it('t3100-ls-tree-restrict.sh: "ls-tree with one path a prefix of the other"', async () => {
      await check(dir, [tree, "path2/baz", "path2/bazbo"]);
    });
    it("-d and -t without -r, with paths", async () => {
      await check(dir, ["-d", tree]);
      await check(dir, ["-d", tree, "path2/"]);
      await check(dir, ["-t", tree, "path2/baz/b"]);
      await check(dir, ["-d", "-t", tree, "path2/baz/b"]);
      await check(dir, ["-r", tree, "path2"]);
      await check(dir, ["-r", "-d", tree, "path2/baz"]);
    });
  });

  describe("t3101-ls-tree-dirname", () => {
    let dir: string;
    let tree: string;
    beforeAll(() => {
      dir = repository("t3101");
      write(dir, "1.txt", "111\n");
      write(dir, "2.txt", "222\n");
      write(dir, "path0/a/b/c/1.txt", "111\n");
      write(dir, "path1/b/c/1.txt", "111\n");
      write(dir, "path2/1.txt", "111\n");
      write(dir, "path3/1.txt", "111\n");
      write(dir, "path3/2.txt", "222\n");
      shell.ok(dir, "add", ".");
      tree = shell.ok(dir, "write-tree").trim();
    });

    it('t3101-ls-tree-dirname.sh: "ls-tree plain"', async () => {
      await check(dir, [tree]);
    });
    it('t3101-ls-tree-dirname.sh: "ls-tree recursive"', async () => {
      await check(dir, ["-r", tree]);
    });
    it('t3101-ls-tree-dirname.sh: "ls-tree filter 1.txt"', async () => {
      await check(dir, [tree, "1.txt"]);
    });
    it('t3101-ls-tree-dirname.sh: "ls-tree filter path1/b/c/1.txt"', async () => {
      await check(dir, [tree, "path1/b/c/1.txt"]);
    });
    it('t3101-ls-tree-dirname.sh: "ls-tree filter all 1.txt files"', async () => {
      await check(dir, [
        tree,
        "1.txt",
        "path0/a/b/c/1.txt",
        "path1/b/c/1.txt",
        "path2/1.txt",
        "path3/1.txt",
      ]);
    });
    it('t3101-ls-tree-dirname.sh: "ls-tree filter directories"', async () => {
      await check(dir, [tree, "path3", "path2", "path0/a/b/c", "path1/b/c", "path0/a"]);
    });
    it('t3101-ls-tree-dirname.sh: "ls-tree filter odd names"', async () => {
      await check(dir, [
        tree,
        "1.txt",
        "./1.txt",
        ".//1.txt",
        "path3/1.txt",
        "path3/./1.txt",
        "path3",
        "path3//",
      ]);
    });
    it('t3101-ls-tree-dirname.sh: "ls-tree filter missing files and extra slashes"', async () => {
      await check(dir, [tree, "1.txt/", "abc.txt", "path3//23.txt", "path3/2.txt///"]);
    });
    it('t3101-ls-tree-dirname.sh: "ls-tree filter is leading path match"', async () => {
      await check(dir, [tree, "pa", "path3/a"]);
    });
    it('t3101-ls-tree-dirname.sh: "ls-tree --full-name"', async () => {
      await check(dir, ["--full-name", tree, "a"], "path0");
    });
    it('t3101-ls-tree-dirname.sh: "ls-tree --no-full-name"', async () => {
      await check(dir, ["--no-full-name", tree, "a"], "path0");
    });
    it('t3101-ls-tree-dirname.sh: "ls-tree --full-tree"', async () => {
      await check(dir, ["--full-tree", tree], "path1/b/c");
    });
    it('t3101-ls-tree-dirname.sh: "ls-tree --full-tree -r"', async () => {
      await check(dir, ["--full-tree", "-r", tree], "path3");
    });
    it('t3101-ls-tree-dirname.sh: "ls-tree --abbrev=5"', async () => {
      await check(dir, ["--abbrev=5", tree]);
    });
    // t3101-ls-tree-dirname.sh: "ls-tree $opt", "ls-tree $opt -r"
    for (const opt of ["--name-only", "--name-status"]) {
      it(`ls-tree ${opt}`, async () => {
        await check(dir, [opt, tree]);
      });
      it(`ls-tree ${opt} -r`, async () => {
        await check(dir, [opt, "-r", tree]);
      });
    }
    it("paths relative to a subdirectory, up and out of it", async () => {
      await check(dir, [tree], "path3");
      await check(dir, ["-r", tree, "../"], "path3");
      await check(dir, [tree, "../path3"], "path3");
      await check(dir, [tree, "../path0/a"], "path3");
      await check(dir, ["--format=%(path)", tree, ".."], "path3");
      await check(dir, [tree, "../.."], "path3");
      await check(dir, [tree, join(dir, "1.txt")], "path3");
      await check(dir, ["--abbrev=2", tree]);
      await check(dir, ["--abbrev", "-r", tree]);
      await check(dir, ["--no-abbrev", tree]);
      await check(dir, [tree, "."]);
    });
  });

  describe("t3102-ls-tree-wildcards", () => {
    let dir: string;
    beforeAll(() => {
      dir = repository("t3102");
      write(dir, "a/one", "");
      write(dir, "aa/two", "");
      write(dir, "a[a]/three", "");
      shell.ok(dir, "add", "a/one", "aa/two", "a[a]/three");
      shell.tick();
      shell.ok(dir, "commit", "-q", "-m", "test");
    });

    it('t3102-ls-tree-wildcards.sh: "ls-tree a[a] matches literally"', async () => {
      await check(dir, ["-r", "HEAD", "a[a]"]);
    });
    it('t3102-ls-tree-wildcards.sh: "ls-tree outside prefix"', async () => {
      await check(dir, ["-r", "HEAD", "../a[a]"], "aa");
    });
    it("pathspec magic: top and literal only", async () => {
      // t3102-ls-tree-wildcards.sh: "ls-tree does not yet support negated pathspec": both refuse it
      await check(dir, ["--name-only", "-r", "HEAD", ":(exclude)a", "a*"]);
      await check(dir, ["HEAD", ":!a"]);
      await check(dir, ["HEAD", ":(glob)a"]);
      await check(dir, ["HEAD", ":(icase)a"]);
      await check(dir, ["HEAD", ":(glob,icase)a"]);
      await check(dir, ["HEAD", ":(literal)a"]);
      await check(dir, ["HEAD", ":/a"], "aa");
      await check(dir, ["HEAD", ":(top)a[a]"], "aa");
      await check(dir, ["HEAD", ":(nope)a"]);
      await check(dir, ["HEAD", ":(top"]);
      await check(dir, ["HEAD", ""]);
    });
  });

  describe("t3103-ls-tree-misc", () => {
    it('t3103-ls-tree-misc.sh: "ls-tree fails with non-zero exit code on broken tree"', async () => {
      const dir = repository("t3103");
      write(dir, "a/one", "");
      shell.ok(dir, "add", "a/one");
      shell.tick();
      shell.ok(dir, "commit", "-q", "-m", "test");
      const tree = shell.ok(dir, "rev-parse", "HEAD:a").trim();
      const path = join(dir, ".git", "objects", tree.slice(0, 2), tree.slice(2));
      chmodSync(path, 0o644);
      unlinkSync(path);
      await check(dir, ["-r", "HEAD"]);
      await check(dir, ["HEAD"]);
      await check(dir, ["-r", "-l", "HEAD"]);
    });

    const dir = () => {
      const d = repository("t3103-usage");
      write(d, "a/one", "");
      shell.ok(d, "add", "a/one");
      shell.tick();
      shell.ok(d, "commit", "-q", "-m", "test");
      return d;
    };
    // t3103-ls-tree-misc.sh: "usage: incompatible options: $opts", "usage: incompatible options: $one_opt and --format"
    for (const opts of [
      "--long --name-only",
      "--name-only --name-status",
      "--name-status --object-only",
      "--object-only --long",
    ]) {
      it(`usage: incompatible options: ${opts}`, async () => {
        const d = dir();
        await check(d, [...opts.split(" "), "HEAD"]);
        const one = opts.split(" ")[0] as string;
        await check(d, [one, "--format=fmt", "HEAD"]);
      });
    }
    it("conflicting -l spellings, a repeated mode, no tree-ish, bad names", async () => {
      const d = dir();
      await check(d, ["-l", "--name-only", "HEAD"]);
      await check(d, ["--name-only", "-l", "HEAD"]);
      await check(d, ["--name-only", "--name-only", "HEAD"]);
      await check(d, []);
      await check(d, ["nope"]);
      await check(d, ["HEAD:nope"]);
      await check(d, ["HEAD:a/one"]);
      await check(d, ["HEAD:a"]);
      await check(d, ["0000000000000000000000000000000000000001"]);
      const tag = shell.ok(d, "rev-parse", "HEAD").trim();
      shell.ok(d, "tag", "-a", "-m", "t", "v1", tag);
      await check(d, ["v1"]);
    });
  });

  describe("t3104-ls-tree-format and t3105-ls-tree-output", () => {
    let dir: string;
    beforeAll(() => {
      // lib-t3100.sh's setup_basic_ls_tree_data
      dir = repository("t3104");
      mkdirSync(join(dir, "dir"));
      shell.commit(dir, "dir/sub-file");
      shell.commit(dir, "top-file");
      shell.ok(dir, "clone", "-q", ".", "submodule");
      const r = shell.git(dir, [
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        "./submodule",
      ]);
      if (r.status !== 0) throw new Error(r.stderr);
      shell.tick();
      shell.ok(dir, "commit", "-q", "-m", "add submodule");
    });

    // t3105-ls-tree-output.sh: "ls-tree --format usage" (the same test)
    it('t3104-ls-tree-format.sh: "ls-tree --format usage"', async () => {
      await check(dir, ["--format=fmt", "-l", "HEAD"]);
      await check(dir, ["--format=fmt", "--name-only", "HEAD"]);
      await check(dir, ["--format=fmt", "--name-status", "HEAD"]);
    });

    it(`t3104-ls-tree-format.sh: "ls-tree --format='%(path) %(path) %(path)' HEAD top-file"`, async () => {
      await check(dir, ["--format=%(path) %(path) %(path)", "HEAD", "top-file.t"]);
    });

    const formats: [string, string[], string[]][] = [
      ["%(objectmode) %(objecttype) %(objectname)%x09%(path)", [], []],
      ["%(objectmode) %(objecttype) %(objectname) %(objectsize:padded)%x09%(path)", ["--long"], []],
      ["%(path)", ["--name-only"], []],
      ["%(objectname)", ["--object-only"], []],
      ["%(objectname)", ["--object-only", "--abbrev"], ["--abbrev"]],
      ["%(objectmode) %(objecttype) %(objectname)%x09%(path)", ["-t"], ["-t"]],
      ["%(objectmode) %(objecttype) %(objectname)%x09%(path)", ["--full-name"], ["--full-name"]],
      ["%(objectmode) %(objecttype) %(objectname)%x09%(path)", ["--full-tree"], ["--full-tree"]],
    ];
    // t3104-ls-tree-format.sh: "ls-tree '--format=<$format>' is like options '$opts $fmtopts'", "ls-tree '--format=<$format>' on optimized v.s. non-optimized path"
    for (const [format, opts, fmtopts] of formats) {
      it(`ls-tree '--format=<${format}>' is like options '${opts.join(" ")} ${fmtopts.join(" ")}'`, async () => {
        await check(dir, [...opts, "-r", "HEAD"]);
        await check(dir, [`--format=${format}`, "-r", ...fmtopts, "HEAD"]);
      });
      it(`ls-tree '--format=<${format}>' on optimized v.s. non-optimized path`, async () => {
        await check(dir, [`--format=> ${format}`, "-r", ...fmtopts, "HEAD"]);
      });
    }

    // t3105-ls-tree-output.sh: "'ls-tree $opts${mode:+ $mode}' output", "'ls-tree $opts${mode:+ $mode}' output (via subdir)", "'ls-tree $opts${mode:+ $mode}' output (via subdir, fails)"
    for (const opts of [
      [],
      ["--long"],
      ["--name-only"],
      ["--object-only"],
      ["--object-only", "--abbrev"],
      ["--full-name"],
      ["--full-tree"],
    ]) {
      for (const mode of [[], ["-d"], ["-r"], ["-t"]]) {
        const title = `ls-tree ${opts.join(" ")}${mode.length > 0 ? ` ${mode.join(" ")}` : ""}`;
        it(`'${title}' output`, async () => {
          await check(dir, [...mode, ...opts, "HEAD"]);
        });
        it(`'${title}' output (via subdir${opts[0] === "--full-tree" ? ", fails" : ""})`, async () => {
          await check(dir, ["--full-name", ...mode, ...opts, "HEAD", "--", "../"], "dir");
        });
      }
    }

    it("format atoms, escapes and errors", async () => {
      await check(dir, [
        "--format=%(objectsize) %(objectsize:padded)|%x41%n%%",
        "-r",
        "-t",
        "HEAD",
      ]);
      await check(dir, ["--format=%(foo)", "HEAD"]);
      await check(dir, ["--format=%z", "HEAD"]);
      await check(dir, ["--format=%(path", "HEAD"]);
      await check(dir, ["--format=plain", "HEAD"]);
      await check(dir, ["-z", "--format=[%(path)]", "-r", "HEAD"]);
      await check(dir, ["--format=%(path)", "-r", "HEAD"], "dir");
    });
  });

  describe("names, modes and object formats", () => {
    it("quoted names, -z, core.quotePath", async () => {
      const dir = repository("quote");
      write(dir, "sp ace", "q");
      write(dir, "tab\there", "q");
      write(dir, "é/ü", "z");
      write(dir, 'quo"te', "q");
      shell.ok(dir, "add", ".");
      shell.tick();
      shell.ok(dir, "commit", "-q", "-m", "m");
      for (const argv of [
        ["HEAD"],
        ["-r", "HEAD"],
        ["-z", "-r", "HEAD"],
        ["-z", "--name-only", "-r", "HEAD"],
        ["-l", "-r", "HEAD"],
        ["--format=%(path)!", "-r", "HEAD"],
        ["-r", "HEAD", "é"],
      ]) {
        await check(dir, argv);
      }
      await check(dir, ["-r", "HEAD", "../tab\there"], "é");
      shell.ok(dir, "config", "core.quotePath", "false");
      await check(dir, ["-r", "HEAD"]);
      await check(dir, ["--format=%(path)!", "-r", "HEAD"]);
    });

    it("a 100664 entry and a gitlink in a crafted tree", async () => {
      const dir = repository("modes");
      write(dir, "f", "x\n");
      shell.ok(dir, "add", "f");
      shell.tick();
      shell.ok(dir, "commit", "-q", "-m", "m");
      const blob = shell.ok(dir, "rev-parse", "HEAD:f").trim();
      const commit = shell.ok(dir, "rev-parse", "HEAD").trim();
      const entry = (mode: string, name: string, id: string) =>
        Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(id, "hex")]);
      const content = Buffer.concat([entry("100664", "a", blob), entry("160000", "sub", commit)]);
      const r = spawnSync("git", ["hash-object", "-t", "tree", "-w", "--stdin", "--literally"], {
        cwd: dir,
        env: nativeGitEnv(root),
        input: content,
      });
      const tree = r.stdout.toString().trim();
      for (const argv of [
        [tree],
        ["-l", tree],
        ["-d", tree],
        ["-r", "-t", tree],
        ["-r", tree, "sub/x"],
        ["--format=%(objectmode) %(objectsize)", tree],
      ]) {
        await check(dir, argv);
      }
    });

    it("a tree holding names fsck refuses ('..', an empty name)", async () => {
      const dir = repository("dotdot");
      write(dir, "f", "x\n");
      shell.ok(dir, "add", "f");
      shell.tick();
      shell.ok(dir, "commit", "-q", "-m", "m");
      const blob = shell.ok(dir, "rev-parse", "HEAD:f").trim();
      const entry = (mode: string, name: string, id: string) =>
        Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(id, "hex")]);
      const content = Buffer.concat([entry("100644", "..", blob), entry("100644", "ok", blob)]);
      const r = spawnSync("git", ["hash-object", "-t", "tree", "-w", "--stdin", "--literally"], {
        cwd: dir,
        env: nativeGitEnv(root),
        input: content,
      });
      const tree = r.stdout.toString().trim();
      for (const argv of [
        [tree],
        ["-r", tree],
        ["-l", tree],
        ["--name-only", tree],
        [tree, "ok"],
      ]) {
        await check(dir, argv);
      }
    });

    it("a SHA-256 repository", async () => {
      const dir = repository("sha256", "--object-format=sha256");
      write(dir, "a/b", "x\n");
      write(dir, "c", "y\n");
      shell.ok(dir, "add", ".");
      shell.tick();
      shell.ok(dir, "commit", "-q", "-m", "m");
      for (const argv of [["HEAD"], ["-r", "-l", "HEAD"], ["--abbrev", "-r", "HEAD"]]) {
        await check(dir, argv);
      }
    });
  });

  describe("corrupt trees (statewalker/webrun-vcs#351)", () => {
    it("scenario from t3103: corrupt trees die as tree-walk.c's decode_tree_entry", async () => {
      const dir = repository("corrupt");
      write(dir, "f", "x\n");
      shell.ok(dir, "add", "f");
      shell.tick();
      shell.ok(dir, "commit", "-q", "-m", "m");
      const blob = shell.ok(dir, "rev-parse", "HEAD:f").trim();
      const tree = (...parts: (string | [string, string, string])[]): string =>
        spawnSync("git", ["hash-object", "-t", "tree", "-w", "--stdin", "--literally"], {
          cwd: dir,
          env: nativeGitEnv(root),
          input: Buffer.concat(
            parts.map((p) =>
              typeof p === "string"
                ? Buffer.from(p, "latin1")
                : Buffer.concat([Buffer.from(`${p[0]} ${p[1]}\0`), Buffer.from(p[2], "hex")]),
            ),
          ),
        })
          .stdout.toString()
          .trim();
      const short = tree("100644 f\0abc");
      const mode = tree(["10x644", "f", blob]);
      const empty = tree(["100644", "", blob]);
      const nested = tree(["100644", "a", blob], ["40000", "sub", short]);
      const odd = tree(["100644", "..", blob], "100644 f\0abc");
      const missing = tree(["100644", "a", blob], ["40000", "sub", "1".repeat(40)]);
      // git shows an entry once the next one decoded: a b c(bad) shows a
      const third = tree(["100644", "a", blob], ["100644", "b", blob], ["10x644", "c", blob]);
      const pair = tree(["100644", "x", blob], ["100644", "y", blob]);
      const late = tree(
        ["100644", "a", blob],
        ["40000", "s", pair],
        ["100644", "t", blob],
        ["10x644", "u", blob],
      );
      const deep = tree(["40000", "s", third], ["100644", "z", blob]);
      for (const argv of [
        [third],
        [late],
        ["-r", late],
        ["-r", deep],
        ["-r", deep, "z"],
        [`${late}:s`],
        [`${late}:t`],
        [short],
        [mode],
        [empty],
        ["-r", short],
        [nested],
        ["-r", nested],
        ["-d", "-r", nested],
        [nested, "sub/f"],
        [`${nested}:sub`],
        [odd],
        ["-r", missing],
        [missing],
      ]) {
        await check(dir, argv);
      }
    });
  });
});
