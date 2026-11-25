/**
 * `git replace` (builtin/replace.c), native twins of t6050-replace.sh: a repository is built
 * with native git, copied (`cp -a`), and each step runs as `git replace` in one copy and as
 * our ReplaceCommand in the other. stdout, stderr and the exit status are compared at every
 * step (only git's `fatal:` line for usage errors), and after each scenario the replace refs
 * of both copies, the objects they name and the presence of `info/grafts`.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type Git, GitApiError, type ReplaceCommand, type ReplaceEditor } from "../src/index.js";
import { compatibilityOf, type Outcome, Shell } from "./describe-native-support.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root: string;
let shell: Shell;
let counter = 0;

/** t6050's fakeeditor: `sed -e "s/A U Thor/A fake Thor/"` (our author is Interop Tester). */
const FAKE_EDITOR = `#!/bin/sh
sed -e "s/Interop Tester/A fake Thor/" "$1" >"$1.new"
mv "$1.new" "$1"
`;

/** What each native editor does, for ours. */
const editors: Record<string, ReplaceEditor> = {
  true: async () => undefined,
  fakeeditor: async (_path, content) =>
    new TextDecoder().decode(content).replaceAll("Interop Tester", "A fake Thor"),
  failingfakeeditor: async () => {
    // editor.c's line (the caller's editor: its wording is the git version's)
    throw new GitApiError(
      compatibilityOf(shell) === "2.43"
        ? "error: There was a problem with the editor './failingfakeeditor'."
        : "error: there was a problem with the editor './failingfakeeditor'",
    );
  },
};

/** `git replace <argv>` mapped onto our ReplaceCommand (parse_options: last value wins). */
function replaceArgs(git: Git, argv: string[], editor?: string): ReplaceCommand {
  const command = git.replace().setCompatibility(compatibilityOf(shell));
  if (editor !== undefined) command.setEditor(editors[editor] as ReplaceEditor);
  let options = true;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (!options || !arg.startsWith("-")) {
      command.addArgument(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const [opt, value] = eq >= 0 ? [arg.slice(0, eq), arg.slice(eq + 1)] : [arg, undefined];
    switch (opt) {
      case "--":
        options = false;
        break;
      case "-l":
      case "--list":
        command.setMode("list");
        break;
      case "-d":
      case "--delete":
        command.setMode("delete");
        break;
      case "-e":
      case "--edit":
        command.setMode("edit");
        break;
      case "-g":
      case "--graft":
        command.setMode("graft");
        break;
      case "--convert-graft-file":
        command.setMode("convert-graft-file");
        break;
      case "-f":
      case "--force":
        command.setForce(true);
        break;
      case "--raw":
        command.setRaw(true);
        break;
      case "--format":
        command.setFormat(value ?? (argv[++i] as string));
        break;
      default:
        throw new Error(`unmapped option ${arg}`);
    }
  }
  return command;
}

/** Twin copies of one fixture: native git runs in `native`, ours in `ours`. */
interface Twins {
  native: string;
  ours: string;
}

/** Copies `fixture` twice (`cp -a`). */
function twins(fixture: string): Twins {
  const id = counter++;
  const native = join(root, `native-${id}`);
  const ours = join(root, `ours-${id}`);
  for (const to of [native, ours]) {
    const r = spawnSync("cp", ["-a", fixture, to]);
    if (r.status !== 0) throw new Error(`cp failed: ${r.stderr}`);
  }
  return { native, ours };
}

/**
 * One `git replace <argv>` step on both twins, compared; native's outcome. `editor` names
 * the GIT_EDITOR of both (a script in the native twin, its port for ours).
 */
async function step(t: Twins, argv: string[], editor?: string): Promise<Outcome> {
  const native = shell.git(t.native, ["replace", ...argv], {
    env: editor === undefined ? {} : { GIT_EDITOR: editor === "true" ? "true" : `./${editor}` },
  });
  const git = await openOurs(t.ours);
  const out = await replaceArgs(git, argv, editor).callOutput();
  const ours: Outcome = {
    status: out.exitCode,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: out.stderr,
  };
  // usage errors: only git's first line (the usage text is the CLI's)
  const expected =
    native.status === 129 ? { ...native, stderr: `${native.stderr.split("\n")[0]}\n` } : native;
  expect({ argv, ...ours }).toEqual({ argv, ...expected });
  await compareState(t);
  return native;
}

/** The replace refs of both twins (native git reading each), their objects and info/grafts. */
async function compareState(t: Twins): Promise<void> {
  const refs = (dir: string) =>
    shell.ok(dir, "for-each-ref", "--format=%(refname) %(objectname)", "refs/replace/");
  const nativeRefs = refs(t.native);
  expect(refs(t.ours)).toBe(nativeRefs);
  // the replacements are in our twin's store, byte for byte (their ids are their contents)
  for (const line of nativeRefs.split("\n").filter(Boolean)) {
    const id = line.split(" ")[1] as string;
    const nativeObject = shell.git(t.native, ["--no-replace-objects", "cat-file", "-p", id]);
    const ourObject = shell.git(t.ours, ["--no-replace-objects", "cat-file", "-p", id]);
    expect(ourObject).toEqual(nativeObject);
  }
  expect(existsSync(join(t.ours, ".git/info/grafts"))).toBe(
    existsSync(join(t.native, ".git/info/grafts")),
  );
}

/** Native git's stdout in `dir`, trimmed. */
const rev = (dir: string, ...args: string[]) => shell.ok(dir, ...args).trim();

/** A new repository on `main`. */
function repository(name: string): string {
  const dir = join(root, `${name}-${counter++}`);
  shell.ok(root, "init", "-q", "-b", "main", dir);
  return dir;
}

/** add_and_commit_file */
function addAndCommitFile(dir: string, file: string, message: string): void {
  shell.ok(dir, "add", file);
  shell.tick();
  shell.ok(dir, "commit", "--quiet", "-m", `${file}: ${message}`);
}

/** Appends lines to `hello`. */
function append(dir: string, ...lines: string[]): void {
  const path = join(dir, "hello");
  const prev = existsSync(path) ? shell.ok(dir, "show", ":hello") : "";
  writeFileSync(path, prev + lines.map((l) => `${l}\n`).join(""));
}

describeGit("git replace, native twins (t6050-replace.sh)", () => {
  /** t6050's repository after 'set up buggy branch' and 'replace the author' */
  let fixture: string;
  const H: string[] = [];
  let R: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "replace-native-"));
    shell = new Shell(root);
    fixture = repository("t6050");
    append(fixture, "line 1", "line 2", "line 3", "line 4");
    addAndCommitFile(fixture, "hello", "4 lines");
    H[1] = rev(fixture, "rev-parse", "HEAD");
    append(fixture, "line BUG", "line 6", "line 7", "line 8");
    addAndCommitFile(fixture, "hello", "4 more lines with a BUG");
    H[2] = rev(fixture, "rev-parse", "HEAD");
    append(fixture, "line 9", "line 10");
    addAndCommitFile(fixture, "hello", "2 more lines");
    H[3] = rev(fixture, "rev-parse", "HEAD");
    append(fixture, "line 11");
    addAndCommitFile(fixture, "hello", "1 more line");
    H[4] = rev(fixture, "rev-parse", "HEAD");
    writeFileSync(join(fixture, "hello"), shell.ok(fixture, "show", ":hello").replace("BUG", "5"));
    addAndCommitFile(fixture, "hello", "BUG fixed");
    H[5] = rev(fixture, "rev-parse", "HEAD");
    append(fixture, "line 12", "line 13");
    addAndCommitFile(fixture, "hello", "2 more lines");
    H[6] = rev(fixture, "rev-parse", "HEAD");
    append(fixture, "line 14", "line 15", "line 16");
    addAndCommitFile(fixture, "hello", "again 3 more lines");
    H[7] = rev(fixture, "rev-parse", "HEAD");
    // 'replace the author'
    const commit = shell.ok(fixture, "cat-file", "commit", H[2] as string);
    R = shell
      .git(fixture, ["hash-object", "-t", "commit", "--stdin", "-w"], {
        input: commit.replace("Interop Tester", "O Thor"),
      })
      .stdout.trim();
    shell.ok(fixture, "update-ref", `refs/replace/${H[2]}`, R);
    // 'tag replaced commit'
    const tag = shell
      .git(fixture, ["mktag"], {
        input: `object ${H[2]}\ntype commit\ntag mytag\ntagger T A Gger <> 0 +0000\n\n`,
      })
      .stdout.trim();
    shell.ok(fixture, "update-ref", "refs/tags/mytag", tag);
    for (const name of ["fakeeditor", "failingfakeeditor"]) {
      const path = join(fixture, name);
      writeFileSync(
        path,
        name === "fakeeditor" ? FAKE_EDITOR : '#!/bin/sh\n./fakeeditor "$@"\nfalse\n',
      );
      chmodSync(path, 0o755);
    }
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it(`t6050-replace.sh: '"git replace" listing and deleting'`, async () => {
    const t = twins(fixture);
    const h2 = H[2] as string;
    await step(t, ["-l"]);
    await step(t, []);
    await step(t, ["--list", `${h2.slice(0, 2)}*`]);
    await step(t, ["--list", "zz*"]);
    await step(t, ["-d", R]);
    await step(t, ["--delete"]);
    await step(t, ["-d", h2]);
    await step(t, ["-l"]);
  });

  it(`t6050-replace.sh: '"git replace" replacing'`, async () => {
    const t = twins(fixture);
    const h2 = H[2] as string;
    await step(t, ["-d", h2]);
    await step(t, [h2, R]);
    await step(t, [h2, R]);
    await step(t, ["-f", h2, R]);
    await step(t, ["-f"]);
    await step(t, []);
  });

  it(`t6050-replace.sh: '"git replace" resolves sha1'`, async () => {
    const t = twins(fixture);
    const short = (H[2] as string).slice(0, 8);
    await step(t, ["-d", short]);
    await step(t, [short, R]);
    await step(t, [H[2] as string, R]);
    await step(t, ["-f", H[2] as string, R]);
    await step(t, ["--force"]);
    await step(t, []);
  });

  it('t6050-replace.sh: "replaced and replacement objects must be of the same type", "-f option bypasses the type check"', async () => {
    const t = twins(fixture);
    writeFileSync(join(t.native, "file"), "replaced\n");
    shell.ok(t.native, "add", "file");
    // the blob in the index of both twins
    const blob = rev(t.native, "rev-parse", ":file");
    shell.git(t.ours, ["hash-object", "-w", "--stdin"], { input: "replaced\n" });
    await step(t, ["mytag", H[1] as string]);
    await step(t, ["HEAD^{tree}", "HEAD~1"]);
    await step(t, ["HEAD^", blob]);
    await step(t, ["nope", "HEAD"]);
    await step(t, ["HEAD", "nope"]);
    await step(t, ["-f", "mytag", H[1] as string]);
    await step(t, ["--force", "HEAD^{tree}", "HEAD~1"]);
    await step(t, ["-f", "HEAD^", blob]);
    await step(t, ["a", "b", "c"]);
  });

  it('t6050-replace.sh: "test --format bogus", "test --format short", "test --format medium", "test --format long"', async () => {
    const t = twins(fixture);
    await step(t, ["-f", "mytag", H[1] as string]);
    await step(t, ["--force", "HEAD^{tree}", "HEAD~1"]);
    await step(t, ["--format", "bogus"]);
    await step(t, ["--format=short"]);
    await step(t, ["-l", "--format=medium"]);
    await step(t, ["--format=long"]);
    await step(t, ["--format=", "-l", "*"]);
    await step(t, ["--format=long", "HEAD", "HEAD"]);
    await step(t, ["-l", "a", "b"]);
  });

  it('t6050-replace.sh: "--edit with and without already replaced object", "--edit and change nothing or command failed"', async () => {
    const t = twins(fixture);
    const h3 = H[3] as string;
    await step(t, ["-d", H[2] as string]);
    await step(t, [H[2] as string, R]);
    await step(t, ["--edit", H[2] as string], "fakeeditor");
    await step(t, ["--force", "--edit", H[2] as string], "fakeeditor");
    await step(t, ["-d", H[2] as string]);
    await step(t, ["--edit", h3], "true");
    await step(t, ["--edit", h3], "failingfakeeditor");
    await step(t, ["--edit", h3], "fakeeditor");
    await step(t, ["-e"]);
    await step(t, ["--raw", "-l"]);
    await step(t, ["-e", "nope"], "fakeeditor");
  });

  it('t6050-replace.sh: "--edit with and without already replaced object" (raw objects, trees, tags and blobs)', async () => {
    const t = twins(fixture);
    await step(t, ["--raw", "-e", H[4] as string], "fakeeditor");
    await step(t, ["-e", "mytag"], "true");
    // a tree pretty-printed and read back through mktree: unchanged, then renamed
    await step(t, ["-e", "HEAD^{tree}"], "true");
    writeFileSync(
      join(t.native, "renamer"),
      '#!/bin/sh\nsed -e "s/\thello/\tworld/" "$1" >"$1.new"\nmv "$1.new" "$1"\n',
    );
    chmodSync(join(t.native, "renamer"), 0o755);
    editors.renamer = async (_p, content) =>
      new TextDecoder().decode(content).replace("\thello", "\tworld");
    await step(t, ["-e", "HEAD^{tree}"], "renamer");
    await step(t, ["--raw", "-e", "HEAD:hello"], "true");
    // a raw tree whose two entries are swapped: git's strict fsck refuses it (treeNotSorted)
    for (const dir of [t.native, t.ours]) {
      writeFileSync(join(dir, "a"), "a\n");
      shell.ok(dir, "add", "a");
      shell.tick();
      shell.ok(dir, "commit", "-q", "-m", "two entries");
    }
    writeFileSync(
      join(t.native, "swapper"),
      '#!/bin/sh\nnode -e \'const f=process.argv[1],fs=require("fs"),b=fs.readFileSync(f),i=b.indexOf(0)+21;fs.writeFileSync(f,Buffer.concat([b.subarray(i),b.subarray(0,i)]))\' "$1"\n',
    );
    chmodSync(join(t.native, "swapper"), 0o755);
    editors.swapper = async (_p, content) => {
      const i = content.indexOf(0) + 21;
      return new Uint8Array([...content.subarray(i), ...content.subarray(0, i)]);
    };
    await step(t, ["--raw", "-e", "HEAD^{tree}"], "swapper");
  });

  it('t6050-replace.sh: "replace ref cleanup"', async () => {
    const t = twins(fixture);
    await step(t, ["-f", "mytag", H[1] as string]);
    const all = shell.ok(t.native, "replace").split("\n").filter(Boolean);
    await step(t, ["-d", ...all, "nope", H[5] as string]);
    await step(t, []);
  });

  it('t6050-replace.sh: "--graft with and without already replaced object"', async () => {
    const t = twins(fixture);
    await step(t, ["-d", H[2] as string]);
    await step(t, ["--graft", H[5] as string]);
    await step(t, ["--graft", H[5] as string, H[4] as string, H[3] as string]);
    await step(t, ["--force", "-g", H[5] as string, H[4] as string, H[3] as string]);
    await step(t, ["-d", H[5] as string]);
    await step(t, ["-g"]);
    await step(t, ["-g", "nope"]);
    await step(t, ["-g", "HEAD^{tree}"]);
    await step(t, ["-g", "HEAD", "HEAD^{tree}"]);
    await step(t, ["-g", "HEAD", "nope"]);
    await step(t, ["-g", "HEAD~1", "HEAD~2"]);
    await step(t, ["-g", H[1] as string, H[1] as string]);
  });

  it('t6050-replace.sh: "--graft using a tag as the new parent", "--graft using a tag as the replaced object"', async () => {
    const t = twins(fixture);
    for (const dir of [t.native, t.ours]) {
      shell.ok(dir, "tag", "new_parent", H[5] as string);
      shell.ok(
        dir,
        "tag",
        "-a",
        "-m",
        "annotated new parent tag",
        "annotated_new_parent",
        H[5] as string,
      );
      shell.ok(dir, "tag", "replaced_object", H[7] as string);
      shell.ok(
        dir,
        "tag",
        "-a",
        "-m",
        "annotated replaced object tag",
        "annotated_replaced_object",
        H[7] as string,
      );
    }
    await step(t, ["--graft", H[7] as string, "new_parent"]);
    await step(t, ["-d", H[7] as string]);
    await step(t, ["--graft", H[7] as string, "annotated_new_parent"]);
    await step(t, ["-d", H[7] as string]);
    await step(t, ["--graft", "replaced_object", H[5] as string]);
    await step(t, ["-d", H[7] as string]);
    await step(t, ["--graft", "annotated_replaced_object", H[5] as string]);
  });

  it('t6050-replace.sh: "--graft with a signed commit", "--graft on a commit with a mergetag"', async () => {
    // the signature and the mergetag are written by hand (no gpg needed): git only parses them
    const base = twins(fixture).native;
    const tree = rev(base, "rev-parse", "HEAD^{tree}");
    const author = "author A U Thor <author@example.com> 1112912000 -0700";
    const committer = "committer C O Mitter <committer@example.com> 1112912000 -0700";
    const signed = shell
      .git(base, ["hash-object", "-t", "commit", "--stdin", "-w"], {
        input: `tree ${tree}\nparent ${H[7]}\n${author}\n${committer}\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n abcd\n -----END PGP SIGNATURE-----\n\nsigned\n`,
      })
      .stdout.trim();
    const tag = shell
      .git(base, ["mktag"], {
        input: `object ${H[6]}\ntype commit\ntag test_tag\ntagger T A Gger <> 0 +0000\n\nmerged\n`,
      })
      .stdout.trim();
    const tagText = shell.ok(base, "cat-file", "tag", tag);
    const mergetag = `mergetag ${tagText.replace(/\n$/, "").split("\n").join("\n ")}\n`;
    const merge = shell
      .git(base, ["hash-object", "-t", "commit", "--stdin", "-w"], {
        input: `tree ${tree}\nparent ${signed}\nparent ${H[6]}\n${author}\n${committer}\n${mergetag}\nmerge\n`,
      })
      .stdout.trim();
    shell.ok(base, "update-ref", "refs/heads/signed", merge);
    const t = twins(base);
    await step(t, ["--graft", signed]);
    await step(t, ["-d", signed]);
    await step(t, ["--graft", merge, H[5] as string]);
    await step(t, ["--graft", merge, H[5] as string, H[6] as string]);
    await step(t, ["-d", merge]);
    await step(t, ["--graft", merge, H[5] as string, tag]);
  });

  it('t6050-replace.sh: "--convert-graft-file"', async () => {
    const dir = repository("graft-file");
    shell.ok(dir, "checkout", "-q", "-b", "with-graft-file");
    shell.commit(dir, "root0");
    shell.commit(dir, "root2");
    shell.ok(dir, "reset", "-q", "--hard", "root2^");
    shell.commit(dir, "root1");
    shell.commit(dir, "after-root1");
    shell.tick();
    shell.ok(dir, "merge", "-q", "-m", "merge-root2", "root2");
    const [a, b, c, d] = ["HEAD^^", "HEAD^", "HEAD^^", "HEAD^2"].map((r) =>
      rev(dir, "rev-parse", r),
    );
    writeFileSync(join(dir, ".git/info/grafts"), `${a}\n${b} ${c}\n\n# comment\n${d}\n`);
    const t = twins(dir);
    await step(t, ["--convert-graft-file"]);
    expect(rev(t.ours, "rev-list", "--count", "HEAD")).toBe(
      rev(t.native, "rev-list", "--count", "HEAD"),
    );
    await step(t, ["--convert-graft-file"]);
    await step(t, ["--convert-graft-file", "x"]);

    // an invalid graft file is not deleted
    const emptyBlob = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";
    const emptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
    for (const to of [t.native, t.ours]) {
      writeFileSync(join(to, ".git/info/grafts"), `${b} ${a}\n${emptyBlob} ${emptyTree}\n${a}\n`);
    }
    await step(t, ["--convert-graft-file"]);
    await step(t, ["-f", "--convert-graft-file"]);
    // --graft while the grafts file is there: git's advice on its first commit parse, and
    // (2.5x) the missing object the file names as a commit
    await step(t, ["-g", b]);
    await step(t, ["-g", b, emptyBlob]);
    await step(t, ["-g", a, b]);
  });

  it('t6050-replace.sh: "--convert-graft-file" (git replace parsing commits while info/grafts exists)', async () => {
    // statewalker/webrun-vcs#364: the first commit a revision parses loads the grafts file and
    // prints its advice, outside --graft too; `~` follows the grafted parents
    const t = twins(fixture);
    for (const dir of [t.native, t.ours]) {
      writeFileSync(join(dir, ".git/info/grafts"), `${H[6]} ${H[3]}\n`);
    }
    await step(t, ["-d", H[2] as string]);
    await step(t, ["HEAD~1", "HEAD"]);
    await step(t, ["-d", "HEAD~1"]);
    await step(t, ["HEAD~2", "HEAD"]);
    await step(t, ["-d", "HEAD~2"]);
    await step(t, ["--edit", "HEAD~1"], "true");
    await step(t, ["HEAD^{tree}", "HEAD~1^{tree}"]);
    await step(t, ["-d", "HEAD^{tree}"]);
  });
});
