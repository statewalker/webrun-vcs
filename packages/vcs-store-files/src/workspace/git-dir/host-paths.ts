/**
 * Paths of a FilesApi and the host paths git writes for them.
 *
 * @example
 * ```typescript
 * const paths = new HostPaths("/home/me/src");
 * paths.hostPath("repo/.git/worktrees/wt"); // "/home/me/src/repo/.git/worktrees/wt"
 * paths.filesPath("/home/me/src/wt/.git"); // "/wt/.git"
 * paths.filesPath("/elsewhere/wt"); // "/elsewhere/wt": beyond the root, as written
 * new HostPaths("C:\\Users\\me").hostPath("wt"); // "C:/Users/me/wt"
 * ```
 *
 * git writes a linked worktree's pointer files (`gitdir`, the `.git` file, an absolute
 * `commondir`) with real host paths. A FilesApi names paths below its root; where that
 * root is on the host (`rootPath`, a Node FilesApi's `rootDirectory`) maps between the two.
 * A Windows root (`C:\\Users\\x`, a UNC `\\\\server\\share`) is written with forward slashes,
 * as Git for Windows writes paths, and compared without case.
 *
 * @module
 */

/** A FilesApi's root on the host, when known (`rootPath`, else the FilesApi's `rootDirectory`). */
export function hostRootOf(files: unknown, rootPath?: string): string | undefined {
  const root = rootPath ?? (files as { rootDirectory?: unknown } | undefined)?.rootDirectory;
  return typeof root === "string" && root !== "" ? root : undefined;
}

/** Maps paths of a FilesApi rooted at `root` (a host path; none: paths stay as they are). */
export class HostPaths {
  private readonly base?: string;
  /** The root is a Windows path (drive or UNC). */
  readonly windows: boolean;

  constructor(root?: string) {
    if (root === undefined || root === "") {
      this.windows = false;
      return;
    }
    this.windows = /^[A-Za-z]:/.test(root) || root.startsWith("\\");
    const slashed = this.windows ? root.replace(/\\/g, "/") : root;
    this.base = slashed.replace(/\/+$/, "");
  }

  /** Whether the root is known. */
  get known(): boolean {
    return this.base !== undefined;
  }

  /** The root as git writes it, without trailing slashes (`""` for `/`); undefined when unknown. */
  get root(): string | undefined {
    return this.base;
  }

  /**
   * The path git writes for `path` (a path in the FilesApi): absolute on the host when the
   * root is known, else `path` itself.
   */
  hostPath(path: string): string {
    if (this.base === undefined) return path;
    const inner = path
      .split("/")
      .filter((p) => p !== "" && p !== ".")
      .join("/");
    return inner === "" ? this.base || "/" : `${this.base}/${inner}`;
  }

  /** `.` and `..` resolved, separators collapsed (a leading `//`, a UNC root, kept). */
  normalize(path: string): string {
    const slashed = this.windows ? path.replace(/\\/g, "/") : path;
    const lead = /^\/*/.exec(slashed)?.[0] ?? "";
    const parts: string[] = [];
    for (const part of slashed.slice(lead.length).split("/")) {
      if (part === "..") parts.pop();
      else if (part !== "." && part !== "") parts.push(part);
    }
    return `${lead.length >= 2 && this.windows ? "//" : lead ? "/" : ""}${parts.join("/")}`;
  }

  /** Whether two host paths name the same place (git's `fspathcmp`: no case on Windows). */
  same(a: string, b: string): boolean {
    const x = this.normalize(a);
    const y = this.normalize(b);
    return this.windows ? x.toLowerCase() === y.toLowerCase() : x === y;
  }

  /**
   * The path in the FilesApi an absolute host path names: the part below the root.
   * Returned as written when the root is unknown or the path lies outside it: such a place
   * is beyond what the FilesApi can name, and reading it fails as a missing one.
   */
  filesPath(hostPath: string): string {
    if (this.base === undefined) return hostPath;
    const target = this.normalize(hostPath);
    const base = this.base === "" ? "" : this.normalize(this.base).replace(/\/$/, "");
    const eq = (a: string, b: string) =>
      this.windows ? a.toLowerCase() === b.toLowerCase() : a === b;
    if (eq(target, base)) return "/";
    const prefix = `${base}/`;
    if (!eq(target.slice(0, prefix.length), prefix)) return hostPath;
    return `/${target.slice(prefix.length)}`;
  }

  /** Whether `hostPath` lies at or below the root (a FilesApi path can name it). */
  inside(hostPath: string): boolean {
    if (this.base === undefined) return false;
    return this.filesPath(hostPath) !== hostPath || this.same(hostPath, this.base || "/");
  }
}
