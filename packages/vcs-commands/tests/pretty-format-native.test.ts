/**
 * git's user formats against `git log -1 --format=<format>`: decorations (`%d`, `%D`,
 * `%(decorate:…)` under log's default filter), `%m`, human dates (`%ah`, with
 * GIT_TEST_DATE_NOW for both), signatures (`%G?`), notes and reflog placeholders without a
 * note or a reflog walk, padding and truncation, wrapping, forced colors, raw bytes, and
 * subjects git's isspace does not trim (a no-break space). Each format is expanded for every
 * commit by native git and by formatCommitPretty, and the bytes compared.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitFilesBackend } from "@statewalker/vcs-store-files";
import { encodeGitPath } from "@statewalker/vcs-utils/encoding";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { formatCommitPretty, loadRefDecorations } from "../src/index.js";
import { put } from "./merge-native-helpers.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

const NOW = 1700000000;
let root: string;

const run = (dir: string, args: string[], env: Record<string, string> = {}) => {
  const r = spawnSync("git", args, {
    cwd: dir,
    env: { ...nativeGitEnv(root), GIT_TEST_DATE_NOW: String(NOW), ...env },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout as Buffer;
};
const text = (dir: string, args: string[], env: Record<string, string> = {}) =>
  run(dir, args, env).toString("utf8").trim();

/** A history whose commits are dated around NOW (today, this week, this year, years ago). */
function repo(): string {
  const dir = join(root, "repo");
  text(root, ["init", "-q", "-b", "main", dir]);
  const commit = (name: string, message: string, when: number, tz: string) => {
    put(dir, `${name}.txt`, `${name}\n`);
    text(dir, ["add", "-A"]);
    const date = `${when} ${tz}`;
    text(dir, ["commit", "-q", "--cleanup=verbatim", "-m", message], {
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    });
  };
  commit(
    "old",
    "Old work\n\nA body that is long enough to be wrapped at twenty columns.",
    NOW - 86400 * 800,
    "-0500",
  );
  commit("year", "Earlier this year ", NOW - 86400 * 60, "+0200");
  text(dir, ["tag", "-a", "-m", "release", "v1"]);
  text(dir, ["tag", "light"]);
  commit("week", "Three days ago\n\nbody line one\nbody line two\n", NOW - 86400 * 3, "+0000");
  text(dir, ["branch", "topic"]);
  text(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  text(dir, ["update-ref", "refs/custom/ref", "HEAD"]);
  commit("today", "Today:  a subject with spaces  ", NOW - 3600, "+0000");
  return dir;
}

describeGit("formatCommitPretty against git log --format, native", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "pretty-format-native-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("every format, every commit: the same bytes", async () => {
    const dir = repo();
    const { history } = await createGitFilesBackend({
      files: createNodeFilesApi({ rootDir: dir }),
    });
    const decorations = await loadRefDecorations({
      refs: history.refs,
      tags: history.tags,
      logFilter: true,
    });
    const ids = text(dir, ["rev-list", "--all"]).split("\n");
    const formats = [
      "%d",
      "%D",
      "%(decorate)",
      "%(decorate:prefix=[,suffix=],separator=%x2c ,pointer=>,tag=T:)",
      "%m",
      "%ah|%ch|%ar",
      "%G?|%GT|%GG|%GS|%GK",
      "[%N]",
      "[%gd|%gD|%gs|%gn|%ge]",
      "%<(10)%s|",
      "%<(10,trunc)%s|",
      "%>(14,ltrunc)%s|",
      "%><(15,mtrunc)%s|",
      "%>(12)%h|%><(9)%an|",
      "%h %>>(20)%s|",
      "x%<|(30)%s|",
      "%w(20,2,4)%B",
      "%w(30)%s%n%n%b%w(0)tail",
      "%C(always,red)%h%C(always,reset) %C(always,bold blue ul)x%C(always,reset)",
      "%C(always,#ff8000 brightblack)%s%C(always,noreverse 200)",
      "%Cred%h%Creset %C(green)%s%C(reset) %C(auto)%h",
      "%x80%xff%x41%x0a",
      "[%s][%f][%b]",
      "%-N|%+gd|% G?",
    ];
    const abbrev = new Map<string, string>();
    const abbreviate = async (id: string) => {
      let short = abbrev.get(id);
      if (!short) {
        short = text(dir, ["rev-parse", "--short", id]);
        abbrev.set(id, short);
      }
      return short;
    };
    for (const id of ids) {
      const commit = await history.commits.load(id);
      if (!commit) throw new Error(`no commit ${id}`);
      for (const format of formats) {
        const native = run(dir, ["log", "-1", `--format=${format}`, id]);
        const ours = await formatCommitPretty(`${format}`, commit, id, {
          abbreviate,
          decorations,
          now: NOW,
          notes: "",
        });
        // git log ends each commit's line with a newline
        const bytes = Buffer.from(encodeGitPath(`${ours}\n`));
        expect(bytes.toString("latin1"), `${format} of ${id}`).toBe(native.toString("latin1"));
      }
    }
  });

  it("grafted and replaced commits are decorated as git decorates them", async () => {
    const dir = join(root, "decorated");
    text(root, ["clone", "-q", join(root, "repo"), dir]);
    const ids = text(dir, ["rev-list", "main"]).split("\n");
    const [tip, second, third] = ids as [string, string, string];
    writeFileSync(join(dir, ".git", "info", "grafts"), `${second} ${third}\n`);
    text(dir, ["replace", third, second]);
    const { history } = await createGitFilesBackend({
      files: createNodeFilesApi({ rootDir: dir }),
    });
    const decorations = await loadRefDecorations({
      refs: history.refs,
      tags: history.tags,
      logFilter: true,
      grafted: [second],
      hasObject: async (id) => (await history.objects?.has(id)) ?? false,
    });
    for (const id of [tip, second, third]) {
      const commit = await history.commits.load(id);
      if (!commit) throw new Error(`no commit ${id}`);
      const native = run(dir, ["log", "-1", "--format=%d", id]).toString("utf8").replace(/\n$/, "");
      expect(await formatCommitPretty("%d", commit, id, { decorations }), id).toBe(native);
    }
  });
});

describeGit("padding, truncation and wrapping of combining and wide characters, native", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "pretty-format-width-native-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("combining marks stay attached where git keeps them; git's width tables", async () => {
    const dir = join(root, "widths");
    text(root, ["init", "-q", "-b", "main", dir]);
    const subjects = [
      // e + combining acute, repeated: marks right at the cut stay with their letter
      "café déjà vü naı̈ve résumé cliché",
      // Hebrew points, Devanagari signs, Arabic marks (zero width in git's tables)
      "שָׁלוֹם किताब بِسْم tail text",
      // wide characters and emoji, a variation selector and a zero-width joiner
      "中文字符 👍🏽 ❤️ 👨‍💻 end",
      // a soft hyphen, a word joiner, a control character
      "soft­hyphen word⁠joiner ctrl\u0001char and more words here",
    ];
    for (const [i, subject] of subjects.entries()) {
      put(dir, `f${i}.txt`, `${i}\n`);
      text(dir, ["add", "-A"]);
      text(dir, ["commit", "-q", "--cleanup=verbatim", "-m", subject]);
    }
    const { history } = await createGitFilesBackend({
      files: createNodeFilesApi({ rootDir: dir }),
    });
    const ids = text(dir, ["rev-list", "--all"]).split("\n");
    const formats: string[] = [];
    for (const n of [3, 4, 5, 6, 7, 8, 9, 11, 13]) {
      formats.push(`%<(${n},trunc)%s|`, `%>(${n},ltrunc)%s|`, `%><(${n},mtrunc)%s|`);
    }
    formats.push("%<(40)%s|", "%>(45)%s|", "%><(50)%s|", "%w(12,1,2)%s", "%w(9)%s");
    for (const id of ids) {
      const commit = await history.commits.load(id);
      if (!commit) throw new Error(`no commit ${id}`);
      for (const format of formats) {
        const native = run(dir, ["log", "-1", `--format=${format}`, id]);
        const ours = await formatCommitPretty(format, commit, id, { now: NOW, notes: "" });
        const bytes = Buffer.from(encodeGitPath(`${ours}\n`));
        expect(bytes.toString("utf8"), `${format} of ${id}`).toBe(native.toString("utf8"));
      }
    }
  });
});
