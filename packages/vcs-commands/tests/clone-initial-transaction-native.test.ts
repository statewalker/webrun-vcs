/**
 * `git clone`'s initial ref transaction against native git (2.43 and 2.5x): the cloned
 * refs (remote-tracking refs, tags, a bare or mirror clone's heads) are written in one
 * initial transaction straight into packed-refs (builtin/clone.c write_remote_refs,
 * refs/files-backend.c files_transaction_finish_initial), the followed tags of a
 * single-branch clone loose one by one (write_followtags), then the remote HEAD and HEAD
 * with its branch loose. Each case compares packed-refs byte for byte, the loose refs and
 * the reference-transaction hook's log (2.43: `prepared`, `committed`; 2.5x: `preparing`,
 * `prepared`, then the packed store's `preparing`, `prepared`, never `committed`).
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitFilesBackend, openGitLinkedWorktrees } from "@statewalker/vcs-store-files";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
  createNodeHookRunner,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Git } from "../src/index.js";
import { nativeIs25x } from "./hooks-native-support.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { gitOut, gitRun, putFile, testEnv } from "./status-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

/** Logs the state and stdin; exits with `$HOOK_EXIT_<state>` when set. */
const HOOK = `#!/bin/sh
{ echo "== $1"; cat; } >> "$HOOK_LOG"
eval "code=\\\${HOOK_EXIT_$1:-0}"
exit "$code"
`;

let root: string;
let counter = 0;
const git = (cwd: string, ...args: string[]) => gitOut(root, cwd, args);

type Clone = ReturnType<Git["clone"]>;

/** packed-refs and every loose ref (path and content) below `gitDir`. */
function refFilesOf(gitDir: string): { packed?: string; loose: string[] } {
  const loose: string[] = [];
  const walk = (rel: string) => {
    for (const e of readdirSync(join(gitDir, rel), { withFileTypes: true })) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(r);
      else loose.push(`${r} ${readFileSync(join(gitDir, r), "utf8")}`);
    }
  };
  walk("refs");
  const packedPath = join(gitDir, "packed-refs");
  return {
    ...(existsSync(packedPath) ? { packed: readFileSync(packedPath, "utf8") } : {}),
    loose: loose.sort(),
  };
}

const readLog = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "");

describeGit("clone's initial ref transaction, as native git", () => {
  let src: string;
  let template: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "clone-initial-"));
    src = join(root, "src");
    git(root, "init", "-q", "-b", "main", src);
    for (const name of ["a", "b"]) {
      putFile(src, `${name}.txt`, `${name}\n`);
      git(src, "add", `${name}.txt`);
      git(src, "commit", "-qm", name);
    }
    git(src, "tag", "-a", "v1", "-m", "v1");
    git(src, "tag", "light", "HEAD~1");
    git(src, "checkout", "-q", "-b", "feat", "HEAD~1");
    putFile(src, "c.txt", "c\n");
    git(src, "add", "c.txt");
    git(src, "commit", "-qm", "c");
    git(src, "tag", "-a", "on-feat", "-m", "on feat");
    git(src, "checkout", "-q", "main");
    template = join(root, "template");
    mkdirSync(join(template, "hooks"), { recursive: true });
    writeFileSync(join(template, "hooks/reference-transaction"), HOOK);
    chmodSync(join(template, "hooks/reference-transaction"), 0o755);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  async function twin(
    name: string,
    native: string[],
    ours: (c: Clone) => Clone,
    { bare = false, url = (s: string) => s, exit = {} as Record<string, string> } = {},
  ) {
    const n = counter++;
    const theirs = join(root, `${name}-native-${n}`);
    const mine = join(root, `${name}-ours-${n}`);
    const theirsLog = `${theirs}.log`;
    const mineLog = `${mine}.log`;
    const result = gitRun(
      root,
      root,
      ["clone", "-q", `--template=${template}`, ...native, url(src), theirs],
      { HOOK_LOG: theirsLog, ...exit },
    );
    // our working copy over an initialised repository, its hooks the template's
    git(root, "init", "-q", ...(bare ? ["--bare"] : []), `--template=${template}`, mine);
    const env = testEnv(root, { HOOK_LOG: mineLog, ...exit });
    const environment = createNodeGitHostEnvironment({
      env,
      hookRunner: createNodeHookRunner({ env, compatibility: nativeIs25x ? "2.56" : "2.43" }),
    });
    let g: Git;
    if (bare) {
      const files = createNodeFilesApi({ rootDir: root });
      const gitDir = mine.slice(root.length + 1);
      const { history } = await createGitFilesBackend({ files, gitDir });
      const worktrees = await openGitLinkedWorktrees({ files, gitDir, history, environment });
      g = Git.fromWorktreeAdmin(await worktrees.openAdmin());
    } else {
      g = await openOurs(root, environment, undefined, mine.slice(root.length + 1));
    }
    let error: unknown;
    try {
      await ours(g.clone().setURI(url(src))).call();
    } catch (e) {
      error = e;
    }
    const gitDir = (dir: string) => (bare ? dir : join(dir, ".git"));
    return {
      result,
      error,
      theirs: {
        log: readLog(theirsLog),
        refs: existsSync(theirs) ? refFilesOf(gitDir(theirs)) : undefined,
      },
      mine: { log: readLog(mineLog), refs: refFilesOf(gitDir(mine)) },
    };
  }

  const cases: Array<{
    name: string;
    native: string[];
    ours: (c: Clone) => Clone;
    bare?: boolean;
    url?: (s: string) => string;
  }> = [
    { name: "no-local", native: ["--no-local"], ours: (c) => c.setLocal(false) },
    { name: "file-url", native: [], ours: (c) => c, url: (s) => `file://${s}` },
    { name: "local", native: [], ours: (c) => c },
    {
      name: "bare",
      native: ["--no-local", "--bare"],
      ours: (c) => c.setLocal(false).setBare(true),
      bare: true,
    },
    {
      name: "mirror",
      native: ["--no-local", "--mirror"],
      ours: (c) => c.setLocal(false).setMirror(true),
      bare: true,
    },
    {
      name: "single-branch",
      native: ["--no-local", "--single-branch"],
      ours: (c) => c.setLocal(false).setSingleBranch(true),
    },
    {
      name: "single-branch-feat",
      native: ["--no-local", "--single-branch", "-b", "feat"],
      ours: (c) => c.setLocal(false).setSingleBranch(true).setBranch("feat"),
    },
    {
      name: "tag",
      native: ["--no-local", "-b", "v1"],
      ours: (c) => c.setLocal(false).setBranch("v1"),
    },
    {
      name: "no-tags",
      native: ["--no-local", "--no-tags"],
      ours: (c) => c.setLocal(false).setNoTags(),
    },
  ];

  it.each(cases)("clone $name: packed-refs, loose refs and the hook's log", async (c) => {
    const { result, error, theirs, mine } = await twin(c.name, c.native, c.ours, {
      bare: c.bare,
      url: c.url,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(error).toBeUndefined();
    expect(mine.refs).toEqual(theirs.refs);
    expect(mine.refs.packed).toBeDefined();
    expect(mine.log).toBe(theirs.log);
  });

  it.each(["preparing", "prepared"])(
    "a hook refusing the initial transaction in '%s' fails the clone",
    async (state) => {
      const { result, error, theirs, mine } = await twin(
        `refuse-${state}`,
        ["--no-local", "--bare"],
        (c) => c.setLocal(false).setBare(true),
        { bare: true, exit: { [`HOOK_EXIT_${state}`]: "1" } },
      );
      // 2.43 tells no `preparing`: its clone succeeds then
      const refused = state === "prepared" || nativeIs25x;
      expect(result.status, result.stderr).toBe(refused ? 128 : 0);
      expect(mine.log).toBe(theirs.log);
      if (refused) {
        expect(String(error)).toContain(
          nativeIs25x
            ? `in '${state}' phase, update aborted by the reference-transaction hook`
            : "ref updates aborted by hook",
        );
        expect(mine.refs.packed).toBeUndefined();
      } else {
        expect(error).toBeUndefined();
        expect(mine.refs).toEqual(theirs.refs);
      }
    },
  );
});
