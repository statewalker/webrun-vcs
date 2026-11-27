/**
 * `git clone -u`/`--upload-pack` and `--server-option` against native git over ssh (git's
 * command run locally, as in `git-native-protocol.test.ts`): the program given runs on the
 * remote, here a wrapper that logs the requests it reads before handing them to
 * `git-upload-pack`, so the `server-option=` lines each client sent are compared
 * (t5702-protocol-v2), with `remote.<name>.serverOption` (git 2.5x; 2.43 ignores it), and
 * the repositories left (t5606-clone-options' `-u`).
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultTransports } from "@statewalker/vcs-transport";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cloneStateOf, ourClone, ourCloneFails } from "./clone-options-native-support.js";
import { nativeIs25x } from "./hooks-native-support.js";
import { localSshExec, writeNativeScripts } from "./native-connect-support.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { gitOut, gitRun, putFile } from "./status-native-support.js";
import { CLEANUP_TIMEOUT, removeTempDir } from "./temp-dir-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root: string;
let srv: string;
let scripts: ReturnType<typeof writeNativeScripts>;
let wrapper: string;
let counter = 0;
const git = (cwd: string, ...args: string[]) => gitOut(root, cwd, args);
const sshEnv = () => ({ GIT_SSH_COMMAND: scripts.ssh, GIT_SSH_VARIANT: "ssh" });
const url = () => `localhost:${srv}/src`;

/** `git -c k=v ...` as `GIT_CONFIG_*` variables (after the test environment's two). */
function commandLine(pairs: [string, string][]): Record<string, string> {
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(2 + pairs.length) };
  pairs.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i + 2}`] = k;
    env[`GIT_CONFIG_VALUE_${i + 2}`] = v;
  });
  return env;
}

/** Two clone destinations and the wrapper's log for each. */
function twins(): { n: string; o: string; nLog: string; oLog: string } {
  const k = counter++;
  return {
    n: join(root, `n${k}`),
    o: join(root, `o${k}`),
    nLog: join(root, `n${k}.log`),
    oLog: join(root, `o${k}.log`),
  };
}

/** The `server-option=` lines a log of requests holds, in order. */
function serverOptions(log: string): string[] {
  if (!existsSync(log)) return [];
  const text = readFileSync(log, "latin1");
  const out: string[] = [];
  for (let at = 0; at + 4 <= text.length; ) {
    const length = Number.parseInt(text.slice(at, at + 4), 16);
    if (!(length >= 4)) {
      at += 4;
      continue;
    }
    const line = text.slice(at + 4, at + length).replace(/\n$/, "");
    if (line.startsWith("server-option=")) out.push(line);
    at += length;
  }
  return out;
}

/** Native git's clone through the wrapper, logging to `log`. */
function nativeClone(
  dest: string,
  log: string,
  args: string[],
  extra: Record<string, string> = {},
) {
  return gitRun(root, root, ["clone", "-q", "-u", wrapper, ...args, url(), dest], {
    ...sshEnv(),
    UPLOAD_PACK_LOG: log,
    ...extra,
  });
}

/** Our clone through the same wrapper, logging to `log`. */
function oursClone(
  log: string,
  configure: Parameters<typeof ourClone>[2],
  extraEnv: Record<string, string> = {},
) {
  const exec = localSshExec(root);
  const transports = createDefaultTransports({
    exec: (target, command, env) => exec(target, `UPLOAD_PACK_LOG='${log}' ${command}`, env),
  });
  return {
    run: (c: Parameters<typeof configure>[0]) =>
      configure(c.setURI(url()).setUploadPack(wrapper).setTransports(transports)),
    extraEnv,
  };
}

describeGit("git clone -u and --server-option over ssh, as native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "clone-server-option-native-"));
    srv = join(root, "srv");
    const src = join(srv, "src");
    mkdirSync(src, { recursive: true });
    git(src, "init", "-q", "-b", "main");
    putFile(src, "a.txt", "a\n");
    git(src, "add", "a.txt");
    git(src, "commit", "-qm", "a");
    scripts = writeNativeScripts(root, srv);
    wrapper = join(root, "logging-upload-pack");
    writeFileSync(
      wrapper,
      '#!/bin/sh\n[ -n "$GIT_EXEC_PATH" ] && PATH="$GIT_EXEC_PATH:$PATH"\ntee -a "$UPLOAD_PACK_LOG" | git-upload-pack "$@"\n',
    );
    chmodSync(wrapper, 0o755);
  });
  afterAll(() => removeTempDir(root), CLEANUP_TIMEOUT);

  async function same(
    args: string[],
    configure: Parameters<typeof ourClone>[2],
    extra: Record<string, string> = {},
  ): Promise<{ native: string[]; ours: string[] }> {
    const { n, o, nLog, oLog } = twins();
    const theirs = nativeClone(n, nLog, args, extra);
    expect(theirs.status, theirs.stderr).toBe(0);
    const { run } = oursClone(oLog, configure);
    await ourClone(root, o, run, { extraEnv: extra });
    expect(cloneStateOf(root, o)).toEqual(cloneStateOf(root, n));
    return { native: serverOptions(nLog), ours: serverOptions(oLog) };
  }

  it("t5606-clone-options.sh: -u runs the program given on the remote", async () => {
    const { n, o, nLog, oLog } = twins();
    expect(nativeClone(n, nLog, []).status).toBe(0);
    const { run } = oursClone(oLog, (c) => c);
    await ourClone(root, o, run);
    expect(cloneStateOf(root, o)).toEqual(cloneStateOf(root, n));
    expect(readFileSync(oLog, "latin1")).toContain("command=fetch");
    expect(readFileSync(nLog, "latin1")).toContain("command=fetch");
  });

  it('t5702-protocol-v2.sh: "server-options are sent when cloning"', async () => {
    const sent = await same(["--server-option=hello", "--server-option=world"], (c) =>
      c.setServerOptions(["hello", "world"]),
    );
    expect(sent.ours).toEqual(sent.native);
    expect(sent.native).toEqual([
      "server-option=hello",
      "server-option=world",
      "server-option=hello",
      "server-option=world",
    ]);
  });

  it('t5702-protocol-v2.sh: "server-options from configuration are used by git-clone"', async () => {
    const configured = commandLine([
      ["remote.origin.serverOption", "foo"],
      ["remote.origin.serverOption", "bar"],
    ]);
    const first = await same([], (c) => c, configured);
    expect(first.ours).toEqual(first.native);
    expect(first.native.length).toBe(nativeIs25x ? 4 : 0);

    const cleared = commandLine([
      ["remote.origin.serverOption", "foo"],
      ["remote.origin.serverOption", "bar"],
      ["remote.origin.serverOption", ""],
      ["remote.origin.serverOption", "tar"],
    ]);
    const second = await same([], (c) => c, cleared);
    expect(second.ours).toEqual(second.native);

    const overridden = commandLine([["remote.origin.serverOption", "tar"]]);
    const third = await same(
      ["--server-option=hello", "--server-option=world"],
      (c) => c.setServerOptions(["hello", "world"]),
      overridden,
    );
    expect(third.ours).toEqual(third.native);
    expect(third.native).not.toContain("server-option=tar");
  });

  it('t5702-protocol-v2.sh: "warn if using server-option with clone with legacy protocol"', async () => {
    const { n, o, nLog, oLog } = twins();
    const v0 = commandLine([["protocol.version", "0"]]);
    const theirs = nativeClone(n, nLog, ["--server-option=hello", "--server-option=world"], v0);
    expect(theirs.status).toBe(128);
    const { run } = oursClone(oLog, (c) => c.setServerOptions(["hello", "world"]));
    const ours = await ourCloneFails(root, o, run, { extraEnv: v0 });
    expect(ours.message).toBe(
      theirs.stderr
        .split("\n")
        .filter((l) => /^(hint|fatal): /.test(l))
        .slice(0, 2)
        .join("\n"),
    );
  });

  it('t5702-protocol-v2.sh: "server-option configuration with legacy protocol is ok"', async () => {
    const env = commandLine([
      ["protocol.version", "0"],
      ["remote.origin.serverOption", "foo"],
    ]);
    const sent = await same([], (c) => c, env);
    expect(sent.ours).toEqual([]);
    expect(sent.native).toEqual([]);
  });
});
