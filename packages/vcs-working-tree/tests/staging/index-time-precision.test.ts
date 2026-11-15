import { FileMode } from "@statewalker/vcs-core";
import { describe, expect, it } from "vitest";
import type { StagingEntry } from "../../src/staging/index.js";
import { serializeIndexFile } from "../../src/staging/index-format.js";

/**
 * A time in milliseconds is a double: at today's dates it resolves only about 244 ns, so a
 * file's nanoseconds cannot survive it. The index writer must record the exact nanoseconds it
 * was given, and take the seconds from them, even when the milliseconds rounded across a
 * millisecond or a second.
 */
describe("index entry times keep their exact nanoseconds", () => {
  /** The milliseconds a Node lstat yields for a time in nanoseconds, and its nanoseconds. */
  function fromNs(total: bigint): { ms: number; ns: number } {
    return {
      ms: Number(total / 1_000_000n) + Number(total % 1_000_000n) / 1e6,
      ns: Number(total % 1_000_000_000n),
    };
  }

  async function recorded(total: bigint): Promise<{ seconds: number; nanos: number }> {
    const { ms, ns } = fromNs(total);
    const entry = {
      path: "a.txt",
      mode: FileMode.REGULAR_FILE,
      objectId: "a".repeat(40),
      stage: 0,
      size: 2,
      mtime: ms,
      mtimeNs: ns,
      ctime: ms,
      ctimeNs: ns,
    } as unknown as StagingEntry;
    const bytes = await serializeIndexFile([entry]);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // header (12 bytes), then ctime sec, ctime nsec, mtime sec, mtime nsec
    expect(view.getUint32(12)).toBe(view.getUint32(20));
    expect(view.getUint32(16)).toBe(view.getUint32(24));
    return { seconds: view.getUint32(20), nanos: view.getUint32(24) };
  }

  const cases: bigint[] = [
    1_794_776_435_296_999_931n, // seen on CI: recorded as .297000000 before
    1_794_774_513_723_999_977n,
    1_794_776_435_999_999_931n, // just below a second: must not move to the next second
    1_794_776_435_000_000_001n,
    1_794_776_435_266_000_000n,
  ];

  for (const total of cases) {
    it(`records ${total} exactly`, async () => {
      const { seconds, nanos } = await recorded(total);
      expect(seconds).toBe(Number(total / 1_000_000_000n));
      expect(nanos).toBe(Number(total % 1_000_000_000n));
    });
  }

  it("falls back to the milliseconds when no nanoseconds are known", async () => {
    const entry = {
      path: "a.txt",
      mode: FileMode.REGULAR_FILE,
      objectId: "a".repeat(40),
      stage: 0,
      size: 2,
      mtime: 1_794_776_435_297,
    } as unknown as StagingEntry;
    const bytes = await serializeIndexFile([entry]);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint32(20)).toBe(1_794_776_435);
    expect(view.getUint32(24)).toBe(297_000_000);
  });
});
