/**
 * Demo: download a REAL HuggingFace model object over the standard Git-LFS
 * batch + basic (whole-object) transfer, using `@statewalker/vcs-transport-lfs`,
 * and verify it by its whole-file SHA-256.
 *
 * This runs LIVE against huggingface.co (no mocks). The steps:
 *   1. Read the Git-LFS pointer for `pytorch_model.bin` from the HF repo and
 *      parse its `oid` (whole-file SHA-256) + `size`.
 *   2. `lfsDownload(...)` POSTs the standard LFS batch request to HF's real LFS
 *      endpoint, follows the returned `download` action href, streams the bytes
 *      into a content-store, and (inside the library) verifies SHA-256 == oid.
 *   3. Independently re-verify: whole-file SHA-256 of the stored bytes equals
 *      the pointer oid and the byte length equals the pointer size.
 */

import { createHash } from "node:crypto";
import {
  type LfsPointer,
  type LfsResolver,
  lfsDownload,
  sha256Hex,
} from "@statewalker/vcs-transport-lfs";
import { type ByteStream, createContentStore } from "@statewalker/webrun-content-store";
import { memBlobStore } from "@statewalker/webrun-storage";

/** The public test model + file used by this demo. */
const MODEL = "hf-internal-testing/tiny-random-gpt2";
const FILE = "pytorch_model.bin";
const POINTER_URL = `https://huggingface.co/${MODEL}/raw/main/${FILE}`;
/** `lfsDownload` appends `/objects/batch`, so this is the LFS base URL. */
const LFS_BASE_URL = `https://huggingface.co/${MODEL}.git/info/lfs`;

/** Content-store identity: opaque, algorithm-agnostic, prefixed so it never
 * collides with a bare LFS oid. */
async function contentHash(input: ByteStream): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of input) h.update(chunk);
  return `cs-sha256:${h.digest("hex")}`;
}

/** A `Map`-backed LFS-oid -> content-store-id resolver (no persistence). */
function memResolver(): LfsResolver {
  const map = new Map<string, string>();
  return {
    async toObject(oid) {
      return map.get(oid);
    },
    async record(oid, obj) {
      map.set(oid, obj);
    },
  };
}

async function collect(stream: ByteStream): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const chunk of stream) parts.push(chunk);
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Parse a Git-LFS v1 pointer file into `{ oid, size }`. */
function parsePointer(text: string): LfsPointer {
  const oidMatch = text.match(/^oid sha256:([0-9a-f]{64})$/m);
  const sizeMatch = text.match(/^size (\d+)$/m);
  if (!oidMatch || !sizeMatch) {
    throw new Error(`not a Git-LFS pointer:\n${text}`);
  }
  return { oid: oidMatch[1], size: Number(sizeMatch[1]) };
}

async function main(): Promise<void> {
  console.log(`\n=== LFS download demo — live against huggingface.co ===`);
  console.log(`model: ${MODEL}`);
  console.log(`file:  ${FILE}\n`);

  // 1. Read + parse the real Git-LFS pointer from the HF repo.
  console.log(`[1] reading LFS pointer  GET ${POINTER_URL}`);
  const ptrRes = await fetch(POINTER_URL);
  if (!ptrRes.ok) {
    throw new Error(`failed to read pointer: HTTP ${ptrRes.status} (HF unreachable?)`);
  }
  const pointerText = await ptrRes.text();
  const ptr = parsePointer(pointerText);
  console.log(`    oid:  sha256:${ptr.oid}`);
  console.log(`    size: ${ptr.size} bytes\n`);

  // 2. Download via the STANDARD Git-LFS batch + basic transfer into a
  //    content-store. fetchImpl defaults to global fetch → real HTTP to HF.
  const store = createContentStore(
    { chunks: memBlobStore(), manifests: memBlobStore(), hashContent: contentHash },
    // Chunk even this small object so the content-store exercises its CDC path.
    { chunkThreshold: 1024 },
  );
  const resolver = memResolver();

  console.log(`[2] LFS batch  POST ${LFS_BASE_URL}/objects/batch  (transfers: ["basic"])`);
  for await (const event of lfsDownload(store, resolver, LFS_BASE_URL, [ptr])) {
    if (event.type === "batch") {
      console.log(`    batch ok — server returned ${event.count} object action(s)`);
    } else if (event.type === "object-downloaded") {
      console.log(`    downloaded + sha256-verified by library: ${event.oid}`);
    } else if (event.type === "error") {
      throw new Error(`LFS transfer failed for ${event.oid}: ${event.reason}`);
    }
  }

  // 3. Independent verification against the pointer.
  console.log(`\n[3] verifying stored object`);
  const storedId = await resolver.toObject(ptr.oid);
  if (!storedId) throw new Error("resolver has no content-store id for the oid");
  if (!(await store.has(storedId))) throw new Error("object not present in content-store");

  const bytes = await collect(store.read(storedId));
  const actualOid = await sha256Hex(bytes);
  const sizeOk = bytes.length === ptr.size;
  const oidOk = actualOid === ptr.oid;

  console.log(`    content-store id: ${storedId}`);
  console.log(
    `    bytes read back:  ${bytes.length} (expected ${ptr.size}) — ${sizeOk ? "OK" : "MISMATCH"}`,
  );
  console.log(`    sha256:           ${actualOid}`);
  console.log(`    matches oid:      ${oidOk ? "OK" : "MISMATCH"}`);

  if (!sizeOk || !oidOk) throw new Error("verification failed");

  console.log(`\n=== SUCCESS ===`);
  console.log(`model=${MODEL} file=${FILE}`);
  console.log(`oid=sha256:${ptr.oid} size=${ptr.size} verified=true`);
  console.log(`Real object downloaded from HF via standard Git-LFS batch + basic transfer.\n`);
}

main().catch((err) => {
  console.error(`\n=== FAILED ===`);
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
