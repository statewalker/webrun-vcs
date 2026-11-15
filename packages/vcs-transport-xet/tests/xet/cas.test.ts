import { describe, expect, it } from "vitest";
import {
  type ChunkRef,
  chunkHash,
  chunkStream,
  downloadXetFile,
  fetchReconstruction,
  fileHash,
  hashToString,
  httpRanges,
  type ReconstructionAnswerV2,
  rangeHash,
  readShard,
  type Shard,
  v2ToV1,
  verifierFromShard,
  writeShard,
  XetHttpError,
  type XetToken,
  xetTokenSource,
  xorbHash,
} from "../../src/index.js";
import { collect, rangedResponse, syntheticData, syntheticXorb, XORB } from "./helpers.js";

describe("U8 (X11c) the live services' protocol, offline", () => {
  const data = new Uint8Array(100_000).map((_, i) => (i * 7) & 0xff);

  it("a body cut twice is resumed from the next byte; the ranges asked say so", async () => {
    const asked: string[] = [];
    let n = 0;
    const f = (async (_u: string, init?: RequestInit) => {
      const range = new Headers(init?.headers).get("range");
      asked.push(range ?? "");
      return rangedResponse(data, range, { cutAfter: n++ < 2 ? 30_000 : undefined });
    }) as typeof fetch;
    const got = await collect(httpRanges({ fetch: f, backoffMs: 1 })("u", 1000, 89_999));
    expect(got.equals(Buffer.from(data.subarray(1000, 90_000)))).toBe(true);
    expect(asked).toEqual(["bytes=1000-89999", "bytes=31000-89999", "bytes=61000-89999"]);
  });

  it("429, 503 and a network error are tried again; past the retries the error stands", async () => {
    const plan = ["429", "503", "throw", "ok"];
    const f = (async (_u: string, init?: RequestInit) => {
      const step = plan.shift();
      if (step === "throw") throw new TypeError("fetch failed");
      if (step === "429" || step === "503") return new Response("busy", { status: Number(step) });
      return rangedResponse(data, new Headers(init?.headers).get("range"));
    }) as typeof fetch;
    const got = await collect(httpRanges({ fetch: f, backoffMs: 1 })("u", 0, 999));
    expect(got.length).toBe(1000);
    let calls = 0;
    const down = (async () => {
      calls++;
      return new Response("busy", { status: 503 });
    }) as typeof fetch;
    await expect(
      collect(httpRanges({ fetch: down, retries: 2, backoffMs: 1 })("u", 0, 9)),
    ).rejects.toThrow(/503/);
    expect(calls).toBe(3);
  });

  it("a server ignoring Range is read from the start, skipping; another range or a 404 is refused", async () => {
    const ignoring = (async () =>
      rangedResponse(data, null, { ignoreRange: true })) as typeof fetch;
    const got = await collect(httpRanges({ fetch: ignoring })("u", 50_000, 50_999));
    expect(got.equals(Buffer.from(data.subarray(50_000, 51_000)))).toBe(true);
    const wrong = (async (_u: string, init?: RequestInit) =>
      rangedResponse(data, new Headers(init?.headers).get("range"), {
        wrongStart: true,
      })) as typeof fetch;
    await expect(collect(httpRanges({ fetch: wrong })("u", 10, 20))).rejects.toThrow(
      /another range/,
    );
    let calls = 0;
    const missing = (async () => {
      calls++;
      return new Response("no", { status: 404 });
    }) as typeof fetch;
    await expect(collect(httpRanges({ fetch: missing, backoffMs: 1 })("u", 0, 9))).rejects.toThrow(
      XetHttpError,
    );
    expect(calls).toBe(1); // a 404 is not tried again
  });

  it("v2's xorbs[].ranges[] become v1's fetch entries", () => {
    const v2: ReconstructionAnswerV2 = {
      offset_into_first_range: 5,
      terms: [{ hash: XORB, unpacked_length: 10, range: { start: 0, end: 3 } }],
      xorbs: {
        [XORB]: [
          {
            url: "https://cdn/x",
            ranges: [
              { chunks: { start: 0, end: 2 }, bytes: { start: 0, end: 99 } },
              { chunks: { start: 2, end: 3 }, bytes: { start: 100, end: 149 } },
            ],
          },
        ],
      },
    };
    expect(v2ToV1(v2)).toEqual({
      offset_into_first_range: 5,
      terms: v2.terms,
      fetch_info: {
        [XORB]: [
          { range: { start: 0, end: 2 }, url: "https://cdn/x", url_range: { start: 0, end: 99 } },
          {
            range: { start: 2, end: 3 },
            url: "https://cdn/x",
            url_range: { start: 100, end: 149 },
          },
        ],
      },
    });
  });

  it("(review of #125) a resume answered by 200, a 206 longer than asked, Retry-After, an abort while waiting", async () => {
    let n = 0;
    const thenWhole = (async (_u: string, init?: RequestInit) =>
      n++ === 0
        ? rangedResponse(data, new Headers(init?.headers).get("range"), { cutAfter: 10_000 })
        : rangedResponse(data, null, { ignoreRange: true })) as typeof fetch;
    const got = await collect(httpRanges({ fetch: thenWhole, backoffMs: 1 })("u", 5000, 59_999));
    expect(got.equals(Buffer.from(data.subarray(5000, 60_000)))).toBe(true);
    const longer = (async () =>
      new Response(data.subarray(100, 300), {
        status: 206,
        headers: { "content-range": "bytes 100-299/100000" },
      })) as typeof fetch;
    expect((await collect(httpRanges({ fetch: longer })("u", 100, 149))).length).toBe(50);
    // Retry-After: 1 second asked, waited, whatever the backoff
    let calls = 0;
    const busy = (async (_u: string, init?: RequestInit) =>
      calls++ === 0
        ? new Response("", { status: 429, headers: { "retry-after": "1" } })
        : rangedResponse(data, new Headers(init?.headers).get("range"))) as typeof fetch;
    const t0 = Date.now();
    await collect(httpRanges({ fetch: busy, backoffMs: 1 })("u", 0, 9));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(950);
    // an abort during a long pause ends it at once
    const down = (async () => new Response("", { status: 503 })) as typeof fetch;
    const ac = new AbortController();
    setTimeout(() => ac.abort(new Error("stop")), 20);
    const t1 = Date.now();
    await expect(
      collect(httpRanges({ fetch: down, backoffMs: 10_000, signal: ac.signal })("u", 0, 9)),
    ).rejects.toThrow(/stop/);
    expect(Date.now() - t1).toBeLessThan(2000);
  });

  it("(review of #125) the reconstruction: v2 first, v1 where v2 is missing, 416 refused", async () => {
    const token = { casUrl: "https://cas.test", accessToken: "t", exp: 0 };
    const asked: string[] = [];
    const v1only = (async (input: RequestInfo | URL) => {
      asked.push(String(input));
      return String(input).includes("/v2/")
        ? new Response("", { status: 404 })
        : Response.json({ offset_into_first_range: 0, terms: [], fetch_info: {} });
    }) as typeof fetch;
    expect((await fetchReconstruction({ token, fileHash: "ab", fetch: v1only })).terms).toEqual([]);
    expect(asked).toEqual([
      "https://cas.test/v2/reconstructions/ab",
      "https://cas.test/v1/reconstructions/ab",
    ]);
    const unsatisfiable = (async () => new Response("", { status: 416 })) as typeof fetch;
    await expect(
      fetchReconstruction({
        token,
        fileHash: "ab",
        range: { start: 10, end: 20 },
        fetch: unsatisfiable,
      }),
    ).rejects.toThrow(/not satisfiable/);
  });

  it("downloadXetFile over a fake Hub, CAS and CDN (bodies cut): a generated file, checked against its shard", async () => {
    const data = syntheticData(3_000_000, 21);
    const { refs, xorb } = await syntheticXorb(data);
    const X = hashToString(xorbHash(refs));
    const F = hashToString(fileHash(refs));
    const n = refs.length;
    const shard: Shard = {
      files: [
        {
          fileHash: fileHash(refs),
          terms: [
            {
              xorbHash: xorbHash(refs),
              bytes: data.length,
              start: 0,
              end: n,
              rangeHash: rangeHash(refs.map((c) => c.hash)),
            },
          ],
        },
      ],
      xorbs: [{ xorbHash: xorbHash(refs), chunks: refs }],
    };
    const seen: string[] = [];
    let cuts = 0;
    const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      seen.push(url);
      if (url.endsWith("/paths-info/rev"))
        return Response.json([{ path: "f.bin", type: "file", size: data.length, xetHash: F }]);
      if (url.endsWith("/xet-read-token/rev"))
        return Response.json({ casUrl: "https://cas.test", accessToken: "t", exp: 0 });
      if (url.startsWith("https://cas.test/v2/reconstructions/")) {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer t");
        return Response.json({
          offset_into_first_range: 0,
          terms: [{ hash: X, unpacked_length: data.length, range: { start: 0, end: n } }],
          xorbs: {
            [X]: [
              {
                url: "https://cdn.test/x",
                ranges: [
                  { chunks: { start: 0, end: n }, bytes: { start: 0, end: xorb.length - 1 } },
                ],
              },
            ],
          },
        });
      }
      if (url === "https://cdn.test/x")
        return rangedResponse(xorb, new Headers(init?.headers).get("range"), {
          cutAfter: cuts++ < 3 ? Math.floor(xorb.length / 5) : undefined,
        });
      return new Response("?", { status: 404 });
    }) as typeof fetch;
    const verify = verifierFromShard(readShard(writeShard(shard)), fileHash(refs), {
      wholeFile: true,
    });
    const got: ChunkRef[] = [];
    for await (const c of chunkStream(
      downloadXetFile({ repo: "a/b", repoType: "dataset", revision: "rev", fetch: f }, "f.bin", {
        verify,
        backoffMs: 1,
      }),
    ))
      got.push({ hash: chunkHash(c), length: c.length });
    expect(hashToString(fileHash(got))).toBe(F);
    expect(seen.slice(0, 3)).toEqual([
      "https://huggingface.co/api/datasets/a/b/paths-info/rev",
      "https://huggingface.co/api/datasets/a/b/xet-read-token/rev",
      `https://cas.test/v2/reconstructions/${F}`,
    ]);
    expect(seen.filter((u) => u === "https://cdn.test/x").length).toBe(4); // three cuts, resumed
  });
});

describe("CAS token renewal and expired xorb URLs", () => {
  const tokenAt = (n: number, exp: number): XetToken => ({
    casUrl: "https://cas.test",
    accessToken: `t${n}`,
    exp,
  });

  it("a token is renewed ahead of its expiry, not before; concurrent callers share one request", async () => {
    let clock = 1_000_000_000_000; // ms
    let fetched = 0;
    const source = xetTokenSource(async () => tokenAt(++fetched, Math.floor(clock / 1000) + 300), {
      refreshAheadSec: 60,
      now: () => clock,
    });
    const [a, b] = await Promise.all([source.token(), source.token()]);
    expect(fetched).toBe(1);
    expect(a).toBe(b);
    clock += 200_000; // 100 s left: still more than the margin
    expect((await source.token()).accessToken).toBe("t1");
    clock += 50_000; // 50 s left: inside the margin
    expect((await source.token()).accessToken).toBe("t2");
    expect(fetched).toBe(2);
    // refresh after a refusal; a stale token already replaced is not fetched again
    expect((await source.refresh(a)).accessToken).toBe("t2");
    expect((await source.refresh(await source.token())).accessToken).toBe("t3");
  });

  it("a failed token request is not cached", async () => {
    let n = 0;
    const source = xetTokenSource(async () => {
      if (n++ === 0) throw new XetHttpError("xet-read-token: HTTP 503", 503);
      return tokenAt(n, 0);
    });
    await expect(source.token()).rejects.toThrow(/503/);
    expect((await source.token()).accessToken).toBe("t2");
  });

  it("fetchReconstruction: a 401 renews the token and asks again, once", async () => {
    let issued = 0;
    const source = xetTokenSource(async () => tokenAt(++issued, 0));
    const auth: string[] = [];
    const f = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const a = new Headers(init?.headers).get("authorization") ?? "";
      auth.push(a);
      return a === "Bearer t1"
        ? new Response("expired", { status: 401 })
        : Response.json({ offset_into_first_range: 0, terms: [], xorbs: {} });
    }) as typeof fetch;
    await fetchReconstruction({ token: source, fileHash: "ab", fetch: f });
    expect(auth).toEqual(["Bearer t1", "Bearer t2"]);
    // a CAS that refuses every token: one renewal, then the 401 stands
    let calls = 0;
    const never = (async () => {
      calls++;
      return new Response("no", { status: 401 });
    }) as typeof fetch;
    await expect(
      fetchReconstruction({ token: source, fileHash: "ab", version: 2, fetch: never }),
    ).rejects.toThrow(/401/);
    expect(calls).toBe(2);
    // a fixed token is not renewed
    calls = 0;
    await expect(
      fetchReconstruction({ token: tokenAt(9, 0), fileHash: "ab", version: 2, fetch: never }),
    ).rejects.toThrow(XetHttpError);
    expect(calls).toBe(1);
  });

  it("httpRanges: a URL refused with 403 is replaced once; a second refusal stands", async () => {
    const data = new Uint8Array(50_000).map((_, i) => i & 0xff);
    const asked: string[] = [];
    let cut = true;
    const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      asked.push(`${url} ${new Headers(init?.headers).get("range")}`);
      if (url === "https://cdn/old" && !cut) return new Response("expired", { status: 403 });
      if (url === "https://cdn/old") {
        cut = false;
        return rangedResponse(data, new Headers(init?.headers).get("range"), { cutAfter: 20_000 });
      }
      return rangedResponse(data, new Headers(init?.headers).get("range"));
    }) as typeof fetch;
    const refreshed: string[] = [];
    const got = await collect(
      httpRanges({
        fetch: f,
        backoffMs: 1,
        refreshUrl: async (url, start, end) => {
          refreshed.push(`${url} ${start}-${end}`);
          return "https://cdn/new";
        },
      })("https://cdn/old", 1000, 39_999),
    );
    expect(got.equals(Buffer.from(data.subarray(1000, 40_000)))).toBe(true);
    expect(refreshed).toEqual(["https://cdn/old 1000-39999"]);
    expect(asked).toEqual([
      "https://cdn/old bytes=1000-39999",
      "https://cdn/old bytes=21000-39999",
      "https://cdn/new bytes=21000-39999",
    ]);
    const denied = (async () => new Response("no", { status: 403 })) as typeof fetch;
    let asks = 0;
    await expect(
      collect(
        httpRanges({
          fetch: denied,
          refreshUrl: async () => {
            asks++;
            return "https://cdn/other";
          },
        })("https://cdn/old", 0, 9),
      ),
    ).rejects.toThrow(/403/);
    expect(asks).toBe(1);
  });

  it("downloadXetFile: an expired xorb URL is replaced from a new reconstruction answer", async () => {
    const data = syntheticData(400_000, 23);
    const { refs, xorb } = await syntheticXorb(data);
    const X = hashToString(xorbHash(refs));
    const F = hashToString(fileHash(refs));
    let answers = 0;
    const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/xet-read-token/main"))
        return Response.json({ casUrl: "https://cas.test", accessToken: "t", exp: 0 });
      if (url.startsWith("https://cas.test/v2/reconstructions/")) {
        answers++;
        return Response.json({
          offset_into_first_range: 0,
          terms: [{ hash: X, unpacked_length: data.length, range: { start: 0, end: refs.length } }],
          xorbs: {
            [X]: [
              {
                url: `https://cdn.test/x?sig=${answers}`,
                ranges: [
                  {
                    chunks: { start: 0, end: refs.length },
                    bytes: { start: 0, end: xorb.length - 1 },
                  },
                ],
              },
            ],
          },
        });
      }
      if (url === "https://cdn.test/x?sig=1") return new Response("expired", { status: 403 });
      if (url === "https://cdn.test/x?sig=2")
        return rangedResponse(xorb, new Headers(init?.headers).get("range"));
      return new Response("?", { status: 404 });
    }) as typeof fetch;
    const got = await collect(downloadXetFile({ repo: "a/b", fetch: f }, "f.bin", { xetHash: F }));
    expect(got.equals(Buffer.from(data))).toBe(true);
    expect(answers).toBe(2);
  });
});
