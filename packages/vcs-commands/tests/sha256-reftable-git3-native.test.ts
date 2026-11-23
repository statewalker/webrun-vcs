/**
 * SHA-256 reftable repositories (version 2 tables, hash id `s256`), twinned with the git 3.0
 * oracle (`$GIT3`, see `native-git3.ts`), whose `init --object-format=sha256` creates one:
 * native git writes, ours reads (refs, peeled tags, reflogs, over many blocks with an obj
 * index, and after compaction); ours writes, native git reads (`for-each-ref`, `reflog`,
 * `fsck`, `refs verify`); where both write the same transactions with the same settings the
 * tables are compared byte for byte (log blocks inflated, as the SHA-1 twins of
 * `reftable-write-git3-native.test.ts` compare them).
 */
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { isSymbolicRef, type Refs } from "@statewalker/vcs-core";
import { createGitFilesBackend, openReftable } from "@statewalker/vcs-store-files";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { InitCommand } from "../src/index.js";
import { git3Binary, nativeGit3Env } from "./native-git3.js";

const git3 = git3Binary();
const git2561 =
  process.env.GIT2561 && existsSync(process.env.GIT2561) ? process.env.GIT2561 : undefined;

const ZERO = "0".repeat(64);
const IDENT = "Interop Tester <interop@example.com> 1112911993 +0000";

/**
 * A version 2 table as hex-comparable bytes: each log block inflated (git deflates with the
 * system's zlib, ours with pako: other back references, same bytes inflated), the footer's log
 * index position and CRC zeroed (they follow the deflated sizes).
 */
function normalizedTable(table: Buffer): Buffer {
  expect(table[4]).toBe(2);
  const headerSize = 28;
  const footerSize = 72;
  const footerAt = table.length - footerSize;
  const logOffset = Number(table.readBigUInt64BE(footerAt + headerSize + 24));
  if (logOffset === 0 && table[headerSize] !== 0x67) return table;
  const start = logOffset === 0 ? headerSize : logOffset;
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
  footer.fill(0, headerSize + 32, headerSize + 40);
  footer.fill(0, footerSize - 4, footerSize);
  parts.push(Buffer.from(`[log index ${footerAt - pos} bytes]`), footer);
  return Buffer.concat(parts);
}

describe.skipIf(!git3)("SHA-256 reftable repositories (git 3.0 oracle)", () => {
  let root = "";
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sha256-reftable-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function run(bin: string, cwd: string, args: string[], env: Record<string, string> = {}) {
    return spawnSync(bin, args, {
      cwd,
      env: { ...nativeGit3Env(root), GIT_EDITOR: "true", ...env },
      encoding: "utf8",
    });
  }

  function g(cwd: string, args: string[], env: Record<string, string> = {}, input?: string) {
    const r = spawnSync(git3 as string, args, {
      cwd,
      env: { ...nativeGit3Env(root), GIT_EDITOR: "true", ...env },
      encoding: "utf8",
      ...(input !== undefined ? { input } : {}),
    });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed (${r.status}): ${r.stderr}`);
    return r.stdout;
  }

  function commit(cwd: string, message: string, t: number) {
    const date = `${1112911993 + t} +0000`;
    g(cwd, ["commit", "-q", "--allow-empty", "-m", message], {
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    });
  }

  function nativeInit(dir: string) {
    g(root, ["init", "-q", "-b", "main", "--object-format=sha256", dir]);
    expect(g(dir, ["rev-parse", "--show-object-format"]).trim()).toBe("sha256");
    expect(g(dir, ["rev-parse", "--show-ref-format"]).trim()).toBe("reftable");
  }

  async function oursInit(dir: string) {
    mkdirSync(dir, { recursive: true });
    await new InitCommand()
      .setFilesApi(createNodeFilesApi({ rootDir: dir }))
      .setInitialBranch("main")
      .setObjectFormat("sha256")
      .setRefFormat("reftable")
      .call();
  }

  async function oursRefs(dir: string): Promise<Refs> {
    const files = createNodeFilesApi({ rootDir: dir });
    return (await createGitFilesBackend({ files })).history.refs;
  }

  function tables(dir: string): Buffer[] {
    const stack = join(dir, ".git", "reftable");
    return readFileSync(join(stack, "tables.list"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((name) => readFileSync(join(stack, name)));
  }

  function expectSameTables(ours: string, theirs: string) {
    const mine = tables(ours);
    const native = tables(theirs);
    expect(mine.length).toBe(native.length);
    for (let i = 0; i < mine.length; i++) {
      const a = normalizedTable(mine[i] as Buffer);
      const b = normalizedTable(native[i] as Buffer);
      expect(a.length).toBe(b.length);
      expect(a.equals(b)).toBe(true);
    }
  }

  /** `for-each-ref --format='%(refname) %(objectname) %(*objectname) %(symref)'` as ours reads it. */
  async function forEachRef(refs: Refs): Promise<string> {
    let out = "";
    for await (const ref of refs.list("refs/")) {
      const resolved = await refs.resolve(ref.name);
      const peeled = !isSymbolicRef(ref) ? (ref.peeledObjectId ?? "") : "";
      out += `${ref.name} ${resolved?.objectId ?? ""} ${peeled} ${isSymbolicRef(ref) ? ref.target : ""}\n`;
    }
    return out;
  }

  const NATIVE_FOR_EACH = "--format=%(refname) %(objectname) %(*objectname) %(symref)";

  async function reflog(refs: Refs, ref: string): Promise<string> {
    const reader = await refs.getReflog?.(ref);
    return ((await reader?.getReverseEntries()) ?? [])
      .filter((e) => e.newId !== ZERO)
      .map(
        (e) =>
          `${e.newId} ${e.who.name} <${e.who.email}> ${ref}@{${e.who.timestamp} ${e.who.tzOffset}} ${e.comment}\n`,
      )
      .join("");
  }

  const nativeReflog = (dir: string, ref: string) =>
    g(dir, ["reflog", "show", "--date=raw", "--format=%H %gn <%ge> %gD %gs", ref]);

  /** Commits and an annotated tag both twins share (same env and dates: same ids). */
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
    expect(c1).toHaveLength(64);
    return { c1, c2, tag };
  }

  it("init --object-format=sha256: ours lays it out as git 3.0 does, its first table byte for byte, under git 3.0's defaults too", async () => {
    const theirs = join(root, "theirs");
    nativeInit(theirs);
    const ours = join(root, "ours");
    await oursInit(ours);
    // git 3.0 defaults (breakingChanges): reftable without --ref-format
    const defaults = join(root, "defaults");
    mkdirSync(defaults);
    await new InitCommand()
      .setFilesApi(createNodeFilesApi({ rootDir: defaults }))
      .setObjectFormat("sha256")
      .setEnvironment(
        createNodeGitHostEnvironment({ env: nativeGit3Env(root), breakingChanges: true }),
      )
      .call();
    for (const dir of [ours, defaults]) {
      expect(g(dir, ["rev-parse", "--show-object-format"]).trim()).toBe("sha256");
      expect(g(dir, ["rev-parse", "--show-ref-format"]).trim()).toBe("reftable");
      for (const file of ["HEAD", "refs/heads"]) {
        expect(readFileSync(join(dir, ".git", file), "utf8")).toBe(
          readFileSync(join(theirs, ".git", file), "utf8"),
        );
      }
      expect(readFileSync(join(dir, ".git", "config"), "utf8")).toContain(
        "[extensions]\n\tobjectformat = sha256\n\trefstorage = reftable\n",
      );
      expectSameTables(dir, theirs);
      expect(g(dir, ["symbolic-ref", "HEAD"])).toBe("refs/heads/main\n");
      expect(g(dir, ["refs", "verify"])).toBe("");
      expect(g(dir, ["fsck", "--no-progress"])).toBe("");
    }
    if (git2561)
      expect(run(git2561, ours, ["symbolic-ref", "HEAD"]).stdout).toBe("refs/heads/main\n");
  });

  it("reads what native git writes: branches, annotated tags (peeled), reflogs, many refs over blocks with an obj index, before and after compaction", async () => {
    const repo = join(root, "repo");
    nativeInit(repo);
    commit(repo, "one", 1);
    g(repo, ["tag", "lightweight"]);
    g(repo, ["tag", "-m", "annotated", "v1"], { GIT_COMMITTER_DATE: "1112912000 +0000" });
    commit(repo, "two", 2);
    g(repo, ["branch", "other", "HEAD~1"]);
    g(repo, ["symbolic-ref", "refs/heads/sym", "refs/heads/main"]);
    // many refs in one transaction: ref index, obj blocks, log blocks
    const head = g(repo, ["rev-parse", "HEAD"]).trim();
    const first = g(repo, ["rev-parse", "HEAD~1"]).trim();
    let lines = "";
    for (let i = 0; i < 1200; i++) {
      lines += `create refs/heads/topic/${String(i).padStart(4, "0")} ${i % 2 ? head : first}\n`;
    }
    g(repo, ["update-ref", "-m", "bulk", "--stdin"], {}, lines);
    for (let i = 0; i < 6; i++)
      g(repo, ["update-ref", "-m", `move ${i}`, "refs/heads/other", i % 2 ? first : head]);
    g(repo, ["update-ref", "-d", "refs/heads/topic/0007"]);

    const check = async () => {
      const stack = join(repo, ".git", "reftable");
      for (const name of readFileSync(join(stack, "tables.list"), "utf8")
        .split("\n")
        .filter(Boolean)) {
        const table = openReftable(new Uint8Array(readFileSync(join(stack, name))), name);
        expect(table.objectFormat.name).toBe("sha256");
        table.verify();
      }
      const refs = await oursRefs(repo);
      expect(await forEachRef(refs)).toBe(g(repo, ["for-each-ref", NATIVE_FOR_EACH]));
      expect((await refs.resolve("HEAD"))?.objectId).toBe(head);
      for (const ref of ["HEAD", "refs/heads/main", "refs/heads/other", "refs/heads/topic/0001"]) {
        expect(await reflog(refs, ref)).toBe(nativeReflog(repo, ref));
      }
      const v1 = await refs.get("refs/tags/v1");
      expect(v1 && !isSymbolicRef(v1) ? v1.peeledObjectId : undefined).toBe(first);
    };
    expect(tables(repo).length).toBeGreaterThan(1);
    const big = tables(repo)
      .map((t) => openReftable(new Uint8Array(t)))
      .find((t) => t.objectIdLength > 0);
    expect(big?.verify().blocks.obj).toBeGreaterThan(0);
    await check();
    g(repo, ["pack-refs"]);
    expect(tables(repo).length).toBe(1);
    await check();
  });

  it("ours writes what native git reads, byte for byte as git writes it (transactions, compaction, pack-refs)", async () => {
    const theirs = join(root, "theirs");
    const ours = join(root, "ours");
    nativeInit(theirs);
    await oursInit(ours);
    const { c1, c2, tag } = objects(theirs);
    expect(objects(ours)).toEqual({ c1, c2, tag });
    const refs = await oursRefs(ours);
    const steps: { stdin: string; message: string; commands: Parameters<Refs["batch"]>[0] }[] = [
      {
        stdin: `create refs/heads/main ${c1}\n`,
        message: "first",
        commands: [{ name: "refs/heads/main", old: null, new: c1 }],
      },
      {
        stdin: `create refs/tags/v1 ${tag}\ncreate refs/heads/b ${c1}\n`,
        message: "tag and branch",
        commands: [
          { name: "refs/tags/v1", old: null, new: tag },
          { name: "refs/heads/b", old: null, new: c1 },
        ],
      },
      {
        stdin: `update refs/heads/main ${c2} ${c1}\n`,
        message: "advance",
        commands: [{ name: "refs/heads/main", old: c1, new: c2 }],
      },
      {
        stdin: `delete refs/heads/b ${c1}\n`,
        message: "drop",
        commands: [{ name: "refs/heads/b", old: c1, new: null }],
      },
    ];
    for (const step of steps) {
      g(theirs, ["update-ref", "-m", step.message, "--stdin"], {}, step.stdin);
      const r = await refs.batch(step.commands, { ident: IDENT, message: step.message });
      expect(r.ok).toBe(true);
      expectSameTables(ours, theirs);
    }
    g(theirs, ["symbolic-ref", "-m", "point", "refs/heads/sym", "refs/heads/main"]);
    await refs.setSymbolic("refs/heads/sym", "refs/heads/main", { ident: IDENT, message: "point" });
    expectSameTables(ours, theirs);
    g(theirs, ["pack-refs"]);
    await refs.packRefs?.([], { all: true });
    expect(tables(ours).length).toBe(1);
    expectSameTables(ours, theirs);
    expect(g(ours, ["for-each-ref", NATIVE_FOR_EACH])).toBe(
      g(theirs, ["for-each-ref", NATIVE_FOR_EACH]),
    );
    for (const ref of ["HEAD", "refs/heads/main"]) {
      expect(nativeReflog(ours, ref)).toBe(nativeReflog(theirs, ref));
    }
    expect(g(ours, ["refs", "verify"])).toBe("");
    expect(g(ours, ["fsck", "--no-progress", "--no-dangling"])).toBe("");
    if (git2561) {
      expect(run(git2561, ours, ["for-each-ref", NATIVE_FOR_EACH]).stdout).toBe(
        g(theirs, ["for-each-ref", NATIVE_FOR_EACH]),
      );
    }
  });

  it("many refs in one transaction: ref index, obj blocks (32-byte keys) and log blocks byte for byte, under other block sizes too", async () => {
    for (const config of [[], ["reftable.blockSize", "1024"], ["reftable.restartInterval", "3"]]) {
      const name = config.length ? config.join("-").replace(/\./g, "_") : "default";
      const theirs = join(root, `theirs-${name}`);
      const ours = join(root, `ours-${name}`);
      nativeInit(theirs);
      await oursInit(ours);
      if (config.length) {
        g(theirs, ["config", config[0] as string, config[1] as string]);
        g(ours, ["config", config[0] as string, config[1] as string]);
      }
      const { c1, c2 } = objects(theirs);
      objects(ours);
      let lines = "";
      const commands: { name: string; old: null; new: string }[] = [];
      for (let i = 0; i < 1500; i++) {
        const ref = `refs/heads/topic/${String(i).padStart(4, "0")}`;
        const id = i % 2 ? c1 : c2;
        lines += `create ${ref} ${id}\n`;
        commands.push({ name: ref, old: null, new: id });
      }
      g(theirs, ["update-ref", "-m", "bulk", "--stdin"], {}, lines);
      const r = await (await oursRefs(ours)).batch(commands, { ident: IDENT, message: "bulk" });
      expect(r.ok).toBe(true);
      expectSameTables(ours, theirs);
      const big = openReftable(new Uint8Array(tables(ours).at(-1) as Buffer), "big");
      const blocks = big.verify().blocks;
      expect(blocks.ref).toBeGreaterThan(3);
      expect(blocks.obj).toBeGreaterThan(0);
      expect(g(ours, ["refs", "verify"])).toBe("");
      expect(g(ours, ["fsck", "--no-progress", "--no-dangling"])).toBe("");
      expect(
        g(ours, [
          "for-each-ref",
          "--count=2",
          "--format=%(refname) %(objectname)",
          "refs/heads/topic/",
        ]),
      ).toBe(`refs/heads/topic/0000 ${c2}\nrefs/heads/topic/0001 ${c1}\n`);
    }
  });

  it("a SHA-1 table in a SHA-256 stack is refused, as git's 'corrupt reftable file'", async () => {
    const sha1 = join(root, "sha1");
    g(root, ["init", "-q", "-b", "main", "sha1"]);
    const repo = join(root, "repo");
    nativeInit(repo);
    commit(repo, "one", 1);
    const head = g(repo, ["rev-parse", "HEAD"]).trim();
    const stack = join(repo, ".git", "reftable");
    const name = readFileSync(join(sha1, ".git", "reftable", "tables.list"), "utf8").trim();
    copyFileSync(join(sha1, ".git", "reftable", name), join(stack, name));
    // the stack names the SHA-1 table alone (its update indexes are git init's, 1..1)
    writeFileSync(join(stack, "tables.list"), `${name}\n`);
    // native git refuses to write: "reftable: transaction prepare: corrupt reftable file"
    const r = run(git3 as string, repo, ["update-ref", "refs/heads/x", head]);
    expect(r.status).toBe(128);
    expect(r.stderr).toContain("corrupt reftable file");
    const refs = await oursRefs(repo);
    await expect(refs.get("HEAD")).rejects.toThrow(/corrupt reftable file/);
  });
});
