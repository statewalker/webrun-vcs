/**
 * git's ref-name rules and ref order.
 *
 * The rules are refs.c's check_refname_format, as `git check-ref-format`
 * applies them: a name is `/`-separated components; a component may not be
 * empty, start with `.`, contain `..` or `@{`, end with `.lock`, or contain a
 * control character, DEL, space or any of `~ ^ : ? [ \ *`. The whole name may
 * not be `@` or end with `.`, and needs two components unless one level is
 * allowed. Non-ASCII characters are allowed; a lone UTF-16 surrogate is not,
 * since it has no UTF-8 encoding (it would be written as U+FFFD, another name).
 */

const LONE_SURROGATE = /\p{Cs}/u;
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
  if (name === "@" || name.endsWith(".") || LONE_SURROGATE.test(name)) return false;
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
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    let x = a.charCodeAt(i);
    let y = b.charCodeAt(i);
    if (x === y) continue;
    // UTF-16 order equals code-point order except that surrogates (U+D800–DFFF,
    // which encode U+10000 and up) sort below U+E000–FFFF. Move them above.
    if (x >= 0xd800 && y >= 0xd800) {
      x = x >= 0xe000 ? x - 0x800 : x + 0x2000;
      y = y >= 0xe000 ? y - 0x800 : y + 0x2000;
    }
    return x - y;
  }
  return a.length - b.length;
}

/**
 * Whether `name` is a valid branch name for `git branch`, `git checkout -b`
 * and branch renames: not starting with "-", not `HEAD`, and `refs/heads/<name>`
 * valid (object-name.c strbuf_check_branch_ref). Unlike git, `@{-N}` is not
 * expanded first: it is refused as a name.
 *
 * @example
 * ```typescript
 * isValidBranchName("feature/x"); // true
 * isValidBranchName("HEAD");      // false
 * ```
 */
export function isValidBranchName(name: string): boolean {
  return (
    name.length > 0 &&
    !name.startsWith("-") &&
    name !== "HEAD" &&
    isValidRefName(`refs/heads/${name}`)
  );
}

/**
 * Whether `name` is a valid tag name for `git tag`: not starting with "-", not
 * `HEAD`, and `refs/tags/<name>` valid (refs.c check_tag_ref, git 2.48 and
 * later; older git accepted `HEAD`).
 */
export function isValidTagName(name: string): boolean {
  return (
    name.length > 0 &&
    !name.startsWith("-") &&
    name !== "HEAD" &&
    isValidRefName(`refs/tags/${name}`)
  );
}
