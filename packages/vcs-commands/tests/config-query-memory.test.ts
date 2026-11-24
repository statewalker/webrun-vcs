/**
 * `git.config()` queries over a working copy whose configuration is a plain object (a
 * `MemoryWorkingCopy`'s), which has no file chain to list: its keys are read as they are.
 */
import { createMemoryHistory } from "@statewalker/vcs-core";
import { MemoryWorkingCopy } from "@statewalker/vcs-working-tree";
import { describe, expect, it } from "vitest";
import { Git } from "../src/index.js";

function gitWith(config: Record<string, unknown>): Git {
  const history = createMemoryHistory();
  return Git.fromWorkingCopy(
    new MemoryWorkingCopy({ history, config } as ConstructorParameters<
      typeof MemoryWorkingCopy
    >[0]),
  );
}

describe("git config queries over a plain-object configuration", () => {
  it("get reads a key of the object", async () => {
    const result = await gitWith({ "user.name": "Alice" }).config().get("user.name").call();
    expect(result).toMatchObject({ exitCode: 0, stdout: "Alice\n", stderr: "" });
  });

  it("get canonicalises the key, types the value, and misses an absent key", async () => {
    const git = gitWith({ "core.bare": true, "pack.window": 1024, "Core.Editor": "vim" });
    expect(await git.config().get("CORE.BARE").setType("bool").call()).toMatchObject({
      exitCode: 0,
      stdout: "true\n",
    });
    expect(await git.config().get("pack.window").setType("int").call()).toMatchObject({
      stdout: "1024\n",
    });
    expect(await git.config().get("core.editor").call()).toMatchObject({ stdout: "vim\n" });
    expect(await git.config().get("user.email").call()).toMatchObject({ exitCode: 1, stdout: "" });
  });

  it("list and get-regexp list every value, several for an array", async () => {
    const git = gitWith({ "remote.origin.fetch": ["+a:b", "+c:d"], "core.bare": true });
    expect((await git.config().list().call()).stdout).toBe(
      "remote.origin.fetch=+a:b\nremote.origin.fetch=+c:d\ncore.bare\n",
    );
    expect((await git.config().setLegacySyntax(true).getRegexp("fetch").call()).stdout).toBe(
      "remote.origin.fetch +a:b\nremote.origin.fetch +c:d\n",
    );
  });
});
