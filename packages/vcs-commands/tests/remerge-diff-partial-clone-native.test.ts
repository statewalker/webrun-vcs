/**
 * `git log --remerge-diff` in a partial clone (statewalker-root#347): the re-merge's own
 * blobs (files with conflict markers, a conflicted virtual merge base) live only in the
 * in-memory overlay, so the batch fetches of the diff, of merge-ort's content merges and of
 * rename detection must never ask the promisor remote for them, while the blobs the merge
 * reads are fetched as native git fetches them. Native git and ours each run in a
 * `clone --filter=blob:none --no-checkout` served by native http-backend; their stdout is
 * compared, and every id a fetch asks for must exist on the server.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { createNodeGitHostEnvironment } from "@statewalker/vcs-utils-node";
import { afterAll, describe, expect, it } from "vitest";

import { installPromisorFetcher } from "../src/index.js";
import { serveOnLoopback } from "./http-loopback-support.js";
import { openOurs } from "./merge-native-helpers.js";
import { gitAsync } from "./native-connect-support.js";
import { nativeGitAvailable, nativeGitHttpBackend } from "./native-git-http-backend.js";
import { testEnv } from "./status-native-support.js";
import { CLEANUP_TIMEOUT, removeTempDir } from "./temp-dir-support.js";

/** Whether the native git on PATH can fetch over HTTP (the 2.56.1 build has no curl) */
const nativeHasCurl = (() => {
  if (!nativeGitAvailable()) return false;
  const execPath = spawnSync("git", ["--exec-path"], { encoding: "utf8" }).stdout.trim();
  return (
    existsSync(join(execPath, "git-remote-https")) || existsSync(join(execPath, "git-remote-http"))
  );
})();
const describeHttp = nativeHasCurl && process.platform === "linux" ? describe : describe.skip;

const PRELUDE = `
tick=1112911993
test_tick () { tick=$((tick + 60)); export GIT_COMMITTER_DATE="$tick +0000" GIT_AUTHOR_DATE="$tick +0000"; }
test_write_lines () { printf "%s\\n" "$@"; }
`;

/** t4069's "setup basic merges" conflicted merge, as branch `c` */
const BASIC = `
test_write_lines 1 2 3 4 5 6 7 8 9 >numbers
git add numbers; test_tick; git commit -q -m base
git branch b
test_write_lines 1 2 three 4 5 6 7 eight 9 >numbers; test_tick; git commit -q -a -m change_a
git checkout -q b
test_write_lines 1 2 tres 4 5 6 7 8 9 >numbers; test_tick; git commit -q -a -m change_b
git checkout -q -b c main
test_tick; git merge -q --no-edit b >/dev/null 2>&1 && exit 1
test_write_lines 1 2 drei 4 5 6 7 acht 9 >numbers; git add numbers; test_tick; git commit -q --no-edit
`;

/** A criss-cross whose two merge bases conflict: the virtual base holds conflict markers */
const CRISS_CROSS = `
test_write_lines 1 2 3 4 5 6 7 8 9 >numbers
git add numbers; test_tick; git commit -q -m base
git branch b
test_write_lines 1 2 three 4 5 6 7 8 9 >numbers; test_tick; git commit -q -a -m a
git checkout -q b
test_write_lines 1 2 tres 4 5 6 7 8 9 >numbers; test_tick; git commit -q -a -m bb
git checkout -q -b x main
test_tick; git merge -q --no-edit b >/dev/null 2>&1 && exit 1
test_write_lines 1 2 drei 4 5 6 7 8 9 >numbers; git add numbers; test_tick; git commit -q --no-edit
git checkout -q -b y b
test_tick; git merge -q --no-edit main >/dev/null 2>&1 && exit 1
test_write_lines 1 2 trois 4 5 6 7 8 9 >numbers; git add numbers; test_tick; git commit -q --no-edit
git checkout -q -b c x
test_write_lines 1 2 drei 4 5 6 7 8 9 x >numbers; test_tick; git commit -q -a -m x2
test_tick; git merge -q --no-edit y >/dev/null 2>&1 && exit 1
test_write_lines 1 2 vier 4 5 6 7 8 9 x >numbers; git add numbers; test_tick; git commit -q --no-edit
`;

const roots: string[] = [];
afterAll(async () => {
  for (const r of roots) await removeTempDir(r);
}, CLEANUP_TIMEOUT);

/** The ids `want` lines of upload-pack requests ask for */
function wantsOf(body: Buffer): string[] {
  return [...body.toString("latin1").matchAll(/want ([0-9a-f]{40})/g)].map((m) => m[1] as string);
}

async function scenario(script: string): Promise<{ native: string; ours: string }> {
  const root = mkdtempSync(join(tmpdir(), "remerge-partial-"));
  roots.push(root);
  const env = testEnv(root);
  mkdirSync(join(root, "work"));
  execFileSync("bash", ["-ec", `${PRELUDE}git init -q -b main .\n${script}`], {
    cwd: join(root, "work"),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  mkdirSync(join(root, "srv"));
  const served = join(root, "srv", "repo.git");
  execFileSync("git", ["clone", "-q", "--bare", "--no-local", join(root, "work"), served], { env });
  execFileSync("git", ["-C", served, "config", "uploadpack.allowFilter", "true"], { env });
  execFileSync("git", ["-C", served, "config", "uploadpack.allowAnySHA1InWant", "true"], { env });
  const backend = nativeGitHttpBackend(join(root, "srv"), root);
  const wanted: string[] = [];
  const server = await serveOnLoopback(async (request) => {
    if (request.method === "POST" && new URL(request.url).pathname.endsWith("/git-upload-pack")) {
      const raw = Buffer.from(await request.clone().arrayBuffer());
      wanted.push(
        ...wantsOf(request.headers.get("content-encoding") === "gzip" ? gunzipSync(raw) : raw),
      );
    }
    return backend.fetch(request);
  });
  try {
    const url = `${server.baseUrl}/repo.git`;
    for (const name of ["native", "ours"]) {
      const c = await gitAsync(root, root, [
        "clone",
        "-q",
        "--filter=blob:none",
        "--no-checkout",
        url,
        name,
      ]);
      expect(c.status, c.stderr).toBe(0);
    }
    const n = await gitAsync(root, join(root, "native"), [
      "log",
      "--remerge-diff",
      "-1",
      "origin/c",
    ]);
    expect(n.status, n.stderr).toBe(0);
    const git = await openOurs(root, createNodeGitHostEnvironment({ env }), undefined, "ours");
    installPromisorFetcher(git.workingCopy, {});
    const id = execFileSync("git", ["rev-parse", "origin/c"], { cwd: join(root, "ours"), env })
      .toString()
      .trim();
    const ours = Buffer.from(
      await git.log().add(id, "origin/c").setMaxCount(1).callBytes({ remergeDiff: true }),
    ).toString("latin1");
    // every object a fetch asked for is the server's: none of the re-merge's own
    const unknown = [...new Set(wanted)].filter(
      (w) => spawnSync("git", ["-C", served, "cat-file", "-e", w], { env }).status !== 0,
    );
    expect(unknown).toEqual([]);
    return { native: n.stdout, ours };
  } finally {
    await server.close();
    backend.close();
  }
}

describeHttp("--remerge-diff in a partial clone", () => {
  it('t4069-remerge-diff.sh: "setup basic merges", "remerge-diff with both a resolved conflict and an unrelated change" in a blob:none clone', async () => {
    const { native, ours } = await scenario(BASIC);
    expect(native).toContain("remerge CONFLICT (content)");
    expect(ours).toBe(native);
  });

  it('t6404-recursive-merge.sh: "setup tests" (a criss-cross whose merge bases conflict) in a blob:none clone', async () => {
    const { native, ours } = await scenario(CRISS_CROSS);
    expect(ours).toBe(native);
  });
});
