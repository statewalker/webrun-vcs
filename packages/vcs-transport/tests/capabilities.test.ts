/**
 * Tests for capability negotiation.
 */

import { describe, expect, it } from "vitest";
import {
  formatCapabilities,
  getSidebandSize,
  hasMultiAck,
  hasOfsDelta,
  hasSideband,
  hasThinPack,
  negotiateCapabilities,
  parseCapabilities,
} from "../src/protocol/capabilities.js";

describe("parseCapabilities", () => {
  it("should parse simple capabilities", () => {
    const result = parseCapabilities("multi_ack thin-pack side-band");
    expect(result.capabilities).toContain("multi_ack");
    expect(result.capabilities).toContain("thin-pack");
    expect(result.capabilities).toContain("side-band");
  });

  it("should parse symref", () => {
    const result = parseCapabilities("symref=HEAD:refs/heads/main");
    expect(result.capabilities).toContain("symref=HEAD:refs/heads/main");
    expect(result.symrefs.get("HEAD")).toBe("refs/heads/main");
  });

  it("should parse agent", () => {
    const result = parseCapabilities("agent=git/2.30.0");
    expect(result.capabilities).toContain("agent=git/2.30.0");
    expect(result.agent).toBe("git/2.30.0");
  });

  it("should parse complex capability string", () => {
    const caps =
      "multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since " +
      "no-progress include-tag multi_ack_detailed symref=HEAD:refs/heads/main agent=git/2.30.0";

    const result = parseCapabilities(caps);
    expect(result.capabilities.size).toBe(12);
    expect(result.symrefs.get("HEAD")).toBe("refs/heads/main");
    expect(result.agent).toBe("git/2.30.0");
  });

  it("should handle empty string", () => {
    const result = parseCapabilities("");
    expect(result.capabilities.size).toBe(0);
    expect(result.symrefs.size).toBe(0);
    expect(result.agent).toBeUndefined();
  });
});

describe("formatCapabilities", () => {
  it("should format capability list", () => {
    const result = formatCapabilities(["multi_ack", "thin-pack"]);
    expect(result).toBe("multi_ack thin-pack");
  });

  it("should include agent", () => {
    const result = formatCapabilities(["multi_ack"], "statewalker-vcs/1.0");
    expect(result).toBe("multi_ack agent=statewalker-vcs/1.0");
  });

  it("should handle empty list", () => {
    const result = formatCapabilities([]);
    expect(result).toBe("");
  });
});

describe("negotiateCapabilities", () => {
  it("should return only capabilities server supports", () => {
    const serverCaps = new Set(["multi_ack_detailed", "thin-pack", "side-band-64k", "ofs-delta"]);

    const result = negotiateCapabilities(serverCaps);

    expect(result).toContain("multi_ack_detailed");
    expect(result).toContain("thin-pack");
    expect(result).toContain("side-band-64k");
    expect(result).toContain("ofs-delta");
  });

  it("should not include unsupported capabilities", () => {
    const serverCaps = new Set(["thin-pack"]);

    const result = negotiateCapabilities(serverCaps);

    expect(result).toContain("thin-pack");
    expect(result).not.toContain("multi_ack_detailed");
    expect(result).not.toContain("side-band-64k");
  });

  it("should fall back to side-band if 64k not available", () => {
    const serverCaps = new Set(["thin-pack", "side-band"]);

    const result = negotiateCapabilities(serverCaps);

    expect(result).toContain("side-band");
    expect(result).not.toContain("side-band-64k");
  });
});

describe("hasMultiAck", () => {
  it("should detect multi_ack_detailed", () => {
    expect(hasMultiAck(new Set(["multi_ack_detailed"]))).toBe(true);
  });

  it("should detect multi_ack", () => {
    expect(hasMultiAck(new Set(["multi_ack"]))).toBe(true);
  });

  it("should return false without multi_ack", () => {
    expect(hasMultiAck(new Set(["thin-pack"]))).toBe(false);
  });

  it("should work with arrays", () => {
    expect(hasMultiAck(["multi_ack_detailed", "thin-pack"])).toBe(true);
  });
});

describe("hasSideband", () => {
  it("should detect side-band-64k", () => {
    expect(hasSideband(new Set(["side-band-64k"]))).toBe(true);
  });

  it("should detect side-band", () => {
    expect(hasSideband(new Set(["side-band"]))).toBe(true);
  });

  it("should return false without sideband", () => {
    expect(hasSideband(new Set(["thin-pack"]))).toBe(false);
  });
});

describe("getSidebandSize", () => {
  it("should return 65520 for side-band-64k", () => {
    expect(getSidebandSize(new Set(["side-band-64k"]))).toBe(65520);
  });

  it("should return 1000 for side-band", () => {
    expect(getSidebandSize(new Set(["side-band"]))).toBe(1000);
  });

  it("should return 0 without sideband", () => {
    expect(getSidebandSize(new Set(["thin-pack"]))).toBe(0);
  });

  it("should prefer side-band-64k", () => {
    expect(getSidebandSize(new Set(["side-band", "side-band-64k"]))).toBe(65520);
  });
});

describe("hasThinPack", () => {
  it("should detect thin-pack", () => {
    expect(hasThinPack(new Set(["thin-pack"]))).toBe(true);
  });

  it("should return false without thin-pack", () => {
    expect(hasThinPack(new Set(["ofs-delta"]))).toBe(false);
  });
});

describe("hasOfsDelta", () => {
  it("should detect ofs-delta", () => {
    expect(hasOfsDelta(new Set(["ofs-delta"]))).toBe(true);
  });

  it("should return false without ofs-delta", () => {
    expect(hasOfsDelta(new Set(["thin-pack"]))).toBe(false);
  });
});
