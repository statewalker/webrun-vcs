/**
 * Tests for Git URI parsing.
 * Ported from JGit's URIishTest.java
 */

import { describe, expect, it } from "vitest";
import {
  formatGitUrl,
  getDefaultPort,
  getEffectivePort,
  getRepositoryName,
  isRemote,
  parseGitUrl,
  toHttpUrl,
} from "../src/utils/uri.js";

describe("parseGitUrl", () => {
  describe("local paths", () => {
    it("should parse Unix file path", () => {
      const u = parseGitUrl("/home/m y");
      expect(u.protocol).toBe("file");
      expect(isRemote(u)).toBe(false);
      expect(u.path).toBe("/home/m y");
    });

    it("should parse Windows path", () => {
      const u = parseGitUrl("D:/m y");
      expect(u.protocol).toBe("file");
      expect(isRemote(u)).toBe(false);
      expect(u.path).toBe("D:/m y");
    });

    it("should parse Windows path with backslash", () => {
      const u = parseGitUrl("D:\\m y");
      expect(u.protocol).toBe("file");
      expect(u.path).toBe("D:\\m y");
    });

    it("should parse relative path", () => {
      const u = parseGitUrl("../../foo/bar");
      expect(u.protocol).toBe("file");
      expect(u.path).toBe("../../foo/bar");
    });

    it("should parse UNC path", () => {
      const u = parseGitUrl("\\\\some\\place");
      expect(u.protocol).toBe("file");
      expect(u.path).toBe("\\\\some\\place");
    });
  });

  describe("file:// URLs", () => {
    it("should parse file URL", () => {
      const u = parseGitUrl("file:///home/m y");
      expect(u.protocol).toBe("file");
      expect(isRemote(u)).toBe(false);
      expect(u.path).toBe("/home/m y");
    });

    it("should parse file URL with Windows path", () => {
      const u = parseGitUrl("file:///D:/m%20y");
      expect(u.protocol).toBe("file");
      expect(u.path).toBe("/D:/m%20y");
    });
  });

  describe("git:// URLs", () => {
    it("should parse git URL", () => {
      const u = parseGitUrl("git://host.example.com/a/b");
      expect(u.protocol).toBe("git");
      expect(isRemote(u)).toBe(true);
      expect(u.host).toBe("host.example.com");
      expect(u.path).toBe("/a/b");
      expect(u.port).toBeUndefined();
    });

    it("should parse git URL with port", () => {
      const u = parseGitUrl("git://host.example.com:8080/a/b");
      expect(u.protocol).toBe("git");
      expect(u.host).toBe("host.example.com");
      expect(u.port).toBe(8080);
      expect(u.path).toBe("/a/b");
    });

    it("should parse git URL with .git suffix", () => {
      const u = parseGitUrl("git://host.example.com/repo.git");
      expect(u.path).toBe("/repo.git");
    });
  });

  describe("http:// URLs", () => {
    it("should parse HTTP URL", () => {
      const u = parseGitUrl("http://example.com/repo.git");
      expect(u.protocol).toBe("http");
      expect(u.host).toBe("example.com");
      expect(u.path).toBe("/repo.git");
    });

    it("should parse HTTP URL with auth", () => {
      const u = parseGitUrl("http://user:pass@example.com/repo.git");
      expect(u.protocol).toBe("http");
      expect(u.user).toBe("user");
      expect(u.password).toBe("pass");
      expect(u.host).toBe("example.com");
    });

    it("should parse HTTP URL with port", () => {
      const u = parseGitUrl("http://example.com:8080/repo.git");
      expect(u.port).toBe(8080);
    });
  });

  describe("https:// URLs", () => {
    it("should parse HTTPS URL", () => {
      const u = parseGitUrl("https://github.com/user/repo.git");
      expect(u.protocol).toBe("https");
      expect(u.host).toBe("github.com");
      expect(u.path).toBe("/user/repo.git");
    });

    it("should parse HTTPS URL with token auth", () => {
      const u = parseGitUrl("https://token:x-oauth@github.com/user/repo.git");
      expect(u.user).toBe("token");
      expect(u.password).toBe("x-oauth");
    });
  });

  describe("ssh:// URLs", () => {
    it("should parse SSH URL", () => {
      const u = parseGitUrl("ssh://git@github.com/user/repo.git");
      expect(u.protocol).toBe("ssh");
      expect(u.user).toBe("git");
      expect(u.host).toBe("github.com");
      expect(u.path).toBe("/user/repo.git");
    });

    it("should parse SSH URL with port", () => {
      const u = parseGitUrl("ssh://git@github.com:22/user/repo.git");
      expect(u.port).toBe(22);
    });
  });

  describe("SCP-like URLs", () => {
    it("should parse SCP-like URL", () => {
      const u = parseGitUrl("git@github.com:user/repo.git");
      expect(u.protocol).toBe("ssh");
      expect(u.user).toBe("git");
      expect(u.host).toBe("github.com");
      expect(u.path).toBe("/user/repo.git");
    });

    it("should parse SCP-like URL without user", () => {
      const u = parseGitUrl("github.com:user/repo.git");
      expect(u.protocol).toBe("ssh");
      expect(u.host).toBe("github.com");
      expect(u.path).toBe("/user/repo.git");
    });
  });
});

describe("formatGitUrl", () => {
  it("should format HTTP URL", () => {
    const u = parseGitUrl("https://github.com/user/repo.git");
    expect(formatGitUrl(u)).toBe("https://github.com/user/repo.git");
  });

  it("should format URL with auth", () => {
    const u = parseGitUrl("https://user:pass@github.com/repo.git");
    expect(formatGitUrl(u)).toBe("https://user:pass@github.com/repo.git");
  });

  it("should format URL with port", () => {
    const u = parseGitUrl("https://github.com:8080/repo.git");
    expect(formatGitUrl(u)).toBe("https://github.com:8080/repo.git");
  });

  it("should format file URL", () => {
    const u = parseGitUrl("file:///path/to/repo");
    expect(formatGitUrl(u)).toBe("file:///path/to/repo");
  });
});

describe("isRemote", () => {
  it("should return true for remote URLs", () => {
    expect(isRemote(parseGitUrl("https://github.com/repo"))).toBe(true);
    expect(isRemote(parseGitUrl("git://github.com/repo"))).toBe(true);
    expect(isRemote(parseGitUrl("ssh://git@github.com/repo"))).toBe(true);
    expect(isRemote(parseGitUrl("git@github.com:repo"))).toBe(true);
  });

  it("should return false for local paths", () => {
    expect(isRemote(parseGitUrl("/path/to/repo"))).toBe(false);
    expect(isRemote(parseGitUrl("file:///path/to/repo"))).toBe(false);
    expect(isRemote(parseGitUrl("../repo"))).toBe(false);
  });
});

describe("getDefaultPort", () => {
  it("should return correct default ports", () => {
    expect(getDefaultPort("https")).toBe(443);
    expect(getDefaultPort("http")).toBe(80);
    expect(getDefaultPort("git")).toBe(9418);
    expect(getDefaultPort("ssh")).toBe(22);
    expect(getDefaultPort("file")).toBe(0);
  });
});

describe("getEffectivePort", () => {
  it("should return specified port if present", () => {
    const u = parseGitUrl("https://github.com:8080/repo");
    expect(getEffectivePort(u)).toBe(8080);
  });

  it("should return default port if not specified", () => {
    const u = parseGitUrl("https://github.com/repo");
    expect(getEffectivePort(u)).toBe(443);
  });
});

describe("getRepositoryName", () => {
  it("should extract repo name from URL", () => {
    expect(getRepositoryName(parseGitUrl("https://github.com/user/repo.git"))).toBe("repo");
  });

  it("should strip .git suffix", () => {
    expect(getRepositoryName(parseGitUrl("https://github.com/user/my-repo.git"))).toBe("my-repo");
  });

  it("should handle URL without .git", () => {
    expect(getRepositoryName(parseGitUrl("https://github.com/user/my-repo"))).toBe("my-repo");
  });

  it("should handle SCP-like URL", () => {
    expect(getRepositoryName(parseGitUrl("git@github.com:user/repo.git"))).toBe("repo");
  });
});

describe("toHttpUrl", () => {
  it("should return HTTPS URL unchanged", () => {
    const u = parseGitUrl("https://github.com/repo");
    expect(toHttpUrl(u)).toBe("https://github.com/repo");
  });

  it("should return HTTP URL unchanged", () => {
    const u = parseGitUrl("http://github.com/repo");
    expect(toHttpUrl(u)).toBe("http://github.com/repo");
  });

  it("should convert git:// to https://", () => {
    const u = parseGitUrl("git://github.com/repo");
    expect(toHttpUrl(u)).toBe("https://github.com/repo");
  });

  it("should throw for ssh://", () => {
    const u = parseGitUrl("ssh://git@github.com/repo");
    expect(() => toHttpUrl(u)).toThrow("Cannot convert ssh://");
  });

  it("should throw for file://", () => {
    const u = parseGitUrl("file:///path/to/repo");
    expect(() => toHttpUrl(u)).toThrow("Cannot convert file://");
  });
});
