/**
 * Serving a shallow repository, against native git (2.43 and 2.5x): upload-pack advertises
 * the repository's own shallow commits after its refs (v0, git's advertise_shallow_grafts),
 * answers a v2 fetch that deepens nothing with the shallow commits it reaches
 * (send_shallow_info's deepen(INFINITE_DEPTH)), counts depths and `--unshallow` against its
 * own boundary (get_shallow_commits stops at a graft without parents) and cuts every pack
 * there; the client records a shallow server's commits on clone (fetch-pack's
 * update_shallow), and on a plain fetch rejects the refs that would need them unless
 * `--update-shallow`. A local clone of a shallow source fetches instead, with git's
 * warnings.
 *
 * Native clients clone from native `git http-backend` and from our served handler over a
 * loopback port; our client clones from native `git daemon` and `git http-backend`, and from
 * a local path (our upload-pack in process); each result is compared with native git's.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createBasePathResolver,
  createDefaultTransports,
  createServedFetchHandler,
} from "@statewalker/vcs-transport";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openLocalRemote } from "../src/commands/local-transport.js";
import { type Git, servedRepositoryOf } from "../src/index.js";
import { type LoopbackServer, serveOnLoopback } from "./http-loopback-support.js";
import { openOurs } from "./merge-native-helpers.js";
import { daemonOpener, gitAsync } from "./native-connect-support.js";
import { nativeGitAvailable, nativeGitHttpBackend } from "./native-git-http-backend.js";
import { gitOut, gitRun, putFile, testEnv } from "./status-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root: string;
let srv: string;
let counter = 0;
const git = (cwd: string, ...args: string[]) => gitOut(root, cwd, args);

/** What a clone left: its shallow file, refs and objects (sorted). */
function stateOf(repo: string) {
  const gitDir = existsSync(join(repo, ".git")) ? join(repo, ".git") : repo;
  const shallowPath = join(gitDir, "shallow");
  return {
    shallow: existsSync(shallowPath)
      ? readFileSync(shallowPath, "utf8").split("\n").filter(Boolean).sort()
      : [],
    refs: git(repo, "for-each-ref", "--format=%(refname) %(objectname) %(symref)"),
    objects: git(repo, "rev-list", "--all", "--objects").split("\n").filter(Boolean).sort(),
  };
}

/** An empty repository for our side, its `protocol.version` set. */
async function oursAt(name: string, version: "0" | "2"): Promise<{ dir: string; ours: Git }> {
  const dir = join(root, `${name}-${counter++}`);
  git(root, "init", "-q", "-b", "main", dir);
  git(dir, "config", "protocol.version", version);
  const ours = await openOurs(
    root,
    createNodeGitHostEnvironment({ env: testEnv(root) }),
    undefined,
    dir.slice(root.length + 1),
  );
  return { dir, ours };
}

describeGit("serving a shallow repository, as native git", () => {
  let nativeHttp: { server: LoopbackServer; close(): Promise<void> };
  let ourHttp: LoopbackServer;
  let host: Git;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "serve-shallow-"));
    srv = join(root, "srv");
    mkdirSync(srv);
    const full = join(root, "full");
    git(root, "init", "-q", "-b", "main", full);
    for (const n of [1, 2, 3, 4, 5]) {
      putFile(full, "f.txt", `${n}\n`);
      git(full, "add", "f.txt");
      gitOut(root, full, ["commit", "-qm", `c${n}`], {
        GIT_AUTHOR_DATE: `170000000${n} +0000`,
        GIT_COMMITTER_DATE: `170000000${n} +0000`,
      });
    }
    git(full, "tag", "-a", "v1", "-m", "v1", "HEAD~3");
    git(full, "branch", "side", "HEAD~1");
    // shallow at c3 (side's depth) and c1 (v1's): a server with two shallow commits
    git(
      root,
      "clone",
      "-q",
      "--no-local",
      "--depth",
      "2",
      "--no-single-branch",
      full,
      join(srv, "shal"),
    );
    git(join(srv, "shal"), "config", "uploadpack.allowfilter", "false");
    git(root, "init", "-q", join(srv, "host"));

    const backend = nativeGitHttpBackend(srv, root);
    const server = await serveOnLoopback((request) => backend.fetch(request));
    nativeHttp = {
      server,
      close: async () => {
        await server.close();
        backend.close();
      },
    };
    host = await openOurs(
      srv,
      createNodeGitHostEnvironment({ env: testEnv(root) }),
      undefined,
      "host",
    );
    ourHttp = await serveOnLoopback(
      createServedFetchHandler({
        resolveRepository: createBasePathResolver({
          files: createNodeFilesApi({ rootDir: srv }),
          exportAll: true,
          openRepository: async (gitDir) => {
            const opened = await openLocalRemote(host.workingCopy, `..${gitDir}`).catch(
              () => undefined,
            );
            return opened ? servedRepositoryOf(opened) : undefined;
          },
        }),
      }),
    );
  });

  afterAll(async () => {
    await nativeHttp?.close();
    await ourHttp?.close();
    rmSync(root, { recursive: true, force: true });
  });

  const variants: Array<{ name: string; args: string[] }> = [
    { name: "plain", args: [] },
    { name: "--depth 1", args: ["--depth", "1"] },
    { name: "--depth 3", args: ["--depth", "3"] },
    { name: "--shallow-since inside", args: ["--shallow-since=1700000004"] },
    { name: "--shallow-since beyond (git fails)", args: ["--shallow-since=1700000002"] },
    { name: "--shallow-exclude inside", args: ["--shallow-exclude=origin/side"] },
    { name: "--shallow-exclude beyond (git fails)", args: ["--shallow-exclude=v1"] },
  ];

  for (const version of ["0", "2"] as const) {
    for (const variant of variants) {
      it(`native clone (v${version}) ${variant.name}: our server answers as http-backend`, async () => {
        const n = counter++;
        const clone = async (server: LoopbackServer, name: string) => {
          const dest = join(root, `${name}-${n}`);
          const r = await gitAsync(root, root, [
            "-c",
            `protocol.version=${version}`,
            "clone",
            "-q",
            ...variant.args,
            `${server.baseUrl}/shal`,
            dest,
          ]);
          return { r, dest };
        };
        const theirs = await clone(nativeHttp.server, "nc-native");
        const mine = await clone(ourHttp, "nc-ours");
        expect(mine.r.status, mine.r.stderr).toBe(theirs.r.status);
        if (theirs.r.status === 0) {
          expect(stateOf(mine.dest)).toEqual(stateOf(theirs.dest));
          // --unshallow: deepened as far as the server's own shallow commits
          const unshallow = async (dest: string) =>
            gitAsync(root, dest, [
              "-c",
              `protocol.version=${version}`,
              "fetch",
              "-q",
              "--unshallow",
            ]);
          const [a, b] = [await unshallow(theirs.dest), await unshallow(mine.dest)];
          expect(b.status, b.stderr).toBe(a.status);
          expect(stateOf(mine.dest)).toEqual(stateOf(theirs.dest));
        } else {
          const fatal = (s: string) => s.split("\n").filter((l) => l.startsWith("fatal: "));
          expect(fatal(mine.r.stderr)).toEqual(fatal(theirs.r.stderr));
        }
      });
    }
  }

  for (const version of ["0", "2"] as const) {
    for (const via of ["daemon", "http"] as const) {
      for (const depth of [undefined, 1]) {
        it(`our clone (v${version}, ${via}${depth ? `, --depth ${depth}` : ""}) of a native shallow server`, async () => {
          const native = join(root, `oc-native-${counter++}`);
          const r = gitRun(root, root, [
            "-c",
            `protocol.version=${version}`,
            "clone",
            "-q",
            "--no-local",
            ...(depth ? ["--depth", String(depth)] : []),
            join(srv, "shal"),
            native,
          ]);
          expect(r.status, r.stderr).toBe(0);
          const { dir, ours } = await oursAt("oc-ours", version);
          const clone = ours.clone();
          if (via === "daemon") {
            clone
              .setURI("git://localhost/shal")
              .setTransports(createDefaultTransports({ openSocket: daemonOpener(root, srv) }));
          } else {
            clone.setURI(`${nativeHttp.server.baseUrl}/shal`);
          }
          if (depth) clone.setDepth(depth);
          await clone.call();
          expect(stateOf(dir)).toEqual(stateOf(native));
        });
      }
    }
  }

  for (const local of [undefined, true]) {
    it(`a local clone${local ? " --local" : ""} of a shallow source fetches, with git's warnings`, async () => {
      const native = join(root, `lc-native-${counter++}`);
      const r = gitRun(root, root, [
        "clone",
        "-q",
        ...(local ? ["--local"] : []),
        join(srv, "shal"),
        native,
      ]);
      expect(r.status, r.stderr).toBe(0);
      const { dir, ours } = await oursAt("lc-ours", "2");
      const clone = ours.clone().setURI(join(srv, "shal"));
      if (local) clone.setLocal(true);
      const result = await clone.call();
      const warnings = r.stderr
        .split("\n")
        .filter((l) => l.startsWith("warning: "))
        .map((l) => `${l}\n`);
      expect(result.messages ?? []).toEqual(warnings);
      expect(stateOf(dir)).toEqual(stateOf(native));
      expect(readFileSync(join(dir, ".git/packed-refs"), "utf8")).toBe(
        readFileSync(join(native, ".git/packed-refs"), "utf8"),
      );
    });
  }

  for (const version of ["0", "2"] as const) {
    for (const update of [false, true]) {
      it(`a fetch (v${version}) from a shallow repository into one without that history${update ? " --update-shallow" : ""}`, async () => {
        const native = join(root, `f-native-${counter++}`);
        git(root, "init", "-q", native);
        const args = [
          "-c",
          `protocol.version=${version}`,
          "fetch",
          ...(update ? ["--update-shallow"] : []),
          join(srv, "shal"),
          "main:refs/x",
          "refs/remotes/origin/side",
        ];
        const r = gitRun(root, native, args);
        expect(r.status, r.stderr).toBe(0);
        const { dir, ours } = await oursAt("f-ours", version);
        const fetch = ours
          .fetch()
          .setRemote(join(srv, "shal"))
          .setRefSpecs("main:refs/x", "refs/remotes/origin/side");
        if (update) fetch.setUpdateShallow(true);
        const result = await fetch.call();
        const warnings = r.stderr.split("\n").filter((l) => l.startsWith("warning: "));
        expect(warnings.length > 0).toBe(!update);
        expect(result.messages.filter((m) => m.startsWith("warning: "))).toEqual(warnings);
        // (git's --update-shallow writes the server's line once per shallow-info line: v2's
        // walk lists a shallow commit reached from two wants twice; ours keeps one)
        expect(stateOf(dir).shallow).toEqual([...new Set(stateOf(native).shallow)]);
        expect(stateOf(dir).refs).toBe(stateOf(native).refs);
        const fetchHead = (d: string) =>
          readFileSync(join(d, ".git/FETCH_HEAD"), "utf8").replaceAll(join(srv, "shal"), "<src>");
        expect(fetchHead(dir)).toBe(fetchHead(native));
      });
    }
  }

  for (const version of ["0", "2"] as const) {
    for (const update of [false, true]) {
      it(`a native fetch (v${version})${update ? " --update-shallow" : ""} from our server: the shallow file and warnings of http-backend's`, async () => {
        const n = counter++;
        const fetch = async (server: LoopbackServer, name: string) => {
          const dest = join(root, `${name}-${n}`);
          git(root, "init", "-q", dest);
          const r = await gitAsync(root, dest, [
            "-c",
            `protocol.version=${version}`,
            "fetch",
            ...(update ? ["--update-shallow"] : []),
            `${server.baseUrl}/shal`,
            "main:refs/x",
            "refs/remotes/origin/side:refs/y",
          ]);
          const shallowPath = join(dest, ".git/shallow");
          return {
            status: r.status,
            // (git 2.43 and 2.5x over smart HTTP v0: the advertised shallow commits do not
            // reach remote-curl's fetch-pack, whose connectivity check then fails)
            warnings: r.stderr
              .split("\n")
              .filter((l) => /^(warning|error|fatal): /.test(l))
              .map((l) => l.replaceAll(server.baseUrl, "<url>")),
            // byte for byte: git writes a server's line as often as it came
            shallow: existsSync(shallowPath) ? readFileSync(shallowPath, "utf8") : undefined,
            refs: git(dest, "for-each-ref", "--format=%(refname) %(objectname)"),
          };
        };
        const theirs = await fetch(nativeHttp.server, "nf-native");
        const mine = await fetch(ourHttp, "nf-ours");
        expect(mine).toEqual(theirs);
      });
    }
  }

  /** A shallow server `srv/<name>`: a `--depth 2` clone of full, `extra` commits added. */
  let shalSerial = 0;
  function shallowServer(extra: number): string {
    const name = `shal-x${shalSerial++}`;
    const dir = join(srv, name);
    git(root, "clone", "-q", "--no-local", "--depth", "2", join(root, "full"), dir);
    git(dir, "config", "uploadpack.allowfilter", "false");
    for (let k = 0; k < extra; k++) addCommit(dir, `x${k}`);
    return name;
  }
  function addCommit(dir: string, text: string) {
    putFile(dir, "g.txt", `${text}\n`);
    git(dir, "add", "g.txt");
    gitOut(root, dir, ["commit", "-qm", text], {
      GIT_AUTHOR_DATE: "1700000100 +0000",
      GIT_COMMITTER_DATE: "1700000100 +0000",
    });
  }
  /** A native clone `name-<n>` of `source` for our side to open. */
  async function oursCloneOf(name: string, source: string, version: "0" | "2") {
    const dir = join(root, `${name}-${counter++}`);
    git(root, "clone", "-q", "--no-local", source, dir);
    git(dir, "config", "protocol.version", version);
    const ours = await openOurs(
      root,
      createNodeGitHostEnvironment({ env: testEnv(root) }),
      undefined,
      dir.slice(root.length + 1),
    );
    return { dir, ours };
  }

  for (const version of ["0", "2"] as const) {
    it(`fetch --update-shallow (v${version}) into a complete clone records no shallow commit it has the history of`, async () => {
      const shal = join(srv, shallowServer(1));
      const native = join(root, `us-native-${counter++}`);
      git(root, "clone", "-q", "--no-local", join(root, "full"), native);
      const r = gitRun(root, native, [
        "-c",
        `protocol.version=${version}`,
        "fetch",
        "-q",
        "--update-shallow",
        shal,
        "main:refs/x",
      ]);
      expect(r.status, r.stderr).toBe(0);
      expect(existsSync(join(native, ".git/shallow"))).toBe(false);
      const { dir, ours } = await oursCloneOf("us-ours", join(root, "full"), version);
      await ours.fetch().setRemote(shal).setRefSpecs("main:refs/x").setUpdateShallow(true).call();
      expect(existsSync(join(dir, ".git/shallow"))).toBe(false);
      expect(stateOf(dir)).toEqual(stateOf(native));
      // the whole history stays reachable: c1..c5 and the server's new commit
      expect(git(dir, "rev-list", "--count", "refs/x").trim()).toBe("6");
      expect(gitRun(root, dir, ["fsck", "--no-dangling", "--no-progress"]).status).toBe(0);
    });

    it(`fetch --update-shallow (v${version}) into an unrelated repository records the shallow commits it needs`, async () => {
      const shal = join(srv, shallowServer(1));
      const unrelated = join(root, `unrelated-${counter++}`);
      git(root, "init", "-q", "-b", "main", unrelated);
      addCommit(unrelated, "own");
      const native = join(root, `uu-native-${counter++}`);
      git(root, "clone", "-q", "--no-local", unrelated, native);
      const r = gitRun(root, native, [
        "-c",
        `protocol.version=${version}`,
        "fetch",
        "-q",
        "--update-shallow",
        shal,
        "main:refs/x",
      ]);
      expect(r.status, r.stderr).toBe(0);
      const { dir, ours } = await oursCloneOf("uu-ours", unrelated, version);
      await ours.fetch().setRemote(shal).setRefSpecs("main:refs/x").setUpdateShallow(true).call();
      expect(stateOf(native).shallow.length).toBe(1);
      expect(stateOf(dir).shallow).toEqual([...new Set(stateOf(native).shallow)]);
      expect(stateOf(dir).refs).toBe(stateOf(native).refs);
      expect(stateOf(dir).objects).toEqual(stateOf(native).objects);
    });

    it(`a native shallow clone (v${version}) fetching without deepening from our shallow server keeps its shallow file, as http-backend`, async () => {
      const name = shallowServer(0);
      const n = counter++;
      const clone = async (server: LoopbackServer, label: string) => {
        const dest = join(root, `${label}-${n}`);
        const r = await gitAsync(root, root, [
          "-c",
          `protocol.version=${version}`,
          "clone",
          "-q",
          "--depth",
          "1",
          `${server.baseUrl}/${name}`,
          dest,
        ]);
        expect(r.status, r.stderr).toBe(0);
        return dest;
      };
      const theirs = await clone(nativeHttp.server, "nd-native");
      const mine = await clone(ourHttp, "nd-ours");
      const before = readFileSync(join(theirs, ".git/shallow"), "utf8");
      expect(readFileSync(join(mine, ".git/shallow"), "utf8")).toBe(before);
      addCommit(join(srv, name), "next");
      const fetch = async (server: LoopbackServer, dest: string) => {
        const r = await gitAsync(root, dest, [
          "-c",
          `protocol.version=${version}`,
          "fetch",
          "-q",
          `${server.baseUrl}/${name}`,
          "main:refs/x",
        ]);
        expect(r.status, r.stderr).toBe(0);
        return {
          shallow: readFileSync(join(dest, ".git/shallow"), "utf8"),
          count: git(dest, "rev-list", "--count", "refs/x").trim(),
          refs: git(dest, "for-each-ref", "--format=%(refname) %(objectname)"),
        };
      };
      const a = await fetch(nativeHttp.server, theirs);
      const b = await fetch(ourHttp, mine);
      expect(a.shallow).toBe(before);
      expect(b).toEqual(a);
    });
  }
});
