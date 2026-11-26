/**
 * `extensions.compatObjectFormat` without native git: object conversion as git's
 * object-file-convert.c, the loose object map kept by loose writes (the repository's and a
 * quarantine's), and repositories without the extension left as they were. The native twins
 * are vcs-commands' `compat-object-format-git3-native.test.ts`.
 */
import { createInMemoryFilesApi, type FilesApi } from "@statewalker/vcs-core";
import { SHA1_OBJECT_FORMAT, SHA256_OBJECT_FORMAT } from "@statewalker/vcs-utils/hash";
import { describe, expect, it } from "vitest";
import {
  CompatObjectConversionError,
  convertObjectContent,
  createGitFilesBackend,
  LooseObjectMap,
} from "../src/index.js";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const ID256 = (c: string) => c.repeat(64);
const ID1 = (c: string) => c.repeat(40);

async function read(files: FilesApi, path: string): Promise<string> {
  if ((await files.stats(path))?.kind !== "file") return "";
  const chunks: Uint8Array[] = [];
  for await (const c of files.read(path)) chunks.push(c);
  return dec(new Uint8Array(chunks.flatMap((c) => [...c])));
}

async function compatRepo() {
  const files = createInMemoryFilesApi();
  const created = await createGitFilesBackend({
    files,
    create: true,
    objectFormat: SHA256_OBJECT_FORMAT,
  });
  await created.history.initialize();
  const config = await read(files, ".git/config");
  await files.write(".git/config", [
    enc(`${config.replace(/\[extensions\]\n/, "[extensions]\n\tcompatObjectFormat = sha1\n")}`),
  ]);
  return createGitFilesBackend({ files });
}

describe("object conversion (object-file-convert.c)", () => {
  const map = async (id: string) => ({ [ID256("a")]: ID1("1"), [ID256("b")]: ID1("2") })[id];

  it("rewrites a commit's tree and parents and keeps the rest", async () => {
    const commit = `tree ${ID256("a")}\nparent ${ID256("b")}\nauthor A <a@x> 1 +0000\ncommitter C <c@x> 1 +0000\nencoding ISO-8859-1\n\nmsg\n`;
    const out = await convertObjectContent(
      "commit",
      enc(commit),
      SHA256_OBJECT_FORMAT,
      SHA1_OBJECT_FORMAT,
      map,
    );
    expect(dec(out)).toBe(commit.replace(ID256("a"), ID1("1")).replace(ID256("b"), ID1("2")));
  });

  it("refuses an unmapped id and an unknown header with git's lines", async () => {
    const unmapped = `tree ${ID256("c")}\nauthor A <a@x> 1 +0000\n\nm\n`;
    const e1 = await convertObjectContent(
      "commit",
      enc(unmapped),
      SHA256_OBJECT_FORMAT,
      SHA1_OBJECT_FORMAT,
      map,
    ).catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(CompatObjectConversionError);
    expect((e1 as CompatObjectConversionError).lines).toEqual([
      `error: unable to map tree ${ID256("c")} in commit object`,
      "fatal: Failed to convert object from sha256 to sha1",
    ]);
    const unknown = `tree ${ID256("a")}\nfrobnicate ${ID256("b")}\n\nm\n`;
    const e2 = await convertObjectContent(
      "commit",
      enc(unknown),
      SHA256_OBJECT_FORMAT,
      SHA1_OBJECT_FORMAT,
      map,
    ).catch((e: unknown) => e);
    expect((e2 as CompatObjectConversionError).lines).toEqual([
      "fatal: Failed to convert object from sha256 to sha1",
    ]);
  });

  it("moves a tag's trailing signature into its format's header", async () => {
    const sig = "-----BEGIN PGP SIGNATURE-----\nabc\n-----END PGP SIGNATURE-----\n";
    const tag = `object ${ID256("a")}\ntype commit\ntag v1\ntagger T <t@x> 1 +0000\n\nrelease\n${sig}`;
    const out = await convertObjectContent(
      "tag",
      enc(tag),
      SHA256_OBJECT_FORMAT,
      SHA1_OBJECT_FORMAT,
      map,
    );
    expect(dec(out)).toBe(
      `object ${ID1("1")}\ntype commit\ntag v1\ntagger T <t@x> 1 +0000\ngpgsig-sha256 -----BEGIN PGP SIGNATURE-----\n abc\n -----END PGP SIGNATURE-----\n\nrelease\n`,
    );
  });

  it("rewrites tree entry ids to the other width", async () => {
    const raw = new Uint8Array([...enc("100644 f\0"), ...new Uint8Array(32).fill(0xaa)]);
    const out = await convertObjectContent(
      "tree",
      raw,
      SHA256_OBJECT_FORMAT,
      SHA1_OBJECT_FORMAT,
      map,
    );
    expect(out).toEqual(new Uint8Array([...enc("100644 f\0"), ...new Uint8Array(20).fill(0x11)]));
  });
});

describe("the loose object map (loose.c)", () => {
  it("records each loose object written, and reads back after a reopen", async () => {
    const { files, history, objects } = await compatRepo();
    const blob = await history.blobs.store([enc("hello\n")]);
    const tree = await history.trees.store([{ mode: 0o100644, name: "a", id: blob }]);
    const text = await read(files, ".git/objects/loose-object-idx");
    const lines = text.split("\n");
    expect(lines[0]).toBe("# loose-object-idx");
    expect(lines.slice(1, -1).map((l) => l.split(" ")[0])).toEqual([blob, tree]);
    // the SHA-1 id of a blob is its SHA-1 hash
    expect(await objects.compat?.toCompat(blob)).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
    const reopened = new LooseObjectMap({
      files,
      objectsDir: ".git/objects",
      storage: SHA256_OBJECT_FORMAT,
      compat: SHA1_OBJECT_FORMAT,
    });
    expect(await reopened.toStorage((await objects.compat?.toCompat(tree)) as string)).toBe(tree);
    // the empty tree is mapped without a line
    expect(await reopened.toCompat(SHA256_OBJECT_FORMAT.emptyTreeId)).toBe(
      SHA1_OBJECT_FORMAT.emptyTreeId,
    );
    // writing an object again adds no line
    await history.blobs.store([enc("hello\n")]);
    expect(await read(files, ".git/objects/loose-object-idx")).toBe(text);
  });

  it("refuses an unconvertible object before writing it", async () => {
    const { files, objects } = await compatRepo();
    const commit = enc(`tree ${ID256("c")}\nauthor A <a@x> 1 +0000\n\nm\n`);
    await expect(objects.put("commit", commit.length, [commit])).rejects.toBeInstanceOf(
      CompatObjectConversionError,
    );
    expect(await read(files, ".git/objects/loose-object-idx")).toBe("");
    const listed: string[] = [];
    for await (const id of objects.list()) listed.push(id);
    expect(listed).toEqual([]);
  });

  it("a quarantine's lines join the repository's map on commit, and go with a discard", async () => {
    const { files, objects } = await compatRepo();
    const q = await objects.beginQuarantine?.();
    if (!q) throw new Error("no quarantine");
    const blob = await q.objects.put("blob", 2, [enc("q\n")]);
    expect(await read(files, ".git/objects/loose-object-idx")).toBe("");
    await q.commit();
    expect(await read(files, ".git/objects/loose-object-idx")).toContain(`${blob} `);
    const d = await objects.beginQuarantine?.();
    const other = await d?.objects.put("blob", 2, [enc("d\n")]);
    await d?.discard();
    expect(await read(files, ".git/objects/loose-object-idx")).not.toContain(`${other} `);
  });

  it("a repository without the extension writes no map", async () => {
    const files = createInMemoryFilesApi();
    const { history, objects } = await createGitFilesBackend({
      files,
      create: true,
      objectFormat: SHA256_OBJECT_FORMAT,
    });
    await history.initialize();
    await history.blobs.store([enc("hello\n")]);
    expect(objects.compat).toBeUndefined();
    expect(await files.exists(".git/objects/loose-object-idx")).toBe(false);
  });
});
