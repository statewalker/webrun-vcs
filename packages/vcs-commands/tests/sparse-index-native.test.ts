/**
 * The sparse index (`index.sparse`, `sdir`) against native git: an index git made sparse is
 * read by ours (expanded, every command sees ordinary entries) and written back sparse; ours
 * writes the sparse index git writes (sparse directory entries, their flags, the cache-tree,
 * the `sdir` extension), which git reads; `sparse-checkout --sparse-index` and
 * `--no-sparse-index` as git, and the index-writing commands on a sparse index.
 *
 * Twins are two copies of one repository, each index refreshed against its own copy, so
 * indexes are compared with their stat data set aside.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStagingStore } from "@statewalker/vcs-store-files";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { parseIndexFile } from "@statewalker/vcs-working-tree";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type Git, ResetMode } from "../src/index.js";
import { openOurs, put } from "./merge-native-helpers.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;
const version = (() => {
  try {
    const out = execFileSync("git", ["--version"], { encoding: "utf8" });
    return /git version 2\.(5\d|[6-9]\d)/.test(out) ? "2.56" : "2.43";
  } catch {
    return "2.56";
  }
})();

let root: string;
const env = () => nativeGitEnv(root);
const git = (cwd: string, args: string[], input?: string) =>
  execFileSync("git", args, {
    cwd,
    env: { ...env(), GIT_EDITOR: "true" },
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    ...(input !== undefined ? { input } : {}),
  }).trimEnd();
const run = (cwd: string, args: string[]) => {
  const r = spawnSync("git", args, {
    cwd,
    env: { ...env(), GIT_EDITOR: "true" },
    encoding: "utf8",
  });
  return { exit: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sparse-index-native-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Every file of the worktree dated well in the past (never racily clean), the index refreshed. */
function settle(dir: string): void {
  for (const name of readdirSync(dir, { recursive: true }) as string[]) {
    if (name === ".git" || name.startsWith(".git/")) continue;
    utimesSync(join(dir, name), 1_600_000_000, 1_600_000_000);
  }
  spawnSync("git", ["update-index", "-q", "--refresh"], { cwd: dir, env: env() });
}

/** A repository with a cone (k/), directories outside it (s/, s/t/, u/) and a top file. */
function repo(): string {
  const dir = mkdtempSync(join(root, "repo-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "core.trustctime", "false"]);
  put(dir, "k/a", "a\n");
  put(dir, "k/sub/b", "b\n");
  put(dir, "s/c", "c\n");
  put(dir, "s/t/d", "d\n");
  put(dir, "u/e", "e\n");
  put(dir, "u/v/w/x", "x\n");
  put(dir, "top", "top\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "base"]);
  git(dir, ["branch", "side"]);
  git(dir, ["checkout", "-q", "side"]);
  put(dir, "k/a", "side a\n");
  put(dir, "s/c", "side c\n");
  git(dir, ["commit", "-q", "-a", "-m", "side"]);
  git(dir, ["checkout", "-q", "main"]);
  settle(dir);
  return dir;
}

/** Two copies of `dir`, each index refreshed against its own copy. */
function copies(dir: string): { native: string; ours: string } {
  const native = `${dir}-native`;
  const mine = `${dir}-ours`;
  for (const d of [native, mine]) {
    execFileSync("cp", ["-a", dir, d]);
    spawnSync("git", ["update-index", "-q", "--refresh"], { cwd: d, env: env() });
  }
  return { native, ours: mine };
}

/** The index as git stores it, stat data set aside: version, entries with flags, extensions. */
async function structure(dir: string) {
  const parsed = await parseIndexFile(new Uint8Array(readFileSync(join(dir, ".git/index"))));
  return {
    version: parsed.version,
    entries: parsed.entries.map(
      (e) =>
        `${e.mode.toString(8)} ${e.objectId} ${e.stage}${e.skipWorktree ? "S" : ""}${e.intentToAdd ? "I" : ""}\t${e.path}`,
    ),
    extensions: parsed.extensions,
    tree: Buffer.from(
      parsed.extensionData.find((x) => x.signature === "TREE")?.data ?? new Uint8Array(),
    ).toString("hex"),
  };
}

/** What git shows of the index and worktree: status, the entries with flags, the files. */
function view(dir: string) {
  return {
    status: git(dir, ["status", "--porcelain=v2", "-uall"]),
    flags: git(dir, ["ls-files", "-t", "--stage"]),
    sparseDirs: git(dir, ["ls-files", "--sparse", "-s"]),
    files: (readdirSync(dir, { recursive: true }) as string[])
      .filter((n) => n !== ".git" && !n.startsWith(".git/"))
      .sort(),
    config: existsSync(join(dir, ".git/config.worktree"))
      ? readFileSync(join(dir, ".git/config.worktree"), "utf8")
      : "<none>",
  };
}

async function ours(dir: string): Promise<Git> {
  return openOurs(dir, createNodeGitHostEnvironment({ env: env() }));
}

async function sparseCheckout(dir: string, args: string[]) {
  const result = await (await ours(dir))
    .sparseCheckout()
    .setArguments(args)
    .setCompatibility(version)
    .call();
  return { exit: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}

describeGit("sparse index against native git", () => {
  it("sparse-checkout set --sparse-index writes the sparse index git writes", async () => {
    const { native, ours: mine } = copies(repo());
    const theirs = run(native, ["sparse-checkout", "set", "--sparse-index", "k"]);
    expect(await sparseCheckout(mine, ["set", "--sparse-index", "k"])).toEqual(theirs);
    const s = await structure(mine);
    expect(s).toEqual(await structure(native));
    expect(s.extensions).toEqual(["TREE", "sdir"]);
    expect(s.entries.filter((e) => e.startsWith("40000"))).toEqual([
      expect.stringMatching(/^40000 [0-9a-f]{40} 0S\ts\/$/),
      expect.stringMatching(/^40000 [0-9a-f]{40} 0S\tu\/$/),
    ]);
    expect(view(mine)).toEqual(view(native));
  });

  it("init --cone --sparse-index, then reapply --no-sparse-index expands it, as git", async () => {
    const { native, ours: mine } = copies(repo());
    const args = ["init", "--cone", "--sparse-index"];
    expect(await sparseCheckout(mine, args)).toEqual(run(native, ["sparse-checkout", ...args]));
    expect(await structure(mine)).toEqual(await structure(native));
    expect(view(mine)).toEqual(view(native));
    const back = ["reapply", "--no-sparse-index"];
    expect(await sparseCheckout(mine, back)).toEqual(run(native, ["sparse-checkout", ...back]));
    expect(await structure(mine)).toEqual(await structure(native));
    expect((await structure(mine)).extensions).not.toContain("sdir");
    expect(view(mine)).toEqual(view(native));
  });

  it("reads an index git made sparse: status, ls-files and the sparse directories' entries", async () => {
    const dir = repo();
    git(dir, ["sparse-checkout", "set", "--sparse-index", "k"]);
    expect((await structure(dir)).extensions).toContain("sdir");
    const g = await ours(dir);
    const status = await g.status().call();
    expect(status.isClean()).toBe(true);
    // a staging of its own (no command's host): expanded from the repository's trees
    const staging = new FileStagingStore(createNodeFilesApi({ rootDir: dir }), ".git/index");
    await staging.read();
    const listed: string[] = [];
    for await (const e of staging.entries()) listed.push(`${e.skipWorktree ? "S" : "H"} ${e.path}`);
    expect(listed).toEqual(
      git(dir, ["ls-files", "-t"])
        .split("\n")
        .map((l) => l.replace(/\t/, " ")),
    );
    expect(staging.indexLayout?.()).toEqual({ split: false, sparse: true });
    // a write keeps it sparse
    put(dir, "k/new", "n\n");
    await (await ours(dir)).add().addFilepattern("k/new").call();
    expect((await structure(dir)).extensions).toEqual(["TREE", "sdir"]);
    expect(git(dir, ["status", "--porcelain"])).toBe("A  k/new");
    expect(git(dir, ["ls-files", "--sparse"])).toBe("k/a\nk/new\nk/sub/b\ns/\ntop\nu/");
  });

  it("add, commit, switch, reset, merge and stash on a sparse index, as git", async () => {
    const dir = repo();
    git(dir, ["sparse-checkout", "set", "--sparse-index", "k"]);
    settle(dir);
    const steps: { name: string; native: string[][]; ours: (g: Git) => Promise<unknown> }[] = [
      {
        name: "add",
        native: [["add", "k/a"]],
        ours: (g) => g.add().addFilepattern("k/a").call(),
      },
      {
        name: "commit",
        native: [["commit", "-q", "-m", "c"]],
        ours: (g) => g.commit().setMessage("c\n").call(),
      },
      {
        name: "switch",
        native: [["switch", "-q", "side"]],
        ours: (g) => g.switch().setName("side").call(),
      },
      {
        name: "reset",
        native: [["reset", "-q", "--hard", "main"]],
        ours: (g) => g.reset().setRef("main").setMode(ResetMode.HARD).call(),
      },
      {
        name: "merge",
        native: [["merge", "-q", "--no-edit", "side"]],
        ours: (g) => g.merge().include("side").call(),
      },
    ];
    for (const step of steps) {
      if (step.name === "add") {
        put(dir, "k/a", "changed\n");
        settle(dir);
      }
      const { native, ours: mine } = copies(dir);
      for (const args of step.native) git(native, args);
      await step.ours(await ours(mine));
      expect(await structure(mine), step.name).toEqual(await structure(native));
      expect(view(mine), step.name).toEqual(view(native));
      // the next step starts from native git's result
      rmSync(dir, { recursive: true, force: true });
      execFileSync("cp", ["-a", native, dir]);
      settle(dir);
      rmSync(native, { recursive: true, force: true });
      rmSync(mine, { recursive: true, force: true });
    }
  });

  it("stash on a sparse index: git reads what ours writes", async () => {
    const dir = repo();
    git(dir, ["sparse-checkout", "set", "--sparse-index", "k"]);
    put(dir, "k/a", "dirty\n");
    settle(dir);
    const g = await ours(dir);
    await g.stashCreate().call();
    expect(git(dir, ["status", "--porcelain"])).toBe("");
    expect((await structure(dir)).extensions).toContain("sdir");
    await (await ours(dir)).stashApply().call();
    expect(git(dir, ["status", "--porcelain"])).toBe(" M k/a");
    expect(git(dir, ["ls-files", "--sparse"])).toBe("k/a\nk/sub/b\ns/\ntop\nu/");
  });

  it("an index made sparse by ours is read by git in both versions' ways", async () => {
    const dir = repo();
    expect((await sparseCheckout(dir, ["set", "--sparse-index", "k"])).exit).toBe(0);
    expect(git(dir, ["ls-files", "--sparse", "-s"])).toContain("040000");
    expect(git(dir, ["status", "--porcelain"])).toBe("");
    expect(git(dir, ["ls-files"])).toBe("k/a\nk/sub/b\ns/c\ns/t/d\ntop\nu/e\nu/v/w/x");
    // git writes it again: the same bytes as ours, stat data apart
    const before = await structure(dir);
    git(dir, ["update-index", "--force-write-index"]);
    expect(await structure(dir)).toEqual(before);
  });

  it("without index.sparse, or without cone mode, the index is written whole", async () => {
    const dir = repo();
    expect((await sparseCheckout(dir, ["set", "--no-cone", "--sparse-index", "/k/"])).exit).toBe(0);
    expect((await structure(dir)).extensions).not.toContain("sdir");
    const { native, ours: mine } = copies(repo());
    const args = ["set", "k"];
    expect(await sparseCheckout(mine, args)).toEqual(run(native, ["sparse-checkout", ...args]));
    expect((await structure(mine)).extensions).not.toContain("sdir");
    expect(await structure(mine)).toEqual(await structure(native));
  });
});

describeGit("sparse-checkout's sparse index settings, against native git", () => {
  it("set --no-cone on a sparse index expands it (2.5x prints its hint)", async () => {
    const dir = repo();
    git(dir, ["sparse-checkout", "set", "--sparse-index", "k"]);
    settle(dir);
    const { native, ours: mine } = copies(dir);
    const args = ["set", "--no-cone", "/k/"];
    expect(await sparseCheckout(mine, args)).toEqual(run(native, ["sparse-checkout", ...args]));
    expect(await structure(mine)).toEqual(await structure(native));
    expect(view(mine)).toEqual(view(native));
  });

  it("advice.sparseIndexExpanded=false silences the hint", async () => {
    const dir = repo();
    git(dir, ["sparse-checkout", "set", "--sparse-index", "k"]);
    git(dir, ["config", "advice.sparseIndexExpanded", "false"]);
    settle(dir);
    const { native, ours: mine } = copies(dir);
    const args = ["reapply", "--no-sparse-index"];
    expect(await sparseCheckout(mine, args)).toEqual(run(native, ["sparse-checkout", ...args]));
    expect(await structure(mine)).toEqual(await structure(native));
  });

  it("without extensions.worktreeConfig, reapply --sparse-index writes the repository's config", async () => {
    const dir = repo();
    // a sparse checkout set up by hand: no worktree config
    git(dir, ["config", "core.sparseCheckout", "true"]);
    git(dir, ["config", "core.sparseCheckoutCone", "true"]);
    put(dir, ".git/info/sparse-checkout", "/*\n!/*/\n/k/\n");
    git(dir, ["read-tree", "-mu", "HEAD"]);
    settle(dir);
    const { native, ours: mine } = copies(dir);
    const args = ["reapply", "--sparse-index"];
    expect(await sparseCheckout(mine, args)).toEqual(run(native, ["sparse-checkout", ...args]));
    expect(readFileSync(join(mine, ".git/config"), "utf8")).toBe(
      readFileSync(join(native, ".git/config"), "utf8"),
    );
    expect(existsSync(join(mine, ".git/config.worktree"))).toBe(
      existsSync(join(native, ".git/config.worktree")),
    );
    expect(await structure(mine)).toEqual(await structure(native));
    expect((await structure(mine)).extensions).toContain("sdir");
  });

  it("checkout -- <path> and restore on a sparse index", async () => {
    const dir = repo();
    git(dir, ["sparse-checkout", "set", "--sparse-index", "k"]);
    put(dir, "k/a", "dirty\n");
    git(dir, ["add", "k/a"]);
    settle(dir);
    const { native, ours: mine } = copies(dir);
    git(native, ["checkout", "HEAD", "--", "k/a"]);
    await (await ours(mine)).checkout().setStartPoint("HEAD").addPath("k/a").call();
    expect(await structure(mine)).toEqual(await structure(native));
    expect(view(mine)).toEqual(view(native));
  });
});

describeGit("sparse index with intent-to-add entries, against native git", () => {
  /** out/ (outside the cone in/) holds files and a subdirectory; HEAD adds out/new.txt. */
  function itaRepo(): string {
    const dir = mkdtempSync(join(root, "ita-"));
    git(dir, ["init", "-q", "-b", "main"]);
    git(dir, ["config", "core.trustctime", "false"]);
    for (const f of ["in/x", "out/a.txt", "out/b.txt", "out/deep/a.txt", "out/deep/b.txt"]) {
      put(dir, f, `${f}\n`);
    }
    git(dir, ["add", "."]);
    git(dir, ["commit", "-q", "-m", "base"]);
    put(dir, "out/new.txt", "new\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-q", "-m", "new"]);
    git(dir, ["sparse-checkout", "set", "--sparse-index", "in"]);
    git(dir, ["config", "advice.sparseIndexExpanded", "false"]);
    settle(dir);
    return dir;
  }

  // 2.43's own `reset -N` writes a sparse index whose out/ is the empty tree
  it.runIf(version === "2.56")(
    "reset -N of a path in a sparse directory writes that directory expanded, as 2.5x",
    async () => {
      const dir = itaRepo();
      expect(git(dir, ["ls-files", "--sparse"])).toBe("in/x\nout/");
      const { native, ours: mine } = copies(dir);
      git(native, ["reset", "-q", "-N", "HEAD~1", "--", "out/new.txt"]);
      await (await ours(mine))
        .reset()
        .setRef("HEAD~1")
        .addPath("out/new.txt")
        .setIntentToAdd(true)
        .call();
      const s = await structure(mine);
      expect(s).toEqual(await structure(native));
      // never a sparse directory of the empty tree
      expect(s.entries.some((e) => e.includes("4b825dc642cb6eb9a060e54bf8d69288fbee4904"))).toBe(
        false,
      );
      expect(s.entries).toContain(
        "100644 e69de29bb2d1d6434b8b29ae775ad8c2e48c5391 0SI\tout/new.txt",
      );
      expect(view(mine)).toEqual(view(native));
      expect(git(mine, ["status", "--porcelain"])).not.toMatch(/^ ?D +out\/a\.txt/m);
    },
  );

  it("an intent-to-add entry under a directory read sparse never collapses it (git reads it)", async () => {
    const dir = itaRepo();
    await (await ours(dir))
      .reset()
      .setRef("HEAD~1")
      .addPath("out/new.txt")
      .setIntentToAdd(true)
      .call();
    const sparse = git(dir, ["ls-files", "--sparse", "-s"]);
    expect(sparse).not.toContain("040000");
    expect(git(dir, ["ls-files"])).toBe(
      "in/x\nout/a.txt\nout/b.txt\nout/deep/a.txt\nout/deep/b.txt\nout/new.txt",
    );
    // the cache-tree native git checks: out/ and the root invalid, out/deep/ valid
    expect(run(dir, ["fsck", "--no-progress", "--no-dangling"]).exit).toBe(0);
  });
});

describeGit("sparse index below an intent-to-add entry, against native git", () => {
  // 2.43's convert_to_sparse_rec collapses invalid directories too (no `span < 0` check)
  it.runIf(version === "2.56")(
    "converting a full index never collapses a directory below one holding an intent-to-add entry",
    async () => {
      const dir = repo();
      git(dir, ["sparse-checkout", "set", "k"]);
      git(dir, ["config", "advice.sparseIndexExpanded", "false"]);
      // s/ita: s/ invalid, so s/t/ stays expanded; u/v/ita: u/ and u/v/ invalid, u/v/w/ too
      put(dir, "s/ita", "i\n");
      put(dir, "u/v/ita", "i\n");
      git(dir, ["add", "--sparse", "-N", "s/ita", "u/v/ita"]);
      settle(dir);
      const { native, ours: mine } = copies(dir);
      const args = ["reapply", "--sparse-index"];
      expect(await sparseCheckout(mine, args)).toEqual(run(native, ["sparse-checkout", ...args]));
      const s = await structure(mine);
      expect(s).toEqual(await structure(native));
      expect(s.entries.filter((e) => e.startsWith("40000"))).toEqual([]);
      expect(view(mine)).toEqual(view(native));
    },
  );

  it.runIf(version === "2.56")(
    "a directory read sparse stays collapsed when an intent-to-add entry lands above it, as git keeps it",
    async () => {
      const dir = repo();
      git(dir, ["sparse-checkout", "set", "--sparse-index", "k"]);
      git(dir, ["config", "advice.sparseIndexExpanded", "false"]);
      // s/c back in the worktree: s/ expanded, s/t/ a sparse directory
      git(dir, ["config", "index.sparse", "false"]);
      git(dir, ["update-index", "--no-skip-worktree", "s/c"]);
      git(dir, ["checkout", "--", "s/c"]);
      git(dir, ["config", "index.sparse", "true"]);
      git(dir, ["update-index", "-q", "--refresh"]);
      expect(git(dir, ["ls-files", "--sparse"])).toBe("k/a\nk/sub/b\ns/c\ns/t/\ntop\nu/");
      put(dir, "s/ita", "i\n");
      git(dir, ["add", "--sparse", "-N", "s/ita"]);
      expect(git(dir, ["ls-files", "--sparse"])).toBe("k/a\nk/sub/b\ns/c\ns/ita\ns/t/\ntop\nu/");
      put(dir, "k/a", "changed\n");
      settle(dir);
      const { native, ours: mine } = copies(dir);
      git(native, ["add", "k/a"]);
      await (await ours(mine)).add().addFilepattern("k/a").call();
      expect(await structure(mine)).toEqual(await structure(native));
      expect(git(mine, ["ls-files", "--sparse"])).toBe("k/a\nk/sub/b\ns/c\ns/ita\ns/t/\ntop\nu/");
      expect(view(mine)).toEqual(view(native));
    },
  );
});
