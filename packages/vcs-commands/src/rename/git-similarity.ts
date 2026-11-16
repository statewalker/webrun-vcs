/**
 * git's similarity estimate of two files (`diffcore-delta.c` and `estimate_similarity` in
 * `diffcore-rename.c`), the score `git status` and `git diff -M` report as `R<score>`.
 *
 * Each file is cut into spans (a line, or 64 bytes when a line is longer), each span hashed;
 * the score is how many bytes of the destination's spans the source also has, against the
 * larger file's size. Text files ignore the CR of a CRLF, as git does.
 */

/** git's full score (`MAX_SCORE`): 100%. */
export const GIT_MAX_SCORE = 60000;

/** git's default rename threshold (`DEFAULT_RENAME_SCORE`): 50%. */
export const GIT_DEFAULT_RENAME_SCORE = 30000;

const HASHBASE = 107927;

/** Whether the bytes are binary to git (`buffer_is_binary`: a NUL in the first 8000). */
export function isBinaryContent(content: Uint8Array): boolean {
  const n = Math.min(content.length, 8000);
  for (let i = 0; i < n; i++) if (content[i] === 0) return true;
  return false;
}

/** The span counts of a file (git's `hash_chars`): hash value to bytes, sorted by hash. */
export type SpanCounts = Array<[hash: number, count: number]>;

/**
 * Cuts the content into spans and counts the bytes of each span hash (`hash_chars`). A last
 * span without a newline (shorter than 64 bytes) counts, as in current git (2.5x); git
 * 2.43 and older left it out (`countLastSpan: false`).
 */
export function spanCounts(
  content: Uint8Array,
  options: { countLastSpan?: boolean } = {},
): SpanCounts {
  const isText = !isBinaryContent(content);
  const counts = new Map<number, number>();
  const add = (accum1: number, accum2: number, n: number) => {
    const hash = ((accum1 + Math.imul(accum2, 0x61)) >>> 0) % HASHBASE;
    counts.set(hash, (counts.get(hash) ?? 0) + n);
  };
  let n = 0;
  let accum1 = 0;
  let accum2 = 0;
  const size = content.length;
  for (let i = 0; i < size; i++) {
    const c = content[i];
    // the CR of a CRLF does not count in a text file
    if (isText && c === 0x0d && i + 1 < size && content[i + 1] === 0x0a) continue;
    const old1 = accum1;
    accum1 = ((accum1 << 7) ^ (accum2 >>> 25)) >>> 0;
    accum2 = ((accum2 << 7) ^ (old1 >>> 25)) >>> 0;
    accum1 = (accum1 + c) >>> 0;
    if (++n < 64 && c !== 0x0a) continue;
    add(accum1, accum2, n);
    n = 0;
    accum1 = 0;
    accum2 = 0;
  }
  if (n > 0 && options.countLastSpan !== false) add(accum1, accum2, n);
  return [...counts.entries()].sort((a, b) => a[0] - b[0]);
}

/**
 * The bytes of `dst` the source has (`diffcore_count_changes`: `src_copied`), from the
 * span counts of both.
 */
export function copiedBytes(src: SpanCounts, dst: SpanCounts): number {
  let copied = 0;
  let d = 0;
  for (const [hash, srcCount] of src) {
    while (d < dst.length && dst[d][0] < hash) d++;
    let dstCount = 0;
    if (d < dst.length && dst[d][0] === hash) {
      dstCount = dst[d][1];
      d++;
    }
    copied += Math.min(srcCount, dstCount);
  }
  return copied;
}

/** One side of a similarity estimate: its mode, size and (lazily) its span counts. */
export interface SimilaritySide {
  mode: number;
  size: number;
  spans(): Promise<SpanCounts>;
}

const isRegular = (mode: number) => (mode & 0o170000) === 0o100000;

/**
 * git's `estimate_similarity`: 0..{@link GIT_MAX_SCORE}. Only regular files are compared
 * (links and submodules are renamed only when exact); a size change too large for
 * `minimumScore` scores 0 without reading either file.
 */
export async function estimateSimilarity(
  src: SimilaritySide,
  dst: SimilaritySide,
  minimumScore: number = GIT_DEFAULT_RENAME_SCORE,
): Promise<number> {
  if (!isRegular(src.mode) || !isRegular(dst.mode)) return 0;
  const maxSize = Math.max(src.size, dst.size);
  const baseSize = Math.min(src.size, dst.size);
  const deltaSize = maxSize - baseSize;
  if (maxSize * (GIT_MAX_SCORE - minimumScore) < deltaSize * GIT_MAX_SCORE) return 0;
  if (!dst.size) return 0;
  const copied = copiedBytes(await src.spans(), await dst.spans());
  return Math.floor((copied * GIT_MAX_SCORE) / maxSize);
}

/** The percentage git prints for a score (`R87`). */
export function scorePercent(score: number): number {
  return Math.floor((score * 100) / GIT_MAX_SCORE);
}
