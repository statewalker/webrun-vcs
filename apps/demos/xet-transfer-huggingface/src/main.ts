/**
 * Demo: chunk-dedup transfer of REAL HuggingFace model bytes over our `xet`
 * custom-transfer agent, run as a LOOPBACK (our `serveXet` server <-> our xet
 * client), plus the basic-LFS fallback path.
 *
 * IMPORTANT — what "xet" means here. `@statewalker/vcs-transport-xet` is a Git
 * LFS *custom transfer agent* using OUR protocol: it negotiates a `xet` transfer
 * in the standard LFS batch, then moves only the MISSING chunks through
 * `@statewalker/webrun-content-transfer` (CDC chunk dedup). HuggingFace's production
 * Xet uses a DIFFERENT CAS protocol on the wire, so we cannot negotiate `xet`
 * against HF. This demo therefore uses REAL HF model bytes (fetched once via the
 * standard LFS basic transfer) but transfers them between two local
 * content-stores over OUR xet loopback — that is where the chunk dedup is shown.
 *
 * Steps:
 *   1. Fetch the real `pytorch_model.bin` bytes from HF once (standard LFS).
 *   2. Put them into a SOURCE content-store (CDC-chunked) and report the chunks.
 *   3. Pre-seed a DESTINATION store with a subset of those chunks, then
 *      `xetDownload` from `serveXet(source)`; spy the destination's `putChunk`
 *      to prove only the MISSING chunks moved, and re-verify the reconstructed
 *      object's whole-file SHA-256 == the HF oid.
 *   4. Show the basic-LFS fallback: the same `xetDownload` against a non-xet
 *      `serveLfs` server transparently moves the whole object and verifies.
 */

import { type LfsPointer, lfsDownload, serveLfs, sha256Hex } from "@statewalker/vcs-transport-lfs";
import { serveXet, xetDownload } from "@statewalker/vcs-transport-xet";
import {
  type ContentStore,
  collect,
  csHash,
  makeStore,
  memResolver,
  seedChunks,
  spyStore,
  streamOf,
} from "./lib.js";

const MODEL = "hf-internal-testing/tiny-random-gpt2";
const FILE = "pytorch_model.bin";
const POINTER_URL = `https://huggingface.co/${MODEL}/raw/main/${FILE}`;
const LFS_BASE_URL = `https://huggingface.co/${MODEL}.git/info/lfs`;
const LOOPBACK_URL = "http://xet.loopback";

function parsePointer(text: string): LfsPointer {
  const oidMatch = text.match(/^oid sha256:([0-9a-f]{64})$/m);
  const sizeMatch = text.match(/^size (\d+)$/m);
  if (!oidMatch || !sizeMatch) throw new Error(`not a Git-LFS pointer:\n${text}`);
  return { oid: oidMatch[1], size: Number(sizeMatch[1]) };
}

/** Fetch the real HF object once via the standard LFS basic transfer. */
async function fetchHfObject(): Promise<{ ptr: LfsPointer; bytes: Uint8Array }> {
  console.log(`[1] fetching real HF bytes (standard LFS)  ${MODEL}/${FILE}`);
  const ptrRes = await fetch(POINTER_URL);
  if (!ptrRes.ok)
    throw new Error(`failed to read pointer: HTTP ${ptrRes.status} (HF unreachable?)`);
  const ptr = parsePointer(await ptrRes.text());
  console.log(`    oid=sha256:${ptr.oid} size=${ptr.size}`);

  const hfStore = makeStore();
  const hfResolver = memResolver();
  for await (const event of lfsDownload(hfStore, hfResolver, LFS_BASE_URL, [ptr])) {
    if (event.type === "error") throw new Error(`HF LFS download failed: ${event.reason}`);
  }
  const id = await hfResolver.toObject(ptr.oid);
  if (!id) throw new Error("HF download produced no object");
  const bytes = await collect(hfStore.read(id));
  if ((await sha256Hex(bytes)) !== ptr.oid) throw new Error("HF bytes failed sha256 check");
  console.log(`    got ${bytes.length} bytes, sha256 verified\n`);
  return { ptr, bytes };
}

/** Put whole bytes into a store + record the oid->id mapping (CDC-chunks). */
async function seedObject(
  store: ContentStore,
  resolver: ReturnType<typeof memResolver>,
  bytes: Uint8Array,
  oid: string,
) {
  const { id } = await store.put(streamOf(bytes));
  await resolver.record(oid, id);
  return id;
}

async function main(): Promise<void> {
  console.log(`\n=== Xet chunk-dedup demo — our xet loopback over REAL HF bytes ===\n`);

  // 1 + 2. Real bytes into a CDC-chunked SOURCE store.
  const { ptr, bytes } = await fetchHfObject();

  const sourceStore = makeStore();
  const sourceResolver = memResolver();
  const sourceId = await seedObject(sourceStore, sourceResolver, bytes, ptr.oid);
  const manifest = await sourceStore.getManifest(sourceId);
  if (!manifest) throw new Error("no manifest for source object");
  // A CDC object can reference the same chunk more than once; dedup — both
  // inside the store and on the wire — is over the UNIQUE chunk ids.
  const uniqueChunks = [...new Set(manifest.chunks.map((c) => c.id))];
  console.log(
    `[2] source content-store: ${manifest.chunks.length} chunk refs → ${uniqueChunks.length} unique chunks`,
  );
  if (uniqueChunks.length < 2) throw new Error("object did not chunk — dedup would be trivial");

  // 3. Dedup over OUR xet loopback: pre-seed the destination with a subset.
  const seeded = uniqueChunks.slice(0, Math.floor(uniqueChunks.length * 0.6));
  const destStore = makeStore();
  const destResolver = memResolver();
  await seedChunks(sourceStore, destStore, seeded);
  console.log(`\n[3] xet transfer (loopback  serveXet <-> xetDownload)`);
  console.log(
    `    destination pre-seeded with ${seeded.length} of ${uniqueChunks.length} unique chunks`,
  );

  const { store: spiedDest, spy } = spyStore(destStore);
  const xetHandler = serveXet(sourceStore, sourceResolver);
  for await (const event of xetDownload(spiedDest, destResolver, LOOPBACK_URL, [ptr], {
    fetchImpl: xetHandler,
    hashContent: csHash,
  })) {
    if (event.type === "error") throw new Error(`xet transfer failed: ${event.reason}`);
  }

  const transferred = spy.putChunkIds.length;
  const expectedMoved = uniqueChunks.length - seeded.length;
  console.log(`    unique chunks:      ${uniqueChunks.length}`);
  console.log(`    already present:    ${seeded.length}`);
  console.log(
    `    chunks transferred: ${transferred}  (expected ${expectedMoved} — only the MISSING ones)`,
  );
  if (transferred !== expectedMoved)
    throw new Error(`dedup mismatch: moved ${transferred}, expected ${expectedMoved}`);
  if (transferred >= uniqueChunks.length) throw new Error("no dedup happened");
  for (const s of seeded) {
    if (spy.putChunkIds.includes(s)) throw new Error("a pre-seeded chunk was re-transferred");
  }

  const destId = await destResolver.toObject(ptr.oid);
  if (!destId) throw new Error("xet transfer produced no object mapping");
  const reconstructed = await collect(spiedDest.read(destId));
  const oidOk = (await sha256Hex(reconstructed)) === ptr.oid;
  const sizeOk = reconstructed.length === ptr.size;
  console.log(
    `    reconstructed:      ${reconstructed.length} bytes, sha256 ${oidOk ? "OK" : "MISMATCH"}, size ${sizeOk ? "OK" : "MISMATCH"}`,
  );
  if (!oidOk || !sizeOk) throw new Error("xet reconstruction failed verification");

  // 4. Basic-LFS fallback: a non-xet server → whole-object transfer.
  console.log(`\n[4] basic-LFS fallback (serveLfs advertises no xet)`);
  const fbStore = makeStore();
  const fbResolver = memResolver();
  const { store: spiedFb, spy: fbSpy } = spyStore(fbStore);
  const lfsHandler = serveLfs(sourceStore, sourceResolver);
  let fallbackDownloaded = false;
  for await (const event of xetDownload(spiedFb, fbResolver, LOOPBACK_URL, [ptr], {
    fetchImpl: lfsHandler,
    hashContent: csHash,
  })) {
    if (event.type === "object-downloaded") fallbackDownloaded = true;
    if (event.type === "error") throw new Error(`fallback failed: ${event.reason}`);
  }
  const fbId = await fbResolver.toObject(ptr.oid);
  if (!fallbackDownloaded || !fbId) throw new Error("fallback produced no object");
  const fbBytes = await collect(spiedFb.read(fbId));
  const fbOk = (await sha256Hex(fbBytes)) === ptr.oid && fbBytes.length === ptr.size;
  console.log(`    whole object moved via basic transfer, sha256 ${fbOk ? "OK" : "MISMATCH"}`);
  console.log(
    `    (no xet negotiation → 0 chunk-level putChunk calls; object stored whole via store.put)`,
  );
  if (fbSpy.putChunkIds.length !== 0)
    throw new Error("basic fallback unexpectedly used chunk-level transfer");
  if (!fbOk) throw new Error("fallback verification failed");

  console.log(`\n=== SUCCESS ===`);
  console.log(`model=${MODEL} file=${FILE} oid=sha256:${ptr.oid} size=${ptr.size}`);
  console.log(
    `xet dedup: ${transferred}/${uniqueChunks.length} unique chunks moved (${seeded.length} skipped); basic fallback verified.\n`,
  );
}

main().catch((err) => {
  console.error(`\n=== FAILED ===`);
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
