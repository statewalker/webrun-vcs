/**
 * JGit's ignore rule test cases, answered by native git.
 *
 * JGit's `IgnoreRuleSpecialCasesTest`, `FastIgnoreRuleTest` and
 * `IgnoreMatcherParametrizedTest` hold several hundred curated (pattern, path) cases:
 * wildcards, classes, escapes, `**`, anchors, directory-only rules, negations. They are
 * extracted into `fixtures/jgit-ignore-cases.json` by `scripts/extract-jgit-ignore-cases.mjs`.
 * The cases come from Eclipse JGit, under the Eclipse Distribution License v. 1.0
 * (SPDX-License-Identifier: BSD-3-Clause): Copyright (C) 2008, 2025 Florian Köberle and others;
 * Copyright (C) 2014, Andrey Loskutov and others; Copyright (C) 2010, Red Hat Inc. and others.
 * JGit's expected values are not the oracle: for each
 * case a `.gitignore` holding the pattern and the path (a file, or a directory when it ends
 * with `/`) are written to disk, native `git check-ignore --no-index -v` decides, and our
 * `isIgnored` and worktree walk must agree. Where JGit's own expectation differs from git,
 * the case is listed (JGit is not git) but does not fail.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFileWorktree, createGitFilesBackend } from "@statewalker/vcs-store-files";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

interface JGitCase {
  /** JGit test class and method the case comes from */
  source: string;
  pattern: string;
  /** JGit's path: `/`-prefixed or not, a trailing `/` for a directory */
  path: string;
  /** JGit's expected answer (rule matches); informational */
  jgit: boolean;
}

const CASES: JGitCase[] = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "fixtures", "jgit-ignore-cases.json"),
    "utf8",
  ),
);

let home = "";
const git = (cwd: string, args: string[], input?: string): string => {
  try {
    return execFileSync("git", args, {
      cwd,
      env: nativeGitEnv(home),
      encoding: "utf8",
      input,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (e) {
    const x = e as { status?: number; stdout?: string };
    if (args[0] === "check-ignore" && x.status === 1) return x.stdout ?? "";
    throw e;
  }
};

/** A case's path on disk: relative, without the directory marker; undefined when unusable. */
function diskPath(c: JGitCase): { path: string; dir: boolean } | undefined {
  const dir = c.path.endsWith("/");
  const path = c.path.replace(/^\/+/, "").replace(/\/+$/, "");
  if (path === "" || path.split("/").some((s) => s === "" || s === "." || s === "..")) {
    return undefined;
  }
  if (path === ".git" || path.startsWith(".git/") || path === ".gitignore") return undefined;
  return { path, dir };
}

/**
 * The cases of one pattern, split into layouts whose paths can coexist on disk (no path is
 * both a file and a directory, or the ancestor of a file).
 */
function layouts(cases: JGitCase[]): Array<Array<{ c: JGitCase; path: string; dir: boolean }>> {
  const out: Array<Array<{ c: JGitCase; path: string; dir: boolean }>> = [];
  for (const c of cases) {
    const p = diskPath(c);
    if (!p) continue;
    const fits = (group: Array<{ path: string; dir: boolean }>) =>
      group.every((g) => {
        if (g.path === p.path) return g.dir === p.dir;
        if (p.path.startsWith(`${g.path}/`)) return g.dir;
        if (g.path.startsWith(`${p.path}/`)) return p.dir;
        return true;
      });
    const group = out.find(fits);
    if (group) group.push({ c, ...p });
    else out.push([{ c, ...p }]);
  }
  return out;
}

describeGit("JGit's ignore rule cases against native git", () => {
  let root = "";
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "ignore-jgit-"));
    home = root;
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it(`${CASES.length} cases: ours answers as git check-ignore`, async () => {
    const byPattern = new Map<string, JGitCase[]>();
    for (const c of CASES) {
      if (c.pattern.includes("\n")) continue;
      const list = byPattern.get(c.pattern) ?? [];
      list.push(c);
      byPattern.set(c.pattern, list);
    }
    const mismatches: string[] = [];
    const jgitDiffers: string[] = [];
    let checked = 0;
    let n = 0;
    for (const [pattern, cases] of byPattern) {
      for (const group of layouts(cases)) {
        const repo = join(root, `r${n++}`);
        mkdirSync(repo, { recursive: true });
        git(repo, ["init", "-q", "-b", "main"]);
        // keep git from reading $XDG_CONFIG_HOME/git/ignore
        writeFileSync(join(repo, ".git", "empty-excludes"), "");
        git(repo, ["config", "core.excludesFile", join(repo, ".git", "empty-excludes")]);
        writeFileSync(join(repo, ".gitignore"), `${pattern}\n`);
        for (const { path, dir } of group) {
          if (dir) mkdirSync(join(repo, path), { recursive: true });
          else {
            mkdirSync(join(repo, path, ".."), { recursive: true });
            writeFileSync(join(repo, path), "x\n");
          }
        }
        // check-ignore reads pathspecs: "./" keeps a leading ":" (JGit's ":]") from being magic
        const out = git(
          repo,
          ["check-ignore", "--no-index", "-v", "-n", "-z", "--stdin"],
          `${group.map((g) => `./${g.path}`).join("\0")}\0`,
        );
        const toks = out.split("\0");
        const gitAnswer = new Map<string, { matched: boolean; ignored: boolean }>();
        for (let i = 0; i + 3 < toks.length; i += 4) {
          const [, , pat, path] = toks.slice(i, i + 4);
          gitAnswer.set(path.replace(/^\.\//, ""), {
            matched: pat !== "",
            ignored: pat !== "" && !pat.startsWith("!"),
          });
        }
        const files = createNodeFilesApi({ rootDir: repo });
        const { history } = await createGitFilesBackend({ files });
        const worktree = createFileWorktree({
          files,
          rootPath: "",
          gitDir: ".git",
          blobs: history.blobs,
          trees: history.trees,
        });
        const walked = new Map<string, boolean>();
        for await (const e of worktree.walk({ includeIgnored: true, includeDirectories: true })) {
          walked.set(e.path, e.isIgnored);
        }
        for (const { c, path, dir } of group) {
          const g = gitAnswer.get(path);
          const label = `${c.source}: ${JSON.stringify(pattern)} ${JSON.stringify(c.path)}`;
          if (!g) {
            mismatches.push(`${label}: no answer from git check-ignore`);
            continue;
          }
          checked++;
          const ours = await worktree.isIgnored(path);
          if (ours !== g.ignored) {
            mismatches.push(
              `${label} (${dir ? "dir" : "file"}): isIgnored ours=${ours} git=${g.ignored}`,
            );
          }
          const w = walked.get(path);
          if (w !== undefined && w !== g.ignored) {
            mismatches.push(`${label} (${dir ? "dir" : "file"}): walk ours=${w} git=${g.ignored}`);
          }
          if (c.jgit !== g.matched) jgitDiffers.push(`${label}: jgit=${c.jgit} git=${g.matched}`);
        }
        rmSync(repo, { recursive: true, force: true });
      }
    }
    if (jgitDiffers.length > 0 && process.env.IGNORE_JGIT_REPORT) {
      console.log(
        `JGit expects otherwise than git in ${jgitDiffers.length} cases:\n${jgitDiffers.join("\n")}`,
      );
    }
    expect(checked).toBeGreaterThan(CASES.length * 0.8);
    expect(mismatches).toEqual([]);
  }, 120_000);
});
