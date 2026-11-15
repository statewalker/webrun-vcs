/**
 * Random ids built from `crypto.getRandomValues`, which every browser origin
 * and server runtime has (`crypto.randomUUID` is missing on non-secure
 * browser origins, such as a page served over plain http from a LAN address).
 */

/**
 * `bytes` random bytes as lowercase hex (32 characters by default).
 *
 * @example
 * ```typescript
 * const tmp = `tmp_${randomHexId()}`; // "tmp_9f86d081884c7d659a2feaa0c55ad015"
 * ```
 */
export function randomHexId(bytes = 16): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  let out = "";
  for (const b of buf) out += b.toString(16).padStart(2, "0");
  return out;
}

const STAMPED = /^([0-9a-z]{1,11})-[0-9a-f]{32}$/;

/**
 * A random id that records when it was made: `<ms since epoch, base 36>-<randomHexId()>`.
 * Stores name temporaries with it so a sweep can tell an old leftover from a
 * write still in progress (`timestampOfId`).
 *
 * @example
 * ```typescript
 * const token = timestampedId();      // "lq3k9x2a-0f3c..."
 * timestampOfId(token);               // Date.now() when it was made
 * ```
 */
export function timestampedId(now: number = Date.now()): string {
  return `${Math.max(0, Math.floor(now)).toString(36)}-${randomHexId()}`;
}

/** The creation time of a `timestampedId`, or `undefined` for any other string. */
export function timestampOfId(id: string): number | undefined {
  const m = STAMPED.exec(id);
  if (!m) return undefined;
  const t = Number.parseInt(m[1] as string, 36);
  return Number.isSafeInteger(t) ? t : undefined;
}
