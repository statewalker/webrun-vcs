/**
 * `git rm --cached` pathspecs against native git (builtin/rm.c): which entries an element
 * removes (2.43 stops a glob-looking element after it named an entry exactly), `-r` for an
 * element naming a directory, and the elements matching nothing. Each case builds the same
 * repository twice, runs native git in one and ours in the other, and compares the index
 * and what failed.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { gitOk, openOurs, put } from "./merge-native-helpers.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;
/** The git version on PATH: 2.43 or 2.5x. */
const version = (() => {
  try {
    const out = execFileSync("git", ["--version"], { encoding: "utf8" });
    return /git version 2\.(5\d|[6-9]\d)/.test(out) ? "2.56" : "2.43";
  } catch {
    return "2.56";
  }
})();

let root: string;
let counter = 0;

function run(cwd: string, args: string[]) {
  const r = spawnSync("git", args, { cwd, env: nativeGitEnv(root), encoding: "utf8" });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Two repositories with `b*`, `b.txt`, `ba`, `d/[x]`, `d/x`, `d/y/z` and `top` committed. */
function twins(): { native: string; ours: string } {
  const n = counter++;
  const out = { native: join(root, `n${n}`), ours: join(root, `o${n}`) };
  for (const dir of [out.native, out.ours]) {
    gitOk(root, root, "init", "-q", "-b", "main", dir);
    for (const path of ["b*", "b.txt", "ba", "d/[x]", "d/x", "d/y/z", "top"]) {
      put(dir, path, `${path}\n`);
    }
    gitOk(root, dir, "add", ".");
    gitOk(root, dir, "commit", "-q", "-m", "c");
  }
  return out;
}

const index = (dir: string) => gitOk(root, dir, "ls-files", "--stage");

describeGit("git rm --cached pathspecs against native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "rm-pathspec-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const cases: [string[], boolean][] = [
    [["b*"], false],
    [["d/[x]"], false],
    [["b?txt"], false],
    [["*"], false],
    [["d"], false],
    [["d/"], false],
    [["."], false],
    [[":(exclude)top"], false],
    [["top", "d"], false],
    [["d", "nothing"], false],
    [["nothing", "d"], false],
    [["d"], true],
    [["."], true],
    [[":(exclude)top"], true],
    [["d/y"], true],
  ];
  for (const [spec, recursive] of cases) {
    it(`rm --cached ${recursive ? "-r " : ""}${spec.join(" ")}`, async () => {
      const { native, ours } = twins();
      const r = run(native, ["rm", "-q", "--cached", ...(recursive ? ["-r"] : []), "--", ...spec]);
      const cmd = (await openOurs(ours))
        .rm()
        .setCached(true)
        .setRecursive(recursive)
        .setCompatibility(version);
      for (const p of spec) cmd.addFilepattern(p);
      let error = "";
      try {
        await cmd.call();
      } catch (e) {
        error = (e as Error).message;
      }
      expect(error).toBe(r.stderr.trim());
      expect(index(ours)).toBe(index(native));
    });
  }

  it("--ignore-unmatch passes over an element matching nothing", async () => {
    const { native, ours } = twins();
    const r = run(native, ["rm", "-q", "--cached", "--ignore-unmatch", "--", "nothing", "top"]);
    expect(r.status).toBe(0);
    await (await openOurs(ours))
      .rm()
      .setCached(true)
      .setIgnoreUnmatch(true)
      .addFilepattern("nothing")
      .addFilepattern("top")
      .call();
    expect(index(ours)).toBe(index(native));
  });
});
