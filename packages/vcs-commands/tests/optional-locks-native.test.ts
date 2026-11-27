/**
 * `GIT_OPTIONAL_LOCKS=0` twins (t7508-status.sh): `git --no-optional-locks status` leaves the
 * index alone where a plain status writes the refreshed stat data back. Native git and ours
 * each run over their own copy of one repository, whose index needs a refresh.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { gitOut, openRepo, putFile, testEnv } from "./status-native-support.js";
import { CLEANUP_TIMEOUT, removeTempDir } from "./temp-dir-support.js";

const describeGit = nativeGitAvailable() ? describe : describe.skip;

/** test-lib's magic mtime (test_set_magic_mtime): 1234567890 */
const MAGIC = 1234567890;

let home: string;

/** A repository whose index holds stale stat data for `file` (its mtime moved, content same). */
function staleIndexRepo(name: string): string {
  const dir = join(home, name);
  gitOut(home, home, ["init", "-q", "-b", "main", dir]);
  putFile(dir, "file", "content\n");
  gitOut(home, dir, ["add", "file"]);
  gitOut(home, dir, ["commit", "-q", "-m", "initial"]);
  const later = Math.floor(Date.now() / 1000) - 100;
  utimesSync(join(dir, "file"), later, later);
  utimesSync(join(dir, ".git/index"), MAGIC, MAGIC);
  return dir;
}

const indexMtime = (dir: string) => Math.floor(statSync(join(dir, ".git/index")).mtimeMs / 1000);

describeGit("GIT_OPTIONAL_LOCKS twins", () => {
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "optional-locks-twins-"));
  });
  afterAll(() => removeTempDir(home), CLEANUP_TIMEOUT);

  it('t7508-status.sh: "--no-optional-locks prevents index update"', async () => {
    const native = staleIndexRepo("native");
    const ours = staleIndexRepo("ours");

    gitOut(home, native, ["--no-optional-locks", "status"]);
    const git = await openRepo(home, ours, { GIT_OPTIONAL_LOCKS: "0" });
    await git.status().call();
    expect(indexMtime(native)).toBe(MAGIC);
    expect(indexMtime(ours)).toBe(MAGIC);

    gitOut(home, native, ["status"]);
    await (await openRepo(home, ours)).status().call();
    expect(indexMtime(native)).not.toBe(MAGIC);
    expect(indexMtime(ours)).not.toBe(MAGIC);
  });

  it("GIT_OPTIONAL_LOCKS=0 in the environment is --no-optional-locks", async () => {
    const native = staleIndexRepo("native-env");
    const ours = staleIndexRepo("ours-env");
    execFileSync("git", ["status"], {
      cwd: native,
      env: testEnv(home, { GIT_OPTIONAL_LOCKS: "0" }),
    });
    await (await openRepo(home, ours, { GIT_OPTIONAL_LOCKS: "false" })).status().call();
    expect(indexMtime(native)).toBe(MAGIC);
    expect(indexMtime(ours)).toBe(MAGIC);
    // any true value keeps the locks
    await (await openRepo(home, ours, { GIT_OPTIONAL_LOCKS: "1" })).status().call();
    expect(indexMtime(ours)).not.toBe(MAGIC);
  });
});
