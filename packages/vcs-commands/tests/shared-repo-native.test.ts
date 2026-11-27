/**
 * `core.sharedRepository` against native git (t1301-shared-repo): `git init --shared`, the
 * value it writes, and the modes git's `adjust_shared_perm` gives what a shared repository's
 * commands create (HEAD, config, refs, reflogs, the index, loose objects, packs,
 * `info/refs`, hooks copied from templates), whatever the umask. Modes are compared as
 * numbers; the umask is set for native git (`sh -c 'umask ..'`) and for ours (the process's,
 * which the FilesApi creates files under).
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitFilesBackend, repack, updateServerInfo } from "@statewalker/vcs-store-files";
import { SharedRepositoryModeError } from "@statewalker/vcs-utils/files";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { InitCommand } from "../src/commands/init-command.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { testEnv } from "./status-native-support.js";
import { CLEANUP_TIMEOUT, removeTempDir } from "./temp-dir-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root: string;
let counter = 0;
const savedUmask = process.umask();

function native(cwd: string, args: string[], umask = 0o022, extra: Record<string, string> = {}) {
  const r = spawnSync("sh", ["-c", `umask ${umask.toString(8)} && exec git "$@"`, "git", ...args], {
    cwd,
    env: testEnv(root, extra),
  });
  return { status: r.status, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

const environment = () => createNodeGitHostEnvironment({ env: testEnv(root) });

/** `body` run under `umask` (the FilesApi creates files as the process's umask says). */
async function underUmask<T>(umask: number, body: () => Promise<T>): Promise<T> {
  process.umask(umask);
  try {
    return await body();
  } finally {
    process.umask(savedUmask);
  }
}

async function oursInit(dir: string, configure: (c: InitCommand) => InitCommand, umask = 0o022) {
  return underUmask(umask, () =>
    configure(
      new InitCommand()
        .setFilesApi(createNodeFilesApi({ rootDir: root }))
        .setEnvironment(environment())
        .setDirectory(dir)
        .setInitialBranch("main"),
    ).call(),
  );
}

/** The permission bits of `path` (a path of the test root). */
const modeOf = (path: string) => lstatSync(join(root, path)).mode & 0o7777;

/** Every path below `dir` with its kind and mode; pack names and `skip` left out. */
function modes(dir: string, skip: string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    const at = join(root, dir, rel);
    const st = lstatSync(at);
    const key = rel.replace(/pack-[0-9a-f]{40}/g, "pack-X");
    if (skip.includes(rel)) return;
    out[key || "."] = `${st.isDirectory() ? "d" : "f"} ${(st.mode & 0o7777).toString(8)}`;
    if (st.isDirectory()) for (const name of readdirSync(at)) walk(rel ? `${rel}/${name}` : name);
  };
  walk("");
  return out;
}

/** Ours: `git update-server-info` in the repository at `gitDir` (a path of the test root). */
async function oursUpdateServerInfo(gitDir: string, umask: number) {
  await underUmask(umask, async () => {
    const backend = await createGitFilesBackend({
      files: createNodeFilesApi({ rootDir: root }),
      gitDir,
      environment: environment(),
    });
    await updateServerInfo({ ...backend, gitDir });
  });
}

describeGit("core.sharedRepository, as native git (t1301-shared-repo)", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "shared-repo-"));
    chmodSync(root, 0o777);
    mkdirSync(join(root, "templates/hooks"), { recursive: true });
    writeFileSync(join(root, "templates/hooks/post-update"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(root, "templates/hooks/post-update"), 0o755);
    writeFileSync(join(root, "templates/foo"), "whatever\n");
    // the repository fetched from
    expect(native(root, ["init", "-q", "--template=", "-b", "main", "src"]).status).toBe(0);
    for (const name of ["one", "two"]) {
      writeFileSync(join(root, "src", `${name}.txt`), `${name}\n`);
      native(join(root, "src"), ["add", `${name}.txt`]);
      native(join(root, "src"), ["commit", "-q", "-m", name]);
    }
  });
  afterAll(() => removeTempDir(root), CLEANUP_TIMEOUT);
  afterEach(() => process.umask(savedUmask));

  it('t1301-shared-repo.sh: "shared = 0400 (faulty permission u-w)"', async () => {
    mkdirSync(join(root, "sub"));
    const theirs = native(join(root, "sub"), ["init", "--shared=0400"]);
    expect(theirs.status).toBe(128);
    let error: unknown;
    try {
      new InitCommand().setShared("0400");
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(SharedRepositoryModeError);
    expect((error as SharedRepositoryModeError).lines.join("\n")).toBe(theirs.stderr.trimEnd());
  });

  for (const umask of [0o002, 0o022]) {
    it(`t1301-shared-repo.sh: "shared=1 does not clear bits preset by umask ${umask.toString(8).padStart(3, "0")}"`, async () => {
      const n = `u${counter}-native`;
      const o = `u${counter++}-ours`;
      expect(native(root, ["init", "-q", "--template=", "--shared=1", n], umask).status).toBe(0);
      const result = await oursInit(o, (c) => c.setShared("1").setTemplate(""), umask);
      expect(result.shared).toBe(0o660);
      expect(modeOf(`${o}/.git/HEAD`)).toBe(0o664);
      expect(modes(o)).toEqual(modes(n));
      expect(native(join(root, o), ["config", "core.sharedrepository"]).stdout).toBe("1\n");
    });
  }

  it('t1301-shared-repo.sh: "shared=all"', async () => {
    const result = await oursInit("all-ours", (c) => c.setShared("all").setTemplate(""));
    expect(result.shared).toBe(0o664);
    expect(native(join(root, "all-ours"), ["config", "core.sharedrepository"]).stdout).toBe("2\n");
  });

  it('t1301-shared-repo.sh: "template cannot set core.bare"', async () => {
    mkdirSync(join(root, "bare-templates"));
    writeFileSync(join(root, "bare-templates/config"), "[core]\n\tbare = true\n");
    expect(native(root, ["init", "-q", "--template=bare-templates", "subdir-native"]).status).toBe(
      0,
    );
    await oursInit("subdir-ours", (c) => c.setTemplate("bare-templates"));
    expect(modes("subdir-ours")).toEqual(modes("subdir-native"));
    expect(native(join(root, "subdir-ours"), ["config", "core.bare"]).stdout).toBe("false\n");
  });

  for (const [shared, rw, ro] of [
    ["0660", 0o660, 0o440],
    ["0640", 0o640, 0o440],
    ["0600", 0o600, 0o400],
    ["0666", 0o666, 0o444],
    ["0664", 0o664, 0o444],
  ] as const) {
    const bits = (m: number) => ["r", "w", "x"].map((c, i) => (m & (4 >> i) ? c : "-")).join("");
    const text = (m: number) => [6, 3, 0].map((s) => bits((m >> s) & 7)).join("");
    for (const [kind, umask, expected] of [
      ["ro", 0o277, ro],
      ["rw", 0o077, rw],
    ] as const) {
      it(`t1301-shared-repo.sh: "shared = ${shared} (${text(expected)}) ${kind}"`, async () => {
        const n = `sri${counter}-native`;
        const o = `sri${counter++}-ours`;
        for (const d of [n, o]) {
          expect(native(root, ["init", "-q", "--template=", d]).status).toBe(0);
          native(join(root, d), ["config", "core.sharedrepository", shared]);
          native(join(root, d), ["commit", "-q", "--allow-empty", "-m", "a1"]);
          mkdirSync(join(root, d, ".git/info"));
        }
        expect(native(join(root, n), ["update-server-info"], umask).status).toBe(0);
        await oursUpdateServerInfo(`${o}/.git`, umask);
        expect(modeOf(`${n}/.git/info/refs`)).toBe(expected);
        expect(modeOf(`${o}/.git/info/refs`)).toBe(expected);
      });
    }
  }

  it('t1301-shared-repo.sh: "info/refs respects umask in unshared repo"', async () => {
    expect(native(root, ["init", "-q", "--template=", "unshared"]).status).toBe(0);
    native(join(root, "unshared"), ["commit", "-q", "--allow-empty", "-m", "a1"]);
    await oursUpdateServerInfo("unshared/.git", 0o002);
    expect(modeOf("unshared/.git/info/refs")).toBe(0o664);
  });

  it('t1301-shared-repo.sh: "forced modes"', async () => {
    const n = "forced-native";
    const o = "forced-ours";
    expect(
      native(root, ["init", "-q", "-b", "main", "--shared=0660", "--template=templates", n], 0o002)
        .status,
    ).toBe(0);
    await oursInit(o, (c) => c.setShared("0660").setTemplate("templates"), 0o002);
    expect(modeOf(`${o}/.git/hooks/post-update`)).toBe(0o770);
    for (const d of [n, o]) writeFileSync(join(root, d, "frotz"), "");
    expect(native(join(root, n), ["add", "frotz"], 0o002).status).toBe(0);
    expect(native(join(root, n), ["commit", "-q", "-a", "-m", "initial"], 0o002).status).toBe(0);
    expect(native(join(root, n), ["repack", "-q", "-a", "-d"], 0o002).status).toBe(0);
    await underUmask(0o002, async () => {
      const git = await openOurs(join(root, o), environment());
      await git.add().addFilepattern("frotz").call();
      await git.commit().setMessage("initial").call();
      const backend = await createGitFilesBackend({
        files: createNodeFilesApi({ rootDir: root }),
        gitDir: `${o}/.git`,
        environment: environment(),
      });
      await repack({ ...backend, gitDir: `${o}/.git` });
    });
    const skip = [".git/COMMIT_EDITMSG", ".git/objects/info/packs", ".git/info/refs"];
    // our repack leaves the emptied loose object directories (git's prune-packed removes
    // them); their modes are checked below
    const ours = modes(o, skip);
    const emptied = Object.keys(ours).filter((p) => /^\.git\/objects\/[0-9a-f]{2}$/.test(p));
    for (const p of emptied) {
      expect(readdirSync(join(root, o, p))).toEqual([]);
      expect(ours[p]).toBe("d 2770");
      delete ours[p];
    }
    expect(ours).toEqual(modes(n, skip));
    // t1301's checks: nothing reachable by others, directories 2770, objects read-only
    for (const [path, mode] of Object.entries(ours)) {
      if (path === "." || path === "frotz") continue;
      expect(Number.parseInt(mode.slice(2), 8) & 0o007, path).toBe(0);
      if (mode.startsWith("d")) expect(mode, path).toBe("d 2770");
      if (path.startsWith(".git/objects/") && mode.startsWith("f"))
        expect(mode, path).toBe("f 440");
    }
  });

  it('t1301-shared-repo.sh: "remote init does not use config from cwd"', async () => {
    expect(native(root, ["init", "-q", "--template=", "cwd"]).status).toBe(0);
    native(join(root, "cwd"), ["config", "core.sharedrepository", "0666"]);
    await oursInit("cwd/child.git", (c) => c.setBare(true).setTemplate(""));
    expect(modeOf("cwd/child.git/config")).toBe(0o644);
  });

  it('t1301-shared-repo.sh: "re-init respects core.sharedrepository (local)"', async () => {
    const n = "reinit-local-native";
    const o = "reinit-local-ours";
    for (const d of [n, o]) {
      expect(native(root, ["init", "-q", "--template=", d]).status).toBe(0);
      native(join(root, d), ["config", "core.sharedrepository", "0666"]);
    }
    expect(native(join(root, n), ["init", "-q", "--template=../templates"]).status).toBe(0);
    await oursInit(o, (c) => c.setTemplate("templates"));
    expect(modeOf(`${o}/.git/foo`)).toBe(0o666);
    expect(modes(o)).toEqual(modes(n));
  });

  it('t1301-shared-repo.sh: "re-init respects core.sharedrepository (remote)"', async () => {
    const n = "child-remote-native.git";
    const o = "child-remote-ours.git";
    expect(native(root, ["init", "-q", "--bare", "--template=", "--shared=0666", n]).status).toBe(
      0,
    );
    await oursInit(o, (c) => c.setBare(true).setShared("0666").setTemplate(""));
    expect(native(root, ["init", "-q", "--bare", "--template=templates", n]).status).toBe(0);
    await oursInit(o, (c) => c.setBare(true).setTemplate("templates"));
    expect(modeOf(`${o}/foo`)).toBe(0o666);
    expect(modes(o)).toEqual(modes(n));
  });

  it('t1301-shared-repo.sh: "template can set core.sharedrepository"', async () => {
    mkdirSync(join(root, "shared-templates"));
    copyFileSync(join(root, "templates/foo"), join(root, "shared-templates/foo"));
    writeFileSync(join(root, "shared-templates/config"), "[core]\n\tsharedrepository = 0666\n");
    const n = "child-template-native.git";
    const o = "child-template-ours.git";
    expect(native(root, ["init", "-q", "--bare", "--template=shared-templates", n]).status).toBe(0);
    await oursInit(o, (c) => c.setBare(true).setTemplate("shared-templates"));
    expect(modeOf(`${o}/HEAD`)).toBe(0o666);
    expect(modes(o)).toEqual(modes(n));
  });

  it("a FilesApi without modes still records core.sharedRepository", async () => {
    const result = await new InitCommand().setShared("group").call();
    expect(result.shared).toBe(0o660);
    const files = (await import("@statewalker/vcs-core")).createInMemoryFilesApi();
    const created = await new InitCommand()
      .setFilesApi(files)
      .setDirectory("repo")
      .setShared("0640")
      .setTemplate("")
      .call();
    expect(created.shared).toBe(-0o640);
    const config = new TextDecoder().decode(
      (await (
        await import("@statewalker/vcs-core")
      ).readFile(files, "repo/.git/config")) as Uint8Array,
    );
    expect(config).toContain("\tsharedrepository = 0640\n");
    expect(config).toContain("[receive]\n\tdenyNonFastforwards = true\n");
  });

  /** A twin pair made by `init --shared=<shared>` (ours `setShared`), then a fetch from src. */
  async function sharedAndFetched(shared: string, umask: number): Promise<[string, string]> {
    const n = `fetched${counter}-native`;
    const o = `fetched${counter++}-ours`;
    const refspec = "refs/heads/main:refs/remotes/src/main";
    expect(native(root, ["init", "-q", "--template=", `--shared=${shared}`, n], umask).status).toBe(
      0,
    );
    const fetched = native(
      join(root, n),
      ["fetch", "-q", "--no-write-fetch-head", join(root, "src"), refspec],
      umask,
    );
    expect(fetched.status, fetched.stderr).toBe(0);
    await oursInit(o, (c) => c.setShared(shared).setTemplate(""), umask);
    await underUmask(umask, async () => {
      const git = await openOurs(root, environment(), undefined, o);
      await git
        .fetch()
        .setRemote(join(root, "src"))
        .setRefSpecs(refspec)
        .setWriteFetchHead(false)
        .call();
    });
    return [n, o];
  }

  /** Modes of the files a fetch wrote: refs, reflogs, objects (loose or packed alike). */
  function fetchedModes(dir: string): Record<string, string> {
    const all = modes(dir);
    const out: Record<string, string> = {};
    for (const [path, mode] of Object.entries(all)) {
      // our repack leaves emptied loose object directories (git's prune-packed removes them)
      if (
        /^\.git\/objects\/[0-9a-f]{2}$/.test(path) &&
        readdirSync(join(root, dir, path)).length === 0
      ) {
        continue;
      }
      // native unpacks a small fetch into loose objects, ours keeps the pack: one mode each
      const key = /^\.git\/objects\/([0-9a-f]{2}(\/.*)?|pack\/.+)$/.test(path)
        ? `.git/objects/<${mode.startsWith("d") ? "dir" : "file"}>`
        : path;
      out[key] = mode;
    }
    return out;
  }

  for (const shared of ["group", "all", "true", "1"]) {
    for (const umask of [0o077, 0o022]) {
      it(`--shared=${shared}, then a fetch under umask ${umask.toString(8).padStart(3, "0")}: the fetched files get git's modes`, async () => {
        const [n, o] = await sharedAndFetched(shared, umask);
        expect(fetchedModes(o)).toEqual(fetchedModes(n));
        expect(modeOf(`${o}/.git/refs/remotes/src/main`)).toBe(
          modeOf(`${n}/.git/refs/remotes/src/main`),
        );
        // a re-init reports the repository shared, as git's "Reinitialized existing shared"
        const again = await oursInit(o, (c) => c.setTemplate(""), umask);
        expect(again.reinitialized).toBe(true);
        expect(again.shared).toBe(shared === "all" ? 0o664 : 0o660);
        expect(native(join(root, n), ["init", "--template="], umask).stdout).toMatch(
          /^Reinitialized existing shared Git repository/,
        );
      });
    }
  }

  for (const umask of [0o077, 0o022]) {
    it(`--shared=0640, a fetch, then gc --prune=now under umask ${umask.toString(8).padStart(3, "0")}`, async () => {
      const [n, o] = await sharedAndFetched("0640", umask);
      const gc = [
        "-c",
        "gc.reflogExpire=90.days.ago",
        "-c",
        "gc.reflogExpireUnreachable=30.days.ago",
        "gc",
        "-q",
        "--prune=now",
      ];
      expect(native(join(root, n), gc, umask).status).toBe(0);
      await underUmask(umask, async () => {
        const git = await openOurs(root, environment(), undefined, o);
        await git.gc().setPrune("now").setQuiet(true).call();
      });
      const ours = fetchedModes(o);
      expect(ours).toEqual(fetchedModes(n));
      for (const path of [".git/info/refs", ".git/objects/info/packs", ".git/packed-refs"]) {
        expect(ours[path], path).toBe("f 640");
      }
      expect(ours[".git/objects/info/commit-graph"]).toBe("f 440");
    });
  }
  /** git's 0444 under `umask`, as {@link modes} prints it. */
  const readOnly = (umask: number) => `f ${(0o444 & ~umask).toString(8)}`;

  /** The modes of every loose object and pack-family file below `dir`'s objects. */
  function objectFileModes(dir: string): Set<string> {
    const out = new Set<string>();
    for (const [path, mode] of Object.entries(modes(dir))) {
      if (
        /^\.git\/objects\/([0-9a-f]{2}\/[0-9a-f]+|pack\/.+\.(pack|idx|rev|bitmap|mtimes))$/.test(
          path,
        )
      ) {
        out.add(mode);
      }
    }
    return out;
  }

  // unshared repositories: git creates loose objects and pack-family files read-only
  // (odb_write_loose_object, finish_tmp_packfile, commit-graph and midx: 0444 under the umask)
  for (const umask of [0o077, 0o022]) {
    it(`unshared: an add and a fetch under umask ${umask.toString(8).padStart(3, "0")}`, async () => {
      const [n, o] = await sharedAndFetched("umask", umask);
      writeFileSync(join(root, n, "a.txt"), "a\n");
      writeFileSync(join(root, o, "a.txt"), "a\n");
      expect(native(join(root, n), ["add", "a.txt"], umask).status).toBe(0);
      await underUmask(umask, async () => {
        const git = await openOurs(root, environment(), undefined, o);
        await git.add().addFilepattern("a.txt").call();
      });
      const ours = fetchedModes(o);
      expect(ours).toEqual(fetchedModes(n));
      expect(objectFileModes(o)).toEqual(new Set([readOnly(umask)]));
      expect(objectFileModes(n)).toEqual(new Set([readOnly(umask)]));
    });

    it(`unshared: gc --prune=now under umask ${umask.toString(8).padStart(3, "0")} writes git's read-only packs and commit-graph`, async () => {
      const [n, o] = await sharedAndFetched("umask", umask);
      const gc = [
        "-c",
        "gc.reflogExpire=90.days.ago",
        "-c",
        "gc.reflogExpireUnreachable=30.days.ago",
        "gc",
        "-q",
        "--prune=now",
      ];
      expect(native(join(root, n), gc, umask).status).toBe(0);
      await underUmask(umask, async () => {
        const git = await openOurs(root, environment(), undefined, o);
        await git.gc().setPrune("now").setQuiet(true).call();
      });
      const ours = fetchedModes(o);
      expect(ours).toEqual(fetchedModes(n));
      expect(ours[".git/objects/info/commit-graph"]).toBe(readOnly(umask));
      expect(objectFileModes(o)).toEqual(new Set([readOnly(umask)]));
    });
  }
  /** The modes of `dir`'s `objects/pack`, every hex name (pack, midx checksum) as `X`. */
  function packDirModes(dir: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [path, mode] of Object.entries(modes(dir))) {
      if (!path.startsWith(".git/objects/pack/")) continue;
      out[path.replace(/[0-9a-f]{40}/g, "X")] = mode;
    }
    return out;
  }

  for (const umask of [0o077, 0o022]) {
    it(`unshared: repack -a -d -b --write-midx under umask ${umask.toString(8).padStart(3, "0")}: bitmaps read-only, the multi-pack-index itself not`, async () => {
      const [n, o] = await sharedAndFetched("umask", umask);
      const args = ["repack", "-q", "-a", "-d", "-b", "--write-midx"];
      const theirs = native(join(root, n), args, umask);
      expect(theirs.status, theirs.stderr).toBe(0);
      await underUmask(umask, async () => {
        const git = await openOurs(root, environment(), undefined, o);
        await git
          .repack()
          .setAll(true)
          .setDeleteRedundant(true)
          .setWriteBitmaps(true)
          .setWriteMidx(true)
          .setQuiet(true)
          .call();
      });
      const ours = packDirModes(o);
      expect(ours).toEqual(packDirModes(n));
      expect(ours[".git/objects/pack/multi-pack-index-X.bitmap"]).toBe(readOnly(umask));
      expect(ours[".git/objects/pack/multi-pack-index"]).toBe(`f ${(0o666 & ~umask).toString(8)}`);
    });
  }
});
