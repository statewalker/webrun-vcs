/**
 * The SHA-1 block function as a WebAssembly module, assembled here at load time (no binary
 * shipped): one function `blocks(p, n)` hashing the `n` 64-byte blocks at `p` into the five
 * state words at address 0, fully unrolled, the 16 schedule words in locals, `i32.rotl` for the
 * rotations. In V8 it runs about 1.5 times as fast as the JavaScript block function.
 *
 * Where WebAssembly cannot be compiled from bytes at run time (Cloudflare workerd, a page whose
 * CSP lacks `wasm-unsafe-eval`, an old browser refusing a synchronous compile on its main
 * thread), `sha1Wasm()` returns undefined and the JavaScript function is used.
 *
 * A second function, `dcblocks`, is the same block function with sha1dc's collision detection
 * (`sha1dc.ts`): the unavoidable bit conditions (`ubcCheck`, `sha1dc-tables.ts`) after the
 * rounds and, for a block meeting some DV's (about one in twenty on random data), the
 * recompressions, unrolled for the two steps they start from, with the DVs' message
 * differences in the module's memory.
 */
import {
  DISTURBANCE_VECTORS,
  UBC_CONDITIONS,
  UBC_FIRST_WORD,
  UBC_LAST_WORD,
} from "./sha1dc-tables.js";

/** The module's view: the state words, its memory, and the block functions. */
export interface Sha1Wasm {
  /** The five state words (address 0). */
  state: Int32Array;
  /** Where blocks are copied to be hashed, at most `capacity` bytes. */
  input: Uint8Array;
  capacity: number;
  /** Hashes the first `n` 64-byte blocks of `input` into `state`. */
  blocks(n: number): void;
  /**
   * Hashes the `n` blocks of `input` from block `first` into `state` with sha1dc's collision
   * detection: true when one of them is part of a collision attack (hashed all the same, as
   * git's sha1dc does).
   */
  dcBlocks(first: number, n: number): boolean;
}

/** Where the input starts in the module's memory (after the state and the collision flag). */
const INPUT_AT = 64;
/** Pages of 64 KiB the memory has: 1 MiB of input. */
const PAGES = 17;
/** The word `dcblocks` sets when a block is part of a collision attack. */
const COLLISION_AT = 24;
/** The recompressions' memory, at the end: the 32 DVs' message differences (80 words each). */
const DM_AT = PAGES * 65536 - 11264;
/** The flagged block's expanded words (80). */
const W_AT = DM_AT + 32 * 320;
/** The state before the block, before steps 58 and 65 (in that step's roles), after the block. */
const IN_AT = W_AT + 320;
const S58_AT = IN_AT + 20;
const S65_AT = IN_AT + 40;
const OUT_AT = IN_AT + 60;

let loaded: Sha1Wasm | null | undefined;

/** The WebAssembly block functions, compiled on first use; undefined where they cannot be. */
export function sha1Wasm(): Sha1Wasm | undefined {
  if (loaded === undefined) {
    try {
      const wasm = (globalThis as { WebAssembly?: typeof WebAssembly }).WebAssembly;
      if (!wasm) throw new Error("no WebAssembly");
      const instance = new wasm.Instance(new wasm.Module(moduleBytes()), {});
      const exports = instance.exports as {
        memory: WebAssembly.Memory;
        blocks: (p: number, n: number) => void;
        dcblocks: (p: number, n: number) => void;
      };
      const buffer = exports.memory.buffer;
      const dm = new Int32Array(buffer, DM_AT, 32 * 80);
      DISTURBANCE_VECTORS.forEach((dv, i) => {
        dm.set(dv.dm, i * 80);
      });
      const run = exports.blocks;
      const dc = exports.dcblocks;
      const words = new Int32Array(buffer, 0, 16);
      loaded = {
        state: words.subarray(0, 5),
        input: new Uint8Array(buffer, INPUT_AT, DM_AT - INPUT_AT),
        capacity: (DM_AT - INPUT_AT) & ~63,
        blocks: (n) => run(INPUT_AT, n),
        dcBlocks: (first, n) => {
          words[COLLISION_AT >> 2] = 0;
          dc(INPUT_AT + first * 64, n);
          return words[COLLISION_AT >> 2] !== 0;
        },
      };
    } catch {
      loaded = null;
    }
  }
  return loaded ?? undefined;
}

// opcodes
const LOCAL_GET = 0x20;
const LOCAL_SET = 0x21;
const I32_CONST = 0x41;
const I32_LOAD = 0x28;
const I32_STORE = 0x36;
const I32_EQZ = 0x45;
const I32_ADD = 0x6a;
const I32_SUB = 0x6b;
const I32_AND = 0x71;
const I32_OR = 0x72;
const I32_XOR = 0x73;
const I32_ROTL = 0x77;
const I32_ROTR = 0x78;
const I32_SHL = 0x74;
const I32_SHR_U = 0x76;
const IF = 0x04;
const RETURN = 0x0f;
const CALL = 0x10;
/** The binary operators of `UBC_CONDITIONS`' postfix expressions. */
const BINARY: Record<string, number> = {
  "^": I32_XOR,
  "&": I32_AND,
  "|": I32_OR,
  "-": I32_SUB,
  ">>": I32_SHR_U,
  "<<": I32_SHL,
};
const BLOCK = 0x02;
const LOOP = 0x03;
const BR = 0x0c;
const BR_IF = 0x0d;
const END = 0x0b;
const VOID = 0x40;
const I32 = 0x7f;

function uleb(n: number, out: number[]): void {
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
}

function sleb(n: number, out: number[]): void {
  n |= 0;
  for (;;) {
    const b = n & 0x7f;
    n >>= 7;
    if ((n === 0 && !(b & 0x40)) || (n === -1 && b & 0x40)) {
      out.push(b);
      return;
    }
    out.push(b | 0x80);
  }
}

/** One function's code being assembled: its locals' count and helpers emitting instructions. */
function assembler() {
  const code: number[] = [];
  const op = (...bytes: number[]) => code.push(...bytes);
  return {
    code,
    op,
    get: (l: number) => op(LOCAL_GET, l),
    set: (l: number) => op(LOCAL_SET, l),
    konst: (v: number) => {
      op(I32_CONST);
      sleb(v, code);
    },
    load: (offset: number) => {
      op(I32_LOAD, 2);
      uleb(offset, code);
    },
    store: (offset: number) => {
      op(I32_STORE, 2);
      uleb(offset, code);
    },
  };
}
type Assembler = ReturnType<typeof assembler>;

/** The round function of step `r` on locals `b`, `c`, `d` (its value left on the stack). */
function roundFunction(asm: Assembler, r: number, b: number, c: number, d: number): void {
  const { get, op } = asm;
  if (r < 20) {
    // d ^ (b & (c ^ d))
    get(d);
    get(b);
    get(c);
    get(d);
    op(I32_XOR, I32_AND, I32_XOR);
  } else if (r >= 40 && r < 60) {
    // (b & c) | (d & (b | c))
    get(b);
    get(c);
    op(I32_AND);
    get(d);
    get(b);
    get(c);
    op(I32_OR, I32_AND, I32_OR);
  } else {
    get(b);
    get(c);
    op(I32_XOR);
    get(d);
    op(I32_XOR);
  }
}

const roundConstant = (r: number) =>
  r < 20 ? 0x5a827999 : r < 40 ? 0x6ed9eba1 : r < 60 ? 0x8f1bbcdc : 0xca62c1d6;

/** A function's body: one run of i32 locals, then the code. */
function functionBody(locals: number, code: number[]): number[] {
  const body: number[] = [1];
  uleb(locals, body);
  body.push(I32, ...code, END);
  return body;
}

/** Function indexes. */
const DCCHECK = 2;
const RECOMPRESS_58 = 3;
const RECOMPRESS_65 = 4;

/**
 * `blocks(p, n)`, or with `dc` `dcblocks(p, n)`: the same block function also keeping the
 * expanded words the unavoidable bit conditions read and the states before steps 58 and 65,
 * checking the conditions after the rounds and calling `dccheck` for a block meeting some.
 */
function blocksCode(dc: boolean): number[] {
  // locals: p, n (params), a b c d e, h0..h4, x, w0..w15; dc: mask, the kept words, the states
  const P = 0;
  const N = 1;
  const V = [2, 3, 4, 5, 6];
  const H = [7, 8, 9, 10, 11];
  const X = 12;
  const W = (i: number) => 13 + i;
  const MASK = 29;
  const KEPT = (t: number) => 30 + t - UBC_FIRST_WORD;
  const S58 = 30 + UBC_LAST_WORD - UBC_FIRST_WORD + 1;
  const S65 = S58 + 5;
  const locals = dc ? S65 + 5 - 2 : 27;
  const asm = assembler();
  const { op, get, set, konst, load, store } = asm;

  for (let k = 0; k < 5; k++) {
    konst(0);
    load(4 * k);
    set(H[k] as number);
  }
  op(BLOCK, VOID, LOOP, VOID);
  get(N);
  op(I32_EQZ, BR_IF, 1);
  for (let k = 0; k < 5; k++) {
    get(H[k] as number);
    set(V[k] as number);
  }
  // the 16 words of the block, big-endian
  for (let i = 0; i < 16; i++) {
    get(P);
    load(4 * i);
    set(X);
    get(X);
    konst(8);
    op(I32_ROTL);
    konst(0x00ff00ff);
    op(I32_AND);
    get(X);
    konst(8);
    op(I32_ROTR);
    konst(0xff00ff00);
    op(I32_AND, I32_OR);
    set(W(i));
  }
  // 80 rounds; the working variables change roles instead of moving
  let [a, b, c, d, e] = V as [number, number, number, number, number];
  for (let r = 0; r < 80; r++) {
    const k = r & 15;
    if (dc && (r === 58 || r === 65)) {
      const saved = r === 58 ? S58 : S65;
      [a, b, c, d, e].forEach((v, i) => {
        get(v);
        set(saved + i);
      });
    }
    if (r >= 16) {
      get(W((r + 13) & 15));
      get(W((r + 8) & 15));
      op(I32_XOR);
      get(W((r + 2) & 15));
      op(I32_XOR);
      get(W(k));
      op(I32_XOR);
      konst(1);
      op(I32_ROTL);
      set(W(k));
    }
    if (dc && r >= UBC_FIRST_WORD && r <= UBC_LAST_WORD) {
      get(W(k));
      set(KEPT(r));
    }
    // e = rotl(a, 5) + f(b, c, d) + e + K + w
    get(a);
    konst(5);
    op(I32_ROTL);
    roundFunction(asm, r, b, c, d);
    op(I32_ADD);
    get(e);
    konst(roundConstant(r));
    op(I32_ADD, I32_ADD);
    get(W(k));
    op(I32_ADD);
    set(e);
    // b = rotl(b, 30)
    get(b);
    konst(30);
    op(I32_ROTL);
    set(b);
    [a, b, c, d, e] = [e, a, b, c, d];
  }
  const last = [a, b, c, d, e];
  if (dc) {
    // mask = ubcCheck(kept words), branch-free: guards and early exits cost more here than
    // the checks they skip
    konst(-1);
    set(MASK);
    for (const condition of UBC_CONDITIONS) {
      get(MASK);
      for (const token of condition.expr.split(" ")) {
        if (token.startsWith("w")) get(KEPT(Number(token.slice(1))));
        else if (/^\d+$/.test(token)) konst(Number(token));
        else if (token === "~") {
          konst(-1);
          op(I32_XOR);
        } else if (token === "!") op(I32_EQZ);
        else op(BINARY[token] as number);
      }
      konst(~condition.dv);
      op(I32_OR, I32_AND);
      set(MASK);
    }
    // a flagged block: its states to memory, then the recompressions
    get(MASK);
    op(IF, VOID);
    for (let k = 0; k < 5; k++) {
      konst(0);
      get(H[k] as number);
      store(IN_AT + 4 * k);
      konst(0);
      get(S58 + k);
      store(S58_AT + 4 * k);
      konst(0);
      get(S65 + k);
      store(S65_AT + 4 * k);
      konst(0);
      get(H[k] as number);
      get(last[k] as number);
      op(I32_ADD);
      store(OUT_AT + 4 * k);
    }
    konst(0);
    konst(0);
    load(COLLISION_AT);
    get(P);
    get(MASK);
    op(CALL, DCCHECK);
    op(I32_OR);
    store(COLLISION_AT);
    op(END);
  }
  for (let k = 0; k < 5; k++) {
    get(H[k] as number);
    get(last[k] as number);
    op(I32_ADD);
    set(H[k] as number);
  }
  get(P);
  konst(64);
  op(I32_ADD);
  set(P);
  get(N);
  konst(1);
  op(I32_SUB);
  set(N);
  op(BR, 0, END, END);
  for (let k = 0; k < 5; k++) {
    konst(0);
    get(H[k] as number);
    store(4 * k);
  }
  return functionBody(locals, asm.code);
}

/**
 * `dccheck(p, mask)`: expands the block at `p` into memory and runs the recompression of each
 * DV of `mask` (DV i is bit i); 1 when one reaches the block's output.
 */
function dccheckCode(): number[] {
  const P = 0;
  const MASK = 1;
  const X = 2;
  const asm = assembler();
  const { op, get, set, konst, load, store } = asm;
  for (let i = 0; i < 80; i++) {
    konst(0);
    if (i < 16) {
      get(P);
      load(4 * i);
      set(X);
      get(X);
      konst(8);
      op(I32_ROTL);
      konst(0x00ff00ff);
      op(I32_AND);
      get(X);
      konst(8);
      op(I32_ROTR);
      konst(0xff00ff00);
      op(I32_AND, I32_OR);
    } else {
      for (const back of [3, 8, 14, 16]) {
        konst(0);
        load(W_AT + 4 * (i - back));
        if (back !== 3) op(I32_XOR);
      }
      konst(1);
      op(I32_ROTL);
    }
    store(W_AT + 4 * i);
  }
  DISTURBANCE_VECTORS.forEach((dv, i) => {
    get(MASK);
    konst(1 << i);
    op(I32_AND, IF, VOID);
    konst(DM_AT + i * 320);
    op(CALL, dv.testt === 58 ? RECOMPRESS_58 : RECOMPRESS_65, IF, VOID);
    konst(1);
    op(RETURN, END, END);
  });
  konst(0);
  return functionBody(1, asm.code);
}

/**
 * `recompress58(dm)` / `recompress65(dm)`: sha1dc's `sha1_recompression_step` for a DV whose
 * message difference is at `dm`, unrolled: from the state before step `t`, back through the
 * other block (the expanded words XOR the difference) to its input, then forward to its output;
 * 1 when that output is the block's own (`OUT_AT`).
 */
function recompressCode(t: 58 | 65): number[] {
  const DM = 0;
  const V = [1, 2, 3, 4, 5];
  const IN = [6, 7, 8, 9, 10];
  const asm = assembler();
  const { op, get, set, konst, load } = asm;
  const state = t === 58 ? S58_AT : S65_AT;
  const other = (i: number) => {
    konst(0);
    load(W_AT + 4 * i);
    get(DM);
    load(4 * i);
    op(I32_XOR);
  };
  const loadState = () => {
    for (let k = 0; k < 5; k++) {
      konst(0);
      load(state + 4 * k);
      set(V[k] as number);
    }
  };
  loadState();
  // backward: from the roles after step i, (A, B, C, D, E), the state before it is
  // (B, rotr(C, 30), D, E, A - (rotl(B, 5) + f(rotr(C, 30), D, E) + K + w))
  let [a, b, c, d, e] = V as [number, number, number, number, number];
  for (let i = t - 1; i >= 0; i--) {
    get(c);
    konst(30);
    op(I32_ROTR);
    set(c);
    get(a);
    get(b);
    konst(5);
    op(I32_ROTL);
    roundFunction(asm, i, c, d, e);
    op(I32_ADD);
    konst(roundConstant(i));
    op(I32_ADD);
    other(i);
    op(I32_ADD, I32_SUB);
    set(a);
    [a, b, c, d, e] = [b, c, d, e, a];
  }
  [a, b, c, d, e].forEach((v, k) => {
    get(v);
    set(IN[k] as number);
  });
  loadState();
  [a, b, c, d, e] = V as [number, number, number, number, number];
  for (let i = t; i < 80; i++) {
    get(a);
    konst(5);
    op(I32_ROTL);
    roundFunction(asm, i, b, c, d);
    op(I32_ADD);
    get(e);
    konst(roundConstant(i));
    op(I32_ADD, I32_ADD);
    other(i);
    op(I32_ADD);
    set(e);
    get(b);
    konst(30);
    op(I32_ROTL);
    set(b);
    [a, b, c, d, e] = [e, a, b, c, d];
  }
  // all five words equal: the OR of the differences is 0
  [a, b, c, d, e].forEach((v, k) => {
    get(IN[k] as number);
    get(v);
    op(I32_ADD);
    konst(0);
    load(OUT_AT + 4 * k);
    op(I32_XOR);
    if (k > 0) op(I32_OR);
  });
  op(I32_EQZ);
  return functionBody(10, asm.code);
}

/** The module's bytes. */
function moduleBytes(): Uint8Array<ArrayBuffer> {
  const bodies = [
    blocksCode(false),
    blocksCode(true),
    dccheckCode(),
    recompressCode(58),
    recompressCode(65),
  ];
  const codeSection: number[] = [];
  uleb(bodies.length, codeSection);
  for (const body of bodies) {
    uleb(body.length, codeSection);
    codeSection.push(...body);
  }

  const out: number[] = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  const section = (id: number, content: number[]) => {
    out.push(id);
    uleb(content.length, out);
    out.push(...content);
  };
  // types: (i32, i32) -> (), (i32, i32) -> i32, (i32) -> i32
  section(1, [3, 0x60, 2, I32, I32, 0, 0x60, 2, I32, I32, 1, I32, 0x60, 1, I32, 1, I32]);
  section(3, [5, 0, 0, 1, 2, 2]); // blocks, dcblocks, dccheck, recompress58, recompress65
  const memory = [1, 0];
  uleb(PAGES, memory);
  section(5, memory); // memory: PAGES pages, no maximum
  const name = (s: string) => [s.length, ...Array.from(s, (ch) => ch.charCodeAt(0))];
  section(7, [3, ...name("memory"), 2, 0, ...name("blocks"), 0, 0, ...name("dcblocks"), 0, 1]);
  section(10, codeSection);
  return new Uint8Array(out);
}
