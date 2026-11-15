import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ChunkRef,
  chunkHash,
  chunkStream,
  hashFromString,
  type ReconstructionAnswer,
  writeXorb,
} from "../../src/index.js";

const fixtures = join(import.meta.dirname, "../../fixtures/xet");
export const fixture = (name: string): string => readFileSync(join(fixtures, name), "utf8");
export const fixtureBytes = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(join(fixtures, name)));

/** the reference files of the Xet specification (dataset `xet-team/xet-spec-reference-files`) */
export const CSV = "Electric_Vehicle_Population_Data_20250917.csv";
export const XORB = "eea25d6ee393ccae385820daed127b96ef0ea034dfb7cf6da3a950ce334b7632";
export const CSV_SIZE = 63_527_244;
export const REVISION = "c4aa3a3f15b1395fff5ce934784bf6c8f2d62de8";
export const XORB_SHA256 = "e72f4e05b9c4b96f1c6b2213d93de00ab943585a2f7c049fd127ba72ec1ff413";
export const FILE_HASH = (): string => fixture(`${CSV}.xet-file-hash`).trim();
export const RANGE_HASH = (): string => fixture(`${XORB}.xorb.range-hash`).trim();
export const SHARDS = {
  base: `${CSV}.shard`,
  verification: `${CSV}.shard.verification`,
  upload: `${CSV}.shard.verification-no-footer`,
  dedupe: `${CSV}.shard.dedupe`,
};

/** the 796 reference chunks (hash, length) */
export const referenceChunks = (): ChunkRef[] =>
  fixture(`${CSV}.chunks`)
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, length] = line.split(" ") as [string, string];
      return { hash: hashFromString(hash), length: Number(length) };
    });

export const recordedAnswer = (): ReconstructionAnswer =>
  JSON.parse(fixture("recon.recorded.json"));

/**
 * The reference xorb (14.7 MB) is not committed. It is read from `XET_REFERENCE_CACHE` (default:
 * `<tmp>/xet-reference`) when present there, and downloaded into it only with `XET_LIVE=1`; the
 * tests that need it are skipped otherwise.
 */
const cacheDir = process.env.XET_REFERENCE_CACHE || join(tmpdir(), "xet-reference");
const cachedXorb = join(cacheDir, `${XORB}.xorb`);
export const HAVE_REFERENCE_XORB = existsSync(cachedXorb) || process.env.XET_LIVE === "1";

const sha256Hex = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
let xorbBytes: Uint8Array | undefined;
export function referenceXorb(): Uint8Array {
  if (xorbBytes) return xorbBytes;
  if (!existsSync(cachedXorb)) {
    mkdirSync(cacheDir, { recursive: true });
    const url = `https://huggingface.co/datasets/xet-team/xet-spec-reference-files/resolve/${REVISION}/${XORB}.xorb`;
    const part = `${cachedXorb}.${process.pid}.part`;
    execFileSync("curl", ["-sSfL", "--retry", "3", "-o", part, url]);
    renameSync(part, cachedXorb);
  }
  const bytes = new Uint8Array(readFileSync(cachedXorb));
  if (sha256Hex(bytes) !== XORB_SHA256) throw new Error(`${cachedXorb}: unexpected SHA-256`);
  xorbBytes = bytes;
  return bytes;
}

/** a fetchRange over in-memory bytes, served in `piece`-sized pieces */
export const memoryRanges = (bytes: Uint8Array, piece = Number.POSITIVE_INFINITY) =>
  async function* (_url: string, start: number, end: number): AsyncGenerator<Uint8Array> {
    for (let at = start; at <= end; at += piece)
      yield bytes.subarray(at, Math.min(end + 1, at + piece));
  };

/** deterministic text-like bytes: words drawn at random (LZ4 shrinks them, CDC finds boundaries) */
export function syntheticData(n: number, seed = 1): Uint8Array {
  const words = Array.from({ length: 64 }, (_, k) =>
    new TextEncoder().encode(`${"w".repeat(1 + (k % 5))}${k.toString(36)}${" ,;\n"[k % 4]}`),
  );
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; ) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    const w = words[(x >>> 0) % 64] as Uint8Array;
    out.set(w.subarray(0, Math.min(w.length, n - i)), i);
    i += w.length;
  }
  return out;
}

/** a synthetic file chunked as Xet chunks it, in one xorb, with a v1 answer over all of it */
export async function syntheticXorb(
  data: Uint8Array,
  o: { compression?: "none" | "lz4" | "bg4-lz4"; name?: string; url?: string } = {},
) {
  const chunks: Uint8Array[] = [];
  for await (const c of chunkStream([data])) chunks.push(c);
  const refs: ChunkRef[] = chunks.map((c) => ({ hash: chunkHash(c), length: c.length }));
  const xorb = writeXorb(chunks, { compression: o.compression ?? "lz4" });
  const name = o.name ?? "ab".repeat(32);
  const answer: ReconstructionAnswer = {
    offset_into_first_range: 0,
    terms: [{ hash: name, unpacked_length: data.length, range: { start: 0, end: chunks.length } }],
    fetch_info: {
      [name]: [
        {
          range: { start: 0, end: chunks.length },
          url: o.url ?? `xorb://${name}`,
          url_range: { start: 0, end: xorb.length - 1 },
        },
      ],
    },
  };
  return { chunks, refs, xorb, answer, name };
}

/** what a ranged GET of `data` answers: 206 with its slice, cut after `cutAfter` bytes if given */
export function rangedResponse(
  data: Uint8Array,
  range: string | null,
  o: { cutAfter?: number; ignoreRange?: boolean; wrongStart?: boolean } = {},
): Response {
  const m = /^bytes=(\d+)-(\d+)$/.exec(range ?? "");
  const [a, b] = m && !o.ignoreRange ? [Number(m[1]), Number(m[2])] : [0, data.length - 1];
  const slice = data.subarray(a, b + 1);
  const cut = o.cutAfter ?? Number.POSITIVE_INFINITY;
  // pieces delivered as they are pulled, then the connection reset
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (sent >= cut) return c.error(new Error("connection reset"));
      if (sent >= slice.length) return c.close();
      const n = Math.min(4096, slice.length - sent, cut - sent);
      c.enqueue(slice.subarray(sent, sent + n));
      sent += n;
    },
  });
  const start = o.wrongStart ? a + 1 : a;
  return new Response(body, {
    status: m && !o.ignoreRange ? 206 : 200,
    headers: m && !o.ignoreRange ? { "content-range": `bytes ${start}-${b}/${data.length}` } : {},
  });
}

export const collect = async (it: AsyncIterable<Uint8Array>): Promise<Buffer> => {
  const parts: Uint8Array[] = [];
  for await (const p of it) parts.push(p);
  return Buffer.concat(parts.map((p) => Buffer.from(p)));
};

export const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
