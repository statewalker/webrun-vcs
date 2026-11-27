/**
 * JGit's `ObjectCheckerTest` (org.eclipse.jgit.test, `lib/`) as native twins
 * (statewalker/webrun-vcs#218): the commits, trees, tags and blobs its methods check, written
 * loose with `git hash-object --literally` into a fresh repository each, then checked by
 * native `git fsck` and by ours, plain and `--strict`, the output compared. Only JGit's
 * inputs are taken: native git decides whether an object is broken and how fsck says so.
 *
 * `fixtures/jgit-object-checker.json` holds the objects, keyed by JGit's method name without
 * `test`: every distinct `(type, bytes)` the method hands its checker (`check`,
 * `checkCommit`, `checkTree`, `checkTag`, `checkPathSegment` as a one-entry tree,
 * `assertCorrupt`, `assertSkipList*`), transcribed from JGit 8c695697468e (the method bodies
 * run with a recording checker). The blob-checker methods (JGit's `BlobObjectChecker` hook)
 * and `testInvalidType` (`OBJ_BAD`) have no git object to write.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FsckCommand } from "../src/index.js";
import { gitOk, openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

const FIXTURE: Record<string, [string, string][]> = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures", "jgit-object-checker.json"), "utf8"),
);

describeGit("JGit ObjectCheckerTest against native git fsck", () => {
  let root: string;
  let n = 0;
  let noReferences: string[] = [];
  let compatibility: "2.43" | "2.56" = "2.43";

  function native(cwd: string, args: string[], input?: Uint8Array) {
    const r = spawnSync("git", args, { cwd, env: nativeGitEnv(root), input });
    return { status: r.status ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
  }

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "jgit-object-checker-"));
    const probe = join(root, "probe");
    gitOk(root, root, "init", "-q", probe);
    noReferences =
      native(probe, ["fsck", "--no-references"]).status === 129 ? [] : ["--no-references"];
    const version = /(\d+)\.(\d+)/.exec(native(probe, ["--version"]).stdout);
    if (version && (Number(version[1]) > 2 || Number(version[2]) >= 45)) compatibility = "2.56";
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  /** A fresh repository holding the objects, written as they are. */
  function repository(objects: [string, string][]): string {
    const dir = join(root, `r${n++}`);
    gitOk(root, root, "init", "-q", "-b", "main", dir);
    for (const [type, hex] of objects) {
      const r = native(
        dir,
        ["hash-object", "-t", type, "--literally", "-w", "--stdin"],
        Buffer.from(hex, "hex"),
      );
      expect(r.status, r.stderr).toBe(0);
    }
    return dir;
  }

  /** As fsck-native.test.ts: the version differences of git's messages evened out. */
  function normalize(text: string): string[] {
    return text
      .split("\n")
      .filter((l) => l !== "" && !/^notice: .* points to an unborn branch/.test(l))
      .map((l) =>
        l.replace(
          /^error: ([0-9a-f]{40}): object (?:could not be parsed: \S+|corrupt or missing)$/,
          "error: $1: object could not be parsed",
        ),
      );
  }

  /** Lines of objects of one fan-out directory that collide in git's hash table, sorted. */
  function normalizeOrder(lines: string[]): string[] {
    const out: string[] = [];
    let run: string[] = [];
    let key: string | undefined;
    for (const line of lines) {
      const k = /[0-9a-f]{40}/.exec(line)?.[0].slice(0, 2);
      if (k === undefined || k !== key) {
        out.push(...run.sort());
        run = [];
      }
      key = k;
      run.push(line);
    }
    out.push(...run.sort());
    return out;
  }

  async function compare(
    dir: string,
    args: string[],
    configure: (c: FsckCommand) => FsckCommand,
    label: string,
  ) {
    const theirs = native(dir, ["fsck", ...noReferences, ...args]);
    const git = await openOurs(dir);
    const files = createNodeFilesApi({ rootDir: dir });
    const ours = await configure(
      git.fsck().setRepositoryFiles({ files }).setCompatibility(compatibility),
    ).call();
    expect(
      {
        stdout: normalizeOrder(normalize(ours.output)),
        stderr: normalize(ours.errorOutput).sort(),
        exit: ours.exitCode,
      },
      `fsck ${args.join(" ")}: ${label}`,
    ).toEqual({
      stdout: normalizeOrder(normalize(theirs.stdout)),
      stderr: normalize(theirs.stderr).sort(),
      exit: theirs.status,
    });
  }

  for (const [name, objects] of Object.entries(FIXTURE)) {
    it(`JGit ObjectCheckerTest#test${name}`, async () => {
      const dir = repository(objects);
      const label = objects.map(([t, h]) => `${t} ${h}`).join(", ");
      await compare(dir, [], (c) => c, label);
      await compare(dir, ["--strict"], (c) => c.setStrict(true), label);
    });
  }
});
