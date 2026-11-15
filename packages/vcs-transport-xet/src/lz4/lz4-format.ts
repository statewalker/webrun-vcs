/** the LZ4 frame magic number (little-endian `04 22 4D 18`) */
export const LZ4_FRAME_MAGIC = 0x184d2204;

/** a little-endian u32 at `at` */
export function readU32(b: Uint8Array, at: number): number {
  return (
    ((b[at] as number) |
      ((b[at + 1] as number) << 8) |
      ((b[at + 2] as number) << 16) |
      ((b[at + 3] as number) << 24)) >>>
    0
  );
}
