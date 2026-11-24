/**
 * `git clean -e <pattern>` against native git (builtin/clean.c: `add_pattern` into an
 * `EXC_CMDL` list, asked before the standard excludes, and the only rules under `-x`): what
 * is removed and what `-n` lists, with `-d`, `-x`, `-X` and path filters.
 *
 * Source: t7300-clean.sh.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { gitOk, openOurs, put, snapshot } from "./merge-native-helpers.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root: string;
let counter = 0;

/** t7300's setup, then the untracked files its tests create, in two directories. */
function twins(): { native: string; ours: string } {
  const n = counter++;
  const out = { native: join(root, `n${n}`), ours: join(root, `o${n}`) };
  for (const dir of [out.native, out.ours]) {
    gitOk(root, root, "init", "-q", "-b", "main", dir);
    put(dir, "src/part1.c", "");
    put(dir, "Makefile", "");
    put(dir, ".gitignore", "build\n*.o\n");
    gitOk(root, dir, "add", ".");
    gitOk(root, dir, "commit", "-q", "-m", "setup");
    put(dir, "src/part2.c", "");
    put(dir, "README", "");
    gitOk(root, dir, "add", ".");
    for (const path of ["a.out", "src/part3.c", "docs/manual.txt", "obj.o", "build/lib.so"]) {
      put(dir, path, "");
    }
    put(dir, "known", "");
    put(dir, "1", "");
    put(dir, "2", "");
    put(dir, "3", "");
    put(dir, "deep/keep/x.o", "");
    put(dir, "deep/keep/y.c", "");
    mkdirSync(join(dir, "empty"));
  }
  return out;
}

/** git's `clean` flags as our setters (`-f` and `-n` the dry-run switch). */
async function ourClean(dir: string, args: string[]) {
  const cmd = (await openOurs(dir)).clean();
  const excludes: string[] = [];
  const paths = new Set<string>();
  let force = 0;
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "-f") force++;
    else if (a === "-n") dryRun = true;
    else if (a === "-d") cmd.setCleanDirectories(true);
    else if (a === "-x") cmd.setIgnore(false);
    else if (a === "-X") cmd.setIgnoredOnly(true);
    else if (a === "-e") excludes.push(args[++i] as string);
    else if (a !== "--") paths.add(a);
  }
  cmd.setDryRun(dryRun).setForceNestedRepositories(force > 1);
  return cmd.setExcludePatterns(excludes).setPaths(paths).call();
}

/** The paths git's `Removing`/`Would remove` lines name, sorted. */
const named = (stdout: string) =>
  stdout
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => l.replace(/^(Removing|Would remove) /, ""))
    .sort();

describeGit("git clean -e against native git (t7300-clean)", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "clean-exclude-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const cases: string[][] = [
    ["-d", "-x", "-e", "src"], // t7300-clean.sh: "git clean -d -x with ignored tracked directory"
    ["-d", "-X", "-e", "src"], // t7300-clean.sh: "git clean -d -X with ignored tracked directory"
    ["-e", "1", "-e", "2"], // t7300-clean.sh: "git clean -e"
    ["-e", "*.out"],
    ["-e", "!*.o"],
    ["-x", "-e", "!*.o"],
    ["-d", "-e", "docs"],
    ["-d", "-e", "docs/"],
    ["-d", "-e", "manual.txt"],
    ["-d", "-e", "!build"],
    ["-d", "-e", "!build", "-e", "build/lib.so"],
    ["-x", "-e", "*.o"],
    ["-d", "-x", "-e", "*.o"],
    ["-d", "-x", "-e", "keep/"],
    ["-X", "-e", "a.out"],
    ["-d", "-X", "-e", "docs"],
    ["-d", "-e", "*.c", "-e", "!part3.c"],
    ["-d", "-e", "empty"],
    ["-e", "3", "--", "1", "3", "deep"],
    ["-d", "-e", "/deep/keep/y.c"],
    ["-ffdx", "-e", "deep"], // t7300-clean.sh: "avoid traversing into ignored directories"
  ];
  for (const args of cases) {
    for (const mode of ["-n", "-f"]) {
      const full = [mode, ...args];
      it(`clean ${full.join(" ")}`, async () => {
        const { native, ours } = twins();
        const expanded = full.flatMap((a) => (a === "-ffdx" ? ["-f", "-f", "-d", "-x"] : [a]));
        const r = spawnSync("git", ["clean", ...expanded], {
          cwd: native,
          env: nativeGitEnv(root),
          encoding: "utf8",
        });
        expect(r.status).toBe(0);
        const result = await ourClean(ours, expanded);
        expect([...result.cleaned].sort()).toEqual(named(r.stdout));
        expect(snapshot(root, ours)).toEqual(snapshot(root, native));
      });
    }
  }
});

describeGit("git clean -e with patterns git's add_pattern takes whole", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "clean-exclude-hash-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  /** t7300's setup plus untracked `#foo`, `#bar` and `x.o` (ignored by `*.o`). */
  function hashTwins(): { native: string; ours: string } {
    const out = twins();
    for (const dir of [out.native, out.ours]) {
      put(dir, "#foo", "");
      put(dir, "#bar", "");
      put(dir, "x.o", "");
    }
    return out;
  }

  const cases: string[][] = [
    ["-e", "#foo"],
    ["-x", "-e", "#foo"],
    ["-d", "-x", "-e", "#foo"],
    ["-X", "-e", "!x.o"],
    ["-x", "-e", "*", "-e", "!#foo"],
  ];
  for (const args of cases) {
    for (const mode of ["-n", "-f"]) {
      const full = [mode, ...args];
      it(`clean ${full.join(" ")}`, async () => {
        const { native, ours } = hashTwins();
        const r = spawnSync("git", ["clean", ...full], {
          cwd: native,
          env: nativeGitEnv(root),
          encoding: "utf8",
        });
        expect(r.status).toBe(0);
        const result = await ourClean(ours, full);
        expect([...result.cleaned].sort()).toEqual(named(r.stdout));
        expect(snapshot(root, ours)).toEqual(snapshot(root, native));
      });
    }
  }
});
