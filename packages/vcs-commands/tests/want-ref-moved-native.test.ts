/**
 * A ref asked for by name (`want-ref`, `uploadpack.allowRefInWant`) that moves between the
 * ls-refs request and the fetch request, against native git (t5703's change-while-negotiating
 * tests). Over stateless smart HTTP v2 the two are separate requests: the fetch then takes the
 * id the server sends in `wanted-refs` (fetch-pack's receive_wanted_refs), and its refs, its
 * FETCH_HEAD, its objects and a deepening fetch's connectivity check follow that id, not the
 * one ls-refs listed.
 *
 * As t5703's `one_time_script` route (lib-httpd's apply-one-time-script.sh), a proxy in front
 * of native http-backend rewrites the first response a substitution changes, once; native git
 * and ours each fetch from a copy of the same local repository through it, and their results
 * are compared.
 */
import { cpSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeGitHostEnvironment } from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type LoopbackServer, serveOnLoopback } from "./http-loopback-support.js";
import { openOurs } from "./merge-native-helpers.js";
import { gitAsync } from "./native-connect-support.js";
import { nativeGitAvailable, nativeGitHttpBackend } from "./native-git-http-backend.js";
import { gitOut, putFile, testEnv } from "./status-native-support.js";
import { CLEANUP_TIMEOUT, removeTempDir } from "./temp-dir-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root: string;
let srv: string;
let counter = 0;
const git = (cwd: string, ...args: string[]) => gitOut(root, cwd, args);

/** t5703's `test_oid numeric` (SHA-1): an id the server does not have. */
const NUMERIC = "0123456789012345678901234567890123456789";

/** sed's `s/<from>/<to>/`: the first match on each line. */
function sedOnce(text: string, from: string, to: string): string {
  return text
    .split("\n")
    .map((line) => {
      const at = line.indexOf(from);
      return at < 0 ? line : line.slice(0, at) + to + line.slice(at + from.length);
    })
    .join("\n");
}

/** test_commit's file and commit, the tag left out (t5703 deletes it). */
function commit(repo: string, name: string): void {
  putFile(repo, `${name}.t`, `${name}\n`);
  git(repo, "add", `${name}.t`);
  git(repo, "commit", "-q", "-m", name);
}

/** What a fetch left: refs, FETCH_HEAD, shallow commits and objects. */
function stateOf(repo: string) {
  const file = (name: string) =>
    existsSync(join(repo, ".git", name)) ? readFileSync(join(repo, ".git", name), "latin1") : "";
  return {
    refs: git(repo, "for-each-ref", "--format=%(refname) %(objectname) %(symref)"),
    fetchHead: file("FETCH_HEAD"),
    shallow: file("shallow"),
    objects: git(repo, "rev-list", "--all", "--objects").split("\n").filter(Boolean).sort(),
  };
}

describeGit("a want-ref whose ref moves between ls-refs and fetch, as native git", () => {
  let server: LoopbackServer;
  let closeBackend: () => void;
  /** The substitution the next response gets, once (t5703's one-time-script) */
  let oneTime: { from: string; to: string } | undefined;
  let pristine: string;
  let shallowPristine: string;
  const repo = () => join(srv, "repo");

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "want-ref-moved-"));
    srv = join(root, "srv");
    const backend = nativeGitHttpBackend(srv, root);
    closeBackend = () => backend.close();
    server = await serveOnLoopback(async (request) => {
      const response = await backend.fetch(request);
      const script = oneTime;
      if (!script) return response;
      const bytes = new Uint8Array(await response.arrayBuffer());
      const text = new TextDecoder("latin1").decode(bytes);
      const modified = sedOnce(text, script.from, script.to);
      if (modified === text) {
        return new Response(bytes, { status: response.status, headers: response.headers });
      }
      oneTime = undefined;
      const out = Uint8Array.from(modified, (c) => c.charCodeAt(0));
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      return new Response(out, { status: response.status, headers });
    });

    // t5703-upload-pack-ref-in-want.sh: "setup repos for change-while-negotiating test"
    git(root, "init", "-q", "-b", "main", repo());
    commit(repo(), "m1");
    pristine = join(root, "local_pristine");
    shallowPristine = join(root, "local_pristine_shallow");
    // clones through the in-process server: never a blocking spawn
    const cloned = await gitAsync(root, root, ["clone", "-q", `${server.baseUrl}/repo`, pristine]);
    expect(cloned.status, cloned.stderr).toBe(0);
    // the --deepen variant's: the same history, cut at m1
    const cut = await gitAsync(root, root, [
      "clone",
      "-q",
      "--depth",
      "1",
      `${server.baseUrl}/repo`,
      shallowPristine,
    ]);
    expect(cut.status, cut.stderr).toBe(0);
    for (const local of [pristine, shallowPristine]) {
      // a local repository with many commits (negotiation takes more than one round)
      git(local, "checkout", "-q", "-b", "side");
      for (let i = 1; i <= 33; i++) commit(local, `s${i}`);
      git(local, "checkout", "-q", "main");
      git(local, "config", "protocol.version", "2");
    }
    // novel commits upstream
    commit(repo(), "m2");
    commit(repo(), "m3");
  });

  afterAll(async () => {
    await server?.close();
    closeBackend?.();
    await removeTempDir(root);
  }, CLEANUP_TIMEOUT);

  /** t5703's `inconsistency`: ls-refs first reports `rev` as `ref`. */
  const inconsistency = (ref: string, rev: string) => ({
    from: git(repo(), "rev-parse", ref).trim(),
    to: rev === NUMERIC ? NUMERIC : git(repo(), "rev-parse", rev).trim(),
  });

  /** One fetch by native git and one by ours, each from a fresh copy of `source`. */
  async function twins(
    source: string,
    script: () => { from: string; to: string },
    args: string[] = [],
  ) {
    const n = counter++;
    const native = join(root, `native-${n}`);
    const mine = join(root, `ours-${n}`);
    cpSync(source, native, { recursive: true });
    cpSync(source, mine, { recursive: true });

    oneTime = script();
    const theirs = await gitAsync(root, native, ["fetch", ...args]);
    expect(oneTime, "the native fetch saw the rewritten response").toBeUndefined();

    oneTime = script();
    const ours = await openOurs(
      root,
      createNodeGitHostEnvironment({ env: testEnv(root) }),
      undefined,
      mine.slice(root.length + 1),
    );
    const fetch = ours.fetch();
    const deepen = args.find((a) => a.startsWith("--deepen="));
    if (deepen) fetch.setDeepen(Number(deepen.slice("--deepen=".length)));
    let error: unknown;
    try {
      await fetch.call();
    } catch (e) {
      error = e;
    }
    expect(oneTime, "our fetch saw the rewritten response").toBeUndefined();
    oneTime = undefined;
    return { theirs, error, native, mine };
  }

  for (const [title, ref] of [
    [`t5703-upload-pack-ref-in-want.sh: "server is initially ahead - ref in want"`, NUMERIC],
    [`t5703-upload-pack-ref-in-want.sh: "server is initially behind - ref in want"`, "main^"],
  ] as const) {
    it(title, async () => {
      git(repo(), "config", "uploadpack.allowRefInWant", "true");
      const { theirs, error, native, mine } = await twins(pristine, () =>
        inconsistency("main", ref),
      );
      expect(theirs.status, theirs.stderr).toBe(0);
      expect(error).toBeUndefined();
      // the id the server sent, not the one ls-refs listed
      expect(git(mine, "rev-parse", "refs/remotes/origin/main")).toBe(
        git(repo(), "rev-parse", "main"),
      );
      expect(stateOf(mine)).toEqual(stateOf(native));
    });
  }

  it(`t5703-upload-pack-ref-in-want.sh: "server is initially ahead - ref in want" (--deepen=1)`, async () => {
    git(repo(), "config", "uploadpack.allowRefInWant", "true");
    const { theirs, error, native, mine } = await twins(
      shallowPristine,
      () => inconsistency("main", NUMERIC),
      ["--deepen=1"],
    );
    // released git's upload-pack (2.43 to 2.56) writes `wanted-refs` before `shallow-info`,
    // where its own fetch-pack expects them the other way round: a deepening want-ref fetch
    // dies there, moved ref or not (git master sends shallow-info first, and succeeds)
    if (theirs.status !== 0) {
      expect(theirs.stderr).toContain("fatal: expected 'packfile', received 'shallow-info'");
    }
    expect(error).toBeUndefined();
    expect(git(mine, "rev-parse", "refs/remotes/origin/main")).toBe(
      git(repo(), "rev-parse", "main"),
    );
    // what the fetch should leave: native git's deepening fetch of main as the server has it
    // (no want-ref, no rewrite)
    git(repo(), "config", "uploadpack.allowRefInWant", "false");
    const oracle = join(root, `oracle-${counter++}`);
    cpSync(shallowPristine, oracle, { recursive: true });
    const r = await gitAsync(root, oracle, ["fetch", "--deepen=1"]);
    expect(r.status, r.stderr).toBe(0);
    expect(stateOf(mine)).toEqual(stateOf(oracle));
    if (theirs.status === 0) expect(stateOf(mine)).toEqual(stateOf(native));
  });

  it(`t5703-upload-pack-ref-in-want.sh: "server loses a ref - ref in want"`, async () => {
    git(repo(), "config", "uploadpack.allowRefInWant", "true");
    const before = stateOf(pristine);
    const { theirs, error, native, mine } = await twins(pristine, () => ({
      from: "main",
      to: "rain",
    }));
    expect(theirs.status).toBe(128);
    const fatal = theirs.stderr.split("\n").filter((l) => l.startsWith("fatal: remote error: "));
    expect(fatal).toEqual(["fatal: remote error: unknown ref refs/heads/rain"]);
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).toContain("unknown ref refs/heads/rain");
    // nothing written by either
    expect(stateOf(native).refs).toBe(before.refs);
    expect(stateOf(mine)).toEqual(stateOf(native));
  });

  it(`t5703-upload-pack-ref-in-want.sh: "server is initially ahead - no ref in want"`, async () => {
    git(repo(), "config", "uploadpack.allowRefInWant", "false");
    const { theirs, error, native, mine } = await twins(pristine, () =>
      inconsistency("main", NUMERIC),
    );
    expect(theirs.status).toBe(128);
    const fatal = theirs.stderr.split("\n").filter((l) => l.startsWith("fatal: remote error: "));
    // 2.43 names the id (`not our ref <id>`), t5703 greps the words alone
    expect(fatal).toHaveLength(1);
    expect(fatal[0]).toMatch(/^fatal: remote error: upload-pack: not our ref/);
    expect(String((error as Error | undefined)?.message)).toContain(
      (fatal[0] as string).slice("fatal: remote error: ".length),
    );
    expect(stateOf(mine)).toEqual(stateOf(native));
  });

  it(`t5703-upload-pack-ref-in-want.sh: "server is initially behind - no ref in want"`, async () => {
    git(repo(), "config", "uploadpack.allowRefInWant", "false");
    const { theirs, error, native, mine } = await twins(pristine, () =>
      inconsistency("main", "main^"),
    );
    expect(theirs.status, theirs.stderr).toBe(0);
    expect(error).toBeUndefined();
    // the id ls-refs listed: no want-ref, the want is that id
    expect(git(mine, "rev-parse", "refs/remotes/origin/main")).toBe(
      git(repo(), "rev-parse", "main^"),
    );
    expect(stateOf(mine)).toEqual(stateOf(native));
  });
});
