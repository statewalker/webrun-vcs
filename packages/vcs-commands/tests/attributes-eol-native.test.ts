/**
 * Attributes and end-of-line conversion against native git: each scenario is built twice by
 * the same steps (never copied), once finished by native git and once by our commands, and
 * the results compared byte for byte: `git ls-files -s --eol` (the blobs `add` stored and
 * their line endings), the warnings `add` prints, the files a checkout writes, and
 * `git status --porcelain` against our status.
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
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import {
  type FilterDriverRegistry,
  type GitHostEnvironment,
  MemoryWorkingCopy,
} from "@statewalker/vcs-working-tree";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { formatStatusPorcelain, Git, ResetMode } from "../src/index.js";
import {
  nativeGitAvailable,
  nativeGitEnv,
  nativeGitHttpBackend,
} from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root = "";
let home = "";
const env = () => nativeGitEnv(home);
const run = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    env: env(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
const runResult = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", args, { cwd, env: env(), encoding: "utf8" });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};
const put = (dir: string, path: string, content: string | Uint8Array) => {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), content);
};
const bytes = (dir: string, path: string) => readFileSync(join(dir, path)).toString("latin1");
/** Warnings of a native git run, in order (`warning: ` dropped). */
const warningsOf = (stderr: string) =>
  stderr
    .split("\n")
    .filter((l) => l.startsWith("warning: "))
    .map((l) => l.slice("warning: ".length));

async function open(
  dir: string,
  extra: { environment?: GitHostEnvironment; drivers?: FilterDriverRegistry } = {},
) {
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
  const environment =
    extra.environment ??
    createNodeGitHostEnvironment({
      home,
      xdgConfigHome: join(home, ".config"),
      // the global files of `home`, no system files (as the native twins read)
      env: { GIT_CONFIG_NOSYSTEM: "1", GIT_ATTR_NOSYSTEM: "1" },
    });
  const config = new GitWorkingCopyConfig(io, ".git/config", {
    environment,
    gitDirPath: join(dir, ".git"),
  });
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
  const wc = new MemoryWorkingCopy({
    history,
    checkout,
    worktree,
    config,
    ...(extra.drivers ? { filterDrivers: extra.drivers } : {}),
  });
  return { git: Git.fromWorkingCopy(wc), wc, worktree, config };
}

/** Builds the same repository twice: `native` and `ours`. */
function twins(name: string, build: (dir: string) => void): { native: string; ours: string } {
  const native = join(root, `${name}-native`);
  const ours = join(root, `${name}-ours`);
  for (const dir of [native, ours]) {
    mkdirSync(dir, { recursive: true });
    run(dir, "init", "-q", "-b", "main");
    build(dir);
  }
  return { native, ours };
}

const lsEol = (dir: string) => run(dir, "ls-files", "-s", "--eol");
const nativeStatus = (dir: string) => run(dir, "status", "--porcelain=v1", "-uall");
async function ourStatus(dir: string) {
  const { git } = await open(dir);
  return formatStatusPorcelain(await git.status().call(), 1);
}

/** Contents exercising git's heuristics: LF, CRLF, mixed, lone CR, NUL, none, empty. */
const CONTENTS: Record<string, string> = {
  "lf.txt": "one\ntwo\n",
  "crlf.txt": "one\r\ntwo\r\n",
  "mixed.txt": "one\r\ntwo\nthree\n",
  "lonecr.txt": "one\rtwo\n",
  "nul.txt": "one\0\ntwo\n",
  "noeol.txt": "no line ending",
  "empty.txt": "",
  "ctrl.txt": `${"x".repeat(100)}\x01\x02\n`,
  "dos.bin": "a\r\nb\r\n",
};

const ATTRIBUTES = [
  undefined,
  "* text=auto\n",
  "*.txt text\n",
  "*.txt text eol=crlf\n",
  "*.txt text eol=lf\n",
  "*.txt -text\n",
  "* text=auto eol=crlf\n",
  "* text=auto eol=lf\n",
  "*.txt binary\n",
  "*.txt crlf\n",
  "*.txt -crlf\n",
  "*.txt crlf=input\n",
  "*.txt eol=crlf\n",
  "[attr]mytext text eol=crlf\n*.txt mytext\n",
  "*.txt text\n*.txt !text\n",
];
const CONFIGS: Array<Record<string, string>> = [
  {},
  { "core.autocrlf": "true" },
  { "core.autocrlf": "input" },
  { "core.autocrlf": "false" },
  { "core.eol": "crlf" },
  { "core.eol": "lf" },
  { "core.autocrlf": "true", "core.safecrlf": "false" },
  { "core.eol": "crlf", "core.safecrlf": "warn" },
];

describeGit("attributes and line endings against native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "attr-eol-"));
    home = join(root, "home");
    mkdirSync(home);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("git add: blobs, ls-files --eol and warnings for every attributes x config x content", async () => {
    let n = 0;
    const mismatches: string[] = [];
    for (const attributes of ATTRIBUTES) {
      for (const config of CONFIGS) {
        const name = `add${n++}`;
        const { native, ours } = twins(name, (dir) => {
          for (const [k, v] of Object.entries(config)) run(dir, "config", k, v);
          if (attributes) put(dir, ".gitattributes", attributes);
          for (const [path, content] of Object.entries(CONTENTS)) put(dir, path, content);
        });
        const nativeAdd = runResult(native, "add", ".");
        const { git } = await open(ours);
        const result = await git.add().addFilepattern(".").call();
        const label = `${JSON.stringify(attributes)} ${JSON.stringify(config)}`;
        if (lsEol(native) !== lsEol(ours)) {
          mismatches.push(`${label}\nnative:\n${lsEol(native)}ours:\n${lsEol(ours)}`);
        }
        const nativeWarnings = warningsOf(nativeAdd.stderr).sort();
        const ourWarnings = [...result.warnings].sort();
        if (JSON.stringify(nativeWarnings) !== JSON.stringify(ourWarnings)) {
          mismatches.push(
            `${label} warnings\nnative: ${JSON.stringify(nativeWarnings)}\nours: ${JSON.stringify(ourWarnings)}`,
          );
        }
        const ns = nativeStatus(native);
        const os = await ourStatus(ours);
        if (ns !== os) mismatches.push(`${label} status\nnative:\n${ns}ours:\n${os}`);
        rmSync(native, { recursive: true, force: true });
        rmSync(ours, { recursive: true, force: true });
      }
    }
    expect(mismatches).toEqual([]);
  }, 600_000);

  it("checkout and reset --hard write the bytes git writes, and status stays clean", async () => {
    let n = 0;
    const mismatches: string[] = [];
    for (const attributes of ATTRIBUTES) {
      for (const config of CONFIGS) {
        const name = `co${n++}`;
        const { native, ours } = twins(name, (dir) => {
          run(dir, "commit", "-q", "--allow-empty", "-m", "c0");
          run(dir, "checkout", "-q", "-b", "files");
          if (attributes) put(dir, ".gitattributes", attributes);
          for (const [path, content] of Object.entries(CONTENTS)) put(dir, path, content);
          // committed as they are (no conversion yet), then the configuration applies
          run(dir, "-c", "core.autocrlf=false", "add", ".");
          run(dir, "commit", "-q", "-m", "c1");
          run(dir, "checkout", "-q", "main");
          for (const [k, v] of Object.entries(config)) run(dir, "config", k, v);
        });
        const label = `${JSON.stringify(attributes)} ${JSON.stringify(config)}`;
        // a branch switch writes the files (and the .gitattributes governing them)
        run(native, "checkout", "-q", "files");
        {
          const { git } = await open(ours);
          await git.checkout().setName("files").call();
        }
        for (const path of Object.keys(CONTENTS)) {
          if (bytes(native, path) !== bytes(ours, path)) {
            mismatches.push(
              `${label} checkout ${path}: native ${JSON.stringify(bytes(native, path))} ours ${JSON.stringify(bytes(ours, path))}`,
            );
          }
        }
        const ns = nativeStatus(native);
        const os = await ourStatus(ours);
        if (ns !== os) mismatches.push(`${label} status\nnative:\n${ns}ours:\n${os}`);
        // reset --hard after deleting again
        for (const dir of [native, ours]) {
          for (const path of Object.keys(CONTENTS)) unlinkSync(join(dir, path));
        }
        run(native, "reset", "-q", "--hard");
        {
          const { git } = await open(ours);
          await git.reset().setMode(ResetMode.HARD).setRef("HEAD").call();
        }
        for (const path of Object.keys(CONTENTS)) {
          if (bytes(native, path) !== bytes(ours, path)) {
            mismatches.push(
              `${label} reset ${path}: native ${JSON.stringify(bytes(native, path))} ours ${JSON.stringify(bytes(ours, path))}`,
            );
          }
        }
        const ns2 = nativeStatus(native);
        const os2 = await ourStatus(ours);
        if (ns2 !== os2)
          mismatches.push(`${label} status after reset\nnative:\n${ns2}ours:\n${os2}`);
        rmSync(native, { recursive: true, force: true });
        rmSync(ours, { recursive: true, force: true });
      }
    }
    expect(mismatches).toEqual([]);
  }, 600_000);
});

/** Index, status and the given files of a twin, as one comparable string. */
async function observe(dir: string, files: string[] = []): Promise<string> {
  const parts = [`ls-files:\n${lsEol(dir)}`, `status:\n${nativeStatus(dir)}`];
  for (const f of files) {
    let content: string;
    try {
      content = JSON.stringify(bytes(dir, f));
    } catch {
      content = "(missing)";
    }
    parts.push(`${f}: ${content}`);
  }
  return parts.join("\n");
}

const encode = (s: string) => new TextEncoder().encode(s);
const decode = (b: Uint8Array) => new TextDecoder().decode(b);

describeGit("attributes and line endings: scenarios against native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "attr-eol-s-"));
    home = join(root, "home");
    mkdirSync(home);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("CRLF already in the index stays under text=auto; status is clean; --renormalize converts", async () => {
    const { native, ours } = twins("crlf-index", (dir) => {
      put(dir, "a.txt", "one\r\ntwo\r\n");
      put(dir, "b.txt", "one\ntwo\n");
      run(dir, "add", ".");
      run(dir, "commit", "-q", "-m", "c1");
      put(dir, ".gitattributes", "* text=auto\n");
      put(dir, "a.txt", "one\r\ntwo\r\nthree\r\n");
    });
    expect(await ourStatus(ours)).toBe(nativeStatus(native));
    const nativeAdd = runResult(native, "add", ".");
    const { git } = await open(ours);
    const added = await git.add().addFilepattern(".").call();
    expect(await observe(ours)).toBe(await observe(native));
    expect(added.warnings).toEqual(warningsOf(nativeAdd.stderr));
    expect(await ourStatus(ours)).toBe(nativeStatus(native));
    // renormalize: the CRLF in the index no longer holds the conversion back
    const nativeRenorm = runResult(native, "add", "--renormalize", ".");
    const { git: git2 } = await open(ours);
    const renorm = await git2.add().addFilepattern(".").setRenormalize(true).call();
    expect(await observe(ours)).toBe(await observe(native));
    expect(renorm.warnings).toEqual(warningsOf(nativeRenorm.stderr));
    expect(await ourStatus(ours)).toBe(nativeStatus(native));
  });

  it("status reports an EOL-only change git reports (size changed), and not one it does not", async () => {
    const { native, ours } = twins("eol-status", (dir) => {
      run(dir, "config", "core.autocrlf", "true");
      put(dir, "a.txt", "one\ntwo\n");
      put(dir, "b.txt", "one\ntwo\n");
      put(dir, "c.txt", "one\ntwo\n");
      run(dir, "add", ".");
      run(dir, "commit", "-q", "-m", "c1");
      run(dir, "rm", "-q", "--cached", "a.txt", "b.txt", "c.txt");
      run(dir, "reset", "-q", "--hard");
      // a.txt: LF in the worktree now (size changed: git says modified without reading)
      put(dir, "a.txt", "one\ntwo\n");
      // b.txt: rewritten with the same CRLF bytes (stat changed, content the same)
      put(dir, "b.txt", "one\r\ntwo\r\n");
      // c.txt: CRLF with a content change
      put(dir, "c.txt", "one\r\nTWO\r\n");
    });
    expect(await ourStatus(ours)).toBe(nativeStatus(native));
    expect(await observe(ours, ["a.txt", "b.txt", "c.txt"])).toBe(
      await observe(native, ["a.txt", "b.txt", "c.txt"]),
    );
  });

  it("ident: $Id$ expanded on checkout, collapsed on add, status clean", async () => {
    const { native, ours } = twins("ident", (dir) => {
      run(dir, "commit", "-q", "--allow-empty", "-m", "c0");
      run(dir, "checkout", "-q", "-b", "b");
      put(dir, ".gitattributes", "*.c ident\n");
      put(dir, "a.c", "/* $Id$ */\nint x;\n$Id: old stuff $\n$Id: has space in $\n$Id:\n$\n");
      put(dir, "b.txt", "$Id$\n");
      run(dir, "add", ".");
      run(dir, "commit", "-q", "-m", "c1");
      run(dir, "checkout", "-q", "main");
    });
    run(native, "checkout", "-q", "b");
    await (await open(ours)).git.checkout().setName("b").call();
    expect(await observe(ours, ["a.c", "b.txt"])).toBe(await observe(native, ["a.c", "b.txt"]));
    expect(await ourStatus(ours)).toBe(nativeStatus(native));
    // an expanded keyword added back collapses
    for (const dir of [native, ours]) put(dir, "a.c", `${bytes(dir, "a.c")}// $Id: 1234 $\n`);
    run(native, "add", "a.c");
    await (await open(ours)).git.add().addFilepattern("a.c").call();
    expect(await observe(ours, ["a.c"])).toBe(await observe(native, ["a.c"]));
  });

  it("core.safecrlf=true refuses an irreversible conversion with git's message", async () => {
    const { native, ours } = twins("safecrlf", (dir) => {
      run(dir, "config", "core.safecrlf", "true");
      put(dir, ".gitattributes", "*.txt text eol=lf\n*.crlf text eol=crlf\n");
      put(dir, "a.txt", "one\r\ntwo\n");
      put(dir, "b.crlf", "one\ntwo\n");
    });
    for (const path of ["a.txt", "b.crlf"]) {
      const result = runResult(native, "add", path);
      expect(result.status).not.toBe(0);
      const message = result.stderr.trim().replace(/^fatal: /, "");
      const { git } = await open(ours);
      await expect(git.add().addFilepattern(path).call()).rejects.toThrow(message);
    }
    expect(lsEol(ours)).toBe(lsEol(native));
  });

  it("working-tree-encoding UTF-16: stored as UTF-8, checked out as UTF-16 (BOM rules as git)", async () => {
    const utf16le = (s: string) =>
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, "utf16le")]);
    const files = ["a.u16", "b.le", "c.bom"];
    const { native, ours } = twins("encoding", (dir) => {
      put(
        dir,
        ".gitattributes",
        "*.u16 text working-tree-encoding=UTF-16\n*.le working-tree-encoding=UTF-16LE\n*.bom working-tree-encoding=UTF-16LE-BOM eol=crlf\n",
      );
      put(dir, "a.u16", utf16le("héllo\nwörld\n"));
      put(dir, "b.le", Buffer.from("plain ✓\n", "utf16le"));
      put(dir, "c.bom", utf16le("x\ny\n"));
    });
    run(native, "add", ".");
    await (await open(ours)).git.add().addFilepattern(".").call();
    expect(await observe(ours)).toBe(await observe(native));
    run(native, "commit", "-q", "-m", "c1");
    run(ours, "commit", "-q", "-m", "c1");
    for (const dir of [native, ours]) for (const f of files) unlinkSync(join(dir, f));
    run(native, "reset", "-q", "--hard");
    await (await open(ours)).git.reset().setMode(ResetMode.HARD).setRef("HEAD").call();
    expect(await observe(ours, files)).toBe(await observe(native, files));
    expect(await ourStatus(ours)).toBe(nativeStatus(native));
    // a UTF-16 file without its BOM is refused on add, as git refuses it
    for (const dir of [native, ours]) put(dir, "d.u16", Buffer.from("no bom\n", "utf16le"));
    const result = runResult(native, "add", "d.u16");
    expect(result.status).not.toBe(0);
    const message = result.stderr
      .split("\n")
      .find((l) => l.startsWith("fatal: "))
      ?.slice("fatal: ".length);
    expect(message).toBeTruthy();
    await expect((await open(ours)).git.add().addFilepattern("d.u16").call()).rejects.toThrow(
      message,
    );
  });

  it("filter drivers: a missing required driver fails as git; a non-required one passes; a host driver converts", async () => {
    const { native, ours } = twins("filters", (dir) => {
      put(dir, ".gitattributes", "*.req filter=req\n*.opt filter=opt\n*.up filter=up\n");
      run(dir, "config", "filter.req.required", "true");
      run(dir, "config", "filter.opt.smudge", "cat");
      run(dir, "config", "filter.up.clean", "tr a-z A-Z");
      run(dir, "config", "filter.up.smudge", "tr A-Z a-z");
      put(dir, "a.req", "required\n");
      put(dir, "b.opt", "optional\n");
      put(dir, "c.up", "upper me\n");
    });
    const drivers = {
      up: {
        clean: async (c: Uint8Array) => encode(decode(c).toUpperCase()),
        smudge: async (c: Uint8Array) => encode(decode(c).toLowerCase()),
      },
    };
    const failed = runResult(native, "add", "a.req");
    expect(failed.status).not.toBe(0);
    const message = failed.stderr.trim().replace(/^fatal: /, "");
    await expect(
      (await open(ours, { drivers })).git.add().addFilepattern("a.req").call(),
    ).rejects.toThrow(message);
    run(native, "add", "b.opt", "c.up");
    await (await open(ours, { drivers })).git
      .add()
      .addFilepattern("b.opt")
      .addFilepattern("c.up")
      .call();
    expect(lsEol(ours)).toBe(lsEol(native));
    run(native, "commit", "-q", "-m", "c1");
    run(ours, "commit", "-q", "-m", "c1");
    for (const dir of [native, ours]) unlinkSync(join(dir, "c.up"));
    run(native, "reset", "-q", "--hard");
    await (await open(ours, { drivers })).git.reset().setMode(ResetMode.HARD).setRef("HEAD").call();
    expect(bytes(ours, "c.up")).toBe(bytes(native, "c.up"));
  });

  it("attribute sources: subdirectories, info/attributes, core.attributesFile, macros and their limits", async () => {
    const files = [
      "a.txt",
      "top.dat",
      "info.txt",
      "g.glob",
      "sub/a.txt",
      "sub/q u.txt",
      "sub/deep/a.txt",
      "sub/deep/x",
      "sub/info.txt",
      "Upper.TXT",
    ];
    const { native, ours } = twins("sources", (dir) => {
      put(
        dir,
        ".gitattributes",
        "[attr]crlfy text eol=crlf\n*.txt text eol=crlf\n/top.dat crlfy\n",
      );
      put(dir, "sub/.gitattributes", '*.txt -text\n[attr]nope text\n"q u.txt" text eol=crlf\n');
      put(dir, "sub/deep/.gitattributes", "*.txt text eol=crlf\nx/ text\n!neg text\n");
      put(dir, ".git/info/attributes", "info.txt -text\n*.TXT text eol=crlf\n");
      put(dir, "global-attrs", "*.glob text eol=crlf\n*.txt -text\n");
      run(dir, "config", "core.attributesFile", join(dir, "global-attrs"));
      for (const f of files) put(dir, f, "a\nb\n");
      run(dir, "-c", "core.autocrlf=false", "add", ".");
      run(dir, "commit", "-q", "-m", "c1");
      for (const f of files) unlinkSync(join(dir, f));
    });
    run(native, "reset", "-q", "--hard");
    await (await open(ours)).git.reset().setMode(ResetMode.HARD).setRef("HEAD").call();
    expect(await observe(ours, files)).toBe(await observe(native, files));
    expect(await ourStatus(ours)).toBe(nativeStatus(native));
  });

  it("stash and stash apply convert as git does (autocrlf=true)", async () => {
    const { native, ours } = twins("stash", (dir) => {
      run(dir, "config", "core.autocrlf", "true");
      put(dir, "a.txt", "one\ntwo\n");
      run(dir, "add", ".");
      run(dir, "commit", "-q", "-m", "c1");
      unlinkSync(join(dir, "a.txt"));
      run(dir, "checkout", "--", "a.txt");
      put(dir, "a.txt", "one\r\ntwo\r\nthree\r\n");
    });
    run(native, "stash", "-q");
    await (await open(ours)).git.stashCreate().call();
    expect(await observe(ours, ["a.txt"])).toBe(await observe(native, ["a.txt"]));
    expect(run(ours, "show", "stash@{0}:a.txt")).toBe(run(native, "show", "stash@{0}:a.txt"));
    run(native, "stash", "apply", "-q");
    await (await open(ours)).git.stashApply().call();
    expect(await observe(ours, ["a.txt"])).toBe(await observe(native, ["a.txt"]));
    expect(await ourStatus(ours)).toBe(nativeStatus(native));
  });

  it("clone checks files out converted (.gitattributes of the cloned tree, core.autocrlf)", async () => {
    const src = join(root, "clone-src.git");
    run(root, "init", "-q", "--bare", "--initial-branch=main", src);
    const work = join(root, "clone-work");
    run(root, "clone", "-q", src, work);
    put(work, ".gitattributes", "*.crlf text eol=crlf\n*.lf text eol=lf\n*.c ident\n");
    put(work, "a.crlf", "one\ntwo\n");
    put(work, "b.lf", "one\ntwo\n");
    put(work, "c.txt", "one\ntwo\n");
    put(work, "d.c", "$Id$\n");
    run(work, "add", ".");
    run(work, "commit", "-q", "-m", "c1");
    run(work, "push", "-q", "origin", "main");
    const files = [".gitattributes", "a.crlf", "b.lf", "c.txt", "d.c"];

    const native = join(root, "clone-native");
    run(root, "clone", "-q", "-c", "core.autocrlf=true", src, native);
    const ours = join(root, "clone-ours");
    mkdirSync(ours);
    run(ours, "init", "-q", "-b", "main");
    run(ours, "config", "core.autocrlf", "true");
    const backend = nativeGitHttpBackend(root, home);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = backend.fetch;
    try {
      await (await open(ours)).git.clone().setURI("http://git.test/clone-src.git").call();
    } finally {
      globalThis.fetch = originalFetch;
      backend.close();
    }
    for (const f of files) expect(bytes(ours, f), f).toBe(bytes(native, f));
    expect(lsEol(ours)).toBe(lsEol(native));
    expect(await ourStatus(ours)).toBe(nativeStatus(native));
  });
});
