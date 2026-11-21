/**
 * Paths of alternate object directories inside a FilesApi: git's `strbuf_realpath` over the
 * FilesApi's links, with host paths mapped through its root (`HostPaths`).
 */

import type { FilesApi } from "@statewalker/vcs-core";
import type { PosixFilesApi } from "@statewalker/vcs-utils/files";
import type { HostPaths } from "../workspace/git-dir/index.js";

/** Most symbolic links followed while resolving one path (the kernel's ELOOP limit). */
const MAX_LINKS = 40;

/** Whether `path` is absolute (a POSIX path or a Windows drive path). */
export function isAbsolute(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}

/** `.` and empty components dropped, `..` applied; undefined above the root. */
export function normalizeAlternatePath(path: string): string | undefined {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return undefined;
      out.pop();
    } else out.push(part);
  }
  return `/${out.join("/")}`;
}

/**
 * git's `strbuf_realpath` (die_on_error 0) inside the FilesApi: symbolic links followed (an
 * absolute target only inside the host root), `..` applied after them; undefined when a link
 * climbs above the root or leaves the storage, there are too many, or a component before the
 * last is missing. Lexical where the FilesApi cannot tell links apart.
 */
export async function alternateRealPath(
  files: FilesApi,
  path: string,
  host: HostPaths,
): Promise<string | undefined> {
  const posix = files as PosixFilesApi;
  const pending = path.split("/").filter((p) => p !== "" && p !== ".");
  const out: string[] = [];
  let links = 0;
  while (pending.length > 0) {
    const part = pending.shift() as string;
    if (part === "..") {
      if (out.length === 0) return undefined;
      out.pop();
      continue;
    }
    out.push(part);
    const current = `/${out.join("/")}`;
    if (!posix.lstat || !posix.readlink) continue;
    const stat = await posix.lstat(current).catch(() => undefined);
    if (!stat) {
      if (pending.length > 0) return undefined;
      continue;
    }
    if (stat.kind !== "symlink") continue;
    if (++links > MAX_LINKS) return undefined;
    const raw = await posix.readlink(current).catch(() => undefined);
    if (!raw) return undefined;
    const target = new TextDecoder().decode(raw);
    out.pop();
    if (isAbsolute(target)) {
      if (host.known && !host.inside(target)) return undefined;
      const inner = host.known ? host.filesPath(target) : target;
      out.length = 0;
      pending.unshift(...inner.split("/").filter((p) => p !== "" && p !== "."));
    } else {
      pending.unshift(...target.split("/").filter((p) => p !== "" && p !== "."));
    }
  }
  return `/${out.join("/")}`;
}

export async function readAllBytes(files: FilesApi, path: string): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const c of files.read(path)) {
    chunks.push(c);
    length += c.length;
  }
  const out = new Uint8Array(length);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
