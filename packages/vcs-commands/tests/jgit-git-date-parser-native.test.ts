/**
 * JGit's `GitDateParserTest` (org.eclipse.jgit.test, `util/`) as native twins
 * (statewalker/webrun-vcs#218): each date text JGit parses is read by native
 * `git rev-parse --since=<text>` (approxidate) and by our `approxidateCareful`, with the clock
 * pinned on both sides (`GIT_TEST_DATE_NOW` at JGit's reference time, 2007-02-21 15:35:00
 * +0100, and the same `now` for ours), in several timezones (`TZ` for native git and for this
 * process). Only JGit's inputs are taken; native git decides the timestamp.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { approxidateCareful } from "../src/commands/git-date.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";
import { CLEANUP_TIMEOUT, removeTempDir } from "./temp-dir-support.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

/** JGit's reference date, 2007-02-21 15:35:00 +0100. */
const NOW = 1172068500;

const ZONES = ["Europe/Berlin", "UTC", "America/Los_Angeles", "Asia/Kolkata"];

/** JGit's methods and the texts each parses. */
const CASES: [string, string[]][] = [
  ["yesterday", ["yesterday"]],
  ["never", ["never"]],
  ["now", ["now"]],
  ["weeksAgo", ["2 weeks ago"]],
  ["daysAndWeeksAgo", ["2 weeks ago", "3 days 2 weeks ago", "3.day.2.week.ago"]],
  ["iso", ["2007-02-21 15:35:00 +0100"]],
  ["rfc", ["Wed, 21 Feb 2007 15:35:00 +0100"]],
  ["shortFmt", ["2007-02-21"]],
  ["shortWithDots", ["2007.02.21"]],
  ["shortWithSlash", ["02/21/2007"]],
  ["shortWithDotsReverse", ["21.02.2007"]],
  ["defaultFmt", ["Wed Feb 21 15:35:00 2007 +0100"]],
  ["local", ["Wed Feb 21 15:35:00 2007"]],
];

describeGit("JGit GitDateParserTest against native git approxidate", () => {
  const savedTz = process.env.TZ;
  let root = "";
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "jgit-date-"));
    execFileSync("git", ["init", "-q", root], { env: nativeGitEnv(root) });
  });
  afterAll(async () => {
    if (savedTz === undefined) delete process.env.TZ;
    else process.env.TZ = savedTz;
    await removeTempDir(root);
  }, CLEANUP_TIMEOUT);

  for (const [method, texts] of CASES) {
    it(`JGit GitDateParserTest#${method}`, () => {
      for (const zone of ZONES) {
        process.env.TZ = zone;
        for (const text of texts) {
          const native = execFileSync("git", ["rev-parse", `--since=${text}`], {
            cwd: root,
            env: { ...nativeGitEnv(root), TZ: zone, GIT_TEST_DATE_NOW: String(NOW) },
            encoding: "utf8",
          }).trim();
          const ours = `--max-age=${approxidateCareful(text, NOW).timestamp}`;
          expect([zone, text, ours]).toEqual([zone, text, native]);
        }
      }
    });
  }
});
