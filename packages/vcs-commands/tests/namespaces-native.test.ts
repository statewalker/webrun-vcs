/**
 * Ref namespaces (`GIT_NAMESPACE`, `git --namespace`) on the serving side, against native git
 * (2.43 and 2.5x): t5509-fetch-push-namespaces.sh.
 *
 * Each scenario runs the same native client twice: against native upload-pack/receive-pack
 * in a namespace (`ext::git --namespace=<ns> %s <dir>`, as t5509's remotes) and against our
 * git:// server serving a copy of the repository with `settings.namespace`. git decides what
 * the client sees (ls-remote, clone, fetch) and what lands in the served repository.
 */
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  createBasePathResolver,
  createServedFetchHandler,
  type GitServeOptions,
  serveGitConnection,
} from "@statewalker/vcs-transport";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openLocalRemote, remoteHookSession } from "../src/commands/local-transport.js";
import { type Git, servedRepositoryOf } from "../src/index.js";
import { type LoopbackServer, serveOnLoopback } from "./http-loopback-support.js";
import { openOurs } from "./merge-native-helpers.js";
import { gitAsync, startTcpServer } from "./native-connect-support.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { gitOut, testEnv } from "./status-native-support.js";
import { CLEANUP_TIMEOUT, removeTempDir } from "./temp-dir-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root: string;
let srv: string;
let original: string;
let port: number;
let closeServer: () => Promise<void>;
let http: LoopbackServer;
let counter = 0;
let commit0: string;
let commit1: string;
const git = (cwd: string, ...args: string[]) => gitOut(root, cwd, args);
const EXT = ["-c", "protocol.ext.allow=always"];

/**
 * Whether native git is 2.45 or later: before, receive-pack and upload-pack matched hidden
 * ref patterns against the full names of packed refs (the namespace's prefix unstripped),
 * which t5509's `pack-refs --all` cases check; ours follows 2.45+
 */
function nativeIs245(): boolean {
  const m = /git version (\d+)\.(\d+)/.exec(gitOut(tmpdir(), tmpdir(), ["--version"]));
  return m ? Number(m[1]) > 2 || (Number(m[1]) === 2 && Number(m[2]) >= 45) : false;
}

type Side = "native" | "ours" | "http";

/** One served repository, once per server: native git's copy, ours over git:// and HTTP. */
type Twin = Record<Side, string>;

/** Copies of the repository at `dir` in `srv`, one for each server. */
function twin(dir: string): Twin {
  const name = `${basename(dir)}-${counter++}`;
  const copy = (side: Side) => {
    const at = join(srv, `${name}-${side}`);
    cpSync(dir, at, { recursive: true });
    return at;
  };
  return { native: copy("native"), ours: copy("ours"), http: copy("http") };
}

/**
 * The URL of the repository in namespace `ns` (none when undefined): native git's `ext::`
 * remote (t5509's `pushee-namespaced`), or our git:// server, which reads the namespace from
 * the path's first segment (`-` for none)
 */
function urlOf(dir: string, ns: string | undefined, side: Side): string {
  if (side === "native") {
    return ns === undefined ? dir : `ext::git --namespace=${ns} %s ${dir}`;
  }
  if (side === "http") return `${http.baseUrl}/${ns ?? "-"}/${basename(dir)}`;
  return `git://127.0.0.1:${port}/${ns ?? "-"}/${basename(dir)}`;
}

/**
 * Runs native git against each server of `pair` (`run` gets the side's served directory and
 * name); `http` adds our smart-HTTP server (otherwise its result is native's)
 */
async function bothSides<T>(
  pair: Twin,
  run: (dir: string, side: Side) => Promise<T>,
  overHttp = false,
): Promise<Record<Side, T>> {
  const native = await run(pair.native, "native");
  const ours = await run(pair.ours, "ours");
  return { native, ours, http: overHttp ? await run(pair.http, "http") : native };
}

/** The refs of the repository at `dir`, as `git for-each-ref` lists them. */
function refsOf(dir: string): string {
  return git(dir, "for-each-ref", "--format=%(objectname) %(objecttype)\t%(refname)");
}

/** A bare repository holding `original`'s commits as t5509's pushee has them after its pushes. */
function pushedPushee(): string {
  const dir = join(root, `pushee-${counter++}`);
  git(root, "init", "-q", "--bare", "-b", "main", dir);
  // a local push starts receive-pack with local_repo_env cleared (GIT_CONFIG_COUNT too), so
  // its detached auto maintenance would change objects/ while twin() copies the repository
  for (const [key, value] of [
    ["receive.autogc", "false"],
    ["maintenance.auto", "false"],
    ["gc.auto", "0"],
  ]) {
    git(dir, "config", key, value);
  }
  git(original, "push", "-q", dir, "main:refs/namespaces/namespace/refs/heads/main");
  git(original, "push", "-q", dir, "refs/tags/*:refs/namespaces/namespace/refs/tags/*");
  return dir;
}

describeGit("ref namespaces against native git (t5509)", () => {
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "namespaces-native-"));
    srv = join(root, "srv");
    mkdirSync(srv);
    original = join(root, "original");
    git(root, "init", "-q", "-b", "main", original);
    for (const n of ["0", "1"]) {
      writeFileSync(join(original, "count"), `${n}\n`);
      git(original, "add", "count");
      git(original, "commit", "-q", "-m", n);
      git(original, "tag", n);
    }
    commit0 = git(original, "rev-parse", "HEAD^").trim();
    commit1 = git(original, "rev-parse", "HEAD").trim();

    const env = testEnv(root);
    git(srv, "init", "-q", "-b", "main", "host");
    const host: Git = await openOurs(srv, createNodeGitHostEnvironment({ env }), undefined, "host");
    const base = createBasePathResolver({
      files: createNodeFilesApi({ rootDir: srv }),
      exportAll: true,
      openRepository: async (gitDir) => {
        const opened = await openLocalRemote(host.workingCopy, `..${gitDir}`).catch(
          () => undefined,
        );
        if (!opened) return undefined;
        return servedRepositoryOf(opened, { hooks: remoteHookSession(host.workingCopy, opened) });
      },
    });
    // `/<ns>/<repo>`: the namespace the resolver serves the repository in (`-`: none)
    const resolveRepository: GitServeOptions["resolveRepository"] = async (path, request) => {
      const [, ns, repo] = path.split("/");
      const served = await base(`/${repo}`, request);
      if (!served || ns === "-" || ns === undefined) return served;
      return { ...served, settings: { ...served.settings, namespace: ns } };
    };
    http = await serveOnLoopback(
      createServedFetchHandler({ resolveRepository, enableReceivePack: true }),
    );
    const server = await startTcpServer((duplex) =>
      serveGitConnection({ duplex, resolveRepository, enableReceivePack: true }),
    );
    port = server.port;
    closeServer = server.close;
  });

  afterAll(async () => {
    await closeServer?.();
    await http?.close();
    if (root) await removeTempDir(root);
  }, CLEANUP_TIMEOUT);

  it('t5509-fetch-push-namespaces.sh: "pushing into a repository using a ref namespace"', async () => {
    const empty = join(root, `empty-${counter++}`);
    git(root, "init", "-q", "--bare", "-b", "main", empty);
    const pair = twin(empty);
    const runs = await bothSides(
      pair,
      async (dir, side) => {
        const url = urlOf(dir, "namespace", side);
        const out: string[] = [];
        const push = await gitAsync(root, original, [...EXT, "push", url, "main"]);
        out.push(`push ${push.status}`);
        for (const version of ["0", "2"]) {
          const ls = await gitAsync(root, original, [
            ...EXT,
            "-c",
            `protocol.version=${version}`,
            "ls-remote",
            url,
          ]);
          out.push(ls.stdout);
        }
        const tags = await gitAsync(root, original, [...EXT, "push", url, "--tags"]);
        out.push(`push --tags ${tags.status}`);
        for (const version of ["0", "2"]) {
          for (const ns of ["namespace", "garbage", undefined]) {
            const ls = await gitAsync(root, original, [
              ...EXT,
              "-c",
              `protocol.version=${version}`,
              "ls-remote",
              urlOf(dir, ns, side),
            ]);
            out.push(`${ns}: ${ls.status}\n${ls.stdout}`);
          }
        }
        return { out, refs: refsOf(dir) };
      },
      true,
    );
    expect(runs.ours).toEqual(runs.native);
    expect(runs.http).toEqual(runs.native);
    // t5509's expectations, to make sure the twins test something
    expect(runs.native.out[1]).toBe(`${commit1}\trefs/heads/main\n`);
    expect(runs.native.refs).toBe(
      [
        `${commit1} commit\trefs/namespaces/namespace/refs/heads/main`,
        `${commit0} commit\trefs/namespaces/namespace/refs/tags/0`,
        `${commit1} commit\trefs/namespaces/namespace/refs/tags/1`,
        "",
      ].join("\n"),
    );
  });

  it('t5509-fetch-push-namespaces.sh: "pulling from a repository using a ref namespace"', async () => {
    const pair = twin(pushedPushee());
    const runs = await bothSides(pair, async (dir, side) => {
      const out: string[] = [];
      for (const version of ["0", "2"]) {
        const puller = join(root, `puller-${counter++}`);
        git(root, "init", "-q", "-b", "main", puller);
        const url = urlOf(dir, "namespace", side);
        git(puller, "remote", "add", "pushee-namespaced", url);
        const r = await gitAsync(root, puller, [
          ...EXT,
          "-c",
          `protocol.version=${version}`,
          "fetch",
          "-q",
          "pushee-namespaced",
        ]);
        out.push(`${r.status}\n${refsOf(puller)}`);
      }
      return out;
    });
    expect(runs.ours).toEqual(runs.native);
    expect(runs.native[0]).toContain(`${commit1} commit\trefs/remotes/pushee-namespaced/main`);
  });

  /** ls-remote of the namespace with `hideRefs` set in the served repository, v0 and v2. */
  async function lsRemoteHidden(hideRefs: string, packRefs = false) {
    const compare = !packRefs || nativeIs245();
    const pair = twin(pushedPushee());
    for (const dir of [pair.native, pair.ours]) {
      if (packRefs) git(dir, "pack-refs", "--all");
      git(dir, "config", "transfer.hideRefs", hideRefs);
    }
    const runs = await bothSides(pair, async (dir, side) => {
      const out: string[] = [];
      for (const version of ["0", "2"]) {
        const ls = await gitAsync(root, original, [
          ...EXT,
          "-c",
          `protocol.version=${version}`,
          "ls-remote",
          urlOf(dir, "namespace", side),
        ]);
        out.push(`${ls.status}\n${ls.stdout}`);
      }
      return out;
    });
    if (compare) expect(runs.ours).toEqual(runs.native);
    return runs;
  }

  it('t5509-fetch-push-namespaces.sh: "hide namespaced refs with transfer.hideRefs"', async () => {
    const { native } = await lsRemoteHidden("refs/tags");
    expect(native[0]).toBe(`0\n${commit1}\trefs/heads/main\n`);
  });

  it('t5509-fetch-push-namespaces.sh: "check that transfer.hideRefs does not match unstripped refs"', async () => {
    const { ours } = await lsRemoteHidden("refs/namespaces/namespace/refs/tags", true);
    expect(ours[0]).toContain("refs/tags/1");
    expect(ours[1]).toContain("refs/tags/1");
  });

  it('t5509-fetch-push-namespaces.sh: "hide full refs with transfer.hideRefs"', async () => {
    const { native } = await lsRemoteHidden("^refs/namespaces/namespace/refs/tags");
    expect(native[0]).toBe(`0\n${commit1}\trefs/heads/main\n`);
  });

  /** A push of `main` into the namespace with `hideRefs` set in the served repository. */
  async function pushHidden(hideRefs: string, prepare?: (dir: string) => void) {
    const pair = twin(pushedPushee());
    for (const dir of [pair.native, pair.ours]) {
      prepare?.(dir);
      git(dir, "config", "transfer.hideRefs", hideRefs);
    }
    const runs = await bothSides(pair, async (dir, side) => {
      const trace = join(root, `trace-${counter++}`);
      const r = await gitAsync(
        root,
        original,
        [...EXT, "push", urlOf(dir, "namespace", side), "main"],
        { GIT_TRACE_PACKET: trace },
      );
      const lines = r.stderr.split("\n").filter((l) => /^ ! |up-to-date/.test(l));
      const traced = readFileSync(trace, "latin1");
      return { status: r.status, lines, refs: refsOf(dir), traced };
    });
    const strip = ({ traced: _, ...rest }: typeof runs.native) => rest;
    expect(strip(runs.ours)).toEqual(strip(runs.native));
    return runs;
  }

  it('t5509-fetch-push-namespaces.sh: "try to update a hidden ref"', async () => {
    const runs = await pushHidden("refs/heads/main");
    expect(runs.native.status).not.toBe(0);
    expect(runs.native.lines.join("\n")).toContain("deny updating a hidden ref");
  });

  it('t5509-fetch-push-namespaces.sh: "try to update a ref that is not hidden"', async () => {
    const runs = await pushHidden("refs/namespaces/namespace/refs/heads/main");
    expect(runs.native.status).toBe(0);
  });

  it('t5509-fetch-push-namespaces.sh: "git-receive-pack(1) with transfer.hideRefs does not match unstripped refs during advertisement"', async () => {
    const runs = await pushHidden("refs/namespaces/namespace/refs/heads/foo", (dir) => {
      git(dir, "update-ref", "refs/namespaces/namespace/refs/heads/foo/1", commit1);
      git(dir, "pack-refs", "--all");
    });
    // git 2.43 hides the packed ref (it matched the unstripped name)
    if (nativeIs245()) expect(runs.native.traced).toContain("refs/heads/foo/1");
    expect(runs.ours.traced).toContain("refs/heads/foo/1");
  });

  it('t5509-fetch-push-namespaces.sh: "try to update a hidden full ref"', async () => {
    const runs = await pushHidden("^refs/namespaces/namespace/refs/heads/main");
    expect(runs.native.status).not.toBe(0);
  });

  it('t5509-fetch-push-namespaces.sh: "clone chooses correct HEAD (v0)", "clone chooses correct HEAD (v2)"', async () => {
    const ambiguous = join(root, `ambiguous-${counter++}`);
    git(root, "init", "-q", "-b", "main", ambiguous);
    git(ambiguous, "commit", "-q", "--allow-empty", "-m", "foo");
    git(ambiguous, "update-ref", "refs/namespaces/ns/refs/heads/one", "HEAD");
    git(ambiguous, "update-ref", "refs/namespaces/ns/refs/heads/two", "HEAD");
    git(ambiguous, "symbolic-ref", "refs/namespaces/ns/HEAD", "refs/namespaces/ns/refs/heads/two");
    const pair = twin(ambiguous);
    const runs = await bothSides(
      pair,
      async (dir, side) => {
        const out: string[] = [];
        for (const version of ["0", "2"]) {
          const clone = join(root, `clone-${counter++}`);
          const r = await gitAsync(root, root, [
            ...EXT,
            "-c",
            `protocol.version=${version}`,
            "clone",
            "-q",
            urlOf(dir, "ns", side),
            clone,
          ]);
          out.push(`${r.status} ${git(clone, "symbolic-ref", "HEAD").trim()}\n${refsOf(clone)}`);
        }
        return out;
      },
      true,
    );
    expect(runs.ours).toEqual(runs.native);
    expect(runs.http).toEqual(runs.native);
    expect(runs.native[0]).toMatch(/^0 refs\/heads\/two\n/);
    expect(runs.native[1]).toMatch(/^0 refs\/heads\/two\n/);
  });

  // not from t5509: a namespace's client asking, by id, for a commit only another namespace
  // reaches, under uploadpack.allowTipSHA1InWant + allowReachableSHA1InWant (v0): git counts
  // only the namespace's own tips
  it("a want reachable only from another namespace is not ours (v0 reachable tips)", async () => {
    const dir = pushedPushee();
    const other = join(root, `other-${counter++}`);
    git(root, "init", "-q", "-b", "main", other);
    writeFileSync(join(other, "secret"), "x\n");
    git(other, "add", "secret");
    git(other, "commit", "-q", "-m", "secret");
    const secret = git(other, "rev-parse", "HEAD").trim();
    git(other, "push", "-q", dir, "main:refs/namespaces/b/refs/heads/main");
    for (const key of ["allowTipSHA1InWant", "allowReachableSHA1InWant"]) {
      git(dir, "config", `uploadpack.${key}`, "true");
    }
    const pair = twin(dir);
    const runs = await bothSides(pair, async (served, side) => {
      const out: string[] = [];
      for (const want of [commit0, secret]) {
        const client = join(root, `client-${counter++}`);
        git(root, "init", "-q", "-b", "main", client);
        const r = await gitAsync(root, client, [
          ...EXT,
          "-c",
          "protocol.version=0",
          "fetch",
          "-q",
          urlOf(served, "namespace", side),
          want,
        ]);
        out.push(`${r.status === 0} ${/not our ref/.test(r.stderr)}`);
      }
      return out;
    });
    expect(runs.ours).toEqual(runs.native);
    expect(runs.native).toEqual(["true false", "false true"]);
  });

  it('t5509-fetch-push-namespaces.sh: "denyCurrentBranch and unborn branch with ref namespace"', async () => {
    const unborn = join(root, `unborn-${counter++}`);
    git(root, "init", "-q", "-b", "main", unborn);
    const pair = twin(unborn);
    const runs = await bothSides(pair, async (dir, side) => {
      const url = urlOf(dir, "namespace", side);
      const refused = await gitAsync(root, original, [...EXT, "push", url, "HEAD:main"]);
      git(dir, "config", "receive.denyCurrentBranch", "updateInstead");
      const pushed = await gitAsync(root, original, [...EXT, "push", url, "HEAD:main"]);
      return {
        statuses: [refused.status, pushed.status],
        refused: refused.stderr.split("\n").filter((l) => /^ ! /.test(l)),
        refs: refsOf(dir),
        head: git(dir, "symbolic-ref", "HEAD").trim(),
        files: readdirSync(dir).sort(),
      };
    });
    expect(runs.ours).toEqual(runs.native);
    expect(runs.native.statuses).toEqual([1, 0]);
  });
});
