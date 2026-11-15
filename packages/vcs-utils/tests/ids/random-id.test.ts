/**
 * Random ids from `crypto.getRandomValues`, which exists on every origin
 * (`crypto.randomUUID` is undefined on non-secure browser origins).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomHexId, timestampedId, timestampOfId } from "../../src/index.js";

describe("randomHexId", () => {
  afterEach(() => vi.restoreAllMocks());

  it("is 16 random bytes as hex by default, without crypto.randomUUID", () => {
    vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
      throw new Error("randomUUID is not available");
    });
    const a = randomHexId();
    const b = randomHexId();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
    expect(randomHexId(4)).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("timestampedId", () => {
  it("carries its creation time", () => {
    const id = timestampedId(1_700_000_000_123);
    expect(id).toMatch(/^[0-9a-z]+-[0-9a-f]{32}$/);
    expect(timestampOfId(id)).toBe(1_700_000_000_123);
    expect(timestampOfId(timestampedId())).toBeGreaterThan(Date.now() - 60_000);
  });

  it("reports no time for other ids", () => {
    expect(timestampOfId("3f2b8c1e-0d4a-4e8b-9c6f-2a1b3c4d5e6f")).toBeUndefined();
    expect(timestampOfId(randomHexId())).toBeUndefined();
    expect(timestampOfId("")).toBeUndefined();
  });
});
