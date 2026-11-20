/**
 * An idle timeout for duplex connections: how long the client waits for the server.
 */

import { TransportError } from "../protocol/index.js";

/** The error an aborted signal fails a wait with: its reason, or a TransportError. */
export function abortErrorOf(signal: AbortSignal, message: string): Error {
  return signal.reason instanceof Error ? signal.reason : new TransportError(message);
}

/**
 * An idle timeout on the server: each wait, and each {@link touch}, re-arms it; {@link pause}
 * stops it while the client itself is busy. When it fires the pending wait fails with "Request
 * timeout" and `onExpire` runs (aborting the requests, closing the duplex). An aborted `signal`
 * fails the pending wait too.
 *
 * @internal shared by the duplex connections of fetch and push
 */
export class IdleTimer {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private reject: ((error: Error) => void) | undefined;
  private expired = false;

  constructor(
    private readonly timeout: number | undefined,
    private readonly onExpire: () => void,
    private readonly signal?: AbortSignal,
    private readonly abortMessage = "Aborted",
  ) {}

  touch(): void {
    if (!this.timeout || !this.reject) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.expired = true;
      this.reject?.(new TransportError("Request timeout"));
      this.onExpire();
    }, this.timeout);
  }

  pause(): void {
    clearTimeout(this.timer);
  }

  /**
   * `chunks` with the timer paused while each is produced here, and re-armed while each waits
   * for the server to take it (and after the last).
   */
  async *serverPaced(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
    const iterator = chunks[Symbol.asyncIterator]();
    try {
      while (true) {
        this.pause();
        const next = await iterator.next();
        this.touch();
        if (next.done) return;
        yield next.value;
      }
    } finally {
      this.touch();
      await iterator.return?.();
    }
  }

  async wait<T>(next: () => Promise<T>): Promise<T> {
    const { signal } = this;
    if (!this.timeout && !signal) return next();
    if (signal?.aborted) throw abortErrorOf(signal, this.abortMessage);
    let onAbort: (() => void) | undefined;
    const stopped = new Promise<never>((_, reject) => {
      this.reject = reject;
      if (signal) {
        onAbort = () => reject(abortErrorOf(signal, this.abortMessage));
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
    this.touch();
    try {
      return await Promise.race([next(), stopped]);
    } catch (error) {
      if (this.expired) throw new TransportError("Request timeout");
      throw error;
    } finally {
      clearTimeout(this.timer);
      this.reject = undefined;
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
  }
}
