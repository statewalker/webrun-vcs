import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const src = join(import.meta.dirname, "../../src");
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });

describe("H5 portable", () => {
  it("src/ has no node: imports", () => {
    const all = files(src);
    expect(all.length).toBeGreaterThan(10);
    for (const f of all) expect(readFileSync(f, "utf8"), f).not.toMatch(/from "node:/);
  });

  it("the Hugging Face Xet modules import only each other and @noble/hashes", () => {
    for (const f of files(src).filter((p) => !p.includes("webrun-chunks"))) {
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(/(?:import|export)[^;]*?from\s*"([^"]+)"/g)) {
        const spec = m[1] as string;
        expect(spec.startsWith(".") || spec.startsWith("@noble/hashes/"), `${f}: ${spec}`).toBe(
          true,
        );
        expect(spec.includes("webrun-chunks"), `${f}: ${spec}`).toBe(false);
      }
    }
  });
});
