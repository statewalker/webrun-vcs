/**
 * `git archive` and `git get-tar-commit-id` against native git, scenarios from git's
 * t5000-tar-tree.sh, t5003-archive-zip.sh, t5001-archive-attr.sh and
 * t5004-archive-corner-cases.sh, and JGit's ArchiveCommandTest inputs. Tar archives and
 * stored (`-0`) zips are compared byte for byte; deflated zips and `tgz` with their
 * compressed streams inflated (git links the system zlib, ours pako). Run with the system
 * git (2.43) and with 2.5x first on `PATH`.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type ArchiveOutcome,
  archiveEnv,
  genrandom,
  nativeArchive,
  normalizeTgz,
  normalizeZip,
  oursArchive,
  tarCommitIdTwins,
} from "./archive-native-support.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

const SUBSTFORMAT = "%H (%h)%n";

let home = "";

function git(dir: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync("git", args, {
    cwd: dir,
    env: archiveEnv(home, env),
    encoding: "latin1",
  });
}

function put(dir: string, path: string, content: string | Buffer): void {
  const full = join(dir, path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

/** Both twins of `git archive <args>`; the outcomes compared as `compare` reads them. */
async function twins(
  dir: string,
  args: string[],
  options: { cwd?: string; compare?: (out: Buffer) => unknown } = {},
): Promise<ArchiveOutcome> {
  const n = nativeArchive(home, dir, args, options.cwd ? { cwd: options.cwd } : {});
  const o = await oursArchive(home, dir, args, options.cwd ? { cwd: options.cwd } : {});
  const view = (r: ArchiveOutcome, bytes: boolean) => ({
    status: r.status,
    err: r.err,
    out:
      r.status === 0 && options.compare
        ? options.compare(r.out)
        : !bytes && isTar(r.out)
          ? tarMembers(r.out)
          : r.out.toString("hex"),
  });
  expect(view(o, false)).toEqual(view(n, false));
  expect(view(o, true)).toEqual(view(n, true));
  return n;
}

const isTar = (out: Buffer) =>
  out.length >= 512 && out.subarray(257, 262).toString("latin1") === "ustar";

/** A tar archive's records as readable fields (a diff that says what differs). */
function tarMembers(tar: Buffer): unknown[] {
  const out: unknown[] = [];
  let at = 0;
  while (at + 512 <= tar.length) {
    const header = tar.subarray(at, at + 512);
    if (header.every((b) => b === 0)) {
      out.push({ zeros: at });
      at += 512;
      continue;
    }
    const field = (from: number, len: number) =>
      header
        .subarray(from, from + len)
        .toString("latin1")
        .replace(/\0+$/, "");
    const type = String.fromCharCode(header[156] as number);
    const size = Number.parseInt(field(124, 12) || "0", 8);
    const body = type === "0" || type === "x" || type === "g" ? Math.ceil(size / 512) * 512 : 0;
    out.push({
      at,
      name: field(0, 100),
      prefix: field(345, 155),
      mode: field(100, 8),
      size: field(124, 12),
      mtime: field(136, 12),
      chksum: field(148, 8),
      type,
      link: field(157, 100),
      rest: header.subarray(257, 345).toString("hex"),
      content: tar
        .subarray(at + 512, at + 512 + size)
        .toString("latin1")
        .slice(0, 200),
    });
    at += 512 + body;
  }
  out.push({ length: tar.length });
  return out;
}

/** A tar archive's member names (for readable assertions). */
function tarNames(tar: Buffer): string[] {
  const names: string[] = [];
  for (let at = 0; at + 512 <= tar.length; ) {
    const header = tar.subarray(at, at + 512);
    if (header.every((b) => b === 0)) break;
    const field = (from: number, len: number) => {
      const s = header.subarray(from, from + len);
      const nul = s.indexOf(0);
      return s.subarray(0, nul < 0 ? len : nul).toString("latin1");
    };
    const prefix = field(345, 155);
    const name = field(0, 100);
    names.push(prefix ? `${prefix}/${name}` : name);
    const size = Number.parseInt(field(124, 12) || "0", 8);
    const type = String.fromCharCode(header[156] as number);
    at += 512 + (type === "0" || type === "x" || type === "g" ? Math.ceil(size / 512) * 512 : 0);
  }
  return names;
}

describeGit("git archive, native (t5000-tar-tree, t5003-archive-zip)", () => {
  let root = "";
  let repo = "";
  let bare = "";

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "archive-native-"));
    home = root;
    repo = join(root, "repo");
    mkdirSync(repo);
    git(repo, ["init", "-q", "-b", "main"]);
    // t5000-tar-tree.sh: "populate workdir"
    put(repo, ".gitattributes", "a files_named_a\n");
    git(repo, ["add", ".gitattributes"]);
    put(repo, "a/a", "simple textfile\n");
    const hundred = "0123456789".repeat(10);
    put(repo, `a/four${hundred}`, "long filename\n");
    put(repo, "a/bin/sh", genrandom("frotz", 500000));
    put(repo, "a/substfile1", `A$Format:${SUBSTFORMAT}$O`);
    put(repo, "a/substfile2", "A not substituted O");
    symlinkSync("a", join(repo, "a/l1"));
    put(repo, `a/${"long_path_to_a_file/".repeat(5)}file_with_long_path`, "text\n");
    put(repo, "a/exec.sh", "#!/bin/sh\necho hi\n");
    execFileSync("chmod", ["+x", join(repo, "a/exec.sh")]);
    // t5000-tar-tree.sh: "add ignored file"
    put(repo, "a/ignored", "ignore me\n");
    put(repo, ".git/info/attributes", "ignored export-ignore\n");
    // t5000-tar-tree.sh: "add files to repository"
    git(repo, ["add", "a"]);
    git(repo, ["commit", "-q", "-m", "initial"], { GIT_COMMITTER_DATE: "2005-05-27 22:00" });
    // t5000-tar-tree.sh: "setup export-subst"
    put(repo, ".git/info/attributes", "ignored export-ignore\nsubstfile? export-subst\n");
    // t5000-tar-tree.sh: "create bare clone"
    bare = join(root, "bare.git");
    git(root, ["clone", "-q", "--template=", "--bare", repo, bare]);
    put(bare, "info/attributes", "ignored export-ignore\nsubstfile? export-subst\n");
    // t5000-tar-tree.sh: "remove ignored file"
    rmSync(join(repo, "a/ignored"));
    git(repo, ["tag", "-a", "-m", "v1", "v1"]);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('t5000-tar-tree.sh: "git archive", "git archive in a bare repo", "git archive vs. the same in a bare repo"', async () => {
    const n = await twins(repo, ["HEAD"]);
    expect(n.status).toBe(0);
    expect(tarNames(n.out)).toContain("pax_global_header");
    expect(tarNames(n.out)).not.toContain("a/ignored");
    const b = await twins(bare, ["HEAD"]);
    expect(b.out.equals(n.out)).toBe(true);
    // a tag names the commit; a tree carries no commit id (and the time of now)
    await twins(repo, ["v1"]);
    await twins(repo, ["--mtime=2002-02-02T02:02:02-0200", "HEAD^{tree}"]);
  });

  it("a tree's archive is dated now, without a commit id", async () => {
    const o = await oursArchive(home, repo, ["HEAD^{tree}"]);
    const mtime = Number.parseInt(o.out.subarray(136, 147).toString("latin1"), 8);
    expect(Math.abs(mtime - Date.now() / 1000)).toBeLessThan(60);
    expect(o.out[156]).not.toBe(0x67);
  });

  it('t5000-tar-tree.sh: "git archive --mtime"', async () => {
    await twins(repo, ["--mtime=2002-02-02T02:02:02-0200", "HEAD"]);
  });

  it('t5000-tar-tree.sh: "git archive --prefix=prefix/"', async () => {
    await twins(repo, ["--prefix=prefix/", "HEAD"]);
    await twins(repo, ["--prefix=pre//", "HEAD"]);
  });

  it('t5000-tar-tree.sh: "git-archive --prefix=olde-"', async () => {
    await twins(repo, ["--prefix=olde-", "HEAD"]);
  });

  it('t5000-tar-tree.sh: "git archive --add-file"', async () => {
    put(repo, "untracked", "untracked\n");
    await twins(repo, ["--add-file=untracked", "HEAD"]);
  });

  it('t5000-tar-tree.sh: "git archive --add-file twice"', async () => {
    put(repo, "untracked", "untracked\n");
    await twins(repo, [
      "--prefix=one/",
      "--add-file=untracked",
      "--prefix=two/",
      "--add-file=untracked",
      "--prefix=",
      "HEAD",
    ]);
  });

  it('t5000-tar-tree.sh: "git archive on large files"', async () => {
    git(repo, ["config", "core.bigfilethreshold", "1"]);
    try {
      await twins(repo, ["HEAD"]);
    } finally {
      git(repo, ["config", "--unset", "core.bigfilethreshold"]);
    }
  });

  it('t5000-tar-tree.sh: "git get-tar-commit-id"', async () => {
    const tar = nativeArchive(home, repo, ["HEAD"]).out;
    const { native, ours } = tarCommitIdTwins(home, tar);
    expect(ours).toEqual(native);
    expect(native.out).toBe(`${git(repo, ["rev-parse", "HEAD"]).trim()}\n`);
    // a tree's archive carries no id
    const treeTar = nativeArchive(home, repo, ["HEAD^{tree}"]).out;
    const t = tarCommitIdTwins(home, treeTar);
    expect(t.ours).toEqual(t.native);
    expect(t.native.status).toBe(1);
  });

  it('t5000-tar-tree.sh: "git archive with --output, override inferred format"', async () => {
    await twins(repo, ["--format=tar", "--output=d4.zip", "HEAD"]);
  });

  it('t5000-tar-tree.sh: "invoke tar filter by format", "invoke tar filter by extension", "default output format remains tar", "extension matching requires dot"', async () => {
    git(repo, ["config", "tar.tar.foo.command", "tr ab ba"]);
    git(repo, ["config", "tar.bar.command", "sh -c 'tr ab ba' -"]);
    git(repo, ["config", "tar.bar.remote", "true"]);
    git(repo, ["config", "tar.invalid", "baz"]);
    try {
      // t5000-tar-tree.sh: "archive --list mentions user filter"
      await twins(repo, ["--list"]);
      await twins(repo, ["--format=tar.foo", "HEAD"]);
      await twins(repo, ["--format=bar", "HEAD"]);
      await twins(repo, ["-o", "config-implicit.tar.foo", "HEAD"]);
      await twins(repo, ["-o", "config-implicit.bar", "HEAD"]);
      await twins(repo, ["-o", "config-implicit.baz", "HEAD"]);
      await twins(repo, ["-o", "config-implicittar.foo", "HEAD"]);
      // a level goes to the filter's command line
      await twins(repo, ["--format=bar", "-3", "HEAD"]);
    } finally {
      git(repo, ["config", "--remove-section", "tar.tar.foo"]);
      git(repo, ["config", "--remove-section", "tar.bar"]);
      git(repo, ["config", "--unset", "tar.invalid"]);
    }
  });

  it('t5000-tar-tree.sh: "git archive --format=tgz", "git archive --format=tar.gz", "infer tgz from .tgz filename", "infer tgz from .tar.gz filename"', async () => {
    const tgz = { compare: (out: Buffer) => normalizeTgz(out) };
    const n = await twins(repo, ["--format=tgz", "HEAD"], tgz);
    await twins(repo, ["--format=tar.gz", "HEAD"], tgz);
    await twins(repo, ["--output=j2.tgz", "HEAD"], tgz);
    await twins(repo, ["--output=j3.tar.gz", "HEAD"], tgz);
    await twins(repo, ["--format=tgz", "-9", "HEAD"], tgz);
    await twins(repo, ["--format=tgz", "-1", "HEAD"], tgz);
    // t5000-tar-tree.sh: "extract tgz file"
    const tar = nativeArchive(home, repo, ["HEAD"]).out;
    expect(Buffer.from(normalizeTgz(n.out).content, "hex").equals(tar)).toBe(true);
  });

  it('t5000-tar-tree.sh: "git archive --format=tgz (external gzip)"', async () => {
    git(repo, ["config", "tar.tgz.command", "gzip -cn"]);
    try {
      await twins(repo, ["--format=tgz", "HEAD"]);
    } finally {
      git(repo, ["config", "--unset", "tar.tgz.command"]);
    }
  });

  it('t5000-tar-tree.sh: "archive and :(glob)"', async () => {
    const n = await twins(repo, ["-v", "HEAD", "--", ":(glob)**/sh"]);
    expect(n.err).toBe("a/\na/bin/\na/bin/sh\n");
  });

  it('t5000-tar-tree.sh: "catch non-matching pathspec"', async () => {
    const n = await twins(repo, ["-v", "HEAD", "--", "*.abc"]);
    expect(n.status).toBe(128);
  });

  it('t5000-tar-tree.sh: "reject paths outside the current directory"', async () => {
    const n = await twins(repo, ["HEAD", ".."], { cwd: "a/bin" });
    expect(n.err).toContain("outside the current directory");
  });

  it('t5000-tar-tree.sh: "allow pathspecs that resolve to the current directory"', async () => {
    const n = await twins(repo, ["-v", "HEAD", "../bin"], { cwd: "a/bin" });
    expect(n.err).toBe("sh\n");
  });

  it('t5000-tar-tree.sh: "attr pathspec in bare repo"', async () => {
    const n = await twins(bare, ["-v", "HEAD", ":(attr:files_named_a)"]);
    expect(n.err).toBe("a/\na/a\n");
  });

  it("an attr pathspec that matches nothing, or only a directory", async () => {
    await twins(bare, ["-v", "HEAD", ":(attr:nosuchattr)"]);
    await twins(repo, ["-v", "HEAD", ":(attr:files_named_a)", "a/bin"]);
  });

  it('t5000-tar-tree.sh: "--list notices extra parameters"', async () => {
    const n = nativeArchive(home, repo, ["--list"]);
    const o = await oursArchive(home, repo, ["--list"]);
    expect(o).toEqual(n);
  });

  it("unknown formats, levels a format does not take, a missing or bad tree-ish", async () => {
    await twins(repo, ["--format=rar", "HEAD"]);
    await twins(repo, ["-3", "HEAD"]);
    await twins(repo, ["--format=zip", "-10", "HEAD"]);
    await twins(repo, ["nosuchref"]);
    await twins(repo, [`${git(repo, ["rev-parse", "HEAD:a/a"]).trim()}`]);
  });

  const zip = { compare: (out: Buffer) => normalizeZip(out) };

  it('t5003-archive-zip.sh: "git archive --format=zip", "git archive --format=zip in a bare repo", "git archive --format=zip vs. the same in a bare repo"', async () => {
    const n = await twins(repo, ["--format=zip", "HEAD"], zip);
    const b = await twins(bare, ["--format=zip", "HEAD"], zip);
    expect(normalizeZip(b.out)).toEqual(normalizeZip(n.out));
    // stored members only: byte for byte
    await twins(repo, ["--format=zip", "-0", "HEAD"]);
  });

  it('t5003-archive-zip.sh: "git archive --format=zip with prefix"', async () => {
    await twins(repo, ["--format=zip", "--prefix=prefix/", "HEAD"], zip);
    await twins(repo, ["--format=zip", "-0", "--prefix=prefix/", "HEAD"]);
  });

  it('t5003-archive-zip.sh: "git archive --format=zip with --output"', async () => {
    await twins(repo, ["--format=zip", "--output=d2.zip", "HEAD"], zip);
    // t5003-archive-zip.sh: "git archive with --output, inferring format (local)"
    await twins(repo, ["--output=d3.zip", "HEAD"], zip);
  });

  it('t5003-archive-zip.sh: "git archive -0 --format=zip on large files", "git archive --format=zip on large files"', async () => {
    git(repo, ["config", "core.bigfilethreshold", "1"]);
    try {
      await twins(repo, ["-0", "--format=zip", "HEAD"]);
      await twins(repo, ["--format=zip", "HEAD"], zip);
    } finally {
      git(repo, ["config", "--unset", "core.bigfilethreshold"]);
    }
  });

  it('t5003-archive-zip.sh: "git archive --format=zip --add-file"', async () => {
    put(repo, "untracked", "untracked\n");
    await twins(repo, ["--format=zip", "--add-file=untracked", "HEAD"], zip);
    // t5003-archive-zip.sh: "git archive --format=zip --add-file twice"
    await twins(
      repo,
      [
        "--format=zip",
        "--prefix=one/",
        "--add-file=untracked",
        "--prefix=two/",
        "--add-file=untracked",
        "--prefix=",
        "HEAD",
      ],
      zip,
    );
  });

  it('t5003-archive-zip.sh: "git archive --format=zip --add-virtual-file"', async () => {
    const args = [
      "--format=zip",
      "--add-virtual-file=quoted:quoted",
      '--add-virtual-file="with\\nnewline":content',
      "--prefix=pre/",
      "--add-virtual-file=with:colon:value",
      "HEAD",
    ];
    await twins(repo, args, zip);
    await twins(repo, ["--format=tar", ...args.slice(1)]);
    await twins(repo, ["--add-virtual-file=nocolon", "HEAD"]);
    await twins(repo, ["--add-virtual-file=:empty", "HEAD"]);
    await twins(repo, ['--add-virtual-file="open:x', "HEAD"]);
  });

  it('t5003-archive-zip.sh: "setup export-subst and diff attributes"', async () => {
    // binary and text members (zip's internal attributes) by the diff driver
    put(
      repo,
      ".git/info/attributes",
      "ignored export-ignore\nsubstfile? export-subst\n*.txt diff\n*.bin -diff\n*.custom diff=custom\n",
    );
    put(repo, "d/text.txt", "text\0with nul\n");
    put(repo, "d/data.bin", "plain text\n");
    put(repo, "d/file.custom", "plain\n");
    git(repo, ["add", "d"]);
    git(repo, ["commit", "-q", "-m", "diff attributes"]);
    git(repo, ["config", "diff.custom.binary", "true"]);
    try {
      await twins(repo, ["--format=zip", "-0", "HEAD", "d"]);
    } finally {
      git(repo, ["config", "--unset", "diff.custom.binary"]);
      git(repo, ["reset", "-q", "--hard", "HEAD^"]);
      put(repo, ".git/info/attributes", "ignored export-ignore\nsubstfile? export-subst\n");
    }
  });
});

describeGit("git archive attributes, native (t5001-archive-attr)", () => {
  let root = "";
  let repo = "";
  let bare = "";

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "archive-attr-native-"));
    home = root;
    repo = join(root, "repo");
    mkdirSync(repo);
    git(repo, ["init", "-q", "-b", "main"]);
    // t5001-archive-attr.sh: "setup"
    put(repo, "ignored", "ignored\n");
    put(repo, ".git/info/attributes", "ignored export-ignore\n");
    git(repo, ["add", "ignored"]);
    put(repo, "ignored-by-tree", "ignored by tree\n");
    put(repo, ".gitattributes", "ignored-by-tree export-ignore\n");
    put(repo, "ignored-by-tree.d/file", "");
    put(repo, ".gitattributes", "ignored-by-tree export-ignore\nignored-by-tree.d export-ignore\n");
    git(repo, ["add", "ignored-by-tree", "ignored-by-tree.d", ".gitattributes"]);
    put(repo, "subdir/included", "");
    put(repo, "subdir/ignored-by-subtree", "");
    put(repo, "subdir/ignored-by-tree", "");
    put(repo, "subdir/.gitattributes", "ignored-by-subtree export-ignore\n");
    git(repo, ["add", "subdir"]);
    put(repo, "ignored-by-worktree", "ignored by worktree\n");
    put(repo, ".gitattributes", "ignored-by-worktree export-ignore\n");
    git(repo, ["add", "ignored-by-worktree"]);
    put(repo, "excluded-by-pathspec.d/file", "");
    git(repo, ["add", "excluded-by-pathspec.d"]);
    put(repo, "nosubstfile", `A$Format:${SUBSTFORMAT}$O`);
    put(repo, "substfile1", `A$Format:${SUBSTFORMAT}$O`);
    put(repo, "substfile2", "A not substituted O");
    put(repo, ".git/info/attributes", "ignored export-ignore\nsubstfile? export-subst\n");
    git(repo, ["add", "nosubstfile", "substfile1", "substfile2"]);
    git(repo, ["commit", "-q", "-m", "."]);
    bare = join(root, "bare");
    git(root, ["clone", "-q", "--template=", "--bare", repo, bare]);
    put(bare, "info/attributes", "ignored export-ignore\nsubstfile? export-subst\n");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('t5001-archive-attr.sh: "git archive", "export-subst"', async () => {
    const n = await twins(repo, ["HEAD"]);
    const names = tarNames(n.out);
    expect(names).not.toContain("ignored");
    expect(names).not.toContain("ignored-by-tree");
    expect(names).not.toContain("ignored-by-tree.d/");
    expect(names).toContain("ignored-by-worktree");
    expect(names).toContain("excluded-by-pathspec.d/file");
  });

  it('t5001-archive-attr.sh: "git archive with pathspec"', async () => {
    await twins(repo, ["HEAD", ":!excluded-by-pathspec.d"]);
  });

  it('t5001-archive-attr.sh: "git archive with wildcard pathspec"', async () => {
    await twins(repo, ["HEAD", ":!excluded-by-p*"]);
  });

  it('t5001-archive-attr.sh: "git -C subdir archive"', async () => {
    const n = await twins(repo, ["HEAD"], { cwd: "subdir" });
    expect(tarNames(n.out)).toContain("included");
  });

  it('t5001-archive-attr.sh: "git archive with worktree attributes", "git archive --worktree-attributes option"', async () => {
    const n = await twins(repo, ["--worktree-attributes", "HEAD"]);
    expect(tarNames(n.out)).toContain("ignored-by-tree");
    expect(tarNames(n.out)).not.toContain("ignored-by-worktree");
  });

  it('t5001-archive-attr.sh: "git archive vs. bare"', async () => {
    const n = await twins(bare, ["HEAD"]);
    expect(n.out.equals(nativeArchive(home, repo, ["HEAD"]).out)).toBe(true);
  });

  it('t5001-archive-attr.sh: "git archive with worktree attributes, bare"', async () => {
    git(bare, ["config", "attr.tree", "HEAD"]);
    try {
      const n = await twins(bare, ["--worktree-attributes", "HEAD"]);
      expect(tarNames(n.out)).toContain("ignored-by-worktree");
    } finally {
      git(bare, ["config", "--unset", "attr.tree"]);
    }
  });

  it('t5001-archive-attr.sh: "export-subst expands %(describe) once"', async () => {
    put(repo, "substfile3", "$Format:%(describe)$\n$Format:%(describe)$\n");
    put(repo, "substfile4", "$Format:%(describe)\n%(describe)$\n");
    git(repo, ["add", "substfile3", "substfile4"]);
    git(repo, ["commit", "-q", "-m", "export-subst-describe"]);
    git(repo, ["tag", "-m", "export-subst-describe", "export-subst-describe"]);
    await twins(repo, ["HEAD"]);
  });
});

describeGit("git archive corner cases, native (t5004-archive-corner-cases)", () => {
  let root = "";
  let repo = "";

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "archive-corner-native-"));
    home = root;
    repo = join(root, "repo");
    mkdirSync(repo);
    git(repo, ["init", "-q", "-b", "main"]);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('t5004-archive-corner-cases.sh: "tar archive of empty tree is empty", "tar archive of empty tree with prefix", "zip archive of empty tree is empty", "zip archive of empty tree with prefix"', async () => {
    const empty = git(repo, ["hash-object", "-t", "tree", "-w", "--stdin"], {}).trim();
    await twins(repo, ["--mtime=2002-02-02T02:02:02-0200", empty]);
    await twins(repo, ["--mtime=2002-02-02T02:02:02-0200", "--prefix=foo/", empty]);
    await twins(repo, ["--mtime=2002-02-02T02:02:02-0200", "--format=zip", empty]);
    await twins(repo, ["--mtime=2002-02-02T02:02:02-0200", "--format=zip", "--prefix=foo/", empty]);
    // t5004-archive-corner-cases.sh: "archive complains about pathspec on empty tree"
    await twins(repo, [empty, "foo"]);
    // t5004-archive-corner-cases.sh: "create commit with empty tree and fake empty tar"
    git(repo, ["commit", "-q", "--allow-empty", "-m", "empty"]);
    await twins(repo, ["HEAD"]);
  });

  it('t5004-archive-corner-cases.sh: "archive empty subtree with no pathspec", "archive empty subtree by direct pathspec"', async () => {
    const empty = git(repo, ["hash-object", "-t", "tree", "-w", "--stdin"], {}).trim();
    const root2 = execFileSync("git", ["mktree"], {
      cwd: repo,
      env: archiveEnv(home),
      input: `040000 tree ${empty}\tsub\n`,
      encoding: "latin1",
    }).trim();
    await twins(repo, ["--mtime=2002-02-02T02:02:02-0200", root2]);
    await twins(repo, ["--mtime=2002-02-02T02:02:02-0200", root2, "sub"]);
  });

  it('t5004-archive-corner-cases.sh: "tar archive with long paths"', async () => {
    const dir = join(root, "long");
    mkdirSync(dir);
    git(dir, ["init", "-q", "-b", "main"]);
    // a name of 100 bytes, a path the prefix field cannot hold, a long symlink target
    put(dir, `${"x".repeat(100)}`, "a\n");
    put(dir, `${"d".repeat(160)}/f`, "b\n");
    put(dir, `${"e".repeat(90)}/${"f".repeat(99)}`, "c\n");
    symlinkSync("t".repeat(120), join(dir, "longlink"));
    put(dir, "dir/ünïcödé.txt", "u\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-q", "-m", "long"]);
    await twins(dir, ["HEAD"]);
    await twins(dir, ["--prefix=p/", "HEAD"]);
    await twins(dir, ["--format=zip", "-0", "HEAD"]);
  });
});

describeGit("git archive conversions and settings, native", () => {
  let root = "";
  let repo = "";

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "archive-convert-native-"));
    home = root;
    repo = join(root, "repo");
    mkdirSync(repo);
    git(repo, ["init", "-q", "-b", "main"]);
    put(repo, ".gitattributes", "*.crlf text eol=crlf\n*.id ident\n");
    put(repo, "a.crlf", "one\ntwo\n");
    put(repo, "b.id", "$Id$\n");
    put(repo, "c.txt", "plain\n");
    put(repo, "x.sh", "#!/bin/sh\n");
    execFileSync("chmod", ["+x", join(repo, "x.sh")]);
    git(repo, ["add", "."]);
    git(repo, ["commit", "-q", "-m", "conversions"]);
    // the worktree's attributes differ from the tree's: the tree's apply
    put(repo, ".gitattributes", "*.txt text eol=crlf\n");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("t5003-archive-zip.sh: the checkout conversions (eol, ident) from the tree's attributes", async () => {
    await twins(repo, ["HEAD"]);
    await twins(repo, ["--format=zip", "-0", "HEAD"]);
    await twins(repo, ["--worktree-attributes", "HEAD"]);
    git(repo, ["config", "core.autocrlf", "true"]);
    try {
      await twins(repo, ["HEAD"]);
    } finally {
      git(repo, ["config", "--unset", "core.autocrlf"]);
    }
  });

  it("t5000-tar-tree.sh: tar.umask", async () => {
    for (const umask of ["0", "077", "0022"]) {
      git(repo, ["config", "tar.umask", umask]);
      await twins(repo, ["HEAD"]);
    }
    git(repo, ["config", "--unset", "tar.umask"]);
  });

  it("t5000-tar-tree.sh: get-tar-commit-id of a short or foreign input", () => {
    for (const input of [
      Buffer.alloc(100),
      Buffer.alloc(1024),
      nativeArchive(home, repo, ["HEAD"]).out,
    ]) {
      const { native, ours } = tarCommitIdTwins(home, input);
      expect(ours).toEqual(native);
    }
  });
});

describeGit("git archive, JGit ArchiveCommandTest inputs (native oracle)", () => {
  let root = "";
  let repo = "";

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "archive-jgit-native-"));
    home = root;
    repo = join(root, "repo");
    mkdirSync(repo);
    git(repo, ["init", "-q", "-b", "main"]);
    put(repo, "a.txt", "content of a.txt\n");
    put(repo, "c.txt", "content of c.txt\n");
    put(repo, "unrelated.txt", "unrelated\n");
    put(repo, "some_directory/content.txt", "content of some_directory/content.txt\n");
    put(repo, "some_directory/nested_directory/nested.txt", "nested\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-q", "-m", "1"]);
    put(repo, "b.txt", "content of b.txt\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-q", "-m", "2"]);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("ArchiveCommandTest: the whole tree, one file, a directory, by id and with a prefix", async () => {
    await twins(repo, ["HEAD"]);
    await twins(repo, ["HEAD", "some_directory/content.txt"]);
    await twins(repo, ["HEAD", "some_directory"]);
    await twins(repo, ["HEAD", "some_directory/"]);
    await twins(repo, ["HEAD~1", "a.txt", "c.txt"]);
    await twins(repo, [git(repo, ["rev-parse", "HEAD~1"]).trim()]);
    await twins(repo, ["--prefix=x/", "HEAD"]);
    await twins(repo, ["--prefix=x", "HEAD"]);
    await twins(repo, ["--format=zip", "-0", "--prefix=x/y/", "HEAD", "some_directory"]);
    await twins(repo, ["--format=tgz", "HEAD"], { compare: (out) => normalizeTgz(out) });
  });
});
