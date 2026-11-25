#!/usr/bin/env node
// Generates vcs-utils' SHA-1 collision detection tables and block function from sha1dc's
// generated sources (git's `sha1dc/ubc_check.c`, Marc Stevens and Dan Shumow, MIT licence):
//
//   node scripts/generate-sha1dc.mjs <git source>/sha1dc
//
// writes packages/vcs-utils/src/hash/hasher/sha1dc-tables.ts (the 32 disturbance vectors, the
// unavoidable bit conditions as data for the WebAssembly builder, and a generic `ubcCheck`) and
// packages/vcs-utils/src/hash/hasher/sha1dc-blocks.ts (the unrolled JavaScript block function
// with the check inlined). Run it again only when sha1dc's tables change; the output is checked in.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "packages/vcs-utils/src/hash/hasher");
const dir = process.argv[2];
if (!dir) {
  console.error("usage: node scripts/generate-sha1dc.mjs <git source>/sha1dc");
  process.exit(2);
}
const source = readFileSync(join(dir, "ubc_check.c"), "utf8");

// --- the DV bits
const bits = new Map();
for (const m of source.matchAll(
  /static const uint32_t (DV_\w+_bit)\s*=\s*\(uint32_t\)\(1\) << (\d+);/g,
))
  bits.set(m[1], Number(m[2]));
const bitsOf = (text) =>
  text.split("|").reduce((acc, name) => {
    const bit = bits.get(name.trim());
    if (bit === undefined) throw new Error(`unknown DV bit ${name}`);
    return (acc | (1 << bit)) >>> 0;
  }, 0);

// --- the DVs
const dvs = [];
for (const m of source.matchAll(/\{(\d+),(\d+),(\d+),(\d+),(\d+),(\d+), \{ ([^}]*) \} \}/g)) {
  const [type, k, b, testt, maski, maskb] = m.slice(1, 7).map(Number);
  if (type === 0) continue;
  const dm = m[7].split(",").map((s) => Number(s.trim()) >>> 0);
  if (dm.length !== 80 || maski !== 0) throw new Error("unexpected DV row");
  dvs.push({ type, k, b, testt, maskb, dm });
}
if (dvs.length !== 32) throw new Error(`expected 32 DVs, found ${dvs.length}`);
// the block functions take DV i's bit to be bit i
dvs.forEach((d, i) => {
  if (d.maskb !== i) throw new Error(`DV ${i} has mask bit ${d.maskb}`);
});

// --- the conditions: `[if (mask & (BITS))] mask &= (EXPR | ~(BITS));` and, in the final
// `if (mask) { ... }` section, `if (mask & BIT) if (COND) mask &= ~BIT;` (turned into the
// first form as `mask &= ((COND) - 1) | ~BIT`, COND being 0 or 1)
const from =
  source.indexOf("uint32_t mask = ~((uint32_t)(0));") + "uint32_t mask = ~((uint32_t)(0));".length;
const to = source.indexOf("dvmask[0]=mask;");
if (from < 40 || to < 0) throw new Error("ubc_check's body not found");
const text = source
  .slice(from, to)
  .replace(/\s+/g, " ")
  .replace("if (mask) {", "")
  .replace(/\}\s*$/, "")
  .trim();
const conditions = [];
let at = 0;
const skipSpace = () => {
  while (text[at] === " ") at++;
};
/** The text inside the parenthesis at `at` (which is `(`), leaving `at` after its `)`. */
const group = () => {
  if (text[at] !== "(") throw new Error(`expected ( at ${text.slice(at, at + 40)}`);
  let depth = 0;
  const start = at;
  for (; at < text.length; at++) {
    if (text[at] === "(") depth++;
    else if (text[at] === ")" && --depth === 0) {
      at++;
      return text.slice(start + 1, at - 1);
    }
  }
  throw new Error("unbalanced");
};
const expect = (s) => {
  skipSpace();
  if (!text.startsWith(s, at)) throw new Error(`expected ${s} at ${text.slice(at, at + 40)}`);
  at += s.length;
};
/** `~(A|B)` or `~A` */
const maskBits = (s) => {
  const t = s.trim();
  if (!t.startsWith("~")) throw new Error(`expected ~bits in ${t}`);
  const inner = t.slice(1).trim();
  return bitsOf(inner.startsWith("(") ? inner.slice(1, -1) : inner);
};
while (true) {
  skipSpace();
  if (at >= text.length) break;
  let guard = 0;
  if (text.startsWith("if (mask & ", at)) {
    at += "if (mask & ".length;
    skipSpace();
    if (text[at] === "(") guard = bitsOf(group());
    else {
      const m = /^DV_\w+_bit/.exec(text.slice(at));
      guard = bitsOf(m[0]);
      at += m[0].length;
    }
    expect(")");
    skipSpace();
  }
  if (text.startsWith("if (", at)) {
    at += 3;
    skipSpace();
    const cond = parse(group());
    expect("mask &= ~");
    const m = /^DV_\w+_bit/.exec(text.slice(at));
    const dv = bitsOf(m[0]);
    at += m[0].length;
    expect(";");
    if (guard !== dv) throw new Error("a kill without its own guard");
    conditions.push({ guarded: true, dv, expr: { op: "-", l: cond, r: { n: 1 } } });
    continue;
  }
  expect("mask &= ");
  skipSpace();
  const whole = group();
  expect(";");
  // EXPR | ~BITS: split at the last top-level `|`
  let depth = 0;
  let split = -1;
  for (let i = 0; i < whole.length; i++) {
    if (whole[i] === "(") depth++;
    else if (whole[i] === ")") depth--;
    else if (whole[i] === "|" && whole[i + 1] !== "|" && whole[i - 1] !== "|" && depth === 0)
      split = i;
  }
  if (split < 0) throw new Error(`no | ~bits in ${whole}`);
  const dv = maskBits(whole.slice(split + 1));
  if (guard && guard !== dv) throw new Error(`guard differs from the condition's DVs: ${whole}`);
  conditions.push({ guarded: guard !== 0, dv, expr: parse(whole.slice(0, split)) });
}

/**
 * C expression → AST: { w } | { n } | { op, l, r } | { un, e }; C precedences, `!` and `~`
 * prefix, `||` of 0/1 values (no side effects, so no short circuit is needed).
 */
function parse(src) {
  const tokens = src.match(/W\[\d+\]|\d+|>>|<<|\|\||[()^&|\-~!]/g);
  let i = 0;
  const PREC = { "||": 1, "|": 2, "^": 3, "&": 4, "<<": 5, ">>": 5, "-": 6 };
  const primary = () => {
    const t = tokens[i++];
    if (t === "(") {
      const e = binary(0);
      if (tokens[i++] !== ")") throw new Error(`unbalanced: ${src}`);
      return e;
    }
    if (t === "!" || t === "~") return { un: t, e: primary() };
    if (t.startsWith("W[")) return { w: Number(t.slice(2, -1)) };
    if (/^\d+$/.test(t)) return { n: Number(t) };
    throw new Error(`unexpected token ${t} in ${src}`);
  };
  const binary = (min) => {
    let l = primary();
    for (;;) {
      const op = tokens[i];
      const p = PREC[op];
      if (p === undefined || p <= min) return l;
      i++;
      l = { op, l, r: binary(p) };
    }
  };
  const e = binary(0);
  if (i !== tokens.length) throw new Error(`trailing tokens in ${src}`);
  return e;
}

const js = (e, word) => {
  if ("w" in e) return word(e.w);
  if ("n" in e) return String(e.n);
  if ("un" in e) {
    if (e.un === "~") return `~${js(e.e, word)}`;
    if ("un" in e.e && e.e.un === "!") return `(${js(e.e.e, word)} !== 0 ? 1 : 0)`;
    return `(${js(e.e, word)} === 0 ? 1 : 0)`;
  }
  const op = e.op === ">>" ? ">>>" : e.op === "||" ? "|" : e.op;
  return `(${js(e.l, word)} ${op} ${js(e.r, word)})`;
};
const rpn = (e) => {
  if ("w" in e) return `w${e.w}`;
  if ("n" in e) return String(e.n);
  if ("un" in e) return `${rpn(e.e)} ${e.un}`;
  return `${rpn(e.l)} ${rpn(e.r)} ${e.op === "||" ? "|" : e.op}`;
};
const hex = (n) => `0x${(n >>> 0).toString(16).padStart(8, "0")}`;
const words = new Set();
const collect = (e) => {
  if ("w" in e) words.add(e.w);
  else if ("un" in e) collect(e.e);
  else if ("op" in e) {
    collect(e.l);
    collect(e.r);
  }
};
for (const c of conditions) collect(c.expr);
const first = Math.min(...words);
const last = Math.max(...words);

const HEADER = `// Generated by scripts/generate-sha1dc.mjs from sha1dc's ubc_check.c (git's sha1dc/,
// Copyright 2017 Marc Stevens <marc@marc-stevens.nl>, Dan Shumow <danshu@microsoft.com>, MIT
// licence: https://opensource.org/licenses/MIT). Do not edit by hand.
`;

// The order of the checks does not change the mask (each only clears bits, a guard only skips a
// check that could clear nothing), so they run in the order that empties the mask soonest on
// random blocks (about 4% of blocks keep a DV): greedily, the check that empties the most masks
// (then clears the most bits) among those not yet empty. The JavaScript block function exits
// early every few checks once the mask is empty; the WebAssembly one runs them all branch-free,
// which is faster there.
const EXIT_EVERY = 4;
const ordered = orderByKillRate(conditions);

function orderByKillRate(list) {
  let seed = 0x5eed;
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) | 0;
  };
  const N = 20000;
  const blocks = [];
  for (let n = 0; n < N; n++) {
    const W = new Int32Array(80);
    for (let i = 0; i < 16; i++) W[i] = random();
    for (let i = 16; i < 80; i++) {
      const x = W[i - 3] ^ W[i - 8] ^ W[i - 14] ^ W[i - 16];
      W[i] = (x << 1) | (x >>> 31);
    }
    blocks.push(W);
  }
  const evaluate = (e, W) => {
    if ("w" in e) return W[e.w];
    if ("n" in e) return e.n;
    if ("un" in e) return e.un === "~" ? ~evaluate(e.e, W) : evaluate(e.e, W) === 0 ? 1 : 0;
    const l = evaluate(e.l, W);
    const r = evaluate(e.r, W);
    switch (e.op) {
      case "^":
        return l ^ r;
      case "&":
        return l & r;
      case "|":
      case "||":
        return l | r;
      case "-":
        return (l - r) | 0;
      case ">>":
        return l >>> r;
      case "<<":
        return l << r;
    }
    throw new Error(e.op);
  };
  // the DV bits each check clears on each block
  const clears = list.map((c) => blocks.map((W) => ~(evaluate(c.expr, W) | ~c.dv) & c.dv));
  const popcount = (x) => {
    let n = 0;
    for (; x; x &= x - 1) n++;
    return n;
  };
  const masks = new Int32Array(N).fill(-1);
  const left = new Set(list.keys());
  const order = [];
  while (left.size) {
    let best = -1;
    let bestScore = -1;
    for (const i of left) {
      let score = 0;
      for (let n = 0; n < N; n++) {
        const cleared = masks[n] & clears[i][n];
        if (cleared) score += (masks[n] & ~cleared) === 0 ? 30 : popcount(cleared);
      }
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    order.push(list[best]);
    left.delete(best);
    for (let n = 0; n < N; n++) masks[n] &= ~clears[best][n];
  }
  return order;
}

function ubcStatements(word, indent, exitLabel) {
  const out = [];
  ordered.forEach((c, index) => {
    const stmt = `mask &= ${js(c.expr, word)} | ${hex(~c.dv)};`;
    if (c.guarded) out.push(`${indent}if (mask & ${hex(c.dv)}) ${stmt}`);
    else out.push(`${indent}${stmt}`);
    if ((index + 1) % EXIT_EVERY === 0 && index + 1 < ordered.length)
      out.push(`${indent}if (mask === 0) break ${exitLabel};`);
  });
  return out;
}

const tables = `${HEADER}
/** One disturbance vector: sha1dc's \`dv_info_t\` (\`maski\` is always 0). */
export interface DisturbanceVector {
  /** 1 for I(K,B), 2 for II(K,B) */
  readonly type: 1 | 2;
  readonly k: number;
  readonly b: number;
  /** The step the recompression starts from (58 or 65) */
  readonly testt: 58 | 65;
  /** The DV's bit in \`ubcCheck\`'s mask */
  readonly maskb: number;
  /** The expanded message block's XOR difference, 80 words */
  readonly dm: Int32Array;
}

const dv = (type: 1 | 2, k: number, b: number, testt: 58 | 65, maskb: number, dm: string): DisturbanceVector => {
  const words = new Int32Array(80);
  for (let i = 0; i < 80; i++) words[i] = Number.parseInt(dm.slice(i * 8, i * 8 + 8), 16) | 0;
  return Object.freeze({ type, k, b, testt, maskb, dm: words });
};

/** sha1dc's \`sha1_dvs\`, in its order. */
export const DISTURBANCE_VECTORS: readonly DisturbanceVector[] = [
${dvs.map((d) => `  dv(${d.type}, ${d.k}, ${d.b}, ${d.testt}, ${d.maskb}, "${d.dm.map((w) => w.toString(16).padStart(8, "0")).join("")}"),`).join("\n")}
];

/** The first and last expanded words the unavoidable bit conditions read. */
export const UBC_FIRST_WORD = ${first};
export const UBC_LAST_WORD = ${last};

/**
 * The unavoidable bit conditions as data, for the WebAssembly builder: \`mask &= expr | ~dv\`,
 * skipped when \`guarded\` and \`mask & dv\` is 0; \`expr\` in postfix (\`w<n>\` an expanded word,
 * numbers, \`^ & | - >> <<\` on 32-bit words, \`>>\` logical, prefix \`~\`, and \`!\`
 * giving 0 or 1). In the order that empties the mask soonest.
 */
export const UBC_CONDITIONS: readonly { guarded: boolean; dv: number; expr: string }[] = [
${ordered.map((c) => `  { guarded: ${c.guarded}, dv: ${hex(c.dv)}, expr: "${rpn(c.expr)}" },`).join("\n")}
];

/**
 * sha1dc's \`ubc_check\`: the DVs whose unavoidable bit conditions the expanded block \`W\` (80
 * words) meets, one bit per DV (\`maskb\`). Only those need the recompression check.
 */
export function ubcCheck(W: ArrayLike<number>): number {
  let mask = -1;
  // biome-ignore lint/suspicious/noConfusingLabels: the early exit of a generated check
  check: {
${ubcStatements((n) => `(W[${n}] as number)`, "    ", "check").join("\n")}
  }
  return mask;
}
`;
writeFileSync(join(OUT, "sha1dc-tables.ts"), tables);

// --- the JavaScript block function with the check inlined
const L = [];
const emit = (s) => L.push(s);
emit(HEADER);
emit(`import { DC_STATE, dcCheck } from "./sha1dc.js";`);
emit(``);
emit(`/**`);
emit(
  ` * The SHA-1 block function with sha1dc's collision detection: hashes the 64-byte blocks of \`p\``,
);
emit(` * from \`at\` to \`end\` into \`s\`, checking each against the unavoidable bit conditions`);
emit(
  ` * (\`ubcCheck\`, inlined on expanded words ${first} to ${last} kept in locals). A block meeting some`,
);
emit(
  ` * goes to \`dcCheck\` with its input, output and the states before steps 58 and 65. True when a`,
);
emit(` * block is part of a collision attack; it is hashed all the same, as git's sha1dc does.`);
emit(` */`);
emit(`export function dcBlocks(s: Int32Array, p: Uint8Array, at: number, end: number): boolean {`);
emit(`  let found = false;`);
emit(`  let h0 = s[0] as number;`);
emit(`  let h1 = s[1] as number;`);
emit(`  let h2 = s[2] as number;`);
emit(`  let h3 = s[3] as number;`);
emit(`  let h4 = s[4] as number;`);
emit(`  for (; at < end; at += 64) {`);
emit(`    let a = h0;`);
emit(`    let b = h1;`);
emit(`    let c = h2;`);
emit(`    let d = h3;`);
emit(`    let e = h4;`);
for (let i = 0; i < 16; i++) {
  emit(`    let w${i} =`);
  emit(`      ((p[at + ${4 * i}] as number) << 24) |`);
  emit(`      ((p[at + ${4 * i + 1}] as number) << 16) |`);
  emit(`      ((p[at + ${4 * i + 2}] as number) << 8) |`);
  emit(`      (p[at + ${4 * i + 3}] as number);`);
}
let v = ["a", "b", "c", "d", "e"];
const saved = {};
for (let r = 0; r < 80; r++) {
  const k = r & 15;
  if (r === 58 || r === 65) {
    saved[r] = v.map((_name, i) => `s${r}${"abcde"[i]}`);
    v.forEach((name, i) => {
      emit(`    const s${r}${"abcde"[i]} = ${name};`);
    });
  }
  if (r >= 16) {
    emit(`    w${k} = w${(r + 13) & 15} ^ w${(r + 8) & 15} ^ w${(r + 2) & 15} ^ w${k};`);
    emit(`    w${k} = (w${k} << 1) | (w${k} >>> 31);`);
  }
  if (words.has(r)) emit(`    const x${r} = w${k};`);
  const [A, B, C, D, E] = v;
  const f =
    r < 20
      ? `(${D} ^ (${B} & (${C} ^ ${D})))`
      : r >= 40 && r < 60
        ? `((${B} & ${C}) | (${D} & (${B} | ${C})))`
        : `(${B} ^ ${C} ^ ${D})`;
  const K = r < 20 ? "0x5a827999" : r < 40 ? "0x6ed9eba1" : r < 60 ? "0x8f1bbcdc" : "0xca62c1d6";
  emit(`    ${E} = (((${A} << 5) | (${A} >>> 27)) + ${f} + ${E} + ${K} + w${k}) | 0;`);
  emit(`    ${B} = (${B} << 30) | (${B} >>> 2);`);
  v = [E, A, B, C, D];
}
emit(`    let mask = -1;`);
emit(`    // biome-ignore lint/suspicious/noConfusingLabels: the early exit of a generated check`);
emit(`    check: {`);
for (const st of ubcStatements((n) => `x${n}`, "      ", "check")) emit(st);
emit(`    }`);
emit(`    if (mask !== 0) {`);
["h0", "h1", "h2", "h3", "h4"].forEach((h, i) => {
  emit(`      DC_STATE[${i}] = ${h};`);
});
saved[58].forEach((name, i) => {
  emit(`      DC_STATE[${5 + i}] = ${name};`);
});
saved[65].forEach((name, i) => {
  emit(`      DC_STATE[${10 + i}] = ${name};`);
});
v.forEach((name, i) => {
  emit(`      DC_STATE[${15 + i}] = (h${i} + ${name}) | 0;`);
});
emit(`      if (dcCheck(p, at, mask)) found = true;`);
emit(`    }`);
v.forEach((name, i) => {
  emit(`    h${i} = (h${i} + ${name}) | 0;`);
});
emit(`  }`);
emit(`  s[0] = h0;`);
emit(`  s[1] = h1;`);
emit(`  s[2] = h2;`);
emit(`  s[3] = h3;`);
emit(`  s[4] = h4;`);
emit(`  return found;`);
emit(`}`);
writeFileSync(join(OUT, "sha1dc-blocks.ts"), `${L.join("\n")}\n`);
// the repository's formatting, so a regeneration changes only what changed
execFileSync(
  "npx",
  ["biome", "format", "--write", join(OUT, "sha1dc-tables.ts"), join(OUT, "sha1dc-blocks.ts")],
  {
    cwd: ROOT,
    stdio: "ignore",
  },
);
console.log(`${dvs.length} DVs, ${conditions.length} conditions, words ${first}..${last}`);
