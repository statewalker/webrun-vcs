import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Dep-lint: the LFS transport skin is an Axis-B skin over content-store + the
 * HTTP substrate. Its source may import only from itself (relative `./…`),
 * `node:` builtins (SHA-256 is the mandated LFS algorithm), the content-store,
 * and the HTTP substrate. Any git-object / vcs-core / files-sync / chunk-dedup
 * import would leak a different domain into this skin.
 */
describe("neutrality (dep-lint)", () => {
  const srcDir = path.resolve(import.meta.dirname, "../src");
  const allowed = new Set(["@statewalker/content-store", "@statewalker/webrun-http-streams"]);
  const forbidden = ["vcs-core", "transport-git", "transport-xet", "files-sync", "working-tree"];

  function importsOf(file: string): string[] {
    const text = readFileSync(file, "utf8");
    const specs: string[] = [];
    const re = /(?:import|export)[^;]*?from\s*["']([^"']+)["']/g;
    for (let m = re.exec(text); m !== null; m = re.exec(text)) specs.push(m[1]);
    return specs;
  }

  it("src imports only relative paths, node builtins, content-store and http-streams", () => {
    const files = readdirSync(srcDir).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      for (const spec of importsOf(path.join(srcDir, f))) {
        const ok = spec.startsWith(".") || spec.startsWith("node:") || allowed.has(spec);
        expect(ok, `${f} imports forbidden module "${spec}"`).toBe(true);
        for (const bad of forbidden) {
          expect(spec.includes(bad), `${f} imports domain module "${spec}"`).toBe(false);
        }
      }
    }
  });
});
