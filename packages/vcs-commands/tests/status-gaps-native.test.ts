/**
 * Status renames, dirty submodule content, absolute submodule gitdirs and `clean -X`
 * against native git: each repository is read by native `git status --porcelain` (v1 and v2,
 * default configuration: `status.renames=true`) and by our StatusCommand, byte for byte.
 * Twins that change the worktree are built twice by the same steps (never copied: a copy
 * changes inodes and loses nanoseconds).
 */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFileWorktree,
  createGitFilesBackend,
  FileStagingStore,
  GitCheckout,
  type GitCheckoutFilesApi,
  GitWorkingCopyConfig,
} from "@statewalker/vcs-store-files";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { MemoryWorkingCopy } from "@statewalker/vcs-working-tree";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { formatStatusPorcelain, Git, type StatusCommand } from "../src/index.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root: string;
const exec = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    env: nativeGitEnv(root),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
const run = (cwd: string, ...args: string[]) => exec(cwd, ...args).trim();
const nativeStatus = (dir: string, version: 1 | 2, ...extra: string[]) =>
  exec(dir, "status", `--porcelain=v${version}`, "--untracked-files=all", ...extra);
const put = (dir: string, path: string, content: string) => {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), content);
};
const lines = (n: number, tag = "l") =>
  Array.from({ length: n }, (_, i) => `${tag} line ${i} of the file\n`).join("");

/** Every path of the worktree (outside `.git`), sorted. */
function listing(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (path === ".git") continue;
    out.push(path);
    if (entry.isDirectory()) out.push(...listing(dir, path));
  }
  return out.sort();
}

/** Our working copy over a repository native git made in `dir`. */
async function open(dir: string) {
  const files = createNodeFilesApi({ rootDir: dir });
  const { history } = await createGitFilesBackend({ files });
  const io = {
    read: async (path: string) => {
      try {
        return new Uint8Array(readFileSync(join(dir, path)));
      } catch {
        return undefined;
      }
    },
    write: async (path: string, content: Uint8Array) => writeFileSync(join(dir, path), content),
  };
  const config = new GitWorkingCopyConfig(io, ".git/config");
  await config.load();
  const staging = new FileStagingStore(files, ".git/index");
  await staging.read();
  const checkout = new GitCheckout({
    staging,
    refs: history.refs,
    files: {
      read: io.read,
      write: (p: string, c: Uint8Array) => files.write(p, [c]),
      stats: async () => undefined,
      remove: async () => {},
    } as unknown as GitCheckoutFilesApi,
    gitDir: ".git",
  });
  const worktree = createFileWorktree({
    files,
    rootPath: "",
    gitDir: ".git",
    blobs: history.blobs,
    trees: history.trees,
  });
  const wc = new MemoryWorkingCopy({ history, checkout, worktree, config });
  return { ours: Git.fromWorkingCopy(wc), wc, worktree };
}

/** A repository with a few committed files on main. */
function repo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  run(dir, "init", "-q", "-b", "main");
  put(dir, "a.txt", lines(20, "a"));
  put(dir, "b.txt", lines(12, "b"));
  put(dir, "c.txt", "c\n");
  put(dir, "d/e.txt", lines(8, "e"));
  put(dir, "d/f.txt", "f\n");
  run(dir, "add", ".");
  run(dir, "commit", "-q", "-m", "c1");
}

/**
 * Our status (porcelain v1 and v2), configured by `configure`, equals native git's with
 * `extra` arguments.
 */
async function expectStatusAs(
  dir: string,
  configure: (status: StatusCommand) => StatusCommand = (s) => s,
  extra: string[] = [],
) {
  let last: Awaited<ReturnType<StatusCommand["call"]>> | undefined;
  for (const version of [1, 2] as const) {
    const { ours } = await open(dir);
    last = await configure(ours.status()).call();
    expect(formatStatusPorcelain(last, version), `porcelain v${version}`).toBe(
      nativeStatus(dir, version, ...extra),
    );
  }
  return last as Awaited<ReturnType<StatusCommand["call"]>>;
}

describeGit("status renames against native git (status.renames)", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "status-renames-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const at = (name: string, setup: (d: string) => void) => {
    const d = join(root, name);
    repo(d);
    setup(d);
    return d;
  };

  it("a staged git mv is R (exact), and RM once the new file is edited", async () => {
    const status = await expectStatusAs(
      at("mv", (d) => {
        run(d, "mv", "a.txt", "x.txt");
        mkdirSync(join(d, "moved"));
        run(d, "mv", "d/e.txt", "moved/e.txt");
        put(d, "moved/e.txt", `${lines(8, "e")}one more\n`);
      }),
    );
    expect(status.renamed).toEqual(
      new Map([
        ["x.txt", "a.txt"],
        ["moved/e.txt", "d/e.txt"],
      ]),
    );
    expect(status.files.find((f) => f.path === "x.txt")?.renameScore).toBe(100);
  });

  it("delete + add of a similar file (>= 50%) is a rename with git's score; < 50% is not", async () => {
    await expectStatusAs(
      at("similar", (d) => {
        run(d, "rm", "-q", "a.txt", "b.txt");
        put(d, "a2.txt", `${lines(20, "a").slice(0, 300)}changed tail\nmore\n`);
        put(d, "b2.txt", `${lines(3, "b")}${lines(20, "zzz")}`);
        run(d, "add", "a2.txt", "b2.txt");
      }),
    );
  });

  it("several candidates: identical blobs, a same basename preferred, empty files", async () => {
    await expectStatusAs(
      at("candidates", (d) => {
        put(d, "dup1.txt", "dup\n");
        put(d, "dup2.txt", "dup\n");
        put(d, "empty", "");
        run(d, "add", ".");
        run(d, "commit", "-qm", "dups");
        run(d, "rm", "-q", "dup1.txt", "dup2.txt", "empty");
        put(d, "x/dup2.txt", "dup\n");
        put(d, "y/other.txt", "dup\n");
        put(d, "empty2", "");
        run(d, "add", ".");
      }),
    );
  });

  it("modes, links, quoted paths and a rename into a new directory", async () => {
    await expectStatusAs(
      at("modes", (d) => {
        symlinkSync("a.txt", join(d, "link"));
        run(d, "add", "link");
        run(d, "commit", "-qm", "link");
        run(d, "mv", "link", "link2");
        run(d, "mv", "b.txt", 'sp ace "q".txt');
        mkdirSync(join(d, "deep/er"), { recursive: true });
        run(d, "mv", "c.txt", "deep/er/c.txt");
        run(d, "rm", "-q", "d/f.txt");
        put(d, "f-exec", "f\n");
        chmodSync(join(d, "f-exec"), 0o755);
        run(d, "add", "f-exec");
      }),
    );
  });

  it("worktree side: only intent-to-add files are paired; untracked files never", async () => {
    await expectStatusAs(
      at("worktree", (d) => {
        renameSync(join(d, "a.txt"), join(d, "n.txt"));
        run(d, "add", "-N", "n.txt");
        rmSync(join(d, "b.txt"));
        put(d, "b-similar.txt", `${lines(12, "b")}extra\n`);
        run(d, "add", "-N", "b-similar.txt");
        // an untracked copy is not paired with the deleted file
        renameSync(join(d, "c.txt"), join(d, "c-untracked.txt"));
      }),
    );
  });

  it("an index rename and a worktree rename of the same file", async () => {
    await expectStatusAs(
      at("both", (d) => {
        run(d, "mv", "a.txt", "c2.txt");
        renameSync(join(d, "c2.txt"), join(d, "d2.txt"));
        run(d, "add", "-N", "d2.txt");
        put(d, "s.txt", lines(15, "s"));
        run(d, "add", "s.txt");
        renameSync(join(d, "s.txt"), join(d, "t.txt"));
        run(d, "add", "-N", "t.txt");
      }),
    );
  });

  it("status.renames=false, diff.renames=false, and status.renames over diff.renames", async () => {
    const setup = (d: string) => {
      run(d, "mv", "a.txt", "x.txt");
      renameSync(join(d, "b.txt"), join(d, "y.txt"));
      run(d, "add", "-N", "y.txt");
    };
    const off = await expectStatusAs(
      at("status-off", (d) => {
        setup(d);
        run(d, "config", "status.renames", "false");
      }),
    );
    expect(off.renamed.size).toBe(0);
    await expectStatusAs(
      at("diff-off", (d) => {
        setup(d);
        run(d, "config", "diff.renames", "false");
      }),
    );
    const on = await expectStatusAs(
      at("status-over-diff", (d) => {
        setup(d);
        run(d, "config", "diff.renames", "false");
        run(d, "config", "status.renames", "true");
      }),
    );
    expect(on.renamed.size).toBe(2);
    await expectStatusAs(
      at("copies", (d) => {
        setup(d);
        run(d, "config", "status.renames", "copies");
      }),
    );
  });

  it("setRenames(false) as --no-renames, setRenames(true) as --renames", async () => {
    const d = at("flags", (dir) => {
      run(dir, "mv", "a.txt", "x.txt");
      run(dir, "config", "status.renames", "false");
    });
    await expectStatusAs(d, (s) => s.setRenames(true), ["--renames"]);
    run(d, "config", "status.renames", "true");
    await expectStatusAs(d, (s) => s.setRenames(false), ["--no-renames"]);
  });

  it("diff.renameLimit / status.renameLimit stop inexact renames, never exact ones", async () => {
    const setup = (d: string) => {
      run(d, "rm", "-q", "a.txt", "b.txt", "d/e.txt");
      put(d, "a2.txt", `${lines(20, "a")}x\n`);
      put(d, "b2.txt", `${lines(12, "b")}y\n`);
      put(d, "e-same.txt", lines(8, "e"));
      run(d, "add", ".");
    };
    const limited = await expectStatusAs(
      at("limit", (d) => {
        setup(d);
        run(d, "config", "diff.renameLimit", "1");
      }),
    );
    expect([...limited.renamed]).toEqual([["e-same.txt", "d/e.txt"]]);
    await expectStatusAs(
      at("status-limit", (d) => {
        setup(d);
        run(d, "config", "diff.renameLimit", "1");
        run(d, "config", "status.renameLimit", "5");
      }),
    );
    const d = at("api-limit", setup);
    for (const version of [1, 2] as const) {
      const { ours } = await open(d);
      const status = await ours.status().setRenameLimit(1).call();
      const native = exec(
        d,
        "-c",
        "status.renameLimit=1",
        "status",
        `--porcelain=v${version}`,
        "--untracked-files=all",
      );
      expect(formatStatusPorcelain(status, version)).toBe(native);
    }
  });

  it("regression: a staged rename is one R line, not D and A (as origin/main showed)", async () => {
    const d = at("regression", (dir) => run(dir, "mv", "a.txt", "x.txt"));
    const { ours } = await open(d);
    const v1 = formatStatusPorcelain(await ours.status().call(), 1);
    expect(v1).toBe("R  a.txt -> x.txt\n");
    const { ours: again } = await open(d);
    const v2 = formatStatusPorcelain(await again.status().call(), 2);
    expect(v2).toMatch(
      /^2 R\. N\.\.\. 100644 100644 100644 [0-9a-f]{40} [0-9a-f]{40} R100 x\.txt\ta\.txt\n$/,
    );
  });
});

/** A repository with a submodule `sub` added by git (gitfile `../.git/modules/sub`). */
function superproject(dir: string, upstream: string, path = "sub"): void {
  if (!existsSync(upstream)) repo(upstream);
  repo(dir);
  exec(dir, "-c", "protocol.file.allow=always", "submodule", "add", "-q", upstream, path);
  run(dir, "commit", "-qm", "sub");
}

describeGit("dirty submodule content in status against native git", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "status-submodule-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const at = (name: string, setup: (d: string) => void) => {
    const d = join(root, name);
    superproject(d, join(root, "up"));
    setup(d);
    return d;
  };
  /** Tracked change, untracked file and a new commit in the submodule. */
  const allDirty = (d: string) => {
    const sub = join(d, "sub");
    put(sub, "c.txt", "new commit\n");
    run(sub, "commit", "-qam", "moved");
    put(sub, "a.txt", "changed\n");
    put(sub, "untracked.txt", "u\n");
  };

  it("tracked changes (S.M.), staged ones, untracked files (S..U), all at once (SCMU)", async () => {
    const modified = await expectStatusAs(
      at("modified", (d) => put(join(d, "sub"), "a.txt", "changed\n")),
    );
    expect(modified.files[0]).toMatchObject({ path: "sub", submoduleModified: true });
    await expectStatusAs(
      at("staged", (d) => {
        put(join(d, "sub"), "new.txt", "n\n");
        run(join(d, "sub"), "add", "new.txt");
      }),
    );
    const untracked = await expectStatusAs(
      at("untracked", (d) => put(join(d, "sub"), "u.txt", "u\n")),
    );
    expect(untracked.modified).toEqual(new Set(["sub"]));
    await expectStatusAs(at("all", allDirty));
    // a clean submodule stays clean
    const clean = await expectStatusAs(at("clean", () => {}));
    expect(clean.isClean()).toBe(true);
  });

  it("a submodule whose .git is a directory (cloned in place) is read too", async () => {
    const d = join(root, "inplace");
    repo(d);
    mkdirSync(join(d, "sub"));
    run(join(d, "sub"), "init", "-q", "-b", "main");
    put(join(d, "sub"), "x.txt", "x\n");
    run(join(d, "sub"), "add", ".");
    run(join(d, "sub"), "commit", "-qm", "x");
    run(d, "add", "sub");
    run(d, "commit", "-qm", "sub");
    put(join(d, "sub"), "x.txt", "changed\n");
    put(join(d, "sub"), "y.txt", "y\n");
    await expectStatusAs(d);
  });

  it("diff.ignoreSubmodules none, untracked, dirty and all", async () => {
    for (const mode of ["none", "untracked", "dirty", "all"]) {
      await expectStatusAs(
        at(`diff-${mode}`, (d) => {
          allDirty(d);
          run(d, "config", "diff.ignoreSubmodules", mode);
        }),
      );
    }
  });

  it("submodule.<name>.ignore in the config and in .gitmodules; the config wins", async () => {
    for (const mode of ["none", "untracked", "dirty", "all"]) {
      await expectStatusAs(
        at(`config-${mode}`, (d) => {
          allDirty(d);
          run(d, "config", "diff.ignoreSubmodules", "all");
          run(d, "config", "submodule.sub.ignore", mode);
        }),
      );
      await expectStatusAs(
        at(`gitmodules-${mode}`, (d) => {
          put(join(d, "sub"), "u.txt", "u\n");
          run(d, "config", "-f", ".gitmodules", "submodule.sub.ignore", mode);
          run(d, "add", ".gitmodules");
          run(d, "commit", "-qm", "ignore");
        }),
      );
    }
    await expectStatusAs(
      at("config-over-gitmodules", (d) => {
        put(join(d, "sub"), "a.txt", "changed\n");
        run(d, "config", "-f", ".gitmodules", "submodule.sub.ignore", "all");
        run(d, "add", ".gitmodules");
        run(d, "commit", "-qm", "ignore");
        run(d, "config", "submodule.sub.ignore", "untracked");
      }),
    );
  });

  it("setIgnoreSubmodules as --ignore-submodules overrides every setting", async () => {
    const d = at("cli", (dir) => {
      allDirty(dir);
      run(dir, "config", "submodule.sub.ignore", "all");
    });
    for (const mode of ["none", "untracked", "dirty", "all"] as const) {
      await expectStatusAs(d, (s) => s.setIgnoreSubmodules(mode), [`--ignore-submodules=${mode}`]);
    }
  });

  it("untracked files inside are not looked for with --untracked-files=no", async () => {
    const d = at("uno", (dir) => put(join(dir, "sub"), "u.txt", "u\n"));
    await expectStatusAs(d, (s) => s.setUntracked(false), ["--untracked-files=no"]);
    put(join(d, "sub"), "a.txt", "changed\n");
    await expectStatusAs(d, (s) => s.setUntracked(false), ["--untracked-files=no"]);
  });

  it("a staged submodule commit: hidden only by --ignore-submodules=all, never by config", async () => {
    const staged = (d: string) => {
      put(join(d, "sub"), "c.txt", "new commit\n");
      run(join(d, "sub"), "commit", "-qam", "moved");
      run(d, "add", "sub");
    };
    await expectStatusAs(
      at("staged-diff-all", (d) => {
        staged(d);
        run(d, "config", "diff.ignoreSubmodules", "all");
      }),
    );
    await expectStatusAs(
      at("staged-config-all", (d) => {
        staged(d);
        run(d, "config", "submodule.sub.ignore", "all");
      }),
    );
    const d = at("staged-cli", staged);
    await expectStatusAs(d, (s) => s.setIgnoreSubmodules("all"), ["--ignore-submodules=all"]);
    await expectStatusAs(d, (s) => s.setIgnoreSubmodules("dirty"), ["--ignore-submodules=dirty"]);
  });

  it("a nested submodule: its untracked files (S..U) and its changes, as git", async () => {
    const inner = join(root, "inner-up");
    repo(inner);
    const up = join(root, "up");
    repo(up);
    exec(up, "-c", "protocol.file.allow=always", "submodule", "add", "-q", inner, "inner");
    run(up, "commit", "-qm", "inner");
    const nested = (name: string, dirty: (sub: string) => void) => {
      const d = join(root, name);
      superproject(d, up);
      exec(
        d,
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "update",
        "-q",
        "--init",
        "--recursive",
      );
      dirty(join(d, "sub"));
      return d;
    };
    await expectStatusAs(nested("nested-untracked", (s) => put(join(s, "inner"), "u.txt", "u\n")));
    await expectStatusAs(
      nested("nested-modified", (s) => put(join(s, "inner"), "a.txt", "changed\n")),
    );
    await expectStatusAs(
      nested("nested-ignored", (s) => {
        put(join(s, "inner"), "a.txt", "changed\n");
        run(s, "config", "submodule.inner.ignore", "all");
      }),
    );
  });

  it("an absolute gitdir inside the repository is read as git reads it", async () => {
    const d = at("absolute", (dir) => {
      writeFileSync(join(dir, "sub/.git"), `gitdir: ${join(dir, ".git/modules/sub")}\n`);
      allDirty(dir);
    });
    const status = await expectStatusAs(d);
    expect(status.files[0]).toMatchObject({
      submoduleCommitChanged: true,
      submoduleModified: true,
      submoduleUntracked: true,
    });
  });

  it("an absolute gitdir outside the FilesApi's root stays unreadable (shown clean)", async () => {
    const d = at("outside", (dir) => {
      renameSync(join(dir, ".git/modules/sub"), join(root, "outside-sub-git"));
      writeFileSync(join(dir, "sub/.git"), `gitdir: ${join(root, "outside-sub-git")}\n`);
      run(
        root,
        "config",
        "-f",
        join(root, "outside-sub-git/config"),
        "core.worktree",
        join(dir, "sub"),
      );
      allDirty(dir);
    });
    // native git follows it (` M sub`); ours never reads beyond the root
    expect(nativeStatus(d, 1)).toBe(" M sub\n");
    const { ours } = await open(d);
    expect(formatStatusPorcelain(await ours.status().call(), 1)).toBe("");
  });

  it("regression: a submodule with untracked files is ` M sub` (origin/main showed it clean)", async () => {
    const d = at("regression", (dir) => put(join(dir, "sub"), "u.txt", "u\n"));
    const { ours } = await open(d);
    expect(formatStatusPorcelain(await ours.status().call(), 2)).toMatch(/^1 \.M S\.\.U /);
  });
});

describeGit("clean -X against native git", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "clean-x-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** native `git clean` with `args` in one build, ours in its twin; would-remove lists and trees. */
  async function twin(
    name: string,
    setup: (d: string) => void,
    flags: { d?: boolean; ff?: boolean; paths?: string[] },
  ) {
    const n = join(root, `${name}-n`);
    const o = join(root, `${name}-o`);
    for (const dir of [n, o]) {
      repo(dir);
      setup(dir);
    }
    const args = ["clean", flags.ff ? "-ff" : "-f", "-X"];
    if (flags.d) args.push("-d");
    const paths = flags.paths ? ["--", ...flags.paths] : [];
    const out = exec(n, ...args, "-n", ...paths)
      .split("\n")
      .filter(Boolean);
    const pick = (prefix: string) =>
      out
        .filter((l) => l.startsWith(prefix))
        .map((l) => l.slice(prefix.length))
        .sort();
    const command = async (dryRun: boolean) => {
      const { ours } = await open(o);
      return ours
        .clean()
        .setIgnoredOnly(true)
        .setCleanDirectories(flags.d === true)
        .setForceNestedRepositories(flags.ff === true)
        .setPaths(new Set(flags.paths ?? []))
        .setDryRun(dryRun)
        .call();
    };
    const dry = await command(true);
    expect([...dry.cleaned].sort(), `${name}: would remove`).toEqual(pick("Would remove "));
    expect([...dry.skipped].sort(), `${name}: would skip`).toEqual(pick("Would skip repository "));
    exec(n, ...args, "-q", ...paths);
    await command(false);
    expect(listing(o), `${name}: worktree`).toEqual(listing(n));
  }

  const layout = (d: string) => {
    put(d, ".gitignore", "*.log\nbuild/\n!keep.log\nign/\n");
    run(d, "add", ".gitignore");
    run(d, "commit", "-qm", "ignore");
    put(d, "x.log", "x\n");
    put(d, "keep.log", "k\n");
    put(d, "u.txt", "u\n");
    put(d, "d/y.log", "l\n");
    put(d, "d/u.txt", "u\n");
    put(d, "u/z.log", "l\n");
    put(d, "u/v.txt", "u\n");
    put(d, "u/deep/w.log", "l\n");
    put(d, "onlyign/a.log", "l\n");
    put(d, "onlyign/deep/b.log", "l\n");
    put(d, "build/out.o", "o\n");
    put(d, "build/sub/deep.o", "o\n");
    put(d, "ign/i.txt", "i\n");
    mkdirSync(join(d, "emptyu"));
  };
  const repos = (d: string) => {
    layout(d);
    mkdirSync(join(d, "u2/nest"), { recursive: true });
    run(join(d, "u2/nest"), "init", "-q");
    put(d, "u2/nest/n.log", "n\n");
    put(d, "u2/l.log", "l\n");
    put(d, "u2/sub/s.log", "s\n");
    put(d, "u2/sub/deeper/x.log", "x\n");
    mkdirSync(join(d, "build/repo"), { recursive: true });
    run(join(d, "build/repo"), "init", "-q");
    put(d, "d/igd/q.log", "q\n");
    mkdirSync(join(d, "d/igd/e"), { recursive: true });
    put(d, "mix/l.log", "l\n");
    mkdirSync(join(d, "mix/e"), { recursive: true });
    mkdirSync(join(d, "nested"));
    run(join(d, "nested"), "init", "-q");
    put(d, "nested/n.log", "n\n");
    put(d, "nested.log", "n\n");
  };
  const cases: Array<
    [string, (d: string) => void, { d?: boolean; ff?: boolean; paths?: string[] }]
  > = [
    ["X", layout, {}],
    ["X-d", layout, { d: true }],
    ["X-path-untracked-dir", layout, { paths: ["u"] }],
    ["X-path-ignored-content-dir", layout, { paths: ["onlyign"] }],
    ["X-d-path-ignored-content-dir", layout, { d: true, paths: ["onlyign"] }],
    ["X-path-ignored-dir", layout, { paths: ["build"] }],
    ["X-d-path-untracked-dir", layout, { d: true, paths: ["u"] }],
    ["X-glob", layout, { paths: ["*.log"] }],
    ["X-d-tracked-dir", layout, { d: true, paths: ["d"] }],
    ["X-d-repos", repos, { d: true }],
    ["X-repos", repos, {}],
    ["X-ff-d-repos", repos, { d: true, ff: true }],
    ["X-file-path", repos, { paths: ["d/igd/q.log"] }],
    ["X-path-in-untracked", repos, { paths: ["u2/sub"] }],
    ["X-glob-in-untracked", repos, { paths: ["u2/s*"] }],
    ["X-glob-tracked", repos, { paths: ["d/*"] }],
    ["X-d-deep-path", repos, { d: true, paths: ["u2/sub/deeper/x.log"] }],
  ];
  for (const [name, setup, flags] of cases) {
    it(`clean ${name}`, async () => {
      await twin(name, setup, flags);
    });
  }

  it("regression: -X keeps untracked files that are not ignored", async () => {
    const d = join(root, "r");
    repo(d);
    layout(d);
    const { ours } = await open(d);
    const result = await ours.clean().setIgnoredOnly(true).setDryRun(false).call();
    expect(result.cleaned).toEqual(new Set(["d/y.log", "u/z.log", "x.log"]));
    expect(existsSync(join(d, "u.txt"))).toBe(true);
    expect(existsSync(join(d, "x.log"))).toBe(false);
  });
});

describeGit("clean -d and absolute gitfile targets (native git)", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "clean-absolute-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  async function bothClean(setup: (dir: string) => void) {
    const nativeDir = join(root, "native");
    const oursDir = join(root, "ours");
    setup(nativeDir);
    setup(oursDir);
    exec(nativeDir, "clean", "-d", "-f", "-q");
    const { ours } = await open(oursDir);
    await ours.clean().setCleanDirectories(true).setDryRun(false).call();
    return { native: listing(nativeDir), ours: listing(oursDir) };
  }

  it("an absolute gitfile target inside the root without HEAD is no repository: removed", async () => {
    const { native, ours } = await bothClean((dir) => {
      repo(dir);
      mkdirSync(join(dir, "u/w"), { recursive: true });
      mkdirSync(join(dir, "u/notrepo"), { recursive: true });
      writeFileSync(join(dir, "u/w/.git"), `gitdir: ${join(dir, "u/notrepo")}\n`);
      put(dir, "u/w/f.txt", "f\n");
    });
    expect(native).not.toContain("u/w/f.txt");
    expect(ours).toEqual(native);
  });

  it("an absolute gitfile target inside the root with HEAD is a repository: kept", async () => {
    const { native, ours } = await bothClean((dir) => {
      repo(dir);
      mkdirSync(join(dir, "u/w"), { recursive: true });
      run(dir, "init", "-q", "--bare", join(dir, "u/store.git"));
      writeFileSync(join(dir, "u/w/.git"), `gitdir: ${join(dir, "u/store.git")}\n`);
      put(dir, "u/w/f.txt", "f\n");
    });
    expect(native).toContain("u/w/f.txt");
    expect(ours).toEqual(native);
  });

  it("an absolute gitfile target outside the root is kept whatever it holds (safe)", async () => {
    const dir = join(root, "r");
    repo(dir);
    mkdirSync(join(dir, "u/w"), { recursive: true });
    mkdirSync(join(root, "elsewhere"));
    writeFileSync(join(dir, "u/w/.git"), `gitdir: ${join(root, "elsewhere")}\n`);
    put(dir, "u/w/f.txt", "f\n");
    const { ours } = await open(dir);
    await ours.clean().setCleanDirectories(true).setDryRun(false).call();
    expect(existsSync(join(dir, "u/w/f.txt"))).toBe(true);
  });

  it("copies keep their own absolute targets apart (cpSync of a twin is not used)", () => {
    // documents why the twins above are built twice: a copied gitfile would name the
    // original's directory, outside the copy's root
    const a = join(root, "a");
    mkdirSync(a);
    writeFileSync(join(a, "g"), `gitdir: ${join(a, "x")}\n`);
    cpSync(a, join(root, "b"), { recursive: true });
    expect(readFileSync(join(root, "b/g"), "utf8")).toContain(a);
  });
});

describeGit("clean keeps repositories it cannot check; ignored directories as git (review)", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "clean-review-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  type Flags = { d?: boolean; x?: boolean; X?: boolean };
  /** native `git clean -f` with `flags` in one build, ours in the other build of `setup`. */
  async function twin(name: string, setup: (d: string) => void, flags: Flags) {
    const n = join(root, `${name}-n`);
    const o = join(root, `${name}-o`);
    for (const dir of [n, o]) {
      repo(dir);
      setup(dir);
    }
    const args = ["clean", "-f"];
    if (flags.d) args.push("-d");
    if (flags.x) args.push("-x");
    if (flags.X) args.push("-X");
    const out = exec(n, ...args, "-n")
      .split("\n")
      .filter(Boolean);
    const pick = (prefix: string) =>
      out
        .filter((l) => l.startsWith(prefix))
        .map((l) => l.slice(prefix.length))
        .sort();
    const command = async (dryRun: boolean) => {
      const { ours } = await open(o);
      return ours
        .clean()
        .setCleanDirectories(flags.d === true)
        .setIgnore(flags.x !== true)
        .setIgnoredOnly(flags.X === true)
        .setDryRun(dryRun)
        .call();
    };
    const dry = await command(true);
    expect([...dry.cleaned].sort(), `${name}: would remove`).toEqual(pick("Would remove "));
    expect([...dry.skipped].sort(), `${name}: would skip`).toEqual(pick("Would skip repository "));
    exec(n, ...args, "-q");
    await command(false);
    expect(listing(o), `${name}: worktree`).toEqual(listing(n));
    return { native: listing(n), ours: listing(o) };
  }

  /** u/w is a worktree whose gitdir is reached through a link (in `.git`, never cleaned). */
  const linkedGitdir = (throughTarget: boolean, ignoreU: boolean) => (d: string) => {
    if (ignoreU) {
      put(d, ".gitignore", "u/\n");
      run(d, "add", ".gitignore");
      run(d, "commit", "-qm", "ignore");
    }
    mkdirSync(join(d, ".git/store"));
    run(d, "init", "-q", "--bare", join(d, ".git/store/real.git"));
    symlinkSync("store", join(d, ".git/lnk"));
    symlinkSync("store/real.git", join(d, ".git/lnk2"));
    const target = throughTarget ? join(d, ".git/lnk2") : join(d, ".git/lnk/real.git");
    mkdirSync(join(d, "u/w"), { recursive: true });
    writeFileSync(join(d, "u/w/.git"), `gitdir: ${target}\n`);
    put(d, "u/w/precious.txt", "precious\n");
    put(d, "u/loose.txt", "loose\n");
  };
  for (const [name, through, ignore, flags] of [
    ["link-in-path -d", false, false, { d: true }],
    ["link-in-path -dx", false, true, { d: true, x: true }],
    ["link-in-path -Xd", false, true, { d: true, X: true }],
    ["link-target -d", true, false, { d: true }],
    ["link-target -dx", true, true, { d: true, x: true }],
    ["link-target -Xd", true, true, { d: true, X: true }],
  ] as Array<[string, boolean, boolean, Flags]>) {
    it(`a gitdir reached through a link is a repository, kept: ${name}`, async () => {
      const { ours } = await twin(name.replace(/\W+/g, "-"), linkedGitdir(through, ignore), flags);
      expect(ours).toContain("u/w/precious.txt");
    });
  }

  /** Ignored directories empty or holding only empty directories or a `.git` that is none. */
  const emptyIgnored = (d: string) => {
    put(d, ".gitignore", "build/\nb2/\nb3/\nb4/\n*.log\nign/\n");
    run(d, "add", ".gitignore");
    run(d, "commit", "-qm", "ignore");
    mkdirSync(join(d, "build"));
    mkdirSync(join(d, "b2/e/f"), { recursive: true });
    mkdirSync(join(d, "b3/fake/.git"), { recursive: true });
    put(d, "b3/fake/x.o", "x\n");
    mkdirSync(join(d, "b4/fake2/.git"), { recursive: true });
    mkdirSync(join(d, "u/empty"), { recursive: true });
    put(d, "u/a.log", "l\n");
    mkdirSync(join(d, "ign/e1/e2"), { recursive: true });
    put(d, "ign/i.txt", "i\n");
    mkdirSync(join(d, "plainu/e"), { recursive: true });
  };
  for (const [name, flags] of [
    ["-Xd", { d: true, X: true }],
    ["-d", { d: true }],
    ["-dx", { d: true, x: true }],
    ["-X", { X: true }],
  ] as Array<[string, Flags]>) {
    it(`empty and fake-repository ignored directories: clean ${name}`, async () => {
      await twin(`empty${name}`, emptyIgnored, flags);
    });
  }
});

describeGit("status review cases against native git", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "status-review2-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("a deinitialised submodule's directory is never entered for untracked files", async () => {
    const d = join(root, "r");
    superproject(d, join(root, "up"));
    exec(d, "submodule", "deinit", "-q", "-f", "sub");
    put(d, "sub/stray.txt", "s\n");
    put(d, "sub/deep/x.txt", "x\n");
    const status = await expectStatusAs(d);
    expect(status.untracked.size).toBe(0);
  });

  it("a submodule's own status.showUntrackedFiles=no hides its untracked files", async () => {
    const d = join(root, "r");
    superproject(d, join(root, "up"));
    put(join(d, "sub"), "u.txt", "u\n");
    run(join(d, "sub"), "config", "status.showUntrackedFiles", "no");
    const status = await expectStatusAs(d);
    expect(status.modified.size).toBe(0);
  });

  it("diff.renameLimit 0 or negative is git's 32767; a skipped detection warns", async () => {
    const setup = (d: string) => {
      repo(d);
      run(d, "rm", "-q", "a.txt", "b.txt");
      put(d, "a2.txt", `${lines(20, "a")}x\n`);
      put(d, "b2.txt", `${lines(12, "b")}y\n`);
      run(d, "add", ".");
    };
    for (const limit of ["0", "-1"]) {
      const d = join(root, `limit${limit}`);
      setup(d);
      run(d, "config", "diff.renameLimit", limit);
      const status = await expectStatusAs(d);
      expect(status.renamed.size).toBe(2);
      expect(status.warnings).toEqual([]);
    }
    const d = join(root, "limit1");
    setup(d);
    run(d, "config", "diff.renameLimit", "1");
    const status = await expectStatusAs(d);
    expect(status.renamed.size).toBe(0);
    expect(status.warnings).toEqual([
      "warning: exhaustive rename detection was skipped due to too many files.",
      "warning: you may want to set your status.renameLimit variable to at least 2 and retry the command.",
    ]);
  });
});

describeGit("clean removes inside non-repository .git directories as git (review 3)", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "clean-fake-git-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  type Flags = { d?: boolean; x?: boolean; X?: boolean; ff?: boolean };
  const argsOf = (flags: Flags) => {
    const args = ["clean", flags.ff ? "-ff" : "-f"];
    if (flags.d) args.push("-d");
    if (flags.x) args.push("-x");
    if (flags.X) args.push("-X");
    return args;
  };
  /** native `git clean` in one build of `setup`, ours in the other; output and trees equal. */
  async function twin(name: string, setup: (d: string) => void, flags: Flags) {
    const n = join(root, `${name}-n`);
    const o = join(root, `${name}-o`);
    for (const dir of [n, o]) {
      repo(dir);
      setup(dir);
    }
    const args = argsOf(flags);
    const out = exec(n, ...args, "-n")
      .split("\n")
      .filter(Boolean);
    const pick = (prefix: string) =>
      out
        .filter((l) => l.startsWith(prefix))
        .map((l) => l.slice(prefix.length))
        .sort();
    const command = async (dryRun: boolean) => {
      const { ours } = await open(o);
      return ours
        .clean()
        .setCleanDirectories(flags.d === true)
        .setIgnore(flags.x !== true)
        .setIgnoredOnly(flags.X === true)
        .setForceNestedRepositories(flags.ff === true)
        .setDryRun(dryRun)
        .call();
    };
    const dry = await command(true);
    expect([...dry.cleaned].sort(), `${name}: would remove`).toEqual(pick("Would remove "));
    expect([...dry.skipped].sort(), `${name}: would skip`).toEqual(pick("Would skip repository "));
    exec(n, ...args, "-q");
    await command(false);
    expect(fullListing(o), `${name}: worktree`).toEqual(fullListing(n));
    return { native: fullListing(n), ours: fullListing(o) };
  }
  /** Every path below `dir` but its own `.git`, `.git` directories elsewhere included. */
  const fullListing = (dir: string, prefix = ""): string[] => {
    const out: string[] = [];
    for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (path === ".git") continue;
      out.push(path);
      if (entry.isDirectory()) out.push(...fullListing(dir, path));
    }
    return out.sort();
  };
  const innerRepo = (d: string, path: string) => {
    mkdirSync(join(d, path), { recursive: true });
    run(join(d, path), "init", "-q");
    put(d, `${path}/p.txt`, "precious\n");
  };
  const layouts: Record<string, (d: string) => void> = {
    // review repro 1: an ignored directory whose fake .git holds a repository
    "ignored-fake-git": (d) => {
      put(d, ".gitignore", "ign/\n");
      run(d, "add", ".gitignore");
      run(d, "commit", "-qm", "ignore");
      innerRepo(d, "ign/d/.git/inner");
      put(d, "ign/d/x.txt", "x\n");
      put(d, "ign/d/.git/junk", "j\n");
    },
    // review repro 2: an untracked directory with a fake .git next to a repository
    "untracked-fake-git": (d) => {
      mkdirSync(join(d, "w/nf/.git"), { recursive: true });
      innerRepo(d, "w/nf/in");
      put(d, "w/nf/q.txt", "q\n");
      put(d, "w/u/u.txt", "u\n");
    },
    // repositories inside fake .git directories, at several depths
    "deep-fake-git": (d) => {
      innerRepo(d, "v/f/.git/deep/r");
      put(d, "v/f/.git/j.txt", "j\n");
      innerRepo(d, "a/b/c/.git/r2");
      put(d, "a/b/c/k.txt", "k\n");
      mkdirSync(join(d, "d/fk/.git/empty"), { recursive: true });
      put(d, "d/fk/k.txt", "k\n");
    },
    // links named .git: a dangling one (no repository) and one to a repository
    "git-links": (d) => {
      mkdirSync(join(d, "dl"));
      symlinkSync("missing", join(d, "dl/.git"));
      put(d, "dl/d.txt", "d\n");
      run(d, "init", "-q", "--bare", join(d, ".git/store.git"));
      mkdirSync(join(d, "u/sl"), { recursive: true });
      symlinkSync(join(d, ".git/store.git"), join(d, "u/sl/.git"));
      put(d, "u/sl/s.txt", "s\n");
      put(d, "u/loose.txt", "l\n");
    },
  };
  const flagSets: Array<[string, Flags]> = [
    ["-d", { d: true }],
    ["-dx", { d: true, x: true }],
    ["-Xd", { d: true, X: true }],
    ["-dff", { d: true, ff: true }],
    ["-Xdff", { d: true, X: true, ff: true }],
    ["-dffx", { d: true, ff: true, x: true }],
  ];
  for (const [layout, setup] of Object.entries(layouts)) {
    for (const [flagName, flags] of flagSets) {
      it(`${layout}: clean ${flagName}`, async () => {
        await twin(`${layout}${flagName}`, setup, flags);
      });
    }
  }

  it("regression: -Xd keeps the repository inside an ignored directory's fake .git", async () => {
    const d = join(root, "r1");
    repo(d);
    layouts["ignored-fake-git"](d);
    const { ours } = await open(d);
    await ours.clean().setIgnoredOnly(true).setCleanDirectories(true).setDryRun(false).call();
    expect(existsSync(join(d, "ign/d/.git/inner/p.txt"))).toBe(true);
    expect(existsSync(join(d, "ign/d/x.txt"))).toBe(false);
  });

  it("regression: -d keeps the repository next to a fake .git", async () => {
    const d = join(root, "r2");
    repo(d);
    layouts["untracked-fake-git"](d);
    const { ours } = await open(d);
    await ours.clean().setCleanDirectories(true).setDryRun(false).call();
    expect(existsSync(join(d, "w/nf/in/p.txt"))).toBe(true);
    expect(existsSync(join(d, "w/nf/.git"))).toBe(false);
  });

  it("an unreadable directory is never removed (its listing fails: content unknown)", async () => {
    const d = join(root, "r3");
    repo(d);
    put(d, "u/locked/secret.txt", "s\n");
    put(d, "u/free.txt", "f\n");
    put(d, "ign/locked/secret.txt", "s\n");
    put(d, ".gitignore", "ign/\n");
    run(d, "add", ".gitignore");
    run(d, "commit", "-qm", "ignore");
    const base = createNodeFilesApi({ rootDir: d });
    // a FilesApi whose listing of the locked directories fails, as an unreadable one does
    const files = new Proxy(base, {
      get(target, key, receiver) {
        if (key === "withLstatCache") return undefined;
        if (key === "list") {
          return (path: string) => {
            if (path.endsWith("/locked")) throw new Error("EACCES: permission denied");
            return target.list(path);
          };
        }
        // the listing with kinds a walk prefers fails alike
        if (key === "listKinds") {
          return async (path: string) => {
            if (path.endsWith("/locked")) throw new Error("EACCES: permission denied");
            return target.listKinds?.(path);
          };
        }
        const value = Reflect.get(target, key, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const { history } = await createGitFilesBackend({ files });
    const staging = new FileStagingStore(files, ".git/index");
    await staging.read();
    const worktree = createFileWorktree({
      files,
      rootPath: "",
      gitDir: ".git",
      blobs: history.blobs,
      trees: history.trees,
    });
    const { MemoryCheckout } = await import("@statewalker/vcs-working-tree");
    const wc = new MemoryWorkingCopy({
      history,
      checkout: new MemoryCheckout({ staging }),
      worktree,
    });
    for (const configure of [
      (c: ReturnType<Git["clean"]>) => c.setCleanDirectories(true),
      (c: ReturnType<Git["clean"]>) => c.setCleanDirectories(true).setIgnore(false),
      (c: ReturnType<Git["clean"]>) => c.setCleanDirectories(true).setIgnoredOnly(true),
    ]) {
      const result = await configure(Git.fromWorkingCopy(wc).clean()).setDryRun(false).call();
      expect([...result.cleaned].some((p) => p.includes("locked"))).toBe(false);
      expect(existsSync(join(d, "u/locked/secret.txt"))).toBe(true);
      expect(existsSync(join(d, "ign/locked/secret.txt"))).toBe(true);
    }
    expect(existsSync(join(d, "u/free.txt"))).toBe(false);
  });

  it("randomized layouts: every flag set as native git", async () => {
    let state = 12345;
    const rnd = () => {
      state = (Math.imul(state, 1103515245) + 12345) >>> 0;
      return state / 2 ** 32;
    };
    const pickOne = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
    for (let k = 0; k < 6; k++) {
      // a fixed plan per layout, applied to both builds
      const plan: Array<(d: string) => void> = [
        (d) => {
          put(d, ".gitignore", "*.log\nign*/\n");
          run(d, "add", ".gitignore");
          run(d, "commit", "-qm", "ignore");
        },
      ];
      for (let i = 0; i < 8; i++) {
        const dir = [pickOne(["u", "ign", "d", "w"]), pickOne(["", "a", "ign2", "b/c"])]
          .filter(Boolean)
          .join("/");
        const kind = pickOne(["file", "log", "fake", "fakejunk", "repo", "fakerepo", "empty"]);
        const name = `n${k}${i}`;
        plan.push((d) => {
          if (kind === "file") put(d, `${dir}/${name}.txt`, "f\n");
          else if (kind === "log") put(d, `${dir}/${name}.log`, "l\n");
          else if (kind === "fake") mkdirSync(join(d, dir, name, ".git"), { recursive: true });
          else if (kind === "fakejunk") put(d, `${dir}/${name}/.git/junk`, "j\n");
          else if (kind === "repo") innerRepo(d, `${dir}/${name}`);
          else if (kind === "fakerepo") innerRepo(d, `${dir}/${name}/.git/in`);
          else mkdirSync(join(d, dir, name), { recursive: true });
        });
      }
      const setup = (d: string) => {
        for (const step of plan) step(d);
      };
      for (const [flagName, flags] of [
        ["-d", { d: true }],
        ["-dx", { d: true, x: true }],
        ["-Xd", { d: true, X: true }],
        ["-X", { X: true }],
        ["-dff", { d: true, ff: true }],
      ] as Array<[string, Flags]>) {
        await twin(`random${k}${flagName}`, setup, flags);
      }
    }
  }, 300_000);
});

describeGit(
  "status of an intent-to-add entry over a path of HEAD (git rm --cached; add -N)",
  () => {
    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), "status-ita-head-"));
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));
    const at = (name: string, setup: (d: string) => void) => {
      const d = join(root, name);
      repo(d);
      setup(d);
      return d;
    };

    it("DA with the file there, DD once it is gone (v1, v2 and the short format)", async () => {
      const dir = at("da", (d) => {
        put(d, "x y", "x\n");
        run(d, "add", "x y");
        run(d, "commit", "-qm", "x y");
        run(d, "rm", "-q", "--cached", "x y", "c.txt", "d/f.txt");
        run(d, "add", "-N", "x y", "c.txt", "d/f.txt");
        put(d, "c.txt", "c changed\n");
        rmSync(join(d, "d/f.txt"));
      });
      const status = await expectStatusAs(dir);
      expect(status.files.find((f) => f.path === "x y")).toMatchObject({
        index: "D",
        worktree: "A",
      });
      expect(status.files.find((f) => f.path === "d/f.txt")).toMatchObject({
        index: "D",
        worktree: "D",
      });
      expect(status.removed.has("x y")).toBe(true);
      expect(formatStatusPorcelain(status, 1)).toBe(exec(dir, "status", "--short"));
      // diff --cached --name-status (HEAD against the index): the entries are deletions
      const { ours } = await open(dir);
      expect(await ours.diff().setCached(true).callText("name-status")).toBe(
        exec(dir, "diff", "--cached", "--name-status"),
      );
    });

    it("a rename from the path: the intent-to-add line keeps only its worktree side", async () => {
      await expectStatusAs(
        at("renamed", (d) => {
          run(d, "rm", "-q", "--cached", "a.txt");
          run(d, "add", "-N", "a.txt");
          put(d, "a2.txt", lines(20, "a"));
          run(d, "add", "a2.txt");
          // the same with the intent-to-add file gone
          run(d, "rm", "-q", "--cached", "b.txt");
          run(d, "add", "-N", "b.txt");
          put(d, "b2.txt", lines(12, "b"));
          run(d, "add", "b2.txt");
          rmSync(join(d, "b.txt"));
        }),
      );
    });
  },
);
