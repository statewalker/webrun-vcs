/**
 * Alternates in memory: git's parsing of `objects/info/alternates` and
 * `$GIT_ALTERNATE_OBJECT_DIRECTORIES`, the order and skips of `odb_add_alternate_recursively`,
 * and the store's reads and writes over them.
 */
import { createInMemoryFilesApi } from "@statewalker/vcs-core";
import { describe, expect, it } from "vitest";
import { createGitFilesBackend, parseAlternates } from "../src/index.js";

const enc = new TextEncoder();

describe("parseAlternates", () => {
  it("skips comments and empty entries, unquotes C-style paths, keeps the rest as written", () => {
    expect(parseAlternates('# a comment\n\n../x/objects\n"/a\\tb/objects"\n/c\r\n', "\n")).toEqual([
      "../x/objects",
      "/a\tb/objects",
      "/c\r",
    ]);
  });

  it("splits the variable at colons; a quoted entry may hold one", () => {
    expect(parseAlternates('/a/objects:"/b:c/objects":rel', ":")).toEqual([
      "/a/objects",
      "/b:c/objects",
      "rel",
    ]);
  });

  it("skips one character after a closing quote, whatever it is (git's end++)", () => {
    expect(parseAlternates('"/a"x/b\n', "\n")).toEqual(["/a", "/b"]);
  });

  it("reads broken quoting unquoted", () => {
    expect(parseAlternates('"/a\n/b\n', "\n")).toEqual(['"/a', "/b"]);
  });
});

/** A repository at `dir` in `files` holding one blob. */
async function repoWithBlob(
  files: ReturnType<typeof createInMemoryFilesApi>,
  dir: string,
  text: string,
) {
  const backend = await createGitFilesBackend({ files, gitDir: `${dir}/.git`, create: true });
  const bytes = enc.encode(text);
  const id = await backend.objects.put("blob", bytes.length, [bytes]);
  return { backend, id };
}

describe("a files store with alternates", () => {
  it("reads borrowed objects, lists them once, writes and removes only its own", async () => {
    const files = createInMemoryFilesApi();
    const alt = await repoWithBlob(files, "/alt", "borrowed\n");
    await files.write("/repo/.git/objects/info/alternates", [
      enc.encode("# shared\n../../../alt/.git/objects\n/alt/.git/objects\n/repo/.git/objects\n"),
    ]);
    const repo = await createGitFilesBackend({ files, gitDir: "/repo/.git", create: true });
    // the same directory twice and the objects directory itself are skipped quietly
    expect((await repo.objects.alternates?.list())?.map((a) => a.objectsDir)).toEqual([
      "/alt/.git/objects",
    ]);
    expect(repo.objects.alternates?.errors).toEqual([]);
    expect(await repo.objects.has(alt.id)).toBe(true);
    expect((await repo.objects.get(alt.id))?.type).toBe("blob");
    // a write of a borrowed object stores nothing here
    const bytes = enc.encode("borrowed\n");
    await repo.objects.put("blob", bytes.length, [bytes]);
    expect(await files.exists(`/repo/.git/objects/${alt.id.slice(0, 2)}/${alt.id.slice(2)}`)).toBe(
      false,
    );
    const own = enc.encode("own\n");
    const ownId = await repo.objects.put("blob", own.length, [own]);
    const listed: string[] = [];
    for await (const id of repo.objects.list()) listed.push(id);
    expect(listed.sort()).toEqual([alt.id, ownId].sort());
    const prefixed: string[] = [];
    for await (const id of repo.objects.listPrefix?.(alt.id.slice(0, 3)) ?? []) prefixed.push(id);
    expect(prefixed).toContain(alt.id);
    expect(await repo.objects.remove(alt.id)).toBe(false);
    expect(await alt.backend.objects.has(alt.id)).toBe(true);
  });

  it("reports a missing directory and nesting too deep, as git", async () => {
    const files = createInMemoryFilesApi();
    const dirs = ["/a0", "/a1", "/a2", "/a3", "/a4", "/a5", "/a6", "/a7"];
    const ids: string[] = [];
    for (const d of dirs) ids.push((await repoWithBlob(files, d, `${d}\n`)).id);
    for (let i = 0; i < dirs.length - 1; i++) {
      await files.write(`${dirs[i]}/.git/objects/info/alternates`, [
        enc.encode(`${dirs[i + 1]}/.git/objects\n${i === 0 ? "/gone/objects\n" : ""}`),
      ]);
    }
    const { objects } = await createGitFilesBackend({ files, gitDir: "/a0/.git" });
    // depth first: a1 and what it borrows are linked before a0's second entry
    expect(objects.alternates?.errors).toEqual([
      "error: /a6/.git/objects: ignoring alternate object stores, nesting too deep",
      "error: object directory /gone/objects does not exist; check .git/objects/info/alternates",
    ]);
    expect(await objects.has(ids[6] as string)).toBe(true);
    expect(await objects.has(ids[7] as string)).toBe(false);
  });

  it("adds an alternate (clone --shared) and dissociates from it (clone --dissociate)", async () => {
    const files = createInMemoryFilesApi();
    const alt = await repoWithBlob(files, "/alt", "borrowed\n");
    const repo = await createGitFilesBackend({ files, gitDir: "/repo/.git", create: true });
    expect(await repo.objects.has(alt.id)).toBe(false);
    await repo.objects.alternates?.add("/alt/.git/objects");
    await repo.objects.alternates?.add("/alt/.git/objects");
    expect(await files.exists("/repo/.git/objects/info/alternates")).toBe(true);
    expect(await repo.objects.has(alt.id)).toBe(true);
    await repo.history.refs.set("refs/tags/b", alt.id);
    await repo.objects.alternates?.dissociate?.();
    expect(await files.exists("/repo/.git/objects/info/alternates")).toBe(false);
    expect(await repo.objects.alternates?.list()).toEqual([]);
    // copied into a pack of its own
    expect(await repo.packs.has(alt.id)).toBe(true);
  });
});
