/**
 * NodeFilesApi whose `write` streams each chunk to the file. The published
 * `@statewalker/webrun-files-node` (0.10) collects every chunk before
 * `fs.writeFile`, so writing a 500 MB object would cost 500 MB of memory.
 * Until that is fixed upstream, this class keeps writes bounded.
 */
import { mkdir, open, rename, rm } from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";
import { NodeFilesApi } from "@statewalker/webrun-files-node";

/** Small chunks are gathered up to this size before each write call. */
const WRITE_BATCH = 64 * 1024;

export class StreamingNodeFilesApi extends NodeFilesApi {
  readonly #root: string;

  constructor(options: { rootDir: string }) {
    super(options);
    this.#root = resolve(options.rootDir);
  }

  /** As NodeFilesApi resolves paths: `..` that would leave the root is refused. */
  #real(path: string): string {
    const segments = path.split("/").filter((s) => !!s && s !== ".");
    const real = resolve(this.#root, `./${segments.join("/")}`);
    if (real !== this.#root && !real.startsWith(this.#root + sep)) {
      throw new Error(`NodeFilesApi: path is outside rootDir: ${path}`);
    }
    return real;
  }

  /**
   * Write `content` chunk by chunk, creating parent directories. Memory stays
   * at about one chunk. The bytes go to a temporary next to the file, renamed
   * over it once the content has ended: a source that fails leaves the old
   * file as it was (as NodeFilesApi, which collects the content first), and a
   * file may be rewritten from its own `read`. Like git with its default
   * `core.fsync`, writes are not fsynced.
   */
  override async write(
    path: string,
    content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  ): Promise<void> {
    const real = this.#real(path);
    await mkdir(dirname(real), { recursive: true });
    // A dot-name: git skips those when it lists refs or objects (no ref or object
    // name starts with "."), so a write in flight is never taken for one.
    const tmp = resolve(dirname(real), `.${basename(real)}.${crypto.randomUUID()}.tmp`);
    const fh = await open(tmp, "wx");
    let done = false;
    try {
      let batch: Uint8Array[] = [];
      let batched = 0;
      const flush = async () => {
        if (batched === 0) return;
        const bytes = batch.length === 1 ? (batch[0] as Uint8Array) : Buffer.concat(batch);
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesWritten } = await fh.write(bytes, offset, bytes.length - offset);
          offset += bytesWritten;
        }
        batch = [];
        batched = 0;
      };
      for await (const chunk of content) {
        batch.push(chunk);
        batched += chunk.length;
        if (batched >= WRITE_BATCH) await flush();
      }
      await flush();
      await fh.close();
      await rename(tmp, real);
      done = true;
    } finally {
      if (!done) {
        await fh.close().catch(() => {});
        await rm(tmp, { force: true }).catch(() => {});
      }
    }
  }
}
