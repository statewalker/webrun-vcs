/**
 * receive-pack's quarantine against native git: `git push` over smart HTTP to our
 * receive-pack on the files backend (a bare repository on disk). A push the update hook or
 * pre-receive refuses leaves the server's objects as they were (`git count-objects -v`, the
 * files under `objects/`); an accepted push lands, and `git fsck --strict` on the server passes.
 * Pushes of a few objects (unpacked) and of a few hundred (kept as a pack) both.
 */

import { type ChildProcess, execFile, execFileSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createHistoryFromComponents } from "@statewalker/vcs-core";
import { createGitFilesBackend } from "@statewalker/vcs-store-files";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  createFetchHandler,
  createRepositoryFacade,
  type ReceivePackServerOptions,
  type RefStore,
  type RepositoryFacade,
} from "../../src/index.js";
import {
  cleanupDir,
  createTransportRefStore,
  gitAvailable,
  loopbackEnv,
  makeTmpDir,
} from "./helpers.js";
import { type LoopbackHttpServer, serveFetchHandler } from "./http-server.js";

const describeGit = gitAvailable() ? describe : describe.skip;

const GIT_ENV = {
  GIT_AUTHOR_NAME: "Interop Tester",
  GIT_AUTHOR_EMAIL: "interop@example.com",
  GIT_COMMITTER_NAME: "Interop Tester",
  GIT_COMMITTER_EMAIL: "interop@example.com",
  GIT_AUTHOR_DATE: "1112911993 +0000",
  GIT_COMMITTER_DATE: "1112911993 +0000",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};

const TEST_TIMEOUT = 60000;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    env: { ...loopbackEnv(), ...GIT_ENV },
    input: "",
    maxBuffer: 64 * 1024 * 1024,
  })
    .toString("utf8")
    .trim();
}

const children = new Set<ChildProcess>();

/** git without blocking the event loop: our server answers in this process. */
function gitAsync(cwd: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      "git",
      args,
      {
        cwd,
        env: { ...loopbackEnv(), ...GIT_ENV },
        timeout: 30000,
        killSignal: "SIGKILL",
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, _stdout, stderr) => {
        children.delete(child);
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ code, stderr });
      },
    );
    // git may close its stdin early: an EPIPE there is not a failure
    child.stdin?.on("error", () => {});
    children.add(child);
  });
}

/** `git count-objects -v` as numbers (count, in-pack, packs, ...). */
function countObjects(dir: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of git(dir, ["count-objects", "-v"]).split("\n")) {
    const [key, value] = line.split(": ");
    if (key && value !== undefined) out[key] = Number(value);
  }
  return out;
}

/** Every file under `objects/`, relative, sorted. */
function objectFiles(dir: string): string[] {
  return (readdirSync(join(dir, "objects"), { recursive: true }) as string[]).map(String).sort();
}

describeGit("Interop · native git push → our receive-pack (files backend): quarantine", () => {
  let root: string;
  let server: LoopbackHttpServer;
  let url: string;
  let target: { repository: RepositoryFacade; refStore: RefStore } | undefined;
  let options: ReceivePackServerOptions = {};
  const serverErrors: string[] = [];

  beforeAll(async () => {
    root = makeTmpDir("vcs-interop-quarantine-");
    const handler = (request: Request) =>
      createFetchHandler({
        resolveRepository: async (repoPath) => (repoPath === "/repo.git" ? (target ?? null) : null),
        receivePack: options,
        logger: {
          info: () => {},
          error: (message, error) => serverErrors.push(`${message}: ${String(error)}`),
        },
      })(request);
    server = await serveFetchHandler(handler);
    url = `${server.baseUrl}/repo.git`;
  });

  afterEach(() => {
    for (const child of children) child.kill("SIGKILL");
    children.clear();
    options = {};
  });

  afterAll(async () => {
    await server?.close();
    cleanupDir(root);
  });

  /**
   * A source repository (c1 ← c2 ← c3), a bare copy served through our receive-pack on the
   * files backend, and a clone of it with one more commit of `files` new files to push.
   */
  async function fresh(name: string, files: number) {
    const src = join(root, `${name}-src`);
    git(root, ["init", "-q", "--initial-branch=main", src]);
    for (let i = 1; i <= 3; i++) {
      writeFileSync(join(src, `f${i}.txt`), `${i}\n`);
      git(src, ["add", "."]);
      git(src, ["commit", "-q", "-m", `c${i}`]);
    }
    const bare = join(root, `${name}.git`);
    git(root, ["clone", "-q", "--bare", src, bare]);
    const backend = await createGitFilesBackend({
      files: createNodeFilesApi({ rootDir: bare }),
      gitDir: ".",
    });
    const history = createHistoryFromComponents({
      objects: backend.objects,
      refs: backend.history.refs,
      packs: backend.packs,
    });
    target = {
      repository: createRepositoryFacade({ history }),
      refStore: createTransportRefStore(history.refs),
    };
    const work = join(root, `${name}-work`);
    git(root, ["clone", "-q", bare, work]);
    for (let i = 0; i < files; i++) writeFileSync(join(work, `new-${i}.txt`), `new ${name} ${i}\n`);
    git(work, ["add", "."]);
    git(work, ["commit", "-q", "-m", "new"]);
    return {
      bare,
      work,
      tip: git(work, ["rev-parse", "HEAD"]),
      old: git(bare, ["rev-parse", "main"]),
    };
  }

  for (const files of [3, 300]) {
    const kind = files > 100 ? "a kept pack" : "unpacked objects";
    it(
      `the update hook refusing the push leaves the server's objects as they were (${kind})`,
      async () => {
        const { bare, work, old } = await fresh(`refused-${files}`, files);
        const countBefore = countObjects(bare);
        const filesBefore = objectFiles(bare);
        options = { hooks: { update: () => "locked!" } };
        const r = await gitAsync(work, ["push", url, "main:main"]);
        expect(r.code).not.toBe(0);
        expect(r.stderr).toContain("hook declined");
        expect(countObjects(bare)).toEqual(countBefore);
        expect(objectFiles(bare)).toEqual(filesBefore);
        expect(git(bare, ["rev-parse", "main"])).toBe(old);
        expect(serverErrors).toEqual([]);
      },
      TEST_TIMEOUT,
    );

    it(
      `an accepted push lands and git fsck --strict passes on the server (${kind})`,
      async () => {
        const { bare, work, tip } = await fresh(`accepted-${files}`, files);
        const countBefore = countObjects(bare);
        /** whether native git, reading the server repository, could not see the pushed tip */
        let quarantined: boolean | undefined;
        options = {
          hooks: {
            // the hook sees the pushed commit; native git reading the repository does not
            preReceive: async (_commands, ctx) => {
              try {
                execFileSync("git", ["cat-file", "-e", tip], {
                  cwd: bare,
                  env: { ...loopbackEnv(), ...GIT_ENV },
                  stdio: "ignore",
                });
                quarantined = false;
              } catch {
                quarantined = true;
              }
              expect(await ctx.repository.has(tip)).toBe(true);
            },
          },
        };
        const r = await gitAsync(work, ["push", url, "main:main"]);
        expect(r.code, r.stderr).toBe(0);
        expect(quarantined).toBe(true);
        expect(git(bare, ["rev-parse", "main"])).toBe(tip);
        const countAfter = countObjects(bare);
        expect((countAfter.count ?? 0) + (countAfter["in-pack"] ?? 0)).toBeGreaterThan(
          (countBefore.count ?? 0) + (countBefore["in-pack"] ?? 0),
        );
        expect(git(bare, ["fsck", "--strict"])).toBe("");
        expect(objectFiles(bare).some((f) => f.startsWith("tmp_objdir-"))).toBe(false);
        expect(serverErrors).toEqual([]);
      },
      TEST_TIMEOUT,
    );
  }
});
