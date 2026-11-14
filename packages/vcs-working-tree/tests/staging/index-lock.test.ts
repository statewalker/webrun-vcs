/**
 * The index is written through `index.lock`, as git does: an existing lock
 * refuses the write, and a failed write leaves the old index and no lock.
 */
import { createInMemoryFilesApi, type FilesApi } from "@statewalker/vcs-utils/files";
import { describe, expect, it } from "vitest";
import { createGitStaging, GitStaging } from "../../src/staging/index.js";

const ID_A = "a".repeat(40);
const ID_B = "b".repeat(40);
const enc = new TextEncoder();

async function bytes(files: FilesApi, path: string): Promise<Uint8Array | undefined> {
  if (!(await files.exists(path))) return undefined;
  const parts: Uint8Array[] = [];
  for await (const c of files.read(path)) parts.push(c);
  const out = new Uint8Array(parts.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of parts) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

function sameBytes(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function stagedIndex(files: FilesApi): Promise<Uint8Array> {
  const staging = createGitStaging(files, ".git/index");
  await staging.setEntry({ path: "a.txt", mode: 0o100644, objectId: ID_A });
  await staging.write();
  return (await bytes(files, ".git/index")) as Uint8Array;
}

describe("index.lock", () => {
  it("an existing lock refuses the write and leaves the index untouched", async () => {
    const files = createInMemoryFilesApi();
    const before = await stagedIndex(files);
    await files.write(".git/index.lock", [enc.encode("held by someone else")]);

    const staging = createGitStaging(files, ".git/index");
    await staging.read();
    await staging.setEntry({ path: "b.txt", mode: 0o100644, objectId: ID_B });
    await expect(staging.write()).rejects.toThrow(
      "Unable to create '.git/index.lock': File exists",
    );

    expect(sameBytes(await bytes(files, ".git/index"), before)).toBe(true);
    // the other writer's lock is not ours to remove
    expect(new TextDecoder().decode(await bytes(files, ".git/index.lock"))).toBe(
      "held by someone else",
    );
  });

  it("a failing write leaves the index untouched and no lock behind", async () => {
    const files = createInMemoryFilesApi();
    const before = await stagedIndex(files);

    // a FilesApi whose writes of the lock file fail after the first chunk
    const failing = Object.create(files) as FilesApi;
    failing.write = async (path, content) => {
      if (!path.endsWith(".lock")) return files.write(path, content);
      async function* broken() {
        for await (const c of content) {
          yield c;
          throw new Error("disk full");
        }
      }
      return files.write(path, broken());
    };
    const staging = createGitStaging(failing, ".git/index");
    await staging.read();
    await staging.setEntry({ path: "b.txt", mode: 0o100644, objectId: ID_B });
    await expect(staging.write()).rejects.toThrow("disk full");

    expect(sameBytes(await bytes(files, ".git/index"), before)).toBe(true);
    expect(await files.exists(".git/index.lock")).toBe(false);
  });

  it("a successful write replaces the index and leaves no lock", async () => {
    const files = createInMemoryFilesApi();
    const before = await stagedIndex(files);
    const staging = createGitStaging(files, ".git/index");
    await staging.read();
    await staging.setEntry({ path: "b.txt", mode: 0o100644, objectId: ID_B });
    await staging.write();
    expect(sameBytes(await bytes(files, ".git/index"), before)).toBe(false);
    expect(await files.exists(".git/index.lock")).toBe(false);
    const again = createGitStaging(files, ".git/index");
    await again.read();
    expect(await again.getEntryCount()).toBe(2);
  });

  it("waits for the lock to go away when lockTimeoutMs is set", async () => {
    const files = createInMemoryFilesApi();
    await stagedIndex(files);
    await files.write(".git/index.lock", [enc.encode("x")]);
    setTimeout(() => void files.remove(".git/index.lock"), 50);

    const staging = new GitStaging(files, ".git/index", { lockTimeoutMs: 2000 });
    await staging.read();
    await staging.setEntry({ path: "b.txt", mode: 0o100644, objectId: ID_B });
    await staging.write();
    expect(await files.exists(".git/index.lock")).toBe(false);
  });

  it("an invalid object id fails before the lock is taken", async () => {
    const files = createInMemoryFilesApi();
    const before = await stagedIndex(files);
    const staging = createGitStaging(files, ".git/index");
    await staging.read();
    await staging.setEntry({ path: "b.txt", mode: 0o100644, objectId: "b".repeat(39) });
    await expect(staging.write()).rejects.toThrow("not an object id");
    expect(sameBytes(await bytes(files, ".git/index"), before)).toBe(true);
    expect(await files.exists(".git/index.lock")).toBe(false);
  });
});
