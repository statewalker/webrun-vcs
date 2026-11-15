import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type ChunkRef,
  chunkHash,
  chunkStream,
  downloadXetFile,
  fetchReconstruction,
  fileHash,
  hashFromString,
  hashToString,
  hubPathInfo,
  readShard,
  reconstruct,
  verifierFromShard,
  xetReadToken,
} from "../../src/index.js";
import {
  CSV,
  collect,
  fixture,
  fixtureBytes,
  REVISION,
  recordedAnswer,
  referenceXorb,
  SHARDS,
} from "./helpers.js";

// U9: the live Hub and CAS (huggingface.co), only with XET_LIVE=1 (never in CI).

describe.runIf(process.env.XET_LIVE === "1")("U9 the live Hub and CAS (XET_LIVE=1)", () => {
  const repo = {
    repo: "xet-team/xet-spec-reference-files",
    repoType: "dataset" as const,
    revision: REVISION,
  };

  it("the reference file downloaded and checked against its shard; v1 and v2 agree; a byte range", async () => {
    const fileHashString = fixture(`${CSV}.xet-file-hash`).trim();
    for (const version of [1, 2] as const) {
      const verify = verifierFromShard(
        readShard(fixtureBytes(SHARDS.verification)),
        hashFromString(fileHashString),
        {
          wholeFile: true,
        },
      );
      const got: ChunkRef[] = [];
      for await (const c of chunkStream(downloadXetFile(repo, CSV, { version, verify })))
        got.push({ hash: chunkHash(c), length: c.length });
      expect(hashToString(fileHash(got)), `v${version}`).toBe(fileHashString);
    }
    // a range: the answer's terms cover it, the bytes are the file's
    const token = await xetReadToken(repo);
    const narrowed = await fetchReconstruction({
      token,
      fileHash: fileHashString,
      range: { start: 140_000, end: 260_000 },
    });
    expect(narrowed.terms.length).toBeGreaterThan(0);
    const part = await collect(
      downloadXetFile(repo, CSV, { range: { start: 140_000, end: 260_000 } }),
    );
    expect(part.length).toBe(120_001);
    // against the same bytes rebuilt locally from the reference xorb (another path entirely)
    const xorb = referenceXorb();
    const answer = recordedAnswer();
    const local = await collect(
      reconstruct(
        answer,
        async function* (_u, a, b) {
          yield xorb.subarray(a, b + 1);
        },
        { length: 260_001 },
      ),
    );
    expect(part.equals(local.subarray(140_000, 260_001))).toBe(true);
    // the whole file against the Hub's SHA-256 of it
    const info = await hubPathInfo(repo, CSV);
    const h = createHash("sha256");
    for await (const p of downloadXetFile(repo, CSV)) h.update(p);
    expect(h.digest("hex")).toBe(info.sha256);
  }, 600_000);
});
