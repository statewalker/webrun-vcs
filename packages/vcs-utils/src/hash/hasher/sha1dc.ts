/**
 * SHA-1 collision detection as git's sha1dc does it (Marc Stevens and Dan Shumow,
 * "Counter-cryptanalysis"): every block's expanded message is checked against the unavoidable
 * bit conditions of 32 disturbance vectors (`ubcCheck`, inlined in the block functions). A block
 * meeting a DV's conditions is recompressed with that DV's message difference, from the state at
 * the DV's step, back to the block's input and forward to its output: when the other message
 * block reaches the same output, the block is part of a collision attack (SHAttered, Shambles).
 *
 * The JavaScript block function (`dcBlocks`) hands a flagged block (about one in twenty on
 * random data) to `dcCheck` here; the WebAssembly one (`sha1-wasm.ts`) runs the same
 * recompression in the module.
 */
import { DISTURBANCE_VECTORS } from "./sha1dc-tables.js";

/** git's message when sha1dc finds a collision attack (`git_SHA1DCFinal`, which dies with it). */
export class Sha1CollisionError extends Error {
  /** @param id the hex SHA-1 of the hashed data (sha1dc's plain hash: git sets no safe hash) */
  constructor(readonly id: string) {
    super(`SHA-1 appears to be part of a collision attack: ${id}`);
    this.name = "Sha1CollisionError";
  }
}

const K = [0x5a827999, 0x6ed9eba1, 0x8f1bbcdc | 0, 0xca62c1d6 | 0];

/** The round function and constant of step `t`, added to `rotl(a, 5) + e + w`. */
function f(t: number, b: number, c: number, d: number): number {
  if (t < 20) return (d ^ (b & (c ^ d))) + (K[0] as number);
  if (t < 40) return (b ^ c ^ d) + (K[1] as number);
  if (t < 60) return ((b & c) | (d & (b | c))) + (K[2] as number);
  return (b ^ c ^ d) + (K[3] as number);
}

const rotl = (x: number, n: number) => (x << n) | (x >>> (32 - n));

// the expanded block and the other block of a recompression
const W = new Int32Array(80);
const M2 = new Int32Array(80);

/**
 * What the block functions hand `dcCheck`: the state before the block (0..4), the states
 * before steps 58 (5..9) and 65 (10..14), in the roles (a, b, c, d, e) of that step, and the
 * state after the block (15..19).
 */
export const DC_STATE = new Int32Array(20);

/**
 * sha1dc's recompression check of the block of `p` at `at`, whose `ubcCheck` is `mask`, from
 * `DC_STATE`: true when the block is part of a collision attack.
 */
export function dcCheck(p: Uint8Array, at: number, mask: number): boolean {
  for (let i = 0; i < 16; i++) {
    const o = at + 4 * i;
    W[i] =
      ((p[o] as number) << 24) |
      ((p[o + 1] as number) << 16) |
      ((p[o + 2] as number) << 8) |
      (p[o + 3] as number);
  }
  for (let i = 16; i < 80; i++) {
    W[i] = rotl(
      (W[i - 3] as number) ^ (W[i - 8] as number) ^ (W[i - 14] as number) ^ (W[i - 16] as number),
      1,
    );
  }
  for (const dv of DISTURBANCE_VECTORS) {
    if ((mask & (1 << dv.maskb)) === 0) continue;
    for (let j = 0; j < 80; j++) M2[j] = (W[j] as number) ^ (dv.dm[j] as number);
    if (recompressionCollides(dv.testt)) return true;
  }
  return false;
}

/**
 * sha1dc's `sha1_recompression_step`: from the state before step `t` (58 or 65), steps back
 * through `M2` to the other block's input and forward to its output; true when that output is
 * the block's own.
 */
function recompressionCollides(t: 58 | 65): boolean {
  const at = t === 58 ? 5 : 10;
  let a = DC_STATE[at] as number;
  let b = DC_STATE[at + 1] as number;
  let c = DC_STATE[at + 2] as number;
  let d = DC_STATE[at + 3] as number;
  let e = DC_STATE[at + 4] as number;
  for (let i = t - 1; i >= 0; i--) {
    // (a, b, c, d, e) is the state after step i
    const pa = b;
    const pb = rotl(c, 2);
    const pe = (a - (rotl(pa, 5) + f(i, pb, d, e) + (M2[i] as number))) | 0;
    a = pa;
    b = pb;
    c = d;
    d = e;
    e = pe;
  }
  const in0 = a;
  const in1 = b;
  const in2 = c;
  const in3 = d;
  const in4 = e;
  a = DC_STATE[at] as number;
  b = DC_STATE[at + 1] as number;
  c = DC_STATE[at + 2] as number;
  d = DC_STATE[at + 3] as number;
  e = DC_STATE[at + 4] as number;
  for (let i = t; i < 80; i++) {
    const next = (rotl(a, 5) + f(i, b, c, d) + e + (M2[i] as number)) | 0;
    e = d;
    d = c;
    c = rotl(b, 30);
    b = a;
    a = next;
  }
  return (
    ((in0 + a) | 0) === DC_STATE[15] &&
    ((in1 + b) | 0) === DC_STATE[16] &&
    ((in2 + c) | 0) === DC_STATE[17] &&
    ((in3 + d) | 0) === DC_STATE[18] &&
    ((in4 + e) | 0) === DC_STATE[19]
  );
}
