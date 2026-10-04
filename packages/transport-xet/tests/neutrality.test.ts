import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Dep-lint: the xet agent is a THIN ADAPTER. Its source may import only from
 * itself (relative `./…`), `node:` builtins, and the three pieces it composes —
 * the content store, the chunk-transfer engine, the reused LFS transport — plus
 * the webrun HTTP/stream substrate it bridges over. Any git-object / vcs-core /
 * files-sync / working-tree import would leak a different domain into this skin.
 */
describe("neutrality (dep-lint)", () => {
  const srcDir = path.resolve(import.meta.dirname, "../src");
  const allowed = new Set([
    "@statewalker/webrun-content-store",
    "@statewalker/webrun-content-transfer",
    "@statewalker/vcs-transport-lfs",
    "@statewalker/webrun-http-streams",
    "@statewalker/webrun-streams",
  ]);
  const forbidden = ["vcs-core", "transport-git", "git-object", "files-sync", "working-tree"];

  function importsOf(file: string): string[] {
    const text = readFileSync(file, "utf8");
    const specs: string[] = [];
    const re = /(?:import|export)[^;]*?from\s*["']([^"']+)["']/g;
    for (let m = re.exec(text); m !== null; m = re.exec(text)) specs.push(m[1]);
    return specs;
  }

  it("src imports only relative paths, node builtins, and the composed packages", () => {
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
