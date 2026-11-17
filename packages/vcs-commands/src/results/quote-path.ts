/**
 * Path quoting as git prints paths (`quote.c`'s `quote_c_style`): a path with a control
 * character, `"` or `\`, or (with `core.quotePath`, the default) a byte above 0x7f, is put in
 * double quotes with C escapes.
 *
 * @example
 * ```typescript
 * quotePath("plain.txt"); // "plain.txt"
 * quotePath("tab\there"); // "\"tab\\there\""
 * quotePath("é.txt"); // "\"\\303\\251.txt\""
 * ```
 *
 * @module
 */

const encoder = new TextEncoder();

/** `cq_lookup` of quote.c: the escape letter, 1 for an octal escape, -1 for none */
function lookup(ch: number): number | string {
  if (ch >= 0x80) return 0;
  switch (ch) {
    case 0x07:
      return "a";
    case 0x08:
      return "b";
    case 0x09:
      return "t";
    case 0x0a:
      return "n";
    case 0x0b:
      return "v";
    case 0x0c:
      return "f";
    case 0x0d:
      return "r";
    case 0x22:
      return '"';
    case 0x5c:
      return "\\";
    case 0x7f:
      return 1;
  }
  return ch < 0x20 ? 1 : -1;
}

function mustQuote(ch: number, quotePathFully: boolean): boolean {
  const v = lookup(ch);
  if (typeof v === "string") return true;
  return v + (quotePathFully ? 1 : 0) > 0;
}

/**
 * The bytes of `path` quoted as `quote_c_style` quotes them, without the double quotes;
 * undefined when the path needs no quoting.
 */
export function quoteCStyleBody(
  path: string | Uint8Array,
  quotePathFully = true,
): string | undefined {
  const bytes = typeof path === "string" ? encoder.encode(path) : path;
  let needs = false;
  for (const b of bytes) {
    if (mustQuote(b, quotePathFully)) {
      needs = true;
      break;
    }
  }
  if (!needs) return undefined;
  let out = "";
  let run: number[] = [];
  const flush = () => {
    if (run.length > 0) {
      out += new TextDecoder().decode(new Uint8Array(run));
      run = [];
    }
  };
  for (const b of bytes) {
    if (!mustQuote(b, quotePathFully)) {
      run.push(b);
      continue;
    }
    flush();
    const v = lookup(b);
    if (typeof v === "string") out += `\\${v}`;
    else out += `\\${(b >> 6) & 3}${(b >> 3) & 7}${b & 7}`;
  }
  flush();
  return out;
}

/** `path` as git prints it: in double quotes with C escapes when it needs quoting */
export function quotePath(path: string, quotePathFully = true): string {
  const body = quoteCStyleBody(path, quotePathFully);
  return body === undefined ? path : `"${body}"`;
}

/**
 * git's `quote_two_c_style`: `prefix` and `path` as they are, or both escaped inside one pair
 * of quotes when either needs quoting
 */
export function quoteTwo(prefix: string, path: string, quotePathFully = true): string {
  return quotePath(`${prefix}${path}`, quotePathFully);
}
