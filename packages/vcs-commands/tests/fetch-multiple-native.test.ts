/**
 * `git fetch --all`, `git fetch --multiple`, `git fetch <group>` and `git remote update`
 * against native git (builtin/fetch.c `fetch_multiple`, builtin/remote.c `update`, remote.c
 * `add_remote_or_group`). Each twin is two clones made by native git (`n<k>`, `o<k>`) beside
 * the upstream repositories `one`, `two` and the mirror `three` (local paths: git's local
 * transport, ours upload-pack in process); native git runs the command in one, ours in the
 * other, and the twins compare stdout, stderr (without progress), the exit status, the refs,
 * FETCH_HEAD and the reflogs.
 *
 * Scenarios from t5514-fetch-multiple.sh and t5506-remote-groups.sh (cited per test), and
 * the `update` tests of t5505-remote.sh.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createNodeGitHostEnvironment,
  createNodeHookRunner,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { FetchMultipleResult, Git, GitApiError } from "../src/index.js";
import { TagOption } from "../src/index.js";
import { nativeIs25x } from "./hooks-native-support.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { gitOut, gitRun, putFile, testEnv } from "./status-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root: string;
let counter = 0;
const git = (cwd: string, ...args: string[]) => gitOut(root, cwd, args, DATES);

const DATES = {
  GIT_AUTHOR_DATE: "1700000000 +0000",
  GIT_COMMITTER_DATE: "1700000000 +0000",
};

async function ours(name: string): Promise<Git> {
  const env = testEnv(root, DATES);
  return openOurs(
    root,
    createNodeGitHostEnvironment({
      env,
      hookRunner: createNodeHookRunner({ env, compatibility: nativeIs25x ? "2.56" : "2.43" }),
    }),
    undefined,
    name,
  );
}

/** t5514's setup_repository: `main` with one commit, `side` with a second. */
function setupRepository(name: string): void {
  const dir = join(root, name);
  mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main");
  putFile(dir, "file", "");
  git(dir, "add", "file");
  git(dir, "commit", "-qm", "Initial");
  git(dir, "checkout", "-q", "-b", "side");
  putFile(dir, "elif", "");
  git(dir, "add", "elif");
  git(dir, "commit", "-qm", "Second");
  git(dir, "checkout", "-q", "main");
}

/** Two clones of `one` (`n<k>`, `o<k>`), each step of `prepare` run in both. */
function twins(prepare: (dir: string) => void = () => {}): [string, string] {
  const names: [string, string] = [`n${counter}`, `o${counter}`];
  counter++;
  for (const name of names) {
    git(root, "clone", "-q", "one", name);
    prepare(join(root, name));
  }
  return names;
}

const refs = (dir: string) =>
  git(join(root, dir), "for-each-ref", "--format=%(refname) %(objectname) %(symref)");

function reflogs(dir: string): string {
  const lines: string[] = [];
  const walk = (rel: string) => {
    const at = join(root, dir, ".git", rel);
    if (!existsSync(at)) return;
    for (const entry of readdirSync(at, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const path = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else lines.push(`${path}:\n${readFileSync(join(at, entry.name), "latin1")}`);
    }
  };
  walk("logs/refs");
  return lines.join("\n");
}

const fetchHead = (dir: string) => {
  const path = join(root, dir, ".git", "FETCH_HEAD");
  return existsSync(path) ? readFileSync(path, "latin1") : null;
};

/** Native stderr without progress lines. */
const withoutProgress = (text: string) =>
  text
    .split("\n")
    .filter((l) => !/^(remote: |Unpacking|Receiving|Resolving)/.test(l))
    .join("\n");

/** Compares what native git did in `n` with what ours did in `o`. */
function expectSame(
  n: string,
  o: string,
  native: { status: number | null; stdout: string; stderr: string },
  result: FetchMultipleResult | GitApiError,
  /** git ran the fetches in parallel: FETCH_HEAD has their lines in the order they ended */
  parallel = false,
): void {
  if ("exitCode" in result && !("fetches" in result)) {
    expect(native.status).toBe(result.exitCode);
    expect(result.message).toBe(native.stderr.trim());
  } else {
    const r = result as FetchMultipleResult;
    expect(r.stdout).toBe(native.stdout);
    // a death's message is ours, its last line git's
    const lastLines = (text: string) =>
      text
        .split("\n")
        .filter((l) => !/^(fatal: |$|Please make sure|and the repository)/.test(l))
        .join("\n");
    expect(lastLines(r.stderr)).toBe(lastLines(withoutProgress(native.stderr)));
    expect(r.exitCode).toBe(native.status);
  }
  expect(refs(o)).toBe(refs(n));
  const sorted = (text: string | null) => text?.split("\n").sort().join("\n") ?? null;
  if (parallel) expect(sorted(fetchHead(o))).toBe(sorted(fetchHead(n)));
  else expect(fetchHead(o)).toBe(fetchHead(n));
  expect(reflogs(o)).toBe(reflogs(n));
}

async function run(
  n: string,
  o: string,
  args: string[],
  build: (git: Git) => { call(): Promise<FetchMultipleResult> },
  parallel = false,
) {
  const native = gitRun(root, join(root, n), args, DATES);
  let result: FetchMultipleResult | GitApiError;
  try {
    result = await build(await ours(o)).call();
  } catch (error) {
    result = error as GitApiError;
  }
  expectSame(n, o, native, result, parallel);
  return { native, result };
}

const addRemotes =
  (...names: string[]) =>
  (dir: string) => {
    for (const name of names) git(dir, "remote", "add", name, `../${name}`);
  };

describeGit("git fetch --all / --multiple / <group>, git remote update, as native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "fetch-multiple-"));
    setupRepository("one");
    setupRepository("two");
    git(join(root, "two"), "branch", "another");
    git(root, "clone", "-q", "--mirror", "two", "three");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('t5514-fetch-multiple.sh: "git fetch --all"', async () => {
    const [n, o] = twins(addRemotes("one", "two", "three"));
    await run(n, o, ["fetch", "--all"], (g) => g.fetchMultiple().setAll(true));
  });

  it('t5514-fetch-multiple.sh: "git fetch --all --no-write-fetch-head"', async () => {
    const [n, o] = twins(addRemotes("one", "two", "three"));
    await run(n, o, ["fetch", "--all", "--no-write-fetch-head"], (g) =>
      g.fetchMultiple().setAll(true).setWriteFetchHead(false),
    );
  });

  it('t5514-fetch-multiple.sh: "git fetch --all should continue if a remote has errors"', async () => {
    const [n, o] = twins((dir) => {
      git(dir, "remote", "add", "bad", "../non-existing");
      addRemotes("one", "two", "three")(dir);
    });
    const { native } = await run(n, o, ["fetch", "--all"], (g) => g.fetchMultiple().setAll(true));
    expect(native.status).toBe(1);
  });

  it('t5514-fetch-multiple.sh: "git fetch --all does not allow non-option arguments"', async () => {
    const [n, o] = twins();
    await run(n, o, ["fetch", "--all", "origin"], (g) =>
      g.fetchMultiple().setAll(true).setRemotes("origin"),
    );
    await run(n, o, ["fetch", "--all", "origin", "main"], (g) =>
      g.fetchMultiple().setAll(true).setRemotes("origin", "main"),
    );
  });

  it('t5514-fetch-multiple.sh: "git fetch --multiple (but only one remote)"', async () => {
    const [n, o] = twins(addRemotes("three"));
    await run(n, o, ["fetch", "--multiple", "three"], (g) => g.fetchMultiple().setRemotes("three"));
  });

  it('t5514-fetch-multiple.sh: "git fetch --multiple (two remotes)", "git fetch --multiple (bad remote names)", "git fetch --all (skipFetchAll)", "git fetch --multiple (ignoring skipFetchAll)"', async () => {
    const [n, o] = twins((dir) => {
      git(dir, "remote", "rm", "origin");
      addRemotes("one", "two")(dir);
    });
    await run(n, o, ["fetch", "--multiple", "one", "two"], (g) =>
      g.fetchMultiple().setRemotes("one", "two"),
    );
    await run(n, o, ["fetch", "--multiple", "four"], (g) => g.fetchMultiple().setRemotes("four"));
    const clearTracking = (dir: string) => {
      for (const line of git(dir, "for-each-ref", "--format=%(refname)", "refs/remotes/")
        .trim()
        .split("\n")) {
        if (line && !line.endsWith("/HEAD")) git(dir, "update-ref", "-d", line);
      }
    };
    for (const d of [n, o]) {
      clearTracking(join(root, d));
      addRemotes("three")(join(root, d));
      git(join(root, d), "config", "remote.three.skipFetchAll", "true");
    }
    await run(n, o, ["fetch", "--all"], (g) => g.fetchMultiple().setAll(true));
    for (const d of [n, o]) clearTracking(join(root, d));
    await run(n, o, ["fetch", "--multiple", "one", "two", "three"], (g) =>
      g.fetchMultiple().setRemotes("one", "two", "three"),
    );
  });

  it('t5514-fetch-multiple.sh: "git fetch --all --no-tags", "git fetch --all --tags"', async () => {
    git(root, "clone", "-q", "one", "test5");
    git(join(root, "test5"), "tag", "test-tag");
    const make = (dir: string) => {
      git(dir, "remote", "set-url", "origin", "../test5");
    };
    const [n, o] = twins(make);
    await run(n, o, ["fetch", "--all", "--no-tags"], (g) =>
      g.fetchMultiple().setAll(true).setTagOpt(TagOption.NO_TAGS),
    );
    await run(n, o, ["fetch", "--all", "--tags"], (g) =>
      g.fetchMultiple().setAll(true).setTagOpt(TagOption.FETCH_TAGS),
    );
  });

  it('t5514-fetch-multiple.sh: "parallel"', async () => {
    const [n, o] = twins((dir) => {
      git(dir, "remote", "add", "one", "./bogus1");
      git(dir, "remote", "add", "two", "./bogus2");
    });
    const { native } = await run(n, o, ["fetch", "--jobs=2", "--multiple", "one", "two"], (g) =>
      g.fetchMultiple().setJobs(2).setRemotes("one", "two"),
    );
    expect(native.stderr).toContain("could not fetch 'one' (exit code: 128)");
    // fetch.parallel does the same; a successful parallel run reads as a sequential one
    const [n2, o2] = twins(addRemotes("one", "two"));
    for (const d of [n2, o2]) git(join(root, d), "config", "fetch.parallel", "2");
    await run(
      n2,
      o2,
      ["fetch", "--prune", "--multiple", "one", "two"],
      (g) => g.fetchMultiple().setPrune(true).setRemotes("one", "two"),
      true,
    );
  });

  it('t5514-fetch-multiple.sh: "git fetch --multiple --jobs=0 picks a default"', async () => {
    const [n, o] = twins(addRemotes("one", "two"));
    await run(n, o, ["fetch", "--multiple", "--jobs=0"], (g) => g.fetchMultiple().setJobs(0));
  });

  it('t5514-fetch-multiple.sh: "git fetch (fetch all remotes with fetch.all = true)", "git config fetch.all false (fetch only default remote)", "git fetch --no-all (fetch only default remote without fetch.all)"', async () => {
    for (const fetchAll of ["true", "false"]) {
      const [n, o] = twins((dir) => {
        addRemotes("one", "two", "three")(dir);
        git(dir, "config", "fetch.all", fetchAll);
      });
      await run(n, o, ["fetch"], (g) => g.fetchMultiple());
      const [n2, o2] = twins((dir) => {
        addRemotes("one", "two", "three")(dir);
        git(dir, "config", "fetch.all", fetchAll);
      });
      await run(n2, o2, ["fetch", "--no-all"], (g) => g.fetchMultiple().setAll(false));
    }
  });

  it('t5506-remote-groups.sh: "no group updates all", "nonexistent group produces error", "updating group updates all members (remote update)", "updating group updates all members (fetch)", "updating group does not update non-members (remote update)", "updating remote name updates that remote", "updating group in parallel with a duplicate remote does not fail (fetch)"', async () => {
    const fresh = () => twins(addRemotes("one", "two"));
    let [n, o] = fresh();
    await run(n, o, ["remote", "update"], (g) => g.remoteUpdate());
    [n, o] = fresh();
    const missing = await run(n, o, ["remote", "update", "nonexistent"], (g) =>
      g.remoteUpdate().setGroups("nonexistent"),
    );
    expect(missing.native.status).toBe(1);
    [n, o] = fresh();
    for (const d of [n, o]) {
      git(join(root, d), "config", "--add", "remotes.all", "one");
      git(join(root, d), "config", "--add", "remotes.all", "two");
    }
    await run(n, o, ["remote", "update", "all"], (g) => g.remoteUpdate().setGroups("all"));
    [n, o] = fresh();
    for (const d of [n, o]) git(join(root, d), "config", "remotes.all", "one two");
    await run(n, o, ["fetch", "all"], (g) =>
      g.fetchMultiple().setMultiple(false).setRemotes("all"),
    );
    [n, o] = fresh();
    for (const d of [n, o]) git(join(root, d), "config", "--add", "remotes.some", "one");
    await run(n, o, ["remote", "update", "some"], (g) => g.remoteUpdate().setGroups("some"));
    [n, o] = fresh();
    await run(n, o, ["remote", "update", "one"], (g) => g.remoteUpdate().setGroups("one"));
    [n, o] = fresh();
    for (const d of [n, o]) {
      git(join(root, d), "config", "--add", "remotes.duplicate", "one");
      git(join(root, d), "config", "--add", "remotes.duplicate", "one");
      git(join(root, d), "config", "fetch.parallel", "2");
    }
    await run(n, o, ["remote", "update", "duplicate"], (g) =>
      g.remoteUpdate().setGroups("duplicate"),
    );
  });

  // a group naming a group: each child expands its name again (git's child `git fetch <name>`)
  it('t5506-remote-groups.sh: "updating group updates all members (remote update)" (a group of groups)', async () => {
    const [n, o] = twins((dir) => {
      addRemotes("two", "three")(dir);
      git(dir, "config", "remotes.inner", "two three");
      git(dir, "config", "remotes.outer", "inner origin");
    });
    const { native } = await run(n, o, ["remote", "update", "outer"], (g) =>
      g.remoteUpdate().setGroups("outer"),
    );
    expect(native.stdout).toBe("Fetching inner\nFetching two\nFetching three\nFetching origin\n");
    // git recurses without end on a group naming itself; ours stops with an error
    for (const d of [n, o]) git(join(root, d), "config", "remotes.loop", "loop origin");
    const looped = await (await ours(o)).remoteUpdate().setGroups("loop").call();
    expect(looped.exitCode).toBe(1);
    expect(looped.stderr).toContain("nests deeper than");
  });

  it('t5505-remote.sh: "update", "update with arguments", "update --prune", "update default", "update default (overridden, with funny whitespace)", "update (with remotes.default defined)"', async () => {
    let [n, o] = twins(addRemotes("two", "three"));
    await run(n, o, ["remote", "update"], (g) => g.remoteUpdate());

    [n, o] = twins((dir) => {
      addRemotes("two", "three")(dir);
      git(dir, "remote", "add", "manduca", "../three");
      git(dir, "config", "remotes.phobaeticus", "two three");
      git(dir, "config", "remotes.titanus", "manduca");
    });
    await run(n, o, ["remote", "update", "phobaeticus", "titanus"], (g) =>
      g.remoteUpdate().setGroups("phobaeticus", "titanus"),
    );

    // a branch gone upstream: --prune removes its tracking ref
    git(root, "clone", "-q", "one", "pruned");
    git(join(root, "pruned"), "branch", "doomed");
    [n, o] = twins((dir) => {
      git(dir, "remote", "set-url", "origin", "../pruned");
      git(dir, "fetch", "-q", "origin");
    });
    git(join(root, "pruned"), "branch", "-D", "doomed");
    git(join(root, "pruned"), "branch", "fresh");
    await run(n, o, ["remote", "update", "--prune"], (g) => g.remoteUpdate().setPrune(true));
    await run(n, o, ["remote", "update", "--no-prune"], (g) => g.remoteUpdate().setPrune(false));

    [n, o] = twins((dir) => {
      addRemotes("two", "three")(dir);
      git(dir, "config", "remote.two.skipDefaultUpdate", "true");
    });
    await run(n, o, ["remote", "update", "default"], (g) => g.remoteUpdate().setGroups("default"));

    [n, o] = twins((dir) => {
      addRemotes("two", "three")(dir);
      git(dir, "config", "remotes.default", "\t two  \n");
    });
    await run(n, o, ["remote", "update", "default"], (g) => g.remoteUpdate().setGroups("default"));

    [n, o] = twins((dir) => {
      addRemotes("two", "three")(dir);
      git(dir, "config", "remotes.default", "two");
    });
    await run(n, o, ["remote", "update"], (g) => g.remoteUpdate());
    await run(n, o, ["remote", "-v", "update"], (g) => g.remoteUpdate().setVerbose(true));
  });
});
