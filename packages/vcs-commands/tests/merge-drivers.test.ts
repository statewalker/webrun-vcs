/**
 * ll_merge's driver selection around a host's merge drivers: the command a registered
 * driver is given, `merge.<driver>.recursive` over the driver's own `recursive`, and a
 * driver that fails to run (git's `LL_MERGE_ERROR`).
 */
import { describe, expect, it } from "vitest";

import {
  createMergeDriver,
  lowLevelMerge,
  type MergeDriverInput,
} from "../src/commands/merge-drivers.js";

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const input = {
  path: "a.txt",
  base: bytes("base\n"),
  ours: bytes("ours\n"),
  theirs: bytes("theirs\n"),
  baseLabel: "base",
  oursLabel: "HEAD",
  theirsLabel: "side",
};

describe("lowLevelMerge with host merge drivers", () => {
  it("gives a driver its configured command (merge.<driver>.driver)", async () => {
    const seen: MergeDriverInput[] = [];
    const drivers = {
      custom: createMergeDriver(async (i) => {
        seen.push(i);
        return { content: i.theirs, conflict: false };
      }),
    };
    const merged = await lowLevelMerge(input, {
      attributes: { merge: "custom" },
      drivers,
      driverCommand: (name) => (name === "custom" ? "./merge %O %A %B" : undefined),
    });
    expect(merged.status).toBe("ok");
    expect(text(merged.content)).toBe("theirs\n");
    expect(seen[0]?.command).toBe("./merge %O %A %B");
  });

  it("merge.<driver>.recursive wins over the driver's own recursive driver", async () => {
    const drivers = {
      custom: createMergeDriver(async (i) => ({ content: i.ours, conflict: false }), {
        recursive: "binary",
      }),
    };
    // the driver's own: binary keeps the base in an inner merge
    const own = await lowLevelMerge(input, {
      attributes: { merge: "custom" },
      drivers,
      virtualAncestor: true,
    });
    expect(text(own.content)).toBe("base\n");
    // the configuration's: union keeps both sides
    const configured = await lowLevelMerge(input, {
      attributes: { merge: "custom" },
      drivers,
      virtualAncestor: true,
      recursiveDriver: () => "union",
    });
    expect(text(configured.content)).toBe("ours\ntheirs\n");
  });

  it("a driver that fails to run (error, or a throw) is git's LL_MERGE_ERROR", async () => {
    const failing = createMergeDriver(async (i) => ({
      content: i.ours,
      conflict: true,
      error: true,
    }));
    const throwing = createMergeDriver(async () => {
      throw new Error("killed");
    });
    for (const driver of [failing, throwing]) {
      const merged = await lowLevelMerge(input, {
        attributes: { merge: "custom" },
        drivers: { custom: driver },
      });
      expect(merged.status).toBe("error");
    }
  });
});
