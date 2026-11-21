/**
 * Sending a pack from upload-pack (protocol v0/v1 `SEND_PACK` and the v2 `packfile` section).
 *
 * With side-band, the pack goes on band 1 in frames as full as the side-band allows (65515
 * payload bytes with side-band-64k, 995 with side-band: 65520- and 1000-byte packets, as git's
 * upload-pack), whatever the chunking of the pack source; at most one frame is held, and a
 * partial one is sent when the source stalls for `keepAliveMs`. An error goes on band 3
 * (`ERR <message>`), so the client
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
import { PACK_OBJECTS_ABORT, PackObjectsError } from "./pack-objects-error.js";

/** The default keep-alive interval (git's `uploadpack.keepAlive` is 5 seconds). */
export const DEFAULT_KEEP_ALIVE_MS = 5000;

/** The payload of a full side-band-64k packet (65520 bytes with the length and band byte). */
export const SIDEBAND_64K_MAX_PAYLOAD = 65515;

/** The payload of a full plain side-band packet (1000 bytes with the length and band byte). */
export const SIDEBAND_MAX_PAYLOAD = 995;

/** An empty band-1 packet: git's side-band keep-alive (`0005\x01`). */
const KEEP_ALIVE_PAYLOAD = new Uint8Array([1]);

const textEncoder = new TextEncoder();

/** Options of `sendPackStream`. */
export interface SendPackStreamOptions {
  /** Whether the client asked for side-band-64k (v2: always, for the packfile section). */
  sideband: boolean;
  /** Send progress on band 2 (side-band only; off when the client sent `no-progress`). */
  progress?: boolean;
  /**
   * Keep-alive interval until the first pack byte, side-band only (0: none). Default 5000.
   * After it, a partial frame is sent when the pack source gives nothing for this long.
   */
  keepAliveMs?: number;
  /**
   * Largest band-1 payload: {@link SIDEBAND_64K_MAX_PAYLOAD} (default) for side-band-64k,
   * {@link SIDEBAND_MAX_PAYLOAD} for plain side-band.
   */
  maxPayload?: number;
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
  const maxPayload = Math.max(
    1,
    Math.min(options.maxPayload ?? SIDEBAND_64K_MAX_PAYLOAD, SIDEBAND_64K_MAX_PAYLOAD),
  );
  // one frame, filled from the pack chunks and sent when full (or at the end)
  const frame = new Uint8Array(maxPayload);
  let fill = 0;
  let bytes = 0;
  let sent = 0;
  const sendFrame = async (data: Uint8Array) => {
    // writeSideband copies the payload into the packet: the frame buffer can be refilled
    await transport.writeSideband(1, data);
    sent += data.length;
    if (options.progress) {
      await transport.writeSideband(2, textEncoder.encode(`Sending objects: ${sent}\r`));
    }
  };
  const flushFrame = async () => {
    if (fill === 0) return;
    const data = frame.subarray(0, fill);
    fill = 0;
    await sendFrame(data);
  };
  const append = async (chunk: Uint8Array) => {
    let offset = 0;
    while (offset < chunk.length) {
      // whole frames straight from the chunk when nothing is held
      if (fill === 0 && chunk.length - offset >= maxPayload) {
        await sendFrame(chunk.subarray(offset, offset + maxPayload));
        offset += maxPayload;
        continue;
      }
      const n = Math.min(maxPayload - fill, chunk.length - offset);
      frame.set(chunk.subarray(offset, offset + n), fill);
      fill += n;
      offset += n;
      if (fill === maxPayload) await flushFrame();
    }
  };

  const it = pack[Symbol.asyncIterator]();
  try {
    let result = await firstChunk(it.next(), keepAliveMs, () =>
      transport.writePktLine(KEEP_ALIVE_PAYLOAD),
    );
    while (!result.done) {
      bytes += result.value.length;
      await append(result.value);
      // a stalled source does not hold a partial frame back
      result = await firstChunk(it.next(), keepAliveMs, flushFrame);
    }
    await flushFrame();
    await transport.writeFlush();
    return { ok: true, bytes };
  } catch (error) {
    // The client went away (a write failed): end the pack source so its readers are released.
    // Not awaited: a read still pending (keep-alive path) settles first, then it closes.
    void Promise.resolve(it.return?.())?.catch(() => {});
    try {
      if (error instanceof PackObjectsError) {
        // create_pack_file: pack-objects' stderr (its warnings, then its death) on the
        // progress band, then the abort
        for (const line of error.lines) {
          await transport.writeSideband(2, textEncoder.encode(`${line}\n`));
        }
        await transport.writeSideband(2, textEncoder.encode(`fatal: ${error.message}\n`));
        // sent with its NUL, as git's sizeof(abort_msg)
        await transport.writeSideband(3, textEncoder.encode(`${PACK_OBJECTS_ABORT}\0`));
        await transport.writeFlush();
        return { ok: false, error: `fatal: ${error.message}`, inBand: true };
      }
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
