/**
 * The ref lines `git fetch` and `git push` print on stderr abbreviate ids as
 * find_unique_abbrev does under `core.abbrev` (longer where a local object shares the
 * prefix), and the summary column is `transport_summary_width` wide (twice the longest
 * abbreviation plus 3). Native twins: the same history fetched and pushed by native git and
 * by ours, an upstream commit crafted to share its first digits with a commit both already
 * have, then the stderr lines compared.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitFilesBackend, openGitLinkedWorktrees } from "@statewalker/vcs-store-files";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Git } from "../src/index.js";
import {
  type NativeGitHttpBackend,
  nativeGitAvailable,
  nativeGitEnv,
  nativeGitHttpBackend,
} from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root = "";
let home = "";
const run = (cwd: string, args: string[], input?: string) =>
  execFileSync("git", args, {
    cwd,
    env: nativeGitEnv(home),
    encoding: "latin1",
    input,
    stdio: ["pipe", "pipe", "pipe"],
  });
/** The stderr of a git command that may fail (a refused push). */
const stderrOf = (cwd: string, args: string[]) =>
  spawnSync("git", args, { cwd, env: nativeGitEnv(home), encoding: "latin1" }).stderr;

async function open(dir: string): Promise<Git> {
  const files = createNodeFilesApi({ rootDir: dir });
  const environment = createNodeGitHostEnvironment({ env: nativeGitEnv(home) });
  const { history } = await createGitFilesBackend({ files });
  const worktrees = await openGitLinkedWorktrees({ files, gitDir: ".git", history, environment });
  return Git.fromWorkingCopy(await worktrees.openCurrent());
}

/**
 * A commit of `tree` on `parent` whose id starts with `prefix`: the message's counter is
 * raised until it does, then the commit is written into `repo`.
 */
function craftCommit(repo: string, tree: string, parent: string, prefix: string): string {
  const ident = "Interop Tester <interop@example.com> 1112911993 +0000";
  for (let n = 0; ; n++) {
    const body = `tree ${tree}\nparent ${parent}\nauthor ${ident}\ncommitter ${ident}\n\ncrafted ${n}\n`;
    const bytes = Buffer.from(body);
    const id = createHash("sha1")
      .update(Buffer.concat([Buffer.from(`commit ${bytes.length}\0`), bytes]))
      .digest("hex");
    if (!id.startsWith(prefix)) continue;
    const written = run(repo, ["hash-object", "-t", "commit", "-w", "--stdin"], body).trim();
    expect(written).toBe(id);
    return id;
  }
}

/** The ref lines of a stderr: the `From`/`To` line and those that start with a space. */
const refLines = (stderr: string) =>
  stderr
    .split("\n")
    .filter((l) => /^(From |To | |Everything up-to-date)/.test(l))
    .filter((l) => !l.startsWith(" (use") && l.trim() !== "");

describeGit("abbreviated ids in fetch and push summaries, native twins", () => {
  let backend: NativeGitHttpBackend;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "summary-abbrev-native-"));
    home = join(root, "home");
    mkdirSync(home);
    backend = nativeGitHttpBackend(root, home);
    globalThis.fetch = backend.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    backend?.close();
    rmSync(root, { recursive: true, force: true });
  });

  /** `work` published as `src.git`, cloned as `native` and `ours` (ours fetching over HTTP). */
  function setup(abbrev: string | undefined) {
    const work = join(root, "work");
    const src = join(root, "src.git");
    run(root, ["init", "-q", "-b", "main", work]);
    run(work, ["commit", "-q", "--allow-empty", "-m", "base"]);
    run(work, ["commit", "-q", "--allow-empty", "-m", "second"]);
    run(work, ["branch", "dev"]);
    run(work, ["branch", "gone"]);
    run(root, ["clone", "-q", "--bare", work, src]);
    const native = join(root, "native");
    const ours = join(root, "ours");
    run(root, ["clone", "-q", src, native]);
    run(root, ["clone", "-q", src, ours]);
    run(ours, ["config", "remote.origin.url", "http://git.test/src.git"]);
    for (const dir of [native, ours]) {
      if (abbrev !== undefined) run(dir, ["config", "core.abbrev", abbrev]);
    }
    return { work, src, native, ours };
  }

  for (const [label, abbrev, prefixLength] of [
    ["core.abbrev=4, a commit sharing 5 digits", "4", 5],
    ["core.abbrev unset (auto), no collision", undefined, 0],
    ["core.abbrev=12", "12", 0],
  ] as const) {
    it(`fetch --prune: ${label}`, async () => {
      const { work, src, native, ours } = setup(abbrev);
      const base = run(work, ["rev-parse", "HEAD~1"]).trim();
      const tip = run(work, ["rev-parse", "HEAD"]).trim();
      const tree = run(work, ["rev-parse", "HEAD^{tree}"]).trim();
      // main moves to a commit that shares its first digits with `base` (both clones have it)
      const crafted = craftCommit(work, tree, tip, base.slice(0, prefixLength));
      run(work, ["update-ref", "refs/heads/main", crafted]);
      // dev is rewritten (a forced update), gone deleted (pruned), topic new
      const rewritten = run(work, ["commit-tree", "-p", base, "-m", "dev rewritten", tree]).trim();
      run(work, ["update-ref", "refs/heads/dev", rewritten]);
      run(work, ["branch", "-D", "gone"]);
      run(work, ["branch", "topic", base]);
      run(work, ["push", "-q", "--force", "--prune", src, "refs/heads/*:refs/heads/*"]);

      const nativeLines = refLines(stderrOf(native, ["fetch", "--prune", "origin"]));
      const result = await (await open(ours))
        .fetch()
        .setRemote("origin")
        .setRemoveDeletedRefs(true)
        .call();
      const oursLines = (result.display ?? []).map((l) =>
        l.replace("From http://git.test/src", `From ${src.replace(/\.git$/, "")}`),
      );
      expect(nativeLines.length).toBeGreaterThan(3);
      expect(oursLines).toEqual(nativeLines);
    });

    it(`push: ${label}`, async () => {
      const { work, native, ours } = setup(abbrev);
      // each pushes to a bare copy of its own; ours over HTTP
      const nativeDst = join(root, "native-dst.git");
      const oursDst = join(root, "ours-dst.git");
      run(root, ["clone", "-q", "--bare", work, nativeDst]);
      run(root, ["clone", "-q", "--bare", work, oursDst]);
      run(oursDst, ["config", "http.receivepack", "true"]);
      run(ours, ["remote", "add", "dst", "http://git.test/ours-dst.git"]);
      run(native, ["remote", "add", "dst", nativeDst]);
      const base = run(native, ["rev-parse", "HEAD~1"]).trim();
      const tip = run(native, ["rev-parse", "HEAD"]).trim();
      const tree = run(native, ["rev-parse", "HEAD^{tree}"]).trim();
      for (const dir of [native, ours]) {
        const crafted = craftCommit(dir, tree, tip, base.slice(0, prefixLength));
        run(dir, ["update-ref", "refs/heads/main", crafted]);
        const rewritten = run(dir, ["commit-tree", "-p", base, "-m", "dev rewritten", tree]).trim();
        run(dir, ["update-ref", "refs/heads/dev", rewritten]);
        run(dir, ["branch", "-f", "topic", base]);
        run(dir, ["branch", "-f", "gone", base]);
      }
      const specs = [
        "refs/heads/main:refs/heads/main",
        "+refs/heads/dev:refs/heads/dev",
        "refs/heads/topic:refs/heads/topic",
        // behind the remote's: refused (non-fast-forward)
        "refs/heads/gone:refs/heads/gone",
      ];
      const nativeLines = refLines(stderrOf(native, ["push", "dst", ...specs]));
      const result = await (await open(ours))
        .push()
        .setRemote("dst")
        .setRefSpecs(...specs)
        .call();
      const oursLines = (result.display ?? []).map((l) =>
        l.replace("To http://git.test/ours-dst.git", `To ${nativeDst}`),
      );
      expect(nativeLines.length).toBeGreaterThan(3);
      expect(oursLines).toEqual(nativeLines);
    });
  }
});
