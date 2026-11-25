/**
 * git's ref-name rules and ref order.
 *
 * The rules are refs.c's check_refname_format, as `git check-ref-format`
 * applies them: a name is `/`-separated components; a component may not be
 * empty, start with `.`, contain `..` or `@{`, end with `.lock`, or contain a
 * control character, DEL, space or any of `~ ^ : ? [ \ *`. The whole name may
 * not be `@` or end with `.`, and needs two components unless one level is
 * allowed. Non-ASCII characters are allowed, and so are names that are not valid
 * UTF-8: git checks bytes and accepts every byte from 0x80 up (`refname_disposition`).
 * Such names reach this code as vcs-utils' `decodeGitPath` gives them (a FilesApi
 * listing, packed-refs, a reftable): each byte outside a valid UTF-8 sequence as the lone
 * surrogate U+DC80..U+DCFF, which `encodeGitPath` turns back into the byte. Any other lone
 * UTF-16 surrogate is refused, since it has no encoding (it would be written as U+FFFD,
 * another name).
 */

import { compareGitPaths } from "@statewalker/vcs-utils/encoding";

/** A lone surrogate that is not an escaped byte (U+DC80..U+DCFF). */
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDC7F\uDD00-\uDFFF]/;
const FORBIDDEN = new Set([" ", "~", "^", ":", "?", "[", "\\", "\u007f"]);

/** `pattern.allowed`: a `*` may still come (`REFNAME_REFSPEC_PATTERN`, cleared by the first). */
function badComponent(component: string, pattern: { allowed: boolean }): boolean {
  if (component.length === 0 || component.startsWith(".") || component.endsWith(".lock")) {
    return true;
  }
  let prev = "";
  for (const ch of component) {
    if (ch === "*") {
      if (!pattern.allowed) return true;
      pattern.allowed = false;
    } else if ((ch.codePointAt(0) ?? 0) < 0x20 || FORBIDDEN.has(ch)) return true;
    if (ch === "." && prev === ".") return true;
    if (ch === "{" && prev === "@") return true;
    prev = ch;
  }
  return false;
}

export interface RefNameOptions {
  /** Accept a single component such as `HEAD` or `main` (`--allow-onelevel`). */
  allowOneLevel?: boolean;
  /**
   * Accept one `*` in the whole name, as a refspec's side has it (`--refspec-pattern`,
   * `REFNAME_REFSPEC_PATTERN`)
   */
  refspecPattern?: boolean;
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
 * isValidRefName("refs/heads/*", { refspecPattern: true }); // true: one `*`
 * ```
 */
export function isValidRefName(name: string, options: RefNameOptions = {}): boolean {
  if (name === "@" || name.endsWith(".") || LONE_SURROGATE.test(name)) return false;
  const parts = name.split("/");
  const pattern = { allowed: options.refspecPattern === true };
  if (parts.some((part) => badComponent(part, pattern))) return false;
  return options.allowOneLevel === true || parts.length >= 2;
}

/**
 * Compare two ref names in git's order: the byte order of their encodings (UTF-8, each
 * escaped byte U+DC80..U+DCFF as that byte: vcs-utils' `compareGitPaths`), which for UTF-8
 * names is code-point order (uppercase before lowercase, non-ASCII last). Unlike
 * `localeCompare` and plain `<` (UTF-16 units), it matches the order git lists refs and
 * writes packed-refs and reftables in.
 *
 * @example
 * ```typescript
 * ["refs/heads/a", "refs/heads/B"].sort(compareRefNames); // ["refs/heads/B", "refs/heads/a"]
 * ```
 */
export function compareRefNames(a: string, b: string): number {
  return compareGitPaths(a, b);
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

/**
 * `git check-ref-format --normalize`'s `collapse_slashes`: leading slashes dropped, runs of
 * slashes collapsed to one.
 *
 * @example
 * ```typescript
 * collapseRefNameSlashes("///heads//foo"); // "heads/foo"
 * ```
 */
export function collapseRefNameSlashes(name: string): string {
  let out = "";
  let prev = "/";
  for (const ch of name) {
    if (prev === "/" && ch === "/") continue;
    out += ch;
    prev = ch;
  }
  return out;
}
