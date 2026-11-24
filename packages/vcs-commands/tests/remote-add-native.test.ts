/**
 * `git remote add` with its options, `git remote set-url [--push] [--add] [--delete]` and
 * `git remote [-v]`, as native git (builtin/remote.c `add`, `set_url`, `show_all`). Each twin
 * runs native git (2.43 in the sandbox, 2.5x where it is first on PATH) beside ours and
 * compares `.git/config` byte for byte, the refs (symbolic ones and their targets), the
 * reflogs, and refusals by git's stderr and exit code.
 *
 * Scenarios after git's t5505-remote ("add another remote", "add remote whose URL agrees
 * with url.<...>.insteadOf", "add --mirror && prune", "add --mirror=fetch", "add
 * --mirror=push", "add alt && prune", "add with reachable tags (default)", "add --tags",
 * "add --no-tags", "reject --no-no-tags", "reject adding remote with an invalid name",
 * "add a remote whose name is a subset/superset of an existing one", "remote add --mirror
 * setting HEAD", "set-url --push", "set-url --add", "set-url --delete", "set-url --push
 * --delete", "set-url bar zot baz", "show empty remote", "remote -v").
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createNodeGitHostEnvironment,
  createNodeHookRunner,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Git, GitApiError } from "../src/index.js";
import { nativeIs25x } from "./hooks-native-support.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { gitOut, gitRun, putFile, testEnv } from "./status-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root: string;
let counter = 0;
const git = (cwd: string, ...args: string[]) => gitOut(root, cwd, args);

const DATES = {
  GIT_AUTHOR_DATE: "1700000000 +0000",
  GIT_COMMITTER_DATE: "1700000000 +0000",
};

/** Our working copy over `<root>/<name>`, ours a 2.43 or 2.5x as the native git is. */
async function ours(name: string): Promise<Git> {
  const env = testEnv(root, DATES);
  return openOurs(
    root,
    createNodeGitHostEnvironment({
      env,
      hookRunner: createNodeHookRunner({ env, compatibility: nativeIs25x ? "2.56" : "2.43" }),
    }),
    undefined,
    name,
  );
}

/** Two empty repositories, `n<k>` (native) and `o<k>` (ours). */
function twins(): [string, string] {
  const names: [string, string] = [`n${counter}`, `o${counter}`];
  counter++;
  for (const name of names) {
    mkdirSync(join(root, name));
    git(join(root, name), "init", "-q", "-b", "main");
  }
  return names;
}

const config = (dir: string) => readFileSync(join(root, dir, ".git/config"), "latin1");

/** Every ref with its id, symbolic refs with their targets (dangling ones too). */
function refs(dir: string): string {
  const lines: string[] = [];
  const walk = (rel: string) => {
    const at = join(root, dir, ".git", rel);
    if (!existsSync(at)) return;
    for (const entry of readdirSync(at, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const path = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else lines.push(`${path}: ${readFileSync(join(at, entry.name), "latin1").trim()}`);
    }
  };
  walk("refs");
  const packed = join(root, dir, ".git/packed-refs");
  if (existsSync(packed)) lines.push(readFileSync(packed, "latin1"));
  return lines.join("\n");
}

/** Every reflog, file by file. */
function reflogs(dir: string): string {
  const lines: string[] = [];
  const walk = (rel: string) => {
    const at = join(root, dir, ".git", rel);
    if (!existsSync(at)) return;
    for (const entry of readdirSync(at, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const path = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else lines.push(`${path}:\n${readFileSync(join(at, entry.name), "latin1")}`);
    }
  };
  walk("logs/refs");
  return lines.join("\n");
}

const fetchHead = (dir: string) => {
  const path = join(root, dir, ".git", "FETCH_HEAD");
  return existsSync(path) ? readFileSync(path, "latin1") : "";
};

async function failure(run: () => Promise<unknown>): Promise<GitApiError | undefined> {
  try {
    await run();
    return undefined;
  } catch (e) {
    return e as GitApiError;
  }
}

/** `git remote add` arguments as our command's setters. */
async function remoteAdd(o: string, args: string[]) {
  const command = (await ours(o)).remoteAdd();
  const track: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "-f") command.setFetch(true);
    else if (arg === "--tags") command.setTags(true);
    else if (arg === "--no-tags") command.setTags(false);
    else if (arg === "-t") track.push(args[++i] as string);
    else if (arg === "-m") command.setMaster(args[++i] as string);
    else if (arg === "--mirror") command.setMirror(true);
    else if (arg.startsWith("--mirror=")) command.setMirror(arg.slice(9) as "fetch" | "push");
    else rest.push(arg);
  }
  if (track.length > 0) command.setTrack(...track);
  command.setName(rest[0] as string).setUri(rest[1] as string);
  return command;
}

/** `git remote set-url` arguments as our command's setters. */
async function remoteSetUrl(o: string, args: string[]) {
  const command = (await ours(o)).remoteSetUrl();
  const rest: string[] = [];
  for (const arg of args) {
    if (arg === "--push") command.setPush(true);
    else if (arg === "--add") command.setAdd(true);
    else if (arg === "--delete") command.setDelete(true);
    else rest.push(arg);
  }
  command.setRemoteName(rest[0] as string).setRemoteUri(rest[1] as string);
  if (rest[2] !== undefined) command.setOldUri(rest[2]);
  return command;
}

describeGit("git remote add / set-url / -v, as native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "remote-add-"));
    const up = join(root, "up");
    mkdirSync(up);
    git(up, "init", "-q", "-b", "main");
    putFile(up, "a.txt", "a\n");
    gitOut(root, up, ["add", "a.txt"]);
    gitOut(root, up, ["commit", "-qm", "one"], DATES);
    gitOut(root, up, ["tag", "-a", "-m", "v1", "v1"], DATES);
    git(up, "branch", "second");
    // a tag on a commit no branch reaches: only --tags fetches it
    git(up, "checkout", "-q", "-b", "side");
    putFile(up, "s.txt", "s\n");
    gitOut(root, up, ["add", "s.txt"]);
    gitOut(root, up, ["commit", "-qm", "side"], DATES);
    git(up, "tag", "lonely");
    git(up, "checkout", "-q", "main");
    git(up, "branch", "-D", "side");
    putFile(up, "b.txt", "b\n");
    gitOut(root, up, ["add", "b.txt"]);
    gitOut(root, up, ["commit", "-qm", "two"], DATES);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  /** Runs `git remote add <args>` in both twins and compares what they leave. */
  async function expectSameAdd(n: string, o: string, args: string[]) {
    const native = gitRun(root, join(root, n), ["remote", "add", ...args], DATES);
    const command = await remoteAdd(o, args);
    const error = await failure(() => command.call());
    if (native.status !== 0) {
      expect(error?.message).toBe(native.stderr.trim());
      expect(error?.exitCode).toBe(native.status);
    } else {
      expect(error, native.stderr).toBeUndefined();
      const messages = command.getMessages();
      if (args.includes("-f")) {
        // stdout: git's "Updating <name>"; stderr: the warnings, then the fetch's lines
        expect(messages.filter((m) => m.startsWith("Updating "))).toEqual(
          native.stdout.trim().split("\n"),
        );
      }
      const stderrLines = messages.filter((m) => m.startsWith("warning: "));
      expect(stderrLines.join("\n")).toBe(
        native.stderr
          .split("\n")
          .filter((l) => l.startsWith("warning: ") || l.startsWith("\t use"))
          .join("\n"),
      );
    }
    expect(config(o)).toBe(config(n));
    expect(refs(o)).toBe(refs(n));
    expect(reflogs(o)).toBe(reflogs(n));
    expect(fetchHead(o).split(o).join("<r>")).toBe(fetchHead(n).split(n).join("<r>"));
    return { native, error };
  }

  it("t5505: remote add with -t, -m, --mirror=fetch|push, --mirror, --[no-]tags (config only)", async () => {
    const cases: string[][] = [
      ["origin", "../up"],
      ["-t", "main", "-t", "second", "origin", "../up"],
      ["-t", "feat/*", "origin", "../up"],
      ["-m", "main", "origin", "../up"],
      ["-t", "second", "-m", "second", "origin", "../up"],
      ["--mirror=fetch", "origin", "../up"],
      ["--mirror=fetch", "-t", "heads/main", "-t", "tags/*", "origin", "../up"],
      ["--mirror=push", "origin", "../up"],
      ["--mirror", "origin", "../up"],
      ["--tags", "origin", "../up"],
      ["--no-tags", "origin", "../up"],
      ["--tags", "--no-tags", "origin", "../up"],
    ];
    for (const args of cases) {
      const [n, o] = twins();
      await expectSameAdd(n, o, args);
    }
  });

  it("t5505: add another remote, add --mirror=fetch, add --tags/--no-tags, -m (fetching)", async () => {
    const cases: string[][] = [
      ["-f", "second", "../up"],
      ["-f", "--tags", "origin", "../up"],
      ["-f", "--no-tags", "origin", "../up"],
      ["-f", "-t", "second", "origin", "../up"],
      ["-f", "-m", "main", "origin", "../up"],
      ["-f", "-t", "main", "-m", "main", "origin", "../up"],
      ["-f", "--mirror=push", "origin", "../up"],
    ];
    for (const args of cases) {
      const [n, o] = twins();
      await expectSameAdd(n, o, args);
    }
  });

  it("t5505: add --mirror && prune (a fetch mirror writes every ref as itself)", async () => {
    const [n, o] = twins();
    // HEAD names no branch the mirror writes: git refuses to fetch into a checked-out one
    for (const d of [n, o]) git(join(root, d), "symbolic-ref", "HEAD", "refs/heads/elsewhere");
    await expectSameAdd(n, o, ["-f", "--mirror=fetch", "origin", "../up"]);
  });

  it("t5505: add remote whose URL agrees with url.<...>.insteadOf (fetching through it)", async () => {
    const [n, o] = twins();
    for (const d of [n, o]) git(join(root, d), "config", `url.${root}/.insteadOf`, "short:");
    await expectSameAdd(n, o, ["-f", "origin", "short:up"]);
  });

  it("t5505: refusals: an existing remote, a bad name, --mirror with -m or a push mirror with -t", async () => {
    const [n, o] = twins();
    for (const d of [n, o]) git(join(root, d), "remote", "add", "origin", "../up");
    for (const args of [
      ["origin", "../other"],
      ["-f", "origin", "../other"],
      ["bad name", "../up"],
      ["bad..name", "../up"],
      ["--mirror=fetch", "-m", "main", "m", "../up"],
      ["--mirror", "-m", "main", "m", "../up"],
      ["--mirror=push", "-t", "main", "m", "../up"],
    ]) {
      const { native } = await expectSameAdd(n, o, args);
      expect(native.status).not.toBe(0);
    }
    // a section with only a fetch line is a remote too; a global one is not
    for (const d of [n, o])
      git(join(root, d), "config", "remote.fe.fetch", "+refs/heads/*:refs/x/*");
    expect((await expectSameAdd(n, o, ["fe", "../up"])).native.status).toBe(3);
  });

  it("t5505: tracking refs alone do not make a remote; a remotes file does (git 2.x)", async () => {
    const [n, o] = twins();
    for (const d of [n, o]) {
      git(join(root, d), "remote", "add", "-f", "origin", "../up");
      git(join(root, d), "config", "--remove-section", "remote.origin");
    }
    await expectSameAdd(n, o, ["origin", "../up"]);

    const [n2, o2] = twins();
    for (const d of [n2, o2]) putFile(join(root, d, ".git"), "remotes/legacy", "URL: ../up\n");
    expect((await expectSameAdd(n2, o2, ["legacy", "../up"])).native.status).toBe(3);
  });

  it("t5505: add a remote whose name is a subset/superset of an existing one (2.5x refuses)", async () => {
    const [n, o] = twins();
    for (const d of [n, o]) git(join(root, d), "remote", "add", "a/b", "../up");
    const subset = await expectSameAdd(n, o, ["a/b/c", "../up"]);
    const superset = await expectSameAdd(n, o, ["a", "../up"]);
    expect(subset.native.status).toBe(nativeIs25x ? 128 : 0);
    expect(superset.native.status).toBe(nativeIs25x ? 128 : 0);
  });

  it("t5505: remote add -f from a path that is no repository fails after configuring", async () => {
    const [n, o] = twins();
    const native = gitRun(root, join(root, n), [
      "remote",
      "add",
      "-f",
      "-m",
      "main",
      "x",
      "../nope",
    ]);
    const command = await remoteAdd(o, ["-f", "-m", "main", "x", "../nope"]);
    const error = await failure(() => command.call());
    expect(native.status).toBe(1);
    expect(error?.exitCode).toBe(1);
    expect(error?.message.split("\n").at(-1)).toBe("error: Could not fetch x");
    expect(native.stderr.trim().split("\n").at(-1)).toBe("error: Could not fetch x");
    expect(config(o)).toBe(config(n));
    expect(refs(o)).toBe(refs(n));
  });

  /** Runs `git remote set-url <args>` in both twins and compares the configuration. */
  async function expectSameSetUrl(n: string, o: string, args: string[]) {
    const native = gitRun(root, join(root, n), ["remote", "set-url", ...args]);
    const error = await failure(async () => (await remoteSetUrl(o, args)).call());
    if (native.status !== 0) {
      expect(error?.message, args.join(" ")).toBe(native.stderr.trim());
      expect(error?.exitCode).toBe(native.status);
    } else {
      expect(error, `${args.join(" ")}: ${native.stderr}`).toBeUndefined();
    }
    expect(config(o), args.join(" ")).toBe(config(n));
    return native;
  }

  it("t5505: set-url [--push] [--add] [--delete], with and without a matching old URL", async () => {
    const [n, o] = twins();
    for (const d of [n, o]) git(join(root, d), "remote", "add", "someremote", "foo");
    const steps: string[][] = [
      ["someremote", "bar"],
      ["someremote", "baz", "foo"],
      ["someremote", "zot", "bar"],
      ["someremote", "baz", "bar"],
      ["--push", "someremote", "zot"],
      ["--push", "someremote", "qux", "zot"],
      ["--push", "someremote", "foo", "qu+x"],
      ["--push", "--add", "someremote", "aaa"],
      ["--push", "--add", "someremote", "bbb"],
      ["--push", "someremote", "ccc"],
      ["--push", "someremote", "ccc", "nomatch"],
      ["--push", "someremote", "ccc", "aaa"],
      ["--push", "--delete", "someremote", "foo"],
      ["--push", "--delete", "someremote", "nomatch"],
      ["--push", "--delete", "someremote", "a+"],
      ["--delete", "someremote", "zot"],
      ["--add", "--delete", "someremote", "x"],
      ["someremote", "x", "("],
      ["nosuchremote", "x"],
      ["--add", "nosuchremote", "x"],
    ];
    for (const step of steps) await expectSameSetUrl(n, o, step);

    // url as the section's last variable: an added value goes after it (git adds at the
    // section's end, our writer after the key's other values: the same place here)
    const [n2, o2] = twins();
    for (const d of [n2, o2]) {
      git(join(root, d), "config", "remote.someremote.fetch", "+refs/heads/*:refs/remotes/s/*");
      git(join(root, d), "config", "remote.someremote.url", "foo");
    }
    for (const step of [
      ["--add", "someremote", "bar"],
      ["--add", "someremote", "baz"],
      ["someremote", "only"],
      ["someremote", "new", "^ba"],
      ["someremote", "new", "^bar$"],
      ["--delete", "someremote", "^ba"],
      ["--delete", "someremote", "."],
      ["--delete", "someremote", "nomatch"],
      ["--push", "--delete", "someremote", "."],
      ["--delete", "someremote", "new"],
    ]) {
      await expectSameSetUrl(n2, o2, step);
    }
  });

  it("t5505: set-url matches the URLs as git reads them (insteadOf), edits the values", async () => {
    const [n, o] = twins();
    for (const d of [n, o]) {
      git(join(root, d), "config", "url.https://example.com/.insteadOf", "ex:");
      git(join(root, d), "config", "remote.r.fetch", "+refs/heads/*:refs/remotes/r/*");
      git(join(root, d), "config", "remote.r.url", "ex:repo");
    }
    // the rewritten URL matches, the value does not: git adds the new URL
    await expectSameSetUrl(n, o, ["r", "https://other/", "example"]);
    await expectSameSetUrl(n, o, ["r", "new", "ex:"]);
    // a legacy remote file defines the remote (git 2.x)
    for (const d of [n, o]) putFile(join(root, d, ".git"), "remotes/legacy", "URL: ../up\n");
    await expectSameSetUrl(n, o, ["--push", "legacy", "../pushed"]);
  });

  it("t5505: remote and remote -v (pushurl, insteadOf/pushInsteadOf, no URL, filter)", async () => {
    const [n, o] = twins();
    for (const d of [n, o]) {
      const set = (...args: string[]) => git(join(root, d), "config", ...args);
      set("url.https://example.com/.insteadOf", "ex:");
      set("url.ssh://push.example/.pushInsteadOf", "ex:");
      set("remote.origin.url", "../up");
      set("remote.b.url", "ex:b");
      set("remote.b.pushurl", "ex:bp");
      set("--add", "remote.b.pushurl", "plain");
      set("remote.a.url", "ex:a");
      set("--add", "remote.a.url", "second");
      set("remote.empty.fetch", "+refs/heads/*:refs/remotes/empty/*");
      set("remote.Z.url", "z");
      set("remote.p.url", "../up");
      set("remote.p.partialclonefilter", "blob:none");
      set("remote.pushDefault", "origin");
      // tracking refs of a remote without configuration are not listed
      git(
        join(root, d),
        "update-ref",
        "refs/remotes/ghost/main",
        git(join(root, "up"), "rev-parse", "HEAD").trim(),
      );
    }
    for (const verbose of [false, true]) {
      const native = git(join(root, n), "remote", ...(verbose ? ["-v"] : []));
      const text = await (await ours(o)).remoteList().setVerbose(verbose).callText();
      expect(text).toBe(native);
    }
  });
});
