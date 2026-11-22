/**
 * Native twins of git's repository safety checks: `safe.directory` and the "detected dubious
 * ownership" refusal, `safe.bareRepository`, and `enter_repo`'s check of another
 * repository. Each scenario runs `git rev-parse --git-dir` (or receive-pack) and our
 * `discoverRepository` (or `FileWorktree.openRepository`) and compares exit codes and
 * stderr.
 *
 * Ownership differences come from `GIT_TEST_ASSUME_DIFFERENT_OWNER`, which both honour, so
 * these run as any user (CI runs unprivileged). When the tests run as root with `setpriv`,
 * native git also runs as uid 65534 against the root-owned fixture, ours with
 * `effectiveUid: 65534`, and as root with `SUDO_UID` against a fixture owned by 65534.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  chownSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGitFilesBackend, discoverRepository, FileWorktree } from "../src/index.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const version = execFileSync("git", ["--version"]).toString();
const [, major = "2", minor = "0"] = /(\d+)\.(\d+)/.exec(version) ?? [];
const compatibility: "2.43" | "2.56" = Number(major) > 2 || Number(minor) >= 46 ? "2.56" : "2.43";
const asRoot = process.getuid?.() === 0 && spawnSync("setpriv", ["--version"]).status === 0;

// a world-readable fixture (native git runs as another user over it); its real path, as
// git's getcwd names directories
const T = realpathSync(mkdtempSync(join(tmpdir(), "repo-safety-")));
dirs.push(T);
chmodSync(T, 0o755);

const BASE_ENV: Record<string, string> = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: T,
  LANG: "C",
  LC_ALL: "C",
  GIT_AUTHOR_NAME: "A U Thor",
  GIT_AUTHOR_EMAIL: "author@example.com",
  GIT_COMMITTER_NAME: "C O Mitter",
  GIT_COMMITTER_EMAIL: "committer@example.com",
  GIT_AUTHOR_DATE: "1700000000 +0000",
  GIT_COMMITTER_DATE: "1700000000 +0000",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_ATTR_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  ...(process.env.GIT_EXEC_PATH ? { GIT_EXEC_PATH: process.env.GIT_EXEC_PATH } : {}),
};

const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, {
    cwd,
    env: {
      ...BASE_ENV,
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "maintenance.auto",
      GIT_CONFIG_VALUE_0: "false",
      GIT_CONFIG_KEY_1: "gc.auto",
      GIT_CONFIG_VALUE_1: "0",
    },
    stdio: "pipe",
  }).toString();

beforeAll(() => {
  git(T, ["init", "-q", "-b", "main", "repo"]);
  git(join(T, "repo"), ["commit", "-q", "--allow-empty", "-m", "c"]);
  git(join(T, "repo"), ["worktree", "add", "-q", join(T, "wt")]);
  mkdirSync(join(T, "repo", "sub"));
  git(T, ["init", "-q", "--bare", "bare.git"]);
  mkdirSync(join(T, "bare.git", "sub"));
  git(T, ["init", "-q", "cfg"]);
  writeFileSync(join(T, "cfg", ".git", "config"), "[safe]\n\tdirectory = *\n", { flag: "a" });
  symlinkSync(join(T, "repo"), join(T, "link"));
  writeFileSync(join(T, "global"), `[safe]\n\tdirectory = ${T}/repo\n`);
  execFileSync("chmod", ["-R", "a+rX", T]);
});

/** `GIT_CONFIG_COUNT` entries for `git -c` values, as git passes them to children. */
function commandLine(entries: Array<[string, string]>): Record<string, string> {
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(entries.length) };
  entries.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return env;
}

interface Outcome {
  exit: number;
  stderr: string;
}

function native(cwd: string, env: Record<string, string>, asUser?: number): Outcome {
  const full = { ...BASE_ENV, ...env };
  const args = ["rev-parse", "--git-dir"];
  const run =
    asUser === undefined
      ? spawnSync("git", args, { cwd, env: full })
      : spawnSync(
          "setpriv",
          [`--reuid=${asUser}`, `--regid=${asUser}`, "--clear-groups", "env", "git", ...args],
          { cwd, env: full },
        );
  return { exit: run.status ?? -1, stderr: run.stderr.toString() };
}

async function ours(
  cwd: string,
  env: Record<string, string>,
  effectiveUid?: number,
): Promise<Outcome> {
  const files = createNodeFilesApi({ rootDir: "/" });
  const environment = createNodeGitHostEnvironment({
    env: { ...BASE_ENV, ...env },
    ...(effectiveUid !== undefined ? { effectiveUid } : {}),
  });
  try {
    const found = await discoverRepository({ files, cwd, environment, compatibility });
    return { exit: 0, stderr: found.warnings.map((w) => `${w}\n`).join("") };
  } catch (error) {
    const e = error as Error & { warnings?: string[] };
    const warnings = (e.warnings ?? []).map((w) => `${w}\n`).join("");
    return { exit: 128, stderr: `${warnings}${e.message}\n` };
  }
}

const DIFFERENT = { GIT_TEST_ASSUME_DIFFERENT_OWNER: "1" };

/** The scenarios: where git starts, its variables, and what this git version answers. */
const scenarios: Array<{ name: string; cwd: string; env: Record<string, string>; only?: "2.56" }> =
  [
    { name: "no exception", cwd: "repo", env: {} },
    { name: "below the worktree", cwd: "repo/sub", env: {} },
    { name: "the exact path", cwd: "repo", env: commandLine([["safe.directory", `${T}/repo`]]) },
    { name: "*", cwd: "repo", env: commandLine([["safe.directory", "*"]]) },
    {
      name: "a leading path with /*",
      cwd: "repo",
      env: commandLine([["safe.directory", `${T}/*`]]),
    },
    {
      name: "the path with /*",
      cwd: "repo",
      env: commandLine([["safe.directory", `${T}/repo/*`]]),
    },
    { name: "a trailing slash", cwd: "repo", env: commandLine([["safe.directory", `${T}/repo/`]]) },
    { name: "through a link", cwd: "repo", env: commandLine([["safe.directory", `${T}/link`]]) },
    { name: "dot at the top", cwd: "repo", env: commandLine([["safe.directory", "."]]) },
    { name: "dot below the top", cwd: "repo/sub", env: commandLine([["safe.directory", "."]]) },
    {
      name: "an empty value resets",
      cwd: "repo",
      env: commandLine([
        ["safe.directory", "*"],
        ["safe.directory", ""],
      ]),
    },
    {
      name: "a value after the reset",
      cwd: "repo",
      env: commandLine([
        ["safe.directory", ""],
        ["safe.directory", `${T}/repo`],
      ]),
    },
    {
      name: "%(prefix)/",
      cwd: "repo",
      env: commandLine([["safe.directory", `%(prefix)/${T}/repo`]]),
    },
    { name: "~/", cwd: "repo", env: commandLine([["safe.directory", "~/repo"]]) },
    { name: "a relative path", cwd: "repo", env: commandLine([["safe.directory", "repo"]]) },
    { name: "the repository's own config", cwd: "cfg", env: {} },
    { name: "the global file", cwd: "repo", env: { GIT_CONFIG_GLOBAL: `${T}/global` } },
    { name: "a linked worktree's gitfile", cwd: "wt", env: {} },
    {
      name: "a linked worktree listed",
      cwd: "wt",
      env: commandLine([["safe.directory", `${T}/wt`]]),
    },
    { name: "a bare repository", cwd: "bare.git", env: {} },
    { name: "below a bare repository", cwd: "bare.git/sub", env: {} },
    {
      name: "a bare repository listed",
      cwd: "bare.git",
      env: commandLine([["safe.directory", `${T}/bare.git`]]),
    },
    { name: "inside .git", cwd: "repo/.git", env: {} },
    {
      name: "a bare repository, explicit before ownership",
      cwd: "bare.git",
      env: commandLine([["safe.bareRepository", "explicit"]]),
    },
  ];

describe(`safe.directory as native git ${compatibility === "2.43" ? "2.43" : "2.5x"}`, () => {
  for (const s of scenarios) {
    it(`assumed different owner: ${s.name}`, async () => {
      const cwd = join(T, s.cwd);
      const env = { ...DIFFERENT, ...s.env };
      expect(await ours(cwd, env)).toEqual(native(cwd, env));
    });
  }

  it("refuses and allows where git does (the scenarios are not all one outcome)", async () => {
    const outcome = (name: string) => {
      const s = scenarios.find((x) => x.name === name);
      if (!s) throw new Error(name);
      return native(join(T, s.cwd), { ...DIFFERENT, ...s.env });
    };
    expect(outcome("no exception")).toEqual({
      exit: 128,
      stderr:
        `fatal: detected dubious ownership in repository at '${T}/repo'\n` +
        "To add an exception for this directory, call:\n\n" +
        `\tgit config --global --add safe.directory ${T}/repo\n`,
    });
    expect(outcome("*").exit).toBe(0);
    expect(outcome("the exact path").exit).toBe(0);
    expect(outcome("an empty value resets").exit).toBe(128);
    expect(outcome("the repository's own config").exit).toBe(128);
    expect(outcome("a leading path with /*").exit).toBe(compatibility === "2.43" ? 128 : 0);
    expect(
      outcome("a relative path").stderr.startsWith("warning: safe.directory 'repo' not absolute"),
    ).toBe(compatibility !== "2.43");
  });

  it.skipIf(!asRoot)("as uid 65534 against root's repositories", async () => {
    for (const s of scenarios) {
      const cwd = join(T, s.cwd);
      if (s.cwd === "cfg") continue;
      expect({ s: s.name, ...(await ours(cwd, s.env, 65534)) }).toEqual({
        s: s.name,
        ...native(cwd, s.env, 65534),
      });
    }
  });

  it.skipIf(!asRoot)("as root with SUDO_UID against a repository the sudo user owns", async () => {
    const own = join(T, "sudo");
    git(T, ["init", "-q", own]);
    execFileSync("chown", ["-R", "65534:65534", own]);
    try {
      const variants: Array<Record<string, string>> = [
        {},
        { SUDO_UID: "65534" },
        { SUDO_UID: "1234" },
        { SUDO_UID: "x" },
      ];
      for (const env of variants) {
        expect({ env, ...(await ours(own, env, 0)) }).toEqual({ env, ...native(own, env) });
      }
      // a root-owned repository stays root's whatever SUDO_UID says
      const cwd = join(T, "repo");
      expect(await ours(cwd, { SUDO_UID: "65534" }, 0)).toEqual(native(cwd, { SUDO_UID: "65534" }));
    } finally {
      chownSync(own, 0, 0);
    }
  });
});

describe("safe.bareRepository=explicit", () => {
  const explicit = commandLine([["safe.bareRepository", "explicit"]]);
  for (const cwd of [
    "bare.git",
    "bare.git/sub",
    "repo/.git",
    "repo/.git/refs",
    "repo/.git/worktrees/wt",
  ]) {
    it(`discovered from ${cwd}`, async () => {
      const dir = join(T, cwd);
      expect(await ours(dir, explicit)).toEqual(native(dir, explicit));
    });
  }

  it("is not applied to an explicit GIT_DIR", async () => {
    const env = { ...explicit, GIT_DIR: join(T, "bare.git") };
    expect(native(T, env)).toEqual({ exit: 0, stderr: "" });
    const files = createNodeFilesApi({ rootDir: "/" });
    const environment = createNodeGitHostEnvironment({ env: { ...BASE_ENV, ...env } });
    const found = await discoverRepository({
      files,
      cwd: T,
      gitDir: join(T, "bare.git"),
      environment,
      compatibility,
    });
    expect(found.bare).toBe(true);
  });

  it("refuses an unknown value as git's config error", async () => {
    const env = commandLine([["safe.bareRepository", "bogus"]]);
    const dir = join(T, "bare.git");
    expect(await ours(dir, env)).toEqual(native(dir, env));
  });
});

describe("enter_repo's check of another repository (receive-pack)", () => {
  /** receive-pack's refusal, or its advertisement's success. */
  function nativeReceivePack(path: string, env: Record<string, string>, asUser?: number): Outcome {
    const full = { ...BASE_ENV, ...env };
    const args = ["receive-pack", "--advertise-refs", path];
    const run =
      asUser === undefined
        ? spawnSync("git", args, { cwd: T, env: full })
        : spawnSync(
            "setpriv",
            [`--reuid=${asUser}`, `--regid=${asUser}`, "--clear-groups", "env", "git", ...args],
            { cwd: T, env: full },
          );
    return { exit: run.status ?? -1, stderr: run.stderr.toString() };
  }

  async function ourOpen(path: string, env: Record<string, string>, effectiveUid?: number) {
    const files = createNodeFilesApi({ rootDir: "/" });
    const environment = createNodeGitHostEnvironment({
      env: { ...BASE_ENV, ...env },
      ...(effectiveUid !== undefined ? { effectiveUid } : {}),
    });
    const { history } = await createGitFilesBackend({ files, gitDir: `${T}/repo/.git` });
    const worktree = new FileWorktree({
      files,
      rootPath: T,
      gitDir: `${T}/repo/.git`,
      blobs: history.blobs,
      trees: history.trees,
      environment,
    });
    try {
      await worktree.openRepository(path, { compatibility });
      return { exit: 0, stderr: "" };
    } catch (error) {
      return { exit: 128, stderr: `${(error as Error).message}\n` };
    }
  }

  for (const [name, path, env] of [
    ["a worktree's repository", "repo", {}],
    ["a bare repository", "bare.git", {}],
    ["a linked worktree's gitfile", "wt", {}],
    ["listed", "repo", commandLine([["safe.directory", `${T}/repo/.git`]])],
    ["listed by its worktree", "repo", commandLine([["safe.directory", `${T}/repo`]])],
  ] as Array<[string, string, Record<string, string>]>) {
    it(`assumed different owner: ${name}`, async () => {
      const full = join(T, path);
      const e = { ...DIFFERENT, ...env };
      expect(await ourOpen(full, e)).toEqual(nativeReceivePack(full, e));
    });
  }

  it.skipIf(!asRoot)("as uid 65534", async () => {
    for (const path of ["repo", "bare.git", "wt"]) {
      const full = join(T, path);
      expect(await ourOpen(full, {}, 65534)).toEqual(nativeReceivePack(full, {}, 65534));
    }
  });

  it("is a no-op without an effective uid, and skipped with checkOwnership: false", async () => {
    const files = createNodeFilesApi({ rootDir: "/" });
    const { history } = await createGitFilesBackend({ files, gitDir: `${T}/repo/.git` });
    const make = (effectiveUid: number | null) =>
      new FileWorktree({
        files,
        rootPath: T,
        gitDir: `${T}/repo/.git`,
        blobs: history.blobs,
        trees: history.trees,
        environment: createNodeGitHostEnvironment({ env: BASE_ENV, effectiveUid }),
      });
    expect(await make(null).openRepository(join(T, "repo"))).toBeDefined();
    const other = process.getuid?.() === 0 ? 65534 : 0;
    await expect(make(other).openRepository(join(T, "repo"))).rejects.toThrow(
      "detected dubious ownership",
    );
    const opened = await make(other).openRepository(join(T, "repo"), { checkOwnership: false });
    expect(opened).toBeDefined();
    await expect(opened?.checkOwnership?.()).rejects.toThrow("detected dubious ownership");
  });
});

describe("the protected configuration has no git directory (read_protected_config)", () => {
  // conditions of the global file's includes, each bringing in safe.directory=*
  const inc = () => join(T, "inc-safe");
  const globalWith = (name: string, text: string) => {
    const file = join(T, `global-${name}`);
    writeFileSync(inc(), "[safe]\n\tdirectory = *\n");
    writeFileSync(file, text);
    execFileSync("chmod", ["a+r", file, inc()]);
    return { GIT_CONFIG_GLOBAL: file };
  };
  const cases: Array<[string, string, Record<string, string>]> = [
    ["gitdir:/", `[includeIf "gitdir:/"]\n\tpath = ${join(T, "inc-safe")}\n`, {}],
    ["gitdir:**", `[includeIf "gitdir:**"]\n\tpath = ${join(T, "inc-safe")}\n`, {}],
    ["gitdir/i:/", `[includeIf "gitdir/i:/"]\n\tpath = ${join(T, "inc-safe")}\n`, {}],
    ["onbranch:**", `[includeIf "onbranch:**"]\n\tpath = ${join(T, "inc-safe")}\n`, {}],
    [
      "hasconfig on a global remote URL",
      `[remote "o"]\n\turl = https://example.com/x\n[includeIf "hasconfig:remote.*.url:https://example.com/**"]\n\tpath = ${join(T, "inc-safe")}\n`,
      {},
    ],
    [
      "hasconfig on a command-line remote URL",
      `[includeIf "hasconfig:remote.*.url:https://example.com/**"]\n\tpath = ${join(T, "inc-safe")}\n`,
      { GIT_CONFIG_PARAMETERS: "'remote.o.url'='https://example.com/x'" },
    ],
    [
      "hasconfig on no matching URL",
      `[remote "o"]\n\turl = https://other.example/x\n[includeIf "hasconfig:remote.*.url:https://example.com/**"]\n\tpath = ${join(T, "inc-safe")}\n`,
      {},
    ],
  ];
  for (const [name, text, extra] of cases) {
    it(`includeIf "${name}" in the global file`, async () => {
      const cwd = join(T, "repo");
      const env = { ...DIFFERENT, ...globalWith(name.replace(/[^a-z]/gi, "-"), text), ...extra };
      expect(await ours(cwd, env)).toEqual(native(cwd, env));
    });
  }

  it("gitdir:/ and gitdir:** are refused as dubious ownership", async () => {
    const cwd = join(T, "repo");
    for (const pattern of ["/", "**"]) {
      const env = {
        ...DIFFERENT,
        ...globalWith(
          `refused${pattern.length}`,
          `[includeIf "gitdir:${pattern}"]\n\tpath = ${inc()}\n`,
        ),
      };
      const outcome = native(cwd, env);
      expect(outcome.exit).toBe(128);
      expect(outcome.stderr).toContain("detected dubious ownership");
      expect(await ours(cwd, env)).toEqual(outcome);
    }
  });

  it("a remote URL in a file hasconfig brings in is fatal", async () => {
    const cwd = join(T, "repo");
    const bad = join(T, "inc-remote");
    writeFileSync(bad, '[remote "p"]\n\turl = https://example.com/y\n');
    execFileSync("chmod", ["a+r", bad]);
    const env = {
      ...DIFFERENT,
      ...globalWith(
        "forbidden",
        `[remote "o"]\n\turl = https://example.com/x\n[includeIf "hasconfig:remote.*.url:https://example.com/**"]\n\tpath = ${bad}\n`,
      ),
    };
    expect(await ours(cwd, env)).toEqual(native(cwd, env));
  });
});

describe("unparseable command-line config is fatal (git_config_from_parameters)", () => {
  const cases: Array<[string, Record<string, string>]> = [
    ["'safe.directory=' junk", { GIT_CONFIG_PARAMETERS: "'safe.directory=' junk" }],
    [
      "COUNT=2 with only pair 0",
      { GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: "*" },
    ],
    ["COUNT=1 without a value", { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory" }],
    ["'=x'", { GIT_CONFIG_PARAMETERS: "'=x'" }],
    ["bad", { GIT_CONFIG_PARAMETERS: "bad" }],
    [
      'COUNT="1 "',
      { GIT_CONFIG_COUNT: "1 ", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: "*" },
    ],
    ["COUNT=x", { GIT_CONFIG_COUNT: "x" }],
    ["COUNT=-1", { GIT_CONFIG_COUNT: "-1" }],
    [
      "a key without a section",
      { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "bad", GIT_CONFIG_VALUE_0: "x" },
    ],
    ["an invalid key", { GIT_CONFIG_PARAMETERS: "'a.1b=x'" }],
    ["a tab separator", { GIT_CONFIG_PARAMETERS: "'a.b=1'\t'safe.directory=*'" }],
    ["a newline separator", { GIT_CONFIG_PARAMETERS: "'a.b=1'\n'safe.directory=*'" }],
    ["a vertical tab separator", { GIT_CONFIG_PARAMETERS: "'a.b=1'\v'safe.directory=*'" }],
    ["a leading space", { GIT_CONFIG_PARAMETERS: " 'safe.directory=*'" }],
    ["new style with a quoted value", { GIT_CONFIG_PARAMETERS: "'safe.directory'='*'" }],
    ["new style without a value", { GIT_CONFIG_PARAMETERS: "'safe.directory'= 'x.y=1'" }],
    ["new style with junk", { GIT_CONFIG_PARAMETERS: "'safe.directory'=*" }],
  ];
  for (const [name, env] of cases) {
    it(name, async () => {
      const cwd = join(T, "repo");
      const full = { ...DIFFERENT, ...env };
      expect(await ours(cwd, full)).toEqual(native(cwd, full));
    });
  }

  it("refuses with git's lines (the cases are not all one outcome)", () => {
    const cwd = join(T, "repo");
    expect(native(cwd, { ...DIFFERENT, GIT_CONFIG_PARAMETERS: "bad" })).toEqual({
      exit: 128,
      stderr:
        "error: bogus format in GIT_CONFIG_PARAMETERS\nfatal: unable to parse command-line config\n",
    });
    expect(
      native(cwd, { ...DIFFERENT, GIT_CONFIG_PARAMETERS: "'a.b=1'\t'safe.directory=*'" }).exit,
    ).toBe(0);
  });
});

describe("safe.directory paths git cannot normalize or expand", () => {
  for (const [name, entries] of [
    ["a missing directory with /*/", [["safe.directory", `${T}/missing/*/`]]],
    ["the parent with /*/", [["safe.directory", `${T}/*/`]]],
    [
      "~nobody/ after *",
      [
        ["safe.directory", "*"],
        ["safe.directory", "~nobody/x"],
      ],
    ],
    ["~nobody/ alone", [["safe.directory", "~nobody/x"]]],
    ["an unknown ~user/", [["safe.directory", "~no-such-user-here/x"]]],
  ] as Array<[string, Array<[string, string]>]>) {
    it(name, async () => {
      const cwd = join(T, "repo");
      const env = { ...DIFFERENT, ...commandLine(entries) };
      expect(await ours(cwd, env)).toEqual(native(cwd, env));
    });
  }

  it("skips a ~user/ entry where the host cannot expand it", async () => {
    const files = createNodeFilesApi({ rootDir: "/" });
    const base = createNodeGitHostEnvironment({
      env: {
        ...BASE_ENV,
        ...DIFFERENT,
        ...commandLine([
          ["safe.directory", "*"],
          ["safe.directory", "~nobody/x"],
        ]),
      },
    });
    const { expandUserHome: _, ...environment } = base;
    const found = await discoverRepository({
      files,
      cwd: join(T, "repo"),
      environment,
      compatibility,
    });
    expect(found.gitDir).toBe(join(T, "repo", ".git"));
  });
});

describe("enter_repo checks the owner before reading the repository", () => {
  it("a bare repository with a broken config, as another owner", async () => {
    const bare = join(T, "broken-config.git");
    git(T, ["init", "-q", "--bare", bare]);
    writeFileSync(join(bare, "config"), "[core\n");
    execFileSync("chmod", ["-R", "a+rX", bare]);
    const files = createNodeFilesApi({ rootDir: "/" });
    const environment = createNodeGitHostEnvironment({ env: { ...BASE_ENV, ...DIFFERENT } });
    const { history } = await createGitFilesBackend({ files, gitDir: `${T}/repo/.git` });
    const worktree = new FileWorktree({
      files,
      rootPath: T,
      gitDir: `${T}/repo/.git`,
      blobs: history.blobs,
      trees: history.trees,
      environment,
    });
    let ourOutcome: Outcome;
    try {
      await worktree.openRepository(bare, { compatibility });
      ourOutcome = { exit: 0, stderr: "" };
    } catch (error) {
      ourOutcome = { exit: 128, stderr: `${(error as Error).message}\n` };
    }
    const run = spawnSync("git", ["receive-pack", "--advertise-refs", bare], {
      cwd: T,
      env: { ...BASE_ENV, ...DIFFERENT },
    });
    const nativeOutcome = { exit: run.status ?? -1, stderr: run.stderr.toString() };
    expect(nativeOutcome.stderr).toContain("detected dubious ownership");
    expect(ourOutcome).toEqual(nativeOutcome);
  });
});
