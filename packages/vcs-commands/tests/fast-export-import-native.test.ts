/**
 * `git fast-export` and `git fast-import` against native git (builtin/fast-export.c,
 * builtin/fast-import.c), over t9350-fast-export.sh's history and t9300-fast-import.sh's
 * streams: an export's stdout must be native git's byte for byte (and its exit status and
 * stderr equal); an import, run by native git in one copy of a repository and by ours in
 * another, must leave the same refs and objects, print the same stdout, and die with the
 * same `fatal:` line.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { FastExportCommand, FastImportCommand, FastMarksFiles } from "../src/index.js";
import { gitOk, openOurs, put } from "./merge-native-helpers.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root: string;
let repo: string;
let tick = 0;
let compatibility: "2.43" | "2.56" = "2.56";

function env(): Record<string, string> {
  const date = `${1112911993 + 60 * tick} -0700`;
  return {
    ...nativeGitEnv(root),
    GIT_AUTHOR_NAME: "A U Thor",
    GIT_AUTHOR_EMAIL: "author@example.com",
    GIT_COMMITTER_NAME: "C O Mitter",
    GIT_COMMITTER_EMAIL: "committer@example.com",
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
    GIT_EDITOR: "true",
  };
}

/** test_tick, then git */
function g(cwd: string, ...args: string[]): string {
  tick++;
  return execFileSync("git", args, { cwd, env: env(), encoding: "latin1" });
}

function gitIn(cwd: string, args: string[], input?: Uint8Array | string) {
  const r = spawnSync("git", args, { cwd, env: env(), input, encoding: "latin1" });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Marks files relative to `dir`, as git opens them from its current directory. */
function marksFiles(dir: string): FastMarksFiles {
  return {
    read: async (path) => {
      const full = join(dir, path);
      return existsSync(full) ? new Uint8Array(readFileSync(full)) : undefined;
    },
    write: async (path, bytes) => {
      const full = join(dir, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, bytes);
    },
  };
}

/** `git fast-export <args>` mapped onto the command (the options t9350 uses). */
function exportArgs(cmd: FastExportCommand, args: string[]): FastExportCommand {
  for (const arg of args) {
    const [opt, value] = arg.includes("=")
      ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]
      : [arg, ""];
    if (opt === "--signed-tags") cmd.setSignedTags(value as "strip");
    else if (opt === "--signed-commits") cmd.setSignedCommits(value as "strip");
    else if (opt === "--tag-of-filtered-object") cmd.setTagOfFilteredObject(value as "drop");
    else if (opt === "--reencode") cmd.setReencode(value as "yes");
    else if (opt === "--export-marks") cmd.setExportMarks(value);
    else if (opt === "--import-marks") cmd.setImportMarks(value);
    else if (opt === "--import-marks-if-exists") cmd.setImportMarks(value, { ifExists: true });
    else if (opt === "--fake-missing-tagger") cmd.setFakeMissingTagger(true);
    else if (opt === "--full-tree") cmd.setFullTree(true);
    else if (opt === "--use-done-feature") cmd.setUseDoneFeature(true);
    else if (opt === "--no-data") cmd.setNoData(true);
    else if (opt === "--refspec") cmd.addRefspec(value);
    else if (opt === "--reference-excluded-parents") cmd.setReferenceExcludedParents(true);
    else if (opt === "--show-original-ids") cmd.setShowOriginalIds(true);
    else if (opt === "--mark-tags") cmd.setMarkTags(true);
    else if (opt === "--progress") cmd.setProgressEvery(Number(value));
    else cmd.addArgument(arg);
  }
  return cmd;
}

function importArgs(cmd: FastImportCommand, args: string[]): FastImportCommand {
  for (const arg of args) {
    const [opt, value] = arg.includes("=")
      ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]
      : [arg, ""];
    if (opt === "--quiet") continue;
    if (opt === "--force") cmd.setForce(true);
    else if (opt === "--done") cmd.setDone(true);
    else if (opt === "--date-format") cmd.setDateFormat(value as "raw");
    else if (opt === "--export-marks") cmd.setExportMarks(value);
    else if (opt === "--import-marks") cmd.setImportMarks(value);
    else if (opt === "--import-marks-if-exists") cmd.setImportMarks(value, { ifExists: true });
    else if (opt === "--allow-unsafe-features") cmd.setAllowUnsafeFeatures(true);
    else if (opt === "--signed-tags") cmd.setSignedTags(value as "strip");
    else if (opt === "--signed-commits") cmd.setSignedCommits(value as "strip");
    else throw new Error(`unmapped fast-import option ${arg}`);
  }
  return cmd;
}

/** git's stderr without fast-import's crash report line */
function stderrLines(text: string): string {
  return text
    .split("\n")
    .filter((l) => !l.startsWith("fast-import: dumping crash report"))
    .join("\n");
}

async function oursExport(dir: string, args: string[]) {
  const git = await openOurs(dir);
  const cmd = exportArgs(git.fastExport(), args)
    .setCompatibility(compatibility)
    .setMarksFiles(marksFiles(dir));
  const out = await cmd.callOutput();
  return {
    status: out.exitCode,
    stdout: Buffer.from(out.stdout).toString("latin1"),
    stderr: out.stderr,
  };
}

/** Runs `git fast-export <args>` natively and ours in `dir`; both must agree. */
async function exportTwin(args: string[], dir = repo) {
  const expected = gitIn(dir, ["fast-export", ...args]);
  const marksFile = args.find((a) => a.startsWith("--export-marks="))?.slice(15);
  const nativeMarks =
    marksFile && existsSync(join(dir, marksFile))
      ? readFileSync(join(dir, marksFile), "latin1")
      : undefined;
  if (marksFile) rmSync(join(dir, marksFile), { force: true });
  const actual = await oursExport(dir, args);
  const ourMarks =
    marksFile && existsSync(join(dir, marksFile))
      ? readFileSync(join(dir, marksFile), "latin1")
      : undefined;
  expect(actual.stdout).toBe(expected.stdout);
  expect(actual.status).toBe(expected.status);
  expect(actual.stderr).toBe(expected.stderr);
  expect(ourMarks).toBe(nativeMarks);
  return expected;
}

/** Every ref (HEAD included) and every object of a repository, as native git lists them. */
function repositoryState(dir: string) {
  const refs = gitIn(dir, ["for-each-ref", "--format=%(refname) %(objectname)"]).stdout;
  const objects = gitIn(dir, ["cat-file", "--batch-all-objects", "--batch-check"]).stdout;
  return { refs, objects: objects.split("\n").sort().join("\n") };
}

/** Copies `base` twice, imports `stream` natively into one and with ours into the other. */
async function importTwin(
  base: string,
  stream: string | Uint8Array,
  args: string[] = [],
  options: { files?: string[] } = {},
) {
  const id = `imp-${Math.random().toString(36).slice(2, 8)}`;
  const nativeDir = join(root, `${id}-native`);
  const oursDir = join(root, `${id}-ours`);
  execFileSync("cp", ["-a", base, nativeDir]);
  execFileSync("cp", ["-a", base, oursDir]);
  const input = typeof stream === "string" ? Buffer.from(stream, "latin1") : stream;
  const expected = gitIn(nativeDir, ["fast-import", "--quiet", ...args], input);
  const git = await openOurs(oursDir);
  const cmd = importArgs(git.fastImport(), args)
    .setInput(new Uint8Array(input))
    .setCompatibility(compatibility)
    .setMarksFiles(marksFiles(oursDir));
  const out = await cmd.callOutput();
  expect(Buffer.from(out.stdout).toString("latin1")).toBe(expected.stdout);
  expect(out.exitCode).toBe(expected.status);
  expect(out.stderr).toBe(stderrLines(expected.stderr));
  expect(repositoryState(oursDir)).toEqual(repositoryState(nativeDir));
  for (const f of options.files ?? []) {
    const a = existsSync(join(oursDir, f)) ? readFileSync(join(oursDir, f), "latin1") : undefined;
    const b = existsSync(join(nativeDir, f))
      ? readFileSync(join(nativeDir, f), "latin1")
      : undefined;
    expect(a).toBe(b);
  }
  return { expected, nativeDir, oursDir };
}

function emptyRepo(name: string): string {
  const dir = join(root, name);
  gitOk(root, root, "init", "-q", "-b", "main", dir);
  return dir;
}

describeGit("git fast-export against native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "fast-export-native-"));
    const version = gitOk(root, root, "--version");
    compatibility = /git version 2\.(\d+)/.exec(version)?.[1] === "43" ? "2.43" : "2.56";
    repo = join(root, "repo");
    gitOk(root, root, "init", "-q", "-b", "main", repo);
    // t9350's setup
    put(repo, "file0", "break it\n");
    g(repo, "add", "file0");
    put(repo, "file", "Wohlauf\n");
    g(repo, "add", "file");
    g(repo, "commit", "-q", "-m", "initial");
    put(repo, "file", "die Luft\n");
    put(repo, "file2", "geht frisch\n");
    g(repo, "add", "file", "file2");
    g(repo, "commit", "-q", "-m", "second");
    put(repo, "file2", "und\n");
    g(repo, "commit", "-q", "-m", "third", "file2");
    g(repo, "tag", "rein");
    g(repo, "checkout", "-q", "-b", "wer", "HEAD^");
    put(repo, "file2", "lange\n");
    g(repo, "commit", "-q", "-m", "sitzt", "file2");
    g(repo, "tag", "-a", "-m", "valentin", "muss");
    g(repo, "merge", "-q", "-s", "ours", "main");
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('t9350-fast-export.sh: "fast-export | fast-import"', async () => {
    const { stdout } = await exportTwin(["--all"]);
    await importTwin(emptyRepo("new"), stdout);
  });

  it('t9350-fast-export.sh: "fast-export ^muss^{commit} muss"', async () => {
    await exportTwin(["--tag-of-filtered-object=rewrite", "^muss^{commit}", "muss"]);
  });

  it('t9350-fast-export.sh: "fast-export --mark-tags ^muss^{commit} muss"', async () => {
    await exportTwin(["--mark-tags", "--tag-of-filtered-object=rewrite", "^muss^{commit}", "muss"]);
  });

  it('t9350-fast-export.sh: "fast-export main~2..main"', async () => {
    await exportTwin(["main~2..main"]);
  });

  it('t9350-fast-export.sh: "fast-export --reference-excluded-parents main~2..main"', async () => {
    await exportTwin(["--reference-excluded-parents", "main~2..main"]);
  });

  it('t9350-fast-export.sh: "fast-export --show-original-ids"', async () => {
    await exportTwin(["--show-original-ids", "main"]);
    await exportTwin(["--show-original-ids", "main", "muss"]);
  });

  it('t9350-fast-export.sh: "import/export-marks"', async () => {
    await exportTwin(["--export-marks=tmp-marks", "HEAD"]);
    gitIn(repo, ["fast-export", "--export-marks=tmp-marks", "HEAD"]);
    await exportTwin(["--import-marks=tmp-marks", "--export-marks=tmp-marks2", "HEAD"]);
    await exportTwin(["--import-marks=tmp-marks", "HEAD"]);
    await exportTwin([
      "--import-marks-if-exists=no-such-marks",
      "--export-marks=tmp-marks3",
      "main",
    ]);
  });

  it('t9350-fast-export.sh: "fast-export | fast-import when main is tagged"', async () => {
    g(repo, "tag", "-m", "msg", "last");
    await exportTwin(["-C", "-C", "--signed-tags=strip", "--all"].filter((a) => a !== "-C"));
    g(repo, "tag", "-d", "last");
  });

  it('t9350-fast-export.sh: "signed-tags=abort", "signed-tags=verbatim", "signed-tags=warn", "signed-tags=strip", "signed-tags=warn-strip"', async () => {
    const head = gitOk(root, repo, "rev-parse", "HEAD").trim();
    const signed = `object ${head}\ntype commit\ntag sign-your-name\ntagger C O Mitter <committer@example.com> 1112911993 -0700\n\nA message for a sign\n-----BEGIN PGP SIGNATURE-----\nVersion: GnuPG v1.4.5 (GNU/Linux)\n\nfakedsignaturefakedsignaturefakedsignaturefakedsignaturfakedsign\naturefakedsignaturefake=\n=/59v\n-----END PGP SIGNATURE-----\n`;
    const id = gitIn(repo, ["mktag"], signed).stdout.trim();
    g(repo, "update-ref", "refs/tags/sign-your-name", id);
    // git 2.43 knows no `warn-verbatim` (its `warn` is that mode)
    const modes = ["abort", "verbatim", "warn", "strip", "warn-strip"];
    if (compatibility !== "2.43") modes.push("warn-verbatim");
    for (const mode of modes) {
      await exportTwin([`--signed-tags=${mode}`, "sign-your-name"]);
    }
    g(repo, "update-ref", "-d", "refs/tags/sign-your-name");
  });

  it('t9350-fast-export.sh: "signed-commits default is same as strip", "signed-commits=abort", "signed-commits=verbatim", "signed-commits=warn-verbatim", "signed-commits=strip", "signed-commits=warn-strip"', async () => {
    const dir = join(root, "signed");
    execFileSync("cp", ["-a", repo, dir]);
    const head = gitOk(root, dir, "rev-parse", "HEAD").trim();
    const tree = gitOk(root, dir, "rev-parse", "HEAD^{tree}").trim();
    const signed = `tree ${tree}\nparent ${head}\nauthor A U Thor <author@example.com> 1112912473 -0700\ncommitter C O Mitter <committer@example.com> 1112912473 -0700\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n fakedsignature\n -----END PGP SIGNATURE-----\n\nsigned commit\n`;
    const id = gitIn(dir, ["hash-object", "-t", "commit", "-w", "--stdin"], signed).stdout.trim();
    g(dir, "update-ref", "refs/heads/signed", id);
    const { stdout } = await exportTwin(["signed~1..signed"], dir);
    // the signature modes are git 2.50+ (2.43 strips signatures without an option)
    if (compatibility === "2.43") {
      await importTwin(dir, stdout.replace(/refs\/heads\/signed/g, "refs/heads/copy"));
      return;
    }
    for (const mode of ["abort", "verbatim", "warn-verbatim", "strip", "warn-strip"]) {
      await exportTwin([`--signed-commits=${mode}`, "signed~1..signed"], dir);
    }
    const verbatim = gitIn(dir, [
      "fast-export",
      "--signed-commits=verbatim",
      "--reference-excluded-parents",
      "signed~1..signed",
    ]).stdout;
    const copy = verbatim.replace(/refs\/heads\/signed/g, "refs/heads/copy");
    for (const mode of [
      [],
      ["--signed-commits=strip"],
      ["--signed-commits=warn-strip"],
      ["--signed-commits=abort"],
      ["--signed-commits=warn-verbatim"],
    ]) {
      await importTwin(dir, copy, mode);
    }
  });

  it('t9350-fast-export.sh: "fast-export | fast-import" (ours both ways)', async () => {
    const git = await openOurs(repo);
    const out = await git
      .fastExport()
      .addArgument("--all")
      .setCompatibility(compatibility)
      .callOutput();
    const target = emptyRepo("ours-both");
    const ours = await openOurs(target);
    const r = await ours
      .fastImport()
      .setInput(out.stdout)
      .setCompatibility(compatibility)
      .callOutput();
    expect(r.exitCode).toBe(0);
    const refs = (d: string) =>
      gitIn(d, ["for-each-ref", "--format=%(refname) %(objectname)"]).stdout;
    expect(refs(target)).toBe(refs(repo));
  });

  it('t9350-fast-export.sh: "cope with tagger-less tags"', async () => {
    const head = gitOk(root, repo, "rev-parse", "HEAD").trim();
    const id = gitIn(
      repo,
      ["mktag", "--no-strict"],
      `object ${head}\ntype commit\ntag tagger-less\n\nno tagger\n`,
    ).stdout.trim();
    g(repo, "update-ref", "refs/tags/tagger-less", id);
    await exportTwin(["tagger-less"]);
    await exportTwin(["--fake-missing-tagger", "tagger-less"]);
    g(repo, "update-ref", "-d", "refs/tags/tagger-less");
  });

  it('t9350-fast-export.sh: "tree_tag", "tree_tag-obj", "tag-obj_tag", "tag-obj_tag-obj", "handling tags of blobs", "handling nested tags"', async () => {
    const dir = join(root, "tags");
    execFileSync("cp", ["-a", repo, dir]);
    const tree = gitOk(root, dir, "rev-parse", "HEAD^{tree}").trim();
    g(dir, "tag", "-a", "-m", "tagging a tree", "tree_tag-obj", tree);
    g(dir, "tag", "-a", "-m", "tagging a tag", "tag-obj_tag-obj", "muss");
    g(dir, "tag", "tree_tag", tree);
    g(dir, "tag", "tag-obj_tag", "muss");
    await exportTwin(["tree_tag"], dir);
    await exportTwin(["tree_tag-obj"], dir);
    await exportTwin(["tag-obj_tag"], dir);
    await exportTwin(["tag-obj_tag-obj"], dir);
    await exportTwin(["--mark-tags", "tag-obj_tag-obj"], dir);
    const blob = gitIn(dir, ["hash-object", "-w", "--stdin"], "die Luft\n").stdout.trim();
    g(dir, "tag", "-a", "-m", "Tag of a blob", "blobtag", blob);
    await exportTwin(["blobtag"], dir);
    // handling nested tags
    g(dir, "tag", "-m", "nested", "nested", "tag-obj_tag-obj");
    await exportTwin(["--mark-tags", "nested"], dir);
    await exportTwin(["--mark-tags", "--all"], dir);
  });

  it('t9350-fast-export.sh: "use refspec", "delete refspec", "delete ref because entire history excluded"', async () => {
    await exportTwin(
      ["--refspec", "refs/heads/main:refs/heads/foobar", "main"].flatMap((a) =>
        a === "--refspec" ? [] : [a.startsWith("refs/") ? `--refspec=${a}` : a],
      ),
    );
    await exportTwin(["--refspec=:refs/heads/to-delete"]);
    await exportTwin(["main", "^main"]);
    await exportTwin(["--reference-excluded-parents", "main", "^main"]);
  });

  it('t9350-fast-export.sh: "full-tree re-shows unmodified files"', async () => {
    await exportTwin(["--full-tree", "main"]);
    await exportTwin(["--no-data", "--use-done-feature", "--progress=2", "wer"]);
  });

  it('t9350-fast-export.sh: "avoid uninteresting refs", "refs are updated even if no commits need to be exported"', async () => {
    gitIn(repo, ["fast-export", "--export-marks=tmp-marks-u", "main"]);
    await exportTwin(["--import-marks=tmp-marks-u", "main", "wer"]);
    await exportTwin(["--import-marks=tmp-marks-u", "main"]);
  });

  it('t9350-fast-export.sh: "reencoding iso-8859-7", "aborting on iso-8859-7", "preserving iso-8859-7"', async () => {
    const dir = join(root, "i18n");
    execFileSync("cp", ["-a", repo, dir]);
    g(dir, "config", "i18n.commitencoding", "iso-8859-7");
    put(dir, "file", "rosten\n");
    put(dir, "msg", Buffer.from("Pi \xf0 in iso-8859-7\n", "latin1"));
    g(dir, "commit", "-q", "-F", "msg", "file");
    await exportTwin(["--reencode=yes", "wer^..wer"], dir);
    await exportTwin(["--reencode=abort", "wer^..wer"], dir);
    await exportTwin(["--reencode=no", "wer^..wer"], dir);
  });

  it('t9350-fast-export.sh: "directory becomes symlink", "fast-export quotes pathnames"', async () => {
    const dir = join(root, "paths");
    gitOk(root, root, "init", "-q", "-b", "main", dir);
    put(dir, "foo/world", "hello\n");
    put(dir, "bar/world", "bye\n");
    put(dir, "path with spaces", "a\n");
    put(dir, 'path with "quote"', "b\n");
    put(dir, "path with\nnewline", "c\n");
    put(dir, "café", "d\n");
    g(dir, "add", ".");
    g(dir, "commit", "-q", "-m", "paths");
    g(dir, "rm", "-q", "-r", "foo");
    execFileSync("ln", ["-s", "bar", join(dir, "foo")]);
    g(dir, "add", "foo");
    g(dir, "commit", "-q", "-m", "symlink");
    const blob = gitOk(root, dir, "rev-parse", "HEAD:bar/world").trim();
    g(dir, "update-index", "--add", "--cacheinfo", `160000,${blob.replace(/./, "1")},sub`);
    g(dir, "commit", "-q", "-m", "gitlink");
    const { stdout } = await exportTwin(["main"], dir);
    await importTwin(emptyRepo("paths-import"), stdout);
  });
});

describeGit("git fast-import against native git", () => {
  let base: string;
  let commitA: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "fast-import-native-"));
    const version = gitOk(root, root, "--version");
    compatibility = /git version 2\.(\d+)/.exec(version)?.[1] === "43" ? "2.43" : "2.56";
    base = emptyRepo("base");
    put(base, "a.txt", "a\n");
    g(base, "add", ".");
    g(base, "commit", "-q", "-m", "A");
    commitA = gitOk(root, base, "rev-parse", "HEAD").trim();
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const C = "committer C O Mitter <committer@example.com> 1112912473 -0700";
  const A = "author A U Thor <author@example.com> 1112912473 -0700";

  it('t9300-fast-import.sh: "A: create pack from stdin"', async () => {
    const stream = `blob
mark :2
data <<EOF
file2
second line of EOF
EOF

blob
mark :3
data <<END
file3 data
END

blob
mark :4
data 9
file4 tgz
commit refs/heads/main
mark :5
${C}
data <<COMMIT
initial
COMMIT

M 644 :2 file2
M 644 :3 file3
M 755 :4 file4

tag series-A
from :5
data <<EOF
An annotated tag without a tagger
EOF

tag series-A-blob
from :3
data <<EOF
An annotated tag that annotates a blob.
EOF
`;
    await importTwin(emptyRepo("a"), stream, ["--export-marks=marks.out"], {
      files: ["marks.out"],
    });
  });

  it('t9300-fast-import.sh: "A: verify marks import", "A: tag blob by sha1"', async () => {
    const stream = `commit refs/heads/verify--import-marks
${C}
data <<COMMIT
recreate from :5
COMMIT

from :5
M 755 :2 copy-of-file2

`;
    const { nativeDir, oursDir } = await importTwin(
      emptyRepo("a2"),
      "blob\nmark :2\ndata 3\nab\ncommit refs/heads/main\nmark :5\n" +
        `${C}\ndata 2\nx\nM 644 :2 file2\n`,
      ["--export-marks=marks.out"],
      { files: ["marks.out"] },
    );
    for (const dir of [nativeDir, oursDir])
      execFileSync("cp", [join(dir, "marks.out"), join(dir, "marks.in")]);
    // the second import over each twin's own marks
    const native2 = gitIn(nativeDir, ["fast-import", "--quiet", "--import-marks=marks.in"], stream);
    const git = await openOurs(oursDir);
    const ours2 = await git
      .fastImport()
      .setInput(stream)
      .setImportMarks("marks.in")
      .setMarksFiles(marksFiles(oursDir))
      .callOutput();
    expect(ours2.exitCode).toBe(native2.status);
    expect(repositoryState(oursDir)).toEqual(repositoryState(nativeDir));
  });

  it(`t9300-fast-import.sh: "B: fail on invalid blob sha1", 'B: accept branch name "TEMP_TAG"'`, async () => {
    await importTwin(
      base,
      `commit refs/heads/branch\nmark :1\n${C}\ndata <<COMMIT\ncorrupt\nCOMMIT\n\nfrom refs/heads/main\nM 755 0000000000000000000000000000000000000001 zero1\n\n`,
    );
    await importTwin(
      base,
      `commit TEMP_TAG\n${C}\ndata <<COMMIT\ntag base\nCOMMIT\n\nfrom refs/heads/main\n\n`,
    );
  });

  it('t9300-fast-import.sh: "B: fail on invalid file path of .", "B: fail on invalid file path of .."', async () => {
    for (const path of [".", "..", "a/./b", ".git/x"]) {
      await importTwin(
        base,
        `commit refs/heads/invalid\n${C}\ndata <<COMMIT\nbad\nCOMMIT\nfrom refs/heads/main\nM 100644 inline ${path}\ndata 4\nbad\n\n`,
      );
    }
  });

  it('t9300-fast-import.sh: "C: incremental import create pack from stdin", "C: validate rename result"', async () => {
    const stream = `blob
mark :6
data 10
newdata!!
commit refs/heads/branch
${C}
data <<COMMIT
second
COMMIT

from refs/heads/main
M 644 :6 file2/newf
M 644 inline file2/oldf
data <<EOF
old
EOF
R a.txt renamed
C renamed copied
D nonexistent

`;
    await importTwin(base, stream);
  });

  it('t9300-fast-import.sh: "E: rfc2822 date, --date-format=raw", "E: rfc2822 date, --date-format=rfc2822"', async () => {
    const stream = `commit refs/heads/branch
author ${"A U Thor <author@example.com> Tue Feb 6 11:22:18 2007 -0500"}
committer ${"C O Mitter <committer@example.com> Tue Feb 6 12:35:02 2007 -0500"}
data <<COMMIT
RFC 2822 type date
COMMIT

from refs/heads/main

`;
    await importTwin(base, stream);
    await importTwin(base, stream, ["--date-format=rfc2822"]);
  });

  it('t9300-fast-import.sh: "F: non-fast-forward update skips", "F: verify other commit"', async () => {
    const stream = `commit refs/heads/main
${C}
data <<COMMIT
losing things already?
COMMIT

from ${commitA}^0
M 644 inline other
data 6
other

reset refs/heads/other
from ${commitA}

`;
    await importTwin(base, stream.replace(`from ${commitA}^0\n`, ""));
    await importTwin(base, stream.replace(`from ${commitA}^0\n`, ""), ["--force"]);
    await importTwin(base, stream);
  });

  it('t9300-fast-import.sh: "H: deletall, add 1", "I: export-pack-edges", "K: reinit branch with from"', async () => {
    const stream = `commit refs/heads/H
${C}
data <<COMMIT
third
COMMIT

from refs/heads/main
deleteall
M 644 inline h/e/l/lo
data <<EOF
$file5_data
EOF
D h/e/l/lo

commit refs/heads/K
${C}
data 2
K
from refs/heads/main

commit refs/heads/K
${C}
data 2
K
from refs/heads/main

`;
    await importTwin(base, stream);
  });

  it('t9300-fast-import.sh: "L: verify internal tree sorting", "M: rename subdirectory to new subdirectory", "N: copy directory by id"', async () => {
    const stream = `blob
mark :1
data <<EOF
some data
EOF

blob
mark :2
data <<EOF
other data
EOF

commit refs/heads/L
${C}
data <<COMMIT
create L
COMMIT

M 644 :1 b.
M 644 :1 b/other
M 644 :1 ba

commit refs/heads/L
${C}
data <<COMMIT
update L
COMMIT

M 644 :2 b.
M 644 :2 b/other
M 644 :2 ba
R b dir/b
C dir/b dir2
M 040000 4b825dc642cb6eb9a060e54bf8d69288fbee4904 dir

commit refs/heads/N
${C}
data 2
N
from refs/heads/L
C "dir2" "new dir"
M 040000 ${"4b825dc642cb6eb9a060e54bf8d69288fbee4904"} "new dir"
C ba ""

`;
    await importTwin(emptyRepo("l"), stream);
  });

  it('t9300-fast-import.sh: "F: non-fast-forward update skips" (through the symbolic ref HEAD)', async () => {
    const stream = `commit HEAD\n${C}\ndata 2\nH\nfrom refs/heads/main\nM 644 inline f\ndata 2\nf\n\nreset HEAD\nfrom refs/heads/main\n\n`;
    await importTwin(base, stream);
    await importTwin(base, `commit HEAD\n${C}\ndata 2\nH\nM 644 inline f\ndata 2\nf\n\n`, [
      "--force",
    ]);
    const head = (d: string) => readFileSync(join(d, ".git/HEAD"), "latin1");
    const { nativeDir, oursDir } = await importTwin(
      base,
      `commit HEAD\n${C}\ndata 2\nH\nfrom refs/heads/main\nM 644 inline g\ndata 2\ng\n\n`,
    );
    expect(head(oursDir)).toBe(head(nativeDir));
  });

  it('t9300-fast-import.sh: "O: comments are all skipped", "P: superproject & submodule mix", "Q: commit notes" (merge)', async () => {
    const stream = `#we will
commit refs/heads/O1
# -- ignore all of this text
${C}
data <<COMMIT
dirty directory copy
COMMIT

# do not forget the import blank line!
#
# yes, we started from our usual base of branch^0.
# i like branch^0.
from refs/heads/main
# and we need to reuse file2/file5 from topic2:
M 644 inline file2/file5
data 6
file5

commit refs/heads/O2
${C}
data 4
O2
from refs/heads/main
merge refs/heads/O1
M 160000 ${"1".repeat(40)} sub

`;
    await importTwin(base, stream);
  });

  it('t9300-fast-import.sh: "S: initialize for S tests", "S: filemodify with garbage after mark must fail", "S: from with garbage after mark must fail"', async () => {
    await importTwin(
      base,
      `blob\nmark :1\ndata 2\nx\ncommit refs/heads/S\nmark :2\n${C}\ndata 2\nS\nM 100644 :1x file\n\n`,
    );
    await importTwin(base, `commit refs/heads/S\nmark :2\n${C}\ndata 2\nS\nfrom :1x\n\n`);
    await importTwin(base, `commit refs/heads/S\n${C}\ndata 2\nS\nfrom :1\n\n`);
    await importTwin(base, `commit refs/heads/S\ndata 2\nS\n\n`);
    await importTwin(
      base,
      `blob\nmark :1\ndata 2\nx\ncommit refs/heads/S\n${C}\ndata 2\nS\nM 777 :1 file\n\n`,
    );
    await importTwin(base, `commit refs/heads/S\n${A}x\n${C}\ndata 2\nS\n\n`);
    await importTwin(base, `bogus command\n`);
  });

  it(`t9300-fast-import.sh: "R: abort on unsupported feature", "R: export-marks feature forbidden by default", 'R: feature done means terminating "done" is mandatory'`, async () => {
    await importTwin(base, "feature no-such-feature-exists\n");
    await importTwin(base, "feature export-marks=git.marks\n");
    await importTwin(base, "feature done\nblob\ndata 2\nx\n");
    await importTwin(base, "feature done\nblob\ndata 2\nx\ndone\n");
    await importTwin(base, "blob\ndata 2\nx\n", ["--done"]);
    await importTwin(base, "blob\ndata 2\nx\nfeature force\n");
    await importTwin(
      base,
      "option git quiet\noption foo bar\nprogress one\nblob\nmark :1\ndata 2\nx\nget-mark :1\ncat-blob :1\nprogress two\n",
    );
  });

  it('t9300-fast-import.sh: "R: export-marks feature results in a marks file being created", "R: feature import-marks-if-exists"', async () => {
    await importTwin(
      base,
      "feature export-marks=git.marks\nblob\nmark :1\ndata 3\nhi\n\n",
      ["--allow-unsafe-features"],
      { files: ["git.marks"] },
    );
    await importTwin(
      base,
      "feature import-marks-if-exists=no.marks\nfeature export-marks=io.marks\nblob\nmark :1\ndata 3\nhi\n\n",
      ["--allow-unsafe-features"],
      { files: ["io.marks"] },
    );
  });

  it('t9300-fast-import.sh: "Q: deny note on empty branch" (tag of reset branch), "W: get-mark & ls"', async () => {
    const stream = `blob
mark :1
data 3
hi
commit refs/heads/W
mark :2
${C}
data 2
W
M 644 :1 dir/file
ls "dir/file"
ls "missing"
ls dir

ls :2 dir/file
ls ${commitA} a.txt
tag W1
from :2
${"tagger T A Gger <tagger@example.com> 1112912473 -0700"}
data 3
w1
reset refs/tags/W1
from 0000000000000000000000000000000000000000

reset refs/heads/gone
from refs/heads/main

checkpoint

`;
    await importTwin(base, stream);
  });
});
