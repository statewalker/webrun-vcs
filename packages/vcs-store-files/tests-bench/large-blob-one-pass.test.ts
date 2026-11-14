/**
 * A large blob goes through the object kernel in one pass with bounded memory:
 * the source is read once, live memory stays under 64 MB whatever the size,
 * and native git reads the result. Run with `pnpm test:bench`
 * (BIG_BLOB_MB sets the size, default 200).
 *
 * The NodeFilesApi of webrun-files-node 0.10 collects a file before writing it,
 * so this benchmark brings its own streaming FilesApi (test code only); the
 * library side, up to FilesApi.write, is what is measured.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, open, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { afterAll, describe, expect, it } from "vitest";
import { createGitFilesBackend } from "../src/index.js";

const MiB = 2 ** 20;
const MB = Number(process.env.BIG_BLOB_MB ?? 200);
const forceGc = (globalThis as { gc?: () => void }).gc;
const live = () => {
  const m = process.memoryUsage();
  return m.heapUsed + m.arrayBuffers;
};

async function settle() {
  for (let i = 0; i < 3; i++) {
    forceGc?.();
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Incompressible pseudo-random megabytes (deterministic), counting passes. */
function randomSource(mb: number, counters: { passes: number; pulled: number }) {
  return {
    async *[Symbol.asyncIterator]() {
      counters.passes++;
      let x = 0x9e3779b9;
      for (let i = 0; i < mb; i++) {
        const chunk = new Uint8Array(MiB);
        const words = new Uint32Array(chunk.buffer);
        for (let j = 0; j < words.length; j++) {
          x ^= x << 13;
          x ^= x >>> 17;
          x ^= x << 5;
          words[j] = x >>> 0;
        }
        counters.pulled += chunk.length;
        yield chunk;
      }
    },
  };
}

/** NodeFilesApi whose write streams chunk by chunk (to a temporary, then renamed). */
class StreamingFilesApi extends NodeFilesApi {
  constructor(private readonly root: string) {
    super({ rootDir: root });
  }
  override async write(
    path: string,
    content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  ): Promise<void> {
    const real = join(this.root, path);
    await mkdir(dirname(real), { recursive: true });
    const tmp = `${real}.bench-tmp`;
    const fh = await open(tmp, "w");
    try {
      for await (const chunk of content) await fh.write(chunk);
    } finally {
      await fh.close();
    }
    await rename(tmp, real);
  }
}

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("one pass over a large blob", () => {
  it(`stores ${MB} MB with live memory growing < 64 MB, read once, and git agrees`, async () => {
    expect(forceGc, "run with --expose-gc (pnpm test:bench)").toBeTypeOf("function");
    const dir = mkdtempSync(join(tmpdir(), "big-blob-"));
    dirs.push(dir);
    execFileSync("git", ["init", "-q", dir]);
    const { history } = await createGitFilesBackend({
      files: new StreamingFilesApi(dir),
    });
    const counters = { passes: 0, pulled: 0 };

    await settle();
    const base = live();
    let peak = 0;
    const sample = () => {
      forceGc?.();
      peak = Math.max(peak, live() - base);
    };
    const timer = setInterval(sample, 100);
    let id: string;
    try {
      id = await history.blobs.store(randomSource(MB, counters), MB * MiB);
      sample();
    } finally {
      clearInterval(timer);
    }

    expect(counters.passes).toBe(1);
    expect(counters.pulled).toBe(MB * MiB);
    expect(peak).toBeLessThan(64 * MiB);
    const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
    expect(
      execFileSync("git", ["cat-file", "-s", id], { cwd: dir, env, encoding: "utf8" }).trim(),
    ).toBe(String(MB * MiB));
    execFileSync("git", ["fsck", "--full"], { cwd: dir, env });
  });
});
