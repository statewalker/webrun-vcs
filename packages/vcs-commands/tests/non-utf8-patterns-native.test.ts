/**
 * Pattern files and patches with bytes that are no valid UTF-8, against native git: a
 * `.gitignore`, `info/exclude`, `core.excludesFile` and `.gitattributes` written in latin-1
 * match the same path bytes as in git (`caf\xe9.txt` ignores `caf\xe9.txt`, never the UTF-8
 * `café.txt`), so status, clean and add agree with git and `add` stores the blobs git stores;
 * a patch naming latin-1 paths, C-quoted (`"caf\351.txt"`) or raw (`core.quotePath=false`),
 * parses to the paths as trees and the index hold them and applies to the right file; and
 * the text forms of diff and status give git's bytes back through `encodeGitPath`. Twins are
 * built by the same steps (never copied).
 */

import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createFileWorktree,
  createGitFilesBackend,
  FileStagingStore,
  GitCheckout,
  type GitCheckoutFilesApi,
  GitWorkingCopyConfig,
} from "@statewalker/vcs-store-files";
import { Patch, PatchApplier } from "@statewalker/vcs-utils/diff";
import { decodeGitPath, encodeGitPath, unquoteGitPath } from "@statewalker/vcs-utils/encoding";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { type GitContentFilter, MemoryWorkingCopy } from "@statewalker/vcs-working-tree";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { formatStatusPorcelain, Git } from "../src/index.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root: string;
let counter = 0;

/** Native git's stdout as bytes. */
function gitBytes(cwd: string, ...args: string[]): Buffer {
  return execFileSync("git", args, {
    cwd,
    env: nativeGitEnv(root),
    stdio: ["ignore", "pipe", "pipe"],
  });
}
const gitText = (cwd: string, ...args: string[]) => gitBytes(cwd, ...args).toString("latin1");

/** A path given as latin-1 text (each char one byte), as a Buffer for node:fs. */
const raw = (path: string) => Buffer.from(path, "latin1");
/** The same path as our commands name it. */
const ours = (path: string) => decodeGitPath(raw(path));
const full = (dir: string, path: string) => Buffer.concat([raw(`${dir}/`), raw(path)]);

/** Writes `content` (latin-1 text, or bytes) at the latin-1 `path`. */
function putRaw(dir: string, path: string, content: string | Uint8Array) {
  const at = full(dir, path);
  mkdirSync(at.subarray(0, at.lastIndexOf(0x2f)), { recursive: true });
  writeFileSync(at, typeof content === "string" ? raw(content) : content);
}

/** The files under `dir` (but `.git`), as latin-1 relative paths. */
function listFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  const at = prefix ? full(dir, prefix) : Buffer.from(dir);
  for (const entry of readdirSync(at, { encoding: "buffer", withFileTypes: true })) {
    const name = entry.name.toString("latin1");
    if (!prefix && name === ".git") continue;
    const rel = prefix ? `${prefix}/${name}` : name;
    if (entry.isDirectory()) out.push(...listFiles(dir, rel));
    else out.push(rel);
  }
  return out.sort();
}

/** A repository at `dir`, opened as a working copy with the host's global files. */
async function open(dir: string): Promise<Git> {
  const files = createNodeFilesApi({ rootDir: dir });
  const { history } = await createGitFilesBackend({ files });
  const io = {
    read: async (path: string) => {
      try {
        return new Uint8Array(readFileSync(join(dir, path)));
      } catch {
        return undefined;
      }
    },
    write: async (path: string, content: Uint8Array) => writeFileSync(join(dir, path), content),
  };
  const environment = createNodeGitHostEnvironment({
    home: root,
    xdgConfigHome: join(root, ".config"),
    env: { GIT_CONFIG_NOSYSTEM: "1", GIT_ATTR_NOSYSTEM: "1" },
  });
  const config = new GitWorkingCopyConfig(io, ".git/config", {
    environment,
    gitDirPath: join(dir, ".git"),
  });
  await config.load();
  const staging = new FileStagingStore(files, ".git/index");
  await staging.read();
  const checkout = new GitCheckout({
    staging,
    refs: history.refs,
    files: {
      read: io.read,
      write: (p: string, c: Uint8Array) => files.write(p, [c]),
      stats: async () => undefined,
      remove: async () => {},
    } as unknown as GitCheckoutFilesApi,
    gitDir: ".git",
  });
  const worktree = createFileWorktree({
    files,
    rootPath: "",
    gitDir: ".git",
    blobs: history.blobs,
    trees: history.trees,
  });
  return Git.fromWorkingCopy(new MemoryWorkingCopy({ history, checkout, worktree, config }));
}

/**
 * The blob at `path` (as our commands name it) in `rev`: its bytes go to git on stdin, as a
 * command-line argument would be UTF-8.
 */
function catBlob(dir: string, rev: string, path: string): Buffer {
  const out = execFileSync("git", ["cat-file", "--batch"], {
    cwd: dir,
    env: nativeGitEnv(root),
    input: Buffer.concat([raw(`${rev}:`), Buffer.from(encodeGitPath(path)), raw("\n")]),
  });
  const eol = out.indexOf(0x0a);
  const size = Number(out.subarray(0, eol).toString("latin1").split(" ")[2]);
  expect(Number.isNaN(size), out.subarray(0, eol).toString("latin1")).toBe(false);
  return out.subarray(eol + 1, eol + 1 + size);
}

/** Paths of `git clean -n` output ("Would remove <path>"), unquoted, as our commands name them. */
function cleanPaths(output: Buffer): string[] {
  const out: string[] = [];
  const prefix = raw("Would remove ");
  let start = 0;
  while (start < output.length) {
    let end = output.indexOf(0x0a, start);
    if (end < 0) end = output.length;
    const line = output.subarray(start, end);
    if (line.subarray(0, prefix.length).equals(prefix)) {
      const body = line.subarray(prefix.length);
      const quoted = unquoteGitPath(body);
      out.push(quoted ? quoted.path : decodeGitPath(body));
    }
    start = end + 1;
  }
  return out.sort();
}

/** The ignore files of the repository: latin-1 rules in each of git's sources. */
function writeIgnoreRules(dir: string) {
  // a BOM before the first rule (git skips it), literal and glob rules, a negation, a
  // directory-only rule, a class
  putRaw(dir, ".gitignore", "\xef\xbb\xbfcaf\xe9.txt\nd\xff/\n*.log\n!k\xe9ep.log\n");
  putRaw(dir, "sub/.gitignore", "*\xe9*\n");
  putRaw(dir, ".git/info/exclude", "x\xe9\n");
  putRaw(dir, ".git/my-excludes", "y[\xe9]\n");
  gitBytes(dir, "config", "core.excludesFile", join(dir, ".git", "my-excludes"));
}

/** The worktree files the rules decide about. */
function writeIgnoreFiles(dir: string) {
  for (const path of [
    "caf\xe9.txt",
    "d\xff/a",
    "k\xe9ep.log",
    "other.log",
    "sub/m\xe9m",
    "sub/plain",
    "x\xe9",
    "y\xe9",
    "z",
  ]) {
    putRaw(dir, path, `${path}\n`);
  }
  // the UTF-8 "café.txt" is other bytes than the latin-1 rule: not ignored
  writeFileSync(join(dir, "café.txt"), "utf-8\n");
}

function buildIgnoreRepo(): string {
  const dir = join(root, `ignore-${counter++}`);
  mkdirSync(dir);
  gitBytes(dir, "init", "-q", "-b", "main");
  putRaw(dir, "plain.txt", "plain\n");
  gitBytes(dir, "add", "plain.txt");
  gitBytes(dir, "commit", "-q", "-m", "base");
  writeIgnoreRules(dir);
  writeIgnoreFiles(dir);
  return dir;
}

describeGit("pattern files and patches with bytes that are no UTF-8, against native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "non-utf8-patterns-"));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("latin-1 ignore rules: status --ignored agrees with git", async () => {
    const dir = buildIgnoreRepo();
    const expected = gitBytes(dir, "status", "--porcelain", "--ignored", "--untracked-files=all");
    // the latin-1 names the rules ignore, and the UTF-8 one they leave
    expect(expected.toString("latin1")).toContain('!! "caf\\351.txt"\n');
    expect(expected.toString("latin1")).toContain('?? "caf\\303\\251.txt"\n');
    expect(expected.toString("latin1")).toContain('?? "k\\351ep.log"\n');
    const git = await open(dir);
    const status = await git.status().setUntrackedFiles("all").setIgnored(true).call();
    expect(Buffer.from(encodeGitPath(formatStatusPorcelain(status))).toString("latin1")).toBe(
      expected.toString("latin1"),
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it("latin-1 ignore rules: clean -n, -n -d, -n -X -d and -f -X -d agree with git", async () => {
    const dir = buildIgnoreRepo();
    const runs: { args: string[]; set: (c: ReturnType<Git["clean"]>) => void }[] = [
      { args: ["-n"], set: () => {} },
      { args: ["-n", "-d"], set: (c) => c.setCleanDirectories(true) },
      { args: ["-n", "-X", "-d"], set: (c) => c.setCleanDirectories(true).setIgnoredOnly(true) },
      { args: ["-n", "-x"], set: (c) => c.setIgnore(false) },
    ];
    for (const run of runs) {
      const expected = cleanPaths(gitBytes(dir, "clean", ...run.args));
      const git = await open(dir);
      const command = git.clean().setDryRun(true);
      run.set(command);
      const result = await command.call();
      // a directory shows with its trailing slash in git's output
      const got = [...result.cleaned].map((p) => p.replace(/\/?$/, "")).sort();
      expect(got, run.args.join(" ")).toEqual(expected.map((p) => p.replace(/\/$/, "")).sort());
    }
    // and for real: the ignored files go, the others stay, in both twins
    const twin = buildIgnoreRepo();
    gitBytes(dir, "clean", "-f", "-X", "-d");
    const git = await open(twin);
    await git.clean().setDryRun(false).setCleanDirectories(true).setIgnoredOnly(true).call();
    expect(listFiles(twin)).toEqual(listFiles(dir));
    expect(listFiles(dir)).toContain("k\xe9ep.log");
    expect(listFiles(dir)).not.toContain("caf\xe9.txt");
    for (const d of [dir, twin]) rmSync(d, { recursive: true, force: true });
  });

  it("latin-1 ignore rules: add . stages what git add -A stages", async () => {
    const native = buildIgnoreRepo();
    const twin = buildIgnoreRepo();
    gitBytes(native, "add", "-A");
    const git = await open(twin);
    await git.add().addFilepattern(".").call();
    expect(gitText(twin, "ls-files", "-s")).toBe(gitText(native, "ls-files", "-s"));
    expect(gitText(native, "ls-files")).not.toContain("caf\\351.txt");
    for (const d of [native, twin]) rmSync(d, { recursive: true, force: true });
  });

  it("latin-1 attribute patterns: add stores the blobs git stores (text, eol, ident)", async () => {
    const build = () => {
      const dir = join(root, `attr-${counter++}`);
      mkdirSync(dir);
      gitBytes(dir, "init", "-q", "-b", "main");
      // a BOM first (skipped), then patterns in latin-1 bytes
      putRaw(
        dir,
        ".gitattributes",
        "\xef\xbb\xbfcaf\xe9.txt text\n*\xe9.crlf text eol=crlf\nd\xff/** ident\n",
      );
      putRaw(dir, "caf\xe9.txt", "a\r\nb\r\n");
      putRaw(dir, "x\xe9.crlf", "c\r\nd\r\n");
      // UTF-8 names: other bytes, no attributes
      writeFileSync(join(dir, "café.txt"), "a\r\nb\r\n");
      writeFileSync(join(dir, "xé.crlf"), "c\r\nd\r\n");
      putRaw(dir, "d\xff/f", "$Id: junk $\n");
      putRaw(dir, "plain", "$Id: junk $\n");
      return dir;
    };
    const native = build();
    const twin = build();
    gitBytes(native, "add", "-A");
    const git = await open(twin);
    await git.add().addFilepattern(".").call();
    const listing = gitText(native, "ls-files", "-s");
    expect(gitText(twin, "ls-files", "-s")).toBe(listing);
    // the latin-1 files normalised (LF, $Id$), the UTF-8 ones as they are
    const blob = (path: string) => catBlob(native, "", ours(path)).toString("latin1");
    expect(blob("caf\xe9.txt")).toBe("a\nb\n");
    expect(blob("caf\xc3\xa9.txt")).toBe("a\r\nb\r\n");
    expect(blob("d\xff/f")).toBe("$Id$\n");
    expect(blob("plain")).toBe("$Id: junk $\n");
    for (const d of [native, twin]) rmSync(d, { recursive: true, force: true });
  });

  /** Two commits changing latin-1 names: modified, added, renamed (and changed), spaced. */
  function buildPatchRepo(): string {
    const dir = join(root, `patch-${counter++}`);
    mkdirSync(dir);
    gitBytes(dir, "init", "-q", "-b", "main");
    const lines = (n: number, tag: string) =>
      Array.from({ length: n }, (_, i) => `${tag} line ${i}\n`).join("");
    putRaw(dir, "caf\xe9.txt", "one\ntwo\nthree\n");
    putRaw(dir, "old\xe9", lines(20, "moved"));
    putRaw(dir, "a b\xe9.txt", "spaced\n");
    putRaw(dir, "gone\xff", "deleted\n");
    gitBytes(dir, "add", "-A");
    gitBytes(dir, "commit", "-q", "-m", "base");
    putRaw(dir, "caf\xe9.txt", "one\n2\nthree\n");
    rmSync(full(dir, "old\xe9"));
    putRaw(dir, "ren\xe9 name", lines(20, "moved").replace("line 3\n", "line three\n"));
    putRaw(dir, "a b\xe9.txt", "spaced out\n");
    rmSync(full(dir, "gone\xff"));
    putRaw(dir, "n\xe9w", "new\n");
    gitBytes(dir, "add", "-A");
    gitBytes(dir, "commit", "-q", "-m", "change");
    return dir;
  }

  /** Parses `patch` and applies each file to the base commit: the new commit's files result. */
  async function applyToBase(dir: string, patch: Uint8Array) {
    const parsed = new Patch();
    parsed.parse(patch);
    expect(parsed.getErrors()).toEqual([]);
    const paths: [string | undefined, string | undefined][] = [];
    for (const file of parsed.getFiles()) {
      const oldPath = file.changeType === "ADD" ? undefined : (file.oldPath ?? undefined);
      const newPath = file.changeType === "DELETE" ? undefined : (file.newPath ?? undefined);
      paths.push([oldPath, newPath]);
      // the paths name the files of the commits: their bytes are the tree's
      const old = oldPath ? catBlob(dir, "HEAD~1", oldPath) : null;
      const result = await new PatchApplier().apply(file, old);
      expect(result.errors, `${oldPath} -> ${newPath}`).toEqual([]);
      if (newPath) {
        const expected = catBlob(dir, "HEAD", newPath);
        expect(Buffer.from(result.content ?? []).equals(expected)).toBe(true);
      }
    }
    return paths.sort((a, b) => String(a[1] ?? a[0]).localeCompare(String(b[1] ?? b[0])));
  }

  const expectedPaths = [
    [ours("a b\xe9.txt"), ours("a b\xe9.txt")],
    [ours("caf\xe9.txt"), ours("caf\xe9.txt")],
    [ours("gone\xff"), undefined],
    [undefined, ours("n\xe9w")],
    [ours("old\xe9"), ours("ren\xe9 name")],
  ].sort((a, b) => String(a[1] ?? a[0]).localeCompare(String(b[1] ?? b[0])));

  it("a patch git writes, quoted and with core.quotePath=false, applies to the right files", async () => {
    const dir = buildPatchRepo();
    const quoted = gitBytes(dir, "diff", "-M", "HEAD~1", "HEAD");
    expect(quoted.toString("latin1")).toContain('diff --git "a/caf\\351.txt" "b/caf\\351.txt"');
    expect(quoted.toString("latin1")).toContain('rename from "old\\351"');
    expect(await applyToBase(dir, quoted)).toEqual(expectedPaths);
    const unquoted = gitBytes(dir, "-c", "core.quotePath=false", "diff", "-M", "HEAD~1", "HEAD");
    expect(unquoted.toString("latin1")).toContain("diff --git a/caf\xe9.txt b/caf\xe9.txt");
    expect(await applyToBase(dir, unquoted)).toEqual(expectedPaths);
    rmSync(dir, { recursive: true, force: true });
  });

  it("a patch we write applies to the right files, here and in git (git apply --check)", async () => {
    for (const quotePath of [true, false]) {
      const dir = buildPatchRepo();
      if (!quotePath) gitBytes(dir, "config", "core.quotePath", "false");
      const git = await open(dir);
      const patch = await git.diff().setOldTree("HEAD~1").setNewTree("HEAD").callBytes();
      expect(Buffer.from(patch).toString("latin1")).toBe(gitText(dir, "diff", "HEAD~1", "HEAD"));
      expect(await applyToBase(dir, patch)).toEqual(expectedPaths);
      // native git takes our patch for the same files
      gitBytes(dir, "checkout", "-q", "HEAD~1");
      writeFileSync(join(root, "ours.patch"), patch);
      gitBytes(dir, "apply", "--index", join(root, "ours.patch"));
      expect(gitText(dir, "write-tree")).toBe(gitText(dir, "rev-parse", "main^{tree}"));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("diff and status text with core.quotePath=false give git's bytes through encodeGitPath", async () => {
    const dir = buildPatchRepo();
    gitBytes(dir, "config", "core.quotePath", "false");
    putRaw(dir, "caf\xe9.txt", "worktree \xe9dit\n");
    putRaw(dir, "untracked\xe9", "u\n");
    const git = await open(dir);
    const text = await git.diff().callText();
    // no U+FFFD: each byte that is no UTF-8 is an escape, the path as trees hold it
    expect(text).not.toContain("�");
    expect(text).toContain(`diff --git a/${ours("caf\xe9.txt")} b/${ours("caf\xe9.txt")}`);
    expect(Buffer.from(encodeGitPath(text)).equals(gitBytes(dir, "diff"))).toBe(true);
    const nameOnly = await (await open(dir)).diff().callText("name-only");
    expect(nameOnly).toBe(`${ours("caf\xe9.txt")}\n`);
    for (const version of [1, 2] as const) {
      const status = formatStatusPorcelain(
        await (await open(dir)).status().setUntrackedFiles("all").call(),
        version,
        {
          quotePath: false,
        },
      );
      expect(Buffer.from(encodeGitPath(status)).toString("latin1")).toBe(
        gitText(dir, "status", `--porcelain=v${version}`, "--untracked-files=all"),
      );
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("a conflicted merge lists latin-1 paths in MERGE_MSG as their bytes, in byte order", async () => {
    // "x\xe9" sorts before "x😀" (\xf0...) by bytes, after it by UTF-16 code units
    const emoji = Buffer.from("x😀").toString("latin1");
    const build = () => {
      const dir = join(root, `merge-${counter++}`);
      mkdirSync(dir);
      gitBytes(dir, "init", "-q", "-b", "main");
      for (const path of ["x\xe9", emoji, "plain"]) putRaw(dir, path, "base\n");
      gitBytes(dir, "add", "-A");
      gitBytes(dir, "commit", "-q", "-m", "base");
      gitBytes(dir, "checkout", "-q", "-b", "side");
      for (const path of ["x\xe9", emoji, "plain"]) putRaw(dir, path, "side\n");
      gitBytes(dir, "commit", "-q", "-am", "side");
      gitBytes(dir, "checkout", "-q", "main");
      for (const path of ["x\xe9", emoji, "plain"]) putRaw(dir, path, "main\n");
      gitBytes(dir, "commit", "-q", "-am", "main");
      return dir;
    };
    const native = build();
    const twin = build();
    try {
      gitBytes(native, "merge", "-q", "side");
    } catch {
      // the merge conflicts
    }
    const git = await openOurs(twin);
    await git.merge().include("side").call();
    const msg = (dir: string) => readFileSync(join(dir, ".git", "MERGE_MSG")).toString("latin1");
    expect(msg(native)).toContain(`#\tplain\n#\tx\xe9\n#\t${emoji}\n`);
    expect(msg(twin)).toBe(msg(native));
    for (const d of [native, twin]) rmSync(d, { recursive: true, force: true });
  });
});

/** `git check-attr -a` of `paths` (as our commands name them), by path: `name=value`, sorted. */
function nativeAttrs(dir: string, paths: string[]): Map<string, string[]> {
  const input = Buffer.concat(
    paths.map((p) => Buffer.concat([Buffer.from(encodeGitPath(p)), Buffer.from([0])])),
  );
  const out = execFileSync("git", ["check-attr", "-a", "-z", "--stdin"], {
    cwd: dir,
    env: nativeGitEnv(root),
    input,
  });
  const fields: Buffer[] = [];
  for (let start = 0; start < out.length; ) {
    const end = out.indexOf(0, start);
    fields.push(out.subarray(start, end));
    start = end + 1;
  }
  const result = new Map<string, string[]>(paths.map((p) => [p, []]));
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const path = decodeGitPath(fields[i]);
    result
      .get(path)
      ?.push(`${fields[i + 1].toString("latin1")}=${fields[i + 2].toString("latin1")}`);
  }
  for (const list of result.values()) list.sort();
  return result;
}

/** Our attributes of `paths`, as {@link nativeAttrs} lists them. */
async function ourAttrs(dir: string, paths: string[]): Promise<Map<string, string[]>> {
  const git = await open(dir);
  const filter = git.worktree?.contentFilter as GitContentFilter;
  const result = new Map<string, string[]>();
  for (const path of paths) {
    const attrs = await filter.attributes(path);
    result.set(
      path,
      [...attrs].map(([k, v]) => `${k}=${v === true ? "set" : v === false ? "unset" : v}`).sort(),
    );
  }
  return result;
}

describeGit("literal parts of patterns as bytes, and case folding as git folds it", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "non-utf8-literal-"));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /**
   * Rules whose literal parts end or start inside a UTF-8 sequence: `sub/caf\xc3*` (a path
   * prefix ending with the first byte of é, C3 A9), `*\xa9` (a suffix starting with its last
   * byte), `/t\xc3*` (anchored). git compares them byte by byte, so they take the UTF-8 é.
   */
  const halfRules = "sub/caf\xc3*\n*\xa9\n/t\xc3*\n";
  const halfFiles = [
    "sub/caf\xc3\xa9.txt",
    "sub/cafe.txt",
    "sub/caf\xe9.txt",
    "x\xc3\xa9",
    "x\xe9",
    "t\xc3\xa4",
    "sub/t\xc3\xa4",
    "plain",
  ];

  function buildRepo(rules: { ignore?: string; attributes?: string }, paths: string[]) {
    const dir = join(root, `literal-${counter++}`);
    mkdirSync(dir);
    gitBytes(dir, "init", "-q", "-b", "main");
    putRaw(dir, "base", "base\n");
    gitBytes(dir, "add", "base");
    gitBytes(dir, "commit", "-q", "-m", "base");
    if (rules.ignore !== undefined) putRaw(dir, ".gitignore", rules.ignore);
    if (rules.attributes !== undefined) putRaw(dir, ".gitattributes", rules.attributes);
    for (const path of paths) putRaw(dir, path, `${path}\n`);
    return dir;
  }

  it("ignore rules holding half of a UTF-8 sequence: status --ignored agrees with git", async () => {
    const dir = buildRepo({ ignore: halfRules }, halfFiles);
    const expected = gitBytes(dir, "status", "--porcelain", "--ignored", "--untracked-files=all");
    // git takes the UTF-8 names by their bytes
    expect(expected.toString("latin1")).toContain('!! "sub/caf\\303\\251.txt"\n');
    expect(expected.toString("latin1")).toContain('!! "x\\303\\251"\n');
    expect(expected.toString("latin1")).toContain('!! "t\\303\\244"\n');
    expect(expected.toString("latin1")).toContain('?? "sub/t\\303\\244"\n');
    const status = await (await open(dir))
      .status()
      .setUntrackedFiles("all")
      .setIgnored(true)
      .call();
    expect(Buffer.from(encodeGitPath(formatStatusPorcelain(status))).toString("latin1")).toBe(
      expected.toString("latin1"),
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it("attribute patterns holding half of a UTF-8 sequence: check-attr agrees with git", async () => {
    const attributes = "sub/caf\xc3* foo\n*\xa9 bar\n/t\xc3* baz\n";
    const dir = buildRepo({ attributes }, halfFiles);
    const paths = halfFiles.map(ours);
    const expected = nativeAttrs(dir, paths);
    expect(expected.get(ours("sub/caf\xc3\xa9.txt"))).toEqual(["foo=set"]);
    expect(expected.get(ours("x\xc3\xa9"))).toEqual(["bar=set"]);
    expect(expected.get(ours("t\xc3\xa4"))).toEqual(["baz=set"]);
    expect(await ourAttrs(dir, paths)).toEqual(expected);
    rmSync(dir, { recursive: true, force: true });
  });

  it("core.ignoreCase folds ASCII only: status --ignored and check-attr agree with git", async () => {
    // *.LOG takes a.log; É* (C3 89) never takes é (C3 A9): git folds no byte beyond ASCII
    const ignore = "*.LOG\nBUILD/\n\xc3\x89*\nD/X*\n";
    const attributes = "*.TXT foo\n\xc3\x89* bar\nD/Y* baz\n";
    const files = ["a.log", "b.txt", "build/out", "\xc3\xa9x", "\xc3\x89y", "d/x1", "d/y1", "keep"];
    const dir = buildRepo({ ignore, attributes }, files);
    gitBytes(dir, "config", "core.ignoreCase", "true");
    const expected = gitBytes(dir, "status", "--porcelain", "--ignored", "--untracked-files=all");
    expect(expected.toString("latin1")).toContain("!! a.log\n");
    expect(expected.toString("latin1")).toContain('?? "\\303\\251x"\n');
    expect(expected.toString("latin1")).toContain('!! "\\303\\211y"\n');
    const status = await (await open(dir))
      .status()
      .setUntrackedFiles("all")
      .setIgnored(true)
      .call();
    expect(Buffer.from(encodeGitPath(formatStatusPorcelain(status))).toString("latin1")).toBe(
      expected.toString("latin1"),
    );
    const paths = files.map(ours);
    const attrs = nativeAttrs(dir, paths);
    expect(attrs.get("b.txt")).toEqual(["foo=set"]);
    expect(attrs.get(ours("\xc3\xa9x"))).toEqual([]);
    expect(await ourAttrs(dir, paths)).toEqual(attrs);
    rmSync(dir, { recursive: true, force: true });
  });
});

describeGit("git directory pointers and configuration values that are no UTF-8", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "non-utf8-gitdir-"));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("a submodule whose gitdir: names a latin-1 directory: status agrees with git", async () => {
    const source = join(root, `source-${counter++}`);
    mkdirSync(source);
    gitBytes(source, "init", "-q", "-b", "main");
    putRaw(source, "f", "one\n");
    gitBytes(source, "add", "f");
    gitBytes(source, "commit", "-q", "-m", "one");
    const dir = join(root, `super-${counter++}`);
    mkdirSync(dir);
    gitBytes(dir, "init", "-q", "-b", "main");
    gitBytes(dir, "-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "sub");
    gitBytes(dir, "commit", "-q", "-m", "add sub");
    // the submodule's repository moves to a latin-1 name, its gitfile naming it in bytes
    renameSync(join(dir, ".git", "modules", "sub"), full(dir, ".git/modules/caf\xe9"));
    putRaw(dir, "sub/.git", "gitdir: ../.git/modules/caf\xe9\n");
    // a commit in the submodule: the superproject sees it modified
    putRaw(dir, "sub/f", "two\n");
    gitBytes(join(dir, "sub"), "commit", "-q", "-am", "two");
    const expected = gitText(dir, "status", "--porcelain");
    expect(expected).toBe(" M sub\n");
    const git = await open(dir);
    expect(git.worktree?.readGitlinkHead).toBeTypeOf("function");
    const head = await git.worktree?.readGitlinkHead?.("sub");
    expect(head).toBe(gitText(join(dir, "sub"), "rev-parse", "HEAD").trim());
    expect(formatStatusPorcelain(await git.status().call())).toBe(expected);
    rmSync(dir, { recursive: true, force: true });
    rmSync(source, { recursive: true, force: true });
  });

  it("a configuration rewrite keeps the bytes of a latin-1 value (core.worktree)", async () => {
    const dir = join(root, `config-${counter++}`);
    mkdirSync(dir);
    gitBytes(dir, "init", "-q", "-b", "main");
    const before = readFileSync(join(dir, ".git", "config"));
    writeFileSync(
      join(dir, ".git", "config"),
      Buffer.concat([before, raw("[core]\n\tworktree = /srv/caf\xe9\n")]),
    );
    const git = await open(dir);
    const config = git.workingCopy.config as GitWorkingCopyConfig;
    expect(config.get("core.worktree")).toBe(ours("/srv/caf\xe9"));
    config.set("user.name", "Someone");
    await config.save();
    expect(gitBytes(dir, "config", "--get", "core.worktree").equals(raw("/srv/caf\xe9\n"))).toBe(
      true,
    );
    expect(gitText(dir, "config", "--get", "user.name")).toBe("Someone\n");
    rmSync(dir, { recursive: true, force: true });
  });
});
