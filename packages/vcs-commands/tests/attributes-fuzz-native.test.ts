/**
 * Attributes and line endings against native git (a seeded differential fuzz): each seed
 * makes a layout of files with random content (LF, CRLF, lone CR, NUL, `$Id$`), random
 * `.gitattributes` in random directories, `info/attributes`, macros, and random
 * `core.autocrlf` / `core.eol` / `core.safecrlf`. Built twice (never copied); both twins are
 * compared on `git check-attr -a` against our attributes, `git add` (ls-files -s --eol, the
 * warnings, a refusal), status, and the bytes `reset --hard` writes after the files are
 * removed.
 *
 * A few seeds run by default; `ATTR_FUZZ=full` runs 500 (or `ATTR_FUZZ_START` /
 * `ATTR_FUZZ_COUNT`), `ATTR_FUZZ_SEED=<n>` one seed, `ATTR_FUZZ_OUT=<file>` writes the
 * mismatches as JSON.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFileWorktree,
  createGitFilesBackend,
  FileStagingStore,
  GitCheckout,
  type GitCheckoutFilesApi,
  GitWorkingCopyConfig,
} from "@statewalker/vcs-store-files";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { type GitContentFilter, MemoryWorkingCopy } from "@statewalker/vcs-working-tree";
import { describe, expect, it } from "vitest";

import { formatStatusPorcelain, Git, ResetMode } from "../src/index.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

const FULL = process.env.ATTR_FUZZ === "full";
const START = Number(process.env.ATTR_FUZZ_START ?? 31000);
const COUNT = Number(process.env.ATTR_FUZZ_COUNT ?? (FULL ? 500 : 40));
const ONLY = process.env.ATTR_FUZZ_SEED ? Number(process.env.ATTR_FUZZ_SEED) : undefined;
const OUT = process.env.ATTR_FUZZ_OUT;

let home = "";
const runResult = (cwd: string, args: string[]) => {
  const r = spawnSync("git", args, { cwd, env: nativeGitEnv(home), encoding: "latin1" });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};
const run = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    env: nativeGitEnv(home),
    encoding: "latin1",
    stdio: ["ignore", "pipe", "pipe"],
  });

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  const r = () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 2 ** 32;
  };
  for (let i = 0; i < 5; i++) r();
  return r;
}

const DIRS = ["", "", "a", "a/b", "c"];
const NAMES = ["x.txt", "y.TXT", "z.bin", "w", "q.c", "a b.txt", "n.txt"];
const PATTERNS = [
  "*.txt",
  "*",
  "x.txt",
  "/x.txt",
  "a/*.txt",
  "**/b/*",
  "*.[tb]*",
  '"a b.txt"',
  "?.c",
  "b/",
  "*.TXT",
  "a/**",
  "w",
  "\\!x",
];
const STATES = [
  "text",
  "-text",
  "!text",
  "text=auto",
  "eol=lf",
  "eol=crlf",
  "binary",
  "-crlf",
  "crlf",
  "crlf=input",
  "ident",
  "mac",
  "-mac",
  "!eol",
  "eol=weird",
  "text=weird",
  "-diff",
];
const MACROS = ["[attr]mac text eol=crlf", "[attr]mac -text", "[attr]mac text=auto ident"];
const SNIPPETS = ["a", "b c", "\n", "\n", "\r\n", "\r\n", "\r", "\0", "$Id$", "é", "\t", "\x01"];
const CONFIGS = [
  ["core.autocrlf", "true"],
  ["core.autocrlf", "input"],
  ["core.autocrlf", "false"],
  ["core.eol", "crlf"],
  ["core.eol", "lf"],
  ["core.safecrlf", "false"],
  ["core.safecrlf", "true"],
  ["core.safecrlf", "warn"],
];

interface Layout {
  files: Map<string, string>;
  attributes: Map<string, string[]>;
  info?: string[];
  config: string[][];
}

function genLayout(seed: number): Layout {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  const files = new Map<string, string>();
  const nf = 2 + Math.floor(r() * 6);
  for (let i = 0; i < nf; i++) {
    const dir = pick(DIRS);
    const path = dir ? `${dir}/${pick(NAMES)}` : pick(NAMES);
    let content = "";
    const len = Math.floor(r() * 10);
    for (let k = 0; k < len; k++) content += pick(SNIPPETS);
    files.set(path, content);
  }
  const line = () => {
    const n = 1 + Math.floor(r() * 3);
    const states = Array.from({ length: n }, () => pick(STATES));
    return `${pick(PATTERNS)} ${states.join(" ")}`;
  };
  const attributes = new Map<string, string[]>();
  const na = Math.floor(r() * 3) + 1;
  for (let i = 0; i < na; i++) {
    const dir = pick(DIRS);
    const lines = Array.from({ length: 1 + Math.floor(r() * 3) }, line);
    if (r() < 0.4) lines.unshift(pick(MACROS));
    attributes.set(dir, lines);
  }
  const layout: Layout = { files, attributes, config: [] };
  if (r() < 0.3) layout.info = Array.from({ length: 1 + Math.floor(r() * 2) }, line);
  const nc = Math.floor(r() * 3);
  for (let i = 0; i < nc; i++) layout.config.push(pick(CONFIGS));
  return layout;
}

function build(dir: string, L: Layout) {
  mkdirSync(dir, { recursive: true });
  run(dir, "init", "-q", "-b", "main");
  for (const [k, v] of L.config) run(dir, "config", k, v);
  for (const [path, content] of L.files) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), Buffer.from(content, "utf8"));
  }
  for (const [d, lines] of L.attributes) {
    mkdirSync(join(dir, d), { recursive: true });
    writeFileSync(join(dir, d, ".gitattributes"), `${lines.join("\n")}\n`);
  }
  if (L.info) {
    mkdirSync(join(dir, ".git", "info"), { recursive: true });
    writeFileSync(join(dir, ".git", "info", "attributes"), `${L.info.join("\n")}\n`);
  }
}

async function open(dir: string) {
  const files = createNodeFilesApi({ rootDir: dir });
  const { history } = await createGitFilesBackend({ files });
  const io = {
    read: async (path: string) => {
      try {
        return new Uint8Array(readFileSync(join(dir, path)));
      } catch {
        return undefined;
      }
    },
    write: async (path: string, content: Uint8Array) => writeFileSync(join(dir, path), content),
  };
  const config = new GitWorkingCopyConfig(io, ".git/config");
  await config.load();
  const staging = new FileStagingStore(files, ".git/index");
  await staging.read();
  const checkout = new GitCheckout({
    staging,
    refs: history.refs,
    files: {
      read: io.read,
      write: (p: string, c: Uint8Array) => files.write(p, [c]),
      stats: async () => undefined,
      remove: async () => {},
    } as unknown as GitCheckoutFilesApi,
    gitDir: ".git",
  });
  const worktree = createFileWorktree({
    files,
    rootPath: "",
    gitDir: ".git",
    blobs: history.blobs,
    trees: history.trees,
  });
  const wc = new MemoryWorkingCopy({ history, checkout, worktree, config });
  return { git: Git.fromWorkingCopy(wc), filter: worktree.contentFilter as GitContentFilter };
}

const warningsOf = (stderr: string) =>
  stderr
    .split("\n")
    .filter((l) => l.startsWith("warning: in the working copy"))
    .map((l) => l.slice("warning: ".length))
    .sort();
const fatalOf = (stderr: string) =>
  stderr
    .split("\n")
    .find((l) => l.startsWith("fatal: "))
    ?.slice("fatal: ".length);

async function one(root: string, seed: number) {
  const L = genLayout(seed);
  const native = join(root, `n${seed}`);
  const ours = join(root, `o${seed}`);
  build(native, L);
  build(ours, L);
  const diffs: string[] = [];
  const paths = [...L.files.keys()].sort();

  // attributes as git check-attr reads them (from the worktree)
  const checkAttr = run(native, "check-attr", "-a", "-z", "--", ...paths).split("\0");
  const nativeAttrs = new Map<string, string[]>();
  for (let i = 0; i + 2 < checkAttr.length; i += 3) {
    const [path, name, value] = checkAttr.slice(i, i + 3);
    const list = nativeAttrs.get(path) ?? [];
    list.push(`${name}=${value}`);
    nativeAttrs.set(path, list);
  }
  {
    const { filter } = await open(ours);
    for (const path of paths) {
      const attrs = await filter.attributes(path);
      const mine = [...attrs]
        .map(([k, v]) => `${k}=${v === true ? "set" : v === false ? "unset" : v}`)
        .sort();
      const theirs = (nativeAttrs.get(path) ?? []).sort();
      if (JSON.stringify(mine) !== JSON.stringify(theirs)) {
        diffs.push(`check-attr ${path}: ours=${mine.join(" ")} git=${theirs.join(" ")}`);
      }
    }
  }

  // add
  const nativeAdd = runResult(native, ["add", "."]);
  let ourWarnings: string[] = [];
  let ourError: string | undefined;
  try {
    const { git } = await open(ours);
    ourWarnings = (await git.add().addFilepattern(".").call()).warnings.slice().sort();
  } catch (e) {
    ourError = (e as Error).message;
  }
  const nativeError = nativeAdd.status !== 0 ? fatalOf(nativeAdd.stderr) : undefined;
  if (nativeError !== ourError) diffs.push(`add error: ours=${ourError} git=${nativeError}`);
  const nativeWarnings = warningsOf(nativeAdd.stderr);
  if (!nativeError && JSON.stringify(nativeWarnings) !== JSON.stringify(ourWarnings)) {
    diffs.push(
      `add warnings: ours=${JSON.stringify(ourWarnings)} git=${JSON.stringify(nativeWarnings)}`,
    );
  }
  const lsN = run(native, "ls-files", "-s", "--eol");
  const lsO = run(ours, "ls-files", "-s", "--eol");
  if (lsN !== lsO) diffs.push(`ls-files after add:\ngit:\n${lsN}ours:\n${lsO}`);
  const stN = run(native, "status", "--porcelain=v1", "-uall");
  const stO = formatStatusPorcelain(await (await open(ours)).git.status().call(), 1);
  if (stN !== stO) diffs.push(`status after add:\ngit:\n${stN}ours:\n${stO}`);

  // checkout: commit, remove the files, reset --hard
  if (!nativeError && !ourError) {
    for (const dir of [native, ours]) {
      run(dir, "-c", "core.safecrlf=false", "add", "-f", ".");
      run(dir, "commit", "-q", "-m", "c1", "--allow-empty");
      for (const path of paths) unlinkSync(join(dir, path));
    }
    const reset = runResult(native, ["reset", "-q", "--hard"]);
    try {
      await (await open(ours)).git.reset().setMode(ResetMode.HARD).setRef("HEAD").call();
    } catch (e) {
      diffs.push(`reset failed: ${(e as Error).message} (git: ${reset.status})`);
    }
    for (const path of paths) {
      const a = readFileSync(join(native, path)).toString("latin1");
      let b = "(missing)";
      try {
        b = readFileSync(join(ours, path)).toString("latin1");
      } catch {}
      if (a !== b)
        diffs.push(`checkout ${path}: ours=${JSON.stringify(b)} git=${JSON.stringify(a)}`);
    }
    const st2N = run(native, "status", "--porcelain=v1", "-uall");
    const st2O = formatStatusPorcelain(await (await open(ours)).git.status().call(), 1);
    if (st2N !== st2O) diffs.push(`status after checkout:\ngit:\n${st2N}ours:\n${st2O}`);
  }
  rmSync(native, { recursive: true, force: true });
  rmSync(ours, { recursive: true, force: true });
  return {
    seed,
    layout: {
      ...L,
      files: Object.fromEntries(L.files),
      attributes: Object.fromEntries(L.attributes),
    },
    diffs,
  };
}

describeGit("attributes and line endings against native git (differential fuzz)", () => {
  it(`match git (${ONLY !== undefined ? `seed ${ONLY}` : `seeds ${START}..${START + COUNT - 1}`})`, async () => {
    const root = mkdtempSync(join(tmpdir(), "attr-fuzz-"));
    home = join(root, "home");
    mkdirSync(home);
    const seeds = ONLY !== undefined ? [ONLY] : Array.from({ length: COUNT }, (_, i) => START + i);
    const bad = [];
    try {
      for (const s of seeds) {
        const res = await one(root, s);
        if (res.diffs.length) bad.push(res);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    if (OUT) writeFileSync(OUT, JSON.stringify({ n: seeds.length, bad }, null, 1));
    expect(bad).toEqual([]);
  }, 3_600_000);
});
