/**
 * `git archive` and `git get-tar-commit-id` against native git, scenarios from git's
 * t5000-tar-tree.sh, t5003-archive-zip.sh, t5001-archive-attr.sh and
 * t5004-archive-corner-cases.sh, and JGit's ArchiveCommandTest inputs. Tar archives and
 * stored (`-0`) zips are compared byte for byte; deflated zips and `tgz` with their
 * compressed streams inflated (git links the system zlib, ours pako). Run with the system
 * git (2.43) and with 2.5x first on `PATH`.
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  createWriteStream,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createDeflate, deflateSync, constants as zlibConstants } from "node:zlib";
import { createNodeGitHostEnvironment } from "@statewalker/vcs-utils-node/files";
import { type FilterDriverRegistry, installContentFilter } from "@statewalker/vcs-working-tree";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type ArchiveOutcome,
  archiveEnv,
  genrandom,
  nativeArchive,
  normalizeTgz,
  normalizeZip,
  openArchiveRepo,
  oursArchive,
  tarCommitIdTwins,
} from "./archive-native-support.js";
import { shellFilterDriver } from "./host-drivers-native-support.js";
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
  options: {
    cwd?: string;
    env?: Record<string, string>;
    compare?: (out: Buffer) => unknown;
    /** What only our twin is given (host drivers, a content filter installed) */
    ours?: Pick<NonNullable<Parameters<typeof oursArchive>[3]>, "filterDrivers" | "prepare">;
  } = {},
): Promise<ArchiveOutcome> {
  const run = {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.env ? { env: options.env } : {}),
  };
  const n = nativeArchive(home, dir, args, run);
  const o = await oursArchive(home, dir, args, { ...run, ...options.ours });
  // callStream writes the bytes call returns
  const streamed = await oursArchive(home, dir, args, { ...run, ...options.ours, stream: true });
  expect({ ...streamed, out: streamed.out.toString("hex") }).toEqual({
    ...o,
    out: o.out.toString("hex"),
  });
  expectNotDatedNow(n);
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

/**
 * Fixture commits are dated 2005, so an archive dated within the hour comes from the clock:
 * native git and ours each read their own (a tree's archive without `--mtime`), and twins
 * straddling a second boundary differ (statewalker/webrun-vcs#369). Such twins pin `--mtime`.
 */
function expectNotDatedNow(r: ArchiveOutcome): void {
  if (r.status !== 0) return;
  let time: number | undefined;
  if (isTar(r.out)) {
    time = Number.parseInt(r.out.subarray(136, 147).toString("latin1"), 8);
  } else if (r.out.length >= 30 && r.out.readUInt32LE(0) === 0x04034b50) {
    const t = r.out.readUInt16LE(10);
    const d = r.out.readUInt16LE(12);
    time =
      Date.UTC((d >> 9) + 1980, ((d >> 5) & 15) - 1, d & 31, t >> 11, (t >> 5) & 63, (t & 31) * 2) /
      1000;
  }
  if (time !== undefined && Math.abs(time - Date.now() / 1000) < 3600) {
    throw new Error("archive dated now: the twins race the clock, pin it with --mtime");
  }
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

  it("the checkout conversions (eol, ident) from the tree's attributes", async () => {
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

  it("tar.umask", async () => {
    for (const umask of ["0", "077", "0022"]) {
      git(repo, ["config", "tar.umask", umask]);
      await twins(repo, ["HEAD"]);
    }
    git(repo, ["config", "--unset", "tar.umask"]);
  });

  it("get-tar-commit-id of a short or foreign input", () => {
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

describeGit("git archive edge cases, native", () => {
  let root = "";
  let repo = "";
  let bare = "";

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "archive-edge-native-"));
    home = root;
    repo = join(root, "repo");
    mkdirSync(repo);
    git(repo, ["init", "-q", "-b", "main"]);
    put(repo, "plain.txt", "plain\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-q", "-m", "plain"]);
    git(repo, ["tag", "plain"]);
    put(
      repo,
      ".gitattributes",
      "*.crlf eol=crlf\n*.id ident\nignored export-ignore\nsub/*.txt eol=crlf\nx.bin -diff\n",
    );
    put(repo, "a.crlf", "one\ntwo\n");
    put(repo, "b.id", "$Id$\n");
    put(repo, "ignored", "gone\n");
    put(repo, "sub/x.txt", "x\ny\n");
    put(repo, "sub/y.id", "$Id$\n");
    put(repo, "x.bin", "text\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-q", "-m", "attributes"]);
    bare = join(root, "bare.git");
    git(root, ["clone", "-q", "--bare", repo, bare]);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("a bare repository converts (eol, ident) by the archived tree", async () => {
    await twins(bare, ["HEAD"]);
    await twins(bare, ["--format=zip", "-0", "HEAD"]);
  });

  it("attr.tree and GIT_ATTR_SOURCE give way to the archived tree", async () => {
    for (const dir of [repo, bare]) {
      git(dir, ["config", "attr.tree", "plain"]);
      try {
        await twins(dir, ["HEAD"]);
      } finally {
        git(dir, ["config", "--unset", "attr.tree"]);
      }
      await twins(dir, ["HEAD"], { env: { GIT_ATTR_SOURCE: "plain" } });
      await twins(dir, ["plain"], { env: { GIT_ATTR_SOURCE: "HEAD" } });
    }
  });

  it("a subdirectory's run converts by the path below it", async () => {
    await twins(repo, ["HEAD"], { cwd: "sub" });
  });

  it("an added file's text flag follows the diff attribute", async () => {
    await twins(repo, ["--format=zip", "-0", "--prefix=p/", "--add-file=x.bin", "HEAD"]);
  });

  it("--add-file with .. from a subdirectory", async () => {
    await twins(repo, ["--add-file=../x.bin", "HEAD"], { cwd: "sub" });
    await twins(repo, ["--add-file=nosuch", "HEAD"]);
  });

  it("a C-quoted virtual path with octal escapes", async () => {
    await twins(repo, ['--add-virtual-file="\\303\\251t\\303\\251":caf\u00e9', "HEAD"]);
    await twins(repo, ["--add-virtual-file=caf\u00e9.txt:x", "HEAD"]);
  });

  it("tgz levels zlib refuses", async () => {
    await twins(repo, ["--format=tgz", "-10", "HEAD"]);
  });

  it('t5000-tar-tree.sh: "invalid filter is reported only once"', async () => {
    git(repo, ["config", "tar.invalid.command", ""]);
    try {
      const n = await twins(repo, ["--format=invalid", "HEAD"]);
      expect(n.err.trim().split("\n")).toHaveLength(1);
    } finally {
      git(repo, ["config", "--unset", "tar.invalid.command"]);
    }
  });

  it("a bare repository's filter drivers: a required one that cannot run dies", async () => {
    put(bare, "info/attributes", "*.crlf filter=x\n");
    git(bare, ["config", "filter.x.required", "true"]);
    try {
      const n = await twins(bare, ["HEAD"]);
      expect(n.status).toBe(128);
    } finally {
      rmSync(join(bare, "info/attributes"));
      git(bare, ["config", "--unset", "filter.x.required"]);
    }
  });

  it("a bare repository's host filter drivers smudge (setFilterDrivers)", async () => {
    put(bare, "info/attributes", "*.crlf filter=up\n");
    git(bare, ["config", "filter.up.smudge", "tr a-z A-Z"]);
    try {
      const upper = {
        smudge: async (content: Uint8Array) =>
          new TextEncoder().encode(new TextDecoder().decode(content).toUpperCase()),
      };
      const n = nativeArchive(home, bare, ["HEAD"]);
      const o = await oursArchive(home, bare, ["HEAD"], { filterDrivers: { up: upper } });
      expect(o.err).toBe(n.err);
      expect(o.out.equals(n.out)).toBe(true);
    } finally {
      rmSync(join(bare, "info/attributes"));
      git(bare, ["config", "--unset", "filter.up.smudge"]);
    }
  });

  it("working-tree-encoding without a value dies, bare or not", async () => {
    git(repo, ["config", "core.attributesFile", join(root, "attributes")]);
    put(root, "attributes", "*.crlf working-tree-encoding\n");
    try {
      expect((await twins(repo, ["HEAD"])).status).toBe(128);
      put(bare, "info/attributes", "*.crlf working-tree-encoding\n");
      expect((await twins(bare, ["HEAD"])).status).toBe(128);
    } finally {
      git(repo, ["config", "--unset", "core.attributesFile"]);
      rmSync(join(bare, "info/attributes"), { force: true });
    }
  });

  it("checkout's verify_path: trees with paths git refuses", async () => {
    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: repo,
      env: archiveEnv(home),
      input: "hi\n",
      encoding: "latin1",
    }).trim();
    const mktree = (input: string) =>
      execFileSync("git", ["mktree"], {
        cwd: repo,
        env: archiveEnv(home),
        input,
        encoding: "latin1",
      }).trim();
    const dotGit = mktree(`100644 blob ${blob}\t.git\n100644 blob ${blob}\tok\n`);
    const nested = mktree(`040000 tree ${mktree(`100644 blob ${blob}\t.git\n`)}\td\n`);
    const ntfs = mktree(`040000 tree ${mktree(`100644 blob ${blob}\tconfig\n`)}\tgit~1\n`);
    for (const tree of [dotGit, nested, ntfs]) {
      const n = await twins(repo, [tree]);
      expect([128, 255]).toContain(n.status);
      await twins(repo, ["--worktree-attributes", "--mtime=2002-02-02T02:02:02-0200", tree]);
    }
    // names the tree decoder refuses: git archives `..` under --worktree-attributes, ours
    // refuses it as verify_path does (an entry that escapes on extraction)
    const raw = Buffer.concat([Buffer.from("100644 ..\0"), Buffer.from(blob, "hex")]);
    const dotdot = execFileSync(
      "git",
      ["hash-object", "-t", "tree", "-w", "--literally", "--stdin"],
      {
        cwd: repo,
        env: archiveEnv(home),
        input: raw,
        encoding: "latin1",
      },
    ).trim();
    expect([128, 255]).toContain((await twins(repo, [dotdot])).status);
    const o = await oursArchive(home, repo, ["--worktree-attributes", dotdot]);
    expect({ status: o.status, err: o.err }).toEqual({
      status: 255,
      err: "error: invalid path '..'\n",
    });
  });
});

describeGit("git archive with many entries, native (t5004-archive-corner-cases)", () => {
  let root = "";

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "archive-many-native-"));
    home = root;
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('t5004-archive-corner-cases.sh: "zip archive with many entries"', async () => {
    const repo = join(root, "repo");
    mkdirSync(repo);
    git(repo, ["init", "-q", "-b", "main"]);
    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: repo,
      env: archiveEnv(home),
      input: "",
      encoding: "latin1",
    }).trim();
    const mktree = (input: string) =>
      execFileSync("git", ["mktree"], {
        cwd: repo,
        env: archiveEnv(home),
        input,
        encoding: "latin1",
      }).trim();
    // 256 directories of 256 empty files: more entries than a zip's 16-bit counts hold
    const hex = [...Array(256).keys()].map((i) => i.toString(16).padStart(2, "0"));
    const inner = mktree(hex.map((h) => `100644 blob ${blob}\t${h}\n`).join(""));
    const outer = mktree(hex.map((h) => `040000 tree ${inner}\t${h}\n`).join(""));
    await twins(repo, ["--format=zip", "--mtime=2002-02-02T02:02:02-0200", outer], {
      compare: (out) => normalizeZip(out),
    });
    await twins(repo, ["--format=zip", "-0", "--mtime=2002-02-02T02:02:02-0200", outer]);
  }, 120000);
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

/**
 * A long-running process filter (gitprotocol-long-running-process, as t0021's
 * rot13-filter.pl): it passes content through and logs each smudge's pathname and checkout
 * metadata (`ref=`, `treeish=`, `blob=`) to the file it is given.
 */
const PROCESS_FILTER = String.raw`
const fs = require("node:fs");
const log = process.argv[2];
let buf = Buffer.alloc(0);
let waiting = null;
process.stdin.on("data", (d) => { buf = Buffer.concat([buf, d]); if (waiting) { const w = waiting; waiting = null; w(); } });
process.stdin.on("end", () => process.exit(0));
const more = () => new Promise((r) => { waiting = r; });
async function packet() {
  while (buf.length < 4) await more();
  const len = parseInt(buf.subarray(0, 4).toString(), 16);
  if (len === 0) { buf = buf.subarray(4); return null; }
  while (buf.length < len) await more();
  const data = buf.subarray(4, len); buf = buf.subarray(len); return data;
}
async function list() { const out = []; for (let p; (p = await packet()) !== null; ) out.push(p); return out; }
const pkt = (s) => { const b = Buffer.from(s); return Buffer.concat([Buffer.from((b.length + 4).toString(16).padStart(4, "0")), b]); };
const write = (...parts) => process.stdout.write(Buffer.concat(parts));
(async () => {
  await list();
  write(pkt("git-filter-server\n"), pkt("version=2\n"), Buffer.from("0000"));
  await list();
  write(pkt("capability=smudge\n"), Buffer.from("0000"));
  for (;;) {
    const header = (await list()).map((p) => p.toString().replace(/\n$/, ""));
    const content = Buffer.concat(await list());
    fs.appendFileSync(log, header.filter((l) => !l.startsWith("command=")).join(" ") + "\n");
    write(pkt("status=success\n"), Buffer.from("0000"));
    for (let at = 0; at < content.length; at += 65516) write(pkt(content.subarray(at, at + 65516)));
    write(Buffer.from("0000"), Buffer.from("0000"));
  }
})();
`;

describeGit("git archive streaming, host files and settings, native (#349)", () => {
  let root = "";
  let repo = "";
  let bare = "";
  const DATE = {
    GIT_COMMITTER_DATE: "2005-05-27 22:00 +0000",
    GIT_AUTHOR_DATE: "2005-05-27 22:00 +0000",
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "archive-stream-native-"));
    home = root;
    repo = join(root, "repo");
    mkdirSync(repo);
    git(repo, ["init", "-q", "-b", "main"]);
    put(repo, ".gitattributes", "subst export-subst\n");
    put(repo, "big.bin", genrandom("big", 300_000));
    put(repo, "d/big.txt", "the quick brown fox jumps over the lazy dog\n".repeat(30_000));
    put(repo, "small", "small\n");
    put(repo, "subst", `$Format:%H$\n${"padding line\n".repeat(20_000)}`);
    git(repo, ["add", "."]);
    git(repo, ["commit", "-q", "-m", "large"], DATE);
    bare = join(root, "bare.git");
    git(root, ["clone", "-q", "--template=", "--bare", repo, bare]);
    put(root, "outside", "outside the repository\n");
    put(root, "tool.sh", "#!/bin/sh\n");
    execFileSync("chmod", ["755", join(root, "tool.sh")]);
    mkdirSync(join(root, "adir"));
    symlinkSync(join(root, "outside"), join(repo, "to-outside"));
    symlinkSync("nowhere", join(repo, "dangling"));
    symlinkSync(join(root, "adir"), join(repo, "to-dir"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  /** Runs `fn` with `key=value` in `dir`'s configuration (written into its file), then unsets it. */
  async function withConfig(dir: string, entries: string[][], fn: () => Promise<void>) {
    for (const [key, value] of entries)
      git(dir, ["config", "--add", key as string, value as string]);
    try {
      await fn();
    } finally {
      for (const [key] of entries) git(dir, ["config", "--unset-all", key as string]);
    }
  }

  it('t5000-tar-tree.sh: "git archive on large files"; t5003-archive-zip.sh: "git archive -0 --format=zip on large files", "git archive --format=zip on large files"', async () => {
    await withConfig(repo, [["core.bigFileThreshold", "100k"]], async () => {
      await twins(repo, ["HEAD"]);
      await twins(repo, ["--prefix=p/", "HEAD", "d", "big.bin"]);
      await twins(repo, ["-0", "--format=zip", "HEAD"]);
      await twins(repo, ["--format=zip", "HEAD"], { compare: normalizeZip });
      await twins(repo, ["-9", "--format=zip", "HEAD"], { compare: normalizeZip });
      await twins(repo, ["--format=tgz", "HEAD"], { compare: normalizeTgz });
      await twins(repo, ["-1", "--format=tar.gz", "HEAD"], { compare: normalizeTgz });
    });
    // threshold 0: every non-empty blob is streamed
    await withConfig(repo, [["core.bigFileThreshold", "0"]], async () => {
      await twins(repo, ["--format=zip", "HEAD"], { compare: normalizeZip });
      await twins(repo, ["HEAD"]);
    });
    await withConfig(bare, [["core.bigFileThreshold", "100k"]], async () => {
      await twins(bare, ["--format=zip", "HEAD"], { compare: normalizeZip });
    });
  });

  it('t5000-tar-tree.sh: "invoke tar filter by format": a command streamed through as a pipe', async () => {
    await withConfig(
      repo,
      [
        ["core.bigFileThreshold", "100k"],
        ["tar.gzn.command", "gzip -cn"],
      ],
      async () => {
        // the same tar through the same gzip: byte for byte
        await twins(repo, ["--format=gzn", "HEAD"]);
        await twins(repo, ["-3", "--format=gzn", "HEAD"]);
      },
    );
    await withConfig(repo, [["tar.bad.command", "cat >/dev/null; exit 1"]], async () => {
      await twins(repo, ["--format=bad", "HEAD"]);
    });
  });

  it("callStream writes the archive in chunks, a streamed blob never whole", async () => {
    await withConfig(repo, [["core.bigFileThreshold", "100k"]], async () => {
      const ours = await openArchiveRepo(home, repo);
      const sizes: number[] = [];
      for await (const chunk of ours.archive().setTree("HEAD").callStream())
        sizes.push(chunk.length);
      expect(sizes.length).toBeGreaterThan(10);
      expect(Math.max(...sizes)).toBeLessThanOrEqual(256 * 1024);
      // a consumer stopping early ends the run
      const early = (await openArchiveRepo(home, repo)).archive().setFormat("zip").setTree("HEAD");
      for await (const _ of early.callStream()) break;
    });
  });

  it('t5000-tar-tree.sh: "git archive --add-file": absolute paths, files outside the repository, symbolic links followed, git\'s deaths', async () => {
    const mtime = "--mtime=2002-02-02T02:02:02-0200";
    await twins(repo, [`--add-file=${join(root, "outside")}`, "HEAD"]);
    await twins(repo, [`--add-file=${join(root, "tool.sh")}`, "--format=zip", "-0", "HEAD"]);
    await twins(repo, ["--add-file=../outside", "--prefix=x/", "--add-file=to-outside", "HEAD"]);
    await twins(repo, ["--add-file=../outside", "HEAD"], { cwd: "d" });
    await twins(repo, ["--add-file=dangling", "HEAD"]);
    await twins(repo, ["--add-file=nope", "HEAD"], { cwd: "d" });
    await twins(repo, ["--add-file=to-dir", "HEAD"]);
    await twins(repo, [`--add-file=${join(root, "adir")}`, "HEAD"]);
    await twins(repo, [`--add-file=${join(root, "missing")}`, mtime, "HEAD"]);
    // a bare repository's paths are its git directory's
    await twins(bare, ["--add-file=../outside", "HEAD"]);
  });

  it("valueless tar.<format>.command and tar.umask die (missing value), as a bad tar.umask", async () => {
    const config = join(repo, ".git", "config");
    const saved = readFileSync(config);
    try {
      writeFileSync(config, Buffer.concat([saved, Buffer.from('[tar "x"]\n\tcommand\n')]));
      await twins(repo, ["HEAD"]);
      await twins(repo, ["--list"]);
      writeFileSync(config, Buffer.concat([saved, Buffer.from("[tar]\n\tumask\n")]));
      await twins(repo, ["--format=zip", "HEAD"]);
      writeFileSync(config, Buffer.concat([saved, Buffer.from("[tar]\n\tumask = 0x\n")]));
      await twins(repo, ["HEAD"]);
    } finally {
      writeFileSync(config, saved);
    }
  });

  it("core.bigFileThreshold is git's unsigned long: 4g, 0, and the values git refuses", async () => {
    for (const value of ["4g", "lots", "-1", "99999999999g"]) {
      await withConfig(repo, [["core.bigFileThreshold", value]], async () => {
        await twins(repo, ["HEAD"]);
        await twins(repo, ["--format=zip", "HEAD"], { compare: normalizeZip });
        // 2.43 reads it when it starts (before `--list`), 2.5x at the first file it writes
        await twins(repo, ["--list"]);
        await twins(repo, ["--add-file=nope", "HEAD"]);
      });
    }
  });

  it("--worktree-attributes in a bare repository: 2.43 reads HEAD's attributes, 2.5x none", async () => {
    const attrs = join(root, "attrs");
    mkdirSync(attrs);
    git(attrs, ["init", "-q", "-b", "main"]);
    put(attrs, ".gitattributes", "ignored export-ignore\n");
    put(attrs, "ignored", "x\n");
    put(attrs, "kept", "y\n");
    git(attrs, ["add", "."]);
    git(attrs, ["commit", "-q", "-m", "attrs"], DATE);
    const attrsBare = join(root, "attrs.git");
    git(root, ["clone", "-q", "--template=", "--bare", attrs, attrsBare]);
    await twins(attrsBare, ["--worktree-attributes", "HEAD"]);
    await twins(attrsBare, ["HEAD"]);
  });

  /** A repository whose `bad.txt` is no UTF-8, and a `filter=x` file. */
  function conversionRepo(name: string): string {
    const dir = join(root, name);
    mkdirSync(dir);
    git(dir, ["init", "-q", "-b", "main"]);
    put(dir, "bad.txt", Buffer.from([0x61, 0xc3, 0x28, 0x0a]));
    put(dir, "f", "filtered\n");
    git(dir, ["add", "."]);
    put(dir, ".gitattributes", "bad.txt working-tree-encoding=UTF-16\nf filter=x\n");
    git(dir, ["add", ".gitattributes"]);
    git(dir, ["commit", "-q", "-m", "conversions"], DATE);
    return dir;
  }

  it("an encoding git cannot write warns, with a worktree or not", async () => {
    const dir = conversionRepo("encode");
    await twins(dir, ["HEAD"]);
    const dirBare = join(root, "encode.git");
    git(root, ["clone", "-q", "--template=", "--bare", dir, dirBare]);
    await twins(dirBare, ["HEAD"]);
  });

  it("a filter driver that is not required and fails: git's lines, the content unfiltered", async () => {
    const dir = conversionRepo("failing");
    const env = archiveEnv(home);
    const drivers = { x: shellFilterDriver(dir, env) };
    await withConfig(dir, [["filter.x.smudge", "false"]], async () => {
      await twins(dir, ["HEAD"], {
        ours: {
          prepare: (ours) => {
            const wc = ours.workingCopy;
            installContentFilter(
              {
                history: wc.history,
                checkout: wc.checkout,
                worktree: wc.worktree,
                config: wc.config,
              },
              { filterDrivers: drivers, environment: createNodeGitHostEnvironment({ env }) },
            );
          },
        },
      });
    });
    const dirBare = join(root, "failing.git");
    git(root, ["clone", "-q", "--template=", "--bare", dir, dirBare]);
    await withConfig(dirBare, [["filter.x.smudge", "exit 3"]], async () => {
      await twins(dirBare, ["HEAD"], {
        ours: { filterDrivers: { x: shellFilterDriver(dirBare, env) } },
      });
    });
  });

  it("a process filter is given the checkout metadata (ref, treeish, blob)", async () => {
    const dir = conversionRepo("process");
    const script = join(root, "process-filter.cjs");
    writeFileSync(script, PROCESS_FILTER);
    const nativeLog = join(root, "native.log");
    const oursLog: string[] = [];
    const logged: FilterDriverRegistry = {
      x: {
        smudge: async (content, context) => {
          const m = context.metadata ?? {};
          const fields = [
            `pathname=${context.path}`,
            ...(m.ref ? [`ref=${m.ref}`] : []),
            ...(m.treeish ? [`treeish=${m.treeish}`] : []),
            ...(m.blob ? [`blob=${m.blob}`] : []),
          ];
          oursLog.push(fields.join(" "));
          return content;
        },
      },
    };
    const env = archiveEnv(home);
    const ours = {
      prepare: (repoOurs: Awaited<ReturnType<typeof openArchiveRepo>>) => {
        const wc = repoOurs.workingCopy;
        installContentFilter(
          { history: wc.history, checkout: wc.checkout, worktree: wc.worktree, config: wc.config },
          { filterDrivers: logged, environment: createNodeGitHostEnvironment({ env }) },
        );
      },
    };
    await withConfig(dir, [["filter.x.process", `node ${script} ${nativeLog}`]], async () => {
      const commit = git(dir, ["rev-parse", "HEAD"]).trim();
      const tree = git(dir, ["rev-parse", "HEAD^{tree}"]).trim();
      for (const treeish of ["HEAD", "main", commit, tree]) {
        rmSync(nativeLog, { force: true });
        oursLog.length = 0;
        const args = treeish === tree ? ["--mtime=2002-02-02T02:02:02-0200", tree] : [treeish];
        // the content filter runs in both of our twins (call and callStream)
        await twins(dir, args, { ours });
        const native = readFileSync(nativeLog, "latin1").trim().split("\n");
        expect(oursLog).toEqual([...native, ...native]);
      }
    });
  });
});

/** The first `n` bytes native `git archive <args>` writes in `dir` (then it is killed, as by SIGPIPE). */
async function nativeHead(dir: string, args: string[], n: number): Promise<Buffer> {
  const child = spawn("git", ["archive", ...args], { cwd: dir, env: archiveEnv(home) });
  const chunks: Buffer[] = [];
  let got = 0;
  for await (const chunk of child.stdout) {
    chunks.push(chunk as Buffer);
    got += (chunk as Buffer).length;
    if (got >= n) break;
  }
  child.kill();
  return Buffer.concat(chunks).subarray(0, n);
}

/** The first `n` bytes of our `callStream` for `git archive <args>` in `dir`. */
async function oursHead(dir: string, args: string[], n: number): Promise<Buffer> {
  const ours = await openArchiveRepo(home, dir);
  const cmd = ours.archive().setLocalTimezone(() => 0);
  for (const a of args) {
    if (a.startsWith("--format=")) cmd.setFormat(a.slice(9));
    else if (a.startsWith("--mtime=")) cmd.setMtime(a.slice(8));
    else if (/^-\d$/.test(a)) cmd.setCompressionLevel(Number(a.slice(1)));
    else cmd.setTree(a);
  }
  const chunks: Buffer[] = [];
  let got = 0;
  for await (const chunk of cmd.callStream()) {
    chunks.push(Buffer.from(chunk));
    got += chunk.length;
    if (got >= n) break;
  }
  return Buffer.concat(chunks).subarray(0, n);
}

/** The SHA-1 of what native git and our `callStream` write, read as they write it. */
async function streamedDigests(
  dir: string,
  args: string[],
): Promise<{ native: string; ours: string }> {
  const child = spawn("git", ["archive", ...args], { cwd: dir, env: archiveEnv(home) });
  const nativeHash = createHash("sha1");
  for await (const chunk of child.stdout) nativeHash.update(chunk as Buffer);
  const ours = await openArchiveRepo(home, dir);
  const cmd = ours
    .archive()
    .setLocalTimezone(() => 0)
    .setCompressionLevel(0)
    .setFormat("zip");
  cmd.setTree(args[args.length - 1] as string);
  const oursHash = createHash("sha1");
  for await (const chunk of cmd.callStream()) oursHash.update(chunk);
  return { native: nativeHash.digest("hex"), ours: oursHash.digest("hex") };
}

/** git's EXPENSIVE prerequisite (`GIT_TEST_LONG`): tests that write gigabytes. */
const itExpensive = process.env.GIT_TEST_LONG ? it : it.skip;

/** Writes `size` zero bytes as a loose blob of `dir`, streamed; its id. */
async function writeZeroBlob(dir: string, size: number): Promise<string> {
  const header = Buffer.from(`blob ${size}\0`);
  const zeros = Buffer.alloc(1 << 20);
  const hash = createHash("sha1").update(header);
  for (let left = size; left > 0; left -= zeros.length) {
    hash.update(left >= zeros.length ? zeros : zeros.subarray(0, left));
  }
  const id = hash.digest("hex");
  const path = join(dir, ".git/objects", id.slice(0, 2), id.slice(2));
  mkdirSync(join(path, ".."), { recursive: true });
  const deflate = createDeflate({ level: 1 });
  const done = pipeline(deflate, createWriteStream(path));
  if (!deflate.write(header)) await once(deflate, "drain");
  for (let left = size; left > 0; left -= zeros.length) {
    if (!deflate.write(left >= zeros.length ? zeros : zeros.subarray(0, left))) {
      await once(deflate, "drain");
    }
  }
  deflate.end();
  await done;
  return id;
}

describeGit(
  "git archive of huge blobs, native (t5000-tar-tree, t5004-archive-corner-cases)",
  () => {
    let root = "";

    beforeAll(() => {
      root = mkdtempSync(join(tmpdir(), "archive-huge-native-"));
      home = root;
    });
    afterAll(() => rmSync(root, { recursive: true, force: true }));

    it('t5000-tar-tree.sh: "set up repository with huge blob", "generate tar with huge size"', async () => {
      const repo = join(root, "huge");
      mkdirSync(repo);
      git(repo, ["init", "-q", "-b", "main"]);
      // a 64 GiB blob's loose object, cut short after 2 KiB (git's t5000/huge-object)
      const obj = "19f9c8273ec45a8938e6999cb59b3ff66739902a";
      mkdirSync(join(repo, ".git/objects", obj.slice(0, 2)), { recursive: true });
      writeFileSync(
        join(repo, ".git/objects", obj.slice(0, 2), obj.slice(2)),
        readFileSync(join(import.meta.dirname, "fixtures/t5000-huge-object")),
      );
      git(repo, ["update-index", "--add", "--cacheinfo", `100644,${obj},huge`]);
      git(repo, ["commit", "-q", "-m", "huge"], { GIT_COMMITTER_DATE: "2005-05-27 22:00 +0000" });
      // the pax `size` record (68719476737 overflows the ustar field) and the first data
      const n = await nativeHead(repo, ["HEAD"], 4096);
      const o = await oursHead(repo, ["HEAD"], 4096);
      expect(n.length).toBe(4096);
      expect(n.toString("latin1")).toContain("size=68719476737\n");
      expect(o.toString("hex")).toBe(n.toString("hex"));
    });

    describe("a file bigger than 4 GiB", () => {
      const SIZE = 4100 * 1024 * 1024;
      let repo = "";
      let tree = "";

      beforeAll(() => {
        repo = join(root, "big");
        mkdirSync(repo);
        git(repo, ["init", "-q", "-b", "main"]);
        // as t5000's huge-object: a loose object declaring a 4100 MiB blob (t5004's big
        // file), cut short after its first MiB; nothing checks its id or bytes while it
        // streams (incompressible bytes, so that the stream is read in several chunks)
        const obj = "754a93d6fada4c6873360e6cb4b209132271ab0e";
        const head = Buffer.concat([Buffer.from(`blob ${SIZE}\0`), genrandom("big", 1 << 20)]);
        const deflated = deflateSync(head, { finishFlush: zlibConstants.Z_SYNC_FLUSH });
        mkdirSync(join(repo, ".git/objects", obj.slice(0, 2)), { recursive: true });
        writeFileSync(join(repo, ".git/objects", obj.slice(0, 2), obj.slice(2)), deflated);
        tree = execFileSync("git", ["mktree"], {
          cwd: repo,
          env: archiveEnv(home),
          input: `100644 blob ${obj}\tbig-file\n`,
          encoding: "latin1",
        }).trim();
      });

      it('t5004-archive-corner-cases.sh: "zip archive with files bigger than 4GB": the zip64 local header', async () => {
        const mtime = "--mtime=2002-02-02T02:02:02-0200";
        for (const level of ["-0", "-6"]) {
          // the local header: 30 bytes, the name, the mtime and zip64 extra fields
          const header = 30 + "big-file".length + 9 + 20;
          const n = await nativeHead(repo, [mtime, "--format=zip", level, tree], header);
          const o = await oursHead(repo, [mtime, "--format=zip", level, tree], header);
          expect(n.readUInt16LE(4)).toBe(45);
          expect(n.readUInt32LE(22)).toBe(0xffffffff);
          expect(n.readBigUInt64LE(30 + 8 + 9 + 4)).toBe(BigInt(SIZE));
          expect(o.toString("hex")).toBe(n.toString("hex"));
        }
      });

      itExpensive(
        't5004-archive-corner-cases.sh: "zip archive with files bigger than 4GB": the whole -0 archive',
        async () => {
          const dir = join(root, "big-whole");
          mkdirSync(dir);
          git(dir, ["init", "-q", "-b", "main"]);
          // written loose: git's hash-object -w packs it, and our pack reader refuses
          // packed objects above 1 GiB
          const blob = await writeZeroBlob(dir, SIZE);
          const whole = execFileSync("git", ["mktree"], {
            cwd: dir,
            env: archiveEnv(home),
            input: `100644 blob ${blob}\tbig-file\n`,
            encoding: "latin1",
          }).trim();
          const commit = execFileSync("git", ["commit-tree", "-m", "big", whole], {
            cwd: dir,
            env: archiveEnv(home, { GIT_COMMITTER_DATE: "2005-05-27 22:00 +0000" }),
            encoding: "latin1",
          }).trim();
          const { native, ours } = await streamedDigests(dir, ["--format=zip", "-0", commit]);
          expect(ours).toBe(native);
        },
        1_200_000,
      );
    });
  },
);
