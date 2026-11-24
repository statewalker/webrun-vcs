/**
 * `git config`'s file edits (`setConfigMultivarInFile`, `renameConfigSectionInFile`) over a
 * portable (in-memory) FilesApi: the lock protocol and the refusals that leave the file alone.
 * Their bytes are compared with native git in vcs-commands' `config-write-native.test.ts`
 * (t1300-config).
 */
import {
  CONFIG_REGEX_NONE,
  type ConfigFileLocation,
  renameConfigSectionInFile,
  setConfigMultivarInFile,
  setConfigMultivarText,
} from "@statewalker/vcs-store-files";
import { createInMemoryFilesApi, readFile } from "@statewalker/vcs-utils/files";
import { describe, expect, it } from "vitest";

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

async function setup(content?: string): Promise<ConfigFileLocation> {
  const files = createInMemoryFilesApi();
  await files.mkdir("/repo/.git");
  if (content !== undefined) {
    await files.write("/repo/.git/config", [new TextEncoder().encode(content)]);
  }
  return { files, path: "/repo/.git/config", name: ".git/config" };
}

describe("config file edits (t1300-config)", () => {
  it("writes through config.lock and leaves no lock behind", async () => {
    const at = await setup("# keep me\n[a]\n\tx = 1\n");
    const outcome = await setConfigMultivarInFile(at, "a.y", "2");
    expect(outcome).toEqual({ status: 0, stderr: [] });
    expect(text(await readFile(at.files, at.path))).toBe("# keep me\n[a]\n\tx = 1\n\ty = 2\n");
    expect(await at.files.exists("/repo/.git/config.lock")).toBe(false);
  });

  it("refuses with 255 while the lock is held, leaving the file and the lock alone", async () => {
    const at = await setup("[a]\n\tx = 1\n");
    await at.files.write("/repo/.git/config.lock", [new Uint8Array(0)]);
    const outcome = await setConfigMultivarInFile(at, "a.x", "2");
    expect(outcome).toEqual({
      status: 255,
      stderr: ["error: could not lock config file .git/config: File exists"],
    });
    expect(text(await readFile(at.files, at.path))).toBe("[a]\n\tx = 1\n");
    expect(await at.files.exists("/repo/.git/config.lock")).toBe(true);
    const renamed = await renameConfigSectionInFile(at, "a", "b");
    expect(renamed).toEqual({
      count: -1,
      stderr: ["error: could not lock config file .git/config"],
    });
  });

  it("rolls the lock back on every refusal (5, 6, 1, 2)", async () => {
    const at = await setup("[a]\n\tx = 1\n\tx = 2\n");
    for (const [key, value, options, status] of [
      ["a.x", "3", {}, 5],
      ["a.x", undefined, {}, 5],
      ["a.nope", undefined, {}, 5],
      ["a.x", "3", { valuePattern: "[" }, 6],
      ["a.1x", "3", {}, 1],
      ["ax", "3", {}, 2],
    ] as const) {
      const outcome = await setConfigMultivarInFile(at, key, value, options);
      expect(outcome.status).toBe(status);
      expect(await at.files.exists("/repo/.git/config.lock")).toBe(false);
    }
    expect(text(await readFile(at.files, at.path))).toBe("[a]\n\tx = 1\n\tx = 2\n");
  });

  it("creates no directory for the lock (git's open fails)", async () => {
    const files = createInMemoryFilesApi();
    const outcome = await setConfigMultivarInFile(
      { files, path: "/nodir/cfg", name: "nodir/cfg" },
      "a.b",
      "c",
    );
    expect(outcome).toEqual({
      status: 255,
      stderr: ["error: could not lock config file nodir/cfg: No such file or directory"],
    });
    expect(await files.exists("/nodir")).toBe(false);
  });

  it("keeps comments and includes around the values it edits", () => {
    const before =
      "[include]\n\tpath = other\n# about a\n[a]\n\tx = 1 ; one\n\tx = 2\n[b]\n\ty = 1\n";
    const added = setConfigMultivarText(before, "cfg", "a.x", "3", {
      valuePattern: CONFIG_REGEX_NONE,
    });
    expect(added.text).toBe(
      "[include]\n\tpath = other\n# about a\n[a]\n\tx = 1 ; one\n\tx = 2\n\tx = 3\n[b]\n\ty = 1\n",
    );
    const unset = setConfigMultivarText(before, "cfg", "a.x", undefined, { multiReplace: true });
    // the comment before the section keeps it
    expect(unset.text).toBe("[include]\n\tpath = other\n# about a\n[a]\n[b]\n\ty = 1\n");
  });
});
