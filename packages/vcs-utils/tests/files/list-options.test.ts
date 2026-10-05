import { describe, expect, it } from "vitest";
import type { FileInfo, ListOptions } from "../../src/files/files-api.js";
import { createInMemoryFilesApi } from "../../src/files/mem-files-api.js";

/**
 * `FilesApi.list()` accepts a `ListOptions` argument.
 *
 * NOTE ON WHAT IS UNDER TEST. The *runtime* half of this suite passes before the
 * widening: `createInMemoryFilesApi()` returns a webrun `MemFilesApi`, which has
 * always honoured `{ recursive: true }`. What is missing is the *declaration* —
 * the vcs `FilesApi` says `list(path: string)`, so every call below is a type
 * error (TS2554) that `pnpm umbrella build` cannot see — the package tsconfig is
 * `include: ["src"]`. The red for this suite is therefore a **tsc** error, not a
 * runtime one.
 *
 * It is observed by two independent gates, both of which point tsc at
 * `tests/tsconfig.typecheck.json` (the only config that covers `tests/files`):
 *
 *   pnpm test            -> vitest --typecheck, which reports it as a failed test
 *   pnpm run typecheck   -> `tsc --noEmit` over src, then over this config
 *
 * Before that wiring the assertion below was **vacuous**: vitest strips types
 * without checking them, and the scratch config was referenced nowhere in the
 * repository, so adding a field to `ListOptions` left `vitest run` at 5 passed
 * and `tsc --noEmit` at exit 0.
 */

async function paths(entries: AsyncIterable<FileInfo>): Promise<string[]> {
  const out: string[] = [];
  for await (const entry of entries) out.push(entry.path);
  return out.sort();
}

function tree() {
  return createInMemoryFilesApi({
    "/proj/README.md": "readme",
    "/proj/src/index.ts": "index",
    "/proj/src/deep/nested.ts": "nested",
  });
}

describe("FilesApi.list(path, options)", () => {
  it("lists only immediate children when no options are passed", async () => {
    const files = tree();

    expect(await paths(files.list("/proj"))).toEqual(["/proj/README.md", "/proj/src"]);
  });

  it("lists only immediate children when recursive is explicitly false", async () => {
    const files = tree();

    expect(await paths(files.list("/proj", { recursive: false }))).toEqual([
      "/proj/README.md",
      "/proj/src",
    ]);
  });

  it("lists all descendants when recursive is true", async () => {
    const files = tree();

    expect(await paths(files.list("/proj", { recursive: true }))).toEqual([
      "/proj/README.md",
      "/proj/src",
      "/proj/src/deep",
      "/proj/src/deep/nested.ts",
      "/proj/src/index.ts",
    ]);
  });

  it("accepts a ListOptions value built independently of the call site", async () => {
    const files = tree();
    const options: ListOptions = { recursive: true };

    expect(await paths(files.list("/proj/src", options))).toEqual([
      "/proj/src/deep",
      "/proj/src/deep/nested.ts",
      "/proj/src/index.ts",
    ]);
  });
});

// The drift alarm against webrun's `ListOptions` used to live here, as
// `const keysMatch: SameKeys<…> = true`, and was VACUOUS — vitest strips types
// without checking them. It now lives in `list-options.test-d.ts`, where vitest's
// `--typecheck` project and `pnpm run typecheck` both execute it.
