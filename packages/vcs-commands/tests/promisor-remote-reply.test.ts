/**
 * What a `promisor-remote` answer leaves for `--filter=auto` lives for one git process
 * (promisor-remote.c's `promisor_remote.accepted`/`advertised_filter`): a later fetch through
 * the same working copy starts from nothing, so a filter an earlier server advertised neither
 * leaks into it nor meets a second one (git's `BUG()` for two accepted filters).
 */
import { describe, expect, it } from "vitest";
import {
  acceptedPromisorRemotes,
  promisorAutoFilter,
  promisorRemoteReplyOf,
  resetPromisorAcceptance,
} from "../src/commands/promisor-remote-reply.js";
import { RemoteConfigStore } from "../src/remote-config/index.js";
import { createInitializedGit } from "./test-helper.js";

describe("promisor-remote acceptance is per fetch", () => {
  it("a second fetch's --filter=auto sees only its own server's filter", async () => {
    const { workingCopy } = await createInitializedGit();
    const store = RemoteConfigStore.from(workingCopy);
    for (const name of ["lopA", "lopB"]) {
      store.setValue(`remote.${name}.url`, `https://example.com/${name}`);
      store.setValue(`remote.${name}.promisor`, "true");
    }
    store.setValue("promisor.acceptfromserver", "All");
    await store.save();
    const stderr: string[] = [];

    // the first fetch: server A advertises lopA with a filter
    resetPromisorAcceptance(workingCopy);
    const first = promisorRemoteReplyOf(workingCopy, (l) => stderr.push(l));
    expect(await first("name=lopA,url=https://example.com/lopA,partialCloneFilter=blob:none")).toBe(
      "lopA",
    );
    expect(promisorAutoFilter(workingCopy, (l) => stderr.push(l))).toBe("blob:none");

    // the second fetch: server B advertises lopB with another filter
    resetPromisorAcceptance(workingCopy);
    expect([...acceptedPromisorRemotes(workingCopy)]).toEqual([]);
    expect(promisorAutoFilter(workingCopy, (l) => stderr.push(l))).toBeUndefined();
    const second = promisorRemoteReplyOf(workingCopy, (l) => stderr.push(l));
    expect(
      await second("name=lopB,url=https://example.com/lopB,partialCloneFilter=blob:limit=5k"),
    ).toBe("lopB");
    expect(promisorAutoFilter(workingCopy, (l) => stderr.push(l))).toBe("blob:limit=5120");
    expect(stderr).toEqual([]);
  });
});
