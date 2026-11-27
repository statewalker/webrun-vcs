/**
 * `git refs migrate` stopped at any step leaves a readable repository (statewalker-root#357),
 * after t1460-refs-migrate.sh: "$from_format -> $to_format: a bunch of refs". A repository
 * with branches, tags, a symbolic ref, root refs and reflogs is copied once per mutating
 * FilesApi call a migration makes; in copy `k` the `k`-th call and every later one throw, as if
 * the process died there (its cleanup cannot run either). The copy then opens in one format,
 * the old one until the config is renamed over (the commit point) and the new one after it,
 * with every ref and reflog entry it had; native git reads it the same way where it knows the
 * format; and a new migration from where it stopped completes.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FilesApi } from "@statewalker/vcs-core";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { afterAll, describe, expect, it } from "vitest";
import {
  createGitFilesBackend,
  migrateRefStorage,
  type RefStorageFormat,
  readRepositoryFormat,
} from "../src/index.js";
import { CLEANUP_TIMEOUT, removeTempDir } from "./temp-dir-support.js";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "A U Thor",
  GIT_AUTHOR_EMAIL: "author@example.com",
  GIT_COMMITTER_NAME: "C O Mitter",
  GIT_COMMITTER_EMAIL: "committer@example.com",
  GIT_AUTHOR_DATE: "1112911993 +0000",
  GIT_COMMITTER_DATE: "1112911993 +0000",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "maintenance.auto",
  GIT_CONFIG_VALUE_0: "false",
  GIT_CONFIG_KEY_1: "gc.auto",
  GIT_CONFIG_VALUE_1: "0",
};
const git = (cwd: string, args: string[], input?: string) =>
  execFileSync("git", args, { cwd, env: GIT_ENV, input }).toString();
const gitAvailable = spawnSync("git", ["--version"]).status === 0;
/** Whether native git reads reftable repositories (2.45+) */
const nativeReftable =
  gitAvailable &&
  spawnSync(
    "git",
    ["init", "-q", "--ref-format=reftable", join(tmpdir(), `rt-probe-${process.pid}`)],
    {
      env: GIT_ENV,
    },
  ).status === 0;

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await removeTempDir(d);
  await removeTempDir(join(tmpdir(), `rt-probe-${process.pid}`));
}, CLEANUP_TIMEOUT);

/** The fixture (a files repository): t1460's "a bunch of refs" with reflogs and a stash. */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "refs-migrate-crash-"));
  dirs.push(root);
  const dir = join(root, "repo");
  git(root, ["init", "-q", "--initial-branch=main", "repo"]);
  writeFileSync(join(dir, "a.txt"), "a\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "initial"]);
  git(dir, ["tag", "-a", "-m", "v1", "v1"]);
  git(dir, ["pack-refs", "--all"]);
  writeFileSync(join(dir, "a.txt"), "b\n");
  git(dir, ["commit", "-q", "-am", "second"]);
  git(
    dir,
    ["update-ref", "--stdin"],
    [
      "create FOO_HEAD HEAD",
      "create refs/heads/branch-1 HEAD",
      "create refs/heads/a/b HEAD~",
      "create refs/heads/a-b HEAD",
      "create refs/tags/tag-1 HEAD",
      "",
    ].join("\n"),
  );
  git(dir, ["symbolic-ref", "refs/heads/sym", "refs/heads/branch-1"]);
  git(dir, ["update-ref", "ORIG_HEAD", "HEAD~"]);
  writeFileSync(join(dir, "a.txt"), "c\n");
  git(dir, ["stash", "push", "-q"]);
  return dir;
}

const MUTATING = new Set([
  "write",
  "mkdir",
  "remove",
  "move",
  "copy",
  "createExclusive",
  "append",
  "touch",
  "symlink",
  "chmod",
  "rmdir",
]);

/** A FilesApi whose `crashAt`-th mutating call and every later one throw; counts them. */
function crashing(base: FilesApi, crashAt: number) {
  const state = { calls: 0, crashed: false };
  const files = new Proxy(base, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      if (typeof prop === "string" && MUTATING.has(prop))
        return (...args: unknown[]) => {
          state.calls++;
          if (state.calls >= crashAt) {
            state.crashed = true;
            throw new Error(`killed at mutating call ${state.calls} (${prop} ${String(args[0])})`);
          }
          return value.apply(target, args);
        };
      return value.bind(target);
    },
  });
  return { files, state };
}

const REF_NAMES = ["HEAD", "ORIG_HEAD", "FOO_HEAD"];
const LOGS = ["HEAD", "refs/heads/main", "refs/heads/branch-1", "refs/heads/a/b", "refs/stash"];

/** Every ref (root refs too, symbolic ones as such) and reflog, as ours reads them. */
async function contentOf(dir: string): Promise<{ format: string; state: string }> {
  const files = createNodeFilesApi({ rootDir: dir });
  const format = (await readRepositoryFormat(files, ".git")).refStorage;
  const { history } = await createGitFilesBackend({ files });
  const refs = history.refs;
  const lines: string[] = [];
  const show = (
    r: { name: string; objectId?: string; target?: string } | undefined,
    name: string,
  ) => (r ? `${name} ${"target" in r && r.target ? `-> ${r.target}` : r.objectId}` : `${name} -`);
  for (const name of REF_NAMES) lines.push(show(await refs.get(name), name));
  for await (const r of refs.list("refs/")) lines.push(show(r, r.name));
  for (const name of LOGS) {
    const log = await refs.getReflog?.(name);
    for (const e of (await log?.getReverseEntries()) ?? []) {
      lines.push(`log ${name} ${e.oldId} ${e.newId} ${e.who.name} ${e.who.timestamp} ${e.comment}`);
    }
  }
  return { format, state: lines.join("\n") };
}

/** Native git's refs (root refs too where it lists them: 2.45+), where it reads the format. */
function nativeView(dir: string, format: string): string | undefined {
  if (format === "reftable" && !nativeReftable) return undefined;
  const format1 = "--format=%(refname) %(objectname) %(symref)";
  const r = spawnSync("git", ["for-each-ref", "--include-root-refs", format1], {
    cwd: dir,
    env: GIT_ENV,
  });
  if (r.status === 0) return r.stdout.toString();
  return git(dir, ["for-each-ref", format1]);
}

async function migrate(dir: string, to: RefStorageFormat, files?: FilesApi): Promise<void> {
  await migrateRefStorage({
    files: files ?? createNodeFilesApi({ rootDir: dir }),
    gitDir: ".git",
    to,
  });
}

async function crashEverywhere(src: string, from: RefStorageFormat, to: RefStorageFormat) {
  const before = await contentOf(src);
  expect(before.format).toBe(from);
  const nativeBefore = nativeView(src, from);

  // a full run counts the mutating calls
  const whole = join(mkdtempSync(join(tmpdir(), "refs-migrate-count-")), "c");
  dirs.push(join(whole, ".."));
  execFileSync("cp", ["-a", src, whole]);
  const probe = crashing(createNodeFilesApi({ rootDir: whole }), Infinity);
  await migrate(whole, to, probe.files);
  const total = probe.state.calls;
  expect(total).toBeGreaterThan(5);
  const after = await contentOf(whole);
  expect(after).toEqual({ format: to, state: before.state });

  const failures: string[] = [];
  const formats = new Set<string>();
  for (let k = 1; k <= total; k++) {
    const copy = join(mkdtempSync(join(tmpdir(), "refs-migrate-k-")), "c");
    dirs.push(join(copy, ".."));
    execFileSync("cp", ["-a", src, copy]);
    const { files, state } = crashing(createNodeFilesApi({ rootDir: copy }), k);
    let died: unknown;
    try {
      await migrate(copy, to, files);
    } catch (e) {
      died = e;
    }
    if (!state.crashed) failures.push(`step ${k}: the migration did not reach step ${k}`);
    const seen = await contentOf(copy).catch((e) => ({ format: "?", state: String(e) }));
    formats.add(seen.format);
    // past the commit point the cleanup's failures are warnings: the migration has happened
    if (!died && seen.format !== to) failures.push(`step ${k}: no error, yet ${seen.format}`);
    if (seen.state !== before.state) {
      failures.push(`step ${k} (${String(died)}): ${seen.format} repository reads\n${seen.state}`);
    }
    const native = nativeView(copy, seen.format);
    if (native !== undefined && nativeBefore !== undefined && native !== nativeBefore) {
      failures.push(`step ${k}: native git reads\n${native}`);
    }
    // the user removes the locks the dead migration left (`config.lock`), as after git; a
    // migration from where it stopped then completes (the new format: nothing left to do)
    for (const e of readdirSync(join(copy, ".git"), { withFileTypes: true, recursive: true })) {
      if (e.isFile() && e.name.endsWith(".lock")) rmSync(join(e.parentPath, e.name));
    }
    if (seen.format === from) {
      await migrate(copy, to);
      const again = await contentOf(copy);
      if (again.format !== to || again.state !== before.state) {
        failures.push(`step ${k}: the migration run again gives\n${again.state}`);
      }
    }
  }
  expect(failures).toEqual([]);
  // both sides of the commit point were reached
  expect([...formats].sort()).toEqual([from, to].sort());
}

describe.skipIf(!gitAvailable || process.platform !== "linux")(
  "t1460-refs-migrate: a migration killed at any step",
  () => {
    it("files -> reftable leaves a repository readable in one format, its refs intact", async () => {
      await crashEverywhere(fixture(), "files", "reftable");
    }, 120_000);

    it("reftable -> files leaves a repository readable in one format, its refs intact", async () => {
      const src = fixture();
      await migrate(src, "reftable");
      await crashEverywhere(src, "reftable", "files");
    }, 120_000);
  },
);
