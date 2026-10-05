/**
 * Git URI parsing.
 *
 * Supports various git URL formats:
 * - https://github.com/user/repo.git
 * - git://github.com/user/repo.git
 * - ssh://git@github.com/user/repo.git
 * - git@github.com:user/repo.git (SCP-like)
 * - file:///path/to/repo
 * - /path/to/repo (local path)
 *
 * Based on JGit's URIish.java
 */

import type { GitUrl } from "../protocol/types.js";

/**
 * Regular expression for standard URI format.
 * Groups: protocol, user, password, host, port, path
 */
const URI_REGEX =
  /^(?:([a-z][a-z0-9+.-]*):\/\/)?(?:([^:@]+)(?::([^@]*))?@)?([^/:]+)?(?::(\d+))?(\/.*)?$/i;

/**
 * Regular expression for SCP-like format (git@host:path).
 * Groups: user, host, path
 */
const SCP_REGEX = /^(?:([^@]+)@)?([^:]+):(.+)$/;

/**
 * Parse a git URL into its components.
 */
export function parseGitUrl(url: string): GitUrl {
  // Check for Windows path (e.g., C:\path\to\repo)
  if (/^[A-Za-z]:[/\\]/.test(url)) {
    return {
      protocol: "file",
      host: "",
      path: url,
    };
  }

  // Check for UNC path (e.g., \\server\share\path)
  if (url.startsWith("\\\\")) {
    return {
      protocol: "file",
      host: "",
      path: url,
    };
  }

  // Check for absolute Unix path
  if (url.startsWith("/")) {
    return {
      protocol: "file",
      host: "",
      path: url,
    };
  }

  // Check for relative path
  if (url.startsWith("./") || url.startsWith("../")) {
    return {
      protocol: "file",
      host: "",
      path: url,
    };
  }

  // Try standard URI format first
  const uriMatch = url.match(URI_REGEX);
  if (uriMatch?.[1]) {
    const [, protocol, user, password, host, port, path] = uriMatch;

    const normalizedProtocol = protocol.toLowerCase() as GitUrl["protocol"];

    return {
      protocol: normalizedProtocol,
      host: host || "",
      port: port ? parseInt(port, 10) : undefined,
      path: path || "/",
      user: user || undefined,
      password: password || undefined,
    };
  }

  // Try SCP-like format (git@github.com:user/repo.git)
  const scpMatch = url.match(SCP_REGEX);
  if (scpMatch) {
    const [, user, host, path] = scpMatch;
    return {
      protocol: "ssh",
      host,
      path: `/${path}`,
      user: user || undefined,
    };
  }

  // If nothing matched, treat as local path
  return {
    protocol: "file",
    host: "",
    path: url,
  };
}

/**
 * Format a GitUrl back to string.
 */
export function formatGitUrl(url: GitUrl): string {
  if (url.protocol === "file") {
    if (url.path.startsWith("/")) {
      return `file://${url.path}`;
    }
    return url.path;
  }

  let result = `${url.protocol}://`;

  if (url.user) {
    result += url.user;
    if (url.password) {
      result += `:${url.password}`;
    }
    result += "@";
  }

  result += url.host;

  if (url.port) {
    result += `:${url.port}`;
  }

  result += url.path;

  return result;
}

/**
 * Check if a URL is remote (not local file).
 */
export function isRemote(url: GitUrl): boolean {
  return url.protocol !== "file";
}

/**
 * Get the default port for a protocol.
 */
export function getDefaultPort(protocol: GitUrl["protocol"]): number {
  switch (protocol) {
    case "https":
      return 443;
    case "http":
      return 80;
    case "git":
      return 9418;
    case "ssh":
      return 22;
    default:
      return 0;
  }
}

/**
 * Get the effective port (specified or default).
 */
export function getEffectivePort(url: GitUrl): number {
  return url.port ?? getDefaultPort(url.protocol);
}

/**
 * Get the repository name from a URL.
 * Strips .git suffix if present.
 */
export function getRepositoryName(url: GitUrl): string {
  const path = url.path;
  const lastSlash = path.lastIndexOf("/");
  let name = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;

  if (name.endsWith(".git")) {
    name = name.slice(0, -4);
  }

  return name;
}

/**
 * Resolve a relative URL against a base URL.
 */
export function resolveUrl(base: GitUrl, relative: string): GitUrl {
  if (relative.includes("://") || relative.startsWith("/")) {
    return parseGitUrl(relative);
  }

  // Handle relative path
  const basePath = base.path.endsWith("/")
    ? base.path
    : base.path.slice(0, base.path.lastIndexOf("/") + 1);

  return {
    ...base,
    path: basePath + relative,
  };
}

/**
 * Convert URL to HTTP(S) endpoint.
 * Useful for smart HTTP protocol.
 */
export function toHttpUrl(url: GitUrl): string {
  if (url.protocol === "http" || url.protocol === "https") {
    return formatGitUrl(url);
  }

  // Convert git:// to https://
  if (url.protocol === "git") {
    return formatGitUrl({ ...url, protocol: "https" });
  }

  // Can't convert SSH or file to HTTP
  throw new Error(`Cannot convert ${url.protocol}:// URL to HTTP`);
}
