/**
 * `--pathspec-from-file` and `--pathspec-file-nul` of add, rm, restore, commit, checkout and
 * stash push against native git (pathspec.c `parse_pathspec_file` and each builtin's
 * refusals), ported from git's t3704, t3601, t2072, t7526, t2026 and t3909. Each case runs
 * native git in one copy of a repository and ours in another, then compares the exit status,
 * the messages (hints left out), the worktree, the index, status, the refs and the stash.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { CheckoutResult, Git } from "../src/index.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { gitOut, openRepo, putFile, testEnv } from "./status-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root: string;
const git = (cwd: string, args: string[]) => gitOut(root, cwd, args);

/** Every worktree path (outside `.git`) with its content. */
function listing(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (path === ".git") continue;
    if (entry.isDirectory()) {
      out.push(`${path}/`, ...listing(dir, path));
      continue;
    }
    out.push(`${path}: ${readFileSync(join(dir, path), "latin1")}`);
  }
  return out.sort();
}

/** The worktree, the index with its flags, status, the refs and the stash's changes. */
function stateOf(dir: string): string {
  const index = git(dir, ["ls-files", "-s", "--debug"])
    .split("\n")
    .filter((l) => !/^\s+(ctime|mtime|dev|uid|size):/.test(l))
    .join("\n");
  const stash = git(dir, ["for-each-ref", "refs/stash"]).trim()
    ? git(dir, ["stash", "show", "--name-status"])
    : "<no stash>";
  return [
    listing(dir).join("\n"),
    index,
    git(dir, ["status", "--porcelain", "-uall"]),
    git(dir, ["for-each-ref", "--format=%(objectname) %(refname)"]),
    git(dir, ["rev-parse", "HEAD"]),
    stash,
  ].join("\n----\n");
}

/** A copy of `template` for one run. */
function copyOf(template: string, name: string): string {
  const copy = join(root, name);
  rmSync(copy, { recursive: true, force: true });
  execFileSync("cp", ["-a", template, copy]);
  execFileSync("git", ["update-index", "-q", "--refresh"], { cwd: copy, env: testEnv(root) });
  return copy;
}

/** Native git's stderr without hints and empty lines (and its 129 usage text ignored). */
const nativeLines = (stderr: string) =>
  stderr
    .split("\n")
    .filter((l) => l !== "" && !l.startsWith("hint:"))
    .join("\n");

interface Outcome {
  status: number;
  stderr: string;
}

/** Ours as git ends: exit status and messages (a checkout result's warnings included). */
async function runOurs(repo: Git, run: (git: Git) => Promise<unknown>): Promise<Outcome> {
  try {
    const result = (await run(repo)) as Partial<CheckoutResult> | undefined;
    if (result && typeof result === "object" && "status" in result) {
      const lines: string[] = [];
      const warnings = result.warnings ?? [];
      lines.push(...warnings.filter((l) => l.startsWith("warning:")));
      if (result.message) lines.push(...result.message.split("\n"));
      lines.push(...warnings.filter((l) => !l.startsWith("warning:")));
      const status = result.exitCode ?? (result.status === "OK" ? 0 : 1);
      return { status, stderr: lines.join("\n") };
    }
    return { status: 0, stderr: "" };
  } catch (error) {
    const e = error as Error & { exitCode?: number };
    return { status: e.exitCode ?? -1, stderr: e.message };
  }
}

/**
 * Runs `git <args>` in one copy of `template` (with `input` on stdin, or written to the file
 * `list` beside the repository's worktree when `args` names it) and `ours` in another, and
 * compares them.
 */
async function expectTwins(
  template: string,
  label: string,
  args: string[],
  ours: (git: Git) => Promise<unknown>,
  input?: string,
): Promise<void> {
  const theirs = copyOf(template, "native");
  const mine = copyOf(template, "ours");
  const r = spawnSync("git", args, {
    cwd: theirs,
    env: testEnv(root),
    ...(input !== undefined ? { input: Buffer.from(input, "latin1") } : {}),
  });
  const native = { status: r.status ?? -1, stderr: nativeLines(r.stderr.toString("latin1")) };
  const got = await runOurs(await openRepo(root, mine), ours);
  if (native.status === 129) {
    expect(got.status, `${label}: usage`).toBe(129);
  } else {
    expect(`${got.status}\n${nativeLines(got.stderr)}`, `${label}: exit and messages`).toBe(
      `${native.status}\n${native.stderr}`,
    );
  }
  expect(stateOf(mine), label).toBe(stateOf(theirs));
}

/** A pathspec file outside the repositories, for the native twin. */
function listFile(content: string): string {
  const path = join(root, `list-${Math.random().toString(36).slice(2)}`);
  writeFileSync(path, Buffer.from(content, "latin1"));
  return path;
}

/** One file per name with `content`. */
function writeFiles(dir: string, names: string[], content: (name: string) => string): void {
  for (const name of names) putFile(dir, name, content(name));
}

const FILES = ["fileA.t", "fileB.t", "fileC.t", "fileD.t"];
const never = () => {
  throw new Error("no prompt expected");
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "pathspec-file-native-"));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** git's test_commit: `<name>.t` holding `<name>`, committed as `<name>`. */
function testCommit(dir: string, name: string): void {
  putFile(dir, `${name}.t`, `${name}\n`);
  git(dir, ["add", `${name}.t`]);
  git(dir, ["commit", "-qm", name]);
}

function init(name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  return dir;
}

/** The reading cases of the scripts (stdin, file, NUL, LF, no trailing, CRLF, quotes, ...). */
const READING: { title: string; content: string; nul?: boolean; stdin?: boolean }[] = [
  { title: "--pathspec-from-file from stdin", content: "fileA.t\n", stdin: true },
  { title: "--pathspec-from-file from file", content: "fileA.t\n" },
  { title: "NUL delimiters", content: "fileA.t\0fileB.t\0", nul: true, stdin: true },
  { title: "LF delimiters", content: "fileA.t\nfileB.t\n", stdin: true },
  { title: "no trailing delimiter", content: "fileA.t\nfileB.t", stdin: true },
  { title: "CRLF delimiters", content: "fileA.t\r\nfileB.t\r\n", stdin: true },
  { title: "quotes", content: '"file\\101.t"\n' },
  {
    title: "quotes not compatible with --pathspec-file-nul",
    content: '"file\\101.t"\n',
    nul: true,
  },
  { title: "only touches what was listed", content: "fileB.t\nfileC.t\n", stdin: true },
  // t2072 only
  { title: "wildcard pathspec matches file in subdirectory", content: "*file\n", stdin: true },
];

type ReadingCase = (typeof READING)[number];

/** The reading case of `title`. */
function readingCase(title: string): ReadingCase {
  const found = READING.find((c) => c.title === title);
  if (!found) throw new Error(`no reading case ${title}`);
  return found;
}

/** The native arguments of one reading case. */
function readingArgs(c: (typeof READING)[number]): { args: string[]; input?: string } {
  const from = c.stdin ? "-" : listFile(c.content);
  const args = [`--pathspec-from-file=${from}`, ...(c.nul ? ["--pathspec-file-nul"] : [])];
  return c.stdin ? { args, input: c.content } : { args };
}

describeGit("t3704-add-pathspec-file.sh", () => {
  let template: string;
  beforeAll(() => {
    template = init("t3704");
    testCommit(template, "file0");
    writeFiles(template, FILES, (n) => `${n[4]}\n`);
  });

  const reading = (c: ReadingCase) => async () => {
    const { args, input } = readingArgs(c);
    await expectTwins(
      template,
      c.title,
      ["add", ...args],
      (g) => g.add().setPathspecFromFile(c.content, c.nul).call(),
      input,
    );
  };
  it(
    't3704-add-pathspec-file.sh: "--pathspec-from-file from stdin"',
    reading(readingCase("--pathspec-from-file from stdin")),
  );
  it(
    't3704-add-pathspec-file.sh: "--pathspec-from-file from file"',
    reading(readingCase("--pathspec-from-file from file")),
  );
  it('t3704-add-pathspec-file.sh: "NUL delimiters"', reading(readingCase("NUL delimiters")));
  it('t3704-add-pathspec-file.sh: "LF delimiters"', reading(readingCase("LF delimiters")));
  it(
    't3704-add-pathspec-file.sh: "no trailing delimiter"',
    reading(readingCase("no trailing delimiter")),
  );
  it('t3704-add-pathspec-file.sh: "CRLF delimiters"', reading(readingCase("CRLF delimiters")));
  it('t3704-add-pathspec-file.sh: "quotes"', reading(readingCase("quotes")));
  it(
    't3704-add-pathspec-file.sh: "quotes not compatible with --pathspec-file-nul"',
    reading(readingCase("quotes not compatible with --pathspec-file-nul")),
  );
  it(
    't3704-add-pathspec-file.sh: "only touches what was listed"',
    reading(readingCase("only touches what was listed")),
  );

  it("a NUL inside a line ends its element (strvec_push copies a C string)", async () => {
    const content = "fileA.t\0junk\nfileB.t\n";
    await expectTwins(
      template,
      "NUL in a line",
      ["add", "--pathspec-from-file=-"],
      (g) => g.add().setPathspecFromFile(content).call(),
      content,
    );
  });

  it('t3704-add-pathspec-file.sh: "error conditions"', async () => {
    const list = listFile("fileA.t\n");
    const empty = listFile("");
    await expectTwins(
      template,
      "--interactive",
      ["add", `--pathspec-from-file=${list}`, "--interactive"],
      (g) =>
        g
          .add()
          .setPathspecFromFile("fileA.t\n")
          .setInteractive(true)
          .setPatchSelector(never)
          .call(),
    );
    await expectTwins(
      template,
      "--patch",
      ["add", `--pathspec-from-file=${list}`, "--patch"],
      (g) => g.add().setPathspecFromFile("fileA.t\n").setPatch(true).setPatchSelector(never).call(),
    );
    await expectTwins(
      template,
      "pathspec arguments",
      ["add", `--pathspec-from-file=${list}`, "--", "fileA.t"],
      (g) => g.add().setPathspecFromFile("fileA.t\n").addFilepattern("fileA.t").call(),
    );
    // an empty file beside arguments is refused all the same
    await expectTwins(
      template,
      "pathspec arguments, empty file",
      ["add", `--pathspec-from-file=${empty}`, "--", "fileA.t"],
      (g) => g.add().setPathspecFromFile("").addFilepattern("fileA.t").call(),
    );
    await expectTwins(template, "empty list", ["add", `--pathspec-from-file=${empty}`], (g) =>
      g.add().setPathspecFromFile("").call(),
    );
  });
});

describeGit("t3601-rm-pathspec-file.sh", () => {
  let template: string;
  beforeAll(() => {
    template = init("t3601");
    writeFiles(template, FILES, (n) => `${n[4]}\n`);
    git(template, ["add", ...FILES]);
    git(template, ["commit", "-qm", "files"]);
  });

  const simple = (title: string, content: string, nul: boolean) => async () => {
    await expectTwins(
      template,
      title,
      ["rm", "--pathspec-from-file=-", ...(nul ? ["--pathspec-file-nul"] : [])],
      (g) => g.rm().setPathspecFromFile(content, nul).call(),
      content,
    );
  };
  it('t3601-rm-pathspec-file.sh: "simplest"', simple("simplest", "fileA.t\n", false));
  it(
    't3601-rm-pathspec-file.sh: "--pathspec-file-nul"',
    simple("--pathspec-file-nul", "fileA.t\0fileB.t\0", true),
  );
  it(
    't3601-rm-pathspec-file.sh: "only touches what was listed"',
    simple("only touches what was listed", "fileB.t\nfileC.t\n", false),
  );

  it('t3601-rm-pathspec-file.sh: "error conditions"', async () => {
    const list = listFile("fileA.t\n");
    const empty = listFile("");
    await expectTwins(
      template,
      "pathspec arguments",
      ["rm", `--pathspec-from-file=${list}`, "--", "fileA.t"],
      (g) => g.rm().setPathspecFromFile("fileA.t\n").addFilepattern("fileA.t").call(),
    );
    await expectTwins(template, "empty list", ["rm", `--pathspec-from-file=${empty}`], (g) =>
      g.rm().setPathspecFromFile("").call(),
    );
    // a badly quoted line dies before anything is removed
    await expectTwins(
      template,
      "badly quoted",
      ["rm", `--pathspec-from-file=${listFile('"fileA.t\n')}`],
      async (g) => g.rm().setPathspecFromFile('"fileA.t\n').call(),
    );
  });
});

describeGit("t2072-restore-pathspec-file.sh", () => {
  let template: string;
  beforeAll(() => {
    template = init("t2072");
    testCommit(template, "file0");
    writeFiles(template, ["dir1/file", ...FILES], () => "1\n");
    git(template, ["add", "dir1", ...FILES]);
    git(template, ["commit", "-qm", "files 1"]);
    writeFiles(template, ["dir1/file", ...FILES], () => "2\n");
    git(template, ["add", "dir1", ...FILES]);
    git(template, ["commit", "-qm", "files 2"]);
  });

  const reading = (c: ReadingCase) => async () => {
    const { args, input } = readingArgs(c);
    await expectTwins(
      template,
      c.title,
      ["restore", ...args, "--source=HEAD^1"],
      (g) => g.restore().setPathspecFromFile(c.content, c.nul).setSource("HEAD^1").call(),
      input,
    );
  };
  it(
    't2072-restore-pathspec-file.sh: "--pathspec-from-file from stdin"',
    reading(readingCase("--pathspec-from-file from stdin")),
  );
  it(
    't2072-restore-pathspec-file.sh: "--pathspec-from-file from file"',
    reading(readingCase("--pathspec-from-file from file")),
  );
  it('t2072-restore-pathspec-file.sh: "NUL delimiters"', reading(readingCase("NUL delimiters")));
  it('t2072-restore-pathspec-file.sh: "LF delimiters"', reading(readingCase("LF delimiters")));
  it(
    't2072-restore-pathspec-file.sh: "no trailing delimiter"',
    reading(readingCase("no trailing delimiter")),
  );
  it('t2072-restore-pathspec-file.sh: "CRLF delimiters"', reading(readingCase("CRLF delimiters")));
  it('t2072-restore-pathspec-file.sh: "quotes"', reading(readingCase("quotes")));
  it(
    't2072-restore-pathspec-file.sh: "quotes not compatible with --pathspec-file-nul"',
    reading(readingCase("quotes not compatible with --pathspec-file-nul")),
  );
  it(
    't2072-restore-pathspec-file.sh: "only touches what was listed"',
    reading(readingCase("only touches what was listed")),
  );
  it(
    't2072-restore-pathspec-file.sh: "wildcard pathspec matches file in subdirectory"',
    reading(readingCase("wildcard pathspec matches file in subdirectory")),
  );

  it('t2072-restore-pathspec-file.sh: "error conditions"', async () => {
    const list = listFile("fileA.t\n");
    const empty = listFile("");
    await expectTwins(
      template,
      "--patch",
      ["restore", `--pathspec-from-file=${list}`, "--patch", "--source=HEAD^1"],
      (g) =>
        g
          .restore()
          .setPathspecFromFile("fileA.t\n")
          .setPatch(true)
          .setPatchSelector(never)
          .setSource("HEAD^1")
          .call(),
    );
    await expectTwins(
      template,
      "pathspec arguments",
      ["restore", `--pathspec-from-file=${list}`, "--source=HEAD^1", "--", "fileA.t"],
      (g) =>
        g.restore().setPathspecFromFile("fileA.t\n").setSource("HEAD^1").addPath("fileA.t").call(),
    );
    await expectTwins(
      template,
      "pathspec arguments, empty file",
      ["restore", `--pathspec-from-file=${empty}`, "--source=HEAD^1", "--", "fileA.t"],
      (g) => g.restore().setPathspecFromFile("").setSource("HEAD^1").addPath("fileA.t").call(),
    );
    await expectTwins(
      template,
      "empty list",
      ["restore", `--pathspec-from-file=${empty}`, "--source=HEAD^1"],
      (g) => g.restore().setPathspecFromFile("").setSource("HEAD^1").call(),
    );
  });
});

describeGit("t7526-commit-pathspec-file.sh", () => {
  let template: string;
  beforeAll(() => {
    template = init("t7526");
    testCommit(template, "file0");
    writeFiles(template, FILES, (n) => `${n[4]}\n`);
    git(template, ["add", ...FILES]);
  });

  const reading = (c: ReadingCase) => async () => {
    const { args, input } = readingArgs(c);
    await expectTwins(
      template,
      c.title,
      ["commit", ...args, "-m", "Commit"],
      (g) => g.commit().setPathspecFromFile(c.content, c.nul).setMessage("Commit").call(),
      input,
    );
  };
  it(
    't7526-commit-pathspec-file.sh: "--pathspec-from-file from stdin"',
    reading(readingCase("--pathspec-from-file from stdin")),
  );
  it(
    't7526-commit-pathspec-file.sh: "--pathspec-from-file from file"',
    reading(readingCase("--pathspec-from-file from file")),
  );
  it('t7526-commit-pathspec-file.sh: "NUL delimiters"', reading(readingCase("NUL delimiters")));
  it('t7526-commit-pathspec-file.sh: "LF delimiters"', reading(readingCase("LF delimiters")));
  it(
    't7526-commit-pathspec-file.sh: "no trailing delimiter"',
    reading(readingCase("no trailing delimiter")),
  );
  it('t7526-commit-pathspec-file.sh: "CRLF delimiters"', reading(readingCase("CRLF delimiters")));
  it('t7526-commit-pathspec-file.sh: "quotes"', reading(readingCase("quotes")));
  it(
    't7526-commit-pathspec-file.sh: "quotes not compatible with --pathspec-file-nul"',
    reading(readingCase("quotes not compatible with --pathspec-file-nul")),
  );
  it(
    't7526-commit-pathspec-file.sh: "only touches what was listed"',
    reading(readingCase("only touches what was listed")),
  );

  it('t7526-commit-pathspec-file.sh: "error conditions"', async () => {
    const list = listFile("fileA.t\n");
    const empty = listFile("");
    await expectTwins(
      template,
      "--all",
      ["commit", `--pathspec-from-file=${list}`, "--all", "-m", "Commit"],
      (g) => g.commit().setPathspecFromFile("fileA.t\n").setAll(true).setMessage("Commit").call(),
    );
    await expectTwins(
      template,
      "pathspec arguments",
      ["commit", `--pathspec-from-file=${list}`, "-m", "Commit", "--", "fileA.t"],
      (g) =>
        g.commit().setPathspecFromFile("fileA.t\n").setOnly("fileA.t").setMessage("Commit").call(),
    );
    await expectTwins(
      template,
      "--include, empty list",
      ["commit", `--pathspec-from-file=${empty}`, "--include", "-m", "Commit"],
      (g) => g.commit().setPathspecFromFile("").setInclude().setMessage("Commit").call(),
    );
    // --include takes the file's elements
    await expectTwins(
      template,
      "--include",
      ["commit", `--pathspec-from-file=${list}`, "--include", "-m", "Commit"],
      (g) => g.commit().setPathspecFromFile("fileA.t\n").setInclude().setMessage("Commit").call(),
    );
    // without --include or --only, an empty list commits what is staged
    await expectTwins(
      template,
      "empty list",
      ["commit", `--pathspec-from-file=${empty}`, "-m", "Commit"],
      (g) => g.commit().setPathspecFromFile("").setMessage("Commit").call(),
    );
  });
});

describeGit("t2026-checkout-pathspec-file.sh", () => {
  let template: string;
  beforeAll(() => {
    template = init("t2026");
    testCommit(template, "file0");
    writeFiles(template, FILES, () => "1\n");
    git(template, ["add", ...FILES]);
    git(template, ["commit", "-qm", "files 1"]);
    writeFiles(template, FILES, () => "2\n");
    git(template, ["add", ...FILES]);
    git(template, ["commit", "-qm", "files 2"]);
  });

  const reading = (c: ReadingCase) => async () => {
    const { args, input } = readingArgs(c);
    await expectTwins(
      template,
      c.title,
      ["checkout", ...args, "HEAD^1"],
      (g) =>
        g
          .checkout()
          .setPathspecFromFile(c.content, c.nul)
          .setName("HEAD^1")
          .setCountCheckoutPaths(true)
          .call(),
      input,
    );
  };
  it(
    't2026-checkout-pathspec-file.sh: "--pathspec-from-file from stdin"',
    reading(readingCase("--pathspec-from-file from stdin")),
  );
  it(
    't2026-checkout-pathspec-file.sh: "--pathspec-from-file from file"',
    reading(readingCase("--pathspec-from-file from file")),
  );
  it('t2026-checkout-pathspec-file.sh: "NUL delimiters"', reading(readingCase("NUL delimiters")));
  it('t2026-checkout-pathspec-file.sh: "LF delimiters"', reading(readingCase("LF delimiters")));
  it(
    't2026-checkout-pathspec-file.sh: "no trailing delimiter"',
    reading(readingCase("no trailing delimiter")),
  );
  it('t2026-checkout-pathspec-file.sh: "CRLF delimiters"', reading(readingCase("CRLF delimiters")));
  it('t2026-checkout-pathspec-file.sh: "quotes"', reading(readingCase("quotes")));
  it(
    't2026-checkout-pathspec-file.sh: "quotes not compatible with --pathspec-file-nul"',
    reading(readingCase("quotes not compatible with --pathspec-file-nul")),
  );
  it(
    't2026-checkout-pathspec-file.sh: "only touches what was listed"',
    reading(readingCase("only touches what was listed")),
  );

  it('t2026-checkout-pathspec-file.sh: "error conditions"', async () => {
    const list = listFile("fileA.t\n");
    const empty = listFile("");
    await expectTwins(
      template,
      "--detach",
      ["checkout", `--pathspec-from-file=${list}`, "--detach"],
      (g) => g.checkout().setPathspecFromFile("fileA.t\n").setDetach(true).call(),
    );
    await expectTwins(
      template,
      "--patch",
      ["checkout", `--pathspec-from-file=${list}`, "--patch"],
      (g) =>
        g.checkout().setPathspecFromFile("fileA.t\n").setPatch(true).setPatchSelector(never).call(),
    );
    await expectTwins(
      template,
      "pathspec arguments",
      ["checkout", `--pathspec-from-file=${list}`, "--", "fileA.t"],
      (g) => g.checkout().setPathspecFromFile("fileA.t\n").addPath("fileA.t").call(),
    );
    await expectTwins(
      template,
      "pathspec arguments, empty file",
      ["checkout", `--pathspec-from-file=${empty}`, "--", "fileA.t"],
      (g) => g.checkout().setPathspecFromFile("").addPath("fileA.t").call(),
    );
  });
});

describeGit("t3909-stash-pathspec-file.sh", () => {
  let template: string;
  beforeAll(() => {
    template = init("t3909");
    writeFiles(template, FILES, () => "");
    git(template, ["add", ...FILES]);
    git(template, ["commit", "-qm", "Files"]);
    // more files are written, so that a stash of everything shows
    writeFiles(template, FILES, (n) => `${n[4]}\n`);
  });

  const simple = (title: string, content: string, nul: boolean) => async () => {
    await expectTwins(
      template,
      title,
      ["stash", "push", "--pathspec-from-file=-", ...(nul ? ["--pathspec-file-nul"] : [])],
      (g) => g.stashCreate().setPathspecFromFile(content, nul).call(),
      content,
    );
  };
  it('t3909-stash-pathspec-file.sh: "simplest"', simple("simplest", "fileA.t\n", false));
  it(
    't3909-stash-pathspec-file.sh: "--pathspec-file-nul"',
    simple("--pathspec-file-nul", "fileA.t\0fileB.t\0", true),
  );
  it(
    't3909-stash-pathspec-file.sh: "only touches what was listed"',
    simple("only touches what was listed", "fileB.t\nfileC.t\n", false),
  );

  it('t3909-stash-pathspec-file.sh: "error conditions"', async () => {
    const list = listFile("fileA.t\n");
    await expectTwins(
      template,
      "--patch",
      ["stash", "push", `--pathspec-from-file=${list}`, "--patch"],
      (g) =>
        g
          .stashCreate()
          .setPathspecFromFile("fileA.t\n")
          .setPatch(true)
          .setPatchSelector(never)
          .call(),
    );
    await expectTwins(
      template,
      "pathspec arguments",
      ["stash", "push", `--pathspec-from-file=${list}`, "--", "fileA.t"],
      (g) => g.stashCreate().setPathspecFromFile("fileA.t\n").addPath("fileA.t").call(),
    );
    // stash's own refusal: --staged
    await expectTwins(
      template,
      "--staged",
      ["stash", "push", `--pathspec-from-file=${list}`, "--staged"],
      (g) => g.stashCreate().setPathspecFromFile("fileA.t\n").setStaged(true).call(),
    );
  });
});
