/**
 * Tests for RefSpec parsing and matching.
 * Ported from JGit's RefSpecTest.java
 */

import { describe, expect, it } from "vitest";
import {
  defaultFetchRefSpec,
  expandFromDestination,
  expandFromSource,
  formatRefSpec,
  isWildcard,
  matchDestination,
  matchSource,
  parseRefSpec,
} from "../src/utils/refspec.js";

describe("RefSpec parsing", () => {
  describe("basic parsing", () => {
    it("should parse master:master", () => {
      const sn = "refs/heads/master";
      const rs = parseRefSpec(`${sn}:${sn}`);

      expect(rs.force).toBe(false);
      expect(rs.wildcard).toBe(false);
      expect(rs.source).toBe(sn);
      expect(rs.destination).toBe(sn);
      expect(formatRefSpec(rs)).toBe(`${sn}:${sn}`);
    });

    it("should split on last colon", () => {
      const lhs = ":m:a:i:n:t";
      const rhs = "refs/heads/maint";
      const rs = parseRefSpec(`${lhs}:${rhs}`);

      expect(rs.force).toBe(false);
      expect(rs.wildcard).toBe(false);
      expect(rs.source).toBe(lhs);
      expect(rs.destination).toBe(rhs);
    });

    it("should parse force master:master", () => {
      const sn = "refs/heads/master";
      const rs = parseRefSpec(`+${sn}:${sn}`);

      expect(rs.force).toBe(true);
      expect(rs.wildcard).toBe(false);
      expect(rs.source).toBe(sn);
      expect(rs.destination).toBe(sn);
      expect(formatRefSpec(rs)).toBe(`+${sn}:${sn}`);
    });

    it("should parse source only", () => {
      const sn = "refs/heads/master";
      const rs = parseRefSpec(sn);

      expect(rs.force).toBe(false);
      expect(rs.wildcard).toBe(false);
      expect(rs.source).toBe(sn);
      expect(rs.destination).toBeNull();
    });

    it("should parse force source only", () => {
      const sn = "refs/heads/master";
      const rs = parseRefSpec(`+${sn}`);

      expect(rs.force).toBe(true);
      expect(rs.source).toBe(sn);
      expect(rs.destination).toBeNull();
    });

    it("should parse delete (destination only)", () => {
      const sn = "refs/heads/master";
      const rs = parseRefSpec(`:${sn}`);

      expect(rs.force).toBe(false);
      expect(rs.source).toBeNull();
      expect(rs.destination).toBe(sn);
    });
  });

  describe("wildcard refspecs", () => {
    it("should parse force wildcard", () => {
      const srcn = "refs/heads/*";
      const dstn = "refs/remotes/origin/*";
      const rs = parseRefSpec(`+${srcn}:${dstn}`);

      expect(rs.force).toBe(true);
      expect(rs.wildcard).toBe(true);
      expect(rs.source).toBe(srcn);
      expect(rs.destination).toBe(dstn);
    });

    it("should parse wildcard in middle of source", () => {
      const rs = parseRefSpec("+refs/pull/*/head:refs/remotes/origin/pr/*");
      expect(rs.wildcard).toBe(true);
    });

    it("should parse wildcard in middle of destination", () => {
      const rs = parseRefSpec("+refs/heads/*:refs/remotes/origin/*/head");
      expect(rs.wildcard).toBe(true);
    });

    it("should parse wildcard mirror", () => {
      const rs = parseRefSpec("*:*");
      expect(rs.wildcard).toBe(true);
    });

    it("should parse wildcard at start", () => {
      const rs = parseRefSpec("*/head:refs/heads/*");
      expect(rs.wildcard).toBe(true);
    });
  });

  describe("negative refspecs", () => {
    it("should parse negative with destination", () => {
      const rs = parseRefSpec("^:refs/readonly/*");
      expect(rs.negative).toBe(true);
      expect(rs.source).toBeNull();
      expect(rs.destination).toBe("refs/readonly/*");
    });

    it("should parse negative with source", () => {
      const rs = parseRefSpec("^refs/testdata/*");
      expect(rs.negative).toBe(true);
      expect(rs.source).toBe("refs/testdata/*");
      expect(rs.destination).toBeNull();
    });
  });

  describe("matching refspec", () => {
    it("should parse matching refspec :", () => {
      const rs = parseRefSpec(":");
      expect(rs.source).toBeNull();
      expect(rs.destination).toBeNull();
      expect(rs.force).toBe(false);
    });

    it("should parse matching refspec +:", () => {
      const rs = parseRefSpec("+:");
      expect(rs.source).toBeNull();
      expect(rs.destination).toBeNull();
      expect(rs.force).toBe(true);
    });
  });

  describe("invalid refspecs", () => {
    it("should reject source ending with /", () => {
      expect(() => parseRefSpec("refs/heads/")).toThrow("source cannot end with /");
    });

    it("should reject destination ending with /", () => {
      expect(() => parseRefSpec("refs/heads/master:refs/heads/")).toThrow(
        "destination cannot end with /",
      );
    });

    it("should reject source starting with /", () => {
      expect(() => parseRefSpec("/foo:/foo")).toThrow("source cannot start with /");
    });

    it("should reject source with //", () => {
      expect(() => parseRefSpec("refs/heads//wrong")).toThrow("source cannot contain //");
    });

    it("should reject destination with //", () => {
      expect(() => parseRefSpec(":refs/heads//wrong")).toThrow("destination cannot contain //");
    });

    it("should reject negative with force", () => {
      expect(() => parseRefSpec("^+refs/heads/master")).toThrow("cannot combine + and ^");
    });

    it("should reject force with negative", () => {
      expect(() => parseRefSpec("+^refs/heads/master")).toThrow("cannot combine + and ^");
    });

    it("should reject mismatched wildcards", () => {
      expect(() => parseRefSpec("refs/heads/*:refs/heads/foo")).toThrow(
        "both source and destination must have wildcard",
      );
    });

    it("should reject multiple wildcards in source", () => {
      expect(() => parseRefSpec("refs/heads/*/*:refs/heads/*")).toThrow(
        "only one wildcard allowed",
      );
    });

    it("should reject multiple wildcards in destination", () => {
      expect(() => parseRefSpec("refs/heads/*:refs/heads/*/*")).toThrow(
        "only one wildcard allowed",
      );
    });
  });
});

describe("isWildcard", () => {
  it("should detect wildcard suffix", () => {
    expect(isWildcard("refs/heads/*")).toBe(true);
  });

  it("should detect wildcard component", () => {
    expect(isWildcard("refs/pull/*/head")).toBe(true);
  });

  it("should return false for non-wildcard", () => {
    expect(isWildcard("refs/heads/a")).toBe(false);
  });
});

describe("matchSource", () => {
  it("should match exact ref", () => {
    const rs = parseRefSpec("refs/heads/master:refs/heads/master");
    expect(matchSource(rs, "refs/heads/master")).toBe(true);
    expect(matchSource(rs, "refs/heads/master-and-more")).toBe(false);
  });

  it("should match wildcard ref", () => {
    const rs = parseRefSpec("+refs/heads/*:refs/remotes/origin/*");
    expect(matchSource(rs, "refs/heads/master")).toBe(true);
    expect(matchSource(rs, "refs/heads/feature/foo")).toBe(true);
    expect(matchSource(rs, "refs/tags/v1.0")).toBe(false);
  });

  it("should match wildcard in middle", () => {
    const rs = parseRefSpec("+refs/pull/*/head:refs/remotes/origin/pr/*");
    expect(matchSource(rs, "refs/pull/a/head")).toBe(true);
    expect(matchSource(rs, "refs/pull/foo/head")).toBe(true);
    expect(matchSource(rs, "refs/pull/foo/bar/head")).toBe(true);
    expect(matchSource(rs, "refs/pull/foo")).toBe(false);
    expect(matchSource(rs, "refs/pull/head")).toBe(false);
    expect(matchSource(rs, "refs/pull/foo/head/more")).toBe(false);
  });
});

describe("matchDestination", () => {
  it("should match exact ref", () => {
    const rs = parseRefSpec("refs/heads/master:refs/heads/master");
    expect(matchDestination(rs, "refs/heads/master")).toBe(true);
    expect(matchDestination(rs, "refs/heads/other")).toBe(false);
  });

  it("should match wildcard ref", () => {
    const rs = parseRefSpec("+refs/heads/*:refs/remotes/origin/*");
    expect(matchDestination(rs, "refs/remotes/origin/master")).toBe(true);
    expect(matchDestination(rs, "refs/heads/master")).toBe(false);
  });

  it("should match wildcard in middle", () => {
    const rs = parseRefSpec("+refs/heads/*:refs/remotes/origin/*/head");
    expect(matchDestination(rs, "refs/remotes/origin/a/head")).toBe(true);
    expect(matchDestination(rs, "refs/remotes/origin/foo/head")).toBe(true);
    expect(matchDestination(rs, "refs/remotes/origin/foo/bar/head")).toBe(true);
    expect(matchDestination(rs, "refs/remotes/origin/foo")).toBe(false);
  });
});

describe("expandFromSource", () => {
  it("should return same spec for non-wildcard", () => {
    const rs = parseRefSpec("refs/heads/master:refs/remotes/origin/master");
    const expanded = expandFromSource(rs, "refs/heads/master");
    expect(expanded.source).toBe("refs/heads/master");
    expect(expanded.destination).toBe("refs/remotes/origin/master");
  });

  it("should expand wildcard", () => {
    const rs = parseRefSpec("+refs/heads/*:refs/remotes/origin/*");
    const expanded = expandFromSource(rs, "refs/heads/master");

    expect(expanded.wildcard).toBe(false);
    expect(expanded.force).toBe(true);
    expect(expanded.source).toBe("refs/heads/master");
    expect(expanded.destination).toBe("refs/remotes/origin/master");
  });

  it("should expand wildcard in middle", () => {
    const rs = parseRefSpec("+refs/pull/*/head:refs/remotes/origin/pr/*");
    const expanded = expandFromSource(rs, "refs/pull/foo/head");

    expect(expanded.source).toBe("refs/pull/foo/head");
    expect(expanded.destination).toBe("refs/remotes/origin/pr/foo");
  });

  it("should expand complex wildcards", () => {
    const rs = parseRefSpec("refs/heads/*/for-linus:refs/remotes/mine/*-blah");
    const expanded = expandFromSource(rs, "refs/heads/foo/for-linus");

    expect(expanded.destination).toBe("refs/remotes/mine/foo-blah");
  });
});

describe("expandFromDestination", () => {
  it("should return same spec for non-wildcard", () => {
    const rs = parseRefSpec("refs/heads/master:refs/remotes/origin/master");
    const expanded = expandFromDestination(rs, "refs/remotes/origin/master");
    expect(expanded.source).toBe("refs/heads/master");
    expect(expanded.destination).toBe("refs/remotes/origin/master");
  });

  it("should expand wildcard", () => {
    const rs = parseRefSpec("refs/heads/*:refs/remotes/origin/*");
    const expanded = expandFromDestination(rs, "refs/remotes/origin/master");

    expect(expanded.source).toBe("refs/heads/master");
    expect(expanded.destination).toBe("refs/remotes/origin/master");
  });

  it("should expand wildcard in middle", () => {
    const rs = parseRefSpec("+refs/pull/*/head:refs/remotes/origin/pr/*");
    const expanded = expandFromDestination(rs, "refs/remotes/origin/pr/foo");

    expect(expanded.source).toBe("refs/pull/foo/head");
    expect(expanded.destination).toBe("refs/remotes/origin/pr/foo");
  });
});

describe("formatRefSpec", () => {
  it("should format simple refspec", () => {
    const rs = parseRefSpec("refs/heads/master:refs/remotes/origin/master");
    expect(formatRefSpec(rs)).toBe("refs/heads/master:refs/remotes/origin/master");
  });

  it("should format force refspec", () => {
    const rs = parseRefSpec("+refs/heads/*:refs/remotes/origin/*");
    expect(formatRefSpec(rs)).toBe("+refs/heads/*:refs/remotes/origin/*");
  });

  it("should format negative refspec", () => {
    const rs = parseRefSpec("^refs/testdata/*");
    expect(formatRefSpec(rs)).toBe("^refs/testdata/*");
  });

  it("should format delete refspec", () => {
    const rs = parseRefSpec(":refs/heads/master");
    expect(formatRefSpec(rs)).toBe(":refs/heads/master");
  });
});

describe("defaultFetchRefSpec", () => {
  it("should create default fetch refspec for origin", () => {
    const rs = defaultFetchRefSpec("origin");
    expect(rs.force).toBe(true);
    expect(rs.source).toBe("refs/heads/*");
    expect(rs.destination).toBe("refs/remotes/origin/*");
  });

  it("should create default fetch refspec for custom remote", () => {
    const rs = defaultFetchRefSpec("upstream");
    expect(rs.destination).toBe("refs/remotes/upstream/*");
  });
});
