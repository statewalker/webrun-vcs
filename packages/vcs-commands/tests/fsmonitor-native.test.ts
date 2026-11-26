/**
 * The file system monitor (`core.fsmonitor`, the `FSMN` index extension) against native git,
 * with t7519-status-fsmonitor.sh's scenarios: from one index, native `git status` / `git add`
 * and ours, given the same monitor answers (t7519's hook scripts, run by both), must print the
 * same status and write the same index bytes, the `FSMN` token and dirty bitmap included.
 *
 * The twins share one repository: the index (bytes and mtime) is put back before the second
 * run. Worktree files are dated back, so no entry is racily clean. A hook answering with the
 * protocol version 1 makes git's token a nanosecond time: those indexes are compared with the
 * token's digits zeroed.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createNodeGitHostEnvironment,
  createNodeHookRunner,
} from "@statewalker/vcs-utils-node/files";
import {
  type FsmonitorQuery,
  type GitHostEnvironment,
  parseFsmonitorExtension,
  parseIndexFile,
} from "@statewalker/vcs-working-tree";
import { serveDuplexOverPort } from "@statewalker/webrun-rpc";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  encodePacketized,
  formatStatusPorcelain,
  queryFsmonitorDaemon,
  ResetMode,
  type UpdateIndexCommand,
} from "../src/index.js";
import { nativeIs25x } from "./hooks-native-support.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";
import { openBare } from "./plumbing-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

/** Whether native git is built with the builtin daemon (`feature: fsmonitor--daemon`). */
const nativeHasDaemon =
  nativeGitAvailable() &&
  /fsmonitor--daemon/.test(execFileSync("git", ["version", "--build-options"]).toString());

let root: string;
let dir: string;
const env = (extra: Record<string, string> = {}) => ({ ...nativeGitEnv(root), ...extra });
const git = (args: string[], extra?: Record<string, string>) =>
  execFileSync("git", args, {
    cwd: dir,
    env: env(extra),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
const put = (path: string, content: string) => {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), content);
};

/** t7519's `write_integration_script`: version 2, every path dirty_repo touches. */
const INTEGRATION = `#!/bin/sh
if test "$#" -ne 2
then
	echo "$0: exactly 2 arguments expected"
	exit 2
fi
if test "$1" != 2
then
	echo "Unsupported core.fsmonitor hook version." >&2
	exit 1
fi
printf "last_update_token\\0"
printf "untracked\\0"
printf "dir1/untracked\\0"
printf "dir2/untracked\\0"
printf "modified\\0"
printf "dir1/modified\\0"
printf "dir2/modified\\0"
printf "new\\0"
printf "dir1/new\\0"
printf "dir2/new\\0"
`;

/** A version 2 hook answering its token and nothing changed (t7519's `printf "last_update_token\0"`). */
const NOTHING = `#!/bin/sh
printf "last_update_token\\0"
`;

/** A version 2 hook answering the paths `report` listed (`.git/fsm-list`). */
const LISTED = `#!/bin/sh
printf "listed_token\\0"
cat .git/fsm-list 2>/dev/null
`;
function report(paths: string[]) {
  writeFileSync(join(dir, ".git/fsm-list"), paths.map((p) => `${p}\0`).join(""));
}

/** t7519/fsmonitor-all: version 1 only, the trivial answer (everything may have changed). */
const ALL_V1 = `#!/bin/sh
if test "$#" -ne 2
then
	echo "$0: exactly 2 arguments expected" >&2
	exit 2
fi
if test "$1" != 1
then
	exit 1
fi
echo "/"
`;

function hook(script: string) {
  const path = join(dir, ".git/hooks/fsmonitor-test");
  mkdirSync(join(dir, ".git/hooks"), { recursive: true });
  writeFileSync(path, script);
  chmodSync(path, 0o755);
}

let back = 0;
/** Every worktree file and directory dated back (a second never used before). */
function dateBack() {
  back++;
  const when = Math.floor(Date.now() / 1000) - 100_000 + back;
  const walk = (rel: string) => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      if (entry.name === ".git" && rel === "") continue;
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path);
      utimesSync(join(dir, path), when, when);
    }
  };
  walk("");
  utimesSync(dir, when, when);
}

/** t7519's `dirty_repo`. */
function dirtyRepo() {
  put("untracked", "");
  put("dir1/untracked", "");
  put("dir2/untracked", "");
  put("modified", "1\n");
  put("dir1/modified", "2\n");
  put("dir2/modified", "3\n");
  put("new", "4\n");
  put("dir1/new", "5\n");
  put("dir2/new", "6\n");
  dateBack();
}

/** t7519's `clean_repo`. */
function cleanRepo() {
  git(["-c", "core.fsmonitor=", "reset", "--hard", "-q", "HEAD"]);
  git(["-c", "core.fsmonitor=", "clean", "-fdq"]);
  dateBack();
}

/** Our host: native git's environment and a hook runner of its version. */
function host(extra: Partial<GitHostEnvironment> = {}): GitHostEnvironment {
  const e = env();
  return {
    ...createNodeGitHostEnvironment({
      env: e,
      hookRunner: createNodeHookRunner({ env: e, compatibility: nativeIs25x ? "2.56" : "2.43" }),
    }),
    ...extra,
  };
}

const indexPath = () => join(dir, ".git/index");
function saveIndex() {
  return { bytes: readFileSync(indexPath()), mtime: statSync(indexPath()).mtime };
}
function restoreIndex(saved: ReturnType<typeof saveIndex>) {
  writeFileSync(indexPath(), saved.bytes);
  utimesSync(indexPath(), saved.mtime, saved.mtime);
}

/** The index's bytes, a version 1 hook's nanosecond token zeroed (and so the trailer). */
function normalized(bytes: Buffer, zeroToken: boolean): string {
  if (!zeroToken) return bytes.toString("hex");
  const out = Buffer.from(bytes);
  const at = out.lastIndexOf(Buffer.from("FSMN"));
  if (at >= 0) {
    for (let i = at + 12; i < out.length && out[i] !== 0; i++) out[i] = 0x30;
  }
  return out.subarray(0, out.length - 20).toString("hex");
}

async function fsmnOf(bytes: Buffer) {
  const parsed = await parseIndexFile(new Uint8Array(bytes));
  const ext = parsed.extensionData.find((e) => e.signature === "FSMN");
  return ext ? parseFsmonitorExtension(ext.data, parsed.entries.length) : undefined;
}

/**
 * Native `git status` and ours from the index as it is: the same porcelain output and index
 * bytes. The index native git wrote is kept afterwards (`keep: "native"`) or ours.
 */
async function statusTwins(
  options: { zeroToken?: boolean; keep?: "native" | "ours"; host?: GitHostEnvironment } = {},
) {
  const saved = saveIndex();
  const nativeOut = git(["status", "--porcelain"]);
  const nativeIndex = readFileSync(indexPath());
  restoreIndex(saved);
  const ours = await openOurs(dir, options.host ?? host());
  const status = await ours.status().call();
  const oursIndex = readFileSync(indexPath());
  expect(formatStatusPorcelain(status)).toBe(nativeOut);
  expect(normalized(oursIndex, !!options.zeroToken)).toBe(
    normalized(nativeIndex, !!options.zeroToken),
  );
  if ((options.keep ?? "native") === "native") writeFileSync(indexPath(), nativeIndex);
  return { nativeOut, nativeIndex, oursIndex, status };
}

/** Our `git ls-files -f`. */
async function oursLsFilesF(): Promise<string> {
  const out = await (await openOurs(dir, host())).lsFiles().setShowFsmonitorBit(true).callOutput();
  return Buffer.from(out.stdout).toString("latin1");
}

/** Native `git update-index <args>` as a process: its exit status, stderr and index. */
function nativeUpdateIndex(args: string[], cwd = dir) {
  const run = spawnSync("git", ["update-index", ...args], { cwd, env: env(), encoding: "utf8" });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

/** Our `git update-index` as a process: git's exit status, stderr and stdout. */
async function oursUpdateIndex(
  build: (command: UpdateIndexCommand) => UpdateIndexCommand,
  git = openOurs(dir, host()),
) {
  try {
    const result = await build((await git).updateIndex()).call();
    return { status: result.exitCode, stdout: result.output, stderr: result.errors };
  } catch (error) {
    const e = error as { exitCode?: number; message: string; output?: string };
    return { status: e.exitCode ?? -1, stdout: e.output ?? "", stderr: `${e.message}\n` };
  }
}

/**
 * Native `git update-index <args>` and ours (`build`) from the index as it is: the same exit
 * status, stdout, stderr and index bytes (a nanosecond token zeroed with `zeroToken`). The
 * index native git wrote is kept.
 */
async function updateIndexTwins(
  args: string[],
  build: (command: UpdateIndexCommand) => UpdateIndexCommand,
  options: { zeroToken?: boolean } = {},
) {
  const saved = saveIndex();
  const native = nativeUpdateIndex(args);
  const nativeIndex = readFileSync(indexPath());
  restoreIndex(saved);
  const ours = await oursUpdateIndex(build);
  const oursIndex = readFileSync(indexPath());
  expect(ours).toEqual(native);
  expect(normalized(oursIndex, !!options.zeroToken)).toBe(
    normalized(nativeIndex, !!options.zeroToken),
  );
  writeFileSync(indexPath(), nativeIndex);
  return { native, nativeIndex, oursIndex };
}

/**
 * A fake builtin daemon on `MessageChannel`s (no socket): each port opened is served one
 * simple-ipc exchange, the request's token recorded and `answer(token)` sent back as
 * pkt-lines and a flush (or `undefined`: the daemon hangs up before answering).
 */
function fakeDaemon(answer: (token: string) => Uint8Array | undefined) {
  const tokens: string[] = [];
  const paths: string[] = [];
  const open = async (request: { path: string }) => {
    paths.push(request.path);
    const { port1, port2 } = new MessageChannel();
    serveDuplexOverPort(port1, (input) =>
      (async function* () {
        let buffered = Buffer.alloc(0);
        let token = "";
        const reader = (input as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
        outer: for (;;) {
          while (buffered.length >= 4) {
            const length = Number.parseInt(buffered.subarray(0, 4).toString(), 16);
            if (length === 0) break outer;
            if (buffered.length < length) break;
            token += buffered.subarray(4, length).toString();
            buffered = buffered.subarray(length);
          }
          const next = await reader.next();
          if (next.done) return;
          buffered = Buffer.concat([buffered, next.value]);
        }
        tokens.push(token);
        const bytes = answer(token);
        if (bytes) yield encodePacketized(bytes);
      })(),
    );
    port1.start();
    return port2;
  };
  return { tokens, paths, open };
}

/** Our host with `core.fsmonitor=true` on its command line and `openIpcPort` replaced. */
function ipcHost(openIpcPort: GitHostEnvironment["openIpcPort"]): GitHostEnvironment {
  const e = env();
  const n = Number(e.GIT_CONFIG_COUNT ?? 0);
  const withIpc = {
    ...e,
    GIT_CONFIG_COUNT: String(n + 1),
    [`GIT_CONFIG_KEY_${n}`]: "core.fsmonitor",
    [`GIT_CONFIG_VALUE_${n}`]: "true",
  };
  return {
    ...createNodeGitHostEnvironment({
      env: withIpc,
      hookRunner: createNodeHookRunner({
        env: withIpc,
        compatibility: nativeIs25x ? "2.56" : "2.43",
      }),
    }),
    ...(openIpcPort ? { openIpcPort } : {}),
  };
}

const INTEGRATION_ANSWER = new TextEncoder().encode(
  "last_update_token\0untracked\0dir1/untracked\0dir2/untracked\0modified\0dir1/modified\0dir2/modified\0new\0dir1/new\0dir2/new\0",
);

/** The full-scan status native git prints without the monitor. */
const withoutMonitor = () => git(["-c", "core.fsmonitor=", "status", "--porcelain"]);

describeGit("fsmonitor against native git (t7519-status-fsmonitor.sh)", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "fsmonitor-native-"));
    dir = join(root, "repo");
    mkdirSync(dir);
    git(["init", "-q", "-b", "main"]);
    // t7519-status-fsmonitor.sh: "setup"
    put("tracked", "");
    put("modified", "");
    put("dir1/tracked", "");
    put("dir1/modified", "");
    put("dir2/tracked", "");
    put("dir2/modified", "");
    git(["-c", "core.fsmonitor=", "add", "."]);
    git(["-c", "core.fsmonitor=", "commit", "-qm", "initial"]);
    git(["config", "core.fsmonitor", ".git/hooks/fsmonitor-test"]);
    put(".gitignore", ".gitignore\nexpect*\nactual*\nmarker*\n");
    dateBack();
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  for (const uc of [false, true]) {
    it(`t7519-status-fsmonitor.sh: "compare status with and without fsmonitor" (untrackedCache=${uc})`, async () => {
      git(["config", "core.untrackedcache", String(uc)]);
      hook(INTEGRATION);
      cleanRepo();
      dirtyRepo();
      git(["add", "new", "dir1/new", "dir2/new"]);
      dateBack();
      // the first status adds the extension, the second reads it
      const first = await statusTwins();
      expect(first.nativeOut).toBe(withoutMonitor());
      expect((await fsmnOf(first.oursIndex))?.token).toBe("last_update_token");
      const second = await statusTwins({ keep: "ours" });
      expect(second.nativeOut).toBe(withoutMonitor());
    });

    it(`t7519-status-fsmonitor.sh: "status doesn't detect unreported modifications" (untrackedCache=${uc})`, async () => {
      git(["config", "core.untrackedcache", String(uc)]);
      hook(NOTHING);
      cleanRepo();
      await statusTwins();
      await statusTwins({ keep: "ours" });
      dirtyRepo();
      // nothing reported: the modified files are taken as up to date, and with the untracked
      // cache its valid directories are not read again
      const { nativeOut } = await statusTwins();
      expect(nativeOut).not.toContain(" M ");
      if (uc) expect(nativeOut).not.toContain("??");
      else expect(nativeOut).toContain("?? untracked");
    });
  }

  it('t7519-status-fsmonitor.sh: "newly added files are marked valid"', async () => {
    hook(NOTHING);
    dirtyRepo();
    await statusTwins();
    const saved = saveIndex();
    git(["add", "new", "dir1/new", "dir2/new"]);
    const nativeIndex = readFileSync(indexPath());
    restoreIndex(saved);
    const ours = await openOurs(dir, host());
    await ours
      .add()
      .addFilepattern("new")
      .addFilepattern("dir1/new")
      .addFilepattern("dir2/new")
      .call();
    expect(readFileSync(indexPath()).toString("hex")).toBe(nativeIndex.toString("hex"));
    // native git reads our bits as its own, and our ls-files -f lists them as native's
    expect(git(["ls-files", "-f"])).toContain("h dir1/new\n");
    expect(await oursLsFilesF()).toBe(git(["ls-files", "-f"]));
  });

  it('t7519-status-fsmonitor.sh: "all files returned by integration script get flagged as invalid"', async () => {
    hook(NOTHING);
    // the first status stores the stats the files were dated back to (entries replaced:
    // dirty), the second marks them valid
    await statusTwins();
    expect(await oursLsFilesF()).toBe(git(["ls-files", "-f"]));
    await statusTwins({ keep: "ours" });
    expect(await oursLsFilesF()).toBe(git(["ls-files", "-f"]));
    expect(git(["ls-files", "-f"])).toContain("h dir1/tracked\n");
    hook(INTEGRATION);
    dirtyRepo();
    // reading the index asks the monitor: the paths it names are listed uppercase
    const native = git(["ls-files", "-f"]);
    expect(native).toContain("H modified\n");
    expect(await oursLsFilesF()).toBe(native);
  });

  it('t7519-status-fsmonitor.sh: "refresh_index() invalidates fsmonitor cache"', async () => {
    hook(INTEGRATION);
    cleanRepo();
    dirtyRepo();
    git(["add", "."]);
    hook("#!/bin/sh\n");
    git(["commit", "-qm", "to reset"]);
    git(["reset", "-q", "HEAD~1"]);
    dateBack();
    // an empty answer: "Empty last update token.", every entry checked, the token empty
    const { nativeOut, status } = await statusTwins();
    expect(nativeOut).toBe(withoutMonitor());
    expect(status.warnings ?? []).toContain("warning: Empty last update token.");
  });

  it("a version 1 hook's trivial answer (t7519/fsmonitor-all) checks every entry", async () => {
    hook(ALL_V1);
    dirtyRepo();
    // version 2 fails, version 1 answers "/": every entry checked, a nanosecond token
    const first = await statusTwins({ zeroToken: true });
    expect(first.nativeOut).toBe(withoutMonitor());
    await statusTwins({ zeroToken: true, keep: "ours" });
  });

  it("a failing hook checks every entry (core.fsmonitorHookVersion=2: an empty token)", async () => {
    hook("#!/bin/sh\nexit 1\n");
    git(["config", "core.fsmonitorHookVersion", "2"]);
    dirtyRepo();
    const first = await statusTwins();
    expect(first.nativeOut).toBe(withoutMonitor());
    expect((await fsmnOf(first.oursIndex))?.token).toBe("");
    await statusTwins({ keep: "ours" });
  });

  // git 2.5x on Linux has the builtin daemon (and would start one): only a git without it
  // fails the IPC query as ours does without a host monitor
  it.skipIf(nativeHasDaemon)(
    "core.fsmonitor=true without the builtin daemon: the token builtin:fake",
    async () => {
      git(["config", "core.fsmonitor", "true"]);
      dirtyRepo();
      const first = await statusTwins();
      expect((await fsmnOf(first.oursIndex))?.token).toBe("builtin:fake");
      await statusTwins({ keep: "ours" });
    },
  );

  it("the monitor turned off removes the extension", async () => {
    hook(NOTHING);
    await statusTwins();
    git(["config", "core.fsmonitor", ""]);
    const { oursIndex } = await statusTwins();
    expect(await fsmnOf(oursIndex)).toBeUndefined();
  });

  it('t7519-status-fsmonitor.sh: "splitting the index results in the same state"', async () => {
    hook(INTEGRATION);
    git(["config", "core.splitIndex", "true"]);
    dirtyRepo();
    // the split files' entries differ from native git's by their racy stat handling (with
    // or without the monitor): the FSMN payloads and the bits native git reads are compared
    for (let round = 0; round < 2; round++) {
      const saved = saveIndex();
      const nativeOut = git(["status", "--porcelain"]);
      const nativeFsmn = await fsmnOf(readFileSync(indexPath()));
      const nativeBits = git(["ls-files", "-f"]);
      restoreIndex(saved);
      const status = await (await openOurs(dir, host())).status().call();
      expect(formatStatusPorcelain(status)).toBe(nativeOut);
      expect(await fsmnOf(readFileSync(indexPath()))).toEqual(nativeFsmn);
      expect(git(["ls-files", "-f"])).toBe(nativeBits);
    }
    expect(git(["ls-files", "-f"])).toContain("h dir1/tracked\n");
  });

  it("one working copy asks the monitor again for each command (a later change is seen)", async () => {
    hook(LISTED);
    report([]);
    await statusTwins();
    await statusTwins({ keep: "ours" });
    const ours = await openOurs(dir, host());
    expect(formatStatusPorcelain(await ours.status().call())).toBe("");
    put("modified", "changed\n");
    dateBack();
    report(["modified"]);
    const native = git(["status", "--porcelain"]);
    expect(native).toContain(" M modified");
    expect(formatStatusPorcelain(await ours.status().call())).toBe(native);
  });

  it("add writes the monitor's untracked-cache invalidations with its new token", async () => {
    git(["config", "core.untrackedcache", "true"]);
    git(["config", "status.showUntrackedFiles", "all"]);
    hook(LISTED);
    report([]);
    await statusTwins();
    await statusTwins({ keep: "ours" });
    put("dir1/fresh", "x\n");
    put("modified", "changed\n");
    dateBack();
    report(["dir1/fresh", "modified"]);
    const saved = saveIndex();
    git(["add", "modified"]);
    const nativeIndex = readFileSync(indexPath());
    restoreIndex(saved);
    await (await openOurs(dir, host())).add().addFilepattern("modified").call();
    expect(readFileSync(indexPath()).toString("hex")).toBe(nativeIndex.toString("hex"));
    // the monitor has nothing more to say: the new file is still found
    report([]);
    expect(git(["status", "--porcelain"])).toContain("?? dir1/fresh");
  });

  it("with the monitor off, any index write drops the extension (tweak_fsmonitor)", async () => {
    hook(NOTHING);
    await statusTwins();
    git(["config", "core.fsmonitor", ""]);
    put("modified", "changed\n");
    const ours = await openOurs(dir, host());
    await ours.add().addFilepattern("modified").call();
    expect(await fsmnOf(readFileSync(indexPath()))).toBeUndefined();
    await ours.reset().call();
    expect(await fsmnOf(readFileSync(indexPath()))).toBeUndefined();
  });

  it(`t7519-status-fsmonitor.sh: 'update-index --fsmonitor" adds the fsmonitor extension'`, async () => {
    hook(NOTHING);
    const { oursIndex } = await updateIndexTwins(["--fsmonitor"], (c) => c.setFsmonitor(true));
    expect((await fsmnOf(oursIndex))?.token).toBe("last_update_token");
    // asked again (the extension read): nothing to write, nothing printed
    await updateIndexTwins(["--fsmonitor", "--verbose"], (c) =>
      c.setVerbose(true).setFsmonitor(true),
    );
  });

  it(`t7519-status-fsmonitor.sh: 'update-index --no-fsmonitor" removes the fsmonitor extension'`, async () => {
    hook(NOTHING);
    await updateIndexTwins(["--fsmonitor"], (c) => c.setFsmonitor(true));
    // core.fsmonitor still set: git's warning, the extension removed
    const { oursIndex, native } = await updateIndexTwins(["--verbose", "--no-fsmonitor"], (c) =>
      c.setVerbose(true).setFsmonitor(false),
    );
    expect(native.stderr).toContain("core.fsmonitor is set");
    expect(await fsmnOf(oursIndex)).toBeUndefined();
  });

  it("update-index --fsmonitor with core.fsmonitor unset: the warning, a nanosecond token", async () => {
    git(["config", "core.fsmonitor", ""]);
    const { native, oursIndex } = await updateIndexTwins(
      ["--fsmonitor"],
      (c) => c.setFsmonitor(true),
      { zeroToken: true },
    );
    expect(native.stderr).toContain("core.fsmonitor is unset");
    expect((await fsmnOf(oursIndex))?.token).toMatch(/^[0-9]+$/);
    // the next read with the monitor off removes it again
    await updateIndexTwins(["--no-fsmonitor"], (c) => c.setFsmonitor(false));
    await updateIndexTwins(["--fsmonitor"], (c) => c.setFsmonitor(true), { zeroToken: true });
    await updateIndexTwins([], (c) => c, { zeroToken: true });
  });

  it(`t7519-status-fsmonitor.sh: 'update-index --fsmonitor-valid" sets the fsmonitor valid bit'`, async () => {
    hook(NOTHING);
    await updateIndexTwins(["--fsmonitor"], (c) => c.setFsmonitor(true));
    for (const path of ["dir1/modified", "dir2/modified", "modified"]) {
      await updateIndexTwins(["--fsmonitor-valid", path], (c) =>
        c.setFsmonitorValid(true).addPath(path),
      );
    }
    expect(git(["ls-files", "-f"])).toBe(
      "h dir1/modified\nH dir1/tracked\nh dir2/modified\nH dir2/tracked\nh modified\nH tracked\n",
    );
    expect(await oursLsFilesF()).toBe(git(["ls-files", "-f"]));
    // t7519-status-fsmonitor.sh: 'update-index --no-fsmonitor-valid" clears the fsmonitor valid bit'
    for (const path of ["dir1/modified", "dir2/modified", "modified"]) {
      await updateIndexTwins(["--no-fsmonitor-valid", path], (c) =>
        c.setFsmonitorValid(false).addPath(path),
      );
    }
    expect(git(["ls-files", "-f"])).not.toContain("h ");
    // a path not in the index dies
    await updateIndexTwins(["--fsmonitor-valid", "nowhere"], (c) =>
      c.setFsmonitorValid(true).addPath("nowhere"),
    );
  });

  it("t7519-status-fsmonitor.sh: 'all unmodified files get marked valid'", async () => {
    hook(NOTHING);
    await updateIndexTwins(["--fsmonitor"], (c) => c.setFsmonitor(true));
    // the first refresh stores the dated-back stats (entries replaced: dirty), the second
    // marks them valid without --force-write-index
    await updateIndexTwins(["--refresh"], (c) => c.refresh());
    await updateIndexTwins(["--refresh"], (c) => c.refresh());
    expect(git(["ls-files", "-f"])).toContain("h dir1/tracked\n");
    expect(await oursLsFilesF()).toBe(git(["ls-files", "-f"]));
    await updateIndexTwins(["--refresh", "--force-write-index"], (c) =>
      c.refresh().setForceWriteIndex(true),
    );
  });

  it("t7519-status-fsmonitor.sh: '*only* files returned by the integration script get flagged as invalid'", async () => {
    hook(LISTED);
    report(["dir1/modified"]);
    cleanRepo();
    await updateIndexTwins(["--refresh", "--force-write-index"], (c) =>
      c.refresh().setForceWriteIndex(true),
    );
    await updateIndexTwins(["--refresh", "--force-write-index"], (c) =>
      c.refresh().setForceWriteIndex(true),
    );
    put("modified", "1\n");
    put("dir1/modified", "2\n");
    put("dir2/modified", "3\n");
    dateBack();
    // valid entries are not looked at: only the reported dir1/modified needs an update
    const { native } = await updateIndexTwins(["--refresh", "--force-write-index"], (c) =>
      c.refresh().setForceWriteIndex(true),
    );
    expect(native.stdout).toBe("dir1/modified: needs update\n");
    expect(native.status).toBe(1);
    expect(await oursLsFilesF()).toBe(git(["ls-files", "-f"]));
  });

  it("t7519-status-fsmonitor.sh: 'incompatible bare repo'", async () => {
    const bare = join(root, "bare-clone");
    execFileSync("git", ["init", "-q", "--bare", bare], { env: env() });
    for (const value of ["foo", "true"]) {
      execFileSync("git", ["config", "core.fsmonitor", value], { cwd: bare, env: env() });
      const native = nativeUpdateIndex(["--fsmonitor"], bare);
      expect(native.status).toBe(128);
      expect(native.stderr).toBe(
        `fatal: bare repository '${bare}' is incompatible with fsmonitor\n`,
      );
      const ours = await oursUpdateIndex((c) => c.setFsmonitor(true), openBare(bare, host()));
      expect(ours).toEqual(native);
    }
  });

  it("diff-files and git diff take entries the monitor reported nothing for as unchanged", async () => {
    hook(LISTED);
    report([]);
    await statusTwins();
    await statusTwins({ keep: "ours" });
    put("modified", "changed\n");
    put("dir1/modified", "changed\n");
    dateBack();
    // nothing reported: neither change is seen, by native git or ours; then each one reported
    for (const reported of [[], ["dir1/modified"], ["modified", "dir1/"]]) {
      report(reported);
      const saved = saveIndex();
      const nativeFiles = git(["diff-files", "--name-only"]);
      const nativeDiff = git(["diff", "--name-only"]);
      restoreIndex(saved);
      const ours = await openOurs(dir, host());
      expect(await ours.diffFiles().setFormats(["name-only"]).callText()).toBe(nativeFiles);
      restoreIndex(saved);
      expect(await (await openOurs(dir, host())).diff().callText("name-only")).toBe(nativeDiff);
      restoreIndex(saved);
      expect(nativeDiff.split("\n").filter(Boolean)).toEqual(
        reported.length === 0
          ? []
          : reported.length === 1
            ? ["dir1/modified"]
            : ["dir1/modified", "modified"],
      );
    }
  });

  it("diff-index sees an fsmonitor-valid file deleted only as 2.43 does, diff-files never", async () => {
    hook(NOTHING);
    await updateIndexTwins(["--fsmonitor"], (c) => c.setFsmonitor(true));
    await updateIndexTwins(["--fsmonitor-valid", "modified", "tracked"], (c) =>
      c.setFsmonitorValid(true).addPath("modified").addPath("tracked"),
    );
    rmSync(join(dir, "tracked"));
    put("modified", "changed\n");
    dateBack();
    const saved = saveIndex();
    const nativeIndexDiff = git(["diff-index", "--name-status", "HEAD"]);
    restoreIndex(saved);
    const nativeDiffHead = git(["diff", "--name-status", "HEAD"]);
    restoreIndex(saved);
    const nativeFiles = git(["diff-files", "--name-status"]);
    // the valid entries: the modified one never listed, the deleted one only by 2.43, whose
    // check_removed still lstats it (2.5x: fake_lstat); other entries' stats were dated back
    if (nativeIs25x) expect(nativeIndexDiff).not.toContain("\ttracked\n");
    else expect(nativeIndexDiff).toContain("D\ttracked\n");
    expect(nativeIndexDiff).not.toMatch(/^M\tmodified$/m);
    expect(nativeFiles).not.toMatch(/\t(tracked|modified)$/m);
    restoreIndex(saved);
    const ours = await openOurs(dir, host());
    expect(await ours.diffIndex().setTree("HEAD").setFormats(["name-status"]).callText()).toBe(
      nativeIndexDiff,
    );
    restoreIndex(saved);
    expect(
      await (await openOurs(dir, host())).diff().setOldTree("HEAD").callText("name-status"),
    ).toBe(nativeDiffHead);
    restoreIndex(saved);
    expect(
      await (await openOurs(dir, host())).diffFiles().setFormats(["name-status"]).callText(),
    ).toBe(nativeFiles);
  });

  it("commit -a leaves a change the monitor reported nothing for unstaged", async () => {
    hook(LISTED);
    report([]);
    await statusTwins();
    await statusTwins({ keep: "ours" });
    put("modified", "changed\n");
    put("dir1/modified", "changed\n");
    dateBack();
    report(["dir1/modified"]);
    const head = git(["rev-parse", "HEAD"]).trim();
    const saved = saveIndex();
    git(["commit", "-qam", "native"]);
    const nativeTree = git(["rev-parse", "HEAD^{tree}"]);
    const nativeIndex = readFileSync(indexPath());
    git(["update-ref", "HEAD", head]);
    restoreIndex(saved);
    await (await openOurs(dir, host())).commit().setAll(true).setMessage("ours").call();
    expect(git(["rev-parse", "HEAD^{tree}"])).toBe(nativeTree);
    expect(git(["diff", "--name-only", "HEAD~1", "HEAD"])).toBe("dir1/modified\n");
    expect(normalized(readFileSync(indexPath()), false)).toBe(normalized(nativeIndex, false));
  });

  it("a host callback answers as the hook would, and a throwing one checks every entry", async () => {
    hook(INTEGRATION);
    dirtyRepo();
    const asked: FsmonitorQuery[] = [];
    const integration = new TextEncoder().encode(
      "last_update_token\0untracked\0dir1/untracked\0dir2/untracked\0modified\0dir1/modified\0dir2/modified\0new\0dir1/new\0dir2/new\0",
    );
    await statusTwins({
      host: host({
        fsmonitor: {
          query: async (q) => {
            asked.push(q);
            return { exitCode: 0, stdout: integration };
          },
        },
      }),
    });
    expect(asked.map((q) => [q.mode, q.command, q.version])).toEqual([
      ["hook", ".git/hooks/fsmonitor-test", 2],
    ]);
    // a callback that throws is a failed query: v2, then v1, the token a nanosecond time
    hook("#!/bin/sh\nexit 1\n");
    await statusTwins({
      zeroToken: true,
      host: host({
        fsmonitor: {
          query: async () => {
            throw new Error("watcher gone");
          },
        },
      }),
    });
  });
  it("the builtin daemon over a MessageChannel answers as the version 2 hook does", async () => {
    // native git runs t7519's integration hook; ours asks a fake daemon giving its bytes
    hook(INTEGRATION);
    cleanRepo();
    dirtyRepo();
    const daemon = fakeDaemon(() => INTEGRATION_ANSWER);
    const first = await statusTwins({ host: ipcHost(daemon.open) });
    expect((await fsmnOf(first.oursIndex))?.token).toBe("last_update_token");
    await statusTwins({ keep: "ours", host: ipcHost(daemon.open) });
    // add_fsmonitor leaves no token: git asks since builtin:fake, then since the answer's
    expect(daemon.tokens).toEqual(["builtin:fake", "last_update_token"]);
    expect(daemon.paths).toEqual([
      `${dir}/.git/fsmonitor--daemon.ipc`,
      `${dir}/.git/fsmonitor--daemon.ipc`,
    ]);
  });

  it("a daemon that hangs up, or none, is a failed query: the token builtin:fake", async () => {
    hook(INTEGRATION);
    cleanRepo();
    dirtyRepo();
    for (const open of [
      fakeDaemon(() => undefined).open,
      async () => {
        throw new Error("ENOENT");
      },
      undefined,
    ]) {
      const status = await (await openOurs(dir, ipcHost(open))).status().call();
      // read before native git's status without the monitor rewrites the index
      expect((await fsmnOf(readFileSync(indexPath())))?.token).toBe("builtin:fake");
      expect(formatStatusPorcelain(status)).toBe(withoutMonitor());
    }
  });

  it("queryFsmonitorDaemon sends a long token in several pkt-lines", async () => {
    const token = "t".repeat(70_000);
    const daemon = fakeDaemon((t) => new TextEncoder().encode(`${t.length}\0`));
    const port = await daemon.open({ path: "x" });
    const answer = await queryFsmonitorDaemon(port, token);
    expect(new TextDecoder().decode(answer)).toBe("70000\0");
    expect(daemon.tokens).toEqual([token]);
    // two pkt-lines (65516 bytes, then the rest) and a flush
    const encoded = encodePacketized(new TextEncoder().encode(token));
    expect(encoded.length).toBe(70_000 + 4 + 4 + 4);
    expect(Buffer.from(encoded.subarray(0, 4)).toString()).toBe("fff0");
  });

  it("update-index --fsmonitor-valid sets a gitlink's bit too (written as not dirty)", async () => {
    hook(NOTHING);
    const sub = "0123456789abcdef0123456789abcdef01234567";
    git(["update-index", "--add", "--cacheinfo", `160000,${sub},sub`]);
    await updateIndexTwins(["--fsmonitor"], (c) => c.setFsmonitor(true));
    await updateIndexTwins(["--fsmonitor-valid", "sub"], (c) =>
      c.setFsmonitorValid(true).addPath("sub"),
    );
  });

  /**
   * Native git and ours each run one index-writing command (`nativeArgs` / `ours`) from the
   * index and worktree as they are: the same `FSMN` payload, the same bits native git reads
   * (`ls-files -f`) and the same worktree file `checkFile` holds. Native git's result is kept.
   */
  async function commandTwins(
    nativeArgs: string[],
    ours: (git: Awaited<ReturnType<typeof openOurs>>) => Promise<unknown>,
    checkFile?: string,
    /** a version 1 token (a failed hook's nanosecond time) compared as digits */
    zeroToken = false,
  ) {
    const saved = saveIndex();
    const savedFile = checkFile ? readFileSync(join(dir, checkFile)) : undefined;
    const head = git(["rev-parse", "HEAD"]).trim();
    const branch = git(["symbolic-ref", "-q", "HEAD"]).trim();
    git(nativeArgs);
    const nativeIndex = readFileSync(indexPath());
    const nativeBits = git(["ls-files", "-f"]);
    const nativeFile = checkFile ? readFileSync(join(dir, checkFile), "latin1") : undefined;
    const nativeHead = git(["rev-parse", "HEAD"]).trim();
    const nativeBranch = git(["symbolic-ref", "-q", "HEAD"]).trim();
    // the worktree, refs and index put back for ours
    git(["-c", "core.fsmonitor=", "checkout", "-qf", branch.replace("refs/heads/", "")]);
    git(["update-ref", branch, head]);
    git(["-c", "core.fsmonitor=", "reset", "-q", "--hard", head]);
    if (checkFile && savedFile) {
      writeFileSync(join(dir, checkFile), savedFile);
      dateBack();
    }
    restoreIndex(saved);
    await ours(await openOurs(dir, host()));
    const oursIndex = readFileSync(indexPath());
    expect(git(["rev-parse", "HEAD"]).trim()).toBe(nativeHead);
    expect(git(["symbolic-ref", "-q", "HEAD"]).trim()).toBe(nativeBranch);
    const tokenless = async (bytes: Buffer) => {
      const fsmn = await fsmnOf(bytes);
      return fsmn && zeroToken ? { ...fsmn, token: fsmn.token.replace(/[0-9]/g, "0") } : fsmn;
    };
    expect(await tokenless(oursIndex)).toEqual(await tokenless(nativeIndex));
    expect(git(["ls-files", "-f"])).toBe(nativeBits);
    if (checkFile) expect(readFileSync(join(dir, checkFile), "latin1")).toBe(nativeFile);
    return { nativeIndex, oursIndex, nativeFile };
  }

  const ourRmCached = (path: string) => (g: Awaited<ReturnType<typeof openOurs>>) =>
    g.rm().addFilepattern(path).setCached(true).call();

  it("every index-writing command adds the extension git's tweak_fsmonitor adds on its read", async () => {
    hook(NOTHING);
    git(["config", "core.fsmonitor", ""]);
    git(["status", "--porcelain"]);
    git(["config", "core.fsmonitor", ".git/hooks/fsmonitor-test"]);
    expect(await fsmnOf(readFileSync(indexPath()))).toBeUndefined();
    const commands: [string[], (g: Awaited<ReturnType<typeof openOurs>>) => Promise<unknown>][] = [
      [["rm", "-q", "--cached", "dir1/tracked"], ourRmCached("dir1/tracked")],
      [
        ["restore", "--staged", "tracked"],
        (g) => g.restore().setStaged(true).addPath("tracked").call(),
      ],
      [["reset", "-q", "HEAD"], (g) => g.reset().setRef("HEAD").call()],
      [
        ["reset", "-q", "--hard", "HEAD"],
        (g) => g.reset().setMode(ResetMode.HARD).setRef("HEAD").call(),
      ],
    ];
    for (const [args, ours] of commands) {
      const saved = saveIndex();
      const { oursIndex } = await commandTwins(args, ours);
      const fsmn = await fsmnOf(oursIndex);
      expect(fsmn?.token).toBe("last_update_token");
      // the extension added by the read: every entry dirty
      expect(fsmn?.dirty.length).toBe(
        (await parseIndexFile(new Uint8Array(oursIndex))).entries.length,
      );
      git(["-c", "core.fsmonitor=", "reset", "-q", "--hard", "HEAD"]);
      restoreIndex(saved);
      dateBack();
    }
  });

  it("a failing monitor drops the valid bits in any index-writing command, as git's read does", async () => {
    hook(NOTHING);
    await statusTwins();
    await statusTwins({ keep: "ours" });
    expect(git(["ls-files", "-f"])).toContain("h dir1/tracked\n");
    hook("#!/bin/sh\nexit 1\n");
    const { oursIndex } = await commandTwins(
      ["rm", "-q", "--cached", "dir1/tracked"],
      ourRmCached("dir1/tracked"),
      undefined,
      true,
    );
    expect(git(["ls-files", "-f"])).not.toMatch(/^h /m);
    expect((await fsmnOf(oursIndex))?.dirty.length).toBeGreaterThan(0);
  });

  it("a reported change drops its bit in a command that only carried the state before", async () => {
    hook(LISTED);
    report([]);
    await statusTwins();
    await statusTwins({ keep: "ours" });
    put("modified", "changed\n");
    dateBack();
    report(["modified"]);
    await commandTwins(["rm", "-q", "--cached", "dir1/tracked"], ourRmCached("dir1/tracked"));
    expect(git(["ls-files", "-f"])).toContain("H modified\n");
  });

  for (const how of ["reset --hard", "checkout -f"] as const) {
    const nativeArgs =
      how === "reset --hard" ? ["reset", "-q", "--hard", "HEAD"] : ["checkout", "-qf", "main"];
    const oursRun = (g: Awaited<ReturnType<typeof openOurs>>) =>
      how === "reset --hard"
        ? g.reset().setMode(ResetMode.HARD).setRef("HEAD").call()
        : g.checkout().setName("main").setForced(true).call();

    it(`${how} leaves a change the monitor did not report alone (oneway_merge)`, async () => {
      hook(LISTED);
      report([]);
      await statusTwins();
      await statusTwins({ keep: "ours" });
      put("modified", "unreported\n");
      dateBack();
      const { nativeFile, oursIndex } = await commandTwins(nativeArgs, oursRun, "modified");
      expect(nativeFile).toBe("unreported\n");
      // the entry keeps its bit (and its stat): native git still sees nothing
      expect(git(["ls-files", "-f"])).toContain("h modified\n");
      expect((await fsmnOf(oursIndex))?.token).toBe("listed_token");
    });

    it(`${how} restores a change the monitor reported`, async () => {
      hook(LISTED);
      report([]);
      await statusTwins();
      await statusTwins({ keep: "ours" });
      put("modified", "reported\n");
      dateBack();
      report(["modified"]);
      const { nativeFile } = await commandTwins(nativeArgs, oursRun, "modified");
      expect(nativeFile).toBe("");
    });

    it(`${how} writes a valid entry the target changes, unreported or not`, async () => {
      hook(LISTED);
      report([]);
      put("modified", "committed\n");
      git(["-c", "core.fsmonitor=", "commit", "-qam", "second"]);
      git(["-c", "core.fsmonitor=", "reset", "-q", "--soft", "HEAD~1"]);
      git([
        "-c",
        "core.fsmonitor=",
        "update-index",
        "--cacheinfo",
        `100644,${git(["rev-parse", "HEAD@{1}:modified"]).trim()},modified`,
      ]);
      git(["-c", "core.fsmonitor=", "update-index", "--refresh", "-q"]);
      dateBack();
      // the index has the second commit's `modified`, HEAD the first's (empty): the entry is
      // valid but the reset changes it
      git(["-c", "core.fsmonitor=", "update-index", "--fsmonitor"]);
      git(["update-index", "--fsmonitor-valid", "modified"]);
      expect(git(["ls-files", "-f", "modified"])).toBe("h modified\n");
      const { nativeFile } = await commandTwins(nativeArgs, oursRun, "modified");
      expect(nativeFile).toBe("");
    });
  }

  it("t7519-status-fsmonitor.sh: 'status succeeds with sparse index'", async () => {
    hook(LISTED);
    report([]);
    put("dir3/outside", "o\n");
    put("dir3/deep/file", "d\n");
    git(["-c", "core.fsmonitor=", "add", "."]);
    git(["-c", "core.fsmonitor=", "commit", "-qm", "outside"]);
    git(["-c", "core.fsmonitor=", "sparse-checkout", "init", "--cone", "--sparse-index"]);
    git(["-c", "core.fsmonitor=", "sparse-checkout", "set", "dir1", "dir2"]);
    dateBack();
    // the extension is kept over the collapsed entries (dir3/ one of them)
    await statusTwins();
    const { oursIndex } = await statusTwins({ keep: "ours" });
    expect(Buffer.from(oursIndex).includes(Buffer.from("sdir"))).toBe(true);
    expect((await fsmnOf(oursIndex))?.token).toBe("listed_token");
    expect(git(["ls-files", "-f", "--sparse"])).toContain("S dir3/\n");
    // a change reported inside the cone, and the collapsed directory reported
    put("dir1/modified", "changed\n");
    dateBack();
    report(["dir1/modified", "dir3"]);
    const { nativeOut } = await statusTwins();
    expect(nativeOut).toContain(" M dir1/modified");
    report(["dir3/"]);
    await statusTwins({ keep: "ours" });
    // another command reading and writing the sparse index keeps the extension
    report([]);
    const rm = await commandTwins(
      ["rm", "-q", "--cached", "dir2/tracked"],
      ourRmCached("dir2/tracked"),
    );
    expect(Buffer.from(rm.oursIndex).includes(Buffer.from("sdir"))).toBe(true);
    expect((await fsmnOf(rm.oursIndex))?.token).toBe("listed_token");
    // a failing monitor: every bit dropped, the index still sparse
    hook("#!/bin/sh\nexit 1\n");
    const failed = await statusTwins({ zeroToken: true });
    expect(Buffer.from(failed.oursIndex).includes(Buffer.from("sdir"))).toBe(true);
  });

  // git 2.5x on Linux: the real daemon, through the Node socket adapter
  it.runIf(nativeHasDaemon)(
    "core.fsmonitor=true asks git's fsmonitor--daemon through a socket port",
    async () => {
      git(["config", "core.fsmonitor", "true"]);
      git(["fsmonitor--daemon", "start"]);
      try {
        git(["status", "--porcelain"]);
        // the default Node host: openIpcPort is connectSocketPort
        let status = await (await openOurs(dir, host())).status().call();
        // the token read before native git's status without the monitor rewrites the index
        const token = (await fsmnOf(readFileSync(indexPath())))?.token ?? "";
        expect(token).toMatch(/^builtin:/);
        expect(token).not.toBe("builtin:fake");
        expect(formatStatusPorcelain(status)).toBe(withoutMonitor());
        // a change the daemon sees (its cookie file orders the answer after it)
        put("modified", "changed\n");
        put("dir1/untracked", "");
        status = await (await openOurs(dir, host())).status().call();
        const next = (await fsmnOf(readFileSync(indexPath())))?.token ?? "";
        expect(next).toMatch(/^builtin:/);
        expect(next).not.toBe("builtin:fake");
        // native git through the daemon from our index, then a full scan: all agree
        const nativeOut = git(["status", "--porcelain"]);
        const expected = withoutMonitor();
        expect(expected).toContain(" M modified");
        expect(formatStatusPorcelain(status)).toBe(expected);
        expect(nativeOut).toBe(expected);
      } finally {
        spawnSync("git", ["fsmonitor--daemon", "stop"], { cwd: dir, env: env() });
      }
    },
  );
});
