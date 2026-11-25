/**
 * path.c's path arithmetic for commands reading paths against a current directory inside the
 * worktree (`ls-tree`, `ls-files`): `normalize_path_copy`, `prefix_path_gently` and
 * `relative_path`, over strings from the top (git paths, `decodeGitPath` text).
 *
 * @example
 * ```typescript
 * normalizePathCopy("a/./b/../c"); // "a/c"
 * prefixPathGently("sub/", "../a.txt", undefined); // "a.txt"
 * relativePath("a.txt", "sub/"); // "../a.txt"
 * ```
 */

/**
 * normalize_path_copy: `.` and `..` components resolved, `/` runs collapsed (a trailing `/`
 * kept); undefined when `..` climbs above the start.
 */
export function normalizePathCopy(src: string): string | undefined {
  let dst = "";
  let i = 0;
  if (src.startsWith("/")) {
    dst = "/";
    i = 1;
  }
  const root = dst.length;
  while (src[i] === "/") i++;
  for (;;) {
    if (src[i] === ".") {
      const next = src[i + 1];
      if (next === undefined) {
        i++;
        break;
      }
      if (next === "/") {
        i += 2;
        while (src[i] === "/") i++;
        continue;
      }
      if (next === ".") {
        const after = src[i + 2];
        if (after === undefined || after === "/") {
          i += after === undefined ? 2 : 3;
          while (src[i] === "/") i++;
          // up_one: strip the last component (dst ends with "/")
          let end = dst.length - 1;
          if (end <= root) return undefined;
          while (end > root && dst[end - 1] !== "/") end--;
          dst = dst.slice(0, end);
          if (after === undefined) break;
          continue;
        }
      }
    }
    // copy up to the next "/", and eat all of them
    let c = src[i++];
    while (c !== undefined && c !== "/") {
      dst += c;
      c = src[i++];
    }
    if (c === "/") {
      dst += "/";
      while (src[i] === "/") i++;
    } else break;
  }
  return dst;
}

/** path.c's relative_path for paths from the top (byte strings). */
export function relativePath(input: string, prefix: string | undefined): string {
  const inLen = input.length;
  const prefixLen = prefix ? prefix.length : 0;
  if (!inLen) return "./";
  if (!prefix || !prefixLen) return input;
  let i = 0;
  let j = 0;
  let inOff = 0;
  let prefixOff = 0;
  while (i < prefixLen && j < inLen && prefix[i] === input[j]) {
    if (prefix[i] === "/") {
      while (prefix[i] === "/") i++;
      while (input[j] === "/") j++;
      prefixOff = i;
      inOff = j;
    } else {
      i++;
      j++;
    }
  }
  if (i >= prefixLen && prefixOff < prefixLen) {
    if (j >= inLen) inOff = inLen;
    else if (input[j] === "/") {
      while (input[j] === "/") j++;
      inOff = j;
    } else i = prefixOff;
  } else if (j >= inLen && inOff < inLen) {
    if (prefix[i] === "/") {
      while (prefix[i] === "/") i++;
      inOff = inLen;
    }
  }
  const rest = input.slice(inOff);
  if (i >= prefixLen) return rest.length === 0 ? "./" : rest;
  let out = "";
  while (i < prefixLen) {
    if (prefix[i] === "/") {
      out += "../";
      while (prefix[i] === "/") i++;
      continue;
    }
    i++;
  }
  if (prefix[prefixLen - 1] !== "/") out += "../";
  return out + rest;
}

/**
 * prefix_path_gently: `path` (relative to the directory `prefix`, from the top, ending with
 * `/`, or absolute) as a path from the top, undefined when it leaves the worktree. An
 * absolute path is taken against `top`, the worktree's host directory (undefined: refused).
 */
export function prefixPathGently(
  prefix: string,
  path: string,
  top: string | undefined,
): string | undefined {
  if (path.startsWith("/")) {
    const normalized = normalizePathCopy(path);
    if (top === undefined || normalized === undefined) return undefined;
    const root = normalizePathCopy(top)?.replace(/\/+$/, "");
    if (root === undefined) return undefined;
    if (normalized === root) return "";
    if (normalized.startsWith(`${root}/`)) return normalized.slice(root.length + 1);
    return undefined;
  }
  return normalizePathCopy(prefix + path);
}
