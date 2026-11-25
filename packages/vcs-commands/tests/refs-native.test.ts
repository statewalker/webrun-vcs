/**
 * `git refs` (builtin/refs.c), native twins: t1460-refs-migrate.sh for `migrate`, t0602-reffiles-fsck.sh
 * and t0614-reftable-fsck.sh for `verify`, t1461-refs-list.sh for `list`, t1462-refs-exists.sh for
 * `exists`, t1463-refs-optimize.sh for `optimize`, and JGit's ReftableConversionTest /
 * ReftableCreationTest for conversions both ways. Each scenario is built by native git, copied, and
 * run by native git in one copy and by ours in the other; the outcome (stdout, stderr, exit
 * status) and the resulting repositories are compared, native git reading both.
 *
 * `git refs` is git 2.46+ (`list` and `exists` 2.52, `optimize` later): with an older native
 * git (2.43) the twins of a subcommand it lacks are skipped. Reflog dates use `+0000`: git 2.56.x
 * stores a reftable log record's zone as hhmm digits where ours (and git master) stores minutes,
 * which only agree at zero (see CLAUDE.md, Reflog expire).
 */

import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { inflateSync } from "node:zlib";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Git } from "../src/index.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

interface Outcome {
  status: number;
  stdout: string;
  stderr: string;
}

let root: string;
let home: string;
let counter = 0;
let time = 1112911993;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "refs-native-"));
  home = join(root, "home");
  mkdirSync(home);
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  if (probe) rmSync(probe, { recursive: true, force: true });
});

function env(extra: Record<string, string> = {}): Record<string, string> {
  const date = `${time} +0000`;
  return {
    ...nativeGitEnv(home ?? tmpdir()),
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
    GIT_EDITOR: "true",
    // the bare twins under a git 3.0 build (safe.bareRepository's default is `explicit`)
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_2: "safe.bareRepository",
    GIT_CONFIG_VALUE_2: "all",
    ...extra,
  };
}

/** Native git in `cwd`. */
function run(cwd: string, args: string[], input?: string): Outcome {
  const r = spawnSync("git", args, { cwd, env: env(), ...(input !== undefined ? { input } : {}) });
  return {
    status: r.status ?? 1,
    stdout: (r.stdout ?? Buffer.alloc(0)).toString("latin1"),
    stderr: (r.stderr ?? Buffer.alloc(0)).toString("utf8"),
  };
}

/** Native git that must succeed; its stdout. */
function ok(cwd: string, ...args: string[]): string {
  const r = run(cwd, args);
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

/** test_commit <message> [<file>]: a commit and its lightweight tag, one tick later. */
function commit(dir: string, message: string, options: { tag?: boolean; file?: string } = {}) {
  time += 60;
  const file = options.file ?? `${message}.t`;
  writeFileSync(join(dir, file), `${message}\n`);
  ok(dir, "add", "--", file);
  ok(dir, "commit", "-q", "-m", message);
  if (options.tag !== false) ok(dir, "tag", message);
}

/** Whether native git has `git refs <sub>` (its usage for `-h`, exit 129). */
let probe: string | undefined;
function hasRefsSubcommand(sub: string): boolean {
  if (!nativeGitAvailable() || process.platform === "win32") return false;
  if (probe === undefined) {
    probe = mkdtempSync(join(tmpdir(), "refs-probe-"));
    spawnSync("git", ["init", "-q", probe], { env: env() });
  }
  const r = spawnSync("git", ["refs", sub, "-h"], { cwd: probe, env: env() });
  const text = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  return (r.status === 0 || r.status === 129) && text.includes(`usage: git refs ${sub}`);
}

const canMigrate = hasRefsSubcommand("migrate");
const canVerify = hasRefsSubcommand("verify");
const canList = hasRefsSubcommand("list");
const canExists = hasRefsSubcommand("exists");
const canOptimize = hasRefsSubcommand("optimize");

/** A new repository of `format` (`main` its initial branch). */
function repository(format: string, name = "repo", ...args: string[]): string {
  const dir = join(root, `${name}-${counter++}`);
  ok(root, "init", "-q", "-b", "main", `--ref-format=${format}`, ...args, dir);
  return dir;
}

/** Two copies of `dir`: native's and ours. */
function twins(dir: string): { native: string; ours: string } {
  const n = counter++;
  const native = `${dir}-native-${n}`;
  const ours = `${dir}-ours-${n}`;
  cpSync(dir, native, { recursive: true, verbatimSymlinks: true });
  cpSync(dir, ours, { recursive: true, verbatimSymlinks: true });
  return { native, ours };
}

/** Ours on `dir` (a bare repository: its own directory is the git directory). */
async function openOursAt(dir: string, bare = false): Promise<Git> {
  return bare ? openOurs(dir, undefined, undefined, "", false, ".") : openOurs(dir);
}

const outcomeOf = (r: { exitCode: number; stderr: string; stdout: Uint8Array }): Outcome => ({
  status: r.exitCode,
  stdout: Buffer.from(r.stdout).toString("latin1"),
  stderr: r.stderr,
});

const RANDOM = /ref_migration\.[A-Za-z0-9]{6}/g;
const normalized = (o: Outcome): Outcome => ({
  ...o,
  stdout: o.stdout.replace(RANDOM, "ref_migration.XXXXXX"),
  stderr: o.stderr.replace(RANDOM, "ref_migration.XXXXXX"),
});

interface MigrateArgs {
  format?: string;
  dryRun?: boolean;
  noReflog?: boolean;
}

function migrateArgv(a: MigrateArgs): string[] {
  return [
    "refs",
    "migrate",
    ...(a.format !== undefined ? [`--ref-format=${a.format}`] : []),
    ...(a.dryRun ? ["--dry-run"] : []),
    ...(a.noReflog ? ["--no-reflog"] : []),
  ];
}

async function oursMigrate(dir: string, a: MigrateArgs, bare = false): Promise<Outcome> {
  const git = await openOursAt(dir, bare);
  const command = git.refsMigrate();
  if (a.format !== undefined) command.setRefFormat(a.format);
  if (a.dryRun) command.setDryRun(true);
  if (a.noReflog) command.setNoReflog(true);
  return outcomeOf(await command.callOutput());
}

/** The git directory of a repository (bare: itself). */
const gitDirOf = (dir: string, bare: boolean) => (bare ? dir : join(dir, ".git"));

/** t1460's test_migration check: every ref (root refs too) and the ref format. */
function refListing(dir: string): string {
  return (
    ok(dir, "for-each-ref", "--include-root-refs", "--format=%(refname) %(objectname) %(symref)") +
    ok(dir, "rev-parse", "--show-ref-format")
  );
}

/**
 * The reflogs as files: those of a files repository read directly, those of a reftable one
 * after native git migrates a copy to files (its own reader then writes them out).
 */
function reflogFiles(dir: string, bare: boolean): Record<string, string> {
  let gitDir = gitDirOf(dir, bare);
  if (ok(dir, "rev-parse", "--show-ref-format").trim() === "reftable") {
    const copy = `${dir}-logs-${counter++}`;
    cpSync(dir, copy, { recursive: true });
    ok(copy, "refs", "migrate", "--ref-format=files");
    gitDir = gitDirOf(copy, bare);
  }
  const out: Record<string, string> = {};
  const logs = join(gitDir, "logs");
  const walk = (d: string) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[relative(logs, p)] = readFileSync(p, "latin1");
    }
  };
  walk(logs);
  return out;
}

/**
 * The ref storage's files as bytes (reftable tables normalised: random names, log blocks
 * inflated), the config, and every other path in the git directory but objects/hooks/info.
 */
function layout(dir: string, bare: boolean): Record<string, string> {
  const gitDir = gitDirOf(dir, bare);
  const out: Record<string, string> = {};
  const skip = new Set(["objects", "hooks", "info", "description", "index", "COMMIT_EDITMSG"]);
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const p = join(d, e.name);
      const rel = relative(gitDir, p);
      if (d === gitDir && skip.has(e.name)) continue;
      if (bare && d === gitDir && e.name !== "config" && !isRefStorage(e.name)) continue;
      if (e.isDirectory()) {
        out[`${rel}/`] = "";
        walk(p);
      } else if (/(^|\/)reftable\/[^/]+\.ref$/.test(rel)) {
        out[rel.replace(/[^/]+$/, "<table>")] = normalizedTable(readFileSync(p)).toString("hex");
      } else if (/(^|\/)reftable\/tables\.list$/.test(rel)) {
        out[rel] = String(readFileSync(p, "latin1").split("\n").filter(Boolean).length);
      } else {
        out[rel] = readFileSync(p, "latin1");
      }
    }
  };
  walk(gitDir);
  return out;
}

const isRefStorage = (name: string) =>
  ["HEAD", "refs", "packed-refs", "logs", "reftable", "FETCH_HEAD", "MERGE_HEAD"].includes(name) ||
  /^[A-Z_-]+$/.test(name);

/**
 * A table with each log block inflated (`g`, the uncompressed length, the records) and the
 * footer's log index position zeroed (as reftable-write-git3-native.test.ts compares them:
 * pako's deflate differs from the system zlib's).
 */
function normalizedTable(table: Buffer): Buffer {
  const footerAt = table.length - 68;
  const logOffset = Number(table.readBigUInt64BE(footerAt + 24 + 24));
  if (logOffset === 0 && table[24] !== 0x67) return table;
  const start = logOffset === 0 ? 24 : logOffset;
  const parts: Buffer[] = [table.subarray(0, start)];
  let pos = start;
  while (pos < footerAt && table[pos] === 0x67) {
    const { buffer, engine } = inflateSync(table.subarray(pos + 4, footerAt), {
      info: true,
    }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    parts.push(table.subarray(pos, pos + 4), buffer);
    pos += 4 + engine.bytesWritten;
  }
  const footer = Buffer.from(table.subarray(footerAt));
  footer.fill(0, 24 + 32, 24 + 40);
  footer.fill(0, 64, 68);
  parts.push(Buffer.from(`[log index ${footerAt - pos} bytes]`), footer);
  return Buffer.concat(parts);
}

/**
 * `git refs migrate <args>` by native git and by ours on twins of `dir`: the outcome, the refs,
 * the reflogs and the git directory's layout compared; native's outcome.
 */
async function checkMigrate(
  dir: string,
  a: MigrateArgs,
  options: { bare?: boolean; compareLayout?: boolean; compareLogs?: boolean } = {},
): Promise<{ native: string; ours: string; outcome: Outcome }> {
  const bare = options.bare === true;
  const t = twins(dir);
  const native = normalized(run(t.native, migrateArgv(a)));
  const ours = normalized(await oursMigrate(t.ours, a, bare));
  expect({ args: a, ...ours }).toEqual({ args: a, ...native });
  expect(refListing(t.ours)).toBe(refListing(t.native));
  if (options.compareLogs !== false) {
    expect(reflogFiles(t.ours, bare)).toEqual(reflogFiles(t.native, bare));
  }
  if (options.compareLayout !== false) {
    const strip = (l: Record<string, string>) =>
      Object.fromEntries(
        Object.entries(l).map(([k, v]) => [k.replace(RANDOM, "ref_migration.XXXXXX"), v]),
      );
    expect(strip(layout(t.ours, bare))).toEqual(strip(layout(t.native, bare)));
  }
  // what native git makes of ours: a consistent ref database
  expect(run(t.ours, ["refs", "verify"])).toEqual({ status: 0, stdout: "", stderr: "" });
  return { ...t, outcome: native };
}

const FORMATS = [
  ["files", "reftable"],
  ["reftable", "files"],
] as const;

describe.skipIf(!canMigrate)("git refs migrate", () => {
  it('t1460-refs-migrate.sh: "missing ref storage format"', async () => {
    const dir = repository("files");
    const { outcome } = await checkMigrate(dir, {});
    expect(outcome.status).toBe(129);
  });

  it('t1460-refs-migrate.sh: "unknown ref storage format"', async () => {
    const dir = repository("files");
    const { outcome } = await checkMigrate(dir, { format: "unknown" });
    expect(outcome.stderr).toBe("error: unknown ref storage format 'unknown'\n");
  });

  for (const [from, to] of FORMATS) {
    describe(`${from} -> ${to}`, () => {
      it(`t1460-refs-migrate.sh: "$from_format: migration to same format fails" (${from})`, async () => {
        const dir = repository(from);
        const { outcome } = await checkMigrate(dir, { format: from });
        expect(outcome.stderr).toBe(`error: repository already uses '${from}' format\n`);
      });

      it(`t1460-refs-migrate.sh: "$from_format -> $to_format: migration with worktree fails" (${from})`, async () => {
        const dir = repository(from);
        commit(dir, "initial");
        ok(dir, "worktree", "add", "-q", "wt");
        const { outcome } = await checkMigrate(
          dir,
          { format: to },
          { compareLayout: false, compareLogs: false },
        );
        expect(outcome.stderr).toBe(
          "error: migrating repositories with worktrees is not supported yet\n",
        );
      });

      it(`t1460-refs-migrate.sh: "$from_format -> $to_format: unborn HEAD" (${from})`, async () => {
        await checkMigrate(repository(from), { format: to });
      });

      it(`t1460-refs-migrate.sh: "$from_format -> $to_format: single ref" (${from})`, async () => {
        const dir = repository(from);
        commit(dir, "initial");
        await checkMigrate(dir, { format: to });
      });

      it(`t1460-refs-migrate.sh: "$from_format -> $to_format: bare repository" (${from})`, async () => {
        const dir = repository(from);
        commit(dir, "initial");
        const bare = `${dir}.git`;
        ok(root, "clone", "-q", `--ref-format=${from}`, "--mirror", dir, bare);
        await checkMigrate(bare, { format: to }, { bare: true });
        // a dry run there names its directory as git does (`./ref_migration.XXXXXX`)
        const { outcome } = await checkMigrate(bare, { format: to, dryRun: true }, { bare: true });
        expect(outcome.stdout).toContain("'./ref_migration.");
      });

      it(`t1460-refs-migrate.sh: "$from_format -> $to_format: dangling symref" (${from})`, async () => {
        const dir = repository(from);
        commit(dir, "initial");
        ok(dir, "symbolic-ref", "BROKEN_HEAD", "refs/heads/nonexistent");
        const { ours } = await checkMigrate(dir, { format: to });
        expect(ok(ours, "symbolic-ref", "BROKEN_HEAD")).toBe("refs/heads/nonexistent\n");
      });

      it(`t1460-refs-migrate.sh: "$from_format -> $to_format: broken ref" (${from})`, async () => {
        // test-tool's REF_SKIP_OID_VERIFICATION: a loose ref to a missing object, migrated
        // into the reftable format first when that is the one tested
        const dir = repository("files");
        commit(dir, "initial");
        const missing = "0000000000000000000000000000000000000001";
        writeFileSync(join(dir, ".git", "refs", "heads", "broken"), `${missing}\n`);
        if (from === "reftable") ok(dir, "refs", "migrate", "--ref-format=reftable");
        const { ours } = await checkMigrate(dir, { format: to });
        expect(ok(ours, "rev-parse", "refs/heads/broken")).toBe(`${missing}\n`);
      });

      it(`t1460-refs-migrate.sh: "$from_format -> $to_format: pseudo-refs" (${from})`, async () => {
        const dir = repository(from);
        commit(dir, "initial");
        ok(dir, "update-ref", "FOO_HEAD", "HEAD");
        await checkMigrate(dir, { format: to });
      });

      it(`t1460-refs-migrate.sh: "$from_format -> $to_format: special refs are left alone" (${from})`, async () => {
        const dir = repository(from);
        commit(dir, "initial");
        writeFileSync(join(dir, ".git", "MERGE_HEAD"), ok(dir, "rev-parse", "HEAD"));
        const { ours } = await checkMigrate(dir, { format: to });
        expect(existsSync(join(ours, ".git", "MERGE_HEAD"))).toBe(true);
      });

      it(`t1460-refs-migrate.sh: "$from_format -> $to_format: a bunch of refs" (${from})`, async () => {
        const dir = repository(from);
        commit(dir, "initial");
        ok(dir, "tag", "-a", "-m", "annotated", "annotated");
        const input = [
          "create FOO_HEAD HEAD",
          "create refs/heads/branch-1 HEAD",
          "create refs/heads/branch-2 HEAD",
          "create refs/heads/branch-3 HEAD",
          "create refs/heads/branch-4 HEAD",
          "create refs/tags/tag-1 HEAD",
          "create refs/tags/tag-2 HEAD",
          "",
        ].join("\n");
        const r = run(dir, ["update-ref", "--stdin"], input);
        expect(r.status).toBe(0);
        await checkMigrate(dir, { format: to });
      });

      it(`t1460-refs-migrate.sh: "$from_format -> $to_format: dry-run migration does not modify repository" (${from})`, async () => {
        const dir = repository(from);
        commit(dir, "initial");
        const { native, ours, outcome } = await checkMigrate(dir, { format: to, dryRun: true });
        expect(outcome.stdout).toMatch(/^Finished dry-run migration of refs/);
        expect(ok(ours, "rev-parse", "--show-ref-format")).toBe(`${from}\n`);
        // the dry run's directory holds the new storage as native's does
        const dryRunDir = (d: string) =>
          join(
            d,
            ".git",
            readdirSync(join(d, ".git")).find((n) => n.startsWith("ref_migration.")) as string,
          );
        const listing = (d: string) =>
          readdirSync(dryRunDir(d), { recursive: true }).map(String).sort();
        const tables = (names: string[]) =>
          names.map((n) => n.replace(/0x[0-9a-f]{12}-0x[0-9a-f]{12}-[0-9a-f]{8}\.ref$/, "<table>"));
        expect(tables(listing(ours))).toEqual(tables(listing(native)));
      });

      it(`t1460-refs-migrate.sh: "$from_format -> $to_format: reflogs of symrefs with target deleted" (${from})`, async () => {
        const dir = repository(from);
        commit(dir, "initial");
        ok(dir, "branch", "branch-1", "HEAD");
        ok(dir, "symbolic-ref", "refs/heads/symref", "refs/heads/branch-1");
        expect(run(dir, ["update-ref", "--stdin"], "delete refs/heads/branch-1\n").status).toBe(0);
        await checkMigrate(dir, { format: to });
      });

      it(`t1460-refs-migrate.sh: "$from_format -> $to_format: reflogs order is retained" (${from})`, async () => {
        const dir = repository(from);
        time = 100005000;
        commit(dir, "initial", { tag: false });
        time = 100003000;
        commit(dir, "second", { tag: false });
        time = 1112911993;
        await checkMigrate(dir, { format: to });
      });

      it(`t1460-refs-migrate.sh: "$from_format -> $to_format: stash is retained" (${from})`, async () => {
        const dir = repository(from);
        commit(dir, "initial", { file: "A" });
        writeFileSync(join(dir, "A"), "foo\n");
        ok(dir, "stash", "push", "-q");
        writeFileSync(join(dir, "A"), "bar\n");
        ok(dir, "stash", "push", "-q");
        const before = ok(dir, "stash", "list");
        const { ours } = await checkMigrate(dir, { format: to });
        expect(ok(ours, "stash", "list")).toBe(before);
      });

      it(`t1460-refs-migrate.sh: "$from_format -> $to_format: skip reflog with --skip-reflog" (${from})`, async () => {
        const dir = repository(from);
        commit(dir, "initial");
        expect(ok(dir, "reflog", "--all").split("\n").filter(Boolean)).toHaveLength(2);
        const { ours } = await checkMigrate(dir, { format: to, noReflog: true });
        expect(ok(ours, "reflog", "--all")).toBe("");
      });

      it(`ReftableConversionTest: annotated tags, symbolic refs, remotes and reflogs convert (${from})`, async () => {
        const dir = repository(from);
        commit(dir, "first");
        ok(dir, "tag", "-a", "-m", "v1", "v1");
        ok(dir, "tag", "-a", "-m", "nested", "v1-nested", "v1");
        ok(dir, "checkout", "-q", "-b", "topic");
        commit(dir, "second");
        ok(dir, "checkout", "-q", "main");
        ok(
          dir,
          "update-ref",
          "-m",
          "  odd\twhitespace  message ",
          "refs/remotes/origin/main",
          "HEAD",
        );
        ok(dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
        ok(dir, "update-ref", "ORIG_HEAD", "topic");
        ok(dir, "update-ref", "refs/notes/commits", "HEAD");
        // reflogs in git's order: each directory's entries sorted, `a/b` before `a-b`
        ok(dir, "branch", "a/b");
        ok(dir, "branch", "a-b");
        await checkMigrate(dir, { format: to });
      });

      it(`ReftableConversionTest: a converted repository converts back to the same refs (${from})`, async () => {
        const dir = repository(from);
        commit(dir, "first");
        commit(dir, "second");
        ok(dir, "branch", "side", "first");
        const before = refListing(dir);
        const logs = reflogFiles(dir, false);
        const { ours } = await checkMigrate(dir, { format: to });
        // and back, by ours, on the migrated copy native git made with ours
        const git = await openOurs(ours);
        const back = outcomeOf(await git.refsMigrate().setRefFormat(from).callOutput());
        expect(back).toEqual({ status: 0, stdout: "", stderr: "" });
        expect(refListing(ours)).toBe(before);
        expect(reflogFiles(ours, false)).toEqual(logs);
        expect(run(ours, ["refs", "verify"]).status).toBe(0);
      });
    });
  }

  it('files -> reftable with symbolic-link refs (t0602-reffiles-fsck.sh: "symlink symref content should be checked")', async () => {
    // files_read_raw_ref: a link naming refs/... is a symbolic ref, any other is followed
    const dir = repository("files");
    commit(dir, "initial");
    const git = join(dir, ".git");
    rmSync(join(git, "HEAD"));
    symlinkSync("refs/heads/main", join(git, "HEAD"));
    symlinkSync("main", join(git, "refs", "heads", "alias"));
    const { ours } = await checkMigrate(dir, { format: "reftable" });
    expect(ok(ours, "symbolic-ref", "HEAD")).toBe("refs/heads/main\n");
    expect(ok(ours, "rev-parse", "refs/heads/alias")).toBe(ok(ours, "rev-parse", "main"));
  });

  it('t1460-refs-migrate.sh: "$from_format -> $to_format: broken ref" (unparsable content, files)', async () => {
    // a deliberate divergence: git 2.56.1 migrates this repository into an empty storage
    // (every ref lost, exit 0); ours refuses and leaves it untouched
    const dir = repository("files");
    commit(dir, "initial");
    writeFileSync(join(dir, ".git", "refs", "heads", "bad"), "garbage\n");
    const before = refListing(dir);
    const ours = await oursMigrate(dir, { format: "reftable" });
    expect(ours).toEqual({
      status: 255,
      stdout: "",
      stderr: "error: cannot migrate the broken ref 'refs/heads/bad'\n",
    });
    expect(refListing(dir)).toBe(before);
    expect(readdirSync(join(dir, ".git")).filter((n) => n.startsWith("ref_migration"))).toEqual([]);
  });

  it('t1460-refs-migrate.sh: "multiple reftable blocks with multiple entries"', async () => {
    const dir = repository("files");
    commit(dir, "first");
    const create = Array.from({ length: 5000 }, (_, i) => `create refs/heads/ref-${i + 1} HEAD`);
    expect(run(dir, ["update-ref", "--stdin"], `${create.join("\n")}\n`).status).toBe(0);
    commit(dir, "second");
    const update = Array.from({ length: 3000 }, (_, i) => `update refs/heads/ref-${i + 1} HEAD`);
    expect(run(dir, ["update-ref", "--stdin"], `${update.join("\n")}\n`).status).toBe(0);
    await checkMigrate(dir, { format: "reftable" }, { compareLayout: false });
  }, 60_000);

  it('t1460-refs-migrate.sh: "migrating from files format deletes backend files"', async () => {
    const dir = repository("files");
    commit(dir, "first");
    ok(dir, "pack-refs", "--all");
    commit(dir, "second");
    ok(dir, "update-ref", "ORIG_HEAD", "HEAD");
    writeFileSync(join(dir, ".git", "FETCH_HEAD"), ok(dir, "rev-parse", "HEAD"));
    const { ours } = await checkMigrate(dir, { format: "reftable" });
    const git = join(ours, ".git");
    expect(readFileSync(join(git, "HEAD"), "utf8")).toBe("ref: refs/heads/.invalid\n");
    expect(readFileSync(join(git, "refs", "heads"), "utf8")).toBe(
      "this repository uses the reftable format\n",
    );
    expect(existsSync(join(git, "FETCH_HEAD"))).toBe(true);
    expect(existsSync(join(git, "ORIG_HEAD"))).toBe(false);
    expect(existsSync(join(git, "logs"))).toBe(false);
    expect(existsSync(join(git, "packed-refs"))).toBe(false);
  });

  it('t1460-refs-migrate.sh: "migrating from reftable format deletes backend files"', async () => {
    const dir = repository("reftable");
    commit(dir, "first");
    const { ours } = await checkMigrate(dir, { format: "files" });
    const git = join(ours, ".git");
    expect(existsSync(join(git, "reftable"))).toBe(false);
    expect(readFileSync(join(git, "HEAD"), "utf8")).toBe("ref: refs/heads/main\n");
    expect(statSync(join(git, "packed-refs")).isFile()).toBe(true);
  });

  it("ReftableCreationTest: a repository created as reftable by ours migrates as native's", async () => {
    // ours creates the reftable repository (`init --ref-format=reftable`), native writes refs
    const dir = join(root, `ours-created-${counter++}`);
    mkdirSync(dir);
    const { Git } = await import("../src/index.js");
    const { createNodeFilesApi } = await import("@statewalker/vcs-utils-node/files");
    await Git.init()
      .setFilesApi(createNodeFilesApi({ rootDir: dir }))
      .setGitDir(".git")
      .setInitialBranch("main")
      .setRefFormat("reftable")
      .call();
    commit(dir, "first");
    ok(dir, "branch", "side");
    await checkMigrate(dir, { format: "files" });
  });
});

/** `git refs verify [--strict] [--verbose]` by native git and by ours on twins of `dir`. */
async function checkVerify(dir: string, args: string[] = [], sortLines = false): Promise<Outcome> {
  const t = twins(dir);
  const native = run(t.native, ["refs", "verify", ...args]);
  const git = await openOurs(t.ours);
  const command = git.refsVerify();
  if (args.includes("--strict")) command.setStrict(true);
  if (args.includes("--verbose")) command.setVerbose(true);
  const ours = outcomeOf(await command.callOutput());
  // git walks refs/ in readdir order, ours by name
  const sorted = (o: Outcome) =>
    sortLines ? { ...o, stderr: o.stderr.split("\n").sort().join("\n") } : o;
  expect(sorted(ours)).toEqual(sorted(native));
  return native;
}

describe.skipIf(!canVerify)("git refs verify", () => {
  it('t0602-reffiles-fsck.sh: "lock files should be ignored"', async () => {
    const dir = repository("files");
    commit(dir, "initial");
    ok(dir, "pack-refs", "--all");
    commit(dir, "second");
    writeFileSync(join(dir, ".git", "refs", "heads", "main.lock"), "garbage\n");
    expect((await checkVerify(dir)).status).toBe(0);
    await checkVerify(dir, ["--verbose"], true);
  });

  it('t0602-reffiles-fsck.sh: "ref name should be checked"', async () => {
    const dir = repository("files");
    commit(dir, "initial");
    const id = ok(dir, "rev-parse", "HEAD");
    const heads = join(dir, ".git", "refs", "heads");
    writeFileSync(join(heads, ".branch-1"), id);
    writeFileSync(join(heads, "@"), id);
    mkdirSync(join(heads, "dir"));
    writeFileSync(join(heads, "dir", ".x.lock"), id);
    writeFileSync(join(heads, "branch.lock"), id);
    const native = await checkVerify(dir, [], true);
    expect(native.status).toBe(255);
    await checkVerify(dir, ["--strict"], true);
  });

  it('t0602-reffiles-fsck.sh: "regular ref content should be checked (aggregate)"', async () => {
    const dir = repository("files");
    commit(dir, "initial");
    const id = ok(dir, "rev-parse", "HEAD").trim();
    const heads = join(dir, ".git", "refs", "heads");
    writeFileSync(join(heads, "bad"), `${id}x\n`);
    writeFileSync(join(heads, "nonl"), id);
    writeFileSync(join(heads, "garbage"), `${id} garbage\n`);
    writeFileSync(join(heads, "trailing"), `${id}\n\n`);
    writeFileSync(join(heads, "short"), "abc\n");
    await checkVerify(dir, [], true);
    await checkVerify(dir, ["--strict"], true);
  });

  it('t0602-reffiles-fsck.sh: "textual symref content should be checked (aggregate)", "the target of the textual symref should be checked"', async () => {
    const dir = repository("files");
    commit(dir, "initial");
    const heads = join(dir, ".git", "refs", "heads");
    writeFileSync(join(heads, "a"), "ref: refs/heads/main");
    writeFileSync(join(heads, "b"), "ref: refs/heads/main  ");
    writeFileSync(join(heads, "c"), "ref:   refs/heads/main\n\n");
    writeFileSync(join(heads, "d"), "ref: refs/heads/.bad\n");
    writeFileSync(join(heads, "e"), "ref: logs/maint\n");
    writeFileSync(join(heads, "f"), "ref: ORIG_HEAD\n");
    writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/tags/initial\n");
    await checkVerify(dir, [], true);
    await checkVerify(dir, ["--strict"], true);
  });

  it('t0602-reffiles-fsck.sh: "the filetype of packed-refs should be checked"', async () => {
    const dir = repository("files");
    commit(dir, "initial");
    ok(dir, "pack-refs", "--all");
    const git = join(dir, ".git");
    rmSync(join(git, "packed-refs"));
    mkdirSync(join(git, "packed-refs-back"));
    symlinkSync("packed-refs-back", join(git, "packed-refs"));
    await checkVerify(dir);
  });

  it('t0602-reffiles-fsck.sh: "packed-refs header should be checked"', async () => {
    const dir = repository("files");
    commit(dir, "initial");
    const id = ok(dir, "rev-parse", "HEAD").trim();
    const packed = join(dir, ".git", "packed-refs");
    for (const header of [
      "# pack-refs wit: peeled fully-peeled sorted ",
      "# pack-refs with traits: peeled",
      "# pack-refs of: peeled",
    ]) {
      writeFileSync(packed, `${header}\n${id} refs/heads/packed\n`);
      await checkVerify(dir);
    }
  });

  it('t0602-reffiles-fsck.sh: "packed-refs missing header should not be reported", "packed-refs content should be checked", "empty packed-refs should be reported"', async () => {
    const dir = repository("files");
    commit(dir, "initial");
    ok(dir, "tag", "-a", "-m", "annotated", "annotated-1");
    const id = ok(dir, "rev-parse", "HEAD").trim();
    const tag = ok(dir, "rev-parse", "annotated-1").trim();
    const packed = join(dir, ".git", "packed-refs");
    writeFileSync(packed, `${id} refs/heads/branch-1\n`);
    expect((await checkVerify(dir)).status).toBe(0);
    writeFileSync(
      packed,
      [
        "# pack-refs with: peeled fully-peeled sorted ",
        `${id.slice(0, 20)} refs/heads/branch-1`,
        `${id}x refs/heads/branch-2`,
        `${id} refs/heads/bad-branch.lock`,
        `${tag} refs/tags/annotated-tag-1`,
        `^${id.slice(0, 20)}`,
        `${tag} refs/tags/annotated-tag-2`,
        `^${id} garbage`,
        "",
      ].join("\n"),
    );
    await checkVerify(dir);
    writeFileSync(packed, `# pack-refs with: peeled fully-peeled sorted \n${id} refs/heads/x`);
    await checkVerify(dir);
    writeFileSync(packed, "");
    await checkVerify(dir);
    await checkVerify(dir, ["--strict"]);
  });

  it('t0602-reffiles-fsck.sh: "packed-ref with sorted trait should be checked", "packed-ref without sorted trait should not be checked"', async () => {
    const dir = repository("files");
    commit(dir, "initial");
    const id = ok(dir, "rev-parse", "HEAD").trim();
    const packed = join(dir, ".git", "packed-refs");
    const body = `${id} refs/heads/main\n${id} refs/heads/a\n${id} refs/heads/b\n`;
    writeFileSync(packed, `# pack-refs with: peeled fully-peeled sorted \n${body}`);
    await checkVerify(dir);
    writeFileSync(packed, `# pack-refs with: peeled fully-peeled \n${body}`);
    await checkVerify(dir);
  });

  it('t0602-reffiles-fsck.sh: "ref name check should be adapted into fsck messages"', async () => {
    const dir = repository("files");
    commit(dir, "initial");
    const id = ok(dir, "rev-parse", "HEAD").trim();
    writeFileSync(join(dir, ".git", "refs", "heads", "nonl"), id);
    writeFileSync(join(dir, ".git", "refs", "heads", "bad"), "garbage\n");
    ok(dir, "config", "fsck.refMissingNewline", "error");
    ok(dir, "config", "fsck.badRefContent", "ignore");
    writeFileSync(join(dir, ".git", "refs", "heads", ".bad"), `${id}\n`);
    ok(dir, "config", "fsck.badRefName", "warn");
    await checkVerify(dir, [], true);
    // an id git does not know is its death
    ok(dir, "config", "fsck.noSuchId", "warn");
    expect((await checkVerify(dir)).status).toBe(128);
  });

  it('t0602-reffiles-fsck.sh: "ref content checks should work with worktrees"', async () => {
    const dir = repository("files");
    commit(dir, "initial");
    ok(dir, "worktree", "add", "-q", "wt");
    ok(join(dir, "wt"), "update-ref", "refs/worktree/w", "HEAD");
    const admin = join(dir, ".git", "worktrees", "wt");
    writeFileSync(
      join(admin, "refs", "worktree", ".bad"),
      `${ok(dir, "rev-parse", "HEAD").trim()}\n`,
    );
    writeFileSync(join(admin, "ORIG_HEAD"), "garbage\n");
    await checkVerify(dir, [], true);
  });

  it('t0614-reftable-fsck.sh: "no errors reported on a well formed repository"', async () => {
    const dir = repository("reftable");
    commit(dir, "initial");
    ok(dir, "branch", "side");
    expect((await checkVerify(dir)).status).toBe(0);
    await checkVerify(dir, ["--verbose"]);
  });

  for (const name of [
    "foo-bar-e4d12d59.ref",
    "0x00000000zzzz-0x00000000zzzz-e4d12d59.ref",
    "0x000000000001-0x000000000002-e4d12d59.abc",
    "0x000000000001-0x000000000002-e4d12d59.refabc",
  ]) {
    it(`t0614-reftable-fsck.sh: "table name $TABLE_NAME should be checked" (${name})`, async () => {
      const dir = repository("reftable");
      commit(dir, "initial");
      const stack = join(dir, ".git", "reftable");
      const list = readFileSync(join(stack, "tables.list"), "utf8");
      const first = list.split("\n")[0] as string;
      execFileSync("mv", [join(stack, first), join(stack, name)]);
      writeFileSync(join(stack, "tables.list"), list.replace(first, name));
      const native = await checkVerify(dir);
      expect(native.stderr).toBe(
        `warning: ${name}: badReftableTableName: invalid reftable table name\n`,
      );
      await checkVerify(dir, ["--strict"]);
    });
  }

  it('t0614-reftable-fsck.sh: "invalid symref gets reported"', async () => {
    const dir = repository("reftable");
    commit(dir, "initial");
    ok(dir, "symbolic-ref", "refs/heads/symref", "garbage");
    ok(dir, "symbolic-ref", "refs/heads/odd", "logs/x");
    await checkVerify(dir);
    await checkVerify(dir, ["--strict"]);
  });
});

describe.skipIf(!canExists)("git refs exists", () => {
  it("t1462-refs-exists.sh (show-ref-exists-tests.sh): existing, missing, symbolic, dangling and directory refs", async () => {
    const dir = repository("files");
    commit(dir, "initial");
    ok(dir, "symbolic-ref", "refs/heads/dangling", "refs/heads/nope");
    for (const ref of [
      "refs/heads/main",
      "HEAD",
      "refs/heads/nope",
      "refs/heads/dangling",
      "refs/heads",
      "refs/tags/initial",
    ]) {
      const native = run(dir, ["refs", "exists", ref]);
      const git = await openOurs(dir);
      const ours = outcomeOf(await git.refsExists().setRef(ref).callOutput());
      expect({ ref, ...ours }).toEqual({ ref, ...native });
    }
    const native = run(dir, ["refs", "exists"]);
    const git = await openOurs(dir);
    const ours = outcomeOf(await git.refsExists().callOutput());
    expect(ours).toEqual(native);
  });
});

describe.skipIf(!canList)("git refs list", () => {
  it("t1461-refs-list.sh (for-each-ref-tests.sh): refs list lists as for-each-ref", async () => {
    const dir = repository("files");
    commit(dir, "initial");
    ok(dir, "tag", "-a", "-m", "t", "annotated");
    ok(dir, "branch", "side");
    const native = run(dir, ["refs", "list", "--format=%(refname) %(objecttype) %(*objectname)"]);
    const git = await openOurs(dir);
    const ours = await git.refsList().setFormat("%(refname) %(objecttype) %(*objectname)").call();
    expect(ours.output).toBe(native.stdout);
  });
});

describe.skipIf(!canOptimize)("git refs optimize", () => {
  for (const format of ["files", "reftable"]) {
    it(`t1463-refs-optimize.sh (pack-refs-tests.sh): refs optimize --all packs as pack-refs (${format})`, async () => {
      const dir = repository(format);
      commit(dir, "initial");
      ok(dir, "branch", "a");
      ok(dir, "branch", "b");
      const t = twins(dir);
      expect(run(t.native, ["refs", "optimize", "--all"]).status).toBe(0);
      const git = await openOurs(t.ours);
      await git.refsOptimize().setAll(true).call();
      expect(refListing(t.ours)).toBe(refListing(t.native));
      const storage = (d: string) =>
        format === "files"
          ? [
              readFileSync(join(d, ".git", "packed-refs"), "latin1"),
              readdirSync(join(d, ".git", "refs", "heads")),
            ]
          : readFileSync(join(d, ".git", "reftable", "tables.list"), "utf8")
              .split("\n")
              .filter(Boolean).length;
      expect(storage(t.ours)).toEqual(storage(t.native));
    });
  }
});
