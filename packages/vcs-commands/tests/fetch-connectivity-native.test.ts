/**
 * The checks git makes after a fetch or clone receives objects, against native git (2.43 and
 * 2.5x): connected.c's check_connected over the new ref tips (fetch: `error: <url> did not
 * send all necessary objects`, exit 1; clone: `fatal: remote did not send all necessary
 * objects`), fetch-pack's check of a deepening fetch, index-pack's
 * `--check-self-contained-and-connected` of a clone (`fatal: did not receive expected object`)
 * and `fetch.fsckObjects` (`index-pack --strict`: `fetch.fsck.<msg-id>`, `fetch.fsck.skipList`).
 *
 * The incomplete packs come from native `git http-backend` with an
 * `uploadpack.packObjectsHook` that feeds pack-objects extra `^<commit>` lines (a server
 * that leaves history out), served over a loopback port to both clients; a shallow source
 * cloned `--shallow-since` past its own boundary sends one too (git's clone fails there).
 */

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FetchCheckError } from "@statewalker/vcs-transport";
import { createNodeGitHostEnvironment } from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Git } from "../src/index.js";
import { type LoopbackServer, serveOnLoopback } from "./http-loopback-support.js";
import { openOurs } from "./merge-native-helpers.js";
import { gitAsync } from "./native-connect-support.js";
import { nativeGitAvailable, nativeGitHttpBackend } from "./native-git-http-backend.js";
import { gitOut, gitRun, putFile, testEnv } from "./status-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

const nativeVersion = (() => {
  if (!nativeGitAvailable()) return "2.56" as const;
  const m = /git version (\d+)\.(\d+)/.exec(execFileSync("git", ["--version"]).toString());
  return m && Number(m[1]) === 2 && Number(m[2]) < 45 ? ("2.43" as const) : ("2.56" as const);
})();

let root: string;
let srv: string;
let counter = 0;
const git = (cwd: string, ...args: string[]) => gitOut(root, cwd, args);
const commitEnv = (n: number) => ({
  GIT_AUTHOR_DATE: `170000000${n} +0000`,
  GIT_COMMITTER_DATE: `170000000${n} +0000`,
});

/**
 * The refs of a repository, `<name> <id>` per line; before git 2.48 a fetch writes no
 * `refs/remotes/origin/HEAD` (ours writes it as 2.48+ does)
 */
const refsOf = (dir: string) =>
  git(dir, "for-each-ref", "--format=%(refname) %(objectname)")
    .split("\n")
    .filter((l) => nativeVersion !== "2.43" || !l.startsWith("refs/remotes/origin/HEAD "))
    .join("\n");
/** git's stderr without progress and `Cloning into` lines. */
const stderrLines = (stderr: string) =>
  stderr
    .split("\n")
    .filter((l) => !/^(remote: |Cloning into|Receiving|Resolving|Unpacking|Checking)/.test(l));
/** Ours: the stderr lines of a failed check (git's ends with a newline: one empty line more). */
const ourLines = (error: FetchCheckError) => [...error.lines, ""];

/** An empty repository for our side. */
async function oursAt(name: string): Promise<{ dir: string; ours: Git }> {
  const dir = join(root, `${name}-${counter++}`);
  git(root, "init", "-q", "-b", "main", dir);
  const ours = await openOurs(
    root,
    createNodeGitHostEnvironment({ env: testEnv(root) }),
    undefined,
    dir.slice(root.length + 1),
  );
  return { dir, ours };
}

/** Our working copy over `dir` again (its configuration read anew). */
function reopen(dir: string): Promise<Git> {
  return openOurs(
    root,
    createNodeGitHostEnvironment({ env: testEnv(root) }),
    undefined,
    dir.slice(root.length + 1),
  );
}

/** Runs `call` and returns the FetchCheckError it fails with. */
async function failure(call: () => Promise<unknown>): Promise<FetchCheckError> {
  try {
    await call();
  } catch (error) {
    if (error instanceof FetchCheckError) return error;
    throw error;
  }
  throw new Error("expected the fetch to fail");
}

describeGit("connectivity and fsck checks after fetch and clone, as native git", () => {
  let server: { http: LoopbackServer; close(): Promise<void> };
  let url: string;
  const ids: Record<string, string> = {};
  /** Makes the served repository leave `revs` (`^<id>` lines) out of every pack. */
  const drop = (repo: string, revs: string[]) => {
    const file = join(srv, repo, "drop-revs");
    if (revs.length === 0) rmSync(file, { force: true });
    else writeFileSync(file, `${revs.join("\n")}\n`);
  };

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "fetch-connectivity-"));
    srv = join(root, "srv");
    mkdirSync(srv);
    const work = join(root, "work");
    git(root, "init", "-q", "-b", "main", work);
    for (const n of [1, 2, 3, 4]) {
      putFile(work, `d/f${n}.txt`, `${n}\n`);
      putFile(work, "top.txt", `top ${n}\n`);
      git(work, "add", ".");
      gitOut(root, work, ["commit", "-qm", `c${n}`], commitEnv(n));
      ids[`c${n}`] = git(work, "rev-parse", "HEAD").trim();
      ids[`c${n}:d`] = git(work, "rev-parse", "HEAD:d").trim();
      ids[`c${n}:d/f${n}.txt`] = git(work, "rev-parse", `HEAD:d/f${n}.txt`).trim();
    }
    git(work, "tag", "-a", "v1", "-m", "v1", ids.c2 as string);
    git(root, "clone", "-q", "--bare", "--no-local", work, join(srv, "repo.git"));
    // malformed commits on top of c4: a committer without `<` (badName), then a bad time zone
    const bad = join(srv, "bad.git");
    git(root, "clone", "-q", "--bare", "--no-local", work, bad);
    const tree = git(bad, "rev-parse", "main^{tree}").trim();
    const hash = (text: string) =>
      execFileSync("git", ["hash-object", "-t", "commit", "-w", "--literally", "--stdin"], {
        cwd: bad,
        env: testEnv(root),
        input: text,
      })
        .toString()
        .trim();
    ids.badName = hash(
      `tree ${tree}\nparent ${ids.c4}\nauthor A <a@x> 1700000005 +0000\ncommitter C c@x> 1700000005 +0000\n\nbad name\n`,
    );
    ids.badTz = hash(
      `tree ${tree}\nparent ${ids.badName}\nauthor A <a@x> 1700000006 +99999\ncommitter C <c@x> 1700000006 +0000\n\nbad tz\n`,
    );
    git(bad, "update-ref", "refs/heads/main", ids.badTz as string);
    git(bad, "update-ref", "refs/heads/name", ids.badName as string);

    // the hook: extra pack-objects input from the repository's drop-revs (cwd is the git dir)
    const hook = join(root, "pack-hook.sh");
    writeFileSync(
      hook,
      [
        "#!/bin/bash",
        // no thin pack: its deltas would name bases the client does not have either
        'args=(); for a in "$@"; do [ "$a" != "--thin" ] && args+=("$a"); done',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell script
        'if [ -f drop-revs ]; then { cat drop-revs; cat; } | "${args[@]}"; else exec "${args[@]}"; fi',
        "",
      ].join("\n"),
    );
    chmodSync(hook, 0o755);
    const backend = nativeGitHttpBackend(srv, root, {
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_2: "uploadpack.packObjectsHook",
      GIT_CONFIG_VALUE_2: hook,
    });
    const http = await serveOnLoopback((request) => backend.fetch(request));
    server = {
      http,
      close: async () => {
        await http.close();
        backend.close();
      },
    };
    url = `${http.baseUrl}/repo.git`;
  });

  afterAll(async () => {
    await server?.close();
    rmSync(root, { recursive: true, force: true });
  });

  /** A native and an our repository, both with `origin` at `remoteUrl` and `main` at c1. */
  async function fetchTwins(remoteUrl: string, start?: string) {
    const native = join(root, `n-${counter++}`);
    git(root, "init", "-q", "-b", "main", native);
    const { dir } = await oursAt("o");
    for (const d of [native, dir]) {
      git(d, "remote", "add", "origin", remoteUrl);
      if (start) {
        git(d, "fetch", "-q", join(srv, "repo.git"), `${start}:refs/remotes/origin/main`);
      }
    }
    return { native, dir, ours: await reopen(dir) };
  }

  for (const start of [undefined, "c1"] as const) {
    it(`fetch of an incomplete pack fails before any ref is written (${start ? "on top of c1" : "into an empty repository"})`, async () => {
      drop("repo.git", [`^${ids.c3}`]);
      try {
        const { native, dir, ours } = await fetchTwins(url, start ? ids[start] : undefined);
        const before = refsOf(native);
        const n = await gitAsync(root, native, ["fetch", "origin"]);
        expect(n.status, n.stderr).toBe(1);
        const error = await failure(() =>
          ours.fetch().setRemote("origin").setCompatibility(nativeVersion).call(),
        );
        expect(error.exitCode).toBe(1);
        expect(ourLines(error)).toEqual(stderrLines(n.stderr));
        expect(error.lines.join("\n")).toContain(
          `error: ${url} did not send all necessary objects`,
        );
        expect(refsOf(dir)).toBe(before);
        expect(refsOf(native)).toBe(before);
        // FETCH_HEAD was truncated when the fetch started and stays empty
        expect(readFileSync(join(dir, ".git/FETCH_HEAD"), "utf8")).toBe(
          existsSync(join(native, ".git/FETCH_HEAD"))
            ? readFileSync(join(native, ".git/FETCH_HEAD"), "utf8")
            : "",
        );
      } finally {
        drop("repo.git", []);
      }
    });
  }

  // what rev-list stops at: a subtree, a blob, the tip itself (each left out of the pack)
  const missingCases: Array<{ name: string; revs: () => string[] }> = [
    { name: "a subtree", revs: () => [`^${ids["c4:d"]}`] },
    { name: "a blob", revs: () => [`^${ids["c3:d/f3.txt"]}`] },
    { name: "the tip", revs: () => [`^${ids.c4}`] },
  ];
  for (const c of missingCases) {
    it(`fetch of a pack without ${c.name}: rev-list's message, as native git`, async () => {
      drop("repo.git", c.revs());
      try {
        const { native, dir, ours } = await fetchTwins(url, ids.c1);
        const before = refsOf(native);
        const n = await gitAsync(root, native, ["fetch", "origin", "main"]);
        expect(n.status, n.stderr).toBe(1);
        const error = await failure(() =>
          ours
            .fetch()
            .setRemote("origin")
            .setRefSpecs("main")
            .setCompatibility(nativeVersion)
            .call(),
        );
        expect(ourLines(error)).toEqual(stderrLines(n.stderr));
        expect(refsOf(dir)).toBe(before);
      } finally {
        drop("repo.git", []);
      }
    });
  }

  it("fetch.fsckObjects over a kept pack (100 objects or more): index-pack's output is read", async () => {
    const big = join(srv, "big.git");
    const work = join(root, `bw-${counter++}`);
    git(root, "init", "-q", "-b", "main", work);
    for (let i = 0; i < 40; i++) putFile(work, `f${i}.txt`, `${i}\n`);
    git(work, "add", ".");
    gitOut(root, work, ["commit", "-qm", "many"], commitEnv(1));
    for (let i = 0; i < 40; i++) {
      putFile(work, `g${i}.txt`, `${i} more\n`);
      git(work, "add", ".");
      gitOut(root, work, ["commit", "-qm", `more ${i}`], commitEnv(2));
    }
    const tree = git(work, "rev-parse", "HEAD^{tree}").trim();
    const head = git(work, "rev-parse", "HEAD").trim();
    git(root, "clone", "-q", "--bare", "--no-local", work, big);
    const bad = execFileSync(
      "git",
      ["hash-object", "-t", "commit", "-w", "--literally", "--stdin"],
      {
        cwd: big,
        env: testEnv(root),
        input: `tree ${tree}\nparent ${head}\nauthor A <a@x> 1700000005 +0000\ncommitter <c@x> 1700000005 +0000\n\nno name\n`,
      },
    )
      .toString()
      .trim();
    git(big, "update-ref", "refs/heads/main", bad);
    const { native, dir } = await fetchTwins(`${server.http.baseUrl}/big.git`);
    for (const d of [native, dir]) git(d, "config", "fetch.fsckObjects", "true");
    const ours = await reopen(dir);
    const n = await gitAsync(root, native, ["fetch", "origin"]);
    expect(n.status).toBe(128);
    const error = await failure(() =>
      ours.fetch().setRemote("origin").setCompatibility(nativeVersion).call(),
    );
    expect(error.exitCode).toBe(128);
    expect(ourLines(error)).toEqual(stderrLines(n.stderr));
    expect(error.lines.at(-1)).toBe("fatal: fetch-pack: invalid index-pack output");
    expect(refsOf(dir)).toBe("");
  });

  it("the same fetch from a complete server succeeds, and the check reads no more", async () => {
    const { native, dir, ours } = await fetchTwins(url, ids.c1);
    expect((await gitAsync(root, native, ["fetch", "-q", "origin"])).status).toBe(0);
    await ours.fetch().setRemote("origin").call();
    expect(refsOf(dir)).toBe(refsOf(native));
  });

  it("clone of an incomplete pack: index-pack's self-contained check refuses it", async () => {
    drop("repo.git", [`^${ids.c3}`]);
    try {
      const native = join(root, `nc-${counter++}`);
      const n = await gitAsync(root, root, ["clone", url, native]);
      expect(n.status).toBe(128);
      expect(existsSync(native)).toBe(false); // remove_junk
      const { dir, ours } = await oursAt("oc");
      const error = await failure(() => ours.clone().setURI(url).call());
      expect(error.exitCode).toBe(128);
      expect(ourLines(error)).toEqual(stderrLines(n.stderr));
      expect(refsOf(dir)).toBe("");
    } finally {
      drop("repo.git", []);
    }
  });

  it("clone --depth of an incomplete pack: update_remote_refs' check refuses it", async () => {
    // the pack leaves out c3, the shallow commit itself
    drop("repo.git", [`^${ids.c3}`]);
    try {
      const native = join(root, `ncd-${counter++}`);
      const n = await gitAsync(root, root, ["clone", "--depth", "2", url, native]);
      expect(n.status).toBe(128);
      const { dir, ours } = await oursAt("ocd");
      const error = await failure(() => ours.clone().setURI(url).setDepth(2).call());
      expect(error.exitCode).toBe(128);
      expect(ourLines(error)).toEqual(stderrLines(n.stderr));
      expect(refsOf(dir)).toBe("");
    } finally {
      drop("repo.git", []);
    }
  });

  it("a deepening fetch of an incomplete pack fails in fetch-pack, the shallow file unchanged", async () => {
    const native = join(root, `nd-${counter++}`);
    expect((await gitAsync(root, root, ["clone", "-q", "--depth", "1", url, native])).status).toBe(
      0,
    );
    const { dir, ours } = await oursAt("od");
    await ours.clone().setURI(url).setDepth(1).call();
    const shallowBefore = readFileSync(join(native, ".git/shallow"), "utf8");
    expect(readFileSync(join(dir, ".git/shallow"), "utf8")).toBe(shallowBefore);
    drop("repo.git", [`^${ids.c3}`]);
    try {
      const n = await gitAsync(root, native, ["fetch", "--depth", "3", "origin"]);
      expect(n.status).toBe(1);
      const error = await failure(() =>
        ours.fetch().setRemote("origin").setDepth(3).setCompatibility(nativeVersion).call(),
      );
      expect(error.exitCode).toBe(1);
      expect(ourLines(error)).toEqual(stderrLines(n.stderr));
      expect(readFileSync(join(native, ".git/shallow"), "utf8")).toBe(shallowBefore);
      expect(readFileSync(join(dir, ".git/shallow"), "utf8")).toBe(shallowBefore);
      expect(refsOf(dir)).toBe(refsOf(native));
    } finally {
      drop("repo.git", []);
    }
  });

  it("a shallow clone then a fetch of new history stays connected (the shallow boundary counts)", async () => {
    const work = join(root, `w-${counter++}`);
    git(root, "clone", "-q", "--bare", "--no-local", join(srv, "repo.git"), join(srv, "grow.git"));
    const growUrl = `${server.http.baseUrl}/grow.git`;
    const native = join(root, `ns-${counter++}`);
    expect(
      (await gitAsync(root, root, ["clone", "-q", "--depth", "1", growUrl, native])).status,
    ).toBe(0);
    const { dir, ours } = await oursAt("os");
    await ours.clone().setURI(growUrl).setDepth(1).call();
    git(root, "clone", "-q", "--no-local", join(srv, "grow.git"), work);
    putFile(work, "new.txt", "new\n");
    git(work, "add", ".");
    gitOut(root, work, ["commit", "-qm", "c5"], commitEnv(7));
    git(work, "push", "-q", join(srv, "grow.git"), "main");
    expect((await gitAsync(root, native, ["fetch", "-q", "origin"])).status).toBe(0);
    await ours.fetch().setRemote("origin").call();
    expect(refsOf(dir)).toBe(refsOf(native));
    expect(readFileSync(join(dir, ".git/shallow"), "utf8")).toBe(
      readFileSync(join(native, ".git/shallow"), "utf8"),
    );
  });

  it("objects an alternate holds count as present (its refs are complete history)", async () => {
    const base = join(root, `base-${counter++}`);
    git(root, "clone", "-q", "--bare", "--no-local", join(srv, "repo.git"), base);
    git(base, "update-ref", "refs/heads/main", ids.c2 as string);
    git(base, "update-ref", "-d", "refs/tags/v1");
    const native = join(root, `na-${counter++}`);
    git(root, "init", "-q", "-b", "main", native);
    const { dir } = await oursAt("oa");
    for (const d of [native, dir]) {
      mkdirSync(join(d, ".git/objects/info"), { recursive: true });
      writeFileSync(join(d, ".git/objects/info/alternates"), `${join(base, "objects")}\n`);
      git(d, "remote", "add", "origin", url);
    }
    // the pack leaves out what the alternate has: only its refs tell the server
    drop("repo.git", [`^${ids.c2}`]);
    try {
      const n = await gitAsync(root, native, ["fetch", "-q", "origin"]);
      expect(n.status, n.stderr).toBe(0);
      await (await reopen(dir)).fetch().setRemote("origin").call();
      expect(refsOf(dir)).toBe(refsOf(native));
      expect(git(dir, "fsck", "--no-progress", "--connectivity-only")).toBe("");
    } finally {
      drop("repo.git", []);
    }
  });

  const badUrl = () => `${server.http.baseUrl}/bad.git`;
  const fsckCases: Array<{ name: string; config: string[]; refspec: string; ok: boolean }> = [
    { name: "malformed commits fetched without fsck", config: [], refspec: "main", ok: true },
    {
      name: "fetch.fsckObjects: a bad time zone",
      config: ["fetch.fsckObjects=true"],
      refspec: "main",
      ok: false,
    },
    {
      name: "transfer.fsckObjects: a bad name",
      config: ["transfer.fsckObjects=true"],
      refspec: "name",
      ok: false,
    },
    {
      name: "fetch.fsckObjects=false over transfer.fsckObjects",
      config: ["transfer.fsckObjects=true", "fetch.fsckObjects=false"],
      refspec: "name",
      ok: true,
    },
    {
      name: "fetch.fsck.<msg-id> made a warning",
      config: ["fetch.fsckObjects=true", "fetch.fsck.badName=warn"],
      refspec: "name",
      ok: true,
    },
    {
      name: "fetch.fsck.<msg-id> ignored, the other object still an error",
      config: ["fetch.fsckObjects=true", "fetch.fsck.badTimezone=ignore"],
      refspec: "main",
      ok: false,
    },
    {
      name: "both downgraded",
      config: [
        "fetch.fsckObjects=true",
        "fetch.fsck.badTimezone=ignore",
        "fetch.fsck.badName=warn",
      ],
      refspec: "main",
      ok: true,
    },
    {
      name: "fetch.fsck.skipList",
      config: ["fetch.fsckObjects=true", "fetch.fsck.skipList=skip.txt"],
      refspec: "name",
      ok: true,
    },
    {
      name: "fetch.fsck.skipList that cannot be read",
      config: ["fetch.fsckObjects=true", "fetch.fsck.skipList=missing.txt"],
      refspec: "name",
      ok: false,
    },
  ];
  for (const c of fsckCases) {
    it(`${c.name}: as native git`, async () => {
      const { native, dir } = await fetchTwins(badUrl());
      for (const d of [native, dir]) {
        for (const kv of c.config) {
          const eq = kv.indexOf("=");
          git(d, "config", kv.slice(0, eq), kv.slice(eq + 1));
        }
        writeFileSync(join(d, "skip.txt"), `# skipped\n${ids.badName}\n`);
      }
      const ours = await reopen(dir);
      const spec = `${c.refspec}:refs/remotes/origin/x`;
      const n = await gitAsync(root, native, ["fetch", "origin", spec]);
      const fetch = () =>
        ours.fetch().setRemote("origin").setRefSpecs(spec).setCompatibility(nativeVersion).call();
      if (c.ok) {
        expect(n.status, n.stderr).toBe(0);
        const result = await fetch();
        // index-pack's warnings come first on git's stderr
        const warnings = stderrLines(n.stderr).filter((l) => l.startsWith("warning: "));
        expect(result.messages ?? []).toEqual(warnings);
        expect(refsOf(dir)).toBe(refsOf(native));
      } else {
        expect(n.status).toBe(128);
        const error = await failure(fetch);
        expect(error.exitCode).toBe(128);
        expect(ourLines(error)).toEqual(stderrLines(n.stderr));
        expect(refsOf(dir)).toBe("");
        // nothing received was kept
        expect(gitRun(root, dir, ["cat-file", "-e", ids.badName as string]).status).toBe(
          gitRun(root, native, ["cat-file", "-e", ids.badName as string]).status,
        );
      }
    });
  }

  it("a fetch.fsck.<msg-id> git cannot use: an unknown type, a fatal message demoted", async () => {
    for (const [config, check] of [
      [["fetch.fsck.badName=bogus"], false],
      [["fetch.fsck.badName=WARN"], false],
      [["fetch.fsckObjects=true", "fetch.fsck.nulInHeader=warn"], true],
    ] as const) {
      const { native, dir } = await fetchTwins(badUrl());
      for (const d of [native, dir]) {
        for (const kv of config) {
          const eq = kv.indexOf("=");
          git(d, "config", kv.slice(0, eq), kv.slice(eq + 1));
        }
      }
      const ours = await reopen(dir);
      const n = await gitAsync(root, native, ["fetch", "origin", "name:refs/remotes/origin/x"]);
      expect(n.status).toBe(128);
      const call = ours
        .fetch()
        .setRemote("origin")
        .setRefSpecs("name:refs/remotes/origin/x")
        .setCompatibility(nativeVersion)
        .call();
      if (check) {
        const error = await failure(() => call);
        expect(ourLines(error)).toEqual(stderrLines(n.stderr));
      } else {
        await expect(call).rejects.toThrow(stderrLines(n.stderr)[0] as string);
      }
      expect(refsOf(dir)).toBe("");
    }
  });

  it("clone with transfer.fsckObjects refuses a malformed commit as native git", async () => {
    const native = join(root, `ncf-${counter++}`);
    const n = await gitAsync(root, root, [
      "-c",
      "transfer.fsckObjects=true",
      "clone",
      badUrl(),
      native,
    ]);
    expect(n.status).toBe(128);
    const { dir } = await oursAt("ocf");
    git(dir, "config", "transfer.fsckObjects", "true");
    const reopened = await reopen(dir);
    const error = await failure(() => reopened.clone().setURI(badUrl()).call());
    expect(error.exitCode).toBe(128);
    expect(ourLines(error)).toEqual(stderrLines(n.stderr));
  });

  it("a clone --shallow-since past a shallow source's boundary fails its connectivity check (local path)", async () => {
    const shal = join(srv, "shal");
    git(root, "clone", "-q", "--no-local", "--depth", "2", join(srv, "repo.git"), shal);
    const native = join(root, `nss-${counter++}`);
    const n = gitRun(root, root, [
      "clone",
      "--no-local",
      "--shallow-since=1700000001",
      shal,
      native,
    ]);
    expect(n.status).toBe(128);
    const { dir, ours } = await oursAt("oss");
    const error = await failure(() =>
      ours
        .clone()
        .setURI(shal)
        .setLocal(false)
        .setShallowSince(new Date(1700000001 * 1000))
        .call(),
    );
    expect(error.exitCode).toBe(128);
    expect(ourLines(error)).toEqual(stderrLines(n.stderr));
    expect(refsOf(dir)).toBe("");
  });
});
