/**
 * git's ref-name rules and ref order.
 *
 * The rules are refs.c's check_refname_format, as `git check-ref-format`
 * applies them: a name is `/`-separated components; a component may not be
 * empty, start with `.`, contain `..` or `@{`, end with `.lock`, or contain a
 * control character, DEL, space or any of `~ ^ : ? [ \ *`. The whole name may
 * not be `@` or end with `.`, and needs two components unless one level is
 * allowed. Non-ASCII characters are allowed.
 */

const FORBIDDEN = new Set([" ", "~", "^", ":", "?", "[", "\\", "*", "\u007f"]);

function badComponent(component: string): boolean {
  if (component.length === 0 || component.startsWith(".") || component.endsWith(".lock")) {
    return true;
  }
  let prev = "";
  for (const ch of component) {
    if ((ch.codePointAt(0) ?? 0) < 0x20 || FORBIDDEN.has(ch)) return true;
    if (ch === "." && prev === ".") return true;
    if (ch === "{" && prev === "@") return true;
    prev = ch;
  }
  return false;
}

export interface RefNameOptions {
  /** Accept a single component such as `HEAD` or `main` (`--allow-onelevel`). */
  allowOneLevel?: boolean;
}

/**
 * Whether `name` is a valid full ref name, exactly as `git check-ref-format`
 * decides it.
 *
 * @example
 * ```typescript
 * isValidRefName("refs/heads/feature/x"); // true
 * isValidRefName("refs/heads/.hidden");   // false: a component starts with "."
 * isValidRefName("main");                 // false: one level
 * isValidRefName("main", { allowOneLevel: true }); // true
 * ```
 */
export function isValidRefName(name: string, options: RefNameOptions = {}): boolean {
  if (name === "@" || name.endsWith(".")) return false;
  const parts = name.split("/");
  if (parts.some(badComponent)) return false;
  return options.allowOneLevel === true || parts.length >= 2;
}

/**
 * Compare two ref names in git's order: the byte order of their UTF-8
 * encodings, which is code-point order (uppercase before lowercase, non-ASCII
 * last). Unlike `localeCompare` and plain `<` (UTF-16 units), it matches the
 * order git lists refs and writes packed-refs in.
 *
 * @example
 * ```typescript
 * ["refs/heads/a", "refs/heads/B"].sort(compareRefNames); // ["refs/heads/B", "refs/heads/a"]
 * ```
 */
export function compareRefNames(a: string, b: string): number {
  const ai = a[Symbol.iterator]();
  const bi = b[Symbol.iterator]();
  for (;;) {
    const x = ai.next();
    const y = bi.next();
    if (x.done || y.done) return x.done === y.done ? 0 : x.done ? -1 : 1;
    const d = (x.value.codePointAt(0) ?? 0) - (y.value.codePointAt(0) ?? 0);
    if (d !== 0) return d;
  }
}
