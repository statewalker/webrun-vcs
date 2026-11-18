/**
 * `git diff --stat` widths against native git: names of CJK characters, emoji, combining
 * marks, control characters and bytes that are not UTF-8 (with `core.quotePath=false`, so
 * they are printed as they are) measured as git's utf8_strwidth measures them, and shortened
 * behind `...` as show_stats does at narrow `--stat` widths.
 *
 * Shortening follows git 2.55+ (2.54 drops whole characters by width, 2.55 also steps over
 * invalid UTF-8 and control characters; older git drops bytes, cutting characters apart): with
 * an older native git only the widths that shorten no name are compared.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gitOk, openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;
const version = spawnSync("git", ["--version"], { encoding: "utf8" }).stdout ?? "";
const [major, minor] = (/(\d+)\.(\d+)/.exec(version) ?? ["", "0", "0"]).slice(1).map(Number);
/** git 2.55+ shortens names by display width, stepping over invalid UTF-8 */
const widthTruncation = (major ?? 0) > 2 || ((major ?? 0) === 2 && (minor ?? 0) >= 55);

describeGit("git diff --stat widths against native git", () => {
  let root: string;
  let dir: string;
  const names: (string | Buffer)[] = [
    "中文名前のファイル.txt",
    "dir/深い/ディレクトリ/ファイル名.md",
    "emoji-😀🎉-names.txt",
    "flags-🇩🇪-and-👍🏽.txt",
    "combining-é́́́-marks.txt",
    "zero​width‍space.txt",
    "halfｶﾅ-fullＡＢ.txt",
    "Ελληνικά/και/한국어/파일.txt",
    "short",
    Buffer.from([0x62, 0x61, 0x64, 0xff, 0xfe, 0x2d, 0xe4, 0xb8, 0x2e, 0x74, 0x78, 0x74]),
    Buffer.from("wide/中中中中中中/￿-nonchar.txt"),
  ];

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "diff-stat-width-"));
    dir = join(root, "r");
    gitOk(root, root, "init", "-q", "-b", "main", dir);
    gitOk(root, dir, "config", "core.quotePath", "false");
    writeFileSync(join(dir, "base"), "x\n");
    gitOk(root, dir, "add", "-A");
    gitOk(root, dir, "commit", "-q", "-m", "base");
    for (const [i, name] of names.entries()) {
      const bytes = Buffer.concat([Buffer.from(`${dir}/`), Buffer.from(name)]);
      const slash = bytes.lastIndexOf(0x2f);
      mkdirSync(bytes.subarray(0, slash), { recursive: true });
      writeFileSync(bytes, "line\n".repeat(i * 7 + 1));
    }
    gitOk(root, dir, "add", "-A");
    gitOk(root, dir, "commit", "-q", "-m", "names");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const native = (args: string[]) => {
    const r = spawnSync("git", args, { cwd: dir, env: nativeGitEnv(root) });
    expect(r.status).toBe(0);
    return r.stdout;
  };

  it.each([
    [80, undefined],
    [60, undefined],
    [40, undefined],
    [30, undefined],
    [26, undefined],
    [22, undefined],
    [50, 12],
    [50, 9],
    [70, 21],
    [70, 5],
  ])("--stat=%s,%s", async (width, nameWidth) => {
    const arg = nameWidth === undefined ? `--stat=${width}` : `--stat=${width},${nameWidth}`;
    const theirs = native(["diff", arg, "HEAD~1", "HEAD"]);
    if (!widthTruncation && theirs.includes(" ...")) return;
    const ours = await (await openOurs(dir))
      .diff()
      .setOldTree("HEAD~1")
      .setNewTree("HEAD")
      .setOptions({ stat: { width, ...(nameWidth !== undefined ? { nameWidth } : {}) } })
      .callBytes("stat");
    expect(Buffer.from(ours).toString("latin1")).toBe(theirs.toString("latin1"));
  });
});
