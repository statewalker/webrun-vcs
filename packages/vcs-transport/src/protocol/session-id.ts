/**
 * The session id this process names itself by (git's trace2 session id, which
 * `transfer.advertiseSID` sends as `session-id=<id>`): made once, on first use, in git's shape
 * (`<UTC time>-H<hex>`, no space or newline).
 *
 * @example
 * ```ts
 * processSessionId(); // "20261125T101500.123000Z-H5f2c9a01"
 * ```
 */
let sessionId: string | undefined;

export function processSessionId(): string {
  if (sessionId !== undefined) return sessionId;
  const now = new Date();
  const two = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${now.getUTCFullYear()}${two(now.getUTCMonth() + 1)}${two(now.getUTCDate())}` +
    `T${two(now.getUTCHours())}${two(now.getUTCMinutes())}${two(now.getUTCSeconds())}` +
    `.${String(now.getUTCMilliseconds() * 1000).padStart(6, "0")}Z`;
  // only a process that advertises its id pays for the random bytes
  const random = new Uint8Array(4);
  crypto.getRandomValues(random);
  const hex = [...random].map((b) => b.toString(16).padStart(2, "0")).join("");
  sessionId = `${stamp}-H${hex}`;
  return sessionId;
}

/**
 * A session id as git sends it, or undefined when `value` cannot be one: `session-id=` values
 * travel inside space-separated capability lists, so a value with a space, a control
 * character or a NUL is refused.
 */
export function validSessionId(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) return undefined;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c <= 0x20 || c === 0x7f) return undefined;
  }
  return value;
}
