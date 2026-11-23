/**
 * Writing reftable repositories, twinned with the git 3.0 oracle (`$GIT3`, see
 * `native-git3.ts`): ours writes, native git reads (`for-each-ref`, `reflog`, `fsck`,
 * `refs verify`), and where both write the same transactions with the same settings the
 * tables are compared byte for byte (git's `reftable/writer.c`; log blocks inflated, see
 * `normalizedTable`). git 2.56.x (`$GIT2561`) must read ours too.
 *
 * Scenarios come from git's `t/t0610-reftable-basics.sh`, `t0611-reftable-httpd.sh`
 * (none apply without HTTP) and `t0612-reftable-jgit-compatibility.sh` (named in each test),
 * ported by hand.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { isSymbolicRef, type Refs, type RefTransactionHook } from "@statewalker/vcs-core";
import {
  createGitFilesBackend,
  openGitLinkedWorktrees,
  openReftable,
  type ReftableRefStore,
} from "@statewalker/vcs-store-files";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Git, InitCommand, ResetMode } from "../src/index.js";
import { openOurs } from "./merge-native-helpers.js";
import { git3Binary, nativeGit3Env } from "./native-git3.js";

const git3 = git3Binary();
/** A git 2.56.x binary (`$GIT2561`): it reads what ours writes too */
const git2561 =
  process.env.GIT2561 && existsSync(process.env.GIT2561) ? process.env.GIT2561 : undefined;

const ZERO = "0".repeat(40);
const IDENT = "Interop Tester <interop@example.com> 1112911993 +0000";

describe.skipIf(!git3)("writing reftable repositories (git 3.0 oracle)", () => {
  let root = "";
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "reftable-write-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function run(
    bin: string,
    cwd: string,
    args: string[],
    env: Record<string, string> = {},
    input?: string,
  ) {
    return spawnSync(bin, args, {
      cwd,
      env: { ...nativeGit3Env(root), GIT_EDITOR: "true", ...env },
      encoding: "utf8",
      ...(input !== undefined ? { input } : {}),
    });
  }

  /** Native git 3.0 in `cwd`; its stdout (failing the test when git fails). */
  function g(cwd: string, args: string[], env: Record<string, string> = {}, input?: string) {
    const r = run(git3 as string, cwd, args, env, input);
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed (${r.status}): ${r.stderr}`);
    return r.stdout;
  }

  async function oursInit(dir: string, setup?: (c: InitCommand) => InitCommand) {
    mkdirSync(dir, { recursive: true });
    const files = createNodeFilesApi({ rootDir: dir });
    let command = new InitCommand().setFilesApi(files).setInitialBranch("main");
    command = setup ? setup(command) : command.setRefFormat("reftable");
    await command.call();
  }

  async function oursRefs(dir: string): Promise<Refs> {
    const files = createNodeFilesApi({ rootDir: dir });
    return (await createGitFilesBackend({ files })).history.refs;
  }

  function tables(dir: string): Uint8Array[] {
    const stack = join(dir, ".git", "reftable");
    return readFileSync(join(stack, "tables.list"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((name) => new Uint8Array(readFileSync(join(stack, name))));
  }

  /**
   * The tables as hex, each log block inflated: git deflates log blocks with the system's
   * zlib (1.3 here), whose level-9 output differs from pako's port of zlib 1.2.8 in places
   * (same inflated bytes, other back references), so the log blocks are compared inflated
   * and the log index's position (which follows them) is zeroed in the footer. Everything
   * else, the refs, restarts, padding, indexes, obj blocks, is compared as written.
   */
  function hexOf(bytes: Uint8Array[]): string[] {
    return bytes.map((b) => normalizedTable(Buffer.from(b)).toString("hex"));
  }

  /** The commits and annotated tag both twins share (same env: same ids). */
  function objects(dir: string): { c1: string; c2: string; tag: string } {
    const tree = g(dir, ["mktree"], {}, "").trim();
    const c1 = g(dir, ["commit-tree", tree, "-m", "one"]).trim();
    const c2 = g(dir, ["commit-tree", tree, "-p", c1, "-m", "two"]).trim();
    const tag = g(
      dir,
      ["mktag"],
      {},
      `object ${c1}\ntype commit\ntag v1\ntagger ${IDENT}\n\nrelease\n`,
    ).trim();
    return { c1, c2, tag };
  }

  it("init: ours lays out a reftable repository as git does, its first table byte for byte (t0610 'init: creates basic reftable structures')", async () => {
    const theirs = join(root, "theirs");
    const ours = join(root, "ours");
    g(root, ["init", "-q", "-b", "main", "theirs"]);
    await oursInit(ours);
    expect(g(ours, ["rev-parse", "--show-ref-format"]).trim()).toBe("reftable");
    for (const file of ["HEAD", "refs/heads"]) {
      expect(readFileSync(join(ours, ".git", file), "utf8")).toBe(
        readFileSync(join(theirs, ".git", file), "utf8"),
      );
    }
    expect(existsSync(join(ours, ".git", "refs", "tags"))).toBe(false);
    expect(hexOf(tables(ours))).toEqual(hexOf(tables(theirs)));
    expect(g(ours, ["symbolic-ref", "HEAD"])).toBe("refs/heads/main\n");
    expect(g(ours, ["refs", "verify"])).toBe("");
    expect(g(ours, ["fsck", "--no-progress"])).toBe("");
    if (git2561) {
      const r = run(git2561, ours, ["symbolic-ref", "HEAD"]);
      expect(r.stdout).toBe("refs/heads/main\n");
    }
  });

  it("init: the ref format comes from --ref-format, GIT_DEFAULT_REF_FORMAT, init.defaultRefFormat or git 3.0's default (t0610 'init: reinitializing reftable ...')", async () => {
    const env = (vars: Record<string, string>, breakingChanges = false) =>
      createNodeGitHostEnvironment({
        env: { ...nativeGit3Env(root), ...vars },
        ...(breakingChanges ? { breakingChanges: true } : {}),
      });
    const format = (dir: string) => g(join(root, dir), ["rev-parse", "--show-ref-format"]).trim();
    await oursInit(join(root, "a"), (c) => c.setEnvironment(env({})));
    expect(format("a")).toBe("files");
    await oursInit(join(root, "b"), (c) => c.setEnvironment(env({}, true)));
    expect(format("b")).toBe("reftable");
    await oursInit(join(root, "c"), (c) =>
      c.setEnvironment(env({ GIT_DEFAULT_REF_FORMAT: "reftable" })),
    );
    expect(format("c")).toBe("reftable");
    await oursInit(join(root, "d"), (c) =>
      c.setEnvironment(
        env({
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "init.defaultRefFormat",
          GIT_CONFIG_VALUE_0: "reftable",
        }),
      ),
    );
    expect(format("d")).toBe("reftable");
    await oursInit(join(root, "e"), (c) =>
      c.setEnvironment(env({ GIT_DEFAULT_REF_FORMAT: "files" }, true)),
    );
    expect(format("e")).toBe("files");
    await expect(oursInit(join(root, "f"), (c) => c.setRefFormat("bogus"))).rejects.toThrow(
      "unknown ref storage format specified via command line: 'bogus'",
    );
    // a reinit keeps the format
    await oursInit(join(root, "b"), (c) => c.setEnvironment(env({})));
    expect(format("b")).toBe("reftable");
  });

  it("ref transactions: tables written byte for byte as git writes them, auto-compaction and pack-refs included (t0610 'ref transaction: writes cause auto-compaction', 'pack-refs: compacts tables')", async () => {
    const theirs = join(root, "theirs");
    const ours = join(root, "ours");
    g(root, ["init", "-q", "-b", "main", "theirs"]);
    await oursInit(ours);
    const { c1, c2, tag } = objects(theirs);
    expect(objects(ours)).toEqual({ c1, c2, tag });
    const refs = await oursRefs(ours);
    const transactions: { stdin: string; message: string; ours: () => Promise<unknown> }[] = [
      {
        stdin: `create refs/heads/main ${c1}\n`,
        message: "first",
        ours: () =>
          refs.batch([{ name: "refs/heads/main", old: null, new: c1 }], {
            ident: IDENT,
            message: "first",
          }),
      },
      {
        stdin: `create refs/tags/v1 ${tag}\ncreate refs/heads/b ${c1}\n`,
        message: "tag and branch",
        ours: () =>
          refs.batch(
            [
              { name: "refs/tags/v1", old: null, new: tag },
              { name: "refs/heads/b", old: null, new: c1 },
            ],
            { ident: IDENT, message: "tag and branch" },
          ),
      },
      {
        stdin: `update refs/heads/main ${c2} ${c1}\n`,
        message: "advance",
        ours: () =>
          refs.batch([{ name: "refs/heads/main", old: c1, new: c2 }], {
            ident: IDENT,
            message: "advance",
          }),
      },
      {
        stdin: `delete refs/heads/b ${c1}\n`,
        message: "drop",
        ours: () =>
          refs.batch([{ name: "refs/heads/b", old: c1, new: null }], {
            ident: IDENT,
            message: "drop",
          }),
      },
    ];
    for (const t of transactions) {
      g(theirs, ["update-ref", "-m", t.message, "--stdin"], {}, t.stdin);
      const r = (await t.ours()) as { ok: boolean };
      expect(r.ok).toBe(true);
      expect(hexOf(tables(ours))).toEqual(hexOf(tables(theirs)));
    }
    g(theirs, ["symbolic-ref", "-m", "point", "refs/heads/sym", "refs/heads/main"]);
    await refs.setSymbolic("refs/heads/sym", "refs/heads/main", { ident: IDENT, message: "point" });
    expect(hexOf(tables(ours))).toEqual(hexOf(tables(theirs)));
    // auto-compaction kept the stacks geometric, the same way
    expect(tables(ours).length).toBeLessThan(6);

    g(theirs, ["pack-refs"]);
    await refs.packRefs?.([], { all: true });
    expect(tables(ours).length).toBe(1);
    expect(hexOf(tables(ours))).toEqual(hexOf(tables(theirs)));
    for (const dir of [ours]) {
      expect(g(dir, ["for-each-ref", "--format=%(refname) %(objectname) %(symref)"])).toBe(
        g(theirs, ["for-each-ref", "--format=%(refname) %(objectname) %(symref)"]),
      );
      expect(g(dir, ["reflog", "show", "--format=%H %gs", "HEAD"])).toBe(
        g(theirs, ["reflog", "show", "--format=%H %gs", "HEAD"]),
      );
      expect(g(dir, ["refs", "verify"])).toBe("");
    }
  });

  it("many refs in one transaction: ref index, obj blocks and log blocks byte for byte, under other block sizes too (t0610 'ref transaction: many refs')", async () => {
    for (const config of [
      [],
      ["reftable.blockSize", "1024"],
      ["reftable.restartInterval", "3"],
      ["reftable.indexObjects", "false"],
    ]) {
      const name = config.length ? config.join("-").replace(/\./g, "_") : "default";
      const theirs = join(root, `theirs-${name}`);
      const ours = join(root, `ours-${name}`);
      g(root, ["init", "-q", "-b", "main", theirs]);
      await oursInit(ours);
      if (config.length) {
        g(theirs, ["config", config[0] as string, config[1] as string]);
        g(ours, ["config", config[0] as string, config[1] as string]);
      }
      const { c1, c2 } = objects(theirs);
      objects(ours);
      const lines: string[] = [];
      const commands: { name: string; old: null; new: string }[] = [];
      for (let i = 0; i < 1500; i++) {
        const ref = `refs/heads/topic/${String(i).padStart(4, "0")}`;
        const id = i % 2 ? c1 : c2;
        lines.push(`create ${ref} ${id}\n`);
        commands.push({ name: ref, old: null, new: id });
      }
      g(theirs, ["update-ref", "-m", "bulk", "--stdin"], {}, lines.join(""));
      const refs = await oursRefs(ours);
      const r = await refs.batch(commands, { ident: IDENT, message: "bulk" });
      expect(r.ok).toBe(true);
      const mine = tables(ours);
      const native = tables(theirs);
      expect(mine.length).toBe(native.length);
      for (let i = 0; i < mine.length; i++) {
        const a = normalizedTable(Buffer.from(mine[i] as Uint8Array));
        const b = normalizedTable(Buffer.from(native[i] as Uint8Array));
        expect(a.length).toBe(b.length);
        expect(a.equals(b)).toBe(true);
      }
      const big = openReftable(mine.at(-1) as Uint8Array, "big");
      const blocks = big.verify().blocks;
      expect(blocks.ref).toBeGreaterThan(3);
      expect(blocks.index).toBeGreaterThan(0);
      expect(g(ours, ["refs", "verify"])).toBe("");
      expect(
        g(ours, ["for-each-ref", "--count=3", "--format=%(refname)", "refs/heads/topic/"]),
      ).toBe("refs/heads/topic/0000\nrefs/heads/topic/0001\nrefs/heads/topic/0002\n");
    }
  });

  it("interleaved writers (ours, git, ours) keep one consistent stack (t0610 'ref transaction: many concurrent writers')", async () => {
    const repo = join(root, "repo");
    await oursInit(repo);
    const { c1, c2 } = objects(repo);
    const refs = await oursRefs(repo);
    for (let i = 0; i < 20; i++) {
      await refs.set(`refs/heads/ours-${i}`, i % 2 ? c1 : c2, { message: `ours ${i}` });
      g(repo, ["update-ref", "-m", `theirs ${i}`, `refs/heads/theirs-${i}`, i % 2 ? c2 : c1]);
    }
    await refs.set("refs/heads/main", c2, { message: "last" });
    const list = g(repo, ["for-each-ref", "--format=%(refname) %(objectname)"]);
    expect(list.split("\n").filter(Boolean).length).toBe(41);
    let ourList = "";
    for await (const ref of refs.list("refs/")) {
      ourList += `${ref.name} ${isSymbolicRef(ref) ? "" : ref.objectId}\n`;
    }
    expect(ourList).toBe(list);
    expect(g(repo, ["refs", "verify"])).toBe("");
    expect(g(repo, ["fsck", "--no-progress", "--no-dangling"])).toBe("");
    // the update indexes ascend through the stack, whoever wrote each table
    const names = readFileSync(join(repo, ".git", "reftable", "tables.list"), "utf8")
      .split("\n")
      .filter(Boolean);
    let last = 0;
    for (const name of names) {
      const t = openReftable(
        new Uint8Array(readFileSync(join(repo, ".git", "reftable", name))),
        name,
      );
      expect(t.minUpdateIndex).toBeGreaterThan(last);
      last = t.maxUpdateIndex;
    }
    expect(g(repo, ["reflog", "show", "--format=%gs", "refs/heads/main"])).toBe("last\n");
  });

  it("reflogs: commits, checkouts and branch deletion as native git logs them (t0610 'reflog: updates via HEAD update HEAD reflog', 'reflog: can delete separate reflog entries')", async () => {
    const repo = join(root, "repo");
    await oursInit(repo);
    const env = createNodeGitHostEnvironment({ env: nativeGit3Env(root) });
    const git = await openOurs(repo, env);
    writeFileSync(join(repo, "a.txt"), "a\n");
    await git.add().addFilepattern("a.txt").call();
    await git.commit().setMessage("first").call();
    writeFileSync(join(repo, "a.txt"), "b\n");
    await git.add().addFilepattern("a.txt").call();
    await git.commit().setMessage("second").call();
    await git.branchCreate().setName("topic").call();
    await git.checkout().setName("topic").call();
    await git.checkout().setName("main").call();
    expect(g(repo, ["reflog", "show", "--format=%gs", "HEAD"])).toBe(
      [
        "checkout: moving from topic to main",
        "checkout: moving from main to topic",
        "commit: second",
        "commit (initial): first",
        "",
      ].join("\n"),
    );
    expect(g(repo, ["reflog", "show", "--format=%gs", "refs/heads/main"])).toBe(
      "commit: second\ncommit (initial): first\n",
    );
    // a deleted branch takes its reflog with it (tombstones)
    await git.branchDelete().setBranchNames("topic").setForce(true).call();
    expect(run(git3 as string, repo, ["reflog", "exists", "refs/heads/topic"]).status).toBe(1);
    // reflog delete: the entry goes, as native's delete does
    const refs = await oursRefs(repo);
    await refs.deleteReflogEntry?.("HEAD", 1, { rewrite: true });
    expect(g(repo, ["reflog", "show", "--format=%gs", "HEAD"])).toBe(
      ["checkout: moving from topic to main", "commit: second", "commit (initial): first", ""].join(
        "\n",
      ),
    );
    expect(g(repo, ["fsck", "--no-progress"])).toBe("");
    if (git2561) {
      expect(run(git2561, repo, ["reflog", "show", "--format=%gs", "refs/heads/main"]).stdout).toBe(
        "commit: second\ncommit (initial): first\n",
      );
    }
  });

  it("stash push and drop on a reftable repository (t0610 'reflog: can delete separate reflog entries')", async () => {
    const repo = join(root, "repo");
    await oursInit(repo);
    const env = createNodeGitHostEnvironment({ env: nativeGit3Env(root) });
    const git = await openOurs(repo, env);
    writeFileSync(join(repo, "a.txt"), "a\n");
    await git.add().addFilepattern("a.txt").call();
    await git.commit().setMessage("first").call();
    for (const content of ["one\n", "two\n", "three\n"]) {
      writeFileSync(join(repo, "a.txt"), content);
      await git.stashCreate().call();
    }
    expect(g(repo, ["stash", "list", "--format=%gs"]).split("\n").filter(Boolean).length).toBe(3);
    await git.stashDrop().setStashRef(1).call();
    const list = g(repo, ["stash", "list", "--format=%gd %s"]);
    expect(list.split("\n").filter(Boolean).length).toBe(2);
    expect(g(repo, ["fsck", "--no-progress", "--no-dangling"])).toBe("");
  });

  it("the reference-transaction hook hears what native git's hears (t1416 on reftable)", async () => {
    const theirs = join(root, "theirs");
    const ours = join(root, "ours");
    g(root, ["init", "-q", "-b", "main", "theirs"]);
    await oursInit(ours);
    const { c1, c2 } = objects(theirs);
    objects(ours);
    const hookLog = join(root, "native-hook.log");
    const hook = join(theirs, ".git", "hooks", "reference-transaction");
    writeFileSync(hook, `#!/bin/sh\necho "$1" >>"${hookLog}"\ncat >>"${hookLog}"\n`);
    chmodSync(hook, 0o755);
    g(theirs, ["update-ref", "refs/heads/main", c1]);
    g(theirs, ["update-ref", "HEAD", c2, c1]);
    g(theirs, ["symbolic-ref", "refs/heads/sym", "refs/heads/main"]);
    g(theirs, ["update-ref", "-d", "refs/heads/sym"]);

    const lines: string[] = [];
    const record: RefTransactionHook = async (state, updates, context) => {
      lines.push(state);
      for (const u of updates) {
        const next = u.newTarget !== undefined ? `ref:${u.newTarget}` : (u.new ?? ZERO);
        const name = state === "preparing" || context?.asAsked ? u.requested : u.name;
        lines.push(`${u.old ?? ZERO} ${next} ${name}`);
      }
      return true;
    };
    const refs = (await oursRefs(ours)) as Refs & {
      setTransactionHook(h: RefTransactionHook): void;
    };
    refs.setTransactionHook(record);
    await refs.batch([{ name: "refs/heads/main", new: c1 }]);
    await refs.batch([{ name: "HEAD", old: c1, new: c2 }]);
    await refs.setSymbolic("refs/heads/sym", "refs/heads/main");
    await refs.batch([{ name: "refs/heads/sym", new: null }]);
    expect(lines.map((l) => `${l}\n`).join("")).toBe(readFileSync(hookLog, "utf8"));
    expect(hexOf(tables(ours)).length).toBe(hexOf(tables(theirs)).length);
  });

  it("gc keeps what only the reflogs reach and compacts the stack; native fsck agrees (t0610 'pack-refs: prunes stale tables')", async () => {
    const repo = join(root, "repo");
    await oursInit(repo);
    const env = createNodeGitHostEnvironment({ env: nativeGit3Env(root) });
    const git = await openOurs(repo, env);
    for (const content of ["one\n", "two\n", "three\n"]) {
      writeFileSync(join(repo, "a.txt"), content);
      await git.add().addFilepattern("a.txt").call();
      await git.commit().setMessage(content.trim()).call();
    }
    const dropped = g(repo, ["rev-parse", "HEAD"]).trim();
    await git.reset().setRef("HEAD~1").setMode(ResetMode.HARD).call();
    // a stale table nobody lists, as a crashed writer leaves it
    const stack = join(repo, ".git", "reftable");
    writeFileSync(join(stack, "0x000000000001-0x000000000001-deadbeef.ref"), "stale");
    await git.gc().call();
    expect(readdirSync(stack).filter((n) => n.endsWith(".ref")).length).toBe(1);
    expect(g(repo, ["cat-file", "-t", dropped])).toBe("commit\n");
    expect(g(repo, ["fsck", "--no-progress", "--no-dangling"])).toBe("");
    expect(g(repo, ["refs", "verify"])).toBe("");
    expect((await git.fsck().call()).exitCode).toBe(0);
  });

  it("clone into a reftable repository: the initial transaction, then HEAD and its branch (t0610 'clone: can clone reftable repository', t0612's clones)", async () => {
    const src = join(root, "src");
    g(root, ["init", "-q", "-b", "main", "src"]);
    const tree = g(src, ["mktree"], {}, "").trim();
    const c1 = g(src, ["commit-tree", tree, "-m", "one"]).trim();
    g(src, ["update-ref", "refs/heads/main", c1]);
    g(src, ["branch", "side"]);
    g(src, ["tag", "-m", "release", "v1"]);
    g(root, ["clone", "-q", "--no-local", src, "theirs"]);
    const ours = join(root, "ours");
    await oursInit(ours);
    const env = createNodeGitHostEnvironment({ env: nativeGit3Env(root) });
    await (await openOurs(root, env, undefined, "ours"))
      .clone()
      .setURI("../src")
      .setLocal(false)
      .call();
    const theirs = join(root, "theirs");
    for (const args of [
      ["for-each-ref", "--format=%(refname) %(objectname) %(symref)"],
      ["symbolic-ref", "HEAD"],
      ["reflog", "show", "--format=%H %gn", "HEAD"],
      ["reflog", "show", "--format=%H %gn", "refs/heads/main"],
    ]) {
      expect(g(ours, args)).toBe(g(theirs, args));
    }
    // (ours names the source as given relative to the worktree: `ours/../src`)
    expect(g(ours, ["reflog", "show", "--format=%gs", "HEAD"])).toMatch(/^clone: from .*src\n$/);
    expect(g(ours, ["refs", "verify"])).toBe("");
    expect(g(ours, ["fsck", "--no-progress"])).toBe("");
  });

  it("concurrent writers, ours and git's, wait for tables.list.lock (t0610 'ref transaction: many concurrent writers')", async () => {
    const repo = join(root, "repo");
    await oursInit(repo);
    g(repo, ["config", "reftable.lockTimeout", "20000"]);
    const { c1 } = objects(repo);
    // compactions of ours and of git's pack-refs run among the writes: a clean must never
    // remove a compacted table before it is listed (review of #229, C2)
    const writers = Array.from({ length: 8 }, async (_, i) => {
      const refs = await oursRefs(repo);
      await refs.set(`refs/heads/ours-${i}`, c1, { message: `ours ${i}` });
      if (i % 3 === 2) await refs.packRefs?.([], { all: true }).catch(() => 0);
    });
    const packers = Array.from(
      { length: 2 },
      () =>
        new Promise<void>((resolve) => {
          spawn(git3 as string, ["pack-refs"], { cwd: repo, env: nativeGit3Env(root) }).on(
            "exit",
            () => resolve(),
          );
        }),
    );
    const natives = Array.from(
      { length: 8 },
      (_, i) =>
        new Promise<void>((resolve, reject) => {
          const child = spawn(git3 as string, ["update-ref", `refs/heads/theirs-${i}`, c1], {
            cwd: repo,
            env: nativeGit3Env(root),
          });
          child.on("exit", (code: number) =>
            code === 0 ? resolve() : reject(new Error(`exit ${code}`)),
          );
        }),
    );
    await Promise.all([...writers, ...natives, ...packers]);
    const names = g(repo, ["for-each-ref", "--format=%(refname)", "refs/heads/"])
      .split("\n")
      .filter(Boolean);
    expect(names.length).toBe(16);
    expect(g(repo, ["refs", "verify"])).toBe("");
    const stack = join(repo, ".git", "reftable");
    for (const name of readFileSync(join(stack, "tables.list"), "utf8")
      .split("\n")
      .filter(Boolean)) {
      expect(existsSync(join(stack, name))).toBe(true);
    }
  });

  it("worktree add by ours in a reftable repository (t0610 'worktree: adding worktree creates separate stack')", async () => {
    const repo = join(root, "repo");
    await oursInit(repo);
    const env = createNodeGitHostEnvironment({ env: nativeGit3Env(root) });
    const files = createNodeFilesApi({ rootDir: root });
    const { history } = await createGitFilesBackend({ files, gitDir: "repo/.git" });
    const worktrees = await openGitLinkedWorktrees({
      files,
      gitDir: "repo/.git",
      history,
      environment: env,
    });
    const git = Git.fromWorkingCopy(await worktrees.openCurrent());
    await git.commit().setMessage("c").setAllowEmpty(true).call();
    await git.worktreeAdd().setPath("../wt").setNewBranch("topic").call();
    const wt = join(root, "wt");
    expect(g(wt, ["symbolic-ref", "HEAD"])).toBe("refs/heads/topic\n");
    expect(g(repo, ["symbolic-ref", "HEAD"])).toBe("refs/heads/main\n");
    expect(existsSync(join(repo, ".git", "worktrees", "wt", "reftable", "tables.list"))).toBe(true);
    expect(g(wt, ["rev-parse", "HEAD"])).toBe(g(repo, ["rev-parse", "HEAD"]));
    expect(g(repo, ["refs", "verify"])).toBe("");
    expect(g(repo, ["fsck", "--no-progress"])).toBe("");
  });

  it("gc run from a linked worktree keeps what only the main worktree reaches (its detached HEAD, refs/bisect, HEAD reflog)", async () => {
    const repo = join(root, "repo");
    g(root, ["init", "-q", "-b", "main", "repo"]);
    g(repo, ["commit", "-q", "--allow-empty", "-m", "c1"]);
    g(repo, ["worktree", "add", "-q", "-b", "wt", "../wt"]);
    const wt = join(root, "wt");
    g(wt, ["commit", "-q", "--allow-empty", "-m", "w1"]);
    g(wt, ["checkout", "-q", "--detach"]);
    g(wt, ["commit", "-q", "--allow-empty", "-m", "w2"]);
    const tree = g(wt, ["rev-parse", "HEAD^{tree}"]).trim();
    const ids: Record<string, string> = { wtHead: g(wt, ["rev-parse", "HEAD"]).trim() };
    ids.wtBisect = g(wt, ["commit-tree", tree, "-m", "w3"]).trim();
    g(wt, ["update-ref", "refs/bisect/bad", ids.wtBisect]);
    g(repo, ["checkout", "-q", "--detach"]);
    g(repo, ["commit", "-q", "--allow-empty", "-m", "m1"]);
    g(repo, ["commit", "-q", "--allow-empty", "-m", "m2"]);
    ids.mainReflog = g(repo, ["rev-parse", "HEAD"]).trim();
    g(repo, ["reset", "-q", "--hard", "HEAD~1"]);
    ids.mainHead = g(repo, ["rev-parse", "HEAD"]).trim();
    ids.mainBisect = g(repo, ["commit-tree", tree, "-m", "m3"]).trim();
    g(repo, ["update-ref", "refs/bisect/good", ids.mainBisect]);
    // the entries carry the fixed 2005 dates of the test environment: kept from expiry
    g(repo, ["config", "gc.reflogExpire", "never"]);
    g(repo, ["config", "gc.reflogExpireUnreachable", "never"]);
    const env = createNodeGitHostEnvironment({ env: nativeGit3Env(root) });
    const files = createNodeFilesApi({ rootDir: root });
    const { history } = await createGitFilesBackend({
      files,
      gitDir: "repo/.git",
      environment: env,
    });
    for (const from of ["repo/.git/worktrees/wt", "repo/.git"]) {
      const worktrees = await openGitLinkedWorktrees({
        files,
        gitDir: from,
        history,
        environment: env,
      });
      const git = Git.fromWorkingCopy(await worktrees.openCurrent());
      await git.gc().setPrune("now").call();
      for (const [what, id] of Object.entries(ids)) {
        expect(`${what} ${run(git3 as string, repo, ["cat-file", "-t", id]).stdout}`).toBe(
          `${what} commit\n`,
        );
      }
      expect((await git.fsck().call()).exitCode).toBe(0);
      expect(g(repo, ["fsck", "--no-progress", "--no-dangling"])).toBe("");
    }
  });

  it("reflog expiry of gc run from a linked worktree reaches through that worktree's own refs, as git's (reflog.c)", async () => {
    // two identical fixtures dated 60 days back (the unreachable entries expire after 30)
    const build = (dir: string) => {
      mkdirSync(dir, { recursive: true });
      let t = Math.floor(Date.now() / 1000) - 60 * 86400;
      t -= t % 3600;
      const at = (cwd: string, args: string[]) => {
        t += 60;
        const date = `${t} +0000`;
        return g(cwd, args, { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }).trim();
      };
      const repo = join(dir, "repo");
      at(dir, ["init", "-q", "-b", "main", "repo"]);
      at(repo, ["commit", "-q", "--allow-empty", "-m", "c1"]);
      at(repo, ["worktree", "add", "-q", "-b", "wt1", "../wt1"]);
      const tree = at(repo, ["rev-parse", "HEAD^{tree}"]);
      for (const [label, d] of [["main", repo], ["wt1", join(dir, "wt1")]] as const) {
        at(d, ["checkout", "-q", "--detach"]);
        at(d, ["commit", "-q", "--allow-empty", "-m", "a"]);
        const head = at(d, ["rev-parse", "HEAD"]);
        const bisect = at(d, ["commit-tree", tree, "-m", `bis ${label}`]);
        const bis2 = at(d, ["commit-tree", tree, "-p", bisect, "-m", `bis2 ${label}`]);
        // reachable only from this worktree's own refs/bisect/x
        at(d, ["update-ref", "refs/bisect/x", bis2]);
        at(d, ["update-ref", "-m", "tobis", "HEAD", bisect]);
        // old and new reachable only from this worktree's own refs/bisect/x: kept by gc in
        // this worktree, expired by gc in another (git's refs_for_each_ref of its own view)
        at(d, ["update-ref", "-m", "tobis2", "HEAD", bis2]);
        at(d, ["update-ref", "-m", "back", "HEAD", head]);
      }
      return repo;
    };
    const theirs = build(join(root, "n"));
    const ours = build(join(root, "o"));
    g(join(root, "n", "wt1"), ["gc", "-q", "--prune=now"]);
    const env = createNodeGitHostEnvironment({ env: nativeGit3Env(root) });
    const files = createNodeFilesApi({ rootDir: join(root, "o") });
    const { history } = await createGitFilesBackend({ files, gitDir: "repo/.git", environment: env });
    const worktrees = await openGitLinkedWorktrees({
      files,
      gitDir: "repo/.git/worktrees/wt1",
      history,
      environment: env,
    });
    await Git.fromWorkingCopy(await worktrees.openCurrent()).gc().setPrune("now").call();
    for (const ref of ["HEAD", "worktrees/wt1/HEAD"]) {
      const show = (dir: string) => g(dir, ["reflog", "show", "--format=%H %gs", ref]);
      expect(`${ref}\n${show(ours)}`).toBe(`${ref}\n${show(theirs)}`);
    }
    expect(g(ours, ["reflog", "show", "--format=%gs", "worktrees/wt1/HEAD"])).toContain("tobis2");
    expect(g(ours, ["reflog", "show", "--format=%gs", "HEAD"])).not.toContain("tobis2");
  });

  it("a held tables.list.lock times out as git's lock does (t0610 'ref transaction: retry acquiring tables.list lock')", async () => {
    const repo = join(root, "repo");
    await oursInit(repo);
    const { c1 } = objects(repo);
    writeFileSync(join(repo, ".git", "reftable", "tables.list.lock"), "");
    const refs = await oursRefs(repo);
    const r = await refs.batch([{ name: "refs/heads/main", new: c1 }]);
    expect(r).toEqual({ ok: false, rejected: [{ name: "refs/heads/main", reason: "locked" }] });
    rmSync(join(repo, ".git", "reftable", "tables.list.lock"));
    expect((await refs.batch([{ name: "refs/heads/main", new: c1 }])).ok).toBe(true);
    expect(g(repo, ["rev-parse", "main"]).trim()).toBe(c1);
  });

  it("linked worktrees: per-worktree refs go to the worktree's own stack (t0610 'worktree: ...')", async () => {
    const repo = join(root, "repo");
    await oursInit(repo);
    const { c1, c2 } = objects(repo);
    const refs = await oursRefs(repo);
    await refs.set("refs/heads/main", c1);
    g(repo, ["worktree", "add", "-q", "-b", "wt", "../wt"]);
    // the worktree's store: its own refs in .git/worktrees/wt/reftable
    const wtRefs = (refs as unknown as ReftableRefStore).forGitDir(".git/worktrees/wt");
    await wtRefs.set("refs/bisect/ours", c2);
    await wtRefs.set("refs/heads/shared", c2, { message: "from the worktree" });
    await wtRefs.setSymbolic("HEAD", "refs/heads/shared", { message: "checkout: moving" });
    const wt = join(root, "wt");
    expect(g(wt, ["rev-parse", "refs/bisect/ours"]).trim()).toBe(c2);
    expect(g(wt, ["rev-parse", "refs/heads/shared"]).trim()).toBe(c2);
    expect(
      run(git3 as string, repo, ["rev-parse", "--verify", "-q", "refs/bisect/ours"]).status,
    ).toBe(1);
    expect(g(wt, ["symbolic-ref", "HEAD"])).toBe("refs/heads/shared\n");
    expect(g(repo, ["symbolic-ref", "HEAD"])).toBe("refs/heads/main\n");
    expect(g(wt, ["reflog", "show", "--format=%gs", "HEAD"])).toContain("checkout: moving");
    expect(existsSync(join(repo, ".git", "worktrees", "wt", "reftable", "tables.list"))).toBe(true);
    expect(g(repo, ["refs", "verify"])).toBe("");
  });
});

/**
 * A table with each log block inflated (`g`, the uncompressed length, the records) and the
 * footer's log index position zeroed: see `hexOf`.
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
