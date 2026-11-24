/**
 * GrepEngine without native git: time bounds of git's look-ahead, which searches the rest of
 * the buffer again after every matching line (as grep.c's `look_ahead` does).
 */
import { describe, expect, it } from "vitest";

import { GrepEngine, grepPattern } from "../src/index.js";

const encoder = new TextEncoder();

describe("GrepEngine look-ahead", () => {
  const lines = 20000;
  const content = encoder.encode("hello world foo bar baz qux\n".repeat(lines));

  for (const ignoreCase of [false, true]) {
    it(`matches every line of ${lines} lines in under a second (-i: ${ignoreCase})`, () => {
      const engine = new GrepEngine([grepPattern("fo[o]")], { ignoreCase, count: true });
      const start = performance.now();
      const hit = engine.grepSource({ name: encoder.encode("f"), content });
      const elapsed = performance.now() - start;
      expect(hit).toBe(true);
      expect(new TextDecoder().decode(engine.output())).toBe(`f:${lines}\n`);
      expect(elapsed).toBeLessThan(1000);
    });
  }
});
