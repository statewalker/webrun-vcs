/**
 * `git rm --cached` pathspecs against native git (builtin/rm.c): which entries an element
 * removes (2.43 stops a glob-looking element after it named an entry exactly), `-r` for an
 * element naming a directory, and the elements matching nothing. Each case builds the same
 * repository twice, runs native git in one and ours in the other, and compares the index
 * and what failed.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { git, gitOk, openOurs, put, snapshot } from "./merge-native-helpers.js";
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

/**
 * check_local_mod and the worktree removal: a repository with a, b, c, x, y, d/e/f, z and
 * w committed, then a and b staged and changed again, c staged, x and y changed, z replaced
 * by a directory, w deleted, n added with intent to add.
 */
function dirtyTwins(): { native: string; ours: string } {
  const n = counter++;
  const out = { native: join(root, `n${n}`), ours: join(root, `o${n}`) };
  for (const dir of [out.native, out.ours]) {
    gitOk(root, root, "init", "-q", "-b", "main", dir);
    for (const path of ["a", "b", "c", "x", "y", "d/e/f", "z", "w"]) put(dir, path, `${path}\n`);
    gitOk(root, dir, "add", ".");
    gitOk(root, dir, "commit", "-q", "-m", "c");
    for (const path of ["a", "b", "c"]) put(dir, path, "staged\n");
    gitOk(root, dir, "add", "a", "b", "c");
    for (const path of ["a", "b", "x", "y"]) put(dir, path, "changed\n");
    rmSync(join(dir, "z"));
    put(dir, "z/inside", "inside\n");
    rmSync(join(dir, "w"));
    put(dir, "n", "n\n");
    gitOk(root, dir, "add", "-N", "n");
  }
  return out;
}

/** The directories of the worktree (empty ones too), outside .git. */
const dirs = (dir: string) =>
  execFileSync("find", [".", "-path", "./.git", "-prune", "-o", "-type", "d", "-print"], {
    cwd: dir,
    encoding: "utf8",
  })
    .split("\n")
    .sort()
    .join("\n");

describeGit("git rm refusing to lose content, and its worktree removal, against native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "rm-local-mod-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const cases: { args: string[]; cached?: boolean; force?: boolean; hints?: boolean }[] = [
    { args: ["a"], cached: true },
    { args: ["a", "b", "c", "x"], cached: true },
    { args: ["n"], cached: true },
    { args: ["c", "x", "y"], cached: true },
    { args: ["a", "b", "c", "x", "y"] },
    { args: ["c", "x"] },
    { args: ["c", "x", "a"], hints: false },
    { args: ["n"] },
    { args: ["d/e/f"] },
    { args: ["w", "d/e/f"] },
    { args: ["z"] },
    { args: ["z", "d/e/f"] },
    { args: ["d/e/f", "z"] },
    { args: ["a", "b", "c", "x", "y", "n"], force: true },
  ];
  for (const { args, cached = false, force = false, hints = true } of cases) {
    const flags = [...(cached ? ["--cached"] : []), ...(force ? ["-f"] : [])];
    it(`rm ${hints ? "" : "(advice.rmHints off) "}${[...flags, ...args].join(" ")}`, async () => {
      const { native, ours } = dirtyTwins();
      if (!hints)
        for (const dir of [native, ours]) gitOk(root, dir, "config", "advice.rmHints", "false");
      const r = run(native, ["rm", "-q", ...flags, "--", ...args]);
      const cmd = (await openOurs(ours)).rm().setCached(cached).setForce(force);
      for (const p of args) cmd.addFilepattern(p);
      let error = "";
      try {
        await cmd.call();
      } catch (e) {
        error = (e as Error).message;
      }
      expect(error).toBe(r.stderr.trim());
      expect(snapshot(root, ours)).toEqual(snapshot(root, native));
      expect(dirs(ours)).toBe(dirs(native));
    });
  }
});

/**
 * Data safety of `git rm` against native git: entries passed over (skip-worktree without
 * `--sparse`, whatever `core.sparseCheckout` says), every stage of an unmerged path removed
 * (with resolve-undo), a submodule holding changes refused (`bad_to_remove_submodule`) and
 * a clean one removed with its `.gitmodules` section, a path reached through a symbolic
 * link, and a removal failing partway.
 */
describeGit("git rm data safety against native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "rm-safety-"));
  });
  afterAll(() => {
    // a directory left read-only by the failing-removal case
    spawnSync("chmod", ["-R", "u+rwx", root]);
    rmSync(root, { recursive: true, force: true });
  });

  /** One repository built twice by `build` (run in each twin). */
  function built(build: (dir: string) => void): { native: string; ours: string } {
    const n = counter++;
    const out = { native: join(root, `n${n}`), ours: join(root, `o${n}`) };
    for (const dir of [out.native, out.ours]) {
      gitOk(root, root, "init", "-q", "-b", "main", dir);
      build(dir);
    }
    return out;
  }

  /** Native `git rm -q <args>` in one twin, ours with the same options in the other. */
  async function rmBoth(
    twin: { native: string; ours: string },
    args: string[],
    options: { cached?: boolean; recursive?: boolean; force?: boolean; sparse?: boolean } = {},
  ) {
    const flags = [
      ...(options.cached ? ["--cached"] : []),
      ...(options.recursive ? ["-r"] : []),
      ...(options.force ? ["-f"] : []),
      ...(options.sparse ? ["--sparse"] : []),
    ];
    const r = run(twin.native, ["rm", "-q", ...flags, "--", ...args]);
    const cmd = (await openOurs(twin.ours))
      .rm()
      .setCached(options.cached === true)
      .setRecursive(options.recursive === true)
      .setForce(options.force === true)
      .setSparse(options.sparse === true)
      .setCompatibility(version);
    for (const p of args) cmd.addFilepattern(p);
    let error = "";
    try {
      await cmd.call();
    } catch (e) {
      error = (e as Error).message;
    }
    return { native: r, error };
  }

  function expectSame(twin: { native: string; ours: string }) {
    expect(snapshot(root, twin.ours)).toEqual(snapshot(root, twin.native));
    expect(dirs(twin.ours)).toBe(dirs(twin.native));
    expect(gitOk(root, twin.ours, "ls-files", "--resolve-undo")).toBe(
      gitOk(root, twin.native, "ls-files", "--resolve-undo"),
    );
  }

  const skipWorktree = (dir: string) => {
    for (const path of ["a", "t", "d/a", "d/b"]) put(dir, path, `${path}\n`);
    gitOk(root, dir, "add", ".");
    gitOk(root, dir, "commit", "-q", "-m", "c");
    gitOk(root, dir, "update-index", "--skip-worktree", "a", "d/a");
    put(dir, "a", "mod\n");
    put(dir, "d/a", "mod\n");
  };
  // each case with the runs that follow it (the last: --sparse removes the entry)
  const skipCases: { args: string[]; recursive?: boolean; sparse?: boolean }[][] = [
    [{ args: ["a"] }, { args: ["a"], sparse: true }],
    [{ args: ["a", "t"] }],
    [{ args: ["d"], recursive: true }],
  ];
  for (const runs of skipCases) {
    const name = runs
      .map((r) => `rm ${r.sparse ? "--sparse " : ""}${r.recursive ? "-r " : ""}${r.args.join(" ")}`)
      .join(", then ");
    it(`passes over skip-worktree entries without a sparse checkout: ${name}`, async () => {
      const twin = built(skipWorktree);
      for (const { args, ...options } of runs) {
        const { native, error } = await rmBoth(twin, args, options);
        expect(error).toBe(native.stderr.trim());
        expectSame(twin);
      }
    });
  }

  const unmerged = (dir: string) => {
    put(dir, "c", "base\n");
    put(dir, "k", "k\n");
    gitOk(root, dir, "add", ".");
    gitOk(root, dir, "commit", "-q", "-m", "c");
    gitOk(root, dir, "checkout", "-q", "-b", "side");
    put(dir, "c", "side\n");
    gitOk(root, dir, "commit", "-q", "-am", "s");
    gitOk(root, dir, "checkout", "-q", "main");
    put(dir, "c", "main\n");
    gitOk(root, dir, "commit", "-q", "-am", "m");
    git(root, dir, "merge", "side");
  };
  for (const cached of [false, true]) {
    it(`removes every stage of an unmerged path: rm ${cached ? "--cached " : ""}c`, async () => {
      const twin = built(unmerged);
      const { native, error } = await rmBoth(twin, ["c"], { cached });
      expect(native.status).toBe(0);
      expect(error).toBe("");
      expectSame(twin);
      expect(gitOk(root, twin.ours, "ls-files", "-s", "c")).toBe("");
    });
  }

  /** A repository to clone as a submodule, made once. */
  let upstream: string | undefined;
  const submodule = (dir: string) => {
    if (!upstream) {
      upstream = join(root, "up");
      gitOk(root, root, "init", "-q", "-b", "main", upstream);
      put(upstream, "u", "u\n");
      put(upstream, ".gitignore", "ign\n");
      gitOk(root, upstream, "add", ".");
      gitOk(root, upstream, "commit", "-q", "-m", "u");
    }
    put(dir, "k", "k\n");
    gitOk(root, dir, "add", "k");
    gitOk(root, dir, "commit", "-q", "-m", "k");
    gitOk(root, dir, "-c", "protocol.file.allow=always", "submodule", "add", "-q", upstream, "sub");
    gitOk(root, dir, "commit", "-q", "-m", "sub");
  };
  const changes: Record<string, (dir: string) => void> = {
    clean: () => {},
    modified: (dir) => put(dir, "sub/u", "changed\n"),
    untracked: (dir) => put(dir, "sub/new", "new\n"),
    ignored: (dir) => put(dir, "sub/ign", "ignored\n"),
    staged: (dir) => {
      put(dir, "sub/u", "staged\n");
      gitOk(root, join(dir, "sub"), "add", "u");
    },
    committed: (dir) => {
      put(dir, "sub/u", "committed\n");
      gitOk(root, join(dir, "sub"), "commit", "-q", "-am", "y");
    },
    "unstaged .gitmodules": (dir) => put(dir, ".gitmodules", "# edited\n"),
    // git's inner status passes -uall: the submodule's own mode does not hide the file
    "untracked under status.showUntrackedFiles=no": (dir) => {
      put(dir, "sub/new", "new\n");
      gitOk(root, join(dir, "sub"), "config", "status.showUntrackedFiles", "no");
    },
  };
  // each kind of change without and with --cached (which refuses none of them)
  for (const kinds of [
    ["clean"],
    ["modified"],
    ["untracked"],
    ["untracked under status.showUntrackedFiles=no"],
    ["ignored"],
    ["staged", "committed"],
    ["unstaged .gitmodules"],
  ]) {
    it(`a submodule ${kinds.join(", or ")}: rm sub, rm --cached sub`, async () => {
      for (const kind of kinds) {
        for (const cached of [false, true]) {
          const twin = built((dir) => {
            submodule(dir);
            changes[kind]?.(dir);
          });
          const { native, error } = await rmBoth(twin, ["sub"], { cached });
          expect(error).toBe(native.stderr.trim());
          expectSame(twin);
        }
      }
    });
  }

  it("a submodule whose status.showUntrackedFiles git cannot read: rm dies, nothing removed", async () => {
    for (const cached of [false, true]) {
      const twin = built((dir) => {
        submodule(dir);
        gitOk(root, join(dir, "sub"), "config", "status.showUntrackedFiles", "bogus");
      });
      const { native, error } = await rmBoth(twin, ["k", "sub"], { cached });
      expect(native.status).toBe(128);
      expect(native.stderr).toContain("fatal: could not run 'git status' in submodule 'sub'");
      // git names the configuration file by its absolute path, ours relative to the files root
      expect(error).toBe(native.stderr.split(`${twin.native}/`).join("").trim());
      // (a status of the superproject dies the same way: the index and files compared)
      expect(index(twin.native)).toContain("\tk\n");
      expect(index(twin.ours)).toBe(index(twin.native));
      for (const path of ["k", "sub/u"]) {
        expect([path, existsSync(join(twin.ours, path))]).toEqual([path, true]);
      }
    }
  });

  /** `d/f` and `t` committed, then `d` replaced by a link to `e`, which `fill` fills. */
  const linked = (target: string, fill: (dir: string) => void) => (dir: string) => {
    put(dir, "d/f", "f\n");
    put(dir, "t", "t\n");
    gitOk(root, dir, "add", ".");
    gitOk(root, dir, "commit", "-q", "-m", "c");
    rmSync(join(dir, "d"), { recursive: true });
    fill(dir);
    symlinkSync(target, join(dir, "d"));
  };
  const linkCases: [string, string, (dir: string) => void, string[]][] = [
    ["a file", "e", (dir) => put(dir, "e/f", "elsewhere\n"), ["d/f"]],
    ["a directory", "e", (dir) => put(dir, "e/f/inside", "inside\n"), ["d/f"]],
    ["a directory, then another path", "e", (dir) => put(dir, "e/f/inside", "x\n"), ["d/f", "t"]],
    // one directory beyond both twins, which the link in each names
    [
      "a file outside the worktree",
      "../outside-e",
      (dir) => put(join(dir, ".."), "outside-e/f", "outside\n"),
      ["d/f"],
    ],
  ];
  for (const [what, target, fill, args] of linkCases) {
    it(`a path beyond a symbolic link to ${what}: rm ${args.join(" ")}`, async () => {
      const twin = built(linked(target, fill));
      const { native, error } = await rmBoth(twin, args);
      expect(error).toBe(native.stderr.trim());
      expectSame(twin);
      if (what !== "a file") return;
      // the link's target emptied: the file vanished, its entry removed
      for (const dir of [twin.native, twin.ours]) rmSync(join(dir, "e/f"));
      const again = await rmBoth(twin, args);
      expect(again.error).toBe(again.native.stderr.trim());
      expect(again.native.status).toBe(0);
      expectSame(twin);
    });
  }

  it("a removal failing after another one went: the index is written all the same", async () => {
    // b/x cannot be unlinked (its directory read-only); a and c can
    const twin = built((dir) => {
      for (const path of ["a", "b/x", "c"]) put(dir, path, `${path}\n`);
      gitOk(root, dir, "add", ".");
      gitOk(root, dir, "commit", "-q", "-m", "c");
    });
    const failing: NonNullable<Parameters<typeof openOurs>[2]> = (files) =>
      new Proxy(files, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver);
          if (prop !== "remove" || typeof value !== "function") return value;
          return async (path: string, ...rest: unknown[]) => {
            if (path.replace(/^\/+/, "") === "b/x") {
              throw Object.assign(new Error("EACCES: permission denied, unlink"), {
                code: "EACCES",
              });
            }
            return value.call(target, path, ...rest);
          };
        },
      });
    const ours = async (args: string[]) => {
      const cmd = (await openOurs(twin.ours, undefined, failing)).rm();
      for (const p of args) cmd.addFilepattern(p);
      try {
        return { result: await cmd.call(), error: "" };
      } catch (e) {
        return { result: undefined, error: (e as Error).message };
      }
    };
    // native git as an unprivileged user (root unlinks anywhere), or as itself when it is one
    const nativeRm = (args: string[]) => {
      chmodSync(join(twin.native, "b"), 0o555);
      try {
        if (process.getuid?.() !== 0) return run(twin.native, ["rm", "-q", "--", ...args]);
        spawnSync("chown", ["-R", "65534:65534", twin.native]);
        // (the temporary directory holding the twins is private to its owner)
        chmodSync(root, 0o711);
        const r = spawnSync(
          "setpriv",
          ["--reuid=65534", "--regid=65534", "--clear-groups", "git", "rm", "-q", "--", ...args],
          { cwd: twin.native, env: nativeGitEnv(root), encoding: "utf8" },
        );
        spawnSync("chown", ["-R", "0:0", twin.native]);
        chmodSync(root, 0o700);
        // the git on PATH cannot be run by that user: git's behaviour (builtin/rm.c) instead
        if (r.error || (r.status !== 0 && !(r.stderr ?? "").startsWith("fatal: git rm:")))
          return undefined;
        return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
      } finally {
        chmodSync(join(twin.native, "b"), 0o755);
      }
    };
    // the first removal fails: nothing changes
    const first = await ours(["b/x", "c"]);
    expect(first.error).toBe("fatal: git rm: 'b/x': Permission denied");
    const firstNative = nativeRm(["b/x", "c"]);
    if (firstNative) expect(first.error).toBe(firstNative.stderr.trim());
    expectSame(twin);
    // a removal after the first fails: passed over, the rest removed and the index written
    const later = await ours(["a", "b/x", "c"]);
    expect(later.error).toBe("");
    expect(later.result?.warnings).toEqual(["warning: git rm: 'b/x': Permission denied"]);
    const laterNative = nativeRm(["a", "b/x", "c"]);
    if (laterNative) {
      expect(laterNative.stderr).toBe("");
      expectSame(twin);
    }
    expect(gitOk(root, twin.ours, "ls-files")).toBe("");
    expect(dirs(twin.ours)).toBe("\n.\n./b");
  });
});
