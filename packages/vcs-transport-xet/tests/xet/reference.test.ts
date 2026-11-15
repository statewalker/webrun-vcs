import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type ChunkRef,
  chunkHash,
  chunkStream,
  downloadXetFile,
  fileHash,
  hashFromString,
  hashToString,
  type ReconstructionAnswer,
  type ReconstructionVerifier,
  rangeHash,
  readShard,
  reconstruct,
  v2ToV1,
  verifierFromShard,
  writeXorb,
  XetIntegrityError,
  xorbHash,
} from "../../src/index.js";
import {
  CSV,
  collect,
  fixture,
  fixtureBytes,
  HAVE_REFERENCE_XORB,
  rangedResponse,
  recordedAnswer,
  referenceChunks,
  referenceXorb,
  SHARDS,
  XORB,
} from "./helpers.js";

// Reference vectors: the specification's reference xorb (14.7 MB, xet-team/xet-spec-reference-
// files at a pinned revision, SHA-256 checked), rebuilt to the reference CSV's 796 chunk hashes,
// file hash and SHA-256. The xorb is not committed: these tests run when it is in the cache
// directory (XET_REFERENCE_CACHE) or with XET_LIVE=1 (downloaded); they are skipped otherwise.

const gc = (globalThis as { gc?: () => void }).gc;

describe.runIf(HAVE_REFERENCE_XORB)("reference xorb (cached, or XET_LIVE=1)", () => {
  it("the rebuilt reference file has the Hub's SHA-256", async () => {
    const xorb = referenceXorb();
    const h = createHash("sha256");
    for await (const p of reconstruct(recordedAnswer(), async function* (_u, start, end) {
      yield xorb.subarray(start, end + 1);
    }))
      h.update(p);
    expect(h.digest("hex")).toBe(fixture(`${CSV}.sha256`).trim());
  }, 300_000);

  describe("H3 + H4 reconstruction from the recorded answer", () => {
    it("rebuilds the reference file: its chunks, chunk hashes and file hash, streaming", async () => {
      const reference = referenceChunks();
      const xorb = referenceXorb();
      const answer = recordedAnswer();
      const fetched: string[] = [];
      // the recorded URLs name the xorb; a range is served in 1 MiB pieces, as a body would arrive
      const fetchRange = async function* (url: string, start: number, end: number) {
        fetched.push(`${url} ${start}-${end}`);
        expect(url).toBe(`xorb://${XORB}`);
        for (let at = start; at <= end; at += 1 << 20)
          yield xorb.subarray(at, Math.min(end + 1, at + (1 << 20)));
      };
      gc?.();
      const before = process.memoryUsage();
      let peak = 0;
      const got: ChunkRef[] = [];
      let size = 0;
      for await (const chunk of chunkStream(reconstruct(answer, fetchRange))) {
        got.push({ hash: chunkHash(chunk), length: chunk.length });
        size += chunk.length;
        // what is retained, after a collection (vitest runs with --expose-gc)
        if (got.length % 50 === 0) {
          gc?.();
          const m = process.memoryUsage();
          peak = Math.max(
            peak,
            m.heapUsed + m.arrayBuffers - before.heapUsed - before.arrayBuffers,
          );
        }
      }
      expect(fetched).toEqual([`xorb://${XORB} 0-14737812`]);
      expect(size).toBe(63_527_244);
      expect(got.length).toBe(796);
      const wrong = got.findIndex(
        (c, i) =>
          c.length !== reference[i]?.length ||
          hashToString(c.hash) !== hashToString(reference[i]?.hash as Uint8Array),
      );
      expect(wrong).toBe(-1);
      expect(hashToString(fileHash(got))).toBe(fixture(`${CSV}.xet-file-hash`).trim());
      // the file is 63 MB; streaming retains a few chunks and fetched pieces, not the file
      if (gc) expect(peak).toBeLessThan(8 * 1024 * 1024);
    }, 300_000);
  });

  describe("H6 range requests", () => {
    it("a term over a chunk sub-range with an offset into it: the matching slice of the file", async () => {
      const xorb = referenceXorb();
      const answer = recordedAnswer();
      const fetchRange = async function* (_url: string, start: number, end: number) {
        yield xorb.subarray(start, end + 1);
      };
      const collect = async (a: ReconstructionAnswer) => {
        const parts: Uint8Array[] = [];
        for await (const p of reconstruct(a, fetchRange)) parts.push(p);
        return Buffer.concat(parts);
      };
      const whole = await collect(answer);
      const ref = referenceChunks();
      const startByte = ref.slice(0, 10).reduce((n, c) => n + c.length, 0);
      const length = ref.slice(10, 20).reduce((n, c) => n + c.length, 0);
      const term = { ...answer.terms[0], unpacked_length: length, range: { start: 10, end: 20 } };
      const ranged = await collect({
        ...answer,
        offset_into_first_range: 12_345,
        terms: [term],
      } as ReconstructionAnswer);
      expect(ranged.equals(whole.subarray(startByte + 12_345, startByte + length))).toBe(true);
    }, 300_000);
  });

  describe("H8 review cases on the reference xorb", () => {
    const answerOf = (): ReconstructionAnswer => recordedAnswer();

    it("the fetched body is closed when a term ends before its fetch range; no chunk past the term is read", async () => {
      const xorb = referenceXorb();
      let closed = 0;
      let served = 0;
      const fetchRange = async function* (_url: string, start: number, end: number) {
        try {
          for (let at = start; at <= end; at += 4096) {
            served = at + 4096;
            yield xorb.subarray(at, Math.min(end + 1, at + 4096));
          }
        } finally {
          closed++;
        }
      };
      const answer = answerOf();
      const ref = referenceChunks();
      const length = ref.slice(0, 3).reduce((n, c) => n + c.length, 0);
      const term = { ...answer.terms[0], unpacked_length: length, range: { start: 0, end: 3 } };
      let size = 0;
      for await (const p of reconstruct(
        { ...answer, terms: [term] } as ReconstructionAnswer,
        fetchRange,
      ))
        size += p.length;
      expect(size).toBe(length);
      expect(closed).toBe(1);
      // the 4th chunk's header starts where the 3rd chunk ends: nothing far past it was pulled
      let end3 = 0;
      for (let k = 0; k < 3; k++)
        end3 +=
          8 +
          ((xorb[end3 + 1] as number) |
            ((xorb[end3 + 2] as number) << 8) |
            ((xorb[end3 + 3] as number) << 16));
      expect(served).toBeLessThanOrEqual(end3 + 4096);
    }, 120_000);

    it("a fetch range that takes in the xorb's tail (XETB) after its last chunk", async () => {
      const xorb = referenceXorb();
      const answer = answerOf();
      const entry = answer.fetch_info[XORB]?.[0];
      if (entry) entry.url_range = { start: 0, end: xorb.length - 1 };
      const fetchRange = async function* (_url: string, start: number, end: number) {
        yield xorb.subarray(start, end + 1);
      };
      let size = 0;
      for await (const p of reconstruct(answer, fetchRange)) size += p.length;
      expect(size).toBe(63_527_244);
    }, 120_000);

    it("a requested length truncates the last term", async () => {
      const xorb = referenceXorb();
      const fetchRange = async function* (_url: string, start: number, end: number) {
        yield xorb.subarray(start, end + 1);
      };
      let size = 0;
      for await (const p of reconstruct(answerOf(), fetchRange, { length: 1_000_003 }))
        size += p.length;
      expect(size).toBe(1_000_003);
    }, 120_000);
  });

  describe("U3 the reference chunks in xorbs we write", () => {
    /** a xorb's chunks read back through `reconstruct` (one term, one fetch of the whole xorb) */
    async function readBack(xorb: Uint8Array, count: number, bytes: number): Promise<Uint8Array[]> {
      const hash = "00".repeat(32);
      const answer: ReconstructionAnswer = {
        offset_into_first_range: 0,
        terms: [{ hash, unpacked_length: bytes, range: { start: 0, end: count } }],
        fetch_info: {
          [hash]: [
            {
              range: { start: 0, end: count },
              url: "xorb://ours",
              url_range: { start: 0, end: xorb.length - 1 },
            },
          ],
        },
      };
      const out: Uint8Array[] = [];
      for await (const c of chunkStream(
        reconstruct(answer, async function* (_u, start, end) {
          yield xorb.subarray(start, end + 1);
        }),
      ))
        out.push(c);
      return out;
    }
    it("the reference file's 796 chunks in a xorb we write: read back, same hashes, about the reference's size", async () => {
      const xorb = referenceXorb();
      const answer = recordedAnswer();
      const chunks: Uint8Array[] = [];
      for await (const c of chunkStream(
        reconstruct(answer, async function* (_u, start, end) {
          yield xorb.subarray(start, end + 1);
        }),
      ))
        chunks.push(c);
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const refs = referenceChunks();
      for (const compression of ["lz4", "bg4-lz4", "none"] as const) {
        const ours = writeXorb(chunks, { compression });
        const back = await readBack(ours, chunks.length, total);
        expect(back.length, compression).toBe(796);
        const wrong = back.findIndex(
          (c, i) => hashToString(chunkHash(c)) !== hashToString(refs[i]?.hash as Uint8Array),
        );
        expect(wrong, compression).toBe(-1);
        if (compression === "none") expect(ours.length).toBe(total + 8 * 796);
        // the reference xorb (xet-core's LZ4, then its 4-byte tail) is 14,737,817 bytes
        if (compression === "lz4") {
          expect(ours.length).toBeLessThan(14_737_817 * 1.25);
          console.log(`U3: our LZ4 xorb ${ours.length} bytes, the reference's 14,737,817`);
        }
      }
      expect(hashToString(xorbHash(refs))).toBe(XORB);
    }, 300_000);
  });
  describe("U5 (X11b) reconstruction checks each chunk against a shard's hashes as it streams", () => {
    /** the reference file's chunks, decoded once */
    let chunks: Uint8Array[] | undefined;
    const referenceChunkData = async () => {
      if (chunks) return chunks;
      const xorb = referenceXorb();
      const answer = recordedAnswer();
      const out: Uint8Array[] = [];
      for await (const c of chunkStream(
        reconstruct(answer, async function* (_u, start, end) {
          yield xorb.subarray(start, end + 1);
        }),
      ))
        out.push(c);
      chunks = out;
      return out;
    };
    /** an answer over all 796 chunks of `xorb` (named as the reference xorb), fetched in 1 MiB pieces */
    const run = async (xorb: Uint8Array, verify?: ReconstructionVerifier) => {
      const answer: ReconstructionAnswer = {
        offset_into_first_range: 0,
        terms: [{ hash: XORB, unpacked_length: 63_527_244, range: { start: 0, end: 796 } }],
        fetch_info: {
          [XORB]: [
            {
              range: { start: 0, end: 796 },
              url: `xorb://${XORB}`,
              url_range: { start: 0, end: xorb.length - 1 },
            },
          ],
        },
      };
      let yielded = 0;
      let bytes = 0;
      try {
        for await (const p of reconstruct(
          answer,
          async function* (_u, start, end) {
            for (let at = start; at <= end; at += 1 << 20)
              yield xorb.subarray(at, Math.min(end + 1, at + (1 << 20)));
          },
          { verify },
        )) {
          yielded++;
          bytes += p.length;
        }
        return { yielded, bytes };
      } catch (e) {
        return { yielded, bytes, error: e as Error };
      }
    };
    /** the reference chunks stored uncompressed, chunk `k` with one byte changed (decodes fine) */
    const damaged = (all: Uint8Array[], k: number) => {
      const xorb = writeXorb(all, { compression: "none" });
      let at = 0;
      for (let i = 0; i < k; i++) at += 8 + (all[i] as Uint8Array).length;
      xorb[at + 8 + 1000] = (xorb[at + 8 + 1000] as number) ^ 0x20;
      return xorb;
    };

    it("the reference reconstruction passes, every chunk checked, with each reference shard", async () => {
      const xorb = referenceXorb();
      for (const name of [SHARDS.base, SHARDS.verification, SHARDS.dedupe]) {
        const v = verifierFromShard(readShard(fixtureBytes(name)));
        let checked = 0;
        const r = await run(xorb, {
          chunk: (x, i, h) => {
            const ok = v.chunk?.(x, i, h);
            if (ok) checked++;
            return ok;
          },
        });
        expect(r.error, name).toBeUndefined();
        expect(r.bytes).toBe(63_527_244);
        expect(checked, name).toBe(796);
      }
    }, 300_000);

    it("a damaged chunk stops the stream at that chunk; unchecked, the damage passes silently", async () => {
      const all = await referenceChunkData();
      const bad = damaged(all, 300);
      const unchecked = await run(bad);
      expect(unchecked.error).toBeUndefined(); // decodes, wrong bytes, nothing notices
      expect(unchecked.yielded).toBe(796);
      for (const name of [SHARDS.base, SHARDS.dedupe]) {
        const r = await run(bad, verifierFromShard(readShard(fixtureBytes(name))));
        expect(r.error, name).toBeInstanceOf(XetIntegrityError);
        expect(r.error?.message).toMatch(/chunk 300 /);
        expect(r.yielded, name).toBe(300); // chunks 0-299 out, nothing from 300 on
      }
    }, 300_000);

    it("with the file's term verification hash only: caught when the term ends", async () => {
      const all = await referenceChunkData();
      const shard = readShard(fixtureBytes(SHARDS.verification));
      const file = hashFromString(fixture(`${CSV}.xet-file-hash`).trim());
      // one verifier per reconstruction (it walks the file's terms in order)
      const termOnly = () => ({ rangeHash: verifierFromShard(shard, file).rangeHash });
      const clean = await run(writeXorb(all, { compression: "none" }), termOnly());
      expect(clean.error).toBeUndefined();
      const r = await run(damaged(all, 700), termOnly());
      expect(r.error).toBeInstanceOf(XetIntegrityError);
      expect(r.error?.message).toMatch(/verification hash/);
      expect(r.yielded).toBe(796); // the term's bytes are out before its end is checked
      expect(() => verifierFromShard(shard, new Uint8Array(32))).toThrow(/not in this shard/);
    }, 300_000);

    it("a term inside its fetch range: its range hash covers its own chunks only", async () => {
      const xorb = referenceXorb();
      const refs = referenceChunks();
      const bytes = refs.slice(100, 200).reduce((n, c) => n + c.length, 0);
      const answer: ReconstructionAnswer = {
        offset_into_first_range: 0,
        terms: [{ hash: XORB, unpacked_length: bytes, range: { start: 100, end: 200 } }],
        fetch_info: {
          [XORB]: [
            {
              range: { start: 0, end: 796 },
              url: `xorb://${XORB}`,
              url_range: { start: 0, end: xorb.length - 1 },
            },
          ],
        },
      };
      const go = async (expected: Uint8Array) => {
        let n = 0;
        for await (const p of reconstruct(
          answer,
          async function* (_u, start, end) {
            yield xorb.subarray(start, end + 1);
          },
          { verify: { rangeHash: () => expected } },
        ))
          n += p.length;
        return n;
      };
      expect(await go(rangeHash(refs.slice(100, 200).map((c) => c.hash)))).toBe(bytes);
      await expect(go(rangeHash(refs.slice(0, 200).map((c) => c.hash)))).rejects.toThrow(
        XetIntegrityError,
      );
    }, 300_000);

    it("chunks of a xorb the shard does not list are not checked", async () => {
      const all = await referenceChunkData();
      const other = verifierFromShard({ files: [], xorbs: [] });
      const r = await run(damaged(all, 5), other);
      expect(r.error).toBeUndefined();
    }, 300_000);
  });

  describe("U8 reconstruction answers over the reference xorb", () => {
    it("(review of #125) a v2 entry of several ranges: a term in its second range reads that range", async () => {
      const xorb = referenceXorb();
      // byte offsets of chunks 0..3 of the reference xorb, from their headers
      const at = [0];
      for (let k = 0; k < 3; k++) {
        const o = at[k] as number;
        at.push(
          o +
            8 +
            ((xorb[o + 1] as number) |
              ((xorb[o + 2] as number) << 8) |
              ((xorb[o + 3] as number) << 16)),
        );
      }
      const refs = referenceChunks();
      const v1 = v2ToV1({
        offset_into_first_range: 0,
        terms: [
          { hash: XORB, unpacked_length: refs[2]?.length as number, range: { start: 2, end: 3 } },
        ],
        xorbs: {
          [XORB]: [
            {
              url: "xorb://x",
              ranges: [
                { chunks: { start: 0, end: 2 }, bytes: { start: 0, end: (at[2] as number) - 1 } },
                {
                  chunks: { start: 2, end: 3 },
                  bytes: { start: at[2] as number, end: (at[3] as number) - 1 },
                },
              ],
            },
          ],
        },
      });
      const asked: number[] = [];
      const out = await collect(
        reconstruct(v1, async function* (_u, a, b) {
          asked.push(a);
          yield xorb.subarray(a, b + 1);
        }),
      );
      expect(asked).toEqual([at[2]]);
      expect(hashToString(chunkHash(new Uint8Array(out)))).toBe(
        hashToString(refs[2]?.hash as Uint8Array),
      );
    }, 300_000);

    it("downloadXetFile over a fake Hub, CAS and CDN (bodies cut): the reference file, checked against its shard", async () => {
      const xorb = referenceXorb();
      const answer = recordedAnswer();
      const fileHashString = fixture(`${CSV}.xet-file-hash`).trim();
      const seen: string[] = [];
      let cuts = 0;
      const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        seen.push(url.replace(/\?.*/, ""));
        if (url.endsWith("/paths-info/rev"))
          return Response.json([
            { path: CSV, type: "file", size: 63_527_244, xetHash: fileHashString },
          ]);
        if (url.endsWith("/xet-read-token/rev"))
          return Response.json({ casUrl: "https://cas.test", accessToken: "t", exp: 0 });
        if (url.startsWith("https://cas.test/v2/reconstructions/")) {
          expect(new Headers(init?.headers).get("authorization")).toBe("Bearer t");
          const e = answer.fetch_info[
            XORB
          ]?.[0] as ReconstructionAnswer["fetch_info"][string][number];
          return Response.json({
            offset_into_first_range: 0,
            terms: answer.terms,
            xorbs: {
              [XORB]: [
                { url: "https://cdn.test/x", ranges: [{ chunks: e.range, bytes: e.url_range }] },
              ],
            },
          });
        }
        if (url === "https://cdn.test/x")
          return rangedResponse(xorb, new Headers(init?.headers).get("range"), {
            cutAfter: cuts++ < 3 ? 3_000_000 : undefined,
          });
        return new Response("?", { status: 404 });
      }) as typeof fetch;
      const verify = verifierFromShard(
        readShard(fixtureBytes(SHARDS.verification)),
        hashFromString(fileHashString),
        {
          wholeFile: true,
        },
      );
      const got: ChunkRef[] = [];
      for await (const c of chunkStream(
        downloadXetFile({ repo: "a/b", repoType: "dataset", revision: "rev", fetch: f }, CSV, {
          version: 2,
          verify,
          backoffMs: 1,
        }),
      ))
        got.push({ hash: chunkHash(c), length: c.length });
      expect(hashToString(fileHash(got))).toBe(fileHashString);
      expect(seen.slice(0, 3)).toEqual([
        "https://huggingface.co/api/datasets/a/b/paths-info/rev",
        "https://huggingface.co/api/datasets/a/b/xet-read-token/rev",
        `https://cas.test/v2/reconstructions/${fileHashString}`,
      ]);
      expect(seen.filter((u) => u === "https://cdn.test/x").length).toBe(4); // three cuts, resumed
    }, 300_000);
  });
});
