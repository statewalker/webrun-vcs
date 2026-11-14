/**
 * Sending a pack from upload-pack (protocol v0/v1 `SEND_PACK` and the v2 `packfile` section).
 *
 * With side-band, the pack goes on band 1, an error on band 3 (`ERR <message>`), so the client
 * sees a failure in band even after the first pack byte. Until the first pack byte (while the
 * pack is prepared: listing objects, reading headers, the delta search) a keep-alive, an empty
 * band-1 packet `0005\x01`, is sent every `keepAliveMs`, as git's upload-pack does with
 * `uploadpack.keepAlive`, so proxies do not time the connection out.
 *
 * Without side-band there is no way to report an error once raw pack bytes are out: the result
 * says the stream must be broken (`inBand: false`) so the caller aborts the connection instead
 * of ending a truncated pack as if it were complete.
 */

import type { TransportApi } from "../../api/transport-api.js";

/** The default keep-alive interval (git's `uploadpack.keepAlive` is 5 seconds). */
export const DEFAULT_KEEP_ALIVE_MS = 5000;

/** An empty band-1 packet: git's side-band keep-alive (`0005\x01`). */
const KEEP_ALIVE_PAYLOAD = new Uint8Array([1]);

const textEncoder = new TextEncoder();

/** Options of `sendPackStream`. */
export interface SendPackStreamOptions {
  /** Whether the client asked for side-band-64k (v2: always, for the packfile section). */
  sideband: boolean;
  /** Send progress on band 2 (side-band only; off when the client sent `no-progress`). */
  progress?: boolean;
  /** Keep-alive interval until the first pack byte, side-band only (0: none). Default 5000. */
  keepAliveMs?: number;
}

/** What `sendPackStream` did. */
export type SendPackStreamResult =
  | { ok: true; bytes: number }
  | {
      ok: false;
      error: string;
      /** Whether the client was told in band (band 3); if not, the caller breaks the stream. */
      inBand: boolean;
    };

/**
 * Writes `pack` to `transport`: on band 1 with keep-alives and errors on band 3 when `sideband`,
 * otherwise raw.
 *
 * @example
 * ```typescript
 * const result = await sendPackStream(transport, repository.exportPack(wants, haves), {
 *   sideband: true,
 *   progress: !noProgress,
 * });
 * if (!result.ok && !result.inBand) abortConnection(result.error);
 * ```
 */
export async function sendPackStream(
  transport: TransportApi,
  pack: AsyncIterable<Uint8Array>,
  options: SendPackStreamOptions,
): Promise<SendPackStreamResult> {
  if (!options.sideband) {
    let bytes = 0;
    async function* counted(): AsyncGenerator<Uint8Array> {
      for await (const chunk of pack) {
        bytes += chunk.length;
        yield chunk;
      }
    }
    try {
      // writePack writes raw bytes when the state has no side-band-64k (this case)
      await transport.writePack(counted());
      return { ok: true, bytes };
    } catch (error) {
      return { ok: false, error: String(error), inBand: false };
    }
  }

  const keepAliveMs = options.keepAliveMs ?? DEFAULT_KEEP_ALIVE_MS;
  let bytes = 0;
  const it = pack[Symbol.asyncIterator]();
  try {
    let result = await firstChunk(it.next(), keepAliveMs, () =>
      transport.writePktLine(KEEP_ALIVE_PAYLOAD),
    );
    while (!result.done) {
      const chunk = result.value;
      await transport.writeSideband(1, chunk);
      if (options.progress) {
        await transport.writeSideband(2, textEncoder.encode(`Sending objects: ${bytes}\r`));
      }
      bytes += chunk.length;
      result = await it.next();
    }
    await transport.writeFlush();
    return { ok: true, bytes };
  } catch (error) {
    // The client went away (a write failed): end the pack source so its readers are released.
    // Not awaited: a read still pending (keep-alive path) settles first, then it closes.
    void Promise.resolve(it.return?.())?.catch(() => {});
    try {
      await transport.writeSideband(3, textEncoder.encode(`ERR ${error}`));
      await transport.writeFlush();
      return { ok: false, error: String(error), inBand: true };
    } catch {
      return { ok: false, error: String(error), inBand: false };
    }
  }
}

/** Waits for `next`, calling `keepAlive` every `intervalMs` until it settles (0: no keep-alive). */
async function firstChunk<T>(
  next: Promise<T>,
  intervalMs: number,
  keepAlive: () => Promise<void>,
): Promise<T> {
  if (intervalMs <= 0) return next;
  // settled while a keep-alive is written: not an unhandled rejection, raced below
  next.catch(() => {});
  while (true) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = new Promise<typeof TICK>((resolve) => {
      timer = setTimeout(() => resolve(TICK), intervalMs);
    });
    try {
      const winner = await Promise.race([next, tick]);
      if (winner !== TICK) return winner as T;
    } finally {
      clearTimeout(timer);
    }
    await keepAlive();
  }
}

const TICK: unique symbol = Symbol("keep-alive tick");
