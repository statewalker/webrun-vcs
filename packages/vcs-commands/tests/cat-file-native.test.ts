/**
 * `git cat-file` (builtin/cat-file.c), native twins: t1006-cat-file's scenarios, each run by
 * native git and by ours on the same repository (stdout bytes, stderr and exit status
 * compared), plus a check that `--batch` streams a large blob.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Git } from "../src/index.js";
import { catFileTwin } from "./cat-file-native-support.js";
import { compatibilityOf, Shell } from "./describe-native-support.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root: string;
let shell: Shell;
let repo: string;
const ids: Record<string, string> = {};

async function check(
  argv: string[],
  input?: string | Uint8Array,
  dir = repo,
  open?: () => Promise<Git>,
): Promise<void> {
  const twin = await catFileTwin(shell, dir, argv, input, open);
  expect({ ...twin.ours, stdout: twin.ours.stdout.toString("latin1") }).toEqual({
    ...twin.native,
    stdout: twin.native.stdout.toString("latin1"),
  });
}

/** t/test-lib's test_write_lines */
const lines = (...l: string[]) => l.map((x) => `${x}\n`).join("");

describeGit("git cat-file, native twins", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "cat-file-native-"));
    shell = new Shell(root);
    repo = join(root, "repo");
    shell.ok(root, "init", "-q", "-b", "main", repo);
    // t1006 "setup part 2"
    writeFileSync(join(repo, "hello"), "Hello World");
    shell.ok(repo, "update-index", "--add", "hello");
    writeFileSync(join(repo, "path with spaces"), "Hello World");
    shell.ok(repo, "update-index", "--add", "--chmod=+x", "path with spaces");
    shell.tick();
    shell.ok(repo, "commit", "-q", "-m", "add hello file");
    ids.hello = shell.ok(repo, "rev-parse", "HEAD:hello").trim();
    ids.tree = shell.ok(repo, "write-tree").trim();
    ids.commit = shell
      .git(repo, ["commit-tree", ids.tree], { input: "Initial commit" })
      .stdout.trim();
    const tag = `object ${ids.hello}\ntype blob\ntag hellotag\ntagger Interop Tester <interop@example.com> 0 +0000\n\nThis is a tag`;
    ids.tag = shell
      .git(repo, ["hash-object", "-t", "tag", "--stdin", "-w"], { input: tag })
      .stdout.trim();
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const objects = () => [
    ["blob", ids.hello],
    ["tree", ids.tree],
    ["blob", `${ids.tree}:hello`],
    ["blob", `${ids.tree}:path with spaces`],
    ["commit", ids.commit],
    ["tag", ids.tag],
  ];

  it('t1006-cat-file.sh: "Type of $type is correct", "Size of $type is correct", "$type exists"', async () => {
    for (const [, name] of objects()) {
      await check(["-e", name as string]);
      await check(["-t", name as string]);
      await check(["-s", name as string]);
    }
  });

  it('t1006-cat-file.sh: "Content of $type is correct", "Pretty content of $type is correct"', async () => {
    for (const [type, name] of objects()) {
      await check([type as string, name as string]);
      await check(["-p", name as string]);
    }
  });

  it('t1006-cat-file.sh: "--batch output of $type is correct", "--batch-check output of $type is correct"', async () => {
    for (const [, name] of objects()) {
      await check(["--batch"], `${name}\n`);
      await check(["--batch-check"], name);
    }
  });

  it('t1006-cat-file.sh: "--batch-command $opt output of $type content is correct", "--batch-command $opt output of $type info is correct"', async () => {
    for (const [, name] of objects()) {
      for (const opt of ["--buffer", "--no-buffer"]) {
        await check(["--batch-command", opt], lines(`contents ${name}`));
        await check(["--batch-command", opt], lines(`info ${name}`));
      }
    }
  });

  // the %(rest) case of that script is declared through $test_rest, so it has no title to cite
  it('t1006-cat-file.sh: "custom --batch-check format", "custom --batch-command format"', async () => {
    for (const [, name] of objects()) {
      await check(["--batch-check=%(objecttype) %(objectname)"], lines(name as string));
      await check(["--batch-command=%(objecttype) %(objectname)"], lines(`info ${name}`));
      await check(
        ["--batch-check=%(objecttype) %(rest)"],
        lines(`${name}    this is some extra content`),
      );
    }
  });

  it('t1006-cat-file.sh: "--batch-check with %(objectmode)" (an unknown atom in 2.43)', async () => {
    for (const [, name] of objects()) {
      await check(["--batch-check=%(objectmode) %(objectname)"], lines(name as string));
    }
  });

  it('t1006-cat-file.sh: "--batch without type ($type)", "--batch without size ($type)"', async () => {
    for (const [, name] of objects()) {
      await check(["--batch=%(objectsize)"], lines(name as string));
      await check(["--batch=%(objecttype)"], lines(name as string));
    }
  });

  it('t1006-cat-file.sh: "--batch-command --buffer with flush for blob info"', async () => {
    await check(["--batch-command", "--buffer"], lines(`info ${ids.hello}`, "flush"));
  });

  it('t1006-cat-file.sh: "--batch-check without %(rest) considers whole line"', async () => {
    shell.ok(repo, "update-index", "--add", "--cacheinfo", `100644,${ids.hello},white space`);
    try {
      await check(["--batch-check"], lines(":white space"));
    } finally {
      shell.ok(repo, "update-index", "--remove", "white space");
    }
  });

  it('t1006-cat-file.sh: "Reach a blob from a tag pointing to it"', async () => {
    await check(["blob", ids.tag as string]);
  });

  it('t1006-cat-file.sh: "--batch-check for a non-existent named object", "--batch-check for a non-existent hash", "--batch-check for an empty line", "empty --batch-check notices missing object"', async () => {
    await check(["--batch-check"], "foobar42\nfoobar84");
    await check(
      ["--batch-check"],
      "0000000000000000000000000000000000000042\n0000000000000000000000000000000000000084",
    );
    await check(["--batch"], `${ids.tag}\n0000000000000000000000000000000000000000`);
    await check(["--batch-check"], "\n");
    await check(["--batch-check="], lines("0".repeat(40)));
  });

  it('t1006-cat-file.sh: "--batch with multiple oids gives correct format", "--batch, -z with multiple oids gives correct format", "--batch, -Z with multiple oids gives correct format"', async () => {
    const input = [ids.hello, ids.commit, ids.tag, "deadbeef", "", ""].join("\n");
    await check(["--batch"], input);
    const nul = `${[ids.hello, ids.commit, ids.tag, "deadbeef", ""].join("\0")}\0`;
    await check(["--batch", "-z"], nul);
    await check(["--batch", "-Z"], nul);
  });

  it('t1006-cat-file.sh: "--batch-check with multiple oids gives correct format", "--batch-check, -z with multiple oids gives correct format", "--batch-check, -Z with multiple oids gives correct format"', async () => {
    const list = [ids.hello, ids.tree, ids.commit, ids.tag, "deadbeef", ""];
    await check(["--batch-check"], `${list.join("\n")}\n`);
    await check(["--batch-check", "-z"], `${list.join("\0")}\0`);
    await check(["--batch-check", "-Z"], `${list.join("\0")}\0`);
  });

  it('t1006-cat-file.sh: "--batch-command with multiple info calls gives correct format", "--batch-command with multiple command calls gives correct format"', async () => {
    const info = [ids.hello, ids.tree, ids.commit, ids.tag, "deadbeef"].map((i) => `info ${i}`);
    await check(["--batch-command", "--buffer"], lines(...info));
    await check(["--batch-command", "--buffer", "-z"], `${info.join("\0")}\0`);
    await check(["--batch-command", "--buffer", "-Z"], `${info.join("\0")}\0`);
    const contents = [
      ...[ids.hello, ids.commit, ids.tag, "deadbeef"].map((i) => `contents ${i}`),
      "flush",
    ];
    await check(["--batch-command", "--buffer"], lines(...contents));
    await check(["--batch-command", "--buffer", "-Z"], `${contents.join("\0")}\0`);
  });

  it('t1006-cat-file.sh: "object reference with curly brace", "object reference with at-sign", "object reference via commit text search"', async () => {
    shell.ok(repo, "branch", "foo{bar", "HEAD");
    shell.ok(repo, "branch", "foo@", "HEAD");
    shell.tick();
    const other = shell.ok(
      repo,
      "commit-tree",
      "-m",
      "testing: just a bunch of junk",
      "HEAD^{tree}",
    );
    shell.ok(repo, "branch", "other", other.trim());
    // 2.43 counts every "{" as a bracket and reads "foo{bar:hello" as a ref name; the
    // revision resolver follows 2.5x (only "@{" and "^{" open one)
    if (compatibilityOf(shell) !== "2.43") await check(["-p", "foo{bar:hello"]);
    await check(["-p", "foo@@{0}:hello"]);
    await check(["-p", "other^{/testing:}:hello"]);
    await check(["--batch-check"], lines("other^{/testing:}:hello", ":/testing"));
  });

  it('t1006-cat-file.sh: "cat-file $arg1 error on missing short OID", "cat-file $arg1 error on missing full OID"', async () => {
    for (const arg of ["-s", "-t", "-p"]) {
      await check([arg, "deadbeef"]);
      await check([arg, "deadbeef".repeat(5)]);
    }
    await check(["-e", "deadbeef".repeat(5)]);
    await check(["-e", "deadbeef"]);
  });

  it("scenario from t1006: <type> <object> peels, refuses and dies as git", async () => {
    await check(["tree", "HEAD"]);
    await check(["commit", "HEAD"]);
    await check(["blob", "HEAD"]);
    await check(["tag", "HEAD"]);
    await check(["bogus", "HEAD"]);
    await check(["-t", "HEAD:nope"]);
    await check(["-p", "HEAD:nope"]);
    await check(["-p", "HEAD:"]);
    await check(["--batch-check=%(objectmode) %(objectname)"], lines("HEAD:", "HEAD:hello"));
  });

  it('t1006-cat-file.sh: "batch-command empty command", "batch-command whitespace before command", "batch-command unknown command", "batch-command missing arguments", "batch-command flush with arguments", "batch-command flush without --buffer", "batch-command contents auto-handles type"', async () => {
    await check(["--batch-command"], "\n");
    await check(["--batch-command"], " info deadbeef\n");
    await check(["--batch-command"], "unknown_command\n");
    await check(["--batch-command"], "info\n");
    await check(["--batch-command", "--buffer"], "flush arg\n");
    await check(["--batch-command"], "flush\n");
    // 2.43 aborts here (an assertion in print_object_or_die), fixed since
    if (compatibilityOf(shell) !== "2.43") {
      await check(["--batch-command=%(objectname)"], "contents HEAD\n");
    }
    // queued commands die unprinted with a later bad one
    await check(["--batch-command", "--buffer"], lines("info HEAD", "bogus"));
    await check(["--batch-command"], lines("info HEAD", "bogus"));
    await check(["--batch-command"], lines("mailmap true", `contents ${ids.commit}`));
  });

  it("scenario from t1006: unknown and unterminated format atoms", async () => {
    await check(["--batch-check=%(objectname) %(bogus)"], lines("HEAD"));
    await check(["--batch-check=%(objectname"], lines("HEAD"));
    await check(["--batch-check=100%% %x %(objectname)"], lines("HEAD"));
  });

  it("scenario from t1006: an ambiguous short id", async () => {
    const dir = join(root, "ambiguous");
    shell.ok(root, "init", "-q", "-b", "main", dir);
    // blobs until two share a 4-digit prefix
    const seen = new Map<string, string>();
    let prefix: string | undefined;
    for (let i = 0; !prefix; i++) {
      const id = shell.git(dir, ["hash-object", "-w", "--stdin"], { input: `x${i}\n` }).stdout;
      const p = id.slice(0, 4);
      if (seen.has(p)) prefix = p;
      seen.set(p, id);
    }
    await check(["--batch-check"], lines(prefix), dir);
    await check(["-t", prefix], undefined, dir);
  });

  it('t1006-cat-file.sh: “cat-file --batch-all-objects shows all objects”, “cat-file --unordered works”, “cat-file --batch="%(objectname)" with --batch-all-objects will work”, “cat-file --batch="%(rest)" with --batch-all-objects will work”, “cat-file --batch="batman" with --batch-all-objects will work”', async () => {
    const one = join(root, "all-one");
    shell.ok(root, "init", "-q", "-b", "main", one);
    writeFileSync(join(one, "file"), "content\n");
    shell.ok(one, "add", "file");
    shell.tick();
    shell.ok(one, "commit", "-qm", "base");
    shell.ok(one, "repack", "-adq");
    shell.git(one, ["hash-object", "-w", "--stdin"], { input: "not-cloned\n" });
    const two = join(root, "all-two");
    shell.ok(root, "clone", "-q", "-s", one, two);
    shell.git(two, ["hash-object", "-w", "--stdin"], { input: "local-unref\n" });
    shell.git(two, ["pack-objects", "-q", ".git/objects/pack/pack"], {
      input: shell.ok(two, "rev-parse", "HEAD:file"),
    });
    // the alternate lies outside all-two: root our FilesApi above both
    const open = () => openOurs(root, undefined, undefined, "all-two");
    for (const argv of [
      ["--batch-check=%(objectname)"],
      ["--batch-check"],
      ["--batch"],
      ["--batch=%(rest)"],
      ["--batch=batman"],
    ]) {
      await check(["--batch-all-objects", ...argv], undefined, two, open);
    }
    const sorted = async (argv: string[]) => {
      const twin = await catFileTwin(shell, two, argv, undefined, open);
      const sort = (b: Buffer) => b.toString().split("\n").sort().join("\n");
      expect(sort(twin.ours.stdout)).toEqual(sort(twin.native.stdout));
    };
    await sorted(["--batch-all-objects", "--unordered", "--batch-check=%(objectname)"]);
  });

  it('t1006-cat-file.sh: "cat-file --batch respects replace objects", "cat-file --batch-check respects replace objects", "cat-file --batch-all-objects --batch-check ignores replace"', async () => {
    const dir = join(root, "replace");
    shell.ok(root, "clone", "-q", repo, dir);
    const orig = shell.ok(dir, "rev-parse", "HEAD").trim();
    const fake = shell
      .git(dir, ["hash-object", "-t", "commit", "-w", "--stdin"], {
        input: `${shell.ok(dir, "cat-file", "commit", orig)}extra\n`,
      })
      .stdout.trim();
    shell.ok(dir, "replace", orig, fake);
    await check(["--batch"], lines(orig), dir);
    await check(["--batch-check"], lines(orig), dir);
    await check(["-s", orig], undefined, dir);
    await check(["-p", orig], undefined, dir);
    await check(["--batch-all-objects", "--batch-check"], undefined, dir);
  });

  it('t1006-cat-file.sh: "batch-check with a submodule", "batch-check with a submodule, object exists"', async () => {
    const missing = shell
      .git(repo, ["mktree"], { input: `160000 commit ${"deadbeef".repeat(5)}\tsub\n` })
      .stdout.trim();
    const present = shell
      .git(repo, ["mktree"], { input: `160000 commit ${ids.commit}\tsub\n` })
      .stdout.trim();
    await check(["--batch-check"], lines(`${missing}:sub`, `${present}:sub`));
    await check(["-p", missing]);
  });

  it("scenario from t1006: --use-mailmap rewrites commit and tag idents", async () => {
    const dir = join(root, "mailmap");
    shell.ok(root, "clone", "-q", repo, dir);
    writeFileSync(
      join(dir, ".mailmap"),
      "Mapped Name <mapped@example.com> <interop@example.com>\n",
    );
    const tag = ids.tag as string;
    for (const name of ["HEAD", tag]) {
      await check(["--use-mailmap", "-p", name], undefined, dir);
      await check(["--use-mailmap", "-s", name], undefined, dir);
      await check(["--use-mailmap", "commit", "HEAD"], undefined, dir);
    }
    await check(["--use-mailmap", "--batch"], lines("HEAD", tag, "HEAD:hello"), dir);
    await check(["--use-mailmap", "--batch-check"], lines("HEAD", tag), dir);
  });

  it("scenario from t1006: a quoted path in a pretty-printed tree", async () => {
    const tree = shell
      .git(repo, ["mktree"], {
        input: `100644 blob ${ids.hello}\ttab\there\n100644 blob ${ids.hello}\tcafé\n`,
      })
      .stdout.trim();
    await check(["-p", tree]);
  });

  it("scenario from t1006: a SHA-256 repository", async () => {
    const dir = join(root, "sha256");
    shell.ok(root, "init", "-q", "--object-format=sha256", "-b", "main", dir);
    writeFileSync(join(dir, "a"), "a\n");
    shell.ok(dir, "add", "a");
    shell.tick();
    shell.ok(dir, "commit", "-qm", "a");
    await check(["--batch"], lines("HEAD", "HEAD:a", "HEAD^{tree}", "nope"), dir);
    await check(["-p", "HEAD^{tree}"], undefined, dir);
    await check(["-t", "HEAD"], undefined, dir);
  });
});

describeGit("git cat-file --batch streams", () => {
  it("writes a large blob in many chunks, none of its size, reading input as it comes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cat-file-stream-"));
    try {
      const sh = new Shell(dir);
      sh.ok(dir, "init", "-q", "-b", "main", ".");
      const size = 8 * 1024 * 1024;
      const big = Buffer.alloc(size);
      for (let i = 0; i < size; i++) big[i] = (i * 2654435761) >>> 24;
      writeFileSync(join(dir, "big"), big);
      const id = sh.ok(dir, "hash-object", "-w", "big").trim();
      const git = await openOurs(dir);
      const chunks: number[] = [];
      let received = 0;
      let firstAnswerBeforeSecondLine = false;
      let fedSecond = false;
      async function* input() {
        yield new TextEncoder().encode(`${id}\n`);
        // the first object's answer is written before more input is read
        await new Promise((r) => setTimeout(r, 0));
        firstAnswerBeforeSecondLine = received > size;
        fedSecond = true;
        yield new TextEncoder().encode("nope\n");
      }
      const result = await git
        .catFile()
        .setBatch("contents")
        .setStdin(input())
        .setStdout((chunk) => {
          if (!fedSecond) received += chunk.length;
          chunks.push(chunk.length);
        })
        .call();
      expect(result.exitCode).toBe(0);
      expect(chunks.reduce((a, b) => a + b, 0)).toBe(
        `${id} blob ${size}\n`.length + size + 1 + "nope missing\n".length,
      );
      expect(chunks.length).toBeGreaterThan(2);
      expect(Math.max(...chunks)).toBeLessThan(size);
      expect(firstAnswerBeforeSecondLine).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describeGit("git cat-file, bytes and odd trees", () => {
  let dir: string;
  let odd: string;
  let blob: string;

  /** Both sides compared; a usage error (129) by its first stderr line. */
  async function checkHere(argv: string[], input?: string | Uint8Array): Promise<void> {
    const twin = await catFileTwin(shell, dir, argv, input);
    if (twin.native.status === 129) {
      expect(twin.ours.status).toBe(129);
      expect(twin.ours.stderr.split("\n")[0]).toBe(twin.native.stderr.split("\n")[0]);
      return;
    }
    expect({ ...twin.ours, stdout: twin.ours.stdout.toString("latin1") }).toEqual({
      ...twin.native,
      stdout: twin.native.stdout.toString("latin1"),
    });
  }

  let base: string;
  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), "cat-file-bytes-"));
    shell = new Shell(base);
    dir = join(base, "bytes");
    shell.ok(base, "init", "-q", "-b", "main", dir);
    // a tracked name that is not UTF-8 (x\xff.txt)
    writeFileSync(
      Buffer.concat([Buffer.from(`${dir}/x`), Buffer.from([0xff]), Buffer.from(".txt")]),
      "x\n",
    );
    writeFileSync(join(dir, "ok"), "ok\n");
    shell.ok(dir, "add", "-A");
    shell.tick();
    shell.ok(dir, "commit", "-qm", "bytes");
    blob = shell.ok(dir, "rev-parse", "HEAD:ok").trim();
    // a tree git's fsck refuses but its readers list: an entry named ".."
    const raw = Buffer.from(blob, "hex");
    const tree = Buffer.concat([Buffer.from("100644 ..\0"), raw, Buffer.from("100644 ok\0"), raw]);
    odd = shell
      .git(dir, ["hash-object", "-t", "tree", "--literally", "--stdin", "-w"], { input: tree })
      .stdout.trim();
  });
  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("scenario from t1006: a path that is not UTF-8, -p of its tree and in --batch input", async () => {
    await checkHere(["-p", "HEAD^{tree}"]);
    await checkHere(["--batch-check"], Buffer.from("HEAD:x\xff.txt\n\xff\n", "latin1"));
    shell.ok(dir, "config", "core.quotePath", "false");
    try {
      await checkHere(["-p", "HEAD^{tree}"]);
    } finally {
      shell.ok(dir, "config", "--unset", "core.quotePath");
    }
  });

  it("scenario from t1006: a tree with an entry named '..'", async () => {
    await checkHere(["-p", odd]);
    await checkHere(["-t", odd]);
    await checkHere(["--batch-check"], lines(odd, `${odd}:ok`));
    await checkHere(["--batch"], lines(`${odd}:ok`));
  });

  it("scenario from t1006: -z keeps a CR that newline input strips", async () => {
    await checkHere(["--batch-check", "-z"], "HEAD\r\0HEAD\0");
    await checkHere(["--batch-check"], "HEAD\r\n");
  });

  it("scenario from t1006: usage errors", async () => {
    await checkHere(["--buffer", "HEAD"]);
    await checkHere(["--batch", "-t", "HEAD"], "");
    await checkHere(["-z", "HEAD"]);
    await checkHere(["--batch-all-objects"]);
    await checkHere(["-t"]);
  });
});

describeGit("git cat-file, corrupt trees (statewalker/webrun-vcs#351)", () => {
  let base: string;
  let dir: string;
  const trees: Record<string, string> = {};

  async function checkHere(argv: string[], input?: string | Uint8Array): Promise<void> {
    const twin = await catFileTwin(shell, dir, argv, input);
    expect({ ...twin.ours, stdout: twin.ours.stdout.toString("latin1") }).toEqual({
      ...twin.native,
      stdout: twin.native.stdout.toString("latin1"),
    });
  }

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), "cat-file-corrupt-"));
    shell = new Shell(base);
    dir = join(base, "corrupt");
    shell.ok(base, "init", "-q", "-b", "main", dir);
    writeFileSync(join(dir, "f"), "x\n");
    shell.ok(dir, "add", "f");
    shell.tick();
    shell.ok(dir, "commit", "-q", "-m", "m");
    const blob = shell.ok(dir, "rev-parse", "HEAD:f").trim();
    const tree = (...parts: (string | [string, string, string])[]): string =>
      shell
        .git(dir, ["hash-object", "-t", "tree", "--literally", "--stdin", "-w"], {
          input: Buffer.concat(
            parts.map((p) =>
              typeof p === "string"
                ? Buffer.from(p, "latin1")
                : Buffer.concat([Buffer.from(`${p[0]} ${p[1]}\0`), Buffer.from(p[2], "hex")]),
            ),
          ),
        })
        .stdout.trim();
    trees.short = tree("100644 f\0abc");
    trees.mode = tree(["10x644", "f", blob]);
    trees.empty = tree(["100644", "", blob]);
    trees.nested = tree(["100644", "a", blob], ["40000", "sub", trees.short]);
    trees.odd = tree(["100644", "..", blob], "100644 f\0abc");
    trees.third = tree(["100644", "a", blob], ["100644", "b", blob], ["10x644", "c", blob]);
  });
  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("scenario from t1006: -p of a corrupt tree dies as tree-walk.c's decode_tree_entry", async () => {
    await checkHere(["-p", trees.short as string]);
    await checkHere(["-p", trees.mode as string]);
    await checkHere(["-p", trees.empty as string]);
    await checkHere(["-t", trees.short as string]);
    await checkHere(["-s", trees.mode as string]);
    await checkHere(["-p", trees.third as string]);
  });

  it("scenario from t1006: a path through a corrupt tree dies (get_tree_entry)", async () => {
    await checkHere(["-p", `${trees.nested}:sub/f`]);
    await checkHere(["-p", `${trees.nested}:a`]);
    await checkHere(["-p", `${trees.odd}:..`]);
    await checkHere(["-e", `${trees.odd}:f`]);
    await checkHere(["-t", `${trees.third}:a`]);
    await checkHere(["-t", `${trees.third}:b`]);
    await checkHere(["-t", `${trees.third}:0`]);
  });

  it("scenario from t1006: --batch reads a corrupt tree raw, dies resolving a path through it", async () => {
    await checkHere(["--batch-check"], lines(trees.short as string, trees.mode as string));
    await checkHere(["--batch"], lines(trees.short as string));
    await checkHere(["--batch-check"], lines(`${trees.nested}:a`, `${trees.nested}:sub/f`, "HEAD"));
    await checkHere(["--batch-check"], lines(`${trees.odd}:ok`));
  });
});
