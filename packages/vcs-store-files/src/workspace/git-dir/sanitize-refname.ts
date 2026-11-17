/**
 * git's `sanitize_refname_component`: a name made usable as one ref component, as
 * `git worktree add` names a worktree's administrative directory after the path's last
 * component.
 *
 * @example
 * ```typescript
 * sanitizeRefnameComponent("a b"); // "a-b"
 * sanitizeRefnameComponent(".x"); // "-x"
 * sanitizeRefnameComponent("x.lock"); // "x"
 * sanitizeRefnameComponent("a..b"); // "a.b"
 * sanitizeRefnameComponent("a@{b"); // "a@-b"
 * ```
 *
 * Each character's disposition is git's `refname_disposition`: control characters, space,
 * `:`, `?`, `[`, `\`, `^`, `~`, DEL and `*` become `-`; `..` collapses to `.`; `@{` becomes
 * `@-`; a leading `.` becomes `-`; a trailing `.lock` (repeated) goes. A trailing `.` stays
 * (git leaves it). Bytes above 0x7f are kept. A `/` separates components, as in git (a
 * path's last component has none).
 *
 * @module
 */

const LOCK = ".lock";

/** git's refname_disposition: 1 end of component, 2 `.`, 3 `{`, 4 bad, 5 `*`, 0 fine. */
function disposition(code: number): number {
  if (code === 0x2f) return 1;
  if (code < 0x20 || code === 0x7f) return 4;
  switch (code) {
    case 0x2e:
      return 2;
    case 0x7b:
      return 3;
    case 0x20:
    case 0x3a:
    case 0x3f:
    case 0x5b:
    case 0x5c:
    case 0x5e:
    case 0x7e:
      return 4;
    case 0x2a:
      return 5;
    default:
      return 0;
  }
}

/** One component (`check_refname_component` with a sanitized buffer): its length in `name`. */
function sanitizeComponent(name: string, start: number, out: string[]): number {
  const componentStart = out.length;
  let last = "";
  let i = start;
  for (; i < name.length; i++) {
    const ch = name[i];
    const disp = disposition(ch.charCodeAt(0));
    if (disp === 1) break;
    out.push(ch);
    if (disp === 2 && last === ".") out.pop();
    else if (disp === 3 && last === "@") out[out.length - 1] = "-";
    else if (disp === 4 || disp === 5) out[out.length - 1] = "-";
    last = ch;
  }
  const length = i - start;
  if (length === 0) return 0;
  if (name[start] === ".") out[componentStart] = "-";
  if (length >= LOCK.length && name.slice(i - LOCK.length, i) === LOCK) {
    // ".lock.lock" loses both
    while (
      out.length - componentStart >= LOCK.length &&
      out.slice(-LOCK.length).join("") === LOCK
    ) {
      out.length -= LOCK.length;
    }
  }
  return length;
}

/** `name` sanitized as git's `sanitize_refname_component` sanitizes it. */
export function sanitizeRefnameComponent(name: string): string {
  // characters of the UTF-16 string: a byte above 0x7f is fine in git, as any non-ASCII here
  const out: string[] = [];
  if (name === "@") out.push("-");
  let pos = 0;
  for (;;) {
    if (out.length > 0 && out[out.length - 1] !== "/") out.push("/");
    const length = sanitizeComponent(name, pos, out);
    if (pos + length >= name.length) break;
    pos += length + 1;
  }
  // an empty last component leaves the separator pushed for it
  while (out.length > 0 && out[out.length - 1] === "/") out.pop();
  return out.join("");
}
