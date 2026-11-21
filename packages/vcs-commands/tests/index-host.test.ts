/**
 * The index host commands give their staging: what one write's settings carry, and when
 * state meant for one write (`git apply`'s re-added paths) is cleared.
 */
import type { Staging, WorkingCopy } from "@statewalker/vcs-working-tree";
import { describe, expect, it } from "vitest";

import { indexHostOf, markReaddedEntries } from "../src/commands/index-host.js";

describe("index host", () => {
  it("re-added paths survive settings asked before the write and go once it is written", async () => {
    const staging = {} as Staging;
    const host = indexHostOf({} as WorkingCopy, staging, () => {
      throw new Error("no trees");
    });
    markReaddedEntries(staging, ["a.txt", "b.txt"]);
    // wantsRewrite (stat refresh) asks for the settings without writing
    expect([...((await host.settings?.())?.readded ?? [])]).toEqual(["a.txt", "b.txt"]);
    // the write itself
    expect([...((await host.settings?.())?.readded ?? [])]).toEqual(["a.txt", "b.txt"]);
    host.written?.();
    expect((await host.settings?.())?.readded).toBeUndefined();
  });
});
