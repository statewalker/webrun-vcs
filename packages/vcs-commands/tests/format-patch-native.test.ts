/**
 * `git format-patch` against native git: histories built by native git (renames, binaries,
 * mode changes, symlinks, merges, non-ASCII authors and subjects, pinned dates), formatted
 * by native `git format-patch` and by our FormatPatchCommand with the same options; the
 * mails are compared byte for byte (the Message-ID timestamps, which git takes from the
 * clock, normalised), the file names too.
 */
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitFilesBackend, openGitLinkedWorktrees } from "@statewalker/vcs-store-files";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type FormatPatchCommand, Git } from "../src/index.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

type Env = Record<string, string | undefined>;
let root = "";
let home = "";
let version = "";
let counter = 0;

const IDENT: Env = {
  GIT_COMMITTER_NAME: "Cid Committer",
  GIT_COMMITTER_EMAIL: "cid@example.com",
  GIT_COMMITTER_DATE: "1700000500 -0700",
};

function envOf(over: Env = {}): Record<string, string> {
  const env: Env = { ...nativeGitEnv(home), ...IDENT, ...over };
  return Object.fromEntries(
    Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined),
  );
}

function git(
  cwd: string,
  args: string[],
  env: Env = {},
): { status: number; stdout: Buffer; stderr: string } {
  const r = spawnSync("git", args, { cwd, env: envOf(env), maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status ?? 1, stdout: r.stdout, stderr: r.stderr.toString() };
}

function gitOk(cwd: string, args: string[], env: Env = {}): string {
  const r = git(cwd, args, env);
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.toString();
}

const put = (dir: string, path: string, content: string | Buffer, mode = 0o644) => {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  rmSync(join(dir, path), { force: true });
  writeFileSync(join(dir, path), content, { mode });
};

function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    int: (n: number) => Math.floor(next() * n),
    pick: <T>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)] as T,
    chance: (p: number) => next() < p,
  };
}

const AUTHORS = [
  ["Ann Author", "ann@example.com"],
  ["José Núñez", "jose@example.com"],
  ["O'Brien, Pat", "pat@example.com"],
  ["张伟", "zhang@example.com"],
];
const SUBJECTS = [
  "Fix the parser",
  "Add café support",
  "Refactor: [core] module",
  "Update über docs",
  "a very long subject line that keeps going on and on beyond the usual seventy-eight column limit of mail",
  "Tidy..up  spaces",
  "=?utf-8?q?looks encoded?=",
];

/** A random history on main (and a merged side branch) built by native git. */
function history(seed: number): string {
  const r = rng(seed);
  const repo = join(root, `h${counter++}`);
  mkdirSync(repo, { recursive: true });
  gitOk(repo, ["init", "-q", "-b", "main"]);
  const files = new Map<string, string>();
  let t = 1700000000;
  const commit = (msg: string) => {
    const [name, email] = r.pick(AUTHORS) as [string, string];
    t += 100 + r.int(1000);
    gitOk(repo, ["add", "-A"]);
    gitOk(repo, ["commit", "-q", "--allow-empty", "-m", msg], {
      GIT_AUTHOR_NAME: name,
      GIT_AUTHOR_EMAIL: email,
      GIT_AUTHOR_DATE: `${t} +0${r.int(9)}00`,
      GIT_COMMITTER_DATE: `${t + 5} +0000`,
    });
  };
  const text = (n: number) =>
    Array.from({ length: n }, (_, i) => `line ${i} ${r.int(100)}\n`).join("");
  put(repo, "README", text(10));
  files.set("README", "x");
  commit("Initial commit");
  for (let i = 0; i < 6; i++) {
    const op = r.int(7);
    if (op === 0) put(repo, `src/f${i}.txt`, text(5 + r.int(20)));
    else if (op === 1)
      put(
        repo,
        readdirSync(repo).includes("README.md") ? "README.md" : "README",
        text(10 + r.int(5)),
      );
    else if (op === 2) {
      const bin = Buffer.from(Array.from({ length: 200 + r.int(3000) }, () => r.int(256)));
      put(repo, "data.bin", bin);
    } else if (op === 3) {
      if (readdirSync(repo).includes("data.bin")) {
        const b = readFileSync(join(repo, "data.bin"));
        b[r.int(b.length)] = 0;
        put(repo, "data.bin", b);
      } else put(repo, "data.bin", Buffer.from([0, 1, 2, 3, 4]));
    } else if (op === 4) put(repo, "run.sh", "#!/bin/sh\necho\n", r.chance(0.5) ? 0o755 : 0o644);
    else if (op === 5) {
      const names = readdirSync(repo);
      if (names.includes("README") && !names.includes("README.md"))
        gitOk(repo, ["mv", "README", "README.md"]);
      else if (names.includes("README.md") && !names.includes("README"))
        gitOk(repo, ["mv", "README.md", "README"]);
    } else {
      rmSync(join(repo, "link"), { force: true });
      symlinkSync(`target${i}`, join(repo, "link"));
    }
    const subject = r.pick(SUBJECTS);
    commit(r.chance(0.5) ? `${subject}\n\nBody line one.\nBody line two with café.\n` : subject);
  }
  // a merge, which format-patch skips
  gitOk(repo, ["checkout", "-q", "-b", "side", "HEAD~2"]);
  put(repo, "side.txt", "side\n");
  commit("Side change");
  gitOk(repo, ["checkout", "-q", "main"]);
  gitOk(repo, ["merge", "-q", "--no-ff", "-m", "Merge side", "side"], {
    GIT_AUTHOR_DATE: `${t + 50} +0000`,
    GIT_COMMITTER_DATE: `${t + 50} +0000`,
  });
  put(repo, "after.txt", "after\n");
  commit("After the merge");
  return repo;
}

async function open(repo: string): Promise<Git> {
  const files = createNodeFilesApi({ rootDir: repo });
  const environment = createNodeGitHostEnvironment({ env: envOf() });
  const { history: h } = await createGitFilesBackend({ files, gitDir: ".git" });
  const worktrees = await openGitLinkedWorktrees({
    files,
    gitDir: ".git",
    history: h,
    environment,
  });
  return Git.fromWorkingCopy(await worktrees.openCurrent());
}

const normalise = (text: string) =>
  text.replace(
    /(Message-ID: <|In-Reply-To: <|References: <|\t<)([^.>]+)\.\d+\.git\./g,
    "$1$2.T.git.",
  );

/** Native `git format-patch --stdout <args>` against ours. */
async function compareStdout(
  repo: string,
  args: string[],
  configure: (c: FormatPatchCommand) => FormatPatchCommand,
  label: string,
) {
  const native = gitOk(repo, ["format-patch", "--stdout", ...args]);
  const g = await open(repo);
  const r = await configure(
    g
      .formatPatch()
      .setStdout(true)
      .setVersionString(version)
      .setMessageIdTime(() => 1),
  ).call();
  g.close();
  expect({ label, text: normalise(Buffer.from(r.output).toString()) }).toEqual({
    label,
    text: normalise(native),
  });
}

describeGit("git format-patch as native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "format-patch-native-"));
    home = join(root, "home");
    mkdirSync(home, { recursive: true });
    version = gitOk(root, ["--version"])
      .trim()
      .replace(/^git version /, "");
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("formats random histories as native git does", async () => {
    for (let seed = 1; seed <= 6; seed++) {
      const repo = history(seed);
      const cases: [string[], (c: FormatPatchCommand) => FormatPatchCommand][] = [
        [["--root", "HEAD"], (c) => c.setRoot(true).addRevision("HEAD")],
        [["-3"], (c) => c.setMaxCount(3)],
        [["HEAD~4"], (c) => c.addRevision("HEAD~4")],
        [["-1", "-k"], (c) => c.setMaxCount(1).setKeepSubject(true)],
        [["-2", "-N", "-s"], (c) => c.setMaxCount(2).setNumbered(false).setSignoff(true)],
        [
          ["-2", "--subject-prefix=RFC PATCH", "-v3", "--start-number=7"],
          (c) => c.setMaxCount(2).setSubjectPrefix("RFC PATCH").setRerollCount(3).setStartNumber(7),
        ],
        [
          ["-2", "--no-stat", "--zero-commit", "--no-signature"],
          (c) => c.setMaxCount(2).setNoStat(true).setZeroCommit(true).setSignature(false),
        ],
        [
          ["-2", "--no-binary", "--to=a@x", "--to=b@y", "--cc=c@z", "--add-header=X-Foo: bar"],
          (c) =>
            c
              .setMaxCount(2)
              .setNoBinary(true)
              .addTo("a@x")
              .addTo("b@y")
              .addCc("c@z")
              .addHeader("X-Foo: bar"),
        ],
        [
          ["-3", "--thread", "--cover-letter"],
          (c) => c.setMaxCount(3).setThread(true).setCoverLetter(true),
        ],
        [
          ["-3", "--thread=deep", "--in-reply-to=<orig@x>"],
          (c) => c.setMaxCount(3).setThread("deep").setInReplyTo("<orig@x>"),
        ],
        [
          ["-2", "--from=Sender Name <sender@x>"],
          (c) => c.setMaxCount(2).setFrom("Sender Name <sender@x>"),
        ],
        [
          ["-2", "--signature=my sig", "--base=HEAD~4"],
          (c) => c.setMaxCount(2).setSignature("my sig").setBase("HEAD~4"),
        ],
        [
          ["-2", "--cover-letter", "--rfc"],
          (c) => c.setMaxCount(2).setCoverLetter(true).setRfc(true),
        ],
      ];
      for (const [args, configure] of cases)
        await compareStdout(repo, args, configure, `seed ${seed} ${args.join(" ")}`);
    }
  }, 300_000);

  it("writes the files git writes, with format.* settings", async () => {
    const repo = history(42);
    gitOk(repo, ["config", "format.subjectPrefix", "PROJ"]);
    gitOk(repo, ["config", "format.signature", "configured signature"]);
    gitOk(repo, ["config", "format.headers", "Organization: Example"]);
    gitOk(repo, ["config", "--add", "format.to", "list@example.com"]);
    gitOk(repo, ["config", "format.coverLetter", "auto"]);
    gitOk(repo, ["config", "format.numbered", "auto"]);
    for (const [args, configure] of [
      [["-3", "-o", "out"], (c: FormatPatchCommand) => c.setMaxCount(3).setOutputDirectory("out")],
      [
        ["-2", "-o", "out2", "--numbered-files", "--suffix=.txt"],
        (c: FormatPatchCommand) =>
          c.setMaxCount(2).setOutputDirectory("out2").setNumberedFiles(true).setSuffix(".txt"),
      ],
      [
        ["-1", "-o", "out3", "--filename-max-length=20"],
        (c: FormatPatchCommand) =>
          c.setMaxCount(1).setOutputDirectory("out3").setFilenameMaxLength(20),
      ],
    ] as [string[], (c: FormatPatchCommand) => FormatPatchCommand][]) {
      const native = gitOk(repo, ["format-patch", ...args]);
      const dir = args[args.indexOf("-o") + 1] as string;
      const nativeFiles = readdirSync(join(repo, dir))
        .sort()
        .map((f) => [f, normalise(readFileSync(join(repo, dir, f)).toString())]);
      rmSync(join(repo, dir), { recursive: true });
      const g = await open(repo);
      const r = await configure(
        g
          .formatPatch()
          .setVersionString(version)
          .setMessageIdTime(() => 1),
      ).call();
      g.close();
      expect(Buffer.from(r.output).toString()).toBe(native);
      const ours = readdirSync(join(repo, dir))
        .sort()
        .map((f) => [f, normalise(readFileSync(join(repo, dir, f)).toString())]);
      expect(ours).toEqual(nativeFiles);
      rmSync(join(repo, dir), { recursive: true });
    }
  }, 120_000);
});
