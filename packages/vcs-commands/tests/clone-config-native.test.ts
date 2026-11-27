/**
 * `git clone`'s configuration options against native git (2.43 and 2.5x): `-c`/`--config`
 * written to the new repository before the fetch and used by it (t5611-clone-config), the
 * remote's name (`-o`/`--origin`, `clone.defaultRemoteName`), `--[no-]reject-shallow` and
 * `clone.rejectShallow` (t5606-clone-options), and `--sparse`
 * (t1091-sparse-checkout-builtin). Each scenario runs native git's clone and ours from the
 * same source and compares the repositories left (`cloneStateOf`).
 */

import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  cloneStateOf,
  ourClone,
  ourCloneFails,
  stderrLines,
} from "./clone-options-native-support.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { gitOut, gitRun, putFile } from "./status-native-support.js";
import { CLEANUP_TIMEOUT, removeTempDir } from "./temp-dir-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root: string;
let src: string;
let shallow: string;
let counter = 0;
const git = (cwd: string, ...args: string[]) => gitOut(root, cwd, args);

/** Two clone destinations, native's and ours. */
function twins(): [string, string] {
  const k = counter++;
  return [join(root, `n${k}`), join(root, `o${k}`)];
}

/** `git -c k=v ...` as `GIT_CONFIG_*` variables (after the test environment's two). */
function commandLine(pairs: [string, string][]): Record<string, string> {
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(2 + pairs.length) };
  pairs.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i + 2}`] = k;
    env[`GIT_CONFIG_VALUE_${i + 2}`] = v;
  });
  return env;
}

describeGit("git clone -c, -o, --reject-shallow, --sparse, as native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "clone-config-native-"));
    src = join(root, "src");
    mkdirSync(src);
    git(src, "init", "-q", "-b", "main");
    putFile(src, "file", "content\n");
    mkdirSync(join(src, "folder1"));
    putFile(src, "folder1/a", "a\n");
    git(src, "add", ".");
    git(src, "commit", "-qm", "one");
    git(src, "tag", "-a", "v1", "-m", "v1");
    git(src, "update-ref", "refs/grab/it", "refs/heads/main");
    git(src, "update-ref", "refs/leave/out", "refs/heads/main");
    shallow = join(root, "shallow-repo");
    // (no tag: a shallow commit two refs reach is listed twice in the clone's shallow file,
    // which clone-shallow-source-native.test.ts covers; not what these twins are about)
    git(root, "clone", "-q", "--depth=1", "--no-tags", "--no-local", src, shallow);
  });
  afterAll(() => removeTempDir(root), CLEANUP_TIMEOUT);

  it.each([
    ['"clone -c sets config in cloned repo"', ["core.foo=bar"]],
    ['"clone -c can set multi-keys"', ["core.foo=bar", "core.foo=baz"]],
    [
      '"clone -c can set multi-keys, including some empty"',
      ["credential.helper=", "credential.helper=hi"],
    ],
    ['"clone -c without a value is boolean true"', ["core.foo"]],
    ['"clone -c config is available during clone"', ["core.autocrlf"]],
    [
      '"clone -c remote.origin.fetch=<refspec> works"',
      ["remote.origin.fetch=+refs/grab/*:refs/grab/*"],
    ],
  ])("t5611-clone-config.sh: %s", async (_title, configs) => {
    const [n, o] = twins();
    const args = configs.flatMap((c) => ["-c", c]);
    expect(gitRun(root, root, ["clone", "-q", ...args, src, n]).status).toBe(0);
    await ourClone(root, o, (c) => c.setURI(src).setConfig(configs));
    expect(cloneStateOf(root, o)).toEqual(cloneStateOf(root, n));
  });

  it('t5611-clone-config.sh: "clone -c config is available during clone" (no-local fetch)', async () => {
    const [n, o] = twins();
    expect(
      gitRun(root, root, ["clone", "-q", "--no-local", "-c", "core.autocrlf", src, n]).status,
    ).toBe(0);
    await ourClone(root, o, (c) => c.setURI(src).setLocal(false).setConfig(["core.autocrlf"]));
    expect(cloneStateOf(root, o)).toEqual(cloneStateOf(root, n));
    expect(cloneStateOf(root, o).files?.file).toBe("content\r\n");
  });

  it('t5611-clone-config.sh: "git -c remote.origin.fetch=<refspec> clone works"', async () => {
    const [n, o] = twins();
    const extraEnv = commandLine([["remote.origin.fetch", "+refs/grab/*:refs/grab/*"]]);
    expect(gitRun(root, root, ["clone", "-q", src, n], extraEnv).status).toBe(0);
    await ourClone(root, o, (c) => c.setURI(src), { extraEnv });
    expect(cloneStateOf(root, o)).toEqual(cloneStateOf(root, n));
    expect(git(o, "for-each-ref", "--format=%(refname)")).toContain("refs/grab/it\n");
  });

  it('t5611-clone-config.sh: "clone -c remote.<remote>.fetch=<refspec> --origin=<name>"', async () => {
    const [n, o] = twins();
    const configs = [
      "remote.upstream.fetch=+refs/grab/*:refs/grab/*",
      "remote.origin.fetch=+refs/leave/*:refs/leave/*",
    ];
    const args = configs.flatMap((c) => ["-c", c]);
    expect(gitRun(root, root, ["clone", "-q", "--origin=upstream", ...args, src, n]).status).toBe(
      0,
    );
    await ourClone(root, o, (c) => c.setURI(src).setRemote("upstream").setConfig(configs));
    expect(cloneStateOf(root, o)).toEqual(cloneStateOf(root, n));
  });

  it("t5611-clone-config.sh: -c url.<base>.insteadOf rewrites the URL fetched from", async () => {
    const [n, o] = twins();
    const configs = [`url.${src}.insteadOf=elsewhere:`, "fetch.fsckObjects=true"];
    const args = configs.flatMap((c) => ["-c", c]);
    expect(gitRun(root, root, ["clone", "-q", "--no-local", ...args, src, n]).status).toBe(0);
    await ourClone(root, o, (c) => c.setURI(src).setLocal(false).setConfig(configs));
    expect(cloneStateOf(root, o)).toEqual(cloneStateOf(root, n));
  });

  it("t5611-clone-config.sh: a -c key git cannot parse fails before anything is written", async () => {
    for (const bad of ["foo", "=x"]) {
      const [n, o] = twins();
      const theirs = gitRun(root, root, ["clone", "-q", "-c", bad, src, n]);
      expect(theirs.status).toBe(128);
      const ours = await ourCloneFails(root, o, (c) => c.setURI(src).setConfig([bad]));
      expect(ours.message).toBe(stderrLines(theirs.stderr));
      expect(ours.exitCode).toBe(128);
    }
  });

  it('t5606-clone-options.sh: "clone -o", "clone --bare -o"', async () => {
    const [n, o] = twins();
    expect(gitRun(root, root, ["clone", "-q", "-o", "foo", src, n]).status).toBe(0);
    await ourClone(root, o, (c) => c.setURI(src).setRemote("foo"));
    expect(cloneStateOf(root, o)).toEqual(cloneStateOf(root, n));

    const [nb, ob] = twins();
    expect(gitRun(root, root, ["clone", "-q", "-o", "foo", "--bare", src, nb]).status).toBe(0);
    await ourClone(root, ob, (c) => c.setURI(src).setRemote("foo").setBare(true), { bare: true });
    expect(cloneStateOf(root, ob, true)).toEqual(cloneStateOf(root, nb, true));
  });

  it('t5606-clone-options.sh: "rejects invalid -o/--origin"', async () => {
    const [n, o] = twins();
    const theirs = gitRun(root, root, ["clone", "-q", "-o", "bad...name", src, n]);
    expect(theirs.status).toBe(128);
    const ours = await ourCloneFails(root, o, (c) => c.setURI(src).setRemote("bad...name"));
    expect(`fatal: ${ours.message}`).toBe(stderrLines(theirs.stderr));
  });

  it('t5606-clone-options.sh: "prefers config "clone.defaultRemoteName" over default"', async () => {
    const [n, o] = twins();
    const extraEnv = commandLine([["clone.defaultRemoteName", "from_config"]]);
    expect(gitRun(root, root, ["clone", "-q", src, n], extraEnv).status).toBe(0);
    await ourClone(root, o, (c) => c.setURI(src), { extraEnv });
    expect(cloneStateOf(root, o)).toEqual(cloneStateOf(root, n));
    expect(git(o, "rev-parse", "--verify", "-q", "refs/remotes/from_config/main")).not.toBe("");
  });

  it('t5606-clone-options.sh: "prefers --origin over -c config"', async () => {
    const [n, o] = twins();
    const args = ["-c", "clone.defaultRemoteName=inline", "--origin", "from_option"];
    expect(gitRun(root, root, ["clone", "-q", ...args, src, n]).status).toBe(0);
    await ourClone(root, o, (c) =>
      c.setURI(src).setConfig(["clone.defaultRemoteName=inline"]).setRemote("from_option"),
    );
    expect(cloneStateOf(root, o)).toEqual(cloneStateOf(root, n));

    // and -c alone names the remote
    const [n2, o2] = twins();
    expect(
      gitRun(root, root, ["clone", "-q", "-c", "clone.defaultRemoteName=inline", src, n2]).status,
    ).toBe(0);
    await ourClone(root, o2, (c) => c.setURI(src).setConfig(["clone.defaultRemoteName=inline"]));
    expect(cloneStateOf(root, o2)).toEqual(cloneStateOf(root, n2));
  });

  it('t5606-clone-options.sh: "reject cloning shallow repository", "reject cloning non-local shallow repository"', async () => {
    for (const local of [true, false]) {
      const [n, o] = twins();
      const flags = local ? [] : ["--no-local"];
      const theirs = gitRun(root, root, ["clone", "-q", "--reject-shallow", ...flags, shallow, n]);
      expect(theirs.status).toBe(128);
      const ours = await ourCloneFails(root, o, (c) =>
        local
          ? c.setURI(shallow).setRejectShallow(true)
          : c.setURI(shallow).setRejectShallow(true).setLocal(false),
      );
      expect(ours.message).toBe(stderrLines(theirs.stderr));
      expect(stderrLines(theirs.stderr)).toBe(
        "fatal: source repository is shallow, reject to clone.",
      );

      const [n2, o2] = twins();
      expect(
        gitRun(root, root, ["clone", "-q", "--no-reject-shallow", ...flags, shallow, n2]).status,
      ).toBe(0);
      await ourClone(root, o2, (c) =>
        local
          ? c.setURI(shallow).setRejectShallow(false)
          : c.setURI(shallow).setRejectShallow(false).setLocal(false),
      );
      expect(cloneStateOf(root, o2)).toEqual(cloneStateOf(root, n2));
    }
  });

  it('t5606-clone-options.sh: "succeed cloning normal repository"', async () => {
    const [n, o] = twins();
    expect(
      gitRun(root, root, ["clone", "-q", "--reject-shallow", "--no-local", src, n]).status,
    ).toBe(0);
    await ourClone(root, o, (c) => c.setURI(src).setRejectShallow(true).setLocal(false));
    expect(cloneStateOf(root, o)).toEqual(cloneStateOf(root, n));
  });

  it('t5611-clone-config.sh: "clone.rejectshallow=true should reject cloning shallow repo", "option --[no-]reject-shallow override clone.rejectshallow config"', async () => {
    const [n, o] = twins();
    const on = commandLine([["clone.rejectshallow", "true"]]);
    const theirs = gitRun(root, root, ["clone", "-q", "--no-local", shallow, n], on);
    expect(theirs.status).toBe(128);
    const ours = await ourCloneFails(root, o, (c) => c.setURI(shallow).setLocal(false), {
      extraEnv: on,
    });
    expect(ours.message).toBe(stderrLines(theirs.stderr));

    // -c clone.rejectShallow written into the new repository counts too
    const [n1, o1] = twins();
    const viaC = ["-c", "clone.rejectShallow=true"];
    expect(gitRun(root, root, ["clone", "-q", ...viaC, "--no-local", shallow, n1]).status).toBe(
      128,
    );
    const ours1 = await ourCloneFails(root, o1, (c) =>
      c.setURI(shallow).setLocal(false).setConfig(["clone.rejectShallow=true"]),
    );
    expect(ours1.message).toBe("fatal: source repository is shallow, reject to clone.");

    const [n2, o2] = twins();
    expect(
      gitRun(root, root, ["clone", "-q", "--no-reject-shallow", "--no-local", shallow, n2], on)
        .status,
    ).toBe(0);
    await ourClone(root, o2, (c) => c.setURI(shallow).setLocal(false).setRejectShallow(false), {
      extraEnv: on,
    });
    expect(cloneStateOf(root, o2)).toEqual(cloneStateOf(root, n2));

    const [n3, o3] = twins();
    const off = commandLine([["clone.rejectshallow", "false"]]);
    expect(
      gitRun(root, root, ["clone", "-q", "--reject-shallow", "--no-local", shallow, n3], off)
        .status,
    ).toBe(128);
    const ours3 = await ourCloneFails(
      root,
      o3,
      (c) => c.setURI(shallow).setLocal(false).setRejectShallow(true),
      { extraEnv: off },
    );
    expect(ours3.message).toBe("fatal: source repository is shallow, reject to clone.");
  });

  it('t1091-sparse-checkout-builtin.sh: "clone --sparse"', async () => {
    const [n, o] = twins();
    expect(gitRun(root, root, ["clone", "-q", "--sparse", `file://${src}`, n]).status).toBe(0);
    await ourClone(root, o, (c) => c.setURI(`file://${src}`).setSparse(true));
    expect(cloneStateOf(root, o)).toEqual(cloneStateOf(root, n));
    expect(Object.keys(cloneStateOf(root, o).files ?? {})).toEqual(["file"]);
  });

  describe("configured refspecs over two branches", () => {
    let two: string;
    beforeAll(() => {
      two = join(root, "two");
      git(root, "clone", "-q", "--no-local", src, two);
      git(two, "branch", "other", "HEAD");
      putFile(two, "other.txt", "other\n");
      git(two, "add", "other.txt");
      git(two, "commit", "-qm", "main moves on");
    });

    type Clone = Parameters<Parameters<typeof ourClone>[2]>[0];
    const cases: [string, string[], string[], (c: Clone) => Clone][] = [
      [
        "plain",
        ["-c", "remote.origin.fetch=+refs/heads/*:refs/foo/*"],
        ["+refs/heads/*:refs/foo/*"],
        (c) => c,
      ],
      [
        "--single-branch",
        ["--single-branch", "-c", "remote.origin.fetch=+refs/heads/*:refs/foo/*"],
        ["+refs/heads/*:refs/foo/*"],
        (c) => c.setSingleBranch(true),
      ],
      [
        "an exact refspec, --single-branch",
        ["--single-branch", "-c", "remote.origin.fetch=refs/heads/main:refs/x/main"],
        ["refs/heads/main:refs/x/main"],
        (c) => c.setSingleBranch(true),
      ],
    ];
    for (const [name, args, fetch, configure] of cases) {
      for (const local of [true, false]) {
        it(`t5611-clone-config.sh: "clone -c remote.origin.fetch=<refspec> works" (refs/remotes/origin/HEAD: ${name}${local ? "" : ", --no-local"})`, async () => {
          const [n, o] = twins();
          const flags = local ? [] : ["--no-local"];
          expect(gitRun(root, root, ["clone", "-q", ...flags, ...args, two, n]).status).toBe(0);
          await ourClone(root, o, (c) => {
            const d = configure(
              c.setURI(two).setConfig(fetch.map((f) => `remote.origin.fetch=${f}`)),
            );
            return local ? d : d.setLocal(false);
          });
          expect(cloneStateOf(root, o)).toEqual(cloneStateOf(root, n));
        });
      }
    }

    it("t5611-clone-config.sh: configured refspecs git's clone dies on (a missing ref, a ref written twice)", async () => {
      const deaths: [string[], (c: Clone) => Clone][] = [
        [
          ["--mirror", "-c", "remote.origin.fetch=+refs/heads/*:refs/heads/*"],
          (c) => c.setMirror(true).setConfig(["remote.origin.fetch=+refs/heads/*:refs/heads/*"]),
        ],
        [
          ["-c", "remote.origin.fetch=+refs/heads/*:refs/remotes/origin/*"],
          (c) => c.setConfig(["remote.origin.fetch=+refs/heads/*:refs/remotes/origin/*"]),
        ],
        [
          ["-c", "remote.origin.fetch=+refs/tags/*:refs/tags/*"],
          (c) => c.setConfig(["remote.origin.fetch=+refs/tags/*:refs/tags/*"]),
        ],
        [
          [
            "--single-branch",
            "-b",
            "other",
            "-c",
            "remote.origin.fetch=refs/heads/main:refs/x/main",
          ],
          (c) =>
            c
              .setSingleBranch(true)
              .setBranch("other")
              .setConfig(["remote.origin.fetch=refs/heads/main:refs/x/main"]),
        ],
        [
          ["-c", "remote.origin.fetch=refs/heads/nope:refs/x/nope"],
          (c) => c.setConfig(["remote.origin.fetch=refs/heads/nope:refs/x/nope"]),
        ],
      ];
      for (const [args, configure] of deaths) {
        const [n, o] = twins();
        const theirs = gitRun(root, root, ["clone", "-q", ...args, two, n]);
        expect(theirs.status).toBe(128);
        const ours = await ourCloneFails(root, o, (c) => configure(c.setURI(two)), {
          bare: args.includes("--mirror"),
        });
        expect(ours.message).toBe(stderrLines(theirs.stderr));
        expect(ours.exitCode).toBe(128);
      }
    });
  });
});
