/**
 * The order of a v2 fetch request's wants when the server takes `want-ref`
 * (`uploadpack.allowRefInWant`), against native git: fetch-pack's add_wants writes one line
 * per ref it seeks, in one pass over the remote's refs sorted by name (HEAD first for a clone,
 * do_fetch_pack's sort and filter_refs), then the ids no listed ref matched (exact-id
 * refspecs): `want-ref <name>` for a listed ref, `want <id>` for an exact id, a ref whose
 * object is complete here skipped. upload-pack walks its wants in that order
 * (get_shallow_commits), so a shallow server's shallow-info, and a clone's `.git/shallow`,
 * follow it.
 *
 * The request lines native upload-pack read (`GIT_TRACE_PACKET`, `upload-pack<`) are compared:
 * native git fetching over file://, ours over `git daemon --inetd`, both v2.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultTransports } from "@statewalker/vcs-transport";
import { createNodeGitHostEnvironment } from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Git } from "../src/index.js";
import { openOurs } from "./merge-native-helpers.js";
import { childDuplex, daemonArgs, gitAsync } from "./native-connect-support.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { git3Binary, nativeGit3Env } from "./native-git3.js";
import { gitOut, putFile, testEnv } from "./status-native-support.js";
import { CLEANUP_TIMEOUT, removeTempDir } from "./temp-dir-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root: string;
let srv: string;
let counter = 0;
const git = (cwd: string, ...args: string[]) => gitOut(root, cwd, args);

// one temporary root for the file; each describe block works in a directory of its own
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "want-ref-order-"));
});
afterAll(() => removeTempDir(root), CLEANUP_TIMEOUT);

/** The wants, deepen and have lines upload-pack read, in order. */
function requestLines(trace: string): string[] {
  return readFileSync(trace, "latin1")
    .split("\n")
    .map((l) => /upload-pack< (.*)$/.exec(l)?.[1])
    .filter(
      (l): l is string =>
        l !== undefined && /^(want|want-ref|deepen|deepen-relative|shallow|have|done)( |$)/.test(l),
    );
}

function commit(repo: string, name: string): string {
  putFile(repo, `${name}.t`, `${name}\n`);
  git(repo, "add", `${name}.t`);
  git(repo, "commit", "-q", "-m", name);
  return git(repo, "rev-parse", "HEAD").trim();
}

describeGit("want-ref lines in git's order, as native git", () => {
  const ids: Record<string, string> = {};

  beforeAll(() => {
    srv = join(root, "srv");
    const repo = join(srv, "repo");
    git(root, "init", "-q", "-b", "main", repo);
    ids.base = commit(repo, "base");
    for (const branch of ["zeta", "alpha", "mid", "beta"]) {
      git(repo, "checkout", "-q", "-b", branch, ids.base as string);
      ids[branch] = commit(repo, branch);
    }
    // two names of one commit, and an annotated tag of beta (followed)
    git(repo, "branch", "twin", ids.alpha as string);
    git(repo, "tag", "-a", "-m", "v1", "v1", ids.beta as string);
    git(repo, "checkout", "-q", "main");
    ids.main = commit(repo, "main");
    git(repo, "config", "uploadpack.allowRefInWant", "true");
  });

  /** An empty repository, and our working copy of it. */
  async function emptyRepo(name: string): Promise<{ dir: string; ours: Git }> {
    const dir = join(root, `${name}-${counter++}`);
    git(root, "init", "-q", "-b", "main", dir);
    git(dir, "config", "protocol.version", "2");
    const ours = await openOurs(
      root,
      createNodeGitHostEnvironment({ env: testEnv(root) }),
      undefined,
      dir.slice(root.length + 1),
    );
    return { dir, ours };
  }

  /** `git daemon --inetd` over `srv`, tracing what upload-pack reads into `trace`. */
  const transports = (trace: string) =>
    createDefaultTransports({
      openSocket: async () =>
        childDuplex(
          spawn("git", daemonArgs(srv), { env: testEnv(root, { GIT_TRACE_PACKET: trace }) }),
        ),
    });

  const FETCHES: Array<[string, () => string[]]> = [
    [
      "named refs given out of order",
      () => ["refs/heads/zeta:refs/x/zeta", "refs/heads/alpha:refs/x/alpha", "mid:refs/x/mid"],
    ],
    [
      "named refs mixed with an exact id",
      () => [
        "refs/heads/zeta:refs/x/zeta",
        `${ids.mid}:refs/x/exact`,
        "refs/heads/alpha:refs/x/alpha",
      ],
    ],
    [
      "an exact id a named ref also lists",
      () => ["refs/heads/zeta:refs/x/zeta", `${ids.alpha}:refs/x/exact`, "alpha:refs/x/alpha"],
    ],
    ["two names of one commit", () => ["twin:refs/x/twin", "alpha:refs/x/alpha"]],
    [
      "exact ids alone, in both orders",
      () =>
        [ids.zeta, ids.mid, ids.alpha]
          .sort()
          .reverse()
          .map((id, i) => `${id}:refs/x/e${i}`),
    ],
    ["a followed tag", () => ["zeta:refs/x/zeta", "beta:refs/x/beta"]],
  ];

  for (const [name, specs] of FETCHES) {
    it(`a fetch of ${name}: the request lines native upload-pack read`, async () => {
      const nativeTrace = join(root, `trace-${counter++}`);
      const native = await emptyRepo("native");
      const r = await gitAsync(
        root,
        native.dir,
        ["fetch", "-q", `file://${join(srv, "repo")}`, ...specs()],
        { GIT_TRACE_PACKET: nativeTrace },
      );
      expect(r.status, r.stderr).toBe(0);

      const ourTrace = join(root, `trace-${counter++}`);
      const mine = await emptyRepo("ours");
      await mine.ours
        .fetch()
        .setRemote("git://localhost/repo")
        .setRefSpecs(...specs())
        .setTransports(transports(ourTrace))
        .call();
      expect(requestLines(ourTrace)).toEqual(requestLines(nativeTrace));
      expect(git(mine.dir, "for-each-ref")).toBe(git(native.dir, "for-each-ref"));
    });
  }

  it("a clone: HEAD first, then the refs by name", async () => {
    const nativeTrace = join(root, `trace-${counter++}`);
    const nativeDir = join(root, `native-clone-${counter++}`);
    const r = await gitAsync(
      root,
      root,
      ["-c", "protocol.version=2", "clone", "-q", `file://${join(srv, "repo")}`, nativeDir],
      { GIT_TRACE_PACKET: nativeTrace },
    );
    expect(r.status, r.stderr).toBe(0);

    const ourTrace = join(root, `trace-${counter++}`);
    const mine = await emptyRepo("ours-clone");
    await mine.ours
      .clone()
      .setURI("git://localhost/repo")
      .setTransports(transports(ourTrace))
      .call();
    expect(requestLines(ourTrace)).toEqual(requestLines(nativeTrace));
  });
});

/**
 * A shallow server taking `want-ref`: upload-pack's shallow-info follows its want list
 * (get_shallow_commits), yet native git writes a `--depth` clone's `.git/shallow` sorted and
 * sends a shallow server's own commits in graft order, so the file is the same whatever order
 * the wants went out in; the request lines are compared above. Released git (2.43 to 2.56)
 * cannot clone so itself (its upload-pack writes `wanted-refs` before `shallow-info`, which its
 * fetch-pack refuses: `expected 'packfile', received 'shallow-info'`), so the oracle is native
 * git's clone of the same server without `want-ref` (add_wants writes its `want <id>` lines in
 * the same order); git master (`$GIT3`) clones so, and is compared directly, request lines too.
 */
const git3 = git3Binary();
const ORACLES: Array<{ name: string; bin: string; env: (home: string) => Record<string, string> }> =
  [
    { name: "PATH's git", bin: "git", env: (home) => testEnv(home) },
    ...(git3
      ? [
          {
            name: "$GIT3",
            bin: git3,
            // files repositories, which PATH's git reads back
            env: (home: string) => ({ ...nativeGit3Env(home), GIT_DEFAULT_REF_FORMAT: "files" }),
          },
        ]
      : []),
  ];

/** Native `bin` in `cwd`, without blocking (ours may serve in this process). */
function run(
  bin: string,
  env: Record<string, string>,
  cwd: string,
  args: string[],
): Promise<{ status: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, env });
    let stderr = "";
    child.stdout.resume();
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("latin1");
    });
    child.stdin.end();
    child.on("close", (status) => resolve({ status, stderr }));
  });
}

for (const oracle of ORACLES) {
  describeGit(`want-ref from a shallow server, as native git (${oracle.name})`, () => {
    let base: string;
    let shalSrv: string;
    const env = () => oracle.env(base);

    beforeAll(() => {
      base = join(root, `shallow-${oracle.bin === "git" ? "path" : "git3"}`);
      shalSrv = join(base, "srv");
      mkdirSync(base, { recursive: true });
      const full = join(base, "full");
      git(base, "init", "-q", "-b", "main", full);
      for (const n of [1, 2, 3, 4, 5]) commit(full, `c${n}`);
      git(full, "tag", "-a", "v1", "-m", "v1", "HEAD~3");
      git(full, "branch", "side", "HEAD~1");
      for (const b of ["zeta", "alpha"]) {
        git(full, "checkout", "-q", "-b", b, "main~2");
        commit(full, b);
      }
      git(full, "checkout", "-q", "main");
      for (const [name, refInWant] of [
        ["shal-ref", "true"],
        ["shal-plain", "false"],
      ] as const) {
        const dest = join(shalSrv, name);
        git(base, "clone", "-q", "--no-local", "--depth", "2", "--no-single-branch", full, dest);
        git(dest, "config", "uploadpack.allowRefInWant", refInWant);
      }
    });

    const transports = (trace?: string) =>
      createDefaultTransports({
        openSocket: async () =>
          childDuplex(
            spawn(oracle.bin, daemonArgs(shalSrv), {
              env: { ...env(), ...(trace ? { GIT_TRACE_PACKET: trace } : {}) },
            }),
          ),
      });

    /** The shallow file's bytes, refs and objects a clone left. */
    const stateOf = (repo: string) => ({
      shallow: existsSync(join(repo, ".git/shallow"))
        ? readFileSync(join(repo, ".git/shallow"), "latin1")
        : "",
      refs: git(repo, "for-each-ref", "--format=%(refname) %(objectname)"),
      objects: git(repo, "rev-list", "--all", "--objects").split("\n").filter(Boolean).sort(),
    });

    for (const depth of [undefined, 1]) {
      it(`a clone${depth ? ` --depth ${depth}, then fetch --deepen=1` : ""}: .git/shallow as native git's`, async () => {
        const n = counter++;
        const nativeClone = (repo: string, dest: string, trace?: string) =>
          run(oracle.bin, { ...env(), ...(trace ? { GIT_TRACE_PACKET: trace } : {}) }, base, [
            "-c",
            "protocol.version=2",
            "clone",
            "-q",
            ...(depth ? ["--depth", String(depth), "--no-single-branch"] : []),
            `file://${join(shalSrv, repo)}`,
            dest,
          ]);
        const plain = join(base, `plain-${n}`);
        const r = await nativeClone("shal-plain", plain);
        expect(r.status, r.stderr).toBe(0);
        // native git's own want-ref clone: dies on released git, compared where it works
        const native = join(base, `native-${n}`);
        const nativeTrace = join(base, `trace-${n}-native`);
        const nr = await nativeClone("shal-ref", native, nativeTrace);
        if (nr.status !== 0) {
          expect(nr.stderr).toContain("fatal: expected 'packfile', received 'shallow-info'");
        }

        const dir = join(base, `ours-${n}`);
        git(base, "init", "-q", "-b", "main", dir);
        git(dir, "config", "protocol.version", "2");
        const open = () =>
          openOurs(
            base,
            createNodeGitHostEnvironment({ env: testEnv(base) }),
            undefined,
            dir.slice(base.length + 1),
          );
        const ourTrace = join(base, `trace-${n}-ours`);
        const clone = (await open())
          .clone()
          .setURI("git://localhost/shal-ref")
          .setTransports(transports(ourTrace));
        if (depth) clone.setDepth(depth).setSingleBranch(false);
        await clone.call();
        expect(stateOf(dir)).toEqual(stateOf(plain));
        if (nr.status === 0) {
          expect(stateOf(dir)).toEqual(stateOf(native));
          expect(requestLines(ourTrace)).toEqual(requestLines(nativeTrace));
        }

        if (depth) {
          const d = await run(oracle.bin, env(), plain, [
            "-c",
            "protocol.version=2",
            "fetch",
            "-q",
            "--deepen=1",
          ]);
          expect(d.status, d.stderr).toBe(0);
          await (await open()).fetch().setDeepen(1).setTransports(transports()).call();
          expect(stateOf(dir)).toEqual(stateOf(plain));
          if (nr.status === 0) {
            const nd = await run(oracle.bin, env(), native, [
              "-c",
              "protocol.version=2",
              "fetch",
              "-q",
              "--deepen=1",
            ]);
            expect(nd.status, nd.stderr).toBe(0);
            expect(stateOf(dir)).toEqual(stateOf(native));
          }
        }
      });
    }
  });
}
