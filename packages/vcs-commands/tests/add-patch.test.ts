import { describe, expect, it } from "vitest";

import {
  PATCH_MODES,
  type PatchRequest,
  patchModeFor,
  runAddPatch,
} from "../src/commands/add-patch/index.js";

const DIFF = `diff --git a/f b/f
index 0ff3bbb..5ecd119 100644
--- a/f
+++ b/f
@@ -1,7 +1,7 @@
 1
-2
+two
 3
-4
+four
 5
 6
 7
`;

function backend(diff: string) {
  const applied: { patch: string; cached: boolean; reverse: boolean; check?: boolean }[] = [];
  return {
    applied,
    diff: async () => diff,
    apply: async (patch: string, args: { cached: boolean; reverse: boolean; check?: boolean }) => {
      applied.push({ patch, ...args });
      return { ok: true, errors: "" };
    },
  };
}

describe("runAddPatch", () => {
  it("splits a hunk and applies the selected half as git reassembles it", async () => {
    const b = backend(DIFF);
    const answers = ["s", "n", "y"];
    const requests: PatchRequest[] = [];
    const result = await runAddPatch({
      mode: PATCH_MODES.stage,
      backend: b,
      selector: (r) => {
        requests.push(r);
        return answers.shift();
      },
    });
    expect(result.output).toContain("Split into 2 hunks.\n");
    expect(result.output).toContain("(1/2) Stage this hunk [y,n,q,a,d,k,K,j,J,g,/,e,p,P,?]? ");
    expect(b.applied).toEqual([
      {
        patch: `diff --git a/f b/f
index 0ff3bbb..5ecd119 100644
--- a/f
+++ b/f
@@ -3,5 +3,5 @@
 3
-4
+four
 5
 6
 7
`,
        cached: true,
        reverse: false,
      },
    ]);
    expect(result.applied).toEqual(["f"]);
    const first = requests[0];
    expect(first.type === "hunk" && first.choices).toEqual([
      "y",
      "n",
      "q",
      "a",
      "d",
      "s",
      "e",
      "p",
      "P",
      "?",
    ]);
  });

  it("prints 2.43's prompts and help", async () => {
    const b = backend(DIFF);
    const answers = ["?", "q"];
    const result = await runAddPatch({
      mode: patchModeFor("reset"),
      backend: b,
      compatibility: "2.43",
      selector: () => answers.shift(),
    });
    expect(result.output).toContain(
      "(1/1) Unstage this hunk [y,n,q,a,d,s,e,?]? y - unstage this hunk\n",
    );
    expect(result.output).toContain("s - split the current hunk into smaller hunks\n");
    expect(b.applied).toEqual([]);
    expect(result.quit).toBe(true);
  });

  it("says No changes for an empty diff", async () => {
    const modern = await runAddPatch({
      mode: PATCH_MODES.stage,
      backend: backend(""),
      selector: () => undefined,
    });
    expect(modern.output).toBe("No changes.\n");
    const legacy = await runAddPatch({
      mode: PATCH_MODES.stage,
      backend: backend(""),
      compatibility: "2.43",
      selector: () => undefined,
    });
    expect(legacy.errors).toBe("No changes.\n");
  });

  it("shows the patch as a last resort when only the worktree refuses it (2.43: stderr)", async () => {
    for (const compatibility of ["2.56", "2.43"] as const) {
      const b = {
        diff: async () => DIFF,
        apply: async (_patch: string, args: { cached: boolean; check?: boolean }) => ({
          ok: args.cached,
          errors: "",
        }),
      };
      const result = await runAddPatch({
        mode: patchModeFor("checkout", "HEAD"),
        backend: b,
        compatibility,
        selector: () => "y",
      });
      const count = (text: string) => text.split("diff --git a/f b/f\n").length - 1;
      // the file's header as prompted, then the patch shown
      expect([count(result.output), count(result.errors)]).toEqual(
        compatibility === "2.43" ? [1, 1] : [2, 0],
      );
    }
  });

  it("refreshes the index before the diff (not in index-only modes) and after each apply", async () => {
    const calls: string[] = [];
    const make = () => ({
      ...backend(DIFF),
      diff: async () => {
        calls.push("diff");
        return DIFF;
      },
      refresh: async () => {
        calls.push("refresh");
        return "u: needs merge\n";
      },
    });
    const staged = await runAddPatch({
      mode: PATCH_MODES.stage,
      backend: make(),
      selector: () => "a",
    });
    expect(calls).toEqual(["refresh", "diff", "refresh"]);
    expect(staged.output.startsWith("u: needs merge\ndiff --git")).toBe(true);
    calls.length = 0;
    await runAddPatch({
      mode: patchModeFor("reset", "HEAD"),
      backend: make(),
      selector: () => "a",
    });
    expect(calls).toEqual(["diff", "refresh"]);
  });
});
