/**
 * The SHA-1 block function as a WebAssembly module, assembled here at load time (no binary
 * shipped): one function `blocks(p, n)` hashing the `n` 64-byte blocks at `p` into the five
 * state words at address 0, fully unrolled, the 16 schedule words in locals, `i32.rotl` for the
 * rotations. In V8 it runs about 1.5 times as fast as the JavaScript block function.
 *
 * Where WebAssembly cannot be compiled from bytes at run time (Cloudflare workerd, a page whose
 * CSP lacks `wasm-unsafe-eval`, an old browser refusing a synchronous compile on its main
 * thread), `sha1Wasm()` returns undefined and the JavaScript function is used.
 */

/** The module's view: the state words, its memory, and the block function. */
export interface Sha1Wasm {
  /** The five state words (address 0). */
  state: Int32Array;
  /** Where blocks are copied to be hashed, at most `capacity` bytes. */
  input: Uint8Array;
  capacity: number;
  /** Hashes the first `n` 64-byte blocks of `input` into `state`. */
  blocks(n: number): void;
}

/** Where the input starts in the module's memory (after the state). */
const INPUT_AT = 64;
/** Pages of 64 KiB the memory has: 1 MiB of input. */
const PAGES = 17;

let loaded: Sha1Wasm | null | undefined;

/** The WebAssembly block function, compiled on first use; undefined where it cannot be. */
export function sha1Wasm(): Sha1Wasm | undefined {
  if (loaded === undefined) {
    try {
      const wasm = (globalThis as { WebAssembly?: typeof WebAssembly }).WebAssembly;
      if (!wasm) throw new Error("no WebAssembly");
      const instance = new wasm.Instance(new wasm.Module(moduleBytes()), {});
      const exports = instance.exports as {
        memory: WebAssembly.Memory;
        blocks: (p: number, n: number) => void;
      };
      const buffer = exports.memory.buffer;
      const run = exports.blocks;
      loaded = {
        state: new Int32Array(buffer, 0, 5),
        input: new Uint8Array(buffer, INPUT_AT, PAGES * 65536 - INPUT_AT),
        capacity: (PAGES * 65536 - INPUT_AT) & ~63,
        blocks: (n) => run(INPUT_AT, n),
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

/** The module's bytes. */
function moduleBytes(): Uint8Array<ArrayBuffer> {
  // locals: p, n (params), a b c d e, h0..h4, x, w0..w15
  const P = 0;
  const N = 1;
  const V = [2, 3, 4, 5, 6];
  const H = [7, 8, 9, 10, 11];
  const X = 12;
  const W = (i: number) => 13 + i;
  const code: number[] = [];
  const op = (...bytes: number[]) => code.push(...bytes);
  const get = (l: number) => op(LOCAL_GET, l);
  const set = (l: number) => op(LOCAL_SET, l);
  const konst = (v: number) => {
    op(I32_CONST);
    sleb(v, code);
  };
  const load = (offset: number) => {
    op(I32_LOAD, 2);
    uleb(offset, code);
  };
  const store = (offset: number) => {
    op(I32_STORE, 2);
    uleb(offset, code);
  };

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
    // e = rotl(a, 5) + f(b, c, d) + e + K + w
    get(a);
    konst(5);
    op(I32_ROTL);
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
    op(I32_ADD);
    get(e);
    konst(r < 20 ? 0x5a827999 : r < 40 ? 0x6ed9eba1 : r < 60 ? 0x8f1bbcdc : 0xca62c1d6);
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
  op(END);

  const body: number[] = [];
  body.push(1); // one run of locals
  uleb(27, body);
  body.push(I32);
  body.push(...code);
  const codeSection: number[] = [1];
  uleb(body.length, codeSection);
  codeSection.push(...body);

  const out: number[] = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  const section = (id: number, content: number[]) => {
    out.push(id);
    uleb(content.length, out);
    out.push(...content);
  };
  section(1, [1, 0x60, 2, I32, I32, 0]); // type: (i32, i32) -> ()
  section(3, [1, 0]); // function 0 has type 0
  const memory = [1, 0];
  uleb(PAGES, memory);
  section(5, memory); // memory: PAGES pages, no maximum
  const name = (s: string) => [s.length, ...Array.from(s, (ch) => ch.charCodeAt(0))];
  section(7, [2, ...name("memory"), 2, 0, ...name("blocks"), 0, 0]); // exports
  section(10, codeSection);
  return new Uint8Array(out);
}
