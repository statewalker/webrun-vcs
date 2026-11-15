/**
 * FileRefStore.set creates reflogs as git does for core.logAllRefUpdates: true
 * (the default of a non-bare repository) logs HEAD, refs/heads/, refs/remotes/ and
 * refs/notes/; "always" logs every ref; false (the default of a bare repository)
 * creates none. An existing reflog is appended to whatever the setting.
 */
import { createInMemoryFilesApi, type FilesApi, type ObjectId } from "@statewalker/vcs-core";
import { readText } from "@statewalker/vcs-utils/files";
import { describe, expect, it } from "vitest";
import { createGitFilesBackend } from "../../src/index.js";

const oid = (n: number): ObjectId => n.toString(16).padStart(40, "a");
const enc = new TextEncoder();

/** A repository at `gitDir`, with `extraConfig` appended to its config, opened afresh. */
async function open(gitDir: string, extraConfig = "") {
  const files = createInMemoryFilesApi();
  await createGitFilesBackend({ files, gitDir, create: true });
  if (extraConfig) {
    const config = await readText(files, `${gitDir}/config`);
    await files.write(`${gitDir}/config`, [enc.encode(config + extraConfig)]);
  }
  const { history } = await createGitFilesBackend({ files, gitDir });
  return { files, refs: history.refs };
}

const lines = async (files: FilesApi, path: string) =>
  (await files.exists(path)) ? (await readText(files, path)).split("\n").filter(Boolean) : [];

describe("reflogs follow core.logAllRefUpdates and core.bare", () => {
  it("a bare repository creates no reflog on set", async () => {
    const { files, refs } = await open(".");
    expect(await readText(files, "config")).toContain("bare = true");
    await refs.set("refs/heads/main", oid(1));
    await refs.set("refs/heads/main", oid(2));
    expect(await files.exists("logs/refs/heads/main")).toBe(false);
    expect(await files.exists("logs/HEAD")).toBe(false);
  });

  it("a non-bare repository creates reflogs for branches, not for tags", async () => {
    const { files, refs } = await open(".git");
    await refs.set("refs/heads/main", oid(1));
    await refs.set("refs/remotes/origin/main", oid(1));
    await refs.set("refs/tags/v1", oid(1));
    expect(await lines(files, ".git/logs/refs/heads/main")).toHaveLength(1);
    expect(await lines(files, ".git/logs/HEAD")).toHaveLength(1);
    expect(await lines(files, ".git/logs/refs/remotes/origin/main")).toHaveLength(1);
    expect(await files.exists(".git/logs/refs/tags/v1")).toBe(false);
  });

  it("core.logAllRefUpdates = always creates reflogs for tags too", async () => {
    const { files, refs } = await open(".git", "\tlogAllRefUpdates = always\n");
    await refs.set("refs/tags/v1", oid(1));
    await refs.set("refs/custom/x", oid(1));
    expect(await lines(files, ".git/logs/refs/tags/v1")).toHaveLength(1);
    expect(await lines(files, ".git/logs/refs/custom/x")).toHaveLength(1);
  });

  it("core.logAllRefUpdates = true in a bare repository creates branch reflogs", async () => {
    const { files, refs } = await open(".", "\tlogAllRefUpdates = true\n");
    await refs.set("refs/heads/main", oid(1));
    await refs.set("refs/tags/v1", oid(1));
    expect(await lines(files, "logs/refs/heads/main")).toHaveLength(1);
    expect(await files.exists("logs/refs/tags/v1")).toBe(false);
  });

  it("an existing reflog is appended to even with core.logAllRefUpdates = false", async () => {
    const { files, refs } = await open(".git", "\tlogAllRefUpdates = false\n");
    const first = `${"0".repeat(40)} ${oid(1)} A <a@b> 1700000000 +0000\tfirst\n`;
    await files.write(".git/logs/refs/heads/old", [enc.encode(first)]);
    await refs.set("refs/heads/old", oid(2));
    await refs.set("refs/heads/new", oid(2));
    expect(await lines(files, ".git/logs/refs/heads/old")).toHaveLength(2);
    expect(await files.exists(".git/logs/refs/heads/new")).toBe(false);
    expect(await files.exists(".git/logs/HEAD")).toBe(false);
  });

  it("reflog lines use the configured user.name and user.email", async () => {
    const { files, refs } = await open(
      ".git",
      "[user]\n\tname = Jane Doe\n\temail = jane@example.com\n",
    );
    await refs.set("refs/heads/main", oid(1));
    const [line] = await lines(files, ".git/logs/refs/heads/main");
    expect(line).toMatch(/ Jane Doe <jane@example\.com> \d+ [+-]\d{4}(\t|$)/);
  });
});
