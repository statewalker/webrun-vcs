/**
 * Drift alarm between the vcs `ListOptions` and the webrun one — as a **type test**.
 *
 * vcs deliberately declares its own `ListOptions` rather than re-exporting
 * webrun's, so the two can silently diverge: every `FilesApi` implementation in
 * this repo delegates to webrun, so a field webrun gains (or drops) is a field vcs
 * callers cannot express (or express in vain).
 *
 * **Why this is a `.test-d.ts` file and not an assertion inside the runtime
 * suite.** It used to be one — `const keysMatch: SameKeys<…> = true` — and it was
 * **vacuous**: vitest strips types without checking them, the package tsconfig is
 * `include: ["src"]`, and the one config that did cover `tests/` was referenced
 * nowhere. Proven: adding `depth?: number` to `ListOptions` left `vitest run` at
 * 5 passed and `tsc --noEmit` at exit 0.
 *
 * Two independent gates now observe it, and the failure modes are different
 * enough that neither subsumes the other:
 *
 *   pnpm test           vitest `--typecheck`, pointed at `tests/tsconfig.typecheck.json`.
 *                       Note the sharp edge: vitest runs tsc **only when it finds
 *                       at least one file matching `typecheck.include`** — i.e.
 *                       only because THIS file exists. Delete it and that gate
 *                       goes quietly back to reporting "Type Errors  no errors".
 *   pnpm run typecheck  `tsc --noEmit` over `src`, then over the same config.
 *                       Covers `tests/files/**` by directory, so it does not care
 *                       what this file is called.
 *
 * The comparison is over the KEY SETS, not mutual assignability. `A extends B` in
 * both directions stays green when either side gains an *optional* field — and
 * since `ListOptions` is all-optional, that is the only realistic drift, so an
 * assignability pair would never ring. A key-set comparison does.
 */

import type { ListOptions as WebrunListOptions } from "@statewalker/webrun-files";
import { describe, expectTypeOf, it } from "vitest";
import type { ListOptions } from "../../src/files/files-api.js";

describe("ListOptions conformance with @statewalker/webrun-files", () => {
  it("declares exactly the webrun ListOptions key set", () => {
    expectTypeOf<keyof ListOptions>().toEqualTypeOf<keyof WebrunListOptions>();
  });

  it("stays mutually assignable, so no call site needs migrating (contract invariant 5)", () => {
    // Weaker than the key-set check above and kept alongside it deliberately:
    // this is the property callers actually rely on, and it would survive a
    // rename of the alarm above.
    expectTypeOf<ListOptions>().toExtend<WebrunListOptions>();
    expectTypeOf<WebrunListOptions>().toExtend<ListOptions>();
  });
});
