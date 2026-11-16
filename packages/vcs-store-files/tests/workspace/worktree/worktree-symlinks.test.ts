/**
 * FileWorktree over a real directory never follows a symbolic link, as git: a write or a
 * remove beneath a link is refused (has_symlink_leading_path), a link at the path written
 * is unlinked rather than written through, and links are listed, read and hashed as links.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type Blobs, createInMemoryFilesApi, FileMode, type Trees } from "@statewalker/vcs-core";
import { createFileWorktree, probeCaseFolding } from "@statewalker/vcs-store-files";
import { createSymlinkFilesApi } from "@statewalker/vcs-utils/files";
import { createSha1 } from "@statewalker/vcs-utils/hash/hasher";
import { createNodeFilesApi, PosixNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import type { Worktree } from "@statewalker/vcs-working-tree";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const enc = new TextEncoder();
const noStores = { blobs: {} as Blobs, trees: {} as Trees };

function blobId(bytes: Uint8Array): string {
  const h = createSha1()
    .update(enc.encode(`blob ${bytes.length}\0`))
    .update(bytes);
  return Array.from(h.digest(), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function collect(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return new Uint8Array(Buffer.concat(chunks));
}

describe("FileWorktree and symbolic links", () => {
  let base: string;
  let root: string;
  let worktree: Worktree;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "worktree-links-"));
    root = join(base, "repo");
    mkdirSync(join(root, ".git/hooks"), { recursive: true });
    writeFileSync(join(base, "outside.txt"), "original\n");
    mkdirSync(join(base, "outdir"));
    worktree = createFileWorktree({
      files: createNodeFilesApi({ rootDir: root }),
      rootPath: "",
      gitDir: ".git",
      ...noStores,
    });
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it("reports what a Node worktree can represent", () => {
    expect(worktree.capabilities).toEqual({
      executable: true,
      symlinks: true,
      windowsPaths: process.platform === "win32",
    });
  });

  it("replaces a link at the path instead of writing through it", async () => {
    symlinkSync("../outside.txt", join(root, "x"));
    await worktree.writeContent("x", enc.encode("PWNED\n"));
    expect(readFileSync(join(base, "outside.txt"), "utf8")).toBe("original\n");
    expect(lstatSync(join(root, "x")).isFile()).toBe(true);
    expect(readFileSync(join(root, "x"), "utf8")).toBe("PWNED\n");
  });

  it("refuses to write beneath a link to a directory", async () => {
    symlinkSync("../outdir", join(root, "d"));
    await expect(worktree.writeContent("d/evil.txt", enc.encode("EVIL\n"))).rejects.toThrow(
      /symbolic link/,
    );
    expect(readdirSync(join(base, "outdir"))).toEqual([]);
  });

  it("refuses to write a hook through a link to .git/hooks", async () => {
    symlinkSync(".git/hooks", join(root, "h"));
    await expect(worktree.writeContent("h/post-commit", enc.encode("#!/bin/sh\n"))).rejects.toThrow(
      /symbolic link/,
    );
    await expect(worktree.mkdir("h/sub")).rejects.toThrow(/symbolic link/);
    expect(existsSync(join(root, ".git/hooks/post-commit"))).toBe(false);
  });

  it("replaces a dangling link with a file, and removes one", async () => {
    symlinkSync("nowhere", join(root, "dangling"));
    await worktree.writeContent("dangling", enc.encode("file\n"));
    expect(lstatSync(join(root, "dangling")).isFile()).toBe(true);
    symlinkSync("nowhere", join(root, "gone"));
    expect(await worktree.remove("gone")).toBe(true);
    expect(() => lstatSync(join(root, "gone"))).toThrow();
  });

  it("removes a link to a directory, never what it points to", async () => {
    writeFileSync(join(base, "outdir/secret.txt"), "s\n");
    symlinkSync("../outdir", join(root, "d"));
    expect(await worktree.remove("d")).toBe(true);
    expect(readdirSync(join(base, "outdir"))).toEqual(["secret.txt"]);
  });

  it("never removes a directory in the way without recursive, nor writes over one", async () => {
    mkdirSync(join(root, "dir"));
    writeFileSync(join(root, "dir/keep.txt"), "keep\n");
    expect(await worktree.remove("dir")).toBe(false);
    await expect(worktree.writeContent("dir", enc.encode("x"))).rejects.toThrow(/directory/);
    expect(readFileSync(join(root, "dir/keep.txt"), "utf8")).toBe("keep\n");
  });

  it("writes a link with a non-UTF-8 target and reads it back as bytes", async () => {
    const target = new Uint8Array([0x61, 0xfe, 0x62]);
    await worktree.writeContent("link", target, { mode: FileMode.SYMLINK });
    expect(lstatSync(join(root, "link")).isSymbolicLink()).toBe(true);
    expect([...(await collect(worktree.readContent("link")))]).toEqual([...target]);
    expect(await worktree.computeHash("link")).toBe(blobId(target));
  });

  it("lists, stats and hashes links as links, never descending into one", async () => {
    writeFileSync(join(base, "outdir/secret.txt"), "secret\n");
    symlinkSync("../outdir", join(root, "d"));
    symlinkSync("../outside.txt", join(root, "x"));
    writeFileSync(join(root, "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
    const walked: string[] = [];
    for await (const entry of worktree.walk())
      walked.push(`${entry.path} ${entry.mode.toString(8)}`);
    expect(walked).toEqual(["d 120000", "run.sh 100755", "x 120000"]);
    const x = await worktree.getEntry("x");
    expect(x?.mode).toBe(FileMode.SYMLINK);
    expect(x?.size).toBe("../outside.txt".length);
    // the link's own content: its target, never the file it names
    expect(await worktree.computeHash("x")).toBe(blobId(enc.encode("../outside.txt")));
    expect(new TextDecoder().decode(await collect(worktree.readContent("x")))).toBe(
      "../outside.txt",
    );
  });

  it("does not follow a symlinked .gitignore", async () => {
    writeFileSync(join(base, "ignore-all"), "*\n");
    symlinkSync("../ignore-all", join(root, ".gitignore"));
    writeFileSync(join(root, "a.txt"), "a\n");
    const walked: string[] = [];
    for await (const entry of worktree.walk()) walked.push(entry.path);
    expect(walked).toContain("a.txt");
  });
});

describe("FileWorktree beneath links, special files, umask, case folding", () => {
  let base: string;
  let root: string;
  let worktree: Worktree;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "worktree-links2-"));
    root = join(base, "repo");
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(join(root, ".git/config"), "[core]\n");
    mkdirSync(join(base, "outdir"));
    writeFileSync(join(base, "outdir/secret.txt"), "SECRET\n");
    symlinkSync("../outdir", join(root, "d"));
    worktree = createFileWorktree({
      files: createNodeFilesApi({ rootDir: root }),
      rootPath: "",
      gitDir: ".git",
      ...noStores,
    });
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it("never reads or hashes a file beneath a link", async () => {
    await expect(collect(worktree.readContent("d/secret.txt"))).rejects.toThrow(/symbolic link/);
    await expect(worktree.computeHash("d/secret.txt")).rejects.toThrow(/symbolic link/);
    // and reports it absent, as git's lstat cache does
    expect(await worktree.getEntry("d/secret.txt")).toBeUndefined();
    expect(await worktree.exists("d/secret.txt")).toBe(false);
  });

  it("treats a path beneath a link as absent when removing it", async () => {
    expect(await worktree.remove("d/secret.txt")).toBe(false);
    expect(readFileSync(join(base, "outdir/secret.txt"), "utf8")).toBe("SECRET\n");
  });

  it("a forced write unlinks a link where a directory must go, never following it", async () => {
    await worktree.writeContent("d/new.txt", enc.encode("new\n"), { replaceInTheWay: true });
    expect(lstatSync(join(root, "d")).isDirectory()).toBe(true);
    expect(readFileSync(join(root, "d/new.txt"), "utf8")).toBe("new\n");
    expect(readdirSync(join(base, "outdir"))).toEqual(["secret.txt"]);
  });

  it.skipIf(process.platform === "win32")("skips a FIFO: neither listed nor an entry", async () => {
    execFileSync("mkfifo", [join(root, "pipe")]);
    writeFileSync(join(root, "a.txt"), "a\n");
    const walked: string[] = [];
    for await (const entry of worktree.walk()) walked.push(entry.path);
    expect(walked).not.toContain("pipe");
    expect(walked).toContain("a.txt");
    expect(await worktree.getEntry("pipe")).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")(
    "sets the executable bit from the file's mode, keeping the umask",
    () => {
      // process.umask cannot change in a worker thread: a child process writes the files
      const script = `
        process.umask(0o077);
        const { createFileWorktree } = await import("@statewalker/vcs-store-files");
        const { createNodeFilesApi } = await import("@statewalker/vcs-utils-node/files");
        const { statSync } = await import("node:fs");
        const w = createFileWorktree({ files: createNodeFilesApi({ rootDir: ${JSON.stringify(root)} }), rootPath: "", blobs: {}, trees: {} });
        const e = new TextEncoder();
        await w.writeContent("run.sh", e.encode("#!/bin/sh\\n"), { mode: 0o100755 });
        await w.writeContent("a.txt", e.encode("a\\n"), { mode: 0o100644 });
        const m = (p) => (statSync(${JSON.stringify(root)} + "/" + p).mode & 0o777).toString(8);
        console.log(m("run.sh"), m("a.txt"));
      `;
      const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
        cwd: join(__dirname, "../../.."),
        encoding: "utf8",
      }).trim();
      expect(out).toBe("700 600");
    },
  );

  it("probes case folding only on a real filesystem", async () => {
    const folding = await (
      worktree as Worktree & {
        probeCaseFolding(): Promise<{ ignoreCase: boolean; precomposeUnicode: boolean }>;
      }
    ).probeCaseFolding();
    const caseInsensitive = existsSync(join(root, ".git/CoNfIg"));
    expect(folding.ignoreCase).toBe(caseInsensitive);
    expect(readdirSync(join(root, ".git"))).toEqual(["config"]);
    expect(
      await probeCaseFolding(createInMemoryFilesApi({ "/.git/config": "x" }), "/.git"),
    ).toEqual({ ignoreCase: false, precomposeUnicode: false });
  });

  it("reports a folding filesystem (simulated)", async () => {
    const files = createInMemoryFilesApi({ "/.git/config": "x" });
    const folding = await probeCaseFolding(
      Object.assign(files, {
        lstat: async (path: string) => {
          const folded = path.normalize("NFC").toLowerCase();
          const stats = await files.stats(folded === "/.git/config" ? "/.git/config" : folded);
          return stats && { kind: stats.kind, size: 0, lastModified: 0 };
        },
      }),
      "/.git",
    );
    expect(folding).toEqual({ ignoreCase: true, precomposeUnicode: true });
  });

  it("tells whether the worktree folds case without writing, or that it cannot tell", async () => {
    const real = await worktree.foldsCase?.();
    expect(real).toBe(existsSync(join(root, ".GIT")));
    expect(readdirSync(join(root, ".git"))).toEqual(["config"]);
    const at = (files: Parameters<typeof createFileWorktree>[0]["files"]) =>
      createFileWorktree({ files, rootPath: "/", gitDir: "/.git", ...noStores }).foldsCase?.();
    // memory keeps case; an empty worktree gives nothing to tell by
    expect(await at(createInMemoryFilesApi({ "/.git/config": "x" }))).toBe(false);
    expect(await at(createInMemoryFilesApi())).toBeUndefined();
    const folding = createSymlinkFilesApi(createInMemoryFilesApi({ "/README": "x" }), {
      ignoreCase: true,
    });
    expect(await at(folding)).toBe(true);
  });

  it("looks at the worktree's own entries for case folding, not a git directory outside it", async () => {
    const at = (files: Parameters<typeof createFileWorktree>[0]["files"], gitDir: string) =>
      createFileWorktree({ files, rootPath: "/wt", gitDir, ...noStores }).foldsCase?.();
    // a separate git directory (linked worktree, submodule) may be on another filesystem
    const separate = createInMemoryFilesApi({ "/repo.git/config": "x" });
    await separate.mkdir("/wt");
    expect(await at(separate, "/repo.git")).toBeUndefined();
    // one inside the root is still looked at when the root has nothing else
    expect(await at(createInMemoryFilesApi({ "/wt/.git/config": "x" }), "/wt/.git")).toBe(false);
    // the worktree's entries come first
    const folding = createSymlinkFilesApi(
      createInMemoryFilesApi({ "/wt/README": "x", "/repo.git/config": "x" }),
      { ignoreCase: true },
    );
    expect(await at(folding, "/repo.git")).toBe(true);
  });
});

describe("FileWorktree path rules follow the FilesApi's platform", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "worktree-platform-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const worktreeOn = (platform: NodeJS.Platform) =>
    createFileWorktree({
      files: new PosixNodeFilesApi({ rootDir: root, platform }),
      rootPath: "",
      ...noStores,
    });

  it("on Windows refuses a backslash and reserved names (git's Windows verify_path)", async () => {
    const windows = worktreeOn("win32");
    expect(windows.capabilities?.windowsPaths).toBe(true);
    await expect(windows.writeContent("d\\post-checkout", enc.encode("x"))).rejects.toThrow(
      /Invalid worktree path/,
    );
    await expect(windows.writeContent("nul.txt", enc.encode("x"))).rejects.toThrow(
      /Invalid worktree path/,
    );
  });

  it("elsewhere writes `a\\b.txt` as a file name", async () => {
    const posix = worktreeOn("linux");
    expect(posix.capabilities?.windowsPaths).toBe(false);
    await posix.writeContent("a\\b.txt", enc.encode("x"));
    expect(readFileSync(join(root, "a\\b.txt"), "utf8")).toBe("x");
  });
});
