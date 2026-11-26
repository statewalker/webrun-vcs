// THROWAWAY (statewalker/webrun-vcs#437): a deliberately failing test, to show that a failing
// shard fails the run and that tested-record then records nothing. Reverted before merge.
import { expect, it } from "vitest";

it("fails on purpose", () => {
  expect(1).toBe(2);
});
