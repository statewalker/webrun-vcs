/**
 * LineInterner and InternedText: diffs through interned lines give the changes of plain
 * diffs (every algorithm, with and without whitespace flags, many versions sharing one
 * interner), and an InternedText reads only the lines before the tail a diff trims.
 */
import { describe, expect, it } from "vitest";
import {
  ByteLines,
  hashLine,
  LineHasher,
  LineInterner,
  whitespaceFlags,
  type XdiffAlgorithm,
  type XdiffOptions,
  xdiffHunks,
} from "../../../src/diff/text-diff/index.js";

const enc = new TextEncoder();

function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TOKENS = ["a", "b", "}", "", "  x", "\tx", "x ", " x", "foo  bar", "foo bar", "x\r"];

/** A random edit of `lines`: inserts, deletes, replaces, whitespace changes and moves */
function edit(r: () => number, lines: string[]): string[] {
  const out = [...lines];
  for (let k = 0, n = 1 + Math.floor(r() * 5); k < n; k++) {
    const at = Math.floor(r() * (out.length + 1));
    const op = Math.floor(r() * 5);
    const tok = r() < 0.3 ? `u${Math.floor(r() * 50)}` : TOKENS[Math.floor(r() * TOKENS.length)];
    if (op === 0) out.splice(at, 0, tok);
    else if (op === 1 && at < out.length) out.splice(at, 1 + Math.floor(r() * 3));
    else if (op === 2 && at < out.length) out[at] = tok;
    else if (op === 3 && at < out.length) out[at] = ` ${out[at]}  `;
    else if (out.length > 4) {
      const block = out.splice(Math.floor(r() * (out.length - 3)), 1 + Math.floor(r() * 3));
      out.splice(Math.floor(r() * (out.length + 1)), 0, ...block);
    }
  }
  return out;
}

const text = (lines: string[], eol: boolean) => {
  const s = lines.map((l) => `${l}\n`).join("");
  return enc.encode(eol || s.length === 0 ? s : s.slice(0, -1));
};

describe("LineInterner", () => {
  it("gives equal lines one id and different lines different ids", () => {
    const interner = new LineInterner();
    const a = new ByteLines(enc.encode("x\ny\nx\nz"));
    const b = new ByteLines(enc.encode("z\nx\n"));
    const ia = interner.ids(a);
    const ib = interner.ids(b);
    expect([...ia]).toEqual([0, 1, 0, 2]);
    // "z" without a newline and "z\n" differ, as xdiff compares lines
    expect([...ib]).toEqual([3, 0]);
    expect(interner.count).toBe(4);
    expect(interner.ids(a)).toBe(ia);
  });

  it("compares lines under its whitespace flags", () => {
    const interner = new LineInterner(whitespaceFlags({ ignoreWhitespace: true }));
    const ids = interner.ids(new ByteLines(enc.encode("a b\n ab \nab\nb a\n")));
    expect([...ids]).toEqual([0, 0, 0, 1]);
  });

  it("diffs through interned lines as plain diffs do", () => {
    const algorithms: XdiffAlgorithm[] = ["myers", "minimal", "patience", "histogram"];
    for (let seed = 1; seed <= 40; seed++) {
      const r = prng(seed);
      const options: XdiffOptions = {
        algorithm: algorithms[seed % 4],
        indentHeuristic: r() < 0.7,
        ignoreWhitespace: seed % 5 === 0,
        ignoreWhitespaceChange: seed % 7 === 0,
        histogramRediff: r() < 0.5,
      };
      const interner = new LineInterner(whitespaceFlags(options));
      // a chain of versions, each diffed with the next through one interner, as blame does
      let lines = Array.from(
        { length: 30 + Math.floor(r() * 300) },
        () => TOKENS[Math.floor(r() * TOKENS.length)],
      );
      let cur = text(lines, true);
      let curText = interner.text(cur);
      for (let v = 0; v < 12; v++) {
        lines = edit(r, lines);
        // a long common tail now and then, so that diffs trim it
        if (r() < 0.3) lines = [...lines, ...Array.from({ length: 200 }, (_, i) => `t${i}`)];
        const next = text(lines, r() < 0.9);
        const nextText = interner.text(next);
        const plain = xdiffHunks(next, cur, options);
        expect(xdiffHunks(nextText, curText, { ...options, interner })).toEqual(plain);
        // ByteLines interned through the same interner agree too
        expect(
          xdiffHunks(new ByteLines(next), new ByteLines(cur), { ...options, interner }),
        ).toEqual(plain);
        cur = next;
        curText = nextText;
      }
    }
  });

  it("reads only the lines before the tail a diff trims", () => {
    const interner = new LineInterner();
    const tail = Array.from({ length: 2000 }, (_, i) => `common tail line ${i}`);
    const a = interner.text(text(["a", "b", ...tail], true));
    const b = interner.text(text(["a", "c", ...tail], true));
    expect(xdiffHunks(a, b, { interner })).toEqual([{ i1: 1, chg1: 1, i2: 1, chg2: 1 }]);
    // trim_common_tail keeps up to 1 KiB of the tail: far fewer lines than the files hold
    expect(interner.count).toBeLessThan(200);
    expect(interner.count).toBeGreaterThan(3);
  });

  it("hashes lines as ByteLines does, so interned text diffs against plain content", () => {
    // an InternedText on one side and plain bytes or ByteLines on the other: equal lines must
    // hash alike whichever reads them, or they land in different classes
    for (let seed = 1; seed <= 30; seed++) {
      const r = prng(seed * 7919);
      let lines = Array.from(
        { length: 20 + Math.floor(r() * 200) },
        () => TOKENS[Math.floor(r() * TOKENS.length)],
      );
      const a = text(lines, true);
      lines = edit(r, lines);
      const b = text(lines, r() < 0.8);
      const plain = xdiffHunks(a, b);
      expect(xdiffHunks(new LineInterner().text(a), b)).toEqual(plain);
      expect(xdiffHunks(a, new LineInterner().text(b))).toEqual(plain);
      const interner = new LineInterner();
      expect(xdiffHunks(interner.text(a), new ByteLines(b), { interner })).toEqual(plain);
      const shared = new LineInterner();
      expect(xdiffHunks(new ByteLines(a), shared.text(b), { interner: shared })).toEqual(plain);
      expect(xdiffHunks(shared.text(a), b, { interner: shared })).toEqual(plain);
    }
  });

  it("finds and hashes lines in one pass as ByteLines hashes them", () => {
    for (let seed = 1; seed <= 50; seed++) {
      const r = prng(seed);
      // lines of every length around the four-byte words, LFs anywhere in a word
      const bytes = new Uint8Array(Math.floor(r() * 300));
      for (let i = 0; i < bytes.length; i++) bytes[i] = r() < 0.15 ? 0x0a : 0x20 + (i % 90);
      const lines = new ByteLines(bytes);
      const hasher = new LineHasher(bytes);
      let p = 0;
      for (let i = 0; i < lines.size(); i++) {
        expect(p).toBe(lines.start(i));
        const h = hasher.next(p);
        expect(hasher.end).toBe(lines.start(i + 1));
        expect(h).toBe(lines.hash(i));
        expect(h).toBe(hashLine(bytes, lines.start(i), lines.start(i + 1)));
        p = hasher.end;
      }
      expect(p).toBe(bytes.length);
    }
  });
});
