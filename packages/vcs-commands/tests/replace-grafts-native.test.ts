/**
 * Replace refs and grafts in history walks, against native git: `git log`, `git rev-list`,
 * `git rev-parse` (parents such as `HEAD~2`, the merge bases of `a...b`) read a commit
 * replaced by `refs/replace/<id>` as its replacement (keeping its id) and a commit named in
 * `info/grafts` with the grafted parents; `--no-replace-objects`, `GIT_NO_REPLACE_OBJECTS` and
 * `core.useReplaceRefs=false` turn replace refs off.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeGitHostEnvironment } from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Git, LogResult } from "../src/index.js";
import { git, gitOk, openOurs, put } from "./merge-native-helpers.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root: string;
let n = 0;
const g = (dir: string, ...args: string[]) => gitOk(root, dir, ...args).trim();

/**
 * main: one - two - three - four, then a merge of side; side forks at one (side1, side2).
 * Each commit is tagged with its name.
 */
function repo(): { dir: string; ids: Record<string, string> } {
  const dir = join(root, `r${n++}`);
  g(root, "init", "-q", "-b", "main", dir);
  const ids: Record<string, string> = {};
  const commit = (name: string) => {
    put(dir, `${name}.txt`, `${name}\n`);
    g(dir, "add", "-A");
    g(dir, "commit", "-q", "-m", name, "-m", `body of ${name}`);
    ids[name] = g(dir, "rev-parse", "HEAD");
    g(dir, "tag", name);
  };
  commit("one");
  commit("two");
  commit("three");
  g(dir, "checkout", "-q", "-b", "side", ids.one as string);
  commit("side1");
  commit("side2");
  g(dir, "checkout", "-q", "main");
  commit("four");
  g(dir, "merge", "-q", "--no-ff", "-m", "merge side", "side");
  ids.merge = g(dir, "rev-parse", "HEAD");
  return { dir, ids };
}

const FORMAT = "%H %P %T %an %s";
const line = (c: LogResult) =>
  `${c.id} ${c.parents.join(" ")} ${c.tree} ${c.author.name} ${c.message.split("\n")[0]}`;

async function oursLog(ours: Git, args: string[], configure = (c: unknown) => c) {
  const command = ours.revList();
  configure(command);
  for (const arg of args) command.addArgument(arg);
  const out: string[] = [];
  for await (const c of await command.call()) out.push(line(c));
  return out;
}

const nativeLog = (dir: string, args: string[], env: string[] = []) =>
  g(dir, ...env, "log", `--format=${FORMAT}`, ...args)
    .split("\n")
    .filter((l) => l !== "");

async function oursRevParse(ours: Git, args: string[]): Promise<string[]> {
  const command = ours.revParse();
  for (const arg of args) command.addArgument(arg);
  return [...(await command.call()).lines];
}

const nativeRevParse = (dir: string, args: string[], env: string[] = []) =>
  g(dir, ...env, "rev-parse", ...args)
    .split("\n")
    .filter((l) => l !== "");

describeGit("replace refs and grafts in history walks, native twins", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "replace-grafts-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("grafts: log, rev-list, parents and merge bases follow the grafted parents", async () => {
    const { dir, ids } = repo();
    // four's parent becomes one (two and three leave main's history); side2 becomes a root
    writeFileSync(
      join(dir, ".git", "info", "grafts"),
      `# grafts\n${ids.four} ${ids.one}\n${ids.side2}\nbad line\n`,
    );
    const ours = await openOurs(dir);
    for (const args of [["main"], ["main", "--", "two.txt"], ["side..main"], ["main...three"]]) {
      expect(await oursLog(ours, args)).toEqual(nativeLog(dir, args));
    }
    for (const args of [
      ["main~1"],
      ["main~2"],
      ["main^2"],
      ["four~1"],
      ["main...three"],
      ["side...four"],
    ]) {
      expect(await oursRevParse(await openOurs(dir), args)).toEqual(nativeRevParse(dir, args));
    }
    expect(g(dir, "merge-base", "--all", ids.three as string, ids.merge as string)).toBe(ids.one);
  });

  it("replace refs: the replacement's content under the replaced id, and turned off", async () => {
    const { dir, ids } = repo();
    // three is replaced by a commit of another message whose parent is one
    const tree = g(dir, "rev-parse", `${ids.three}^{tree}`);
    const replacement = g(dir, "commit-tree", "-p", ids.one as string, "-m", "replaced", tree);
    g(dir, "replace", ids.three as string, replacement);
    // and side2 by four (a replacement's own replacement is followed)
    g(dir, "replace", ids.side2 as string, ids.four as string);
    const ours = await openOurs(dir);
    for (const args of [["main"], ["main", "--", "two.txt"], ["side..main"], ["main...two"]]) {
      expect(await oursLog(ours, args)).toEqual(nativeLog(dir, args));
    }
    for (const args of [["main~2"], ["main~3"], ["main^2"], ["main^2~1"], ["main...two"]]) {
      expect(await oursRevParse(await openOurs(dir), args)).toEqual(nativeRevParse(dir, args));
    }
    // --no-replace-objects
    const off = (c: unknown) =>
      (c as { setUseReplaceRefs(u: boolean): void }).setUseReplaceRefs(false);
    expect(await oursLog(await openOurs(dir), ["main"], off)).toEqual(
      nativeLog(dir, ["main"], ["--no-replace-objects"]),
    );
    // GIT_NO_REPLACE_OBJECTS
    const environment = createNodeGitHostEnvironment({
      env: { ...nativeGitEnv(root), GIT_NO_REPLACE_OBJECTS: "1" },
    });
    const noReplace = git(root, dir, "-c", "core.useReplaceRefs=false", "log", `--format=${FORMAT}`)
      .stdout.split("\n")
      .filter((l) => l !== "");
    expect(await oursLog(await openOurs(dir, environment), ["main"])).toEqual(noReplace);
    // core.useReplaceRefs=false
    g(dir, "config", "core.useReplaceRefs", "false");
    expect(await oursLog(await openOurs(dir), ["main"])).toEqual(noReplace);
    expect(await oursRevParse(await openOurs(dir), ["main~2"])).toEqual(
      nativeRevParse(dir, ["main~2"]),
    );
  });

  it("grafts and replace refs together: a replaced commit keeps its own id's graft", async () => {
    const { dir, ids } = repo();
    const tree = g(dir, "rev-parse", `${ids.two}^{tree}`);
    const replacement = g(dir, "commit-tree", "-p", ids.one as string, "-m", "two again", tree);
    g(dir, "replace", ids.two as string, replacement);
    writeFileSync(join(dir, ".git", "info", "grafts"), `${ids.two}\n${ids.merge} ${ids.three}\n`);
    expect(await oursLog(await openOurs(dir), ["main"])).toEqual(nativeLog(dir, ["main"]));
    expect(await oursLog(await openOurs(dir), ["main", "--", "one.txt"])).toEqual(
      nativeLog(dir, ["main", "--", "one.txt"]),
    );
    expect(await oursRevParse(await openOurs(dir), ["three~1", "main^", "main...two"])).toEqual(
      nativeRevParse(dir, ["three~1", "main^", "main...two"]),
    );
  });
});
