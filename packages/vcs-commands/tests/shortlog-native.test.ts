/**
 * `git shortlog` against native git, its scenarios taken from git's t4201-shortlog.sh: the
 * default output, user formats (`--format`, `--date`, `--abbrev`), wrapping (`-w`) of
 * UTF-8 and broken non-UTF-8 subjects, reading `git log` output (medium, raw, full) as git
 * reads its stdin, encodings, revision pseudo options, `-c`/`--group=committer`, trailer and
 * format groups with their de-duplication, `--no-group`, and the errors. Run with the
 * system git (2.43) and with 2.56.1 first on `PATH`.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { nativeGitAvailable } from "./native-git-http-backend.js";
import { Fixture, native, type Outcome, oursShortlog } from "./shortlog-native-support.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root = "";
let repo: Fixture;

async function same(args: string[], stdin?: string): Promise<{ native: Outcome; ours: Outcome }> {
  const n = native(root, repo.dir, "shortlog", args, stdin ?? "");
  const o = await oursShortlog(repo.dir, args, stdin);
  return { native: n, ours: o };
}

async function expectSame(args: string[], stdin?: string): Promise<Outcome> {
  const { native: n, ours: o } = await same(args, stdin);
  expect(o).toEqual(n);
  return n;
}

const LONG =
  "This is a very, very long first line for the commit message to see if it is wrapped correctly";

describeGit("git shortlog, native (t4201-shortlog)", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "shortlog-native-"));
    const dir = join(root, "repo");
    mkdirSync(dir);
    repo = new Fixture(root, dir);
    // t4201-shortlog.sh: "setup"
    repo.git(["init", "-q", "-b", "main"]);
    repo.put("a1", "1\n");
    repo.git(["add", "a1"]);
    const tree = repo.git(["write-tree"]).trim();
    const commit = repo.git(["commit-tree", tree], {}, "Test\n\n").trim();
    repo.git(["update-ref", "HEAD", commit]);
    repo.put("a1", "2\n");
    repo.git(["commit", "--quiet", "-m", LONG, "a1"]);
    repo.put("a1", "3\n");
    repo.git(["commit", "--quiet", "-m", LONG.replaceAll("i", "\u{1D11E}"), "a1"]);
    repo.git(["config", "i18n.commitencoding", "non-utf-8"]);
    repo.put("a1", "4\n");
    const broken = Buffer.concat(
      LONG.split("i").flatMap((part, k) =>
        k === 0 ? [Buffer.from(part)] : [Buffer.from([0xf8, 0x9d, 0x84, 0x9e]), Buffer.from(part)],
      ),
    );
    repo.put("msg", broken);
    repo.git(["commit", "--quiet", "-F", "msg", "a1"]);
    repo.put("a1", "5\n");
    repo.git(["commit", "--quiet", "-m", "a\t\t\t\t\t\t\t\t12\t34\t56\t78", "a1"]);
    repo.put("a1", "6\n");
    repo.git([
      "commit",
      "--quiet",
      "-m",
      "Commit by someone else",
      "--author=Someone else <not!me>",
      "a1",
    ]);
    repo.git(["config", "--unset", "i18n.commitencoding"]);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('t4201-shortlog.sh: "default output format"', async () => {
    await expectSame(["HEAD"]);
  });

  it('t4201-shortlog.sh: "pretty format"', async () => {
    await expectSame(["--format=%H", "HEAD"]);
  });

  it('t4201-shortlog.sh: "pretty format (with --date)"', async () => {
    await expectSame(["--format=%ad %H", "--date=short", "HEAD"]);
  });

  it('t4201-shortlog.sh: "--abbrev"', async () => {
    await expectSame(["--format=%h", "--abbrev=35", "HEAD"]);
  });

  it('t4201-shortlog.sh: "output from user-defined format is re-wrapped"', async () => {
    await expectSame(["--format=two%nlines", "HEAD"]);
  });

  it('t4201-shortlog.sh: "shortlog wrapping"', async () => {
    const n = await expectSame(["-w", "HEAD"]);
    expect(n.out).toContain("         it is wrapped correctly");
    await expectSame(["-w60,2,4", "HEAD"]);
    await expectSame(["-w0,3", "HEAD"]);
  });

  it('t4201-shortlog.sh: "shortlog from non-git directory"', async () => {
    const log = repo.git(["log", "--no-expand-tabs", "HEAD"]);
    await expectSame(["-w"], log);
  });

  it('t4201-shortlog.sh: "shortlog can read --format=raw output"', async () => {
    const log = repo.git(["log", "--format=raw", "HEAD"]);
    await expectSame(["-w"], log);
  });

  it('t4201-shortlog.sh: "shortlog should add newline when input line matches wraplen"', async () => {
    const input = [
      "commit 0000000000000000000000000000000000000001",
      "Author: A U Thor <author@example.com>",
      "Date:   Thu Apr 7 15:14:13 2005 -0700",
      "",
      "    aaaaaaaaaaaaaaaaaaaaaa: aaaaaa aaaaaaaaaa aaaa aaaaaaaa aa aaaa aa aaa",
      "",
      "commit 0000000000000000000000000000000000000002",
      "Author: A U Thor <author@example.com>",
      "Date:   Thu Apr 7 15:14:13 2005 -0700",
      "",
      "    bbbbbbbbbbbbbbbbbb: bbbbbbbb bbb bbbb bbbbbbb bb bbbb bbb bbbbb bbbbbb",
      "",
    ].join("\n");
    const n = await expectSame(["-w"], input);
    expect(n.out).toContain(
      "aaaaaaaaaaaaaaaaaaaaaa: aaaaaa aaaaaaaaaa aaaa aaaaaaaa aa aaaa aa aaa\n",
    );
  });

  it('t4201-shortlog.sh: "shortlog with revision pseudo options"', async () => {
    await expectSame(["--all"]);
    await expectSame(["--branches"]);
    await expectSame(["--exclude=refs/heads/m*", "--all"]);
  });

  it("bad -w arguments and groups are refused", async () => {
    // t4201-shortlog.sh: "shortlog bogus --group"
    await expectSame(["--group=bogus", "HEAD"]);
    await expectSame(["-w10,20", "HEAD"]);
    await expectSame(["-wx", "HEAD"]);
  });

  describe("encodings and groups", () => {
    beforeAll(() => {
      // t4201-shortlog.sh: "shortlog encoding"
      repo.git(["checkout", "-q", "-b", "enc", "HEAD~5"]);
      repo.put("a1", "2\n");
      repo.git([
        "commit",
        "--quiet",
        "-m",
        "set a1 to 2 and some non-ASCII chars: Äßø",
        '--author=Jöhännës "Dschö" Schindëlin <Johannes.Schindelin@gmx.de>',
        "a1",
      ]);
      // the second commit in ISO8859-1, its author too (git commit with iconv'ed arguments)
      repo.put("a1", "3\n");
      repo.git(["add", "a1"]);
      const tree = repo.git(["write-tree"]).trim();
      const parent = repo.git(["rev-parse", "HEAD"]).trim();
      const raw = Buffer.concat([
        Buffer.from(`tree ${tree}\nparent ${parent}\nauthor `),
        Buffer.from('Jöhännës "Dschö" Schindëlin <Johannes.Schindelin@gmx.de>', "latin1"),
        Buffer.from(
          " 1112912053 -0700\ncommitter C O Mitter <committer@example.com> 1112912053 -0700\nencoding ISO8859-1\n\n",
        ),
        Buffer.from("set a1 to 3 and some non-ASCII chars: áæï\n", "latin1"),
      ]);
      const id = repo.git(["hash-object", "-t", "commit", "-w", "--stdin"], {}, raw).trim();
      repo.git(["update-ref", "HEAD", id]);
    });

    it('t4201-shortlog.sh: "shortlog encoding"', async () => {
      await expectSame(["HEAD~2.."]);
    });

    it('t4201-shortlog.sh: "shortlog --committer (internal)", "shortlog --committer (external)", "--group=committer is the same as --committer"', async () => {
      repo.git(["checkout", "-q", "--orphan", "side"]);
      repo.git(["commit", "-q", "--allow-empty", "-m", "one"]);
      repo.git(["commit", "-q", "--allow-empty", "-m", "two"]);
      repo.git(["commit", "-q", "--allow-empty", "-m", "three"], {
        GIT_COMMITTER_NAME: "Sin Nombre",
      });
      await expectSame(["-nsc", "HEAD"]);
      await expectSame(["-nsc"], repo.git(["log", "--format=full"]));
      await expectSame(["-ns", "--group=committer", "HEAD"]);
    });

    it('t4201-shortlog.sh: "shortlog --group=trailer:signed-off-by", "trailer idents are split", "trailer idents are mailmapped"', async () => {
      repo.git(["commit", "-q", "--allow-empty", "-m", "foo", "-s"]);
      repo.git(["commit", "-q", "--allow-empty", "-m", "foo", "-s"], {
        GIT_COMMITTER_NAME: "SOB One",
        GIT_COMMITTER_EMAIL: "sob@example.com",
      });
      repo.git(["commit", "-q", "--allow-empty", "--amend", "--no-edit", "-s"]);
      await expectSame(["-nse", "--group=trailer:signed-off-by", "HEAD"]);
      await expectSame(["-ns", "--group=trailer:signed-off-by", "HEAD"]);
      repo.put("mail.map", "Another Name <sob@example.com>\n");
      repo.git(["config", "mailmap.file", "mail.map"]);
      await expectSame(["-ns", "--group=trailer:signed-off-by", "HEAD"]);
      repo.git(["config", "--unset", "mailmap.file"]);
    });

    it('t4201-shortlog.sh: "shortlog --group=format", "shortlog --group=<format> DWIM"', async () => {
      await expectSame(["-s", "--date=format:%Y", "--group=format:%cN (%cd)", "HEAD"]);
      await expectSame(["-s", "--date=format:%Y", "--group=%cN (%cd)", "HEAD"]);
    });

    it('t4201-shortlog.sh: "shortlog de-duplicates trailers in a single commit"', async () => {
      repo.git(
        ["commit", "-q", "--allow-empty", "-F", "-"],
        {},
        "subject one\n\nthis message has two distinct values, plus a repeat\n\nRepeated-trailer: Foo\nRepeated-trailer: Bar\nRepeated-trailer: Foo\n",
      );
      repo.git(
        ["commit", "-q", "--allow-empty", "-F", "-"],
        {},
        "subject two\n\nsimilar to the previous, but without the second distinct value\n\nRepeated-trailer: Foo\nRepeated-trailer: Foo\n",
      );
      await expectSame(["-ns", "--group=trailer:repeated-trailer", "-2", "HEAD"]);
    });

    it('t4201-shortlog.sh: "shortlog de-duplicates trailers in a single commit (folded/unfolded values)"', async () => {
      repo.git(
        ["commit", "-q", "--allow-empty", "-F", "-"],
        {},
        "subject one\n\nthis message has two distinct values, plus a repeat (folded)\n\nRepeated-trailer: Foo foo foo\nRepeated-trailer: Bar\nRepeated-trailer: Foo\n  foo foo\n",
      );
      repo.git(
        ["commit", "-q", "--allow-empty", "-F", "-"],
        {},
        "subject two\n\nsimilar to the previous, but without the second distinct value\n\nRepeated-trailer: Foo foo foo\nRepeated-trailer: Foo\n  foo foo\n",
      );
      await expectSame(["-ns", "--group=trailer:repeated-trailer", "-2", "HEAD"]);
    });

    it('t4201-shortlog.sh: "shortlog can match multiple groups"', async () => {
      repo.git(
        ["commit", "-q", "--allow-empty", "-F", "-"],
        {},
        "subject one\n\nthis has two trailers that are distinct from the author; it will count\n3 times in the output\n\nSome-trailer: User A <a@example.com>\nAnother-trailer: User B <b@example.com>\n",
      );
      repo.git(
        ["commit", "-q", "--allow-empty", "-F", "-"],
        {},
        "subject two\n\nthis one has two trailers, one of which is a duplicate with the author;\nit will only be counted once for them\n\nAnother-trailer: A U Thor <author@example.com>\nSome-trailer: User B <b@example.com>\n",
      );
      await expectSame([
        "-ns",
        "--group=author",
        "--group=trailer:some-trailer",
        "--group=trailer:another-trailer",
        "-2",
        "HEAD",
      ]);
      await expectSame(["--group=author", "--group=trailer:some-trailer", "-e", "-2", "HEAD"]);
    });

    it('t4201-shortlog.sh: "shortlog can match multiple format groups"', async () => {
      repo.git(["commit", "-q", "--allow-empty", "-m", "identical names"], {
        GIT_COMMITTER_NAME: "A U Thor",
      });
      await expectSame(["-ns", "--group=%cn", "--group=%an", "-2", "HEAD"]);
    });

    it('t4201-shortlog.sh: "--no-group resets group list to author", "--no-group resets trailer list"', async () => {
      // t4201-shortlog.sh: "set up option selection tests"
      repo.git(
        ["commit", "-q", "--allow-empty", "-F", "-"],
        {},
        "subject\n\nbody\n\nTrailer-one: value-one\nTrailer-two: value-two\n",
      );
      await expectSame([
        "-ns",
        "--group=committer",
        "--group=trailer:trailer-one",
        "--no-group",
        "-1",
        "HEAD",
      ]);
      await expectSame([
        "-ns",
        "--group=trailer:trailer-one",
        "--no-group",
        "--group=trailer:trailer-two",
        "-1",
        "HEAD",
      ]);
    });

    it('t4201-shortlog.sh: "stdin with multiple groups reports error"', async () => {
      const log = repo.git(["log"]);
      await expectSame(["--group=author", "--group=committer"], log);
      await expectSame(["--group=trailer:signed-off-by"], log);
      await expectSame(["--group=format:%an"], log);
    });
  });
});
