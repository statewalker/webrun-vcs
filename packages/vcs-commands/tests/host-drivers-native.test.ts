/**
 * Host-supplied drivers against native git: native git runs the configured commands
 * (`filter.<driver>.clean`/`.smudge`, `diff.<driver>.textconv`, `merge.<driver>.driver`),
 * ours the callbacks a host registers, here callbacks running the same commands as git does
 * (`host-drivers-native-support.ts`). What is compared is what git decides around the
 * commands: `filter.<driver>.required` (a missing or failing driver dies, never passes the
 * content through), an empty command disabling a direction, `diff.<driver>.cachetextconv`
 * (git's notes cache in `refs/notes/textconv/<driver>`, its commits and reflog), and
 * `merge.<driver>.recursive` (the driver of the inner merges of merge bases) and drivers
 * killed by a signal.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createNodeGitHostEnvironment } from "@statewalker/vcs-utils-node/files";
import { type FilterDriverRegistry, installContentFilter } from "@statewalker/vcs-working-tree";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type Git,
  installMergeDrivers,
  installTextconvRunner,
  type MergeDriverRegistry,
} from "../src/index.js";
import {
  shellFilterDriver,
  shellMergeDriver,
  shellTextconvRunner,
} from "./host-drivers-native-support.js";
import { openOurs, snapshot } from "./merge-native-helpers.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

const version = spawnSync("git", ["--version"], { encoding: "utf8" }).stdout ?? "";
const [major = 0, minor = 0] = (/(\d+)\.(\d+)/.exec(version) ?? ["", "0", "0"])
  .slice(1)
  .map(Number);
const atLeast = (ma: number, mi: number) => major > ma || (major === ma && minor >= mi);

let root: string;
let counter = 0;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "host-drivers-"));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** The environment of both twins, with `-c` settings as git's GIT_CONFIG_COUNT. */
function envOf(commandLine: Record<string, string> = {}): Record<string, string> {
  const env = nativeGitEnv(root);
  let n = Number(env.GIT_CONFIG_COUNT ?? 0);
  for (const [key, value] of Object.entries(commandLine)) {
    env[`GIT_CONFIG_KEY_${n}`] = key;
    env[`GIT_CONFIG_VALUE_${n}`] = value;
    n++;
  }
  env.GIT_CONFIG_COUNT = String(n);
  return env;
}

/** Native git in `dir`. */
function git(
  dir: string,
  args: string[],
  env = envOf(),
): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("git", args, { cwd: dir, env, encoding: "utf8" });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** A shell script run in `dir` (git's test scripts' setup), failing loudly. */
function sh(dir: string, script: string): void {
  const r = spawnSync("sh", ["-ec", script], { cwd: dir, env: envOf(), encoding: "utf8" });
  if (r.status !== 0) throw new Error(`setup failed: ${r.stderr}${r.stdout}`);
}

/** Two repositories built by `script` (native and ours). */
function twins(script: string): { native: string; ours: string } {
  const n = counter++;
  const native = join(root, `native-${n}`);
  const ours = join(root, `ours-${n}`);
  for (const dir of [native, ours]) {
    mkdirSync(dir, { recursive: true });
    sh(dir, `git init -q -b main\n${script}`);
  }
  return { native, ours };
}

interface Drivers {
  filters?: string[];
  /** Drivers of the host's own, running no command (as git-lfs's) */
  hostFilters?: FilterDriverRegistry;
  merges?: string[];
  textconv?: boolean;
  commandLine?: Record<string, string>;
}

/** Our Git over `dir`, with the host drivers running git's commands. */
async function open(dir: string, drivers: Drivers = {}): Promise<Git> {
  const env = envOf(drivers.commandLine);
  const environment = createNodeGitHostEnvironment({ env });
  const repo = await openOurs(dir, environment);
  const wc = repo.workingCopy;
  if (drivers.filters || drivers.hostFilters) {
    const filterDrivers: FilterDriverRegistry = {
      ...Object.fromEntries(
        (drivers.filters ?? []).map((name) => [name, shellFilterDriver(dir, env)]),
      ),
      ...drivers.hostFilters,
    };
    installContentFilter(
      { history: wc.history, checkout: wc.checkout, worktree: wc.worktree, config: wc.config },
      { filterDrivers, environment },
    );
  }
  if (drivers.merges) {
    const registry: MergeDriverRegistry = Object.fromEntries(
      drivers.merges.map((name) => [name, shellMergeDriver(dir, env)]),
    );
    installMergeDrivers(wc, registry);
  }
  if (drivers.textconv) installTextconvRunner(wc, shellTextconvRunner(dir, env));
  return repo;
}

/** git's die(): the `fatal:` line of an error thrown by ours. */
function fatalLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith("fatal: ") ? message : `fatal: ${message}`;
}

const ROT13 = `#!/bin/sh
tr 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ' 'nopqrstuvwxyzabcdefghijklmNOPQRSTUVWXYZABCDEFGHIJKLM'
`;

const TEST_O = "a b c d e f g h i j k l m\nn o p q r s t u v w x y z\n$Id$\n";

describeGit("filter.<driver>.required against native git (t0021)", () => {
  /** Adds `path` in both twins; the index and git's death compared. */
  async function compareAdd(
    tw: { native: string; ours: string },
    path: string,
    drivers: Drivers,
  ): Promise<void> {
    const native = git(tw.native, ["add", path], envOf(drivers.commandLine));
    const repo = await open(tw.ours, drivers);
    let died: string | undefined;
    try {
      await repo.add().addFilepattern(path).call();
    } catch (error) {
      died = fatalLine(error);
    }
    if (native.status === 0) expect(died).toBeUndefined();
    else {
      expect(native.status).toBe(128);
      const lines = native.stderr.trimEnd().split("\n");
      expect(died).toBe(lines[lines.length - 1]);
    }
    expect(git(tw.ours, ["ls-files", "-s"]).stdout).toBe(git(tw.native, ["ls-files", "-s"]).stdout);
  }

  /** Removes `path` and checks it out again in both twins; the file and the death compared. */
  async function compareCheckout(
    tw: { native: string; ours: string },
    path: string,
    drivers: Drivers,
  ): Promise<void> {
    for (const dir of [tw.native, tw.ours]) rmSync(join(dir, path), { force: true });
    const native = git(tw.native, ["checkout", "--", path], envOf(drivers.commandLine));
    const repo = await open(tw.ours, drivers);
    let died: string | undefined;
    try {
      await repo.checkout().addPath(path).call();
    } catch (error) {
      died = fatalLine(error);
    }
    if (native.status === 0) expect(died).toBeUndefined();
    else {
      expect(native.status).not.toBe(0);
      const lines = native.stderr.trimEnd().split("\n");
      expect(died).toBe(lines[lines.length - 1]);
    }
    const read = (dir: string) =>
      existsSync(join(dir, path)) ? readFileSync(join(dir, path), "utf8") : null;
    expect(read(tw.ours)).toBe(read(tw.native));
  }

  const setup = (config: Record<string, string>, attributes: string, files: string) =>
    twins(
      [
        `cat >rot13.sh <<'EOF'\n${ROT13}EOF`,
        "chmod +x rot13.sh",
        ...Object.entries(config).map(([k, v]) => `git config ${k} '${v}'`),
        `printf '%s\\n' '${attributes}' >.gitattributes`,
        files,
      ].join("\n"),
    );

  it('t0021-conversion.sh: "required filter should filter data"', async () => {
    const tw = setup(
      {
        "filter.required.smudge": "./rot13.sh",
        "filter.required.clean": "./rot13.sh",
        "filter.required.required": "true",
      },
      "*.r filter=required",
      `printf '%s' '${TEST_O}' >test.r`,
    );
    const drivers = { filters: ["required"] };
    await compareAdd(tw, "test.r", drivers);
    await compareCheckout(tw, "test.r", drivers);
    expect(readFileSync(join(tw.ours, "test.r"), "utf8")).toBe(TEST_O);
  });

  it('t0021-conversion.sh: "required filter smudge failure"', async () => {
    const tw = setup(
      {
        "filter.failsmudge.smudge": "false",
        "filter.failsmudge.clean": "cat",
        "filter.failsmudge.required": "true",
      },
      "*.fs filter=failsmudge",
      "echo test >test.fs",
    );
    const drivers = { filters: ["failsmudge"] };
    await compareAdd(tw, "test.fs", drivers);
    await compareCheckout(tw, "test.fs", drivers);
  });

  it('t0021-conversion.sh: "required filter clean failure"', async () => {
    const tw = setup(
      {
        "filter.failclean.smudge": "cat",
        "filter.failclean.clean": "false",
        "filter.failclean.required": "true",
      },
      "*.fc filter=failclean",
      "echo test >test.fc",
    );
    await compareAdd(tw, "test.fc", { filters: ["failclean"] });
  });

  it('t0021-conversion.sh: "required filter with absent clean field"', async () => {
    const tw = setup(
      { "filter.absentclean.smudge": "cat", "filter.absentclean.required": "true" },
      "*.ac filter=absentclean",
      "echo test >test.ac",
    );
    await compareAdd(tw, "test.ac", { filters: ["absentclean"] });
  });

  it('t0021-conversion.sh: "required filter with absent smudge field"', async () => {
    const tw = setup(
      { "filter.absentsmudge.clean": "cat", "filter.absentsmudge.required": "true" },
      "*.as filter=absentsmudge",
      "echo test >test.as",
    );
    const drivers = { filters: ["absentsmudge"] };
    await compareAdd(tw, "test.as", drivers);
    await compareCheckout(tw, "test.as", drivers);
  });

  it("a required filter the host does not provide dies, as one git cannot run", async () => {
    // native git cannot run the command; ours has no driver registered under the name
    const tw = setup(
      {
        "filter.missing.clean": "./no-such-filter",
        "filter.missing.smudge": "./no-such-filter",
        "filter.missing.required": "true",
      },
      "*.m filter=missing",
      "echo test >test.m",
    );
    await compareAdd(tw, "test.m", {});
    // a stored blob cannot be checked out through it either
    for (const dir of [tw.native, tw.ours]) {
      sh(dir, "git -c filter.missing.clean=cat add test.m");
    }
    await compareCheckout(tw, "test.m", {});
  });

  it('t0021-conversion.sh: "filter that does not read is fine"', async () => {
    const tw = setup(
      { "filter.epipe.clean": "echo xyzzy" },
      "big filter=epipe",
      "head -c 131073 /dev/zero | tr '\\0' 'a' >big",
    );
    await compareAdd(tw, "big", { filters: ["epipe"] });
  });

  it('t0021-conversion.sh: "filter: clean empty file"', async () => {
    const tw = setup(
      {
        "filter.in-repo-header.clean": "echo cleaned && cat",
        "filter.in-repo-header.smudge": "sed 1d",
      },
      "empty-in-worktree    filter=in-repo-header",
      ">empty-in-worktree",
    );
    await compareAdd(tw, "empty-in-worktree", { filters: ["in-repo-header"] });
  });

  it('t0021-conversion.sh: "disable filter with empty override"', async () => {
    const tw = setup(
      { "filter.disable.smudge": "false", "filter.disable.clean": "false" },
      "*.disable filter=disable",
      "echo test >test.disable",
    );
    await compareAdd(tw, "test.disable", {
      filters: ["disable"],
      commandLine: { "filter.disable.clean": "" },
    });
    await compareCheckout(tw, "test.disable", {
      filters: ["disable"],
      commandLine: { "filter.disable.smudge": "" },
    });
  });

  it("an empty command turns a host's own driver off, and a required one then dies", async () => {
    const tw = setup(
      { "filter.req.clean": "tr a-z A-Z", "filter.req.required": "true" },
      "*.q filter=req",
      "echo test >test.q",
    );
    // the host's driver runs no command (as git-lfs's): the empty override still wins
    const upper: FilterDriverRegistry = {
      req: {
        clean: async (content) =>
          new TextEncoder().encode(new TextDecoder().decode(content).toUpperCase()),
      },
    };
    await compareAdd(tw, "test.q", { hostFilters: upper });
    await compareAdd(tw, "test.q", {
      hostFilters: upper,
      commandLine: { "filter.req.clean": "" },
    });
  });
});

const HELPER = `#!/bin/sh
sed 's/^/converted: /' "$@" >helper.out
cat helper.out
`;

describeGit("diff.<driver>.cachetextconv against native git (t4042)", () => {
  /** `git diff HEAD^ HEAD` in both twins: output, the notes caches and their reflogs. */
  async function compareDiff(tw: { native: string; ours: string }): Promise<void> {
    const native = git(tw.native, ["diff", "HEAD^", "HEAD"]);
    expect(native.status).toBe(0);
    const repo = await open(tw.ours, { textconv: true });
    const ours = await repo.diff().setOldTree("HEAD^").setNewTree("HEAD").callText();
    expect(ours).toBe(native.stdout);
    const caches = (dir: string) =>
      git(dir, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/notes/"]).stdout;
    expect(caches(tw.ours)).toBe(caches(tw.native));
    const logs = (dir: string) =>
      git(dir, ["for-each-ref", "--format=%(refname)", "refs/notes/"])
        .stdout.split("\n")
        .filter(Boolean)
        .map((ref) => git(dir, ["reflog", "show", "--format=%H %gs", ref]).stdout)
        .join("");
    expect(logs(tw.ours)).toBe(logs(tw.native));
  }

  it("caches textconv output in refs/notes/textconv/<driver>, as git", async () => {
    const tw = twins(
      [
        `cat >helper <<'EOF'\n${HELPER}EOF`,
        "chmod +x helper",
        "echo foo content 1 >foo.bin",
        "echo bar content 1 >bar.bin",
        "git add foo.bin bar.bin",
        "git commit -q -m one",
        "echo foo content 2 >foo.bin",
        "echo bar content 2 >bar.bin",
        "git commit -q -a -m two",
        'echo "*.bin diff=magic" >.gitattributes',
        "git config diff.magic.textconv ./helper",
        "git config diff.magic.cachetextconv true",
      ].join("\n"),
    );
    // t4042-diff-textconv-caching.sh: "first textconv works"
    await compareDiff(tw);
    // t4042-diff-textconv-caching.sh: "cached textconv produces same output"
    await compareDiff(tw);
    // t4042-diff-textconv-caching.sh: "cached textconv does not run helper"
    for (const dir of [tw.native, tw.ours]) rmSync(join(dir, "helper.out"), { force: true });
    await compareDiff(tw);
    expect(existsSync(join(tw.native, "helper.out"))).toBe(false);
    expect(existsSync(join(tw.ours, "helper.out"))).toBe(false);
    // t4042-diff-textconv-caching.sh: "changing textconv invalidates cache"
    for (const dir of [tw.native, tw.ours]) {
      sh(dir, 'echo other >other && git config diff.magic.textconv "./helper other"');
    }
    await compareDiff(tw);
    // t4042-diff-textconv-caching.sh: "switching diff driver produces correct results"
    for (const dir of [tw.native, tw.ours]) {
      sh(
        dir,
        "git config diff.moremagic.textconv ./helper && echo foo.bin diff=moremagic >>.gitattributes",
      );
    }
    await compareDiff(tw);
  });

  it("git show --textconv <rev>:<path> reads and fills the cache, as git", async () => {
    const tw = twins(
      [
        `cat >helper <<'EOF'\n${HELPER}EOF`,
        "chmod +x helper",
        'echo "*.bin diff=magic" >.gitattributes',
        "echo one >a.bin",
        "echo two >b.bin",
        "git add .gitattributes a.bin b.bin",
        "git commit -q -m one",
        "git config diff.magic.textconv ./helper",
        "git config diff.magic.cachetextconv true",
      ].join("\n"),
    );
    for (const path of ["a.bin", "b.bin", "a.bin"]) {
      for (const dir of [tw.native, tw.ours]) rmSync(join(dir, "helper.out"), { force: true });
      const native = git(tw.native, ["show", "--textconv", `HEAD:${path}`]);
      const repo = await open(tw.ours, { textconv: true });
      const result = await repo
        .show()
        .setOptions({ textconv: true })
        .addArgument(`HEAD:${path}`)
        .call();
      expect(Buffer.from(result.stdout).toString()).toBe(native.stdout);
      // the helper runs only when the blob is not cached yet
      expect(existsSync(join(tw.ours, "helper.out"))).toBe(
        existsSync(join(tw.native, "helper.out")),
      );
      const caches = (dir: string) =>
        git(dir, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/notes/"]).stdout;
      expect(caches(tw.ours)).toBe(caches(tw.native));
    }
  });

  it("does not cache the worktree's side (no object id git knows)", async () => {
    const tw = twins(
      [
        `cat >helper <<'EOF'\n${HELPER}EOF`,
        "chmod +x helper",
        'echo "*.bin diff=magic" >.gitattributes',
        "echo one >a.bin",
        "git add .gitattributes a.bin",
        "git commit -q -m one",
        "git config diff.magic.textconv ./helper",
        "git config diff.magic.cachetextconv true",
        "echo two >a.bin",
      ].join("\n"),
    );
    const native = git(tw.native, ["diff"]);
    const repo = await open(tw.ours, { textconv: true });
    expect(await repo.diff().callText()).toBe(native.stdout);
    const cached = (dir: string) => git(dir, ["ls-tree", "-r", "refs/notes/textconv/magic"]).stdout;
    expect(cached(tw.ours)).toBe(cached(tw.native));
  });
});

/** t6406's custom-merge, without the temporary files' (random) names in its output. */
const CUSTOM_MERGE = `#!/bin/sh

orig="$1" ours="$2" theirs="$3" exit="$4" path=$5
orig_name="$6" our_name="$7" their_name="$8"
(
	echo "path is $path"
	echo "orig_name is $orig_name"
	echo "our_name is $our_name"
	echo "their_name is $their_name"
	echo "=== orig ==="
	cat "$orig"
	echo "=== ours ==="
	cat "$ours"
	echo "=== theirs ==="
	cat "$theirs"
) >"$ours+"
cat "$ours+" >"$ours"
rm -f "$ours+"

if test -f ./please-abort
then
	echo >>./please-abort killing myself
	kill -9 $$
fi
exit "$exit"
`;

/** t6406's setup: text, binary and union changed on main and on side, side checked out. */
const T6406_SETUP = [
  "for f in text binary union; do echo Initial >$f && git add $f; done",
  "git commit -q -m Initial",
  "git branch side",
  "for f in text binary union; do echo Main >>$f && git add $f; done",
  "git commit -q -m Main",
  "git checkout -q side",
  "for f in text binary union; do echo Side >>$f && git add $f; done",
  "git commit -q -m Side",
  "git tag anchor",
  `cat >custom-merge <<'EOF'\n${CUSTOM_MERGE}EOF`,
  "chmod +x custom-merge",
  "printf '%s\\n' custom-merge please-abort >.git/info/exclude",
].join("\n");

/** t6406's criss-cross: recursive-a and recursive-b each merge base-a and base-b. */
const CRISS_CROSS = [
  "git checkout -q -b base-a main^",
  "echo base-a >text",
  "git commit -q -m base-a text",
  "git checkout -q -b base-b main^",
  "echo base-b >text",
  "git commit -q -m base-b text",
  "git checkout -q -b recursive-a base-a",
  "git merge -q base-b >/dev/null 2>&1 || true",
  "echo recursive-a >text",
  "git add text",
  "git commit -q -m recursive-a",
  "git checkout -q -b recursive-b base-b",
  "git merge -q base-a >/dev/null 2>&1 || true",
  "echo recursive-b >text",
  "git add text",
  "git commit -q -m recursive-b",
].join("\n");

describeGit("merge.<driver>.driver and .recursive against native git (t6406)", () => {
  /** `git merge <branch>` in both twins: exit status, git's error line, the state after. */
  async function compareMerge(
    tw: { native: string; ours: string },
    branch: string,
    merges: string[],
  ): Promise<void> {
    const native = git(tw.native, ["merge", branch]);
    const repo = await open(tw.ours, { merges });
    let status = 0;
    let errors: string[] = [];
    try {
      const result = await repo.merge().include(branch).call();
      const failed = String(result.status) === "FAILED" || String(result.status) === "failed";
      status = failed ? 2 : result.conflicts?.length || result.status === "conflicting" ? 1 : 0;
      errors = [...(result.output ?? []), ...(result.message ?? "").split("\n")].filter((l) =>
        l.startsWith("error: "),
      );
    } catch (error) {
      status = 128;
      errors = [fatalLine(error)];
    }
    // git 2.43 does not name the path (ours follows 2.5x's ERROR path message)
    const expectedErrors = native.stderr
      .split("\n")
      .filter((l) => l.startsWith("error: ") && !/ died of signal /.test(l));
    if (!atLeast(2, 44))
      errors = errors.map((l) => l.replace(/ internal merge for .*/, " internal merge"));
    expect({ status, errors }).toEqual({ status: native.status, errors: expectedErrors });
    expect(snapshot(root, tw.ours)).toEqual(snapshot(root, tw.native));
  }

  it('t6406-merge-attr.sh: "custom merge backend"', async () => {
    const tw = twins(
      [
        T6406_SETUP,
        "echo '* merge=union' >.gitattributes",
        "echo 'text merge=custom' >>.gitattributes",
        "git config merge.custom.driver './custom-merge %O %A %B 0 %P %S %X %Y'",
        "git config merge.custom.name 'custom merge driver for testing'",
      ].join("\n"),
    );
    await compareMerge(tw, "main", ["custom"]);
    // the second "custom merge backend": the driver exits 1 (a conflict)
    for (const dir of [tw.native, tw.ours]) {
      sh(
        dir,
        "git reset -q --hard anchor && git config --replace-all merge.custom.driver './custom-merge %O %A %B 1 %P %S %X %Y'",
      );
    }
    await compareMerge(tw, "main", ["custom"]);
  });

  it('t6406-merge-attr.sh: "custom merge driver that is killed with a signal"', async () => {
    const tw = twins(
      [
        T6406_SETUP,
        "git config merge.custom.driver './custom-merge %O %A %B 0 %P %S %X %Y'",
        "echo '* merge=custom' >.gitattributes",
        ">please-abort",
      ].join("\n"),
    );
    await compareMerge(tw, "main", ["custom"]);
  });

  // git 2.43 aborts (merge_switch_to_result's assertion) on a failure in an inner merge
  const itFixed = atLeast(2, 50) ? it : it.skip;
  itFixed(
    't6406-merge-attr.sh: "custom merge driver that is killed with a signal on recursive merge"',
    async () => {
      const tw = twins(
        [
          T6406_SETUP,
          CRISS_CROSS,
          "git config merge.custom.driver './custom-merge %O %A %B 0 %P %S %X %Y'",
          "echo '* merge=custom' >.gitattributes",
          ">please-abort",
        ].join("\n"),
      );
      await compareMerge(tw, "recursive-a", ["custom"]);
    },
  );

  for (const recursive of ["binary", "union", "text", "inner"]) {
    it(`merge.<driver>.recursive=${recursive} merges the merge bases with that driver`, async () => {
      const tw = twins(
        [
          T6406_SETUP,
          CRISS_CROSS,
          "git config merge.custom.driver './custom-merge %O %A %B 0 %P %S %X %Y'",
          `git config merge.custom.recursive ${recursive}`,
          "git config merge.inner.driver 'cat %B >%A'",
          "echo '* merge=custom' >.gitattributes",
        ].join("\n"),
      );
      await compareMerge(tw, "recursive-a", ["custom", "inner"]);
    });
  }

  it("without merge.<driver>.recursive the inner merges run the driver itself", async () => {
    const tw = twins(
      [
        T6406_SETUP,
        CRISS_CROSS,
        "git config merge.custom.driver './custom-merge %O %A %B 0 %P %S %X %Y'",
        "echo '* merge=custom' >.gitattributes",
      ].join("\n"),
    );
    await compareMerge(tw, "recursive-a", ["custom"]);
  });
});
